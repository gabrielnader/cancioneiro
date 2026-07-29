//! F13 (PRD V5) + F18 fase 1 (PRD V8) — o funil de curadoria dentro do app.
//!
//! `enrich_scan` seleciona as músicas INCOMPLETAS (sem letra OU com
//! título/artista placeholder) de uma pasta (prefixo de file_path) e passa
//! cada uma pelas etapas do funil, por CUSTO CRESCENTE, cada etapa recebendo
//! só o que a anterior não resolveu (PRD V6):
//!
//! | etapa | `fonte`           | custo       | o que faz                   |
//! |-------|-------------------|-------------|-----------------------------|
//! | 1     | "nome do arquivo" | instantâneo | tags não-placeholder > nome de arquivo limpo (porte do tools/curadoria.py) |
//! | 2     | "LRCLIB"          | ~0,5 s      | LRCLIB por título/artista + DURAÇÃO |
//! | 3     | "Vagalume"        | ~0,5 s      | Vagalume, só onde o LRCLIB veio vazio |
//!
//! As etapas 4 (impressão digital) e 5 (transcrição) são a fase 2 da F18 e
//! não existem aqui.
//!
//! Todo o acesso à rede entra por um `fetch` injetável — os testes rodam sem
//! rede; no comando real é o `ureq`, e continua sendo ponto de rede
//! EXPLÍCITO, acionado pelo usuário, limitado a LRCLIB e Vagalume.
//!
//! `apply` grava as propostas aceitas via writer::write_tags. Regra do lote
//! (V3.1): NUNCA apaga dados existentes — campo ausente/vazio na aplicação
//! preserva o valor atual do arquivo; temas SOMAM aos existentes.

use crate::db::{self, Song};
use crate::error::Result;
use crate::lyrics_fetch::{self, ScoredCandidate};
use crate::vagalume;
use crate::writer;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::cell::Cell;
use std::path::Path;
use std::time::Duration;

// ---------------------------------------------------------------------------
// Vocabulário do funil (contrato com o frontend — valores ESTÁVEIS)
// ---------------------------------------------------------------------------

// Os valores são ESTÁVEIS e vão CRUS para a tela: quem cura são ~40 pessoas
// que não abrem terminal e não têm a quem perguntar, então "lrclib" ou
// "nome-do-arquivo" apareceriam como código de programa no meio da revisão.
// São frases curtas em pt-BR, minúsculas (entram no meio de uma linha de
// status), com os nomes próprios das bases grafados como elas se escrevem.

/// `fonte` — etapa 1: montada aqui mesmo, sem rede, a partir das etiquetas
/// existentes e do nome do arquivo.
pub const FONTE_NOME_ARQUIVO: &str = "nome do arquivo";
/// `fonte` — etapa 2: LRCLIB, com a duração conferida.
pub const FONTE_LRCLIB: &str = "LRCLIB";
/// `fonte` — etapa 3: Vagalume, por casamento estrito de texto (não há
/// duração para conferir).
pub const FONTE_VAGALUME: &str = "Vagalume";
/// `fonte` — a música foi tentada e falhou; `error` traz a explicação em
/// pt-BR e a linha não é aplicável.
pub const FONTE_ERRO: &str = "erro";

/// `etapa` — escolhendo as músicas e anunciando o total (evento inicial,
/// `done = 0`).
pub const ETAPA_PREPARANDO: &str = "preparando";
/// `etapa` — lendo etiquetas e nome do arquivo (sem rede).
pub const ETAPA_NOME_ARQUIVO: &str = "lendo etiquetas e nome do arquivo";
/// `etapa` — consultando o LRCLIB.
pub const ETAPA_LRCLIB: &str = "procurando no LRCLIB";
/// `etapa` — consultando o Vagalume.
pub const ETAPA_VAGALUME: &str = "procurando no Vagalume";
/// `etapa` — esta música terminou; é o ÚNICO evento que faz `done` crescer.
pub const ETAPA_CONCLUIDA: &str = "concluída";

/// Proposta de enriquecimento para uma música incompleta. A letra achada vem
/// na própria proposta (evita segunda rodada de rede no apply).
#[derive(Debug, Clone, Serialize)]
pub struct EnrichProposal {
    pub song_id: i64,
    pub file_path: String,
    pub current_title: String,
    pub current_artist: Option<String>,
    pub proposed_title: String,
    pub proposed_artist: Option<String>,
    pub lyrics: Option<String>,
    /// "alta" | "media" | "baixa" (baixa = só palpite de nome de arquivo,
    /// sem letra).
    pub confidence: String,
    /// Etapa do funil que produziu o dado: `FONTE_NOME_ARQUIVO`,
    /// `FONTE_LRCLIB`, `FONTE_VAGALUME` ou `FONTE_ERRO`. A UI MOSTRA isto —
    /// quem revisa precisa saber se a sugestão veio de um palpite de nome de
    /// arquivo ou de uma base de letras, e o `apply` precisa dela para gravar
    /// a procedência certa em `TXXX:LETRA_ORIGEM`.
    pub fonte: String,
    /// A música JÁ tinha letra no arquivo quando a varredura passou. Com
    /// `lyrics: Some(...)`, isto significa que a proposta SUBSTITUIRIA uma
    /// letra existente — o caso que o tools/curadoria.py recusa desde a
    /// DECISIONS #55 e que o app não sabia nem mostrar.
    pub has_lyrics: bool,
    /// Procedência da letra ATUAL (TXXX:LETRA_ORIGEM), para a revisão poder
    /// dizer se o que seria sobrescrito é transcrição de máquina ou letra
    /// oficial.
    pub letra_origem: Option<String>,
    /// Erro por música (ex.: "sem conexão", arquivo sumido) — nunca aborta
    /// o lote.
    pub error: Option<String>,
}

/// Resultado por música do `apply`: `song` Some = gravada e reindexada;
/// `error` Some = falhou (mensagem do writer) — o lote nunca aborta no meio,
/// então a UI recebe o desfecho de TODAS as aplicações, inclusive das que já
/// foram para o disco antes de uma falha.
#[derive(Debug, Clone, Serialize)]
pub struct EnrichApplyResult {
    pub song_id: i64,
    pub song: Option<Song>,
    pub error: Option<String>,
}

/// Uma aplicação aceita pelo usuário. `None` em artist/lyrics/add_temas
/// significa "não mexer" — o lote nunca apaga, só preenche/atualiza.
///
/// `current_title`/`current_artist` são o ECO do estado contra o qual a
/// proposta foi montada (os mesmos campos da `EnrichProposal`). O apply os
/// confere com o banco antes de gravar: a varredura leva minutos e o usuário
/// pode corrigir a música à mão nesse meio-tempo — sem essa conferência a
/// proposta obsoleta silenciosamente desfazia a edição manual (QA A5).
#[derive(Debug, Clone, Deserialize)]
pub struct EnrichApply {
    pub song_id: i64,
    pub title: String,
    pub artist: Option<String>,
    pub lyrics: Option<String>,
    /// Temas a SOMAR aos existentes (normalização/dedup do writer).
    pub add_temas: Option<String>,
    pub current_title: String,
    pub current_artist: Option<String>,
    /// Eco do `fonte` da proposta (V8/F18) — o frontend copia o campo da
    /// `EnrichProposal` sem alterar. Só tem efeito quando `lyrics` traz letra
    /// NOVA, e serve a uma coisa só: gravar a procedência certa em
    /// `TXXX:LETRA_ORIGEM`. `"Vagalume"` (comparado sem distinguir caixa)
    /// marca a letra como vinda da base comunitária, com o mesmo valor
    /// `"vagalume"` que o `tools/curadoria.py` grava; qualquer outra fonte
    /// LIMPA a marca, porque letra oficial não é transcrição.
    ///
    /// Ausente no JSON = `None` = "não sei de onde veio", tratado como
    /// qualquer-outra-fonte: a marca é limpa, nunca inventada. É por isso que
    /// o campo é opcional — um payload sem ele nunca grava procedência
    /// ERRADA, só deixa de gravar a certa.
    #[serde(default)]
    pub fonte: Option<String>,
    /// Consentimento EXPLÍCITO para substituir uma letra que já existe no
    /// arquivo. Ausente/false = não substituir. Sem isto, `apply_one` recusa
    /// a gravação.
    #[serde(default)]
    pub substituir_letra: bool,
}

