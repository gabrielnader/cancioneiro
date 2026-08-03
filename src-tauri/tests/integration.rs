//! Testes de integração da Fase 1 (F1 — indexer + banco) e F6 (round-trip).
//! Cobrem os Acceptance Checks do PRD contra SQLite em tempdir e fixtures MP3 reais.

use cancioneiro_lib::db;
use cancioneiro_lib::indexer;
use rusqlite::Connection;
use std::fs;
use std::path::{Path, PathBuf};

mod common;
use common::{copy_fixture, fixtures_dir};

fn test_conn() -> Connection {
    let conn = db::open_in_memory().expect("open in-memory db");
    conn
}

/// Copia as 3 fixtures MP3 válidas + a corrompida para um tempdir.
fn setup_music_dir(include_corrupt: bool) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    for name in ["com_letra.mp3", "sem_letra.mp3", "sem_tags.mp3"] {
        copy_fixture(name, &dir.path().join(name));
    }
    if include_corrupt {
        copy_fixture("corrompido.mp3", &dir.path().join("corrompido.mp3"));
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
/// V14 — o tema casa EXATO, e não por pedaço.
///
/// "Natal" não pode arrastar "Natalino" nem "Pré-Natal": montar playlist por
/// tema acrescenta em lote, e um lote errado é trabalho manual de desfazer.
fn songs_by_tema_casa_exato_e_nao_por_pedaco() {
    let dir = setup_music_dir(false);
    let conn = test_conn();
    let folder_id = db::add_folder(&conn, dir.path().to_str().unwrap()).unwrap();
    indexer::scan_folder(&conn, folder_id, |_, _| {}).unwrap();
    let songs = db::list_songs(&conn).unwrap();

    let temas = ["Natal; Louvor", "Natalino", "natal"];
    for (s, t) in songs.iter().zip(temas) {
        conn.execute(
            "UPDATE songs SET temas = ?2 WHERE id = ?1",
            rusqlite::params![s.id, t],
        )
        .unwrap();
    }

    let achadas = db::songs_by_tema(&conn, "Natal").unwrap();
    assert_eq!(
        achadas.len(),
        2,
        "só as duas com o tema Natal (uma delas em minúsculas): {:?}",
        achadas.iter().map(|s| &s.temas).collect::<Vec<_>>()
    );
    assert!(
        !achadas.iter().any(|s| s.temas.as_deref() == Some("Natalino")),
        "Natalino não é Natal"
    );

    // e a lista de temas conta cada um uma vez, com o número de músicas
    let lista = db::list_temas(&conn).unwrap();
    let natais: Vec<_> = lista
        .iter()
        .filter(|(t, _)| t.eq_ignore_ascii_case("natal"))
        .collect();
    assert_eq!(
        natais.len(),
        1,
        "\"Natal\" e \"natal\" são UM tema na lista: {lista:?}"
    );
    assert_eq!(natais[0].1, 2, "e a contagem soma as duas: {lista:?}");
}

#[test]
/// V13 — renomear a playlist, e a recusa do nome vazio.
///
/// A recusa mora no banco, e não só na tela: playlist sem nome vira uma linha
/// em branco na lateral, impossível de achar ou de apagar depois.
fn rename_playlist_troca_o_nome_e_recusa_vazio() {
    let conn = test_conn();
    let id = db::create_playlist(&conn, "Antigo").unwrap();

    db::rename_playlist(&conn, id, "  Reunião de sábado  ").unwrap();
    let nomes: Vec<String> = db::list_playlists(&conn)
        .unwrap()
        .into_iter()
        .map(|p| p.name)
        .collect();
    assert!(
        nomes.contains(&"Reunião de sábado".to_string()),
        "o nome novo entra sem os espaços das pontas: {nomes:?}"
    );

    for vazio in ["", "   "] {
        assert!(
            db::rename_playlist(&conn, id, vazio).is_err(),
            "nome vazio ({vazio:?}) tem de ser recusado"
        );
    }
    // e o nome anterior continua lá: a recusa não estraga o que existia
    let nomes: Vec<String> = db::list_playlists(&conn)
        .unwrap()
        .into_iter()
        .map(|p| p.name)
        .collect();
    assert!(nomes.contains(&"Reunião de sábado".to_string()));
}

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
// V2 (F8) — round-trip de temas: TXXX:TEMAS gravado pelo script Python é lido
// idêntico pelo indexer Rust; busca por tema sem acento encontra a música.
// ---------------------------------------------------------------------------
#[test]
fn roundtrip_temas_from_python_script_and_search_by_tema() {
    use cancioneiro_lib::search;

    let dir = setup_music_dir(false);
    let conn = test_conn();
    let folder_id = db::add_folder(&conn, dir.path().to_str().unwrap()).unwrap();
    indexer::scan_folder(&conn, folder_id, |_, _| {}).unwrap();

    let songs = db::list_songs(&conn).unwrap();
    let com_letra = songs
        .iter()
        .find(|s| s.file_path.ends_with("com_letra.mp3"))
        .unwrap();
    assert_eq!(com_letra.temas.as_deref(), Some("água; esperança"));

    // fixtures sem TXXX:TEMAS ficam sem temas
    let sem_letra = songs
        .iter()
        .find(|s| s.file_path.ends_with("sem_letra.mp3"))
        .unwrap();
    assert_eq!(sem_letra.temas, None);

    // busca por tema, sem acento
    let results = search::search(&conn, "agua", 50).unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].song.title, "Coração Sertanejo");
}

