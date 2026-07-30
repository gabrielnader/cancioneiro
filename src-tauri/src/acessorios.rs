//! V9/F18 fase 2 — a máquina de acessórios: baixar, CONFERIR e só então
//! instalar os binários auxiliares que não cabem num instalador de 5 MB.
//!
//! Este é o módulo mais perigoso do produto: ele baixa um arquivo da internet
//! e o resultado é executado. Um download comprometido aqui vira execução de
//! código arbitrário nas máquinas de ~40 pessoas que não têm a quem
//! perguntar. Todo o desenho abaixo existe por causa disso.
//!
//! As quatro regras que o desenho executa (PRD V9, "Regras do download"):
//!
//! 1. **Origem única e fixa.** Os arquivos são rehospedados por nós, num
//!    lançamento à parte e ESTÁVEL (`acessorios-v1`). URL que não muda, hash
//!    sob nosso controle, uma origem só para explicar na tela.
//! 2. **Conferência obrigatória antes de executar.** O SHA-256 compilado no
//!    aplicativo é a autoridade; nada entra no cache sem conferir.
//! 3. **O cache nunca recebe arquivo pela metade.** O download vai para um
//!    `.parcial` ao lado, é conferido ali, e só então troca de nome. Internet
//!    que cai no meio, disco cheio ou cancelamento não deixam binário
//!    quebrado em uso — nem lixo na pasta.
//! 4. **Progresso e cancelamento durante o download**, não só entre arquivos:
//!    são 2 MB hoje e 180 MB na versão seguinte, e a v0.8.1 já ensinou o
//!    custo de deixar a pessoa olhando para uma tela parada.
//!
//! A rede entra por um `fetch` INJETÁVEL, como no funil: a suíte roda sem
//! rede, e o fetcher real (`commands::acessorio_fetcher`) recusa qualquer
//! endereço que não seja o do lançamento de acessórios.

use crate::error::{AppError, Result};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

// ===========================================================================
//  ██  CATÁLOGO DOS ACESSÓRIOS — É AQUI QUE OS SHA-256 SÃO PREENCHIDOS  ██
// ===========================================================================
//
// DE ONDE VÊM AS SOMAS: do lançamento `acessorios-v1` (Chromaprint v1.5.1),
// publicado pelo fluxo `.github/workflows/acessorios.yml`. Cada valor tem
// DUAS contas independentes sobre o mesmo arquivo: o `digest` que o próprio
// GitHub calcula sobre o ativo armazenado e o `SHA256SUMS.txt` que o fluxo
// calcula no runner. Se um dia elas divergirem, desconfie do ATIVO — nunca
// ajuste a constante para o valor novo.
//
// TROCAR UMA SOMA DESLIGA O ACESSÓRIO PARA QUEM JÁ BAIXOU: o arquivo que
// está no cache passa a ser considerado corrompido, e quem receber a
// atualização vê a etapa 2 sumir sem ter a quem perguntar. Se o Chromaprint
// for atualizado um dia, o caminho é publicar `acessorios-v2` com tag NOVA e
// trocar URL e somas de uma vez — nunca sobrescrever os ativos da v1 (o
// próprio fluxo diz isso).
//
// SOMA PENDENTE (64 zeros) deixa o acessório `Indisponivel`: o aplicativo diz
// isso ANTES de gastar o download de alguém, em vez de baixar 2 MB para então
// acusar o arquivo de estar corrompido — acusação falsa é pior que ausência
// de recurso quando a mensagem é a explicação inteira.
//
// V10 — AS ENTRADAS DA ETAPA 5. Os `whisper-cli` saem do fluxo
// `.github/workflows/acessorio-transcritor.yml` e os MODELOS do
// `acessorio-modelo.yml`, os dois no MESMO lançamento `acessorios-v1`
// (acrescentar arquivo a um lançamento não muda o hash dos que já estão lá —
// quem baixou o `fpcalc` não é afetado). Nenhum teste desta suíte depende dos
// valores reais: o que se testa é o MECANISMO de conferência.
//
// V10.2 — SÃO DOIS MODELOS, E ISSO É TEMPORÁRIO. Ver o bloco marcado dentro do
// catálogo, logo abaixo da entrada do `ggml-small-q5_1.bin`.
//
// AO PREENCHER UMA SOMA, PREENCHA O TAMANHO JUNTO: os tamanhos das entradas
// pendentes são APROXIMAÇÕES para a tela ter o que dizer, e saem do mesmo
// `ls -l`/resumo do fluxo que dá a soma. Tamanho errado não impede download
// nenhum (a barra usa o `Content-Length`), mas mente na estimativa de tempo —
// e estimativa errada por ordem de grandeza é pior que estimativa ausente
// (DECISIONS #85).

/// Soma ainda não preenchida (64 zeros). Ver o bloco acima.
pub const SHA256_PENDENTE: &str =
    "0000000000000000000000000000000000000000000000000000000000000000";

/// Lançamento ESTÁVEL dos acessórios — não muda a cada versão do aplicativo.
pub const URL_BASE: &str =
    "https://github.com/gabrielnader/cancioneiro/releases/download/acessorios-v1";

/// Nome do arquivo do macOS. O Chromaprint v1.5.1 publica um binário
/// UNIVERSAL: um arquivo só serve Intel e Apple Silicon, os dois nativos.
/// Não há Rosetta no caminho, não há aviso a dar na tela, e o catálogo tem
/// três entradas — não quatro.
pub const ARQUIVO_MACOS: &str = "fpcalc-macos-universal";

/// Tudo que o aplicativo sabe sobre os acessórios, compilado no binário.
pub const CATALOGO: &[Acessorio] = &[
    Acessorio {
        nome: FPCALC,
        plataforma: "windows-x86_64",
        arquivo: "fpcalc-windows-x86_64.exe",
        sha256: "659ea2dba1a12d7df4fe2b6f23f60fd9414ae61aca1b014ee8fa37c5e09b930b",
        tamanho_bytes: 3_418_112,
        executavel: true,
    },
    Acessorio {
        nome: FPCALC,
        plataforma: "linux-x86_64",
        arquivo: "fpcalc-linux-x86_64",
        sha256: "085a1adf67b4a71a2e57b7b05bc425c1ea21b371b2b43049fc8ba37b53cb472b",
        tamanho_bytes: 5_538_312,
        executavel: true,
    },
    Acessorio {
        nome: FPCALC,
        plataforma: "macos",
        arquivo: ARQUIVO_MACOS,
        sha256: "ede0f92ac30807799872f8700d5e334e9ddef738a6b1b9d154097954619d68f8",
        tamanho_bytes: 4_739_368,
        executavel: true,
    },
    // --- etapa 5 (V10): SOMAS E TAMANHOS PENDENTES -------------------------
    //
    // O whisper.cpp é CONSTRUÍDO por nós (`BUILD_SHARED_LIBS=OFF`, para o
    // acessório ser UM arquivo conferível por UM SHA-256). O macOS sai
    // universal, como o Chromaprint — ver o comentário da entrada dele.
    Acessorio {
        nome: WHISPER_CLI,
        plataforma: "windows-x86_64",
        arquivo: "whisper-cli-windows-x86_64.exe",
        // Republicado: o `whisper-cli` do Windows NÃO é reprodutível (o MSVC
        // carimba data e caminho no executável), então republicar o
        // lançamento para acrescentar um MODELO trocou a soma deste binário
        // sem que nada dele tivesse mudado. Linux e macOS saíram idênticos.
        // Foi o aviso do próprio fluxo acontecendo: "rodar de novo com a
        // mesma tag substitui os arquivos e muda os hashes que o app espera".
        // Ver a trava que o `acessorio-modelo.yml` passou a dar.
        sha256: "db0f063f489170c32bc6a59fe3b05db99e3ff3a317e2fe8b4362bdd95b9ab4de",
        tamanho_bytes: 971_776,
        executavel: true,
    },
    Acessorio {
        nome: WHISPER_CLI,
        plataforma: "linux-x86_64",
        arquivo: "whisper-cli-linux-x86_64",
        sha256: "8f294425975183614989e8ae428e4d0ecbdc3eb80769c489a3076647c6953344",
        tamanho_bytes: 1_635_784,
        executavel: true,
    },
    Acessorio {
        nome: WHISPER_CLI,
        // UNIVERSAL, como o fpcalc: um arquivo nativo nos dois processadores.
        // Eram duas entradas, uma por processador, até o runner Intel do CI
        // se revelar inatendível — três execuções ficaram horas na fila sem
        // começar. Runner que não existe não é plataforma a mais, é impasse;
        // e um arquivo a menos é um hash a menos e uma plataforma a menos
        // para explicar na tela.
        plataforma: "macos",
        arquivo: "whisper-cli-macos-universal",
        sha256: "6bc9670accbb2d5c9c1f8799c03bf65ab37d63f288c467f01da35f8bfbe1272c",
        tamanho_bytes: 2_830_456,
        executavel: true,
    },
    Acessorio {
        nome: MODELO_WHISPER,
        // DADO, não programa: o mesmo arquivo serve as quatro máquinas, e ele
        // não recebe o bit de execução.
        plataforma: QUALQUER_PLATAFORMA,
        arquivo: "ggml-small-q5_1.bin",
        sha256: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
        tamanho_bytes: 190_085_487,
        executavel: false,
    },
    // ███ V10.2 — O SEGUNDO MODELO EXISTE PARA SER MEDIDO, E UM DOS DOIS SAI ██
    //
    // NÃO trate dois modelos como o desenho final. Esta entrada e a de cima
    // convivem por UMA rodada, para o acervo real dizer qual fica; assim que a
    // medição decidir, **um dos dois é REMOVIDO do catálogo** (e a entrada que
    // ficar herda a preferência sozinha, sem `transcricao::MODELOS`).
    //
    // POR QUE ELE ENTROU: a v0.10.0 saiu com o `small` quantizado e a qualidade
    // reprovou na medição do acervo real — 37% de encontrabilidade contra os
    // 78% que o faster-whisper tinha entregado. Foi exatamente o risco que o
    // PRD V10 registrou ("a prova não viaja junto quando o código é reusado",
    // DECISIONS #72), acontecendo. E o modo de falha não é grafia: o modelo
    // classifica trecho CANTADO como música e não o transcreve — as saídas
    // vieram salpicadas de `[música]`, `[MÚSICA DE FUNDO]`, `[cantarolando]`, e
    // numa das faixas quatro estrofes inteiras sumiram. Onde ele emite a marca,
    // a letra não existe. Não é falta de idioma: o `--language pt` está sendo
    // passado (`transcricao::argumentos`).
    //
    // SÃO 1,5 GB, e o dono do produto autorizou: ele ensina cada pessoa
    // pessoalmente, e este download roda uma vez só na vida da máquina.
    //
    // A soma e o tamanho foram conferidos por ele BAIXANDO o arquivo publicado
    // e recalculando — não são o que o fluxo imprimiu e ninguém releu.
    Acessorio {
        nome: MODELO_WHISPER_GRANDE,
        plataforma: QUALQUER_PLATAFORMA,
        arquivo: "ggml-medium.bin",
        sha256: "6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208",
        tamanho_bytes: 1_533_763_059,
        executavel: false,
    },
];

