//! V8/F18 (fase 1) — o Vagalume como SEGUNDA fonte de letra oficial dentro
//! do app, sempre DEPOIS do LRCLIB e só no que ele não tiver.
//!
//! Porte fiel do `tools/curadoria.py` (`buscar_letra_vagalume`,
//! `_confere_estrito`, `_VAGALUME_TIPO_EXATO`, `_VAGALUME_INDISPONIVEL`).
//! Existe por medição: no acervo real (94 arquivos de repertório brasileiro
//! regional/devocional) o LRCLIB cobriu ~3%; o Vagalume é base comunitária
//! brasileira e cobre justamente esse buraco.
//!
//! # Por que esta fonte é mais rígida que o LRCLIB (DECISIONS #63)
//!
//! A API do Vagalume **não tem campo de duração**. A trava que sustenta todo
//! o resto do funil (±3 s = ALTA, >15 s desqualifica) simplesmente não existe
//! aqui. A única prova disponível é textual, e por isso ela é exigida dos
//! DOIS lados e por uma régua PRÓPRIA e estrita — as mesmas palavras, na
//! mesma ordem, sem contenção —, NÃO pela similaridade do LRCLIB: aquela foi
//! afrouxada justamente porque lá a duração confirma o casamento.
//!
//! Sob a régua frouxa o QA mediu colisões graves: "Ponto de Oxum" x "Ponto de
//! Ogum" (0,923), "Ponto de Iansã" x "Ponto de Iemanjá" (0,867), "Cantiga" x
//! "Cantigas" (0,933); e a contenção aceitava "A Volta da Asa Branca" para
//! "Asa Branca". Uma rodada de QA pegou a implementação gravando a letra de
//! "Ponto de Ogum" dentro de um arquivo "Ponto de Oxum" — com a marca de
//! letra OFICIAL. Daí as três travas desta fonte:
//!
//! 1. só `type: "exact"` é aceito — `"aprox"` é literalmente a API dizendo
//!    "isto NÃO é a música que você pediu, é a mais parecida que eu tenho",
//!    e resposta SEM `type` não traz veredito nenhum;
//! 2. título E artista conferidos por igualdade de palavras significativas;
//! 3. sem título E artista para conferir, não se consulta (foi um casamento
//!    sem prova — "Lampejo" com uma faixa do Roberto Carlos — que ensinou
//!    isso ao projeto).
//!
//! # A chave da API
//!
//! Gratuita, do usuário, entra por PARÂMETRO. Ela nunca entra no banco de
//! músicas nem em log, nenhuma mensagem de erro deste módulo a inclui, e ela
//! não é enviada a lugar nenhum além do próprio Vagalume: aparece num lugar
//! só, a query string da consulta. Fica GUARDADA nas preferências locais do
//! aplicativo, na máquina da própria pessoa — mandar ~40 curadores sem
//! suporte redigitar uma chave de API a cada sessão seria pior do que
//! guardá-la. Sem chave, a etapa é pulada em silêncio (`Ok(None)`, zero rede)
//! e o resto do funil segue igual.
//!
//! # Normalização Unicode
//!
//! O lado Python normaliza para NFC antes de enviar (o macOS entrega NFD em
//! nome de arquivo). Aqui o texto enviado vem sempre das TAGS ID3 lidas pelo
//! lofty, e a comparação passa por `fold_pt`, que dá a MESMA chave para NFC e
//! NFD — então a régua nunca erra por causa de forma de composição. O que
//! pode acontecer, no limite, é uma tag NFD não ser encontrada pela API; o
//! resultado é uma busca a menos, nunca uma letra errada.

use crate::error::Result;
use crate::lyrics_fetch::{norm, percent_encode, similarity};

/// Endereço da busca. Junto com o do LRCLIB, é um dos DOIS únicos destinos
/// de rede de todo o produto.
pub const SEARCH_URL: &str = "https://api.vagalume.com.br/search.php";

/// A API responde por tipo. `"exact"` é a ÚNICA resposta aproveitável.
const TIPO_EXATO: &str = "exact";

/// Mensagem (pt-BR) de chave recusada pela API — a chave foi digitada errada
/// ou copiada pela metade, e nenhuma consulta desta varredura vai passar.
///
/// Ela é PRODUZIDA pelo fetcher real (`commands::funil_fetcher`, o único que
/// enxerga o status HTTP) e RECONHECIDA pelo funil (`enrich`), que ao vê-la
/// desliga a etapa do Vagalume pelo resto da varredura em vez de repetir a
/// mesma rejeição em 95 linhas. O acoplamento pelo texto é deliberado: o
/// fetcher é injetável — é assim que a suíte roda sem rede — e a mensagem é
/// o único canal que atravessa a injeção.
pub const ERRO_CHAVE_RECUSADA: &str =
    "a chave do Vagalume foi recusada — confira se copiou a chave inteira";