// ---------------------------------------------------------------------------
// V5/F14 — round-trip da marca de procedência: o `tools/curadoria.py
// transcrever` grava TXXX:LETRA_ORIGEM = "transcricao" no MP3 e o indexer lê
// esse frame igual aos demais TXXX. Arquivo sem a marca fica sem procedência
// (None) — nunca "oficial" por engano.
// ---------------------------------------------------------------------------
#[test]
fn scan_reads_letra_origem_marker_and_leaves_unmarked_files_absent() {
    use lofty::config::{ParseOptions, WriteOptions};
    use lofty::file::AudioFile;
    use lofty::tag::TagExt;

    let dir = setup_music_dir(false);

    // marca só a fixture com letra, como faria a ferramenta de curadoria
    let marcada = dir.path().join("com_letra.mp3");
    let mut tag = lofty::mpeg::MpegFile::read_from(
        &mut fs::File::open(&marcada).unwrap(),
        ParseOptions::new(),
    )
    .unwrap()
    .id3v2()
    .cloned()
    .unwrap_or_default();
    tag.insert_user_text("LETRA_ORIGEM".to_string(), "transcricao".to_string());
    tag.save_to_path(&marcada, WriteOptions::default()).unwrap();

    let conn = test_conn();
    let folder_id = db::add_folder(&conn, dir.path().to_str().unwrap()).unwrap();
    indexer::scan_folder(&conn, folder_id, |_, _| {}).unwrap();

    let songs = db::list_songs(&conn).unwrap();
    let com_letra = songs
        .iter()
        .find(|s| s.file_path.ends_with("com_letra.mp3"))
        .unwrap();
    assert_eq!(com_letra.letra_origem.as_deref(), Some("transcricao"));

    // fixtures sem o frame: procedência ausente
    for name in ["sem_letra.mp3", "sem_tags.mp3"] {
        let outra = songs.iter().find(|s| s.file_path.ends_with(name)).unwrap();
        assert_eq!(outra.letra_origem, None, "{name} não tem a marca");
    }
}

/// Grava TXXX:INSTRUMENTAL = `valor` no MP3, preservando os demais frames —
/// o jeito como uma ferramenta QUALQUER (não a nossa) deixaria a marca.
fn marcar_instrumental(path: &Path, valor: &str) {
    use lofty::config::{ParseOptions, WriteOptions};
    use lofty::file::AudioFile;
    use lofty::tag::TagExt;

    let mut tag =
        lofty::mpeg::MpegFile::read_from(&mut fs::File::open(path).unwrap(), ParseOptions::new())
            .unwrap()
            .id3v2()
            .cloned()
            .unwrap_or_default();
    tag.insert_user_text("INSTRUMENTAL".to_string(), valor.to_string());
    tag.save_to_path(path, WriteOptions::default()).unwrap();
}