// ===========================================================================
//  fim do bloco a preencher
// ===========================================================================

/// Nome do acessório da etapa 2. É o que o frontend manda em
/// `acessorio_baixar(nome)` e o que aparece nas mensagens.
pub const FPCALC: &str = "fpcalc";

/// Nome do PROGRAMA da etapa 5 (whisper.cpp).
pub const WHISPER_CLI: &str = "whisper-cli";

/// Nome do MODELO da etapa 5 — dado, não programa. São duas entradas
/// separadas de propósito: 2 MB e 180 MB têm conversas diferentes com quem
/// vai clicar, e um pode estar pronto sem o outro.
///
/// Desde a V10.2 este é o modelo PEQUENO dos dois. O nome não mudou porque ele
/// é a identidade que atravessa para o frontend (`acessorio_baixar(nome)`), e
/// renomear identidade de contrato para melhorar a leitura de quem escreve o
/// Rust é o tipo de troca que quebra a tela de quem não tem a quem perguntar.
pub const MODELO_WHISPER: &str = "modelo-de-transcricao";

/// Nome do modelo GRANDE da etapa 5 (V10.2, `ggml-medium.bin`).
///
/// **Temporário e declarado**: ele existe para a remedição escolher entre os
/// dois, e um dos dois sai do catálogo depois disso. Ver o bloco no `CATALOGO`
/// e a ordem de preferência em `transcricao::MODELOS`.
pub const MODELO_WHISPER_GRANDE: &str = "modelo-de-transcricao-grande";

/// Plataforma dos acessórios que são DADO: um arquivo só serve as quatro
/// máquinas. É sempre o ÚLTIMO recurso na busca, para nunca ganhar de um
/// arquivo específico do processador.
pub const QUALQUER_PLATAFORMA: &str = "qualquer";

// ---------------------------------------------------------------------------
// O tempo do download (PRD V10) — a regra que muda para 180 MB
// ---------------------------------------------------------------------------
//
// "Download só com aceite explícito, com tamanho **e tempo** — a dispensa do
// tempo valia para 5 MB, não vale para 180 MB."
//
// Antes do primeiro byte não há velocidade medida, e não medir não pode virar
// não dizer nada: a tela precisa de um número para a pessoa decidir se começa
// agora ou à noite. O número de referência abaixo é DECLARADO, não medido, e a
// copy tem de dizer "cerca de".

/// Velocidade de referência: 1 MB/s (~8 Mbit/s), uma conexão doméstica
/// modesta. Deliberadamente conservadora — pela DECISIONS #85, estimativa que
/// promete MENOS do que leva é o defeito; folga não é.
pub const BANDA_REFERENCIA_BYTES_S: u64 = 1_000_000;

/// Amostra mínima antes de trocar a referência pela velocidade MEDIDA. No
/// primeiro pedaço a velocidade aparente é absurda (64 KiB em microssegundos),
/// e um "faltam 0 segundos" que dura um minuto é pior que nenhum número.
const AMOSTRA_MINIMA: Duration = Duration::from_millis(500);
const BYTES_MINIMOS_DA_AMOSTRA: u64 = 256 * 1024;

/// Quanto tempo se espera para baixar `tamanho_bytes`, ANTES de começar.
/// Arredonda para CIMA.
pub fn segundos_estimados(tamanho_bytes: u64) -> u64 {
    tamanho_bytes.div_ceil(BANDA_REFERENCIA_BYTES_S)
}

/// Quanto ainda falta, a partir do que ESTA conexão já mostrou. `None` quando
/// não dá para saber — servidor que não anuncia o tamanho, ou amostra curta
/// demais para render número honesto. "Não sabemos" é um estado
/// (DECISIONS #86); um zero no lugar seria mentira.
pub fn segundos_restantes(
    baixados: u64,
    total: Option<u64>,
    decorridos: Duration,
) -> Option<u64> {
    let total = total?;
    let faltam = total.saturating_sub(baixados);
    if faltam == 0 {
        return Some(0);
    }
    if decorridos < AMOSTRA_MINIMA || baixados < BYTES_MINIMOS_DA_AMOSTRA {
        return None;
    }
    let por_segundo = baixados as f64 / decorridos.as_secs_f64();
    (por_segundo > 0.0).then(|| (faltam as f64 / por_segundo).ceil() as u64)
}

/// Mensagens (pt-BR, curtas) — TEXTO FIXO, sem interpolação: a primeira frase
/// diz o que é; o resto só existe se responder a uma pergunta que a pessoa
/// faria naquele momento.
pub const ERRO_SOMA_NAO_CONFERE: &str =
    "o arquivo baixado não confere com o esperado — foi descartado, e esta etapa fica desligada";
pub const ERRO_INDISPONIVEL: &str =
    "este acessório ainda não está disponível nesta versão do aplicativo";
pub const ERRO_DOWNLOAD_INTERROMPIDO: &str =
    "o download foi interrompido antes do fim — nada foi instalado";
pub const ERRO_ACESSORIO_DESCONHECIDO: &str = "não há este acessório para este computador";

// QA M4 — as falhas de ESCRITA também falam pt-BR.
//
// Seis pontos deste módulo subiam `io::Error` pelo `?` (`create_dir_all`,
// `File::create`, `write_all`, `sync_all`, `set_permissions`, `rename`), e o
// `From` do `error.rs` os transformava em "erro de arquivo: {e}" — a frase do
// sistema operacional, em inglês, direto na tela. Só as falhas de LEITURA DA
// REDE tinham frase própria; as de escrita, que são as PROVÁVEIS num parque
// de máquinas que ninguém pode olhar, não tinham. Cada frase abaixo termina
// dizendo o que fazer, porque não há a quem perguntar.

/// `ENOSPC` no Unix; `ERROR_HANDLE_DISK_FULL` e `ERROR_DISK_FULL` no Windows.
#[cfg(unix)]
const CODIGOS_DISCO_CHEIO: &[i32] = &[28];
#[cfg(windows)]
const CODIGOS_DISCO_CHEIO: &[i32] = &[39, 112];
#[cfg(not(any(unix, windows)))]
const CODIGOS_DISCO_CHEIO: &[i32] = &[];

pub const ERRO_DISCO_CHEIO: &str =
    "não há espaço em disco para este download — libere espaço e tente de novo";
