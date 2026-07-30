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
/// V10.8 — a conferência do áudio reprovou, e o arquivo VOLTOU ao que era.
///
/// Não é uma promessa: o conserto da etiqueta calcula o resumo (SHA-256) dos
/// bytes de áudio antes de mexer e o confere depois de gravar. Se um único byte
/// mudou, os bytes originais — que ficaram na memória exatamente para isto —
/// são regravados e a gravação vira recusa. Nunca sai daqui um arquivo alterado.
pub const ERRO_AUDIO_MUDARIA: &str =
    "gravar neste MP3 mudaria o som da música, então o programa desfez tudo e o arquivo voltou a \
     ser o que era — não há como gravar etiquetas nele, e não há nada que você possa fazer por aqui";
/// V10.8 — o desfecho mais raro: a conferência reprovou E devolver os bytes
/// originais ao arquivo também falhou (o disco encheu, o arquivo saiu do lugar
/// no meio da operação).
///
/// Ela existe porque é a única situação de todo o produto em que o arquivo pode
/// ter ficado diferente do que era, e calar sobre isso seria a pior mentira
/// possível para quem não tem a quem perguntar.
pub const ERRO_ARQUIVO_NAO_VOLTOU: &str =
    "o programa desfez uma gravação que não deu certo, mas não conseguiu devolver este arquivo ao \
     que ele era — não mexa nele por enquanto, e recupere a música de uma cópia se você tiver uma";
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

// ---------------------------------------------------------------------------
// V10.8 — a SOBRA entre o fim declarado da etiqueta e o primeiro quadro MPEG,
// e por que o conserto acontece JUNTO com a gravação que a pessoa pediu.
//
// # O defeito, medido
//
// Sete arquivos de um acervo real recusavam TODA gravação. Eles têm uma região
// de bytes entre o fim DECLARADO da etiqueta ID3v2 e o primeiro quadro MPEG. No
// arquivo medido: a etiqueta declarando terminar no byte 4.096 e o primeiro
// quadro em 5.347 — 1.251 bytes que não são etiqueta declarada, não são
// cabeçalho de codificador e não são áudio (81% zeros com bytes aleatórios por
// cima).
//
// O que a medição no lofty 0.22.4 mostrou, e o que dá a razão de cada linha
// daqui:
//
// 1. a LEITURA passa. `MpegFile::read_from` procura o sync de MPEG sem teto
//    nenhum (`find_next_frame`), acha o quadro 1.251 bytes adiante e devolve a
//    etiqueta inteira. É por isso que estes arquivos tocam, aparecem na lista
//    com título e artista, e nada avisa que há algo errado neles;
// 2. a GRAVAÇÃO falha com `UnknownFormat`. Ao gravar, o lofty reexamina o
//    formato pelo CONTEÚDO (`Probe::guess_file_type` dentro de `write_id3v2`),
//    e ali a busca do sync tem teto: `ParseOptions::DEFAULT_MAX_JUNK_BYTES`,
//    que é 1.024. 1.251 > 1.024, o sync não é encontrado, e o formato fica
//    "desconhecido". **É por isso que uma sobra MENOR grava sem reclamar**, e é
//    por isso que uma etiqueta de 4.096 bytes sem sobra nenhuma também grava:
//    o tamanho da etiqueta nunca foi o problema;
// 3. na falha, nada é escrito — o arquivo fica byte a byte igual, porque a
//    recusa acontece antes de o lofty tocar nele;
// 4. corrigir o CAMPO DE TAMANHO do cabeçalho ID3v2 para alcançar o primeiro
//    quadro (4086 → 5337, dois bytes trocados) faz o lofty ler E gravar. A
//    região passa a ser enchimento DECLARADO dentro da etiqueta, que é o que
//    todo editor de etiqueta escreve depois dos quadros;
// 5. o áudio sobrevive idêntico: conferido pelo SHA-256 dos bytes de áudio
//    antes e depois (16.508 bytes, o mesmo resumo nos dois).
//
// # Por que o conserto não pergunta nada
//
// A pessoa já decidiu: ela mandou gravar esta letra neste arquivo. Corrigir o
// número da etiqueta é o MEIO de fazer o que ela pediu, não uma segunda
// decisão — e perguntar "seu arquivo tem uma anomalia estrutural, posso
// corrigir 2 bytes?" é uma pergunta técnica para quem não tem como respondê-la:
// exatamente o pedágio que a DECISIONS #102 existe para eliminar. O que ela
// recebe é o DESFECHO, dito em português (`AVISO_ETIQUETA_NORMALIZADA`).
//
// # Por que o gatilho é a FALHA, e nunca a suspeita
//
// O detector de anomalia erra. Num MP3 feito com LAME o primeiro quadro de
// áudio carrega o cabeçalho Xing/Info, com enchimento `0x55` e a assinatura do
// codificador; um detector que procura o primeiro `FF Fx` depois da etiqueta
// pode achar o SEGUNDO quadro e chamar o miolo do primeiro de "sobra". O
// `tools/diagnosticar_mp3.py` já acusou um arquivo PERFEITO por isso (ver a
// função `sobra_e_inocente`, que documenta o erro).
//
// Com o gatilho sendo a falha real, esse falso positivo fica **inalcançável**:
// arquivo que grava não passa por aqui, e nem o campo de tamanho dele é lido.
// Nenhuma varredura procura anomalia, e nenhum arquivo são é examinado.
// ---------------------------------------------------------------------------