/// Texto de "não temos esta letra" que a base comunitária às vezes devolve no
/// lugar da letra. Comparado sobre a chave normalizada (sem acento, sem
/// pontuação, minúsculas), então cobre as variações de acento. A lista cresceu
/// com o que o QA viu passando: são convites para o visitante CONTRIBUIR com a
/// letra, não a letra. Todos falam de "a letra" no singular e em posição de
/// objeto — texto de canção de verdade que menciona "letra" ("escrevi a letra
/// dessa canção") não bate com nenhum destes.
const INDISPONIVEL: &[&str] = &[
    "ainda nao temos a letra",
    "nao temos a letra",
    "nao possui letra",
    "nao possuimos a letra",
    "sem letra cadastrada",
    "letra nao cadastrada",
    "letra nao disponivel",
    "letra indisponivel",
    "letra em breve",
    "aguardando revisao",
    "envie a letra",
    "enviar a letra",
    "enviando a letra",
    "adicione a letra",
    "cadastre a letra",
    "colabore com a letra",
];

/// Conectivos que só mudam a GRAFIA de um nome composto: "Milionário y José
/// Rico" x "Milionário & José Rico" x "Sandy e Junior" são o mesmo artista.
/// ("&" já vira espaço no `norm`.) A lista é curta de propósito: tudo que não
/// estiver aqui é palavra que distingue.
const CONECTIVOS: &[&str] = &["e", "y", "and", "feat", "ft", "featuring"];

/// Letra aprovada pela régua estrita, com os nomes que a base devolveu.
///
/// `matched_title`/`matched_artist` existem para a UI poder MOSTRAR de onde a
/// letra veio; o enriquecimento NÃO os propõe como título/artista novos — a
/// régua garante que são as mesmas palavras do que já está no arquivo, e
/// trocar a grafia curada de alguém não é trabalho desta etapa.
#[derive(Debug, Clone)]
pub struct VagalumeMatch {
    pub lyrics: String,
    pub matched_title: String,
    pub matched_artist: String,
}

/// Palavras significativas de um texto: chave normalizada sem os conectivos.
fn palavras_significativas(texto: &str) -> Vec<String> {
    norm(texto)
        .split_whitespace()
        .filter(|p| !CONECTIVOS.contains(p))
        .map(str::to_string)
        .collect()
}

/// Casamento do VAGALUME: as MESMAS palavras, na mesma ordem.
///
/// Passa: acento, caixa, pontuação e conectivo ("&" x "y" x "e").
/// Não passa: qualquer palavra a mais, a menos ou trocada.
///
/// Única flexibilidade, e do lado do PEDIDO: tag de título no formato
/// "Artista - Título" (visto no acervo real) vale também por cada segmento do
/// traço — mas por IGUALDADE de palavras, nunca por contenção.
fn confere_estrito(pedido: &str, devolvido: &str) -> bool {
    let alvo = palavras_significativas(devolvido);
    if alvo.is_empty() {
        return false;
    }
    if palavras_significativas(pedido) == alvo {
        return true;
    }
    segmentos_do_traco(pedido)
        .into_iter()
        .any(|parte| palavras_significativas(parte) == alvo)
}

/// Quebra o pedido nos traços cercados de espaço (`\s+[-–—]\s+` do Python):
/// hífen, meia-risca e travessão.
fn segmentos_do_traco(pedido: &str) -> Vec<&str> {
    let mut partes = Vec::new();
    let mut inicio = 0usize;
    let bytes: Vec<(usize, char)> = pedido.char_indices().collect();
    for (i, (pos, c)) in bytes.iter().enumerate() {
        if !matches!(c, '-' | '\u{2013}' | '\u{2014}') {
            continue;
        }
        let antes = pedido[inicio..*pos].to_string();
        let tem_espaco_antes = antes.ends_with(char::is_whitespace);
        let depois = bytes.get(i + 1).map(|(p, _)| *p).unwrap_or(pedido.len());
        let tem_espaco_depois = pedido[depois..].starts_with(char::is_whitespace);
        if tem_espaco_antes && tem_espaco_depois {
            partes.push(pedido[inicio..*pos].trim());
            inicio = depois;
        }
    }
    if partes.is_empty() {
        return Vec::new(); // sem traço: nada a repartir
    }
    partes.push(pedido[inicio..].trim());
    partes
}

