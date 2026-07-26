use crate::db::{self, Folder, Playlist, PlaylistItem, Song};
use crate::error::{AppError, Result};
use crate::indexer;
use rusqlite::Connection;
use serde::Serialize;
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

/// Estado global: conexão SQLite protegida por mutex.
pub struct Db(pub Mutex<Connection>);

impl Db {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>> {
        self.0
            .lock()
            .map_err(|_| AppError("estado do banco corrompido (lock poisoned)".into()))
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
    let conn = state.lock()?;
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
    let conn = state.lock()?;
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
