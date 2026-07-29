//! V10 — etapa 5 do funil: escrever a letra OUVINDO O ÁUDIO.
//!
//! Porte do subcomando `transcrever` do `tools/curadoria.py` (`_MIN_LACO`,
//! `limpar_transcricao`, `eh_alucinacao`, `extrair_candidatos`,
//! `sem_conteudo`, e o laço de decisão do `cmd_transcrever`), trocando o
//! motor: lá é o `faster-whisper` (CTranslate2, Python), aqui é o
//! `whisper-cli` do whisper.cpp com o modelo `small` quantizado, baixado como
//! acessório.
//!
//! # A prova NÃO viaja junto com o código (DECISIONS #72)
//!
//! Os **78%** (trechos lembrados que viraram encontráveis) foram medidos com
//! o `faster-whisper`. Este é **outro motor**, com **outro modelo**. Nada
//! neste arquivo autoriza repetir aquele número: a remedição é condição de
//! entrega, e o arnês está em `tests/remedicao.rs` (ignorado por padrão,
//! porque exige o binário, o modelo e um acervo que a suíte não tem).
//!
//! # O que este módulo faz, e o que ele NÃO faz
//!
//! Ele produz **letra**, e só letra. Não propõe título nem artista.
//!
//! A identificação pelo REFRÃO (F14.1 do Python) fica de fora do aplicativo,
//! pelo mesmo motivo que já a manteve fora do `fingerprint.rs`: medida em duas
//! passadas completas do acervo real (94 arquivos) ela rendeu 0 e 1
//! identificação, e a única foi **errada e aplicada** (DECISIONS #74). Um
//! recurso que erra metade do que produz não entra num produto sem suporte.
//!
//! A consequência é que "transcrição nunca sobrescreve etiqueta real" vale
//! **por construção**, e não por uma regra que alguém precisa lembrar de
//! aplicar: não há nome vindo daqui, logo não há o que sobrescrever e não há
//! CONFLITO possível. Há teste fixando isso.
//!
//! O que o refrão continua fazendo é INFORMAR: `Desfecho::Transcrita` carrega
//! o trecho mais repetido para a revisão mostrar em uma linha. Quem vai
//! conferir 47 letras escritas por máquina precisa reconhecer a música de
//! relance, e é para isso que as travas do candidato existem (2 palavras, 8
//! caracteres, repetição real, sem alucinação, sem placeholder) — elas
//! separam refrão de fragmento.
//!
//! # As três coisas que o acervo real ensinou, e que o porte precisa carregar
//!
//! 1. **`_MIN_LACO = 200`.** O limpador de repetição com piso baixo mutilava
//!    letra legítima dentro do MP3 de alguém, para sempre. Repetição é a
//!    matéria-prima deste repertório; o laço do Whisper mede 200 a 600
//!    caracteres, a maior repetição legítima medida mede 32 (DECISIONS #66).
//! 2. **A lista negra de alucinação.** Em trecho instrumental o modelo "ouve"
//!    legenda de vídeo e agradecimento. Gravar isso como letra faz o arquivo
//!    "ter letra": toda etapa seguinte passa a pulá-lo, para sempre, e a marca
//!    de instrumental nunca mais tem chance (DECISIONS #70).
//! 3. **`vad_filter` DESLIGADO.** O VAD é detector de FALA; sobre canto com
//!    instrumentação ele descarta quase tudo antes de o modelo ouvir — 35% do
//!    acervo real voltou vazio (DECISIONS #62). No whisper.cpp o equivalente é
//!    **não passar `--vad`**, e há teste varrendo a linha de comando inteira
//!    atrás de qualquer coisa que o ligue.

use crate::error::{AppError, Result};
use crate::lyrics_fetch::norm;
use std::io::{BufRead, Read};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

// ---------------------------------------------------------------------------
// As constantes calibradas (porte literal do tools/curadoria.py)
// ---------------------------------------------------------------------------

/// Só é laço quando a repetição é LONGA — da ordem do defeito de verdade
/// (200+ caracteres), não uma ordem de grandeza abaixo dele.
///
/// **Achado MÉDIO do QA no lado Python**: com o piso em 20, o limpador causava
/// dano permanente dentro dos MP3s do acervo. Sequências de 20 a 40 caracteres
/// — dez sílabas percussivas antes da palavra, uma interjeição repetida, uma
/// despedida em série — são letra legítima em ponto, coco e ciranda. A maior
/// repetição legítima medida no repertório tem 32 caracteres ("Adeus adeus
/// adeus adeus adeus Bahia"); os laços do Whisper têm 402 a 600.
pub const MIN_LACO: usize = 200;

/// Linha inteira repetida em série; duas bastam para o leitor entender.
const MAX_LINHAS_IGUAIS: usize = 2;

/// Tamanho máximo da unidade que se considera "sílaba emendada" — o `{1,10}`
/// do `(.{1,10}?)\1{2,}` do Python.
const MAX_UNIDADE_LACO: usize = 10;

/// Piso de caracteres por segundo de ÁUDIO abaixo do qual a transcrição não
/// carrega conteúdo nenhum.
///
/// Medido no acervo real de 94 arquivos com o modelo `small`: instrumentais
/// voltaram com 0,074 e 0,076 c/s; as letras legítimas mais ralas, com 1,22
/// c/s. Entre as duas bordas há um fator de 16 sem nada no meio, e o piso fica
/// praticamente na média geométrica — 3,9x acima do pior instrumental e 4,1x
/// abaixo da letra mais rala já vista.
///
/// Os dois erros NÃO são simétricos: deixar ruído passar custa uma linha feia
/// no índice; marcar uma música de verdade como instrumental a tira da fila de
/// letra **para sempre** (a marca vence até o `--forcar-tudo`). Por isso o
/// piso não sobe.
pub const DENSIDADE_MINIMA_LETRA: f64 = 0.30;

/// Um candidato a refrão vem do ÁUDIO, não da etiqueta: palavra solta e
/// genérica ("amor", "aleluia") não distingue música nenhuma.
pub const MIN_PALAVRAS_CANDIDATO: usize = 2;
pub const MIN_CARACTERES_CANDIDATO: usize = 8;
/// Refrão é frase que VOLTA: aparecer uma vez não faz de um verso o refrão.
pub const MIN_REPETICOES_REFRAO: usize = 2;
/// Título de canção é frase curta.
const MAX_PALAVRAS_REFRAO: usize = 6;
const MAX_PALAVRAS_PRIMEIRA: usize = 8;
const MAX_CANDIDATOS: usize = 5;

/// Alucinações conhecidas do Whisper em pt-BR, comparadas por IGUALDADE sobre
/// a chave normalizada.
///
/// Estas frases NÃO derrubam a linha: várias são verso legítimo neste
/// repertório ("Obrigado" sozinho é agradecimento devocional). Elas contam
/// como "não é conteúdo" — se a transcrição inteira for só isto, ela vale
/// vazia, e a música é marcada instrumental em vez de receber o lixo como
/// letra.
const ALUCINACOES_EXATAS: &[&str] = &[
    "musica",
    "musicas",
    "a musica",
    "obrigado",
    "obrigada",
    "muito obrigado",
    "muito obrigada",
    "tchau",
    "tchau tchau",
    "ate a proxima",
    "ate mais",
    "fim",
    "the end",
];

/// Trechos que denunciam a alucinação em QUALQUER posição da frase, e que por
/// isso derrubam a linha inteira.
///
/// Só entram aqui frases inconfundíveis — nenhuma canção contém "legendas pela
/// comunidade" ou "inscreva-se no canal". A distinção entre esta lista e a de
/// cima é o que impede a regra de mutilar letra de verdade, que é a lição do
/// `_MIN_LACO` aplicada a outro lugar.
const ALUCINACOES_TRECHOS: &[&str] = &[
    "legendas pela comunidade",
    "legendado pela comunidade",
    "amara org",
    "obrigado por assistir",
    "obrigada por assistir",
    "obrigado por assistirem",
    "inscreva se no canal",
    "se inscreva no canal",
    "deixe seu like",
];

