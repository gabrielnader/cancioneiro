//! V10 — etapa 4 do funil: **lyrics.ovh, a fonte de letra SEM CHAVE.**
//!
//! # Por que ela entrou, e por que ela entrou NA FRENTE do Vagalume
//!
//! A API do Vagalume está **descontinuada e sem suporte oficial**. Some-se a
//! isso o que já se sabia: o dono do produto nunca conseguiu a chave, o site
//! esteve fora do ar, e o nosso código de Vagalume **nunca rodou contra a API
//! real** — ele atravessou centenas de testes com o `fetch` injetado e zero
//! contato com o serviço. Uma etapa assim é peso morto atrás de uma tela
//! pedindo uma chave que ninguém tem.
//!
//! O `lyrics.ovh` não pede chave nenhuma. Por isso ela vem ANTES: a etapa com
//! chave é a que quase ninguém alcança, e pôr a sem-chave depois dela seria
//! deixar a única fonte utilizável atrás de um pedágio.
//!
//! **E então o Vagalume foi REMOVIDO** (DECISIONS #110): não desligado, não
//! rebaixado a extra opcional — removido, porque código que nunca rodou contra
//! a realidade é pior que código ausente, e existir custa mais que zero (um
//! campo de chave numa tela para 40 pessoas leigas, um parágrafo explicando o
//! campo, um destino a mais na lista, atrito em toda refatoração). O parágrafo
//! que dizia o contrário sobreviveu à remoção e foi achado pelo QA na
//! v0.10.0 — é a DECISIONS #84 outra vez: **documentação que mente é defeito,
//! mesmo quando o comportamento é o certo.** O que ficou dele está em
//! `casamento_estrito.rs`, e é o que importava.
//!
//! # Isto NÃO promete cobertura
//!
//! Medido no acervo real (94 arquivos de repertório brasileiro regional e
//! devocional), o LRCLIB cobriu **~3%**. O `lyrics.ovh` não vai mudar essa
//! ordem de grandeza: ele entra para **eliminar a exigência de chave**, não
//! para achar mais letra. Quem resolve este repertório é a etapa 5, a
//! transcrição — e ela resolve ouvindo o áudio, não consultando base nenhuma.
//!
//! # Por que esta fonte é tão rígida quanto o Vagalume era (DECISIONS #63)
//!
//! O `lyrics.ovh` **não devolve duração**. A trava que sustenta o resto do
//! funil (±3 s = ALTA, >15 s desqualifica) não existe aqui, exatamente como
//! não existia no Vagalume. A única prova disponível é textual, e por isso vale
//! a MESMA régua estrita — `casamento_estrito::confere_estrito`, a função, não
//! uma cópia dela: fonte sem duração é uma CATEGORIA, e foi a régua frouxa do
//! LRCLIB reusada numa fonte sem duração que gravou a letra de "Ponto de Ogum"
//! dentro de um arquivo "Ponto de Oxum".
//!
//! Daí as três travas, herdadas inteiras:
//!
//! 1. título E artista conferidos por igualdade de palavras significativas;
//! 2. sem título E artista REAIS para conferir, não se consulta — foi um
//!    casamento sem prova ("Lampejo" com uma faixa do Roberto Carlos) que
//!    ensinou isso ao projeto;
//! 3. confiança **MÉDIA, nunca ALTA**: sem duração não há confirmação
//!    independente, e ALTA chega PRÉ-MARCADA na revisão (DECISIONS #49).
//!
//! # A fraqueza desta fonte, escrita para não ser esquecida
//!
//! **O `lyrics.ovh` não devolve título nem artista.** Não há segundo lado para
//! conferir: nem o `type: "exact"` que o Vagalume devolvia, nem nomes para o
//! `confere_estrito` comparar. Se o serviço fizer casamento aproximado
//! por dentro — e não há como saber daqui —, ele pode devolver a letra de
//! "Ponto de Ogum" para um pedido de "Ponto de Oxum" **e o programa não tem
//! como perceber**. Esta é a única etapa do funil cujo casamento não é
//! verificável por nós.
//!
//! O que compensa isso é tudo o que sobra, e é pouco de propósito:
//!
//! - só se consulta com título E artista REAIS (nada de placeholder, nada de
//!   palpite de nome de arquivo);
//! - **não se consulta com título composto** ("Adventício - Lampejo"): sem
//!   resposta verificável, não se adivinha qual metade é o título;
//! - confiança **MÉDIA**, então a linha nunca chega pré-marcada e **alguém lê
//!   a letra antes de ela entrar no arquivo** (DECISIONS #49);
//! - a proposta não troca nome nenhum — a letra é a mudança inteira.
//!
//! Nenhuma dessas travas é prova. A prova, aqui, é o olho de quem revisa.
//!
//! # O formato da resposta
//!
//! `GET https://api.lyrics.ovh/v1/{artista}/{titulo}` devolve
//! `{"lyrics": "..."}`. **Não foi possível confirmar contra o serviço real**:
//! o proxy deste ambiente recusa o host (`CONNECT tunnel failed, 403`), como
//! recusa o Hugging Face e o próprio LRCLIB. Então os dois formatos plausíveis
//! são tratados, e tudo o que não é uma letra vira "não temos" em vez de erro:
//!
//! - `{"lyrics": "..."}` — a letra;
//! - `{"error": "No lyrics found"}` — não temos;
//! - 404 (que o `funil_fetcher` transforma em corpo vazio) — não temos;
//! - corpo que não é JSON, ou JSON sem `lyrics` — não temos.
//!
//! **Nada aqui vira erro por não achar letra.** Erro é só falha de rede, e
//! esta fonte cai com frequência: falha dela é erro DAQUELA MÚSICA e a fila
//! segue, exatamente como a falha do `fpcalc` num arquivo (QA A2).

