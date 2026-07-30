//! F10 (PRD V4) — busca de letra no LRCLIB (https://lrclib.net/api/search).
//!
//! O app é 100% offline em todos os fluxos, EXCETO as etapas de rede do funil
//! de curadoria (`enrich_folder_scan` e `enrich_song_scan`), que injetam o
//! `commands::funil_fetcher`. São os únicos pontos de rede do produto, todos
//! acionados por clique explícito.
//!
//! V8/F18 — a porta antiga deste módulo (o comando "Buscar letra na
//! internet", que consultava o LRCLIB fora do funil) SAIU junto com o botão
//! que a chamava: superfície de rede sem chamador é superfície de rede a
//! menos num produto cujo contrato é "rede só nos pontos enumerados". O que
//! ficou é o que o funil usa: `query_best` (melhor candidato de uma consulta)
//! e `classify` (o corte de confiança).
//!
//! O fetcher é injetável (`F: Fn(&str) -> Result<String>`) para os testes
//! rodarem sem rede. Score portado do tools/curadoria.py (V3): similaridade
//! textual normalizada + bônus/descarte por diferença de duração.

use crate::db::fold_pt;
use crate::error::{AppError, Result};
use std::collections::HashMap;

/// Endereço da busca. Com o `lyrics_ovh` e o `fingerprint` (AcoustID), é um
/// dos TRÊS destinos que o `commands::funil_fetcher` aceita — ele recusa
/// qualquer outro. O Vagalume era o quarto e SAIU (DECISIONS #110).
pub const SEARCH_URL: &str = "https://lrclib.net/api/search";

