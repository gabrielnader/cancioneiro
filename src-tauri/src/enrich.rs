//! F13 (PRD V5) + F18 fases 1 e 2 (PRD V8 e V9) — o funil de curadoria
//! dentro do app.
//!
//! `enrich_scan` escolhe as músicas de uma pasta (prefixo de file_path) e
//! passa cada uma pelas etapas do funil, cada etapa recebendo só o que a
//! anterior não resolveu:
//!
//! | etapa | `fonte`                  | custo       | o que faz            |
//! |-------|--------------------------|-------------|----------------------|
//! | 1     | "nome do arquivo"        | instantâneo | palpite local a partir das etiquetas e do nome do arquivo (porte do tools/curadoria.py) |
//! | 2     | "reconhecimento pelo som"| ~1 s        | IDENTIDADE: título e artista pelo AcoustID |
//! | 3     | "LRCLIB"                 | ~0,5 s      | letra, conferida pela DURAÇÃO |
//! | 4     | "Vagalume"               | ~0,5 s      | letra, casamento estrito de texto |
//!
//! A etapa 5 (transcrição) é a v0.10.0 e não existe aqui.
//!
//! # Por que a impressão digital vem ANTES das fontes de letra
//!
//! Ela não é fonte de letra — não devolve letra nenhuma. Ela devolve
//! **identidade**, que é *entrada* de todas as outras. São duas fases
//! distintas: descobrir que música é esta (1 e 2), e conseguir a letra dela
//! (3, 4, 5). Ordená-la por custo, no meio das fontes de letra, foi erro de
//! categoria.
//!
//! A consequência prática está em `palpites_de_letra`: **com nome verdadeiro
//! em mãos, as etapas 3 e 4 recebem UM palpite**, em vez da cascata de até
//! sete do `gerar_palpites`, cada um com sua pausa de cortesia. Décimos de
//! segundo de CPU local compram até seis idas à rede a menos por música. O
//! `gerar_palpites` continua sendo o caminho de quem o AcoustID não
//! reconheceu — que é a maioria.
//!
//! # O risco que essa ordem cria, e o que o segura
//!
//! Antes, um erro do AcoustID estragaria uma consulta. Agora ele
//! **contamina tudo o que vem depois**: com título e artista errados, o
//! LRCLIB acha a letra da música errada e devolve ALTA, porque a duração vai
//! bater — o AcoustID também casa por duração, então os dois erram juntos e
//! de forma consistente. Seria letra errada com toda a aparência de certa.
//! É a família do incidente "Ponto de Ogum" dentro de "Ponto de Oxum"
//! (DECISIONS #63), agora com multiplicador. Três travas:
//!
//! 1. **as regras de aceitação do AcoustID não se afrouxam**, em hipótese
//!    nenhuma — nem "só um pouco" para aumentar a taxa de acerto. Afrouxá-las
//!    agora não custa uma proposta ruim: propaga o erro para as etapas de
//!    letra. Elas moram no `fingerprint`, calibradas contra erro medido;
//! 2. **nome recusado pela régua não vaza**: as etapas de letra voltam aos
//!    palpites locais, e há teste fixando isso;
//! 3. **letra achada por nome vindo do SOM tem teto de confiança MÉDIA** —
//!    ver `TETO_COM_IDENTIDADE_DO_SOM`.
//!
//! # Os dois modos de varredura
//!
//! `Modo::Completar` é a varredura de sempre: só as músicas incompletas.
//! `Modo::Conferencia` é outro trabalho — perguntar ao som se a etiqueta
//! está certa — e por isso inclui as músicas COMPLETAS, que a outra nunca
//! alcança. Ver `Modo`.
//!
//! Todo o acesso à rede entra por `Fontes`, injetável — os testes rodam sem
//! rede; no comando real é o `ureq`, e continua sendo ponto de rede
//! EXPLÍCITO, acionado pelo usuário, limitado a LRCLIB, Vagalume e AcoustID.
//!
//! `apply` grava as propostas aceitas via writer::write_tags. Regra do lote
//! (V3.1): NUNCA apaga dados existentes — campo ausente/vazio na aplicação
//! preserva o valor atual do arquivo; temas SOMAM aos existentes.

use crate::db::{self, Song};
use crate::error::Result;
use crate::fingerprint::{self, Identificacao};
use crate::lyrics_fetch::{self, ScoredCandidate};
use crate::vagalume;
use crate::writer;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::cell::Cell;
use std::path::Path;
use std::time::Duration;

/// O que o funil precisa do mundo de fora.
///
/// Um simples `Fn(&str) -> Result<String>` já é `Fontes`: traz a rede e mais
/// nada, com a etapa 2 desligada. Isso NÃO é uma conveniência de teste — é o
/// estado real de quem ainda não baixou o acessório `fpcalc`, que é o estado
/// de toda instalação nova. O comando de verdade passa uma implementação
/// completa; a suíte exercita as duas.
pub trait Fontes {
    /// GET da URL. Só LRCLIB, Vagalume e AcoustID passam pelo fetcher real.
    fn buscar(&self, url: &str) -> Result<String>;

