//! Testes de integração da Fase 1 (F1 — indexer + banco) e F6 (round-trip).
//! Cobrem os Acceptance Checks do PRD contra SQLite em tempdir e fixtures MP3 reais.

use cancioneiro_lib::db;
use cancioneiro_lib::indexer;
use rusqlite::Connection;
use std::fs;
use std::path::{Path, PathBuf};

fn fixtures_dir() -> PathBuf {
    // src-tauri/tests -> repo root/fixtures
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("fixtures")
}

fn test_conn() -> Connection {
    let conn = db::open_in_memory().expect("open in-memory db");
    conn
}

/// Copia as 3 fixtures MP3 válidas + a corrompida para um tempdir.
fn setup_music_dir(include_corrupt: bool) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let src = fixtures_dir();
    for name in ["com_letra.mp3", "sem_letra.mp3", "sem_tags.mp3"] {
        fs::copy(src.join(name), dir.path().join(name)).unwrap();
    }
    if include_corrupt {
        fs::copy(src.join("corrompido.mp3"), dir.path().join("corrompido.mp3")).unwrap();
    }
    dir
}

/// Caminho canônico do tempdir — add_folder canonicaliza, então os file_path
/// gravados derivam desta forma do caminho.
fn canon(dir: &tempfile::TempDir) -> PathBuf {
    dir.path().canonicalize().unwrap()
}

// ---------------------------------------------------------------------------
// F1 — Acceptance: adicionar pasta com 3 MP3s fixture => 3 registros em songs
// ---------------------------------------------------------------------------
#[test]
fn add_folder_indexes_three_fixtures_with_correct_paths() {
    let dir = setup_music_dir(false);
    let conn = test_conn();

    let folder_id = db::add_folder(&conn, dir.path().to_str().unwrap()).unwrap();
    indexer::scan_folder(&conn, folder_id, |_done, _total| {}).unwrap();

    let songs = db::list_songs(&conn).unwrap();
    assert_eq!(songs.len(), 3);
    for name in ["com_letra.mp3", "sem_letra.mp3", "sem_tags.mp3"] {
        let expected = canon(&dir).join(name);
        assert!(
            songs.iter().any(|s| s.file_path == expected.to_str().unwrap()),
            "esperava song com file_path {:?}",
            expected
        );
    }
}

// ---------------------------------------------------------------------------
// F1 + F6 — Acceptance (round-trip): USLT gravado pelo script Python é lido
// pelo indexer Rust com texto idêntico (acentos e \n preservados).
// ---------------------------------------------------------------------------
#[test]
fn roundtrip_uslt_from_python_script_is_read_exactly() {
    let expected_lyrics = "Quando o sol amanhecer\nMeu coração vai cantar\nA esperança vai nascer\nE a alegria vai chegar\n\nNão há noite sem estrela\nNão há dor que não se cura";

    let dir = setup_music_dir(false);
    let conn = test_conn();
    let folder_id = db::add_folder(&conn, dir.path().to_str().unwrap()).unwrap();
    indexer::scan_folder(&conn, folder_id, |_, _| {}).unwrap();

    let songs = db::list_songs(&conn).unwrap();
    let song = songs
        .iter()
        .find(|s| s.file_path.ends_with("com_letra.mp3"))
        .expect("com_letra.mp3 indexada");

    assert!(song.has_lyrics, "has_lyrics deve ser true");
    assert_eq!(song.title, "Coração Sertanejo");
    assert_eq!(song.artist.as_deref(), Some("Artista Teste"));

    let lyrics = db::get_lyrics(&conn, song.id).unwrap();
    assert_eq!(lyrics.as_deref(), Some(expected_lyrics));
}