/// Idioma pedido ao motor. Fixo: o acervo é em português, e `auto` faz o
/// Whisper decidir errado em faixa instrumental e transcrever para outro
/// idioma.
pub const IDIOMA: &str = "pt";

// ---------------------------------------------------------------------------
// Quanto tempo isto leva — e por que o número começa DECLARADO
// ---------------------------------------------------------------------------

/// Segundos de CPU por segundo de ÁUDIO. **Número de referência, não medido.**
///
/// O `tools/curadoria.py` usa 0,25 para o `small` do faster-whisper, e esse
/// número é a proporção PUBLICADA daquele motor. Este é outro motor
/// (whisper.cpp) com outro modelo (quantizado q5_1) e em máquinas que ninguém
/// pode olhar: reusar 0,25 seria a DECISIONS #72 outra vez — a prova não viaja
/// junto quando o código é reusado.
///
/// 1,0 ("um minuto de máquina por minuto de música") é deliberadamente
/// conservador. Estimativa que promete MENOS do que leva é o defeito da
/// DECISIONS #85; folga não é. E a copy tem de dizer "cerca de".
///
/// **Este número existe para ser substituído por medição.** A primeira
/// transcrição desta máquina já devolve o valor real
/// (`TranscricaoResultado::razao_medida`), e a remedição do arnês
/// `tests/remedicao.rs` devolve o valor de referência novo.
pub const RAZAO_DE_REFERENCIA: f64 = 1.0;

/// Duração mínima e máxima consideradas ao ESTIMAR, em segundos.
///
/// A duração que a estimativa tem à mão é a do cabeçalho do MP3, e o cabeçalho
/// já mentiu por uma ordem de grandeza — 300 s lidos como 2365 s
/// (DECISIONS #72). Numa DECISÃO isso é proibido; numa estimativa agregada, um
/// cabeçalho mentiroso acrescentaria meia hora ao total e faria a pessoa
/// desistir de um trabalho de vinte minutos. Aparar nos dois extremos limita o
/// estrago sem inventar nada.
const DURACAO_MINIMA_ESTIMADA: f64 = 30.0;
const DURACAO_MAXIMA_ESTIMADA: f64 = 900.0;

/// Duração típica quando o cabeçalho não diz nada — quatro minutos, que é a
/// ordem de grandeza de uma canção deste repertório.
const DURACAO_TIPICA: f64 = 240.0;

/// Quanto tempo leva transcrever estas músicas, em segundos.
///
/// `razao` é `RAZAO_DE_REFERENCIA` enquanto esta máquina não transcreveu nada,
/// e a razão MEDIDA depois disso.
pub fn segundos_para_transcrever(duracoes: impl Iterator<Item = f64>, razao: f64) -> u64 {
    let audio: f64 = duracoes
        .map(|d| {
            if d <= 0.0 {
                DURACAO_TIPICA
            } else {
                d.clamp(DURACAO_MINIMA_ESTIMADA, DURACAO_MAXIMA_ESTIMADA)
            }
        })
        .sum();
    (audio * razao.max(0.0)).ceil() as u64
}

// ---------------------------------------------------------------------------
// Mensagens (pt-BR, curtas) — TEXTO FIXO, como no resto do produto
// ---------------------------------------------------------------------------

/// O acessório não conseguiu nem ser EXECUTADO nesta máquina: ausente, sem bit
/// de execução, de outra arquitetura, bloqueado pelo antivírus. Não é defeito
/// de um arquivo de música — vai acontecer em todos —, e é o único veredito da
/// etapa 5 que a desliga pelo resto do trabalho, como o
/// `fingerprint::ERRO_FPCALC_NAO_EXECUTA` faz com a etapa 2.
pub const ERRO_NAO_EXECUTA: &str =
    "o programa que escreve a letra não conseguiu ser executado neste computador";

/// O modelo não está no cache (ou não confere). Sem ele o transcritor não faz
/// nada, e a frase precisa ser distinta: é o outro download.
pub const ERRO_SEM_MODELO: &str =
    "o modelo que escreve a letra ainda não está neste computador";

/// O transcritor rodou e não deu conta DESTE arquivo. Erro de uma música só: a
/// fila segue para a seguinte (a mesma regra do QA A2 na etapa 2).
pub const ERRO_AUDIO: &str = "não foi possível ouvir o áudio deste arquivo";

/// O transcritor ficou sem dar sinal de vida por muito tempo. Distinto do
/// anterior de propósito: aqui o processo foi encerrado por nós.
pub const ERRO_TRAVOU: &str = "o programa que escreve a letra parou de responder e foi encerrado";

/// Teto de SILÊNCIO do motor, não de duração total.
///
/// Transcrever é a única etapa que leva minutos por música, e um teto absoluto
/// erraria nos dois sentidos: curto demais mataria o set de duas horas que
/// alguém gravou, longo demais deixaria um processo travado consumindo a
/// máquina a noite inteira. O `whisper-cli` com `--print-progress` fala a cada
/// 5% do áudio, então meia hora calado só acontece quando ele não está mais
/// trabalhando.
const TETO_DE_SILENCIO: Duration = Duration::from_secs(30 * 60);

/// De quanto em quanto tempo o cancelamento é consultado enquanto o motor
/// roda. É o mesmo intervalo do `fingerprint::impressao_digital` (QA A4), e
/// aqui ele importa mais: lá a espera era de segundos, aqui é de minutos.
const PASSO_DA_ESPERA: Duration = Duration::from_millis(20);

// ---------------------------------------------------------------------------
// O limpador de repetição
// ---------------------------------------------------------------------------

/// Colapsa os laços de sílaba de UMA linha — o
/// `re.sub(r"(.{1,10}?)\1{2,}", _colapsar, linha)` do Python, à mão porque a
/// árvore não tem crate de regex (e porque referência de grupo, que é o que
/// esta expressão usa, nenhuma delas suporta).
///
/// A varredura é da esquerda para a direita; em cada posição procura-se a
/// MENOR unidade (1 a 10 caracteres) que apareça três vezes ou mais em
/// sequência — "menor primeiro" é o `{1,10}?` preguiçoso —, e a repetição é
/// consumida por inteiro (o `{2,}` é guloso). Só então o piso decide: abaixo
/// de `MIN_LACO` o trecho volta INTACTO.
fn colapsar_lacos(linha: &str) -> String {
    let cs: Vec<char> = linha.chars().collect();
    let mut saida = String::with_capacity(linha.len());
    let mut i = 0;
    while i < cs.len() {
        let mut achado = None;
        for n in 1..=MAX_UNIDADE_LACO {
            // sem espaço para três cópias, unidade maior também não cabe
            if i + n * 3 > cs.len() {
                break;
            }
            let mut copias = 1;
            while i + (copias + 1) * n <= cs.len()
                && cs[i + copias * n..i + (copias + 1) * n] == cs[i..i + n]
            {
                copias += 1;
            }
            if copias >= 3 {
                achado = Some((n, copias));
                break;
            }
        }
        match achado {
            Some((n, copias)) => {
                let fim = i + n * copias;
                if fim - i < MIN_LACO {
                    saida.extend(&cs[i..fim]); // repetição legítima: intacta
                } else {
                    let unidade: String = cs[i..i + n].iter().collect();
                    saida.push_str(&unidade);
                    saida.push_str(&unidade); // duas ocorrências bastam
                }
                i = fim;
            }
            None => {
                saida.push(cs[i]);
                i += 1;
            }
        }
    }
    saida
}

/// Tira os laços de repetição do Whisper sem tocar no texto legítimo — porte
/// do `limpar_transcricao` do `tools/curadoria.py`.
///
/// Ele vive AQUI, e não no motor: assim a letra gravada sai sem laço seja qual
/// for o programa por trás, e o teste consegue provar isso.
pub fn limpar_transcricao(texto: &str) -> String {
    if texto.is_empty() {
        return String::new();
    }
    let mut linhas: Vec<String> = Vec::new();
    let mut repetidas = 0usize;
    let mut anterior: Option<String> = None;
    for linha in texto.split('\n') {
        let limpa = colapsar_lacos(linha);
        let chave = norm(&limpa);
        if !chave.is_empty() && anterior.as_deref() == Some(chave.as_str()) {
            repetidas += 1;
            if repetidas >= MAX_LINHAS_IGUAIS {
                continue;
            }
        } else {
            repetidas = 0;
            anterior = Some(chave);
        }
        linhas.push(limpa);
    }
    linhas.join("\n")
}

