//! V10 — a etapa 5 com o motor de verdade EXECUTADO, sobre MP3 de verdade.
//!
//! Estes testes moram aqui, e não no módulo, por uma razão: desde que o
//! aplicativo passou a DECODIFICAR o MP3 antes de chamar o `whisper-cli`, eles
//! precisam de um MP3 que decodifique — e o acesso às fixtures compartilhadas
//! passa pelo retrato do `tests/common` (DECISIONS #77: o `pytest` reescreve
//! `fixtures/` enquanto o `cargo` lê, e isso dava falha fantasma).
//!
//! O `whisper-cli` é um script de shell de mentira. O que se prova é o que o
//! aplicativo faz em volta dele: drenar os canos, responder ao cancelamento,
//! matar o processo, medir a duração — e não deixar arquivo nenhum dentro do
//! acervo.

use cancioneiro_lib::transcricao::{
    decidir, transcrever, Desfecho, ERRO_AUDIO, IDIOMA,
};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

mod common;
use common::copy_fixture;

/// Nunca cancela.
const SEGUE: &dyn Fn() -> bool = &|| false;
/// Ignora o progresso.
const SEM_PROGRESSO: &dyn Fn(u8) = &|_| {};

/// Um MP3 de VERDADE (a fixture com letra, ~2 s de tom puro): o aplicativo
/// decodifica antes de chamar o motor, e um arquivo de mentira pararia na
/// decodificação em vez de exercitar o que estes testes querem exercitar.
fn mp3_real(dir: &Path) -> PathBuf {
    let destino = dir.join("musica.mp3");
    copy_fixture("com_letra.mp3", &destino);
    destino
}

/// Os nomes de arquivo de uma pasta, em ordem.
fn conteudo(dir: &Path) -> Vec<String> {
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
    let mp3 = mp3_real(dir.path());

    let inicio = Instant::now();
    let saida = transcrever(&whisper, &modelo, &mp3, dir.path(), IDIOMA, SEGUE, SEM_PROGRESSO)
        .expect("stderr grande não é falha")
        .expect("não foi cancelado");
    let gasto = inicio.elapsed();

    assert_eq!(saida.texto, "Chove lá fora\nE aqui dentro canta o coração");
    assert!(
        saida.duracao.medida > 0.0 && saida.duracao.medida < 10.0,
        "a duração é a MEDIDA na decodificação ({:?}), e não os 300 s que o \
         motor anunciou no stderr",
        saida.duracao
    );
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
    let mp3 = mp3_real(dir.path());

    let vistos = std::sync::Mutex::new(Vec::new());
    let anota: &dyn Fn(u8) = &|p| vistos.lock().unwrap().push(p);
    transcrever(&whisper, &modelo, &mp3, dir.path(), IDIOMA, SEGUE, anota)
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
    let mp3 = mp3_real(dir.path());

    let inicio = Instant::now();
    let saida = transcrever(&whisper, &modelo, &mp3, dir.path(), IDIOMA, &|| true, SEM_PROGRESSO)
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
    let mp3 = mp3_real(dir.path());

    let _ = transcrever(&whisper, &modelo, &mp3, dir.path(), IDIOMA, &|| true, SEM_PROGRESSO);
    std::thread::sleep(Duration::from_millis(3500));
    assert!(!marca.exists(), "o transcritor continuou rodando depois do PARE");
}



/// Motor que falha NESTE arquivo é erro de UMA música: a mensagem é a de
/// áudio, não a de máquina, e a fila do chamador segue.
#[cfg(unix)]
#[test]
fn motor_que_falha_no_arquivo_e_erro_de_uma_musica_so() {
    let dir = tempfile::tempdir().unwrap();
    let whisper = script(dir.path(), "echo 'error: failed to open' >&2\nexit 1\n");
    let modelo = modelo_falso(dir.path());
    let mp3 = mp3_real(dir.path());

    let erro = transcrever(&whisper, &modelo, &mp3, dir.path(), IDIOMA, SEGUE, SEM_PROGRESSO)
        .expect_err("saída 1 é falha");
    assert_eq!(erro.to_string(), ERRO_AUDIO);
}

