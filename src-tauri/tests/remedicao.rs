//! **A remedição dos 78% — condição de entrega da v0.10.0.**
//!
//! Os 78% (trechos lembrados que viraram encontráveis) foram medidos com o
//! **faster-whisper** (CTranslate2, Python). O `whisper.cpp` com modelo
//! quantizado é **outro motor**, e *a prova não viaja junto quando o código é
//! reusado* (DECISIONS #72). Publicar sem remedir seria repetir, com 180 MB e
//! horas de CPU, o erro que este projeto já cometeu três vezes.
//!
//! # Por que este arnês é um teste `#[ignore]`, e não um script
//!
//! Porque ele mede **o produto**, não uma aproximação dele. Ele chama o mesmo
//! `transcricao::transcrever` que o aplicativo chama, com os mesmos
//! argumentos, passa pelo mesmo `transcricao::decidir` e procura o trecho com
//! a mesma `search::search` — o FTS5 de verdade, com o tokenizador de verdade.
//! Uma reimplementação em Python mediria outra coisa, e é exatamente esse tipo
//! de "outra coisa" que produziu o número que estamos remedindo.
//!
//! # Como rodar
//!
//! ```sh
//! CANCIONEIRO_WHISPER_CLI=/caminho/whisper-cli \
//! CANCIONEIRO_WHISPER_MODELO=/caminho/ggml-small-q5_1.bin \
//! CANCIONEIRO_REMEDICAO=/caminho/trechos.json \
//! cargo test --test remedicao -- --ignored --nocapture
//! ```
//!
//! `trechos.json` é a lista dos MESMOS arquivos e dos MESMOS trechos lembrados
//! da medição original — remedir em outro material não remede nada:
//!
//! ```json
//! [
//!   {"arquivo": "/acervo/Ponto de Oxum.mp3", "trecho": "na beira do mar sagrado"},
//!   {"arquivo": "/acervo/faixa 07.mp3",      "trecho": "vou chegar mais cedo"}
//! ]
//! ```
//!
//! # O que ele imprime
//!
//! - **encontráveis / total** e a porcentagem — o número que substitui os 78%;
//! - a **razão medida** (segundos de máquina por segundo de áudio), que é o
//!   valor a pôr em `transcricao::RAZAO_DE_REFERENCIA` para a estimativa de
//!   tempo deixar de ser declarada;
//! - uma linha por arquivo, dizendo por que cada um achou ou não.
//!
//! # O que ele NÃO faz
//!
//! **Não escreve em arquivo nenhum.** O acervo em que isto vai rodar pode ser
//! de alguém que o dono do produto não pode nem ver: a letra transcrita entra
//! num banco em memória e morre com o processo.

use cancioneiro_lib::error::AppError;
use cancioneiro_lib::{db, search, transcricao};
use std::path::{Path, PathBuf};
use std::time::Instant;

/// Um par da medição: o arquivo e o trecho que alguém lembrava dele.
struct Caso {
    arquivo: PathBuf,
    trecho: String,
}

/// Lê a lista de casos do JSON (sem crate de desserialização derivada: são
/// dois campos, e `serde_json::Value` basta).
fn casos(caminho: &Path) -> Vec<Caso> {
    let texto = std::fs::read_to_string(caminho)
        .unwrap_or_else(|e| panic!("não consegui ler {}: {e}", caminho.display()));
    let dados: serde_json::Value =
        serde_json::from_str(&texto).expect("o arquivo de trechos precisa ser um JSON válido");
    dados
        .as_array()
        .expect("o JSON precisa ser uma LISTA de {arquivo, trecho}")
        .iter()
        .map(|item| Caso {
            arquivo: PathBuf::from(
                item.get("arquivo")
                    .and_then(serde_json::Value::as_str)
                    .expect("cada item precisa de \"arquivo\""),
            ),
            trecho: item
                .get("trecho")
                .and_then(serde_json::Value::as_str)
                .expect("cada item precisa de \"trecho\"")
                .to_string(),
        })
        .collect()
}

fn variavel(nome: &str) -> PathBuf {
    PathBuf::from(std::env::var(nome).unwrap_or_else(|_| {
        panic!("defina {nome} — veja o cabeçalho de tests/remedicao.rs")
    }))
}

/// O trecho vira encontrável? Pergunta feita à busca DE VERDADE: banco em
/// memória, FTS5, o mesmo `search::search` que a caixa de busca do app chama.
fn encontravel(letra: &str, trecho: &str) -> bool {
    let conn = db::open_in_memory().expect("banco em memória");
    conn.execute("INSERT INTO folders (path) VALUES ('/remedicao')", [])
        .expect("pasta");
    conn.execute(
        "INSERT INTO songs (file_path, folder_id, title, artist, lyrics, has_lyrics,
                            file_mtime, file_size)
         VALUES ('/remedicao/x.mp3', 1, 'x', NULL, ?1, 1, 0, 0)",
        [letra],
    )
    .expect("música");
    // o mesmo limite do comando `search` do app
    search::search(&conn, trecho, 200)
        .expect("busca")
        .iter()
        .any(|r| r.snippet.is_some())
}