// ---------------------------------------------------------------------------
// F1 — Acceptance: MP3 sem tags => title = nome do arquivo sem extensão,
// has_lyrics = false.
// ---------------------------------------------------------------------------
#[test]
fn mp3_without_tags_falls_back_to_filename_title() {
    let dir = setup_music_dir(false);
    let conn = test_conn();
    let folder_id = db::add_folder(&conn, dir.path().to_str().unwrap()).unwrap();
    indexer::scan_folder(&conn, folder_id, |_, _| {}).unwrap();

    let songs = db::list_songs(&conn).unwrap();
    let song = songs
        .iter()
        .find(|s| s.file_path.ends_with("sem_tags.mp3"))
        .expect("sem_tags.mp3 indexada");

    assert_eq!(song.title, "sem_tags");
    assert!(!song.has_lyrics);
    let lyrics = db::get_lyrics(&conn, song.id).unwrap();
    assert!(lyrics.is_none() || lyrics.as_deref() == Some(""));
}

// ---------------------------------------------------------------------------
// F1 — Acceptance: segundo rescan sem mudanças não altera indexed_at (skip
// incremental por mtime+size).
// ---------------------------------------------------------------------------
#[test]
fn rescan_without_changes_skips_all_files() {
    let dir = setup_music_dir(false);
    let conn = test_conn();
    let folder_id = db::add_folder(&conn, dir.path().to_str().unwrap()).unwrap();
    indexer::scan_folder(&conn, folder_id, |_, _| {}).unwrap();

    let before: Vec<(i64, String)> = {
        let mut stmt = conn
            .prepare("SELECT id, indexed_at FROM songs ORDER BY id")
            .unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    };

    // indexed_at tem resolução de segundos: força diferença detectável
    std::thread::sleep(std::time::Duration::from_millis(1100));
    let stats = indexer::scan_folder(&conn, folder_id, |_, _| {}).unwrap();
    assert_eq!(stats.indexed, 0, "nenhum arquivo deveria ser relido");
    assert_eq!(stats.skipped, 3);

    let after: Vec<(i64, String)> = {
        let mut stmt = conn
            .prepare("SELECT id, indexed_at FROM songs ORDER BY id")
            .unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    };
    assert_eq!(before, after, "indexed_at não deve mudar em rescan sem mudanças");
}

// ---------------------------------------------------------------------------
// F1 — Acceptance: alterar mtime de 1 arquivo e reindexar atualiza somente
// essa Song.
// ---------------------------------------------------------------------------
#[test]
fn rescan_updates_only_changed_file() {
    let dir = setup_music_dir(false);
    let conn = test_conn();
    let folder_id = db::add_folder(&conn, dir.path().to_str().unwrap()).unwrap();
    indexer::scan_folder(&conn, folder_id, |_, _| {}).unwrap();

    let before: Vec<(String, String)> = {
        let mut stmt = conn
            .prepare("SELECT file_path, indexed_at FROM songs ORDER BY file_path")
            .unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    };

    std::thread::sleep(std::time::Duration::from_millis(1100));

    // Toca o mtime de um arquivo (conteúdo idêntico, mtime novo)
    let target = dir.path().join("sem_letra.mp3");
    let content = fs::read(&target).unwrap();
    fs::write(&target, &content).unwrap();

    let stats = indexer::scan_folder(&conn, folder_id, |_, _| {}).unwrap();
    assert_eq!(stats.indexed, 1, "somente o arquivo tocado deve ser relido");
    assert_eq!(stats.skipped, 2);

    // Confirma no banco: só o indexed_at do arquivo tocado mudou.
    let after: Vec<(String, String)> = {
        let mut stmt = conn
            .prepare("SELECT file_path, indexed_at FROM songs ORDER BY file_path")
            .unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    };
    for (path, indexed_at) in &after {
        let (_, before_at) = before
            .iter()
            .find(|(p, _)| p == path)
            .expect("mesmos arquivos antes e depois");
        if path.ends_with("sem_letra.mp3") {
            assert_ne!(indexed_at, before_at, "arquivo tocado deve ser reindexado");
        } else {
            assert_eq!(indexed_at, before_at, "demais arquivos intocados: {path}");
        }
    }
}

