//! Testes de integração da F10 (PRD V4) — write_tags: gravação de tags ID3
//! no MP3 via lofty com round-trip pelo indexer, sem tocar no áudio nem no
//! nome do arquivo. Fixtures MP3 reais copiadas para tempdir.

use cancioneiro_lib::{db, indexer, search, writer};
use rusqlite::Connection;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("fixtures")
}

/// Copia fixtures para um tempdir, registra a pasta e indexa. Devolve
/// (tempdir, conn, folder_id).
fn setup() -> (tempfile::TempDir, Connection, i64) {
    let dir = tempfile::tempdir().unwrap();
    let src = fixtures_dir();
    for name in ["com_letra.mp3", "sem_letra.mp3", "sem_tags.mp3"] {
        fs::copy(src.join(name), dir.path().join(name)).unwrap();
    }
    let conn = db::open_in_memory().unwrap();
    let folder_id = db::add_folder(&conn, dir.path().to_str().unwrap()).unwrap();
    indexer::scan_folder(&conn, folder_id, |_, _| {}).unwrap();
    (dir, conn, folder_id)
}

fn song_by_suffix(conn: &Connection, suffix: &str) -> db::Song {
    db::list_songs(conn)
        .unwrap()
        .into_iter()
        .find(|s| s.file_path.ends_with(suffix))
        .unwrap_or_else(|| panic!("{suffix} deveria estar indexada"))
}

fn audio_duration(path: &Path) -> Duration {
    use lofty::file::AudioFile;
    lofty::read_from_path(path)
        .expect("arquivo deve continuar parseável")
        .properties()
        .duration()
}

// ---------------------------------------------------------------------------
// F10 — Acceptance (round-trip): write_tags grava e o indexer relê
// título/artista/letra/temas idênticos (acentos e \n preservados); o arquivo
// NÃO é renomeado; o áudio não muda de duração e continua parseável.
// ---------------------------------------------------------------------------
#[test]
fn write_tags_roundtrip_via_indexer_preserving_audio_and_filename() {
    let (dir, conn, folder_id) = setup();
    let song = song_by_suffix(&conn, "com_letra.mp3");
    let path = PathBuf::from(&song.file_path);
    let duration_before = audio_duration(&path);

    let lyrics = "Primeira linha com coração\nSegunda linha: ação e reação\n\nEstrofe após linha em branco";
    let updated = writer::write_tags(
        &conn,
        song.id,
        "  Canção Renovada  ", // trim aplicado no título gravado
        Some("São João Batista"),
        Some(lyrics),
        Some("Água, CURA; esperança, agua"),
    )
    .unwrap();

    // Song devolvida já atualizada (mesmo id — upsert, nunca re-cria)
    assert_eq!(updated.id, song.id);
    assert_eq!(updated.title, "Canção Renovada");
    assert_eq!(updated.artist.as_deref(), Some("São João Batista"));
    assert!(updated.has_lyrics);
    // normalização igual à do Python: minúsculas, dedup sem acento, ordem
    // alfabética por chave sem acento
    assert_eq!(updated.temas.as_deref(), Some("água; cura; esperança"));
    assert_eq!(db::get_lyrics(&conn, song.id).unwrap().as_deref(), Some(lyrics));

    // nunca renomeia: os mesmos 3 arquivos, nomes intactos
    let mut names: Vec<String> = fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    assert_eq!(names, vec!["com_letra.mp3", "sem_letra.mp3", "sem_tags.mp3"]);

    // áudio intacto: duração idêntica e arquivo ainda parseável
    assert_eq!(audio_duration(&path), duration_before);

    // round-trip completo: um novo scan (relê o arquivo do zero via read_tags
    // do indexer) devolve exatamente o que foi gravado
    let stats = indexer::scan_folder(&conn, folder_id, |_, _| {}).unwrap();
    assert_eq!(stats.removed, 0, "arquivo não pode sumir do índice");
    let reread = song_by_suffix(&conn, "com_letra.mp3");
    assert_eq!(reread.title, "Canção Renovada");
    assert_eq!(reread.artist.as_deref(), Some("São João Batista"));
    assert_eq!(reread.temas.as_deref(), Some("água; cura; esperança"));
    assert_eq!(db::get_lyrics(&conn, reread.id).unwrap().as_deref(), Some(lyrics));
}

