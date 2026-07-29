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
// de recurso quando a mensagem é a explicação inteira. Nenhuma entrada está
// pendente hoje, e há teste fixando isso.

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
    },
    Acessorio {
        nome: FPCALC,
        plataforma: "linux-x86_64",
        arquivo: "fpcalc-linux-x86_64",
        sha256: "085a1adf67b4a71a2e57b7b05bc425c1ea21b371b2b43049fc8ba37b53cb472b",
        tamanho_bytes: 5_538_312,
    },
    Acessorio {
        nome: FPCALC,
        plataforma: "macos",
        arquivo: ARQUIVO_MACOS,
        sha256: "ede0f92ac30807799872f8700d5e334e9ddef738a6b1b9d154097954619d68f8",
        tamanho_bytes: 4_739_368,
    },
];

// ===========================================================================
//  fim do bloco a preencher
// ===========================================================================

/// Nome do acessório da etapa 2. É o que o frontend manda em
/// `acessorio_baixar(nome)` e o que aparece nas mensagens.
pub const FPCALC: &str = "fpcalc";

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
    /// regra 1). Não é critério de aceitação: quem decide é a soma.
    pub tamanho_bytes: u64,
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

/// O acessório `nome` desta máquina, ou `None` quando não publicamos binário
/// para esta plataforma (aí a etapa que depende dele simplesmente não existe
/// aqui, e a tela diz isso em vez de oferecer um download que não serve).
pub fn desta_maquina(nome: &str) -> Option<&'static Acessorio> {
    let plataforma = if cfg!(target_os = "windows") && cfg!(target_arch = "x86_64") {
        "windows-x86_64"
    } else if cfg!(target_os = "linux") && cfg!(target_arch = "x86_64") {
        "linux-x86_64"
    } else if cfg!(target_os = "macos") {
        // um arquivo só serve os dois processadores do Mac: o universal
        // roda nativo nos dois, e o x86_64 roda no Apple Silicon por Rosetta
        "macos"
    } else {
        return None;
    };
    CATALOGO
        .iter()
        .find(|a| a.nome == nome && a.plataforma == plataforma)
}

/// Todos os acessórios que existem para esta máquina (hoje, só o `fpcalc`).
pub fn catalogo_desta_maquina() -> Vec<&'static Acessorio> {
    let mut vistos = Vec::new();
    for a in CATALOGO {
        if let Some(meu) = desta_maquina(a.nome) {
            if !vistos.iter().any(|v: &&Acessorio| v.nome == meu.nome) {
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

    std::fs::create_dir_all(cache)?;
    let corpo = fetch(&acessorio.url())?;
    let total = corpo.total;
    let mut origem = corpo.bytes;

    // a partir daqui existe um parcial no disco, e ele some sozinho em
    // qualquer caminho de saída que não seja o sucesso (ver `Parcial`)
    let parcial = Parcial(acessorio.parcial(cache));
    let mut destino = std::fs::File::create(&parcial.0)?;
    let mut hasher = Sha256::new();
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
        destino.write_all(&buf[..lidos])?;
        hasher.update(&buf[..lidos]);
        baixados += lidos as u64;
        on_progress(baixados, total);
    }
    destino.flush()?;
    drop(destino);

    if hex(&hasher.finalize()) != acessorio.sha256 {
        return Err(AppError(ERRO_SOMA_NAO_CONFERE.into()));
    }

    // O bit de execução vai ANTES da troca de nome: assim o arquivo que
    // aparece no cache já nasce executável, sem uma janela em que ele existe
    // e não roda.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&parcial.0, std::fs::Permissions::from_mode(0o755))?;
    }

    let caminho = acessorio.caminho(cache);
    std::fs::rename(&parcial.0, &caminho)?;
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

    /// Os nomes de arquivo são os que o `.github/workflows/acessorios.yml`
    /// publica. Divergência aqui é 404 na cara de quem clicou.
    #[test]
    fn os_nomes_de_arquivo_sao_os_que_o_workflow_publica() {
        let arquivos: Vec<&str> = CATALOGO.iter().map(|a| a.arquivo).collect();
        assert!(arquivos.contains(&"fpcalc-windows-x86_64.exe"));
        assert!(arquivos.contains(&"fpcalc-linux-x86_64"));
        // o Chromaprint v1.5.1 publica binário UNIVERSAL para macOS: um
        // arquivo só, nativo nos dois processadores, sem Rosetta
        assert!(arquivos.contains(&"fpcalc-macos-universal"));
        assert_eq!(arquivos.len(), 3, "três plataformas, não quatro");
    }

    /// Guarda de regressão: o catálogo publicado NÃO pode voltar a ter soma
    /// pendente nem tamanho zero. Uma soma zerada por um merge desligaria a
    /// etapa 2 de todo mundo, e um tamanho zerado faria a tela prometer um
    /// download de 0 byte antes de baixar 5 MB.
    #[test]
    fn o_catalogo_publicado_nao_tem_nada_pendente() {
        for a in CATALOGO {
            assert_ne!(a.sha256, SHA256_PENDENTE, "{}: soma pendente", a.arquivo);
            assert!(a.tamanho_bytes > 0, "{}: tamanho pendente", a.arquivo);
        }
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