// ---------------------------------------------------------------------------
// F1 — Acceptance: remover pasta apaga Songs e PlaylistItems em cascata.
// ---------------------------------------------------------------------------
#[test]
fn remove_folder_cascades_to_songs_and_playlist_items() {
    let dir = setup_music_dir(false);
    let conn = test_conn();
    let folder_id = db::add_folder(&conn, dir.path().to_str().unwrap()).unwrap();
    indexer::scan_folder(&conn, folder_id, |_, _| {}).unwrap();

    let songs = db::list_songs(&conn).unwrap();
    assert_eq!(songs.len(), 3);

    let playlist_id = db::create_playlist(&conn, "Reunião").unwrap();
    for s in &songs {
        db::add_song_to_playlist(&conn, playlist_id, s.id).unwrap();
    }
    let items = db::get_playlist_items(&conn, playlist_id).unwrap();
    assert_eq!(items.len(), 3);

    db::remove_folder(&conn, folder_id).unwrap();

    assert_eq!(db::list_songs(&conn).unwrap().len(), 0);
    assert_eq!(db::get_playlist_items(&conn, playlist_id).unwrap().len(), 0);
    // FTS também deve esvaziar (via triggers)
    let fts_count: i64 = conn
        .query_row("SELECT count(*) FROM songs_fts", [], |r| r.get(0))
        .unwrap();
    assert_eq!(fts_count, 0);
}

// ---------------------------------------------------------------------------
// F1 — Acceptance: varredura com .mp3 corrompido completa sem erro fatal e
// indexa os demais (corrompido entra com fallback de título, sem letra).
// ---------------------------------------------------------------------------
#[test]
fn scan_with_corrupt_mp3_does_not_abort() {
    let dir = setup_music_dir(true);
    let conn = test_conn();
    let folder_id = db::add_folder(&conn, dir.path().to_str().unwrap()).unwrap();

    let result = indexer::scan_folder(&conn, folder_id, |_, _| {});
    assert!(result.is_ok(), "scan não pode abortar por arquivo corrompido");

    let songs = db::list_songs(&conn).unwrap();
    // Os 3 válidos indexados normalmente; o corrompido entra com fallback
    // (título = nome do arquivo) — nunca aborta a varredura.
    assert_eq!(songs.len(), 4);
    for name in ["com_letra.mp3", "sem_letra.mp3", "sem_tags.mp3"] {
        assert!(
            songs.iter().any(|s| s.file_path.ends_with(name)),
            "válido {name} deve estar indexado"
        );
    }
    assert!(songs.iter().any(|s| s.title == "Coração Sertanejo"));
    let corrupt = songs
        .iter()
        .find(|s| s.file_path.ends_with("corrompido.mp3"))
        .expect("corrompido indexado com fallback");
    assert_eq!(corrupt.title, "corrompido");
    assert!(!corrupt.has_lyrics);
}

// ---------------------------------------------------------------------------
// F1 — varredura é recursiva e extensão é case-insensitive (.MP3).
// ---------------------------------------------------------------------------
#[test]
fn scan_is_recursive_and_extension_case_insensitive() {
    let dir = setup_music_dir(false);
    let sub = dir.path().join("subpasta/aninhada");
    fs::create_dir_all(&sub).unwrap();
    fs::rename(
        dir.path().join("sem_letra.mp3"),
        sub.join("MAIUSCULA.MP3"),
    )
    .unwrap();

    let conn = test_conn();
    let folder_id = db::add_folder(&conn, dir.path().to_str().unwrap()).unwrap();
    indexer::scan_folder(&conn, folder_id, |_, _| {}).unwrap();

    let songs = db::list_songs(&conn).unwrap();
    assert_eq!(songs.len(), 3);
    let nested = songs
        .iter()
        .find(|s| s.file_path.ends_with("MAIUSCULA.MP3"))
        .expect(".MP3 em subpasta deve ser indexado");
    assert!(nested.file_path.contains("subpasta/aninhada") || nested.file_path.contains("subpasta\\aninhada"));
}