    /// O acessório `fpcalc` está pronto nesta máquina? Consultado ANTES de
    /// anunciar a etapa na tela — anunciar "reconhecendo pelo som" para
    /// depois não reconhecer nada seria descrever trabalho que não houve.
    fn reconhece_pelo_som(&self) -> bool {
        false
    }

    /// Roda o `fpcalc` sobre o arquivo. `None` = o acessório não está pronto
    /// (etapa pulada em silêncio); `Some(Err)` = ele rodou e falhou.
    ///
    /// `cancelado` é consultado DENTRO da leitura do som: ela é a única etapa
    /// do funil que gasta tempo sem tocar a rede, e um `fpcalc` travado
    /// segurava o "Cancelar" por até 120 s (QA A4).
    fn impressao_digital(
        &self,
        _mp3: &Path,
        _cancelado: &dyn Fn() -> bool,
    ) -> Option<Result<fingerprint::Impressao>> {
        None
    }

    /// Chave do AcoustID compilada nesta build. Vazia = etapa 2 pulada em
    /// silêncio, como o Vagalume sem chave.
    fn chave_acoustid(&self) -> &str {
        ""
    }
}

impl<F> Fontes for F
where
    F: Fn(&str) -> Result<String>,
{
    fn buscar(&self, url: &str) -> Result<String> {
        self(url)
    }
}

/// O que a varredura está fazendo. São dois TRABALHOS distintos, com custos
/// distintos, e o padrão não muda.
///
/// A separação existe por um caso real: um arquivo etiquetado "Te ver feliz,
/// te ver contente" / "Caetano Veloso" que é, de verdade, "Viver Feliz" do
/// Nilson Chaves. O funil inteiro supunha duas categorias — campo faltando =
/// completar, campo com texto real = confiável —, e "Caetano Veloso" não é
/// placeholder por regra nenhuma. Com letra no arquivo, essa música é
/// "completa" e **nunca entra em varredura**: o erro fica invisível para
/// sempre. São duas populações diferentes, e só a etapa 2 alcança a segunda,
/// porque é a única que ignora a etiqueta e pergunta ao som.
///
/// Atravessa o IPC como texto minúsculo e sem acento — `"completar"` ou
/// `"conferencia"` —, no mesmo estilo do resto do contrato. Ausente no JSON
/// vale `Completar`: se um dia o frontend esquecer o campo, o que acontece é
/// a varredura barata de sempre, nunca a cara por engano.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Modo {
    /// Completar o que falta — a varredura de sempre, só nas músicas
    /// incompletas, com o funil inteiro.
    #[default]
    Completar,
    /// Conferir se a etiqueta bate com o som. Alcança TODAS as músicas
    /// disponíveis, inclusive as completas, e roda **só a etapa 2**: as
    /// etapas de letra são o outro trabalho. O custo é outro também — o
    /// `fpcalc` lê o áudio de cada arquivo, então isto são minutos para um
    /// acervo, não segundos —, e por isso é disparada de propósito.
    Conferencia,
}

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
/// `fonte` — etapa 2: a identidade veio do SOM (impressão digital acústica
/// confirmada pelo AcoustID). Aparece crua na tela, então diz o que é em
/// palavras de gente: quem revisa precisa entender, de relance, que esta
/// linha não saiu de uma etiqueta nem de uma base de letras.
pub const FONTE_IMPRESSAO_DIGITAL: &str = "reconhecimento pelo som";
/// `fonte` — etapa 3: LRCLIB, com a duração conferida.
pub const FONTE_LRCLIB: &str = "LRCLIB";
/// `fonte` — etapa 4: Vagalume, por casamento estrito de texto (não há
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
/// `etapa` — lendo o áudio e perguntando que música é esta.
pub const ETAPA_IMPRESSAO_DIGITAL: &str = "reconhecendo pelo som";
/// `etapa` — consultando o LRCLIB.
pub const ETAPA_LRCLIB: &str = "procurando no LRCLIB";
/// `etapa` — consultando o Vagalume.
pub const ETAPA_VAGALUME: &str = "procurando no Vagalume";
/// `etapa` — esta música terminou; é o ÚNICO evento que faz `done` crescer.
pub const ETAPA_CONCLUIDA: &str = "concluída";

/// Teto de confiança da letra achada com um nome que veio do SOM.
///
/// ALTA chega PRÉ-MARCADA na revisão (DECISIONS #49), e ALTA no resto do
/// produto significa "a duração confirmou um nome que o ARQUIVO já
/// afirmava". Aqui não é isso: o nome veio do AcoustID, que casou por
/// duração, e o LRCLIB o confirmou pela MESMA duração — a segunda conta não
/// é independente da primeira, é a mesma conta feita duas vezes. Se o
/// AcoustID errar a gravação, os dois erram juntos e o resultado tem toda a
/// aparência de certo.
///
/// Não temos medição da taxa de erro do AcoustID neste repertório (o número
/// que temos, 16%, é taxa de acerto, não de falso positivo). Sem medição, o
/// produto não pré-marca: o teto é MÉDIA, e quem cura dá o clique. Custa uma
/// marcação — "Marcar todas" continua existindo — e fecha o único caminho em
/// que um clique escreveria a letra da música errada num arquivo que estava
/// bom.
const TETO_COM_IDENTIDADE_DO_SOM: &str = "media";