/// True quando o "texto" devolvido é um recado da base, não a letra.
fn letra_indisponivel(letra: &str) -> bool {
    let chave = norm(letra);
    INDISPONIVEL.iter().any(|marca| chave.contains(marca))
}

/// Entidades HTML nomeadas que o desescape resolve.
///
/// A tabela é a do Latin-1 inteiro mais a pontuação tipográfica, porque o
/// outro lado do produto usa o `html.unescape` do Python — que decodifica o
/// HTML5 inteiro — sobre o MESMO texto vindo da MESMA base. O que os dois
/// decodificarem diferente vira diferença DENTRO do arquivo de música: a
/// tabela curta que existia aqui não tinha uma única vogal acentuada, e
/// `Cora&ccedil;&atilde;o` entrava literal no quadro USLT e no índice de
/// busca do player enquanto o `tools/curadoria.py` gravava "Coração".
///
/// `nbsp` é o espaço DURO (U+00A0), não o espaço comum, pelo mesmo motivo:
/// é o caractere que o Python grava.
const NOMEADAS: &[(&str, char)] = &[
    // XML/HTML básicas
    ("amp", '&'), ("lt", '<'), ("gt", '>'), ("quot", '"'),
    ("apos", '\''),
    // espaço e pontuação
    ("nbsp", '\u{A0}'), ("shy", '\u{AD}'), ("ndash", '–'),
    ("mdash", '—'), ("hellip", '…'), ("bull", '•'), ("middot", '·'),
    ("deg", '°'), ("laquo", '«'), ("raquo", '»'), ("lsquo", '‘'),
    ("rsquo", '’'), ("ldquo", '“'), ("rdquo", '”'), ("sbquo", '‚'),
    ("bdquo", '„'), ("dagger", '†'), ("Dagger", '‡'), ("permil", '‰'),
    ("lsaquo", '‹'), ("rsaquo", '›'), ("prime", '′'), ("Prime", '″'),
    // símbolos
    ("copy", '©'), ("reg", '®'), ("trade", '™'), ("sect", '§'),
    ("para", '¶'), ("plusmn", '±'), ("times", '×'), ("divide", '÷'),
    ("micro", 'µ'), ("not", '¬'), ("iexcl", '¡'), ("iquest", '¿'),
    ("cent", '¢'), ("pound", '£'), ("yen", '¥'), ("euro", '€'),
    ("curren", '¤'), ("brvbar", '¦'), ("uml", '¨'), ("macr", '¯'),
    ("acute", '´'), ("cedil", '¸'), ("ordf", 'ª'), ("ordm", 'º'),
    ("sup1", '¹'), ("sup2", '²'), ("sup3", '³'), ("frac14", '¼'),
    ("frac12", '½'), ("frac34", '¾'),
    // A
    ("Agrave", 'À'), ("Aacute", 'Á'), ("Acirc", 'Â'), ("Atilde", 'Ã'),
    ("Auml", 'Ä'), ("Aring", 'Å'), ("AElig", 'Æ'), ("agrave", 'à'),
    ("aacute", 'á'), ("acirc", 'â'), ("atilde", 'ã'), ("auml", 'ä'),
    ("aring", 'å'), ("aelig", 'æ'),
    // C/E
    ("Ccedil", 'Ç'), ("ccedil", 'ç'), ("Egrave", 'È'), ("Eacute", 'É'),
    ("Ecirc", 'Ê'), ("Euml", 'Ë'), ("egrave", 'è'), ("eacute", 'é'),
    ("ecirc", 'ê'), ("euml", 'ë'),
    // I/N
    ("Igrave", 'Ì'), ("Iacute", 'Í'), ("Icirc", 'Î'), ("Iuml", 'Ï'),
    ("igrave", 'ì'), ("iacute", 'í'), ("icirc", 'î'), ("iuml", 'ï'),
    ("Ntilde", 'Ñ'), ("ntilde", 'ñ'),
    // O
    ("Ograve", 'Ò'), ("Oacute", 'Ó'), ("Ocirc", 'Ô'), ("Otilde", 'Õ'),
    ("Ouml", 'Ö'), ("Oslash", 'Ø'), ("ograve", 'ò'), ("oacute", 'ó'),
    ("ocirc", 'ô'), ("otilde", 'õ'), ("ouml", 'ö'), ("oslash", 'ø'),
    // U/Y e resto do Latin-1
    ("Ugrave", 'Ù'), ("Uacute", 'Ú'), ("Ucirc", 'Û'), ("Uuml", 'Ü'),
    ("ugrave", 'ù'), ("uacute", 'ú'), ("ucirc", 'û'), ("uuml", 'ü'),
    ("Yacute", 'Ý'), ("yacute", 'ý'), ("yuml", 'ÿ'), ("ETH", 'Ð'),
    ("eth", 'ð'), ("THORN", 'Þ'), ("thorn", 'þ'), ("szlig", 'ß'),
];

