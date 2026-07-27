//! F10 (PRD V4) — busca de letra no LRCLIB (https://lrclib.net/api/search).
//!
//! O app é 100% offline em todos os fluxos, EXCETO o clique explícito em
//! "Buscar letra na internet": este módulo (chamado pelo comando
//! `fetch_lyrics_online` em commands.rs, que injeta o fetcher `ureq`) é o
//! ÚNICO ponto de rede de todo o produto.
//!
//! O fetcher é injetável (`F: Fn(&str) -> Result<String>`) para os testes
//! rodarem sem rede. Score portado do tools/curadoria.py (V3): similaridade
//! textual normalizada + bônus/descarte por diferença de duração.

use crate::db::fold_pt;
use crate::error::{AppError, Result};
use serde::Serialize;
use std::collections::HashMap;

const SEARCH_URL: &str = "https://lrclib.net/api/search";

#[derive(Debug, Clone, Serialize)]
pub struct LyricsMatch {
    pub lyrics: String,
    pub matched_title: String,
    pub matched_artist: String,
    /// "alta" | "media"
    pub confidence: String,
}

/// Percent-encode de um valor de query string (RFC 3986: só unreserved
/// passam sem escape) — evita depender de crate para meia dúzia de bytes.
fn percent_encode(s: &str) -> String {
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
/// colapsados.
fn norm(s: &str) -> String {
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
fn similarity(a: &str, b: &str) -> f64 {
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

/// Busca no LRCLIB e escolhe o melhor candidato pelas regras da V3:
/// - candidato sem plainLyrics (vazio/nulo) ou sem duração: descartado;
/// - diferença de duração > 15 s: descartado (homônimo/versão errada);
/// - score = similaridade("titulo artista", "trackName artistName")
///   + 0.3 se dif ≤ 3 s, + 0.15 se dif ≤ 8 s;
/// - confiança ALTA: (dif ≤ 3 e sim ≥ 0.6) ou (sim ≥ 0.85 e dif ≤ 8);
///   MÉDIA: sim ≥ 0.5 e dif ≤ 15; abaixo disso devolve Ok(None).
pub fn fetch_lyrics_online<F>(
    title: &str,
    artist: &str,
    duration_seconds: f64,
    fetch: F,
) -> Result<Option<LyricsMatch>>
where
    F: Fn(&str) -> Result<String>,
{
    let alvo = format!("{} {}", title.trim(), artist.trim());
    let alvo = alvo.trim();
    let url = format!("{SEARCH_URL}?q={}", percent_encode(alvo));
    let body = fetch(&url)?;

    let results: Vec<serde_json::Value> = serde_json::from_str(&body)
        .map_err(|e| AppError(format!("resposta inválida do LRCLIB: {e}")))?;

    // melhor candidato: (score, sim, dif, letra, título, artista)
    let mut best: Option<(f64, f64, f64, String, String, String)> = None;
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
        if best.as_ref().is_none_or(|(s, ..)| score > *s) {
            best = Some((
                score,
                sim,
                dif,
                lyrics.to_string(),
                track.to_string(),
                artist_name.to_string(),
            ));
        }
    }

    let Some((_, sim, dif, lyrics, matched_title, matched_artist)) = best else {
        return Ok(None);
    };
    let confidence = if (dif <= 3.0 && sim >= 0.6) || (sim >= 0.85 && dif <= 8.0) {
        "alta"
    } else if sim >= 0.5 && dif <= 15.0 {
        "media"
    } else {
        return Ok(None); // nada confiável
    };
    Ok(Some(LyricsMatch {
        lyrics,
        matched_title,
        matched_artist,
        confidence: confidence.to_string(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stub(body: &'static str) -> impl Fn(&str) -> Result<String> {
        move |_url| Ok(body.to_string())
    }

    #[test]
    fn alta_match_by_close_duration() {
        let body = r#"[{
            "trackName": "Coração Sertanejo",
            "artistName": "Artista Teste",
            "duration": 181.0,
            "plainLyrics": "Quando o sol amanhecer\nMeu coração vai cantar"
        }]"#;
        let m = fetch_lyrics_online("Coração Sertanejo", "Artista Teste", 180.0, stub(body))
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
        let m = fetch_lyrics_online("Coração Sertanejo", "Artista Teste", 180.0, stub(body))
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
        let m = fetch_lyrics_online("Coração Sertanejo", "Artista Teste", 180.0, stub(body))
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
        let m = fetch_lyrics_online("Coração Sertanejo", "Artista Teste", 180.0, stub(body))
            .unwrap();
        assert!(m.is_none());
    }

    #[test]
    fn empty_results_return_none() {
        assert!(fetch_lyrics_online("T", "A", 100.0, stub("[]"))
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
        let m = fetch_lyrics_online("Coração Sertanejo", "Artista Teste", 180.0, stub(body))
            .unwrap();
        assert!(m.is_none(), "instrumental/sem letra nunca vira match");
    }

    #[test]
    fn invalid_json_is_an_error() {
        assert!(fetch_lyrics_online("T", "A", 100.0, stub("not json")).is_err());
        // objeto em vez de lista também é inválido
        assert!(fetch_lyrics_online("T", "A", 100.0, stub(r#"{"erro": 1}"#)).is_err());
    }

    #[test]
    fn fetch_error_propagates() {
        let err = fetch_lyrics_online("T", "A", 100.0, |_url| {
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
        let m = fetch_lyrics_online("Coração Sertanejo", "Artista Teste", 180.0, stub(body))
            .unwrap()
            .unwrap();
        assert_eq!(m.lyrics, "letra do mais próximo");
        assert_eq!(m.confidence, "alta");
    }

    #[test]
    fn url_is_percent_encoded_with_title_and_artist() {
        let captured = std::cell::RefCell::new(String::new());
        let _ = fetch_lyrics_online("Coração & Vida", "São João", 100.0, |url| {
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