#[test]
#[ignore = "exige o whisper-cli, o modelo de 180 MB e o acervo da medição original"]
fn remedir_os_78_por_cento_com_o_whisper_cpp() {
    let whisper = variavel("CANCIONEIRO_WHISPER_CLI");
    let modelo = variavel("CANCIONEIRO_WHISPER_MODELO");
    let lista = variavel("CANCIONEIRO_REMEDICAO");
    // a pasta onde o WAV temporário de cada faixa é criado — NUNCA ao lado do
    // MP3: o acervo desta medição pode ser de alguém que ninguém pode ver
    let trabalho = tempfile::tempdir().expect("pasta temporária");
    let casos = casos(&lista);
    assert!(!casos.is_empty(), "a lista de trechos está vazia");

    let mut encontrados = 0usize;
    let mut audio_total = 0.0f64;
    let mut relogio_total = 0.0f64;
    let mut instrumentais = 0usize;
    let mut adiadas = 0usize;
    let mut erros = 0usize;

    println!("\n=== remedição dos 78% — whisper.cpp + {} ===", modelo.display());
    for (i, caso) in casos.iter().enumerate() {
        let comeco = Instant::now();
        let saida = transcricao::transcrever(
            &whisper,
            &modelo,
            &caso.arquivo,
            trabalho.path(),
            transcricao::IDIOMA,
            &|| false,
            &|_p: u8| {},
        );
        let gasto = comeco.elapsed().as_secs_f64();
        let nome = caso
            .arquivo
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();

        let desfecho = match saida {
            Err(AppError(msg)) => {
                erros += 1;
                println!("[{}/{}] ERRO       {nome} — {msg}", i + 1, casos.len());
                continue;
            }
            Ok(None) => unreachable!("este arnês nunca cancela"),
            Ok(Some(s)) => {
                // só o áudio comprovadamente ouvido até o fim entra na
                // medição — dividir o relógio por um pedaço da música daria
                // uma razão inflada, e é ela que vira a frase da tela
                if s.duracao.provada() {
                    audio_total += s.duracao.medida;
                    relogio_total += gasto;
                }
                transcricao::decidir(&s.texto, s.duracao, 0.0)
            }
        };

        match desfecho {
            transcricao::Desfecho::Transcrita { letra, refrao, .. } => {
                let achou = encontravel(&letra, &caso.trecho);
                encontrados += usize::from(achou);
                println!(
                    "[{}/{}] {} {nome} — trecho {:?}{}",
                    i + 1,
                    casos.len(),
                    if achou { "ENCONTRÁVEL" } else { "não achou  " },
                    caso.trecho,
                    refrao
                        .map(|r| format!(" (refrão: {r:?})"))
                        .unwrap_or_default()
                );
                if !achou {
                    println!("        letra transcrita: {letra:?}");
                }
            }
            transcricao::Desfecho::Instrumental { motivo } => {
                instrumentais += 1;
                println!("[{}/{}] INSTRUMENTAL {nome} — {motivo}", i + 1, casos.len());
            }
            transcricao::Desfecho::Adiada { motivo } => {
                adiadas += 1;
                println!("[{}/{}] ADIADA     {nome} — {motivo}", i + 1, casos.len());
            }
            transcricao::Desfecho::Erro { mensagem } => {
                erros += 1;
                println!("[{}/{}] ERRO       {nome} — {mensagem}", i + 1, casos.len());
            }
        }
    }

    let total = casos.len();
    let porcento = 100.0 * encontrados as f64 / total as f64;
    println!("\n--- resultado ---");
    println!("encontráveis: {encontrados} de {total} ({porcento:.0}%)");
    println!("instrumentais: {instrumentais} | adiadas: {adiadas} | erros: {erros}");
    if audio_total > 0.0 {
        let razao = relogio_total / audio_total;
        println!(
            "razão medida: {razao:.2} s de máquina por segundo de áudio \
             (a referência compilada é {:.2} — ver transcricao::RAZAO_DE_REFERENCIA)",
            transcricao::RAZAO_DE_REFERENCIA
        );
    } else {
        println!("razão medida: nenhuma — o motor não informou duração em nenhum arquivo");
    }
    println!(
        "\nO número acima SUBSTITUI os 78%: eles foram medidos com faster-whisper, \
         que é outro motor (DECISIONS #72). Se este caiu muito, o modelo \
         não-quantizado volta à mesa.\n"
    );
}

/// Imprime o JSON exato de tudo que a v0.10.0 faz cruzar para o frontend.
/// Não é uma asserção — é documentação executável, para o contrato não
/// precisar ser deduzido de `struct`s espalhadas por dois arquivos.
#[test]
#[ignore = "documentação: cargo test --test remedicao contrato -- --ignored --nocapture"]
fn contrato_com_o_frontend() {
    use cancioneiro_lib::enrich;
    let mostrar = |nome: &str, v: serde_json::Value| {
        println!("\n// {nome}\n{}", serde_json::to_string_pretty(&v).unwrap());
    };
    mostrar(
        "enrich_count -> Contagem",
        serde_json::to_value(enrich::Contagem {
            total: 150,
            sem_letra: 80,
            segundos_estimados: 1020,
            etapas: enrich::contar(
                &db::open_in_memory().unwrap(),
                "",
                enrich::EtapasLigadas { som: true, transcricao: true },
            )
            .unwrap()
            .etapas,
            transcricao_disponivel: true,
        })
        .unwrap(),
    );
    mostrar(
        "enrich_folder_scan -> EnrichScanResult",
        serde_json::to_value(enrich::EnrichScanResult {
            propostas: vec![],
            sem_perguntar_ao_som: 0,
            sem_letra_no_fim: vec![12, 47],
            segundos_de_transcricao: 10_800,
            estimativa_medida_nesta_maquina: true,
        })
        .unwrap(),
    );
    mostrar(
        "transcrever_musicas -> TranscricaoResultado",
        serde_json::to_value(enrich::TranscricaoResultado {
            propostas: vec![],
            razao_medida: Some(1.37),
            razao_desta_maquina: 1.37,
        })
        .unwrap(),
    );
}
