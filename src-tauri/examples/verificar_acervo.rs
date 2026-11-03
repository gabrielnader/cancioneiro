//! V15.8 — o verificador do acervo, com o PRÓPRIO código do app.
//!
//! O `tools/diagnosticar_mp3.py` imita as regras do lofty, e imitação erra: a
//! varredura de campo acusou 105 arquivos quando só 20 falhavam, e não
//! apontou a causa de vários dos 20. Este programa não imita nada: para cada
//! MP3 ele faz exatamente o que o app faz — ler com o indexador e gravar com o
//! `writer` — e diz o desfecho, com o erro do lofty por baixo.
//!
//! **O acervo não é tocado.** Cada arquivo é COPIADO para uma pasta temporária
//! do sistema (fora do acervo), e é a cópia que é lida e gravada; a pasta é
//! apagada no fim. Nada é criado, renomeado ou alterado na pasta das músicas.
//!
//! Uso: `verificar_acervo ~/Documents/UDV/Musicas`
//! Só imprime os arquivos com algum problema, e no fim um resumo por causa.

use cancioneiro_lib::{db, indexer, writer};
use lofty::config::ParseOptions;
use lofty::file::AudioFile;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

fn main() {
    let Some(pasta) = std::env::args().nth(1) else {
        eprintln!("uso: verificar_acervo <pasta das músicas>");
        std::process::exit(2);
    };
    let mp3s: Vec<PathBuf> = walkdir::WalkDir::new(&pasta)
        .into_iter()
        .filter_entry(|e| e.depth() == 0 || !e.file_name().to_string_lossy().starts_with('.'))
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
        .map(|e| e.into_path())
        .filter(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("mp3")))
        .collect();
    eprintln!("{} arquivo(s) — o acervo NÃO é tocado: cada um é testado numa cópia temporária", mp3s.len());

    let temporaria = std::env::temp_dir().join(format!("cancioneiro-verificacao-{}", std::process::id()));
    let mut causas: BTreeMap<String, usize> = BTreeMap::new();
    let mut com_problema = 0;
    for (n, mp3) in mp3s.iter().enumerate() {
        if (n + 1) % 500 == 0 {
            eprintln!("... {} de {}", n + 1, mp3s.len());
        }
        if let Some((causa, detalhe)) = verificar(mp3, &temporaria) {
            com_problema += 1;
            println!("\n=== {}\n  {causa}\n  {detalhe}", mp3.display());
            *causas.entry(causa).or_default() += 1;
        }
    }
    let _ = std::fs::remove_dir_all(&temporaria);
    println!("\n{com_problema} de {} arquivo(s) com problema. Por causa:", mp3s.len());
    for (causa, quantos) in causas.iter().rev() {
        println!("  {quantos:5}  {causa}");
    }
}

/// `None` = o app lê e grava este arquivo. `Some((causa, detalhe))` = não.
fn verificar(mp3: &Path, temporaria: &Path) -> Option<(String, String)> {
    let _ = std::fs::remove_dir_all(temporaria);
    std::fs::create_dir_all(temporaria).ok()?;
    let copia = temporaria.join(mp3.file_name()?);
    if let Err(e) = std::fs::copy(mp3, &copia) {
        return Some(("não deu para copiar".into(), e.to_string()));
    }

    // a leitura crua do lofty, só para dar NOME à causa (o app não usa isto)
    let leitura_crua = match std::fs::File::open(&copia)
        .map_err(lofty::error::LoftyError::from)
        .and_then(|mut f| lofty::mpeg::MpegFile::read_from(&mut f, ParseOptions::new()))
    {
        Ok(_) => "leitura crua: ok".to_string(),
        Err(e) => format!("leitura crua: {:?}", e.kind()),
    };

    // o caminho do app: indexar e gravar
    let conn = db::open_in_memory().ok()?;
    let pasta_id = db::add_folder(&conn, temporaria.to_str()?).ok()?;
    let resultado = indexer::scan_folder(&conn, pasta_id, |_, _| {}).ok()?;
    let song = db::list_songs(&conn).ok()?.into_iter().next()?;
    let leu = resultado.tag_errors == 0;
    let gravou = writer::write_tags(
        &conn,
        song.id,
        &song.title,
        song.artist.as_deref(),
        Some("verificação"),
        None,
        None,
    );
    match (leu, gravou) {
        (true, Ok(_)) => None,
        (false, Ok(_)) => Some((
            "o app NÃO LÊ as etiquetas (mostra o nome do arquivo), mas grava".into(),
            leitura_crua,
        )),
        (_, Err(e)) => {
            let frase = e.0.split(": ").last().unwrap_or("").to_string();
            Some((format!("NÃO GRAVA — {}", frase.split(" — ").next().unwrap_or(&frase)), format!("{leitura_crua}; {}", gravacao_crua(&copia))))
        }
    }
}

/// O erro do lofty ao GRAVAR, sem os consertos do app, só para dar nome.
fn gravacao_crua(copia: &Path) -> String {
    let Ok(mut f) = std::fs::File::open(copia) else {
        return String::new();
    };
    match lofty::mpeg::MpegFile::read_from(&mut f, ParseOptions::new()) {
        Ok(m) => {
            let tag = m.id3v2().cloned().unwrap_or_default();
            drop(f);
            use lofty::tag::TagExt;
            match tag.save_to_path(copia, lofty::config::WriteOptions::default()) {
                Ok(()) => "gravação crua: ok".into(),
                Err(e) => format!("gravação crua: {:?}", e.kind()),
            }
        }
        Err(_) => String::new(),
    }
}
