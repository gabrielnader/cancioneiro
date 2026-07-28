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
    /// Temas do frame TXXX:TEMAS ("água; cura") — V2, PRD-v2-temas.md.
    temas: Option<String>,
    /// Procedência da letra atual, do frame TXXX:LETRA_ORIGEM ("transcricao")
    /// — V5/F14, PRD-v5-transcricao.md.
    letra_origem: Option<String>,
    /// Música sem voz, do frame TXXX:INSTRUMENTAL — V8/F17.
    instrumental: bool,
    /// true se a leitura de tags falhou e usamos fallback
    fallback: bool,
}

/// Lê a marca TXXX:INSTRUMENTAL (V8/F17). O frame é uma BANDEIRA, não um
/// texto: a curadoria grava "1" e o desmarque explícito do
/// `embed_lyrics.py --nao-instrumental` grava "0" (ou remove o frame).
/// Qualquer outro valor não-vazio conta como marca — um arquivo marcado por
/// outra ferramenta com "true"/"sim" não pode ser lido como "não é".
fn read_instrumental(tag: &lofty::tag::Tag) -> bool {
    read_txxx(tag, "INSTRUMENTAL")
        .map(|v| !matches!(v.to_lowercase().as_str(), "0" | "false" | "nao" | "não"))
        .unwrap_or(false)
}

/// Extrai um frame TXXX pela descrição (lofty expõe TXXX desconhecidos como
/// ItemKey::Unknown(descrição)). Texto em branco conta como ausente.
fn read_txxx(tag: &lofty::tag::Tag, desc: &str) -> Option<String> {
    tag.items()
        .find(|item| matches!(item.key(), ItemKey::Unknown(d) if d == desc))
        .and_then(|item| item.value().text())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
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
        temas: None,
        letra_origem: None,
        instrumental: false,
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

    let (title, artist, album, lyrics, temas, letra_origem, instrumental) = match tag {
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
            let temas = read_txxx(t, "TEMAS");
            // V5/F14 — procedência da letra. A marca acompanha a letra que
            // está no arquivo (DECISIONS #54): letra sem marca é letra sem
            // procedência declarada, nunca "oficial" por dedução.
            let letra_origem = read_txxx(t, "LETRA_ORIGEM");
            // V8/F17 — música sem voz. A marca NUNCA é deduzida de "não tem
            // letra": ela existe justamente para separar as duas coisas.
            let instrumental = read_instrumental(t);
            (title, artist, album, lyrics, temas, letra_origem, instrumental)
        }
        None => (file_stem_title(path), None, None, None, None, None, false),
    };

    TagData {
        title,
        artist,
        album,
        duration_seconds: Some(duration),
        lyrics,
        temas,
        letra_origem,
        instrumental,
        fallback: false,
    }
}

/// Nomes das subpastas do arquivo relativos à pasta registrada, separados
/// por espaço (F12): /acervo/Barco/sub/x.mp3 com folder /acervo → "Barco
/// sub"; arquivo na raiz da pasta registrada → None. Só alimenta o índice de
/// busca (coluna songs.pastas na FTS) — a Song não expõe o valor.
fn pastas_for(folder_path: &str, file_path: &Path) -> Option<String> {
    let rel = file_path.parent()?.strip_prefix(folder_path).ok()?;
    let parts: Vec<String> = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(" "))
    }
}

/// Upsert de uma música por file_path (INSERT ... ON CONFLICT preserva o id —
/// e portanto os itens de playlist que apontam para ela).
fn upsert_song(
    conn: &Connection,
    folder_id: i64,
    path_str: &str,
    tags: &TagData,
    pastas: Option<&str>,
    mtime: i64,
    size: i64,
) -> Result<()> {
    let has_lyrics = tags.lyrics.is_some();
    conn.execute(
        "INSERT INTO songs
            (file_path, folder_id, title, artist, album, duration_seconds,
             has_lyrics, lyrics, temas, letra_origem, instrumental, pastas,
             file_mtime, file_size, available, indexed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 1, datetime('now'))
         ON CONFLICT(file_path) DO UPDATE SET
            folder_id = excluded.folder_id,
            title = excluded.title,
            artist = excluded.artist,
            album = excluded.album,
            duration_seconds = excluded.duration_seconds,
            has_lyrics = excluded.has_lyrics,
            lyrics = excluded.lyrics,
            temas = excluded.temas,
            letra_origem = excluded.letra_origem,
            instrumental = excluded.instrumental,
            pastas = excluded.pastas,
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
            tags.temas,
            tags.letra_origem,
            tags.instrumental as i64,
            pastas,
            mtime,
            size
        ],
    )?;
    Ok(())
}