/// Percent-encode de um valor de query string (RFC 3986: só unreserved
/// passam sem escape) — evita depender de crate para meia dúzia de bytes.
/// Compartilhado com o `lyrics_ovh` (V10).
pub(crate) fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Normalização de comparação (igual à _norm_comparacao do curadoria.py):
/// minúsculas + sem acento (fold_pt), pontuação vira espaço, espaços
/// colapsados. Reusada pelo enrich (F13) na detecção de placeholders.
pub(crate) fn norm(s: &str) -> String {
    fold_pt(s)
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

// ---------------------------------------------------------------------------
// A similaridade: porte do difflib.SequenceMatcher.ratio() do Python
// ---------------------------------------------------------------------------
//
// QA A1 — ATÉ A v0.9.0 ISTO ERA COEFICIENTE DE DICE SOBRE BIGRAMAS, e o
// comentário dizia "comparável ao difflib.ratio". Não era comparável o
// bastante: TODOS os limiares que o Rust usa sobre esta função nasceram no
// `tools/curadoria.py`, onde `similaridade()` é `difflib.SequenceMatcher(None,
// a, b).ratio()` — o 0,85 do `fingerprint::LIMIAR_MESMA_GRAFIA` (calibrado
// contra um acervo real de 94 arquivos) e os 0,6/0,85/0,5 do `classify` logo
// abaixo. Usar número calibrado com uma métrica sobre outra métrica é a
// DECISIONS #63 literal, escrita por engano dentro do código em vez de numa
// fonte de letra.
//
// A MEDIÇÃO (49 pares de nomes do repertório, rotulados à mão em "mesma coisa,
// outra grafia" e "outra música"; a contenção é resolvida por regra própria e
// ficou fora):
//
//   |                 | falsos conflitos | conflitos perdidos |
//   |-----------------|------------------|--------------------|
//   | Dice    @ 0,85  |        8         |         1          |
//   | difflib @ 0,85  |        1         |         3          |
//
// E o melhor limiar POSSÍVEL de cada métrica erra o mesmo tanto: 4 erros para
// o difflib (em 0,857) e 4 para o Dice (em 0,667). As duas faixas se
// sobrepõem nas duas métricas — "Ponto de Oxum" x "Ponto de Ogum" (músicas
// diferentes) pontua ACIMA de "Roda Viva" x "Roda Vida" (a mesma) nas duas.
// **Nenhum limiar separa as classes**, porque a diferença entre Oxum e Ogum é
// semântica e a régua é de caracteres. Recalibrar o Dice, portanto, não
// compraria acerto: compraria um número novo, tirado de um corpus que EU
// escrevi, no lugar de um número tirado de um acervo real — trocar a
// DECISIONS #63 por ela mesma um degrau adiante.
//
// Por que o Dice erra tanto mais na faixa que interessa: uma troca de UM
// caractere destrói DOIS bigramas, e em nome curto ("Luiz"/"Luis", "Viva"/
// "Vida") isso é uma fração enorme do total. O difflib conta caracteres
// casados, então perde um. Nome de artista brasileiro é curto e de grafia
// variável, e é exatamente ali que a diferença aparece — nas cadeias longas
// do LRCLIB ("título artista" concatenados) as duas métricas quase coincidem.
//
// O erro também não é simétrico em custo, e é isso que decide a DIREÇÃO:
// falso conflito faz o funil voltar antes das etapas de letra (a música fica
// sem letra e a tela acusa a etiqueta certa), enquanto conflito perdido só
// devolve o comportamento de quem não baixou o acessório — a etiqueta real é
// preservada de qualquer jeito, nada errado é gravado. Condenar não é o lado
// conservador.

/// Casamentos totais entre `a` e `b`, pelo algoritmo do
/// `difflib.SequenceMatcher.get_matching_blocks()`: acha o maior bloco comum e
/// recorre à ESQUERDA e à DIREITA dele (nunca cruzado — é o que faz o difflib
/// não ser um casamento de conjuntos).
fn casamentos(a: &[char], b: &[char]) -> usize {
    // b2j: onde cada caractere de `b` aparece. O `autojunk` do difflib
    // descarta os caracteres populares demais, e só a partir de 200
    // elementos — nomes nunca chegam lá, mas o porte inclui a regra para não
    // divergir no dia em que alguém comparar textos longos.
    let mut b2j: HashMap<char, Vec<usize>> = HashMap::new();
    for (j, c) in b.iter().enumerate() {
        b2j.entry(*c).or_default().push(j);
    }
    if b.len() >= 200 {
        let teto = b.len() / 100 + 1;
        b2j.retain(|_, js| js.len() <= teto);
    }

    let mut total = 0;
    let mut fila = vec![(0usize, a.len(), 0usize, b.len())];
    while let Some((alo, ahi, blo, bhi)) = fila.pop() {
        let (i, j, k) = maior_bloco(a, b, &b2j, alo, ahi, blo, bhi);
        if k == 0 {
            continue;
        }
        total += k;
        if alo < i && blo < j {
            fila.push((alo, i, blo, j));
        }
        if i + k < ahi && j + k < bhi {
            fila.push((i + k, ahi, j + k, bhi));
        }
    }
    total
}

/// O `find_longest_match` do difflib, restrito a `a[alo..ahi]` e
/// `b[blo..bhi]`: devolve (início em a, início em b, tamanho). Empate fica
/// com o bloco que começa mais cedo em `a` e depois mais cedo em `b` — o
/// desempate importa, porque muda a recursão e portanto o total.
fn maior_bloco(
    a: &[char],
    b: &[char],
    b2j: &HashMap<char, Vec<usize>>,
    alo: usize,
    ahi: usize,
    blo: usize,
    bhi: usize,
) -> (usize, usize, usize) {
    let (mut besti, mut bestj, mut bestsize) = (alo, blo, 0usize);
    // j2len[j] = tamanho do bloco que termina em a[i-1]/b[j]
    let mut j2len: HashMap<usize, usize> = HashMap::new();
    for (i, ca) in a.iter().enumerate().take(ahi).skip(alo) {
        let mut novo: HashMap<usize, usize> = HashMap::new();
        for &j in b2j.get(ca).map(Vec::as_slice).unwrap_or(&[]) {
            if j < blo {
                continue;
            }
            if j >= bhi {
                break;
            }
            // j == 0 não tem antecessor: `wrapping_sub` cai num índice que
            // nunca é chave, que é o mesmo que o `j2len.get(j-1, 0)` do
            // Python faz com o -1
            let k = j2len.get(&j.wrapping_sub(1)).copied().unwrap_or(0) + 1;
            novo.insert(j, k);
            if k > bestsize {
                (besti, bestj, bestsize) = (i + 1 - k, j + 1 - k, k);
            }
        }
        j2len = novo;
    }
    // Estende o bloco pelas pontas. No difflib isto serve para reabsorver os
    // caracteres "populares" purgados do b2j; sem `isjunk` (é sempre `None`
    // aqui) é só isto que existe.
    while besti > alo && bestj > blo && a[besti - 1] == b[bestj - 1] {
        (besti, bestj, bestsize) = (besti - 1, bestj - 1, bestsize + 1);
    }
    while besti + bestsize < ahi
        && bestj + bestsize < bhi
        && a[besti + bestsize] == b[bestj + bestsize]
    {
        bestsize += 1;
    }
    (besti, bestj, bestsize)
}

/// Similaridade textual em [0, 1] entre as chaves normalizadas: o
/// `difflib.SequenceMatcher.ratio()` do `tools/curadoria.py`, 2·M/T sobre os
/// caracteres casados. Ver o bloco acima para a medição que decidiu o porte.
///
/// No `lyrics_ovh` (V10) ela NÃO decide se o casamento vale — lá a régua é a
/// igualdade de palavras (`confere_estrito`) — e serve só de desempate entre
/// entradas que já passaram por ela.
pub(crate) fn similarity(a: &str, b: &str) -> f64 {
    let (a, b) = (norm(a), norm(b));
    if a == b {
        // Única divergência deliberada do Python: lá dois vazios dão 1,0 (a
        // fórmula 2·M/T com T = 0). Aqui valem 0,0, porque a resposta é usada
        // para decidir IDENTIDADE — dois campos vazios não são a mesma
        // música, são dois nadas. Nenhum chamador chega aqui com vazio (o
        // `discorda` para no placeholder, o `query_best` no filtro `keep`), e
        // a guarda existe para o dia em que um chegue.
        return if a.is_empty() { 0.0 } else { 1.0 };
    }
    let (ca, cb): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let total = ca.len() + cb.len();
    2.0 * casamentos(&ca, &cb) as f64 / total as f64
}

/// Melhor candidato bruto de UMA consulta ao LRCLIB, antes do corte de
/// confiança. Reutilizado pelo enriquecimento em lote (F13), que itera vários
/// palpites e compara os scores entre eles.
#[derive(Debug, Clone)]
pub(crate) struct ScoredCandidate {
    pub lyrics: String,
    pub matched_title: String,
    pub matched_artist: String,
    pub sim: f64,
    pub dif: f64,
    pub score: f64,
}

/// Confiança pelas regras da V3: ALTA se (dif ≤ 3 e sim ≥ 0.6) ou
/// (sim ≥ 0.85 e dif ≤ 8); MÉDIA se sim ≥ 0.5 e dif ≤ 15; senão None
/// (nada confiável — vira BAIXA no enriquecimento em lote).
pub(crate) fn classify(sim: f64, dif: f64) -> Option<&'static str> {
    if (dif <= 3.0 && sim >= 0.6) || (sim >= 0.85 && dif <= 8.0) {
        Some("alta")
    } else if sim >= 0.5 && dif <= 15.0 {
        Some("media")
    } else {
        None
    }
}

