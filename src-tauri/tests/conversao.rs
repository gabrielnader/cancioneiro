//! V16.4 — "Consertar o arquivo": o .mp3 que por dentro é WAV ou M4A vira MP3
//! de verdade, com o original guardado na pasta do app e o "Voltar ao som
//! original". O que se prova: o som do MP3 dentro de WAV não muda NADA; o
//! recodificado tem a mesma duração; o texto do original chega à etiqueta; o
//! "Voltar" devolve o arquivo byte por byte; e o arquivo que está tocando, ou
//! que mudou no meio, não é trocado.

use cancioneiro_lib::conversao::{self, Conteudo};
use cancioneiro_lib::{db, indexer, pacote, writer};
use rusqlite::Connection;
use std::fs;
use std::path::{Path, PathBuf};

mod common;
use common::copy_fixture;

fn audio_mp3(nome: &str, dir: &Path) -> Vec<u8> {
    let tmp = dir.join(format!("{nome}.fonte"));
    copy_fixture(nome, &tmp);
    let b = fs::read(&tmp).unwrap();
    fs::remove_file(&tmp).unwrap();
    let t = if &b[..3] == b"ID3" {
        10 + (((b[6] as usize) << 21) | ((b[7] as usize) << 14) | ((b[8] as usize) << 7) | b[9] as usize)
    } else {
        0
    };
    b[t..].to_vec()
}

fn bloco(id: &[u8], corpo: &[u8]) -> Vec<u8> {
    let mut c = id.to_vec();
    c.extend_from_slice(&(corpo.len() as u32).to_le_bytes());
    c.extend_from_slice(corpo);
    if corpo.len() % 2 == 1 {
        c.push(0);
    }
    c
}

fn riff(formato: u16, canais: u16, taxa: u32, bits: u16, info: bool, dados: &[u8]) -> Vec<u8> {
    let mut fmt = Vec::new();
    fmt.extend_from_slice(&formato.to_le_bytes());
    fmt.extend_from_slice(&canais.to_le_bytes());
    fmt.extend_from_slice(&taxa.to_le_bytes());
    fmt.extend_from_slice(&(taxa * canais as u32 * bits as u32 / 8).to_le_bytes());
    fmt.extend_from_slice(&(canais * bits / 8).to_le_bytes());
    fmt.extend_from_slice(&bits.to_le_bytes());
    let mut corpo = b"WAVE".to_vec();
    corpo.extend(bloco(b"fmt ", &fmt));
    if info {
        let mut lista = b"INFO".to_vec();
        lista.extend(bloco(b"INAM", b"Manto Azul\0"));
        lista.extend(bloco(b"IART", b"Paulinho Pedra Azul\0"));
        corpo.extend(bloco(b"LIST", &lista));
    }
    corpo.extend(bloco(b"data", dados));
    let mut a = b"RIFF".to_vec();
    a.extend_from_slice(&(corpo.len() as u32).to_le_bytes());
    a.extend(corpo);
    a
}

/// "Cores - Manto azul": MP3 embrulhado num WAV, com nome .mp3.
fn mp3_em_wav(path: &Path) -> Vec<u8> {
    let audio = audio_mp3("com_letra.mp3", path.parent().unwrap());
    fs::write(path, riff(0x55, 2, 44100, 0, true, &audio)).unwrap();
    audio
}

/// WAV de verdade: 3 s de um tom, 44,1 kHz, estéreo, 16 bits.
fn wav_pcm(path: &Path) {
    let mut pcm = Vec::new();
    for i in 0..(44100 * 3) {
        let v = ((i as f32 * 440.0 * std::f32::consts::TAU / 44100.0).sin() * 8000.0) as i16;
        pcm.extend_from_slice(&v.to_le_bytes());
        pcm.extend_from_slice(&v.to_le_bytes());
    }
    fs::write(path, riff(1, 2, 44100, 16, false, &pcm)).unwrap();
}

fn biblioteca(dir: &Path) -> Connection {
    let conn = db::open_in_memory().unwrap();
    let id = db::add_folder(&conn, dir.to_str().unwrap()).unwrap();
    indexer::scan_folder(&conn, id, |_, _| {}).unwrap();
    conn
}

fn musica(conn: &Connection, sufixo: &str) -> db::Song {
    db::list_songs(conn).unwrap().into_iter().find(|s| s.file_path.ends_with(sufixo)).unwrap()
}

