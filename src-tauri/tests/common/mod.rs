//! Acesso às fixtures MP3 compartilhado pelos testes de integração.
//!
//! # Por que isto existe
//!
//! O `fixtures/` da raiz do repositório é um artefato COMPARTILHADO e
//! MUTÁVEL: o `tools/make_fixtures.py` reescreve os quatro MP3s do zero, e a
//! suíte Python o executa (`tests/python/test_fixtures.py`) toda vez que
//! roda. Os testes Rust, do outro lado, copiam esses mesmos arquivos para
//! tempdirs.
//!
//! Rodar as duas suítes ao mesmo tempo dava três ou quatro falhas por
//! execução, sempre em testes diferentes, sempre em `enrich.rs`, e sempre
//! sumindo ao rodar de novo. O sintoma não conta a história:
//! `failed to fill whole buffer` num teste de proposta de letra. Numa release
//! automatizada isso vira uma falha que ninguém consegue reproduzir.
//!
//! # Por que a solução é um retrato, e não uma espera
//!
//! A primeira tentativa foi esperar o arquivo "estabilizar" (duas leituras
//! iguais) antes de copiar. Não basta: a geração de cada fixture passa por
//! vários estados COMPLETOS e intermediários — o lame grava o MP3, depois o
//! mutagen acrescenta TIT2, depois USLT, depois TXXX. Uma cópia tirada entre
//! duas dessas gravações não está truncada, está *errada*, e falha lá adiante
//! afirmando que a música não tem letra. Não dá para sincronizar com um
//! processo que publica estados intermediários válidos.
//!
//! Então cada binário de teste tira UM RETRATO das fixtures no primeiro uso e
//! copia dali para o resto da execução. O retrato é tirado depois que o
//! diretório fica quieto (nenhuma mudança de tamanho ou mtime por um
//! intervalo) e é conferido depois: se alguém escreveu durante a cópia, tira
//! de novo. Feito o retrato, nada mais que aconteça em `fixtures/` alcança os
//! testes.
//!
//! `CANCIONEIRO_FIXTURES_DIR` pula tudo isso: o CI gera as fixtures, copia
//! para um diretório que a suíte Python nunca toca e aponta os testes Rust
//! para lá. Aí não há corrida nenhuma para detectar.
#![allow(dead_code)] // cada binário de teste usa só parte deste módulo

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime};

/// Quanto tempo o diretório precisa ficar sem mudanças para o retrato sair.
const QUIETUDE: Duration = Duration::from_millis(150);
/// Teto de tentativas (≈ 6 s). O gerador leva bem menos; desistir com uma
/// mensagem explicando o que houve é melhor do que pendurar a suíte.
const TENTATIVAS: usize = 40;

/// Diretório de onde as fixtures são copiadas: o retrato, ou o que a variável
/// de ambiente mandar.
pub fn fixtures_dir() -> PathBuf {
    static RETRATO: OnceLock<PathBuf> = OnceLock::new();
    RETRATO.get_or_init(tirar_retrato).clone()
}

/// Copia uma fixture do retrato para `dest`.
pub fn copy_fixture(nome: &str, dest: &Path) {
    let src = fixtures_dir().join(nome);
    fs::copy(&src, dest)
        .unwrap_or_else(|e| panic!("não foi possível copiar {src:?} para {dest:?}: {e}"));
}

/// Diretório original das fixtures (o do repositório, ou o apontado pela
/// variável de ambiente).
fn origem() -> PathBuf {
    match std::env::var_os("CANCIONEIRO_FIXTURES_DIR") {
        Some(dir) => PathBuf::from(dir),
        // src-tauri/tests -> raiz do repositório /fixtures
        None => Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("fixtures"),
    }
}

/// (nome, tamanho, mtime) de cada MP3 — barato de tirar e sensível a qualquer
/// regravação, inclusive uma que devolva o mesmo tamanho.
fn assinatura(dir: &Path) -> Vec<(String, u64, Option<SystemTime>)> {
    let Ok(entradas) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut v: Vec<_> = entradas
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|x| x.eq_ignore_ascii_case("mp3")))
        .filter_map(|e| {
            let md = e.metadata().ok()?;
            Some((e.file_name().to_string_lossy().into_owned(), md.len(), md.modified().ok()))
        })
        .collect();
    v.sort();
    v
}

fn tirar_retrato() -> PathBuf {
    let origem = origem();
    // Com CANCIONEIRO_FIXTURES_DIR o diretório é do CI e ninguém escreve nele:
    // usar direto evita a espera e a cópia.
    if std::env::var_os("CANCIONEIRO_FIXTURES_DIR").is_some() {
        return origem;
    }

    // Um retrato por execução de binário de teste, dentro do target (some com
    // `cargo clean`, não polui /tmp a cada rodada). Binários de teste rodam em
    // paralelo, então cada arquivo é publicado por rename — operação atômica:
    // quem lê vê a versão antiga inteira ou a nova inteira, nunca metade.
    let destino = Path::new(env!("CARGO_TARGET_TMPDIR")).join("fixtures-retrato");
    fs::create_dir_all(&destino).expect("criar diretório do retrato das fixtures");

    for _ in 0..TENTATIVAS {
        // 1. espera o diretório ficar quieto
        let antes = assinatura(&origem);
        std::thread::sleep(QUIETUDE);
        if antes.is_empty() || assinatura(&origem) != antes {
            continue; // alguém está escrevendo (ou ainda não há fixtures)
        }

        // 2. copia tudo
        let mut copiou_tudo = true;
        for (nome, _, _) in &antes {
            let tmp = destino.join(format!("{nome}.{}.parcial", std::process::id()));
            match fs::read(origem.join(nome)).and_then(|b| fs::write(&tmp, b)) {
                Ok(()) => {
                    if fs::rename(&tmp, destino.join(nome)).is_err() {
                        copiou_tudo = false;
                    }
                }
                Err(_) => copiou_tudo = false,
            }
        }

        // 3. confere que nada mudou DURANTE a cópia — é o que separa um
        //    retrato de uma foto tremida
        if copiou_tudo && assinatura(&origem) == antes {
            return destino;
        }
    }

    panic!(
        "as fixtures em {origem:?} não pararam de mudar em {} s. Alguém está \
         rodando o tools/make_fixtures.py (a suíte Python roda ele) ao mesmo \
         tempo que os testes Rust. Rode as suítes em sequência, ou aponte \
         CANCIONEIRO_FIXTURES_DIR para uma cópia que a suíte Python não toque \
         — é o que o .github/workflows/ci.yml faz.",
        (TENTATIVAS as f64 * QUIETUDE.as_secs_f64()).round()
    );
}
