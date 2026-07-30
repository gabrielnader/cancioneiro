//! Testes de integração da F10 (PRD V4) — write_tags: gravação de tags ID3
//! no MP3 via lofty com round-trip pelo indexer, sem tocar no áudio nem no
//! nome do arquivo. Fixtures MP3 reais copiadas para tempdir.

use cancioneiro_lib::{db, indexer, search, writer};
use rusqlite::Connection;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

mod common;
use common::copy_fixture;

/// Copia fixtures para um tempdir, registra a pasta e indexa. Devolve
/// (tempdir, conn, folder_id).
fn setup() -> (tempfile::TempDir, Connection, i64) {
    let dir = tempfile::tempdir().unwrap();
    for name in ["com_letra.mp3", "sem_letra.mp3", "sem_tags.mp3"] {
        copy_fixture(name, &dir.path().join(name));
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
// Helpers V5/F14 — frames "estrangeiros" (gravados pelas ferramentas Python):
// TXXX:LETRA_ORIGEM, outros TXXX e a capa (APIC).
// ---------------------------------------------------------------------------

const LETRA_ORIGEM: &str = "LETRA_ORIGEM";
/// V8/F17 — marca de instrumental gravada pela curadoria (`TXXX:INSTRUMENTAL`).
const INSTRUMENTAL: &str = "INSTRUMENTAL";

fn id3_tag(path: &Path) -> lofty::id3::v2::Id3v2Tag {
    use lofty::config::ParseOptions;
    use lofty::file::AudioFile;
    lofty::mpeg::MpegFile::read_from(&mut fs::File::open(path).unwrap(), ParseOptions::new())
        .expect("arquivo deve continuar parseável")
        .id3v2()
        .cloned()
        .unwrap_or_default()
}

/// Simula o que o `tools/curadoria.py transcrever` deixa no arquivo: a marca
/// de origem da letra + frames estrangeiros que o app NUNCA pode perder
/// (outro TXXX e a capa).
fn marcar_transcricao_com_capa(path: &Path) {
    use lofty::config::WriteOptions;
    use lofty::picture::{MimeType, Picture, PictureType};
    use lofty::tag::TagExt;

    let mut tag = id3_tag(path);
    tag.insert_user_text(LETRA_ORIGEM.to_string(), "transcricao".to_string());
    tag.insert_user_text("OUTRA_COISA".to_string(), "valor alheio".to_string());
    tag.insert_picture(Picture::new_unchecked(
        PictureType::CoverFront,
        Some(MimeType::Png),
        Some("capa".to_string()),
        b"\x89PNG\r\n\x1a\n-fake".to_vec(),
    ));
    tag.save_to_path(path, WriteOptions::default()).unwrap();
}

fn letra_origem(path: &Path) -> Option<String> {
    id3_tag(path).get_user_text(LETRA_ORIGEM).map(str::to_string)
}

/// Valor cru do TXXX:INSTRUMENTAL no arquivo (None = frame ausente).
fn instrumental_frame(path: &Path) -> Option<String> {
    id3_tag(path).get_user_text(INSTRUMENTAL).map(str::to_string)
}

/// Marca o arquivo como instrumental do jeito que a curadoria Python marca,
/// junto dos frames estrangeiros que o app nunca pode perder.
fn marcar_instrumental_com_capa(path: &Path) {
    use lofty::config::WriteOptions;
    use lofty::picture::{MimeType, Picture, PictureType};
    use lofty::tag::TagExt;

    let mut tag = id3_tag(path);
    tag.insert_user_text(INSTRUMENTAL.to_string(), "1".to_string());
    tag.insert_user_text("OUTRA_COISA".to_string(), "valor alheio".to_string());
    tag.insert_picture(Picture::new_unchecked(
        PictureType::CoverFront,
        Some(MimeType::Png),
        Some("capa".to_string()),
        b"\x89PNG\r\n\x1a\n-fake".to_vec(),
    ));
    tag.save_to_path(path, WriteOptions::default()).unwrap();
}

/// Os frames estrangeiros que precisam sobreviver a QUALQUER gravação.
fn frames_alheios_intactos(path: &Path) {
    use lofty::id3::v2::FrameId;
    use std::borrow::Cow;

    let tag = id3_tag(path);
    assert_eq!(
        tag.get_user_text("OUTRA_COISA"),
        Some("valor alheio"),
        "TXXX alheio nunca pode ser removido"
    );
    assert!(
        tag.get(&FrameId::Valid(Cow::Borrowed("APIC"))).is_some(),
        "a capa (APIC) nunca pode ser removida"
    );
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
        None,
    )
    .unwrap().song;

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

    writer::write_tags(&conn, song.id, "Novo Título", None, None, None, None).unwrap();

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
        let err = writer::write_tags(&conn, song.id, title, None, None, None, None)
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

    assert!(writer::write_tags(&conn, 9999, "T", None, None, None, None).is_err());

    let song = song_by_suffix(&conn, "sem_letra.mp3");
    fs::remove_file(&song.file_path).unwrap();
    let err = writer::write_tags(&conn, song.id, "T", None, None, None, None)
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
        None,
    )
    .unwrap().song;
    assert_eq!(updated.title, "Só Título");
    assert_eq!(updated.artist, None);
    assert!(!updated.has_lyrics);
    assert_eq!(updated.temas, None);
    assert_eq!(db::get_lyrics(&conn, song.id).unwrap(), None);

    // regrava com tudo e depois remove com None
    writer::write_tags(&conn, song.id, "Cheio", Some("A"), Some("letra"), Some("tema"), None)
        .unwrap();
    let cleared = writer::write_tags(&conn, song.id, "Cheio", None, None, None, None).unwrap().song;
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
        None,
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
    copy_fixture("com_letra.mp3", &sub.join("com_letra.mp3"));

    let conn = db::open_in_memory().unwrap();
    let folder_id = db::add_folder(&conn, dir.path().to_str().unwrap()).unwrap();
    indexer::scan_folder(&conn, folder_id, |_, _| {}).unwrap();
    let song = song_by_suffix(&conn, "com_letra.mp3");

    writer::write_tags(
        &conn,
        song.id,
        "Título Editado",
        None,
        Some("letra nova"),
        None,
        None,
    )
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
// V8 — a coluna `arquivo` (nome buscável) é RECALCULADA na edição, porque a
// regra depende do título: música sem tag entra com o nome como título e o
// nome fica fora do índice (não se indexa o mesmo texto duas vezes); assim
// que a pessoa dá um título de verdade, o nome antigo passa a valer como
// busca — é justamente por ele que a coordenadora ainda procura a música.
// ---------------------------------------------------------------------------
#[test]
fn write_tags_makes_the_file_name_searchable_once_the_title_differs() {
    use rusqlite::params;

    let (_dir, conn, _folder_id) = setup();
    let song = song_by_suffix(&conn, "sem_tags.mp3");
    assert_eq!(song.title, "sem_tags", "sem tag: título é o nome do arquivo");

    // antes: nome == título, nada a repetir no índice
    let arquivo: Option<String> = conn
        .query_row(
            "SELECT arquivo FROM songs WHERE id = ?1",
            params![song.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(arquivo, None);
    // ...e a música é achável assim mesmo, pelo título
    assert_eq!(search::search(&conn, "sem_tags", 50).unwrap().len(), 1);

    writer::write_tags(&conn, song.id, "Ponto de Ogum", None, None, None, None).unwrap();

    let arquivo: Option<String> = conn
        .query_row(
            "SELECT arquivo FROM songs WHERE id = ?1",
            params![song.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(arquivo.as_deref(), Some("sem_tags"));

    // FTS em sincronia: o nome antigo ainda acha a música, sem snippet
    let results = search::search(&conn, "sem_tags", 50).unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].song.id, song.id);
    assert_eq!(results[0].song.title, "Ponto de Ogum");
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
        None,
    )
    .unwrap().song;
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

// ---------------------------------------------------------------------------
// V5/F14 (QA A3) — a marca TXXX:LETRA_ORIGEM descreve a letra ATUAL: gravar
// uma letra nova por cima de um arquivo marcado como "transcricao" derruba a
// marca (senão o arquivo passa a mentir que a letra escrita à mão saiu do
// áudio, e o selo "transcrição automática" do player mentiria junto).
// Os demais frames estrangeiros (outro TXXX, capa) continuam intactos.
// ---------------------------------------------------------------------------
#[test]
fn write_tags_drops_letra_origem_when_lyrics_are_replaced() {
    let (_dir, conn, _folder_id) = setup();
    let song = song_by_suffix(&conn, "com_letra.mp3");
    let path = PathBuf::from(&song.file_path);
    marcar_transcricao_com_capa(&path);
    assert_eq!(letra_origem(&path).as_deref(), Some("transcricao"));

    writer::write_tags(
        &conn,
        song.id,
        &song.title,
        song.artist.as_deref(),
        Some("Letra escrita à mão pelo usuário"),
        None,
        None,
    )
    .unwrap();

    assert_eq!(
        letra_origem(&path),
        None,
        "letra substituída: a marca de transcrição não pode sobreviver"
    );
    frames_alheios_intactos(&path);
}

// ---------------------------------------------------------------------------
// V5/F14 (QA A3) — apagar a letra também derruba a marca (não há letra alguma
// para ser "transcrição automática").
// ---------------------------------------------------------------------------
#[test]
fn write_tags_drops_letra_origem_when_lyrics_are_cleared() {
    let (_dir, conn, _folder_id) = setup();
    let song = song_by_suffix(&conn, "com_letra.mp3");
    let path = PathBuf::from(&song.file_path);
    marcar_transcricao_com_capa(&path);

    let updated =
        writer::write_tags(&conn, song.id, &song.title, song.artist.as_deref(), None, None, None)
            .unwrap()
            .song;
    assert!(!updated.has_lyrics);

    assert_eq!(letra_origem(&path), None, "letra apagada derruba a marca");
    frames_alheios_intactos(&path);
}

// ---------------------------------------------------------------------------
// V5/F14 (QA A3) — gravação que NÃO mexe na letra (só título/artista/temas,
// letra repassada igual, como faz o apply do lote) PRESERVA a marca: ela ainda
// descreve a letra que está no arquivo.
// ---------------------------------------------------------------------------
#[test]
fn write_tags_keeps_letra_origem_when_lyrics_pass_through_unchanged() {
    let (_dir, conn, _folder_id) = setup();
    let song = song_by_suffix(&conn, "com_letra.mp3");
    let path = PathBuf::from(&song.file_path);
    marcar_transcricao_com_capa(&path);
    let letra = db::get_lyrics(&conn, song.id).unwrap().expect("fixture tem letra");

    let updated = writer::write_tags(
        &conn,
        song.id,
        "Outro Título",
        Some("Outro Artista"),
        Some(&letra), // repasse: a mesma letra que já está no arquivo
        Some("novo tema"),
        None,
    )
    .unwrap().song;

    assert_eq!(
        letra_origem(&path).as_deref(),
        Some("transcricao"),
        "letra inalterada: a marca legítima tem de continuar"
    );
    assert_eq!(
        updated.letra_origem.as_deref(),
        Some("transcricao"),
        "a Song reindexada continua marcada — o selo do painel permanece"
    );
    frames_alheios_intactos(&path);

    // e a letra continua lá, byte a byte
    assert_eq!(db::get_lyrics(&conn, song.id).unwrap().as_deref(), Some(letra.as_str()));
}

// ---------------------------------------------------------------------------
// V5/F14 — o selo do player some no ato: a Song devolvida pelo write_tags (e
// a que o banco passa a servir) já vem SEM procedência quando a letra muda.
// Sem isso o painel continuaria dizendo "transcrição automática" sobre a letra
// que o coordenador acabou de digitar, até reiniciar o app.
// ---------------------------------------------------------------------------
#[test]
fn write_tags_clears_letra_origem_in_the_reindexed_song() {
    let (_dir, conn, folder_id) = setup();
    let song = song_by_suffix(&conn, "com_letra.mp3");
    let path = PathBuf::from(&song.file_path);
    marcar_transcricao_com_capa(&path);

    // rescan: o banco passa a enxergar a marca deixada pela curadoria
    indexer::scan_folder(&conn, folder_id, |_, _| {}).unwrap();
    assert_eq!(
        song_by_suffix(&conn, "com_letra.mp3").letra_origem.as_deref(),
        Some("transcricao"),
        "o indexer precisa ver a marca antes da edição"
    );

    let updated = writer::write_tags(
        &conn,
        song.id,
        &song.title,
        song.artist.as_deref(),
        Some("Letra escrita à mão pelo usuário"),
        None,
        None,
    )
    .unwrap().song;

    assert_eq!(
        updated.letra_origem, None,
        "a Song devolvida ao frontend não pode mais se declarar transcrição"
    );
    assert_eq!(
        db::get_song(&conn, song.id).unwrap().unwrap().letra_origem,
        None
    );
}

// ---------------------------------------------------------------------------
// V5/F14 (QA A3) — arquivo SEM marca nunca ganha uma: gravar letra nova não
// inventa TXXX:LETRA_ORIGEM.
// ---------------------------------------------------------------------------
#[test]
fn write_tags_never_invents_letra_origem() {
    let (_dir, conn, _folder_id) = setup();
    let song = song_by_suffix(&conn, "sem_tags.mp3");
    let path = PathBuf::from(&song.file_path);

    writer::write_tags(&conn, song.id, "T", None, Some("letra nova"), None, None).unwrap();
    assert_eq!(letra_origem(&path), None);
}

// ---------------------------------------------------------------------------
// V8/F17 — a marca de instrumental é posta e retirada pelo write_tags:
// `Some(true)` grava TXXX:INSTRUMENTAL = "1", `Some(false)` REMOVE o frame.
// Nos dois sentidos os frames estrangeiros (outro TXXX e a capa) sobrevivem,
// e a Song devolvida já reflete a marca — o selo da lista muda no ato.
// ---------------------------------------------------------------------------
#[test]
fn write_tags_sets_and_clears_instrumental_preserving_foreign_frames() {
    let (_dir, conn, folder_id) = setup();
    let song = song_by_suffix(&conn, "sem_letra.mp3");
    let path = PathBuf::from(&song.file_path);
    marcar_instrumental_com_capa(&path);
    // o arquivo entra marcado, mas o banco só sabe disso depois de reler
    indexer::scan_folder(&conn, folder_id, |_, _| {}).unwrap();
    assert!(song_by_suffix(&conn, "sem_letra.mp3").instrumental);

    // desmarcar: o frame sai do arquivo
    let desmarcada = writer::write_tags(
        &conn,
        song.id,
        &song.title,
        song.artist.as_deref(),
        None,
        None,
        Some(false),
    )
    .unwrap().song;
    assert!(!desmarcada.instrumental);
    assert_eq!(instrumental_frame(&path), None, "desmarcar remove o frame");
    frames_alheios_intactos(&path);

    // marcar de novo: frame canônico "1"
    let marcada = writer::write_tags(
        &conn,
        song.id,
        &song.title,
        song.artist.as_deref(),
        None,
        None,
        Some(true),
    )
    .unwrap().song;
    assert!(marcada.instrumental);
    assert_eq!(instrumental_frame(&path).as_deref(), Some("1"));
    frames_alheios_intactos(&path);

    // round-trip: um scan do zero relê exatamente o que foi gravado
    indexer::scan_folder(&conn, folder_id, |_, _| {}).unwrap();
    assert!(song_by_suffix(&conn, "sem_letra.mp3").instrumental);
}

// ---------------------------------------------------------------------------
// V8/F17 — `None` é "não mexer": nenhuma rotina que não seja a escolha humana
// (o lote do enrich, uma gravação só de título) pode desmarcar sozinha.
// É a garantia do PRD: "marcada à mão, nenhuma rotina desmarca sozinha".
// ---------------------------------------------------------------------------
#[test]
fn write_tags_leaves_the_human_mark_untouched_when_instrumental_is_none() {
    let (_dir, conn, folder_id) = setup();
    let song = song_by_suffix(&conn, "sem_letra.mp3");
    let path = PathBuf::from(&song.file_path);
    marcar_instrumental_com_capa(&path);

    let updated = writer::write_tags(
        &conn,
        song.id,
        "Outro Título",
        Some("Outro Artista"),
        None,
        Some("prelúdio"),
        None, // não mexe na marca
    )
    .unwrap().song;

    assert_eq!(instrumental_frame(&path).as_deref(), Some("1"));
    assert!(updated.instrumental, "a Song reindexada continua marcada");
    frames_alheios_intactos(&path);

    indexer::scan_folder(&conn, folder_id, |_, _| {}).unwrap();
    assert!(song_by_suffix(&conn, "sem_letra.mp3").instrumental);
}

// ---------------------------------------------------------------------------
// V8/F17 — a interação com a regra da letra (DECISIONS #54). A marca
// LETRA_ORIGEM descreve a LETRA e cai quando a letra muda; INSTRUMENTAL
// descreve a MÚSICA (não tem voz) e NÃO cai: o PRD prevê explicitamente a
// instrumental com letra registrada, e a escolha humana não pode ser desfeita
// de lado, por um efeito colateral de salvar a letra.
// ---------------------------------------------------------------------------
#[test]
fn write_tags_keeps_instrumental_when_lyrics_change_or_are_cleared() {
    let (_dir, conn, folder_id) = setup();
    let song = song_by_suffix(&conn, "com_letra.mp3");
    let path = PathBuf::from(&song.file_path);
    marcar_transcricao_com_capa(&path);
    marcar_instrumental_com_capa(&path);
    indexer::scan_folder(&conn, folder_id, |_, _| {}).unwrap();

    // letra NOVA: derruba a procedência, preserva a marca de instrumental
    let com_letra_nova = writer::write_tags(
        &conn,
        song.id,
        &song.title,
        song.artist.as_deref(),
        Some("Letra escrita à mão pelo usuário"),
        None,
        None,
    )
    .unwrap().song;
    assert_eq!(letra_origem(&path), None, "letra trocada derruba a procedência");
    assert_eq!(
        instrumental_frame(&path).as_deref(),
        Some("1"),
        "trocar a letra não desmarca o instrumental"
    );
    assert!(com_letra_nova.instrumental);
    // instrumental COM letra registrada é caso previsto no PRD, não contradição
    assert!(com_letra_nova.has_lyrics);
    frames_alheios_intactos(&path);

    // apagar a letra também não mexe na marca
    let sem_letra = writer::write_tags(
        &conn,
        song.id,
        &song.title,
        song.artist.as_deref(),
        None,
        None,
        None,
    )
    .unwrap().song;
    assert!(!sem_letra.has_lyrics);
    assert!(sem_letra.instrumental);
    assert_eq!(instrumental_frame(&path).as_deref(), Some("1"));
}

// ---------------------------------------------------------------------------
// V8/F17 — arquivo sem marca nunca ganha uma sozinho: gravação comum (e até
// `Some(false)` num arquivo já sem marca) não inventa TXXX:INSTRUMENTAL.
// ---------------------------------------------------------------------------
#[test]
fn write_tags_never_invents_instrumental() {
    let (_dir, conn, _folder_id) = setup();
    let song = song_by_suffix(&conn, "sem_tags.mp3");
    let path = PathBuf::from(&song.file_path);

    writer::write_tags(&conn, song.id, "T", None, Some("letra nova"), None, None).unwrap();
    assert_eq!(instrumental_frame(&path), None);

    let updated = writer::write_tags(&conn, song.id, "T", None, None, None, Some(false))
        .unwrap()
        .song;
    assert_eq!(instrumental_frame(&path), None);
    assert!(!updated.instrumental);
}

// ---------------------------------------------------------------------------
// V8/F18 — procedência DECLARADA pelo chamador. O funil sabe de onde a letra
// veio; o editor do player não sabe e continua no `write_tags` de sempre.
//
// `Some("vagalume")` marca `TXXX:LETRA_ORIGEM = "vagalume"` — o valor herdado
// que o `tools/embed_lyrics.py` grava, porque o dado viaja no MP3 e os dois
// stacks precisam falar a mesma língua. `Some("")` declara letra oficial sem
// marca e LIMPA a herdada. Nos dois casos os frames estrangeiros sobrevivem.
// ---------------------------------------------------------------------------
#[test]
fn write_tags_com_origem_records_the_declared_provenance() {
    let (_dir, conn, _folder_id) = setup();
    let song = song_by_suffix(&conn, "com_letra.mp3");
    let path = PathBuf::from(&song.file_path);
    marcar_transcricao_com_capa(&path);
    assert_eq!(letra_origem(&path), Some("transcricao".into()));

    // letra do Vagalume por cima de uma transcrição: a marca vira "vagalume"
    let atualizada = writer::write_tags_com_origem(
        &conn,
        song.id,
        &song.title,
        song.artist.as_deref(),
        Some("letra da base comunitária"),
        None,
        None,
        Some(writer::ORIGEM_VAGALUME),
    )
    .unwrap().song;
    assert_eq!(letra_origem(&path), Some("vagalume".into()));
    assert_eq!(atualizada.letra_origem.as_deref(), Some("vagalume"));
    frames_alheios_intactos(&path);

    // e não duplica o frame ao regravar por cima
    writer::write_tags_com_origem(
        &conn,
        song.id,
        &song.title,
        song.artist.as_deref(),
        Some("outra letra da base"),
        None,
        None,
        Some(writer::ORIGEM_VAGALUME),
    )
    .unwrap();
    assert_eq!(letra_origem(&path), Some("vagalume".into()));

    // declaração vazia = letra oficial SEM marca: limpa a que estava lá
    let limpa = writer::write_tags_com_origem(
        &conn,
        song.id,
        &song.title,
        song.artist.as_deref(),
        Some("letra oficial do lrclib"),
        None,
        None,
        Some(""),
    )
    .unwrap().song;
    assert_eq!(letra_origem(&path), None);
    assert_eq!(limpa.letra_origem, None);
    frames_alheios_intactos(&path);
}

/// A marca descreve a letra ATUAL: sem letra nova não há procedência a
/// declarar, e a declaração é IGNORADA — nem inventa marca em arquivo sem
/// letra, nem derruba a marca legítima de quem só mexeu no título.
#[test]
fn write_tags_com_origem_ignores_a_declaration_without_a_new_lyric() {
    let (_dir, conn, _folder_id) = setup();

    // (a) arquivo COM letra, gravação que só troca o título: marca preservada
    let com_letra = song_by_suffix(&conn, "com_letra.mp3");
    let path = PathBuf::from(&com_letra.file_path);
    marcar_transcricao_com_capa(&path);
    let letra_atual = db::get_lyrics(&conn, com_letra.id).unwrap();
    writer::write_tags_com_origem(
        &conn,
        com_letra.id,
        "Outro Título",
        com_letra.artist.as_deref(),
        letra_atual.as_deref(), // repasse da MESMA letra
        None,
        None,
        Some(writer::ORIGEM_VAGALUME),
    )
    .unwrap();
    assert_eq!(
        letra_origem(&path),
        Some("transcricao".into()),
        "repasse da mesma letra não muda a procedência dela"
    );

    // (b) arquivo SEM letra: declaração não inventa marca nenhuma
    let sem_letra = song_by_suffix(&conn, "sem_letra.mp3");
    let path2 = PathBuf::from(&sem_letra.file_path);
    writer::write_tags_com_origem(
        &conn,
        sem_letra.id,
        &sem_letra.title,
        sem_letra.artist.as_deref(),
        None,
        None,
        None,
        Some(writer::ORIGEM_VAGALUME),
    )
    .unwrap();
    assert_eq!(letra_origem(&path2), None);
}

/// V8/F18 — o editor grava com a MESMA chamada que o funil, incluindo a
/// marca de instrumental, e as duas coisas não se atrapalham.
///
/// É o caso novo do formulário: a pessoa aceita a letra de uma proposta do
/// Vagalume, ela cai no campo de letra, e o salvar do editor precisa levar a
/// procedência junto. Sem isso o editor apagava a marca que o funil tinha
/// acabado de gravar — a mesma letra passava a se declarar oficial só porque
/// foi salva pela outra porta.
#[test]
fn the_editor_can_declare_the_provenance_of_the_lyric_it_saves() {
    let (_dir, conn, _folder_id) = setup();
    let song = song_by_suffix(&conn, "sem_letra.mp3");
    let path = PathBuf::from(&song.file_path);

    let atualizada = writer::write_tags_com_origem(
        &conn,
        song.id,
        "Ponto de Oxum",
        Some("Coral Novo"),
        Some("letra aceita de uma proposta do Vagalume"),
        Some("água; esperança"),
        Some(true), // e a marca de instrumental do mesmo formulário
        Some(writer::ORIGEM_VAGALUME),
    )
    .unwrap().song;

    assert_eq!(letra_origem(&path), Some("vagalume".into()));
    assert_eq!(atualizada.letra_origem.as_deref(), Some("vagalume"));
    assert!(atualizada.instrumental, "as duas marcas convivem");
    assert_eq!(atualizada.temas.as_deref(), Some("água; esperança"));

    // ...e o salvar seguinte, sem declarar nada, continua valendo a regra da
    // DECISIONS #54: mesma letra, marca preservada
    let de_novo = writer::write_tags(
        &conn,
        song.id,
        "Ponto de Oxum",
        Some("Coral Novo"),
        Some("letra aceita de uma proposta do Vagalume"),
        Some("água; esperança"),
        None,
    )
    .unwrap().song;
    assert_eq!(de_novo.letra_origem.as_deref(), Some("vagalume"));
}

/// `write_tags` (o editor SEM declaração) é exatamente
/// `write_tags_com_origem(..., None)`: não sabe de procedência e segue
/// valendo a regra da DECISIONS #54.
#[test]
fn write_tags_is_write_tags_com_origem_without_a_declaration() {
    let (_dir, conn, _folder_id) = setup();
    let song = song_by_suffix(&conn, "com_letra.mp3");
    let path = PathBuf::from(&song.file_path);
    marcar_transcricao_com_capa(&path);

    // letra trocada à mão no editor: a marca cai (não é mais transcrição)
    writer::write_tags(
        &conn,
        song.id,
        &song.title,
        song.artist.as_deref(),
        Some("letra digitada à mão"),
        None,
        None,
    )
    .unwrap();
    assert_eq!(letra_origem(&path), None);
}

// ---------------------------------------------------------------------------
// V10 — o valor de procedência do VAGALUME é HERANÇA, e herança não se apaga.
//
// A etapa do Vagalume saiu do aplicativo (DECISIONS #110) e nada mais a
// escreve. Mas o `tools/curadoria.py` a grava, e arquivos do acervo real já a
// carregam: um valor que este programa não produz mais NÃO é lixo a limpar.
// "Nunca apagar dado existente" vale para INTERPRETAR dado existente também.
// ---------------------------------------------------------------------------

/// Gravar título e artista sobre um arquivo marcado `vagalume` PRESERVA a
/// marca — pela regra da DECISIONS #54 (a marca descreve a letra, e a letra
/// não mudou). É o caminho de quem aceita só o nome numa revisão.
#[test]
fn a_marca_herdada_do_vagalume_sobrevive_a_gravacao_de_nome() {
    let (_dir, conn, _folder_id) = setup();
    let song = song_by_suffix(&conn, "com_letra.mp3");
    let path = PathBuf::from(&song.file_path);
    const LETRA_HERDADA: &str = "letra que veio da base comunitária";

    // o estado que o `tools/curadoria.py` deixa num arquivo do acervo real: a
    // letra dele, com a marca dele. (A declaração só vale quando a letra MUDA
    // — DECISIONS #54 —, então a letra aqui é nova.)
    writer::write_tags_com_origem(
        &conn,
        song.id,
        "Título Antigo",
        Some("Artista Antigo"),
        Some(LETRA_HERDADA),
        None,
        None,
        Some(writer::ORIGEM_VAGALUME),
    )
    .unwrap();
    assert_eq!(letra_origem(&path), Some("vagalume".into()));

    // agora o APLICATIVO grava só NOME, repassando a letra intacta e sem
    // declarar procedência nenhuma — é o caminho do `enrich::apply` para quem
    // aceita o título e não mexe na letra.
    let atualizada = writer::write_tags_com_origem(
        &conn,
        song.id,
        "Título Novo",
        Some("Artista Novo"),
        Some(LETRA_HERDADA),
        None,
        None,
        None,
    )
    .unwrap().song;
    assert_eq!(
        letra_origem(&path),
        Some("vagalume".into()),
        "a marca herdada NÃO é apagada por uma gravação de nome"
    );
    assert_eq!(atualizada.letra_origem.as_deref(), Some("vagalume"));
    assert_eq!(atualizada.title, "Título Novo");

    // e a REINDEXAÇÃO continua lendo o valor do arquivo: ele chega ao banco e
    // à tela como qualquer outra procedência, sem ninguém precisar conhecê-lo
    indexer::scan_folder(&conn, song.folder_id, |_, _| {}).unwrap();
    let relido = song_by_suffix(&conn, "com_letra.mp3");
    assert_eq!(relido.letra_origem.as_deref(), Some("vagalume"));
}

// ---------------------------------------------------------------------------
// V10.1 — MP3 com CAMPO DE IDIOMA INVÁLIDO num quadro ID3v2 (defeito relatado
// em campo).
//
// O acervo real tem arquivos gravados por programas que escreveram `[0,0,0]`
// no campo de idioma de um COMM/USLT em vez de três letras. O lofty LÊ isso
// sem reclamar (em qualquer ParsingMode) e RECUSA a gravação — o que tirava
// aquela música da curadoria para sempre, porque toda tentativa falhava igual.
//
// A saída não é descartar o quadro (seria perder a anotação ou a letra de
// alguém): é CONSERTAR o idioma para `und`, que é o valor previsto pelo
// próprio padrão ID3 para "não sei qual é".
// ---------------------------------------------------------------------------

/// Bytes do ÁUDIO: tudo depois do bloco ID3v2 do começo do arquivo. É a prova
/// forte de "o áudio não é tocado" — mais forte que comparar a duração, que
/// sobreviveria a uma reescrita dos quadros MPEG.
fn audio_bytes(path: &Path) -> Vec<u8> {
    let bytes = fs::read(path).unwrap();
    if bytes.len() < 10 || &bytes[..3] != b"ID3" {
        return bytes;
    }
    // tamanho synchsafe: 4 bytes de 7 bits
    let tamanho = ((bytes[6] as usize) << 21)
        | ((bytes[7] as usize) << 14)
        | ((bytes[8] as usize) << 7)
        | (bytes[9] as usize);
    bytes[10 + tamanho..].to_vec()
}

/// Escreve `valor` no campo de idioma do n-ésimo quadro `id` do bloco ID3v2.
///
/// É manipulação de bytes crua de propósito: nenhuma biblioteca aceita
/// ESCREVER um idioma inválido (é justamente o que o lofty recusa), então a
/// única forma de montar em teste o arquivo que veio do campo é editar o
/// arquivo no lugar. Layout do quadro ID3v2.4: 4 bytes de identificador, 4 de
/// tamanho, 2 de sinalizadores, 1 de codificação e então os 3 do idioma.
fn por_idioma_no_quadro(path: &Path, id: &[u8; 4], nth: usize, valor: [u8; 3]) {
    let mut bytes = fs::read(path).unwrap();
    let mut achados = 0;
    let mut i = 0;
    while i + 14 < bytes.len() {
        if &bytes[i..i + 4] == id {
            if achados == nth {
                let lang = i + 10 + 1;
                bytes[lang..lang + 3].copy_from_slice(&valor);
                fs::write(path, bytes).unwrap();
                return;
            }
            achados += 1;
            i += 14;
        } else {
            i += 1;
        }
    }
    panic!("não achei o quadro {} nº {nth}", String::from_utf8_lossy(id));
}

/// Acrescenta ao arquivo um COMM — a anotação que alguém escreveu e que este
/// produto não pode perder.
fn anotar(path: &Path, lang: [u8; 3], desc: &str, texto: &str) {
    use lofty::config::WriteOptions;
    use lofty::id3::v2::{CommentFrame, Frame};
    use lofty::tag::TagExt;
    use lofty::TextEncoding;

    let mut tag = id3_tag(path);
    tag.insert(Frame::Comment(CommentFrame::new(
        TextEncoding::UTF8,
        lang,
        desc.to_string(),
        texto.to_string(),
    )));
    tag.save_to_path(path, WriteOptions::default()).unwrap();
}

/// (idioma, texto) do COMM de descrição `desc`, lido do arquivo.
fn comentario(path: &Path, desc: &str) -> Option<([u8; 3], String)> {
    use lofty::id3::v2::Frame;
    (&id3_tag(path)).into_iter().find_map(|f| match f {
        Frame::Comment(c) if c.description == desc => Some((c.language, c.content.clone())),
        _ => None,
    })
}

/// (idioma, texto) do primeiro USLT do arquivo.
fn uslt(path: &Path) -> Option<([u8; 3], String)> {
    id3_tag(path)
        .unsync_text()
        .next()
        .map(|f| (f.language, f.content.clone()))
}

const ANOTACAO: &str = "não sei quem canta, perguntar ao Dona Alzira";

/// O caso do campo: gravar num MP3 cujo COMM tem idioma `[0,0,0]` PASSA, o
/// texto da anotação sobrevive inteiro (o quadro é consertado, não descartado)
/// e o áudio não é tocado.
#[test]
fn write_tags_conserta_idioma_invalido_em_vez_de_recusar_o_arquivo() {
    let (dir, conn, _folder_id) = setup();
    let song = song_by_suffix(&conn, "com_letra.mp3");
    let path = PathBuf::from(&song.file_path);
    marcar_transcricao_com_capa(&path);
    anotar(&path, *b"eng", "anotacao", ANOTACAO);
    por_idioma_no_quadro(&path, b"COMM", 0, [0, 0, 0]);
    assert_eq!(
        comentario(&path, "anotacao").unwrap().0,
        [0, 0, 0],
        "o arquivo precisa entrar no teste com o defeito"
    );
    let audio_antes = audio_bytes(&path);

    let atualizada = writer::write_tags(
        &conn,
        song.id,
        "Apologia ao Jumento",
        Some("Luiz Gonzaga"),
        db::get_lyrics(&conn, song.id).unwrap().as_deref(),
        Some("humor"),
        None,
    )
    .expect("um idioma inválido não pode impedir a curadoria da música").song;

    assert_eq!(atualizada.title, "Apologia ao Jumento");

    // o quadro alheio sobreviveu INTEIRO, só com o idioma consertado
    let (lang, texto) = comentario(&path, "anotacao").expect("a anotação não pode ser descartada");
    assert_eq!(texto, ANOTACAO);
    assert_eq!(&lang, b"und", "idioma desconhecido vira `und`, o valor do padrão");

    // e nada mais mudou
    frames_alheios_intactos(&path);
    assert_eq!(audio_bytes(&path), audio_antes, "o áudio não pode ser tocado");
    let mut nomes: Vec<String> = fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    nomes.sort();
    assert_eq!(nomes, vec!["com_letra.mp3", "sem_letra.mp3", "sem_tags.mp3"]);
}

/// Idioma VÁLIDO não é mexido: o conserto vale só para o que está quebrado.
/// Sem isto o produto normalizaria o acervo inteiro para `und`, apagando a
/// informação de idioma que alguém gravou de propósito.
#[test]
fn write_tags_nao_mexe_em_idioma_valido() {
    let (_dir, conn, _folder_id) = setup();
    let song = song_by_suffix(&conn, "com_letra.mp3");
    let path = PathBuf::from(&song.file_path);
    anotar(&path, *b"eng", "anotacao", ANOTACAO);
    anotar(&path, *b"spa", "outra", "otra anotación");

    writer::write_tags(&conn, song.id, "Título Novo", None, None, None, None).unwrap();

    assert_eq!(comentario(&path, "anotacao").unwrap().0, *b"eng");
    assert_eq!(comentario(&path, "outra").unwrap().0, *b"spa");
}

/// USLT com idioma inválido: a gravação passa e a LETRA sobrevive inteira.
///
/// Honestidade sobre o que este teste prova: por FORA, o `write_tags` sempre
/// remove e regrava o USLT (com `por`), então um USLT quebrado nunca chega ao
/// `save`, e este teste passaria mesmo sem o conserto. Ele fica como guarda do
/// desfecho que interessa a quem cura — a letra não some. Quem cobre o conserto
/// do USLT em si é o teste unitário
/// `writer::tests::o_conserto_troca_so_o_idioma_quebrado_e_nao_perde_quadro`,
/// que chama a função direto.
#[test]
fn write_tags_conserta_idioma_invalido_do_uslt_sem_perder_a_letra() {
    let (_dir, conn, folder_id) = setup();
    let song = song_by_suffix(&conn, "com_letra.mp3");
    let path = PathBuf::from(&song.file_path);
    let letra = db::get_lyrics(&conn, song.id).unwrap().expect("fixture tem letra");
    por_idioma_no_quadro(&path, b"USLT", 0, [0, 0, 0]);
    assert_eq!(uslt(&path).unwrap().0, [0, 0, 0]);

    // o caminho do lote: repassa a MESMA letra e só troca o nome
    writer::write_tags(
        &conn,
        song.id,
        "Apologia ao Jumento",
        Some("Luiz Gonzaga"),
        Some(&letra),
        None,
        None,
    )
    .expect("idioma inválido no USLT não pode impedir a gravação");

    let (lang, texto) = uslt(&path).expect("a letra não pode ser descartada");
    assert_eq!(texto, letra);
    assert_eq!(&lang, b"por", "o USLT que o produto grava é sempre `por`");

    indexer::scan_folder(&conn, folder_id, |_, _| {}).unwrap();
    assert_eq!(
        db::get_lyrics(&conn, song.id).unwrap().as_deref(),
        Some(letra.as_str())
    );
}

/// Duas anotações com a MESMA descrição e idiomas inválidos DIFERENTES: o
/// conserto levaria as duas à mesma chave (`und` + a descrição), e o lofty
/// guarda uma só — apagaria a anotação de alguém. Medido: `insert` devolve a
/// substituída e o quadro some.
///
/// A regra inviolável ganha: o produto RECUSA a gravação, em pt-BR, e não
/// toca no arquivo. Recusar é ruim; apagar em silêncio é pior.
#[test]
fn write_tags_recusa_em_vez_de_fundir_duas_anotacoes_no_conserto() {
    let (_dir, conn, _folder_id) = setup();
    let song = song_by_suffix(&conn, "com_letra.mp3");
    let path = PathBuf::from(&song.file_path);
    anotar(&path, *b"eng", "anotacao", "PRIMEIRA anotação");
    anotar(&path, *b"deu", "anotacao", "SEGUNDA anotação");
    por_idioma_no_quadro(&path, b"COMM", 0, [0, 0, 0]);
    por_idioma_no_quadro(&path, b"COMM", 1, [0, 0, 1]);
    let bytes_antes = fs::read(&path).unwrap();

    let err = writer::write_tags(&conn, song.id, "Título Novo", None, None, None, None)
        .expect_err("fundir duas anotações numa só é apagar dado existente");

    assert_eq!(
        err.to_string(),
        format!(
            "não foi possível salvar em {}: {}",
            song.file_path,
            writer::ERRO_ANOTACOES_INDISTINGUIVEIS
        )
    );
    assert_eq!(
        fs::read(&path).unwrap(),
        bytes_antes,
        "gravação recusada não pode tocar no arquivo"
    );
}

// ---------------------------------------------------------------------------
// V10.1 — as falhas da GRAVAÇÃO falam pt-BR (mesma família do achado M4 do QA
// da v0.9.0, corrigido só no caminho do download).
//
// Quem cura são ~40 pessoas sem suporte: a mensagem na tela é a única
// explicação que elas vão receber, e ela precisa dizer o que aconteceu, o que
// fazer, e DE QUAL MÚSICA se trata (o caminho do arquivo fica).
// ---------------------------------------------------------------------------

/// Arquivo que o lofty não entende: a mensagem é pt-BR inteira, cita o arquivo
/// e não repassa o texto da biblioteca.
///
/// **V10.7 — e ela não fala mais de disco desconectado.** O arquivo está aqui,
/// foi aberto e foi lido; o que falhou foi entender o que há dentro dele. A
/// frase antiga mandava conferir o cabo do HD externo neste caminho, que é
/// mexer no que está certo — e o disco, quando ele é o problema, chega como
/// `io::Error` e tem frase própria (`ERRO_ARQUIVO_SUMIU`).
#[test]
fn write_tags_explica_em_portugues_um_mp3_que_nao_da_para_ler() {
    let (_dir, conn, _folder_id) = setup();
    let song = song_by_suffix(&conn, "sem_letra.mp3");
    // o arquivo continua existindo e com o mesmo nome — o conteúdo é que não é
    // um MP3 (cópia interrompida, ou um arquivo de outro formato com nome de
    // .mp3, que TOCA no aplicativo e só a gravação de etiqueta recusa)
    copy_fixture("corrompido.mp3", Path::new(&song.file_path));

    let err = writer::write_tags(&conn, song.id, "Título", None, None, None, None)
        .expect_err("arquivo que o lofty não entende não pode ser gravado");

    assert_eq!(
        err.to_string(),
        format!(
            "não foi possível salvar em {}: {}",
            song.file_path,
            writer::ERRO_ESTRUTURA_DO_MP3
        )
    );
    assert!(
        err.to_string().contains(&song.file_path),
        "sem o caminho, a pessoa não sabe de qual música a mensagem fala"
    );
    // e a mensagem inteira não manda ninguém mexer no HD externo
    for palavra in ["disco", "desconect", "cabo"] {
        assert!(
            !err.to_string().contains(palavra),
            "o arquivo foi lido com sucesso: nada aqui é do aparelho ({palavra})"
        );
    }
}

// Falta de permissão, disco cheio e as demais falhas de sistema são traduzidas
// em `writer::frase_de_io`/`frase_de_lofty`, com teste unitário por caso no
// próprio módulo. NÃO há teste de integração para elas de propósito: tirar o
// bit de escrita da pasta não impede nada quando a suíte roda como root (é o
// caso no contêiner de desenvolvimento e no CI), então o teste passaria ou
// falharia conforme quem o rodou — a "falha fantasma" que a DECISIONS #77 saiu
// para acabar. A ponte entre a falha real e a frase é o `map_err` de cada
// chamada, e ela é curta o bastante para ser lida.

// ---------------------------------------------------------------------------
// V10.8 — a SOBRA entre o fim declarado da etiqueta e o primeiro quadro MPEG.
//
// Sete arquivos de um acervo real recusavam TODA gravação, e a causa foi medida
// arquivo por arquivo: a etiqueta ID3v2 declara terminar num byte que não
// alcança o primeiro quadro MPEG, e no meio sobra uma região que não é etiqueta
// declarada, não é cabeçalho de codificador e não é áudio. No arquivo medido: a
// etiqueta declarando terminar em 4.096 e o primeiro quadro em 5.347.
//
// O que decide a recusa é a relação com o teto de "bytes de lixo" da biblioteca
// (`ParseOptions::DEFAULT_MAX_JUNK_BYTES` = 1.024 no lofty 0.22): ao GRAVAR, o
// lofty reexamina o formato pelo CONTEÚDO, procura o sync de MPEG só dentro
// desse teto depois do fim declarado da etiqueta, não acha, e devolve
// `UnknownFormat`. Ao LER não há teto nenhum — é por isso que estes arquivos
// tocam, aparecem na lista com título e artista, e só a gravação falha.
//
// Os testes desta seção são a prova de que a fixture reproduz o defeito ANTES
// do conserto. Sem essa prova o resto da seção poderia passar por qualquer
// outro motivo, que é o erro que já nos custou uma versão inteira (o teste de
// fumaça que "passava" sem passar o modelo).
// ---------------------------------------------------------------------------

/// A fixture da anomalia, num acervo só dela.
///
/// Acervo próprio, e não um item a mais no `setup()`: metade dos testes deste
/// arquivo conta as músicas indexadas, e um arquivo novo na pasta comum mudaria
/// a contagem de todos eles.
fn setup_da_sobra() -> (tempfile::TempDir, Connection, db::Song) {
    let dir = tempfile::tempdir().unwrap();
    copy_fixture(
        "sobra_antes_do_audio.mp3",
        &dir.path().join("sobra_antes_do_audio.mp3"),
    );
    let conn = db::open_in_memory().unwrap();
    let folder_id = db::add_folder(&conn, dir.path().to_str().unwrap()).unwrap();
    indexer::scan_folder(&conn, folder_id, |_, _| {}).unwrap();
    let song = song_by_suffix(&conn, "sobra_antes_do_audio.mp3");
    (dir, conn, song)
}

/// Fim DECLARADO do bloco ID3v2 (10 de cabeçalho + o tamanho synchsafe).
fn fim_declarado_da_etiqueta(bytes: &[u8]) -> usize {
    assert_eq!(&bytes[..3], b"ID3", "a fixture precisa começar com uma etiqueta");
    10 + (((bytes[6] as usize) << 21)
        | ((bytes[7] as usize) << 14)
        | ((bytes[8] as usize) << 7)
        | (bytes[9] as usize))
}

/// A ESTRUTURA da fixture é a que foi medida em campo — e é ela, não o tamanho
/// da etiqueta, que causa a recusa.
///
/// Este teste não exercita nada do produto: ele existe para que a fixture não
/// possa envelhecer em silêncio. Se um dia o gerador encolher a sobra para
/// menos que o teto de lixo do lofty, a gravação passará a funcionar sozinha e o
/// teste do conserto viraria um teste de nada.
#[test]
fn a_fixture_da_sobra_tem_a_estrutura_medida_em_campo() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("x.mp3");
    copy_fixture("sobra_antes_do_audio.mp3", &path);
    let bytes = fs::read(&path).unwrap();

    let fim = fim_declarado_da_etiqueta(&bytes);
    assert_eq!(fim, 4096, "a etiqueta declara terminar onde ela declarava em campo");

    // o primeiro quadro MPEG de verdade: sync + versão/camada válidas, e o
    // quadro seguinte batendo no comprimento calculado (a mesma conferência de
    // dois quadros que o lofty faz — um `FF Fx` solto não é quadro)
    let primeiro = bytes[fim..]
        .windows(2)
        .position(|j| j[0] == 0xFF && j[1] & 0xE0 == 0xE0)
        .map(|p| fim + p)
        .expect("a fixture precisa ter áudio MPEG de verdade depois da sobra");
    assert_eq!(primeiro, 5347, "o primeiro quadro começa onde começava em campo");

    let sobra = primeiro - fim;
    assert_eq!(sobra, 1251, "a sobra medida em campo tinha 1.251 bytes");
    assert!(
        sobra > 1024,
        "a sobra precisa passar do teto de lixo do lofty ({sobra} bytes): abaixo dele \
         a gravação funciona e a fixture deixa de reproduzir o defeito"
    );
    let zeros = bytes[fim..primeiro].iter().filter(|b| **b == 0).count();
    assert!(
        zeros * 100 / sobra >= 75,
        "a sobra medida era quase toda de zeros, com bytes aleatórios por cima"
    );
}

/// **A prova de que a fixture reproduz o defeito.**
///
/// Ler passa: é por isso que estes arquivos tocam e aparecem na lista com
/// título e artista, e é por isso que ninguém suspeita deles até mandar gravar.
/// Gravar falha com `UnknownFormat` — o mesmo desfecho que os sete arquivos do
/// relato devolviam, e a razão pela qual aquelas músicas saíam da curadoria
/// para sempre.
#[test]
fn a_fixture_da_sobra_le_mas_recusa_a_gravacao_com_unknown_format() {
    use lofty::config::{ParseOptions, WriteOptions};
    use lofty::error::ErrorKind;
    use lofty::file::AudioFile;
    use lofty::tag::{Accessor, TagExt};

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("sobra_antes_do_audio.mp3");
    copy_fixture("sobra_antes_do_audio.mp3", &path);

    // 1. a LEITURA passa, e devolve a etiqueta inteira
    let lido = lofty::mpeg::MpegFile::read_from(
        &mut fs::File::open(&path).unwrap(),
        ParseOptions::new(),
    )
    .expect("o arquivo do relato é lido sem reclamação — é por isso que ele toca");
    let tag = lido.id3v2().cloned().expect("a etiqueta declarada é lida");
    assert_eq!(
        tag.title().as_deref(),
        Some("Sobra Antes do Áudio"),
        "o título chega à lista, e nada na tela sugere que algo está errado"
    );

    // 2. a GRAVAÇÃO falha, e falha com UnknownFormat
    let bytes_antes = fs::read(&path).unwrap();
    let erro = tag
        .save_to_path(&path, WriteOptions::default())
        .expect_err("é ESTA recusa que o conserto desta versão existe para resolver");
    assert!(
        matches!(erro.kind(), ErrorKind::UnknownFormat),
        "o defeito medido é UnknownFormat, e não outro: {erro}"
    );

    // 3. e a recusa não escreve nada: o arquivo fica byte a byte igual
    assert_eq!(
        fs::read(&path).unwrap(),
        bytes_antes,
        "a recusa do lofty acontece antes de o arquivo ser tocado"
    );
}

/// Os bytes de ÁUDIO da fixture, contados do primeiro quadro MPEG até o fim.
///
/// Definição diferente da do `audio_bytes` de propósito: neste arquivo o fim
/// DECLARADO da etiqueta não é onde o áudio começa — é justamente essa diferença
/// que é o defeito. Depois da gravação as duas contas coincidem, e é assim que a
/// comparação prova algo.
fn audio_da_fixture_com_sobra(bytes: &[u8]) -> Vec<u8> {
    let fim = fim_declarado_da_etiqueta(bytes);
    let primeiro = bytes[fim..]
        .windows(2)
        .position(|j| j[0] == 0xFF && j[1] & 0xE0 == 0xE0)
        .map(|p| fim + p)
        .expect("a fixture tem áudio MPEG");
    bytes[primeiro..].to_vec()
}

/// **O caso do campo, do começo ao fim.** Gravar uma letra num arquivo com a
/// sobra PASSA, a letra vai para o disco, e o áudio continua byte a byte o
/// mesmo — comparado inteiro, e não por um resumo, que é a prova mais forte
/// disponível num teste.
#[test]
fn write_tags_grava_no_arquivo_com_sobra_sem_tocar_no_audio() {
    let (_dir, conn, song) = setup_da_sobra();
    let path = PathBuf::from(&song.file_path);
    let audio_antes = audio_da_fixture_com_sobra(&fs::read(&path).unwrap());
    assert_eq!(
        audio_antes.len(),
        16_508,
        "o áudio da fixture é o mesmo tom que o sem_tags.mp3"
    );

    let gravacao = writer::write_tags(
        &conn,
        song.id,
        "Ponto de Oxum",
        Some("Grupo Fixture"),
        Some("uma letra que alguém escreveu à mão"),
        Some("água"),
        None,
    )
    .expect("a sobra entre a etiqueta e o áudio não pode impedir a curadoria da música");

    // 1. o que a pessoa pediu está no arquivo, lido de volta pelo indexador
    assert_eq!(gravacao.song.title, "Ponto de Oxum");
    assert_eq!(gravacao.song.artist.as_deref(), Some("Grupo Fixture"));
    assert!(gravacao.song.has_lyrics);
    assert_eq!(gravacao.song.temas.as_deref(), Some("água"));
    assert_eq!(
        db::get_lyrics(&conn, song.id).unwrap().as_deref(),
        Some("uma letra que alguém escreveu à mão")
    );

    // 2. o ÁUDIO é o mesmo. Depois da gravação o fim declarado da etiqueta
    //    passou a ser onde o áudio começa — o defeito não existe mais no arquivo
    assert_eq!(
        audio_bytes(&path),
        audio_antes,
        "nenhum byte de áudio pode mudar: é a regra inviolável do projeto"
    );

    // 3. e o arquivo continua com o mesmo nome, no mesmo lugar
    assert!(path.is_file());
    assert!(path.ends_with("sobra_antes_do_audio.mp3"));
}

/// **O desfecho DIZ o que foi feito.** A gravação que precisou normalizar a
/// etiqueta devolve a frase; a gravação comum não devolve nada.
///
/// O par é o teste: um `aviso` que aparecesse sempre seria ruído que se aprende
/// a ignorar, e um que nunca aparecesse seria o segredo que esta versão existe
/// para não guardar.
#[test]
fn a_gravacao_que_normalizou_a_etiqueta_conta_isso_e_a_comum_nao() {
    let (_dir, conn, song) = setup_da_sobra();
    let gravacao =
        writer::write_tags(&conn, song.id, "Com Sobra", None, None, None, None).unwrap();
    assert_eq!(
        gravacao.aviso,
        Some(writer::AVISO_ETIQUETA_NORMALIZADA),
        "quem mexeu num byte que ninguém pediu para mexer precisa dizer isso"
    );

    // o arquivo normal do acervo: nada aconteceu, e não há nada a contar
    let (_dir2, conn2, _folder) = setup();
    let normal = song_by_suffix(&conn2, "com_letra.mp3");
    let comum = writer::write_tags(
        &conn2,
        normal.id,
        "Sem Sobra",
        None,
        db::get_lyrics(&conn2, normal.id).unwrap().as_deref(),
        None,
        None,
    )
    .unwrap();
    assert_eq!(comum.aviso, None, "gravação comum não tem nada a avisar");
}

/// A segunda gravação do MESMO arquivo é comum: o conserto acontece uma vez, e a
/// anomalia não volta.
///
/// Importa porque a curadoria grava a mesma música mais de uma vez (o nome
/// primeiro, a letra depois), e um aviso repetido a cada gravação viraria ruído
/// sobre um arquivo que já está são.
#[test]
fn depois_do_conserto_o_arquivo_grava_como_qualquer_outro() {
    let (_dir, conn, song) = setup_da_sobra();
    let primeira =
        writer::write_tags(&conn, song.id, "Primeira", None, None, None, None).unwrap();
    assert_eq!(primeira.aviso, Some(writer::AVISO_ETIQUETA_NORMALIZADA));
    let audio = audio_bytes(&PathBuf::from(&song.file_path));

    let segunda = writer::write_tags(
        &conn,
        song.id,
        "Segunda",
        Some("Artista"),
        Some("a letra, agora"),
        None,
        None,
    )
    .expect("o arquivo consertado grava como qualquer outro");
    assert_eq!(
        segunda.aviso, None,
        "a anomalia não existe mais: avisar de novo seria ruído"
    );
    assert_eq!(segunda.song.title, "Segunda");
    assert_eq!(
        audio_bytes(&PathBuf::from(&song.file_path)),
        audio,
        "a segunda gravação também não toca no áudio"
    );
}

/// **O conserto não é uma desculpa para aceitar qualquer arquivo.** O `.mp3` que
/// nunca foi MPEG falha com o MESMO `UnknownFormat` e continua recusado, com a
/// frase da estrutura e sem um byte alterado.
///
/// É o teste que impede o conserto de virar "tentar de novo mais forte": ele só
/// vale para a anomalia que foi medida, e o gatilho compartilhado com outra
/// causa é exatamente onde um conserto cego estragaria um arquivo.
#[test]
fn o_arquivo_que_nunca_foi_mpeg_continua_recusado_em_portugues() {
    let (_dir, conn, _folder_id) = setup();
    let song = song_by_suffix(&conn, "sem_letra.mp3");
    copy_fixture("corrompido.mp3", Path::new(&song.file_path));
    let bytes_antes = fs::read(&song.file_path).unwrap();

    let err = writer::write_tags(&conn, song.id, "Título", None, None, None, None)
        .expect_err("arquivo que não é MPEG não tem conserto nenhum");
    assert_eq!(
        err.to_string(),
        format!(
            "não foi possível salvar em {}: {}",
            song.file_path,
            writer::ERRO_ESTRUTURA_DO_MP3
        )
    );
    assert_eq!(
        fs::read(&song.file_path).unwrap(),
        bytes_antes,
        "a recusa não pode deixar o arquivo diferente do que era"
    );
}

/// A sobra que carrega OUTRA ETIQUETA não é absorvida: recusa, e o arquivo fica
/// intacto.
///
/// Absorver a sobra faz o lofty reescrever aquela região na gravação — e se o
/// que estava ali era a etiqueta APE de alguém, o conserto apagaria dado
/// existente para poder gravar. Recusar é ruim (a música continua sem poder ser
/// curada); apagar é a regra que não se quebra.
#[test]
fn a_sobra_que_carrega_outra_etiqueta_nao_e_absorvida() {
    let (_dir, conn, song) = setup_da_sobra();
    let path = PathBuf::from(&song.file_path);

    // planta a assinatura de uma etiqueta APE no meio da sobra, sem mudar o
    // tamanho do arquivo nem a posição de nada
    let mut bytes = fs::read(&path).unwrap();
    let fim = fim_declarado_da_etiqueta(&bytes);
    bytes[fim + 400..fim + 408].copy_from_slice(b"APETAGEX");
    fs::write(&path, &bytes).unwrap();

    let err = writer::write_tags(&conn, song.id, "Título", None, None, None, None)
        .expect_err("uma etiqueta alheia na sobra não pode ser absorvida");
    assert_eq!(
        err.to_string(),
        format!(
            "não foi possível salvar em {}: {}",
            song.file_path,
            writer::ERRO_ESTRUTURA_DO_MP3
        )
    );
    assert_eq!(
        fs::read(&path).unwrap(),
        bytes,
        "a recusa não escreve nada, nem o campo de tamanho"
    );
}
/// **O que acontece com a sobra, medido e escrito.**
///
/// Depois do conserto, a região passa a estar DENTRO do bloco declarado — e o
/// bloco declarado é exatamente o que a biblioteca reescreve em toda gravação de
/// etiqueta, em qualquer arquivo. Então a sobra não sobrevive à gravação.
///
/// Isso está registrado aqui, e não escondido, porque é a única coisa que o
/// conserto muda no arquivo além do que a pessoa pediu. O que se afirma é o que
/// foi medido: o áudio é o mesmo byte a byte, a etiqueta é a nova, e o arquivo
/// fica MENOR — a etiqueta de 4.096 bytes vira a etiqueta enxuta que o lofty
/// escreve (com o enchimento de 1.024 que ele usa por padrão), que é o que
/// acontece com QUALQUER arquivo de etiqueta grande que se grave, com sobra ou
/// sem ela.
#[test]
fn o_conserto_absorve_a_sobra_e_o_audio_e_o_unico_intocado() {
    let (_dir, conn, song) = setup_da_sobra();
    let path = PathBuf::from(&song.file_path);
    let antes = fs::read(&path).unwrap();
    let audio_antes = audio_da_fixture_com_sobra(&antes);

    writer::write_tags(&conn, song.id, "T", None, None, None, None).unwrap();

    let depois = fs::read(&path).unwrap();
    let fim = fim_declarado_da_etiqueta(&depois);
    assert_eq!(
        &depois[fim..],
        &audio_antes[..],
        "o áudio é o mesmo, e agora começa exatamente onde a etiqueta termina"
    );
    assert_eq!(
        depois.len() - fim,
        16_508,
        "o áudio continua tendo o tamanho que tinha"
    );
    assert!(
        depois.len() < antes.len(),
        "o arquivo encolhe: a etiqueta de 4.096 bytes e a sobra de 1.251 dão lugar \
         à etiqueta nova ({} bytes) — o mesmo que acontece com qualquer etiqueta \
         grande que se regrave",
        fim
    );
}
