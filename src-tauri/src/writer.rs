//! F10 (PRD V4) — gravação de tags ID3 no MP3 via lofty.
//!
//! Este é o ÚNICO fluxo do app que escreve em arquivos de áudio, e ele grava
//! somente frames ID3v2.4 (TIT2/TPE1/USLT/TXXX:TEMAS): nunca renomeia, nunca
//! move e nunca toca nos frames MPEG (o áudio em si).
//!
//! Decisão de implementação: gravamos com `Id3v2Tag` (frames diretos) em vez
//! da `Tag` genérica do lofty por dois motivos, descobertos na fonte do
//! lofty 0.22 e confirmados pelo round-trip dos testes:
//! 1. `ItemKey::Lyrics` na `Tag` genérica vira USLT com lang padrão "XXX"
//!    (`UNKNOWN_LANGUAGE`), e a spec do PRD (compat com o embed_lyrics.py /
//!    mutagen) exige lang "por";
//! 2. Para TXXX:TEMAS o `Id3v2Tag::insert_user_text` escreve o frame TXXX
//!    canônico (desc "TEMAS"), o mesmo formato do mutagen — o round-trip
//!    write (lofty) → read (read_tags do indexer, que o vê como
//!    `ItemKey::Unknown("TEMAS")`) é verificado em tests/writer.rs.
//! O `Id3v2Tag` existente é lido do arquivo e modificado, preservando
//! quaisquer outros frames (APIC, álbum, etc.).

use crate::db::{self, fold_pt, Song};
use crate::error::{AppError, Result};
use crate::indexer;
use lofty::config::{ParseOptions, WriteOptions};
use lofty::file::AudioFile;
use lofty::id3::v2::{Frame, FrameId, Id3v2Tag, UnsynchronizedTextFrame};
use lofty::mpeg::MpegFile;
use lofty::tag::{Accessor, TagExt};
use lofty::TextEncoding;
use rusqlite::Connection;
use std::borrow::Cow;
use std::collections::BTreeMap;
use std::path::Path;

/// Idioma do USLT — o mesmo que o embed_lyrics.py (mutagen) grava.
const USLT_LANG: [u8; 3] = *b"por";
const TEMAS_DESC: &str = "TEMAS";
/// V5/F14 — procedência da letra, gravada pelas ferramentas Python
/// (`TXXX:LETRA_ORIGEM = "transcricao"` = letra saída do áudio). A marca
/// descreve a letra que está NO ARQUIVO: quem troca a letra derruba a marca.
const LETRA_ORIGEM_DESC: &str = "LETRA_ORIGEM";

/// Normalização de temas IGUAL à do Python (embed_lyrics.normalize_temas +
/// split_temas_input): split por vírgula OU ponto-e-vírgula, trim, colapso de
/// espaços internos, minúsculas, dedup por chave sem acento (primeira
/// ocorrência vence) e ordenação alfabética pela chave sem acento.
pub fn normalize_temas(raw: &str) -> Vec<String> {
    let mut vistos: BTreeMap<String, String> = BTreeMap::new();
    for tema in raw.replace(';', ",").split(',') {
        let limpo = tema
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase();
        if limpo.is_empty() {
            continue;
        }
        vistos.entry(fold_pt(&limpo)).or_insert(limpo);
    }
    vistos.into_values().collect()
}

fn non_empty(s: Option<&str>) -> Option<&str> {
    s.map(str::trim).filter(|t| !t.is_empty())
}

