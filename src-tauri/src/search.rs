use crate::db::{self, Song};
use crate::error::Result;
use rusqlite::{params, Connection};
use serde::Serialize;

/// Marcadores de destaque no snippet (área de uso privado do Unicode — não
/// colidem com texto de letra real). O frontend converte em <mark>.
pub const HIGHLIGHT_START: char = '\u{E000}';
pub const HIGHLIGHT_END: char = '\u{E001}';

#[derive(Debug, Clone, Serialize)]
pub struct SearchResult {
    pub song: Song,
    /// Trecho da letra com o termo destacado — presente somente quando o
    /// match ocorreu na letra.
    pub snippet: Option<String>,
}

/// Converte input do usuário em query FTS5 segura: cada token vira uma frase
/// entre aspas (sempre literal — operadores FTS não têm efeito) e o último
/// token é prefixo, para busca enquanto digita. `None` = sem tokens úteis.
pub fn sanitize_fts_query(input: &str) -> Option<String> {
    let tokens: Vec<&str> = input
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .collect();
    if tokens.is_empty() {
        return None;
    }
    let mut parts: Vec<String> = tokens.iter().map(|t| format!("\"{t}\"")).collect();
    parts.last_mut().unwrap().push('*');
    Some(parts.join(" "))
}

/// Busca em título, artista, letra, temas e pastas (F12). Query vazia/só-
/// especiais devolve a biblioteca completa em ordem alfabética
/// (comportamento do PRD para campo limpo), sem snippets.
///
/// O snippet vem SEMPRE da coluna de letra: `snippet(songs_fts, 2, ...)` —
/// índice 2 = lyrics na FTS (title, artist, lyrics, temas, pastas). Match só
/// em tema/pasta portanto nunca gera snippet (o marcador de destaque não
/// aparece e o filter abaixo descarta).
pub fn search(conn: &Connection, input: &str, limit: usize) -> Result<Vec<SearchResult>> {
    let Some(fts_query) = sanitize_fts_query(input) else {
        return Ok(db::list_songs(conn)?
            .into_iter()
            .map(|song| SearchResult { song, snippet: None })
            .collect());
    };

    let sql = format!(
        "SELECT {}, snippet(songs_fts, 2, ?2, ?3, '…', 12)
         FROM songs_fts
         JOIN songs s ON s.id = songs_fts.rowid
         WHERE songs_fts MATCH ?1
         ORDER BY rank
         LIMIT ?4",
        db::SONG_COLS
            .split(", ")
            .map(|c| format!("s.{c}"))
            .collect::<Vec<_>>()
            .join(", ")
    );

    let mut stmt = conn.prepare_cached(&sql)?;
    let rows = stmt.query_map(
        params![
            fts_query,
            HIGHLIGHT_START.to_string(),
            HIGHLIGHT_END.to_string(),
            limit as i64
        ],
        |r| {
            let song = db::song_from_row(r)?;
            let raw_snippet: Option<String> = r.get(10)?;
            Ok(SearchResult {
                song,
                // snippet só é relevante quando o match foi na letra — o
                // marcador de início só aparece nesse caso.
                snippet: raw_snippet.filter(|s| s.contains(HIGHLIGHT_START)),
            })
        },
    )?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}
