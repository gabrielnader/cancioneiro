use crate::db::{self, Folder, Playlist, PlaylistItem, Song};
use crate::error::{AppError, Result};
use crate::indexer;
use rusqlite::Connection;
use serde::Serialize;
use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use tauri::{AppHandle, Emitter, State};

/// Estado global: conexão SQLite protegida por mutex + caminho do arquivo do
/// banco (quando file-backed), para abrir conexões dedicadas de scan.
pub struct Db {
    pub conn: Mutex<Connection>,
    pub path: Option<PathBuf>,
}

impl Db {
    pub fn new(conn: Connection, path: Option<PathBuf>) -> Self {
        Db {
            conn: Mutex::new(conn),
            path,
        }
    }

    fn lock(&self) -> Result<MutexGuard<'_, Connection>> {
        self.conn
            .lock()
            .map_err(|_| AppError("estado do banco corrompido (lock poisoned)".into()))
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
/// User-Agent "Cancioneiro/0.4"; qualquer falha de rede vira "sem conexão".
fn lrclib_fetcher(url: &str) -> Result<String> {
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(10))
        .user_agent("Cancioneiro/0.4")
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
#[tauri::command]
pub fn enrich_folder_scan(
    state: State<'_, Db>,
    folder_prefix: String,
) -> Result<Vec<crate::enrich::EnrichProposal>> {
    let conn = state.scan_conn()?;
    crate::enrich::enrich_scan(
        &conn,
        &folder_prefix,
        lrclib_fetcher,
        std::time::Duration::from_millis(300),
    )
}

/// Aplica as propostas aceitas (write_tags por música; nunca renomeia, nunca
/// apaga dados existentes — só preenche/atualiza o que veio). Devolve as
/// Songs atualizadas.
#[tauri::command]
pub fn enrich_apply(
    state: State<'_, Db>,
    aplicacoes: Vec<crate::enrich::EnrichApply>,
) -> Result<Vec<Song>> {
    let conn = state.lock()?;
    crate::enrich::apply(&conn, &aplicacoes)
}
