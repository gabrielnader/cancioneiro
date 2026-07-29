use crate::db::{self, Folder, Playlist, PlaylistItem, Song};
use crate::error::{AppError, Result};
use crate::indexer;
use rusqlite::Connection;
use serde::Serialize;
use std::collections::HashMap;
use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::{AppHandle, Emitter, Manager, State};

// ---------------------------------------------------------------------------
// Por que alguns comandos são `#[tauri::command(async)]`
// ---------------------------------------------------------------------------
//
// Comando SEM `async` roda na THREAD PRINCIPAL — a mesma que desenha a
// janela. Enquanto ele não volta, o WebView não repinta e não recebe evento
// nenhum: o app inteiro congela e o sistema operacional troca o cursor pelo
// de "ocupado".
//
// Isso passou despercebido até o teste em campo da v0.8.0, e foi relatado
// como "não vi barra de progresso em lugar algum, só o cursor rodando". A
// barra existia, os eventos de progresso estavam sendo emitidos o tempo todo
// e o E2E os cobria — mas o E2E roda contra o mock no navegador, onde não há
// thread principal do Tauri para bloquear. **Nenhuma das quatro suítes podia
// pegar isto**: é um defeito que só existe dentro do binário.
//
// A marca vai em todo comando que pode demorar mais que um quadro de vídeo:
// as duas varreduras do funil (minutos, com rede), a indexação (que percorre
// o disco) e a gravação de etiquetas — `enrich_apply` reescreve dezenas de
// MP3s numa chamada só. Os demais são consultas de milissegundos ao SQLite, e
// pagar uma troca de thread neles só somaria latência.
//
// A regra para quem vier depois: se o comando faz rede, percorre disco ou
// escreve arquivo, ele é `(async)`.
//
// E a metade que faltava na regra (QA B5): **`(async)` não basta se o comando
// disputa o LOCK COMPARTILHADO com um que demora.** O `enrich_apply` segura o
// lock enquanto grava dezenas de MP3s; um comando síncrono que peça o mesmo
// lock nesse meio-tempo bloqueia a thread principal do mesmo jeito, só que
// pela porta do mutex. Quem pode ser chamado durante um lote longo usa
// `scan_conn()` — conexão dedicada quando o banco é um arquivo — e é
// `(async)`. Consulta de milissegundos que a UI só dispara em repouso
// continua no lock, que é o certo: uma conexão nova por tecla digitada seria
// pior.

/// Estado global: conexão SQLite protegida por mutex + caminho do arquivo do
/// banco (quando file-backed), para abrir conexões dedicadas de scan, + o
/// registro das varreduras de enriquecimento em andamento (QA M4).
pub struct Db {
    pub conn: Mutex<Connection>,
    pub path: Option<PathBuf>,
    /// Varreduras de enriquecimento VIVAS, por `scan_id` gerado no frontend:
    /// cada uma tem sua bandeira de cancelamento. A entrada nasce no início da
    /// varredura e morre no fim (inclusive quando ela falha ou é cancelada), de
    /// modo que o mapa não cresce sem limite e cancelar um id desconhecido —
    /// varredura já encerrada, id inventado — é um no-op inofensivo.
    scans: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl Db {
    pub fn new(conn: Connection, path: Option<PathBuf>) -> Self {
        Db {
            conn: Mutex::new(conn),
            path,
            scans: Mutex::new(HashMap::new()),
        }
    }

    fn lock(&self) -> Result<MutexGuard<'_, Connection>> {
        self.conn
            .lock()
            .map_err(|_| AppError("estado do banco corrompido (lock poisoned)".into()))
    }

    /// Registra uma varredura e devolve sua bandeira de cancelamento.
    /// Reiniciar um `scan_id` em uso substitui a bandeira antiga (a nova
    /// varredura nasce não-cancelada).
    ///
    /// Id VAZIO não é registrado: é o "não quero cancelamento" da varredura
    /// de uma música só (V8/F18). Registrá-lo daria a duas chamadas
    /// simultâneas a mesma chave, e faria um `enrich_cancel_scan("")`
    /// perdido derrubar uma varredura que ninguém pediu para parar.
    fn scan_begin(&self, scan_id: &str) -> Result<Arc<AtomicBool>> {
        let flag = Arc::new(AtomicBool::new(false));
        if scan_id.is_empty() {
            return Ok(flag);
        }
        self.scans
            .lock()
            .map_err(|_| AppError("estado das varreduras corrompido (lock poisoned)".into()))?
            .insert(scan_id.to_string(), Arc::clone(&flag));
        Ok(flag)
    }

    /// Desregistra a varredura (fim normal, erro ou cancelamento).
    fn scan_end(&self, scan_id: &str) {
        if let Ok(mut scans) = self.scans.lock() {
            scans.remove(scan_id);
        }
    }

    /// Marca a varredura `scan_id` como cancelada. Id desconhecido é no-op
    /// (nada é registrado — o mapa só guarda varreduras vivas).
    pub fn cancel_scan(&self, scan_id: &str) -> Result<()> {
        let scans = self
            .scans
            .lock()
            .map_err(|_| AppError("estado das varreduras corrompido (lock poisoned)".into()))?;
        if let Some(flag) = scans.get(scan_id) {
            flag.store(true, Ordering::SeqCst);
        }
        Ok(())
    }

    /// Quantas varreduras estão vivas (usado pelos testes de limpeza).
    #[cfg(test)]
    fn scans_vivas(&self) -> usize {
        self.scans.lock().unwrap().len()
    }

    /// Conexão para varreduras longas: dedicada (WAL) quando o banco é um
    /// arquivo, para não bloquear busca/listagem durante o scan; cai no lock
    /// compartilhado quando in-memory (testes).
    fn scan_conn(&self) -> Result<ScanConn<'_>> {
        match &self.path {
            Some(p) => Ok(ScanConn::Owned(db::open_at(p)?)),
            None => Ok(ScanConn::Shared(self.lock()?)),
        }
    }
}

enum ScanConn<'a> {
    Owned(Connection),
    Shared(MutexGuard<'a, Connection>),
}

impl Deref for ScanConn<'_> {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        match self {
            ScanConn::Owned(c) => c,
            ScanConn::Shared(g) => g,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ScanProgress {
    pub done: usize,
    pub total: usize,
}

/// Progresso da varredura de enriquecimento (evento `enrich:progress`):
/// `atual` é o NOME BASE do arquivo em processamento (vazio no evento inicial
/// com `done = 0`, emitido só para a UI já mostrar o total).
///
/// `etapa` (V8/F18) nomeia a etapa do funil em curso, já em pt-BR e pronta
/// para exibir: `"preparando"`, `"lendo etiquetas e nome do arquivo"`,
/// `"procurando no LRCLIB"`, `"procurando no Vagalume"` ou `"concluída"` (as
/// constantes `enrich::ETAPA_*`). O PRD V8 pede status sempre visível "com
/// contagem e barra, a etapa atual do funil e o arquivo do momento", e uma
/// música sozinha leva segundos entre os palpites no LRCLIB e a consulta ao
/// Vagalume. Só o evento `"concluída"` faz `done` crescer; os demais mudam o
/// texto sem mexer na barra.
///
/// `scan_id` (QA M4) identifica a varredura que emitiu o evento: sem ele, uma
/// varredura antiga que ainda não morreu embaralhava a barra de progresso da
/// varredura nova. A UI ignora eventos de um id que não é o dela.
#[derive(Debug, Clone, Serialize)]
pub struct EnrichProgress {
    pub done: usize,
    pub total: usize,
    pub atual: String,
    pub etapa: String,
    pub scan_id: String,
}

#[derive(Debug, Serialize)]
pub struct ScanResult {
    pub indexed: usize,
    pub skipped: usize,
    pub removed: usize,
    pub total: usize,
    pub missing_folders: Vec<String>,
}

