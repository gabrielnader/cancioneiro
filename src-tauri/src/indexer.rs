use crate::db;
use crate::error::{AppError, Result};
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::tag::{Accessor, ItemKey};
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashSet;
use std::path::Path;
use std::time::UNIX_EPOCH;
use walkdir::WalkDir;

#[derive(Debug, Default, PartialEq)]
pub struct ScanStats {
    /// Arquivos lidos/relidos (novos ou alterados).
    pub indexed: usize,
    /// Arquivos inalterados (skip por mtime+size).
    pub skipped: usize,
    /// Registros removidos (arquivo sumiu do disco).
    pub removed: usize,
    /// Arquivos com falha de leitura de tags (indexados com fallback).
    pub tag_errors: usize,
    /// Total de MP3s encontrados na pasta.
    pub total: usize,
}

#[derive(Debug, Default)]
pub struct ScanOutcome {
    pub stats: ScanStats,
    /// Pastas registradas cujo caminho não existe mais no disco.
    pub missing_folders: Vec<String>,
}

struct TagData {
    title: String,
    artist: Option<String>,
    album: Option<String>,
    duration_seconds: Option<i64>,
    lyrics: Option<String>,
    /// true se a leitura de tags falhou e usamos fallback
    fallback: bool,
}

fn file_stem_title(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

/// Lê tags de um MP3 com lofty. Nunca falha: em erro de leitura devolve
/// fallback (título = nome do arquivo, sem letra), conforme F1 do PRD.
fn read_tags(path: &Path) -> TagData {
    let fallback = TagData {
        title: file_stem_title(path),
        artist: None,
        album: None,
        duration_seconds: None,
        lyrics: None,
        fallback: true,
    };

    let tagged = match lofty::read_from_path(path) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("[indexer] falha ao ler tags de {path:?}: {e}");
            return fallback;
        }
    };

    let duration = tagged.properties().duration().as_secs() as i64;
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag());

    let (title, artist, album, lyrics) = match tag {
        Some(t) => {
            let title = t
                .title()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| file_stem_title(path));
            let artist = t
                .artist()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            let album = t
                .album()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            let lyrics = t
                .get_string(&ItemKey::Lyrics)
                .map(|s| s.to_string())
                .filter(|s| !s.trim().is_empty());
            (title, artist, album, lyrics)
        }
        None => (file_stem_title(path), None, None, None),
    };

    TagData {
        title,
        artist,
        album,
        duration_seconds: Some(duration),
        lyrics,
        fallback: false,
    }
}