// ---------------------------------------------------------------------------
// A lista negra de alucinação
// ---------------------------------------------------------------------------

/// True quando a frase é uma alucinação típica do Whisper sobre áudio
/// instrumental ou de voz baixa. Porte literal do `eh_alucinacao`.
pub fn eh_alucinacao(texto: &str) -> bool {
    let chave = norm(texto);
    ALUCINACOES_EXATAS.contains(&chave.as_str())
        || ALUCINACOES_TRECHOS.iter().any(|t| chave.contains(t))
}

/// True só para as alucinações INCONFUNDÍVEIS (a lista de trechos): as que
/// nenhuma canção contém, e que por isso podem ser removidas do texto.
fn e_alucinacao_inconfundivel(texto: &str) -> bool {
    let chave = norm(texto);
    ALUCINACOES_TRECHOS.iter().any(|t| chave.contains(t))
}

/// O texto sem as linhas que são, inconfundivelmente, alucinação do motor.
///
/// Esta é a única parte da lista negra que APAGA texto, e é por isso que ela
/// usa só a lista de trechos. Deixar "Legendas pela comunidade Amara.org"
/// dentro da letra é pior que perdê-la: o arquivo passa a "ter letra" e some
/// da fila para sempre (DECISIONS #70). Já derrubar uma linha "Obrigado" de um
/// canto devocional seria mutilar letra de verdade — é a lição do `MIN_LACO`,
/// e por isso a lista exata não entra aqui.
pub fn sem_alucinacao(texto: &str) -> String {
    texto
        .split('\n')
        .filter(|l| !e_alucinacao_inconfundivel(l))
        .collect::<Vec<_>>()
        .join("\n")
}

/// True quando NADA no texto é conteúdo: vazio, ou só frases da lista negra.
///
/// É aqui que a lista EXATA trabalha. Uma faixa instrumental que volta como
/// "Música\nObrigado\nTchau" tem 26 caracteres de nada — gravá-los como letra
/// mentiria, e ainda tiraria o arquivo da fila.
fn so_alucinacao(texto: &str) -> bool {
    let mut viu_conteudo = false;
    for linha in texto.split('\n') {
        if linha.trim().is_empty() {
            continue;
        }
        if !eh_alucinacao(linha) {
            viu_conteudo = true;
        }
    }
    !viu_conteudo
}

// ---------------------------------------------------------------------------
// O refrão — INFORMAÇÃO para quem revisa, nunca dado a gravar
// ---------------------------------------------------------------------------

