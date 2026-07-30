//! F10 (PRD V4) — gravação de tags ID3 no MP3 via lofty.
//!
//! Este é o ÚNICO fluxo do app que escreve em arquivos de áudio, e ele grava
//! somente frames ID3v2.4 (TIT2/TPE1/USLT/TXXX:TEMAS/TXXX:INSTRUMENTAL):
//! nunca renomeia, nunca move e nunca toca nos frames MPEG (o áudio em si).
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
use lofty::error::{ErrorKind, LoftyError};
use lofty::file::AudioFile;
use lofty::id3::v2::{Frame, FrameId, Id3v2Tag, UnsynchronizedTextFrame};
use lofty::mpeg::MpegFile;
use lofty::tag::{Accessor, TagExt};
use lofty::TextEncoding;
use rusqlite::Connection;
use std::borrow::Cow;
use std::collections::{BTreeMap, HashSet};
use std::path::Path;

/// Idioma do USLT — o mesmo que o embed_lyrics.py (mutagen) grava.
const USLT_LANG: [u8; 3] = *b"por";
const TEMAS_DESC: &str = "TEMAS";
/// V5/F14 — procedência da letra, gravada pelas ferramentas Python
/// (`TXXX:LETRA_ORIGEM = "transcricao"` = letra saída do áudio). A marca
/// descreve a letra que está NO ARQUIVO: quem troca a letra derruba a marca.
const LETRA_ORIGEM_DESC: &str = "LETRA_ORIGEM";
/// Letra vinda da base comunitária Vagalume — **valor HERANÇA, só de
/// leitura** (V10).
///
/// A etapa do Vagalume saiu do aplicativo (DECISIONS #110) e **nada mais
/// escreve este valor aqui**. Ele continua existindo por uma razão: o
/// `tools/curadoria.py` o grava, e arquivos do acervo real já o carregam. Um
/// valor que o programa não reconhece não é lixo a limpar — "nunca apagar dado
/// existente" vale para INTERPRETAR dado existente também.
///
/// Na prática a garantia é a da DECISIONS #54: a marca só muda quando a LETRA
/// muda, então uma gravação de título/artista sobre um arquivo marcado
/// `vagalume` o preserva. Há teste fixando isso.
pub const ORIGEM_VAGALUME: &str = "vagalume";
/// V10 — letra ESCRITA ouvindo o áudio (etapa 5). É o mesmo valor que o
/// `tools/embed_lyrics.py` grava desde a V5/F14 (`ORIGEM_TRANSCRICAO`) e que o
/// player já sabe exibir como "pode conter erros": o dado viaja no MP3, e os
/// dois stacks precisam falar a mesma língua.
pub const ORIGEM_TRANSCRICAO: &str = "transcricao";
/// V10 — letra vinda do `lyrics.ovh`, a fonte de letra da etapa 4, que não
/// pede credencial nenhuma.
///
/// O valor é o nome do serviço, minúsculo, no mesmo estilo dos demais: o dado
/// viaja no MP3, e é assim que a próxima ferramenta sabe de onde a letra veio.
/// **O `tools/embed_lyrics.py` ainda não conhece este valor** — enquanto não
/// conhecer, o `rotulo_letra` do `tools/curadoria.py` mostra o "SIM" genérico
/// em vez de "lyrics.ovh". É perda de RÓTULO, não de dado: origem desconhecida
/// nunca é lida como transcrição, e nada apaga a marca.
pub const ORIGEM_LYRICS_OVH: &str = "lyrics.ovh";
/// V8/F17 — marca de música sem voz. O valor canônico gravado é "1", o mesmo
/// que o `embed_lyrics.py --instrumental` grava; desmarcar REMOVE o frame.
const INSTRUMENTAL_DESC: &str = "INSTRUMENTAL";

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

// ---------------------------------------------------------------------------
// V10.1 — o quadro com CAMPO DE IDIOMA INVÁLIDO, e por que ele é consertado
// em vez de descartado.
//
// Relatado em campo: aplicar uma proposta falhava com "ID3v2: Invalid frame
// language found: [0, 0, 0] (expected 3 ascii characters)", e a curadoria
// daquela música ficava impossível PARA SEMPRE — toda tentativa falha igual, e
// um arquivo que não pode ser gravado sai da curadoria em silêncio.
//
// O que foi MEDIDO na fonte do lofty 0.22.4 e conferido nas fixtures deste
// repositório (tests/writer.rs), nos três modos de parsing:
//
// | ParsingMode | leitura | idioma lido | regravação                        |
// |-------------|---------|-------------|-----------------------------------|
// | Strict      | OK      | [0,0,0]     | FALHA (Invalid frame language)    |
// | BestAttempt | OK      | [0,0,0]     | FALHA (idem)                      |
// | Relaxed     | OK      | [0,0,0]     | FALHA (idem)                      |
//
// Ou seja: **`ParseOptions`/`ParsingMode` não tem nada a ver com este
// defeito.** A validação mora em `LanguageFrame::create_bytes`, que roda na
// ESCRITA (`as_bytes`), e ali não existe modo tolerante nenhum: o `?` aborta a
// gravação do arquivo inteiro. Afrouxar a leitura não resolveria nada — e a
// tolerância que existe na leitura (`Relaxed`) DESCARTA quadros, que é
// justamente o que este produto não pode fazer.
//
// Daí o conserto. `und` é o código que o próprio ISO-639-2 (o vocabulário que
// o ID3 usa neste campo) reserva para "idioma indeterminado": ele é a forma
// PREVISTA de dizer "não sei", e não um valor inventado por nós. Consertar
// preserva o conteúdo do quadro — que pode ser um COMM com a anotação de
// alguém, ou um USLT com a letra inteira; descartar não preserva nada.
//
// Só COMM e USLT carregam idioma no lofty 0.22 (`Frame::Comment` e
// `Frame::UnsynchronizedText` são os dois únicos braços de `Frame::as_bytes`
// que podem devolver `InvalidLanguage`). Um SYLT, por exemplo, chega como
// `Frame::Binary` e é regravado byte a byte, sem validação. Mesmo assim a
// varredura abaixo é dirigida pela VARIANTE do quadro, e não por uma lista de
// identificadores escrita à mão: se amanhã o lofty passar a entender outro
// quadro com idioma, é aqui que a lista cresce, num lugar só (DECISIONS #80).