/// O desfecho a contar quando a gravação só foi possível depois de normalizar o
/// cabeçalho da etiqueta.
///
/// Régua da DECISIONS #100 (no máximo duas frases, 210 caracteres) e o mesmo
/// compromisso das frases de erro: **diz o que aconteceu** ("o programa corrigiu
/// uma medida errada"), **responde ao medo de quem lê** ("a música em si não foi
/// alterada") e **não promete: conta o que foi conferido**. Sem pedágio antes e
/// sem segredo depois.
pub const AVISO_ETIQUETA_NORMALIZADA: &str =
    "para conseguir gravar, o programa corrigiu uma medida errada por dentro da etiqueta deste \
     MP3 — a música em si não foi alterada, e o programa conferiu isso depois de gravar";

/// Marcas de OUTRA etiqueta dentro da sobra. Achar qualquer uma delas cancela o
/// conserto.
///
/// Absorver a sobra no tamanho declarado da primeira etiqueta faz o lofty
/// reescrever aquela região na gravação seguinte — e se o que estava ali era uma
/// SEGUNDA etiqueta (ID3v2 grudada, o rodapé de uma, uma etiqueta APE, uma
/// ID3v1 no lugar errado), isso apagaria a anotação de alguém. "Nunca apagar
/// dado existente" é a regra inviolável, e a diferença entre enchimento e dado
/// é justamente a assinatura: dado de etiqueta sempre tem uma.
///
/// A lista é a mesma do `MARCAS_DA_SOBRA` do `tools/diagnosticar_mp3.py`, menos
/// as marcas de codificador (`Xing`/`Info`/`LAME`), que são a sobra INOCENTE que
/// nunca chega aqui — arquivo com cabeçalho de codificador grava, e o gatilho é
/// a falha.
const MARCAS_DE_OUTRA_ETIQUETA: &[&[u8]] = &[b"ID3", b"3DI", b"APETAGEX", b"TAG"];

