//! V9/F18 fase 2 — etapa 4 do funil: a impressão digital acústica.
//!
//! Porte do subcomando `identificar` do `tools/curadoria.py`
//! (`criar_impressao_digital`, `consultar_acoustid`, `escolher_candidato`,
//! `classificar`, `_artista_da_gravacao`, `_discorda`). O `fpcalc` calcula um
//! resumo acústico do arquivo, o AcoustID diz que gravação é aquela, e o que
//! volta são **título e artista** — nunca letra.
//!
//! # Por que esta etapa é diferente de todas as outras
//!
//! As etapas 2 e 3 partem da ETIQUETA e procuram a letra. Esta parte do SOM e
//! ignora a etiqueta por completo. É a única capaz de descobrir que a
//! etiqueta MENTE — um arquivo com `title = "Te ver feliz, te ver contente"`
//! e `artist = "Caetano Veloso"` que é, de verdade, "Viver Feliz" do Nilson
//! Chaves. Nenhuma regra de texto pega isso: "Caetano Veloso" não é
//! placeholder por critério nenhum, e as etapas de letra só iriam procurar,
//! com afinco, pela música errada.
//!
//! # As regras de aceitação são CONSERVADORAS por medição, não por gosto
//!
//! Pontuação mínima 0,7; gravação sem metadados descartada; título ou artista
//! de ripador descartados; **teto de 15 s de diferença de duração**;
//! confirmação BAIXA não é identificação. Cada uma dessas foi calibrada
//! contra erro medido no acervo real, e afrouxar qualquer uma põe título de
//! outra gravação dentro do arquivo de alguém.
//!
//! A linha mais delicada do porte é o `classificar` **sem duração**: quando
//! não há duração dos dois lados, não há bônus nem desqualificação, e o teto
//! passa a ser MÉDIA. Aplicar a régua calibrada COM duração num contexto que
//! não tem duração foi o erro mais caro do projeto (DECISIONS #63) — por isso
//! a tabela inteira está fixada em teste, linha por linha.
//!
//! # O que NÃO foi portado
//!
//! A identificação pelo REFRÃO (F14.1) fica de fora do aplicativo. Ela é
//! opt-in até no Python porque mediu 0 e 1 identificação em duas execuções de
//! 94 arquivos — e a única foi ERRADA (DECISIONS #74). Um recurso que erra
//! metade do que produz não entra num produto sem suporte.
//!
//! # A chave
//!
//! `option_env!("ACOUSTID_API_KEY")`, em tempo de build, a partir de um
//! segredo do repositório. Build sem o segredo (desenvolvimento, fork)
//! simplesmente não tem chave, e a etapa é pulada **em silêncio** — como o
//! Vagalume sem chave. A chave aparece num lugar só, a query string da
//! consulta: nenhuma mensagem deste módulo a interpola, e as mensagens são
//! todas `&'static str`.
//!
//! # Normalização Unicode
//!
//! O lado Python normaliza para NFC (`_nfc`) porque recebe nome de arquivo do
//! macOS, que chega NFD. Aqui o texto vem do JSON do AcoustID, e a comparação
//! passa por `fold_pt`, que dá a MESMA chave para NFC e NFD — a régua nunca
//! erra por forma de composição. No limite, uma etiqueta proposta pode sair
//! na forma que a API mandou; é diferença invisível na tela, e não vale uma
//! dependência de normalização Unicode inteira.

use crate::error::{AppError, Result};
use crate::lyrics_fetch::{norm, percent_encode, similarity};
use serde_json::Value;
use std::path::Path;
use std::time::Duration;

/// Endereço da consulta. Com o LRCLIB e o Vagalume, um dos TRÊS destinos de
/// rede do funil (o quarto do produto é o GitHub, para atualização e
/// acessórios) — `commands::funil_fetcher` recusa qualquer outro.
pub const LOOKUP_URL: &str = "https://api.acoustid.org/v2/lookup";

/// O AcoustID pede no máximo ~3 consultas por segundo (0,34 s).
pub const PAUSA_ACOUSTID: Duration = Duration::from_millis(340);

/// Pontuação mínima da impressão digital (PRD V6). Abaixo disso o AcoustID
/// está chutando — e chute vindo do ÁUDIO não encosta em etiqueta de curador.
pub const PONTUACAO_MINIMA: f64 = 0.7;

/// Acima disto a duração denuncia outra gravação (regra da V3, uniforme em
/// todo o funil).
pub const MAX_DIF_DURACAO_S: f64 = 15.0;

