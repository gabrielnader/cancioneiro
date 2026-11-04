//! V16.4 — "Consertar o arquivo": a música com nome de .mp3 que por dentro é
//! outra coisa (MP3 embrulhado num WAV, WAV de verdade, M4A) vira um MP3 de
//! verdade, com o MESMO nome, para poder receber nome, letra e anotação.
//!
//! Decisão do dono do produto (04/11): só com a aprovação explícita da pessoa,
//! e sempre com o ORIGINAL guardado na pasta do app e o "Voltar ao som
//! original". É a única gravação do app que mexe no áudio:
//!
//! - MP3 dentro de WAV: o som é TIRADO da caixa, byte por byte — não muda nada
//!   (conferido: o que fica depois da etiqueta é idêntico ao que estava no WAV).
//! - WAV de verdade e M4A: o som é RECODIFICADO em MP3 de 256 kbps (160 kbps
//!   quando é mono). Muda, pouco; por isso o original guardado.
//!
//! O nome do arquivo nunca muda (a biblioteca só indexa .mp3, então todo
//! arquivo que chega aqui já se chama .mp3), e nada é criado na pasta das
//! músicas: os temporários e a cópia ficam na pasta do app.

use crate::db::{self, Song};
use crate::error::{AppError, Result};
use crate::indexer;
use lofty::config::{ParseOptions, WriteOptions};
use lofty::file::TaggedFileExt;
use lofty::id3::v2::Id3v2Tag;
use lofty::tag::{Tag, TagExt, TagType};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};

/// O que o arquivo é POR DENTRO, pelos primeiros bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Conteudo {
    /// MP3 de verdade (ou algo que a gravação de sempre sabe tratar).
    Mp3,
    /// RIFF/WAVE com áudio MPEG dentro (formato 0x55 ou 0x50).
    Mp3EmWav,
    /// RIFF/WAVE com outro áudio (PCM, quase sempre).
    Wav,
    /// MP4/M4A (AAC ou ALAC).
    Mp4,
}

impl Conteudo {
    /// Os que a gravação recusa e o "Consertar o arquivo" resolve.
    pub fn trocado(self) -> bool {
        self != Conteudo::Mp3
    }

    /// O som muda no conserto?
    pub fn recodifica(self) -> bool {
        matches!(self, Conteudo::Wav | Conteudo::Mp4)
    }

    fn extensao(self) -> &'static str {
        match self {
            Conteudo::Mp4 => "m4a",
            Conteudo::Mp3 => "mp3",
            _ => "wav",
        }
    }

    /// Como a frase chama o formato.
    pub fn nome(self) -> &'static str {
        match self {
            Conteudo::Mp4 => "M4A",
            Conteudo::Mp3 => "MP3",
            _ => "WAV",
        }
    }
}

/// Lê só o começo do arquivo (4 KB bastam: o "fmt " do WAV vem logo no início).
pub fn conteudo_do_arquivo(path: &Path) -> Conteudo {
    let mut cabeca = Vec::with_capacity(4096);
    if std::fs::File::open(path)
        .and_then(|f| f.take(4096).read_to_end(&mut cabeca))
        .is_err()
    {
        return Conteudo::Mp3; // ilegível: a gravação de sempre dá a frase dela
    }
    conteudo_dos_bytes(&cabeca)
}

pub fn conteudo_dos_bytes(b: &[u8]) -> Conteudo {
    if b.len() >= 12 && &b[..4] == b"RIFF" && &b[8..12] == b"WAVE" {
        return match formato_do_wav(b) {
            Some(0x55) | Some(0x50) => Conteudo::Mp3EmWav,
            _ => Conteudo::Wav,
        };
    }
    if b.len() >= 8 && &b[4..8] == b"ftyp" {
        return Conteudo::Mp4;
    }
    Conteudo::Mp3
}

/// Os blocos do RIFF: (id, início do conteúdo, tamanho declarado).
fn blocos_do_riff(b: &[u8]) -> Vec<([u8; 4], usize, usize)> {
    let mut blocos = Vec::new();
    let mut i = 12;
    while i + 8 <= b.len() {
        let id: [u8; 4] = b[i..i + 4].try_into().unwrap();
        let tamanho = u32::from_le_bytes(b[i + 4..i + 8].try_into().unwrap()) as usize;
        blocos.push((id, i + 8, tamanho));
        // blocos têm tamanho par; o byte de enchimento não entra no tamanho
        i = i.saturating_add(8).saturating_add(tamanho).saturating_add(tamanho % 2);
    }
    blocos
}