/// O que uma varredura aprende sobre SI MESMA enquanto roda: vereditos que
/// valem para as músicas seguintes, e a conta do que deixou de ser feito por
/// causa deles.
///
/// Um veredito é uma afirmação sobre a VARREDURA ("esta chave está recusada",
/// "este acessório não roda nesta máquina"), nunca sobre um arquivo. Erro de
/// um arquivo não entra aqui — ele vira a linha de erro daquela música e a
/// fila segue (QA A2).
#[derive(Default)]
struct EstadoDaVarredura {
    /// O Vagalume recusou a chave: etapa 4 desligada pelo resto da varredura,
    /// em vez de reescrever a mesma acusação 95 vezes (DECISIONS #83).
    chave_recusada: Cell<bool>,
    /// O acessório do som não CONSEGUE RODAR nesta máquina, ou o AcoustID
    /// recusou este aplicativo: etapa 2 desligada pelo resto.
    som_desligado: Cell<bool>,
    /// Quantas músicas passaram sem que o som fosse perguntado por causa do
    /// desligamento acima. Sem este número, a pessoa vê uma linha vermelha,
    /// as outras 149 sem nada, e conclui que o resto foi conferido — a
    /// DECISIONS #86 acontecendo por omissão de escopo.
    sem_perguntar_ao_som: Cell<usize>,
}

/// O que uma varredura em lote devolve.
///
/// Era um `Vec<EnrichProposal>` puro até a v0.9.0, e por isso não havia onde
/// dizer que a etapa do som tinha sido desligada no meio: quem mandou
/// conferir 150 músicas via uma linha de erro e 149 linhas em branco, sem
/// nada na tela avisando que aquelas 149 nunca chegaram a ser perguntadas
/// (QA A2). "Não sabemos" precisa ser um estado (DECISIONS #86), e para isso
/// precisa existir um campo.
#[derive(Debug, Clone, Default, Serialize)]
pub struct EnrichScanResult {
    pub propostas: Vec<EnrichProposal>,
    /// Músicas que teriam sido perguntadas ao som e não foram, porque a etapa
    /// 2 se desligou antes de chegar nelas. Zero é o caso normal.
    pub sem_perguntar_ao_som: usize,
}

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
    /// Aceitar esta proposta trocaria um título ou artista que uma PESSOA
    /// escreveu (V9).
    ///
    /// É a DECISIONS #79 do lado das etiquetas. O LRCLIB devolve a grafia
    /// oficial, e a grafia oficial quase sempre difere da que alguém digitou:
    /// "Ponto de Oxum" volta como "Ponto de Oxum (Ao Vivo)", com a duração
    /// batendo, portanto ALTA, portanto PRÉ-MARCADA (DECISIONS #49) — e um
    /// clique em "Aplicar selecionadas" leva embora a curadoria de ~40
    /// pessoas que digitaram aquilo à mão.
    ///
    /// O que está errado NÃO é a troca: a revisão mostra o valor atual ao
    /// lado do proposto, então trocar nome não é invisível como trocar letra
    /// era (ali a linha dizia só "letra encontrada"). O que está errado é a
    /// pré-marcação transformar em UM clique o que deveria ser uma escolha
    /// por linha. Por isso aqui NÃO há o mecanismo de consentimento do
    /// `substituir_letra`, e o `apply` não recusa nada: é informação, e o
    /// frontend decide o que fazer com ela.
    ///
    /// "Escrito por gente" exclui três coisas — campo vazio, placeholder de
    /// ripador, e o título que o indexador copiou do nome do arquivo
    /// (DECISIONS #91). Preencher um branco ou substituir "Faixa 03" continua
    /// pré-marcável: é exatamente para isso que a varredura existe.
    pub substitui_nome_escrito: bool,
    /// O SOM discorda da etiqueta REAL que já está no arquivo (V9).
    ///
    /// Quando isto vem preenchido, a linha existe para INFORMAR, não para
    /// corrigir: `proposed_title`/`proposed_artist` continuam sendo o que já
    /// está lá, `confidence` é sempre "baixa" (nunca pré-marcada, em
    /// nenhuma confiança) e nenhuma etapa de letra chegou a rodar. A regra
    /// inviolável é "tag real nunca é sobrescrita sem confirmação", e este é
    /// literalmente o caso que ela descreve — o `tools/curadoria.py` chama
    /// isso de CONFLITO e também não grava nada.
    ///
    /// A UI mostra os DOIS lados e a pessoa decide. Aceitar o que o som diz
    /// é uma escolha humana explícita, que volta pelo `apply` como qualquer
    /// outra edição.
    pub conflito: Option<Conflito>,
    /// Erro por música (ex.: "sem conexão", arquivo sumido) — nunca aborta
    /// o lote.
    pub error: Option<String>,
}