/// Grava TIT2/TPE1/USLT/TXXX:TEMAS no MP3 da música `song_id` (ID3v2.4),
/// reindexa o arquivo (upsert — FTS atualizada pelos triggers) e devolve a
/// Song atualizada. `None`/vazio em artist/lyrics/temas REMOVE o frame.
/// Nunca renomeia o arquivo nem altera os frames de áudio.
pub fn write_tags(
    conn: &Connection,
    song_id: i64,
    title: &str,
    artist: Option<&str>,
    lyrics: Option<&str>,
    temas: Option<&str>,
) -> Result<Song> {
    let song = db::get_song(conn, song_id)?
        .ok_or_else(|| AppError(format!("música não encontrada: {song_id}")))?;

    let title = title.trim();
    if title.is_empty() {
        return Err(AppError("título vazio".into()));
    }

    let path = Path::new(&song.file_path);
    if !path.is_file() {
        // mensagem exata que o frontend usa para arquivo sumido
        return Err(AppError(format!("arquivo não encontrado: {}", song.file_path)));
    }

    // Lê a tag ID3v2 existente (preserva os demais frames); MP3 sem tag ganha
    // uma nova. A leitura via MpegFile valida que há um stream MPEG real.
    let mut file = std::fs::File::open(path)
        .map_err(|e| AppError(format!("não foi possível salvar em {}: {e}", song.file_path)))?;
    let mpeg = MpegFile::read_from(&mut file, ParseOptions::new())
        .map_err(|e| AppError(format!("não foi possível salvar em {}: {e}", song.file_path)))?;
    drop(file);
    let mut tag: Id3v2Tag = mpeg.id3v2().cloned().unwrap_or_default();

    // TIT2
    tag.set_title(title.to_string());

    // TPE1 — None/vazio remove o frame
    match non_empty(artist) {
        Some(a) => tag.set_artist(a.to_string()),
        None => tag.remove_artist(),
    }

    // USLT — substitui, nunca duplica (delall + add, como o mutagen);
    // None/vazio remove. A letra é gravada exatamente como veio (sem trim),
    // preservando \n e acentos.
    //
    // A letra que JÁ está no arquivo é lida antes da troca para decidir o
    // destino da marca TXXX:LETRA_ORIGEM (V5/F14) — o mesmo critério de
    // "tem letra" do indexer (texto em branco conta como ausente).
    let letra_anterior: Option<String> = tag
        .unsync_text()
        .next()
        .map(|f| f.content.clone())
        .filter(|l| !l.trim().is_empty());
    let letra_nova = lyrics.filter(|l| !l.trim().is_empty());
    drop(tag.remove(&FrameId::Valid(Cow::Borrowed("USLT"))));
    if let Some(l) = letra_nova {
        tag.insert(Frame::UnsynchronizedText(UnsynchronizedTextFrame::new(
            TextEncoding::UTF8,
            USLT_LANG,
            String::new(),
            l.to_string(),
        )));
    }

    // TXXX:LETRA_ORIGEM (V5/F14, achado do QA A3) — a marca descreve a letra
    // ATUAL. Trocar ou apagar a letra invalida a marca: sem isso, uma letra
    // digitada à mão por cima de uma transcrição continuaria se declarando
    // "transcrição automática" (e o selo do player mentiria). Gravação que
    // NÃO mexe na letra — só título/artista/temas, ou o repasse da mesma
    // letra que o apply do lote faz (enrich::apply_one) — preserva a marca.
    // Todos os demais frames estrangeiros (capa, outros TXXX) continuam
    // intocados, como sempre.
    if letra_nova != letra_anterior.as_deref() {
        drop(tag.remove_user_text(LETRA_ORIGEM_DESC));
    }

    // TXXX:TEMAS — normalizados; None/vazio (ou só separadores) remove
    drop(tag.remove_user_text(TEMAS_DESC));
    if let Some(t) = temas {
        let normalizados = normalize_temas(t);
        if !normalizados.is_empty() {
            tag.insert_user_text(TEMAS_DESC.to_string(), normalizados.join("; "));
        }
    }

    // save_to_path regrava SOMENTE o bloco ID3v2 (mesmo arquivo, mesmo nome);
    // ID3v2.4 é o default de escrita do lofty.
    tag.save_to_path(path, WriteOptions::default())
        .map_err(|e| AppError(format!("não foi possível salvar em {}: {e}", song.file_path)))?;

    // Re-stata mtime/size e upserta — banco/FTS em sincronia na hora, e o
    // próximo rescan não precisa reler o arquivo.
    indexer::index_single_file(conn, song.folder_id, path)?;

    db::get_song(conn, song_id)?
        .ok_or_else(|| AppError(format!("música não encontrada: {song_id}")))
}

#[cfg(test)]
mod tests {
    use super::normalize_temas;

    #[test]
    fn normalize_temas_matches_python_rules() {
        // split por vírgula e ponto-e-vírgula, trim, colapso, minúsculas
        assert_eq!(
            normalize_temas("Água,  cura de   novo ; ESPERANÇA"),
            vec!["água", "cura de novo", "esperança"]
        );
        // dedup por chave sem acento: primeira ocorrência vence
        assert_eq!(normalize_temas("Água, agua, ÁGUA"), vec!["água"]);
        // ordenação pela chave sem acento ("água" antes de "ânimo" e "zelo")
        assert_eq!(
            normalize_temas("zelo, Ânimo, água"),
            vec!["água", "ânimo", "zelo"]
        );
        // vazio / só separadores
        assert_eq!(normalize_temas(""), Vec::<String>::new());
        assert_eq!(normalize_temas(" ; , ;; "), Vec::<String>::new());
    }
}