/// Tabelas do cabeçalho de quadro MPEG, na ordem dos índices do próprio
/// cabeçalho. São as tabelas do padrão, e existem aqui por uma razão só: achar o
/// primeiro quadro com CERTEZA. Um palpite errado sobre onde o áudio começa é a
/// única forma de este código estragar uma música — e é a conferência do
/// SHA-256, não esta tabela, que garante que isso não sai daqui.
const BITRATES_MPEG1: [[u32; 15]; 3] = [
    // camada I
    [32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0],
    // camada II
    [32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0],
    // camada III
    [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
];
const BITRATES_MPEG2: [[u32; 15]; 3] = [
    // camada I
    [32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0],
    // camadas II e III compartilham a tabela
    [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
    [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
];
const AMOSTRAGENS: [[u32; 3]; 4] = [
    [11025, 12000, 8000], // versão 0 = MPEG 2.5
    [0, 0, 0],            // versão 1 = reservada
    [22050, 24000, 16000], // versão 2 = MPEG 2
    [44100, 48000, 32000], // versão 3 = MPEG 1
];

/// Comprimento em bytes do quadro cujo cabeçalho são estes quatro bytes;
/// `None` quando eles não são um cabeçalho de quadro MPEG válido.
fn tamanho_do_quadro_mpeg(h: [u8; 4]) -> Option<usize> {
    // 11 bits de sync
    if h[0] != 0xFF || h[1] & 0xE0 != 0xE0 {
        return None;
    }
    let versao = ((h[1] >> 3) & 0x03) as usize; // 1 é reservada
    let camada = ((h[1] >> 1) & 0x03) as usize; // 0 é reservada
    if versao == 1 || camada == 0 {
        return None;
    }
    let i_camada = 3 - camada; // 3=I → 0, 2=II → 1, 1=III → 2
    let i_bitrate = ((h[2] >> 4) & 0x0F) as usize; // 0 = livre, 15 = inválido
    let i_amostragem = ((h[2] >> 2) & 0x03) as usize; // 3 = inválido
    if i_bitrate == 0 || i_bitrate == 15 || i_amostragem == 3 {
        return None;
    }
    let bitrate = if versao == 3 {
        BITRATES_MPEG1[i_camada][i_bitrate - 1]
    } else {
        BITRATES_MPEG2[i_camada][i_bitrate - 1]
    } * 1000;
    let amostragem = AMOSTRAGENS[versao][i_amostragem];
    if bitrate == 0 || amostragem == 0 {
        return None;
    }
    let enchimento = ((h[2] >> 1) & 0x01) as usize;
    let tamanho = match camada {
        // camada I conta em blocos de 4 bytes
        3 => (12 * bitrate as usize / amostragem as usize + enchimento) * 4,
        // camada III de MPEG 2 / 2.5 tem metade das amostras por quadro
        1 if versao != 3 => 72 * bitrate as usize / amostragem as usize + enchimento,
        _ => 144 * bitrate as usize / amostragem as usize + enchimento,
    };
    (tamanho > 4).then_some(tamanho)
}

/// Os bits que dois quadros do MESMO fluxo têm sempre iguais: sync, versão,
/// camada e taxa de amostragem. É a máscara que o próprio lofty usa
/// (`HEADER_MASK`), e é ela que transforma "achei um `FF Fx`" em "achei um
/// quadro".
const MASCARA_DO_CABECALHO: u32 = 0xFFFE_0C00;

/// Posição do PRIMEIRO quadro MPEG a partir de `inicio` — conferida por dois
/// quadros, e não por um.
///
/// Um `FF Fx` solto aparece dentro de qualquer bloco de bytes; o que identifica
/// um quadro de verdade é o quadro SEGUINTE cair exatamente no comprimento
/// calculado, com a mesma versão, camada e taxa de amostragem. É a mesma
/// conferência do `cmp_header` do lofty, e é o que torna o resultado utilizável
/// para decidir onde o áudio começa.
fn primeiro_quadro_mpeg(bytes: &[u8], inicio: usize) -> Option<usize> {
    let mut i = inicio;
    while i + 4 <= bytes.len() {
        let cabecalho: [u8; 4] = bytes[i..i + 4].try_into().unwrap();
        if let Some(tamanho) = tamanho_do_quadro_mpeg(cabecalho) {
            let seguinte = i + tamanho;
            if seguinte + 4 <= bytes.len() {
                let proximo: [u8; 4] = bytes[seguinte..seguinte + 4].try_into().unwrap();
                let a = u32::from_be_bytes(cabecalho) & MASCARA_DO_CABECALHO;
                let b = u32::from_be_bytes(proximo) & MASCARA_DO_CABECALHO;
                if a == b && tamanho_do_quadro_mpeg(proximo).is_some() {
                    return Some(i);
                }
            } else if seguinte <= bytes.len() {
                // o último quadro do arquivo não tem um seguinte para conferir
                return Some(i);
            }
        }
        i += 1;
    }
    None
}

/// Fim DECLARADO do bloco ID3v2 do começo do arquivo, quando há um que dá para
/// interpretar com segurança.
///
/// Recusa (devolvendo `None`) tudo que não é o caso simples: arquivo que não
/// começa com `ID3`, campo de tamanho com bit alto aceso (não é synchsafe: o
/// número não quer dizer nada), tamanho que passa do fim do arquivo, e
/// **etiqueta com RODAPÉ** — o rodapé desloca o fim do bloco em 10 bytes, e
/// errar essa conta aqui é a única forma de o conserto mirar no lugar errado.
/// Nenhum dos arquivos do relato tem rodapé, e recusar custa uma gravação que já
/// estava recusada de qualquer jeito.
fn fim_declarado_do_id3v2(bytes: &[u8]) -> Option<usize> {
    if bytes.len() < 10 || &bytes[..3] != b"ID3" {
        return None;
    }
    // bit 0x10 dos sinalizadores = rodapé presente (só existe no ID3v2.4)
    if bytes[5] & 0x10 != 0 {
        return None;
    }
    let tamanho = &bytes[6..10];
    if tamanho.iter().any(|b| b & 0x80 != 0) {
        return None;
    }
    let fim = 10
        + (((tamanho[0] as usize) << 21)
            | ((tamanho[1] as usize) << 14)
            | ((tamanho[2] as usize) << 7)
            | (tamanho[3] as usize));
    (fim <= bytes.len()).then_some(fim)
}

/// Os quatro bytes synchsafe do campo de tamanho para um bloco ID3v2 que termina
/// em `fim` (cabeçalho incluído). `None` se o valor não cabe nos 28 bits do
/// campo.
fn tamanho_synchsafe(fim: usize) -> Option<[u8; 4]> {
    let corpo = fim.checked_sub(10)?;
    if corpo >= 1 << 28 {
        return None;
    }
    Some([
        ((corpo >> 21) & 0x7F) as u8,
        ((corpo >> 14) & 0x7F) as u8,
        ((corpo >> 7) & 0x7F) as u8,
        (corpo & 0x7F) as u8,
    ])
}

/// Resumo SHA-256 de um bloco de bytes. É o mesmo algoritmo com que o
/// `acessorios.rs` confere os binários baixados: aqui ele confere que o ÁUDIO
/// que estava no arquivo é o áudio que continua nele.
fn resumo(bytes: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).into()
}

/// Devolve os bytes originais ao arquivo. `Err` só quando nem isso foi
/// possível — a única situação de todo o produto em que o arquivo pode ter
/// ficado diferente do que era.
fn restaurar(path: &Path, original: &[u8], caminho: &str) -> Result<()> {
    std::fs::write(path, original)
        .map_err(|_| erro_de_gravacao(caminho, ERRO_ARQUIVO_NAO_VOLTOU))
}

/// Grava a etiqueta e devolve a frase do desfecho: `None` para a gravação
/// comum, `Some` quando ela só foi possível depois de normalizar o cabeçalho.
///
/// **O gatilho é a falha.** Arquivo que grava normalmente sai daqui pelo
/// primeiro `Ok` e não tem um único byte examinado — nenhuma suspeita, nenhuma
/// varredura, nenhum falso positivo possível.
fn salvar_etiqueta(
    tag: &Id3v2Tag,
    path: &Path,
    caminho: &str,
) -> Result<Option<&'static str>> {
    match tag.save_to_path(path, WriteOptions::default()) {
        Ok(()) => Ok(None),
        Err(e) if matches!(e.kind(), ErrorKind::UnknownFormat) => {
            gravar_normalizando_a_etiqueta(tag, path, caminho)
        }
        Err(e) => Err(erro_de_gravacao(caminho, frase_de_lofty(&e))),
    }
}

/// Segunda tentativa, depois de o lofty ter recusado o arquivo com
/// `UnknownFormat`: normaliza o campo de tamanho da etiqueta e grava.
///
/// A ordem das coisas aqui é a garantia, e cada passo existe por um motivo:
///
/// 1. os bytes originais vão para a MEMÓRIA. É a cópia que devolve o arquivo ao
///    que era se algo der errado — e é memória, não um arquivo temporário, porque
///    **nada é criado dentro da pasta do acervo**, que é promessa do produto.
///    Música tem alguns MB; a cópia cabe;
/// 2. o resumo do ÁUDIO é calculado ANTES de qualquer alteração. Áudio aqui é
///    "do primeiro quadro MPEG até o fim do arquivo": inclui o que vier depois
///    dele (uma ID3v1 no fim, por exemplo), e essa conferência mais larga é de
///    graça;
/// 3. se o arquivo não é a anomalia que este código sabe consertar, a recusa
///    original vale e nada é tocado;
/// 4. o campo de tamanho é corrigido — dois a quatro bytes, nas posições 6 a 9.
///    Nenhum byte é removido, nenhum byte é movido;
/// 5. a gravação que a pessoa pediu acontece. Se ela falhar, o arquivo VOLTA;
/// 6. o áudio é CONFERIDO contra o resumo do passo 2. Mudou um byte, o arquivo
///    volta e a gravação vira recusa: o desfecho nunca é um arquivo alterado.
fn gravar_normalizando_a_etiqueta(
    tag: &Id3v2Tag,
    path: &Path,
    caminho: &str,
) -> Result<Option<&'static str>> {
    let original =
        std::fs::read(path).map_err(|e| erro_de_gravacao(caminho, frase_de_io(&e)))?;

    // O arquivo é a anomalia da sobra? A recusa original é o desfecho de tudo
    // que não for exatamente ela — inclusive do `.mp3` que nunca foi MPEG, que
    // é a outra causa conhecida de `UnknownFormat` e não tem conserto nenhum.
    let Some(fim) = fim_declarado_do_id3v2(&original) else {
        return Err(erro_de_gravacao(caminho, ERRO_ESTRUTURA_DO_MP3));
    };
    let Some(primeiro_quadro) = primeiro_quadro_mpeg(&original, fim) else {
        return Err(erro_de_gravacao(caminho, ERRO_ESTRUTURA_DO_MP3));
    };
    if primeiro_quadro <= fim {
        // não há sobra: a recusa vem de outra coisa, e mexer no tamanho
        // declarado só encolheria a etiqueta por cima do áudio
        return Err(erro_de_gravacao(caminho, ERRO_ESTRUTURA_DO_MP3));
    }
    let sobra = &original[fim..primeiro_quadro];
    if MARCAS_DE_OUTRA_ETIQUETA.iter().any(|m| contem(sobra, m)) {
        // a sobra é (ou carrega) outra etiqueta: absorvê-la apagaria dado de
        // alguém na regravação. Recusar é ruim; apagar é inviolável.
        return Err(erro_de_gravacao(caminho, ERRO_ESTRUTURA_DO_MP3));
    }
    let Some(novo_tamanho) = tamanho_synchsafe(primeiro_quadro) else {
        return Err(erro_de_gravacao(caminho, ERRO_ESTRUTURA_DO_MP3));
    };

    let resumo_do_audio = resumo(&original[primeiro_quadro..]);

    let mut normalizado = original.clone();
    normalizado[6..10].copy_from_slice(&novo_tamanho);
    std::fs::write(path, &normalizado)
        .map_err(|e| erro_de_gravacao(caminho, frase_de_io(&e)))?;

    if let Err(e) = tag.save_to_path(path, WriteOptions::default()) {
        // a gravação falhou mesmo com a etiqueta normalizada: o arquivo volta a
        // ser o que era, e a pessoa recebe a frase da falha de verdade
        let frase = frase_de_lofty(&e);
        restaurar(path, &original, caminho)?;
        return Err(erro_de_gravacao(caminho, frase));
    }

    conferir_o_audio_ou_restaurar(path, &original, resumo_do_audio, caminho)?;
    Ok(Some(AVISO_ETIQUETA_NORMALIZADA))
}

