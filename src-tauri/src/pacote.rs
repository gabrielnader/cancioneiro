//! V16 — o PACOTE DE LETRAS DO GRUPO.
//!
//! Relato do dono do produto: a transcrição do acervo inteiro levou quase
//! quatro dias no computador dele, e "não imagino que uma pessoa mais velha vá
//! fazer o mesmo". A maioria do grupo tem as mesmas músicas. Então quem
//! organiza faz a curadoria UMA vez, publica, e o app de cada pessoa recebe.
//!
//! Decisões do dono do produto (registradas na DECISIONS, V16):
//!
//! - **Recebimento automático, por trás.** Sem cartão e sem botão: um passo a
//!   mais é um passo que quem tem pouca familiaridade não dá. É a ÚNICA
//!   gravação do app sem um clique, e por isso ela é a mais estreita:
//! - **Só preenche o que está vazio.** Letra que não existe, quem canta vazio
//!   (ou "Unknown"), nome que ainda é o nome do arquivo, temas que faltam, a
//!   marca de instrumental em música sem letra. Nada que alguém escreveu é
//!   trocado — nem por uma correção de quem organiza.
//! - **A mesma música é reconhecida pela cópia do áudio** (a `digital`), não
//!   pelo nome do arquivo: cobre quem copiou o acervo da mesma fonte. O
//!   reconhecimento pelo som (fpcalc) fica para depois, se a cobertura medida
//!   for baixa.
//!
//! E as garantias de sempre continuam: a gravação passa pelo `enrich::apply`
//! (que confere se a música mudou e recusa trocar letra existente), o áudio
//! não é tocado, e a música que está TOCANDO nunca é gravada (fica para a
//! próxima abertura).

use crate::db::{self, Song};
use crate::enrich::{self, Campo, EnrichApply};
use crate::error::{AppError, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::Mutex;

/// Versão do formato do pacote. Um app velho que receber uma versão maior não
/// aplica nada (melhor nada do que algo lido errado).
pub const VERSAO_DO_PACOTE: u32 = 1;

/// Quanto do áudio entra na digital: 1 MB do miolo, depois do primeiro quadro.
const TAMANHO_DA_DIGITAL: usize = 1024 * 1024;
/// O que fica de fora no fim: ID3v1, APE e Lyrics3 moram ali, e mudam de uma
/// cópia para outra sem o áudio mudar.
const MARGEM_DO_FIM: u64 = 64 * 1024;

/// O ARQUIVO que está tocando agora. O recebimento NUNCA grava essa música:
/// reescrever o arquivo que o player está lendo pode cortar o som. É o
/// caminho, e não o número da música, porque o caminho é o que o player lê.
static TOCANDO: Mutex<Option<String>> = Mutex::new(None);

pub fn definir_tocando(caminho: Option<String>) {
    if let Ok(mut t) = TOCANDO.lock() {
        *t = caminho;
    }
}

pub(crate) fn esta_tocando(caminho: &str) -> bool {
    TOCANDO.lock().map(|t| t.as_deref() == Some(caminho)).unwrap_or(true)
}

/// Uma música no pacote. Só o que serve para PREENCHER: campo ausente é campo
/// que quem organiza não tem.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MusicaDoPacote {
    pub digital: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub titulo: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artista: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub letra: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temas: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub instrumental: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Pacote {
    pub versao: u32,
    pub musicas: Vec<MusicaDoPacote>,
}

/// O que o recebimento fez.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct ResumoDoRecebimento {
    /// Músicas desta biblioteca que estão no pacote.
    pub reconhecidas: usize,
    /// Músicas que ganharam alguma coisa.
    pub preenchidas: usize,
    /// Quantas ganharam LETRA (é o número que a pessoa quer ouvir).
    pub com_letra_nova: usize,
    /// Gravações que falharam (ficam para a próxima vez, em silêncio).
    pub falhas: usize,
}

// ---------------------------------------------------------------------------
// A digital do áudio
// ---------------------------------------------------------------------------