/// Limpeza de uma frase para virar candidato: pontuação vira espaço, marca
/// combinante some, espaços colapsam — o `limpar_consulta` do Python, sem a
/// recomposição NFC (a árvore não tem normalizador Unicode). A diferença
/// aparece só na FORMA de exibição de um texto que já chega NFD, e é a mesma
/// concessão que o `fingerprint` documenta.
fn limpar_frase(texto: &str) -> String {
    texto
        .chars()
        .filter(|c| !matches!(c, '\u{0300}'..='\u{036F}'))
        .map(|c| {
            if c.is_alphanumeric() || c.is_whitespace() {
                c
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// As frases do texto transcrito: linhas e pontuação forte separam; hífen NÃO
/// divide (partiria palavra composta).
fn frases_do_texto(texto: &str) -> Vec<String> {
    texto
        .split(|c| matches!(c, '\n' | '\r' | '.' | ',' | ';' | ':' | '!' | '?' | '…'))
        .filter_map(|bruto| {
            let frase = limpar_frase(bruto).to_lowercase();
            (!frase.is_empty()).then_some(frase)
        })
        .collect()
}

/// True se a frase é curta/genérica demais para ser refrão: menos de 2
/// palavras ou menos de 8 caracteres.
fn candidato_fraco(frase: &str) -> bool {
    let chave = norm(frase);
    chave.chars().count() < MIN_CARACTERES_CANDIDATO
        || chave.split_whitespace().count() < MIN_PALAVRAS_CANDIDATO
}

/// Candidatos a refrão, do mais repetido para o menos — porte do
/// `extrair_candidatos`.
///
/// Placeholders, alucinações e frases fracas nunca entram. No aplicativo o
/// resultado é INFORMATIVO (ver `refrao`): nada aqui vira consulta, nome
/// proposto ou etiqueta gravada.
pub fn extrair_candidatos(texto: &str) -> Vec<String> {
    let frases = frases_do_texto(texto);
    if frases.is_empty() {
        return Vec::new();
    }
    // chave normalizada -> (ocorrências, ordem de aparição, frase)
    let mut contagem: Vec<(String, usize, usize, String)> = Vec::new();
    for (ordem, frase) in frases.iter().enumerate() {
        if candidato_fraco(frase) || crate::enrich::is_placeholder(frase) || eh_alucinacao(frase) {
            continue;
        }
        let chave = norm(frase);
        match contagem.iter_mut().find(|c| c.0 == chave) {
            Some(c) => c.1 += 1,
            None => contagem.push((chave, 1, ordem, frase.clone())),
        }
    }
    let mut repetidas: Vec<&(String, usize, usize, String)> = contagem
        .iter()
        .filter(|c| c.1 >= MIN_REPETICOES_REFRAO && c.3.split_whitespace().count() <= MAX_PALAVRAS_REFRAO)
        .collect();
    // mais repetida primeiro; empate decide por quem apareceu antes
    repetidas.sort_by(|a, b| b.1.cmp(&a.1).then(a.2.cmp(&b.2)));
    let mut candidatos: Vec<String> = repetidas.iter().map(|c| c.3.clone()).collect();
    let primeira = &frases[0];
    if primeira.split_whitespace().count() <= MAX_PALAVRAS_PRIMEIRA
        && !crate::enrich::is_placeholder(primeira)
        && !eh_alucinacao(primeira)
        && !candidato_fraco(primeira)
    {
        candidatos.push(primeira.clone());
    }
    let mut vistos: Vec<String> = Vec::new();
    let mut unicos = Vec::new();
    for frase in candidatos {
        let chave = norm(&frase);
        if !vistos.contains(&chave) {
            vistos.push(chave);
            unicos.push(frase);
        }
        if unicos.len() == MAX_CANDIDATOS {
            break;
        }
    }
    unicos
}

/// O trecho mais repetido da transcrição, para a revisão mostrar em UMA linha.
///
/// É a única coisa que o refrão faz dentro do aplicativo, e é de propósito:
/// quem vai conferir 47 letras escritas por máquina precisa reconhecer a
/// música de relance. Nada aqui é gravado nem consultado — a identificação
/// pelo refrão (F14.1) fica de fora, por medição (DECISIONS #74).
pub fn refrao(texto: &str) -> Option<String> {
    extrair_candidatos(texto).into_iter().next()
}

// ---------------------------------------------------------------------------
// A densidade — porte do sem_conteudo
// ---------------------------------------------------------------------------

/// True quando a transcrição não carrega conteúdo nenhum: vazia, ou tão rala
/// para o tamanho do áudio que é o motor ouvindo quase nada.
///
/// Sem duração conhecida não há densidade a medir — e chutar aqui seria marcar
/// instrumental por engano —, então só o texto vazio conta.
pub fn sem_conteudo(texto: &str, duracao: f64, densidade_minima: f64) -> bool {
    let limpo = texto.trim();
    if limpo.is_empty() {
        return true;
    }
    if densidade_minima <= 0.0 || duracao <= 0.0 {
        return false;
    }
    (limpo.chars().count() as f64) / duracao < densidade_minima
}

// ---------------------------------------------------------------------------
// O desfecho de UMA música
// ---------------------------------------------------------------------------

/// O que a etapa 5 concluiu sobre uma música. Nenhuma variante carrega título
/// ou artista: a transcrição não identifica nada.
#[derive(Debug, Clone, PartialEq)]
pub enum Desfecho {
    /// Letra escrita ouvindo o áudio, já sem laço de repetição.
    Transcrita {
        letra: String,
        /// Trecho mais repetido, para a revisão mostrar. Só informação.
        refrao: Option<String>,
        /// Segundos de áudio que o MOTOR decodificou; 0,0 = não informou.
        duracao: f64,
    },
    /// Áudio LEGÍVEL e transcrição sem conteúdo: música sem voz (V7/F16).
    /// Áudio ilegível é `Erro`, e são coisas diferentes.
    Instrumental { motivo: String },
    /// Transcrição rala e duração NÃO provada: nada é decidido e nada é
    /// gravado (DECISIONS #72).
    Adiada { motivo: String },
    /// Falha desta música. A fila segue.
    Erro { mensagem: String },
}

/// Decide o desfecho a partir do que o motor devolveu — porte do laço de
/// decisão do `cmd_transcrever`.
///
/// `duracao_do_motor` é o número que o próprio transcritor informou (0,0 =
/// não informou) e é a ÚNICA prova de duração que esta etapa aceita: quem
/// decodificou o áudio sabe quanto áudio existe, e é o topo da ordem de
/// autoridade da DECISIONS #72. `duracao_do_cabecalho` entra em um lugar só —
/// decidir se a transcrição rala vira `Adiada` —, e nunca decide sozinha:
/// margem de segurança não protege contra erro de ordem de grandeza.
pub fn decidir(bruto: &str, duracao_do_motor: f64, duracao_do_cabecalho: f64) -> Desfecho {
    decidir_com_densidade(
        bruto,
        duracao_do_motor,
        duracao_do_cabecalho,
        DENSIDADE_MINIMA_LETRA,
    )
}

/// O `decidir` com o piso de densidade explícito — a porta que os testes usam.
pub fn decidir_com_densidade(
    bruto: &str,
    duracao_do_motor: f64,
    duracao_do_cabecalho: f64,
    densidade_minima: f64,
) -> Desfecho {
    // A lista negra vem ANTES da conta: alucinação não é conteúdo, e contá-la
    // como conteúdo é justamente o que faz um instrumental "ter letra".
    let util = sem_alucinacao(bruto);
    let conteudo = if so_alucinacao(&util) { "" } else { util.as_str() };
    // A densidade é medida no texto CRU (só sem alucinação), ANTES do
    // limpador: ele colapsa linha repetida em série, e neste repertório uma
    // faixa de 15 minutos pode ser um refrão repetido cinquenta vezes. O que
    // se quer medir é quanto o MOTOR ouviu.
    let caracteres = conteudo.trim().chars().count();
    let prova = duracao_do_motor > 0.0;
    let rala_com_prova = prova && sem_conteudo(conteudo, duracao_do_motor, densidade_minima);

    if caracteres > 0
        && !prova
        && sem_conteudo(conteudo, duracao_do_cabecalho, densidade_minima)
    {
        // A ÚNICA coisa que acusa "instrumental" aqui é a duração do
        // cabeçalho — e ela não é medição. Marcar tira o arquivo da fila para
        // sempre, e desfazer é trabalho de gente: errar para este lado é
        // destruir dado de quem não tem a quem recorrer.
        return Desfecho::Adiada {
            motivo: format!(
                "a transcrição saiu curta ({caracteres} caracteres), mas não foi possível \
                 confirmar a duração deste áudio. Nada foi gravado. Se a música não tem voz, \
                 marque como instrumental no editor"
            ),
        };
    }
    if caracteres == 0 || rala_com_prova {
        // O áudio foi LIDO até o fim (ilegível teria virado erro antes):
        // voltar vazio — ou quase — daqui é música SEM VOZ, não defeito.
        let motivo = if caracteres == 0 {
            "a transcrição voltou vazia e o áudio foi lido até o fim".to_string()
        } else {
            let densidade = caracteres as f64 / duracao_do_motor;
            format!(
                "{caracteres} caracteres em {} de áudio dão {}, abaixo do mínimo de {}",
                duracao_em_pt_br(duracao_do_motor),
                decimal_pt_br(densidade),
                decimal_pt_br(densidade_minima)
            )
        };
        return Desfecho::Instrumental { motivo };
    }
    let letra = limpar_transcricao(conteudo);
    Desfecho::Transcrita {
        refrao: refrao(&letra),
        letra,
        duracao: duracao_do_motor,
    }
}

/// "252,4 s" -> "4m12s"; "38,2 s" -> "38s".
fn duracao_em_pt_br(segundos: f64) -> String {
    let total = segundos.round().max(0.0) as u64;
    if total >= 60 {
        format!("{}m{:02}s", total / 60, total % 60)
    } else {
        format!("{total}s")
    }
}

/// "0,07" — vírgula decimal, sem depender de locale.
fn decimal_pt_br(valor: f64) -> String {
    format!("{valor:.2}").replace('.', ",")
}

// ---------------------------------------------------------------------------
// O motor: rodar o whisper-cli sem travar e sem escrever nada
// ---------------------------------------------------------------------------

/// O que o `whisper-cli` devolveu.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SaidaDoMotor {
    /// A transcrição crua, uma linha por segmento.
    pub texto: String,
    /// Segundos de ÁUDIO que o motor decodificou, do próprio motor. 0,0
    /// significa "não informou" — e aí não há prova de duração nenhuma.
    pub duracao: f64,
}

/// Uma notícia vinda do stderr do motor.
#[derive(Debug, Clone, Copy, PartialEq)]
enum DoMotor {
    /// Porcentagem concluída desta música (0 a 100).
    Progresso(u8),
    /// Segundos de áudio que o motor abriu.
    Duracao(f64),
}

/// Lê UMA linha do stderr do `whisper-cli`. Função pura, e é ela que os testes
/// exercitam — o formato do motor é a única parte deste módulo que não
/// depende de nós.
///
/// Duas linhas interessam, e as duas o `whisper-cli` imprime em stderr:
///
/// - `main: processing 'x.mp3' (4800000 samples, 300.0 sec), 4 threads, ...`
///   — é o `info.duration` do faster-whisper: a duração que o DECODIFICADOR
///   mediu, e o topo da ordem de autoridade da DECISIONS #72;
/// - `whisper_print_progress_callback: progress =  35%` — o progresso, que
///   com `--print-progress` sai a cada 5%.
fn ler_linha_do_motor(linha: &str) -> Option<DoMotor> {
    if let Some(resto) = linha.split_once("progress =").map(|(_, r)| r) {
        let numero: String = resto
            .trim_start()
            .chars()
            .take_while(char::is_ascii_digit)
            .collect();
        return numero
            .parse::<u16>()
            .ok()
            .map(|p| DoMotor::Progresso(p.min(100) as u8));
    }
    // "(4800000 samples, 300.00 sec)" — a duração vem depois de "samples,"
    let resto = linha.split_once("samples,")?.1;
    let segundos = resto.split_once("sec")?.0.trim();
    segundos
        .parse::<f64>()
        .ok()
        .filter(|s| *s > 0.0)
        .map(DoMotor::Duracao)
}

/// Os argumentos do `whisper-cli`, num lugar só, para o teste poder varrê-los.
///
/// **Nada de `--vad`, e nada de `-o*`.** O VAD é detector de FALA e destruiu
/// 35% das transcrições do acervo real (DECISIONS #62); os `-o*` fazem o
/// `whisper-cli` GRAVAR arquivos ao lado do MP3, e este produto não escreve
/// nada na pasta de música de ninguém.
///
/// `--max-context 0` é o `condition_on_previous_text=False` do faster-whisper:
/// nenhum texto anterior entra como prompt da janela seguinte, que é a outra
/// trava contra os laços de repetição.
pub fn argumentos(modelo: &Path, mp3: &Path, idioma: &str) -> Vec<String> {
    vec![
        "--model".into(),
        modelo.display().to_string(),
        "--file".into(),
        mp3.display().to_string(),
        "--language".into(),
        idioma.into(),
        // sem carimbo de tempo: o que vai para o MP3 é a letra, não a legenda
        "--no-timestamps".into(),
        // o progresso é o que a tela mostra durante os minutos desta música
        "--print-progress".into(),
        "--max-context".into(),
        "0".into(),
    ]
}

/// Roda o `whisper-cli` sobre o MP3 e devolve a transcrição.
///
/// - `Ok(Some(saida))` — o motor rodou e terminou;
/// - `Ok(None)` — a pessoa cancelou. Cancelar não é falha;
/// - `Err` — o binário não sobe (`ERRO_NAO_EXECUTA`, veredito sobre a
///   máquina), o motor falhou neste arquivo (`ERRO_AUDIO`) ou travou
///   (`ERRO_TRAVOU`).
///
/// **Os canos precisam ser DRENADOS enquanto o filho roda** (QA A4 da
/// v0.9.0). O cano tem 64 KiB; o `whisper-cli` despeja em stderr muito mais
/// que isso numa faixa longa, e um filho que escreve sem ser lido bloqueia na
/// própria escrita, para sempre. Duas threads, uma por cano — a mesma solução
/// do `fingerprint::impressao_digital`, e aqui o defeito dispararia de
/// verdade, não em teoria.
///
/// A diferença para lá é que o stderr **não é descartado**: ele é lido linha a
/// linha e vira progresso e duração, que atravessam por um canal. Assim o
/// callback fica na thread de quem chamou, sem exigir `Sync`, e um
/// cancelamento não precisa esperar thread nenhuma.
pub fn transcrever(
    whisper: &Path,
    modelo: &Path,
    mp3: &Path,
    idioma: &str,
    cancelado: &dyn Fn() -> bool,
    progresso: &dyn Fn(u8),
) -> Result<Option<SaidaDoMotor>> {
    if !modelo.is_file() {
        return Err(AppError(ERRO_SEM_MODELO.into()));
    }
    let mut filho = std::process::Command::new(whisper)
        .args(argumentos(modelo, mp3, idioma))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|_| AppError(ERRO_NAO_EXECUTA.into()))?;

    let lendo_saida = filho.stdout.take().map(|mut c| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = c.read_to_end(&mut buf);
            buf
        })
    });
    let (envia, recebe) = std::sync::mpsc::channel::<DoMotor>();
    let lendo_erro = filho.stderr.take().map(|c| {
        std::thread::spawn(move || {
            let mut leitor = std::io::BufReader::new(c);
            let mut linha = Vec::new();
            // `read_until` em vez de `lines()`: o motor pode emitir '\r' sem
            // '\n', e uma leitura que espera a quebra certa é uma leitura que
            // não drena — que é o defeito que esta thread existe para evitar.
            while leitor.read_until(b'\n', &mut linha).unwrap_or(0) > 0 {
                let texto = String::from_utf8_lossy(&linha);
                for pedaco in texto.split(['\r', '\n']) {
                    if let Some(noticia) = ler_linha_do_motor(pedaco) {
                        if envia.send(noticia).is_err() {
                            return; // ninguém mais escuta: o trabalho acabou
                        }
                    }
                }
                linha.clear();
            }
        })
    });

    let mut duracao = 0.0f64;
    let mut ultimo_sinal = Instant::now();
    let status = loop {
        // O cancelamento é consultado a cada 20 ms, e não entre músicas: esta
        // etapa leva MINUTOS por arquivo, e um "Cancelar" que só responde na
        // música seguinte não responde.
        if cancelado() {
            break None;
        }
        let mut houve_noticia = false;
        while let Ok(noticia) = recebe.try_recv() {
            houve_noticia = true;
            match noticia {
                DoMotor::Progresso(p) => progresso(p),
                DoMotor::Duracao(s) => duracao = s,
            }
        }
        if houve_noticia {
            ultimo_sinal = Instant::now();
        }
        match filho.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if ultimo_sinal.elapsed() > TETO_DE_SILENCIO => break None,
            Ok(None) => std::thread::sleep(PASSO_DA_ESPERA),
            Err(_) => break None,
        }
    };

    let Some(status) = status else {
        let travou = !cancelado();
        let _ = filho.kill();
        let _ = filho.wait(); // colhe o zumbi
        // As threads de dreno NÃO são esperadas, e isto é deliberado (QA A4):
        // matar o filho nem sempre fecha os canos, e esperar traria de volta
        // exatamente a demora que o "Cancelar" veio tirar. Elas terminam
        // sozinhas quando o cano fechar; até lá estão paradas numa leitura.
        drop(lendo_saida);
        drop(lendo_erro);
        return if travou {
            Err(AppError(ERRO_TRAVOU.into()))
        } else {
            Ok(None)
        };
    };

    // No caminho normal a espera é obrigatória: é dela que sai a transcrição.
    let saida = lendo_saida
        .map(std::thread::JoinHandle::join)
        .transpose()
        .map_err(|_| AppError(ERRO_AUDIO.into()))?
        .unwrap_or_default();
    if let Some(t) = lendo_erro {
        let _ = t.join();
    }
    // o que ficou no canal depois do fim (a duração costuma sair no começo,
    // mas o progresso final pode chegar junto com o encerramento)
    while let Ok(noticia) = recebe.try_recv() {
        match noticia {
            DoMotor::Progresso(p) => progresso(p),
            DoMotor::Duracao(s) => duracao = s,
        }
    }
    if !status.success() {
        return Err(AppError(ERRO_AUDIO.into()));
    }
    Ok(Some(SaidaDoMotor {
        texto: String::from_utf8_lossy(&saida).trim().to_string(),
        duracao,
    }))
}