/// ISO-639-2 para "idioma indeterminado" — o valor que o padrão prevê para
/// "não sei qual é". É o que substitui um campo de idioma quebrado.
const LANG_INDETERMINADO: [u8; 3] = *b"und";

/// A régua do lofty: três caracteres ASCII alfabéticos, nem mais nem menos.
fn idioma_valido(lang: [u8; 3]) -> bool {
    lang.iter().all(u8::is_ascii_alphabetic)
}

/// (idioma, descrição) de um quadro que carrega idioma; `None` para os demais.
///
/// A dupla é a CHAVE de unicidade do lofty dentro de um mesmo identificador de
/// quadro (`PartialEq` de `CommentFrame`/`UnsynchronizedTextFrame` compara
/// exatamente isto) — é por ela que o conserto pode fazer dois quadros
/// colidirem, e é por isso que ela é calculada antes de mexer em qualquer
/// coisa.
fn idioma_e_descricao<'a>(f: &'a Frame<'_>) -> Option<([u8; 3], &'a str)> {
    match f {
        Frame::Comment(c) => Some((c.language, c.description.as_str())),
        Frame::UnsynchronizedText(u) => Some((u.language, u.description.as_str())),
        _ => None,
    }
}

/// Troca por `und` todo campo de idioma inválido dos quadros da tag, para que
/// o arquivo possa ser gravado sem perder quadro nenhum.
///
/// Recusa (sem tocar em nada) o único caso em que o conserto custaria dado:
/// dois quadros do mesmo tipo que, depois de consertados, teriam a MESMA
/// chave (idioma + descrição). Medido: `Id3v2Tag::insert` devolve o quadro
/// substituído e o conteúdo dele some. Recusar é ruim — a música continua sem
/// poder ser curada —, mas apagar a anotação de alguém em silêncio é pior, e a
/// regra inviolável do projeto é essa.
///
/// Nota do que NÃO dá para consertar aqui: quando dois quadros já chegam com a
/// MESMA chave (mesmo idioma inválido e mesma descrição), o próprio LEITOR do
/// lofty funde os dois antes de nos entregar a tag — `read.rs` insere quadro a
/// quadro com `Id3v2Tag::insert`. Essa perda acontece em qualquer leitura,
/// inclusive na do indexador, e está fora do alcance deste código.
fn consertar_idiomas_invalidos(tag: &mut Id3v2Tag, caminho: &str) -> Result<()> {
    // 1. quais identificadores de quadro têm idioma quebrado neste arquivo.
    //    Arquivo sem defeito nenhum não passa por nada abaixo — nem a ordem
    //    dos quadros muda.
    let mut ids: Vec<FrameId<'static>> = Vec::new();
    for f in &*tag {
        if idioma_e_descricao(f).is_some_and(|(lang, _)| !idioma_valido(lang)) {
            let id = FrameId::Valid(Cow::Owned(f.id_str().to_string()));
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
    }

    for id in ids {
        // 2. simula o conserto e confere que nenhuma chave colide.
        let mut chaves: HashSet<([u8; 3], String)> = HashSet::new();
        let cabem_todos = (&*tag)
            .into_iter()
            .filter(|f| f.id() == &id)
            .filter_map(idioma_e_descricao)
            .all(|(lang, desc)| {
                let consertado = if idioma_valido(lang) { lang } else { LANG_INDETERMINADO };
                chaves.insert((consertado, desc.to_string()))
            });
        if !cabem_todos {
            return Err(AppError(format!(
                "não foi possível salvar em {caminho}: {ERRO_ANOTACOES_INDISTINGUIVEIS}"
            )));
        }

        // 3. conserta. O lofty não expõe acesso mutável aos quadros, então os
        //    quadros deste identificador saem e voltam. A ORDEM deles no bloco
        //    ID3v2 muda, e isso é indiferente: o padrão não dá significado à
        //    ordem dos quadros.
        let mut quadros: Vec<Frame<'static>> = tag.remove(&id).collect();
        for f in &mut quadros {
            match f {
                Frame::Comment(c) if !idioma_valido(c.language) => c.language = LANG_INDETERMINADO,
                Frame::UnsynchronizedText(u) if !idioma_valido(u.language) => {
                    u.language = LANG_INDETERMINADO
                }
                _ => {}
            }
        }
        for f in quadros {
            // o passo 2 já provou que não há colisão: nada é substituído aqui
            drop(tag.insert(f));
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// V10.1 — as falhas da GRAVAÇÃO falam pt-BR.
//
// É a mesma família do achado M4 do QA da v0.9.0 (erro de io em inglês
// vazando para a tela), que foi corrigido só no caminho do download: o
// caminho de gravação tinha o mesmo buraco, e era ele que estava aparecendo
// em campo — "ID3v2: Invalid frame language found: [0, 0, 0] (expected 3
// ascii characters)" na tela de quem não sabe o que é um quadro ID3v2 e não
// tem a quem perguntar.
//
// Régua das frases (DECISIONS #100): a primeira parte diz o que aconteceu, e o
// resto só existe para dizer o que fazer. O CAMINHO DO ARQUIVO fica sempre,
// fora da frase: é a única forma de a pessoa saber de qual música se trata
// quando a falha acontece no meio de um lote de 47.
// ---------------------------------------------------------------------------

pub const ERRO_DISCO_CHEIO: &str =
    "não há espaço em disco para gravar as alterações — libere espaço e salve de novo";
pub const ERRO_SEM_PERMISSAO: &str =
    "o computador não deixou gravar neste arquivo — se a pasta estiver sincronizada com a nuvem \
     ou protegida por antivírus, pause e tente de novo";
pub const ERRO_ARQUIVO_EM_USO: &str =
    "o arquivo está aberto em outro programa — feche esse programa e salve de novo";
/// O arquivo saiu de baixo do programa entre a conferência e a abertura: pen
/// drive arrancado, compartilhamento de rede que caiu, HD externo que dormiu.
///
/// **É a ÚNICA frase que fala do aparelho, e é de propósito** (V10.7). Disco
/// desconectado e leitura interrompida produzem `std::io::Error`, e é só aqui
/// que conferir o cabo responde a alguma coisa. A frase antiga dizia isso para
/// oito variantes de PARSE do lofty, em que o arquivo já tinha sido lido com
/// sucesso — mandava mexer no que estava certo.
pub const ERRO_ARQUIVO_SUMIU: &str =
    "o arquivo não está mais onde estava, e nada foi gravado — se ele fica num HD externo ou num \
     pen drive, confira se o aparelho continua ligado e conectado";
/// A ESTRUTURA do arquivo: o lofty abriu, leu, e não entendeu o que achou
/// (`UnknownFormat`, `FileDecoding`, `SizeMismatch`, `TooMuchData`, `FakeTag`).
///
/// A frase não chuta a causa. A hipótese mais provável — um arquivo que na
/// verdade nunca foi MPEG, com nome de `.mp3`, que TOCA no aplicativo porque
/// quem decodifica o áudio é o WebView — é justamente a que não se afirma sem
/// medir: o `tools/diagnosticar_mp3.py` existe para separá-la das outras, e
/// acusar o arquivo errado é a DECISIONS #97.
///
/// E ela não promete que a música continua tocando: com o arquivo realmente
/// corrompido, pode não continuar. O que se afirma é só o que se sabe — que
/// **nós** não mexemos em nada.
pub const ERRO_ESTRUTURA_DO_MP3: &str =
    "o programa não entendeu como este MP3 está montado por dentro, e nada foi alterado no \
     arquivo — não há como gravar etiquetas nele, e não há nada que você possa fazer por aqui";
/// O TEXTO de uma etiqueta: os bytes não correspondem à codificação que o
/// próprio quadro declara (`StringFromUtf8`, `StrFromUtf8`, `TextDecode`).
///
/// **Isto não é arquivo danificado, e chamar de danificado é acusação falsa**
/// (V10.7): o áudio não está em questão, e o arquivo pode estar perfeito. O que
/// existe é um pedaço de texto — o comentário de alguém, um título gravado por
/// um programa antigo — que não dá para reler do jeito que foi escrito.
pub const ERRO_TEXTO_DA_ETIQUETA: &str =
    "o texto de uma etiqueta deste MP3 está escrito de um jeito que o programa não conseguiu ler, \
     e nada foi alterado no arquivo — o problema é só nesse texto, e não há nada que você possa \
     fazer por aqui";
pub const ERRO_ETIQUETAS_FORA_DO_PADRAO: &str =
    "as etiquetas deste MP3 estão num formato que o programa não conseguiu regravar, e o arquivo \
     não foi alterado";
pub const ERRO_ANOTACOES_INDISTINGUIVEIS: &str =
    "este MP3 tem duas anotações que ficariam idênticas ao serem consertadas, e gravar apagaria \
     uma delas — nada foi alterado no arquivo";
/// Depois da gravação bem-sucedida. A frase NÃO diz "não foi possível
/// salvar" porque salvou: a mentira faria a pessoa refazer o trabalho.
pub const ERRO_LISTA_DESATUALIZADA: &str =
    "as alterações foram gravadas neste arquivo, mas a lista de músicas não pôde ser atualizada \
     agora — feche e abra o aplicativo para vê-las";
/// Desfecho de quem não tem tradução prevista. É uma frase em pt-BR que se
/// explica sozinha, e NUNCA o repasse do texto original da biblioteca: quem lê
/// não fala inglês e não tem a quem perguntar.
pub const ERRO_GRAVACAO: &str =
    "não foi possível gravar as alterações neste arquivo — tente de novo e, se continuar, \
     confira se o arquivo ainda está no lugar";

/// `ENOSPC` no Unix; `ERROR_HANDLE_DISK_FULL` e `ERROR_DISK_FULL` no Windows.
/// Mesma lista do `acessorios.rs` — o código do sistema é o mesmo.
#[cfg(unix)]
const CODIGOS_DISCO_CHEIO: &[i32] = &[28];
#[cfg(windows)]
const CODIGOS_DISCO_CHEIO: &[i32] = &[39, 112];
#[cfg(not(any(unix, windows)))]
const CODIGOS_DISCO_CHEIO: &[i32] = &[];

/// `ERROR_SHARING_VIOLATION` e `ERROR_LOCK_VIOLATION` do Windows: o arquivo
/// está aberto por outro programa. É o caso real de quem deixou a música
/// tocando em outro player e mandou salvar aqui — e o Rust não tem um
/// `ErrorKind` estável para ele, só o número do sistema. No Unix não existe
/// bloqueio obrigatório e a lista fica vazia.
#[cfg(windows)]
const CODIGOS_ARQUIVO_EM_USO: &[i32] = &[32, 33];
#[cfg(not(windows))]
const CODIGOS_ARQUIVO_EM_USO: &[i32] = &[];

/// Traduz uma falha de sistema de arquivos para a frase em pt-BR.
fn frase_de_io(e: &std::io::Error) -> &'static str {
    if let Some(codigo) = e.raw_os_error() {
        if CODIGOS_DISCO_CHEIO.contains(&codigo) {
            return ERRO_DISCO_CHEIO;
        }
        if CODIGOS_ARQUIVO_EM_USO.contains(&codigo) {
            return ERRO_ARQUIVO_EM_USO;
        }
    }
    match e.kind() {
        std::io::ErrorKind::PermissionDenied => ERRO_SEM_PERMISSAO,
        // o arquivo sumiu entre a conferência e a abertura (pen drive
        // arrancado, compartilhamento de rede que caiu)
        std::io::ErrorKind::NotFound => ERRO_ARQUIVO_SUMIU,
        _ => ERRO_GRAVACAO,
    }
}

/// Traduz uma falha do lofty para a frase em pt-BR correspondente.
///
/// O `_ =>` no fim é deliberado e é o ponto do achado: erro sem tradução
/// prevista vira uma frase nossa que se explica, e não o texto em inglês da
/// biblioteca. `ErrorKind` é `#[non_exhaustive]`, então a lista vai
/// envelhecer sozinha — o desfecho padrão é o que garante que envelhecer não
/// devolve inglês para a tela.
fn frase_de_lofty(e: &LoftyError) -> &'static str {
    match e.kind() {
        ErrorKind::Io(io) => frase_de_io(io),
        /*
          V10.7 — A ESTRUTURA do arquivo, e não "o arquivo está danificado ou o
          disco foi desconectado".

          As cinco acontecem DEPOIS de o arquivo ter sido aberto e lido com
          sucesso: são falhas de PARSE, e o disco nunca está em questão nelas —
          quando ele está, o erro é um `io::Error` e o braço de cima o pega.
          Mandar conferir o cabo do HD externo por um problema que não é do cabo
          faz a pessoa mexer no que está certo, e num produto sem suporte é a
          pior mensagem possível.

          O que foi MEDIDO na fonte do lofty 0.22.4 sobre estas cinco:
          `UnknownFormat` é o arquivo cujo formato não foi reconhecido (o caso do
          `.mp3` que na verdade é m4a — ele TOCA, porque quem decodifica o áudio
          é o WebView, e só a gravação de etiqueta exige fluxo MPEG);
          `FileDecoding`, `SizeMismatch` e `FakeTag` são um tamanho ou um bloco
          declarado que não corresponde ao que está no arquivo; `TooMuchData`, no
          caminho do MP3, é um tamanho declarado absurdo na leitura.

          Ressalva registrada do `TooMuchData`: no lofty ele também pode sair da
          ESCRITA, se a etiqueta a gravar passar de 256 MB (o teto do campo
          synchsafe) ou se um quadro de imagem alheio passar do limite de
          alocação. Nenhum dos dois é alcançável neste acervo — a etiqueta que
          gravamos tem uma letra de música dentro —, e se um dia for, a frase
          continua não acusando nada que a pessoa tenha feito.
        */
        ErrorKind::UnknownFormat
        | ErrorKind::FileDecoding(_)
        | ErrorKind::SizeMismatch
        | ErrorKind::TooMuchData
        | ErrorKind::FakeTag => ERRO_ESTRUTURA_DO_MP3,
        /*
          V10.7 — o TEXTO de uma etiqueta, que não é arquivo danificado.

          As três são bytes de texto que não correspondem à codificação declarada
          no próprio quadro: um comentário gravado em Latin-1 e anunciado como
          UTF-8, um título de um programa antigo, um UTF-16 sem a marca de ordem
          dos bytes. O áudio não está envolvido e o arquivo pode estar perfeito —
          dizer "pode estar danificado" aqui é acusar o arquivo errado
          (DECISIONS #97), e quem lê não tem a quem perguntar se é verdade.
        */
        ErrorKind::StringFromUtf8(_)
        | ErrorKind::StrFromUtf8(_)
        | ErrorKind::TextDecode(_) => ERRO_TEXTO_DA_ETIQUETA,
        // o áudio está bom; são as etiquetas que o lofty recusa a regravar
        ErrorKind::Id3v2(_)
        | ErrorKind::FileEncoding(_)
        | ErrorKind::UnsupportedTag
        | ErrorKind::NotAPicture
        | ErrorKind::UnsupportedPicture
        | ErrorKind::BadTimestamp(_) => ERRO_ETIQUETAS_FORA_DO_PADRAO,
        _ => ERRO_GRAVACAO,
    }
}

/// Monta a mensagem que a pessoa vê: o caminho do arquivo (de qual música se
/// trata) e uma frase em pt-BR que diz o que aconteceu e o que fazer.
fn erro_de_gravacao(caminho: &str, frase: &str) -> AppError {
    AppError(format!("não foi possível salvar em {caminho}: {frase}"))
}

/// Grava TIT2/TPE1/USLT/TXXX:TEMAS/TXXX:INSTRUMENTAL no MP3 da música
/// `song_id` (ID3v2.4), reindexa o arquivo (upsert — FTS atualizada pelos
/// triggers) e devolve a Song atualizada. `None`/vazio em artist/lyrics/temas
/// REMOVE o frame. Nunca renomeia o arquivo nem altera os frames de áudio.
///
/// `instrumental` (V8/F17) é uma opção de TRÊS estados, e é assim de
/// propósito: `Some(true)` marca, `Some(false)` desmarca e `None` significa
/// "não mexer". Só a escolha explícita de quem está olhando o formulário (ou
/// da curadoria que ouviu o áudio) mexe na marca; o lote do "Completar dados"
/// e qualquer gravação de título/letra passam `None` e não podem desfazê-la —
/// "marcada à mão, nenhuma rotina desmarca sozinha" (PRD V8).
pub fn write_tags(
    conn: &Connection,
    song_id: i64,
    title: &str,
    artist: Option<&str>,
    lyrics: Option<&str>,
    temas: Option<&str>,
    instrumental: Option<bool>,
) -> Result<Song> {
    write_tags_com_origem(conn, song_id, title, artist, lyrics, temas, instrumental, None)
}

/// O mesmo `write_tags`, com a procedência da letra DECLARADA pelo chamador
/// (V8/F18). Só o funil usa esta porta; o editor do player continua no
/// `write_tags`, que não sabe de onde a letra veio.
///
/// `letra_origem`:
/// - `None` — "não sei": vale a regra da DECISIONS #54, a marca sobrevive
///   se e só se a letra do arquivo não mudou;
/// - `Some("lyrics.ovh")` / `Some("transcricao")` — a letra que está sendo
///   gravada veio daquela fonte, e é assim que ela fica marcada, no mesmo
///   vocabulário que o `tools/curadoria.py` usa;
/// - `Some("")` — declaração de que a letra é oficial e SEM marca (o caminho
///   do LRCLIB): limpa qualquer marca herdada, inclusive a de transcrição.
///
/// A declaração só vale quando a letra MUDA — que é exatamente o momento em
/// que a marca precisa ser refeita (DECISIONS #54). Gravação que não mexe na
/// letra (só título/artista/temas, ou o repasse do mesmo texto que o lote
/// faz) ignora o parâmetro e preserva a marca legítima: a procedência
/// descreve a letra ATUAL, e essa letra continua sendo a mesma.
#[allow(clippy::too_many_arguments)]
pub fn write_tags_com_origem(
    conn: &Connection,
    song_id: i64,
    title: &str,
    artist: Option<&str>,
    lyrics: Option<&str>,
    temas: Option<&str>,
    instrumental: Option<bool>,
    letra_origem: Option<&str>,
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
        .map_err(|e| erro_de_gravacao(&song.file_path, frase_de_io(&e)))?;
    // `ParseOptions::new()` (BestAttempt) é a leitura de sempre, e continua
    // sendo: os três modos leem este acervo igual — ver o bloco do
    // `consertar_idiomas_invalidos`. Modo mais tolerante não conserta nada
    // aqui e DESCARTA quadros, que é o que não podemos fazer.
    let mpeg = MpegFile::read_from(&mut file, ParseOptions::new())
        .map_err(|e| erro_de_gravacao(&song.file_path, frase_de_lofty(&e)))?;
    drop(file);
    let mut tag: Id3v2Tag = mpeg.id3v2().cloned().unwrap_or_default();

    // Antes de qualquer alteração: um campo de idioma quebrado num quadro
    // alheio faria a gravação inteira falhar lá embaixo, e a música sairia da
    // curadoria para sempre. Consertar (e não descartar) preserva o conteúdo.
    consertar_idiomas_invalidos(&mut tag, &song.file_path)?;

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
    //
    // V8/F18: a letra MUDOU é o momento em que a marca precisa ser refeita.
    // Sem declaração ela some (regra acima); com declaração ela passa a ser o
    // que o funil informou — "" para letra oficial sem marca, o nome da fonte para
    // a base comunitária. O frame antigo cai antes em qualquer caso, para
    // substituir em vez de duplicar.
    if letra_nova != letra_anterior.as_deref() {
        drop(tag.remove_user_text(LETRA_ORIGEM_DESC));
        if let Some(origem) = letra_origem.filter(|o| !o.is_empty() && letra_nova.is_some()) {
            tag.insert_user_text(LETRA_ORIGEM_DESC.to_string(), origem.to_string());
        }
    }

    // TXXX:INSTRUMENTAL (V8/F17) — a marca descreve a MÚSICA (não tem voz),
    // não a letra, e por isso NÃO segue a regra da DECISIONS #54 logo acima:
    // trocar ou apagar a letra invalida a procedência da letra, mas não diz
    // nada sobre haver ou não canto no áudio. O PRD prevê explicitamente a
    // instrumental com letra registrada, e desmarcar de lado — como efeito
    // colateral de salvar um texto — desfaria em silêncio a escolha de quem
    // ouviu a música. Só o `Some(...)` explícito mexe aqui.
    match instrumental {
        Some(true) => {
            drop(tag.remove_user_text(INSTRUMENTAL_DESC));
            tag.insert_user_text(INSTRUMENTAL_DESC.to_string(), "1".to_string());
        }
        Some(false) => drop(tag.remove_user_text(INSTRUMENTAL_DESC)),
        None => {} // não mexe: preserva o que estiver no arquivo
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
        .map_err(|e| erro_de_gravacao(&song.file_path, frase_de_lofty(&e)))?;

    // Re-stata mtime/size e upserta — banco/FTS em sincronia na hora, e o
    // próximo rescan não precisa reler o arquivo.
    //
    // Daqui para baixo o ARQUIVO JÁ FOI GRAVADO, e é por isso que a falha tem
    // frase própria: dizer "não foi possível salvar" seria mentira, e a pessoa
    // gravaria tudo de novo achando que nada tinha sido feito. O que ficou
    // para trás é só a lista na tela, e reabrir o aplicativo a refaz.
    indexer::index_single_file(conn, song.folder_id, path).map_err(|_| {
        AppError(format!("{}: {ERRO_LISTA_DESATUALIZADA}", song.file_path))
    })?;

    db::get_song(conn, song_id)?
        .ok_or_else(|| AppError(format!("música não encontrada: {song_id}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idioma_valido_segue_a_regua_do_lofty() {
        assert!(idioma_valido(*b"por"));
        assert!(idioma_valido(*b"und"));
        assert!(idioma_valido(*b"XXX")); // maiúsculas contam
        assert!(!idioma_valido([0, 0, 0])); // o caso do campo
        assert!(!idioma_valido(*b"p0r")); // dígito no meio
        assert!(!idioma_valido(*b"po ")); // espaço de preenchimento
        // o valor com que consertamos precisa passar na régua, senão o
        // conserto trocaria uma recusa por outra
        assert!(idioma_valido(LANG_INDETERMINADO));
    }

    /// Monta uma tag em memória com os quadros pedidos. Construir um quadro
    /// com idioma inválido é possível (`CommentFrame::new` aceita três bytes
    /// quaisquer) — quem valida é a ESCRITA, que é justamente o defeito.
    fn tag_com(quadros: Vec<Frame<'static>>) -> Id3v2Tag {
        let mut tag = Id3v2Tag::new();
        for q in quadros {
            drop(tag.insert(q));
        }
        tag
    }

    fn comentario(lang: [u8; 3], desc: &str, texto: &str) -> Frame<'static> {
        Frame::Comment(lofty::id3::v2::CommentFrame::new(
            TextEncoding::UTF8,
            lang,
            desc.to_string(),
            texto.to_string(),
        ))
    }

    fn letra(lang: [u8; 3], texto: &str) -> Frame<'static> {
        Frame::UnsynchronizedText(UnsynchronizedTextFrame::new(
            TextEncoding::UTF8,
            lang,
            String::new(),
            texto.to_string(),
        ))
    }

    /// O conserto troca só o que está quebrado, em COMM e em USLT, e não
    /// perde quadro nenhum.
    ///
    /// O USLT precisa de teste AQUI porque o `write_tags` sempre remove e
    /// regrava o USLT antes de salvar: pelo caminho de fora, um USLT quebrado
    /// nunca chega à gravação, e um teste de integração passaria por outro
    /// motivo que não o conserto (DECISIONS #113 — teste que só visita o caso
    /// fácil certifica o contrário do que o código faz).
    #[test]
    fn o_conserto_troca_so_o_idioma_quebrado_e_nao_perde_quadro() {
        let mut tag = tag_com(vec![
            comentario([0, 0, 0], "anotacao", "anotação de alguém"),
            comentario(*b"eng", "outra", "someone else's note"),
            letra([0, 0, 0], "a letra inteira desta música"),
        ]);

        consertar_idiomas_invalidos(&mut tag, "/acervo/x.mp3").unwrap();

        assert_eq!(tag.len(), 3, "nenhum quadro pode sumir no conserto");
        // `Id3v2Tag::comments()` só devolve COMM de descrição vazia; aqui
        // interessam TODOS, inclusive o de descrição preenchida.
        let comms: BTreeMap<String, ([u8; 3], String)> = (&tag)
            .into_iter()
            .filter_map(|f| match f {
                Frame::Comment(c) => {
                    Some((c.description.clone(), (c.language, c.content.clone())))
                }
                _ => None,
            })
            .collect();
        assert_eq!(
            comms["anotacao"],
            (*b"und", "anotação de alguém".to_string()),
            "idioma quebrado vira `und` e o texto sobrevive"
        );
        assert_eq!(
            comms["outra"],
            (*b"eng", "someone else's note".to_string()),
            "idioma válido não é mexido"
        );
        let uslt = tag.unsync_text().next().unwrap();
        assert_eq!(&uslt.language, b"und");
        assert_eq!(uslt.content, "a letra inteira desta música");
    }

    /// Arquivo sem defeito não passa por conserto nenhum — nem a ordem dos
    /// quadros muda. É o caso de 100% do acervo bem gravado.
    #[test]
    fn o_conserto_nao_encosta_num_arquivo_sem_defeito() {
        let quadros = vec![
            comentario(*b"por", "a", "um"),
            comentario(*b"eng", "b", "dois"),
            letra(*b"por", "três"),
        ];
        let mut tag = tag_com(quadros.clone());
        consertar_idiomas_invalidos(&mut tag, "/acervo/x.mp3").unwrap();
        let depois: Vec<Frame<'static>> = tag.into_iter().collect();
        assert_eq!(depois, quadros);
    }

    /// Dois quadros que o conserto tornaria indistinguíveis: recusa, e a tag
    /// não é usada para gravar nada. Medido: sem esta guarda o
    /// `Id3v2Tag::insert` devolve o quadro substituído e o texto some.
    #[test]
    fn o_conserto_recusa_quando_fundiria_dois_quadros() {
        let mut tag = tag_com(vec![
            comentario([0, 0, 0], "anotacao", "PRIMEIRA"),
            comentario([0, 0, 1], "anotacao", "SEGUNDA"),
        ]);

        let err = consertar_idiomas_invalidos(&mut tag, "/acervo/x.mp3")
            .expect_err("fundir dois quadros é apagar dado existente");
        assert_eq!(
            err.to_string(),
            format!("não foi possível salvar em /acervo/x.mp3: {ERRO_ANOTACOES_INDISTINGUIVEIS}")
        );

        // ...e a recusa vale só para a colisão: as MESMAS duas anotações com
        // descrições diferentes passam, porque as chaves seguem distintas
        let mut tag = tag_com(vec![
            comentario([0, 0, 0], "anotacao", "PRIMEIRA"),
            comentario([0, 0, 1], "outra", "SEGUNDA"),
        ]);
        consertar_idiomas_invalidos(&mut tag, "/acervo/x.mp3").unwrap();
        assert_eq!(tag.len(), 2);
    }

    /// Nenhuma falha do lofty pode chegar à tela em inglês: o desfecho padrão
    /// é uma frase nossa. `ErrorKind` é `#[non_exhaustive]`, então esta é a
    /// garantia que sobrevive à próxima versão da biblioteca.
    ///
    /// **V10.7 — e a tabela passou a ser COMPLETA**, variante por variante. Oito
    /// delas caíam na mesma frase, que falava de arquivo danificado e de disco
    /// desconectado; nenhuma das oito tem a ver com disco, e três nem com
    /// arquivo danificado. Uma tabela que só visita duas variantes é a
    /// DECISIONS #113: ela certifica o caso fácil e cala sobre o resto.
    #[test]
    fn toda_falha_do_lofty_vira_frase_em_portugues() {
        use lofty::error::{FileDecodingError, Id3v2Error, Id3v2ErrorKind};
        use lofty::file::FileType;

        /// Dois bytes que não são UTF-8 — o começo de um texto de etiqueta
        /// gravado em Latin-1 e anunciado como UTF-8. Montados em tempo de
        /// execução de propósito: sobre um literal, o próprio compilador avisa
        /// que a conversão sempre falha, e aviso é o que esta suíte não tem.
        fn bytes_invalidos() -> Vec<u8> {
            vec![0xff, 0xfe]
        }

        let casos: Vec<(LoftyError, &str)> = vec![
            (
                // o defeito relatado em campo
                LoftyError::from(Id3v2Error::new(Id3v2ErrorKind::InvalidLanguage([0, 0, 0]))),
                ERRO_ETIQUETAS_FORA_DO_PADRAO,
            ),
            // A ESTRUTURA do arquivo: o que a biblioteca não conseguiu ler do
            // jeito que está montado. O arquivo foi ABERTO com sucesso nos
            // cinco casos — não há disco em questão em nenhum deles.
            (
                LoftyError::from(FileDecodingError::new(FileType::Mpeg, "qualquer coisa")),
                ERRO_ESTRUTURA_DO_MP3,
            ),
            (
                LoftyError::new(ErrorKind::UnknownFormat),
                ERRO_ESTRUTURA_DO_MP3,
            ),
            (
                LoftyError::new(ErrorKind::SizeMismatch),
                ERRO_ESTRUTURA_DO_MP3,
            ),
            (
                LoftyError::new(ErrorKind::TooMuchData),
                ERRO_ESTRUTURA_DO_MP3,
            ),
            (LoftyError::new(ErrorKind::FakeTag), ERRO_ESTRUTURA_DO_MP3),
            // O TEXTO de uma etiqueta: bytes que não correspondem à codificação
            // que o próprio quadro declara. O arquivo pode estar perfeito, e
            // chamá-lo de danificado é acusação falsa (DECISIONS #97).
            (
                LoftyError::from(String::from_utf8(bytes_invalidos()).unwrap_err()),
                ERRO_TEXTO_DA_ETIQUETA,
            ),
            (
                LoftyError::from(std::str::from_utf8(&bytes_invalidos()).unwrap_err()),
                ERRO_TEXTO_DA_ETIQUETA,
            ),
            (
                LoftyError::new(ErrorKind::TextDecode("expected a UTF-16 BOM")),
                ERRO_TEXTO_DA_ETIQUETA,
            ),
            (
                LoftyError::from(std::io::Error::from(std::io::ErrorKind::PermissionDenied)),
                ERRO_SEM_PERMISSAO,
            ),
            (
                LoftyError::from(std::io::Error::from(std::io::ErrorKind::NotFound)),
                ERRO_ARQUIVO_SUMIU,
            ),
            (
                // sem tradução prevista: cai no desfecho padrão, em pt-BR
                LoftyError::new(ErrorKind::AtomMismatch),
                ERRO_GRAVACAO,
            ),
        ];

        for (erro, esperada) in casos {
            let frase = frase_de_lofty(&erro);
            assert_eq!(frase, esperada, "tradução errada para {erro}");
            assert_ne!(
                frase,
                erro.to_string(),
                "a frase não pode ser o repasse do texto da biblioteca"
            );
        }
    }

    /// V10.7 — **a falha de PARSE não pode acusar o disco.**
    ///
    /// A frase antiga mandava conferir se "o disco onde ele está pode ter sido
    /// desconectado" para oito variantes que só acontecem depois de o arquivo
    /// ter sido lido com sucesso. Num produto sem suporte, essa é a pior
    /// mensagem possível: ela faz a pessoa mexer no que está certo — desligar e
    /// religar o HD externo por um problema que não é do cabo.
    ///
    /// Disco desconectado e leitura interrompida por I/O produzem
    /// `std::io::Error`, que tem caminho próprio (`frase_de_io`), e é lá que
    /// esse vocabulário mora.
    #[test]
    fn a_falha_de_parse_nao_acusa_o_disco_nem_manda_mexer_no_aparelho() {
        let de_parse = [
            ERRO_ESTRUTURA_DO_MP3,
            ERRO_TEXTO_DA_ETIQUETA,
            ERRO_ETIQUETAS_FORA_DO_PADRAO,
            ERRO_ANOTACOES_INDISTINGUIVEIS,
        ];
        for frase in de_parse {
            for palavra in ["disco", "desconect", "cabo", "pen drive", "conectad"] {
                assert!(
                    !frase.contains(palavra),
                    "falha de parse não pode falar de {palavra:?}: {frase}"
                );
            }
            // e as quatro acontecem ANTES de o arquivo ser tocado: dizer isso é
            // a única coisa que responde ao medo de quem lê ("perdi a música?")
            assert!(
                frase.contains("não foi alterado") || frase.contains("nada foi alterado"),
                "toda recusa de parse precisa dizer que o arquivo ficou intacto: {frase}"
            );
        }
    }

    /// O aparelho só é citado onde ele está em questão: o arquivo que saiu de
    /// baixo do programa entre a conferência e a abertura (pen drive arrancado,
    /// compartilhamento de rede que caiu) é um `io::Error` de `NotFound`.
    #[test]
    fn o_aparelho_desconectado_e_do_caminho_de_io_e_so_dele() {
        let sumiu = std::io::Error::from(std::io::ErrorKind::NotFound);
        assert_eq!(frase_de_io(&sumiu), ERRO_ARQUIVO_SUMIU);
        assert!(
            ERRO_ARQUIVO_SUMIU.contains("conectado"),
            "é aqui que conferir o aparelho faz sentido: {ERRO_ARQUIVO_SUMIU}"
        );
    }

    /// **Duas famílias com a MESMA frase são uma família só na tela** — e é
    /// exatamente assim que as oito variantes viraram uma. Este teste é o que
    /// faz a próxima fusão exigir uma justificativa em vez de acontecer por
    /// distração, e a régua da DECISIONS #100 vale para as frases do backend
    /// como para as da tela: elas SÃO a tela.
    #[test]
    fn cada_familia_tem_a_sua_frase_e_ela_cabe_na_regua() {
        let todas = [
            ERRO_DISCO_CHEIO,
            ERRO_SEM_PERMISSAO,
            ERRO_ARQUIVO_EM_USO,
            ERRO_ARQUIVO_SUMIU,
            ERRO_ESTRUTURA_DO_MP3,
            ERRO_TEXTO_DA_ETIQUETA,
            ERRO_ETIQUETAS_FORA_DO_PADRAO,
            ERRO_ANOTACOES_INDISTINGUIVEIS,
            ERRO_LISTA_DESATUALIZADA,
            ERRO_GRAVACAO,
        ];
        let distintas: HashSet<&str> = todas.iter().copied().collect();
        assert_eq!(
            distintas.len(),
            todas.len(),
            "duas famílias diferentes não podem dizer a mesma coisa"
        );
        for frase in todas {
            let n = frase.chars().count();
            assert!(n <= 210, "{n} caracteres, o teto é 210: {frase}");
            assert!(!frase.is_empty());
        }
    }

    /// Códigos do sistema que têm frase própria. "erro de gravação" genérico
    /// mandaria a pessoa procurar defeito no lugar errado (DECISIONS #116).
    #[test]
    fn os_codigos_do_sistema_com_frase_propria() {
        for codigo in CODIGOS_DISCO_CHEIO {
            let e = std::io::Error::from_raw_os_error(*codigo);
            assert_eq!(frase_de_io(&e), ERRO_DISCO_CHEIO, "código {codigo}");
        }
        for codigo in CODIGOS_ARQUIVO_EM_USO {
            let e = std::io::Error::from_raw_os_error(*codigo);
            assert_eq!(frase_de_io(&e), ERRO_ARQUIVO_EM_USO, "código {codigo}");
        }
        // e o que não está em lista nenhuma continua tendo frase em pt-BR
        let outro = std::io::Error::from(std::io::ErrorKind::Other);
        assert_eq!(frase_de_io(&outro), ERRO_GRAVACAO);
    }

    /// A mensagem que chega à tela carrega o CAMINHO do arquivo: sem ele, uma
    /// falha no meio de um lote não diz de qual música se trata.
    #[test]
    fn a_mensagem_cita_o_arquivo() {
        let caminho = "/Users/alguem/Downloads/musicas/Humor/Apologia ao jumento.mp3";
        let e = erro_de_gravacao(caminho, ERRO_ESTRUTURA_DO_MP3);
        assert!(e.to_string().contains(caminho));
        assert!(e.to_string().starts_with("não foi possível salvar em "));
    }

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