/// Mensagem (pt-BR, curta) que a UI mostra como está quando a proposta ficou
/// obsoleta entre a varredura e o apply.
pub const AVISO_PROPOSTA_OBSOLETA: &str = "a música mudou depois da varredura — sugestão ignorada";

/// Mensagem (pt-BR, curta) da recusa de sobrescrever letra existente sem o
/// consentimento explícito. A proposta ALTA do LRCLIB chega PRÉ-MARCADA na
/// revisão (DECISIONS #49), e um clique apagava a transcrição que alguém
/// corrigiu à mão — sem aviso, sem desfazer e sem a quem perguntar.
pub const AVISO_LETRA_EXISTENTE: &str =
    "esta música já tem letra — marque \"substituir a letra atual\" para trocá-la";

// ---------------------------------------------------------------------------
// Placeholders (porte do eh_placeholder do tools/curadoria.py)
// ---------------------------------------------------------------------------

/// Placeholders exatos de ripador/CDDB sobre a chave normalizada (minúscula,
/// sem acento, sem pontuação — "[Unknown Artist]" vira "unknown artist").
const PLACEHOLDERS_EXATOS: &[&str] = &[
    "artist",
    "no artist",
    "unknown artist",
    "artista desconhecido",
    "artista desconhecida",
    "unknown",
    "desconhecido",
    "desconhecida",
    "no title",
    "sem titulo",
    "untitled",
    "unknown title",
    "titulo desconhecido",
];

/// Expressões que, em QUALQUER posição, denunciam tag de ripador — nenhum
/// artista ou título real as contém, então a busca por trecho é segura.
/// "artista desconheci" sem o final cobre o truncamento de campo do ID3 visto
/// no acervo real ("04 Faixa 4 Artista Desconheci").
const PLACEHOLDERS_TRECHO: &[&str] = &[
    "artista desconheci",
    "artista desconhecida",
    "unknown artist",
    "no artist",
    "titulo desconheci",
    "unknown title",
];

/// Palavras de maquinário: NÃO identificam a música, mas várias delas são
/// título de verdade quando aparecem sozinhas ("Pista", "Gravação", "Nome",
/// "Sem Nome" existem no repertório). Por isso esta lista sozinha NUNCA
/// condena um texto — ver `MARCA_DE_RIPADOR`.
const RUIDO_DE_ARQUIVO: &[&str] = &[
    "audiotrack",
    "audio",
    "track",
    "faixa",
    "pista",
    "converted",
    "convertido",
    "copia",
    "copy",
    "mp3",
    "wav",
    "untitled",
    "new",
    "recording",
    "gravacao",
    "sem",
    "titulo",
    "nome",
];

/// Marca de ripador: só ELA habilita a regra do `RUIDO_DE_ARQUIVO`. Vale um
/// número solto ("04", "2010"), uma corrida com cara de horário/data
/// ("22-17-23") ou uma palavra que nenhuma canção usa como título.
///
/// A exigência é o conserto de uma regressão achada pelo QA do lado Python:
/// sem ela, "Gravação", "Nome" e "Sem Nome" viravam placeholder — ou seja,
/// campo VAZIO — e o título REAL do curador era sobrescrito em silêncio. Uma
/// palavra comum sozinha nunca é lixo; precisa da companhia da marca.
const MARCA_DE_RIPADOR: &[&str] = &[
    "audiotrack",
    "converted",
    "convertido",
    "mp3",
    "wav",
    "untitled",
];

/// Sequência de no máximo `max` dígitos ASCII, não vazia.
fn so_digitos(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max && s.bytes().all(|b| b.is_ascii_digit())
}

/// `^\d{1,4}(?:[-:.]\d{1,2}){1,}$` — "22-17-23", "2010.05.03", "12:30".
/// Conferido sobre o texto ORIGINAL, porque a pontuação some no `norm`.
fn cara_de_horario(palavra: &str) -> bool {
    let mut campos = palavra.split(['-', ':', '.']);
    if !campos.next().is_some_and(|c| so_digitos(c, 4)) {
        return false;
    }
    let mut houve_separador = false;
    for campo in campos {
        houve_separador = true;
        if !so_digitos(campo, 2) {
            return false;
        }
    }
    houve_separador
}

/// True quando o texto traz prova de que saiu de uma máquina.
fn tem_marca_de_ripador(partes: &[&str], bruto: &str) -> bool {
    partes
        .iter()
        .any(|p| so_digitos(p, usize::MAX) || MARCA_DE_RIPADOR.contains(p))
        || bruto.split_whitespace().any(cara_de_horario)
}

/// `^(?:\d+\s+)?(?:(?:audio\s?track|faixa|track)(?:\s?\d+)?|pista\s?\d+)$`
/// sobre a chave normalizada — "AudioTrack 02", "02 Faixa 3", "track",
/// "Pista 3"...
///
/// "pista" SOZINHA fica de fora (e é a única das cinco que exige o número):
/// é palavra que existe como título de verdade no repertório, e tratá-la como
/// campo vazio apagaria o título de quem curou.
fn placeholder_faixa(chave: &str) -> bool {
    // prefixo numérico opcional ("02 audiotrack 02")
    let s = match chave.split_once(' ') {
        Some((num, resto)) if num.chars().all(|c| c.is_ascii_digit()) => resto,
        _ => chave,
    };
    for (kw, exige_numero) in [
        ("audio track", false),
        ("audiotrack", false),
        ("faixa", false),
        ("track", false),
        ("pista", true),
    ] {
        if let Some(resto) = s.strip_prefix(kw) {
            let resto = resto.strip_prefix(' ').unwrap_or(resto);
            if so_digitos(resto, usize::MAX) || (!exige_numero && resto.is_empty()) {
                return true;
            }
        }
    }
    false
}

/// True se o texto é placeholder (tag-lixo ou entrada-lixo do LRCLIB):
/// vazio, só dígitos/pontuação, "AudioTrack N"/"Faixa N"/"Track N"/"Pista N"
/// (com ou sem prefixo numérico), "no artist", "[Unknown Artist]", "Artista
/// Desconhecido", "sem título", "untitled" etc. Case/acento-insensitive.
///
/// Porte do `eh_placeholder` do `tools/curadoria.py`, incluindo as duas
/// regras que o acervo real obrigou a existir lá: a de SUBSTRING (etiqueta
/// truncada pelo limite do ID3, "04 Faixa 4 Artista Desconheci") e a do ruído
/// de arquivo com marca de máquina ("1-2010 22-17-23)_converted").
pub fn is_placeholder(texto: &str) -> bool {
    let chave = lyrics_fetch::norm(texto);
    if chave.is_empty() || chave.chars().all(|c| c.is_ascii_digit()) {
        return true; // vazio, só pontuação/# ou só dígitos
    }
    if PLACEHOLDERS_EXATOS.contains(&chave.as_str()) {
        return true;
    }
    if placeholder_faixa(&chave) {
        return true;
    }
    if PLACEHOLDERS_TRECHO.iter().any(|m| chave.contains(m)) {
        return true;
    }
    // Só números e palavras de maquinário E com marca de ripador junto: não
    // sobra nada que identifique a música. Uma palavra sozinha é TÍTULO,
    // sempre — "Convertido", "Gravação", "Nome", "Pista" viram lixo só
    // acompanhadas da marca da máquina.
    let partes: Vec<&str> = chave.split_whitespace().collect();
    if partes.len() < 2 || !tem_marca_de_ripador(&partes, texto) {
        return false;
    }
    partes
        .iter()
        .all(|p| so_digitos(p, usize::MAX) || RUIDO_DE_ARQUIVO.contains(p))
}

/// Tag placeholder é tratada como campo VAZIO em todos os pontos: não vira
/// palpite, não bloqueia proposta BAIXA, não marca a música como completa.
fn sem_placeholder(texto: &str) -> &str {
    if is_placeholder(texto) {
        ""
    } else {
        texto
    }
}