/// O outro lado de uma divergência: o que o SOM diz que esta música é.
#[derive(Debug, Clone, Serialize)]
pub struct Conflito {
    pub titulo: String,
    pub artista: String,
    /// "alta" | "media" — a confiança da IDENTIFICAÇÃO acústica, não a da
    /// linha (que é sempre "baixa", para nunca chegar pré-marcada).
    pub confianca: String,
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
/// Três exceções, nesta ordem:
/// - `error` presente: a linha (desabilitada na UI) É a informação — o usuário
///   precisa saber que a música foi tentada e falhou (decisão 47);
/// - `conflito` presente: idem, e com mais razão — a linha existe justamente
///   porque nada muda e alguém precisa saber por quê (V9);
/// - `lyrics` presente: a letra é a mudança, mesmo com título/artista iguais.
///
/// A comparação usa `current_title`/`current_artist` da própria proposta — os
/// mesmos textos que a UI exibe na coluna "atual" —, normalizados por
/// `campo_efetivo`.
fn e_no_op(p: &EnrichProposal) -> bool {
    p.error.is_none()
        && p.conflito.is_none()
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
        // calculado num lugar só, na saída do `processar_musica`
        substitui_nome_escrito: false,
        conflito: None,
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
        self.esperar_ao_menos(Duration::ZERO);
    }

