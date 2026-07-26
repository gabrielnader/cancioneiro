use crate::error::{AppError, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
pub struct Folder {
    pub id: i64,
    pub path: String,
    pub last_scanned_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Song {
    pub id: i64,
    pub file_path: String,
    pub folder_id: i64,
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub duration_seconds: Option<i64>,
    pub has_lyrics: bool,
    pub available: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Playlist {
    pub id: i64,
    pub name: String,
    pub song_count: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct PlaylistItem {
    pub id: i64,
    pub playlist_id: i64,
    pub position: i64,
    pub song: Song,
}

const SCHEMA: &str = r#"
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_scanned_at TEXT
);

CREATE TABLE IF NOT EXISTS songs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT NOT NULL UNIQUE,
    folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    artist TEXT,
    album TEXT,
    duration_seconds INTEGER,
    has_lyrics INTEGER NOT NULL DEFAULT 0,
    lyrics TEXT,
    file_mtime INTEGER NOT NULL,
    file_size INTEGER NOT NULL,
    available INTEGER NOT NULL DEFAULT 1,
    indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_songs_folder_id ON songs(folder_id);

CREATE VIRTUAL TABLE IF NOT EXISTS songs_fts USING fts5(
    title, artist, lyrics,
    content='songs', content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS songs_ai AFTER INSERT ON songs BEGIN
    INSERT INTO songs_fts(rowid, title, artist, lyrics)
    VALUES (new.id, new.title, new.artist, new.lyrics);
END;

CREATE TRIGGER IF NOT EXISTS songs_ad AFTER DELETE ON songs BEGIN
    INSERT INTO songs_fts(songs_fts, rowid, title, artist, lyrics)
    VALUES ('delete', old.id, old.title, old.artist, old.lyrics);
END;

CREATE TRIGGER IF NOT EXISTS songs_au AFTER UPDATE ON songs BEGIN
    INSERT INTO songs_fts(songs_fts, rowid, title, artist, lyrics)
    VALUES ('delete', old.id, old.title, old.artist, old.lyrics);
    INSERT INTO songs_fts(rowid, title, artist, lyrics)
    VALUES (new.id, new.title, new.artist, new.lyrics);
END;

CREATE TABLE IF NOT EXISTS playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS playlist_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    song_id INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
    position INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_playlist_items ON playlist_items(playlist_id, position);
"#;

/// Remove diacríticos latinos comuns (suficiente para ordenação pt-BR).
fn strip_diacritic(c: char) -> char {
    match c {
        'á' | 'à' | 'â' | 'ã' | 'ä' | 'å' => 'a',
        'é' | 'è' | 'ê' | 'ë' => 'e',
        'í' | 'ì' | 'î' | 'ï' => 'i',
        'ó' | 'ò' | 'ô' | 'õ' | 'ö' => 'o',
        'ú' | 'ù' | 'û' | 'ü' => 'u',
        'ç' => 'c',
        'ñ' => 'n',
        'ý' | 'ÿ' => 'y',
        other => other,
    }
}

fn fold_pt(s: &str) -> String {
    s.chars()
        .flat_map(char::to_lowercase)
        .map(strip_diacritic)
        .collect()
}

pub fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    // Ordenação alfabética que ignora caixa e acentos ("Água" antes de "Zebra")
    conn.create_collation("ptbr", |a, b| fold_pt(a).cmp(&fold_pt(b)))?;
    conn.execute_batch(SCHEMA)?;
    Ok(())
}

pub fn open_at(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
    init_schema(&conn)?;
    Ok(conn)
}

pub fn open_in_memory() -> Result<Connection> {
    let conn = Connection::open_in_memory()?;
    init_schema(&conn)?;
    Ok(conn)
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

pub fn add_folder(conn: &Connection, path: &str) -> Result<i64> {
    let p = Path::new(path);
    if !p.is_dir() {
        return Err(AppError(format!("pasta não encontrada: {path}")));
    }
    // Canonicaliza para evitar duplicatas como "/musicas" vs "/musicas/".
    let canonical = std::fs::canonicalize(p)
        .map_err(|e| AppError(format!("pasta não encontrada: {path} ({e})")))?;
    let canonical_str = canonical.to_string_lossy().into_owned();

    // Pastas sobrepostas (uma dentro da outra) fariam o mesmo arquivo pertencer
    // a duas folders: como file_path é UNIQUE, remover uma delas apagaria a
    // música (e seus itens de playlist) mesmo estando coberta pela outra.
    // Rejeitamos o overlap — exceto o caso da própria pasta já registrada.
    for existing in list_folders(conn)? {
        if existing.path == canonical_str {
            return Ok(existing.id);
        }
        let existing_path = Path::new(&existing.path);
        if canonical.starts_with(existing_path) || existing_path.starts_with(&canonical) {
            return Err(AppError(format!(
                "pasta sobreposta a uma pasta já adicionada: {}",
                existing.path
            )));
        }
    }

    conn.execute(
        "INSERT INTO folders (path) VALUES (?1)",
        params![canonical_str],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn remove_folder(conn: &Connection, folder_id: i64) -> Result<()> {
    conn.execute("DELETE FROM folders WHERE id = ?1", params![folder_id])?;
    Ok(())
}

pub fn list_folders(conn: &Connection) -> Result<Vec<Folder>> {
    let mut stmt =
        conn.prepare("SELECT id, path, last_scanned_at FROM folders ORDER BY path")?;
    let rows = stmt.query_map([], |r| {
        Ok(Folder {
            id: r.get(0)?,
            path: r.get(1)?,
            last_scanned_at: r.get(2)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

// ---------------------------------------------------------------------------
// Songs
// ---------------------------------------------------------------------------

pub(crate) const SONG_COLS: &str =
    "id, file_path, folder_id, title, artist, album, duration_seconds, has_lyrics, available";

pub(crate) fn song_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Song> {
    Ok(Song {
        id: r.get(0)?,
        file_path: r.get(1)?,
        folder_id: r.get(2)?,
        title: r.get(3)?,
        artist: r.get(4)?,
        album: r.get(5)?,
        duration_seconds: r.get(6)?,
        has_lyrics: r.get::<_, i64>(7)? != 0,
        available: r.get::<_, i64>(8)? != 0,
    })
}

pub fn list_songs(conn: &Connection) -> Result<Vec<Song>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {SONG_COLS} FROM songs ORDER BY title COLLATE ptbr, id"
    ))?;
    let rows = stmt.query_map([], song_from_row)?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

pub fn get_song(conn: &Connection, song_id: i64) -> Result<Option<Song>> {
    let mut stmt = conn.prepare(&format!("SELECT {SONG_COLS} FROM songs WHERE id = ?1"))?;
    Ok(stmt
        .query_row(params![song_id], song_from_row)
        .optional()?)
}

pub fn get_lyrics(conn: &Connection, song_id: i64) -> Result<Option<String>> {
    let lyrics: Option<Option<String>> = conn
        .query_row(
            "SELECT lyrics FROM songs WHERE id = ?1",
            params![song_id],
            |r| r.get(0),
        )
        .optional()?;
    match lyrics {
        None => Err(AppError(format!("música não encontrada: {song_id}"))),
        Some(l) => Ok(l),
    }
}

// ---------------------------------------------------------------------------
// Playlists
// ---------------------------------------------------------------------------

pub fn create_playlist(conn: &Connection, name: &str) -> Result<i64> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError("nome de playlist vazio".into()));
    }
    conn.execute("INSERT INTO playlists (name) VALUES (?1)", params![trimmed])?;
    Ok(conn.last_insert_rowid())
}

pub fn delete_playlist(conn: &Connection, playlist_id: i64) -> Result<()> {
    conn.execute("DELETE FROM playlists WHERE id = ?1", params![playlist_id])?;
    Ok(())
}

pub fn list_playlists(conn: &Connection) -> Result<Vec<Playlist>> {
    let mut stmt = conn.prepare(
        "SELECT p.id, p.name, count(pi.id)
         FROM playlists p
         LEFT JOIN playlist_items pi ON pi.playlist_id = p.id
         GROUP BY p.id ORDER BY p.name COLLATE ptbr",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(Playlist {
            id: r.get(0)?,
            name: r.get(1)?,
            song_count: r.get(2)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

pub fn add_song_to_playlist(conn: &Connection, playlist_id: i64, song_id: i64) -> Result<i64> {
    let next: i64 = conn.query_row(
        "SELECT coalesce(max(position) + 1, 0) FROM playlist_items WHERE playlist_id = ?1",
        params![playlist_id],
        |r| r.get(0),
    )?;
    conn.execute(
        "INSERT INTO playlist_items (playlist_id, song_id, position) VALUES (?1, ?2, ?3)",
        params![playlist_id, song_id, next],
    )?;
    conn.execute(
        "UPDATE playlists SET updated_at = datetime('now') WHERE id = ?1",
        params![playlist_id],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn remove_playlist_item(conn: &Connection, item_id: i64) -> Result<()> {
    let playlist_id: Option<i64> = conn
        .query_row(
            "SELECT playlist_id FROM playlist_items WHERE id = ?1",
            params![item_id],
            |r| r.get(0),
        )
        .optional()?;
    conn.execute("DELETE FROM playlist_items WHERE id = ?1", params![item_id])?;
    if let Some(pid) = playlist_id {
        renumber_playlist(conn, pid)?;
    }
    Ok(())
}

/// Reordena a playlist inteira: `item_ids` na nova ordem desejada. Deve
/// cobrir exatamente os itens atuais (transacional — não deixa positions
/// duplicadas se algo falhar no meio).
pub fn reorder_playlist(conn: &Connection, playlist_id: i64, item_ids: &[i64]) -> Result<()> {
    let current: std::collections::HashSet<i64> = {
        let mut stmt =
            conn.prepare("SELECT id FROM playlist_items WHERE playlist_id = ?1")?;
        let rows = stmt.query_map(params![playlist_id], |r| r.get(0))?;
        rows.collect::<std::result::Result<_, _>>()?
    };
    let requested: std::collections::HashSet<i64> = item_ids.iter().copied().collect();
    if requested != current || requested.len() != item_ids.len() {
        return Err(AppError(
            "reordenação inválida: itens não correspondem à playlist".into(),
        ));
    }

    let tx = conn.unchecked_transaction()?;
    for (pos, item_id) in item_ids.iter().enumerate() {
        tx.execute(
            "UPDATE playlist_items SET position = ?1 WHERE id = ?2 AND playlist_id = ?3",
            params![pos as i64, item_id, playlist_id],
        )?;
    }
    tx.execute(
        "UPDATE playlists SET updated_at = datetime('now') WHERE id = ?1",
        params![playlist_id],
    )?;
    tx.commit()?;
    Ok(())
}

fn renumber_playlist(conn: &Connection, playlist_id: i64) -> Result<()> {
    let ids: Vec<i64> = {
        let mut stmt = conn.prepare(
            "SELECT id FROM playlist_items WHERE playlist_id = ?1 ORDER BY position, id",
        )?;
        let rows = stmt.query_map(params![playlist_id], |r| r.get(0))?;
        rows.collect::<std::result::Result<_, _>>()?
    };
    for (pos, id) in ids.iter().enumerate() {
        conn.execute(
            "UPDATE playlist_items SET position = ?1 WHERE id = ?2",
            params![pos as i64, id],
        )?;
    }
    Ok(())
}

pub fn get_playlist_items(conn: &Connection, playlist_id: i64) -> Result<Vec<PlaylistItem>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT pi.id, pi.playlist_id, pi.position, {}
         FROM playlist_items pi
         JOIN songs s ON s.id = pi.song_id
         WHERE pi.playlist_id = ?1
         ORDER BY pi.position, pi.id",
        SONG_COLS
            .split(", ")
            .map(|c| format!("s.{c}"))
            .collect::<Vec<_>>()
            .join(", ")
    ))?;
    let rows = stmt.query_map(params![playlist_id], |r| {
        Ok(PlaylistItem {
            id: r.get(0)?,
            playlist_id: r.get(1)?,
            position: r.get(2)?,
            song: Song {
                id: r.get(3)?,
                file_path: r.get(4)?,
                folder_id: r.get(5)?,
                title: r.get(6)?,
                artist: r.get(7)?,
                album: r.get(8)?,
                duration_seconds: r.get(9)?,
                has_lyrics: r.get::<_, i64>(10)? != 0,
                available: r.get::<_, i64>(11)? != 0,
            },
        })
    })?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_initializes_with_fts5_and_foreign_keys() {
        let conn = open_in_memory().unwrap();
        let fk: i64 = conn
            .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
            .unwrap();
        assert_eq!(fk, 1);
        // FTS5 disponível e tabela criada
        let count: i64 = conn
            .query_row("SELECT count(*) FROM songs_fts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn list_songs_orders_alphabetically_ignoring_case_and_accents() {
        let conn = open_in_memory().unwrap();
        conn.execute_batch(
            "INSERT INTO folders (path) VALUES ('/f');
             INSERT INTO songs (file_path, folder_id, title, file_mtime, file_size) VALUES
               ('/f/1.mp3', 1, 'zebra', 0, 0),
               ('/f/2.mp3', 1, 'Água Viva', 0, 0),
               ('/f/3.mp3', 1, 'banana', 0, 0),
               ('/f/4.mp3', 1, 'Édipo', 0, 0);",
        )
        .unwrap();
        let titles: Vec<String> = list_songs(&conn)
            .unwrap()
            .into_iter()
            .map(|s| s.title)
            .collect();
        assert_eq!(titles, vec!["Água Viva", "banana", "Édipo", "zebra"]);
    }

    #[test]
    fn create_playlist_rejects_empty_name() {
        let conn = open_in_memory().unwrap();
        assert!(create_playlist(&conn, "").is_err());
        assert!(create_playlist(&conn, "   ").is_err());
    }

    #[test]
    fn playlist_positions_are_sequential_and_renumbered_after_removal() {
        let conn = open_in_memory().unwrap();
        conn.execute_batch(
            "INSERT INTO folders (path) VALUES ('/f');
             INSERT INTO songs (file_path, folder_id, title, file_mtime, file_size)
             VALUES ('/f/a.mp3', 1, 'A', 0, 0), ('/f/b.mp3', 1, 'B', 0, 0), ('/f/c.mp3', 1, 'C', 0, 0);",
        )
        .unwrap();
        let pid = create_playlist(&conn, "P").unwrap();
        add_song_to_playlist(&conn, pid, 1).unwrap();
        add_song_to_playlist(&conn, pid, 2).unwrap();
        add_song_to_playlist(&conn, pid, 3).unwrap();

        let items = get_playlist_items(&conn, pid).unwrap();
        assert_eq!(
            items.iter().map(|i| i.position).collect::<Vec<_>>(),
            vec![0, 1, 2]
        );

        remove_playlist_item(&conn, items[0].id).unwrap();
        let items = get_playlist_items(&conn, pid).unwrap();
        assert_eq!(
            items.iter().map(|i| i.position).collect::<Vec<_>>(),
            vec![0, 1]
        );
        assert_eq!(items[0].song.title, "B");
    }

    #[test]
    fn reorder_playlist_persists_new_positions() {
        let conn = open_in_memory().unwrap();
        conn.execute_batch(
            "INSERT INTO folders (path) VALUES ('/f');
             INSERT INTO songs (file_path, folder_id, title, file_mtime, file_size)
             VALUES ('/f/a.mp3', 1, 'A', 0, 0), ('/f/b.mp3', 1, 'B', 0, 0), ('/f/c.mp3', 1, 'C', 0, 0);",
        )
        .unwrap();
        let pid = create_playlist(&conn, "P").unwrap();
        for song_id in 1..=3 {
            add_song_to_playlist(&conn, pid, song_id).unwrap();
        }
        let items = get_playlist_items(&conn, pid).unwrap();
        // inverte a ordem
        let new_order: Vec<i64> = items.iter().rev().map(|i| i.id).collect();
        reorder_playlist(&conn, pid, &new_order).unwrap();

        let items = get_playlist_items(&conn, pid).unwrap();
        assert_eq!(
            items.iter().map(|i| i.song.title.clone()).collect::<Vec<_>>(),
            vec!["C", "B", "A"]
        );
        assert_eq!(
            items.iter().map(|i| i.position).collect::<Vec<_>>(),
            vec![0, 1, 2]
        );
    }

    #[test]
    fn reorder_playlist_rejects_incomplete_or_foreign_item_ids() {
        let conn = open_in_memory().unwrap();
        conn.execute_batch(
            "INSERT INTO folders (path) VALUES ('/f');
             INSERT INTO songs (file_path, folder_id, title, file_mtime, file_size)
             VALUES ('/f/a.mp3', 1, 'A', 0, 0), ('/f/b.mp3', 1, 'B', 0, 0);",
        )
        .unwrap();
        let pid = create_playlist(&conn, "P").unwrap();
        add_song_to_playlist(&conn, pid, 1).unwrap();
        add_song_to_playlist(&conn, pid, 2).unwrap();
        let items = get_playlist_items(&conn, pid).unwrap();

        // subconjunto → erro (positions ficariam duplicadas)
        assert!(reorder_playlist(&conn, pid, &[items[0].id]).is_err());
        // id estranho → erro
        assert!(reorder_playlist(&conn, pid, &[items[0].id, 9999]).is_err());
        // ordem original intacta
        let after = get_playlist_items(&conn, pid).unwrap();
        assert_eq!(
            after.iter().map(|i| i.position).collect::<Vec<_>>(),
            vec![0, 1]
        );
    }

    #[test]
    fn delete_playlist_cascades_items_but_keeps_songs() {
        let conn = open_in_memory().unwrap();
        conn.execute_batch(
            "INSERT INTO folders (path) VALUES ('/f');
             INSERT INTO songs (file_path, folder_id, title, file_mtime, file_size)
             VALUES ('/f/a.mp3', 1, 'A', 0, 0);",
        )
        .unwrap();
        let pid = create_playlist(&conn, "P").unwrap();
        add_song_to_playlist(&conn, pid, 1).unwrap();
        delete_playlist(&conn, pid).unwrap();
        let count: i64 = conn
            .query_row("SELECT count(*) FROM playlist_items", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
        assert_eq!(list_songs(&conn).unwrap().len(), 1);
    }
}