// ---------------------------------------------------------------------------
// V8/F17 — round-trip da marca de instrumental: a curadoria grava
// TXXX:INSTRUMENTAL = "1" no MP3 e o indexer lê esse frame como os demais
// TXXX. Arquivo SEM o frame não é instrumental — o app nunca deduz isso de
// "não tem letra", e remover o frame é como as duas ferramentas do produto
// desmarcam (nenhuma delas escreve "0" em lugar nenhum).
// ---------------------------------------------------------------------------
#[test]
fn scan_reads_instrumental_marker_and_leaves_unmarked_files_absent() {
    let dir = setup_music_dir(false);
    // uma música sem voz, marcada pela curadoria
    marcar_instrumental(&dir.path().join("sem_letra.mp3"), "1");
    // e um "0" de OUTRO tagger: as nossas ferramentas desmarcam removendo o
    // frame, mas o arquivo passa por outras mãos e um "0" tem de ser lido
    // como "não é" — não como um valor desconhecido que vira marca.
    marcar_instrumental(&dir.path().join("sem_tags.mp3"), "0");

    let conn = test_conn();
    let folder_id = db::add_folder(&conn, dir.path().to_str().unwrap()).unwrap();
    indexer::scan_folder(&conn, folder_id, |_, _| {}).unwrap();

    let songs = db::list_songs(&conn).unwrap();
    let por_nome = |nome: &str| {
        songs
            .iter()
            .find(|s| s.file_path.ends_with(nome))
            .unwrap_or_else(|| panic!("{nome} deveria estar indexada"))
    };
    assert!(por_nome("sem_letra.mp3").instrumental, "marca lida do TXXX");
    assert!(
        !por_nome("sem_tags.mp3").instrumental,
        "\"0\" é valor falso, não marca"
    );
    // sem o frame: não é instrumental (mesmo tendo letra ou não)
    assert!(!por_nome("com_letra.mp3").instrumental);

    // rescan sem mudanças não perde a marca
    indexer::scan_folder(&conn, folder_id, |_, _| {}).unwrap();
    let songs = db::list_songs(&conn).unwrap();
    assert!(songs
        .iter()
        .find(|s| s.file_path.ends_with("sem_letra.mp3"))
        .unwrap()
        .instrumental);
}

// ---------------------------------------------------------------------------
// V8/F17 — o conjunto EXATO de valores que conta como marca. Não é preciosismo
// de parser: os dois stacks leem o mesmo arquivo, e uma divergência aqui faz o
// Python mandar para a fila de letra um arquivo que o app mostra como
// instrumental (ou o contrário). O critério da assimetria é o custo do erro:
// desrespeitar a marca devolve a peça sem voz à varredura e ela acaba
// recebendo a letra da versão cantada — por isso, na dúvida, é marca.
// ---------------------------------------------------------------------------
#[test]
fn instrumental_marker_recognizes_the_same_value_set_as_the_python_tool() {
    let dir = tempfile::tempdir().unwrap();
    let src = fixtures_dir().join("sem_letra.mp3");

    // (valor gravado no frame, é marca?)
    let casos: &[(&str, bool)] = &[
        ("1", true),
        ("true", true),
        ("sim", true),
        ("SIM", true),
        ("yes", true),
        ("0", false),
        ("false", false),
        ("FALSE", false),
        ("nao", false),
        ("não", false),
        ("NÃO", false),
        ("  1  ", true),  // espaço em volta não muda nada
        ("   ", false),   // frame em branco conta como ausente
    ];

    for (i, (valor, _)) in casos.iter().enumerate() {
        let dest = dir.path().join(format!("caso{i}.mp3"));
        fs::copy(&src, &dest).unwrap();
        marcar_instrumental(&dest, valor);
    }
    // e um arquivo SEM o frame: o estado normal, e o que sobra depois de
    // desmarcar em qualquer uma das duas ferramentas
    fs::copy(&src, dir.path().join("sem_frame.mp3")).unwrap();

    let conn = test_conn();
    let folder_id = db::add_folder(&conn, dir.path().to_str().unwrap()).unwrap();
    indexer::scan_folder(&conn, folder_id, |_, _| {}).unwrap();
    let songs = db::list_songs(&conn).unwrap();
    let por_nome = |nome: &str| {
        songs
            .iter()
            .find(|s| s.file_path.ends_with(nome))
            .unwrap_or_else(|| panic!("{nome} deveria estar indexada"))
            .instrumental
    };

    for (i, (valor, esperado)) in casos.iter().enumerate() {
        assert_eq!(
            por_nome(&format!("caso{i}.mp3")),
            *esperado,
            "TXXX:INSTRUMENTAL = {valor:?}"
        );
    }
    assert!(!por_nome("sem_frame.mp3"), "sem frame não é instrumental");
}

