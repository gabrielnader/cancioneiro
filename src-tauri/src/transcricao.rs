//! V10 — etapa 5 do funil: escrever a letra OUVINDO O ÁUDIO.
//!
//! Porte do subcomando `transcrever` do `tools/curadoria.py` (`_MIN_LACO`,
//! `limpar_transcricao`, `eh_alucinacao`, `extrair_candidatos`,
//! `sem_conteudo`, e o laço de decisão do `cmd_transcrever`), trocando o
//! motor: lá é o `faster-whisper` (CTranslate2, Python), aqui é o
//! `whisper-cli` do whisper.cpp com um modelo baixado como acessório.
//!
//! **Qual modelo é escolha do programa, não da pessoa** (V10.2): a transcrição
//! usa o preferido que estiver pronto. Desde a V10.5 há UM no catálogo — a
//! medição no acervo real decidiu entre os dois que conviviam. Ver o bloco
//! marcado em `MODELOS`.
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
//! **Isto foi FALSO na v0.10.0, e o teste que o afirmava passava** (QA A2). O
//! tipo de retorno realmente não tem onde pôr um nome — mas quem montava a
//! proposta da etapa 5 partia da proposta da etapa 1, e assim a linha saía
//! propondo o palpite do nome do arquivo sob o rótulo da transcrição. O teste
//! só passava por usar música com etiqueta REAL, em que o palpite empata com a
//! etiqueta; a música TÍPICA desta etapa é a de CD ripado, e nela a linha
//! propunha "Oh! Chuva" / "Falamansa". A correção está em
//! `enrich::proposta_da_transcricao`, e o teste passou a usar o caso que
//! importa. **Garantia de construção que depende de quem chama não é garantia
//! de construção.**
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

/// Segundos de CPU por segundo de ÁUDIO, para o `ggml-medium.bin`.
/// **Número de referência, não medido.**
///
/// O `tools/curadoria.py` usa 0,25 para o `small` do faster-whisper, e esse
/// número é a proporção PUBLICADA daquele motor. Este é outro motor
/// (whisper.cpp) com outro modelo e em máquinas que ninguém pode olhar: reusar
/// 0,25 seria a DECISIONS #72 outra vez — a prova não viaja junto quando o
/// código é reusado.
///
/// **De onde saem os 3,0.** A v0.10.0 declarava 1,0 para o `small` ("um minuto
/// de máquina por minuto de música"), e o dono do produto mediu o `medium` como
/// ~3x mais lento que ele. É palpite em cima de palpite, e é por isso que a
/// medição é POR MODELO: este 3,0 vale só até esta máquina transcrever 5
/// minutos de áudio com este modelo, e some.
///
/// Ele NÃO é a média esperada: pela DECISIONS #85 o defeito é prometer MENOS do
/// que leva, então este número erra para cima de propósito. E a copy tem de
/// dizer "cerca de".
///
/// **V10.5 — o 1,0 do `small` SUMIU junto com o modelo.** Ele não vira o padrão
/// de nada: uma razão declarada é a de UM motor, e a de um motor que saiu do
/// produto não descreve mais coisa nenhuma.
///
/// **Este número existe para ser substituído por medição, e agora ele é.**
///
/// A v0.10.0 calculava a razão real, serializava, tipava, testava — e jogava
/// fora: nenhum consumidor no repositório inteiro (QA A1). A frase "leva cerca
/// de 3 horas NESTE COMPUTADOR" saía de uma constante declarada, num produto
/// cujo `whisper-cli` de macOS passou a sair sem Metal e sem Accelerate, o que
/// a torna ainda mais otimista.
///
/// O caminho de volta é `db::somar_medicao` / `db::razao_medida`: quem manda a
/// medição de volta é o próprio backend, ao fim de cada execução da etapa 5, e
/// quem a lê é a varredura que monta a pergunta do fim. Nada disso atravessa o
/// frontend — ver a DECISIONS #112.
pub const RAZAO_DE_REFERENCIA_DO_GRANDE: f64 = 3.0;

/// Áudio mínimo já transcrito nesta máquina para a razão MEDIDA valer.
///
/// Cinco minutos são umas duas ou três canções: o bastante para diluir a
/// máquina que estava ocupada com outra coisa na primeira delas, e pouco o
/// bastante para a segunda varredura do dia já usar o número real.
pub const AUDIO_MINIMO_PARA_MEDIR: f64 = 300.0;

// ---------------------------------------------------------------------------
//  ██  V10.5 — UM MODELO, PORQUE A MEDIÇÃO DECIDIU  ██
// ---------------------------------------------------------------------------
//
// O `ggml-small-q5_1.bin` saiu do catálogo: 31% de encontrabilidade contra os
// 48% do `ggml-medium.bin`, em 83 trechos de 3 músicas, com a letra conferida
// OUVINDO a gravação. Os números, e as DUAS ressalvas que andam com eles,
// estão no bloco marcado do `acessorios::CATALOGO` — leia lá antes de repetir
// o 48% em qualquer lugar.
//
// A LISTA CONTINUA EXISTINDO com um item só, e não virou uma constante. Ela é
// o lugar onde a preferência é DECLARADA, e é ela que a guarda do catálogo
// verifica ("todo acessório de DADO está na lista"): sem ela, o próximo modelo
// publicado apareceria na tela — a tela lista o catálogo —, alguém baixaria
// 1,5 GB e a transcrição nunca o usaria.
//
// PREFERÊNCIA, NÃO ESCOLHA: o primeiro da lista que estiver pronto é o que
// roda; nenhum pronto, a etapa não existe nesta máquina. Não há caixinha de
// seleção, e não vai haver — escolha é pedágio para quem não sabe o que é um
// modelo (DECISIONS #102).
//
// E A ORDEM É DECLARADA, não deduzida do tamanho do arquivo: um modelo melhor
// e MENOR amanhã (destilado, podado) entra na frente sem esta lista precisar
// de exceção, e ordenar por bytes o poria no fim.

/// Um modelo da etapa 5 — o arquivo que o `whisper-cli` lê para entender o que
/// é cantado.
#[derive(Debug, Clone, Copy)]
pub struct Modelo {
    /// O acessório do catálogo que traz este arquivo. É a identidade que
    /// atravessa para o frontend (`acessorio_baixar(nome)`).
    pub nome: &'static str,
    /// Segundos de relógio por segundo de áudio, DECLARADO — vale até esta
    /// máquina medir este modelo.
    pub razao_de_referencia: f64,
}

/// O modelo da etapa 5 (`ggml-medium.bin`) — o que sobrou da medição.
///
/// O identificador continua dizendo GRANDE, como o nome do acessório: ele é o
/// grande dos dois que existiram, e trocar o nome não mudaria nada além de
/// apagar de onde ele veio.
pub static MODELO_GRANDE: Modelo = Modelo {
    nome: crate::acessorios::MODELO_WHISPER_GRANDE,
    razao_de_referencia: RAZAO_DE_REFERENCIA_DO_GRANDE,
};

/// Os modelos da etapa 5, na ORDEM DE PREFERÊNCIA — o que entende melhor
/// primeiro. Hoje é UM; ver o bloco marcado acima para por que a lista
/// continua sendo uma lista.
pub const MODELOS: &[&Modelo] = &[&MODELO_GRANDE];

/// O modelo que o funil OFERECE para baixar, e cuja estimativa a tela mostra
/// enquanto não há nenhum no cache: o último da ordem de preferência.
///
/// Com um modelo só ele é o MESMO que o preferido, e a função continua
/// existindo porque as duas perguntas são diferentes — "qual eu ofereço a quem
/// não tem nada?" e "qual eu rodo?" — e voltarão a ter respostas diferentes no
/// dia em que houver dois de novo. Enquanto forem a mesma, há teste dizendo
/// isso em voz alta.
pub fn modelo_oferecido() -> &'static Modelo {
    MODELOS[MODELOS.len() - 1]
}

impl Modelo {
    /// O arquivo deste modelo, como ele se chama no lançamento e no cache.
    ///
    /// A busca é no CATÁLOGO inteiro, e não em `desta_maquina`: modelo é DADO
    /// e vale para as quatro plataformas, então a resposta não pode depender de
    /// onde a suíte está rodando. Vazio é inalcançável — há teste varrendo os
    /// modelos —, e é `""` em vez de um `panic!` porque a única coisa que
    /// depende disto é uma chave de medição: perder a estimativa é ruim,
    /// derrubar a transcrição de alguém é pior.
    pub fn arquivo(&self) -> &'static str {
        crate::acessorios::CATALOGO
            .iter()
            .find(|a| a.nome == self.nome)
            .map_or("", |a| a.arquivo)
    }

    /// A chave sob a qual ESTE modelo guarda o que mediu nesta máquina.
    ///
    /// A chave carrega o ARQUIVO, e não o nome do acessório: se um dia o mesmo
    /// nome de acessório passar a apontar para outro arquivo, a medição do
    /// arquivo antigo não pode ser lida como se fosse dele. É a DECISIONS #72
    /// escrita numa chave de banco — a prova não viaja junto quando o que a
    /// produziu muda.
    pub fn chave_de_medicao(&self) -> String {
        format!("{}:{}", crate::db::MEDICAO_TRANSCRICAO, self.arquivo())
    }
}

/// O modelo que vale: o PRIMEIRO da ordem de preferência que estiver pronto.
///
/// `None` = nenhum está pronto, e a etapa 5 não existe nesta máquina.
///
/// `estado_de` entra por parâmetro para a regra poder ser exercitada sem os
/// 1,7 GB de arquivos reais que a suíte não tem como forjar (a soma é
/// conferida contra o catálogo, e não há como gerar um arquivo que bata). O
/// caso que isto compra é o que importa: **grande corrompido não desliga a
/// etapa numa máquina que tem o pequeno** — cai para ele, em vez de falhar.
pub fn modelo_pronto(
    estado_de: impl Fn(&Modelo) -> crate::acessorios::Estado,
) -> Option<&'static Modelo> {
    MODELOS
        .iter()
        .copied()
        .find(|m| estado_de(m) == crate::acessorios::Estado::Pronto)
}

/// O modelo cuja estimativa vale nesta máquina: o preferido que estiver
/// PRONTO; o oferecido, enquanto nenhum está.
///
/// Existe porque a pergunta do fim é montada pela VARREDURA, que acontece
/// antes de a etapa 5 rodar — e "quanto tempo isto leva" depende de qual
/// modelo vai rodar. Uma varredura que estimasse pelo pequeno numa máquina com
/// o grande baixado erraria por um fator de três, para menos (DECISIONS #85).
pub fn modelo_desta_maquina(cache: &Path) -> &'static Modelo {
    modelo_pronto(|m| crate::acessorios::estado_desta_maquina(m.nome, cache))
        .unwrap_or_else(modelo_oferecido)
}