pub const ERRO_SEM_PERMISSAO: &str =
    "o computador não deixou gravar na pasta do aplicativo — se houver antivírus ou pasta \
     sincronizada com a nuvem, pause e tente de novo";
pub const ERRO_ARQUIVO_EM_USO: &str =
    "o acessório está em uso por outro programa — feche o aplicativo, abra de novo e tente";
pub const ERRO_GRAVACAO: &str = "não foi possível gravar o download neste computador";

/// Em que passo do download a escrita falhou. A MESMA `io::Error` quer dizer
/// coisas diferentes conforme o passo, e mandar a pessoa procurar no lugar
/// errado é pior que não dizer nada.
#[derive(Debug, Clone, Copy)]
enum Passo {
    /// Criar a pasta de cache.
    Pasta,
    /// Escrever o `.parcial`.
    Gravacao,
    /// Trocar o `.parcial` de nome (e o bit de execução antes dele).
    Instalacao,
}

/// Traduz a falha de escrita para uma frase em pt-BR que diz o que fazer.
fn erro_de_escrita(passo: Passo, e: &std::io::Error) -> AppError {
    if e.raw_os_error()
        .is_some_and(|c| CODIGOS_DISCO_CHEIO.contains(&c))
    {
        return AppError(ERRO_DISCO_CHEIO.into());
    }
    if e.kind() == std::io::ErrorKind::PermissionDenied {
        // No Windows, `rename` por cima de um `fpcalc` que está RODANDO dá
        // "os error 5" (acesso negado) — que não é problema de permissão de
        // pasta nenhum. É o caso real de quem manda baixar de novo com uma
        // varredura em curso.
        return AppError(match passo {
            Passo::Instalacao => ERRO_ARQUIVO_EM_USO.into(),
            Passo::Pasta | Passo::Gravacao => ERRO_SEM_PERMISSAO.into(),
        });
    }
    AppError(ERRO_GRAVACAO.into())
}

/// Pedaço de leitura do download. 64 KiB dá progresso miúdo o bastante para a
/// barra andar visivelmente em 2 MB sem inundar o WebView de eventos.
const PEDACO: usize = 64 * 1024;

/// Um binário auxiliar publicado por nós.
#[derive(Debug, Clone)]
pub struct Acessorio {
    /// Nome curto e estável ("fpcalc") — a identidade que cruza para o
    /// frontend.
    pub nome: &'static str,
    /// Plataforma a que este arquivo serve ("linux-x86_64", "macos"...).
    pub plataforma: &'static str,
    /// Nome do arquivo no lançamento E no cache — nunca renomeamos nada.
    pub arquivo: &'static str,
    /// SHA-256 esperado, em hexadecimal minúsculo. Ver o bloco do catálogo.
    pub sha256: &'static str,
    /// Tamanho anunciado na tela ANTES de baixar ("quanto ocupa", PRD V9
    /// regra 1). Não é critério de aceitação: quem decide é a soma. É dele
    /// que sai o tempo estimado (PRD V10).
    pub tamanho_bytes: u64,
    /// Este acessório é um PROGRAMA que vamos executar?
    ///
    /// V10 — o catálogo presumia que todo acessório era binário e ligava o bit
    /// de execução em todos. O modelo de transcrição é DADO: 180 MB que nunca
    /// serão executados, e marcá-los como executáveis é convite para o
    /// antivírus sem ganho nenhum. O `estado` não muda: quem decide se o
    /// arquivo serve continua sendo a soma.
    pub executavel: bool,
}

impl Acessorio {
    /// Endereço no lançamento de acessórios.
    pub fn url(&self) -> String {
        format!("{URL_BASE}/{}", self.arquivo)
    }

    /// Onde ele fica depois de instalado.
    pub fn caminho(&self, cache: &Path) -> PathBuf {
        cache.join(self.arquivo)
    }

    /// Onde o download acontece: ao LADO do destino, na mesma pasta, para a
    /// troca de nome ser dentro do mesmo sistema de arquivos (e portanto
    /// atômica). Mesma disciplina da gravação de etiquetas (DECISIONS #56).
    fn parcial(&self, cache: &Path) -> PathBuf {
        cache.join(format!("{}.parcial", self.arquivo))
    }

    /// True quando a soma ainda não foi preenchida nesta build.
    fn soma_pendente(&self) -> bool {
        self.sha256 == SHA256_PENDENTE
    }
}

/// Situação de um acessório nesta máquina.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Estado {
    /// Não está no cache — é o estado normal de quem ainda não baixou.
    Ausente,
    /// Está no cache e a soma CONFERE. Só neste estado ele é executado.
    Pronto,
    /// Está no cache e a soma NÃO confere. Tratado como ausente em todo o
    /// resto do produto: o próximo download passa por cima.
    Corrompido,
    /// Esta build do aplicativo não tem a soma deste acessório, então não há
    /// como conferi-lo — e o que não pode ser conferido não é executado.
    Indisponivel,
}

impl Estado {
    /// O valor que cruza para o frontend. Vocabulário FECHADO, em snake_case
    /// sem acento, como o resto do contrato de IPC.
    pub fn como_texto(self) -> &'static str {
        match self {
            Estado::Ausente => "ausente",
            Estado::Pronto => "pronto",
            Estado::Corrompido => "corrompido",
            Estado::Indisponivel => "indisponivel",
        }
    }
}

/// Corpo de um download: o total anunciado pelo servidor (`Content-Length`,
/// quando existe) e o fluxo de bytes. `total: None` é "não sabemos" — um zero
/// no lugar seria lido pela barra como 0% de um arquivo vazio (DECISIONS #86).
pub struct Corpo {
    pub total: Option<u64>,
    pub bytes: Box<dyn Read>,
}

/// Pasta de cache dos acessórios, sob o perfil do usuário. `base` é o
/// diretório de dados do aplicativo (no binário real,
/// `app.path().app_data_dir()`); recebê-lo por parâmetro é o que deixa este
/// módulo testável sem Tauri.
pub fn diretorio_de_cache(base: &Path) -> PathBuf {
    base.join("acessorios")
}

/// Os rótulos de plataforma que servem esta máquina, **do mais específico
/// para o mais genérico**.
///
/// A ordem é o ponto (V10). Hoje o `fpcalc` e o `whisper-cli` do macOS são os
/// dois UNIVERSAIS e moram sob `"macos"`, e o modelo é dado e mora sob
/// `"qualquer"` — então a cadeia inteira poderia ser mais curta.
///
/// Ela fica assim de propósito: o degrau por processador (`"macos-arm64"`,
/// `"macos-x86_64"`) é o que permite publicar um acessório específico depois
/// sem tocar nesta função. O `whisper-cli` já foi por processador nesta mesma
/// versão, e voltou a ser universal só porque o runner Intel do CI se revelou
/// inatendível — se um dia houver motivo para separá-los de novo (aceleração
/// por hardware, por exemplo), basta a entrada no catálogo.
///
/// Procurar do específico para o genérico é o que deixa acessórios de
/// granularidade diferente conviverem no mesmo catálogo sem uma tabela por
/// acessório.
///
/// Lista vazia = não publicamos binário para esta máquina, e a tela diz isso
/// em vez de oferecer um download que não serviria (DECISIONS #101).
pub fn plataformas_desta_maquina() -> &'static [&'static str] {
    if cfg!(target_os = "windows") && cfg!(target_arch = "x86_64") {
        &["windows-x86_64", QUALQUER_PLATAFORMA]
    } else if cfg!(target_os = "linux") && cfg!(target_arch = "x86_64") {
        &["linux-x86_64", QUALQUER_PLATAFORMA]
    } else if cfg!(target_os = "macos") && cfg!(target_arch = "aarch64") {
        &["macos-arm64", "macos", QUALQUER_PLATAFORMA]
    } else if cfg!(target_os = "macos") && cfg!(target_arch = "x86_64") {
        &["macos-x86_64", "macos", QUALQUER_PLATAFORMA]
    } else {
        &[]
    }
}

/// O acessório `nome` desta máquina, ou `None` quando não publicamos arquivo
/// para esta plataforma (aí a etapa que depende dele simplesmente não existe
/// aqui, e a tela diz isso em vez de oferecer um download que não serve).
pub fn desta_maquina(nome: &str) -> Option<&'static Acessorio> {
    plataformas_desta_maquina().iter().find_map(|plataforma| {
        CATALOGO
            .iter()
            .find(|a| a.nome == nome && a.plataforma == *plataforma)
    })
}

/// Situação do acessório `nome` NESTA máquina, sem o chamador precisar
/// resolver a plataforma antes.
///
/// Sem arquivo publicado para esta plataforma o acessório é `Indisponivel`, e
/// não `Ausente`: "não existe para esta máquina" não é "ainda não baixaram" —
/// oferecer o download de algo que não serviria é o que a DECISIONS #101
/// proíbe, e é a mesma família do estado que a #97 criou.
pub fn estado_desta_maquina(nome: &str, cache: &Path) -> Estado {
    desta_maquina(nome).map_or(Estado::Indisponivel, |a| estado(a, cache))
}