#[tauri::command(async)]
pub fn add_folder(app: AppHandle, state: State<'_, Db>, path: String) -> Result<ScanResult> {
    let conn = state.scan_conn()?;
    let folder_id = db::add_folder(&conn, &path)?;
    let stats = indexer::scan_folder(&conn, folder_id, |done, total| {
        let _ = app.emit("scan:progress", ScanProgress { done, total });
    })?;
    Ok(ScanResult {
        indexed: stats.indexed,
        skipped: stats.skipped,
        removed: stats.removed,
        total: stats.total,
        missing_folders: vec![],
    })
}

#[tauri::command]
pub fn remove_folder(state: State<'_, Db>, folder_id: i64) -> Result<()> {
    let conn = state.lock()?;
    db::remove_folder(&conn, folder_id)
}

#[tauri::command]
pub fn list_folders(state: State<'_, Db>) -> Result<Vec<Folder>> {
    let conn = state.lock()?;
    db::list_folders(&conn)
}

/// Rescan incremental de todas as pastas (rodado na abertura e no botão
/// "Reindexar tudo").
#[tauri::command(async)]
pub fn scan(app: AppHandle, state: State<'_, Db>) -> Result<ScanResult> {
    let conn = state.scan_conn()?;
    let outcome = indexer::scan_all(&conn, |done, total| {
        let _ = app.emit("scan:progress", ScanProgress { done, total });
    })?;
    Ok(ScanResult {
        indexed: outcome.stats.indexed,
        skipped: outcome.stats.skipped,
        removed: outcome.stats.removed,
        total: outcome.stats.total,
        missing_folders: outcome.missing_folders,
    })
}

#[tauri::command]
pub fn list_songs(state: State<'_, Db>) -> Result<Vec<Song>> {
    let conn = state.lock()?;
    db::list_songs(&conn)
}

#[tauri::command]
pub fn search(state: State<'_, Db>, query: String) -> Result<Vec<crate::search::SearchResult>> {
    let conn = state.lock()?;
    crate::search::search(&conn, &query, 200)
}

#[tauri::command]
pub fn get_lyrics(state: State<'_, Db>, song_id: i64) -> Result<Option<String>> {
    let conn = state.lock()?;
    db::get_lyrics(&conn, song_id)
}

/// Usado pelo player antes de tocar: o arquivo ainda existe no disco?
#[tauri::command]
pub fn file_exists(path: String) -> bool {
    Path::new(&path).is_file()
}

// ---------------------------------------------------------------------------
// Playlists (F5)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn create_playlist(state: State<'_, Db>, name: String) -> Result<i64> {
    let conn = state.lock()?;
    db::create_playlist(&conn, &name)
}

#[tauri::command]
pub fn delete_playlist(state: State<'_, Db>, playlist_id: i64) -> Result<()> {
    let conn = state.lock()?;
    db::delete_playlist(&conn, playlist_id)
}

#[tauri::command]
pub fn list_playlists(state: State<'_, Db>) -> Result<Vec<Playlist>> {
    let conn = state.lock()?;
    db::list_playlists(&conn)
}

#[tauri::command]
pub fn get_playlist_items(state: State<'_, Db>, playlist_id: i64) -> Result<Vec<PlaylistItem>> {
    let conn = state.lock()?;
    db::get_playlist_items(&conn, playlist_id)
}

#[tauri::command]
pub fn add_to_playlist(state: State<'_, Db>, playlist_id: i64, song_id: i64) -> Result<i64> {
    let conn = state.lock()?;
    db::add_song_to_playlist(&conn, playlist_id, song_id)
}

#[tauri::command]
pub fn remove_playlist_item(state: State<'_, Db>, item_id: i64) -> Result<()> {
    let conn = state.lock()?;
    db::remove_playlist_item(&conn, item_id)
}

#[tauri::command]
pub fn reorder_playlist(
    state: State<'_, Db>,
    playlist_id: i64,
    item_ids: Vec<i64>,
) -> Result<()> {
    let conn = state.lock()?;
    db::reorder_playlist(&conn, playlist_id, &item_ids)
}

// ---------------------------------------------------------------------------
// Curadoria no player (F10 — PRD V4)
// ---------------------------------------------------------------------------

/// Grava TIT2/TPE1/USLT/TXXX:TEMAS/TXXX:INSTRUMENTAL no MP3 (nunca renomeia,
/// nunca toca o áudio), reindexa o arquivo e devolve a Song atualizada.
///
/// `instrumental` (V8/F17) tem três estados: `true` marca, `false` desmarca e
/// `null` (ausente no JSON) significa "não mexer" — ver writer::write_tags.
///
/// `letra_origem` (V8/F18) é a procedência da letra que está sendo gravada,
/// e o editor a informa quando sabe: `"vagalume"` quando o texto no
/// formulário veio de uma proposta da base comunitária. Ausente = o
/// comportamento de sempre (a marca cai quando a letra muda, porque letra
/// oficial não é transcrição). Existe porque a letra aceita de uma proposta e
/// salva pelo editor perdia, na volta, a marca que o funil tinha acabado de
/// gravar. Ver `writer::write_tags_com_origem`.
#[allow(clippy::too_many_arguments)]
#[tauri::command(async)]
pub fn write_tags(
    state: State<'_, Db>,
    song_id: i64,
    title: String,
    artist: Option<String>,
    lyrics: Option<String>,
    temas: Option<String>,
    instrumental: Option<bool>,
    letra_origem: Option<String>,
) -> Result<Song> {
    let conn = state.lock()?;
    crate::writer::write_tags_com_origem(
        &conn,
        song_id,
        &title,
        artist.as_deref(),
        lyrics.as_deref(),
        temas.as_deref(),
        instrumental,
        letra_origem.as_deref(),
    )
}

/// Para onde uma requisição do funil pode ir. A lista é FECHADA, e é o que
/// torna o inviolável "nada do acervo sai da máquina" uma garantia
/// executável em vez de uma promessa: um endereço montado errado (ou vindo
/// de dado do próprio acervo) não consegue virar requisição para outro
/// servidor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Destino {
    Lrclib,
    Vagalume,
    /// AcoustID (V9) — recebe um resumo acústico, nunca o áudio.
    Acoustid,
}

fn destino_de(url: &str) -> Option<Destino> {
    if url.starts_with(crate::vagalume::SEARCH_URL) {
        Some(Destino::Vagalume)
    } else if url.starts_with(crate::lyrics_fetch::SEARCH_URL) {
        Some(Destino::Lrclib)
    } else if url.starts_with(crate::fingerprint::LOOKUP_URL) {
        Some(Destino::Acoustid)
    } else {
        None
    }
}

/// Fetcher real (ureq) do funil, compartilhado por `enrich_folder_scan` e
/// `enrich_song_scan`. GET com timeout de 10 s e User-Agent
/// "Cancioneiro/0.9".
///
/// A primeira coisa que ele faz é conferir o DESTINO: só LRCLIB, Vagalume e
/// AcoustID passam (ver `Destino`).
///
/// 404 no Vagalume é resposta legítima ("não conheço esta música") e vira
/// corpo vazio, que o módulo lê como "sem resultado". Chamar isso de falha de
/// rede transformaria repertório desconhecido em erro na tela do usuário.
///
/// As demais falhas viram mensagens DISTINTAS (ver `mensagem_de_status`).
pub(crate) fn funil_fetcher(url: &str) -> Result<String> {
    let Some(destino) = destino_de(url) else {
        return Err(AppError("endereço de rede não permitido".into()));
    };
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(10))
        .user_agent("Cancioneiro/0.9")
        .build();
    match agent.get(url).call() {
        Ok(resp) => resp
            .into_string()
            .map_err(|_| AppError("sem conexão".into())),
        Err(ureq::Error::Status(404, _)) if destino == Destino::Vagalume => Ok(String::new()),
        Err(ureq::Error::Status(status, _)) => {
            Err(AppError(mensagem_de_status(status, destino).into()))
        }
        // transporte: DNS que não resolve, tempo esgotado, conexão recusada.
        // Aqui "sem conexão" é a verdade, e continua sendo o texto.
        Err(_) => Err(AppError("sem conexão".into())),
    }
}

