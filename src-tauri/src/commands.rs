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
    fn scan_begin(&self, scan_id: &str) -> Result<Arc<AtomicBool>> {
        let flag = Arc::new(AtomicBool::new(false));
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
/// `scan_id` (QA M4) identifica a varredura que emitiu o evento: sem ele, uma
/// varredura antiga que ainda não morreu embaralhava a barra de progresso da
/// varredura nova. A UI ignora eventos de um id que não é o dela.
#[derive(Debug, Clone, Serialize)]
pub struct EnrichProgress {
    pub done: usize,
    pub total: usize,
    pub atual: String,
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

/// Grava TIT2/TPE1/USLT/TXXX:TEMAS no MP3 (nunca renomeia, nunca toca o
/// áudio), reindexa o arquivo e devolve a Song atualizada.
#[tauri::command]
pub fn write_tags(
    state: State<'_, Db>,
    song_id: i64,
    title: String,
    artist: Option<String>,
    lyrics: Option<String>,
    temas: Option<String>,
) -> Result<Song> {
    let conn = state.lock()?;
    crate::writer::write_tags(
        &conn,
        song_id,
        &title,
        artist.as_deref(),
        lyrics.as_deref(),
        temas.as_deref(),
    )
}

/// Fetcher real (ureq) do LRCLIB, compartilhado por fetch_lyrics_online e
/// enrich_folder_scan — os ÚNICOS pontos de rede de todo o app, ambos
/// acionados por cliques explícitos do usuário. GET com timeout de 10 s e
/// User-Agent "Cancioneiro/0.5"; qualquer falha de rede vira "sem conexão".
fn lrclib_fetcher(url: &str) -> Result<String> {
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(10))
        .user_agent("Cancioneiro/0.5")
        .build();
    agent
        .get(url)
        .call()
        .map_err(|_| AppError("sem conexão".into()))?
        .into_string()
        .map_err(|_| AppError("sem conexão".into()))
}

/// Busca a letra no LRCLIB por título+artista+duração.
///
/// Ponto de rede EXPLÍCITO (PRD V4): tudo o mais é 100% offline; qualquer
/// falha de rede vira Err "sem conexão" (o frontend converte no aviso
/// "Sem conexão — a busca de letra precisa de internet.").
#[tauri::command]
pub fn fetch_lyrics_online(
    title: String,
    artist: Option<String>,
    duration_seconds: f64,
) -> Result<Option<crate::lyrics_fetch::LyricsMatch>> {
    crate::lyrics_fetch::fetch_lyrics_online(
        &title,
        artist.as_deref().unwrap_or(""),
        duration_seconds,
        lrclib_fetcher,
    )
}

// ---------------------------------------------------------------------------
// Enriquecimento em lote (F13 — PRD V5)
// ---------------------------------------------------------------------------

/// Identifica no LRCLIB as músicas incompletas sob `folder_prefix` (vazio =
/// biblioteca inteira) e devolve as propostas para a UI de revisão.
///
/// Ponto de rede EXPLÍCITO acionado pelo usuário ("Completar dados desta
/// pasta"); pausa de cortesia de 300 ms entre consultas. Erro de rede por
/// música vira proposta BAIXA com `error` — o lote nunca aborta. Usa conexão
/// dedicada (scan_conn) para não travar busca/listagem durante a varredura.
///
/// Emite `enrich:progress` (EnrichProgress) a cada música processada — no
/// acervo real são minutos de varredura, e o invoke sozinho não dá sinal de
/// vida. Mesmo padrão do `scan:progress` da indexação. Todo evento carrega o
/// `scan_id` (gerado pelo frontend) para a UI descartar o que vier de uma
/// varredura antiga.
///
/// Cancelável por `enrich_cancel_scan(scan_id)`: a varredura verifica a
/// bandeira entre músicas e volta cedo com as propostas que já tiver.
#[tauri::command]
pub fn enrich_folder_scan(
    app: AppHandle,
    state: State<'_, Db>,
    folder_prefix: String,
    scan_id: String,
) -> Result<Vec<crate::enrich::EnrichProposal>> {
    let cancel = state.scan_begin(&scan_id)?;
    let resultado = (|| {
        let conn = state.scan_conn()?;
        crate::enrich::enrich_scan(
            &conn,
            &folder_prefix,
            lrclib_fetcher,
            std::time::Duration::from_millis(300),
            |done, total, atual| {
                let _ = app.emit(
                    "enrich:progress",
                    EnrichProgress {
                        done,
                        total,
                        atual: atual.to_string(),
                        scan_id: scan_id.clone(),
                    },
                );
            },
            || cancel.load(Ordering::SeqCst),
        )
    })();
    state.scan_end(&scan_id); // a entrada morre sempre — o mapa não cresce
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
    fn enrich_progress_event_carries_the_scan_id() {
        let json = serde_json::to_value(EnrichProgress {
            done: 2,
            total: 7,
            atual: "Falamansa - Oh! Chuva.mp3".into(),
            scan_id: "scan-42".into(),
        })
        .unwrap();

        assert_eq!(json["done"], 2);
        assert_eq!(json["total"], 7);
        assert_eq!(json["atual"], "Falamansa - Oh! Chuva.mp3");
        assert_eq!(json["scan_id"], "scan-42");
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