/// Consulta o LRCLIB por "titulo artista" e escolhe o melhor candidato pelas
/// regras da V3 (sem aplicar o corte de confiança — use `classify`):
/// - candidato sem plainLyrics (vazio/nulo) ou sem duração: descartado;
/// - candidato reprovado no filtro `keep(trackName, artistName)`: descartado
///   (o enriquecimento em lote descarta resultados placeholder por aqui);
/// - diferença de duração > 15 s: descartado (homônimo/versão errada);
/// - score = similaridade("titulo artista", "trackName artistName")
///   + 0.3 se dif ≤ 3 s, + 0.15 se dif ≤ 8 s.
pub(crate) fn query_best<F, K>(
    title: &str,
    artist: &str,
    duration_seconds: f64,
    fetch: &F,
    keep: K,
) -> Result<Option<ScoredCandidate>>
where
    F: Fn(&str) -> Result<String>,
    K: Fn(&str, &str) -> bool,
{
    let alvo = format!("{} {}", title.trim(), artist.trim());
    let alvo = alvo.trim();
    let url = format!("{SEARCH_URL}?q={}", percent_encode(alvo));
    let body = fetch(&url)?;

    let results: Vec<serde_json::Value> = serde_json::from_str(&body)
        .map_err(|e| AppError(format!("resposta inválida do LRCLIB: {e}")))?;

    let mut best: Option<ScoredCandidate> = None;
    for res in &results {
        let lyrics = res
            .get("plainLyrics")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if lyrics.trim().is_empty() {
            continue; // instrumental / sem letra: candidato descartado
        }
        let Some(dur) = res.get("duration").and_then(|v| v.as_f64()) else {
            continue; // sem duração não há como validar (curadoria.py: BAIXA)
        };
        let dif = (duration_seconds - dur).abs();
        if dif > 15.0 {
            continue; // homônimo/versão errada: desclassificado
        }
        let track = res.get("trackName").and_then(|v| v.as_str()).unwrap_or("");
        let artist_name = res
            .get("artistName")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if !keep(track, artist_name) {
            continue; // ex.: resultado placeholder do LRCLIB (F13)
        }
        let candidato = format!("{track} {artist_name}");
        let sim = similarity(alvo, candidato.trim());
        let bonus = if dif <= 3.0 {
            0.3
        } else if dif <= 8.0 {
            0.15
        } else {
            0.0
        };
        let score = sim + bonus;
        if best.as_ref().is_none_or(|b| score > b.score) {
            best = Some(ScoredCandidate {
                lyrics: lyrics.to_string(),
                matched_title: track.to_string(),
                matched_artist: artist_name.to_string(),
                sim,
                dif,
                score,
            });
        }
    }
    Ok(best)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stub(body: &'static str) -> impl Fn(&str) -> Result<String> {
        move |_url| Ok(body.to_string())
    }

    /// Candidato do LRCLIB já aprovado pelo corte de confiança.
    #[derive(Debug)]
    struct Achado {
        lyrics: String,
        matched_title: String,
        matched_artist: String,
        confidence: &'static str,
    }

    /// O que o funil faz com UMA consulta ao LRCLIB: melhor candidato
    /// (`query_best`) mais o corte de confiança (`classify`). Este par era o
    /// miolo do comando `fetch_lyrics_online`, que saiu junto com o botão que
    /// o chamava (V8/F18); o comportamento continua sendo o que o funil usa,
    /// e continua coberto por estes testes.
    fn melhor<F>(
        title: &str,
        artist: &str,
        duration_seconds: f64,
        fetch: F,
    ) -> Result<Option<Achado>>
    where
        F: Fn(&str) -> Result<String>,
    {
        let Some(best) = query_best(title, artist, duration_seconds, &fetch, |_, _| true)? else {
            return Ok(None);
        };
        Ok(classify(best.sim, best.dif).map(|confidence| Achado {
            lyrics: best.lyrics,
            matched_title: best.matched_title,
            matched_artist: best.matched_artist,
            confidence,
        }))
    }

    #[test]
    fn alta_match_by_close_duration() {
        let body = r#"[{
            "trackName": "Coração Sertanejo",
            "artistName": "Artista Teste",
            "duration": 181.0,
            "plainLyrics": "Quando o sol amanhecer\nMeu coração vai cantar"
        }]"#;
        let m = melhor("Coração Sertanejo", "Artista Teste", 180.0, stub(body))
            .unwrap()
            .expect("dif 1s + texto idêntico ⇒ match");
        assert_eq!(m.confidence, "alta");
        assert_eq!(m.matched_title, "Coração Sertanejo");
        assert_eq!(m.matched_artist, "Artista Teste");
        assert!(m.lyrics.contains("amanhecer"));
    }

    #[test]
    fn duration_divergent_over_15s_is_discarded() {
        let body = r#"[{
            "trackName": "Coração Sertanejo",
            "artistName": "Artista Teste",
            "duration": 200.0,
            "plainLyrics": "letra qualquer"
        }]"#;
        // texto idêntico mas 20s de diferença: homônimo/versão errada
        let m = melhor("Coração Sertanejo", "Artista Teste", 180.0, stub(body))
            .unwrap();
        assert!(m.is_none());
    }

    #[test]
    fn media_confidence_when_duration_between_8_and_15s() {
        let body = r#"[{
            "trackName": "Coração Sertanejo",
            "artistName": "Artista Teste",
            "duration": 190.0,
            "plainLyrics": "letra"
        }]"#;
        // sim 1.0 mas dif 10s: nem dif≤3, nem dif≤8 ⇒ MÉDIA
        let m = melhor("Coração Sertanejo", "Artista Teste", 180.0, stub(body))
            .unwrap()
            .expect("sim alta com dif 10s ⇒ média");
        assert_eq!(m.confidence, "media");
    }

    #[test]
    fn low_similarity_returns_none_even_with_matching_duration() {
        let body = r#"[{
            "trackName": "Outra Coisa Completamente Diferente",
            "artistName": "Ninguém Conhecido",
            "duration": 180.0,
            "plainLyrics": "letra"
        }]"#;
        let m = melhor("Coração Sertanejo", "Artista Teste", 180.0, stub(body))
            .unwrap();
        assert!(m.is_none());
    }

    #[test]
    fn empty_results_return_none() {
        assert!(melhor("T", "A", 100.0, stub("[]"))
            .unwrap()
            .is_none());
    }

    #[test]
    fn empty_or_null_plain_lyrics_candidates_are_discarded() {
        let body = r#"[
            {"trackName": "Coração Sertanejo", "artistName": "Artista Teste",
             "duration": 180.0, "plainLyrics": ""},
            {"trackName": "Coração Sertanejo", "artistName": "Artista Teste",
             "duration": 180.0, "plainLyrics": null},
            {"trackName": "Coração Sertanejo", "artistName": "Artista Teste",
             "duration": 180.0}
        ]"#;
        let m = melhor("Coração Sertanejo", "Artista Teste", 180.0, stub(body))
            .unwrap();
        assert!(m.is_none(), "instrumental/sem letra nunca vira match");
    }

    #[test]
    fn invalid_json_is_an_error() {
        assert!(melhor("T", "A", 100.0, stub("not json")).is_err());
        // objeto em vez de lista também é inválido
        assert!(melhor("T", "A", 100.0, stub(r#"{"erro": 1}"#)).is_err());
    }

    #[test]
    fn fetch_error_propagates() {
        let err = melhor("T", "A", 100.0, |_url| {
            Err(AppError("sem conexão".into()))
        })
        .expect_err("erro do fetcher propaga");
        assert_eq!(err.to_string(), "sem conexão");
    }

    #[test]
    fn best_candidate_wins_by_score() {
        // dois candidatos plausíveis: o de duração mais próxima (bônus 0.3)
        // deve vencer o de duração mais distante
        let body = r#"[
            {"trackName": "Coração Sertanejo", "artistName": "Artista Teste",
             "duration": 187.0, "plainLyrics": "letra do mais distante"},
            {"trackName": "Coração Sertanejo", "artistName": "Artista Teste",
             "duration": 181.0, "plainLyrics": "letra do mais próximo"}
        ]"#;
        let m = melhor("Coração Sertanejo", "Artista Teste", 180.0, stub(body))
            .unwrap()
            .unwrap();
        assert_eq!(m.lyrics, "letra do mais próximo");
        assert_eq!(m.confidence, "alta");
    }

    #[test]
    fn url_is_percent_encoded_with_title_and_artist() {
        let captured = std::cell::RefCell::new(String::new());
        let _ = melhor("Coração & Vida", "São João", 100.0, |url| {
            *captured.borrow_mut() = url.to_string();
            Ok("[]".into())
        })
        .unwrap();
        assert_eq!(
            captured.borrow().as_str(),
            "https://lrclib.net/api/search?q=Cora%C3%A7%C3%A3o%20%26%20Vida%20S%C3%A3o%20Jo%C3%A3o"
        );
    }

    #[test]
    fn similarity_is_diacritic_and_case_insensitive() {
        assert!(similarity("Coração Sertanejo", "CORACAO SERTANEJO") > 0.99);
        assert!(similarity("Coração Sertanejo", "xyz abc") < 0.2);
    }

    /// A MEDIÇÃO que decidiu o porte (QA A1).
    ///
    /// Os limiares de todo o funil — 0,85 do `LIMIAR_MESMA_GRAFIA`, e os
    /// 0,6/0,85/0,5 do `classify` logo abaixo — nasceram no
    /// `tools/curadoria.py`, onde `similaridade()` é
    /// `difflib.SequenceMatcher.ratio()`. Enquanto esta função foi Dice de
    /// bigramas, o Rust usava números calibrados contra OUTRA métrica: a
    /// DECISIONS #63 escrita por engano no código.
    ///
    /// Os valores esperados abaixo foram lidos do Python rodando, par a par
    /// (`difflib.SequenceMatcher(None, _norm_comparacao(a),
    /// _norm_comparacao(b)).ratio()`). Se algum dia esta função divergir de
    /// novo, é aqui que se vê.
    #[test]
    fn a_similaridade_reproduz_o_difflib_do_python() {
        // (a, b, ratio medido no Python, Dice que esta função devolvia antes)
        const MEDIDO: &[(&str, &str, f64, f64)] = &[
            ("Ponto de Oxum", "Ponto de Ogum", 0.9231, 0.8333),
            ("Luiz Gonzaga", "Luis Gonzaga", 0.9167, 0.8182),
            ("Nilson Chaves", "Nilton Chaves", 0.9231, 0.8333),
            ("Cabocla Jurema", "Cabocla Jurama", 0.9286, 0.8462),
            ("Zé Pilintra", "Zé Pelintra", 0.9091, 0.8000),
            ("Roda Viva", "Roda Vida", 0.8889, 0.7500),
            ("Ponto de Iemanjá", "Ponto de Iansã", 0.8667, 0.7143),
            ("Milionário & José Rico", "Milionário y José Rico", 0.9524, 0.9500),
            ("Toinho do Alagoas", "Toinho de Alagoas", 0.9412, 0.8750),
            ("Adventício - Lampejo", "Lampejo", 0.5600, 0.5217),
            ("Satania", "Sabrina", 0.4286, 0.1667),
            ("Sol", "Sol Nascente", 0.4000, 0.3077),
            ("Asa Branca", "Asa Morena", 0.6000, 0.3333),
            ("Tim Maia", "Tom Jobim", 0.3529, 0.2667),
            ("Roberto Carlos", "Erasmo Carlos", 0.7407, 0.6400),
            ("Alcione", "Alceu Valença", 0.4000, 0.2222),
        ];
        for (a, b, difflib, dice) in MEDIDO {
            let s = similarity(a, b);
            assert!(
                (s - difflib).abs() < 5e-4,
                "{a:?} x {b:?}: esperado {difflib} (difflib do Python), veio {s}"
            );
            // e o par é justamente um em que as duas métricas DISCORDAM —
            // sem isso o teste passaria mesmo se nada tivesse sido portado
            if (difflib - dice).abs() > 0.01 {
                assert!((s - dice).abs() > 0.01, "{a:?} x {b:?}: ainda é Dice");
            }
        }
    }

    /// O `ratio` do difflib é 2·M/T sobre os blocos casados, e conta
    /// caracteres — não bigramas. Casos de borda do algoritmo, para o porte
    /// não passar só nos nomes brasileiros da medição.
    #[test]
    fn o_ratio_portado_bate_com_os_casos_de_borda_do_difflib() {
        // vazio contra vazio: o difflib dá 1,0, mas aqui vale 0,0 (ver a
        // função) — nada não é igual a nada para efeito de identificação
        assert_eq!(similarity("", ""), 0.0);
        assert_eq!(similarity("", "Asa Branca"), 0.0);
        assert_eq!(similarity("Asa Branca", "Asa Branca"), 1.0);
        // uma letra só de cada lado, diferentes: nenhum bloco casa
        assert_eq!(similarity("a", "b"), 0.0);
        // o Dice devolvia 0,0 aqui (nenhuma string tem 2 caracteres); o
        // difflib casa o "a" e dá 2·1/3
        assert!((similarity("a", "ab") - 2.0 / 3.0).abs() < 1e-9);
        // Blocos em ordem trocada: o difflib NÃO é distância de edição nem
        // conjunto de bigramas — ele casa o maior bloco e recorre só à
        // ESQUERDA e à DIREITA dele. Em "ab cd" x "cd ab" isso deixa 2
        // caracteres casados de 10, e não os 4 que um casamento de conjuntos
        // daria: 2·2/10 = 0,4. É o caso que separa o porte de verdade de uma
        // aproximação parecida.
        assert!((similarity("ab cd", "cd ab") - 0.4).abs() < 1e-9);
    }
}