struct Lugar {
    _musicas: tempfile::TempDir,
    _app: tempfile::TempDir,
    temporarios: PathBuf,
    copias: PathBuf,
}

fn lugar() -> (Lugar, PathBuf) {
    let musicas = tempfile::tempdir().unwrap();
    let app = tempfile::tempdir().unwrap();
    let dir = musicas.path().to_path_buf();
    let l = Lugar {
        temporarios: app.path().join("temporarios"),
        copias: app.path().join("arquivos-originais"),
        _musicas: musicas,
        _app: app,
    };
    (l, dir)
}

fn consertar(conn: &Connection, l: &Lugar, s: &db::Song) -> db::Song {
    let p = conversao::preparar(Path::new(&s.file_path), &l.temporarios).expect("prepara");
    conversao::trocar(conn, s, &p, &l.copias).expect("troca")
}

fn depois_da_etiqueta(b: &[u8]) -> &[u8] {
    assert_eq!(&b[..3], b"ID3");
    let t = 10 + (((b[6] as usize) << 21) | ((b[7] as usize) << 14) | ((b[8] as usize) << 7) | b[9] as usize);
    &b[t..]
}

#[test]
fn reconhece_o_que_o_arquivo_e_por_dentro() {
    let (_l, dir) = lugar();
    let a = dir.join("a.mp3");
    mp3_em_wav(&a);
    assert_eq!(conversao::conteudo_do_arquivo(&a), Conteudo::Mp3EmWav);
    let b = dir.join("b.mp3");
    wav_pcm(&b);
    assert_eq!(conversao::conteudo_do_arquivo(&b), Conteudo::Wav);
    let c = dir.join("c.mp3");
    fs::copy(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/dados/m4a_com_nome_de_mp3.mp3"), &c).unwrap();
    assert_eq!(conversao::conteudo_do_arquivo(&c), Conteudo::Mp4);
    let d = dir.join("d.mp3");
    copy_fixture("com_letra.mp3", &d);
    assert_eq!(conversao::conteudo_do_arquivo(&d), Conteudo::Mp3);

    let conn = biblioteca(&dir);
    let mut lista = conversao::musicas_para_consertar(&conn).unwrap();
    lista.sort_by_key(|(id, _)| *id);
    assert_eq!(lista.len(), 3);
}

#[test]
fn mp3_dentro_de_wav_sai_da_caixa_sem_mudar_o_som_e_aceita_a_letra() {
    let (l, dir) = lugar();
    let path = dir.join("Cores - Manto azul.mp3");
    let audio = mp3_em_wav(&path);
    let original = fs::read(&path).unwrap();
    let conn = biblioteca(&dir);
    let s = musica(&conn, "Manto azul.mp3");

    let s = consertar(&conn, &l, &s);
    let novo = fs::read(&path).unwrap();
    assert_eq!(depois_da_etiqueta(&novo), &audio[..], "o som é o mesmo, byte por byte");
    assert_eq!(s.title, "Manto Azul", "o nome escrito no WAV chegou à etiqueta");
    assert_eq!(s.artist.as_deref(), Some("Paulinho Pedra Azul"));
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 1, "nada foi criado na pasta das músicas");

    // agora grava como qualquer MP3
    writer::write_tags(&conn, s.id, &s.title, s.artist.as_deref(), Some("a letra"), None, None).unwrap();
    assert!(db::get_song(&conn, s.id).unwrap().unwrap().has_lyrics);

    // o original está guardado e volta byte por byte
    let copia = conversao::copia_guardada(&conn, s.id).unwrap().expect("cópia guardada");
    assert_eq!(fs::read(&copia).unwrap(), original);
    assert_eq!(conversao::copias_guardadas(&conn).unwrap(), (1, original.len() as u64));
    let s = conversao::voltar_ao_original(&conn, &s).unwrap();
    assert_eq!(fs::read(&path).unwrap(), original);
    assert!(!copia.exists(), "a cópia sai da pasta do app");
    assert!(conversao::copia_guardada(&conn, s.id).unwrap().is_none());
}