fn file_mtime_epoch(md: &std::fs::Metadata) -> i64 {
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn is_mp3(path: &Path) -> bool {
    path.extension()
        .map(|e| e.to_string_lossy().eq_ignore_ascii_case("mp3"))
        .unwrap_or(false)
}

/// Varre uma pasta registrada: indexa MP3s novos/alterados (skip incremental
/// por mtime+size), remove do índice arquivos que sumiram, atualiza
/// last_scanned_at. `progress` recebe (concluídos, total).
pub fn scan_folder<F: FnMut(usize, usize)>(
    conn: &Connection,
    folder_id: i64,
    mut progress: F,
) -> Result<ScanStats> {
    let folder_path: String = conn
        .query_row(
            "SELECT path FROM folders WHERE id = ?1",
            params![folder_id],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(|| AppError(format!("pasta não registrada: {folder_id}")))?;

    if !Path::new(&folder_path).is_dir() {
        return Err(AppError(format!("pasta não encontrada: {folder_path}")));
    }

    // Pasta existe: tudo que está nela volta a ficar disponível.
    conn.execute(
        "UPDATE songs SET available = 1 WHERE folder_id = ?1",
        params![folder_id],
    )?;

    let files: Vec<walkdir::DirEntry> = WalkDir::new(&folder_path)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file() && is_mp3(e.path()))
        .collect();

    let mut stats = ScanStats {
        total: files.len(),
        ..Default::default()
    };
    let mut seen: HashSet<String> = HashSet::with_capacity(files.len());
    let mut done = 0usize;
    progress(0, stats.total);

    for entry in files {
        let path = entry.path();
        let path_str = path.to_string_lossy().into_owned();
        seen.insert(path_str.clone());

        let md = match entry.metadata() {
            Ok(m) => m,
            Err(e) => {
                eprintln!("[indexer] metadata falhou para {path:?}: {e}");
                done += 1;
                progress(done, stats.total);
                continue;
            }
        };
        let mtime = file_mtime_epoch(&md);
        let size = md.len() as i64;

        let existing: Option<(i64, i64)> = conn
            .query_row(
                "SELECT file_mtime, file_size FROM songs WHERE file_path = ?1",
                params![path_str],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;

        if existing == Some((mtime, size)) {
            stats.skipped += 1;
            done += 1;
            progress(done, stats.total);
            continue;
        }

        let tags = read_tags(path);
        if tags.fallback {
            stats.tag_errors += 1;
        }
        let has_lyrics = tags.lyrics.is_some();
        conn.execute(
            "INSERT INTO songs
                (file_path, folder_id, title, artist, album, duration_seconds,
                 has_lyrics, lyrics, file_mtime, file_size, available, indexed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1, datetime('now'))
             ON CONFLICT(file_path) DO UPDATE SET
                folder_id = excluded.folder_id,
                title = excluded.title,
                artist = excluded.artist,
                album = excluded.album,
                duration_seconds = excluded.duration_seconds,
                has_lyrics = excluded.has_lyrics,
                lyrics = excluded.lyrics,
                file_mtime = excluded.file_mtime,
                file_size = excluded.file_size,
                available = 1,
                indexed_at = datetime('now')",
            params![
                path_str,
                folder_id,
                tags.title,
                tags.artist,
                tags.album,
                tags.duration_seconds,
                has_lyrics as i64,
                tags.lyrics,
                mtime,
                size
            ],
        )?;
        stats.indexed += 1;
        done += 1;
        progress(done, stats.total);
    }

    // Remove do índice arquivos desta pasta que sumiram do disco.
    let indexed_paths: Vec<(i64, String)> = {
        let mut stmt =
            conn.prepare("SELECT id, file_path FROM songs WHERE folder_id = ?1")?;
        let rows = stmt.query_map(params![folder_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<std::result::Result<_, _>>()?
    };
    for (id, path) in indexed_paths {
        if !seen.contains(&path) {
            conn.execute("DELETE FROM songs WHERE id = ?1", params![id])?;
            stats.removed += 1;
        }
    }

    conn.execute(
        "UPDATE folders SET last_scanned_at = datetime('now') WHERE id = ?1",
        params![folder_id],
    )?;

    Ok(stats)
}

/// Varre todas as pastas registradas. Pastas cujo caminho sumiu do disco não
/// têm as músicas deletadas: elas são marcadas indisponíveis e a pasta é
/// reportada em `missing_folders` (F1 do PRD).
pub fn scan_all<F: FnMut(usize, usize)>(
    conn: &Connection,
    mut progress: F,
) -> Result<ScanOutcome> {
    let folders = db::list_folders(conn)?;
    let mut outcome = ScanOutcome::default();

    for folder in folders {
        if !Path::new(&folder.path).is_dir() {
            conn.execute(
                "UPDATE songs SET available = 0 WHERE folder_id = ?1",
                params![folder.id],
            )?;
            outcome.missing_folders.push(folder.path);
            continue;
        }
        let stats = scan_folder(conn, folder.id, &mut progress)?;
        outcome.stats.indexed += stats.indexed;
        outcome.stats.skipped += stats.skipped;
        outcome.stats.removed += stats.removed;
        outcome.stats.tag_errors += stats.tag_errors;
        outcome.stats.total += stats.total;
    }

    Ok(outcome)
}
