//! F13 (PRD V5) — enriquecimento em lote pelo app.
//!
//! `enrich_scan` seleciona as músicas INCOMPLETAS (sem letra OU com
//! título/artista placeholder) de uma pasta (prefixo de file_path), monta
//! palpites (tags não-placeholder > nome de arquivo limpo — porte do
//! tools/curadoria.py) e consulta o LRCLIB pela mesma infra do lyrics_fetch
//! (fetcher injetável: os testes rodam sem rede; no comando real é o ureq —
//! continua sendo ponto de rede EXPLÍCITO, acionado pelo usuário).
//!
//! `apply` grava as propostas aceitas via writer::write_tags. Regra do lote
//! (V3.1): NUNCA apaga dados existentes — campo ausente/vazio na aplicação
//! preserva o valor atual do arquivo; temas SOMAM aos existentes.

use crate::db::{self, Song};
use crate::error::Result;
use crate::lyrics_fetch::{self, ScoredCandidate};
use crate::writer;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::Duration;

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
}

/// Mensagem (pt-BR, curta) que a UI mostra como está quando a proposta ficou
/// obsoleta entre a varredura e o apply.
pub const AVISO_PROPOSTA_OBSOLETA: &str = "a música mudou depois da varredura — sugestão ignorada";

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

/// `^(?:\d+\s+)?(?:audio\s?track|faixa|track|pista)(?:\s?\d+)?$` sobre a
/// chave normalizada — "AudioTrack 02", "02 Faixa 3", "track", "Pista 3"...
fn placeholder_faixa(chave: &str) -> bool {
    // prefixo numérico opcional ("02 audiotrack 02")
    let s = match chave.split_once(' ') {
        Some((num, resto)) if num.chars().all(|c| c.is_ascii_digit()) => resto,
        _ => chave,
    };
    for kw in ["audio track", "audiotrack", "faixa", "track", "pista"] {
        if let Some(resto) = s.strip_prefix(kw) {
            let resto = resto.strip_prefix(' ').unwrap_or(resto);
            if resto.is_empty() || resto.chars().all(|c| c.is_ascii_digit()) {
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
pub fn is_placeholder(texto: &str) -> bool {
    let chave = lyrics_fetch::norm(texto);
    if chave.is_empty() || chave.chars().all(|c| c.is_ascii_digit()) {
        return true; // vazio, só pontuação/# ou só dígitos
    }
    if PLACEHOLDERS_EXATOS.contains(&chave.as_str()) {
        return true;
    }
    placeholder_faixa(&chave)
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

/// Proposta BAIXA: só o palpite de nome de arquivo, sem letra. Tag REAL
/// existente é preservada no palpite (o lote nunca propõe apagar).
fn proposta_baixa(
    song: &Song,
    titulo_tag: &str,
    artista_tag: &str,
    nome: &str,
    error: Option<String>,
) -> EnrichProposal {
    let (mut titulo_prop, mut artista_prop) = gerar_palpites(nome, "", "")
        .into_iter()
        .next()
        .unwrap_or_default();
    if !titulo_tag.is_empty() {
        titulo_prop = titulo_tag.to_string();
    }
    if !artista_tag.is_empty() {
        artista_prop = artista_tag.to_string();
    }
    EnrichProposal {
        song_id: song.id,
        file_path: song.file_path.clone(),
        current_title: song.title.clone(),
        current_artist: song.artist.clone(),
        proposed_title: titulo_prop,
        proposed_artist: (!artista_prop.is_empty()).then_some(artista_prop),
        lyrics: None,
        confidence: "baixa".into(),
        error,
    }
}

/// Acrescenta a proposta ao lote, a menos que ela não mude nada (`e_no_op`).
fn registrar(propostas: &mut Vec<EnrichProposal>, proposta: EnrichProposal) {
    if !e_no_op(&proposta) {
        propostas.push(proposta);
    }
}

/// Varre as músicas available sob `folder_prefix` (vazio = todas), consulta
/// o LRCLIB para as incompletas e devolve as propostas. `pausa` é a cortesia
/// entre consultas (300 ms no comando real; zero nos testes). Erro de rede
/// por música vira proposta BAIXA com `error` — nunca aborta o lote.
///
/// `on_progress(done, total, nome_do_arquivo)` é chamado DEPOIS de cada música
/// processada, espelhando o `|done, total|` do indexer (evento `scan:progress`).
/// Um primeiro evento com `done = 0` sai antes de qualquer processamento, para
/// a UI já mostrar o total. `total` é o número de CANDIDATAS (depois do filtro
/// de músicas completas, antes do descarte de no-op): mede trabalho, não
/// resultado — o progresso avança mesmo quando a proposta é descartada, quando
/// a rede falha ou quando o arquivo sumiu do disco.
///
/// `cancelled()` (QA M4) é consultado ANTES de cada música — inclusive antes
/// da primeira, quando nem o evento inicial de progresso sai. Cancelar faz a
/// varredura voltar CEDO com as propostas que já tinha (vec vazio se ainda não
/// havia nenhuma), sem gastar mais rede nem emitir mais progresso: o "Cancelar"
/// da UI só descarta o resultado, e a varredura zumbi ficava consultando o
/// LRCLIB por minutos e embaralhando a barra da varredura seguinte.
pub fn enrich_scan<F, P, C>(
    conn: &Connection,
    folder_prefix: &str,
    fetch: F,
    pausa: Duration,
    on_progress: P,
    cancelled: C,
) -> Result<Vec<EnrichProposal>>
where
    F: Fn(&str) -> Result<String>,
    P: Fn(usize, usize, &str),
    C: Fn() -> bool,
{
    if cancelled() {
        return Ok(Vec::new());
    }

    // 1ª passada (sem rede): seleciona as candidatas para o total do progresso
    // ser conhecido antes da primeira consulta.
    let mut candidatas: Vec<(Song, String, String, String)> = Vec::new();
    for song in db::list_songs(conn)? {
        if !song.available {
            continue;
        }
        if !under_prefix(&song.file_path, folder_prefix) {
            continue;
        }
        let titulo_tag = sem_placeholder(&song.title).to_string();
        let artista_tag = sem_placeholder(song.artist.as_deref().unwrap_or("")).to_string();
        let completa = song.has_lyrics && !titulo_tag.is_empty() && !artista_tag.is_empty();
        if completa {
            continue;
        }
        let nome = Path::new(&song.file_path)
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        candidatas.push((song, titulo_tag, artista_tag, nome));
    }

    let total = candidatas.len();
    on_progress(0, total, ""); // total na tela antes da primeira consulta

    let mut propostas = Vec::new();
    let mut primeira = true;
    for (feitas, (song, titulo_tag, artista_tag, nome)) in candidatas.into_iter().enumerate() {
        // cancelamento entre músicas: volta com o que já tem (QA M4)
        if cancelled() {
            return Ok(propostas);
        }

        // arquivo sumido do disco: reporta sem gastar rede
        if !Path::new(&song.file_path).is_file() {
            registrar(
                &mut propostas,
                proposta_baixa(
                    &song,
                    &titulo_tag,
                    &artista_tag,
                    &nome,
                    Some(format!("arquivo não encontrado: {}", song.file_path)),
                ),
            );
            on_progress(feitas + 1, total, &nome);
            continue;
        }

        let duracao = song.duration_seconds.unwrap_or(0) as f64;
        let mut best: Option<ScoredCandidate> = None;
        let mut erro: Option<String> = None;
        for (titulo, artista) in gerar_palpites(&nome, &titulo_tag, &artista_tag) {
            if !primeira && !pausa.is_zero() {
                std::thread::sleep(pausa); // cortesia com a API entre consultas
            }
            primeira = false;
            match lyrics_fetch::query_best(&titulo, &artista, duracao, &fetch, |t, a| {
                !is_placeholder(t) && !is_placeholder(a)
            }) {
                Ok(Some(cand)) => {
                    if best.as_ref().is_none_or(|b| cand.score > b.score) {
                        best = Some(cand);
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
        let proposta = match (erro, best, confianca) {
            (None, Some(b), Some(conf)) => EnrichProposal {
                song_id: song.id,
                file_path: song.file_path.clone(),
                current_title: song.title.clone(),
                current_artist: song.artist.clone(),
                proposed_title: b.matched_title,
                proposed_artist: (!b.matched_artist.is_empty()).then_some(b.matched_artist),
                lyrics: Some(b.lyrics),
                confidence: conf.to_string(),
                error: None,
            },
            (erro, _, _) => proposta_baixa(&song, &titulo_tag, &artista_tag, &nome, erro),
        };
        registrar(&mut propostas, proposta);
        on_progress(feitas + 1, total, &nome);
    }
    Ok(propostas)
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
    let lyrics_final = match lyrics_novo {
        Some(_) => ap.lyrics.clone(), // grava exatamente como veio (sem trim)
        None => db::get_lyrics(conn, ap.song_id)?, // preserva a letra atual
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
    writer::write_tags(
        conn,
        ap.song_id,
        &ap.title,
        artist_final.as_deref(),
        lyrics_final.as_deref(),
        temas_final.as_deref(),
        // V8/F17 — o lote NUNCA mexe na marca de instrumental: ela é escolha
        // humana (ou da curadoria olhando o áudio), e nada aqui a examinou.
        None,
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
