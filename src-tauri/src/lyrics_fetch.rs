//! F10 (PRD V4) — busca de letra no LRCLIB (https://lrclib.net/api/search).
//!
//! O app é 100% offline em todos os fluxos, EXCETO as etapas de rede do funil
//! de curadoria (`enrich_folder_scan` e `enrich_song_scan`), que injetam o
//! fetcher `ureq` daqui e do `vagalume`. São os únicos pontos de rede do
//! produto, todos acionados por clique explícito.
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

/// Endereço da busca. Junto com o do Vagalume (V8/F18), é um dos DOIS únicos
/// destinos de rede de todo o produto — `commands::funil_fetcher` recusa
/// qualquer outro.
pub const SEARCH_URL: &str = "https://lrclib.net/api/search";

/// Percent-encode de um valor de query string (RFC 3986: só unreserved
/// passam sem escape) — evita depender de crate para meia dúzia de bytes.
/// Compartilhado com o `vagalume` (V8/F18).
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

fn bigrams(s: &str) -> HashMap<(char, char), usize> {
    let chars: Vec<char> = s.chars().collect();
    let mut map = HashMap::new();
    for w in chars.windows(2) {
        *map.entry((w[0], w[1])).or_insert(0) += 1;
    }
    map
}

/// Similaridade textual em [0, 1]: coeficiente de Dice sobre bigramas de
/// caracteres das strings normalizadas (sem dependência nova; comparável ao
/// difflib.ratio usado no curadoria.py).
///
/// No Vagalume (V8/F18) ela NÃO decide se o casamento vale — lá a régua é a
/// igualdade de palavras (`confere_estrito`) — e serve só de desempate entre
/// entradas que já passaram por ela.
pub(crate) fn similarity(a: &str, b: &str) -> f64 {
    let (a, b) = (norm(a), norm(b));
    if a == b {
        return if a.is_empty() { 0.0 } else { 1.0 };
    }
    let (ba, bb) = (bigrams(&a), bigrams(&b));
    let (na, nb): (usize, usize) = (ba.values().sum(), bb.values().sum());
    if na == 0 || nb == 0 {
        return 0.0; // uma das strings tem < 2 chars e elas diferem
    }
    let inter: usize = ba
        .iter()
        .map(|(k, v)| v.min(bb.get(k).unwrap_or(&0)))
        .sum();
    (2.0 * inter as f64) / ((na + nb) as f64)
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
}