/// Reindexa um único arquivo (F10): re-stata mtime/size, relê as tags e faz
/// upsert — usado pelo writer logo após gravar tags, para o banco (e a FTS,
/// via triggers) refletirem o disco sem esperar um rescan. As pastas (F12)
/// são derivadas do caminho da pasta registrada, lido do banco.
pub(crate) fn index_single_file(conn: &Connection, folder_id: i64, path: &Path) -> Result<()> {
    let folder_path: String = conn
        .query_row(
            "SELECT path FROM folders WHERE id = ?1",
            params![folder_id],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(|| AppError(format!("pasta não registrada: {folder_id}")))?;
    let md = std::fs::metadata(path)?;
    let mtime = file_mtime_epoch(&md);
    let size = md.len() as i64;
    let tags = read_tags(path);
    let pastas = pastas_for(&folder_path, path);
    upsert_song(
        conn,
        folder_id,
        &path.to_string_lossy(),
        &tags,
        pastas.as_deref(),
        mtime,
        size,
    )
}

fn file_mtime_epoch(md: &std::fs::Metadata) -> i64 {
    // Milissegundos: resolução de segundos deixaria passar um arquivo editado
    // no mesmo segundo da indexação (com o mesmo tamanho).
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
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
        let pastas = pastas_for(&folder_path, path);
        upsert_song(conn, folder_id, &path_str, &tags, pastas.as_deref(), mtime, size)?;
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

    // Pré-conta os MP3s de todas as pastas existentes para que o progresso
    // reportado seja global ("n de total"), não reiniciando a cada pasta.
    let mut grand_total = 0usize;
    let mut existing: Vec<&db::Folder> = Vec::new();
    for folder in &folders {
        if Path::new(&folder.path).is_dir() {
            grand_total += count_mp3s(&folder.path);
            existing.push(folder);
        }
    }

    let mut base = 0usize;
    for folder in &folders {
        if !Path::new(&folder.path).is_dir() {
            conn.execute(
                "UPDATE songs SET available = 0 WHERE folder_id = ?1",
                params![folder.id],
            )?;
            outcome.missing_folders.push(folder.path.clone());
            continue;
        }
        let stats = scan_folder(conn, folder.id, |done, _local_total| {
            progress(base + done, grand_total);
        })?;
        base += stats.total;
        outcome.stats.indexed += stats.indexed;
        outcome.stats.skipped += stats.skipped;
        outcome.stats.removed += stats.removed;
        outcome.stats.tag_errors += stats.tag_errors;
        outcome.stats.total += stats.total;
    }

    Ok(outcome)
}

fn count_mp3s(folder_path: &str) -> usize {
    WalkDir::new(folder_path)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file() && is_mp3(e.path()))
        .count()
}

#[cfg(test)]
mod tests {
    use super::pastas_for;
    use std::path::Path;

    #[test]
    fn pastas_for_derives_relative_subfolder_names() {
        // subpastas relativas à pasta registrada, separadas por espaço
        assert_eq!(
            pastas_for("/acervo", Path::new("/acervo/Barco/sub/x.mp3")).as_deref(),
            Some("Barco sub")
        );
        assert_eq!(
            pastas_for("/acervo", Path::new("/acervo/Canções/y.mp3")).as_deref(),
            Some("Canções")
        );
        // arquivo na raiz da pasta registrada: sem pasta
        assert_eq!(pastas_for("/acervo", Path::new("/acervo/x.mp3")), None);
        // caminho fora da pasta registrada (defensivo): sem pasta
        assert_eq!(pastas_for("/acervo", Path::new("/outro/x.mp3")), None);
    }
}