// ---------------------------------------------------------------------------
// F1 — pastas sobrepostas são rejeitadas (evita perda de playlists via
// cascade quando o mesmo arquivo pertenceria a duas pastas); mesma pasta
// re-adicionada devolve o id existente.
// ---------------------------------------------------------------------------
#[test]
fn overlapping_folders_are_rejected_and_readd_is_idempotent() {
    let dir = setup_music_dir(false);
    let sub = dir.path().join("interna");
    fs::create_dir_all(&sub).unwrap();

    let conn = test_conn();
    let id1 = db::add_folder(&conn, dir.path().to_str().unwrap()).unwrap();

    // subpasta de uma pasta registrada → erro
    assert!(db::add_folder(&conn, sub.to_str().unwrap()).is_err());

    // re-adicionar a mesma pasta → mesmo id, sem duplicar
    let id_again = db::add_folder(&conn, dir.path().to_str().unwrap()).unwrap();
    assert_eq!(id1, id_again);
    assert_eq!(db::list_folders(&conn).unwrap().len(), 1);

    // pasta-mãe de uma pasta registrada → erro
    let outer = tempfile::tempdir().unwrap();
    let inner = outer.path().join("musicas");
    fs::create_dir_all(&inner).unwrap();
    let conn2 = test_conn();
    db::add_folder(&conn2, inner.to_str().unwrap()).unwrap();
    assert!(db::add_folder(&conn2, outer.path().to_str().unwrap()).is_err());
}

// ---------------------------------------------------------------------------
// F1 — Erro documentado: pasta inexistente.
// ---------------------------------------------------------------------------
#[test]
fn add_nonexistent_folder_returns_error() {
    let conn = test_conn();
    let result = db::add_folder(&conn, "/caminho/que/nao/existe/xyz123");
    assert!(result.is_err());
}

#[test]
fn scan_missing_folder_marks_songs_unavailable_without_deleting() {
    let dir = setup_music_dir(false);
    let conn = test_conn();
    let folder_id = db::add_folder(&conn, dir.path().to_str().unwrap()).unwrap();
    indexer::scan_folder(&conn, folder_id, |_, _| {}).unwrap();
    assert_eq!(db::list_songs(&conn).unwrap().len(), 3);

    let path = canon(&dir);
    drop(dir); // remove a pasta do disco

    let outcome = indexer::scan_all(&conn, |_, _| {}).unwrap();
    assert!(
        outcome.missing_folders.iter().any(|p| p == path.to_str().unwrap()),
        "pasta sumida deve ser reportada"
    );

    let songs = db::list_songs(&conn).unwrap();
    assert_eq!(songs.len(), 3, "músicas não são deletadas quando a pasta some");
    assert!(songs.iter().all(|s| !s.available), "todas marcadas indisponíveis");
}

// ---------------------------------------------------------------------------
// F1 — arquivo individual removido do disco some do índice no rescan
// (pasta ainda existe).
// ---------------------------------------------------------------------------
#[test]
fn rescan_removes_deleted_file_from_index() {
    let dir = setup_music_dir(false);
    let conn = test_conn();
    let folder_id = db::add_folder(&conn, dir.path().to_str().unwrap()).unwrap();
    indexer::scan_folder(&conn, folder_id, |_, _| {}).unwrap();
    assert_eq!(db::list_songs(&conn).unwrap().len(), 3);

    fs::remove_file(dir.path().join("sem_tags.mp3")).unwrap();
    indexer::scan_folder(&conn, folder_id, |_, _| {}).unwrap();

    let songs = db::list_songs(&conn).unwrap();
    assert_eq!(songs.len(), 2);
    assert!(!songs.iter().any(|s| s.file_path.ends_with("sem_tags.mp3")));
}