/// **A duração já não depende do stderr do motor.** Ela vem da CONTAGEM DE
/// AMOSTRAS da nossa decodificação, que é medição do áudio — o topo da ordem
/// de autoridade da DECISIONS #72.
///
/// Este teste é a inversão do que a v0.10.0 fazia antes da decodificação: um
/// motor que não diz nada em stderr continua entregando duração PROVADA, e a
/// `Adiada` — que existia para o caso "transcrição rala sem prova de duração"
/// — deixa de ser alcançável por este caminho.
#[cfg(unix)]
#[test]
fn a_duracao_vem_da_decodificacao_e_nao_do_stderr_do_motor() {
    let dir = tempfile::tempdir().unwrap();
    let whisper = script(dir.path(), "echo 'la la la'\n");
    let modelo = modelo_falso(dir.path());
    let mp3 = mp3_real(dir.path());

    let saida = transcrever(&whisper, &modelo, &mp3, dir.path(), IDIOMA, SEGUE, SEM_PROGRESSO)
        .unwrap()
        .unwrap();
    assert!(
        saida.duracao.provada(),
        "o motor calou e a duração continua provada: {:?}",
        saida.duracao
    );
    assert!(
        !matches!(
            decidir(&saida.texto, saida.duracao, 300.0),
            Desfecho::Adiada { .. }
        ),
        "com prova de duração não há o que adiar"
    );
}

/// E o número do motor, quando existe, NÃO ganha da decodificação. O
/// `whisper-cli` recebe o WAV, então os dois deveriam concordar; quando não
/// concordarem, quem manda é a contagem de amostras.
#[cfg(unix)]
#[test]
fn o_numero_que_o_motor_anuncia_nao_ganha_da_contagem_de_amostras() {
    let dir = tempfile::tempdir().unwrap();
    let whisper = script(
        dir.path(),
        "echo \"main: processing 'x.wav' (48000000 samples, 3000.0 sec)\" >&2\necho 'la la la'\n",
    );
    let modelo = modelo_falso(dir.path());
    let mp3 = mp3_real(dir.path());

    let saida = transcrever(&whisper, &modelo, &mp3, dir.path(), IDIOMA, SEGUE, SEM_PROGRESSO)
        .unwrap()
        .unwrap();
    assert!(
        saida.duracao.medida < 100.0,
        "o motor mentiu 3000 s e a medição valeu: {:?}",
        saida.duracao
    );
    // e mentir para MAIS não derruba a prova: a corroboração pelo número do
    // motor só olha para o lado que acusa — ele ter ouvido MENOS do que nós
    // escrevemos no WAV
    assert!(saida.duracao.provada(), "{:?}", saida.duracao);
}

/// **Nada é criado dentro do acervo.** O WAV vai para a pasta que quem chama
/// escolheu, e a pasta do MP3 fica exatamente como estava — mesmo quando o
/// motor falha. São acervos que o dono do produto não pode nem ver.
#[cfg(unix)]
#[test]
fn nada_e_criado_ao_lado_do_mp3_e_o_temporario_nao_sobrevive() {
    let acervo = tempfile::tempdir().unwrap();
    let trabalho = tempfile::tempdir().unwrap();
    let mp3 = mp3_real(acervo.path());
    let antes = conteudo(acervo.path());

    let whisper = script(trabalho.path(), "echo 'uma letra qualquer bem comprida'\n");
    let modelo = modelo_falso(trabalho.path());
    transcrever(&whisper, &modelo, &mp3, trabalho.path(), IDIOMA, SEGUE, SEM_PROGRESSO)
        .unwrap()
        .unwrap();
    assert_eq!(conteudo(acervo.path()), antes, "o acervo ficou intacto");
    assert!(
        !conteudo(trabalho.path()).iter().any(|n| n.ends_with(".wav")),
        "e o temporário sumiu: {:?}",
        conteudo(trabalho.path())
    );

    // e quando o motor FALHA, também não sobra WAV nenhum
    let quebrado = script(trabalho.path(), "exit 1\n");
    let _ = transcrever(&quebrado, &modelo, &mp3, trabalho.path(), IDIOMA, SEGUE, SEM_PROGRESSO);
    assert_eq!(conteudo(acervo.path()), antes);
    assert!(!conteudo(trabalho.path()).iter().any(|n| n.ends_with(".wav")));
}