#[test]
fn wav_de_verdade_vira_mp3_da_mesma_duracao() {
    let (l, dir) = lugar();
    let path = dir.join("gravacao.mp3");
    wav_pcm(&path);
    let conn = biblioteca(&dir);
    let s = consertar(&conn, &l, &musica(&conn, "gravacao.mp3"));
    assert_eq!(conversao::conteudo_do_arquivo(&path), Conteudo::Mp3);
    let d = s.duration_seconds.expect("duração");
    assert!((d - 3).abs() <= 1, "duração {d}");
    writer::write_tags(&conn, s.id, "Gravação", None, Some("letra"), None, None).unwrap();
}

#[test]
fn m4a_vira_mp3_com_o_que_estava_escrito() {
    let (l, dir) = lugar();
    let path = dir.join("m4a.mp3");
    fs::copy(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/dados/m4a_com_nome_de_mp3.mp3"), &path).unwrap();
    let conn = biblioteca(&dir);
    let s = consertar(&conn, &l, &musica(&conn, "m4a.mp3"));
    assert_eq!(conversao::conteudo_do_arquivo(&path), Conteudo::Mp3);
    assert_eq!(s.title, "Manto Azul");
    assert_eq!(s.artist.as_deref(), Some("Paulinho Pedra Azul"));
    assert_eq!(db::get_lyrics(&conn, s.id).unwrap().as_deref(), Some("Uma letra do m4a"));
    let d = s.duration_seconds.expect("duração");
    assert!((d - 3).abs() <= 1, "duração {d}");
}

#[test]
fn nao_troca_o_que_esta_tocando_nem_o_que_mudou_no_meio() {
    let (l, dir) = lugar();
    let path = dir.join("x.mp3");
    mp3_em_wav(&path);
    let original = fs::read(&path).unwrap();
    let conn = biblioteca(&dir);
    let s = musica(&conn, "x.mp3");
    let p = conversao::preparar(&path, &l.temporarios).unwrap();

    pacote::definir_tocando(Some(s.file_path.clone()));
    let r = conversao::trocar(&conn, &s, &p, &l.copias);
    pacote::definir_tocando(None);
    assert!(r.unwrap_err().to_string().contains("tocando"));
    assert_eq!(fs::read(&path).unwrap(), original);

    let mut mudado = original.clone();
    mudado.push(0);
    fs::write(&path, &mudado).unwrap();
    assert!(conversao::trocar(&conn, &s, &p, &l.copias).is_err());
    assert_eq!(fs::read(&path).unwrap(), mudado);
    assert_eq!(conversao::copias_guardadas(&conn).unwrap().0, 0, "nenhuma cópia ficou para trás");
}

#[test]
fn mp3_de_verdade_nao_e_consertado() {
    let (l, dir) = lugar();
    let path = dir.join("bom.mp3");
    copy_fixture("com_letra.mp3", &path);
    assert!(conversao::preparar(&path, &l.temporarios).is_err());
}

#[test]
fn apagar_as_copias_tira_o_voltar() {
    let (l, dir) = lugar();
    let path = dir.join("y.mp3");
    mp3_em_wav(&path);
    let conn = biblioteca(&dir);
    let s = consertar(&conn, &l, &musica(&conn, "y.mp3"));
    let copia = conversao::copia_guardada(&conn, s.id).unwrap().unwrap();
    conversao::apagar_copias(&conn).unwrap();
    assert!(!copia.exists());
    assert_eq!(conversao::copias_guardadas(&conn).unwrap(), (0, 0));
    assert!(conversao::voltar_ao_original(&conn, &s).is_err());
}

/// V16.5 — "Balançou o Roseiral": M4A em HE-AAC (o áudio de 48 kbps baixado do
/// YouTube). O AAC do symphonia recusava ("aac too complex") e o conserto dizia
/// "não foi possível ler o som". O FDK AAC lê.
#[test]
fn m4a_em_he_aac_tambem_e_consertado() {
    let (l, dir) = lugar();
    let path = dir.join("Balançou o Roseiral.mp3");
    fs::copy(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/dados/heaac_com_nome_de_mp3.mp3"), &path).unwrap();
    let conn = biblioteca(&dir);
    let s = consertar(&conn, &l, &musica(&conn, "Roseiral.mp3"));
    assert_eq!(conversao::conteudo_do_arquivo(&path), Conteudo::Mp3);
    assert_eq!(s.title, "Balançou o Roseiral");
    let d = s.duration_seconds.expect("duração");
    assert!((d - 3).abs() <= 1, "duração {d}");
}