/// Desescapa as entidades HTML que a base devolve no texto da letra
/// (`&ccedil;`, `&quot;`, `&#39;`, `&amp;`...). Sem isto elas entram no MP3 e
/// no índice de busca do player. Cobre as `NOMEADAS` mais as numéricas
/// (decimais e hexadecimais); entidade desconhecida fica como está, que é o
/// comportamento seguro E o do Python — nunca some texto do usuário.
fn unescape_html(texto: &str) -> String {
    if !texto.contains('&') {
        return texto.to_string();
    }
    let mut out = String::with_capacity(texto.len());
    let mut resto = texto;
    while let Some(i) = resto.find('&') {
        out.push_str(&resto[..i]);
        let depois = &resto[i + 1..];
        // entidade tem no máximo ~10 caracteres até o ';'
        let fim = depois
            .char_indices()
            .take(12)
            .find(|(_, c)| *c == ';')
            .map(|(p, _)| p);
        let Some(fim) = fim else {
            out.push('&');
            resto = depois;
            continue;
        };
        let corpo = &depois[..fim];
        let resolvida = if let Some(num) = corpo.strip_prefix('#') {
            let (digitos, base) = match num.strip_prefix(['x', 'X']) {
                Some(hex) => (hex, 16),
                None => (num, 10),
            };
            u32::from_str_radix(digitos, base)
                .ok()
                .and_then(char::from_u32)
        } else {
            NOMEADAS
                .iter()
                .find(|(nome, _)| *nome == corpo)
                .map(|(_, c)| *c)
        };
        match resolvida {
            Some(c) => {
                out.push(c);
                resto = &depois[fim + 1..];
            }
            None => {
                out.push('&');
                resto = depois;
            }
        }
    }
    out.push_str(resto);
    out
}