/// Valor EFETIVO de um campo para a comparação de no-op: espaços das pontas
/// removidos e placeholder tratado como VAZIO — exatamente a noção que o resto
/// do módulo usa (`sem_placeholder`), aplicada aos DOIS lados da comparação.
///
/// Aplicar a normalização também ao lado PROPOSTO é o que impede o caso
/// "placeholder atual + palpite também placeholder" de passar por mudança:
/// tag "AudioTrack 17" com arquivo "17 Faixa.mp3" proporia "Faixa" — texto
/// diferente, valor igual a nada. Os dois viram "" e a proposta cai.
fn campo_efetivo(texto: &str) -> &str {
    sem_placeholder(texto.trim())
}

/// True se a proposta não muda NADA e portanto não deve nem ser produzida:
/// título e artista efetivos iguais aos atuais e sem letra. No teste real
/// (acervo de 94 músicas) essas linhas — "Abrição de portas — Antônio Nóbrega"
/// → "Abrição de portas — Antônio Nóbrega", BAIXA, sem letra — só faziam o
/// usuário perder tempo procurando qual era a sugestão.
///
/// Duas exceções, nesta ordem:
/// - `error` presente: a linha (desabilitada na UI) É a informação — o usuário
///   precisa saber que a música foi tentada e falhou (decisão 47);
/// - `lyrics` presente: a letra é a mudança, mesmo com título/artista iguais.
///
/// A comparação usa `current_title`/`current_artist` da própria proposta — os
/// mesmos textos que a UI exibe na coluna "atual" —, normalizados por
/// `campo_efetivo`.
fn e_no_op(p: &EnrichProposal) -> bool {
    p.error.is_none()
        && p.lyrics.is_none()
        && campo_efetivo(&p.proposed_title) == campo_efetivo(&p.current_title)
        && campo_efetivo(p.proposed_artist.as_deref().unwrap_or(""))
            == campo_efetivo(p.current_artist.as_deref().unwrap_or(""))
}

// ---------------------------------------------------------------------------
// Nome de arquivo → palpites (porte simplificado do curadoria.py)
// ---------------------------------------------------------------------------