// ===========================================================================
// A DECODIFICAÇÃO — e a duração que ela PROVA (DECISIONS #72)
// ===========================================================================

use cancioneiro_lib::transcricao::{decodificar_para_wav, Temporario, TAXA_DO_MOTOR};

/// O WAV sai com a contagem de amostras compatível com o áudio, e a duração
/// devolvida é amostras/16000 — medição, não leitura de cabeçalho.
#[test]
fn a_decodificacao_mede_a_duracao_pela_contagem_de_amostras() {
    let dir = tempfile::tempdir().unwrap();
    let mp3 = mp3_real(dir.path());
    let wav = Temporario(dir.path().join("saida.wav"));

    let d = decodificar_para_wav(&mp3, &wav.0, SEGUE)
        .expect("a fixture decodifica")
        .expect("não foi cancelado");

    assert!(d.amostras > 0);
    assert!(
        (d.duracao - d.amostras as f64 / TAXA_DO_MOTOR as f64).abs() < 1e-9,
        "a duração É a contagem de amostras dividida pela taxa"
    );
    // a fixture tem ~2 s; a margem é generosa porque o que se prova é a ORDEM
    // DE GRANDEZA — é ela que o cabeçalho errava por um fator de 8
    assert!(
        (1.0..4.0).contains(&d.duracao),
        "duração medida fora do esperado: {}",
        d.duracao
    );
    // e o arquivo no disco tem exatamente esses bytes de áudio
    let bytes = std::fs::metadata(&wav.0).unwrap().len();
    assert_eq!(bytes, 44 + d.amostras * 2);
}

/// **O incidente que criou a DECISIONS #72, agora sem saída.**
///
/// Sem cabeçalho Xing o mutagen estimava 300 s reais como 2365 s, e uma música
/// CANTADA foi marcada instrumental para sempre. A decodificação não lê
/// cabeçalho nenhum: ela conta amostras.
///
/// O arquivo deste teste é feito à mão — a tag ID3v2 e o primeiro quadro (o
/// que carrega o Xing/Info que o `lame` escreve) são removidos, e o que sobra
/// é fluxo MPEG puro.
#[test]
fn mp3_sem_cabecalho_xing_continua_tendo_duracao_provada() {
    let dir = tempfile::tempdir().unwrap();
    let inteiro = mp3_real(dir.path());
    let bytes = std::fs::read(&inteiro).unwrap();

    // pula a tag ID3v2 ("ID3" + versão + flags + tamanho em 4 bytes de 7 bits)
    let mut pos = 0usize;
    if bytes.starts_with(b"ID3") {
        let n = ((bytes[6] as usize) << 21)
            | ((bytes[7] as usize) << 14)
            | ((bytes[8] as usize) << 7)
            | bytes[9] as usize;
        pos = 10 + n;
    }
    // acha o primeiro quadro MPEG e o descarta junto com o Xing que ele traz
    while pos + 1 < bytes.len() && !(bytes[pos] == 0xFF && bytes[pos + 1] & 0xE0 == 0xE0) {
        pos += 1;
    }
    assert!(pos + 4 < bytes.len(), "a fixture tem quadro MPEG");
    let primeiro = pos;
    let mut seguinte = primeiro + 2;
    while seguinte + 1 < bytes.len()
        && !(bytes[seguinte] == 0xFF && bytes[seguinte + 1] & 0xE0 == 0xE0)
    {
        seguinte += 1;
    }
    let sem_xing = dir.path().join("sem-xing.mp3");
    std::fs::write(&sem_xing, &bytes[seguinte..]).unwrap();
    let cru = std::fs::read(&sem_xing).unwrap();
    assert!(!cru.starts_with(b"ID3"), "sem tag ID3v2");
    assert!(
        !cru.windows(4).take(2000).any(|j| j == b"Xing" || j == b"Info"),
        "e sem o cabeçalho que declara a duração"
    );

    let wav = Temporario(dir.path().join("saida.wav"));
    let d = decodificar_para_wav(&sem_xing, &wav.0, SEGUE)
        .expect("fluxo MPEG puro decodifica")
        .expect("não foi cancelado");
    assert!(
        (1.0..4.0).contains(&d.duracao),
        "a duração é medida do ÁUDIO, não declarada: {}",
        d.duracao
    );
}