/// A razão que vale AGORA nesta máquina PARA ESTE MODELO: a medida, se já
/// houver amostra que baste; a de referência dele, enquanto não houver.
///
/// Existe como função — e não como duas leituras espalhadas — porque a escolha
/// entre número medido e número declarado é exatamente o tipo de regra que
/// diverge quando está escrita em dois lugares (DECISIONS #80).
pub fn razao_desta_maquina(conn: &rusqlite::Connection, modelo: &Modelo) -> f64 {
    razao_medida_desta_maquina(conn, modelo).unwrap_or(modelo.razao_de_referencia)
}

/// A razão MEDIDA deste modelo nesta máquina, ou `None` enquanto ela não
/// existe (amostra abaixo do piso, ou nada transcrito ainda).
///
/// É este `Option` — e não uma comparação com a constante — que responde "a
/// estimativa é medição ou palpite de fábrica?" (DECISIONS #119). A v0.10.0
/// respondia com `razao != RAZAO_DE_REFERENCIA`, e isso mentia na máquina que
/// medisse exatamente 1,0; com dois modelos há duas constantes, e a comparação
/// passaria a escolher a errada.
pub fn razao_medida_desta_maquina(
    conn: &rusqlite::Connection,
    modelo: &Modelo,
) -> Option<f64> {
    crate::db::razao_medida(
        conn,
        &modelo.chave_de_medicao(),
        AUDIO_MINIMO_PARA_MEDIR,
    )
    .ok()
    .flatten()
    .filter(|r| *r > 0.0)
}

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

/// Não foi possível preparar o áudio para o motor: a pasta de trabalho não
/// aceitou a escrita, ou o disco encheu. Frase distinta de propósito — o
/// problema não é o MP3 nem o transcritor, e mandar a pessoa procurar defeito
/// neles seria mandá-la procurar no lugar errado.
pub const ERRO_TEMPORARIO: &str =
    "não foi possível preparar o áudio neste computador — verifique o espaço em disco";

/// O arquivo tem mais áudio do que a etapa 5 consegue preparar de uma vez
/// (umas 37 horas; ver `Wav::MAX_AMOSTRAS`). Frase própria porque a pessoa não
/// tem defeito nenhum a procurar: o arquivo está bom, ele é que é enorme.
pub const ERRO_LONGO_DEMAIS: &str =
    "este arquivo tem áudio demais para a letra ser escrita de uma vez só";

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
        // Campo::Titulo: um candidato a refrão é um nome de MÚSICA em
        // potencial, e "Diversos" cantado numa letra é letra.
        if candidato_fraco(frase)
            || crate::enrich::is_placeholder(crate::enrich::Campo::Titulo, frase)
            || eh_alucinacao(frase)
        {
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
        && !crate::enrich::is_placeholder(crate::enrich::Campo::Titulo, primeira)
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
// O que se SABE sobre a duração desta música (DECISIONS #72)
// ---------------------------------------------------------------------------

/// Duração medida do áudio, com a única informação que decide se ela é PROVA:
/// o áudio foi lido até o fim?
///
/// # Por que dois campos, e não um número
///
/// A v0.10.0 usou "segundos > 0" como sinônimo de "duração provada", e o QA
/// mostrou o buraco: a contagem de amostras vinha de um decodificador que
/// **parava no número de quadros declarado no cabeçalho Xing/Info** — ou seja,
/// derivava exatamente do número que a DECISIONS #72 proíbe confiar. O
/// resultado era um número medido de verdade, de um pedaço do áudio, com cara
/// de prova. Um `cat a.mp3 b.mp3 > set.mp3` bastava: 30 s de música, cabeçalho
/// dizendo 2 s, e a etapa 5 afirmando "o áudio foi lido até o fim".
///
/// Medir e ler até o fim são fatos DIFERENTES, e quem decide precisa dos dois.
/// Um número sozinho não sabe dizer se é o áudio inteiro ou o começo dele —
/// e é essa diferença que separa "esta música não tem voz" (permanente) de
/// "não ouvi tudo" (a tentar de novo).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Duracao {
    /// Segundos MEDIDOS pela contagem de amostras. 0,0 = não houve medição.
    pub medida: f64,
    /// O áudio foi lido até o fim REAL do arquivo, sem falha de leitura e sem
    /// ficar aquém do que o próprio arquivo declara.
    pub ate_o_fim: bool,
}

impl Duracao {
    /// Nada se sabe: nem quantos segundos, nem se o áudio acabou.
    pub const DESCONHECIDA: Duracao = Duracao {
        medida: 0.0,
        ate_o_fim: false,
    };

    /// Medição de um áudio que se leu INTEIRO — a única coisa que autoriza um
    /// veredito permanente sobre esta música.
    pub fn completa(segundos: f64) -> Duracao {
        Duracao {
            medida: segundos,
            ate_o_fim: segundos > 0.0,
        }
    }

    /// É prova? Há medição E ela cobre o áudio inteiro.
    pub fn provada(&self) -> bool {
        self.medida > 0.0 && self.ate_o_fim
    }
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
        /// O que se sabe sobre a duração do áudio ouvido.
        duracao: Duracao,
    },
    /// Áudio lido ATÉ O FIM e transcrição sem conteúdo: música sem voz
    /// (V7/F16). Áudio ilegível é `Erro`, e áudio lido pela metade é `Adiada`
    /// — as três coisas são diferentes, e confundi-las tira o arquivo da fila
    /// de letra para sempre.
    Instrumental { motivo: String },
    /// Duração NÃO comprovadamente completa: nada é decidido e nada é gravado
    /// (DECISIONS #72 e #111).
    Adiada { motivo: String },
    /// Falha desta música. A fila segue.
    Erro { mensagem: String },
}

/// Frase única do adiamento por duração não comprovada. Uma só, porque a
/// pessoa que lê não tem a quem perguntar: o que ela precisa saber é que nada
/// foi gravado e o que fazer se a música realmente não tem voz.
fn motivo_de_adiar(detalhe: &str) -> String {
    format!(
        "{detalhe}, e não foi possível confirmar que o áudio deste arquivo foi ouvido até o \
         fim. Nada foi gravado, e a música continua na fila. Se ela não tem voz, marque como \
         instrumental no editor"
    )
}

/// Decide o desfecho a partir do que o motor devolveu — porte do laço de
/// decisão do `cmd_transcrever`.
///
/// # A ordem de autoridade da duração (DECISIONS #72, corrigida na #111)
///
/// `duracao` é a medição da nossa própria decodificação — contagem exata de
/// amostras dividida por 16 000 —, acompanhada do fato que decide se ela vale
/// como PROVA: o áudio foi lido até o fim. Os dois juntos ficam acima do número
/// que o motor informa no stderr (que só corrobora) e muito acima do cabeçalho
/// do MP3.
///
/// `duracao_do_cabecalho` entra em UM lugar só — decidir se a transcrição rala
/// vira `Adiada` —, e nunca decide sozinha. Ela é o número que já mentiu por
/// uma ordem de grandeza: 300 s reais lidos como 2365 s, e uma música cantada
/// marcada instrumental para sempre. Margem de segurança não protege contra
/// erro de ordem de grandeza; só corroboração protege.
///
/// # O `if` que a DECISIONS #108 prometeu, e que agora existe
///
/// Aquela decisão dizia que `Adiada` tinha ficado inalcançável pelo caminho
/// real e que o custo de mantê-la era um `if`. A hora chegou, e por um motivo
/// que a decisão não previa: a contagem de amostras podia vir de um áudio lido
/// pela METADE, e ninguém sabia. **`Instrumental` só sai com
/// `duracao.provada()`** — sem isso o produto ADIA, porque marcar tira o
/// arquivo da fila de letra para sempre e desfazer é trabalho de gente.
pub fn decidir(bruto: &str, duracao: Duracao, duracao_do_cabecalho: f64) -> Desfecho {
    decidir_com_densidade(bruto, duracao, duracao_do_cabecalho, DENSIDADE_MINIMA_LETRA)
}