// ---------------------------------------------------------------------------
// Progresso: callback recebe (done, total) coerentes.
// ---------------------------------------------------------------------------
#[test]
fn scan_reports_progress() {
    let dir = setup_music_dir(false);
    let conn = test_conn();
    let folder_id = db::add_folder(&conn, dir.path().to_str().unwrap()).unwrap();

    let progress = std::cell::RefCell::new(Vec::new());
    indexer::scan_folder(&conn, folder_id, |done, total| {
        progress.borrow_mut().push((done, total));
    })
    .unwrap();

    let p = progress.borrow();
    assert!(!p.is_empty());
    assert_eq!(p.last().unwrap(), &(3, 3));
}

// ---------------------------------------------------------------------------
// Seção 8 do PRD: nenhum arquivo de áudio é modificado pelo app — bytes dos
// MP3s idênticos antes/depois de todos os fluxos de backend (indexar,
// reindexar, buscar, ler letra, playlists, rescan).
// ---------------------------------------------------------------------------
#[test]
fn backend_flows_never_modify_audio_files() {
    use cancioneiro_lib::search;

    let dir = setup_music_dir(true);
    let names = ["com_letra.mp3", "sem_letra.mp3", "sem_tags.mp3", "corrompido.mp3"];
    let before: Vec<Vec<u8>> = names
        .iter()
        .map(|n| fs::read(dir.path().join(n)).unwrap())
        .collect();
    let mtimes_before: Vec<_> = names
        .iter()
        .map(|n| fs::metadata(dir.path().join(n)).unwrap().modified().unwrap())
        .collect();

    let conn = test_conn();
    let folder_id = db::add_folder(&conn, dir.path().to_str().unwrap()).unwrap();
    indexer::scan_folder(&conn, folder_id, |_, _| {}).unwrap();
    indexer::scan_all(&conn, |_, _| {}).unwrap();
    search::search(&conn, "coração", 50).unwrap();
    search::search(&conn, "\"*especial", 50).unwrap();

    let songs = db::list_songs(&conn).unwrap();
    for s in &songs {
        db::get_lyrics(&conn, s.id).unwrap();
    }
    let pid = db::create_playlist(&conn, "Fluxo").unwrap();
    for s in &songs {
        db::add_song_to_playlist(&conn, pid, s.id).unwrap();
    }
    let items = db::get_playlist_items(&conn, pid).unwrap();
    let reversed: Vec<i64> = items.iter().rev().map(|i| i.id).collect();
    db::reorder_playlist(&conn, pid, &reversed).unwrap();
    db::remove_playlist_item(&conn, items[0].id).unwrap();
    db::delete_playlist(&conn, pid).unwrap();
    indexer::scan_all(&conn, |_, _| {}).unwrap();

    for (i, name) in names.iter().enumerate() {
        let after = fs::read(dir.path().join(name)).unwrap();
        assert_eq!(before[i], after, "bytes de {name} não podem mudar");
        let mtime_after = fs::metadata(dir.path().join(name))
            .unwrap()
            .modified()
            .unwrap();
        assert_eq!(mtimes_before[i], mtime_after, "mtime de {name} não pode mudar");
    }
}

// ---------------------------------------------------------------------------
// Duração extraída (fixtures têm 1.5–5.5s).
// ---------------------------------------------------------------------------
#[test]
fn duration_is_extracted_for_valid_fixtures() {
    let dir = setup_music_dir(false);
    let conn = test_conn();
    let folder_id = db::add_folder(&conn, dir.path().to_str().unwrap()).unwrap();
    indexer::scan_folder(&conn, folder_id, |_, _| {}).unwrap();

    let songs = db::list_songs(&conn).unwrap();
    let com_letra = songs
        .iter()
        .find(|s| s.file_path.ends_with("com_letra.mp3"))
        .unwrap();
    let d = com_letra.duration_seconds.expect("duração extraída");
    assert!((1..=6).contains(&d), "duração fora do esperado: {d}");
}
