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
use tauri::{AppHandle, Emitter, State};

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

#[tauri::command]
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
#[tauri::command]
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
#[tauri::command]
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

/// Fetcher real (ureq) do funil, compartilhado por `enrich_folder_scan` e
/// `enrich_song_scan` — os ÚNICOS pontos de rede de todo o app, ambos
/// acionados por cliques explícitos do usuário. GET com timeout de 10 s e
/// User-Agent "Cancioneiro/0.7".
///
/// A primeira coisa que ele faz é conferir o DESTINO: só LRCLIB e Vagalume
/// passam. A trava é barata e vale como garantia executável do inviolável
/// "nada do acervo sai da máquina" — um endereço montado errado (ou vindo de
/// dado do próprio acervo) não consegue virar requisição para outro servidor.
///
/// 404 no Vagalume é resposta legítima ("não conheço esta música") e vira
/// corpo vazio, que o módulo lê como "sem resultado". Chamar isso de falha de
/// rede transformaria repertório desconhecido em erro na tela do usuário.
///
/// As demais falhas viram mensagens DISTINTAS (ver `mensagem_de_status`).
pub(crate) fn funil_fetcher(url: &str) -> Result<String> {
    let vagalume = url.starts_with(crate::vagalume::SEARCH_URL);
    if !vagalume && !url.starts_with(crate::lyrics_fetch::SEARCH_URL) {
        return Err(AppError("endereço de rede não permitido".into()));
    }
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(10))
        .user_agent("Cancioneiro/0.7")
        .build();
    match agent.get(url).call() {
        Ok(resp) => resp
            .into_string()
            .map_err(|_| AppError("sem conexão".into())),
        Err(ureq::Error::Status(404, _)) if vagalume => Ok(String::new()),
        Err(ureq::Error::Status(status, _)) => {
            Err(AppError(mensagem_de_status(status, vagalume).into()))
        }
        // transporte: DNS que não resolve, tempo esgotado, conexão recusada.
        // Aqui "sem conexão" é a verdade, e continua sendo o texto.
        Err(_) => Err(AppError("sem conexão".into())),
    }
}

/// O que dizer a quem está olhando a tela quando o servidor RESPONDEU, mas
/// não com a letra.
///
/// Dizer "sem conexão" para tudo (o que este fetcher fazia) manda a pessoa
/// investigar a própria internet, que está ótima, e repete a acusação errada
/// em cada uma das linhas da varredura. As frases são curtas, sem jargão e
/// sem número de código solto — quem cura são ~40 pessoas que não abrem
/// terminal e não têm a quem perguntar; esta frase é a explicação inteira.
///
/// São TEXTO FIXO, sem interpolação: é o que garante que a chave do usuário
/// nunca possa aparecer numa mensagem de erro.
fn mensagem_de_status(status: u16, vagalume: bool) -> &'static str {
    match status {
        // só a consulta ao Vagalume leva chave; 401/403 no LRCLIB é outra
        // coisa qualquer, e mandar conferir uma chave que não existe naquela
        // consulta seria mandar a pessoa procurar defeito onde não há
        401 | 403 if vagalume => crate::vagalume::ERRO_CHAVE_RECUSADA,
        429 => "o site de letras pediu para esperar um pouco",
        500..=599 => "o site de letras está fora do ar agora",
        _ => "o site de letras respondeu com erro",
    }
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