// ---------------------------------------------------------------------------
// F10 — write_tags re-stata mtime/size: o rescan seguinte NÃO relê o arquivo
// (o banco já está em sincronia com o disco).
// ---------------------------------------------------------------------------
#[test]
fn write_tags_leaves_index_in_sync_so_rescan_skips() {
    let (_dir, conn, folder_id) = setup();
    let song = song_by_suffix(&conn, "com_letra.mp3");

    writer::write_tags(&conn, song.id, "Novo Título", None, None, None).unwrap();

    let stats = indexer::scan_folder(&conn, folder_id, |_, _| {}).unwrap();
    assert_eq!(stats.indexed, 0, "mtime/size upsertados devem casar com o disco");
    assert_eq!(stats.skipped, 3);
}

// ---------------------------------------------------------------------------
// F10 — Acceptance: salvar com título vazio é bloqueado; nada é gravado.
// ---------------------------------------------------------------------------
#[test]
fn write_tags_rejects_empty_title_without_touching_file() {
    let (_dir, conn, _folder_id) = setup();
    let song = song_by_suffix(&conn, "com_letra.mp3");
    let bytes_before = fs::read(&song.file_path).unwrap();

    for title in ["", "   ", "\n\t"] {
        let err = writer::write_tags(&conn, song.id, title, None, None, None)
            .expect_err("título vazio deve ser rejeitado");
        assert_eq!(err.to_string(), "título vazio");
    }

    assert_eq!(
        fs::read(&song.file_path).unwrap(),
        bytes_before,
        "arquivo não pode ser tocado quando o título é inválido"
    );
    // banco intacto
    assert_eq!(song_by_suffix(&conn, "com_letra.mp3").title, "Coração Sertanejo");
}

// ---------------------------------------------------------------------------
// F10 — música inexistente no banco e arquivo sumido do disco.
// ---------------------------------------------------------------------------
#[test]
fn write_tags_errors_for_unknown_song_and_missing_file() {
    let (dir, conn, _folder_id) = setup();

    assert!(writer::write_tags(&conn, 9999, "T", None, None, None).is_err());

    let song = song_by_suffix(&conn, "sem_letra.mp3");
    fs::remove_file(&song.file_path).unwrap();
    let err = writer::write_tags(&conn, song.id, "T", None, None, None)
        .expect_err("arquivo sumido deve falhar");
    // mensagem exata que o frontend usa para arquivo sumido
    assert_eq!(
        err.to_string(),
        format!("arquivo não encontrado: {}", song.file_path)
    );
    drop(dir);
}

// ---------------------------------------------------------------------------
// F10 — Acceptance: letra vazia remove USLT; temas vazios removem TXXX:TEMAS;
// artista vazio remove TPE1. None e string vazia se comportam igual.
// ---------------------------------------------------------------------------
#[test]
fn write_tags_none_or_empty_removes_artist_lyrics_and_temas() {
    let (_dir, conn, folder_id) = setup();
    let song = song_by_suffix(&conn, "com_letra.mp3");
    assert!(song.has_lyrics && song.artist.is_some() && song.temas.is_some());

    // string vazia / espaços removem
    let updated = writer::write_tags(
        &conn,
        song.id,
        "Só Título",
        Some("  "),
        Some(""),
        Some(" ; , "),
    )
    .unwrap();
    assert_eq!(updated.title, "Só Título");
    assert_eq!(updated.artist, None);
    assert!(!updated.has_lyrics);
    assert_eq!(updated.temas, None);
    assert_eq!(db::get_lyrics(&conn, song.id).unwrap(), None);

    // regrava com tudo e depois remove com None
    writer::write_tags(&conn, song.id, "Cheio", Some("A"), Some("letra"), Some("tema")).unwrap();
    let cleared = writer::write_tags(&conn, song.id, "Cheio", None, None, None).unwrap();
    assert_eq!(cleared.artist, None);
    assert!(!cleared.has_lyrics);
    assert_eq!(cleared.temas, None);

    // releitura do disco confirma que os frames realmente saíram do MP3
    indexer::scan_folder(&conn, folder_id, |_, _| {}).unwrap();
    let reread = song_by_suffix(&conn, "com_letra.mp3");
    assert_eq!(reread.artist, None);
    assert!(!reread.has_lyrics);
    assert_eq!(reread.temas, None);
}