/// O `decidir` com o piso de densidade explícito — a porta que os testes usam.
pub fn decidir_com_densidade(
    bruto: &str,
    duracao: Duracao,
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
    let prova = duracao.provada();

    if caracteres == 0 {
        // Vazio com o áudio LIDO ATÉ O FIM é música sem voz. Vazio com o áudio
        // lido pela metade é uma pergunta em aberto — e era exatamente aqui
        // que a v0.10.0 gravava a frase "o áudio foi lido até o fim" sobre um
        // arquivo cujos 28 dos 30 segundos nunca foram abertos.
        return if prova {
            Desfecho::Instrumental {
                motivo: "a transcrição voltou vazia e o áudio foi lido até o fim".to_string(),
            }
        } else {
            Desfecho::Adiada {
                motivo: motivo_de_adiar("a transcrição voltou vazia"),
            }
        };
    }
    if !prova {
        // Sem prova de duração não há densidade que valha: a ÚNICA coisa que
        // acusaria "instrumental" aqui é o cabeçalho, e ele não é medição.
        return if sem_conteudo(conteudo, duracao_do_cabecalho, densidade_minima) {
            Desfecho::Adiada {
                motivo: motivo_de_adiar(&format!(
                    "a transcrição saiu curta ({caracteres} caracteres)"
                )),
            }
        } else {
            // Texto de sobra: é letra, e letra se propõe sem depender de saber
            // a duração. O que NÃO se faz sem prova é o veredito permanente.
            let letra = limpar_transcricao(conteudo);
            Desfecho::Transcrita {
                refrao: refrao(&letra),
                letra,
                duracao,
            }
        };
    }
    if sem_conteudo(conteudo, duracao.medida, densidade_minima) {
        let densidade = caracteres as f64 / duracao.medida;
        return Desfecho::Instrumental {
            motivo: format!(
                "{caracteres} caracteres em {} de áudio dão {}, abaixo do mínimo de {}",
                duracao_em_pt_br(duracao.medida),
                decimal_pt_br(densidade),
                decimal_pt_br(densidade_minima)
            ),
        };
    }
    let letra = limpar_transcricao(conteudo);
    Desfecho::Transcrita {
        refrao: refrao(&letra),
        letra,
        duracao,
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

// ===========================================================================
// A DECODIFICAÇÃO — por que ela existe, e por que ela é uma boa notícia
// ===========================================================================
//
// O `whisper-cli` lê **WAV PCM 16 bits, 16 kHz, mono**, e só. Ele decodifica
// outros formatos quando compilado com ffmpeg, o que é opção de Linux e
// brigaria com o `BUILD_SHARED_LIBS=OFF` que faz do acessório UM arquivo
// conferível por UM SHA-256. Entregar a ele um MP3 e torcer seria a
// DECISIONS #96 outra vez: hash prova que baixou o arquivo certo, não que ele
// faz o que a gente precisa.
//
// Então o aplicativo **não depende do formato de entrada do binário**: ele
// decodifica aqui dentro, em Rust puro, e entrega o que o motor sabe ler.
//
// # A duração medida — e o buraco que quase passou (DECISIONS #111)
//
// Decodificar dá a CONTAGEM EXATA DE AMOSTRAS, e isso é medição do áudio.
// Mas a v0.10.0 quase publicou essa medição como prova sem reparar em COMO o
// decodificador decide onde parar.
//
// O `symphonia` liga `gapless` por padrão. Com ele, o `Track::num_frames` —
// que vem do contador de quadros do cabeçalho **Xing/Info** — vira o fim do
// fluxo, e todo pacote além dele é aparado até sobrar nada. Ou seja: a
// contagem de amostras derivava exatamente do número que a DECISIONS #72
// proíbe confiar, com cara de medição. O arquivo que expõe isso não é exótico
// — é o que `cat a.mp3 b.mp3 > set.mp3` produz, e todo player toca inteiro:
// 30 s de música, o contador da primeira cópia dizendo 2 s, e a etapa 5
// afirmando "o áudio foi lido até o fim".
//
// Duas coisas mudaram, e nenhuma é margem de segurança:
//
// 1. **`gapless` desligado.** O corte de silêncio de codificação (uns 12 ms
//    nas pontas) não vale um decodificador que obedece a um contador que
//    ninguém verificou. Sem ele o laço só para no EOF de verdade.
// 2. **O cabeçalho virou PISO, nunca autoridade.** Se decodificamos MUITO
//    menos do que o próprio arquivo declara, a leitura ficou incompleta e a
//    duração **não é prova** — é o que pega o arquivo cortado no meio, que
//    antes virava "8 s de áudio" em silêncio. Decodificar MAIS do que o
//    declarado é o caso normal do arquivo emendado, e não acusa nada: o
//    cabeçalho é que estava errado.
//
// É corroboração, que é o que a DECISIONS #72 diz ser a única proteção contra
// erro de ordem de grandeza — e ela é usada na única direção em que é sólida.
//
// O incidente original continua resolvido: sem cabeçalho Xing, 300 segundos
// reais eram lidos como 2365, e uma música CANTADA foi marcada instrumental
// para sempre. Com a contagem de amostras, 355 caracteres em 300 s dão
// 1,18 c/s (letra) em vez de 0,15 c/s (instrumental).
//
// # Onde o temporário NÃO vai
//
// **Nunca ao lado do MP3.** São acervos que o dono do produto não pode nem
// ver, e a regra "nenhum arquivo é renomeado ou movido" tem um irmão que
// nunca havia sido escrito: nada é CRIADO dentro do acervo. O destino é
// passado por quem chama (a pasta de dados do aplicativo), e a guarda de
// `Drop` o apaga em qualquer saída — sucesso, erro, cancelamento ou pânico —,
// o mesmo padrão do `.parcial` do `acessorios.rs`.

/// A taxa que o motor exige. Não é preferência: é o formato que ele lê.
pub const TAXA_DO_MOTOR: u32 = 16_000;

/// Meia-largura do núcleo de reamostragem, em amostras de ENTRADA.
const TAPS: isize = 24;

/// Corte do filtro, como fração da menor das duas Nyquist. 0,45 deixa margem
/// para a transição do filtro caber abaixo da Nyquist de destino — é o que
/// impede o conteúdo acima de 8 kHz de DOBRAR para dentro da banda de voz.
const FATOR_DE_CORTE: f64 = 0.45;

/// De quantos em quantos pacotes o cancelamento é consultado durante a
/// decodificação. Um pacote de MP3 são 1152 amostras (~26 ms a 44,1 kHz),
/// então 64 pacotes são ~1,7 s de áudio — muito menos que o tempo que a
/// decodificação leva por si.
const PACOTES_ENTRE_CHECAGENS: usize = 64;

/// Reamostrador de sinc janelado (Blackman), em FLUXO.
///
/// Em fluxo porque um set de duas horas a 16 kHz seriam centenas de MB se o
/// áudio inteiro fosse acumulado em memória, e essas máquinas são modestas. A
/// janela guarda só o que o núcleo ainda alcança.
///
/// Sinc janelado, e não decimação simples, porque decimar 44,1 kHz para 16 kHz
/// sem filtrar DOBRA tudo o que está acima de 8 kHz para dentro da banda de
/// voz — pratos e sibilância viram chiado exatamente onde o modelo procura
/// palavra. O peso é normalizado pela soma, o que garante ganho unitário em
/// corrente contínua seja qual for a janela.
struct Reamostrador {
    /// Amostras de entrada por amostra de saída.
    passo: f64,
    /// Corte, em ciclos por amostra de ENTRADA.
    corte: f64,
    janela: Vec<f32>,
    /// Posição de leitura dentro de `janela`, em amostras de entrada.
    pos: f64,
}

impl Reamostrador {
    fn novo(taxa_entrada: u32, taxa_saida: u32) -> Self {
        let (entrada, saida) = (taxa_entrada as f64, taxa_saida as f64);
        Reamostrador {
            passo: entrada / saida,
            corte: FATOR_DE_CORTE * entrada.min(saida) / entrada,
            // a janela começa com zeros à esquerda para a primeira amostra de
            // saída cair no instante zero do áudio, e não TAPS amostras adiante
            janela: vec![0.0; TAPS as usize],
            pos: TAPS as f64,
        }
    }

    /// sinc(x) = sen(pi x) / (pi x), com o limite em zero.
    fn sinc(x: f64) -> f64 {
        if x.abs() < 1e-9 {
            1.0
        } else {
            (std::f64::consts::PI * x).sin() / (std::f64::consts::PI * x)
        }
    }

    /// Blackman sobre [-TAPS, TAPS].
    fn janela_de_blackman(x: f64) -> f64 {
        let t = std::f64::consts::PI * x / TAPS as f64;
        0.42 + 0.5 * t.cos() + 0.08 * (2.0 * t).cos()
    }

    fn amostra_em(&self, pos: f64) -> f32 {
        let centro = pos.floor() as isize;
        let frac = pos - centro as f64;
        let (mut soma, mut peso_total) = (0.0f64, 0.0f64);
        for k in (1 - TAPS)..=TAPS {
            let i = centro + k;
            if i < 0 || i as usize >= self.janela.len() {
                continue;
            }
            let x = k as f64 - frac;
            let peso = Self::sinc(2.0 * self.corte * x) * Self::janela_de_blackman(x);
            soma += self.janela[i as usize] as f64 * peso;
            peso_total += peso;
        }
        if peso_total.abs() < 1e-12 {
            return 0.0;
        }
        (soma / peso_total) as f32
    }

    /// Consome mais entrada e escreve o que já der em `saida`.
    fn alimentar(&mut self, entrada: &[f32], saida: &mut Vec<i16>) {
        self.janela.extend_from_slice(entrada);
        let limite = self.janela.len() as f64 - TAPS as f64;
        while self.pos < limite {
            saida.push(para_i16(self.amostra_em(self.pos)));
            self.pos += self.passo;
        }
        // descarta o que o núcleo já não alcança
        let base = (self.pos.floor() as usize).saturating_sub(TAPS as usize);
        if base > 0 {
            self.janela.drain(..base);
            self.pos -= base as f64;
        }
    }

    /// Fim do áudio: preenche a cauda com silêncio para não perder as últimas
    /// amostras.
    fn finalizar(&mut self, saida: &mut Vec<i16>) {
        let cauda = vec![0.0f32; TAPS as usize];
        self.alimentar(&cauda, saida);
    }
}

/// f32 no intervalo [-1, 1] para PCM de 16 bits, com corte nos extremos.
fn para_i16(v: f32) -> i16 {
    (v.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16
}

/// Apaga o arquivo ao sair do escopo, aconteça o que acontecer — retorno
/// cedo, erro no meio, cancelamento ou pânico. Mesmo padrão do `.parcial` do
/// `acessorios.rs`, e pela mesma razão: é o que garante "não deixa lixo" sem
/// espalhar `remove_file` por seis caminhos de saída.
pub struct Temporario(pub PathBuf);

impl Drop for Temporario {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Fração do que o cabeçalho DECLARA abaixo da qual a leitura é considerada
/// incompleta.
///
/// O número é frouxo de propósito. Ele não existe para pegar diferença fina —
/// existe para pegar erro de ORDEM DE GRANDEZA, que é o modo de falha real: 8 s
/// de um arquivo que declara 30, 2 s de um arquivo que declara 30. Apertá-lo
/// custaria caro na direção errada: quando não há Xing/Info, o `symphonia`
/// ESTIMA o total pelo tamanho do arquivo e pela taxa do primeiro quadro, e
/// num VBR essa estimativa erra por alguns pontos percentuais sem que nada
/// esteja errado. Errar aqui para o lado apertado transformaria música normal
/// em `Adiada` para sempre.
const FRACAO_MINIMA_DO_DECLARADO: f64 = 0.9;

/// O que a decodificação produziu.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Decodificado {
    /// Amostras de 16 kHz mono escritas no WAV.
    pub amostras: u64,
    /// Duração em segundos, MEDIDA (amostras / taxa).
    pub duracao: f64,
    /// O áudio foi lido até o EOF real, sem falha de leitura, e sem ficar
    /// aquém do que o próprio arquivo declara. **Só com isto a duração é
    /// prova** — ver `Duracao` e a DECISIONS #111.
    pub completa: bool,
}

impl Decodificado {
    /// O que esta decodificação PROVA sobre a duração.
    pub fn prova(&self) -> Duracao {
        Duracao {
            medida: self.duracao,
            ate_o_fim: self.completa,
        }
    }
}

/// Decodifica o MP3 e grava um WAV 16 kHz mono em `destino`.
///
/// `Ok(None)` é cancelamento. `Err(ERRO_AUDIO)` é o áudio que não pôde ser
/// lido — arquivo danificado, formato que não é MP3, faixa vazia, **ou falha
/// de leitura no meio** —, e é erro de UMA música: a fila segue.
///
/// Nada é lido nem escrito ao lado do MP3: a única escrita é em `destino`.
pub fn decodificar_para_wav(
    mp3: &Path,
    destino: &Path,
    cancelado: &dyn Fn() -> bool,
) -> Result<Option<Decodificado>> {
    let arquivo = std::fs::File::open(mp3).map_err(|_| AppError(ERRO_AUDIO.into()))?;
    decodificar_fonte(Box::new(arquivo), destino, cancelado)
}

/// O corpo da decodificação, sobre uma fonte de bytes qualquer.
///
/// Existe separado do `decodificar_para_wav` por uma razão de teste que vale o
/// preço: **é o único jeito de provar que uma FALHA DE LEITURA no meio do
/// arquivo vira erro, e não áudio curto.** Não dá para fazer um `File` de
/// verdade falhar no meio dentro de uma suíte, e o modo de falha é dos mais
/// comuns nas 40 máquinas do produto — HD externo que dorme, pen drive,
/// compartilhamento de rede, setor ruim. Sem o encaixe, a correção do QA A3
/// seria uma linha de código sem prova nenhuma.
fn decodificar_fonte(
    fonte: Box<dyn symphonia::core::io::MediaSource>,
    destino: &Path,
    cancelado: &dyn Fn() -> bool,
) -> Result<Option<Decodificado>> {
    use symphonia::core::audio::GenericAudioBufferRef;
    use symphonia::core::codecs::audio::AudioDecoderOptions;
    use symphonia::core::formats::probe::Hint;
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;

    let fluxo = MediaSourceStream::new(fonte, Default::default());
    let mut hint = Hint::new();
    hint.with_extension("mp3");
    let mut formato = symphonia::default::get_probe()
        .probe(&hint, fluxo, FormatOptions::default(), MetadataOptions::default())
        .map_err(|_| AppError(ERRO_AUDIO.into()))?;
    let faixa = formato
        .tracks()
        .iter()
        .find(|t| t.codec_params.as_ref().is_some_and(|p| p.audio().is_some()))
        .ok_or_else(|| AppError(ERRO_AUDIO.into()))?;
    let id_da_faixa = faixa.id;
    // O que o ARQUIVO declara ter, em quadros PCM na taxa dele. Vem do
    // Xing/Info, do VBRI, ou de uma estimativa pelo tamanho — nenhum dos três
    // é medição, e por isso o número entra aqui como PISO a corroborar, nunca
    // como autoridade (DECISIONS #72).
    let declarado = faixa.num_frames;
    let parametros = faixa
        .codec_params
        .as_ref()
        .and_then(|p| p.audio())
        .ok_or_else(|| AppError(ERRO_AUDIO.into()))?
        .clone();
    // **`gapless` DESLIGADO, e é o coração da correção do C1.** Ligado (o
    // padrão), ele apara todo quadro que passe do fim declarado no cabeçalho
    // Xing/Info — e assim a "contagem de amostras" que a DECISIONS #108
    // promoveu ao topo da ordem de autoridade era, na verdade, o cabeçalho
    // disfarçado. O que se perde é o corte de silêncio de codificação, uns
    // 12 ms nas pontas; o que se ganha é ouvir o arquivo inteiro.
    let opcoes = AudioDecoderOptions::default().gapless(false);
    let mut decodificador = symphonia::default::get_codecs()
        .make_audio_decoder(&parametros, &opcoes)
        .map_err(|_| AppError(ERRO_AUDIO.into()))?;

    let mut wav = Wav::criar(destino)?;
    let mut reamostrador: Option<Reamostrador> = None;
    let mut mono: Vec<f32> = Vec::new();
    let mut entrelacado: Vec<f32> = Vec::new();
    let mut pcm: Vec<i16> = Vec::new();
    let mut pacotes = 0usize;
    // Quadros PCM (na taxa do ARQUIVO) que realmente saíram do decodificador.
    // É este número que se confronta com o declarado.
    let mut quadros_lidos: u64 = 0;
    // Não nasce em `false`: o único jeito de sair do laço para cá é o EOF.
    // Todo o resto — cancelamento, falha de leitura, fluxo quebrado — sai por
    // `return`, e é isso que garante que "ouvi até o fim" nunca seja o valor
    // padrão de nada.
    let chegou_ao_fim;

    loop {
        // O cancelamento é consultado DURANTE a decodificação: uma faixa longa
        // leva segundos aqui, e a etapa 5 inteira leva minutos — cada trecho
        // que ignora o "Cancelar" é tempo que a pessoa fica olhando um botão
        // que não responde (QA A4).
        pacotes += 1;
        if pacotes % PACOTES_ENTRE_CHECAGENS == 0 && cancelado() {
            return Ok(None); // o `Temporario` de quem chamou apaga o arquivo
        }
        let pacote = match formato.next_packet() {
            Ok(Some(p)) => p,
            // EOF do fluxo MPEG: o arquivo acabou. É a ÚNICA saída normal do
            // laço, e a única que autoriza dizer "ouvi até o fim".
            Ok(None) => {
                chegou_ao_fim = true;
                break;
            }
            // **QA A3.** Aqui morava um `break` que engolia tudo. Fluxo
            // truncado no fim é comum em acervo de gravação de casa — e o
            // `symphonia` já o entrega como `Ok(None)` acima. O que sobra
            // nesta perna é FALHA DE LEITURA: HD externo que dormiu, pen drive
            // arrancado, compartilhamento de rede que caiu, setor ruim. São
            // normais em 40 máquinas alheias, e tratá-las como "o áudio é
            // curto" promovia duração parcial a prova, gravava letra parcial
            // como completa e tirava o arquivo da fila para sempre.
            Err(_) => return Err(AppError(ERRO_AUDIO.into())),
        };
        if pacote.track_id != id_da_faixa {
            continue;
        }
        let quadro = match decodificador.decode_ref(&pacote.as_packet_ref()) {
            Ok(q) => q,
            Err(symphonia::core::errors::Error::DecodeError(_)) => continue, // quadro ruim: pula
            // o que não é quadro ruim é o fluxo quebrando: erro, não fim
            Err(_) => return Err(AppError(ERRO_AUDIO.into())),
        };
        quadros_lidos += quadro.frames() as u64;
        let taxa = quadro.spec().rate();
        let canais = quadro.num_planes().max(1);
        if taxa == 0 {
            return Err(AppError(ERRO_AUDIO.into()));
        }
        let r = reamostrador.get_or_insert_with(|| Reamostrador::novo(taxa, TAXA_DO_MOTOR));

        entrelacado.clear();
        match &quadro {
            GenericAudioBufferRef::F32(_) | GenericAudioBufferRef::F64(_) => {
                quadro.copy_to_vec_interleaved(&mut entrelacado)
            }
            _ => quadro.copy_to_vec_interleaved(&mut entrelacado),
        }
        // mono é a MÉDIA dos canais: descartar um canal perderia a voz quando
        // ela estiver panoramizada para o outro lado
        mono.clear();
        mono.reserve(entrelacado.len() / canais + 1);
        for bloco in entrelacado.chunks(canais) {
            mono.push(bloco.iter().sum::<f32>() / bloco.len() as f32);
        }
        pcm.clear();
        r.alimentar(&mono, &mut pcm);
        wav.escrever(&pcm)?;
    }

    if let Some(mut r) = reamostrador {
        pcm.clear();
        r.finalizar(&mut pcm);
        wav.escrever(&pcm)?;
    }
    let amostras = wav.finalizar()?;
    if amostras == 0 {
        // nem um quadro decodificou: isto não é "música sem voz", é áudio que
        // não pôde ser lido — e as duas coisas são diferentes (V7/F16)
        return Err(AppError(ERRO_AUDIO.into()));
    }
    // A CORROBORAÇÃO (DECISIONS #72): o que o arquivo declara vale como piso, e
    // só como piso. Ficar MUITO abaixo dele é leitura incompleta — o arquivo
    // cortado no meio, que antes virava "8 s de áudio" em silêncio. Ficar acima
    // é o arquivo emendado, e não acusa nada: quem estava errado era o
    // cabeçalho.
    let bate_com_o_declarado = match declarado {
        Some(d) if d > 0 => quadros_lidos as f64 >= d as f64 * FRACAO_MINIMA_DO_DECLARADO,
        // sem declaração não há o que corroborar: o que se mediu é o que o
        // arquivo tem, e dizer "não sei" aqui adiaria todo MP3 sem cabeçalho
        _ => true,
    };
    Ok(Some(Decodificado {
        amostras,
        duracao: amostras as f64 / TAXA_DO_MOTOR as f64,
        completa: chegou_ao_fim && bate_com_o_declarado,
    }))
}

/// Escritor de WAV PCM 16 bits mono, em fluxo: o cabeçalho sai com os
/// tamanhos zerados e é corrigido no fim, quando o total é conhecido. Assim o
/// áudio nunca precisa caber na memória.
struct Wav {
    arquivo: std::io::BufWriter<std::fs::File>,
    amostras: u64,
}

impl Wav {
    const CABECALHO: usize = 44;

    /// Teto de amostras que um WAV consegue DESCREVER.
    ///
    /// **QA B3.** Os dois tamanhos do cabeçalho são `u32`, e o do RIFF é
    /// `36 + bytes_de_audio`: a soma estoura a partir de umas 37 horas num
    /// arquivo só. Em `release` ela daria a volta em silêncio, e o `whisper-cli`
    /// receberia um WAV que anuncia dois segundos de áudio — a etapa 5
    /// escreveria a letra dos dois primeiros segundos de um set de dois dias e
    /// diria que ouviu tudo, que é o mesmo defeito do C1 por outra porta.
    /// 37 horas num MP3 é raro e não é impossível: `cat` de acervo inteiro é
    /// exatamente como estes arquivos nascem.
    const MAX_AMOSTRAS: u64 = ((u32::MAX as u64) - Self::CABECALHO as u64) / 2;

    fn criar(destino: &Path) -> Result<Self> {
        if let Some(pasta) = destino.parent() {
            std::fs::create_dir_all(pasta).map_err(|_| AppError(ERRO_TEMPORARIO.into()))?;
        }
        let arquivo = std::fs::File::create(destino).map_err(|_| AppError(ERRO_TEMPORARIO.into()))?;
        let mut wav = Wav {
            arquivo: std::io::BufWriter::new(arquivo),
            amostras: 0,
        };
        wav.escrever_cabecalho(0)?;
        Ok(wav)
    }

    fn escrever_cabecalho(&mut self, bytes_de_audio: u32) -> Result<()> {
        use std::io::Write;
        let taxa = TAXA_DO_MOTOR;
        let bytes_por_segundo = taxa * 2; // mono, 16 bits
        let mut c = Vec::with_capacity(Self::CABECALHO);
        c.extend_from_slice(b"RIFF");
        c.extend_from_slice(&(36 + bytes_de_audio).to_le_bytes());
        c.extend_from_slice(b"WAVEfmt ");
        c.extend_from_slice(&16u32.to_le_bytes()); // tamanho do bloco fmt
        c.extend_from_slice(&1u16.to_le_bytes()); // PCM
        c.extend_from_slice(&1u16.to_le_bytes()); // mono
        c.extend_from_slice(&taxa.to_le_bytes());
        c.extend_from_slice(&bytes_por_segundo.to_le_bytes());
        c.extend_from_slice(&2u16.to_le_bytes()); // alinhamento do bloco
        c.extend_from_slice(&16u16.to_le_bytes()); // bits por amostra
        c.extend_from_slice(b"data");
        c.extend_from_slice(&bytes_de_audio.to_le_bytes());
        debug_assert_eq!(c.len(), Self::CABECALHO);
        self.arquivo
            .write_all(&c)
            .map_err(|_| AppError(ERRO_TEMPORARIO.into()))
    }

    fn escrever(&mut self, pcm: &[i16]) -> Result<()> {
        use std::io::Write;
        if self.amostras + pcm.len() as u64 > Self::MAX_AMOSTRAS {
            // Recusar é a única saída honesta: escrever um cabeçalho que dá a
            // volta faria o motor ouvir um pedaço e o produto afirmar que
            // ouviu tudo. Erro de UMA música — a fila segue, e o arquivo
            // continua na fila em vez de sair dela com um veredito falso.
            return Err(AppError(ERRO_LONGO_DEMAIS.into()));
        }
        let mut bytes = Vec::with_capacity(pcm.len() * 2);
        for a in pcm {
            bytes.extend_from_slice(&a.to_le_bytes());
        }
        self.arquivo
            .write_all(&bytes)
            .map_err(|_| AppError(ERRO_TEMPORARIO.into()))?;
        self.amostras += pcm.len() as u64;
        Ok(())
    }

    /// Corrige os tamanhos do cabeçalho e devolve quantas amostras foram
    /// escritas.
    fn finalizar(mut self) -> Result<u64> {
        use std::io::{Seek, SeekFrom, Write};
        self.arquivo
            .flush()
            .map_err(|_| AppError(ERRO_TEMPORARIO.into()))?;
        let bytes_de_audio = (self.amostras * 2).min(Self::MAX_AMOSTRAS * 2) as u32;
        let mut arquivo = self
            .arquivo
            .into_inner()
            .map_err(|_| AppError(ERRO_TEMPORARIO.into()))?;
        debug_assert!(self.amostras <= Self::MAX_AMOSTRAS);
        arquivo
            .seek(SeekFrom::Start(0))
            .map_err(|_| AppError(ERRO_TEMPORARIO.into()))?;
        let mut cabecalho = Wav {
            arquivo: std::io::BufWriter::new(arquivo),
            amostras: 0,
        };
        cabecalho.escrever_cabecalho(bytes_de_audio)?;
        cabecalho
            .arquivo
            .flush()
            .map_err(|_| AppError(ERRO_TEMPORARIO.into()))?;
        Ok(self.amostras)
    }
}

/// Caminho do WAV temporário desta transcrição, na pasta que quem chama
/// escolheu — **nunca** ao lado do MP3.
fn caminho_temporario(pasta: &Path) -> PathBuf {
    static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    pasta.join(format!("transcricao-{}-{n}.wav", std::process::id()))
}

// ---------------------------------------------------------------------------
// O motor: rodar o whisper-cli sem travar e sem escrever nada
// ---------------------------------------------------------------------------

/// O que o `whisper-cli` devolveu.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SaidaDoMotor {
    /// A transcrição crua, uma linha por segmento.
    pub texto: String,
    /// O que se sabe sobre a duração do áudio que o motor ouviu.
    pub duracao: Duracao,
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

/// Decodifica o MP3 e roda o `whisper-cli` sobre o WAV resultante.
///
/// - `Ok(Some(saida))` — o motor rodou e terminou;
/// - `Ok(None)` — a pessoa cancelou. Cancelar não é falha;
/// - `Err` — o binário não sobe (`ERRO_NAO_EXECUTA`, veredito sobre a
///   máquina), o áudio não pôde ser lido (`ERRO_AUDIO`), a pasta de trabalho
///   não aceitou a escrita (`ERRO_TEMPORARIO`) ou o motor travou
///   (`ERRO_TRAVOU`).
///
/// `pasta_temporaria` é onde o WAV é criado, e **nunca** é a pasta do MP3:
/// nada é criado dentro do acervo. O arquivo some em qualquer saída, inclusive
/// pânico (ver `Temporario`).
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
#[allow(clippy::too_many_arguments)]
pub fn transcrever(
    whisper: &Path,
    modelo: &Path,
    mp3: &Path,
    pasta_temporaria: &Path,
    idioma: &str,
    cancelado: &dyn Fn() -> bool,
    progresso: &dyn Fn(u8),
) -> Result<Option<SaidaDoMotor>> {
    if !modelo.is_file() {
        return Err(AppError(ERRO_SEM_MODELO.into()));
    }
    // O binário é conferido ANTES de decodificar. Não é só economia (uma
    // faixa de cinco minutos leva segundos para decodificar): é a mesma
    // disciplina do `acessorios::baixar`, que diz "indisponível" antes de
    // gastar o download de alguém. A falha de SPAWN continua existindo logo
    // abaixo, para o arquivo que existe e mesmo assim não roda.
    if !whisper.is_file() {
        return Err(AppError(ERRO_NAO_EXECUTA.into()));
    }
    // O WAV nasce guardado: a partir daqui ele some em qualquer caminho de
    // saída que não seja o fim normal — e no fim normal também, quando o
    // `Temporario` sai de escopo.
    let temporario = Temporario(caminho_temporario(pasta_temporaria));
    let Some(decodificado) = decodificar_para_wav(mp3, &temporario.0, cancelado)? else {
        return Ok(None); // cancelado durante a decodificação
    };

    let mut filho = std::process::Command::new(whisper)
        .args(argumentos(modelo, &temporario.0, idioma))
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

    // A duração que o MOTOR anuncia é lida, mas não é a que sai daqui: ela
    // CORROBORA (ver o fim desta função). Quem manda é a contagem de amostras
    // da decodificação — ver a ordem de autoridade no cabeçalho da seção de
    // decodificação.
    let mut duracao_do_motor = 0.0f64;
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
                DoMotor::Duracao(s) => duracao_do_motor = s,
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
            DoMotor::Duracao(s) => duracao_do_motor = s,
        }
    }
    if !status.success() {
        return Err(AppError(ERRO_AUDIO.into()));
    }
    // A segunda corroboração, de graça: o motor anuncia quanto áudio ABRIU no
    // WAV que nós escrevemos. Se ele diz ter aberto MUITO MENOS do que
    // escrevemos, ele não ouviu a música inteira — e a transcrição que voltou
    // fala de um pedaço. Só nesta direção: um número maior é padding interno
    // do motor e não acusa nada. É a mesma disciplina do cabeçalho — o outro
    // número entra como piso, nunca como autoridade.
    let mut prova = decodificado.prova();
    if duracao_do_motor > 0.0
        && prova.medida > 0.0
        && duracao_do_motor < prova.medida * FRACAO_MINIMA_DO_DECLARADO
    {
        prova.ate_o_fim = false;
    }
    Ok(Some(SaidaDoMotor {
        texto: String::from_utf8_lossy(&saida).trim().to_string(),
        duracao: prova,
    }))
}

/// A etapa 5 pronta para rodar nesta máquina: o programa, o arquivo do modelo
/// e QUAL modelo é.
///
/// O terceiro campo não é decoração: é ele que diz sob que chave a medição
/// desta execução é guardada, e é ele que a estimativa da próxima varredura vai
/// ler. Devolver só os dois caminhos obrigaria quem chama a redescobrir o
/// modelo pelo nome do arquivo — um contrato que depende de o chamador lembrar
/// já falhou uma vez aqui (DECISIONS #112).
pub struct Transcritor {
    /// O `whisper-cli` conferido.
    pub programa: PathBuf,
    /// O arquivo do modelo no cache, conferido.
    pub arquivo_do_modelo: PathBuf,
    /// Qual dos modelos é este.
    pub modelo: &'static Modelo,
}

/// Os acessórios da etapa 5, prontos nesta máquina. `None` quando falta algum:
/// o programa sem modelo não faz nada, e modelo sem programa tampouco
/// (DECISIONS #101 — a tela lista o que ESTA máquina faz).
///
/// Com os DOIS modelos prontos sai o preferido; com o preferido corrompido sai
/// o outro. Ver `modelo_pronto`.
pub fn acessorios_prontos(cache: &Path) -> Option<Transcritor> {
    let programa = crate::acessorios::caminho_pronto(crate::acessorios::WHISPER_CLI, cache)?;
    let modelo = modelo_pronto(|m| crate::acessorios::estado_desta_maquina(m.nome, cache))?;
    // O caminho sai do CATÁLOGO, e não de um segundo `caminho_pronto`: aquele
    // reconferiria a soma, e conferir a soma é ler o arquivo inteiro — 1,5 GB
    // no modelo grande. O `modelo_pronto` acima já a conferiu, nesta mesma
    // chamada; repetir não prova nada de novo e custa segundos por varredura.
    Some(Transcritor {
        programa,
        arquivo_do_modelo: crate::acessorios::desta_maquina(modelo.nome)?.caminho(cache),
        modelo,
    })
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
        let desfecho = decidir("Música\nObrigado\nTchau", Duracao::completa(300.0), 300.0);
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
        match decidir(letra, Duracao::completa(60.0), 60.0) {
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

    /// Transcrição vazia com o áudio lido ATÉ O FIM marca instrumental
    /// (V7/F16). Áudio ilegível é erro, e são coisas diferentes — quem produz
    /// o erro é o `transcrever`, não esta função.
    #[test]
    fn transcricao_vazia_com_audio_lido_ate_o_fim_marca_instrumental() {
        assert!(matches!(
            decidir("", Duracao::completa(300.0), 300.0),
            Desfecho::Instrumental { .. }
        ));
    }

    /// **O `if` da DECISIONS #108, agora existindo (QA C1).**
    ///
    /// Aquela decisão escreveu que `Adiada` tinha ficado inalcançável pelo
    /// caminho real e que "o custo de manter é um `if`". O QA mostrou por que o
    /// `if` precisava existir de verdade: a contagem de amostras vinha de um
    /// decodificador que parava no contador do cabeçalho, e um `cat a.mp3
    /// b.mp3` bastava para a etapa 5 afirmar "o áudio foi lido até o fim"
    /// sobre 2 dos 30 segundos.
    ///
    /// **Vazio sem prova de leitura completa NÃO é instrumental.** A marca
    /// tira o arquivo da fila de letra para sempre (ela vence até o
    /// `--forcar-tudo`), e o motivo gravado seria uma afirmação falsa.
    #[test]
    fn vazio_sem_prova_de_leitura_completa_e_adiado_e_nunca_instrumental() {
        for duracao in [
            Duracao::DESCONHECIDA,
            // medido, mas de um áudio que não se leu até o fim: é exatamente o
            // que o cabeçalho mentiroso produzia
            Duracao {
                medida: 2.0,
                ate_o_fim: false,
            },
        ] {
            match decidir("", duracao, 30.0) {
                Desfecho::Adiada { motivo } => {
                    assert!(motivo.contains("Nada foi gravado"), "{motivo}");
                }
                outro => panic!("{duracao:?} não podia dar {outro:?}"),
            }
        }
    }

    /// E a frase do instrumental só é dita quando ela é VERDADE.
    #[test]
    fn a_frase_do_audio_lido_ate_o_fim_so_sai_quando_e_verdade() {
        let dita = |d| match decidir("", d, 30.0) {
            Desfecho::Instrumental { motivo } => motivo.contains("lido até o fim"),
            _ => false,
        };
        assert!(dita(Duracao::completa(30.0)));
        assert!(!dita(Duracao {
            medida: 2.0,
            ate_o_fim: false
        }));
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
            decidir(ralo, Duracao::DESCONHECIDA, 300.0),
            Desfecho::Adiada { .. }
        ));
        // com a duração PROVADA, aí sim marca
        assert!(matches!(
            decidir(ralo, Duracao::completa(300.0), 300.0),
            Desfecho::Instrumental { .. }
        ));
        // medida mas incompleta vale o mesmo que não medida: é o caso do
        // arquivo emendado, em que 2 s de 30 tinham cara de medição
        assert!(matches!(
            decidir(
                ralo,
                Duracao {
                    medida: 2.0,
                    ate_o_fim: false
                },
                300.0
            ),
            Desfecho::Adiada { .. }
        ));
        // e o cabeçalho absurdo não decide nada sozinho: sem prova e sem
        // cabeçalho crível, a transcrição normal continua virando letra
        assert!(matches!(
            decidir(&"palavra ".repeat(60), Duracao::DESCONHECIDA, 2365.0),
            Desfecho::Adiada { .. }
        ));
        assert!(matches!(
            decidir(&"palavra ".repeat(60), Duracao::DESCONHECIDA, 300.0),
            Desfecho::Transcrita { .. }
        ));
    }

    /// Letra farta continua sendo LETRA mesmo sem prova de duração: o que a
    /// falta de prova proíbe é o veredito PERMANENTE (instrumental), não a
    /// proposta que alguém vai ler antes de aceitar.
    #[test]
    fn sem_prova_de_duracao_a_letra_farta_continua_saindo() {
        match decidir(&"palavra ".repeat(60), Duracao::DESCONHECIDA, 300.0) {
            Desfecho::Transcrita { duracao, .. } => {
                assert!(!duracao.provada(), "e a proposta CARREGA a falta de prova");
            }
            outro => panic!("{outro:?}"),
        }
    }

    /// **Nenhum caminho produz `Instrumental` sem prova.** Varredura sobre a
    /// combinação inteira, e não sobre os casos de que o autor lembrou
    /// (DECISIONS #76): é a única forma de o `if` continuar existindo depois
    /// que alguém acrescentar uma porta nova.
    #[test]
    fn instrumental_exige_duracao_comprovadamente_completa() {
        let textos = ["", "la", "Música", "la la la la", &"palavra ".repeat(60)];
        let duracoes = [
            Duracao::DESCONHECIDA,
            Duracao {
                medida: 2.0,
                ate_o_fim: false,
            },
            Duracao {
                medida: 300.0,
                ate_o_fim: false,
            },
            Duracao {
                medida: 0.0,
                ate_o_fim: true,
            },
        ];
        for texto in textos {
            for duracao in duracoes {
                let desfecho = decidir(texto, duracao, 300.0);
                assert!(
                    !matches!(desfecho, Desfecho::Instrumental { .. }),
                    "{texto:?} com {duracao:?} virou {desfecho:?}"
                );
            }
        }
    }

    /// O motivo do instrumental DIZ a conta: quem cura precisa ver por que
    /// este arquivo saiu da fila de letra, e é a única explicação que existe.
    #[test]
    fn o_motivo_do_instrumental_diz_a_conta() {
        match decidir(&"x".repeat(20), Duracao::completa(300.0), 300.0) {
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
    // O reamostrador: o que ele preserva e o que ele PRECISA jogar fora
    // -----------------------------------------------------------------------

    /// Gera `n` amostras de um seno de `hz` na taxa `taxa`.
    fn seno(hz: f64, taxa: u32, n: usize) -> Vec<f32> {
        (0..n)
            .map(|i| {
                (2.0 * std::f64::consts::PI * hz * i as f64 / taxa as f64).sin() as f32 * 0.8
            })
            .collect()
    }

    fn rms(v: &[i16]) -> f64 {
        if v.is_empty() {
            return 0.0;
        }
        let s: f64 = v.iter().map(|a| (*a as f64).powi(2)).sum();
        (s / v.len() as f64).sqrt()
    }

    fn reamostrar(entrada: &[f32], de: u32, para: u32) -> Vec<i16> {
        let mut r = Reamostrador::novo(de, para);
        let mut saida = Vec::new();
        // alimentado em pedaços, como o decodificador faz: prova que o
        // reamostrador em FLUXO não perde nem duplica nada nas emendas
        for pedaco in entrada.chunks(577) {
            r.alimentar(pedaco, &mut saida);
        }
        r.finalizar(&mut saida);
        saida
    }

    /// **A razão de existir do filtro.** Decimar 44,1 kHz para 16 kHz sem
    /// filtrar DOBRA tudo o que está acima de 8 kHz para dentro da banda de
    /// voz: prato e sibilância viram chiado exatamente onde o modelo procura
    /// palavra. Um tom de 12 kHz tem de SUMIR, não reaparecer em 4 kHz.
    #[test]
    fn o_reamostrador_corta_o_que_dobraria_para_dentro_da_voz() {
        let baixo = reamostrar(&seno(400.0, 44_100, 44_100), 44_100, TAXA_DO_MOTOR);
        let alto = reamostrar(&seno(12_000.0, 44_100, 44_100), 44_100, TAXA_DO_MOTOR);
        let (r_baixo, r_alto) = (rms(&baixo), rms(&alto));
        assert!(r_baixo > 10_000.0, "o tom de voz sobrevive: {r_baixo}");
        assert!(
            r_alto < r_baixo * 0.05,
            "12 kHz precisa ser cortado, não dobrado: {r_alto} contra {r_baixo}"
        );
    }

    /// Ganho unitário em corrente contínua: o áudio não pode sair mais alto
    /// nem mais baixo do que entrou.
    #[test]
    fn o_reamostrador_preserva_o_nivel() {
        let constante = vec![0.5f32; 44_100];
        let saida = reamostrar(&constante, 44_100, TAXA_DO_MOTOR);
        let meio = &saida[TAPS as usize * 3..saida.len() - TAPS as usize * 3];
        let esperado = 0.5 * i16::MAX as f64;
        for a in meio {
            assert!(
                (*a as f64 - esperado).abs() < esperado * 0.02,
                "nível fora: {a} contra {esperado}"
            );
        }
    }

    /// O número de amostras de saída é o da conversão de taxa, com folga de
    /// uma janela: é dele que sai a duração PROVADA.
    #[test]
    fn o_reamostrador_devolve_a_quantidade_certa_de_amostras() {
        for (de, n) in [(44_100u32, 44_100usize), (48_000, 48_000), (22_050, 22_050)] {
            let saida = reamostrar(&vec![0.1f32; n], de, TAXA_DO_MOTOR);
            let esperado = n as f64 * TAXA_DO_MOTOR as f64 / de as f64;
            assert!(
                (saida.len() as f64 - esperado).abs() <= TAPS as f64 + 2.0,
                "{de} Hz: {} amostras, esperado ~{esperado}",
                saida.len()
            );
        }
    }

    // -----------------------------------------------------------------------
    // O WAV e o temporário
    // -----------------------------------------------------------------------

    /// O cabeçalho é o que o `whisper-cli` exige: PCM 16 bits, 16 kHz, MONO. Se
    /// qualquer um dos três estiver errado, ele recusa o arquivo e a etapa 5
    /// nasce morta nas 40 máquinas.
    #[test]
    fn o_wav_sai_em_pcm_16_bits_16_khz_mono() {
        let dir = tempfile::tempdir().unwrap();
        let caminho = dir.path().join("a.wav");
        let mut wav = Wav::criar(&caminho).unwrap();
        wav.escrever(&[0i16, 1000, -1000]).unwrap();
        assert_eq!(wav.finalizar().unwrap(), 3);

        let bytes = std::fs::read(&caminho).unwrap();
        let u16em = |i: usize| u16::from_le_bytes([bytes[i], bytes[i + 1]]);
        let u32em = |i: usize| {
            u32::from_le_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]])
        };
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WAVE");
        assert_eq!(u16em(20), 1, "PCM");
        assert_eq!(u16em(22), 1, "mono");
        assert_eq!(u32em(24), 16_000, "16 kHz");
        assert_eq!(u32em(28), 32_000, "bytes por segundo = 16000 * 2");
        assert_eq!(u16em(32), 2, "alinhamento do bloco");
        assert_eq!(u16em(34), 16, "16 bits por amostra");
        assert_eq!(&bytes[36..40], b"data");
        assert_eq!(u32em(40), 6, "o tamanho é corrigido no fim");
        assert_eq!(u32em(4), 42, "e o RIFF também");
        assert_eq!(bytes.len(), 44 + 6);
    }

    /// O temporário some ao sair do escopo, aconteça o que acontecer — é a
    /// mesma guarda do `.parcial` do `acessorios.rs`, e é o que garante que
    /// cancelamento e pânico não deixem WAV de 10 MB espalhado.
    #[test]
    fn o_temporario_some_no_drop_inclusive_no_panico() {
        let dir = tempfile::tempdir().unwrap();
        let caminho = dir.path().join("t.wav");
        {
            let _t = Temporario(caminho.clone());
            std::fs::write(&caminho, b"audio").unwrap();
            assert!(caminho.exists());
        }
        assert!(!caminho.exists(), "o Drop apaga");

        let caminho = dir.path().join("panico.wav");
        let c = caminho.clone();
        let _ = std::panic::catch_unwind(move || {
            let _t = Temporario(c.clone());
            std::fs::write(&c, b"audio").unwrap();
            panic!("no meio da transcrição");
        });
        assert!(!caminho.exists(), "o Drop apaga no desenrolar do pânico");
    }

    /// O nome do temporário é único por processo e por chamada: duas
    /// transcrições ao mesmo tempo não podem escrever no mesmo arquivo.
    #[test]
    fn cada_temporario_tem_nome_proprio() {
        let pasta = Path::new("/tmp/x");
        let a = caminho_temporario(pasta);
        let b = caminho_temporario(pasta);
        assert_ne!(a, b);
        assert!(a.starts_with(pasta) && b.starts_with(pasta));
        assert!(a.extension().is_some_and(|e| e == "wav"));
    }

    // -----------------------------------------------------------------------
    // O que o motor recebe
    // -----------------------------------------------------------------------

    /// Sem o modelo não se abre processo nenhum e não se decodifica nada: são
    /// 180 MB, e a frase precisa dizer QUAL dos dois downloads falta.
    #[test]
    fn sem_modelo_a_transcricao_nem_comeca() {
        let dir = tempfile::tempdir().unwrap();
        let erro = transcrever(
            Path::new("/bin/sh"),
            Path::new("/nao/existe/modelo.bin"),
            Path::new("/tmp/x.mp3"),
            dir.path(),
            IDIOMA,
            SEGUE,
            SEM_PROGRESSO,
        )
        .expect_err("sem modelo é falha");
        assert_eq!(erro.to_string(), ERRO_SEM_MODELO);
        assert_eq!(sobrou_na_pasta(dir.path()), Vec::<String>::new());
    }

    /// Binário que não existe é VEREDITO sobre a máquina, e é conferido ANTES
    /// de decodificar: decodificar cinco minutos de áudio para então descobrir
    /// que o programa não está lá é gastar o tempo de quem espera.
    #[test]
    fn binario_que_nao_existe_e_veredito_sobre_a_maquina() {
        let dir = tempfile::tempdir().unwrap();
        let modelo = dir.path().join("modelo.bin");
        std::fs::write(&modelo, b"x").unwrap();
        let erro = transcrever(
            Path::new("/nao/existe/whisper-cli"),
            &modelo,
            Path::new("/tmp/x.mp3"),
            dir.path(),
            IDIOMA,
            SEGUE,
            SEM_PROGRESSO,
        )
        .expect_err("binário ausente é falha");
        assert_eq!(erro.to_string(), ERRO_NAO_EXECUTA);
        assert_ne!(ERRO_NAO_EXECUTA, ERRO_AUDIO);
        assert_eq!(
            sobrou_na_pasta(dir.path()),
            vec!["modelo.bin".to_string()],
            "nem chegou a criar o temporário"
        );
    }

    /// Nada de `-f arquivo.mp3`: o que vai para a linha de comando é o WAV.
    #[test]
    fn o_motor_recebe_o_wav_e_nunca_o_mp3() {
        let args = argumentos(
            Path::new("/m/modelo.bin"),
            Path::new("/dados/temporarios/transcricao-1-0.wav"),
            IDIOMA,
        );
        assert!(args.iter().any(|a| a.ends_with(".wav")));
        assert!(!args.iter().any(|a| a.ends_with(".mp3")));
    }

    // -----------------------------------------------------------------------
    // QA A3 — EOF e FALHA DE LEITURA são coisas diferentes
    // -----------------------------------------------------------------------

    /// Um MP3 sintético: quadros MPEG-1 Layer III de silêncio, 128 kbps,
    /// 44,1 kHz, mono. Serve para exercitar o CAMINHO da leitura sem depender
    /// da fixture — e sobretudo para poder falhar no meio de propósito.
    fn mp3_de_silencio(quadros: usize) -> Vec<u8> {
        let mut q = vec![0u8; 417]; // 144 * 128000 / 44100
        q[0] = 0xFF; // sincronismo
        q[1] = 0xFB; // MPEG-1, Layer III, sem CRC
        q[2] = 0x90; // 128 kbps, 44,1 kHz, sem padding
        q[3] = 0xC0; // mono
        q.repeat(quadros)
    }

    /// Uma fonte que entrega `ate` bytes e então **falha na leitura** — o HD
    /// externo que dormiu, o pen drive arrancado, o compartilhamento de rede
    /// que caiu, o setor ruim. Não dá para fazer um `File` de verdade fazer
    /// isso dentro de uma suíte, e este é o modo de falha mais comum das 40
    /// máquinas do produto.
    struct FonteQueFalha {
        bytes: Vec<u8>,
        pos: usize,
        /// Depois deste ponto a leitura ERRA. `None` = o arquivo inteiro
        /// chega, e o fim é um EOF honesto.
        falha_apos: Option<usize>,
    }

    impl FonteQueFalha {
        fn inteira(bytes: Vec<u8>) -> Self {
            FonteQueFalha { bytes, pos: 0, falha_apos: None }
        }
        fn que_falha_em(bytes: Vec<u8>, ponto: usize) -> Self {
            FonteQueFalha { bytes, pos: 0, falha_apos: Some(ponto) }
        }
    }

    impl std::io::Read for FonteQueFalha {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.falha_apos.is_some_and(|p| self.pos >= p) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    "o disco sumiu no meio da leitura",
                ));
            }
            let ate = self.falha_apos.unwrap_or(self.bytes.len());
            let fim = (self.pos + buf.len()).min(ate).min(self.bytes.len());
            let n = fim - self.pos;
            buf[..n].copy_from_slice(&self.bytes[self.pos..fim]);
            self.pos = fim;
            Ok(n)
        }
    }

    impl std::io::Seek for FonteQueFalha {
        fn seek(&mut self, de: std::io::SeekFrom) -> std::io::Result<u64> {
            let novo = match de {
                std::io::SeekFrom::Start(n) => n as i64,
                std::io::SeekFrom::Current(n) => self.pos as i64 + n,
                std::io::SeekFrom::End(n) => self.bytes.len() as i64 + n,
            };
            self.pos = novo.max(0) as usize;
            Ok(self.pos as u64)
        }
    }

    impl symphonia::core::io::MediaSource for FonteQueFalha {
        fn is_seekable(&self) -> bool {
            true
        }
        fn byte_len(&self) -> Option<u64> {
            Some(self.bytes.len() as u64)
        }
    }

    /// **Falha de leitura no meio é ERRO, e nunca "áudio curto".**
    ///
    /// Aqui morava um `Err(_) => break` que engolia tudo. O comentário falava
    /// de fluxo truncado no fim — que é comum em acervo de gravação de casa e
    /// que o `symphonia` já entrega como fim normal —, mas o mesmo `break`
    /// engolia falha de I/O. O resultado era duração parcial promovida a prova,
    /// letra parcial gravada como completa, e o arquivo fora da fila de letra
    /// para sempre, sem uma linha dizendo o que houve.
    #[test]
    fn falha_de_leitura_no_meio_e_erro_e_nunca_audio_curto() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = mp3_de_silencio(400);
        let destino = dir.path().join("saida.wav");

        // o mesmo áudio, lido inteiro: decodifica e a duração é COMPLETA
        {
            let _t = Temporario(destino.clone());
            let inteiro = decodificar_fonte(
                Box::new(FonteQueFalha::inteira(bytes.clone())),
                &destino,
                SEGUE,
            )
            .expect("silêncio é áudio")
            .expect("não cancelado");
            assert!(inteiro.completa, "{inteiro:?}");
            assert!(inteiro.duracao > 5.0, "{inteiro:?}");
        }

        // e agora o disco some no meio
        {
            let _t = Temporario(destino.clone());
            let erro = decodificar_fonte(
                Box::new(FonteQueFalha::que_falha_em(bytes.clone(), bytes.len() / 3)),
                &destino,
                SEGUE,
            )
            .expect_err("falha de leitura é erro, não áudio de um terço");
            assert_eq!(erro.to_string(), ERRO_AUDIO);
        }
    }

    /// **QA B3 — o cabeçalho do WAV não dá a volta em silêncio.**
    ///
    /// `36 + bytes_de_audio` é `u32`: a partir de umas 37 horas de áudio a
    /// soma estoura. Em `release` ela daria a volta, o `whisper-cli` receberia
    /// um WAV anunciando dois segundos, e a etapa 5 escreveria a letra do
    /// comecinho afirmando ter ouvido tudo — o C1 de novo, por outra porta.
    #[test]
    fn wav_longo_demais_recusa_em_vez_de_dar_a_volta() {
        let dir = tempfile::tempdir().unwrap();
        let caminho = dir.path().join("gigante.wav");
        let mut wav = Wav::criar(&caminho).unwrap();
        // 37 horas a 16 kHz — o teto está logo acima
        assert!(Wav::MAX_AMOSTRAS > 16_000 * 60 * 60 * 37);
        assert!(Wav::MAX_AMOSTRAS < 16_000 * 60 * 60 * 38);
        wav.amostras = Wav::MAX_AMOSTRAS - 1;
        let erro = wav
            .escrever(&[0i16, 0, 0])
            .expect_err("passar do teto é recusa");
        assert_eq!(erro.to_string(), ERRO_LONGO_DEMAIS);
        // e a frase é sobre o ARQUIVO, não sobre um defeito a procurar
        assert_ne!(ERRO_LONGO_DEMAIS, ERRO_AUDIO);
        assert_ne!(ERRO_LONGO_DEMAIS, ERRO_TEMPORARIO);
    }

    /// O que sobrou numa pasta, em ordem — para provar que nada ficou para
    /// trás (o mesmo auxiliar do `acessorios.rs`).
    fn sobrou_na_pasta(dir: &Path) -> Vec<String> {
        let mut nomes: Vec<String> = std::fs::read_dir(dir)
            .map(|it| {
                it.flatten()
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        nomes.sort();
        nomes
    }

    /// Nunca cancela.
    const SEGUE: &dyn Fn() -> bool = &|| false;
    /// Ignora o progresso.
    const SEM_PROGRESSO: &dyn Fn(u8) = &|_| {};

    // -----------------------------------------------------------------------
    // V10.5 — a lista de UM modelo, e a medição POR MODELO que continua
    // -----------------------------------------------------------------------

    /// A lista de modelos é ordem de PREFERÊNCIA, e ela cobre o catálogo.
    ///
    /// A guarda que importa é a última: **todo acessório de DADO do catálogo
    /// tem de estar aqui**. Sem ela, alguém publica um modelo, ele aparece na
    /// tela, a pessoa baixa 1,5 GB — e a transcrição nunca o usa, porque a
    /// preferência não sabe que ele existe. Hoje "dado" e "modelo" coincidem;
    /// quando deixarem de coincidir, é nesta linha que alguém vai ter de dizer
    /// qual é qual.
    ///
    /// **V10.5 — a lista tem UM item, e a guarda continua valendo dos dois
    /// lados**: nada no catálogo fora da lista, e nada na lista fora do
    /// catálogo. É justamente com uma entrada só que ela ganha valor: o
    /// próximo modelo publicado entra no catálogo (a tela lista o catálogo) e
    /// pode facilmente não entrar aqui.
    #[test]
    fn a_ordem_dos_modelos_e_de_preferencia_e_cobre_o_catalogo() {
        assert!(!MODELOS.is_empty());
        for m in MODELOS {
            assert!(
                crate::acessorios::CATALOGO.iter().any(|a| a.nome == m.nome),
                "{} não é acessório do catálogo",
                m.nome
            );
            assert!(
                !m.arquivo().is_empty(),
                "{}: sem arquivo, a chave da medição não identifica nada",
                m.nome
            );
            assert!(m.razao_de_referencia > 0.0);
        }
        // o oferecido é o ÚLTIMO da preferência: é o mais barato de baixar, e é
        // o que o funil propõe a quem ainda não tem nenhum
        assert_eq!(modelo_oferecido().nome, MODELOS[MODELOS.len() - 1].nome);
        // todo DADO do catálogo é um modelo conhecido daqui
        for a in crate::acessorios::CATALOGO.iter().filter(|a| !a.executavel) {
            assert!(
                MODELOS.iter().any(|m| m.nome == a.nome),
                "{} é dado no catálogo e não está na ordem de preferência",
                a.arquivo
            );
        }
        // e o contrário: nada aqui que o catálogo não ofereça — uma entrada
        // órfã seria um modelo que a transcrição prefere e que ninguém pode
        // baixar
        assert_eq!(
            MODELOS.len(),
            crate::acessorios::CATALOGO
                .iter()
                .filter(|a| !a.executavel)
                .count(),
            "a lista e o catálogo têm de descrever os MESMOS modelos"
        );
    }

    /// **Sobrou UM modelo, e é o `ggml-medium.bin` (V10.5).**
    ///
    /// *Mudou de propósito, e não por acidente.* Este teste pinava a
    /// PREFERÊNCIA entre dois modelos ("o maior primeiro, o pequeno é o que se
    /// oferece"), que era o desenho temporário da V10.2. A medição no acervo
    /// real acabou com a convivência — 48% do grande contra 31% do pequeno em
    /// 83 trechos —, e o que ele pina agora é o desfecho dela: o catálogo, a
    /// preferência e a oferta apontam todos para o mesmo arquivo. Uma tela que
    /// oferecesse um modelo e uma transcrição que rodasse outro é exatamente o
    /// defeito que a lista de preferência existe para impedir.
    #[test]
    fn o_unico_modelo_e_o_grande_e_e_ele_que_se_oferece() {
        assert_eq!(MODELOS.len(), 1, "a convivência dos dois acabou");
        assert_eq!(MODELOS[0].nome, crate::acessorios::MODELO_WHISPER_GRANDE);
        assert_eq!(modelo_oferecido().nome, MODELOS[0].nome);
        assert_eq!(modelo_oferecido().arquivo(), "ggml-medium.bin");
    }

    /// **A razão declarada que sobrou é a DO MOTOR QUE SOBROU.**
    ///
    /// *Mudou de propósito, e não por acidente.* Ele comparava as razões dos
    /// dois modelos (o grande é ~3x mais lento). Com um modelo só não há
    /// comparação a fazer — e o defeito que resta é o oposto e mais silencioso:
    /// alguém "limpa" a constante do grande de volta para 1,0, que era a do
    /// pequeno, e a tela passa a prometer 3 horas para um trabalho de 9
    /// (DECISIONS #85, para menos).
    #[test]
    fn a_razao_declarada_e_a_do_modelo_que_ficou() {
        let modelo = MODELOS[0];
        assert_eq!(modelo.razao_de_referencia, RAZAO_DE_REFERENCIA_DO_GRANDE);
        assert!(
            modelo.razao_de_referencia >= 3.0,
            "1,0 era a razão do `small`, que saiu do produto; o `medium` é ~3x \
             mais lento que ele, e arredondar para BAIXO é o defeito"
        );
    }

    /// **Com o modelo pronto, é ele que roda.** Continua sendo preferência, e
    /// não escolha: não há caixinha de seleção, porque escolha é pedágio para
    /// quem não sabe o que é um modelo (DECISIONS #102).
    #[test]
    fn com_o_modelo_pronto_a_transcricao_usa_ele() {
        use crate::acessorios::Estado;
        let escolhido = modelo_pronto(|_| Estado::Pronto).expect("há modelo pronto");
        assert_eq!(escolhido.nome, crate::acessorios::MODELO_WHISPER_GRANDE);
    }

    /// **O modelo inutilizável desliga a etapa 5, e é isso que tem de
    /// acontecer.**
    ///
    /// *Mudou de propósito, e não por acidente.* Ele fixava a QUEDA do grande
    /// corrompido para o pequeno — a rede de proteção que os dois modelos no
    /// catálogo compravam. Sem o segundo modelo não há para onde cair, e o
    /// desenho tem de dizer isso em vez de disfarçar: `None` é a etapa não
    /// existir nesta máquina, que é o que a tela mostra e o que o botão "baixar
    /// de novo" conserta. Um arquivo de 1,5 GB truncado NÃO pode virar um
    /// transcritor que roda com dado quebrado.
    #[test]
    fn modelo_inutilizavel_desliga_a_etapa_em_vez_de_rodar_quebrado() {
        use crate::acessorios::Estado;
        for ruim in [Estado::Corrompido, Estado::Ausente, Estado::Indisponivel] {
            assert!(
                modelo_pronto(|_| ruim).is_none(),
                "{ruim:?} não pode virar transcritor"
            );
        }
    }

    /// Sem modelo nenhum pronto, a etapa não existe — e isso é `None`, não uma
    /// escolha do pior de dois ausentes.
    #[test]
    fn sem_modelo_pronto_a_etapa_nao_existe() {
        use crate::acessorios::Estado;
        assert!(modelo_pronto(|_| Estado::Ausente).is_none());
    }

    /// Fim a fim contra o disco DE VERDADE: um arquivo com conteúdo errado no
    /// lugar do modelo é `Corrompido` para o `acessorios::estado` real, e o
    /// transcritor não sai. É o pedaço que liga a regra acima ao sistema de
    /// arquivos — a lição da DECISIONS #98.
    #[test]
    fn arquivo_errado_no_cache_nao_vira_transcritor() {
        let cache = tempfile::tempdir().unwrap();
        for nome in [
            crate::acessorios::MODELO_WHISPER_GRANDE,
            crate::acessorios::WHISPER_CLI,
        ] {
            if let Some(a) = crate::acessorios::desta_maquina(nome) {
                std::fs::write(a.caminho(cache.path()), b"nao e o arquivo certo").unwrap();
                assert_eq!(
                    crate::acessorios::estado(a, cache.path()),
                    crate::acessorios::Estado::Corrompido
                );
            }
        }
        assert!(acessorios_prontos(cache.path()).is_none());
        // e o modelo que vale para a ESTIMATIVA continua sendo o oferecido
        assert_eq!(
            modelo_desta_maquina(cache.path()).nome,
            modelo_oferecido().nome
        );
    }

    /// **A medição é POR MODELO.** Cada modelo guarda o próprio somatório, e a
    /// chave carrega o ARQUIVO — não o nome do acessório: se um dia o mesmo
    /// nome apontar para outro arquivo, a medição do arquivo antigo não pode
    /// ser lida como se fosse dele (DECISIONS #72).
    #[test]
    fn cada_modelo_tem_a_propria_chave_de_medicao() {
        let chaves: Vec<String> = MODELOS.iter().map(|m| m.chave_de_medicao()).collect();
        let mut unicas = chaves.clone();
        unicas.sort();
        unicas.dedup();
        assert_eq!(unicas.len(), chaves.len(), "chave repetida: {chaves:?}");
        for (m, chave) in MODELOS.iter().zip(&chaves) {
            assert!(
                chave.contains(m.arquivo()),
                "{chave} não diz qual arquivo foi medido"
            );
            assert!(chave.starts_with(crate::db::MEDICAO_TRANSCRICAO));
        }
    }

    /// **A medição do modelo que SAIU não manda na estimativa do que ficou.**
    ///
    /// *Mudou de propósito, e não por acidente.* Ele provava que a medição de
    /// um dos dois modelos não vazava para o outro. Agora prova a consequência
    /// disso na máquina de quem já usou a v0.10.x: a linha do
    /// `ggml-small-q5_1.bin` continua no banco, e ela é **lixo inofensivo** —
    /// ninguém a lê, e ela não desloca nada.
    ///
    /// **Por que ela não é apagada nem reetiquetada.** Reetiquetá-la para o
    /// `ggml-medium.bin` seria afirmar que uma medição feita com um motor vale
    /// para outro, que é exatamente o erro do PRD V10 (DECISIONS #72) — e um
    /// erro de fator ~3, para MENOS, na única frase que diz quanto tempo o
    /// trabalho leva. Apagá-la seria o programa mexendo em dado que já existe
    /// para arrumar uma casa que ninguém vê.
    #[test]
    fn a_medicao_do_modelo_que_saiu_nao_move_a_estimativa_do_que_ficou() {
        let conn = crate::db::open_in_memory().unwrap();
        let modelo = MODELOS[0];
        // como a v0.10.x deixou: 600 s de áudio em 300 s de relógio com o
        // `small`, sob a chave DELE
        let chave_do_pequeno = format!("{}:ggml-small-q5_1.bin", crate::db::MEDICAO_TRANSCRICAO);
        crate::db::somar_medicao(&conn, &chave_do_pequeno, 600.0, 300.0).unwrap();

        assert_eq!(
            razao_desta_maquina(&conn, modelo),
            modelo.razao_de_referencia,
            "o modelo que ficou continua na razão DECLARADA — ninguém o mediu"
        );
        assert_eq!(razao_medida_desta_maquina(&conn, modelo), None);
        // e a linha antiga continua ali, intacta: ninguém a apagou
        assert_eq!(
            crate::db::razao_medida(&conn, &chave_do_pequeno, AUDIO_MINIMO_PARA_MEDIR).unwrap(),
            Some(0.5)
        );
    }

    /// **"Medido" é um FATO, não uma comparação de floats.** A v0.10.0 decidia
    /// se a estimativa era medição comparando o número com a constante de
    /// referência: numa máquina que medisse exatamente a razão declarada, a
    /// tela mentiria dizendo "de fábrica".
    #[test]
    fn medido_e_um_fato_e_nao_a_comparacao_com_a_constante() {
        let conn = crate::db::open_in_memory().unwrap();
        let m = modelo_oferecido();
        // exatamente a razão de referência (3,0), medida de verdade
        crate::db::somar_medicao(&conn, &m.chave_de_medicao(), 600.0, 1800.0).unwrap();
        assert_eq!(razao_desta_maquina(&conn, m), RAZAO_DE_REFERENCIA_DO_GRANDE);
        assert_eq!(
            razao_medida_desta_maquina(&conn, m),
            Some(RAZAO_DE_REFERENCIA_DO_GRANDE),
            "o número empata com a constante, mas ele é MEDIDO"
        );
    }

    /// **A medição da v0.10.0 continua dizendo de QUAL modelo ela é — e por
    /// isso ela não é lida como sendo do modelo que ficou (V10.5).**
    ///
    /// *Mudou de propósito, e não por acidente.* Ele fixava que a linha da
    /// v0.10.0 seguia VALENDO, como medição do pequeno. Com o pequeno fora do
    /// catálogo ela não vale mais para estimativa nenhuma — e o que este teste
    /// protege agora é o outro lado: que ela não seja aproveitada para o
    /// `ggml-medium.bin`. A reetiquetagem continua rodando porque ela é o que
    /// torna a linha IDENTIFICÁVEL; sem ela sobraria uma chave `transcricao`
    /// nua, que é a próxima candidata a ser "aproveitada" por engano.
    #[test]
    fn a_medicao_de_modelo_unico_da_v0_10_0_nao_e_lida_como_do_modelo_atual() {
        let arquivo = tempfile::NamedTempFile::new().unwrap();
        {
            let conn = crate::db::open_at(arquivo.path()).unwrap();
            // como a v0.10.0 gravava: chave sem modelo nenhum
            conn.execute(
                "INSERT INTO medicoes_da_maquina (chave, audio_segundos, relogio_segundos)
                 VALUES ('transcricao', 600.0, 900.0)",
                [],
            )
            .unwrap();
        }
        // a abertura seguinte (a atualização do aplicativo) reetiqueta a linha
        let conn = crate::db::open_at(arquivo.path()).unwrap();
        assert_eq!(
            razao_medida_desta_maquina(&conn, MODELOS[0]),
            None,
            "a medição do motor que saiu NÃO é lida como se fosse do que ficou"
        );
        // ela continua no banco, com o nome do arquivo que a produziu
        let chave_do_pequeno = format!("{}:ggml-small-q5_1.bin", crate::db::MEDICAO_TRANSCRICAO);
        assert_eq!(
            crate::db::razao_medida(&conn, &chave_do_pequeno, AUDIO_MINIMO_PARA_MEDIR).unwrap(),
            Some(1.5),
            "1,5 s de relógio por segundo de áudio, como o `small` mediu aqui"
        );
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