    /// Cortesia com um piso PRÓPRIO desta consulta: o AcoustID pede no
    /// máximo ~3 por segundo (0,34 s), mais que os 300 ms das fontes de
    /// letra. Pausa configurada em zero é o desligamento explícito dos
    /// testes e continua valendo zero — piso nenhum a ressuscita.
    fn esperar_ao_menos(&self, minimo: Duration) {
        if self.pausa.is_zero() {
            self.primeira.set(false);
            return;
        }
        if !self.primeira.replace(false) {
            std::thread::sleep(self.pausa.max(minimo));
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

impl Candidata {
    /// O título que alguém realmente ESCREVEU — vazio quando não há.
    ///
    /// `indexer.rs` copia o nome do arquivo para o `title` quando o MP3 não
    /// tem TIT2 (DECISIONS #91), e isso não é etiqueta: é o indexador
    /// falando. A distinção é crítica na etapa 2, e nas duas pontas:
    ///
    /// - tratar a invenção como etiqueta REAL faria o som CONTRADIZER o nome
    ///   do arquivo em todo arquivo sem tag, e "Falamansa - Oh! Chuva.mp3"
    ///   identificado como "Oh! Chuva" viraria CONFLITO. Seria a etapa 2
    ///   falhando exatamente na metade pior etiquetada do acervo — a
    ///   população que ela existe para resolver;
    /// - e faria a identificação nunca preencher o título, porque o campo
    ///   "já estaria ocupado".
    ///
    /// A resposta não é perfeita (um arquivo bem nomeado pode ter etiqueta
    /// idêntica ao nome) e não precisa ser: nesse caso o som confirma o que
    /// já está lá, e a proposta cai por no-op.
    fn titulo_escrito(&self) -> &str {
        if titulo_e_o_nome_do_arquivo(&self.titulo_tag, &self.nome) {
            ""
        } else {
            &self.titulo_tag
        }
    }
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
///
/// No `Modo::Conferencia` o filtro NÃO se aplica: o trabalho ali é perguntar
/// ao som se a etiqueta está certa, e a música que mais precisa dessa
/// pergunta é justamente a que parece completa — título real, artista real,
/// letra — e está errada. Um `if` no mesmo lugar, e não uma segunda função:
/// a regra de quem é candidata é UMA (a cópia divergente foi o defeito
/// ALTO-2 da rodada passada).
fn candidata(song: Song, modo: Modo) -> Option<Candidata> {
    if !song.available {
        return None;
    }
    let cand = montar_candidata(song, None, None);
    if modo == Modo::Conferencia {
        return Some(cand);
    }
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
pub fn count_candidatas(conn: &Connection, folder_prefix: &str, modo: Modo) -> Result<usize> {
    Ok(db::list_songs(conn)?
        .into_iter()
        .filter(|s| under_prefix(&s.file_path, folder_prefix))
        .filter_map(|s| candidata(s, modo))
        .count())
}

/// Passa UMA música pelo funil e devolve a proposta. `None` significa
/// CANCELADA no meio do caminho — a varredura volta cedo sem contabilizar
/// esta música (nem proposta, nem progresso).
///
/// `etapa(nome)` é chamada ao ENTRAR em cada etapa, para a UI dizer o que
/// está acontecendo agora; nenhuma delas faz `done` crescer.
#[allow(clippy::too_many_arguments)]
fn processar_musica<S, C, E>(
    cand: &Candidata,
    fontes: &S,
    modo: Modo,
    chave_vagalume: &str,
    estado: &EstadoDaVarredura,
    cortesia: &Cortesia,
    cancelled: &C,
    etapa: E,
) -> Option<EnrichProposal>
where
    S: Fontes,
    C: Fn() -> bool,
    E: Fn(&str),
{
    let mut proposta = passar_pelo_funil(
        cand,
        fontes,
        modo,
        chave_vagalume,
        estado,
        cortesia,
        cancelled,
        etapa,
    )?;
    // Num lugar SÓ, na saída: o funil tem cinco pontos de retorno com
    // proposta, e uma etapa nova amanhã teria um sexto. Marcar em cada um
    // deles é o tipo de coisa que fica correta hoje e silenciosamente errada
    // na próxima rodada — e o modo de falhar aqui é pré-marcar a troca de um
    // nome curado, que é justamente o que este campo existe para impedir.
    proposta.substitui_nome_escrito = substitui_nome_escrito(cand, &proposta);
    Some(proposta)
}

/// Esta proposta trocaria um título ou artista ESCRITO POR GENTE?
///
/// Compara por valor EFETIVO dos dois lados (`campo_efetivo`), como o
/// `e_no_op`: " Oxum " não é outro nome que "Oxum". Proposta vazia num campo
/// não conta como troca — o `apply` preserva o valor atual nesse caso, então
/// avisar seria avisar de uma substituição que não aconteceria.
fn substitui_nome_escrito(cand: &Candidata, p: &EnrichProposal) -> bool {
    fn trocaria(escrito: &str, proposto: &str) -> bool {
        let (escrito, proposto) = (campo_efetivo(escrito), campo_efetivo(proposto));
        !escrito.is_empty() && !proposto.is_empty() && proposto != escrito
    }
    // `titulo_escrito` já descarta placeholder e a invenção do indexador;
    // `artista_tag` já descarta placeholder (o indexador não inventa artista)
    trocaria(cand.titulo_escrito(), &p.proposed_title)
        || trocaria(&cand.artista_tag, p.proposed_artist.as_deref().unwrap_or(""))
}

#[allow(clippy::too_many_arguments)]
fn passar_pelo_funil<S, C, E>(
    cand: &Candidata,
    fontes: &S,
    modo: Modo,
    chave_vagalume: &str,
    estado: &EstadoDaVarredura,
    cortesia: &Cortesia,
    cancelled: &C,
    etapa: E,
) -> Option<EnrichProposal>
where
    S: Fontes,
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

    let mut erro: Option<String> = None;

    // --- etapa 2: IDENTIDADE pelo som (AcoustID) --------------------------
    //
    // Roda também para INSTRUMENTAL: ela dá título e artista sem encostar em
    // letra — é o oposto das etapas de letra, e "instrumental sem letra ainda
    // pode (e deve) ter título e artista corretos" (PRD V8).
    let mut identidade: Option<(String, String, &'static str)> = None;
    let mut duracao_provada: Option<f64> = None;

    let som_disponivel =
        fontes.reconhece_pelo_som() && !fontes.chave_acoustid().trim().is_empty();
    if som_disponivel && estado.som_desligado.get() {
        // A etapa existia para esta música e não foi feita. Contar é o que
        // permite à tela dizer quantas ficaram sem ser perguntadas, em vez de
        // deixar a pessoa concluir que o silêncio é aprovação (QA A2).
        estado
            .sem_perguntar_ao_som
            .set(estado.sem_perguntar_ao_som.get() + 1);
    }
    if som_disponivel && !estado.som_desligado.get() {
        if cancelled() {
            return None;
        }
        etapa(ETAPA_IMPRESSAO_DIGITAL);
        match fontes.impressao_digital(Path::new(&cand.song.file_path), &|| cancelled()) {
            // o acessório sumiu entre o começo da varredura e agora: silêncio
            None => {}
            Some(Err(e)) => {
                // QA A2 — falha do `fpcalc` é erro DESTA música, e o funil
                // segue. Faixa curta, gravação silenciosa e arquivo danificado
                // são comuns num acervo de gravação de casa: medido com o
                // `fpcalc` de verdade nas fixtures do projeto, TRÊS dos quatro
                // arquivos falham. Desligar a etapa no primeiro soluço fazia
                // uma varredura de conferência de 150 músicas perguntar ao som
                // UMA vez, mostrar uma linha vermelha e deixar as outras 149
                // com a aparência de conferidas.
                //
                // Só VEREDITO desliga — o acessório que não roda nesta máquina
                // ou o AcoustID que recusou este aplicativo —, exatamente como
                // a etapa 4 só se desliga com `ERRO_CHAVE_RECUSADA`. A
                // incoerência entre as duas etapas era o achado.
                if cancelled() {
                    return None; // o `fpcalc` foi morto pelo "Cancelar"
                }
                let msg = e.to_string();
                if msg == fingerprint::ERRO_FPCALC_NAO_EXECUTA {
                    estado.som_desligado.set(true);
                }
                erro = Some(msg);
            }
            Some(Ok(impressao)) => {
                // A duração que o fpcalc mediu DECODIFICANDO o áudio é a
                // melhor prova de duração que o produto tem; o cabeçalho já
                // mentiu por uma ordem de grandeza (DECISIONS #72). Daqui
                // para a frente é ela que confere os candidatos.
                duracao_provada = Some(impressao.duracao);
                if cancelled() {
                    return None;
                }
                cortesia.esperar_ao_menos(fingerprint::PAUSA_ACOUSTID);
                match fingerprint::identificar(&impressao, fontes.chave_acoustid(), &|url| {
                    fontes.buscar(url)
                }) {
                    Ok(Some(id)) => {
                        if let Some(conflito) = conflito_com_a_etiqueta(cand, &id) {
                            // O som contradiz etiqueta REAL. A linha existe
                            // para informar, e o funil PARA aqui: procurar
                            // letra sob um nome que o som acabou de
                            // contradizer é o caminho mais curto para gravar
                            // a letra da música errada.
                            let mut p = proposta_baixa(cand, None);
                            p.fonte = FONTE_IMPRESSAO_DIGITAL.into();
                            p.conflito = Some(conflito);
                            return Some(p);
                        }
                        identidade = Some(identidade_util(cand, &id));
                    }
                    Ok(None) => {}
                    Err(e) => {
                        let msg = e.to_string();
                        // chave recusada é veredito sobre a varredura
                        // INTEIRA, não sobre esta música
                        if msg == fingerprint::ERRO_CHAVE_RECUSADA {
                            estado.som_desligado.set(true);
                        }
                        erro = Some(msg);
                    }
                }
            }
        }
    }

    // A conferência é UM trabalho — perguntar ao som —, e termina aqui.
    if modo == Modo::Conferencia {
        return Some(proposta_da_identidade(cand, identidade, erro));
    }

    // V8/F17 — as etapas 3 e 4 são etapas de LETRA, e a música marcada como
    // instrumental para aqui, com o que as etapas 1 e 2 acharam.
    //
    // Não é economia de rede, e NÃO é filtro de completude: é regra de
    // INTEGRIDADE, e por isso ela sobreviveu à remoção do portão da varredura
    // de uma música só (QA ALTO-3b). Um instrumental com título e artista
    // corretos casa com a versão CANTADA da mesma peça no LRCLIB e sai ALTA —
    // e ALTA chega pré-marcada na revisão (DECISIONS #49). Um clique gravaria
    // a letra de outra gravação dentro do arquivo. Nem "quem clicou sabe o
    // que quer" autoriza pôr letra de terceiro dentro de uma peça sem voz.
    if cand.song.instrumental {
        return Some(proposta_da_identidade(cand, identidade, erro));
    }

    // Rede caída derruba TODAS as fontes: insistir só gastaria o tempo de
    // quem está esperando.
    if erro.is_some() {
        return Some(proposta_da_identidade(cand, identidade, erro));
    }

    // --- etapa 3: LRCLIB (título/artista + duração) -----------------------
    etapa(ETAPA_LRCLIB);
    // a duração PROVADA quando o som foi lido; senão, a do cabeçalho, como
    // sempre foi (e um cabeçalho absurdo simplesmente não casa nada)
    let duracao =
        duracao_provada.unwrap_or_else(|| cand.song.duration_seconds.unwrap_or(0) as f64);
    let palpites = palpites_de_letra(cand, &identidade);
    let mut best: Option<ScoredCandidate> = None;
    for (titulo, artista) in palpites {
        // cancelar precisa parar a REDE, não só a fila de músicas: um único
        // arquivo chega a render quatro palpites, cada um com sua pausa.
        if cancelled() {
            return None;
        }
        cortesia.esperar();
        match lyrics_fetch::query_best(&titulo, &artista, duracao, &|url| fontes.buscar(url), |t, a| {
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
        // Com identidade vinda do SOM, os NOMES propostos são os dela (já
        // filtrados pelo conflito e preenchendo só campo vazio), não os que o
        // LRCLIB devolveu: a autoridade sobre a identidade é a impressão
        // digital, e uma segunda fonte de nome só criaria divergência.
        let (titulo_prop, artista_prop) = match &identidade {
            Some((t, a, _)) => (t.clone(), a.clone()),
            None => (b.matched_title.clone(), b.matched_artist.clone()),
        };
        return Some(EnrichProposal {
            song_id: cand.song.id,
            file_path: cand.song.file_path.clone(),
            current_title: cand.song.title.clone(),
            current_artist: cand.song.artist.clone(),
            proposed_title: titulo_prop,
            proposed_artist: (!artista_prop.is_empty()).then_some(artista_prop),
            lyrics: Some(b.lyrics.clone()),
            confidence: if identidade.is_some() {
                TETO_COM_IDENTIDADE_DO_SOM.to_string()
            } else {
                conf.to_string()
            },
            fonte: FONTE_LRCLIB.into(),
            has_lyrics: cand.song.has_lyrics,
            letra_origem: cand.song.letra_origem.clone(),
            // calculado num lugar só, na saída do `processar_musica`
            substitui_nome_escrito: false,
            conflito: None,
            error: None,
        });
    }

    // --- etapa 4: Vagalume, SÓ onde o LRCLIB veio vazio --------------------
    //
    // Quatro condições, as três primeiras herdadas do tools/curadoria.py:
    // - o LRCLIB não trouxe letra confiável (o funil só passa adiante o que a
    //   etapa anterior não resolveu) E não falhou (rede caída derruba as duas
    //   fontes; insistir só gastaria o tempo do usuário);
    // - há chave (sem chave a etapa é pulada em silêncio);
    // - há título E artista REAIS para conferir. O Vagalume não tem duração:
    //   a igualdade de palavras dos dois lados é a única prova que existe, e
    //   ela precisa de um pedido que já signifique alguma coisa. Palpite de
    //   nome de arquivo não é isso — mas identidade vinda do SOM é, e é
    //   justamente por isso que ela vem antes: o que a etapa 2 conquista
    //   habilita esta aqui;
    // - a chave ainda não foi recusada nesta varredura (QA MÉDIO-6): chave
    //   errada não melhora entre uma música e a seguinte, e insistir custa
    //   meio segundo por arquivo para reescrever a mesma linha de erro 95
    //   vezes. A primeira reporta; as demais pulam em silêncio, igual ao que
    //   já acontece quando não há chave nenhuma.
    let (titulo_consulta, artista_consulta) = match &identidade {
        Some((t, a, _)) => (t.clone(), a.clone()),
        None => (cand.titulo_tag.clone(), cand.artista_tag.clone()),
    };
    let sem_letra_do_lrclib = erro.is_none() && confianca.is_none();
    let tem_o_que_conferir = !titulo_consulta.is_empty() && !artista_consulta.is_empty();
    if sem_letra_do_lrclib
        && !chave_vagalume.trim().is_empty()
        && tem_o_que_conferir
        && !estado.chave_recusada.get()
    {
        if cancelled() {
            return None;
        }
        etapa(ETAPA_VAGALUME);
        cortesia.esperar();
        match vagalume::fetch_lyrics_vagalume(
            &titulo_consulta,
            &artista_consulta,
            chave_vagalume,
            &|url| fontes.buscar(url),
            |t, a| !is_placeholder(t) && !is_placeholder(a),
        ) {
            // A régua estrita garante que o título/artista devolvidos são as
            // MESMAS palavras do que foi pedido; então a etapa não propõe
            // trocar nome nenhum — a letra é a mudança inteira.
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
                    proposed_title: titulo_consulta,
                    proposed_artist: Some(artista_consulta),
                    lyrics: Some(m.lyrics),
                    confidence: "media".into(),
                    fonte: FONTE_VAGALUME.into(),
                    has_lyrics: cand.song.has_lyrics,
                    letra_origem: cand.song.letra_origem.clone(),
                    // calculado num lugar só, na saída do `processar_musica`
                    substitui_nome_escrito: false,
                    conflito: None,
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
                    estado.chave_recusada.set(true);
                }
                erro = Some(msg);
            }
        }
    }

    Some(proposta_da_identidade(cand, identidade, erro))
}

/// True quando o que o SOM identificou CONTRADIZ uma etiqueta real do
/// arquivo — e então nada do que ele disse é aproveitado, nem para o campo
/// que estava vazio: quem erra o título pode ter errado a gravação inteira.
///
/// Porte da noção de CONFLITO do subcomando `identificar` do
/// `tools/curadoria.py`, inclusive no que ele decide NÃO aplicar.
fn conflito_com_a_etiqueta(cand: &Candidata, id: &Identificacao) -> Option<Conflito> {
    let discorda = fingerprint::discorda(cand.titulo_escrito(), &id.titulo)
        || fingerprint::discorda(&cand.artista_tag, &id.artista);
    discorda.then(|| Conflito {
        titulo: id.titulo.clone(),
        artista: id.artista.clone(),
        confianca: id.confianca.to_string(),
    })
}

/// A identidade APROVEITÁVEL de uma identificação sem conflito: regra da
/// V3.1, só preenche campo vazio ou placeholder. Etiqueta REAL é preservada
/// em qualquer confiança — palpite vindo do áudio não encosta em trabalho de
/// curador (DECISIONS #53), e o `identificar` do Python faz o mesmo.
fn identidade_util(cand: &Candidata, id: &Identificacao) -> (String, String, &'static str) {
    let titulo = if cand.titulo_escrito().is_empty() {
        id.titulo.clone()
    } else {
        cand.titulo_escrito().to_string()
    };
    let artista = if cand.artista_tag.is_empty() {
        id.artista.clone()
    } else {
        cand.artista_tag.clone()
    };
    (titulo, artista, id.confianca)
}

/// Os palpites que as etapas de letra recebem.
///
/// Com identidade vinda do som: UM palpite, o verdadeiro. Sem ela: a cascata
/// local de até sete do `gerar_palpites`, que continua sendo o caminho de
/// quem o AcoustID não reconheceu — a maioria.
fn palpites_de_letra(
    cand: &Candidata,
    identidade: &Option<(String, String, &'static str)>,
) -> Vec<(String, String)> {
    match identidade {
        Some((titulo, artista, _)) => vec![(titulo.clone(), artista.clone())],
        None => gerar_palpites(&cand.nome, &cand.titulo_tag, &cand.artista_tag),
    }
}

/// A proposta de quem chegou ao fim sem letra: o que a etapa 2 descobriu, se
/// descobriu alguma coisa, ou o palpite local de sempre.
fn proposta_da_identidade(
    cand: &Candidata,
    identidade: Option<(String, String, &'static str)>,
    erro: Option<String>,
) -> EnrichProposal {
    let mut p = proposta_baixa(cand, erro);
    // erro tem precedência: a linha de erro É a informação, e anunciar uma
    // identificação ao lado de "não deu" confundiria as duas coisas
    if p.error.is_some() {
        return p;
    }
    if let Some((titulo, artista, confianca)) = identidade {
        // Só vira proposta se MUDA alguma coisa, pela mesma noção de campo
        // efetivo que o resto do módulo usa; senão o `e_no_op` a derruba de
        // qualquer jeito e a confiança alta só faria a linha aparecer
        // pré-marcada sem ter o que aplicar.
        let mudou = campo_efetivo(&titulo) != campo_efetivo(&p.current_title)
            || campo_efetivo(&artista) != campo_efetivo(p.current_artist.as_deref().unwrap_or(""));
        if mudou {
            p.proposed_title = titulo;
            p.proposed_artist = (!artista.is_empty()).then_some(artista);
            // Aqui ALTA é segura e continua valendo: esta proposta aplica
            // NOMES e só nomes, em campos que estavam vazios (etiqueta real
            // foi preservada acima), sem tocar em letra nenhuma. É
            // exatamente o caso que a DECISIONS #79 descreve como o que
            // devolve segurança à pré-marcação.
            p.confidence = confianca.to_string();
            p.fonte = FONTE_IMPRESSAO_DIGITAL.into();
        }
    }
    p
}

/// Varre as músicas available sob `folder_prefix` (vazio = todas), passa as
/// escolhidas pelo funil (etiquetas/nome → som → LRCLIB → Vagalume) e
/// devolve as propostas.
///
/// `modo` escolhe o TRABALHO: `Completar` olha só as incompletas e roda o
/// funil inteiro; `Conferencia` olha TODAS as disponíveis e roda só a etapa
/// do som (ver `Modo`).
///
/// `chave_vagalume` é a chave do Vagalume já resolvida pelo comando (a
/// pessoal do usuário tem precedência sobre a nossa, compilada). Vazia, a
/// etapa 4 é pulada em silêncio e todo o resto funciona igual.
///
/// `pausa` é a cortesia entre consultas, de TODAS as fontes (300 ms no
/// comando real, com piso próprio de 340 ms para o AcoustID; zero nos
/// testes). Erro de rede por música vira proposta com `error` — nunca aborta
/// o lote.
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
#[allow(clippy::too_many_arguments)]
pub fn enrich_scan<S, P, C>(
    conn: &Connection,
    folder_prefix: &str,
    modo: Modo,
    fontes: S,
    chave_vagalume: &str,
    pausa: Duration,
    on_progress: P,
    cancelled: C,
) -> Result<EnrichScanResult>
where
    S: Fontes,
    P: Fn(usize, usize, &str, &str),
    C: Fn() -> bool,
{
    // QA MÉDIO-6 e QA A2 — os vereditos e a conta do que não foi feito vivem
    // pela varredura inteira, ao lado da cortesia.
    let estado = EstadoDaVarredura::default();
    let fechar = |propostas: Vec<EnrichProposal>| EnrichScanResult {
        propostas,
        sem_perguntar_ao_som: estado.sem_perguntar_ao_som.get(),
    };

    if cancelled() {
        return Ok(fechar(Vec::new()));
    }

    // 1ª passada (sem rede): seleciona as candidatas para o total do progresso
    // ser conhecido antes da primeira consulta.
    let candidatas: Vec<Candidata> = db::list_songs(conn)?
        .into_iter()
        .filter(|s| under_prefix(&s.file_path, folder_prefix))
        .filter_map(|s| candidata(s, modo))
        .collect();

    let total = candidatas.len();
    on_progress(0, total, "", ETAPA_PREPARANDO); // total na tela antes da 1ª consulta

    let cortesia = Cortesia::nova(pausa);
    let mut propostas = Vec::new();
    for (feitas, cand) in candidatas.iter().enumerate() {
        // cancelamento entre músicas: volta com o que já tem (QA M4)
        if cancelled() {
            return Ok(fechar(propostas));
        }
        let Some(proposta) = processar_musica(
            cand,
            &fontes,
            modo,
            chave_vagalume,
            &estado,
            &cortesia,
            &cancelled,
            |etapa| on_progress(feitas, total, &cand.nome, etapa),
        ) else {
            return Ok(fechar(propostas)); // cancelada no meio desta música
        };
        registrar(&mut propostas, proposta);
        on_progress(feitas + 1, total, &cand.nome, ETAPA_CONCLUIDA);
    }
    Ok(fechar(propostas))
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
pub fn enrich_scan_song<S, P, C>(
    conn: &Connection,
    song_id: i64,
    titulo: Option<&str>,
    artista: Option<&str>,
    fontes: S,
    chave_vagalume: &str,
    pausa: Duration,
    on_progress: P,
    cancelled: C,
) -> Result<Option<EnrichProposal>>
where
    S: Fontes,
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
    let estado = EstadoDaVarredura::default();
    let Some(proposta) = processar_musica(
        &cand,
        &fontes,
        // a música avulsa é sempre o funil INTEIRO: quem clicou quer tudo
        // que o produto sabe fazer por aquele arquivo, e o portão de
        // completude já não vale aqui (QA ALTO-3b)
        Modo::Completar,
        chave_vagalume,
        &estado,
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
            substitui_nome_escrito: false,
            conflito: None,
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