fn formato_do_wav(b: &[u8]) -> Option<u16> {
    blocos_do_riff(b)
        .into_iter()
        .find(|(id, _, _)| id == b"fmt ")
        .and_then(|(_, ini, _)| b.get(ini..ini + 2))
        .map(|x| u16::from_le_bytes([x[0], x[1]]))
}

/// O conteúdo do bloco "data" (o áudio). Tamanho declarado maior que o arquivo
/// (gravação interrompida) fica com o que existe.
fn bloco_de_dados(b: &[u8]) -> Option<&[u8]> {
    let (_, ini, tam) = blocos_do_riff(b).into_iter().find(|(id, _, _)| id == b"data")?;
    let fim = ini.saturating_add(tam).min(b.len());
    (ini < fim).then(|| &b[ini..fim])
}

// ---------------------------------------------------------------------------
// O conserto, em duas metades: PREPARAR (pesado, sem o banco) e TROCAR (rápido,
// com o banco). Recodificar uma música leva segundos, e o banco preso esse
// tempo todo travaria a tela.
// ---------------------------------------------------------------------------

/// O MP3 novo pronto, ainda fora da pasta das músicas.
pub struct Preparado {
    pub conteudo: Conteudo,
    pub original: Vec<u8>,
    pub novo: Vec<u8>,
}

const ERRO_DE_LEITURA: &str =
    "não foi possível ler o som deste arquivo para consertá-lo. Nada foi alterado";

/// Monta o MP3 novo de `path` (que tem de estar trocado), usando `temporarios`
/// (na pasta do app) para a etiqueta.
pub fn preparar(path: &Path, temporarios: &Path) -> Result<Preparado> {
    let original = std::fs::read(path).map_err(|_| AppError(ERRO_DE_LEITURA.into()))?;
    let conteudo = conteudo_dos_bytes(&original);
    if !conteudo.trocado() {
        return Err(AppError("este arquivo já é um MP3 de verdade".into()));
    }

    // 1) o som, como fluxo MPEG
    let (fluxo, segundos_do_original) = match conteudo {
        Conteudo::Mp3EmWav => {
            let dados = bloco_de_dados(&original).ok_or_else(|| AppError(ERRO_DE_LEITURA.into()))?;
            let ini = crate::writer::primeiro_quadro_mpeg(dados, 0)
                .ok_or_else(|| AppError(ERRO_DE_LEITURA.into()))?;
            (dados[ini..].to_vec(), None)
        }
        _ => {
            let (mp3, segundos) = recodificar(&original, conteudo)?;
            (mp3, Some(segundos))
        }
    };

    // 2) o que estava escrito no arquivo (nome, quem canta, letra…) vai para a
    //    etiqueta ID3 do MP3 novo
    std::fs::create_dir_all(temporarios).map_err(|_| AppError(ERRO_DE_LEITURA.into()))?;
    let temporario = temporarios.join(format!("conserto-{}.mp3", std::process::id()));
    let _apaga = Apaga(temporario.clone());
    std::fs::write(&temporario, &fluxo).map_err(|_| AppError(ERRO_DE_LEITURA.into()))?;
    if let Some(etiqueta) = etiqueta_do_original(&original, conteudo, temporarios) {
        if !etiqueta.is_empty() {
            etiqueta
                .save_to_path(&temporario, WriteOptions::default())
                .map_err(|_| AppError(ERRO_DE_LEITURA.into()))?;
        }
    }
    let novo = std::fs::read(&temporario).map_err(|_| AppError(ERRO_DE_LEITURA.into()))?;

    // 3) a conferência
    conferir(&novo, &fluxo, conteudo, segundos_do_original)?;
    Ok(Preparado { conteudo, original, novo })
}