use crate::error::Result;
use crate::lyrics_fetch::percent_encode;
use crate::casamento_estrito::{letra_indisponivel, segmentos_do_traco, unescape_html};

/// Endereço da consulta. Ponto de rede ENUMERADO: com o LRCLIB e o AcoustID,
/// um dos **três** destinos que o `commands::funil_fetcher` aceita (ver
/// `commands::Destino`, que tem exatamente estes três). Fora do funil há um
/// quarto endereço no produto inteiro, o GitHub do download de acessórios e da
/// atualização, guardado por `destino_de_acessorio_permitido`.
pub const SEARCH_URL: &str = "https://api.lyrics.ovh/v1/";

/// Mensagem (pt-BR) quando o serviço respondeu com erro. Ela é PRODUZIDA pelo
/// fetcher real (o único que enxerga o status HTTP) e chega à linha daquela
/// música — **nunca desliga a etapa**: este serviço cai com frequência, e
/// desligar no primeiro soluço deixaria as outras 149 músicas com a aparência
/// de conferidas (QA A2).
///
/// Sem número de código e sem texto de sistema: quem lê não tem a quem
/// perguntar, e "502" não explica nada.
pub const ERRO_FORA_DO_AR: &str = "o site de letras sem cadastro está fora do ar agora";

/// **A ressalva que TEM de chegar à tela.**
///
/// Esta fonte não devolve título nem artista: não há segundo lado para
/// conferir, e o programa não tem como saber se a letra que veio é mesmo desta
/// música (ver "A fraqueza desta fonte", acima). O teto MÉDIA garante que a
/// linha não chegue pré-marcada — mas isso só protege alguém que saiba **por
/// quê**.
///
/// O uso real: numa revisão de 53 músicas o dono do produto disse *"nem li as
/// sugestões em baixa, não deu vontade de ler mesmo"*. Uma linha MÉDIA dizendo
/// só "letra encontrada" convida ao clique, e o clique grava letra dentro do
/// arquivo de alguém. Silenciar uma incerteza que o programa CONHECE é a
/// DECISIONS #86 pelo avesso.
///
/// Vai no campo `aviso` da proposta — o que explica uma linha que a pessoa
/// PODE aplicar —, nunca no `error`, que desabilita a linha. E vale só para
/// esta etapa: o LRCLIB confere pela duração e o som tem a régua do AcoustID,
/// e poluir aquelas linhas com uma ressalva que não se aplica a elas ensinaria
/// a ignorar todas.
pub const AVISO_SEM_CONFERENCIA: &str = "este site não diz a que música a letra \
     pertence, então não deu para conferir se ela é desta — vale ler antes de aplicar";