/// `bytes` contém a sequência `marca`?
fn contem(bytes: &[u8], marca: &[u8]) -> bool {
    bytes.len() >= marca.len() && bytes.windows(marca.len()).any(|j| j == marca)
}

/// **O áudio é conferido, não prometido.**
///
/// Depois da gravação, relê o arquivo, acha onde o áudio começa agora (o fim do
/// bloco ID3v2 que o lofty acabou de escrever) e compara o resumo com o de
/// antes. Se não bater — ou se o arquivo não puder mais ser lido —, os bytes
/// originais voltam e a gravação vira recusa em pt-BR.
///
/// É público dentro do crate para poder ser testado com um resumo que NÃO bate:
/// a restauração é a parte que precisa de prova, e provocá-la pelo caminho de
/// fora exigiria um arquivo que faz o lofty estragar o áudio — que é justamente
/// o que ninguém sabe construir.
fn conferir_o_audio_ou_restaurar(
    path: &Path,
    original: &[u8],
    resumo_esperado: [u8; 32],
    caminho: &str,
) -> Result<()> {
    let Ok(depois) = std::fs::read(path) else {
        // não deu para reler o que acabamos de gravar: não há como afirmar que o
        // áudio está intacto, e o que não se confere não se aceita
        restaurar(path, original, caminho)?;
        return Err(erro_de_gravacao(caminho, ERRO_AUDIO_MUDARIA));
    };
    // o lofty escreveu a etiqueta inteira, então o tamanho declarado dela é
    // exato e o áudio começa logo depois. Arquivo sem etiqueta (a gravação que
    // remove tudo) tem áudio desde o byte 0.
    let inicio = fim_declarado_do_id3v2(&depois).unwrap_or(0);
    if inicio <= depois.len() && resumo(&depois[inicio..]) == resumo_esperado {
        return Ok(());
    }
    restaurar(path, original, caminho)?;
    Err(erro_de_gravacao(caminho, ERRO_AUDIO_MUDARIA))
}