/// O que dizer a quem está olhando a tela quando o servidor RESPONDEU, mas
/// não com o que se pediu.
///
/// Dizer "sem conexão" para tudo (o que este fetcher fazia) manda a pessoa
/// investigar a própria internet, que está ótima, e repete a acusação errada
/// em cada uma das linhas da varredura. As frases são curtas, sem jargão e
/// sem número de código solto — quem cura são ~40 pessoas que não abrem
/// terminal e não têm a quem perguntar; esta frase é a explicação inteira.
///
/// Cada destino fala de si: chamar o AcoustID de "site de letras" seria
/// mandar a pessoa procurar defeito no lugar errado — ele não devolve letra
/// nenhuma.
///
/// São TEXTO FIXO, sem interpolação: é o que garante que nenhuma chave (a do
/// usuário, no Vagalume, ou a nossa, no AcoustID) possa aparecer numa
/// mensagem de erro.
fn mensagem_de_status(status: u16, destino: Destino) -> &'static str {
    match (status, destino) {
        // a chave do Vagalume é do USUÁRIO: dá para conferir se copiou certo
        (401 | 403, Destino::Vagalume) => crate::vagalume::ERRO_CHAVE_RECUSADA,
        // a do AcoustID é NOSSA e vem compilada: não há nada que a pessoa
        // possa fazer, e mandá-la conferir uma chave que ela nunca digitou
        // seria mandá-la procurar defeito onde não há
        (401 | 403, Destino::Acoustid) => crate::fingerprint::ERRO_CHAVE_RECUSADA,
        // o LRCLIB não tem chave nenhuma: 401/403 lá é outra coisa
        (429, Destino::Acoustid) => "o reconhecimento pelo som pediu para esperar um pouco",
        (500..=599, Destino::Acoustid) => "o reconhecimento pelo som está fora do ar agora",
        (_, Destino::Acoustid) => crate::fingerprint::ERRO_RESPOSTA,
        (429, _) => "o site de letras pediu para esperar um pouco",
        (500..=599, _) => "o site de letras está fora do ar agora",
        (_, _) => "o site de letras respondeu com erro",
    }
}

// ---------------------------------------------------------------------------
// Acessórios (F18 fase 2 — PRD V9)
// ---------------------------------------------------------------------------

/// O endereço é do lançamento de acessórios?
///
/// Função à parte, e não um `if` dentro do fetcher, para a suíte poder
/// exercitar a trava sem abrir conexão nenhuma: um teste que "confirma" o
/// endereço legítimo chamando o fetcher baixaria 13 MB de binário a cada
/// rodada de CI.
fn destino_de_acessorio_permitido(url: &str) -> bool {
    url.starts_with(crate::acessorios::URL_BASE)
}

/// Fetcher real dos acessórios. Ponto de rede SEPARADO do funil, e com a
/// mesma disciplina: só o lançamento de acessórios passa.
///
/// A trava vale para o endereço que NÓS montamos. O GitHub responde a esse
/// endereço com um redirecionamento para o próprio armazenamento dele, e o
/// `ureq` o segue — é assim que um download do GitHub funciona. Isso não
/// abre porta nenhuma: quem escolhe o destino inicial é o catálogo compilado,
/// nada do acervo é enviado, e o que chega é conferido byte a byte pelo
/// SHA-256 antes de virar arquivo executável. **A soma é a autoridade, não a
/// origem** — é ela que torna o redirecionamento inofensivo.
///
/// Sem timeout total: são 5 MB numa conexão que pode ser ruim, e derrubar o
/// download aos 10 s seria transformar internet lenta em defeito. O que
/// existe é timeout de CONEXÃO, e o cancelamento da pessoa, que é verificado
/// a cada pedaço.
fn acessorio_fetcher(url: &str) -> Result<crate::acessorios::Corpo> {
    if !destino_de_acessorio_permitido(url) {
        return Err(AppError("endereço de rede não permitido".into()));
    }
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(15))
        .user_agent("Cancioneiro/0.9")
        .build();
    let resp = agent.get(url).call().map_err(|e| match e {
        ureq::Error::Status(404, _) => AppError(
            "o arquivo não está mais disponível para download nesta versão do aplicativo".into(),
        ),
        ureq::Error::Status(status, _) if (500..=599).contains(&status) => {
            AppError("o servidor de downloads está fora do ar agora".into())
        }
        ureq::Error::Status(_, _) => AppError("o servidor de downloads respondeu com erro".into()),
        _ => AppError("sem conexão".into()),
    })?;
    let total = resp
        .header("Content-Length")
        .and_then(|v| v.parse::<u64>().ok());
    Ok(crate::acessorios::Corpo {
        total,
        bytes: Box::new(resp.into_reader()),
    })
}

// ---------------------------------------------------------------------------
// Enriquecimento em lote (F13 — PRD V5)
// ---------------------------------------------------------------------------

/// Cortesia com as APIs entre consultas — das DUAS fontes.
const PAUSA_CORTESIA: std::time::Duration = std::time::Duration::from_millis(300);

/// Emissor de `enrich:progress` para uma varredura (por `scan_id`).
fn emissor_de_progresso(
    app: AppHandle,
    scan_id: String,
) -> impl Fn(usize, usize, &str, &str) {
    move |done, total, atual, etapa| {
        let _ = app.emit(
            "enrich:progress",
            EnrichProgress {
                done,
                total,
                atual: atual.to_string(),
                etapa: etapa.to_string(),
                scan_id: scan_id.clone(),
            },
        );
    }
}

/// A chave do Vagalume que o funil vai usar. Duas podem existir, e a ordem
/// entre elas é o ponto (PRD V9):
///
/// 1. **a do usuário**, se ele digitou uma. Ela vem do frontend a cada
///    chamada (é preferência dele, não dado do acervo) e fica guardada nas
///    preferências locais, na máquina da própria pessoa;
/// 2. **a nossa**, embutida em tempo de build a partir de um segredo do
///    repositório. Ela existe para ninguém precisar de chave nenhuma: pedir
///    uma chave de API a quem não sabe o que é terminal era um pedágio
///    absurdo, e o campo por pessoa existia só porque a alternativa não
///    tinha sido pensada.
///
/// A do usuário vem PRIMEIRO de propósito: é a saída se a nossa for
/// bloqueada algum dia. Build sem o segredo (desenvolvimento, fork)
/// simplesmente não tem chave embutida, e aí vale a regra de sempre — sem
/// nenhuma das duas, a etapa é pulada em silêncio e nada falha.
///
/// Assumido conscientemente: chave dentro de programa distribuído não é
/// segredo — qualquer pessoa a extrai do binário. Aceito porque o estrago é
/// recuperável (chave nova numa atualização, em uma hora) e o ganho é ~40
/// pessoas que nunca veem uma tela de configuração.
///
/// Nenhuma das duas entra no banco de músicas, em log ou em mensagem de
/// erro, nem vai a lugar nenhum além do próprio Vagalume.
fn chave(vagalume_key: Option<String>) -> String {
    let do_usuario = vagalume_key.unwrap_or_default().trim().to_string();
    if !do_usuario.is_empty() {
        return do_usuario;
    }
    option_env!("VAGALUME_API_KEY").unwrap_or("").trim().to_string()
}