/// Cancelar durante a decodificação volta `None` e não deixa WAV nenhum — o
/// mesmo contrato do download de acessório.
#[test]
fn cancelar_durante_a_decodificacao_nao_deixa_lixo() {
    let dir = tempfile::tempdir().unwrap();
    let mp3 = mp3_real(dir.path());
    let destino = dir.path().join("saida.wav");
    {
        let wav = Temporario(destino.clone());
        let r = decodificar_para_wav(&mp3, &wav.0, &|| true).expect("cancelar não é falha");
        assert!(r.is_none());
    }
    assert!(!destino.exists(), "o Drop apagou o parcial");
}

/// Áudio que não pôde ser LIDO é `ERRO_AUDIO` — e é erro de UMA música. Não é
/// "instrumental": áudio ilegível e música sem voz são coisas diferentes
/// (V7/F16), e confundi-las tira o arquivo da fila de letra para sempre.
#[test]
fn arquivo_que_nao_e_audio_e_erro_e_nunca_instrumental() {
    let dir = tempfile::tempdir().unwrap();
    let lixo = dir.path().join("corrompido.mp3");
    copy_fixture("corrompido.mp3", &lixo);
    let destino = dir.path().join("saida.wav");
    {
        let wav = Temporario(destino.clone());
        let erro = decodificar_para_wav(&lixo, &wav.0, SEGUE).expect_err("não é áudio");
        assert_eq!(erro.to_string(), ERRO_AUDIO);
    }
    assert!(!destino.exists());

    let sumido = dir.path().join("nao-existe.mp3");
    let erro = decodificar_para_wav(&sumido, &destino, SEGUE).expect_err("arquivo ausente");
    assert_eq!(erro.to_string(), ERRO_AUDIO);
}

// ===========================================================================
// C1 — o contador do cabeçalho `Info` NÃO é medição, e não pode virar prova
// ===========================================================================
//
// O achado do QA na v0.10.0: o `symphonia` para de entregar áudio no número de
// quadros declarado no cabeçalho Xing/Info (é o que a opção `gapless` faz — ela
// apara tudo o que passa do fim DECLARADO). Logo a "contagem de amostras" que a
// DECISIONS #108 promoveu ao topo da ordem de autoridade derivava, sem que
// ninguém percebesse, exatamente do número que a DECISIONS #72 proíbe confiar.
//
// O arquivo que expõe isso não é exótico: é o que `cat a.mp3 b.mp3 > set.mp3`
// produz, e todo player toca inteiro. O contador da PRIMEIRA cópia fala pelo
// arquivo todo.