/// Os dois acessórios da etapa 5, prontos nesta máquina. `None` quando falta
/// algum: o programa sem o modelo não faz nada, e o modelo sem o programa
/// tampouco (DECISIONS #101 — a tela lista o que ESTA máquina faz).
pub fn acessorios_prontos(cache: &Path) -> Option<(PathBuf, PathBuf)> {
    let pronto = |nome: &str| -> Option<PathBuf> {
        let a = crate::acessorios::desta_maquina(nome)?;
        (crate::acessorios::estado(a, cache) == crate::acessorios::Estado::Pronto)
            .then(|| a.caminho(cache))
    };
    Some((
        pronto(crate::acessorios::WHISPER_CLI)?,
        pronto(crate::acessorios::MODELO_WHISPER)?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // O limpador de repetição — os números vieram do acervo real
    // -----------------------------------------------------------------------

    /// A tabela foi conferida contra o `limpar_transcricao` do
    /// `tools/curadoria.py` RODANDO, caso a caso — não deduzida do código.
    #[test]
    fn o_limpador_bate_com_o_python_caso_a_caso() {
        const CASOS: &[(&str, &str)] = &[
            // repetição curta: INTACTA. É a lição da DECISIONS #66 — piso
            // baixo mutila letra de verdade, dentro do arquivo do usuário.
            ("Valalalala", "Valalalala"),
            ("VaVaVa", "VaVaVa"),
            ("abcabcabc", "abcabcabc"),
            (
                "Adeus adeus adeus adeus adeus Bahia",
                "Adeus adeus adeus adeus adeus Bahia",
            ),
            ("Chove chove chove", "Chove chove chove"),
        ];
        for (entrada, esperado) in CASOS {
            assert_eq!(limpar_transcricao(entrada), *esperado, "{entrada:?}");
        }
    }

    /// O PISO em 200 caracteres, medido nos dois lados da borda com o Python.
    #[test]
    fn o_piso_do_laco_esta_em_200_caracteres() {
        assert_eq!(MIN_LACO, 200);
        // 198 caracteres: repetição legítima, sai intacta
        let curto = "la".repeat(99);
        assert_eq!(limpar_transcricao(&curto), curto, "198 caracteres ficam");
        // 200 caracteres: é laço do motor, colapsa para duas ocorrências
        let no_piso = "la".repeat(100);
        assert_eq!(limpar_transcricao(&no_piso), "lala", "200 colapsa");
        // e o laço de verdade, dos 300 aos 600 caracteres
        assert_eq!(limpar_transcricao(&"la".repeat(150)), "lala");
        assert_eq!(limpar_transcricao(&"ha ".repeat(80)), "ha ha ");
    }

    /// Linha inteira repetida em série: duas ficam, o resto sai. Conferido
    /// contra o Python, inclusive a comparação sem caixa/acento/pontuação e o
    /// fato de linha VAZIA nunca ser descartada.
    #[test]
    fn linha_repetida_em_serie_fica_em_duas() {
        assert_eq!(limpar_transcricao("a\na\na\na\nb"), "a\na\nb");
        assert_eq!(limpar_transcricao("Oi\noi\nOI!\noi\nb"), "Oi\noi\nb");
        assert_eq!(limpar_transcricao("a\n\n\n\na"), "a\n\n\n\na");
        assert_eq!(limpar_transcricao(""), "");
    }

    // -----------------------------------------------------------------------
    // A lista negra de alucinação
    // -----------------------------------------------------------------------

    /// Conferido contra o `eh_alucinacao` do `tools/curadoria.py`, incluindo
    /// os casos que ele deliberadamente NÃO condena.
    #[test]
    fn a_lista_negra_bate_com_o_python() {
        const CASOS: &[(&str, bool)] = &[
            ("Música", true),
            ("musicas", true),
            ("Obrigado", true),
            ("Legendas pela comunidade Amara.org", true),
            ("Inscreva-se no canal!", true),
            ("Amara.org", true),
            ("fim", true),
            ("The End", true),
            ("até mais", true),
            // e o que NÃO é alucinação: a frase precisa ser a linha INTEIRA
            ("obrigado meu senhor", false),
            ("O fim do mundo", false),
            ("Chove lá fora", false),
        ];
        for (texto, esperado) in CASOS {
            assert_eq!(eh_alucinacao(texto), *esperado, "{texto:?}");
        }
    }

    /// Só a lista INCONFUNDÍVEL apaga texto. É a lição do `MIN_LACO` aplicada
    /// à lista negra: derrubar um "Obrigado" de canto devocional seria mutilar
    /// letra de verdade, dentro do arquivo de alguém, para sempre.
    #[test]
    fn apagar_linha_e_privilegio_da_lista_inconfundivel() {
        let letra = "Chove lá fora\nObrigado meu senhor\nObrigado\n\
                     Legendas pela comunidade Amara.org\nE aqui dentro canta";
        assert_eq!(
            sem_alucinacao(letra),
            "Chove lá fora\nObrigado meu senhor\nObrigado\nE aqui dentro canta",
            "a legenda de vídeo sai; o agradecimento devocional fica"
        );
    }

    /// Transcrição que é SÓ alucinação vale vazia — e vazia com áudio legível
    /// marca instrumental. Gravar "Música / Obrigado / Tchau" como letra faria
    /// o arquivo "ter letra": ele sumiria da fila para sempre (DECISIONS #70).
    #[test]
    fn transcricao_so_de_alucinacao_nao_vira_letra() {
        let desfecho = decidir("Música\nObrigado\nTchau", 300.0, 300.0);
        assert!(
            matches!(desfecho, Desfecho::Instrumental { .. }),
            "{desfecho:?}"
        );
    }

    // -----------------------------------------------------------------------
    // O refrão — as travas do candidato, e o que ele NÃO faz
    // -----------------------------------------------------------------------

    /// Saída conferida contra o `extrair_candidatos` do Python sobre o mesmo
    /// texto: as travas descartam a alucinação ("Obrigado"), o placeholder
    /// ("Faixa 5") e a frase fraca ("amor"), e o mais repetido vem primeiro.
    #[test]
    fn os_candidatos_batem_com_o_python() {
        let texto = "Me apresento\nNa beira do mar sagrado\nNa beira do mar sagrado\n\
                     Obrigado\nNa beira do mar sagrado\nFaixa 5\namor\nMe apresento";
        assert_eq!(
            extrair_candidatos(texto),
            vec!["na beira do mar sagrado", "me apresento"]
        );
    }

    /// As três travas, uma a uma: 2 palavras, 8 caracteres, repetição >= 2.
    #[test]
    fn as_travas_do_candidato_sao_as_do_python() {
        assert_eq!(MIN_PALAVRAS_CANDIDATO, 2);
        assert_eq!(MIN_CARACTERES_CANDIDATO, 8);
        assert_eq!(MIN_REPETICOES_REFRAO, 2);
        // uma palavra só: nunca
        assert!(refrao("aleluia\naleluia\naleluia").is_none());
        // duas palavras, menos de 8 caracteres: nunca
        assert!(refrao("eu vou\neu vou\neu vou").is_none());
        // repetida uma vez só: não é refrão (e a primeira linha, que entra
        // como candidato, é a mesma frase)
        assert_eq!(
            refrao("na beira do mar\noutra coisa\nmais outra"),
            Some("na beira do mar".into()),
            "a primeira linha entra como candidato, como no Python"
        );
        assert!(
            refrao("eu\noutra coisa qualquer\nmais outra coisa").is_none(),
            "primeira linha fraca não vira candidato"
        );
    }

    /// A ÚNICA coisa que o refrão faz aqui é informar. A identificação pelo
    /// refrão (F14.1) mediu 0 e 1 identificação em 94 arquivos, e a única foi
    /// errada e aplicada (DECISIONS #74) — ela não entra num produto sem
    /// suporte, e por isso nenhum desfecho carrega título ou artista.
    #[test]
    fn nenhum_desfecho_carrega_titulo_ou_artista() {
        let letra = "Na beira do mar sagrado\nNa beira do mar sagrado\nEu vi Iemanjá";
        match decidir(letra, 60.0, 60.0) {
            Desfecho::Transcrita { refrao, letra: l, .. } => {
                assert_eq!(refrao.as_deref(), Some("na beira do mar sagrado"));
                assert_eq!(l, letra, "a letra sai como veio, sem laço a colapsar");
            }
            outro => panic!("{outro:?}"),
        }
        // o tipo não tem onde pôr um nome: esta é a garantia por construção
    }

    // -----------------------------------------------------------------------
    // A densidade e a duração PROVADA (DECISIONS #72)
    // -----------------------------------------------------------------------

    /// Piso e bordas conferidos contra o `sem_conteudo` do Python.
    #[test]
    fn a_densidade_bate_com_o_python() {
        assert_eq!(DENSIDADE_MINIMA_LETRA, 0.30);
        let d = DENSIDADE_MINIMA_LETRA;
        assert!(sem_conteudo("", 300.0, d));
        assert!(sem_conteudo("abc", 300.0, d));
        // 90 caracteres em 300 s = 0,30 c/s: NO piso, e o piso não condena
        assert!(!sem_conteudo(&"x".repeat(90), 300.0, d));
        assert!(sem_conteudo(&"x".repeat(89), 300.0, d));
        // sem duração não há densidade a medir
        assert!(!sem_conteudo("abc", 0.0, d));
    }

    /// Transcrição vazia com áudio LEGÍVEL marca instrumental (V7/F16). Áudio
    /// ilegível é erro, e são coisas diferentes — quem produz o erro é o
    /// `transcrever`, não esta função.
    #[test]
    fn transcricao_vazia_com_audio_legivel_marca_instrumental() {
        assert!(matches!(
            decidir("", 300.0, 300.0),
            Desfecho::Instrumental { .. }
        ));
        // e sem duração nenhuma: vazio não depende de duração
        assert!(matches!(decidir("", 0.0, 0.0), Desfecho::Instrumental { .. }));
    }

    /// **Sem prova de duração, ADIADA — e nada é gravado.**
    ///
    /// O cabeçalho do MP3 já mentiu por uma ordem de grandeza (300 s lidos
    /// como 2365 s), e uma música cantada foi marcada instrumental para
    /// sempre. Marcar tira o arquivo da fila em definitivo e desfazer é
    /// trabalho de gente: errar para este lado destrói dado de quem não tem a
    /// quem recorrer.
    #[test]
    fn transcricao_rala_sem_duracao_provada_e_adiada() {
        // 13 caracteres para 300 s de cabeçalho seriam 0,04 c/s
        let ralo = "la la la la";
        assert!(matches!(
            decidir(ralo, 0.0, 300.0),
            Desfecho::Adiada { .. }
        ));
        // com a duração PROVADA pelo motor, aí sim marca
        assert!(matches!(
            decidir(ralo, 300.0, 300.0),
            Desfecho::Instrumental { .. }
        ));
        // e o cabeçalho absurdo não decide nada sozinho: sem prova e sem
        // cabeçalho crível, a transcrição normal continua virando letra
        assert!(matches!(
            decidir(&"palavra ".repeat(60), 0.0, 2365.0),
            Desfecho::Adiada { .. }
        ));
        assert!(matches!(
            decidir(&"palavra ".repeat(60), 0.0, 300.0),
            Desfecho::Transcrita { .. }
        ));
    }

    /// O motivo do instrumental DIZ a conta: quem cura precisa ver por que
    /// este arquivo saiu da fila de letra, e é a única explicação que existe.
    #[test]
    fn o_motivo_do_instrumental_diz_a_conta() {
        match decidir(&"x".repeat(20), 300.0, 300.0) {
            Desfecho::Instrumental { motivo } => {
                assert!(motivo.contains("20 caracteres"), "{motivo}");
                assert!(motivo.contains("5m00s"), "{motivo}");
                assert!(motivo.contains("0,07"), "{motivo}");
                assert!(motivo.contains("0,30"), "{motivo}");
            }
            outro => panic!("{outro:?}"),
        }
    }

    // -----------------------------------------------------------------------
    // A linha de comando: o que ela tem, e sobretudo o que ela NÃO tem
    // -----------------------------------------------------------------------

    /// **`vad_filter` desligado.** Ligado, ele destruiu 35% das transcrições
    /// do acervo real: as transcrições foram de 42 para 71 e as vazias de 33
    /// para 2 quando ele foi desligado (DECISIONS #62). No whisper.cpp o
    /// equivalente é não passar `--vad`, e nada pode ligá-lo por padrão.
    ///
    /// A varredura olha a linha INTEIRA, e não uma lista de flags conhecidas:
    /// teste que só olha onde o autor lembrou dá confiança falsa
    /// (DECISIONS #76).
    #[test]
    fn a_linha_de_comando_nunca_liga_o_vad() {
        let args = argumentos(Path::new("/m/modelo.bin"), Path::new("/a/x.mp3"), IDIOMA);
        for arg in &args {
            let a = arg.to_lowercase();
            assert!(!a.contains("vad"), "{arg} liga o detector de fala");
        }
    }

    /// E nunca manda o motor GRAVAR arquivo: os `-o*`/`--output-*` do
    /// `whisper-cli` escrevem ao lado do MP3, e nada neste produto escreve na
    /// pasta de música de ninguém sem ação explícita.
    #[test]
    fn a_linha_de_comando_nunca_manda_gravar_arquivo() {
        let args = argumentos(Path::new("/m/modelo.bin"), Path::new("/a/x.mp3"), IDIOMA);
        for arg in &args {
            let a = arg.to_lowercase();
            assert!(
                !a.starts_with("--output") && !a.starts_with("-o"),
                "{arg} faria o motor gravar arquivo"
            );
        }
    }

    /// O que a linha PRECISA ter: modelo, arquivo, idioma e o
    /// `--max-context 0`, que é o `condition_on_previous_text=False` do
    /// faster-whisper — a outra trava contra os laços de repetição.
    #[test]
    fn a_linha_de_comando_leva_o_modelo_o_idioma_e_o_corte_de_contexto() {
        let args = argumentos(Path::new("/m/modelo.bin"), Path::new("/a/x.mp3"), IDIOMA);
        assert!(args.contains(&"/m/modelo.bin".to_string()));
        assert!(args.contains(&"/a/x.mp3".to_string()));
        assert!(args.contains(&"pt".to_string()));
        let par = args.windows(2).any(|p| p[0] == "--max-context" && p[1] == "0");
        assert!(par, "sem --max-context 0: {args:?}");
        assert!(args.contains(&"--print-progress".to_string()));
    }

    // -----------------------------------------------------------------------
    // A leitura do stderr
    // -----------------------------------------------------------------------

    #[test]
    fn a_duracao_e_o_progresso_saem_das_linhas_do_motor() {
        assert_eq!(
            ler_linha_do_motor(
                "main: processing 'x.mp3' (4800000 samples, 300.0 sec), 4 threads, 1 processors"
            ),
            Some(DoMotor::Duracao(300.0))
        );
        assert_eq!(
            ler_linha_do_motor("whisper_print_progress_callback: progress =  35%"),
            Some(DoMotor::Progresso(35))
        );
        assert_eq!(
            ler_linha_do_motor("whisper_print_progress_callback: progress = 100%"),
            Some(DoMotor::Progresso(100))
        );
        // ruído do motor não vira notícia nenhuma
        assert_eq!(ler_linha_do_motor("whisper_init_from_file_with_params_no_state: loading model"), None);
        assert_eq!(ler_linha_do_motor(""), None);
        assert_eq!(ler_linha_do_motor("main: processing 'x.mp3'"), None);
    }

    // -----------------------------------------------------------------------
    // O motor de verdade, executado — a família de testes que a v0.9.0 deixou
    // pronta para esta entrega
    // -----------------------------------------------------------------------

    /// Nunca cancela.
    const SEGUE: &dyn Fn() -> bool = &|| false;
    /// Ignora o progresso.
    const SEM_PROGRESSO: &dyn Fn(u8) = &|_| {};

    /// Um executável de mentira com o corpo de shell que se pedir.
    #[cfg(unix)]
    fn script(dir: &Path, corpo: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let caminho = dir.join(format!("whisper-falso-{n}"));
        std::fs::write(&caminho, format!("#!/bin/sh\n{corpo}")).unwrap();
        std::fs::set_permissions(&caminho, std::fs::Permissions::from_mode(0o755)).unwrap();
        caminho
    }

    #[cfg(unix)]
    fn modelo_falso(dir: &Path) -> PathBuf {
        let caminho = dir.join("ggml-small-q5_1.bin");
        std::fs::write(&caminho, b"modelo de mentira").unwrap();
        caminho
    }

    /// **QA A4, agora com o motor que o defeito esperava.** O `whisper-cli`
    /// despeja progresso em stderr muito acima dos 64 KiB do cano; sem os dois
    /// drenos, o filho bloqueia na própria escrita e a etapa nunca termina.
    ///
    /// O comentário do `fingerprint.rs` dizia, em julho: "defeito plantado
    /// para detonar na entrega seguinte". É esta.
    #[cfg(unix)]
    #[test]
    fn stderr_muito_maior_que_o_cano_nao_trava_a_transcricao() {
        let dir = tempfile::tempdir().unwrap();
        // ~400 KiB em stderr, seis vezes o cano
        let whisper = script(
            dir.path(),
            r#"echo "main: processing 'x.mp3' (4800000 samples, 300.0 sec), 4 threads" >&2
i=0
while [ $i -lt 400 ]; do
  awk 'BEGIN{s="";while(length(s)<1023)s=s "x";print s}' >&2
  echo "whisper_print_progress_callback: progress = $((i / 4))%" >&2
  i=$((i+1))
done
echo "Chove lá fora"
echo "E aqui dentro canta o coração"
"#,
        );
        let modelo = modelo_falso(dir.path());
        let mp3 = dir.path().join("x.mp3");
        std::fs::write(&mp3, b"nao importa").unwrap();

        let inicio = Instant::now();
        let saida = transcrever(&whisper, &modelo, &mp3, IDIOMA, SEGUE, SEM_PROGRESSO)
            .expect("stderr grande não é falha")
            .expect("não foi cancelado");
        let gasto = inicio.elapsed();

        assert_eq!(saida.texto, "Chove lá fora\nE aqui dentro canta o coração");
        assert!((saida.duracao - 300.0).abs() < 1e-9, "a duração do motor");
        assert!(gasto < Duration::from_secs(60), "travou nos canos: {gasto:?}");
    }

    /// O progresso do motor vira progresso por música — é o que a tela mostra
    /// durante os minutos de uma faixa. Cresce e termina em 100.
    #[cfg(unix)]
    #[test]
    fn o_progresso_do_stderr_chega_a_quem_chamou() {
        let dir = tempfile::tempdir().unwrap();
        let whisper = script(
            dir.path(),
            r#"echo "main: processing 'x.mp3' (1600000 samples, 100.0 sec), 4 threads" >&2
for p in 5 25 50 75 100; do
  echo "whisper_print_progress_callback: progress = $p%" >&2
done
echo "uma letra qualquer que seja comprida o suficiente"
"#,
        );
        let modelo = modelo_falso(dir.path());
        let mp3 = dir.path().join("x.mp3");
        std::fs::write(&mp3, b"nao importa").unwrap();

        let vistos = std::sync::Mutex::new(Vec::new());
        let anota: &dyn Fn(u8) = &|p| vistos.lock().unwrap().push(p);
        transcrever(&whisper, &modelo, &mp3, IDIOMA, SEGUE, anota)
            .unwrap()
            .unwrap();

        let vistos = vistos.lock().unwrap().clone();
        assert_eq!(vistos, vec![5, 25, 50, 75, 100], "{vistos:?}");
    }

    /// **Cancelar responde em segundos, não em minutos.** Transcrever é a
    /// única etapa que leva minutos POR MÚSICA: um cancelamento que só é
    /// consultado entre arquivos não é cancelamento.
    ///
    /// O falso é um shell que chama `sleep`, de propósito: matar o filho não
    /// fecha os canos quando existe um NETO segurando a ponta de escrita, e
    /// esperar as threads de dreno traria a demora toda de volta (QA A4).
    #[cfg(unix)]
    #[test]
    fn cancelar_interrompe_a_transcricao_no_meio() {
        let dir = tempfile::tempdir().unwrap();
        let whisper = script(dir.path(), "sleep 60\n");
        let modelo = modelo_falso(dir.path());
        let mp3 = dir.path().join("x.mp3");
        std::fs::write(&mp3, b"nao importa").unwrap();

        let inicio = Instant::now();
        let saida = transcrever(&whisper, &modelo, &mp3, IDIOMA, &|| true, SEM_PROGRESSO)
            .expect("cancelar não é falha");
        let gasto = inicio.elapsed();

        assert!(saida.is_none(), "cancelar devolve None, não erro");
        assert!(gasto < Duration::from_secs(5), "demorou {gasto:?}");
    }

    /// E o processo morre junto: deixar um `whisper-cli` vivo por música numa
    /// fila de 47 arquivos consome a máquina de quem mandou PARAR — e este
    /// consome a máquina inteira, não uns décimos de segundo como o `fpcalc`.
    #[cfg(unix)]
    #[test]
    fn o_processo_cancelado_e_encerrado_e_nao_fica_orfao() {
        let dir = tempfile::tempdir().unwrap();
        let marca = dir.path().join("ainda-vivo");
        let whisper = script(
            dir.path(),
            &format!("sleep 2\ntouch '{}'\n", marca.display()),
        );
        let modelo = modelo_falso(dir.path());
        let mp3 = dir.path().join("x.mp3");
        std::fs::write(&mp3, b"nao importa").unwrap();

        let _ = transcrever(&whisper, &modelo, &mp3, IDIOMA, &|| true, SEM_PROGRESSO);
        std::thread::sleep(Duration::from_millis(3500));
        assert!(!marca.exists(), "o transcritor continuou rodando depois do PARE");
    }

    /// Binário que não sobe é VEREDITO sobre a máquina, não sobre o arquivo —
    /// e é a única falha que desliga a etapa. A mensagem tem de ser distinta,
    /// senão o funil não consegue diferenciar as duas coisas (QA A2).
    #[test]
    fn binario_que_nao_existe_e_veredito_sobre_a_maquina() {
        let dir = tempfile::tempdir().unwrap();
        let modelo = dir.path().join("modelo.bin");
        std::fs::write(&modelo, b"x").unwrap();
        let erro = transcrever(
            Path::new("/nao/existe/whisper-cli"),
            &modelo,
            Path::new("/tmp/x.mp3"),
            IDIOMA,
            SEGUE,
            SEM_PROGRESSO,
        )
        .expect_err("binário ausente é falha");
        assert_eq!(erro.to_string(), ERRO_NAO_EXECUTA);
        assert_ne!(ERRO_NAO_EXECUTA, ERRO_AUDIO);
    }

    /// Sem o modelo não se abre processo nenhum: são 180 MB, e a frase precisa
    /// dizer QUAL dos dois downloads falta.
    #[test]
    fn sem_modelo_a_transcricao_nem_comeca() {
        let erro = transcrever(
            Path::new("/bin/sh"),
            Path::new("/nao/existe/modelo.bin"),
            Path::new("/tmp/x.mp3"),
            IDIOMA,
            SEGUE,
            SEM_PROGRESSO,
        )
        .expect_err("sem modelo é falha");
        assert_eq!(erro.to_string(), ERRO_SEM_MODELO);
    }

    /// Motor que falha NESTE arquivo é erro de UMA música: a mensagem é a de
    /// áudio, não a de máquina, e a fila do chamador segue.
    #[cfg(unix)]
    #[test]
    fn motor_que_falha_no_arquivo_e_erro_de_uma_musica_so() {
        let dir = tempfile::tempdir().unwrap();
        let whisper = script(dir.path(), "echo 'error: failed to open' >&2\nexit 1\n");
        let modelo = modelo_falso(dir.path());
        let mp3 = dir.path().join("x.mp3");
        std::fs::write(&mp3, b"nao importa").unwrap();

        let erro = transcrever(&whisper, &modelo, &mp3, IDIOMA, SEGUE, SEM_PROGRESSO)
            .expect_err("saída 1 é falha");
        assert_eq!(erro.to_string(), ERRO_AUDIO);
    }

    /// O motor que não informa a duração não impede a transcrição — só tira a
    /// prova. E sem prova, transcrição rala vira ADIADA (DECISIONS #72).
    #[cfg(unix)]
    #[test]
    fn motor_que_nao_informa_a_duracao_deixa_a_prova_em_zero() {
        let dir = tempfile::tempdir().unwrap();
        let whisper = script(dir.path(), "echo 'la la la'\n");
        let modelo = modelo_falso(dir.path());
        let mp3 = dir.path().join("x.mp3");
        std::fs::write(&mp3, b"nao importa").unwrap();

        let saida = transcrever(&whisper, &modelo, &mp3, IDIOMA, SEGUE, SEM_PROGRESSO)
            .unwrap()
            .unwrap();
        assert_eq!(saida.duracao, 0.0);
        assert!(matches!(
            decidir(&saida.texto, saida.duracao, 300.0),
            Desfecho::Adiada { .. }
        ));
    }

    /// Nenhuma mensagem deste módulo repassa texto do motor: ele fala inglês e
    /// despeja diagnóstico de decodificador, e quem lê não tem a quem
    /// perguntar.
    #[test]
    fn nenhuma_mensagem_repassa_o_texto_do_motor() {
        for msg in [ERRO_NAO_EXECUTA, ERRO_SEM_MODELO, ERRO_AUDIO, ERRO_TRAVOU] {
            let baixa = msg.to_lowercase();
            // palavra a palavra: "modelo" é português e contém "model"
            for palavra in baixa.split(|c: char| !c.is_alphanumeric()) {
                assert!(
                    !["error", "failed", "whisper", "model", "ggml", "vad"].contains(&palavra),
                    "{msg} repassa jargão do motor: {palavra}"
                );
            }
            assert!(msg.chars().next().is_some_and(char::is_lowercase));
        }
    }
}