/// Passa as músicas incompletas sob `folder_prefix` (vazio = biblioteca
/// inteira) pelo funil — etiquetas/nome do arquivo → LRCLIB → Vagalume — e
/// devolve as propostas para a UI de revisão.
///
/// Ponto de rede EXPLÍCITO acionado pelo usuário (a seção de curadoria em
/// Configurações); pausa de cortesia de 300 ms entre consultas, valendo para
/// as duas fontes. `chave_vagalume` é a chave gratuita do usuário, guardada
/// pelo frontend: ausente ou vazia, a etapa do Vagalume é pulada em silêncio
/// e todo o resto funciona igual. Erro de rede por música vira proposta com
/// `error` — o lote nunca aborta. Usa conexão dedicada (scan_conn) para não
/// travar busca/listagem durante a varredura, que dura minutos.
///
/// Emite `enrich:progress` (EnrichProgress) a cada etapa e a cada música
/// concluída — no acervo real são minutos de varredura, e o invoke sozinho
/// não dá sinal de vida. Todo evento carrega o `scan_id` (gerado pelo
/// frontend) para a UI descartar o que vier de uma varredura antiga.
///
/// Cancelável por `enrich_cancel_scan(scan_id)`: a varredura verifica a
/// bandeira entre músicas e antes de cada consulta, e volta cedo com as
/// propostas que já tiver.
///
/// **A resposta é um OBJETO, não a lista de propostas** (mudou na correção do
/// QA A2): `{ propostas, sem_perguntar_ao_som }`. O segundo campo conta as
/// músicas que teriam sido perguntadas ao som e não foram, porque a etapa 2
/// se desligou no meio — sem ele, a tela mostrava uma linha de erro e o
/// silêncio das outras, e o silêncio era lido como aprovação (DECISIONS #86).
/// Zero é o caso normal e não merece texto na tela.
#[tauri::command(async)]
pub fn enrich_folder_scan(
    app: AppHandle,
    state: State<'_, Db>,
    folder_prefix: String,
    scan_id: String,
    vagalume_key: Option<String>,
    modo: Option<crate::enrich::Modo>,
) -> Result<crate::enrich::EnrichScanResult> {
    let modo = modo.unwrap_or_default();
    let cancel = state.scan_begin(&scan_id)?;
    let fontes = fontes_do_funil(&app);
    let progresso = emissor_de_progresso(app, scan_id.clone());
    let resultado = (|| {
        let conn = state.scan_conn()?;
        crate::enrich::enrich_scan(
            &conn,
            &folder_prefix,
            modo,
            fontes,
            &chave(vagalume_key),
            PAUSA_CORTESIA,
            progresso,
            || cancel.load(Ordering::SeqCst),
        )
    })();
    state.scan_end(&scan_id); // a entrada morre sempre — o mapa não cresce
    resultado
}

/// Quantas músicas a varredura de `folder_prefix` (vazio = biblioteca
/// inteira) vai olhar, para a tela poder dizer o tamanho do trabalho ANTES de
/// a pessoa mandar começar. Sem rede, sem gravação: é a mesma
/// `enrich::candidata` da varredura, contada (QA ALTO-2 — havia uma segunda
/// cópia da regra em TypeScript, já divergente).
///
/// É `(async)` e usa CONEXÃO DEDICADA (QA B5). Era síncrono e pegava o lock
/// compartilhado — o mesmo que o `enrich_apply` segura enquanto grava dezenas
/// de MP3s —, então uma contagem disparada durante a gravação parava a thread
/// que desenha a janela até o lote terminar. É a DECISIONS #92 entrando pela
/// porta do mutex em vez da porta do comando síncrono, e a V9 dispara esta
/// contagem mais vezes (a cada troca de pasta e de modo). Ela lê a biblioteca
/// inteira: percorrer o banco já basta para o `(async)`.
#[tauri::command(async)]
pub fn enrich_count(
    state: State<'_, Db>,
    folder_prefix: String,
    modo: Option<crate::enrich::Modo>,
) -> Result<usize> {
    let conn = state.scan_conn()?;
    crate::enrich::count_candidatas(&conn, &folder_prefix, modo.unwrap_or_default())
}

/// O MESMO funil, numa música só: o "completar dados desta música" do editor
/// (PRD V8/F18). Devolve `null` quando procuramos e não veio nada novo. Nada
/// é gravado aqui; a proposta devolvida entra no mesmo `enrich_apply` do
/// lote.
///
/// Ao contrário do lote, esta porta NÃO pula a música completa (QA ALTO-3b):
/// quem apertou o botão está olhando aquele arquivo e quer uma segunda
/// opinião. `title`/`artist` são o que está no formulário do editor naquele
/// momento e, quando vêm, mandam na consulta — o backend procurava pela
/// etiqueta velha do banco enquanto a pessoa já tinha digitado o nome certo
/// (QA ALTO-3a). Os dois são opcionais: sem eles vale o que está no banco.
///
/// `scan_id` é OPCIONAL porque o caso pontual do editor são segundos, não
/// minutos: quem não manda um id não ganha cancelamento e recebe os eventos
/// de progresso com `scan_id` vazio (que a UI já descarta, por serem de uma
/// varredura que não é a dela). Quem manda um id ganha os dois, pelo mesmo
/// `enrich_cancel_scan(scan_id)` do lote.
#[tauri::command(async)]
pub fn enrich_song_scan(
    app: AppHandle,
    state: State<'_, Db>,
    song_id: i64,
    vagalume_key: Option<String>,
    scan_id: Option<String>,
    title: Option<String>,
    artist: Option<String>,
) -> Result<Option<crate::enrich::EnrichProposal>> {
    let scan_id = scan_id.unwrap_or_default();
    let cancel = state.scan_begin(&scan_id)?;
    let fontes = fontes_do_funil(&app);
    let progresso = emissor_de_progresso(app, scan_id.clone());
    let resultado = (|| {
        let conn = state.scan_conn()?;
        crate::enrich::enrich_scan_song(
            &conn,
            song_id,
            title.as_deref(),
            artist.as_deref(),
            fontes,
            &chave(vagalume_key),
            PAUSA_CORTESIA,
            progresso,
            || cancel.load(Ordering::SeqCst),
        )
    })();
    state.scan_end(&scan_id);
    resultado
}

/// Cancela a varredura `scan_id` de verdade (QA M4): a bandeira é lida entre
/// músicas e a varredura volta cedo, parando de consultar o LRCLIB e de emitir
/// progresso. Id desconhecido (varredura já encerrada) é no-op silencioso.
#[tauri::command]
pub fn enrich_cancel_scan(state: State<'_, Db>, scan_id: String) -> Result<()> {
    state.cancel_scan(&scan_id)
}

/// Aplica as propostas aceitas (write_tags por música; nunca renomeia, nunca
/// apaga dados existentes — só preenche/atualiza o que veio). Devolve um
/// resultado por música (`song` = gravada e reindexada; `error` = falhou):
/// falha numa música NÃO aborta o lote, então a UI fica em sincronia com o
/// que realmente foi para o disco.
#[tauri::command(async)]
pub fn enrich_apply(
    state: State<'_, Db>,
    aplicacoes: Vec<crate::enrich::EnrichApply>,
) -> Result<Vec<crate::enrich::EnrichApplyResult>> {
    let conn = state.lock()?;
    crate::enrich::apply(&conn, &aplicacoes)
}

// ---------------------------------------------------------------------------
// As fontes do funil (rede + acessório) montadas para uma varredura
// ---------------------------------------------------------------------------

/// Implementação real de `enrich::Fontes`: a rede pelo `funil_fetcher` e a
/// impressão digital pelo `fpcalc` do cache, quando ele está lá.
struct FontesDoFunil {
    /// `None` = o acessório não está pronto → etapa do som pulada em
    /// SILÊNCIO. É o estado normal de quem ainda não baixou, não um erro.
    fpcalc: Option<PathBuf>,
    chave_acoustid: &'static str,
}

impl crate::enrich::Fontes for FontesDoFunil {
    fn buscar(&self, url: &str) -> Result<String> {
        funil_fetcher(url)
    }
    fn reconhece_pelo_som(&self) -> bool {
        self.fpcalc.is_some()
    }
    fn impressao_digital(
        &self,
        mp3: &Path,
        cancelado: &dyn Fn() -> bool,
    ) -> Option<Result<crate::fingerprint::Impressao>> {
        self.fpcalc
            .as_ref()
            .map(|fpcalc| crate::fingerprint::impressao_digital(fpcalc, mp3, cancelado))
    }
    fn chave_acoustid(&self) -> &str {
        self.chave_acoustid
    }
}

/// Monta as fontes para UMA varredura. A soma do acessório é conferida aqui,
/// uma vez por varredura e não uma vez por música: são milissegundos, e
/// protege contra o arquivo ter sido trocado no disco depois de instalado —
/// o que é conferido antes de executar precisa continuar sendo o que se
/// executa.
fn fontes_do_funil(app: &AppHandle) -> FontesDoFunil {
    FontesDoFunil {
        fpcalc: fpcalc_pronto(app),
        chave_acoustid: crate::fingerprint::chave_acoustid(),
    }
}