struct Apaga(PathBuf);
impl Drop for Apaga {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// O MP3 novo é um MP3 que o app lê, e o som é o esperado: idêntico ao que
/// estava no WAV, ou da mesma duração do original recodificado.
fn conferir(novo: &[u8], fluxo: &[u8], conteudo: Conteudo, segundos: Option<f64>) -> Result<()> {
    let falhou = || AppError("o arquivo consertado não passou na conferência. Nada foi alterado".into());
    let inicio = crate::writer::fim_declarado_do_id3v2(novo).unwrap_or(0);
    if conteudo == Conteudo::Mp3EmWav && novo.get(inicio..) != Some(fluxo) {
        return Err(falhou());
    }
    let mpeg = {
        use lofty::file::AudioFile;
        lofty::mpeg::MpegFile::read_from(&mut std::io::Cursor::new(novo), ParseOptions::new())
            .map_err(|_| falhou())?
    };
    if let Some(esperado) = segundos {
        use lofty::file::AudioFile;
        let obtido = mpeg.properties().duration().as_secs_f64();
        if (obtido - esperado).abs() > 0.5 + esperado * 0.01 {
            return Err(falhou());
        }
    }
    Ok(())
}

/// A etiqueta do arquivo original, convertida em ID3v2. As várias que um WAV
/// pode ter (LIST/INFO e um bloco "id3 ") são juntadas, sem trocar o que a
/// principal já diz. Falha de leitura = sem etiqueta (o original fica guardado).
fn etiqueta_do_original(original: &[u8], conteudo: Conteudo, temporarios: &Path) -> Option<Id3v2Tag> {
    // o lofty decide o tipo pelo CONTEÚDO, mas lê de caminho: uma cópia na
    // pasta do app com a extensão verdadeira
    let copia = temporarios.join(format!("leitura-{}.{}", std::process::id(), conteudo.extensao()));
    let _apaga = Apaga(copia.clone());
    std::fs::write(&copia, original).ok()?;
    // sem as propriedades do som: o lofty recusa ler as de um WAV com MPEG
    // dentro, e só a etiqueta interessa aqui
    let arquivo = lofty::probe::Probe::open(&copia)
        .ok()?
        .options(ParseOptions::new().read_properties(false))
        .read()
        .ok()?;
    let mut tags: Vec<&Tag> = arquivo.tags().iter().collect();
    // ID3v2 primeiro: é a mais completa quando existe
    tags.sort_by_key(|t| if t.tag_type() == TagType::Id3v2 { 0 } else { 1 });
    let mut junta = Tag::new(TagType::Id3v2);
    for t in tags {
        for item in t.items() {
            if junta.get(item.key()).is_none() {
                junta.insert_unchecked(item.clone());
            }
        }
    }
    Some(Id3v2Tag::from(junta))
}

/// Decodifica o WAV/M4A e codifica em MP3 CBR (duração exata para qualquer
/// player, sem depender de cabeçalho VBR). Devolve o MP3 e os segundos lidos.
fn recodificar(original: &[u8], conteudo: Conteudo) -> Result<(Vec<u8>, f64)> {
    use mp3lame_encoder::{Bitrate, Builder, FlushNoGap, InterleavedPcm, MonoPcm, Quality};
    use symphonia::core::codecs::audio::AudioDecoderOptions;
    use symphonia::core::formats::probe::Hint;
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;

    let erro = || AppError(ERRO_DE_LEITURA.into());
    let fonte = std::io::Cursor::new(original.to_vec());
    let fluxo = MediaSourceStream::new(Box::new(fonte), Default::default());
    let mut hint = Hint::new();
    hint.with_extension(conteudo.extensao());
    let mut formato = symphonia::default::get_probe()
        .probe(&hint, fluxo, FormatOptions::default(), MetadataOptions::default())
        .map_err(|_| erro())?;
    let faixa = formato
        .tracks()
        .iter()
        .find(|t| t.codec_params.as_ref().is_some_and(|p| p.audio().is_some()))
        .ok_or_else(erro)?;
    let id_da_faixa = faixa.id;
    let parametros = faixa.codec_params.as_ref().and_then(|p| p.audio()).ok_or_else(erro)?.clone();
    let mut decodificador = symphonia::default::get_codecs()
        .make_audio_decoder(&parametros, &AudioDecoderOptions::default())
        .map_err(|_| erro())?;

    let mut codificador: Option<(mp3lame_encoder::Encoder, usize)> = None;
    let mut saida: Vec<u8> = Vec::new();
    let mut entrelacado: Vec<f32> = Vec::new();
    let mut dois: Vec<f32> = Vec::new();
    let mut quadros: u64 = 0;
    let mut taxa = 0u32;

    loop {
        let pacote = match formato.next_packet() {
            Ok(Some(p)) => p,
            Ok(None) => break,
            Err(_) => return Err(erro()),
        };
        if pacote.track_id != id_da_faixa {
            continue;
        }
        let quadro = match decodificador.decode_ref(&pacote.as_packet_ref()) {
            Ok(q) => q,
            Err(symphonia::core::errors::Error::DecodeError(_)) => continue,
            Err(_) => return Err(erro()),
        };
        let canais = quadro.num_planes().max(1);
        if codificador.is_none() {
            taxa = quadro.spec().rate();
            if taxa == 0 {
                return Err(erro());
            }
            let saem = canais.min(2);
            let mut b = Builder::new().ok_or_else(erro)?;
            b.set_num_channels(saem as u8).map_err(|_| erro())?;
            b.set_sample_rate(taxa).map_err(|_| erro())?;
            // taxa que o MP3 não tem (96 kHz de estúdio): o LAME reamostra
            if ![8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000].contains(&taxa) {
                b.set_output_sample_rate(std::num::NonZeroU32::new(44100)).map_err(|_| erro())?;
            }
            b.set_brate(if saem == 1 { Bitrate::Kbps160 } else { Bitrate::Kbps256 }).map_err(|_| erro())?;
            b.set_quality(Quality::NearBest).map_err(|_| erro())?;
            b.set_to_write_vbr_tag(false).map_err(|_| erro())?;
            codificador = Some((b.build().map_err(|_| erro())?, saem));
        }
        let (cod, saem) = codificador.as_mut().unwrap();
        quadros += quadro.frames() as u64;
        entrelacado.clear();
        quadro.copy_to_vec_interleaved(&mut entrelacado);
        saida.reserve(mp3lame_encoder::max_required_buffer_size(entrelacado.len()));
        if *saem == 1 {
            cod.encode_to_vec(MonoPcm(&entrelacado[..]), &mut saida).map_err(|_| erro())?;
        } else {
            // mais de dois canais: ficam os dois primeiros
            let fonte: &[f32] = if canais == 2 {
                &entrelacado
            } else {
                dois.clear();
                for bloco in entrelacado.chunks(canais) {
                    dois.extend_from_slice(&bloco[..2]);
                }
                &dois
            };
            cod.encode_to_vec(InterleavedPcm(fonte), &mut saida).map_err(|_| erro())?;
        }
    }
    let (mut cod, _) = codificador.ok_or_else(erro)?;
    saida.reserve(7200);
    cod.flush_to_vec::<FlushNoGap>(&mut saida).map_err(|_| erro())?;
    Ok((saida, quadros as f64 / taxa as f64))
}

// ---------------------------------------------------------------------------
// A troca e o "Voltar".
// ---------------------------------------------------------------------------

/// Guarda o original em `pasta_das_copias`, grava o MP3 novo no MESMO caminho
/// e relê a música. Qualquer falha antes de gravar: nada mudou. Falha DEPOIS:
/// o original volta.
pub fn trocar(conn: &Connection, song: &Song, p: &Preparado, pasta_das_copias: &Path) -> Result<Song> {
    let path = Path::new(&song.file_path);
    if crate::pacote::esta_tocando(&song.file_path) {
        return Err(AppError("esta música está tocando. Pare a música e tente de novo".into()));
    }
    // o arquivo mudou desde que foi preparado (outra gravação, outro programa)
    if std::fs::read(path).ok().as_deref() != Some(&p.original[..]) {
        return Err(AppError("o arquivo mudou enquanto era consertado. Nada foi alterado; tente de novo".into()));
    }

    std::fs::create_dir_all(pasta_das_copias)
        .map_err(|_| AppError("não foi possível guardar o original. Nada foi alterado".into()))?;
    let agora = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let copia = pasta_das_copias.join(format!("{}-{agora}.{}", song.id, p.conteudo.extensao()));
    let guardou = std::fs::write(&copia, &p.original).is_ok()
        && std::fs::read(&copia).ok().as_deref() == Some(&p.original[..]);
    if !guardou {
        let _ = std::fs::remove_file(&copia);
        return Err(AppError("não foi possível guardar o original. Nada foi alterado".into()));
    }

    let gravou = std::fs::write(path, &p.novo).is_ok()
        && std::fs::read(path).ok().as_deref() == Some(&p.novo[..]);
    if !gravou {
        let _ = std::fs::write(path, &p.original);
        let _ = std::fs::remove_file(&copia);
        return Err(AppError(format!(
            "não foi possível gravar o arquivo consertado em {}. O original foi mantido",
            song.file_path
        )));
    }

    conn.execute(
        "INSERT OR REPLACE INTO arquivos_originais (song_id, copia, conteudo, tamanho, guardado_em)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![song.id, copia.to_string_lossy(), p.conteudo.extensao(), p.original.len() as i64, agora as i64],
    )?;
    reler(conn, song)
}

fn reler(conn: &Connection, song: &Song) -> Result<Song> {
    indexer::index_single_file(conn, song.folder_id, Path::new(&song.file_path))
        .map_err(|_| AppError(format!("{}: {}", song.file_path, crate::writer::ERRO_LISTA_DESATUALIZADA)))?;
    db::get_song(conn, song.id)?.ok_or_else(|| AppError(format!("música não encontrada: {}", song.id)))
}

/// A cópia guardada do original de uma música, se houver.
pub fn copia_guardada(conn: &Connection, song_id: i64) -> Result<Option<PathBuf>> {
    Ok(conn
        .query_row("SELECT copia FROM arquivos_originais WHERE song_id = ?1", params![song_id], |r| {
            r.get::<_, String>(0)
        })
        .optional()?
        .map(PathBuf::from))
}

/// "Voltar ao som original": o arquivo guardado volta para o MESMO caminho, e
/// a cópia sai da pasta do app. O que foi gravado depois do conserto (letra,
/// nome) se perde junto com o MP3 novo — a tela avisa antes.
pub fn voltar_ao_original(conn: &Connection, song: &Song) -> Result<Song> {
    let copia = copia_guardada(conn, song.id)?
        .ok_or_else(|| AppError("não há original guardado desta música".into()))?;
    if crate::pacote::esta_tocando(&song.file_path) {
        return Err(AppError("esta música está tocando. Pare a música e tente de novo".into()));
    }
    let original = std::fs::read(&copia)
        .map_err(|_| AppError("o original guardado não foi encontrado na pasta do app".into()))?;
    let path = Path::new(&song.file_path);
    let atual = std::fs::read(path).map_err(|_| AppError(format!("arquivo não encontrado: {}", song.file_path)))?;
    let voltou = std::fs::write(path, &original).is_ok()
        && std::fs::read(path).ok().as_deref() == Some(&original[..]);
    if !voltou {
        let _ = std::fs::write(path, &atual);
        return Err(AppError("não foi possível pôr o original de volta. O arquivo ficou como estava".into()));
    }
    conn.execute("DELETE FROM arquivos_originais WHERE song_id = ?1", params![song.id])?;
    let _ = std::fs::remove_file(&copia);
    reler(conn, song)
}

/// As músicas da biblioteca que são outra coisa por dentro.
pub fn musicas_para_consertar(conn: &Connection) -> Result<Vec<(i64, Conteudo)>> {
    Ok(db::list_songs(conn)?
        .into_iter()
        .filter_map(|s| {
            let c = conteudo_do_arquivo(Path::new(&s.file_path));
            c.trocado().then_some((s.id, c))
        })
        .collect())
}

/// Quantas cópias de originais estão guardadas, e quanto ocupam.
pub fn copias_guardadas(conn: &Connection) -> Result<(usize, u64)> {
    let (n, bytes): (i64, i64) = conn.query_row(
        "SELECT count(*), coalesce(sum(tamanho), 0) FROM arquivos_originais",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    Ok((n as usize, bytes as u64))
}

/// Apaga as cópias guardadas (com elas, o "Voltar" daquelas músicas).
pub fn apagar_copias(conn: &Connection) -> Result<()> {
    let mut st = conn.prepare("SELECT copia FROM arquivos_originais")?;
    let copias: Vec<String> = st.query_map([], |r| r.get(0))?.collect::<std::result::Result<_, _>>()?;
    for c in copias {
        let _ = std::fs::remove_file(c);
    }
    conn.execute("DELETE FROM arquivos_originais", [])?;
    Ok(())
}
