//! Como este programa chama OUTRO programa — hoje o `fpcalc` e o `whisper-cli`.
//!
//! Existe por um defeito de campo no Windows: **a cada música lida, piscava
//! uma janela de terminal na tela**. No Windows todo processo filho ganha um
//! console próprio a menos que se peça o contrário, e a impressão digital roda
//! uma vez POR MÚSICA — numa pasta de mil músicas são mil janelas abrindo e
//! fechando por cima do que a pessoa está fazendo.
//!
//! No Linux e no macOS não há console para criar e a função não faz nada: o
//! `#[cfg]` mantém a diferença AQUI, num lugar só, em vez de espalhada por
//! cada lugar que chama um programa externo.

use std::path::Path;
use std::process::Command;

/// Monta o `Command` do jeito que este produto precisa: sem janela no Windows.
///
/// Use SEMPRE isto no lugar de `Command::new` — um `Command::new` solto volta
/// a piscar terminal na cara de quem está curando, e isso não aparece em
/// nenhuma suíte, porque o CI e o desenvolvimento são Linux.
pub fn comando_sem_janela(programa: &Path) -> Command {
    // `mut` só é usado no ramo do Windows abaixo; nos outros sistemas o
    // compilador avisaria, e a regra da casa é zero aviso
    #[allow(unused_mut)]
    let mut cmd = Command::new(programa);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW — o processo roda sem console nenhum. Os canos de
        // stdout/stderr continuam funcionando normalmente: é a JANELA que não
        // nasce, não a saída.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Inicia o programa, tentando de novo quando o sistema responde "arquivo de
/// texto ocupado" (`ETXTBSY`, só no Linux e no macOS).
///
/// Existe por uma corrida conhecida: um executável recém-escrito — o acessório
/// que acabou de ser baixado — pode estar aberto para escrita dentro de OUTRO
/// processo que nasceu naquele instante (o filho herda o arquivo entre o `fork`
/// e o `exec`), e aí o sistema recusa executá-lo. Dura milissegundos. Sem esta
/// segunda chance, a recusa vira "o programa não conseguiu ser executado neste
/// computador", que DESLIGA a etapa inteira — por um engasgo de alguns
/// milissegundos. Achado pela suíte de testes, que escreve executáveis de
/// mentira enquanto outros testes criam processos em paralelo.
pub fn iniciar(cmd: &mut Command) -> std::io::Result<std::process::Child> {
    // ETXTBSY vale 26 no Linux e no macOS
    const OCUPADO: i32 = 26;
    let mut tentativas = 0;
    loop {
        match cmd.spawn() {
            Err(e) if e.raw_os_error() == Some(OCUPADO) && tentativas < 10 => {
                tentativas += 1;
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            outro => return outro,
        }
    }
}