/// Caminho do `fpcalc` quando ele está no cache E a soma confere. Qualquer
/// outra situação (sem pasta de perfil, acessório ausente, arquivo trocado)
/// devolve `None`, e a etapa some sem dizer nada.
fn fpcalc_pronto(app: &AppHandle) -> Option<PathBuf> {
    let cache = diretorio_de_cache(app).ok()?;
    let acessorio = crate::acessorios::desta_maquina(crate::acessorios::FPCALC)?;
    (crate::acessorios::estado(acessorio, &cache) == crate::acessorios::Estado::Pronto)
        .then(|| acessorio.caminho(&cache))
}

/// Pasta de cache dos acessórios, sob o perfil do usuário — a mesma pasta de
/// dados onde vive o banco.
fn diretorio_de_cache(app: &AppHandle) -> Result<PathBuf> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|_| AppError("não foi possível achar a pasta do aplicativo".into()))?;
    Ok(crate::acessorios::diretorio_de_cache(&base))
}

// ---------------------------------------------------------------------------
// Comandos dos acessórios (F18 fase 2 — PRD V9)
// ---------------------------------------------------------------------------

/// Um acessório como a tela precisa vê-lo. Tudo que a regra 1 do PRD V9 pede
/// para dizer ANTES de baixar ("o que vai baixar, quanto ocupa") mais o
/// estado atual.
#[derive(Debug, Clone, Serialize)]
pub struct AcessorioInfo {
    /// Identidade estável, e o que `acessorio_baixar` recebe: "fpcalc".
    pub nome: String,
    /// Para que serve, em pt-BR e pronto para exibir.
    pub para_que_serve: String,
    /// Nome do arquivo, igual no lançamento e no cache.
    pub arquivo: String,
    /// Quanto ocupa, em bytes.
    pub tamanho_bytes: u64,
    /// Quanto tempo o download deve levar, em segundos, numa conexão de
    /// referência (V10). A dispensa do tempo valia para 5 MB; para os 180 MB
    /// do modelo, não vale — sem isto a tela oferece um download sem dizer se
    /// ele leva três minutos ou três horas.
    ///
    /// É estimativa DECLARADA, não medida (`acessorios::BANDA_REFERENCIA_BYTES_S`,
    /// 1 MB/s): a copy tem de dizer "cerca de". Durante o download o número
    /// honesto passa a ser o `segundos_restantes` do progresso, que vem da
    /// velocidade real desta conexão.
    pub segundos_estimados: u64,
    /// "ausente" | "pronto" | "corrompido" | "indisponivel".
    pub estado: String,
    /// É um PROGRAMA que o aplicativo executa (`true`) ou um DADO que ele só
    /// lê (`false`)? O modelo de transcrição é dado — 180 MB que ninguém
    /// executa —, e a tela precisa poder dizer isso: "um programa de 2 MB e um
    /// arquivo de 180 MB" é uma conversa diferente de "dois programas".
    pub executavel: bool,
    /// De onde ele vem — a "origem só para explicar na tela" do PRD V9.
    pub origem: String,
}

/// Progresso do download (evento `acessorio:progresso`).
///
/// `total` é `null` quando o servidor não anuncia o tamanho: "não sabemos" é
/// um estado, e um zero no lugar seria lido pela barra como 0% de um arquivo
/// vazio (DECISIONS #86).
#[derive(Debug, Clone, Serialize)]
pub struct AcessorioProgresso {
    pub nome: String,
    pub baixados: u64,
    pub total: Option<u64>,
    /// Quanto ainda falta, em segundos, pela velocidade MEDIDA desta conexão
    /// (V10). `null` enquanto a amostra é curta demais para render número
    /// honesto, e quando o servidor não anuncia o tamanho — "não sabemos" é um
    /// estado (DECISIONS #86), e num download de 180 MB um "faltam 0 segundos"
    /// que dura dez minutos é pior que nenhum número.
    pub segundos_restantes: Option<u64>,
    pub download_id: String,
}

/// Desfecho de `acessorio_baixar`. `cancelado` é um CAMPO, e não algo a
/// deduzir do estado: cancelar e falhar em silêncio terminam os dois com o
/// acessório ausente, e a tela precisa saber qual dos dois aconteceu sem
/// adivinhar.
#[derive(Debug, Clone, Serialize)]
pub struct AcessorioDownload {
    pub cancelado: bool,
    pub acessorio: AcessorioInfo,
}

/// Para que serve cada acessório, em pt-BR — aparece cru na tela.
fn para_que_serve(nome: &str) -> &'static str {
    match nome {
        crate::acessorios::FPCALC => "reconhecer a música pelo som",
        crate::acessorios::WHISPER_CLI => "escrever a letra ouvindo o áudio",
        // Duas entradas para uma etapa só, e a frase precisa explicar por quê:
        // são 2 MB de programa e 180 MB de dado, e a pessoa vai ver os dois.
        crate::acessorios::MODELO_WHISPER => {
            "entender o que é cantado — é o que o transcritor consulta"
        }
        _ => "",
    }
}

fn info_de(
    acessorio: &crate::acessorios::Acessorio,
    cache: &Path,
    tem_chave: bool,
) -> AcessorioInfo {
    let mut estado = crate::acessorios::estado(acessorio, cache);
    // Sem a chave do AcoustID compilada nesta build, o `fpcalc` não teria o
    // que fazer. Oferecer um download de 5 MB que não pode servir para nada
    // seria pior que não oferecer nada — e "indisponível nesta versão" é
    // exatamente o que está acontecendo.
    //
    // A etapa 5 não depende de chave nenhuma: ela roda LOCAL, que é o que
    // torna aceitável transcrever acervos que o dono do produto não pode ver.
    if !tem_chave && acessorio.nome == crate::acessorios::FPCALC {
        estado = crate::acessorios::Estado::Indisponivel;
    }
    AcessorioInfo {
        nome: acessorio.nome.to_string(),
        para_que_serve: para_que_serve(acessorio.nome).to_string(),
        arquivo: acessorio.arquivo.to_string(),
        tamanho_bytes: acessorio.tamanho_bytes,
        segundos_estimados: crate::acessorios::segundos_estimados(acessorio.tamanho_bytes),
        estado: estado.como_texto().to_string(),
        executavel: acessorio.executavel,
        origem: acessorio.url(),
    }
}

/// Os acessórios que existem para ESTE computador, com o estado de cada um.
///
/// Lista vazia significa que não publicamos binário para esta plataforma — e
/// a tela deve dizer isso, em vez de oferecer um download que não serviria.
///
/// É `(async)` porque confere a soma dos arquivos do cache: lê alguns MB de
/// disco, e comando síncrono roda na thread que desenha a janela
/// (DECISIONS #92).
#[tauri::command(async)]
pub fn acessorios_estado(app: AppHandle) -> Result<Vec<AcessorioInfo>> {
    let cache = diretorio_de_cache(&app)?;
    let tem_chave = !crate::fingerprint::chave_acoustid().is_empty();
    Ok(crate::acessorios::catalogo_desta_maquina()
        .into_iter()
        .map(|a| info_de(a, &cache, tem_chave))
        .collect())
}