/// O que uma gravação bem-sucedida devolve: a Song reindexada e, quando houve,
/// a frase que conta o que precisou ser feito no arquivo para a gravação caber.
///
/// **O `aviso` existe porque o desfecho tem de DIZER o que foi feito** (V10.8).
/// Sem pedágio antes — nenhuma pergunta técnica para quem não tem a quem
/// perguntar — e sem segredo depois: um conserto silencioso no arquivo de alguém
/// é a mesma falta de respeito que uma pergunta impossível, com sinal trocado.
///
/// `None` é a esmagadora maioria das gravações: nada fora do comum aconteceu, e
/// não há nada a contar.
#[derive(Debug, Clone)]
pub struct Gravacao {
    pub song: Song,
    pub aviso: Option<&'static str>,
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
) -> Result<Gravacao> {
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
) -> Result<Gravacao> {
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
    //
    // V10.8 — e quando ele recusa o arquivo com `UnknownFormat`, o
    // `salvar_etiqueta` tenta uma segunda vez, normalizando o campo de tamanho
    // da etiqueta. O `aviso` é o desfecho a contar quando isso aconteceu.
    let aviso = salvar_etiqueta(&tag, path, &song.file_path)?;

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

    let song = db::get_song(conn, song_id)?
        .ok_or_else(|| AppError(format!("música não encontrada: {song_id}")))?;
    Ok(Gravacao { song, aviso })
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
            // V10.8 — os dois desfechos do conserto da etiqueta e o AVISO da
            // gravação que deu certo entram na mesma régua: o que a pessoa lê é
            // a tela, e a tela não distingue mensagem de erro de mensagem de
            // desfecho.
            ERRO_AUDIO_MUDARIA,
            ERRO_ARQUIVO_NAO_VOLTOU,
            AVISO_ETIQUETA_NORMALIZADA,
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

    /// **A metade RUST do par contra a divergência mock×backend.**
    ///
    /// A frase do aviso é a única do `writer.rs` que existe também no
    /// `mockBackend.ts` — porque lá existe um PRODUTOR dela (o mock decide, por
    /// arquivo ensinado, que aquela gravação normalizou a etiqueta), e sem isso o
    /// E2E não teria como ver na tela o desfecho que esta versão promete.
    ///
    /// Não dá para chamar o TypeScript daqui, então vale a convenção da
    /// DECISIONS #88: a frase é fixada como DADO nos dois lados, letra por letra.
    /// A outra metade está no `mockBackend.contrato.test.ts`
    /// ("a frase do mock é a MESMA do writer.rs"). Mudar a frase quebra o teste
    /// de cada lado — divergir passa a exigir apagar um teste, em vez de
    /// acontecer por esquecimento.
    #[test]
    fn a_frase_do_aviso_e_a_mesma_que_o_mock_do_frontend_mostra() {
        assert_eq!(
            AVISO_ETIQUETA_NORMALIZADA,
            "para conseguir gravar, o programa corrigiu uma medida errada por dentro da \
             etiqueta deste MP3 — a música em si não foi alterada, e o programa conferiu \
             isso depois de gravar"
        );
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

    // -----------------------------------------------------------------------
    // V10.8 — o conserto da etiqueta, peça por peça.
    //
    // A parte que precisa de prova unitária é a que o caminho de fora não
    // alcança: a RESTAURAÇÃO. Provocá-la por um teste de integração exigiria um
    // arquivo que faz o lofty estragar o áudio — e ninguém sabe construir um,
    // porque a biblioteca não faz isso. A garantia, então, é testada onde ela
    // mora: dando à conferência um resumo que não bate.
    // -----------------------------------------------------------------------

    /// Um cabeçalho de quadro MPEG 1 camada III, 64 kbps, 44,1 kHz — o mesmo do
    /// `lame -b 64` que gera as fixtures.
    const QUADRO_64K_44K: [u8; 4] = [0xFF, 0xFB, 0x50, 0xC4];

    #[test]
    fn o_tamanho_do_quadro_sai_da_tabela_do_padrao() {
        // 144 * 64000 / 44100 = 208 (sem enchimento)
        assert_eq!(tamanho_do_quadro_mpeg(QUADRO_64K_44K), Some(208));
        // o mesmo quadro COM o bit de enchimento aceso tem um byte a mais
        let mut com_enchimento = QUADRO_64K_44K;
        com_enchimento[2] |= 0x02;
        assert_eq!(tamanho_do_quadro_mpeg(com_enchimento), Some(209));

        // e o que não é cabeçalho não vira quadro nenhum
        assert_eq!(tamanho_do_quadro_mpeg([0x00, 0x00, 0x00, 0x00]), None);
        assert_eq!(tamanho_do_quadro_mpeg([0xFF, 0x00, 0x50, 0xC4]), None, "sync incompleto");
        assert_eq!(tamanho_do_quadro_mpeg([0xFF, 0xEB, 0x50, 0xC4]), None, "versão reservada");
        assert_eq!(tamanho_do_quadro_mpeg([0xFF, 0xF9, 0x50, 0xC4]), None, "camada reservada");
        assert_eq!(tamanho_do_quadro_mpeg([0xFF, 0xFB, 0x00, 0xC4]), None, "bitrate livre");
        assert_eq!(tamanho_do_quadro_mpeg([0xFF, 0xFB, 0xF0, 0xC4]), None, "bitrate inválido");
        assert_eq!(tamanho_do_quadro_mpeg([0xFF, 0xFB, 0x5C, 0xC4]), None, "amostragem inválida");
    }

    /// **Um `FF Fx` solto não é um quadro, e é isso que evita mirar no lugar
    /// errado.** O par de quadros é a conferência; sem ela, qualquer byte
    /// aleatório da sobra poderia ser confundido com o começo do áudio — que é
    /// exatamente o erro que o `tools/diagnosticar_mp3.py` já cometeu.
    #[test]
    fn o_primeiro_quadro_exige_o_quadro_seguinte_batendo() {
        let tamanho = tamanho_do_quadro_mpeg(QUADRO_64K_44K).unwrap();

        // um cabeçalho sozinho, seguido de lixo: não conta
        let mut sozinho = vec![0u8; 3 * tamanho];
        sozinho[10..14].copy_from_slice(&QUADRO_64K_44K);
        sozinho[10 + tamanho] = 0x13; // onde o próximo quadro deveria estar
        assert_eq!(primeiro_quadro_mpeg(&sozinho, 0), None);

        // dois quadros encadeados: o primeiro é achado, na posição exata
        let mut encadeados = vec![0u8; 3 * tamanho];
        encadeados[10..14].copy_from_slice(&QUADRO_64K_44K);
        let seguinte = 10 + tamanho;
        encadeados[seguinte..seguinte + 4].copy_from_slice(&QUADRO_64K_44K);
        assert_eq!(primeiro_quadro_mpeg(&encadeados, 0), Some(10));
        // e a busca começa onde se manda: nada antes de `inicio` é olhado
        assert_eq!(primeiro_quadro_mpeg(&encadeados, 11), None);
    }

    #[test]
    fn o_fim_declarado_recusa_tudo_que_nao_e_o_caso_simples() {
        // o caso do relato: 10 + 4086 = 4096
        let mut bytes = vec![0u8; 6000];
        bytes[..3].copy_from_slice(b"ID3");
        bytes[3] = 4;
        bytes[6..10].copy_from_slice(&[0, 0, 31, 118]);
        assert_eq!(fim_declarado_do_id3v2(&bytes), Some(4096));

        // arquivo que não começa com etiqueta
        assert_eq!(fim_declarado_do_id3v2(b"\xff\xfbnada disso"), None);
        // bit alto aceso: o campo não é synchsafe e o número não quer dizer nada
        let mut alto = bytes.clone();
        alto[8] = 0x9F;
        assert_eq!(fim_declarado_do_id3v2(&alto), None);
        // etiqueta com RODAPÉ: o fim do bloco fica 10 bytes adiante, e errar essa
        // conta é a única forma de o conserto mirar no lugar errado
        let mut rodape = bytes.clone();
        rodape[5] = 0x10;
        assert_eq!(fim_declarado_do_id3v2(&rodape), None);
        // etiqueta que diz ser maior que o arquivo (download interrompido)
        assert_eq!(fim_declarado_do_id3v2(&bytes[..1000]), None);
    }

    /// **O conserto muda DOIS bytes, e são os que foram medidos em campo.**
    ///
    /// 4086 → 5337, nas posições 8 e 9 do arquivo. Nada é removido e nada é
    /// movido: o número que descreve a etiqueta passa a alcançar o primeiro
    /// quadro, e a região do meio vira enchimento declarado.
    #[test]
    fn o_conserto_do_tamanho_e_o_medido_em_campo() {
        let antigo = tamanho_synchsafe(4096).unwrap();
        let novo = tamanho_synchsafe(5347).unwrap();
        assert_eq!(antigo, [0, 0, 31, 118], "4086 em synchsafe");
        assert_eq!(novo, [0, 0, 41, 89], "5337 em synchsafe");
        let diferentes: Vec<usize> = (0..4).filter(|i| antigo[*i] != novo[*i]).collect();
        assert_eq!(diferentes, vec![2, 3], "só as posições 8 e 9 do arquivo mudam");

        // e o campo tem 28 bits: um valor que não cabe não é consertado às cegas
        assert_eq!(tamanho_synchsafe(9), None);
        assert_eq!(tamanho_synchsafe(10 + (1 << 28)), None);
    }

    /// **A garantia (a), provada: se o áudio mudaria, o arquivo VOLTA.**
    ///
    /// A conferência recebe os bytes originais e o resumo do áudio de antes. Aqui
    /// o arquivo em disco é outro — como se a gravação tivesse estragado o áudio
    /// —, e o desfecho tem de ser: arquivo idêntico ao original, byte a byte, e
    /// uma recusa em pt-BR. Nunca um arquivo alterado.
    #[test]
    fn a_conferencia_do_audio_restaura_o_arquivo_quando_o_audio_mudaria() {
        let dir = std::env::temp_dir().join(format!("cancioneiro-conferencia-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("musica.mp3");

        // o arquivo como ele era: uma etiqueta declarada de 20 bytes + "áudio"
        let mut original = vec![0u8; 34];
        original[..3].copy_from_slice(b"ID3");
        original[3] = 4;
        original[6..10].copy_from_slice(&tamanho_synchsafe(20).unwrap());
        original[20..].copy_from_slice(b"AUDIO ORIGINAL");
        let resumo_do_audio = resumo(&original[20..]);

        // e o arquivo como ele ficou depois de uma gravação que estragou o áudio
        let mut estragado = original.clone();
        estragado[20..].copy_from_slice(b"AUDIO ESTRAGAD");
        std::fs::write(&path, &estragado).unwrap();

        let err = conferir_o_audio_ou_restaurar(&path, &original, resumo_do_audio, "/acervo/x.mp3")
            .expect_err("áudio diferente é recusa, e não um arquivo alterado no disco");
        assert_eq!(
            err.to_string(),
            format!("não foi possível salvar em /acervo/x.mp3: {ERRO_AUDIO_MUDARIA}")
        );
        assert_eq!(
            std::fs::read(&path).unwrap(),
            original,
            "o arquivo tem de voltar a ser EXATAMENTE o que era"
        );

        // e o caminho feliz: áudio igual, nada acontece
        std::fs::write(&path, &original).unwrap();
        conferir_o_audio_ou_restaurar(&path, &original, resumo_do_audio, "/acervo/x.mp3").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), original);

        // o resumo do áudio é do ÁUDIO, e não do arquivo: mexer na ETIQUETA
        // passa na conferência, porque é isso que a gravação existe para fazer
        let mut outra_etiqueta = original.clone();
        outra_etiqueta[10..20].copy_from_slice(b"TIT2 outro");
        std::fs::write(&path, &outra_etiqueta).unwrap();
        conferir_o_audio_ou_restaurar(&path, &original, resumo_do_audio, "/acervo/x.mp3").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), outra_etiqueta, "a etiqueta nova fica");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// A marca de outra etiqueta é procurada em toda a sobra, e não só no começo
    /// dela: uma etiqueta APE grudada 400 bytes adiante é dado de alguém do mesmo
    /// jeito.
    #[test]
    fn as_marcas_de_outra_etiqueta_sao_achadas_em_qualquer_posicao() {
        let mut sobra = vec![0u8; 500];
        assert!(!MARCAS_DE_OUTRA_ETIQUETA.iter().any(|m| contem(&sobra, m)));
        sobra[400..408].copy_from_slice(b"APETAGEX");
        assert!(MARCAS_DE_OUTRA_ETIQUETA.iter().any(|m| contem(&sobra, m)));
        // e a busca não estoura em sobra menor que a marca
        assert!(!contem(b"AP", b"APETAGEX"));
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