/// Remove trechos delimitados por `abre`..`fecha` (não aninhados), como a
/// regex `\[[^\]]*\]`; delimitador sem fechamento fica como está.
fn remove_delimitado(s: &str, abre: char, fecha: char) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find(abre) {
        out.push_str(&rest[..i]);
        let depois = &rest[i + abre.len_utf8()..];
        match depois.find(fecha) {
            Some(j) => {
                out.push(' ');
                rest = &depois[j + fecha.len_utf8()..];
            }
            None => {
                out.push_str(&rest[i..]);
                return out;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Remove o prefixo de número de faixa (`^\s*\(?\d{1,3}\)?\s*[-.)]*\s+`):
/// "08 Xote", "08 - Xote", "(08) Xote" → "Xote"; "12" sozinho fica.
fn remove_prefixo_faixa(s: &str) -> &str {
    let inicio = s.trim_start();
    let sem_abre = inicio.strip_prefix('(').unwrap_or(inicio);
    let nd = sem_abre.chars().take_while(|c| c.is_ascii_digit()).count();
    if nd == 0 || nd > 3 {
        return s;
    }
    let mut rest = &sem_abre[nd..];
    rest = rest.strip_prefix(')').unwrap_or(rest);
    let apos_w1 = rest.trim_start();
    let w1 = rest.len() - apos_w1.len();
    let apos_punct = apos_w1.trim_start_matches(['-', '.', ')']);
    let punct = apos_w1.len() - apos_punct.len();
    let apos_w2 = apos_punct.trim_start();
    let w2 = apos_punct.len() - apos_w2.len();
    if w2 > 0 {
        apos_w2 // "\s*[-.)]*\s+" completo
    } else if punct == 0 && w1 > 0 {
        apos_w1 // sem pontuação: o \s+ é o próprio espaço após o número
    } else {
        s // sem espaço obrigatório depois: não é prefixo de faixa
    }
}

/// Limpa um nome de arquivo para virar palpite: remove a extensão e o número
/// de faixa inicial; remove conteúdo entre colchetes e entre parênteses
/// (exceto quando remover os parênteses deixaria o nome vazio); underscores
/// viram espaço e espaços são colapsados.
pub fn limpar_nome_arquivo(nome: &str) -> String {
    let stem = Path::new(nome)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| nome.to_string());
    let s = stem.replace('_', " ");
    let s = remove_delimitado(&s, '[', ']');
    let sem_parenteses = remove_delimitado(&s, '(', ')');
    let s = if sem_parenteses.trim().is_empty() {
        s
    } else {
        sem_parenteses
    };
    let s = remove_prefixo_faixa(&s);
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn split_divisor(s: &str) -> Option<(String, String)> {
    let (a, b) = s.split_once(" - ")?;
    let (a, b) = (a.trim(), b.trim());
    if a.is_empty() || b.is_empty() {
        return None;
    }
    Some((a.to_string(), b.to_string()))
}

/// Palpites (título, artista) na ordem da V3: tags não-placeholder primeiro
/// (título de tag com " - " e artista vazio também é dividido nas duas
/// ordens); nome de arquivo limpo dividido no primeiro " - " nas duas ordens
/// (com 3+ segmentos também os DOIS ÚLTIMOS nas duas ordens); nome inteiro
/// como título. Tag placeholder é tratada como vazia: nunca vira palpite.
pub(crate) fn gerar_palpites(
    nome_arquivo: &str,
    titulo: &str,
    artista: &str,
) -> Vec<(String, String)> {
    let titulo = sem_placeholder(titulo);
    let artista = sem_placeholder(artista);
    let mut palpites: Vec<(String, String)> = Vec::new();
    if !titulo.is_empty() {
        palpites.push((titulo.to_string(), artista.to_string()));
        if artista.is_empty() {
            if let Some((a, b)) = split_divisor(titulo) {
                palpites.push((b.clone(), a.clone())); // Artista - Título
                palpites.push((a, b)); // Título - Artista
            }
        }
    }
    let limpo = limpar_nome_arquivo(nome_arquivo);
    if let Some((a, b)) = split_divisor(&limpo) {
        palpites.push((b.clone(), a.clone())); // Artista - Título
        palpites.push((a, b)); // Título - Artista
        let segmentos: Vec<&str> = limpo
            .split(" - ")
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect();
        if segmentos.len() >= 3 {
            // "coleção - Título - Artista": os dois últimos, nas duas ordens
            let (penultimo, ultimo) = (segmentos[segmentos.len() - 2], segmentos[segmentos.len() - 1]);
            palpites.push((penultimo.to_string(), ultimo.to_string()));
            palpites.push((ultimo.to_string(), penultimo.to_string()));
        }
    }
    if !limpo.is_empty() {
        palpites.push((limpo, String::new()));
    }
    let mut vistos = std::collections::HashSet::new();
    palpites
        .into_iter()
        .filter(|p| vistos.insert(p.clone()))
        .collect()
}

// ---------------------------------------------------------------------------
// Scan (propostas) e apply
// ---------------------------------------------------------------------------

/// True se `file_path` está DENTRO da pasta `prefix` (fronteira de pasta
/// exata: "/m/1" não casa "/m/10/a.mp3"). Prefixo vazio = biblioteca inteira.
/// Espelha o `isUnderFolder` de src/lib/folderTree.ts: exige o separador
/// ('/' ou '\\') logo após o prefixo — ou o próprio prefixo já termina nele.
pub(crate) fn under_prefix(file_path: &str, prefix: &str) -> bool {
    if prefix.is_empty() {
        return true;
    }
    match file_path.strip_prefix(prefix) {
        Some(resto) => prefix.ends_with(['/', '\\']) || resto.starts_with(['/', '\\']),
        None => false,
    }
}

/// Proposta da ETAPA 1 (sem rede): só o palpite de nome de arquivo, sem
/// letra, confiança BAIXA. Tag REAL existente é preservada no palpite (o lote
/// nunca propõe apagar). `fonte` é `erro` quando a música foi tentada e
/// falhou — nesse caso a linha existe para INFORMAR, não para aplicar.
fn proposta_baixa(
    cand: &Candidata,
    error: Option<String>,
) -> EnrichProposal {
    let Candidata {
        song,
        titulo_tag,
        artista_tag,
        nome,
    } = cand;
    let (mut titulo_prop, mut artista_prop) = gerar_palpites(nome, "", "")
        .into_iter()
        .next()
        .unwrap_or_default();
    // Título que é LITERALMENTE o nome do arquivo não é etiqueta: é o
    // indexador falando. `indexer.rs` copia o nome quando o MP3 não tem TIT2,
    // e preferi-lo ao palpite limpo fazia a proposta sair igual ao que já
    // estava lá — o `e_no_op` a derrubava e a etapa que se chama "nome do
    // arquivo" não entregava nada justamente para quem não tem tag nenhuma.
    // Um "Falamansa - Oh! Chuva.mp3" sem tags chegava a propor esse texto
    // inteiro como TÍTULO e ainda "Falamansa" como artista, duplicando o
    // artista dentro do próprio título.
    //
    // O arquivo BEM nomeado não sofre com isso: o palpite limpo dá o mesmo
    // valor que a etiqueta, e a proposta cai por no-op como sempre caiu.
    if !titulo_tag.is_empty() && !titulo_e_o_nome_do_arquivo(titulo_tag, nome) {
        titulo_prop = titulo_tag.to_string();
    }
    if !artista_tag.is_empty() {
        artista_prop = artista_tag.to_string();
    }
    let fonte = if error.is_some() {
        FONTE_ERRO
    } else {
        FONTE_NOME_ARQUIVO
    };
    EnrichProposal {
        song_id: song.id,
        file_path: song.file_path.clone(),
        current_title: song.title.clone(),
        current_artist: song.artist.clone(),
        proposed_title: titulo_prop,
        proposed_artist: (!artista_prop.is_empty()).then_some(artista_prop),
        lyrics: None,
        confidence: "baixa".into(),
        fonte: fonte.into(),
        has_lyrics: song.has_lyrics,
        letra_origem: song.letra_origem.clone(),
        error,
    }
}

/// True quando o texto do título é o próprio nome do arquivo (sem extensão).
/// Serve a uma pergunta só: este título foi ESCRITO por alguém, ou o indexador
/// o inventou a partir do nome do arquivo por falta de TIT2?
///
/// A resposta não é perfeita — um arquivo bem nomeado pode ter uma etiqueta
/// idêntica ao nome — e não precisa ser: nesse caso o palpite limpo dá o mesmo
/// valor e a proposta cai por no-op de qualquer jeito.
fn titulo_e_o_nome_do_arquivo(titulo: &str, nome: &str) -> bool {
    let stem = Path::new(nome)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    titulo.trim() == stem.trim()
}

/// Acrescenta a proposta ao lote, a menos que ela não mude nada (`e_no_op`).
fn registrar(propostas: &mut Vec<EnrichProposal>, proposta: EnrichProposal) {
    if !e_no_op(&proposta) {
        propostas.push(proposta);
    }
}

/// Cortesia de rede COMPARTILHADA pelas duas fontes: uma pausa antes de cada
/// consulta, exceto a primeira de toda a varredura. Compartilhada de
/// propósito — a pausa existe para não atropelar servidor alheio, e uma
/// varredura que alterna LRCLIB e Vagalume sem pausa entre eles dispararia
/// duas consultas coladas por música.
struct Cortesia {
    pausa: Duration,
    primeira: Cell<bool>,
}

impl Cortesia {
    fn nova(pausa: Duration) -> Self {
        Cortesia {
            pausa,
            primeira: Cell::new(true),
        }
    }

    fn esperar(&self) {
        if !self.primeira.replace(false) && !self.pausa.is_zero() {
            std::thread::sleep(self.pausa);
        }
    }
}

/// Uma música que entrou na varredura, com o que a etapa 1 já sabe dela:
/// as tags REAIS (placeholder já virou vazio) e o nome base do arquivo.
struct Candidata {
    song: Song,
    titulo_tag: String,
    artista_tag: String,
    nome: String,
}

/// Monta a `Candidata`: etiquetas EFETIVAS (placeholder já tratado como
/// vazio) e nome base do arquivo. Ponto único dessa montagem — os dois
/// caminhos de entrada (o lote e a música avulsa) passam por aqui.
///
/// `titulo`/`artista` são o que a pessoa digitou no editor e, quando vêm
/// preenchidos, SUBSTITUEM as etiquetas do banco (V8/F18, QA ALTO-3a): o
/// backend procurava por "Faixa 03" enquanto quem clicou tinha acabado de
/// escrever "Asa Branca" no formulário. Passam pelo mesmo `sem_placeholder`
/// das etiquetas — texto digitado também pode ser lixo de ripador colado.
fn montar_candidata(song: Song, titulo: Option<&str>, artista: Option<&str>) -> Candidata {
    fn efetivo(digitado: Option<&str>, do_banco: &str) -> String {
        let bruto = digitado
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .unwrap_or(do_banco);
        sem_placeholder(bruto).to_string()
    }
    let titulo_tag = efetivo(titulo, &song.title);
    let artista_tag = efetivo(artista, song.artist.as_deref().unwrap_or(""));
    let nome = Path::new(&song.file_path)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    Candidata {
        song,
        titulo_tag,
        artista_tag,
        nome,
    }
}

/// Filtro de entrada da varredura EM LOTE: devolve `None` para a música que
/// não tem o que completar (e portanto não conta no total do progresso nem
/// gasta rede).
///
/// Completa = título E artista reais (não-placeholder) mais letra. Para o
/// INSTRUMENTAL a letra sai da conta (V8/F17): música sem voz não tem letra a
/// buscar, em fonte nenhuma, e cobrá-la para sempre era exatamente a
/// pendência eterna que a marca veio resolver. O que ela AINDA pode ganhar é
/// título e artista — por isso ela não é descartada aqui, e sim nas etapas de
/// LETRA (ver `processar_musica`): "instrumental sem letra ainda pode (e
/// deve) ter título e artista corretos" (PRD V8).
///
/// O filtro é do LOTE, e só dele: ele existe para 95 músicas não virarem 95
/// consultas inúteis. A música avulsa do editor entra por `candidata_pedida`,
/// sem este portão.
fn candidata(song: Song) -> Option<Candidata> {
    if !song.available {
        return None;
    }
    let cand = montar_candidata(song, None, None);
    let nomes_prontos = !cand.titulo_tag.is_empty() && !cand.artista_tag.is_empty();
    let completa = nomes_prontos && (cand.song.instrumental || cand.song.has_lyrics);
    (!completa).then_some(cand)
}

/// Entrada da varredura de UMA música: quem clicou sabe o que quer.
///
/// A única exigência é o arquivo estar disponível — não há filtro de
/// completude (QA ALTO-3b). A música completa era recusada aqui sem tocar a
/// rede, e a tela dizia "não achamos esta música nos sites de letra": uma
/// afirmação sobre uma busca que não aconteceu, repetida a cada clique, para
/// alguém que não tem a quem perguntar. A checagem de arquivo sumido do disco
/// continua valendo, dentro do `processar_musica`.
fn candidata_pedida(song: Song, titulo: Option<&str>, artista: Option<&str>) -> Option<Candidata> {
    song.available
        .then(|| montar_candidata(song, titulo, artista))
}

/// Quantas músicas sob `folder_prefix` (vazio = biblioteca inteira) a
/// varredura vai olhar — o mesmo número que ela anuncia como `total` no
/// primeiro evento de progresso.
///
/// Existe para a tela poder dizer "vou olhar N músicas" ANTES de a pessoa
/// mandar começar, e mora aqui por um motivo (QA ALTO-2): a regra de quem é
/// candidata é UMA, a `candidata`. A cópia que existia em TypeScript já havia
/// divergido, e uma contagem que não bate com a barra de progresso não tem
/// como ser explicada a quem não abre terminal.
pub fn count_candidatas(conn: &Connection, folder_prefix: &str) -> Result<usize> {
    Ok(db::list_songs(conn)?
        .into_iter()
        .filter(|s| under_prefix(&s.file_path, folder_prefix))
        .filter_map(candidata)
        .count())
}

/// Passa UMA música pelo funil e devolve a proposta. `None` significa
/// CANCELADA no meio do caminho — a varredura volta cedo sem contabilizar
/// esta música (nem proposta, nem progresso).
///
/// `etapa(nome)` é chamada ao ENTRAR em cada etapa, para a UI dizer o que
/// está acontecendo agora; nenhuma delas faz `done` crescer.
fn processar_musica<F, C, E>(
    cand: &Candidata,
    fetch: &F,
    chave_vagalume: &str,
    chave_recusada: &Cell<bool>,
    cortesia: &Cortesia,
    cancelled: &C,
    etapa: E,
) -> Option<EnrichProposal>
where
    F: Fn(&str) -> Result<String>,
    C: Fn() -> bool,
    E: Fn(&str),
{
    // --- etapa 1: etiquetas + nome do arquivo (instantânea, sem rede) -----
    etapa(ETAPA_NOME_ARQUIVO);

    // arquivo sumido do disco: reporta sem gastar rede
    if !Path::new(&cand.song.file_path).is_file() {
        return Some(proposta_baixa(
            cand,
            Some(format!("arquivo não encontrado: {}", cand.song.file_path)),
        ));
    }

    // V8/F17 — as etapas 2 e 3 são etapas de LETRA, e "todas as etapas de
    // letra pulam o arquivo [...] e a varredura em lote do app". A música
    // marcada como instrumental para aqui, com o que a etapa 1 achou.
    //
    // Não é só economia de rede, e NÃO é filtro de completude: é regra de
    // INTEGRIDADE, e por isso ela sobreviveu à remoção do portão da varredura
    // de uma música só (QA ALTO-3b). Um instrumental com título e artista
    // corretos casa com a versão CANTADA da mesma peça no LRCLIB e sai
    // ALTA — e ALTA chega pré-marcada na revisão (DECISIONS #49). Um
    // clique gravaria a letra de outra gravação dentro do arquivo. Vale
    // igual nos dois caminhos: nem "quem clicou sabe o que quer" autoriza
    // pôr letra de terceiro dentro de uma peça sem voz.
    if cand.song.instrumental {
        return Some(proposta_baixa(cand, None));
    }

    // --- etapa 2: LRCLIB (título/artista + duração) -----------------------
    etapa(ETAPA_LRCLIB);
    let duracao = cand.song.duration_seconds.unwrap_or(0) as f64;
    let mut best: Option<ScoredCandidate> = None;
    let mut erro: Option<String> = None;
    for (titulo, artista) in gerar_palpites(&cand.nome, &cand.titulo_tag, &cand.artista_tag) {
        // cancelar precisa parar a REDE, não só a fila de músicas: um único
        // arquivo chega a render quatro palpites, cada um com sua pausa.
        if cancelled() {
            return None;
        }
        cortesia.esperar();
        match lyrics_fetch::query_best(&titulo, &artista, duracao, fetch, |t, a| {
            !is_placeholder(t) && !is_placeholder(a)
        }) {
            Ok(Some(cand_lrclib)) => {
                if best.as_ref().is_none_or(|b| cand_lrclib.score > b.score) {
                    best = Some(cand_lrclib);
                }
                // para no primeiro palpite que rende ALTA
                if best
                    .as_ref()
                    .is_some_and(|b| lyrics_fetch::classify(b.sim, b.dif) == Some("alta"))
                {
                    break;
                }
            }
            Ok(None) => {}
            Err(e) => {
                // Por música: nunca aborta o lote. E um candidato válido
                // (MÉDIA/ALTA) já achado por palpite anterior é mantido —
                // a proposta de erro só vale se nada aproveitável veio
                // antes da falha.
                if best
                    .as_ref()
                    .and_then(|b| lyrics_fetch::classify(b.sim, b.dif))
                    .is_none()
                {
                    erro = Some(e.to_string());
                }
                break;
            }
        }
    }

    let confianca = best
        .as_ref()
        .and_then(|b| lyrics_fetch::classify(b.sim, b.dif));
    if let (None, Some(b), Some(conf)) = (&erro, &best, confianca) {
        return Some(EnrichProposal {
            song_id: cand.song.id,
            file_path: cand.song.file_path.clone(),
            current_title: cand.song.title.clone(),
            current_artist: cand.song.artist.clone(),
            proposed_title: b.matched_title.clone(),
            proposed_artist: (!b.matched_artist.is_empty()).then(|| b.matched_artist.clone()),
            lyrics: Some(b.lyrics.clone()),
            confidence: conf.to_string(),
            fonte: FONTE_LRCLIB.into(),
            has_lyrics: cand.song.has_lyrics,
            letra_origem: cand.song.letra_origem.clone(),
            error: None,
        });
    }

    // --- etapa 3: Vagalume, SÓ onde o LRCLIB veio vazio --------------------
    //
    // Quatro condições, as três primeiras herdadas do tools/curadoria.py:
    // - o LRCLIB não trouxe letra confiável (o funil só passa adiante o que a
    //   etapa anterior não resolveu) E não falhou (rede caída derruba as duas
    //   fontes; insistir só gastaria o tempo do usuário);
    // - há chave (sem chave a etapa é pulada em silêncio);
    // - há título E artista REAIS para conferir. O Vagalume não tem duração:
    //   a igualdade de palavras dos dois lados é a única prova que existe, e
    //   ela precisa de um pedido que já signifique alguma coisa. Palpite de
    //   nome de arquivo não é isso — identificar quem ainda não tem tag é
    //   trabalho da impressão digital (fase 2 da F18);
    // - a chave ainda não foi recusada nesta varredura (QA MÉDIO-6): chave
    //   errada não melhora entre uma música e a seguinte, e insistir custa
    //   meio segundo por arquivo para reescrever a mesma linha de erro 95
    //   vezes. A primeira reporta; as demais pulam em silêncio, igual ao que
    //   já acontece quando não há chave nenhuma.
    let sem_letra_do_lrclib = erro.is_none() && confianca.is_none();
    let tem_o_que_conferir = !cand.titulo_tag.is_empty() && !cand.artista_tag.is_empty();
    if sem_letra_do_lrclib
        && !chave_vagalume.trim().is_empty()
        && tem_o_que_conferir
        && !chave_recusada.get()
    {
        if cancelled() {
            return None;
        }
        etapa(ETAPA_VAGALUME);
        cortesia.esperar();
        match vagalume::fetch_lyrics_vagalume(
            &cand.titulo_tag,
            &cand.artista_tag,
            chave_vagalume,
            fetch,
            |t, a| !is_placeholder(t) && !is_placeholder(a),
        ) {
            // A régua estrita garante que o título/artista devolvidos são as
            // MESMAS palavras das tags atuais; então a etapa não propõe trocar
            // nome nenhum — a letra é a mudança inteira.
            //
            // Confiança MÉDIA, nunca ALTA, e isso é deliberado: ALTA chega
            // PRÉ-MARCADA na revisão (DECISIONS #49), e ALTA no resto do
            // produto significa "a duração confirmou". Aqui não há duração
            // para confirmar nada (DECISIONS #63) — a prova é só textual, e
            // foi exatamente esta fonte que uma vez gravou "Ponto de Ogum"
            // dentro de "Ponto de Oxum". A letra chega, com a fonte visível,
            // e quem cura dá o clique.
            Ok(Some(m)) => {
                return Some(EnrichProposal {
                    song_id: cand.song.id,
                    file_path: cand.song.file_path.clone(),
                    current_title: cand.song.title.clone(),
                    current_artist: cand.song.artist.clone(),
                    proposed_title: cand.titulo_tag.clone(),
                    proposed_artist: Some(cand.artista_tag.clone()),
                    lyrics: Some(m.lyrics),
                    confidence: "media".into(),
                    fonte: FONTE_VAGALUME.into(),
                    has_lyrics: cand.song.has_lyrics,
                    letra_origem: cand.song.letra_origem.clone(),
                    error: None,
                })
            }
            Ok(None) => {}
            Err(e) => {
                let msg = e.to_string();
                // chave recusada é veredito sobre a varredura INTEIRA, não
                // sobre esta música: registra e desliga a etapa. Um erro
                // qualquer (fora do ar, "espere um pouco") pode ter sido
                // soluço, e a música seguinte merece a tentativa.
                if msg == vagalume::ERRO_CHAVE_RECUSADA {
                    chave_recusada.set(true);
                }
                erro = Some(msg);
            }
        }
    }

    Some(proposta_baixa(cand, erro))
}

/// Varre as músicas available sob `folder_prefix` (vazio = todas), passa as
/// incompletas pelo funil (etiquetas/nome → LRCLIB → Vagalume) e devolve as
/// propostas.
///
/// `chave_vagalume` é a chave gratuita do usuário, guardada pelo frontend e
/// passada por PARÂMETRO: o Cancioneiro nunca a grava no banco nem em log.
/// Vazia, a etapa 3 é pulada em silêncio e todo o resto funciona igual.
///
/// `pausa` é a cortesia entre consultas, das DUAS fontes (300 ms no comando
/// real; zero nos testes). Erro de rede por música vira proposta com `error`
/// — nunca aborta o lote.
///
/// `on_progress(done, total, nome_do_arquivo, etapa)` espelha o `|done,
/// total|` do indexer (evento `scan:progress`) com duas informações a mais
/// que o acervo real exigiu:
/// - um primeiro evento com `done = 0` e `etapa = "preparando"` sai antes de
///   qualquer processamento, para a UI já mostrar o total;
/// - dentro de cada música sai um evento ao ENTRAR em cada etapa do funil,
///   com o MESMO `done` (a barra não anda, o texto muda): uma música chega a
///   levar segundos entre quatro palpites no LRCLIB e a consulta ao Vagalume,
///   e o PRD V8 pede "a etapa atual do funil e o arquivo do momento" visíveis
///   o tempo todo. `done` só cresce no evento `etapa = "concluída"`, um por
///   música — quem só quer a barra pode ignorar os demais.
///
/// `total` é o número de CANDIDATAS (depois do filtro de músicas completas,
/// antes do descarte de no-op): mede trabalho, não resultado — o progresso
/// avança mesmo quando a proposta é descartada, quando a rede falha ou quando
/// o arquivo sumiu do disco.
///
/// `cancelled()` (QA M4) é consultado ANTES de cada música e ANTES de CADA
/// consulta de rede — inclusive antes da primeira, quando nem o evento
/// inicial de progresso sai. Cancelar faz a varredura voltar CEDO com as
/// propostas que já tinha (vec vazio se ainda não havia nenhuma), sem gastar
/// mais rede nem emitir mais progresso: o "Cancelar" da UI só descarta o
/// resultado, e a varredura zumbi ficava consultando por minutos e
/// embaralhando a barra da varredura seguinte.
pub fn enrich_scan<F, P, C>(
    conn: &Connection,
    folder_prefix: &str,
    fetch: F,
    chave_vagalume: &str,
    pausa: Duration,
    on_progress: P,
    cancelled: C,
) -> Result<Vec<EnrichProposal>>
where
    F: Fn(&str) -> Result<String>,
    P: Fn(usize, usize, &str, &str),
    C: Fn() -> bool,
{
    if cancelled() {
        return Ok(Vec::new());
    }

    // 1ª passada (sem rede): seleciona as candidatas para o total do progresso
    // ser conhecido antes da primeira consulta.
    let candidatas: Vec<Candidata> = db::list_songs(conn)?
        .into_iter()
        .filter(|s| under_prefix(&s.file_path, folder_prefix))
        .filter_map(candidata)
        .collect();

    let total = candidatas.len();
    on_progress(0, total, "", ETAPA_PREPARANDO); // total na tela antes da 1ª consulta

    let cortesia = Cortesia::nova(pausa);
    // QA MÉDIO-6 — vive pela varredura inteira, ao lado da cortesia: assim
    // que a API recusa a chave, a etapa 3 se desliga para as músicas
    // seguintes.
    let chave_recusada = Cell::new(false);
    let mut propostas = Vec::new();
    for (feitas, cand) in candidatas.iter().enumerate() {
        // cancelamento entre músicas: volta com o que já tem (QA M4)
        if cancelled() {
            return Ok(propostas);
        }
        let Some(proposta) = processar_musica(
            cand,
            &fetch,
            chave_vagalume,
            &chave_recusada,
            &cortesia,
            &cancelled,
            |etapa| on_progress(feitas, total, &cand.nome, etapa),
        ) else {
            return Ok(propostas); // cancelada no meio desta música
        };
        registrar(&mut propostas, proposta);
        on_progress(feitas + 1, total, &cand.nome, ETAPA_CONCLUIDA);
    }
    Ok(propostas)
}

/// O MESMO funil de `enrich_scan`, numa música só — o "completar dados desta
/// música" do editor (PRD V8/F18: "no editar de cada música, a versão
/// individual: rodar o funil só naquele arquivo, para o caso pontual").
///
/// Diferente do lote, esta porta NÃO tem filtro de completude (QA ALTO-3b):
/// música completa, com nome e artista reais, é consultada mesmo assim. O
/// botão só é apertado por alguém que está olhando aquele arquivo e quer uma
/// segunda opinião; recusá-la em silêncio e responder "não achamos esta
/// música nos sites de letra" era mentir sobre uma busca que nunca aconteceu.
///
/// `titulo`/`artista` são o que está no formulário do editor NAQUELE momento
/// e valem mais que as etiquetas do banco para MONTAR a consulta (QA
/// ALTO-3a). O eco `current_title`/`current_artist` da proposta continua
/// saindo do BANCO — é ele que o `apply` confere contra o disco antes de
/// gravar (QA A5), e um eco tirado do formulário aprovaria a si mesmo.
///
/// Devolve `Ok(None)` para uma coisa só: procuramos e não veio nada novo
/// (incluindo a proposta que não mudaria nada). As exceções são o arquivo
/// indisponível e o cancelamento no meio. Música inexistente é `Err` — o id
/// veio do próprio app, então é defeito, não resultado. O progresso sai no
/// mesmo formato da varredura em lote (com `total` 0 ou 1), para a UI
/// reaproveitar o mesmo indicador.
#[allow(clippy::too_many_arguments)]
pub fn enrich_scan_song<F, P, C>(
    conn: &Connection,
    song_id: i64,
    titulo: Option<&str>,
    artista: Option<&str>,
    fetch: F,
    chave_vagalume: &str,
    pausa: Duration,
    on_progress: P,
    cancelled: C,
) -> Result<Option<EnrichProposal>>
where
    F: Fn(&str) -> Result<String>,
    P: Fn(usize, usize, &str, &str),
    C: Fn() -> bool,
{
    let song = db::get_song(conn, song_id)?.ok_or_else(|| {
        crate::error::AppError(format!("música não encontrada: {song_id}"))
    })?;
    if cancelled() {
        return Ok(None);
    }
    let Some(cand) = candidata_pedida(song, titulo, artista) else {
        on_progress(0, 0, "", ETAPA_PREPARANDO); // arquivo indisponível
        return Ok(None);
    };
    on_progress(0, 1, "", ETAPA_PREPARANDO);

    let cortesia = Cortesia::nova(pausa);
    // uma música só: não há "resto da varredura" para desligar, mas a recusa
    // da chave precisa chegar à proposta como o erro que é
    let chave_recusada = Cell::new(false);
    let Some(proposta) = processar_musica(
        &cand,
        &fetch,
        chave_vagalume,
        &chave_recusada,
        &cortesia,
        &cancelled,
        |etapa| on_progress(0, 1, &cand.nome, etapa),
    ) else {
        return Ok(None); // cancelada no meio
    };
    on_progress(1, 1, &cand.nome, ETAPA_CONCLUIDA);
    Ok((!e_no_op(&proposta)).then_some(proposta))
}

/// Aplica as propostas aceitas via writer::write_tags (título obrigatório).
/// O lote NUNCA apaga: artist/lyrics `None` (ou vazios) preservam o valor
/// atual do arquivo; `add_temas` SOMA aos temas existentes (a normalização
/// do writer deduplica e ordena).
///
/// Falha por música (arquivo sumido, título inválido, erro de escrita) vira
/// entrada com `error` e o lote CONTINUA — nunca aborta no meio deixando a
/// UI dessincronizada do disco. O `Result` externo fica reservado a erros de
/// infraestrutura (lock envenenado é tratado no commands.rs).
pub fn apply(conn: &Connection, aplicacoes: &[EnrichApply]) -> Result<Vec<EnrichApplyResult>> {
    let mut resultados = Vec::with_capacity(aplicacoes.len());
    for ap in aplicacoes {
        resultados.push(match apply_one(conn, ap) {
            Ok(song) => EnrichApplyResult {
                song_id: ap.song_id,
                song: Some(song),
                error: None,
            },
            Err(e) => EnrichApplyResult {
                song_id: ap.song_id,
                song: None,
                error: Some(e.to_string()),
            },
        });
    }
    Ok(resultados)
}

/// Dois campos de texto valem o MESMO valor: comparação após trim, com
/// `None` e string vazia tratados como o mesmo "ausente".
fn mesmo_valor(a: Option<&str>, b: Option<&str>) -> bool {
    fn efetivo(v: Option<&str>) -> &str {
        v.map(str::trim).unwrap_or("")
    }
    efetivo(a) == efetivo(b)
}

/// Grava UMA aplicação (regras de preservação do lote) e devolve a Song
/// atualizada — o apply converte o Err em `EnrichApplyResult::error`.
fn apply_one(conn: &Connection, ap: &EnrichApply) -> Result<Song> {
    let song = db::get_song(conn, ap.song_id)?.ok_or_else(|| {
        crate::error::AppError(format!("música não encontrada: {}", ap.song_id))
    })?;

    // QA A5 — proposta obsoleta não escreve: a varredura pode ter rodado em
    // segundo plano por minutos enquanto o usuário corrigia esta música à mão.
    // Comparação por texto aparado, com None e "" valendo o mesmo (ausente).
    if !mesmo_valor(Some(&song.title), Some(&ap.current_title))
        || !mesmo_valor(song.artist.as_deref(), ap.current_artist.as_deref())
    {
        return Err(crate::error::AppError(AVISO_PROPOSTA_OBSOLETA.into()));
    }

    let lyrics_novo = ap
        .lyrics
        .as_deref()
        .map(str::trim)
        .filter(|l| !l.is_empty());
    let lyrics_atual = db::get_lyrics(conn, ap.song_id)?;
    let atual_efetiva = lyrics_atual
        .as_deref()
        .map(str::trim)
        .filter(|l| !l.is_empty());

    // QA CRÍTICO-1 — letra existente só é trocada com consentimento
    // EXPLÍCITO. O fluxo normal do frontend manda `lyrics: None` quando
    // ninguém pediu substituição, então esta recusa é o cinto de segurança,
    // não o caminho comum: ela existe porque a proposta ALTA chega
    // PRÉ-MARCADA na revisão e um clique já destruiu transcrição corrigida à
    // mão. É o mesmo "não sobrescreve letra" que o tools/curadoria.py aplica
    // desde a DECISIONS #55.
    //
    // Letra IGUAL à que já está lá (texto aparado, como em `mesmo_valor`) não
    // é substituição: nada se perde, e recusar produziria um erro
    // incompreensível para quem só aceitou o título.
    let letra_igual = lyrics_novo.is_some() && lyrics_novo == atual_efetiva;
    if lyrics_novo.is_some() && atual_efetiva.is_some() && !letra_igual && !ap.substituir_letra {
        return Err(crate::error::AppError(AVISO_LETRA_EXISTENTE.into()));
    }

    let lyrics_final = match lyrics_novo {
        // grava exatamente como veio (sem trim)
        Some(_) if !letra_igual => ap.lyrics.clone(),
        // repasse: a letra que já está no arquivo, e não a cópia com espaço
        // diferente que veio na aplicação. Regravar o mesmo texto com outra
        // pontuação de espaço faria o writer considerar a letra TROCADA e
        // derrubar a marca de procedência legítima (DECISIONS #54).
        _ => lyrics_atual,
    };
    let artist_final = ap
        .artist
        .as_deref()
        .map(str::trim)
        .filter(|a| !a.is_empty())
        .map(str::to_string)
        .or_else(|| song.artist.clone());
    let temas_final = match (
        ap.add_temas.as_deref().map(str::trim).filter(|t| !t.is_empty()),
        song.temas.as_deref(),
    ) {
        (Some(novos), Some(atuais)) => Some(format!("{atuais}; {novos}")),
        (Some(novos), None) => Some(novos.to_string()),
        (None, atuais) => atuais.map(str::to_string),
    };
    // V8/F18 — procedência da letra. Só é DECLARADA quando esta gravação
    // traz letra nova: o repasse da letra que já estava no arquivo (o caminho
    // de quem só aceita título/artista) não sabe nada sobre ela e preserva a
    // marca legítima pela regra da DECISIONS #54. Letra do Vagalume fica
    // marcada como tal — o mesmo `TXXX:LETRA_ORIGEM = "vagalume"` que o
    // tools/curadoria.py grava —, e letra de qualquer outra fonte LIMPA a
    // marca: letra oficial nunca é transcrição.
    let do_vagalume = ap
        .fonte
        .as_deref()
        .is_some_and(|f| f.eq_ignore_ascii_case(FONTE_VAGALUME));
    let origem_declarada =
        lyrics_novo.map(|_| if do_vagalume { writer::ORIGEM_VAGALUME } else { "" });
    writer::write_tags_com_origem(
        conn,
        ap.song_id,
        &ap.title,
        artist_final.as_deref(),
        lyrics_final.as_deref(),
        temas_final.as_deref(),
        // V8/F17 — o lote NUNCA mexe na marca de instrumental: ela é escolha
        // humana (ou da curadoria olhando o áudio), e nada aqui a examinou.
        None,
        origem_declarada,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_placeholder_detects_ripper_and_cddb_junk() {
        for texto in [
            "", "   ", "12", "#", "###", "02",
            "AudioTrack 02", "02 AudioTrack 02", "Audio Track 5", "audiotrack",
            "Faixa 8", "faixa 2", "Faixa", "Track 10", "track", "Pista 3",
            "no artist", "No Artist", "unknown artist", "[Unknown Artist]",
            "Artista Desconhecido", "artista desconhecido", "artist",
            "no title", "Sem Título", "sem titulo", "untitled", "Unknown",
        ] {
            assert!(is_placeholder(texto), "{texto:?} deveria ser placeholder");
        }
    }

    #[test]
    fn is_placeholder_keeps_real_names() {
        for texto in [
            "Oh! Chuva", "Chegança", "Antonio Nobrega", "Cali",
            "Faixa de Gaza", "12 Horas", "Música Espírita", "O Artista",
            "Princesa Goiana", "É cedo ainda",
        ] {
            assert!(!is_placeholder(texto), "{texto:?} não é placeholder");
        }
    }

    /// Bateria comparada ao `eh_placeholder` do `tools/curadoria.py`, caso a
    /// caso: as duas metades do porte — a regra de SUBSTRING e a de ruído de
    /// arquivo com marca de ripador — faltavam aqui, e as etiquetas que elas
    /// pegam passavam por REAIS. Uma "04 Faixa 4 Artista Desconheci" julgada
    /// real deixa a música "completa": ela some do funil para sempre.
    ///
    /// A segunda metade da tabela é a proteção contra o incidente inverso (a
    /// regressão do `_RUIDO_DE_ARQUIVO`, que engoliu "Pista", "Gravação" e
    /// "Sem Nome"): condenar um título REAL apaga o trabalho de quem curou.
    #[test]
    fn is_placeholder_matches_the_python_port() {
        const CASOS: &[(&str, bool)] = &[
            // lixo de ripador com sujeira em volta (regra de SUBSTRING)
            ("04 Faixa 4 Artista Desconheci", true),
            ("Artista Desconhecida", true),
            ("05 Unknown Artist", true),
            ("No Artist - 03", true),
            ("Titulo Desconheci", true),
            ("Unknown Title 3", true),
            ("Artista Desconhecido de Verdade", true),
            // só números e palavras de maquinário, COM marca de máquina junto
            ("1-2010 22-17-23)_converted", true),
            ("audiotrack 02 converted", true),
            ("Track 05 copy", true),
            ("faixa 3 mp3", true),
            ("22-17-23 converted", true),
            ("2010-05-03 gravacao", true),
            ("New Recording 12", true),
            ("Sem Titulo 4", true),
            ("untitled 1", true),
            ("01 audio", true),
            ("wav 3", true),
            // ...e o que NÃO pode virar placeholder: palavra de maquinário
            // SOZINHA é título, e sem a marca da máquina a regra não vale
            ("Pista", false),
            ("Gravação", false),
            ("Nome", false),
            ("Sem Nome", false),
            ("Convertido", false),
            ("Copia", false),
            ("Recording", false),
            ("Audio", false),
            ("Nova Gravação", false),
            ("Sem Nome no Mundo", false),
            ("Pista de Dança", false),
            ("Faixa Nobre", false),
            ("Track Dois", false),
            ("Faixa de Gaza", false),
            ("O Artista", false),
            ("12 Horas", false),
        ];
        for (texto, esperado) in CASOS {
            assert_eq!(
                is_placeholder(texto),
                *esperado,
                "{texto:?} — o Python decide {esperado}"
            );
        }
    }

    #[test]
    fn limpar_nome_arquivo_matches_python_rules() {
        assert_eq!(limpar_nome_arquivo("Oh! Chuva.mp3"), "Oh! Chuva");
        assert_eq!(
            limpar_nome_arquivo("Falamansa - Oh! Chuva.mp3"),
            "Falamansa - Oh! Chuva"
        );
        // prefixo de número de faixa (com hífen, ponto ou parênteses)
        assert_eq!(
            limpar_nome_arquivo("08 Na dança das Folhas.mp3"),
            "Na dança das Folhas"
        );
        assert_eq!(limpar_nome_arquivo("08 - Xote.mp3"), "Xote");
        assert_eq!(limpar_nome_arquivo("(08) Xote.mp3"), "Xote");
        // underscores e ruído entre colchetes/parênteses
        assert_eq!(
            limpar_nome_arquivo("Oh_Chuva_[Official]_(Ao Vivo).mp3"),
            "Oh Chuva"
        );
        // parênteses ficam se removê-los deixaria vazio
        assert_eq!(limpar_nome_arquivo("(Instrumental).mp3"), "(Instrumental)");
        // nome só numérico não vira vazio
        assert_eq!(limpar_nome_arquivo("12.mp3"), "12");
    }

    #[test]
    fn gerar_palpites_orders_tag_then_filename_splits() {
        // tags reais vêm primeiro
        let p = gerar_palpites("qualquer.mp3", "Título Tag", "Artista Tag");
        assert_eq!(p[0], ("Título Tag".into(), "Artista Tag".into()));

        // divisor no nome: duas ordens + nome inteiro
        let p = gerar_palpites("Falamansa - Oh! Chuva.mp3", "", "");
        assert_eq!(
            p,
            vec![
                ("Oh! Chuva".to_string(), "Falamansa".to_string()),
                ("Falamansa".to_string(), "Oh! Chuva".to_string()),
                ("Falamansa - Oh! Chuva".to_string(), String::new()),
            ]
        );

        // sem divisor: só o nome inteiro
        assert_eq!(
            gerar_palpites("Só Nome.mp3", "", ""),
            vec![("Só Nome".to_string(), String::new())]
        );

        // título de tag com divisor e artista vazio: split nas duas ordens
        let p = gerar_palpites("arquivo qualquer.mp3", "Hyldon - Musica Bonita", "");
        assert_eq!(p[0], ("Hyldon - Musica Bonita".into(), "".into()));
        assert_eq!(p[1], ("Musica Bonita".into(), "Hyldon".into()));
        assert_eq!(p[2], ("Hyldon".into(), "Musica Bonita".into()));
        assert_eq!(p[3], ("arquivo qualquer".into(), "".into()));

        // com artista real o título de tag não é dividido
        let p = gerar_palpites("x.mp3", "A - B", "Artista");
        assert_eq!(p[0], ("A - B".into(), "Artista".into()));
        assert!(!p.contains(&("B".to_string(), "A".to_string())));
    }

    fn proposta(
        current_title: &str,
        current_artist: Option<&str>,
        proposed_title: &str,
        proposed_artist: Option<&str>,
    ) -> EnrichProposal {
        EnrichProposal {
            song_id: 1,
            file_path: "/m/a.mp3".into(),
            current_title: current_title.into(),
            current_artist: current_artist.map(str::to_string),
            proposed_title: proposed_title.into(),
            proposed_artist: proposed_artist.map(str::to_string),
            lyrics: None,
            confidence: "baixa".into(),
            fonte: FONTE_NOME_ARQUIVO.into(),
            has_lyrics: false,
            letra_origem: None,
            error: None,
        }
    }

    #[test]
    fn e_no_op_uses_the_same_placeholder_notion_as_the_rest_of_the_module() {
        // idêntico em título e artista, sem letra: nada a revisar
        assert!(e_no_op(&proposta(
            "Abrição de portas",
            Some("Antônio Nóbrega"),
            "Abrição de portas",
            Some("Antônio Nóbrega"),
        )));
        // espaços das pontas não contam como mudança
        assert!(e_no_op(&proposta("  Abrição  ", None, "Abrição", None)));
        // None e "" são o mesmo artista (ausente)
        assert!(e_no_op(&proposta("T", None, "T", Some(""))));
        // placeholder ATUAL + palpite também placeholder: os dois valem VAZIO,
        // texto diferente não é mudança
        assert!(e_no_op(&proposta("AudioTrack 17", Some("no artist"), "Faixa", None)));
        // placeholder atual com palpite REAL: é exatamente o que o lote existe
        // para propor
        assert!(!e_no_op(&proposta("Faixa 5", None, "Chegança", Some("Nóbrega"))));
        // só o artista muda: ainda é mudança
        assert!(!e_no_op(&proposta("Abrição", None, "Abrição", Some("Nóbrega"))));

        // letra é a mudança, mesmo com título/artista iguais
        let mut com_letra = proposta("T", Some("A"), "T", Some("A"));
        com_letra.lyrics = Some("letra".into());
        assert!(!e_no_op(&com_letra));

        // linha de erro nunca é descartada (a UI a mostra desabilitada)
        let mut com_erro = proposta("T", Some("A"), "T", Some("A"));
        com_erro.error = Some("sem conexão".into());
        assert!(!e_no_op(&com_erro));
    }

    #[test]
    fn under_prefix_respects_folder_boundaries() {
        // vazio = biblioteca inteira
        assert!(under_prefix("/m/1/a.mp3", ""));
        // fronteira exata de pasta: "/m/1" casa "/m/1/..." mas não "/m/10/..."
        assert!(under_prefix("/m/1/a.mp3", "/m/1"));
        assert!(!under_prefix("/m/10/a.mp3", "/m/1"));
        assert!(under_prefix("/m/10/a.mp3", "/m/10"));
        assert!(under_prefix("/m/1/Sub/a.mp3", "/m/1"));
        // prefixo com barra final também funciona
        assert!(under_prefix("/m/1/a.mp3", "/m/1/"));
        assert!(!under_prefix("/m/10/a.mp3", "/m/1/"));
        // prefixo é pasta: nunca casa o próprio caminho como arquivo
        assert!(!under_prefix("/m/1", "/m/1"));
        // separador Windows
        assert!(under_prefix(r"C:\m\1\a.mp3", r"C:\m\1"));
        assert!(!under_prefix(r"C:\m\10\a.mp3", r"C:\m\1"));
        assert!(under_prefix(r"C:\m\1\a.mp3", r"C:\m\1\"));
    }

    #[test]
    fn gerar_palpites_treats_placeholder_tags_as_empty() {
        let p = gerar_palpites(
            "adventício - Cheganca - Antonio Nobrega.mp3",
            "02 AudioTrack 02",
            "no artist",
        );
        assert_eq!(
            p[0],
            ("Cheganca - Antonio Nobrega".into(), "adventício".into())
        );
        for (titulo, artista) in &p {
            assert!(!titulo.contains("AudioTrack"));
            assert_ne!(artista, "no artist");
        }
        // 3+ segmentos: os dois últimos nas duas ordens também entram
        assert!(p.contains(&("Cheganca".into(), "Antonio Nobrega".into())));
        assert!(p.contains(&("Antonio Nobrega".into(), "Cheganca".into())));
        // dois segmentos não ganham combinações extras (dedup)
        assert_eq!(gerar_palpites("Falamansa - Oh! Chuva.mp3", "", "").len(), 3);
    }
}