/// Caminho do acessório `nome` quando ele está no cache **e** a soma confere.
///
/// Qualquer outra situação devolve `None`, e a etapa que depende dele
/// simplesmente não existe aqui. Isto é UMA regra — "conferido é o que se
/// executa" — e ela mora num lugar só: estava copiada no `commands::
/// fpcalc_pronto` e no `transcricao::acessorios_prontos`, que é como regras
/// divergem (DECISIONS #80).
pub fn caminho_pronto(nome: &str, cache: &Path) -> Option<PathBuf> {
    let a = desta_maquina(nome)?;
    (estado(a, cache) == Estado::Pronto).then(|| a.caminho(cache))
}

/// Todos os acessórios que existem para esta máquina, sem repetir nome e na
/// ordem do catálogo — o som, o transcritor e os modelos.
pub fn catalogo_desta_maquina() -> Vec<&'static Acessorio> {
    let mut vistos: Vec<&'static Acessorio> = Vec::new();
    for a in CATALOGO {
        if let Some(meu) = desta_maquina(a.nome) {
            if !vistos.iter().any(|v| v.nome == meu.nome) {
                vistos.push(meu);
            }
        }
    }
    vistos
}

/// SHA-256 de uma fatia de bytes, em hexadecimal minúsculo.
pub fn sha256_dos_bytes(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// SHA-256 de um arquivo, lido em pedaços (o modelo da etapa 5 tem 180 MB e
/// não cabe na memória de uma máquina modesta).
fn sha256_do_arquivo(caminho: &Path) -> Result<String> {
    let mut arquivo = std::fs::File::open(caminho)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; PEDACO];
    loop {
        let n = arquivo.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex(&hasher.finalize()))
}

/// Situação do acessório no cache. `Pronto` SÓ quando o arquivo existe **e** a
/// soma confere — arquivo que existe mas não confere é `Corrompido`, e o
/// produto o trata como ausente.
pub fn estado(acessorio: &Acessorio, cache: &Path) -> Estado {
    if acessorio.soma_pendente() {
        return Estado::Indisponivel;
    }
    let caminho = acessorio.caminho(cache);
    if !caminho.is_file() {
        return Estado::Ausente;
    }
    match sha256_do_arquivo(&caminho) {
        // arquivo ilegível é indistinguível de arquivo quebrado para quem
        // vai executá-lo: nos dois casos ele não pode ser usado
        Err(_) => Estado::Corrompido,
        Ok(soma) if soma == acessorio.sha256 => Estado::Pronto,
        Ok(_) => Estado::Corrompido,
    }
}

/// Apaga o parcial ao sair do escopo, aconteça o que acontecer — retorno
/// cedo, erro no meio ou pânico. É o que garante "cancelar não deixa lixo"
/// sem espalhar `remove_file` por seis caminhos de saída.
struct Parcial(PathBuf);

impl Drop for Parcial {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Baixa o acessório, CONFERE a soma e só então o instala no cache.
///
/// - `Ok(Some(caminho))`: instalado (ou já estava lá, íntegro — e aí nem se
///   abre conexão);
/// - `Ok(None)`: a pessoa cancelou. Cancelar não é falha e não vira erro
///   vermelho na tela — mesma convenção do funil;
/// - `Err`: soma diferente, download interrompido, acessório indisponível.
///   Em TODOS os casos o cache fica como estava, sem parcial esquecido.
///
/// `on_progress(baixados, total)` sai uma vez antes do primeiro byte (para o
/// total aparecer na tela) e a cada pedaço; `cancelled()` é consultado a cada
/// pedaço — não só entre arquivos, porque um arquivo é o download inteiro.
pub fn baixar<F, P, C>(
    acessorio: &Acessorio,
    cache: &Path,
    fetch: F,
    on_progress: P,
    cancelled: C,
) -> Result<Option<PathBuf>>
where
    F: Fn(&str) -> Result<Corpo>,
    P: Fn(u64, Option<u64>),
    C: Fn() -> bool,
{
    match estado(acessorio, cache) {
        // o que não pode ser conferido não é baixado: dizer isto ANTES do
        // download é o que evita acusar de corrompido um arquivo íntegro
        Estado::Indisponivel => return Err(AppError(ERRO_INDISPONIVEL.into())),
        // baixou uma vez, as próximas começam direto (PRD V9, regra 3)
        Estado::Pronto => return Ok(Some(acessorio.caminho(cache))),
        Estado::Ausente | Estado::Corrompido => {}
    }

    std::fs::create_dir_all(cache).map_err(|e| erro_de_escrita(Passo::Pasta, &e))?;
    let corpo = fetch(&acessorio.url())?;
    let total = corpo.total;
    let mut origem = corpo.bytes;

    // a partir daqui existe um parcial no disco, e ele some sozinho em
    // qualquer caminho de saída que não seja o sucesso (ver `Parcial`)
    let parcial = Parcial(acessorio.parcial(cache));
    let mut destino =
        std::fs::File::create(&parcial.0).map_err(|e| erro_de_escrita(Passo::Gravacao, &e))?;
    let mut buf = vec![0u8; PEDACO];
    let mut baixados: u64 = 0;
    on_progress(0, total);

    loop {
        if cancelled() {
            return Ok(None); // o parcial some no Drop
        }
        let lidos = origem
            .read(&mut buf)
            .map_err(|_| AppError(ERRO_DOWNLOAD_INTERROMPIDO.into()))?;
        if lidos == 0 {
            break;
        }
        destino
            .write_all(&buf[..lidos])
            .map_err(|e| erro_de_escrita(Passo::Gravacao, &e))?;
        baixados += lidos as u64;
        on_progress(baixados, total);
    }
    // `sync_all`, e não `flush` (QA B2): o `flush` de um `File` do Rust é
    // no-op — não existe buffer de usuário para esvaziar —, então o que havia
    // aqui não era barreira nenhuma. Sem forçar os dados ao disco antes da
    // troca de nome, um desligamento na hora errada deixaria no cache um
    // arquivo com o nome CERTO e conteúdo indefinido — e é justamente o
    // arquivo que o produto executa depois.
    destino
        .sync_all()
        .map_err(|e| erro_de_escrita(Passo::Gravacao, &e))?;
    drop(destino);

    // QA M3 — A SOMA CONFERE O ARQUIVO DO DISCO, não os bytes que passaram
    // pela rede.
    //
    // Até a v0.9.0 o SHA-256 era acumulado sobre o que se LIA da conexão e
    // comparado antes do `rename`: isso confere o FLUXO, e o que vai ser
    // executado é o ARQUIVO. Um `.parcial` esvaziado depois da última escrita
    // — antivírus em quarentena, sincronizador de nuvem, disco que não gravou
    // — saía "instalado" com 0 byte, e o módulo cuja razão de existir é
    // "nada entra no cache sem conferir" devolvia `Ok`. Reler custa alguns MB
    // de leitura de disco (180 MB na etapa 5), que é o preço de a garantia
    // ser verdadeira.
    let soma = sha256_do_arquivo(&parcial.0).map_err(|_| AppError(ERRO_GRAVACAO.into()))?;
    if soma != acessorio.sha256 {
        return Err(AppError(ERRO_SOMA_NAO_CONFERE.into()));
    }

    // O bit de execução vai ANTES da troca de nome: assim o arquivo que
    // aparece no cache já nasce executável, sem uma janela em que ele existe
    // e não roda.
    //
    // V10 — e SÓ para quem é programa. O modelo de transcrição são 180 MB de
    // dado que ninguém executa; marcá-los como executáveis é convite para o
    // antivírus, e não compra nada.
    #[cfg(unix)]
    if acessorio.executavel {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&parcial.0, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| erro_de_escrita(Passo::Instalacao, &e))?;
    }

    let caminho = acessorio.caminho(cache);
    std::fs::rename(&parcial.0, &caminho).map_err(|e| erro_de_escrita(Passo::Instalacao, &e))?;
    std::mem::forget(parcial); // deu certo: não há mais parcial para apagar
    Ok(Some(caminho))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::io::Cursor;

    /// Bytes que fazem as vezes de "o binário baixado" — nenhum teste depende
    /// dos arquivos reais nem das somas reais (que ainda não existem): o que
    /// se testa é o MECANISMO de conferência, com arquivos gerados aqui.
    const CONTEUDO: &[u8] = b"binario de mentira do fpcalc\n";