/// Letra aprovada pela régua estrita, com os nomes que foram PEDIDOS.
///
/// O `lyrics.ovh` não devolve título nem artista — devolve só a letra —, então
/// os nomes aqui são os do pedido. Isso é conveniente e é também a verdade: a
/// régua garante que a letra é da música pedida, e esta etapa não propõe
/// trocar nome nenhum.
#[derive(Debug, Clone, PartialEq)]
pub struct LyricsOvhMatch {
    pub lyrics: String,
    pub matched_title: String,
    pub matched_artist: String,
}

/// A letra que veio no corpo, ou `None` para qualquer forma de "não temos".
///
/// Separada da consulta para o teste poder varrer os formatos sem tocar a
/// rede — e porque é aqui que mora a decisão "isto não é uma letra".
fn letra_do_corpo(corpo: &str) -> Option<String> {
    let dados: serde_json::Value = serde_json::from_str(corpo).ok()?;
    let bruta = dados.as_object()?.get("lyrics")?.as_str()?;
    // CRLF vira LF: o texto vai para um quadro USLT e para o índice de busca,
    // e um '\r' sobrando aparece na tela de quem lê. Conversão inócua — ela
    // não apaga nem junta linha nenhuma.
    let letra = unescape_html(bruta).replace("\r\n", "\n").replace('\r', "\n");
    let letra = letra.trim().to_string();
    // Recado da base no lugar da letra ("ainda não temos a letra") reusa a
    // MESMA lista do `casamento_estrito` (onde ela nasceu, no módulo do
    // Vagalume): é o mesmo tipo de conteúdo, e uma segunda lista divergiria
    // (DECISIONS #80).
    if letra.is_empty() || letra_indisponivel(&letra) {
        return None;
    }
    Some(letra)
}