// ---------------------------------------------------------------------------
// V5 (F12) — o scan preenche songs.pastas com os nomes das subpastas do
// arquivo relativos à pasta registrada (separados por espaço); arquivo na
// raiz fica NULL; a busca encontra pelo nome da pasta sem a palavra em
// título/letra/temas e sem snippet de letra.
// ---------------------------------------------------------------------------
#[test]
fn scan_fills_pastas_and_search_finds_by_folder_name() {
    use cancioneiro_lib::search;
    use rusqlite::params;

    let dir = setup_music_dir(false);
    let sub = dir.path().join("Barco").join("aninhada");
    fs::create_dir_all(&sub).unwrap();
    fs::rename(dir.path().join("sem_letra.mp3"), sub.join("sem_letra.mp3")).unwrap();

    let conn = test_conn();
    let folder_id = db::add_folder(&conn, dir.path().to_str().unwrap()).unwrap();
    indexer::scan_folder(&conn, folder_id, |_, _| {}).unwrap();

    // subpastas relativas, separadas por espaço
    let pastas: Option<String> = conn
        .query_row(
            "SELECT pastas FROM songs WHERE file_path LIKE ?1",
            params!["%sem_letra.mp3"],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(pastas.as_deref(), Some("Barco aninhada"));

    // arquivo na raiz da pasta registrada: sem pasta (NULL)
    let pastas_raiz: Option<String> = conn
        .query_row(
            "SELECT pastas FROM songs WHERE file_path LIKE ?1",
            params!["%com_letra.mp3"],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(pastas_raiz, None);

    // busca por nome de pasta (sem a palavra em título/letra/temas)
    let results = search::search(&conn, "barco", 50).unwrap();
    assert_eq!(results.len(), 1);
    assert!(results[0].song.file_path.ends_with("sem_letra.mp3"));
    assert!(results[0].snippet.is_none(), "match de pasta não gera snippet");

    // rescan sem mudanças não perde as pastas
    indexer::scan_folder(&conn, folder_id, |_, _| {}).unwrap();
    let results = search::search(&conn, "aninhada", 50).unwrap();
    assert_eq!(results.len(), 1);
}

// ---------------------------------------------------------------------------
// V8 — o scan preenche songs.arquivo com o nome-base SEM extensão e a busca
// encontra a música por uma palavra que só existe no NOME DO ARQUIVO (tags
// dizendo outra coisa), sem snippet de letra. Música sem tag — cujo título JÁ
// É o nome do arquivo — não repete o texto no índice (coluna NULL).
// ---------------------------------------------------------------------------
#[test]
fn scan_fills_arquivo_and_search_finds_by_file_name() {
    use cancioneiro_lib::search;
    use rusqlite::params;

    let dir = setup_music_dir(false);
    // nome no estilo do acervo real: prefixo, hífens, parênteses e ruído "##"
    let renomeada = dir.path().join("barco - Marinheiro só (Capoeira) ##.mp3");
    fs::rename(dir.path().join("com_letra.mp3"), &renomeada).unwrap();

    let conn = test_conn();
    let folder_id = db::add_folder(&conn, dir.path().to_str().unwrap()).unwrap();
    indexer::scan_folder(&conn, folder_id, |_, _| {}).unwrap();

    // coluna preenchida com o nome sem extensão
    let arquivo: Option<String> = conn
        .query_row(
            "SELECT arquivo FROM songs WHERE file_path LIKE ?1",
            params!["%Capoeira) ##.mp3"],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(arquivo.as_deref(), Some("barco - Marinheiro só (Capoeira) ##"));

    // sem tags: título já é o nome do arquivo => nada a repetir no índice
    let arquivo_sem_tags: Option<String> = conn
        .query_row(
            "SELECT arquivo FROM songs WHERE file_path LIKE ?1",
            params!["%sem_tags.mp3"],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(arquivo_sem_tags, None);
    // ...e continua achável pelo título (que É o nome do arquivo)
    assert_eq!(search::search(&conn, "sem_tags", 50).unwrap().len(), 1);

    // "capoeira" só existe no nome do arquivo (a tag diz "Coração Sertanejo")
    let results = search::search(&conn, "capoeira", 50).unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].song.title, "Coração Sertanejo");
    assert!(
        results[0].snippet.is_none(),
        "match de nome de arquivo não gera snippet"
    );

    // a extensão não entrou no índice
    assert!(search::search(&conn, "mp3", 50).unwrap().is_empty());

    // rescan sem mudanças não perde o nome indexado
    indexer::scan_folder(&conn, folder_id, |_, _| {}).unwrap();
    assert_eq!(search::search(&conn, "capoeira", 50).unwrap().len(), 1);
}

// ---------------------------------------------------------------------------
// Seção 8 do PRD: nenhum arquivo de áudio é modificado pelo app — bytes dos
// MP3s idênticos antes/depois de todos os fluxos de backend (indexar,
// reindexar, buscar, ler letra, playlists, rescan). Exclui, por definição
// (PRD V4), o único fluxo que escreve: writer::write_tags, que tem testes
// próprios de round-trip/áudio intacto/nome intacto em tests/writer.rs.
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

// ---------------------------------------------------------------------------
// V8/F17 — round-trip REAL da marca de instrumental, atravessando os dois
// stacks: quem marca é o `tools/embed_lyrics.py --instrumental` (o caminho
// da curadoria), quem lê é o indexer.
//
// Por que este teste e não só o de leitura: os outros dois round-trips
// (USLT, TXXX:TEMAS) cobrem campos que, se divergirem, produzem uma letra
// faltando ou um tema a menos. A marca de instrumental decide se um arquivo
// entra ou não em toda etapa de letra — se o Python gravar de um jeito que o
// Rust não reconhece, a marca simplesmente não faz nada, e a peça sem voz
// volta a receber a letra da versão cantada. Até aqui ela só era testada com
// um frame escrito pelo próprio lofty, o que não prova nada sobre a Python.
//
// E o desmarque também: `--nao-instrumental` REMOVE o frame (não escreve
// "0"), e o indexer tem de voltar a ler "não é instrumental".
// ---------------------------------------------------------------------------
#[test]
fn roundtrip_instrumental_mark_written_by_the_python_script() {
    use std::process::Command;

    let script = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("tools/embed_lyrics.py");

    let dir = setup_music_dir(false);
    let alvo = dir.path().join("sem_letra.mp3");

    let rodar = |flag: &str| {
        let out = Command::new("python3")
            .arg(&script)
            .arg(&alvo)
            .arg(flag)
            .output()
            .unwrap_or_else(|e| panic!("python3 {script:?} {flag}: {e}"));
        assert!(
            out.status.success(),
            "embed_lyrics.py {flag} falhou: {}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
    };

    let conn = test_conn();
    let folder_id = db::add_folder(&conn, dir.path().to_str().unwrap()).unwrap();
    let instrumental_agora = |conn: &Connection| {
        indexer::scan_folder(conn, folder_id, |_, _| {}).unwrap();
        db::list_songs(conn)
            .unwrap()
            .into_iter()
            .find(|s| s.file_path.ends_with("sem_letra.mp3"))
            .expect("sem_letra.mp3 indexada")
            .instrumental
    };

    assert!(!instrumental_agora(&conn), "sem a marca, não é instrumental");

    rodar("--instrumental");
    assert!(
        instrumental_agora(&conn),
        "o indexer não reconheceu a marca gravada pelo embed_lyrics.py"
    );

    rodar("--nao-instrumental");
    assert!(
        !instrumental_agora(&conn),
        "o desmarque do embed_lyrics.py (remoção do frame) não foi lido"
    );

    // e a marca não é dedução de "não tem letra": o arquivo continua sem
    // letra nos três estados acima
    assert!(!db::list_songs(&conn)
        .unwrap()
        .into_iter()
        .find(|s| s.file_path.ends_with("sem_letra.mp3"))
        .unwrap()
        .has_lyrics);
}