/// Teto de espera pelo `fpcalc`. Ele lê o arquivo inteiro, mas um minuto de
/// música leva menos de um segundo; passar disto é sinal de binário travado,
/// e uma varredura de 150 arquivos não pode ficar presa em um deles.
const TIMEOUT_FPCALC: Duration = Duration::from_secs(120);

/// Acima disto, duas grafias são o MESMO nome ("Milionário & José Rico" x
/// "Milionário y José Rico"). Calibrado no acervo real de 94 arquivos, onde
/// 6 dos 8 conflitos eram a mesma música escrita de outro jeito.
const LIMIAR_MESMA_GRAFIA: f64 = 0.85;

/// Comprimento mínimo para o teste de contenção não absolver coincidência
/// ("Sol" dentro de "Sol Nascente" são músicas diferentes).
const MIN_CONTENCAO: usize = 5;

/// A API recusou este aplicativo. Como a chave é NOSSA e vem compilada, não
/// há nada que a pessoa possa fazer — a frase não manda ninguém procurar
/// defeito onde não há, e o funil desliga a etapa pelo resto da varredura.
pub const ERRO_CHAVE_RECUSADA: &str =
    "o reconhecimento pelo som não está aceitando este aplicativo agora";

/// A API respondeu, mas não com uma identificação. O texto dela NÃO é
/// repassado: vem em inglês, não explica nada a quem não tem a quem
/// perguntar, e repassar texto de terceiro é o caminho por onde uma chave
/// vaza para a tela.
pub const ERRO_RESPOSTA: &str = "o reconhecimento pelo som respondeu com erro";

/// O `fpcalc` não conseguiu ler o som deste arquivo (ou não rodou). Uma só
/// mensagem para os dois casos porque, para quem está olhando, eles são a
/// mesma coisa: o som não foi lido. Quando é o binário que está quebrado,
/// isto acontece em TODOS os arquivos — e o funil desliga a etapa depois da
/// primeira falha, em vez de repetir a mesma linha 95 vezes (DECISIONS #83).
pub const ERRO_FPCALC: &str = "não foi possível ler o som deste arquivo";

/// A chave do AcoustID compilada nesta build. Vazia = etapa pulada em
/// silêncio.
pub fn chave_acoustid() -> &'static str {
    option_env!("ACOUSTID_API_KEY").unwrap_or("").trim()
}

/// O resumo acústico de um arquivo, do jeito que o `fpcalc -json` o devolve.
#[derive(Debug, Clone)]
pub struct Impressao {
    /// Duração REAL, medida decodificando o áudio. É a melhor prova de
    /// duração que o produto tem: o cabeçalho do MP3 já mentiu por uma ordem
    /// de grandeza (300 s lidos como 2365 s, DECISIONS #72).
    pub duracao: f64,
    pub fingerprint: String,
}

/// O que a etapa 4 devolve: nomes, e só. Nunca letra.
#[derive(Debug, Clone, PartialEq)]
pub struct Identificacao {
    pub titulo: String,
    pub artista: String,
    /// "alta" | "media" — BAIXA não é identificação e nunca chega aqui.
    pub confianca: &'static str,
    pub pontuacao: f64,
}

/// Roda o `fpcalc -json` do cache sobre o arquivo e lê duração e impressão.
///
/// Nada é escrito: o `fpcalc` só lê. O erro é sempre a mesma frase em pt-BR —
/// a saída original vem em inglês e costuma ser um despejo de decodificador.
pub fn impressao_digital(fpcalc: &Path, mp3: &Path) -> Result<Impressao> {
    let mut filho = std::process::Command::new(fpcalc)
        .arg("-json")
        .arg(mp3)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|_| AppError(ERRO_FPCALC.into()))?;

    // Espera com teto: `wait()` puro deixaria a varredura presa para sempre
    // num binário travado, e o "Cancelar" da tela não teria como voltar.
    let limite = std::time::Instant::now() + TIMEOUT_FPCALC;
    loop {
        match filho.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < limite => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Ok(None) => {
                let _ = filho.kill();
                let _ = filho.wait();
                return Err(AppError(ERRO_FPCALC.into()));
            }
            Err(_) => return Err(AppError(ERRO_FPCALC.into())),
        }
    }

    let saida = filho
        .wait_with_output()
        .map_err(|_| AppError(ERRO_FPCALC.into()))?;
    if !saida.status.success() {
        return Err(AppError(ERRO_FPCALC.into()));
    }
    let texto = String::from_utf8_lossy(&saida.stdout);
    let dados: Value = serde_json::from_str(&texto).map_err(|_| AppError(ERRO_FPCALC.into()))?;
    let duracao = dados
        .get("duration")
        .and_then(Value::as_f64)
        .ok_or_else(|| AppError(ERRO_FPCALC.into()))?;
    let fingerprint = dados
        .get("fingerprint")
        .and_then(Value::as_str)
        .filter(|f| !f.is_empty())
        .ok_or_else(|| AppError(ERRO_FPCALC.into()))?;
    Ok(Impressao {
        duracao,
        fingerprint: fingerprint.to_string(),
    })
}