// ---------------------------------------------------------------------------
// F10 — Acceptance: após salvar, buscar por trecho da letra nova encontra a
// música (FTS atualizado) sem reiniciar o app; a letra antiga sai do índice.
// ---------------------------------------------------------------------------
#[test]
fn write_tags_updates_fts_immediately() {
    let (_dir, conn, _folder_id) = setup();
    let song = song_by_suffix(&conn, "com_letra.mp3");

    // antes: letra antiga tem "esperança" (e o termo novo não existe)
    assert_eq!(search::search(&conn, "zimbabue", 50).unwrap().len(), 0);

    writer::write_tags(
        &conn,
        song.id,
        &song.title,
        song.artist.as_deref(),
        Some("Uma letra nova que fala de Zimbabué e outras terras"),
        Some("missões"),
    )
    .unwrap();

    let hits = search::search(&conn, "zimbabue", 50).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].song.id, song.id);
    // busca por tema novo também encontra
    let hits = search::search(&conn, "missoes", 50).unwrap();
    assert_eq!(hits.len(), 1);
    // trecho da letra antiga não encontra mais esta música pela letra
    let old = search::search(&conn, "amanhecer", 50).unwrap();
    assert!(old.iter().all(|r| r.song.id != song.id));
}

// ---------------------------------------------------------------------------
// V5 (F12) — write_tags (via index_single_file) preserva/preenche a coluna
// pastas de arquivo em subpasta: a busca por nome de pasta continua achando
// a música logo após a edição, sem esperar rescan.
// ---------------------------------------------------------------------------
#[test]
fn write_tags_preserves_pastas_for_file_in_subfolder() {
    use rusqlite::params;

    let dir = tempfile::tempdir().unwrap();
    let sub = dir.path().join("Barco");
    fs::create_dir_all(&sub).unwrap();
    fs::copy(fixtures_dir().join("com_letra.mp3"), sub.join("com_letra.mp3")).unwrap();

    let conn = db::open_in_memory().unwrap();
    let folder_id = db::add_folder(&conn, dir.path().to_str().unwrap()).unwrap();
    indexer::scan_folder(&conn, folder_id, |_, _| {}).unwrap();
    let song = song_by_suffix(&conn, "com_letra.mp3");

    writer::write_tags(&conn, song.id, "Título Editado", None, Some("letra nova"), None)
        .unwrap();

    let pastas: Option<String> = conn
        .query_row(
            "SELECT pastas FROM songs WHERE id = ?1",
            params![song.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(pastas.as_deref(), Some("Barco"));

    // FTS em sincronia: busca por pasta acha imediatamente após a edição
    let results = search::search(&conn, "barco", 50).unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].song.id, song.id);
    assert!(results[0].snippet.is_none());
}

// ---------------------------------------------------------------------------
// F10 — MP3 sem nenhuma tag ID3 ganha uma tag nova (não falha) e o
// round-trip lê de volta idêntico, com acentos.
// ---------------------------------------------------------------------------
#[test]
fn write_tags_creates_id3_tag_on_untagged_file() {
    let (_dir, conn, folder_id) = setup();
    let song = song_by_suffix(&conn, "sem_tags.mp3");
    let path = PathBuf::from(&song.file_path);
    let duration_before = audio_duration(&path);

    let updated = writer::write_tags(
        &conn,
        song.id,
        "Título Novo",
        Some("Artista Ção"),
        Some("Letra única\ncom acentuação"),
        Some("João; João, joao"),
    )
    .unwrap();
    assert_eq!(updated.title, "Título Novo");
    assert_eq!(updated.artist.as_deref(), Some("Artista Ção"));
    assert_eq!(updated.temas.as_deref(), Some("joão"));
    assert_eq!(audio_duration(&path), duration_before);

    indexer::scan_folder(&conn, folder_id, |_, _| {}).unwrap();
    let reread = song_by_suffix(&conn, "sem_tags.mp3");
    assert_eq!(reread.title, "Título Novo");
    assert_eq!(
        db::get_lyrics(&conn, reread.id).unwrap().as_deref(),
        Some("Letra única\ncom acentuação")
    );
}