/// Baixa o acessório `nome`, confere a soma e o instala. Nada baixa sozinho:
/// este comando só existe porque alguém clicou depois de ler o que ia
/// baixar e quanto ocupava.
///
/// Emite `acessorio:progresso` a cada pedaço, com o `download_id` que o
/// frontend gerou — a mesma disciplina do `scan_id` do funil, e pelo mesmo
/// motivo: um download antigo não pode embaralhar a barra do novo.
///
/// Cancelável por `acessorio_cancelar(download_id)`, verificado DENTRO do
/// download e não só entre arquivos.
///
/// Devolve o desfecho: `cancelado` diz se a pessoa parou, e `acessorio` traz
/// o estado final. Falha de rede ou soma que não confere viram `Err` com uma
/// frase em pt-BR — e, nos dois casos, nada foi instalado.
#[tauri::command(async)]
pub fn acessorio_baixar(
    app: AppHandle,
    state: State<'_, Db>,
    nome: String,
    download_id: String,
) -> Result<AcessorioDownload> {
    let cache = diretorio_de_cache(&app)?;
    let tem_chave = !crate::fingerprint::chave_acoustid().is_empty();
    let acessorio = crate::acessorios::desta_maquina(&nome)
        .ok_or_else(|| AppError(crate::acessorios::ERRO_ACESSORIO_DESCONHECIDO.into()))?;
    if !tem_chave && acessorio.nome == crate::acessorios::FPCALC {
        return Err(AppError(crate::acessorios::ERRO_INDISPONIVEL.into()));
    }

    let cancel = state.scan_begin(&download_id)?;
    let nome_evento = acessorio.nome.to_string();
    let id_evento = download_id.clone();
    // O relógio começa aqui, e não no primeiro byte: o que a pessoa espera
    // inclui o tempo de abrir a conexão.
    let inicio = std::time::Instant::now();
    let resultado = crate::acessorios::baixar(
        acessorio,
        &cache,
        acessorio_fetcher,
        |baixados, total| {
            let _ = app.emit(
                "acessorio:progresso",
                AcessorioProgresso {
                    nome: nome_evento.clone(),
                    baixados,
                    total,
                    segundos_restantes: crate::acessorios::segundos_restantes(
                        baixados,
                        total,
                        inicio.elapsed(),
                    ),
                    download_id: id_evento.clone(),
                },
            );
        },
        || cancel.load(Ordering::SeqCst),
    );
    state.scan_end(&download_id);

    let cancelado = matches!(resultado, Ok(None));
    resultado?;
    Ok(AcessorioDownload {
        cancelado,
        acessorio: info_de(acessorio, &cache, tem_chave),
    })
}

