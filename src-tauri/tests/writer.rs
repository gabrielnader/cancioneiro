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
    .unwrap();
    assert_eq!(updated.title, "Só Título");
    assert_eq!(updated.artist, None);
    assert!(!updated.has_lyrics);
    assert_eq!(updated.temas, None);
    assert_eq!(db::get_lyrics(&conn, song.id).unwrap(), None);

    // regrava com tudo e depois remove com None
    writer::write_tags(&conn, song.id, "Cheio", Some("A"), Some("letra"), Some("tema"), None)
        .unwrap();
    let cleared = writer::write_tags(&conn, song.id, "Cheio", None, None, None, None).unwrap();
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
    fs::copy(fixtures_dir().join("com_letra.mp3"), sub.join("com_letra.mp3")).unwrap();

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
            .unwrap();
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
    .unwrap();

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
    .unwrap();

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
    .unwrap();
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
    .unwrap();
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
    .unwrap();

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
    .unwrap();
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
    .unwrap();
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

    let updated =
        writer::write_tags(&conn, song.id, "T", None, None, None, Some(false)).unwrap();
    assert_eq!(instrumental_frame(&path), None);
    assert!(!updated.instrumental);
}