/// A chave do Vagalume como o funil a espera: `None`/vazia = etapa pulada.
///
/// Ela vem do frontend a cada chamada (é preferência dele, não dado do
/// acervo) e NUNCA entra no banco de músicas, em log ou em mensagem de erro,
/// nem é enviada a lugar nenhum além do próprio Vagalume. Fica guardada nas
/// preferências locais do aplicativo, na máquina da própria pessoa. Sem chave
/// nada falha: a etapa simplesmente não acontece.
fn chave(vagalume_key: Option<String>) -> String {
    vagalume_key.unwrap_or_default().trim().to_string()
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
#[tauri::command]
pub fn enrich_folder_scan(
    app: AppHandle,
    state: State<'_, Db>,
    folder_prefix: String,
    scan_id: String,
    vagalume_key: Option<String>,
) -> Result<Vec<crate::enrich::EnrichProposal>> {
    let cancel = state.scan_begin(&scan_id)?;
    let progresso = emissor_de_progresso(app, scan_id.clone());
    let resultado = (|| {
        let conn = state.scan_conn()?;
        crate::enrich::enrich_scan(
            &conn,
            &folder_prefix,
            funil_fetcher,
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
#[tauri::command]
pub fn enrich_count(state: State<'_, Db>, folder_prefix: String) -> Result<usize> {
    let conn = state.lock()?;
    crate::enrich::count_candidatas(&conn, &folder_prefix)
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
#[tauri::command]
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
    let progresso = emissor_de_progresso(app, scan_id.clone());
    let resultado = (|| {
        let conn = state.scan_conn()?;
        crate::enrich::enrich_scan_song(
            &conn,
            song_id,
            title.as_deref(),
            artist.as_deref(),
            funil_fetcher,
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
#[tauri::command]
pub fn enrich_apply(
    state: State<'_, Db>,
    aplicacoes: Vec<crate::enrich::EnrichApply>,
) -> Result<Vec<crate::enrich::EnrichApplyResult>> {
    let conn = state.lock()?;
    crate::enrich::apply(&conn, &aplicacoes)
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
        assert_eq!(
            [
                ETAPA_PREPARANDO,
                ETAPA_NOME_ARQUIVO,
                ETAPA_LRCLIB,
                ETAPA_VAGALUME,
                ETAPA_CONCLUIDA
            ],
            [
                "preparando",
                "lendo etiquetas e nome do arquivo",
                "procurando no LRCLIB",
                "procurando no Vagalume",
                "concluída"
            ]
        );
        assert_eq!(
            [
                FONTE_NOME_ARQUIVO,
                FONTE_LRCLIB,
                FONTE_VAGALUME,
                FONTE_ERRO
            ],
            ["nome do arquivo", "LRCLIB", "Vagalume", "erro"]
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
            ]
        );
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
            "",
        ] {
            let err = funil_fetcher(url).expect_err("destino {url} deveria ser recusado");
            assert_eq!(err.to_string(), "endereço de rede não permitido");
        }
    }

    /// ...e os dois destinos legítimos passam pela trava (o erro que sobra é
    /// de rede, não de permissão — a suíte roda sem internet).
    #[test]
    fn the_two_legitimate_destinations_pass_the_guard() {
        for url in [
            crate::lyrics_fetch::SEARCH_URL,
            crate::vagalume::SEARCH_URL,
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

        // chave recusada: só faz sentido numa consulta ao Vagalume, que é a
        // única que leva chave
        assert_eq!(mensagem_de_status(401, true), ERRO_CHAVE_RECUSADA);
        assert_eq!(mensagem_de_status(403, true), ERRO_CHAVE_RECUSADA);
        // o LRCLIB não tem chave nenhuma: 401/403 lá é outra coisa
        assert_eq!(
            mensagem_de_status(401, false),
            "o site de letras respondeu com erro"
        );

        assert_eq!(
            mensagem_de_status(429, true),
            "o site de letras pediu para esperar um pouco"
        );
        assert_eq!(
            mensagem_de_status(429, false),
            "o site de letras pediu para esperar um pouco"
        );
        for fora_do_ar in [500, 502, 503, 504] {
            assert_eq!(
                mensagem_de_status(fora_do_ar, false),
                "o site de letras está fora do ar agora",
                "status {fora_do_ar}"
            );
        }
        for outro in [400, 404, 410, 418] {
            assert_eq!(
                mensagem_de_status(outro, false),
                "o site de letras respondeu com erro",
                "status {outro}"
            );
        }
    }

    /// Nenhuma dessas frases pode carregar a chave: elas são texto FIXO, sem
    /// interpolação, e é assim que a garantia se sustenta.
    #[test]
    fn no_network_message_can_ever_carry_the_key() {
        let chave = "minha-chave-secreta-do-vagalume";
        for status in [400, 401, 403, 404, 429, 500, 502, 503] {
            for vagalume in [true, false] {
                assert!(
                    !mensagem_de_status(status, vagalume).contains(chave),
                    "status {status}"
                );
            }
        }
    }

    /// A chave do Vagalume é normalizada num lugar só, e ausente/vazia
    /// significa "pule a etapa" — nunca erro.
    #[test]
    fn a_missing_or_blank_key_becomes_the_empty_key() {
        assert_eq!(chave(None), "");
        assert_eq!(chave(Some("   ".into())), "");
        assert_eq!(chave(Some("  minha-chave \n".into())), "minha-chave");
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