/// Cancela o download `download_id`. Id desconhecido (download já encerrado)
/// é no-op silencioso, igual ao cancelamento de varredura — os dois usam o
/// mesmo registro de trabalhos longos vivos.
#[tauri::command]
pub fn acessorio_cancelar(state: State<'_, Db>, download_id: String) -> Result<()> {
    state.cancel_scan(&download_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn estado() -> Db {
        Db::new(db::open_in_memory().unwrap(), None)
    }

    // -----------------------------------------------------------------------
    // QA M4 — registro de cancelamento: a bandeira nasce baixada, cancelar a
    // levanta, e a entrada some no fim da varredura (o mapa não cresce).
    // -----------------------------------------------------------------------
    #[test]
    fn cancel_scan_raises_the_flag_of_the_running_scan() {
        let state = estado();
        let flag = state.scan_begin("scan-1").unwrap();
        assert!(!flag.load(Ordering::SeqCst), "varredura nasce não-cancelada");

        state.cancel_scan("scan-1").unwrap();
        assert!(flag.load(Ordering::SeqCst), "cancelar levanta a bandeira");

        state.scan_end("scan-1");
        assert_eq!(state.scans_vivas(), 0, "entrada limpa no fim da varredura");
    }

    /// V8/F18 — a varredura de UMA música pode vir sem `scan_id` (o editor
    /// não oferece "Cancelar" para o caso pontual). Id vazio não entra no
    /// mapa: duas chamadas simultâneas não disputariam a mesma chave, e um
    /// `enrich_cancel_scan("")` perdido não derruba varredura nenhuma.
    #[test]
    fn an_empty_scan_id_is_never_registered() {
        let state = estado();
        let flag = state.scan_begin("").unwrap();
        assert_eq!(state.scans_vivas(), 0, "id vazio não entra no mapa");

        state.cancel_scan("").unwrap();
        assert!(!flag.load(Ordering::SeqCst), "e não pode ser cancelado");
        state.scan_end("");
        assert_eq!(state.scans_vivas(), 0);
    }

    #[test]
    fn cancelling_unknown_scan_id_is_a_harmless_no_op() {
        let state = estado();
        // id que nunca existiu
        state.cancel_scan("nunca-existiu").unwrap();
        // id de varredura já encerrada
        state.scan_begin("scan-1").unwrap();
        state.scan_end("scan-1");
        state.cancel_scan("scan-1").unwrap();

        assert_eq!(
            state.scans_vivas(),
            0,
            "cancelar id desconhecido não registra nada (mapa não cresce)"
        );
    }

    #[test]
    fn cancelling_one_scan_does_not_touch_another() {
        let state = estado();
        let a = state.scan_begin("scan-a").unwrap();
        let b = state.scan_begin("scan-b").unwrap();

        state.cancel_scan("scan-a").unwrap();
        assert!(a.load(Ordering::SeqCst));
        assert!(!b.load(Ordering::SeqCst), "cada varredura tem sua bandeira");

        state.scan_end("scan-a");
        state.scan_end("scan-b");
        assert_eq!(state.scans_vivas(), 0);
    }

    // -----------------------------------------------------------------------
    // QA M4 — o evento enrich:progress carrega a identidade da varredura
    // (snake_case, sem renames: é o contrato com o frontend).
    // -----------------------------------------------------------------------
    #[test]
    fn enrich_progress_event_carries_the_scan_id_and_the_stage() {
        let json = serde_json::to_value(EnrichProgress {
            done: 2,
            total: 7,
            atual: "Falamansa - Oh! Chuva.mp3".into(),
            etapa: crate::enrich::ETAPA_VAGALUME.into(),
            scan_id: "scan-42".into(),
        })
        .unwrap();

        assert_eq!(json["done"], 2);
        assert_eq!(json["total"], 7);
        assert_eq!(json["atual"], "Falamansa - Oh! Chuva.mp3");
        assert_eq!(json["etapa"], "procurando no Vagalume");
        assert_eq!(json["scan_id"], "scan-42");
        // o evento tem exatamente estes cinco campos, em snake_case
        let campos: Vec<&String> = json.as_object().unwrap().keys().collect();
        assert_eq!(campos, ["atual", "done", "etapa", "scan_id", "total"]);
    }

    // -----------------------------------------------------------------------
    // V8/F18 — o vocabulário de `etapa` é FECHADO e estável: a UI traduz cada
    // valor para uma frase em pt-BR, e um valor novo apareceria cru na tela de
    // quem não tem a quem perguntar.
    // -----------------------------------------------------------------------
    #[test]
    fn the_stage_vocabulary_is_closed_and_stable() {
        use crate::enrich::*;
        // na ORDEM em que a pessoa as lê durante uma varredura (V9: a
        // impressão digital passou a vir ANTES das fontes de letra, porque
        // é o nome dela que as alimenta)
        assert_eq!(
            [
                ETAPA_PREPARANDO,
                ETAPA_NOME_ARQUIVO,
                ETAPA_IMPRESSAO_DIGITAL,
                ETAPA_LRCLIB,
                ETAPA_VAGALUME,
                ETAPA_CONCLUIDA
            ],
            [
                "preparando",
                "lendo etiquetas e nome do arquivo",
                "reconhecendo pelo som",
                "procurando no LRCLIB",
                "procurando no Vagalume",
                "concluída"
            ]
        );
        assert_eq!(
            [
                FONTE_NOME_ARQUIVO,
                FONTE_IMPRESSAO_DIGITAL,
                FONTE_LRCLIB,
                FONTE_VAGALUME,
                FONTE_ERRO
            ],
            [
                "nome do arquivo",
                "reconhecimento pelo som",
                "LRCLIB",
                "Vagalume",
                "erro"
            ]
        );
    }

    // -----------------------------------------------------------------------
    // V8/F18 — a proposta chega ao frontend com `fonte`, em snake_case e sem
    // renames, junto dos campos que a revisão já usava.
    // -----------------------------------------------------------------------
    #[test]
    fn enrich_proposal_serializes_the_source_of_the_data() {
        let json = serde_json::to_value(crate::enrich::EnrichProposal {
            song_id: 7,
            file_path: "/m/a.mp3".into(),
            current_title: "Faixa 5".into(),
            current_artist: None,
            proposed_title: "Chegança".into(),
            proposed_artist: Some("Antônio Nóbrega".into()),
            lyrics: Some("letra".into()),
            confidence: "alta".into(),
            fonte: crate::enrich::FONTE_VAGALUME.into(),
            has_lyrics: true,
            letra_origem: Some("transcricao".into()),
            substitui_nome_escrito: true,
            conflito: None,
            error: None,
        })
        .unwrap();

        assert_eq!(json["fonte"], "Vagalume");
        assert_eq!(json["confidence"], "alta");
        // QA CRÍTICO-1 — a revisão precisa saber que aceitar esta linha
        // SUBSTITUIRIA uma letra, e o que seria sobrescrito
        assert_eq!(json["has_lyrics"], true);
        assert_eq!(json["letra_origem"], "transcricao");
        let campos: Vec<&String> = json.as_object().unwrap().keys().collect();
        assert_eq!(
            campos,
            [
                "confidence",
                "conflito",
                "current_artist",
                "current_title",
                "error",
                "file_path",
                "fonte",
                "has_lyrics",
                "letra_origem",
                "lyrics",
                "proposed_artist",
                "proposed_title",
                "song_id",
                "substitui_nome_escrito",
            ]
        );
        // V9 — a revisão precisa saber que aceitar esta linha trocaria um
        // nome que uma PESSOA escreveu, para não pré-marcá-la
        assert_eq!(json["substitui_nome_escrito"], true);
    }

    /// V9 — o outro lado da divergência atravessa o IPC inteiro: sem os dois
    /// valores, a tela não tem como mostrar os dois lados, e mostrar um lado
    /// só de uma contradição é pior que não mostrar nada.
    #[test]
    fn a_proposta_de_conflito_leva_os_dois_lados_para_a_tela() {
        let json = serde_json::to_value(crate::enrich::EnrichProposal {
            song_id: 7,
            file_path: "/m/a.mp3".into(),
            current_title: "Te ver feliz, te ver contente".into(),
            current_artist: Some("Caetano Veloso".into()),
            proposed_title: "Te ver feliz, te ver contente".into(),
            proposed_artist: Some("Caetano Veloso".into()),
            lyrics: None,
            confidence: "baixa".into(),
            fonte: crate::enrich::FONTE_IMPRESSAO_DIGITAL.into(),
            has_lyrics: true,
            letra_origem: None,
            substitui_nome_escrito: false,
            conflito: Some(crate::enrich::Conflito {
                titulo: "Viver Feliz".into(),
                artista: "Nilson Chaves".into(),
                confianca: "alta".into(),
            }),
            error: None,
        })
        .unwrap();

        assert_eq!(json["conflito"]["titulo"], "Viver Feliz");
        assert_eq!(json["conflito"]["artista"], "Nilson Chaves");
        assert_eq!(json["conflito"]["confianca"], "alta");
        assert_eq!(json["fonte"], "reconhecimento pelo som");
        // a etiqueta atual NÃO é corrigida sozinha, e a linha nunca chega
        // pré-marcada (só "alta" é pré-marcada — DECISIONS #49)
        assert_eq!(json["proposed_title"], "Te ver feliz, te ver contente");
        assert_eq!(json["confidence"], "baixa");
        let campos: Vec<&String> = json["conflito"].as_object().unwrap().keys().collect();
        assert_eq!(campos, ["artista", "confianca", "titulo"]);
    }

    /// O modo da varredura chega do frontend como texto minúsculo e sem
    /// acento, e ausente vale a varredura BARATA — nunca a cara por engano.
    #[test]
    fn o_modo_da_varredura_atravessa_o_ipc_como_texto() {
        use crate::enrich::Modo;
        assert_eq!(
            serde_json::from_str::<Modo>("\"completar\"").unwrap(),
            Modo::Completar
        );
        assert_eq!(
            serde_json::from_str::<Modo>("\"conferencia\"").unwrap(),
            Modo::Conferencia
        );
        assert_eq!(
            serde_json::from_str::<Option<Modo>>("null")
                .unwrap()
                .unwrap_or_default(),
            Modo::Completar
        );
        assert!(serde_json::from_str::<Modo>("\"CONFERENCIA\"").is_err());
    }

    /// O eco de `fonte` é OPCIONAL: um payload sem ele continua válido e vale
    /// como "não sei de onde veio" (a marca de procedência é limpa, nunca
    /// inventada). O mesmo vale para o consentimento de substituir letra:
    /// ausente é NÃO — a omissão nunca pode autorizar uma sobrescrita.
    #[test]
    fn enrich_apply_accepts_the_source_echo_and_survives_without_it() {
        let com: crate::enrich::EnrichApply = serde_json::from_str(
            r#"{"song_id": 7, "title": "T", "artist": null, "lyrics": "L",
                "add_temas": null, "current_title": "T", "current_artist": null,
                "fonte": "Vagalume", "substituir_letra": true}"#,
        )
        .unwrap();
        assert_eq!(com.fonte.as_deref(), Some("Vagalume"));
        assert!(com.substituir_letra);

        let sem: crate::enrich::EnrichApply = serde_json::from_str(
            r#"{"song_id": 7, "title": "T", "artist": null, "lyrics": "L",
                "add_temas": null, "current_title": "T", "current_artist": null}"#,
        )
        .unwrap();
        assert_eq!(sem.fonte, None);
        assert!(!sem.substituir_letra, "ausente = não substituir");
    }

    // -----------------------------------------------------------------------
    // V8/F18 — "nenhuma telemetria, nada do acervo sai da máquina": o único
    // fetcher do produto recusa qualquer destino que não seja LRCLIB ou
    // Vagalume, ANTES de abrir conexão. Roda offline: nenhuma das URLs abaixo
    // chega a virar requisição.
    // -----------------------------------------------------------------------
    #[test]
    fn the_fetcher_refuses_any_host_other_than_lrclib_and_vagalume() {
        for url in [
            "https://exemplo.invalido/coleta",
            "http://localhost:9/x",
            "file:///etc/passwd",
            "https://lrclib.net.exemplo.invalido/api/search?q=x",
            "https://api.vagalume.com.br.exemplo.invalido/search.php",
            "https://api.acoustid.org.exemplo.invalido/v2/lookup",
            // o lançamento de acessórios NÃO é destino do funil: cada
            // fetcher tem a sua lista, e nenhuma empresta para a outra
            crate::acessorios::URL_BASE,
            "",
        ] {
            let err = funil_fetcher(url).expect_err("destino {url} deveria ser recusado");
            assert_eq!(err.to_string(), "endereço de rede não permitido");
        }
    }

    /// ...e os três destinos legítimos passam pela trava (o erro que sobra é
    /// de rede, não de permissão — a suíte roda sem internet).
    #[test]
    fn the_three_legitimate_destinations_pass_the_guard() {
        for url in [
            crate::lyrics_fetch::SEARCH_URL,
            crate::vagalume::SEARCH_URL,
            crate::fingerprint::LOOKUP_URL,
        ] {
            if let Err(e) = funil_fetcher(url) {
                assert_ne!(
                    e.to_string(),
                    "endereço de rede não permitido",
                    "{url} é destino legítimo"
                );
            }
        }
    }

    /// V9 — a MESMA disciplina no fetcher dos acessórios, e ela importa mais
    /// aqui do que em qualquer outro lugar: o que este fetcher traz vira
    /// arquivo EXECUTÁVEL na máquina de quem clicou. Só o lançamento de
    /// acessórios passa, e nenhum endereço parecido passa junto. Roda
    /// offline: nenhuma das URLs abaixo chega a virar requisição.
    #[test]
    fn o_fetcher_de_acessorios_so_aceita_o_lancamento_de_acessorios() {
        for url in [
            "https://exemplo.invalido/fpcalc",
            "http://localhost:9/fpcalc",
            "file:///bin/sh",
            // domínio PARECIDO com o do GitHub
            "https://github.com.exemplo.invalido/gabrielnader/cancioneiro/releases/download/acessorios-v1/fpcalc-linux-x86_64",
            // GitHub de verdade, outro repositório
            "https://github.com/outra/pessoa/releases/download/acessorios-v1/fpcalc-linux-x86_64",
            // o repositório certo, mas outro lançamento (a tag é FIXA: é
            // dela que vêm as somas compiladas)
            "https://github.com/gabrielnader/cancioneiro/releases/download/acessorios-v2/fpcalc-linux-x86_64",
            // destinos do funil não valem aqui
            crate::lyrics_fetch::SEARCH_URL,
            crate::vagalume::SEARCH_URL,
            crate::fingerprint::LOOKUP_URL,
            "",
        ] {
            assert!(
                !destino_de_acessorio_permitido(url),
                "destino {url} deveria ser recusado"
            );
        }
    }

    /// ...e todo endereço do catálogo passa pela trava. Sem o par, a trava
    /// poderia estar recusando tudo e os dois testes continuariam verdes.
    #[test]
    fn os_enderecos_do_catalogo_passam_pela_trava_dos_acessorios() {
        for acessorio in crate::acessorios::CATALOGO {
            assert!(
                destino_de_acessorio_permitido(&acessorio.url()),
                "{} é destino legítimo",
                acessorio.arquivo
            );
        }
    }

    /// O download é registrado no MESMO mapa de trabalhos longos vivos das
    /// varreduras, então ele ganha o cancelamento de graça — e um id
    /// desconhecido continua sendo no-op inofensivo.
    #[test]
    fn o_download_de_acessorio_e_cancelavel_pelo_mesmo_registro() {
        let state = estado();
        let flag = state.scan_begin("download-1").unwrap();
        assert!(!flag.load(Ordering::SeqCst));
        state.cancel_scan("download-1").unwrap();
        assert!(flag.load(Ordering::SeqCst));
        state.scan_end("download-1");
        assert_eq!(state.scans_vivas(), 0);
    }

    // -----------------------------------------------------------------------
    // DECISIONS #15/#48 — a JANELA DE ESCRITA não pode crescer com a F18. A
    // varredura, que dura minutos, roda em conexão DEDICADA e não segura o
    // mutex que busca/listagem usam; o apply, que são segundos, continua no
    // lock compartilhado. As duas varreduras novas (pasta e música) usam a
    // mesma `scan_conn`, então valem para as duas.
    // -----------------------------------------------------------------------
    #[test]
    fn a_running_scan_never_holds_the_lock_that_search_needs() {
        let dir = tempfile::tempdir().unwrap();
        let caminho = dir.path().join("cancioneiro.db");
        let state = Db::new(db::open_at(&caminho).unwrap(), Some(caminho.clone()));

        let varredura = state.scan_conn().unwrap();
        // com a varredura em curso, a busca continua entrando
        let busca = state.lock().expect("o lock da busca continua livre");
        assert!(db::list_songs(&busca).is_ok());
        drop(busca);
        // e a conexão da varredura é OUTRA, não o guard compartilhado
        assert!(matches!(varredura, ScanConn::Owned(_)));
    }

    /// Banco in-memory (só nos testes) não tem arquivo para reabrir: aí a
    /// varredura cai no lock compartilhado mesmo — comportamento inalterado.
    #[test]
    fn an_in_memory_database_falls_back_to_the_shared_lock() {
        let state = estado();
        assert!(matches!(state.scan_conn().unwrap(), ScanConn::Shared(_)));
    }

    // -----------------------------------------------------------------------
    // QA MÉDIO-6 — resposta do servidor não é "sem conexão". Antes, um 429
    // (plausível a 300 ms × 95 músicas), um 500 ou uma chave digitada errada
    // produziam todos a MESMA frase, e a pessoa terminava com dezenas de
    // linhas culpando uma internet que estava ótima. Não há a quem perguntar:
    // a frase é a explicação inteira.
    // -----------------------------------------------------------------------
    #[test]
    fn each_http_failure_says_what_actually_happened() {
        use crate::vagalume::ERRO_CHAVE_RECUSADA;

        // chave recusada: as duas fontes que levam chave têm mensagens
        // DIFERENTES, porque as chaves são de donos diferentes — a do
        // Vagalume é do usuário (dá para conferir se copiou certo), a do
        // AcoustID é nossa e vem compilada (não há nada que ele possa fazer)
        assert_eq!(mensagem_de_status(401, Destino::Vagalume), ERRO_CHAVE_RECUSADA);
        assert_eq!(mensagem_de_status(403, Destino::Vagalume), ERRO_CHAVE_RECUSADA);
        assert_eq!(
            mensagem_de_status(401, Destino::Acoustid),
            crate::fingerprint::ERRO_CHAVE_RECUSADA
        );
        // o LRCLIB não tem chave nenhuma: 401/403 lá é outra coisa
        assert_eq!(
            mensagem_de_status(401, Destino::Lrclib),
            "o site de letras respondeu com erro"
        );

        assert_eq!(
            mensagem_de_status(429, Destino::Vagalume),
            "o site de letras pediu para esperar um pouco"
        );
        assert_eq!(
            mensagem_de_status(429, Destino::Lrclib),
            "o site de letras pediu para esperar um pouco"
        );
        for fora_do_ar in [500, 502, 503, 504] {
            assert_eq!(
                mensagem_de_status(fora_do_ar, Destino::Lrclib),
                "o site de letras está fora do ar agora",
                "status {fora_do_ar}"
            );
        }
        for outro in [400, 404, 410, 418] {
            assert_eq!(
                mensagem_de_status(outro, Destino::Lrclib),
                "o site de letras respondeu com erro",
                "status {outro}"
            );
        }
    }

    /// O AcoustID fala de SI, e nunca se chama "site de letras": ele não
    /// devolve letra nenhuma, e mandar a pessoa procurar defeito num site de
    /// letras quando o que falhou foi o reconhecimento é mandá-la procurar
    /// no lugar errado.
    #[test]
    fn o_reconhecimento_pelo_som_nunca_se_chama_site_de_letras() {
        for status in [400, 401, 403, 404, 429, 500, 502, 503] {
            let msg = mensagem_de_status(status, Destino::Acoustid);
            assert!(!msg.contains("letras"), "status {status}: {msg}");
            assert!(msg.contains("som"), "status {status}: {msg}");
        }
    }

    /// Nenhuma dessas frases pode carregar chave nenhuma: elas são texto
    /// FIXO, sem interpolação, e é assim que a garantia se sustenta.
    #[test]
    fn no_network_message_can_ever_carry_the_key() {
        for chave in [
            "minha-chave-secreta-do-vagalume",
            "minha-chave-secreta-do-acoustid",
        ] {
            for status in [400, 401, 403, 404, 429, 500, 502, 503] {
                for destino in [Destino::Lrclib, Destino::Vagalume, Destino::Acoustid] {
                    assert!(
                        !mensagem_de_status(status, destino).contains(chave),
                        "status {status}, destino {destino:?}"
                    );
                }
            }
        }
    }

    /// A chave do Vagalume é resolvida num lugar só. A do USUÁRIO tem
    /// precedência sobre a nossa — é a saída se a nossa for bloqueada algum
    /// dia —, e sem nenhuma das duas a etapa é pulada, nunca um erro.
    #[test]
    fn a_chave_do_usuario_tem_precedencia_sobre_a_nossa() {
        let nossa = option_env!("VAGALUME_API_KEY").unwrap_or("").trim();
        // digitada pela pessoa: vence sempre, e chega aparada
        assert_eq!(chave(Some("  minha-chave \n".into())), "minha-chave");
        // ausente ou em branco: cai para a nossa (vazia nesta build, e aí a
        // etapa é pulada em silêncio)
        assert_eq!(chave(None), nossa);
        assert_eq!(chave(Some("   ".into())), nossa);
    }

    // -----------------------------------------------------------------------
    // QA A5 — o eco da proposta chega do frontend em snake_case, sem renames.
    // -----------------------------------------------------------------------
    #[test]
    fn enrich_apply_deserializes_the_proposal_echo_from_snake_case() {
        let ap: crate::enrich::EnrichApply = serde_json::from_str(
            r#"{"song_id": 7, "title": "Oh! Chuva", "artist": "Falamansa",
                "lyrics": null, "add_temas": null,
                "current_title": "Falamansa - Oh! Chuva", "current_artist": null}"#,
        )
        .unwrap();

        assert_eq!(ap.song_id, 7);
        assert_eq!(ap.current_title, "Falamansa - Oh! Chuva");
        assert_eq!(ap.current_artist, None);
    }
}