    /// Um acessório de teste com a soma do `CONTEUDO` (ou a que se pedir).
    fn acessorio_de_teste(sha256: &str) -> Acessorio {
        Acessorio {
            nome: "fpcalc",
            plataforma: "teste",
            arquivo: "fpcalc-teste",
            sha256: String::leak(sha256.to_string()),
            tamanho_bytes: CONTEUDO.len() as u64,
            executavel: true,
        }
    }

    /// Fetcher de teste: conta as chamadas e devolve os bytes pedidos.
    fn fetcher<'a>(
        bytes: &'static [u8],
        chamadas: &'a Cell<usize>,
    ) -> impl Fn(&str) -> Result<Corpo> + 'a {
        move |_url| {
            chamadas.set(chamadas.get() + 1);
            Ok(Corpo {
                total: Some(bytes.len() as u64),
                bytes: Box::new(Cursor::new(bytes)),
            })
        }
    }

    fn sem_progresso(_baixados: u64, _total: Option<u64>) {}
    fn sem_cancelamento() -> bool {
        false
    }

    /// Nada além do arquivo instalado pode sobrar na pasta de cache: um
    /// `.parcial` esquecido ocupa disco para sempre e, pior, dá a impressão
    /// de que algo foi baixado.
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

    // -----------------------------------------------------------------------
    // O catálogo
    // -----------------------------------------------------------------------

    /// Todo endereço do catálogo aponta para o NOSSO lançamento de acessórios.
    /// Um endereço fora dele é recusado pelo fetcher real, então uma entrada
    /// errada aqui vira acessório que nunca baixa — melhor descobrir na suíte.
    #[test]
    fn todo_endereco_do_catalogo_e_do_lancamento_de_acessorios() {
        assert!(!CATALOGO.is_empty());
        for a in CATALOGO {
            assert!(
                a.url().starts_with(URL_BASE),
                "{} sai do lançamento de acessórios: {}",
                a.arquivo,
                a.url()
            );
            assert!(a.url().ends_with(a.arquivo));
        }
    }

    /// Os nomes de arquivo são os que os fluxos `acessorios.yml` (etapa 2) e
    /// `acessorio-transcritor.yml` (etapa 5) publicam. Divergência aqui é 404
    /// na cara de quem clicou.
    #[test]
    fn os_nomes_de_arquivo_sao_os_que_o_workflow_publica() {
        let arquivos: Vec<&str> = CATALOGO.iter().map(|a| a.arquivo).collect();
        assert!(arquivos.contains(&"fpcalc-windows-x86_64.exe"));
        assert!(arquivos.contains(&"fpcalc-linux-x86_64"));
        // o Chromaprint v1.5.1 publica binário UNIVERSAL para macOS: um
        // arquivo só, nativo nos dois processadores, sem Rosetta
        assert!(arquivos.contains(&"fpcalc-macos-universal"));
        // V10 — o whisper.cpp é construído por nós, e sai UNIVERSAL: o runner
        // Intel do CI é inatendível, então o binário cobre os dois
        // processadores num arquivo só
        assert!(arquivos.contains(&"whisper-cli-macos-universal"));
        assert!(
            !arquivos.contains(&"whisper-cli-macos-x86_64"),
            "o arquivo por processador não existe mais — o app procuraria \
             um nome que o fluxo nunca publica"
        );
        assert!(arquivos.contains(&"whisper-cli-linux-x86_64"));
        assert!(arquivos.contains(&"whisper-cli-windows-x86_64.exe"));
        assert!(arquivos.contains(&"ggml-small-q5_1.bin"));
        // V10.2 — o `medium` foi publicado no MESMO lançamento pelo fluxo
        // `acessorio-modelo.yml`, que recusa republicar por cima de um nome já
        // existente (acrescentar arquivo não muda a soma dos que já estão lá).
        assert!(arquivos.contains(&"ggml-medium.bin"));
    }

    /// Guarda de regressão: o que JÁ FOI PUBLICADO não pode voltar a ter soma
    /// pendente nem tamanho zero. Uma soma zerada por um merge desligaria a
    /// etapa 2 de todo mundo, e um tamanho zerado faria a tela prometer um
    /// download de 0 byte antes de baixar 5 MB.
    ///
    /// Desde a V10 o catálogo INTEIRO está publicado — `fpcalc`, os três
    /// `whisper-cli` e o modelo —, então a guarda vale para todas as
    /// entradas, sem filtro. O filtro por `FPCALC` existia enquanto a etapa 5
    /// esperava o fluxo `acessorio-transcritor.yml`; mantê-lo agora deixaria
    /// justamente as entradas novas fora da rede que as protege.
    ///
    /// `SHA256_PENDENTE` continua existindo para o PRÓXIMO acessório: uma
    /// entrada pendente é tratada como `Indisponivel`, que é exatamente o que
    /// ela é (DECISIONS #97). **Nenhum teste desta suíte depende dos valores
    /// reais.**
    #[test]
    fn o_que_ja_foi_publicado_nao_tem_nada_pendente() {
        for a in CATALOGO.iter() {
            assert_ne!(a.sha256, SHA256_PENDENTE, "{}: soma pendente", a.arquivo);
            assert!(a.tamanho_bytes > 0, "{}: tamanho pendente", a.arquivo);
        }
    }

    /// Toda entrada, publicada ou não, anuncia um tamanho — é ele que a tela
    /// mostra ANTES de baixar, e é dele que sai o tempo estimado. Zero faria a
    /// tela prometer um download instantâneo de 180 MB.
    #[test]
    fn toda_entrada_do_catalogo_anuncia_um_tamanho() {
        for a in CATALOGO {
            assert!(a.tamanho_bytes > 0, "{}: sem tamanho", a.arquivo);
        }
    }

    /// V10.2 — **os DOIS modelos, com as somas e os tamanhos que o dono do
    /// produto conferiu baixando os arquivos publicados e recalculando.**
    ///
    /// O `medium` entra porque a qualidade do `small` quantizado REPROVOU na
    /// medição do acervo real: 37% de encontrabilidade contra os 78% do motor
    /// antigo, e com um modo de falha que não é grafia — o modelo classifica
    /// trecho cantado como música e devolve `[música]` no lugar da estrofe.
    ///
    /// **Isto é temporário e declarado**: assim que a remedição decidir, um dos
    /// dois SAI do catálogo. Ver o comentário do `CATALOGO`.
    #[test]
    fn o_catalogo_tem_os_dois_modelos_com_as_somas_publicadas() {
        let por_arquivo = |arquivo: &str| {
            CATALOGO
                .iter()
                .find(|a| a.arquivo == arquivo)
                .unwrap_or_else(|| panic!("{arquivo} não está no catálogo"))
        };
        let pequeno = por_arquivo("ggml-small-q5_1.bin");
        assert_eq!(
            pequeno.sha256, "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
            "o modelo pequeno continua INALTERADO"
        );
        assert_eq!(pequeno.tamanho_bytes, 190_085_487);

        let grande = por_arquivo("ggml-medium.bin");
        assert_eq!(
            grande.sha256, "6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208"
        );
        assert_eq!(grande.tamanho_bytes, 1_533_763_059);
        assert!(!grande.executavel, "modelo é DADO, não programa");
        assert_eq!(
            grande.plataforma, QUALQUER_PLATAFORMA,
            "dado não tem processador"
        );
        assert!(
            grande.tamanho_bytes > pequeno.tamanho_bytes,
            "o `medium` é o grande dos dois"
        );
    }

    /// V10 — o modelo é DADO, não executável, e não recebe (nem deve receber)
    /// o bit de execução. O catálogo presumia que todo acessório era binário.
    #[test]
    fn o_modelo_e_dado_e_o_transcritor_e_executavel() {
        let modelos: Vec<&Acessorio> = CATALOGO
            .iter()
            .filter(|a| [MODELO_WHISPER, MODELO_WHISPER_GRANDE].contains(&a.nome))
            .collect();
        assert_eq!(modelos.len(), 2, "os dois modelos estão no catálogo");
        for modelo in &modelos {
            assert!(!modelo.executavel, "{}: o modelo não é programa", modelo.arquivo);
            assert_eq!(
                modelo.plataforma, QUALQUER_PLATAFORMA,
                "dado não tem processador: um arquivo serve as quatro máquinas"
            );
        }
        for a in CATALOGO
            .iter()
            .filter(|a| ![MODELO_WHISPER, MODELO_WHISPER_GRANDE].contains(&a.nome))
        {
            assert!(a.executavel, "{}: é programa", a.arquivo);
        }
    }

    /// No Unix, arquivo de DADO instalado não ganha o bit de execução: um
    /// arquivo de 180 MB marcado como executável é convite para o antivírus e
    /// não serve para nada — ninguém o executa.
    #[cfg(unix)]
    #[test]
    fn no_unix_o_dado_instalado_nao_e_executavel() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let a = Acessorio {
            executavel: false,
            ..acessorio_de_teste(&sha256_dos_bytes(CONTEUDO))
        };
        let chamadas = Cell::new(0);
        let caminho = baixar(
            &a,
            dir.path(),
            fetcher(CONTEUDO, &chamadas),
            sem_progresso,
            sem_cancelamento,
        )
        .unwrap()
        .unwrap();
        let modo = std::fs::metadata(&caminho).unwrap().permissions().mode();
        assert_eq!(modo & 0o111, 0, "dado não recebe bit de execução");
        // e continua PRONTO: o que decide é a soma, não a permissão
        assert_eq!(estado(&a, dir.path()), Estado::Pronto);
    }

    /// A máquina escolhe o arquivo mais específico que existir, e o genérico
    /// só entra depois. Sem a ordem, o `fpcalc` universal ("macos") poderia
    /// ser escolhido no lugar do `whisper-cli` do processador certo — ou o
    /// contrário.
    #[test]
    fn a_plataforma_especifica_vem_antes_da_generica() {
        let plataformas = plataformas_desta_maquina();
        if plataformas.is_empty() {
            return; // plataforma sem binário publicado: nada a ordenar
        }
        assert_eq!(
            plataformas.last(),
            Some(&QUALQUER_PLATAFORMA),
            "o genérico é o ÚLTIMO recurso"
        );
        assert!(
            !plataformas[..plataformas.len() - 1].contains(&QUALQUER_PLATAFORMA),
            "o genérico aparece uma vez só"
        );
    }

    /// Nesta máquina existem os quatro acessórios: o do som, o transcritor e os
    /// DOIS modelos. Um catálogo que esquecesse a plataforma faria a etapa
    /// sumir da tela sem ninguém perceber (DECISIONS #101).
    ///
    /// **É esta lista que a tela mostra**, e é por isso que a preferência entre
    /// os modelos não precisa de caixinha de seleção: os dois aparecem porque a
    /// tela lista o catálogo, e quem escolhe qual roda é o programa.
    #[test]
    fn esta_maquina_tem_o_som_o_transcritor_e_os_dois_modelos() {
        for nome in [FPCALC, WHISPER_CLI, MODELO_WHISPER, MODELO_WHISPER_GRANDE] {
            assert!(
                desta_maquina(nome).is_some(),
                "{nome} não tem arquivo para esta máquina"
            );
        }
        let nomes: Vec<&str> = catalogo_desta_maquina().iter().map(|a| a.nome).collect();
        assert_eq!(nomes.len(), 4, "quatro acessórios, sem repetição: {nomes:?}");
    }

    // -----------------------------------------------------------------------
    // O tempo do download — a regra que MUDA para 180 MB (PRD V10)
    // -----------------------------------------------------------------------

    /// "A dispensa do tempo valia para 5 MB, não vale para 180 MB." O tempo
    /// sai de um número de referência declarado, e a conta é ARREDONDADA PARA
    /// CIMA: prometer menos do que leva é o defeito da DECISIONS #85.
    #[test]
    fn o_tempo_estimado_sai_do_tamanho_e_arredonda_para_cima() {
        assert_eq!(segundos_estimados(0), 0);
        assert_eq!(segundos_estimados(BANDA_REFERENCIA_BYTES_S), 1);
        assert_eq!(segundos_estimados(BANDA_REFERENCIA_BYTES_S + 1), 2);
        // 180 MB não podem sair como "menos de um minuto"
        let modelo = desta_maquina(MODELO_WHISPER).expect("o modelo existe aqui");
        assert!(modelo.tamanho_bytes > 100_000_000, "o modelo é grande");
        assert!(
            segundos_estimados(modelo.tamanho_bytes) >= 60,
            "180 MB precisam de tempo na tela"
        );
    }

    /// O tempo que RESTA vem de medição, não da referência: a referência
    /// serve para a tela dizer algo antes do primeiro byte; depois disso,
    /// quem manda é a velocidade real desta conexão.
    #[test]
    fn o_tempo_restante_vem_da_velocidade_medida() {
        use std::time::Duration;
        // 1 MB em 2 s = 500 KB/s; faltam 4 MB → 8 s
        assert_eq!(
            segundos_restantes(1_000_000, Some(5_000_000), Duration::from_secs(2)),
            Some(8)
        );
        // sem total anunciado não há restante a calcular (DECISIONS #86)
        assert_eq!(
            segundos_restantes(1_000_000, None, Duration::from_secs(2)),
            None
        );
        // amostra curta demais não vira estimativa: no primeiro pedaço a
        // velocidade aparente é absurda, e um "faltam 0 segundos" que dura um
        // minuto é pior que nenhum número
        assert_eq!(
            segundos_restantes(64_000, Some(180_000_000), Duration::from_millis(50)),
            None
        );
        // e o fim do download não promete tempo nenhum
        assert_eq!(
            segundos_restantes(5_000_000, Some(5_000_000), Duration::from_secs(10)),
            Some(0)
        );
    }

    /// Soma tem 64 dígitos hexadecimais minúsculos — ou é a pendente. Um
    /// caractere a menos, colado errado do resumo do workflow, desligaria o
    /// acessório de todo mundo sem ninguém perceber.
    #[test]
    fn toda_soma_do_catalogo_e_hexadecimal_de_64_digitos() {
        for a in CATALOGO {
            assert_eq!(a.sha256.len(), 64, "{}: soma com tamanho errado", a.arquivo);
            assert!(
                a.sha256
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
                "{}: soma precisa ser hexadecimal minúsculo",
                a.arquivo
            );
        }
    }

    /// Há no máximo UM acessório por plataforma+nome: duas entradas iguais
    /// fariam a segunda nunca ser escolhida, em silêncio.
    #[test]
    fn o_catalogo_nao_tem_entrada_repetida() {
        let mut chaves: Vec<(&str, &str)> =
            CATALOGO.iter().map(|a| (a.nome, a.plataforma)).collect();
        chaves.sort_unstable();
        let total = chaves.len();
        chaves.dedup();
        assert_eq!(chaves.len(), total, "entrada repetida no catálogo");
    }

    // -----------------------------------------------------------------------
    // Estado
    // -----------------------------------------------------------------------

    #[test]
    fn sem_arquivo_no_cache_o_acessorio_esta_ausente() {
        let dir = tempfile::tempdir().unwrap();
        let a = acessorio_de_teste(&sha256_dos_bytes(CONTEUDO));
        assert_eq!(estado(&a, dir.path()), Estado::Ausente);
    }

    #[test]
    fn arquivo_com_a_soma_certa_esta_pronto() {
        let dir = tempfile::tempdir().unwrap();
        let a = acessorio_de_teste(&sha256_dos_bytes(CONTEUDO));
        std::fs::write(a.caminho(dir.path()), CONTEUDO).unwrap();
        assert_eq!(estado(&a, dir.path()), Estado::Pronto);
    }

    /// Arquivo em cache que NÃO confere não é "pronto com defeito": é
    /// `Corrompido`, e o produto o trata como ausente (baixa por cima).
    #[test]
    fn arquivo_com_a_soma_errada_esta_corrompido() {
        let dir = tempfile::tempdir().unwrap();
        let a = acessorio_de_teste(&sha256_dos_bytes(CONTEUDO));
        std::fs::write(a.caminho(dir.path()), b"outra coisa qualquer").unwrap();
        assert_eq!(estado(&a, dir.path()), Estado::Corrompido);
    }

    /// Soma ainda não preenchida = acessório INDISPONÍVEL nesta build, e isso
    /// é dito ANTES de gastar o download de alguém. Sem este estado, o
    /// aplicativo baixaria 2 MB para então acusar o arquivo de não conferir —
    /// uma acusação falsa, num produto onde a mensagem é a explicação inteira.
    #[test]
    fn soma_pendente_deixa_o_acessorio_indisponivel() {
        let dir = tempfile::tempdir().unwrap();
        let a = acessorio_de_teste(SHA256_PENDENTE);
        // mesmo com um arquivo no lugar certo: não há com o que conferir
        std::fs::write(a.caminho(dir.path()), CONTEUDO).unwrap();
        assert_eq!(estado(&a, dir.path()), Estado::Indisponivel);

        let chamadas = Cell::new(0);
        let erro = baixar(
            &a,
            dir.path(),
            fetcher(CONTEUDO, &chamadas),
            sem_progresso,
            sem_cancelamento,
        )
        .expect_err("acessório sem soma não baixa");
        assert_eq!(erro.to_string(), ERRO_INDISPONIVEL);
        assert_eq!(chamadas.get(), 0, "nem chega a abrir conexão");
    }

    // -----------------------------------------------------------------------
    // Download
    // -----------------------------------------------------------------------

    #[test]
    fn soma_certa_instala_o_arquivo_no_cache() {
        let dir = tempfile::tempdir().unwrap();
        let a = acessorio_de_teste(&sha256_dos_bytes(CONTEUDO));
        let chamadas = Cell::new(0);

        let caminho = baixar(
            &a,
            dir.path(),
            fetcher(CONTEUDO, &chamadas),
            sem_progresso,
            sem_cancelamento,
        )
        .unwrap()
        .expect("download concluído devolve o caminho");

        assert_eq!(caminho, a.caminho(dir.path()));
        assert_eq!(std::fs::read(&caminho).unwrap(), CONTEUDO);
        assert_eq!(estado(&a, dir.path()), Estado::Pronto);
        assert_eq!(chamadas.get(), 1);
        assert_eq!(sobrou_na_pasta(dir.path()), vec!["fpcalc-teste".to_string()]);
    }

    /// No Unix, binário sem bit de execução é binário que não roda — e o
    /// erro que sairia ("permission denied") não explica nada a quem só
    /// clicou em "baixar".
    #[cfg(unix)]
    #[test]
    fn no_unix_o_arquivo_instalado_e_executavel() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let a = acessorio_de_teste(&sha256_dos_bytes(CONTEUDO));
        let chamadas = Cell::new(0);
        let caminho = baixar(
            &a,
            dir.path(),
            fetcher(CONTEUDO, &chamadas),
            sem_progresso,
            sem_cancelamento,
        )
        .unwrap()
        .unwrap();
        let modo = std::fs::metadata(&caminho).unwrap().permissions().mode();
        assert_eq!(modo & 0o111, 0o111, "bit de execução ligado para todos");
    }

    /// A trava que justifica o módulo inteiro: soma diferente = arquivo
    /// descartado, NADA instalado, nada de lixo no cache, e uma frase em
    /// pt-BR que diz o que aconteceu.
    #[test]
    fn soma_errada_nao_instala_e_nao_deixa_lixo() {
        let dir = tempfile::tempdir().unwrap();
        let a = acessorio_de_teste(&sha256_dos_bytes(b"o que a gente esperava"));
        let chamadas = Cell::new(0);

        let erro = baixar(
            &a,
            dir.path(),
            fetcher(CONTEUDO, &chamadas),
            sem_progresso,
            sem_cancelamento,
        )
        .expect_err("soma diferente é falha");

        assert_eq!(erro.to_string(), ERRO_SOMA_NAO_CONFERE);
        assert!(!a.caminho(dir.path()).exists(), "nada foi instalado");
        assert_eq!(sobrou_na_pasta(dir.path()), Vec::<String>::new());
        assert_eq!(estado(&a, dir.path()), Estado::Ausente);
    }

    /// Cancelar no MEIO do download (não entre arquivos): o parcial some e o
    /// cache fica como estava.
    #[test]
    fn cancelamento_no_meio_do_download_nao_deixa_lixo() {
        let dir = tempfile::tempdir().unwrap();
        // grande o bastante para haver mais de um pedaço
        let grande: &'static [u8] = Box::leak(vec![7u8; PEDACO * 3].into_boxed_slice());
        let a = Acessorio {
            tamanho_bytes: grande.len() as u64,
            ..acessorio_de_teste(&sha256_dos_bytes(grande))
        };
        let chamadas = Cell::new(0);
        let lidos = Cell::new(0u64);

        let resultado = baixar(
            &a,
            dir.path(),
            fetcher(grande, &chamadas),
            |baixados, _| lidos.set(baixados),
            || lidos.get() > 0, // cancela assim que o primeiro pedaço chega
        )
        .unwrap();

        assert!(resultado.is_none(), "cancelar não é erro — é `None`");
        assert!(lidos.get() > 0, "o cancelamento foi no MEIO do download");
        assert!(lidos.get() < grande.len() as u64, "e antes do fim");
        assert_eq!(sobrou_na_pasta(dir.path()), Vec::<String>::new());
        assert_eq!(estado(&a, dir.path()), Estado::Ausente);
    }

    /// Baixou uma vez, as próximas começam direto (PRD V9, regra 3 do
    /// download): arquivo íntegro no cache não gasta rede nenhuma.
    #[test]
    fn arquivo_integro_no_cache_nao_baixa_de_novo() {
        let dir = tempfile::tempdir().unwrap();
        let a = acessorio_de_teste(&sha256_dos_bytes(CONTEUDO));
        std::fs::write(a.caminho(dir.path()), CONTEUDO).unwrap();
        let chamadas = Cell::new(0);

        let caminho = baixar(
            &a,
            dir.path(),
            fetcher(CONTEUDO, &chamadas),
            sem_progresso,
            sem_cancelamento,
        )
        .unwrap()
        .unwrap();

        assert_eq!(caminho, a.caminho(dir.path()));
        assert_eq!(chamadas.get(), 0, "zero chamadas de rede");
    }

    /// Arquivo corrompido no cache (download antigo interrompido por um
    /// desligamento, disco com defeito) é tratado como AUSENTE: baixa de novo
    /// por cima, em vez de virar pendência eterna que ninguém sabe limpar.
    #[test]
    fn arquivo_corrompido_no_cache_e_baixado_de_novo_por_cima() {
        let dir = tempfile::tempdir().unwrap();
        let a = acessorio_de_teste(&sha256_dos_bytes(CONTEUDO));
        std::fs::write(a.caminho(dir.path()), b"metade de um download").unwrap();
        assert_eq!(estado(&a, dir.path()), Estado::Corrompido);
        let chamadas = Cell::new(0);

        baixar(
            &a,
            dir.path(),
            fetcher(CONTEUDO, &chamadas),
            sem_progresso,
            sem_cancelamento,
        )
        .unwrap()
        .unwrap();

        assert_eq!(chamadas.get(), 1, "corrompido REBAIXA");
        assert_eq!(estado(&a, dir.path()), Estado::Pronto);
        assert_eq!(sobrou_na_pasta(dir.path()), vec!["fpcalc-teste".to_string()]);
    }

    /// Progresso em BYTES, crescente, terminando no total — é o que a barra
    /// da tela mostra enquanto os 2 MB chegam.
    #[test]
    fn o_progresso_conta_os_bytes_baixados() {
        let dir = tempfile::tempdir().unwrap();
        let grande: &'static [u8] = Box::leak(vec![3u8; PEDACO * 2 + 11].into_boxed_slice());
        let a = Acessorio {
            tamanho_bytes: grande.len() as u64,
            ..acessorio_de_teste(&sha256_dos_bytes(grande))
        };
        let chamadas = Cell::new(0);
        let eventos = std::cell::RefCell::new(Vec::new());

        baixar(
            &a,
            dir.path(),
            fetcher(grande, &chamadas),
            |baixados, total| eventos.borrow_mut().push((baixados, total)),
            sem_cancelamento,
        )
        .unwrap()
        .unwrap();

        let eventos = eventos.borrow();
        assert_eq!(
            eventos.first(),
            Some(&(0, Some(grande.len() as u64))),
            "um evento inicial põe o total na tela antes do primeiro byte"
        );
        assert_eq!(
            eventos.last(),
            Some(&(grande.len() as u64, Some(grande.len() as u64)))
        );
        assert!(
            eventos.windows(2).all(|p| p[0].0 <= p[1].0),
            "o progresso nunca anda para trás"
        );
        assert!(eventos.len() > 2, "há progresso DURANTE o download");
    }

    /// Servidor que não anuncia o tamanho: `total` é `None` — "não sabemos" é
    /// um estado (DECISIONS #86), não um zero que a barra leria como 0%.
    #[test]
    fn sem_content_length_o_total_e_desconhecido() {
        let dir = tempfile::tempdir().unwrap();
        let a = acessorio_de_teste(&sha256_dos_bytes(CONTEUDO));
        let eventos = std::cell::RefCell::new(Vec::new());

        baixar(
            &a,
            dir.path(),
            |_url| {
                Ok(Corpo {
                    total: None,
                    bytes: Box::new(Cursor::new(CONTEUDO)),
                })
            },
            |baixados, total| eventos.borrow_mut().push((baixados, total)),
            sem_cancelamento,
        )
        .unwrap()
        .unwrap();

        assert!(eventos.borrow().iter().all(|(_, total)| total.is_none()));
    }

    /// Falha de rede no meio do download não deixa binário pela metade em uso
    /// (PRD V9, regra 5): o arquivo só entra no cache depois de conferido.
    #[test]
    fn queda_de_rede_no_meio_nao_deixa_binario_pela_metade() {
        struct Cai(usize);
        impl std::io::Read for Cai {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                if self.0 == 0 {
                    return Err(std::io::Error::other("conexão perdida"));
                }
                self.0 -= 1;
                let n = buf.len().min(128);
                buf[..n].fill(1);
                Ok(n)
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let a = acessorio_de_teste(&sha256_dos_bytes(CONTEUDO));

        let erro = baixar(
            &a,
            dir.path(),
            |_url| {
                Ok(Corpo {
                    total: Some(4096),
                    bytes: Box::new(Cai(2)),
                })
            },
            sem_progresso,
            sem_cancelamento,
        )
        .expect_err("conexão perdida é falha");

        assert_eq!(erro.to_string(), ERRO_DOWNLOAD_INTERROMPIDO);
        assert!(!a.caminho(dir.path()).exists());
        assert_eq!(sobrou_na_pasta(dir.path()), Vec::<String>::new());
    }

    // -----------------------------------------------------------------------
    // QA M3 — o que se confere tem de ser o que se INSTALA
    // -----------------------------------------------------------------------

    /// Um leitor que entrega os bytes certos e ESVAZIA o `.parcial` no fim.
    ///
    /// É o modelo do que separa "os bytes que vieram da rede" de "os bytes que
    /// ficaram no disco": antivírus que põe o arquivo em quarentena logo
    /// depois de escrito, sincronizador de nuvem que o troca, disco que
    /// silenciosamente não gravou. Nenhum deles é hipotético num parque de
    /// ~40 máquinas Windows que ninguém pode olhar.
    struct EsvaziaNoFim {
        restante: Vec<u8>,
        parcial: PathBuf,
    }

    impl std::io::Read for EsvaziaNoFim {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.restante.is_empty() {
                // fim do corpo: os bytes já foram todos escritos, e é AQUI
                // que o arquivo do disco deixa de ser o que se baixou
                let _ = std::fs::File::create(&self.parcial);
                return Ok(0);
            }
            let n = buf.len().min(self.restante.len());
            buf[..n].copy_from_slice(&self.restante[..n]);
            self.restante.drain(..n);
            Ok(n)
        }
    }

    /// A soma era calculada sobre os bytes LIDOS DA REDE e comparada antes do
    /// `rename` — nada relia o arquivo do disco. Isso confere o FLUXO, não o
    /// arquivo que vai ser executado, e um `.parcial` esvaziado depois da
    /// última escrita saía "instalado" com 0 byte.
    ///
    /// Hoje o `fpcalc_pronto` reconfere lendo o disco antes de cada varredura,
    /// então nada não-conferido chega a rodar. Mas a garantia está escrita
    /// como se fosse deste módulo, e um dia alguém vai confiar nela.
    #[test]
    fn a_soma_confere_o_arquivo_do_disco_e_nao_os_bytes_da_rede() {
        let dir = tempfile::tempdir().unwrap();
        let a = acessorio_de_teste(&sha256_dos_bytes(CONTEUDO));
        let parcial = a.parcial(dir.path());
        // O que faz este teste valer: os bytes que passam pela REDE são
        // exatamente os esperados, então a conferência antiga — a que somava
        // o que era lido da conexão — aprovava. É a diferença entre conferir
        // o fluxo e conferir o arquivo.
        assert_eq!(sha256_dos_bytes(CONTEUDO), a.sha256);

        let erro = baixar(
            &a,
            dir.path(),
            |_url| {
                Ok(Corpo {
                    total: Some(CONTEUDO.len() as u64),
                    bytes: Box::new(EsvaziaNoFim {
                        restante: CONTEUDO.to_vec(),
                        parcial: parcial.clone(),
                    }),
                })
            },
            sem_progresso,
            sem_cancelamento,
        )
        .expect_err("arquivo esvaziado no disco não confere");

        assert_eq!(erro.to_string(), ERRO_SOMA_NAO_CONFERE);
        assert!(!a.caminho(dir.path()).exists(), "nada foi instalado");
        assert_eq!(sobrou_na_pasta(dir.path()), Vec::<String>::new());
        assert_eq!(estado(&a, dir.path()), Estado::Ausente);
    }

    // -----------------------------------------------------------------------
    // QA M4 — erro de escrita fala pt-BR e diz o que fazer
    // -----------------------------------------------------------------------

    /// Seis pontos do download subiam `io::Error` pelo `?`, e o `From` do
    /// `error.rs` os transformava em "erro de arquivo: {e}" — a frase do
    /// sistema operacional, em inglês, direto na tela de quem não tem a quem
    /// perguntar. Só as falhas de LEITURA DA REDE tinham frase própria; as de
    /// ESCRITA, que são as prováveis, não.
    #[test]
    fn falha_de_escrita_vira_frase_em_pt_br_que_diz_o_que_fazer() {
        use std::io::{Error, ErrorKind};
        let cheio = Error::from_raw_os_error(CODIGOS_DISCO_CHEIO[0]);
        let sem_permissao = Error::from(ErrorKind::PermissionDenied);
        let outro = Error::other("qualquer coisa");

        // disco cheio é disco cheio em qualquer passo
        for passo in [Passo::Pasta, Passo::Gravacao, Passo::Instalacao] {
            assert_eq!(
                erro_de_escrita(passo, &cheio).to_string(),
                ERRO_DISCO_CHEIO
            );
        }
        // "sem permissão" quer dizer coisas diferentes conforme o passo: na
        // INSTALAÇÃO (o rename) o caso real é o Windows recusando trocar um
        // `fpcalc` que está rodando — os error 5 —, e mandar a pessoa olhar
        // permissão de pasta ali seria mandá-la procurar no lugar errado
        assert_eq!(
            erro_de_escrita(Passo::Pasta, &sem_permissao).to_string(),
            ERRO_SEM_PERMISSAO
        );
        assert_eq!(
            erro_de_escrita(Passo::Gravacao, &sem_permissao).to_string(),
            ERRO_SEM_PERMISSAO
        );
        assert_eq!(
            erro_de_escrita(Passo::Instalacao, &sem_permissao).to_string(),
            ERRO_ARQUIVO_EM_USO
        );
        assert_eq!(
            erro_de_escrita(Passo::Gravacao, &outro).to_string(),
            ERRO_GRAVACAO
        );
    }

    /// E nenhuma delas repassa o texto do sistema: "os error 28" e "No space
    /// left on device" não explicam nada a quem só clicou em "baixar".
    #[test]
    fn nenhuma_mensagem_de_escrita_repassa_o_texto_do_sistema() {
        for msg in [
            ERRO_DISCO_CHEIO,
            ERRO_SEM_PERMISSAO,
            ERRO_ARQUIVO_EM_USO,
            ERRO_GRAVACAO,
            ERRO_SOMA_NAO_CONFERE,
            ERRO_DOWNLOAD_INTERROMPIDO,
        ] {
            assert!(!msg.contains("os error"), "{msg}");
            assert!(!msg.contains("erro de arquivo"), "{msg}");
            // nenhuma palavra em inglês do repertório do sistema
            for ingles in ["denied", "space", "device", "permission", "Access"] {
                assert!(!msg.contains(ingles), "{msg} tem {ingles}");
            }
            assert!(msg.chars().next().is_some_and(|c| c.is_lowercase()));
        }
    }

    /// Fim a fim: a pasta de cache não pode ser criada (há um ARQUIVO no
    /// caminho dela) e a mensagem que sobe é a de pt-BR, não a do sistema.
    #[test]
    fn pasta_de_cache_que_nao_pode_ser_criada_nao_vaza_o_erro_do_sistema() {
        let dir = tempfile::tempdir().unwrap();
        let atravancado = dir.path().join("acessorios");
        std::fs::write(&atravancado, b"um arquivo onde devia haver pasta").unwrap();
        let cache = atravancado.join("dentro");
        let a = acessorio_de_teste(&sha256_dos_bytes(CONTEUDO));
        let chamadas = Cell::new(0);

        let erro = baixar(
            &a,
            &cache,
            fetcher(CONTEUDO, &chamadas),
            sem_progresso,
            sem_cancelamento,
        )
        .expect_err("não dá para criar a pasta");

        let msg = erro.to_string();
        assert!(!msg.contains("os error"), "vazou o erro do sistema: {msg}");
        assert!(
            [ERRO_DISCO_CHEIO, ERRO_SEM_PERMISSAO, ERRO_GRAVACAO].contains(&msg.as_str()),
            "é uma das frases de escrita, e veio: {msg}"
        );
        assert_eq!(chamadas.get(), 0, "nem chega a abrir conexão");
    }

    // -----------------------------------------------------------------------
    // Soma e cache
    // -----------------------------------------------------------------------

    /// Vetores conhecidos do SHA-256 — se a conferência estiver errada, tudo
    /// o mais neste módulo é teatro.
    #[test]
    fn a_soma_bate_com_os_vetores_conhecidos_do_sha256() {
        assert_eq!(
            sha256_dos_bytes(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_dos_bytes(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn a_pasta_de_cache_fica_sob_o_perfil_do_usuario() {
        let base = Path::new("/perfil/do/usuario");
        assert_eq!(
            diretorio_de_cache(base),
            Path::new("/perfil/do/usuario/acessorios")
        );
    }
}