/// Consulta o `/v2/lookup` e devolve os resultados brutos (pontuação +
/// gravações do MusicBrainz).
///
/// Corpo fora de forma NÃO é erro: é "não temos" — a mesma regra do Vagalume,
/// e pela mesma razão (uma página de manutenção não é motivo para marcar a
/// música como falha). Erro DECLARADO pela API vira `Err` com texto fixo.
pub fn consultar_acoustid<F>(
    duracao: f64,
    fingerprint: &str,
    chave: &str,
    fetch: &F,
) -> Result<Vec<Value>>
where
    F: Fn(&str) -> Result<String>,
{
    // a duração vai ARREDONDADA (o Python usa int(round(...))): o AcoustID
    // casa a impressão contra a duração declarada, e truncar erraria por até
    // um segundo em todo arquivo
    let segundos = duracao.max(0.0).round() as i64;
    let url = format!(
        "{LOOKUP_URL}?client={}&meta=recordings&duration={segundos}&fingerprint={}",
        percent_encode(chave),
        percent_encode(fingerprint)
    );
    let corpo = fetch(&url)?;
    let Ok(dados) = serde_json::from_str::<Value>(&corpo) else {
        return Ok(Vec::new());
    };
    let Some(dados) = dados.as_object() else {
        return Ok(Vec::new());
    };
    if dados.get("status").and_then(Value::as_str) != Some("ok") {
        return Err(AppError(ERRO_RESPOSTA.into()));
    }
    Ok(dados
        .get("results")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

/// Confiança a partir da PONTUAÇÃO da impressão digital e da diferença de
/// duração. Porte literal do `classificar` do `tools/curadoria.py`, incluindo
/// a linha `dif is None` — ver o cabeçalho do módulo. `None` aqui é o "BAIXA"
/// do Python: não é identificação.
fn classificar(pontuacao: f64, dif: Option<f64>) -> Option<&'static str> {
    let Some(dif) = dif else {
        // sem duração comparável não há bônus nem desqualificação, e o teto
        // é MÉDIA: nada confirmou este casamento além da própria pontuação
        return (pontuacao >= 0.85).then_some("media");
    };
    if (dif <= 3.0 && pontuacao >= 0.6) || (dif <= 8.0 && pontuacao >= 0.85) {
        Some("alta")
    } else if dif <= 15.0 && pontuacao >= 0.5 {
        Some("media")
    } else {
        None
    }
}

/// Nome do artista de uma gravação do MusicBrainz, respeitando a
/// "joinphrase" das participações ("Gal Costa & Caetano Veloso").
fn artista_da_gravacao(gravacao: &Value) -> String {
    let Some(artistas) = gravacao.get("artists").and_then(Value::as_array) else {
        return String::new();
    };
    let nomes: Vec<(&str, &str)> = artistas
        .iter()
        .filter_map(|a| {
            let nome = a.get("name").and_then(Value::as_str)?.trim();
            (!nome.is_empty())
                .then(|| (nome, a.get("joinphrase").and_then(Value::as_str).unwrap_or("")))
        })
        .collect();
    let mut saida = String::new();
    for (i, (nome, junta)) in nomes.iter().enumerate() {
        saida.push_str(nome);
        if i < nomes.len() - 1 {
            saida.push_str(if junta.is_empty() { " & " } else { junta });
        }
    }
    saida.trim().to_string()
}

/// O melhor candidato do AcoustID, ou nada.
///
/// `duracao_mp3` deve ser a duração PROVADA (a que o `fpcalc` mediu). Zero
/// significa desconhecida: aí a duração simplesmente não entra na conta, em
/// vez de entrar errada — "margem de segurança não protege contra erro de
/// ordem de grandeza; só corroboração protege" (DECISIONS #72).
pub fn escolher_candidato(resultados: &[Value], duracao_mp3: f64) -> Option<Identificacao> {
    let mut melhor: Option<((f64, f64), Identificacao)> = None;
    for res in resultados {
        let pontuacao = res.get("score").and_then(Value::as_f64).unwrap_or(0.0);
        if pontuacao < PONTUACAO_MINIMA {
            continue; // chute
        }
        let Some(gravacoes) = res.get("recordings").and_then(Value::as_array) else {
            continue; // a impressão casou, mas não há título/artista ligados
        };
        for gravacao in gravacoes {
            let titulo = gravacao
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            let artista = artista_da_gravacao(gravacao);
            // metadado de ripador no MusicBrainz é tão inútil quanto no MP3
            if crate::enrich::is_placeholder(&titulo) || crate::enrich::is_placeholder(&artista) {
                continue;
            }
            let duracao = gravacao.get("duration").and_then(Value::as_f64);
            let dif = match (duracao, duracao_mp3) {
                (Some(d), mp3) if mp3 > 0.0 => Some((mp3 - d).abs()),
                _ => None,
            };
            if dif.is_some_and(|d| d > MAX_DIF_DURACAO_S) {
                continue; // outra gravação
            }
            let Some(confianca) = classificar(pontuacao, dif) else {
                continue; // confirmação fraca não é identificação
            };
            // maior pontuação primeiro; empate decide pela duração mais
            // próxima (ausente conta como a mais distante possível)
            let ordem = (pontuacao, -dif.unwrap_or(f64::MAX / 2.0));
            if melhor.as_ref().is_none_or(|(o, _)| ordem > *o) {
                melhor = Some((
                    ordem,
                    Identificacao {
                        titulo,
                        artista,
                        confianca,
                        pontuacao,
                    },
                ));
            }
        }
    }
    melhor.map(|(_, m)| m)
}

/// True quando uma etiqueta REAL existente CONTRADIZ o que o som identificou.
///
/// Porte do `_discorda` do `tools/curadoria.py`. Campo vazio ou placeholder
/// não contradiz nada — só espera ser preenchido. Variação de grafia também
/// não: são a mesma coisa quando as chaves normalizadas são muito parecidas
/// OU quando uma contém a outra ("Lampejo" dentro de "Adventício - Lampejo").
/// Diferença de verdade continua conflito.
///
/// A tolerância de grafia é legítima AQUI, e é o exato caso da DECISIONS #63:
/// ela existe porque a DURAÇÃO confirma o casamento, e no AcoustID a duração
/// confirma. Copiá-la para uma fonte sem duração foi o que gravou "Ponto de
/// Ogum" dentro de "Ponto de Oxum".
pub fn discorda(atual: &str, identificado: &str) -> bool {
    if crate::enrich::is_placeholder(atual) || crate::enrich::is_placeholder(identificado) {
        return false;
    }
    let (a, b) = (norm(atual), norm(identificado));
    if a == b {
        return false;
    }
    let (curta, longa) = if a.len() <= b.len() { (&a, &b) } else { (&b, &a) };
    if curta.chars().count() >= MIN_CONTENCAO && longa.contains(curta.as_str()) {
        return false;
    }
    similarity(&a, &b) < LIMIAR_MESMA_GRAFIA
}

/// Etapa 4 inteira, já com a impressão calculada: consulta o AcoustID e
/// devolve a identificação confirmada, ou nada.
///
/// Sem chave, nada acontece e nada falha (`Ok(None)`, zero rede).
pub fn identificar<F>(impressao: &Impressao, chave: &str, fetch: &F) -> Result<Option<Identificacao>>
where
    F: Fn(&str) -> Result<String>,
{
    let chave = chave.trim();
    if chave.is_empty() {
        return Ok(None);
    }
    let resultados = consultar_acoustid(
        impressao.duracao,
        &impressao.fingerprint,
        chave,
        fetch,
    )?;
    Ok(escolher_candidato(&resultados, impressao.duracao))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[cfg(unix)]
    use std::path::PathBuf;

    fn stub(body: &'static str) -> impl Fn(&str) -> Result<String> {
        move |_url| Ok(body.to_string())
    }

    // -----------------------------------------------------------------------
    // A chave: compilada, opcional, e NUNCA visível
    // -----------------------------------------------------------------------

    /// Sem o segredo no build, a etapa é pulada em SILÊNCIO — o mesmo que já
    /// acontece com o Vagalume sem chave. Nada falha, nada aparece na tela.
    #[test]
    fn sem_chave_de_build_a_etapa_e_pulada_em_silencio() {
        // a suíte roda sem o segredo; se algum dia o CI a definir, o que
        // precisa continuar valendo é a forma (texto simples, sem espaço)
        let chave = chave_acoustid();
        assert_eq!(chave.trim(), chave);
        assert!(
            identificar(&impressao_falsa(), "", &stub("{}"))
                .unwrap()
                .is_none(),
            "chave vazia não consulta nada"
        );
    }

    /// Nenhuma mensagem deste módulo pode carregar a chave: são TEXTO FIXO,
    /// sem interpolação — o mesmo modelo do `mensagem_de_status` do funil.
    #[test]
    fn nenhuma_mensagem_pode_carregar_a_chave() {
        let chave = "chave-secreta-do-acoustid";
        for msg in [ERRO_CHAVE_RECUSADA, ERRO_RESPOSTA, ERRO_FPCALC] {
            assert!(!msg.contains(chave));
            assert!(!msg.contains("apikey") && !msg.contains("client="));
        }
    }

    /// Nem quando a PRÓPRIA API devolve um erro: a mensagem dela não é
    /// repassada. Além do risco de vazar a chave, texto de API em inglês não
    /// explica nada a quem não tem a quem perguntar.
    #[test]
    fn o_erro_da_api_nao_repassa_o_texto_dela() {
        let chave = "chave-secreta-do-acoustid";
        let corpo = format!(
            r#"{{"status": "error", "error": {{"message": "invalid API key {chave}"}}}}"#
        );
        let erro = consultar_acoustid(180.0, "IMPRESSAO", chave, &|_url| Ok(corpo.clone()))
            .expect_err("status error é falha");
        assert_eq!(erro.to_string(), ERRO_RESPOSTA);
        assert!(!erro.to_string().contains(chave));
    }

    // -----------------------------------------------------------------------
    // A consulta
    // -----------------------------------------------------------------------

    /// A URL é a mesma do `consultar_acoustid` do tools/curadoria.py: mesmo
    /// endereço, `meta=recordings`, duração ARREDONDADA para inteiro e a
    /// impressão digital escapada.
    #[test]
    fn a_url_e_a_mesma_do_python() {
        let vista = std::cell::RefCell::new(String::new());
        consultar_acoustid(180.4, "AQAA-x_y", "minha-chave", &|url: &str| {
            *vista.borrow_mut() = url.to_string();
            Ok(r#"{"status": "ok", "results": []}"#.into())
        })
        .unwrap();
        let url = vista.borrow().clone();
        assert!(url.starts_with(LOOKUP_URL), "{url}");
        assert!(url.contains("client=minha-chave"));
        assert!(url.contains("meta=recordings"));
        assert!(url.contains("duration=180"), "duração arredondada: {url}");
        assert!(url.contains("fingerprint=AQAA-x_y"));
    }

    #[test]
    fn duracao_e_arredondada_e_nao_truncada() {
        for (dur, esperado) in [(180.4, "duration=180"), (180.6, "duration=181")] {
            let vista = std::cell::RefCell::new(String::new());
            consultar_acoustid(dur, "F", "k", &|url: &str| {
                *vista.borrow_mut() = url.to_string();
                Ok(r#"{"status": "ok", "results": []}"#.into())
            })
            .unwrap();
            assert!(vista.borrow().contains(esperado), "{dur}");
        }
    }

    #[test]
    fn corpo_fora_de_forma_nao_e_erro_e_sim_lista_vazia() {
        for corpo in ["[]", "\"texto\"", "não é json"] {
            let r = consultar_acoustid(180.0, "F", "k", &|_url| Ok(corpo.to_string()));
            assert_eq!(r.unwrap().len(), 0, "{corpo:?}");
        }
    }

    // -----------------------------------------------------------------------
    // As regras de aceitação — porte do escolher_candidato do Python
    // -----------------------------------------------------------------------

    fn resultado(score: f64, titulo: &str, artista: &str, duracao: Option<f64>) -> serde_json::Value {
        let mut gravacao = json!({
            "title": titulo,
            "artists": [{"name": artista}],
        });
        if let Some(d) = duracao {
            gravacao["duration"] = json!(d);
        }
        json!({"score": score, "recordings": [gravacao]})
    }

    /// A tabela do `classificar` do tools/curadoria.py, caso a caso —
    /// inclusive a linha que o Rust NÃO tinha: sem duração comparável não há
    /// bônus nem desclassificação, e pontuação altíssima ainda rende MÉDIA.
    ///
    /// Esta é a linha que a DECISIONS #63 manda olhar duas vezes: régua
    /// calibrada com duração aplicada onde não há duração foi o erro mais
    /// caro do projeto.
    #[test]
    fn classificar_bate_com_a_tabela_do_python() {
        const CASOS: &[(f64, Option<f64>, Option<&str>)] = &[
            // com duração: as MESMAS regras da V3
            (0.60, Some(3.0), Some("alta")),
            (0.59, Some(3.0), Some("media")),
            (0.85, Some(8.0), Some("alta")),
            (0.84, Some(8.0), Some("media")),
            (0.50, Some(15.0), Some("media")),
            (0.49, Some(15.0), None),
            (1.00, Some(15.1), None),
            // SEM duração comparável: só a pontuação decide, e o teto é MÉDIA
            (1.00, None, Some("media")),
            (0.85, None, Some("media")),
            (0.84, None, None),
            (0.70, None, None),
        ];
        for (pontuacao, dif, esperado) in CASOS {
            assert_eq!(
                classificar(*pontuacao, *dif),
                *esperado,
                "pontuação {pontuacao}, dif {dif:?}"
            );
        }
    }

    /// Pontuação abaixo de 0,7 é chute do AcoustID, e chute vindo do ÁUDIO
    /// não encosta em etiqueta de curador.
    #[test]
    fn pontuacao_abaixo_do_minimo_e_descartada() {
        let baixa = [resultado(0.69, "Asa Branca", "Luiz Gonzaga", Some(180.0))];
        assert!(escolher_candidato(&baixa, 180.0).is_none());
        let alta = [resultado(0.70, "Asa Branca", "Luiz Gonzaga", Some(180.0))];
        assert!(escolher_candidato(&alta, 180.0).is_some());
    }

    /// O TETO DE DURAÇÃO (15 s) é o que separa a gravação certa do homônimo,
    /// e vale mesmo com pontuação perfeita.
    #[test]
    fn o_teto_de_duracao_desqualifica_mesmo_com_pontuacao_perfeita() {
        assert_eq!(MAX_DIF_DURACAO_S, 15.0);
        let fora = [resultado(1.0, "Asa Branca", "Luiz Gonzaga", Some(196.0))];
        assert!(escolher_candidato(&fora, 180.0).is_none(), "16 s fora");
        let dentro = [resultado(1.0, "Asa Branca", "Luiz Gonzaga", Some(195.0))];
        assert!(escolher_candidato(&dentro, 180.0).is_some(), "15 s passa");
    }

    /// A impressão casou, mas o AcoustID não tem título/artista ligados a
    /// ela: não há nada a propor.
    #[test]
    fn resultado_sem_gravacao_nao_identifica_nada() {
        let sem = [json!({"score": 0.95})];
        assert!(escolher_candidato(&sem, 180.0).is_none());
        let vazio = [json!({"score": 0.95, "recordings": []})];
        assert!(escolher_candidato(&vazio, 180.0).is_none());
    }

    /// Metadado de ripador no MusicBrainz é tão inútil quanto no MP3 — e
    /// gravá-lo por cima de um campo vazio pioraria o arquivo.
    #[test]
    fn gravacao_com_placeholder_e_descartada() {
        for (titulo, artista) in [
            ("AudioTrack 05", "Luiz Gonzaga"),
            ("Asa Branca", "Unknown Artist"),
            ("Asa Branca", ""),
            ("", "Luiz Gonzaga"),
        ] {
            let r = [resultado(0.95, titulo, artista, Some(180.0))];
            assert!(
                escolher_candidato(&r, 180.0).is_none(),
                "{titulo:?} / {artista:?}"
            );
        }
    }

    /// BAIXA não é identificação (porte literal do Python).
    ///
    /// Vale reparar ONDE a BAIXA mora depois do corte de pontuação: com
    /// `PONTUACAO_MINIMA` em 0,7, toda diferença de duração dentro do teto de
    /// 15 s rende pelo menos MÉDIA. Sobra um caso só — pontuação entre 0,7 e
    /// 0,85 SEM duração para confirmar —, e é justamente o caso de "casou o
    /// som, mas nada corroborou". A tabela do `classificar` foi conferida
    /// linha a linha contra o `tools/curadoria.py` rodando.
    #[test]
    fn confirmacao_fraca_sem_duracao_para_confirmar_nao_identifica() {
        assert_eq!(classificar(0.84, None), None);
        let sem_duracao = [resultado(0.84, "Asa Branca", "Luiz Gonzaga", None)];
        assert!(escolher_candidato(&sem_duracao, 180.0).is_none());

        // e dentro do teto de duração, 0,7 já é MÉDIA — como no Python
        assert_eq!(classificar(0.70, Some(10.0)), Some("media"));
    }

    /// Sem duração no MP3 (0,0 = desconhecida) não se classifica POR duração
    /// — classifica-se sem ela, em vez de classificar errado.
    #[test]
    fn sem_duracao_do_mp3_a_duracao_nao_entra_na_conta() {
        let r = [resultado(0.95, "Asa Branca", "Luiz Gonzaga", Some(999.0))];
        let m = escolher_candidato(&r, 0.0).expect("sem duração, a pontuação decide");
        assert_eq!(m.confianca, "media", "e o teto é MÉDIA, nunca ALTA");
    }

    #[test]
    fn empate_de_pontuacao_decide_pela_duracao_mais_proxima() {
        let r = [
            resultado(0.9, "Longe", "Alguém", Some(190.0)),
            resultado(0.9, "Perto", "Alguém", Some(181.0)),
        ];
        assert_eq!(escolher_candidato(&r, 180.0).unwrap().titulo, "Perto");
    }

    #[test]
    fn a_maior_pontuacao_vence() {
        let r = [
            resultado(0.75, "Menor", "Alguém", Some(180.0)),
            resultado(0.95, "Maior", "Alguém", Some(180.0)),
        ];
        assert_eq!(escolher_candidato(&r, 180.0).unwrap().titulo, "Maior");
    }

    /// "joinphrase" do MusicBrainz: participação vira UM nome de artista, do
    /// jeito que o MusicBrainz o escreve.
    #[test]
    fn o_artista_respeita_a_juncao_das_participacoes() {
        let g = json!({"artists": [
            {"name": "Gal Costa", "joinphrase": " & "},
            {"name": "Caetano Veloso"}
        ]});
        assert_eq!(artista_da_gravacao(&g), "Gal Costa & Caetano Veloso");

        // sem joinphrase declarada, o padrão do Python é " & "
        let g = json!({"artists": [{"name": "A"}, {"name": "B"}]});
        assert_eq!(artista_da_gravacao(&g), "A & B");

        let g = json!({"artists": [{"name": "Luiz Gonzaga"}]});
        assert_eq!(artista_da_gravacao(&g), "Luiz Gonzaga");

        assert_eq!(artista_da_gravacao(&json!({})), "");
    }

    // -----------------------------------------------------------------------
    // Conflito com etiqueta real (porte do _discorda)
    // -----------------------------------------------------------------------

    /// Os pares medidos no acervo real de 94 arquivos, que calibraram o
    /// `_discorda` do Python. Campo vazio ou placeholder nunca contradiz —
    /// só espera ser preenchido.
    #[test]
    fn discorda_reconhece_variacao_de_grafia_e_condena_musica_diferente() {
        // variação de grafia: mesma música
        assert!(!discorda("Milionário & José Rico", "Milionário y José Rico"));
        assert!(!discorda("Toinho do Alagoas", "Toinho de Alagoas"));
        // contenção: "Lampejo" dentro de "Adventício - Lampejo"
        assert!(!discorda("Adventício - Lampejo", "Lampejo"));
        assert!(!discorda(
            "Marinheiro Só (dj mitsu remix)",
            "Marinheiro Só"
        ));
        // música diferente do mesmo artista: continua conflito
        assert!(discorda("Satania", "Sabrina"));
        assert!(discorda("Ponto de Oxum", "Ponto de Ogum"));
        // contenção curta demais não absolve
        assert!(discorda("Sol", "Sol Nascente"));
        // campo vazio ou placeholder não contradiz nada
        assert!(!discorda("", "Asa Branca"));
        assert!(!discorda("Faixa 05", "Asa Branca"));
        assert!(!discorda("Asa Branca", ""));
    }

    // -----------------------------------------------------------------------
    // Fim a fim
    // -----------------------------------------------------------------------

    fn impressao_falsa() -> Impressao {
        Impressao {
            duracao: 180.0,
            fingerprint: "AQAAxyz".into(),
        }
    }

    #[test]
    fn identificar_devolve_titulo_e_artista_e_nunca_letra() {
        let corpo = r#"{"status": "ok", "results": [
            {"score": 0.95, "recordings": [
                {"title": "Asa Branca", "duration": 181,
                 "artists": [{"name": "Luiz Gonzaga"}]}
            ]}
        ]}"#;
        let m = identificar(&impressao_falsa(), "chave", &stub(corpo))
            .unwrap()
            .expect("identificação confirmada");
        assert_eq!(m.titulo, "Asa Branca");
        assert_eq!(m.artista, "Luiz Gonzaga");
        assert_eq!(m.confianca, "alta");
        assert!((m.pontuacao - 0.95).abs() < 1e-9);
    }

    #[test]
    fn identificar_sem_candidato_confirmado_devolve_nada() {
        let corpo = r#"{"status": "ok", "results": []}"#;
        assert!(identificar(&impressao_falsa(), "chave", &stub(corpo))
            .unwrap()
            .is_none());
    }

    #[test]
    fn erro_de_rede_sobe_para_quem_chamou() {
        let erro = identificar(&impressao_falsa(), "chave", &|_url| {
            Err(AppError("sem conexão".into()))
        })
        .expect_err("erro do fetcher propaga");
        assert_eq!(erro.to_string(), "sem conexão");
    }

    // -----------------------------------------------------------------------
    // O binário: o fpcalc de verdade, executado
    // -----------------------------------------------------------------------

    /// Cria um "fpcalc" de mentira que imprime o que se pedir e sai com o
    /// código pedido.
    #[cfg(unix)]
    fn fpcalc_falso(dir: &Path, saida: &str, codigo: i32) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let caminho = dir.join("fpcalc-falso");
        std::fs::write(
            &caminho,
            format!("#!/bin/sh\ncat <<'FIM'\n{saida}\nFIM\nexit {codigo}\n"),
        )
        .unwrap();
        std::fs::set_permissions(&caminho, std::fs::Permissions::from_mode(0o755)).unwrap();
        caminho
    }

    #[cfg(unix)]
    #[test]
    fn a_impressao_digital_le_duracao_e_fingerprint_do_json() {
        let dir = tempfile::tempdir().unwrap();
        let fpcalc = fpcalc_falso(
            dir.path(),
            r#"{"duration": 210.5, "fingerprint": "AQADtE..."}"#,
            0,
        );
        let mp3 = dir.path().join("x.mp3");
        std::fs::write(&mp3, b"nao importa").unwrap();

        let i = impressao_digital(&fpcalc, &mp3).unwrap();
        assert!((i.duracao - 210.5).abs() < 1e-9);
        assert_eq!(i.fingerprint, "AQADtE...");
    }

    #[cfg(unix)]
    #[test]
    fn fpcalc_que_falha_vira_erro_em_pt_br_sem_detalhe_tecnico() {
        let dir = tempfile::tempdir().unwrap();
        let fpcalc = fpcalc_falso(dir.path(), "ERROR: cannot decode", 1);
        let mp3 = dir.path().join("x.mp3");
        std::fs::write(&mp3, b"nao importa").unwrap();

        let erro = impressao_digital(&fpcalc, &mp3).expect_err("saída 1 é falha");
        assert_eq!(erro.to_string(), ERRO_FPCALC);
    }

    #[cfg(unix)]
    #[test]
    fn saida_do_fpcalc_fora_de_forma_tambem_e_erro() {
        let dir = tempfile::tempdir().unwrap();
        let mp3 = dir.path().join("x.mp3");
        std::fs::write(&mp3, b"nao importa").unwrap();
        for saida in ["não é json", "{}", r#"{"duration": 1}"#] {
            let fpcalc = fpcalc_falso(dir.path(), saida, 0);
            assert_eq!(
                impressao_digital(&fpcalc, &mp3)
                    .expect_err("{saida} deveria falhar")
                    .to_string(),
                ERRO_FPCALC
            );
        }
    }

    #[test]
    fn binario_que_nao_existe_e_erro_e_nao_panico() {
        let erro = impressao_digital(Path::new("/nao/existe/fpcalc"), Path::new("/tmp/x.mp3"))
            .expect_err("binário ausente é falha");
        assert_eq!(erro.to_string(), ERRO_FPCALC);
    }
}