/// Onde mora o contador de quadros do Xing/Info, e quanto ele diz.
fn contador_do_cabecalho(bytes: &[u8]) -> Option<(usize, u32)> {
    for i in 0..bytes.len().saturating_sub(12) {
        if &bytes[i..i + 4] == b"Info" || &bytes[i..i + 4] == b"Xing" {
            let flags = u32::from_be_bytes([bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]]);
            if flags & 1 == 1 {
                let n =
                    u32::from_be_bytes([bytes[i + 8], bytes[i + 9], bytes[i + 10], bytes[i + 11]]);
                return Some((i + 8, n));
            }
        }
    }
    None
}

/// Os bytes de `copias` fixtures emendadas — o `cat a.mp3 b.mp3 > set.mp3` do
/// acervo real, com uma tag ID3 e um cabeçalho `Info` no meio do caminho.
fn emendado(dir: &Path, copias: usize) -> Vec<u8> {
    let uma = dir.join("uma.mp3");
    copy_fixture("com_letra.mp3", &uma);
    let base = std::fs::read(&uma).unwrap();
    std::fs::remove_file(&uma).unwrap();
    let mut bytes = Vec::with_capacity(base.len() * copias);
    for _ in 0..copias {
        bytes.extend_from_slice(&base);
    }
    bytes
}

fn escrever(dir: &Path, nome: &str, bytes: &[u8]) -> PathBuf {
    let p = dir.join(nome);
    std::fs::write(&p, bytes).unwrap();
    p
}

fn decodificar(dir: &Path, mp3: &Path, nome: &str) -> cancioneiro_lib::transcricao::Decodificado {
    let wav = Temporario(dir.join(nome));
    decodificar_para_wav(mp3, &wav.0, SEGUE)
        .expect("decodifica")
        .expect("não foi cancelado")
}

/// **A prova de que o C1 morreu.** Mesmíssimos bytes de áudio; só os 4 bytes
/// do contador do `Info` mudam. A duração medida tem de ser a MESMA nos três,
/// porque a duração é do ÁUDIO — o contador é só uma afirmação de quem
/// escreveu o arquivo.
///
/// Antes da correção, com a fixture deste repositório:
///
/// ```text
/// Info diz 78    → amostras=32601   duracao=2,04
/// Info diz 116   → amostras=48000   duracao=3,00   (o que o `cat` deixa)
/// Info diz 1160  → amostras=484833  duracao=30,30  (o número verdadeiro)
/// ```
#[test]
fn o_contador_do_cabecalho_info_nao_decide_quanto_audio_existe() {
    let dir = tempfile::tempdir().unwrap();
    let bytes = emendado(dir.path(), 10);
    let (pos, declarado) = contador_do_cabecalho(&bytes).expect("a fixture tem cabeçalho Info");
    assert_eq!(declarado, 116, "uma cópia declara 116 quadros");

    // 1) como o `cat` deixa: o contador da primeira cópia, um décimo do total
    let como_o_cat = decodificar(dir.path(), &escrever(dir.path(), "set.mp3", &bytes), "a.wav");

    // 2) o contador ADULTERADO para 78 quadros (os 2 s do relatório do QA)
    let mut mentiroso = bytes.clone();
    mentiroso[pos..pos + 4].copy_from_slice(&78u32.to_be_bytes());
    let mentiroso =
        decodificar(dir.path(), &escrever(dir.path(), "mentiroso.mp3", &mentiroso), "b.wav");

    // 3) o contador CORRIGIDO para o total verdadeiro
    let mut honesto = bytes.clone();
    honesto[pos..pos + 4].copy_from_slice(&1160u32.to_be_bytes());
    let honesto =
        decodificar(dir.path(), &escrever(dir.path(), "honesto.mp3", &honesto), "c.wav");

    assert_eq!(
        (como_o_cat.amostras, mentiroso.amostras),
        (honesto.amostras, honesto.amostras),
        "o contador do cabeçalho mudou a duração medida: 78 → {:.2}s, 116 → {:.2}s, \
         1160 → {:.2}s",
        mentiroso.duracao,
        como_o_cat.duracao,
        honesto.duracao
    );
    assert!(
        honesto.duracao > 25.0,
        "dez cópias de ~3 s são ~30 s de áudio, e é isso que um player toca: {:.2}s",
        honesto.duracao
    );
    // e os três são duração COMPROVADAMENTE completa: o áudio foi lido até o
    // fim do arquivo, e é só isso que autoriza um veredito de instrumental
    for d in [como_o_cat, mentiroso, honesto] {
        assert!(d.completa, "{d:?}");
    }
}