/// Letra do `lyrics.ovh` para um título+artista JÁ conhecidos (tag real ou
/// identificação confirmada pelo som).
///
/// `Ok(None)` é "não temos" — inclusive quando não há o que conferir. `Err` é
/// só falha de rede, e o funil a transforma em erro POR MÚSICA.
///
/// `keep(titulo, artista)` é o mesmo filtro de placeholder do LRCLIB, aplicado
/// ao PEDIDO: tag de ripador não vira consulta nem gasta rede.
pub fn fetch_lyrics_ovh<F, K>(
    title: &str,
    artist: &str,
    fetch: &F,
    keep: K,
) -> Result<Option<LyricsOvhMatch>>
where
    F: Fn(&str) -> Result<String>,
    K: Fn(&str, &str) -> bool,
{
    // 1. sem os DOIS lados não há o que conferir: não se consulta. É a trava
    //    que a decisão 63 comprou com a letra errada dentro de um arquivo.
    let (title, artist) = (title.trim(), artist.trim());
    if title.is_empty() || artist.is_empty() {
        return Ok(None);
    }
    // 2. tag de ripador não identifica nada: não se consulta
    if !keep(title, artist) {
        return Ok(None);
    }
    // 3. título COMPOSTO não é título. Uma tag "Adventício - Lampejo" (visto no
    //    acervo real) tem duas metades e nenhuma pista de qual é o nome da
    //    música. O Vagalume podia tentar as duas porque devolvia os nomes e o
    //    `confere_estrito` julgava a resposta; aqui não volta nada para
    //    julgar, então tentar seria adivinhar — e o preço do palpite errado é
    //    a letra de outra música dentro do arquivo de alguém (DECISIONS #63).
    //    Quem resolve este caso é a etapa 2: com o nome vindo do som, o pedido
    //    chega limpo aqui.
    if !segmentos_do_traco(title).is_empty() || !segmentos_do_traco(artist).is_empty() {
        return Ok(None);
    }

    // artista e título são SEGMENTOS DE CAMINHO, não query string: o
    // `percent_encode` escapa tudo o que não é `unreserved`, inclusive a barra
    // — sem isso um artista com "/" no nome viraria outro caminho.
    let url = format!(
        "{SEARCH_URL}{}/{}",
        percent_encode(artist),
        percent_encode(title)
    );
    let corpo = fetch(&url)?;

    let Some(letra) = letra_do_corpo(&corpo) else {
        return Ok(None);
    };
    // Não há régua a aplicar sobre a RESPOSTA: ela é só a letra. O que
    // protege esta etapa está todo acima desta linha, mais o teto MÉDIA que o
    // funil impõe — ver "A fraqueza desta fonte" no cabeçalho.
    Ok(Some(LyricsOvhMatch {
        lyrics: letra,
        matched_title: title.to_string(),
        matched_artist: artist.to_string(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::AppError;
    use crate::lyrics_fetch::{norm, similarity};

    /// Filtro de placeholder igual ao do funil.
    fn manter(t: &str, a: &str) -> bool {
        !crate::enrich::is_placeholder(crate::enrich::Campo::Titulo, t)
            && !crate::enrich::is_placeholder(crate::enrich::Campo::Artista, a)
    }

    fn corpo(body: &'static str) -> impl Fn(&str) -> Result<String> {
        move |_url| Ok(body.to_string())
    }

    // -----------------------------------------------------------------------
    // O endereço
    // -----------------------------------------------------------------------

    /// Artista e título vão como SEGMENTOS DE CAMINHO, escapados. Um artista
    /// com barra no nome não pode virar outro caminho, e um com acento não
    /// pode virar bytes crus na URL.
    #[test]
    fn a_url_escapa_os_segmentos_do_caminho() {
        let vista = std::cell::RefCell::new(String::new());
        fetch_lyrics_ovh(
            "Coração",
            "AC/DC",
            &|url: &str| {
                *vista.borrow_mut() = url.to_string();
                Ok(r#"{"lyrics": "uma letra"}"#.into())
            },
            manter,
        )
        .unwrap()
        .expect("a letra vem");
        let url = vista.borrow().clone();
        assert!(url.starts_with(SEARCH_URL), "{url}");
        assert!(url.contains("AC%2FDC"), "a barra é escapada: {url}");
        assert!(url.contains("Cora%C3%A7%C3%A3o"), "o acento também: {url}");
        // artista antes do título, como o endpoint pede
        assert!(
            url.find("AC%2FDC").unwrap() < url.find("Cora").unwrap(),
            "artista/titulo, nesta ordem: {url}"
        );
    }

    /// Nenhuma chave em lugar nenhum — é a razão de esta fonte existir.
    #[test]
    fn a_consulta_nao_leva_chave_nenhuma() {
        let vista = std::cell::RefCell::new(String::new());
        let _ = fetch_lyrics_ovh(
            "Asa Branca",
            "Luiz Gonzaga",
            &|url: &str| {
                *vista.borrow_mut() = url.to_string();
                Ok("{}".into())
            },
            manter,
        );
        let url = vista.borrow().clone();
        for suspeito in ["apikey", "api_key", "key=", "token"] {
            assert!(!url.contains(suspeito), "{url} tem {suspeito}");
        }
    }

    // -----------------------------------------------------------------------
    // As travas herdadas: só se consulta quando há o que conferir
    // -----------------------------------------------------------------------

    /// Sem título E artista REAIS não se consulta — zero rede. Foi um
    /// casamento sem prova ("Lampejo" com uma faixa do Roberto Carlos) que
    /// ensinou isso ao projeto, e esta fonte não tem duração para se apoiar.
    #[test]
    fn sem_os_dois_lados_reais_nao_se_consulta() {
        for (titulo, artista) in [
            ("Asa Branca", ""),
            ("", "Luiz Gonzaga"),
            ("   ", "  "),
            // placeholder de ripador conta como VAZIO
            ("Faixa 03", "Luiz Gonzaga"),
            ("Asa Branca", "Unknown Artist"),
            ("AudioTrack 02", "Artista Desconhecido"),
            // V10 — e o rótulo de coletânea também
            ("Asa Branca", "Various Artists"),
        ] {
            let chamadas = std::cell::Cell::new(0);
            let r = fetch_lyrics_ovh(
                titulo,
                artista,
                &|_url: &str| {
                    chamadas.set(chamadas.get() + 1);
                    Ok(r#"{"lyrics": "uma letra qualquer"}"#.into())
                },
                manter,
            )
            .unwrap();
            assert!(r.is_none(), "{titulo:?}/{artista:?} não devolve letra");
            assert_eq!(chamadas.get(), 0, "{titulo:?}/{artista:?} gastou rede");
        }
    }

    // -----------------------------------------------------------------------
    // Os formatos da resposta — nenhum deles vira ERRO
    // -----------------------------------------------------------------------

    /// A forma documentada.
    #[test]
    fn o_formato_com_letra_devolve_a_letra() {
        let m = fetch_lyrics_ovh(
            "Asa Branca",
            "Luiz Gonzaga",
            &corpo(r#"{"lyrics": "Quando olhei a terra ardendo\nQual fogueira de São João"}"#),
            manter,
        )
        .unwrap()
        .expect("a letra vem");
        assert_eq!(
            m.lyrics,
            "Quando olhei a terra ardendo\nQual fogueira de São João"
        );
        // os nomes são os PEDIDOS: a fonte não devolve nome para propor
        assert_eq!(m.matched_title, "Asa Branca");
        assert_eq!(m.matched_artist, "Luiz Gonzaga");
    }

    /// **Não achar letra NUNCA é erro.** Se fosse, uma varredura de 150
    /// músicas num repertório de cobertura ~3% terminaria com 145 linhas
    /// vermelhas culpando a internet de quem está olhando.
    #[test]
    fn nada_que_nao_seja_letra_vira_erro() {
        const CORPOS: &[&str] = &[
            // o "não temos" que a API declara
            r#"{"error": "No lyrics found"}"#,
            // 404 → o funil_fetcher entrega corpo vazio
            "",
            // objeto sem o campo
            "{}",
            // letra vazia ou só espaço
            r#"{"lyrics": ""}"#,
            r#"{"lyrics": "   \n  "}"#,
            // tipo errado no campo
            r#"{"lyrics": null}"#,
            r#"{"lyrics": 42}"#,
            r#"{"lyrics": ["a"]}"#,
            // não é objeto
            "[]",
            "\"texto\"",
            // página de manutenção: não é JSON
            "<html><body>502 Bad Gateway</body></html>",
            "não é json",
        ];
        for c in CORPOS {
            let r = fetch_lyrics_ovh(
                "Asa Branca",
                "Luiz Gonzaga",
                &|_url: &str| Ok(c.to_string()),
                manter,
            );
            assert!(
                matches!(r, Ok(None)),
                "{c:?} deveria ser \"não temos\", e veio {r:?}"
            );
        }
    }

    /// Recado da base no lugar da letra reusa a MESMA lista do
    /// `casamento_estrito` — é o mesmo tipo de conteúdo, e uma segunda lista
    /// divergiria (DECISIONS #80).
    #[test]
    fn recado_no_lugar_da_letra_nao_e_letra() {
        for recado in [
            "Ainda não temos a letra desta música",
            "Letra não disponível",
            "Envie a letra desta canção",
        ] {
            let corpo = format!(r#"{{"lyrics": {}}}"#, serde_json::to_string(recado).unwrap());
            let r = fetch_lyrics_ovh(
                "Asa Branca",
                "Luiz Gonzaga",
                &|_url: &str| Ok(corpo.clone()),
                manter,
            )
            .unwrap();
            assert!(r.is_none(), "{recado:?}");
        }
        // ...e o texto de canção que MENCIONA "letra" continua sendo letra
        let m = fetch_lyrics_ovh(
            "Asa Branca",
            "Luiz Gonzaga",
            &corpo(r#"{"lyrics": "Escrevi a letra dessa canção pra você"}"#),
            manter,
        )
        .unwrap();
        assert!(m.is_some(), "menção legítima a \"letra\" não é recado");
    }

    /// O texto sai sem `\r`: ele vai para um quadro USLT e para o índice de
    /// busca, e um retorno de carro sobrando aparece na tela de quem lê. A
    /// conversão não apaga nem junta linha nenhuma.
    #[test]
    fn o_texto_sai_sem_retorno_de_carro() {
        let m = fetch_lyrics_ovh(
            "Asa Branca",
            "Luiz Gonzaga",
            &corpo("{\"lyrics\": \"primeira\\r\\nsegunda\\rterceira\"}"),
            manter,
        )
        .unwrap()
        .unwrap();
        assert_eq!(m.lyrics, "primeira\nsegunda\nterceira");
        assert!(!m.lyrics.contains('\r'));
    }

    /// Entidade HTML é desescapada pela MESMA tabela do `casamento_estrito`: o mesmo
    /// texto passando por dois caminhos não pode chegar diferente ao arquivo
    /// (DECISIONS #89 — `Cora&ccedil;&atilde;o` entrava literal no índice).
    #[test]
    fn entidade_html_e_desescapada_pela_mesma_tabela() {
        let m = fetch_lyrics_ovh(
            "Coração",
            "Alguém",
            &corpo(r#"{"lyrics": "Cora&ccedil;&atilde;o &amp; alma"}"#),
            manter,
        )
        .unwrap()
        .unwrap();
        assert_eq!(m.lyrics, "Coração & alma");
    }

    /// Falha de rede sobe para quem chamou, e o funil a transforma em erro
    /// daquela música — nunca em desligamento da etapa (QA A2).
    #[test]
    fn falha_de_rede_sobe_para_quem_chamou() {
        let erro = fetch_lyrics_ovh(
            "Asa Branca",
            "Luiz Gonzaga",
            &|_url: &str| Err(AppError(ERRO_FORA_DO_AR.into())),
            manter,
        )
        .expect_err("erro do fetcher propaga");
        assert_eq!(erro.to_string(), ERRO_FORA_DO_AR);
    }

    /// A mensagem não repassa texto de sistema nem número de código: quem lê
    /// não tem a quem perguntar, e "502" não explica nada (QA M4).
    #[test]
    fn a_mensagem_nao_repassa_texto_de_sistema() {
        let m = ERRO_FORA_DO_AR;
        for suspeito in ["502", "504", "error", "gateway", "timeout", "os error"] {
            assert!(!m.to_lowercase().contains(suspeito), "{m} tem {suspeito}");
        }
        assert!(m.chars().next().is_some_and(char::is_lowercase));
    }

    /// A ressalva obedece à régua de copy da DECISIONS #100: cabe em duas
    /// frases e 210 caracteres, começa dizendo o que é, e **não tem jargão
    /// nosso** — ela aparece crua na tela de quem não sabe o que é uma API.
    #[test]
    fn a_ressalva_obedece_a_regua_da_copy() {
        let a = AVISO_SEM_CONFERENCIA;
        assert!(
            a.chars().count() <= 210,
            "{} caracteres, o teto é 210",
            a.chars().count()
        );
        assert!(a.chars().next().is_some_and(char::is_lowercase));
        assert!(!a.contains('\n') && !a.contains("  "), "texto corrido: {a:?}");
        for jargao in [
            "api", "endpoint", "json", "fonte", "casamento", "lyrics.ovh",
            "http", "campo", "régua", "duração",
        ] {
            assert!(
                !a.to_lowercase().contains(jargao),
                "{a:?} tem jargão: {jargao}"
            );
        }
        // e ela DIZ as três coisas que a pessoa precisa naquele segundo: que o
        // site não identifica a música, que por isso não foi conferida, e o
        // que fazer a respeito
        assert!(a.contains("não diz a que música"));
        assert!(a.contains("não deu para conferir"));
        assert!(a.contains("ler antes de aplicar"));
    }

    /// **Título COMPOSTO não vira consulta.** Uma tag "Adventício - Lampejo"
    /// tem duas metades e nenhuma pista de qual é o nome da música. O Vagalume
    /// podia tentar as duas porque devolvia os nomes para o `confere_estrito`
    /// julgar; aqui não volta nada para julgar, então tentar seria adivinhar —
    /// e o preço do palpite errado é a letra de outra música dentro do arquivo
    /// de alguém (DECISIONS #63).
    #[test]
    fn titulo_composto_nao_vira_consulta() {
        for (titulo, artista) in [
            ("Adventício - Lampejo", "Adventício"),
            ("Luiz Gonzaga - Asa Branca", "Luiz Gonzaga"),
            ("Asa Branca", "Luiz Gonzaga - convidados"),
            // travessão e meia-risca contam igual
            ("Adventício — Lampejo", "Adventício"),
            ("Adventício – Lampejo", "Adventício"),
        ] {
            let chamadas = std::cell::Cell::new(0);
            let r = fetch_lyrics_ovh(
                titulo,
                artista,
                &|_url: &str| {
                    chamadas.set(chamadas.get() + 1);
                    Ok(r#"{"lyrics": "uma letra qualquer"}"#.into())
                },
                manter,
            )
            .unwrap();
            assert!(r.is_none(), "{titulo:?}/{artista:?}");
            assert_eq!(chamadas.get(), 0, "{titulo:?} gastou rede");
        }
        // ...e o hífen SEM espaço em volta é parte do nome, não separador
        let m = fetch_lyrics_ovh(
            "Bem-te-vi",
            "Luiz Gonzaga",
            &corpo(r#"{"lyrics": "uma letra qualquer"}"#),
            manter,
        )
        .unwrap();
        assert!(m.is_some(), "hífen dentro da palavra não é composição");
    }

    /// **A fraqueza desta fonte, fixada em teste para não ser esquecida.** Ela
    /// não devolve título nem artista: não há segundo lado a conferir, e a
    /// régua estrita — que existe e é uma só — não tem onde morder. O que
    /// protege é o teto MÉDIA (que o funil impõe) e o olho de quem revisa.
    ///
    /// O par que a régua condenaria, se houvesse resposta para julgar, está
    /// aqui como lembrete de qual é o risco.
    #[test]
    fn esta_fonte_nao_tem_como_conferir_o_casamento() {
        // a régua estrita condena o par...
        assert!(!crate::casamento_estrito::confere_estrito(
            "Ponto de Oxum",
            "Ponto de Ogum"
        ));
        // ...e a similaridade frouxa do LRCLIB o absolveria — é o erro que a
        // DECISIONS #63 registrou
        assert!(similarity(&norm("Ponto de Oxum"), &norm("Ponto de Ogum")) > 0.85);
        // mas aqui a resposta é SÓ a letra: nada volta com nome para conferir
        let m = fetch_lyrics_ovh(
            "Ponto de Oxum",
            "Alguém",
            &corpo(r#"{"lyrics": "letra que poderia ser de outra música"}"#),
            manter,
        )
        .unwrap()
        .expect("a letra chega");
        assert_eq!(m.matched_title, "Ponto de Oxum", "o nome é o PEDIDO");
        assert_eq!(
            m.matched_artist, "Alguém",
            "a fonte não devolve nome nenhum para comparar"
        );
    }
}