/// Letra do Vagalume para um título+artista JÁ conhecidos (tag real ou
/// identificação confirmada). Devolve `Ok(None)` para "não temos" e `Err` só
/// para falha de rede — que o lote transforma em erro POR MÚSICA.
///
/// `keep(titulo, artista)` é o mesmo filtro de placeholder que o LRCLIB usa
/// (`query_best`), aplicado aos DOIS lados: no PEDIDO (tag de ripador não vira
/// consulta — nem gasta rede) e em cada entrada da RESPOSTA.
///
/// Entre as entradas que passam a régua, vence a MELHOR (igualdade literal do
/// título primeiro, depois similaridade), não a primeira da lista: `mus` é uma
/// lista e a exata pode vir atrás de uma variação.
pub fn fetch_lyrics_vagalume<F, K>(
    title: &str,
    artist: &str,
    api_key: &str,
    fetch: &F,
    keep: K,
) -> Result<Option<VagalumeMatch>>
where
    F: Fn(&str) -> Result<String>,
    K: Fn(&str, &str) -> bool,
{
    // 1. sem chave: etapa pulada em silêncio, zero rede
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Ok(None);
    }
    // 2. sem os DOIS lados não há o que conferir: não se consulta
    let (title, artist) = (title.trim(), artist.trim());
    if title.is_empty() || artist.is_empty() {
        return Ok(None);
    }
    // 3. tag de ripador não identifica nada: não se consulta
    if !keep(title, artist) {
        return Ok(None);
    }

    let url = format!(
        "{SEARCH_URL}?art={}&mus={}&apikey={}",
        percent_encode(artist),
        percent_encode(title),
        percent_encode(api_key)
    );
    let body = fetch(&url)?;

    // Corpo vazio/inválido/fora de forma = "não temos" (nunca erro): a base
    // responde 404 com corpo vazio para música que não conhece, e uma página
    // de manutenção não é motivo para marcar a música como falha de rede.
    let Ok(dados) = serde_json::from_str::<serde_json::Value>(&body) else {
        return Ok(None);
    };
    let Some(dados) = dados.as_object() else {
        return Ok(None);
    };

    // `aprox` é a API dizendo que devolveu OUTRA música; sem `type` não há
    // veredito nenhum em que se apoiar.
    if dados.get("type").and_then(|v| v.as_str()) != Some(TIPO_EXATO) {
        return Ok(None);
    }

    let artista_res = dados
        .get("art")
        .and_then(|v| v.get("name"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let Some(musicas) = dados.get("mus").and_then(|v| v.as_array()) else {
        return Ok(None);
    };

    let mut melhor: Option<((u8, f64), VagalumeMatch)> = None;
    for musica in musicas {
        let Some(musica) = musica.as_object() else {
            continue;
        };
        let titulo_res = musica
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let letra = unescape_html(musica.get("text").and_then(|v| v.as_str()).unwrap_or(""))
            .trim()
            .to_string();
        if letra.is_empty() || letra_indisponivel(&letra) {
            continue;
        }
        if !keep(&titulo_res, &artista_res) {
            continue;
        }
        if !(confere_estrito(title, &titulo_res) && confere_estrito(artist, &artista_res)) {
            continue;
        }
        let nota = (
            u8::from(norm(title) == norm(&titulo_res)),
            similarity(title, &titulo_res),
        );
        let melhor_ate_agora = melhor
            .as_ref()
            .is_none_or(|(n, _)| nota.0 > n.0 || (nota.0 == n.0 && nota.1 > n.1));
        if melhor_ate_agora {
            melhor = Some((
                nota,
                VagalumeMatch {
                    lyrics: letra,
                    matched_title: titulo_res,
                    matched_artist: artista_res.clone(),
                },
            ));
        }
    }
    Ok(melhor.map(|(_, m)| m))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn confere_estrito_demands_the_same_words_in_the_same_order() {
        assert!(confere_estrito("Água Viva", "AGUA VIVA"));
        assert!(confere_estrito("Água Viva", "água  viva!"));
        // conectivos são grafia, não palavra que distingue
        assert!(confere_estrito("Milionário & José Rico", "Milionario y Jose Rico"));
        assert!(confere_estrito("Sandy e Junior", "Sandy & Junior"));
        // palavra a mais, a menos ou trocada: não confere
        assert!(!confere_estrito("Ponto de Oxum", "Ponto de Ogum"));
        assert!(!confere_estrito("Cantiga", "Cantigas"));
        assert!(!confere_estrito("Asa Branca", "A Volta da Asa Branca"));
        assert!(!confere_estrito("Canoeiro", "Canoeiro II"));
        // ordem importa
        assert!(!confere_estrito("Viva Água", "Água Viva"));
        // devolvido vazio (ou só conectivo) nunca confere
        assert!(!confere_estrito("Água Viva", ""));
        assert!(!confere_estrito("Água Viva", " & "));
    }

    #[test]
    fn confere_estrito_accepts_a_segment_of_a_dash_separated_request() {
        assert!(confere_estrito("Coral Novo - Água Viva", "Água Viva"));
        assert!(confere_estrito("Coral Novo – Água Viva", "Coral Novo"));
        assert!(confere_estrito("Coral Novo — Água Viva", "Água Viva"));
        // por IGUALDADE de palavras, nunca por contenção
        assert!(!confere_estrito("Coral Novo - Água Viva", "Água"));
        // hífen sem espaços NÃO reparte ("Luso-Brasileiro" é uma palavra só)
        assert!(!confere_estrito("Luso-Brasileiro", "Luso"));
    }

    #[test]
    fn letra_indisponivel_catches_the_communitys_placeholder_texts() {
        assert!(letra_indisponivel("Ainda não temos a letra desta música"));
        assert!(letra_indisponivel("AINDA NAO TEMOS A LETRA"));
        assert!(letra_indisponivel("Envie a letra!"));
        // letra de verdade que menciona a palavra "letra" continua valendo
        assert!(!letra_indisponivel("Escrevi a letra dessa canção"));
        assert!(!letra_indisponivel("Primeira linha\nSegunda linha"));
    }

    #[test]
    fn unescape_html_resolves_named_and_numeric_entities() {
        assert_eq!(unescape_html("a &amp; b"), "a & b");
        assert_eq!(unescape_html("&quot;vem&quot;"), "\"vem\"");
        assert_eq!(unescape_html("&#39;agora&#39;"), "'agora'");
        assert_eq!(unescape_html("&#xE9;"), "é");
        // entidade desconhecida ou & solto ficam como estão
        assert_eq!(unescape_html("Tim & Tom"), "Tim & Tom");
        assert_eq!(unescape_html("&naoexiste;"), "&naoexiste;");
        assert_eq!(unescape_html("100% & 50%"), "100% & 50%");
        // texto sem entidade nenhuma passa intacto
        assert_eq!(unescape_html("linha\nlinha"), "linha\nlinha");
    }

    /// Paridade com o `html.unescape` do Python, entrada por entrada.
    ///
    /// O mesmo texto de letra passa pelos DOIS stacks — pelo
    /// `tools/curadoria.py` no terminal da curadoria e por aqui no app —, e o
    /// que sair diferente vai para dentro do MP3 e para o índice de busca do
    /// player. A tabela curta de antes não tinha uma única entidade acentuada:
    /// `Cora&ccedil;&atilde;o` virava "Coração" no Python e ficava literal
    /// aqui. Cada par abaixo foi conferido contra o `html.unescape`.
    #[test]
    fn unescape_html_matches_pythons_html_unescape() {
        const CASOS: &[(&str, &str)] = &[
            ("Cora&ccedil;&atilde;o", "Coração"),
            ("&eacute;", "é"),
            ("&aacute;", "á"),
            // `&nbsp;` é espaço DURO (U+00A0), não o espaço ASCII: é o que o
            // Python grava, e trocá-lo mudaria o texto entre os dois stacks
            ("a&nbsp;b", "a\u{A0}b"),
            (
                "Ma&ccedil;&atilde; &agrave; noite, &Eacute; ver&atilde;o",
                "Maçã à noite, É verão",
            ),
            (
                "&Aacute;gua &Ccedil;&eacute;u &Iacute;ndio &Oacute;timo &Uacute;nico",
                "Água Çéu Índio Ótimo Único",
            ),
            (
                "&agrave;&aacute;&acirc;&atilde;&auml; &egrave;&eacute;&ecirc;&euml;",
                "àáâãä èéêë",
            ),
            (
                "&igrave;&iacute;&icirc;&iuml; &ograve;&oacute;&ocirc;&otilde;&ouml;",
                "ìíîï òóôõö",
            ),
            ("&ugrave;&uacute;&ucirc;&uuml; &ccedil;&ntilde;&yacute;", "ùúûü çñý"),
            (
                "&Agrave;&Aacute;&Acirc;&Atilde;&Auml; &Egrave;&Eacute;&Ecirc;&Euml;",
                "ÀÁÂÃÄ ÈÉÊË",
            ),
            (
                "&Igrave;&Iacute;&Icirc;&Iuml; &Ograve;&Oacute;&Ocirc;&Otilde;&Ouml;",
                "ÌÍÎÏ ÒÓÔÕÖ",
            ),
            ("&Ugrave;&Uacute;&Ucirc;&Uuml; &Ccedil;&Ntilde;&Yacute;", "ÙÚÛÜ ÇÑÝ"),
            ("&lsquo;a&rsquo; &ldquo;b&rdquo;", "‘a’ “b”"),
            ("um&ndash;dois&mdash;tr&ecirc;s", "um–dois—três"),
            ("retic&ecirc;ncias&hellip;", "reticências…"),
            ("30&deg;C", "30°C"),
            ("a&middot;b", "a·b"),
            ("&laquo;citado&raquo;", "«citado»"),
            ("&apos;agora&apos;", "'agora'"),
            ("&amp; &lt; &gt; &quot;", "& < > \""),
            ("&#39;a&#39; &#xE9; &#233;", "'a' é é"),
            // entidade que não existe sai LITERAL, como no Python — nunca
            // some texto do usuário
            ("&naoexiste;", "&naoexiste;"),
            ("Tim & Tom", "Tim & Tom"),
            ("100% & 50%", "100% & 50%"),
            ("linha\nlinha", "linha\nlinha"),
        ];
        for (entrada, esperado) in CASOS {
            assert_eq!(&unescape_html(entrada), esperado, "entrada {entrada:?}");
        }
    }

    /// Nome repetido na tabela é sempre defeito: a primeira ocorrência vence
    /// em silêncio e a segunda (a que alguém acabou de acrescentar) nunca
    /// entra em vigor.
    #[test]
    fn the_named_entity_table_has_no_duplicates() {
        let mut nomes: Vec<&str> = NOMEADAS.iter().map(|(n, _)| *n).collect();
        nomes.sort_unstable();
        let total = nomes.len();
        nomes.dedup();
        assert_eq!(nomes.len(), total, "há entidade repetida em NOMEADAS");
    }
}