/// **A2 do C1: um cabeçalho mentiroso não pode marcar instrumental.**
///
/// Ponta a ponta, com o motor ouvindo só o comecinho — os dois desfechos que o
/// QA reproduziu eram PERMANENTES: o instrumental tira o arquivo da fila de
/// letra para sempre (a marca vence até o `--forcar-tudo`), e o toco de letra
/// faz `etapas_de_letra_valem_a_pena` nunca mais deixar a música entrar em
/// varredura.
#[cfg(unix)]
#[test]
fn cabecalho_mentiroso_nao_marca_instrumental_ponta_a_ponta() {
    let dir = tempfile::tempdir().unwrap();
    let bytes = emendado(dir.path(), 10);
    let (pos, _) = contador_do_cabecalho(&bytes).unwrap();
    let mut mentiroso = bytes.clone();
    mentiroso[pos..pos + 4].copy_from_slice(&78u32.to_be_bytes());
    let mp3 = escrever(dir.path(), "trinta-segundos.mp3", &mentiroso);

    // o motor não ouve voz nos primeiros segundos: sem a correção, isto virava
    // "a transcrição voltou vazia e o áudio foi lido até o fim" — uma
    // afirmação FALSA, e permanente
    let whisper = script(dir.path(), "echo ''\n");
    let modelo = modelo_falso(dir.path());
    let saida = transcrever(&whisper, &modelo, &mp3, dir.path(), IDIOMA, SEGUE, SEM_PROGRESSO)
        .unwrap()
        .unwrap();
    assert!(
        saida.duracao.medida > 25.0,
        "o áudio tem ~30 s e o cabeçalho dizia 2: {:?}",
        saida.duracao
    );
    assert!(saida.duracao.provada(), "{:?}", saida.duracao);
}

// ===========================================================================
// A3 — EOF e FALHA DE LEITURA são coisas diferentes
// ===========================================================================

/// Arquivo cortado no meio: o que veio NÃO é promovido a prova.
///
/// O cabeçalho declara 1160 quadros e só 290 chegaram. Isso não decide que o
/// áudio é curto — decide que **não sabemos** quanto áudio existe, e sem saber
/// não se marca instrumental. O cabeçalho aqui é PISO, nunca autoridade: é a
/// corroboração da DECISIONS #72, na única direção em que ela é sólida.
#[test]
fn arquivo_cortado_no_meio_nao_promove_duracao_parcial_a_prova() {
    let dir = tempfile::tempdir().unwrap();
    let bytes = emendado(dir.path(), 10);
    let (pos, _) = contador_do_cabecalho(&bytes).unwrap();
    let mut inteiro = bytes.clone();
    inteiro[pos..pos + 4].copy_from_slice(&1160u32.to_be_bytes());

    let completo = decodificar(dir.path(), &escrever(dir.path(), "int.mp3", &inteiro), "i.wav");
    assert!(completo.completa);

    let cortado = &inteiro[..inteiro.len() / 4];
    let d = decodificar(dir.path(), &escrever(dir.path(), "cort.mp3", cortado), "t.wav");
    assert!(d.amostras > 0, "o que veio foi decodificado");
    assert!(
        !d.completa,
        "8 s de um arquivo que declara 30 não é áudio curto, é leitura incompleta: {d:?}"
    );
}
