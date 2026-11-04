//! V16 — o pacote de letras do grupo: montar no app de quem organiza, aplicar
//! no app de cada pessoa. O que se prova aqui é o que ele SE RECUSA a fazer:
//! trocar o que alguém escreveu, gravar a música que está tocando, mexer no
//! áudio.

use cancioneiro_lib::{db, indexer, pacote, writer};
use rusqlite::Connection;
use std::fs;
use std::path::{Path, PathBuf};

mod common;
use common::copy_fixture;

/// O áudio (sem a etiqueta) de uma fixture.
fn audio_da_fixture(nome: &str, dir: &Path) -> Vec<u8> {
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

/// Um MP3 de ~300 KB sem etiqueta: o áudio da fixture repetido (quadros MPEG
/// repetidos continuam sendo áudio válido). `semente` muda o áudio, para duas
/// "gravações" diferentes terem digitais diferentes.
fn mp3_grande(path: &Path, semente: u8) {
    let audio = audio_da_fixture("com_letra.mp3", path.parent().unwrap());
    let mut a = Vec::new();
    for i in 0..15u8 {
        let mut pedaco = audio.clone();
        // mexe num byte de DADO de áudio (longe dos cabeçalhos) por semente
        let k = pedaco.len() / 2;
        pedaco[k] = pedaco[k].wrapping_add(semente).wrapping_add(i);
        a.extend(pedaco);
    }
    fs::write(path, a).unwrap();
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

fn audio_de(path: &str) -> Vec<u8> {
    let b = fs::read(path).unwrap();
    let t = if &b[..3] == b"ID3" {
        10 + (((b[6] as usize) << 21) | ((b[7] as usize) << 14) | ((b[8] as usize) << 7) | b[9] as usize)
    } else {
        0
    };
    b[t..].to_vec()
}

/// O acervo de quem organiza (com etiquetas) e a CÓPIA sem etiquetas de outra
/// pessoa: mesmo áudio, outros nomes de arquivo.
fn dois_acervos() -> (tempfile::TempDir, tempfile::TempDir, Connection, Connection) {
    let meu = tempfile::tempdir().unwrap();
    let dela = tempfile::tempdir().unwrap();
    for (n, nome) in [(1u8, "a.mp3"), (2, "b.mp3"), (3, "c.mp3")] {
        mp3_grande(&meu.path().join(nome), n);
        fs::copy(meu.path().join(nome), dela.path().join(format!("copia {nome}"))).unwrap();
    }
    let c_meu = biblioteca(meu.path());
    let a = musica(&c_meu, "a.mp3");
    writer::write_tags(&c_meu, a.id, "Asa Branca", Some("Luiz Gonzaga"), Some("Quando olhei a terra ardendo"), Some("sertão; seca"), None).unwrap();
    let b = musica(&c_meu, "b.mp3");
    writer::write_tags(&c_meu, b.id, "Carinhoso", Some("Pixinguinha"), Some("Meu coração, não sei por quê"), None, None).unwrap();
    let c = musica(&c_meu, "c.mp3");
    writer::write_tags(&c_meu, c.id, "Tema do Mar", None, None, None, Some(true)).unwrap();
    let c_dela = biblioteca(dela.path());
    (meu, dela, c_meu, c_dela)
}

#[test]
fn a_digital_nao_muda_quando_a_etiqueta_muda() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("x.mp3");
    mp3_grande(&path, 1);
    let antes = pacote::digital_do_audio(&path).expect("digital");
    let conn = biblioteca(dir.path());
    let s = musica(&conn, "x.mp3");
    writer::write_tags(&conn, s.id, "Um Nome", Some("Alguém"), Some("uma letra"), None, None).unwrap();
    assert_eq!(pacote::digital_do_audio(&path).as_deref(), Some(antes.as_str()));
    // e outra gravação tem outra digital
    let outro = dir.path().join("y.mp3");
    mp3_grande(&outro, 9);
    assert_ne!(pacote::digital_do_audio(&outro).unwrap(), antes);
}

#[test]
fn o_pacote_preenche_a_copia_de_outra_pessoa() {
    let (_m, _d, c_meu, c_dela) = dois_acervos();
    let bytes = pacote::montar(&c_meu, |_, _| {}).unwrap();
    let p = pacote::abrir(&bytes).expect("o pacote abre");
    assert_eq!(p.musicas.len(), 3);

    let r = pacote::aplicar(&c_dela, &p, |_, _| {}).unwrap();
    assert_eq!(r.reconhecidas, 3);
    assert_eq!(r.preenchidas, 3);
    assert_eq!(r.com_letra_nova, 2);

    let a = musica(&c_dela, "copia a.mp3");
    assert_eq!(a.title, "Asa Branca", "o nome do arquivo virou o nome de verdade");
    assert_eq!(a.artist.as_deref(), Some("Luiz Gonzaga"));
    assert!(a.has_lyrics);
    assert_eq!(db::get_lyrics(&c_dela, a.id).unwrap().as_deref(), Some("Quando olhei a terra ardendo"));
    assert!(a.temas.as_deref().unwrap_or("").contains("sertão"));
    assert!(musica(&c_dela, "copia c.mp3").instrumental, "a marca de instrumental chega");
}

#[test]
fn o_pacote_nunca_troca_o_que_a_pessoa_escreveu() {
    let (_m, _d, c_meu, c_dela) = dois_acervos();
    // ela já tinha escrito nome, quem canta e letra na cópia dela
    let a = musica(&c_dela, "copia a.mp3");
    writer::write_tags(&c_dela, a.id, "Asa Branca (versão dela)", Some("Ela Mesma"), Some("a letra que ela escreveu"), Some("forró"), None).unwrap();
    writer::gravar_anotacoes(&c_dela, a.id, "minha anotação").unwrap();
    let audio_antes = audio_de(&a.file_path);

    let p = pacote::abrir(&pacote::montar(&c_meu, |_, _| {}).unwrap()).unwrap();
    pacote::aplicar(&c_dela, &p, |_, _| {}).unwrap();

    let a = musica(&c_dela, "copia a.mp3");
    assert_eq!(a.title, "Asa Branca (versão dela)");
    assert_eq!(a.artist.as_deref(), Some("Ela Mesma"));
    assert_eq!(db::get_lyrics(&c_dela, a.id).unwrap().as_deref(), Some("a letra que ela escreveu"));
    // tema só se SOMA
    let temas = a.temas.unwrap_or_default();
    assert!(temas.contains("forró") && temas.contains("sertão"), "{temas}");
    assert_eq!(a.anotacoes.as_deref(), Some("minha anotação"), "as anotações dela ficam");
    assert_eq!(audio_de(&a.file_path), audio_antes, "o áudio não é tocado");
}

#[test]
fn a_musica_que_esta_tocando_fica_para_depois() {
    let (_m, _d, c_meu, c_dela) = dois_acervos();
    let b = musica(&c_dela, "copia b.mp3");
    pacote::definir_tocando(Some(b.file_path.clone()));
    let p = pacote::abrir(&pacote::montar(&c_meu, |_, _| {}).unwrap()).unwrap();
    let r = pacote::aplicar(&c_dela, &p, |_, _| {}).unwrap();
    pacote::definir_tocando(None);
    assert_eq!(r.preenchidas, 2);
    assert!(!musica(&c_dela, "copia b.mp3").has_lyrics, "a que tocava não foi gravada");
    // na próxima vez, sim
    pacote::aplicar(&c_dela, &p, |_, _| {}).unwrap();
    assert!(musica(&c_dela, "copia b.mp3").has_lyrics);
}

#[test]
fn aplicar_de_novo_nao_grava_nada() {
    let (_m, _d, c_meu, c_dela) = dois_acervos();
    let p = pacote::abrir(&pacote::montar(&c_meu, |_, _| {}).unwrap()).unwrap();
    pacote::aplicar(&c_dela, &p, |_, _| {}).unwrap();
    let r = pacote::aplicar(&c_dela, &p, |_, _| {}).unwrap();
    assert_eq!(r.preenchidas, 0, "tudo já estava preenchido");
    assert_eq!(r.reconhecidas, 3);
}

#[test]
fn pacote_de_versao_futura_nao_e_aplicado() {
    let json = br#"{"versao": 99, "musicas": []}"#;
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    std::io::Write::write_all(&mut gz, json).unwrap();
    assert!(pacote::abrir(&gz.finish().unwrap()).is_none());
    assert!(pacote::abrir(b"isto nao e um pacote").is_none());
}

#[allow(dead_code)]
fn _usa(_: PathBuf) {}