/// A digital de uma cópia do áudio: SHA-256 de 1 MB a partir do primeiro
/// quadro MPEG. Duas cópias do mesmo arquivo com etiquetas diferentes têm a
/// MESMA digital — a etiqueta do começo fica antes do primeiro quadro, e as do
/// fim ficam fora da margem. `None` quando não há áudio MPEG reconhecível ou
/// o arquivo é curto demais para uma digital confiável.
pub fn digital_do_audio(path: &Path) -> Option<String> {
    let mut f = std::fs::File::open(path).ok()?;
    let tamanho = f.metadata().ok()?.len();
    let mut cabeca = [0u8; 10];
    f.read_exact(&mut cabeca).ok()?;
    let etiqueta = crate::writer::fim_declarado_do_id3v2(&cabeca).unwrap_or(0) as u64;
    // a etiqueta + uma folga para achar o primeiro quadro + a própria digital
    let ler = (etiqueta + 256 * 1024 + TAMANHO_DA_DIGITAL as u64).min(tamanho);
    let mut bytes = Vec::with_capacity(ler as usize);
    std::io::Seek::rewind(&mut f).ok()?;
    f.take(ler).read_to_end(&mut bytes).ok()?;
    let inicio = crate::writer::primeiro_quadro_mpeg(&bytes, etiqueta as usize)?;
    let fim = (inicio + TAMANHO_DA_DIGITAL).min(tamanho.saturating_sub(MARGEM_DO_FIM) as usize).min(bytes.len());
    if fim <= inicio || fim - inicio < 64 * 1024 {
        return None;
    }
    Some(hex(&Sha256::digest(&bytes[inicio..fim])))
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// A digital da música, do cache quando o arquivo não mudou (data e tamanho).
/// Calcular lê 1 MB por música; num acervo de 8 mil, só a primeira vez.
pub fn digital_da_musica(conn: &Connection, song: &Song) -> Option<String> {
    let meta = std::fs::metadata(&song.file_path).ok()?;
    let mtime = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs() as i64;
    let tamanho = meta.len() as i64;
    let guardada: Option<String> = conn
        .query_row(
            "SELECT digital FROM digitais_do_audio WHERE song_id = ?1 AND mtime = ?2 AND tamanho = ?3",
            params![song.id, mtime, tamanho],
            |r| r.get(0),
        )
        .optional()
        .ok()?;
    if guardada.is_some() {
        return guardada;
    }
    let digital = digital_do_audio(Path::new(&song.file_path))?;
    let _ = conn.execute(
        "INSERT OR REPLACE INTO digitais_do_audio (song_id, mtime, tamanho, digital) VALUES (?1, ?2, ?3, ?4)",
        params![song.id, mtime, tamanho, digital],
    );
    Some(digital)
}

// ---------------------------------------------------------------------------
// O que é "vazio"
// ---------------------------------------------------------------------------

/// O nome ainda é o nome do arquivo (a música não tinha título na etiqueta) ou
/// um rótulo de ripador ("Faixa 3", "Unknown")? Então preenchê-lo não apaga
/// nada que alguém escreveu.
fn titulo_vazio(song: &Song) -> bool {
    let nome = Path::new(&song.file_path)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let igual = |a: &str, b: &str| normal(a) == normal(b);
    song.title.trim().is_empty()
        || igual(&song.title, &nome)
        || enrich::is_placeholder(Campo::Titulo, &song.title)
}

fn artista_vazio(song: &Song) -> bool {
    song.artist
        .as_deref()
        .map(|a| a.trim().is_empty() || enrich::is_placeholder(Campo::Artista, a))
        .unwrap_or(true)
}

/// Comparação de nomes: NFC simplificado (o macOS entrega o caminho
/// decomposto), sem caixa e sem espaços nas pontas.
fn normal(s: &str) -> String {
    db::fold_pt(s.trim())
}

fn temas_de(texto: Option<&str>) -> Vec<String> {
    texto
        .unwrap_or("")
        .split(';')
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .collect()
}

// ---------------------------------------------------------------------------
// Montar (no app de quem organiza)
// ---------------------------------------------------------------------------

/// O pacote desta biblioteca, compactado. Só entra o que tem algo a dar —
/// e o nome só quando ele é um nome de verdade (não o do arquivo).
pub fn montar(conn: &Connection, progresso: impl Fn(usize, usize)) -> Result<Vec<u8>> {
    let songs = db::list_songs(conn)?;
    let total = songs.len();
    let mut musicas = Vec::new();
    let mut vistas = std::collections::HashSet::new();
    for (n, song) in songs.iter().enumerate() {
        progresso(n, total);
        if !song.available {
            continue;
        }
        let letra = if song.has_lyrics {
            db::get_lyrics(conn, song.id)?.filter(|l| !l.trim().is_empty())
        } else {
            None
        };
        let artista = (!artista_vazio(song)).then(|| song.artist.clone()).flatten();
        let titulo = (!titulo_vazio(song)).then(|| song.title.clone());
        let temas = song.temas.clone().filter(|t| !t.trim().is_empty());
        if letra.is_none() && artista.is_none() && titulo.is_none() && temas.is_none() && !song.instrumental {
            continue;
        }
        let Some(digital) = digital_da_musica(conn, song) else {
            continue;
        };
        // a mesma gravação em duas pastas: entra uma vez só
        if !vistas.insert(digital.clone()) {
            continue;
        }
        musicas.push(MusicaDoPacote {
            digital,
            titulo,
            artista,
            letra,
            temas,
            instrumental: song.instrumental,
        });
    }
    progresso(total, total);
    let json = serde_json::to_vec(&Pacote { versao: VERSAO_DO_PACOTE, musicas })
        .map_err(|e| AppError(format!("não foi possível montar o pacote: {e}")))?;
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
    gz.write_all(&json).map_err(|e| AppError(format!("não foi possível compactar o pacote: {e}")))?;
    gz.finish().map_err(|e| AppError(format!("não foi possível compactar o pacote: {e}")))
}

/// Abre um pacote compactado. `None` quando ele é de uma versão que este app
/// não conhece, ou não é um pacote.
pub fn abrir(bytes: &[u8]) -> Option<Pacote> {
    let mut json = Vec::new();
    flate2::read::GzDecoder::new(bytes).read_to_end(&mut json).ok()?;
    let p: Pacote = serde_json::from_slice(&json).ok()?;
    (p.versao <= VERSAO_DO_PACOTE).then_some(p)
}

// ---------------------------------------------------------------------------
// Aplicar (no app de cada pessoa)
// ---------------------------------------------------------------------------

/// O que preencher nesta música, a partir do que o pacote tem. `None` quando
/// não há nada vazio que o pacote preencha.
fn o_que_preencher(song: &Song, m: &MusicaDoPacote) -> Option<EnrichApply> {
    let titulo = m.titulo.as_ref().filter(|_| titulo_vazio(song)).cloned();
    let artista = m.artista.as_ref().filter(|_| artista_vazio(song)).cloned();
    let letra = m
        .letra
        .as_ref()
        .filter(|l| !l.trim().is_empty() && !song.has_lyrics && !song.instrumental)
        .cloned();
    let atuais = temas_de(song.temas.as_deref());
    let novos: Vec<String> = temas_de(m.temas.as_deref())
        .into_iter()
        .filter(|t| !atuais.iter().any(|a| normal(a) == normal(t)))
        .collect();
    let instrumental = m.instrumental && !song.instrumental && !song.has_lyrics && letra.is_none();
    if titulo.is_none() && artista.is_none() && letra.is_none() && novos.is_empty() && !instrumental {
        return None;
    }
    Some(EnrichApply {
        song_id: song.id,
        title: titulo.unwrap_or_else(|| song.title.clone()),
        artist: artista,
        lyrics: letra,
        add_temas: (!novos.is_empty()).then(|| novos.join("; ")),
        current_title: song.title.clone(),
        current_artist: song.artist.clone(),
        fonte: Some(FONTE_GRUPO.into()),
        substituir_letra: false,
        marcar_instrumental: instrumental,
    })
}

/// A fonte das gravações do pacote. Letra que não é da internet nem da
/// transcrição: a procedência fica limpa (DECISIONS #54).
pub const FONTE_GRUPO: &str = "letras do grupo";

/// Preenche esta biblioteca com o pacote. Nunca troca nada escrito, nunca
/// grava a música que está tocando, e uma falha numa música não para as
/// outras.
pub fn aplicar(conn: &Connection, pacote: &Pacote, progresso: impl Fn(usize, usize)) -> Result<ResumoDoRecebimento> {
    let por_digital: HashMap<&str, &MusicaDoPacote> =
        pacote.musicas.iter().map(|m| (m.digital.as_str(), m)).collect();
    let songs = db::list_songs(conn)?;
    let total = songs.len();
    let mut resumo = ResumoDoRecebimento::default();
    for (n, song) in songs.iter().enumerate() {
        progresso(n, total);
        if !song.available {
            continue;
        }
        let Some(digital) = digital_da_musica(conn, song) else {
            continue;
        };
        let Some(m) = por_digital.get(digital.as_str()) else {
            continue;
        };
        resumo.reconhecidas += 1;
        let Some(ap) = o_que_preencher(song, m) else {
            continue;
        };
        if esta_tocando(&song.file_path) {
            continue; // fica para a próxima abertura
        }
        let com_letra = ap.lyrics.is_some();
        match enrich::apply(conn, std::slice::from_ref(&ap))?.into_iter().next() {
            Some(r) if r.song.is_some() => {
                resumo.preenchidas += 1;
                if com_letra {
                    resumo.com_letra_nova += 1;
                }
            }
            _ => resumo.falhas += 1,
        }
    }
    progresso(total, total);
    Ok(resumo)
}
