//! Testes da Fase 2 (F2 — busca por letra, título ou artista).
//! Acceptance Checks do PRD contra SQLite em memória.

use cancioneiro_lib::db;
use cancioneiro_lib::search::{self, HIGHLIGHT_END, HIGHLIGHT_START};
use rusqlite::{params, Connection};

fn conn_with_songs(songs: &[(&str, Option<&str>, Option<&str>)]) -> Connection {
    // (title, artist, lyrics)
    let with_temas: Vec<(&str, Option<&str>, Option<&str>, Option<&str>)> =
        songs.iter().map(|&(t, a, l)| (t, a, l, None)).collect();
    conn_with_songs_temas(&with_temas)
}

fn conn_with_songs_temas(
    songs: &[(&str, Option<&str>, Option<&str>, Option<&str>)],
) -> Connection {
    // (title, artist, lyrics, temas)
    let conn = db::open_in_memory().unwrap();
    conn.execute("INSERT INTO folders (path) VALUES ('/f')", [])
        .unwrap();
    for (i, (title, artist, lyrics, temas)) in songs.iter().enumerate() {
        conn.execute(
            "INSERT INTO songs (file_path, folder_id, title, artist, lyrics, temas, has_lyrics, file_mtime, file_size)
             VALUES (?1, 1, ?2, ?3, ?4, ?5, ?6, 0, 0)",
            params![
                format!("/f/{i}.mp3"),
                title,
                artist,
                lyrics,
                temas,
                lyrics.map(|l| !l.is_empty()).unwrap_or(false) as i64
            ],
        )
        .unwrap();
    }
    conn
}

/// Insere músicas com file_path de verdade, preenchendo a coluna `arquivo`
/// com o nome-base SEM extensão — a mesma derivação que o indexer grava
/// (indexer::arquivo_para_busca). (file_path, title, artist, lyrics, temas)
fn conn_with_files(
    songs: &[(&str, &str, Option<&str>, Option<&str>, Option<&str>)],
) -> Connection {
    let conn = db::open_in_memory().unwrap();
    conn.execute("INSERT INTO folders (path) VALUES ('/f')", [])
        .unwrap();
    for (file_path, title, artist, lyrics, temas) in songs {
        let base = file_path.rsplit('/').next().unwrap();
        let arquivo = base.rsplit_once('.').map(|(stem, _)| stem).unwrap_or(base);
        conn.execute(
            "INSERT INTO songs (file_path, folder_id, title, artist, lyrics, temas, arquivo,
                                has_lyrics, file_mtime, file_size)
             VALUES (?1, 1, ?2, ?3, ?4, ?5, ?6, ?7, 0, 0)",
            params![
                file_path,
                title,
                artist,
                lyrics,
                temas,
                arquivo,
                lyrics.map(|l| !l.is_empty()).unwrap_or(false) as i64
            ],
        )
        .unwrap();
    }
    conn
}

// ---------------------------------------------------------------------------
// V2 (F8): busca encontra músicas por TEMA, ignorando acentos; match apenas
// em tema não gera snippet de letra.
// ---------------------------------------------------------------------------
#[test]
fn search_finds_songs_by_tema_ignoring_diacritics() {
    let conn = conn_with_songs_temas(&[
        ("Rio Divino", None, Some("uma letra qualquer"), Some("água; cura")),
        ("Outra Canção", None, Some("nada relacionado"), None),
    ]);

    let results = search::search(&conn, "agua", 50).unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].song.title, "Rio Divino");
    assert_eq!(results[0].song.temas.as_deref(), Some("água; cura"));
    // match só no tema: sem snippet de letra
    assert!(results[0].snippet.is_none());

    let results = search::search(&conn, "cura", 50).unwrap();
    assert_eq!(results.len(), 1);
}

// ---------------------------------------------------------------------------
// V2 (F8): busca multi-token cruza colunas — dois temas juntos, e
// título + tema na mesma query (AND do FTS5 é por linha, não por coluna).
// ---------------------------------------------------------------------------
#[test]
fn multi_token_search_matches_across_temas_and_title() {
    let conn = conn_with_songs_temas(&[
        ("Rio Divino", None, Some("uma letra qualquer"), Some("água; cura")),
        ("Só Água", None, Some("outra letra"), Some("água")),
        ("Sem Nada", None, Some("nada"), None),
    ]);

    // dois temas na mesma query (AND)
    let results = search::search(&conn, "agua cura", 50).unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].song.title, "Rio Divino");

    // token do título + token do tema
    let results = search::search(&conn, "rio agua", 50).unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].song.title, "Rio Divino");
}

// ---------------------------------------------------------------------------
// V5 (F12): busca encontra músicas pelo NOME DA PASTA (coluna pastas),
// ignorando acentos; match apenas em pasta NUNCA gera snippet de letra;
// música na raiz (pastas NULL) não é encontrada pelo termo da pasta.
// ---------------------------------------------------------------------------
#[test]
fn search_finds_songs_by_folder_name_without_snippet() {
    let conn = db::open_in_memory().unwrap();
    conn.execute("INSERT INTO folders (path) VALUES ('/f')", [])
        .unwrap();
    conn.execute(
        "INSERT INTO songs (file_path, folder_id, title, lyrics, has_lyrics, pastas, file_mtime, file_size)
         VALUES ('/f/Barco/x.mp3', 1, 'Vento Norte', 'letra sem o termo', 1, 'Barco', 0, 0),
                ('/f/y.mp3', 1, 'Na Raiz', 'nada aqui', 1, NULL, 0, 0),
                ('/f/Canções/z.mp3', 1, 'Terceira', 'letra qualquer', 1, 'Canções', 0, 0)",
        [],
    )
    .unwrap();

    // "barco" só existe no nome da pasta — encontra, sem snippet de letra
    for q in ["barco", "Barco", "BARCO"] {
        let results = search::search(&conn, q, 50).unwrap();
        assert_eq!(results.len(), 1, "query {q:?}");
        assert_eq!(results[0].song.title, "Vento Norte");
        assert!(
            results[0].snippet.is_none(),
            "match só de pasta não pode gerar snippet de letra"
        );
    }

    // sem acento encontra pasta acentuada
    let results = search::search(&conn, "cancoes", 50).unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].song.title, "Terceira");
    assert!(results[0].snippet.is_none());
}

// ---------------------------------------------------------------------------
// V5 (F12): com a coluna pastas na FTS, o snippet continua vindo da coluna
// de LETRA (índice de coluna do snippet() não pode escorregar).
// ---------------------------------------------------------------------------
#[test]
fn lyrics_snippet_column_index_survives_pastas_column() {
    let conn = db::open_in_memory().unwrap();
    conn.execute("INSERT INTO folders (path) VALUES ('/f')", [])
        .unwrap();
    conn.execute(
        "INSERT INTO songs (file_path, folder_id, title, lyrics, has_lyrics, pastas, file_mtime, file_size)
         VALUES ('/f/Barco/x.mp3', 1, 'Vento Norte', 'a segunda linha fala de esperança viva', 1, 'Barco', 0, 0)",
        [],
    )
    .unwrap();

    // match na letra: snippet destacado, mesmo com pastas preenchida
    let results = search::search(&conn, "esperança", 50).unwrap();
    assert_eq!(results.len(), 1);
    let snippet = results[0].snippet.as_deref().expect("snippet presente");
    assert!(snippet.contains(&format!("{HIGHLIGHT_START}esperança{HIGHLIGHT_END}")));

    // pasta + letra na mesma query (AND por linha) também mantém o snippet
    let results = search::search(&conn, "barco esperanca", 50).unwrap();
    assert_eq!(results.len(), 1);
    assert!(results[0].snippet.is_some());
}

// ---------------------------------------------------------------------------
// V8 — busca encontra músicas pelo NOME DO ARQUIVO (coluna `arquivo` na FTS).
// As coordenadoras se organizam por nome de arquivo há anos (DECISIONS #67):
// depois de o nome ficar VISÍVEL na V6, torná-lo BUSCÁVEL é a outra metade.
// Match só no nome NUNCA gera snippet — o snippet segue exclusivo da letra.
// ---------------------------------------------------------------------------
#[test]
fn search_finds_songs_by_file_name_without_snippet() {
    let conn = conn_with_files(&[
        // nome de arquivo real do acervo: o "Capoeira" só existe no nome
        (
            "/f/barco - Marinheiro só (Capoeira).mp3",
            "Marinheiro Só",
            Some("Trio do Norte"),
            Some("eu não sou daqui, marinheiro"),
            Some("mar"),
        ),
        ("/f/outra.mp3", "Outra Canção", None, Some("nada aqui"), None),
    ]);

    for q in ["capoeira", "Capoeira", "CAPOEIRA"] {
        let results = search::search(&conn, q, 50).unwrap();
        assert_eq!(results.len(), 1, "query {q:?}");
        assert_eq!(results[0].song.title, "Marinheiro Só");
        assert!(
            results[0].snippet.is_none(),
            "match só de nome de arquivo não pode gerar snippet de letra"
        );
    }

    // token do nome + token da letra na mesma query (AND por linha)
    let results = search::search(&conn, "capoeira marinheiro", 50).unwrap();
    assert_eq!(results.len(), 1);
}

// ---------------------------------------------------------------------------
// V8 — o nome do arquivo entra no índice com a mesma indiferença a acento e
// caixa do resto da busca, e a pontuação/ruído real dos nomes ("##", " - ",
// parênteses) não quebra nem a indexação nem a query.
// ---------------------------------------------------------------------------
#[test]
fn file_name_search_ignores_diacritics_and_survives_punctuation_noise() {
    let conn = conn_with_files(&[
        (
            "/f/Barco/barquinha - canto pra iemanja - Tincoãs ##.mp3",
            "Canto Pra Iemanjá",
            None,
            Some("odoya minha mãe"),
            None,
        ),
        (
            "/f/adventício - Abrir a sessão ####.mp3",
            "Abertura",
            None,
            Some("letra qualquer"),
            None,
        ),
    ]);

    // sem acento acha nome acentuado e vice-versa
    for q in ["tincoas", "Tincoãs", "iemanja", "iemanjá"] {
        let results = search::search(&conn, q, 50).unwrap();
        assert_eq!(results.len(), 1, "query {q:?}");
        assert_eq!(results[0].song.title, "Canto Pra Iemanjá");
    }
    let results = search::search(&conn, "adventicio", 50).unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].song.title, "Abertura");

    // o ruído digitado junto não quebra a query nem some com o resultado
    for q in [
        "Tincoãs ##",
        "barquinha - canto",
        "(iemanja)",
        "adventício - Abrir",
    ] {
        let r = search::search(&conn, q, 50).unwrap();
        assert_eq!(r.len(), 1, "query {q:?} deve achar exatamente 1");
    }

    // só ruído: nenhum token útil => biblioteca inteira, sem erro
    let results = search::search(&conn, "##", 50).unwrap();
    assert_eq!(results.len(), 2);
}

// ---------------------------------------------------------------------------
// V8 — a EXTENSÃO fica fora do índice: ninguém procura "mp3", e indexá-la
// devolveria o acervo inteiro para esse token (todo arquivo é .mp3).
// ---------------------------------------------------------------------------
#[test]
fn file_extension_is_not_searchable() {
    let conn = conn_with_files(&[
        ("/f/barco - Marinheiro só.mp3", "Marinheiro Só", None, Some("letra"), None),
        ("/f/OUTRA.MP3", "Outra", None, Some("outra letra"), None),
    ]);

    let results = search::search(&conn, "mp3", 50).unwrap();
    assert!(
        results.is_empty(),
        "extensão não é conteúdo: {:?}",
        results.iter().map(|r| r.song.title.as_str()).collect::<Vec<_>>()
    );

    // e o nome (sem extensão) continua achável nos dois arquivos
    assert_eq!(search::search(&conn, "barco", 50).unwrap().len(), 1);
    assert_eq!(search::search(&conn, "outra", 50).unwrap().len(), 1);
}

// ---------------------------------------------------------------------------
// V8: com a coluna `arquivo` na FTS, o snippet continua vindo da coluna de
// LETRA (índice 2). Coluna nova entra no FIM da FTS justamente por isso.
// ---------------------------------------------------------------------------
#[test]
fn lyrics_snippet_column_index_survives_arquivo_column() {
    let conn = conn_with_files(&[(
        "/f/Barco/barco - Marinheiro só (Capoeira).mp3",
        "Marinheiro Só",
        Some("Trio do Norte"),
        Some("a segunda linha fala de esperança viva"),
        Some("mar"),
    )]);

    // match na letra: snippet destacado, com todas as colunas preenchidas
    let results = search::search(&conn, "esperança", 50).unwrap();
    assert_eq!(results.len(), 1);
    let snippet = results[0].snippet.as_deref().expect("snippet presente");
    assert!(
        snippet.contains(&format!("{HIGHLIGHT_START}esperança{HIGHLIGHT_END}")),
        "snippet deve citar a LETRA: {snippet:?}"
    );

    // nome do arquivo + letra na mesma query mantém o snippet da letra
    let results = search::search(&conn, "capoeira esperanca", 50).unwrap();
    assert_eq!(results.len(), 1);
    assert!(results[0].snippet.is_some());
}

// ---------------------------------------------------------------------------
// Acceptance: trecho existente apenas na letra de 1 música retorna essa
// música em primeiro.
// ---------------------------------------------------------------------------
#[test]
fn lyrics_only_match_returns_that_song_first() {
    let conn = conn_with_songs(&[
        ("Alegria Geral", Some("Banda A"), Some("hoje é dia de festa")),
        ("Canção da Manhã", Some("Banda B"), Some("o vagalume brilha na escuridão")),
        ("Outra Música", Some("Banda C"), Some("nada a ver com o resto")),
    ]);

    let results = search::search(&conn, "vagalume", 50).unwrap();
    assert!(!results.is_empty());
    assert_eq!(results[0].song.title, "Canção da Manhã");
    assert_eq!(results.len(), 1);
}

// ---------------------------------------------------------------------------
// Acceptance: "coracao" encontra "coração" (remove_diacritics 2).
// ---------------------------------------------------------------------------
#[test]
fn search_without_diacritics_finds_accented_lyrics() {
    let conn = conn_with_songs(&[
        ("Sertaneja", None, Some("meu coração vai cantar")),
        ("Outra", None, Some("sem o termo aqui")),
    ]);

    let results = search::search(&conn, "coracao", 50).unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].song.title, "Sertaneja");

    // e o inverso: acentuado encontra acentuado
    let results = search::search(&conn, "coração", 50).unwrap();
    assert_eq!(results.len(), 1);

    // caixa alta também (AMANHECER encontra amanhecer)
    let conn2 = conn_with_songs(&[("A", None, Some("quando amanhecer eu vou"))]);
    let results = search::search(&conn2, "AMANHECER", 50).unwrap();
    assert_eq!(results.len(), 1);
}

// ---------------------------------------------------------------------------
// Acceptance: aspas/asteriscos/operadores FTS no input não lançam erro e são
// tratados como literais.
// ---------------------------------------------------------------------------
#[test]
fn special_characters_are_sanitized_never_error() {
    let conn = conn_with_songs(&[
        ("Estrela Guia", None, Some("não há noite sem estrela")),
    ]);

    for q in [
        "\"estrela\"",
        "estrela*",
        "estrela AND noite",
        "-estrela",
        "NEAR(estrela)",
        "est\"rela",
        "(estrela)",
        "estrela:",
        "^estrela",
        "estrela + noite",
    ] {
        let r = search::search(&conn, q, 50);
        assert!(r.is_ok(), "query {q:?} não pode dar erro: {:?}", r.err());
    }

    // termo literal entre aspas ainda encontra
    let results = search::search(&conn, "\"estrela\"", 50).unwrap();
    assert_eq!(results.len(), 1);

    // operadores FTS não têm efeito de operador: "estrela AND noite" busca
    // os tokens literais (AND vira token 'and', que não existe) — sem erro.
    let results = search::search(&conn, "NOT AND OR", 50).unwrap();
    assert!(results.is_empty() || !results.is_empty()); // apenas não pode ter dado Err
}

// ---------------------------------------------------------------------------
// Acceptance: apenas caracteres especiais => tratado como vazio => biblioteca
// completa em ordem alfabética (sem erro de sintaxe).
// ---------------------------------------------------------------------------
#[test]
fn only_special_characters_returns_full_library_alphabetical() {
    let conn = conn_with_songs(&[
        ("Zebra", None, None),
        ("Amanhecer", None, None),
        ("Meio", None, None),
    ]);

    for q in ["\"", "*", "-", "\"*-", "   ", ""] {
        let results = search::search(&conn, q, 50).unwrap();
        assert_eq!(results.len(), 3, "query {q:?} deve listar tudo");
        let titles: Vec<_> = results.iter().map(|r| r.song.title.as_str()).collect();
        assert_eq!(titles, vec!["Amanhecer", "Meio", "Zebra"]);
        assert!(results.iter().all(|r| r.snippet.is_none()));
    }
}

// ---------------------------------------------------------------------------
// Acceptance: match na letra exibe snippet com o termo destacado.
// ---------------------------------------------------------------------------
#[test]
fn lyrics_match_produces_highlighted_snippet() {
    let conn = conn_with_songs(&[(
        "Longa",
        None,
        Some("primeira linha da canção\nsegunda linha fala de esperança viva\nterceira linha encerra o pensamento da obra completa"),
    )]);

    let results = search::search(&conn, "esperança", 50).unwrap();
    assert_eq!(results.len(), 1);
    let snippet = results[0].snippet.as_deref().expect("snippet presente");
    assert!(
        snippet.contains(&format!("{HIGHLIGHT_START}esperança{HIGHLIGHT_END}")),
        "snippet deve conter termo destacado: {snippet:?}"
    );
}

// ---------------------------------------------------------------------------
// Match apenas em título/artista: sem snippet de letra.
// ---------------------------------------------------------------------------
#[test]
fn title_match_has_no_lyrics_snippet() {
    let conn = conn_with_songs(&[("Aurora Boreal", Some("Trio Norte"), Some("letra sem o termo"))]);

    let results = search::search(&conn, "aurora", 50).unwrap();
    assert_eq!(results.len(), 1);
    assert!(results[0].snippet.is_none());

    let results = search::search(&conn, "trio", 50).unwrap();
    assert_eq!(results.len(), 1);
    assert!(results[0].snippet.is_none());
}

// ---------------------------------------------------------------------------
// Busca incremental (prefixo do último token): "amanhe" encontra "amanhecer".
// ---------------------------------------------------------------------------
#[test]
fn last_token_is_prefix_matched_for_typeahead() {
    let conn = conn_with_songs(&[("X", None, Some("quando o sol amanhecer"))]);
    let results = search::search(&conn, "amanhe", 50).unwrap();
    assert_eq!(results.len(), 1);
    let results = search::search(&conn, "sol amanhe", 50).unwrap();
    assert_eq!(results.len(), 1);
}

// ---------------------------------------------------------------------------
// Acceptance: 2.000 músicas sintéticas, busca < 100ms.
// ---------------------------------------------------------------------------
#[test]
fn search_over_2000_songs_under_100ms() {
    let conn = db::open_in_memory().unwrap();
    conn.execute("INSERT INTO folders (path) VALUES ('/f')", [])
        .unwrap();

    let words = [
        "amor", "esperança", "coração", "alegria", "caminho", "estrada", "luz", "sombra",
        "noite", "dia", "sol", "lua", "estrela", "vento", "chuva", "flor", "campo", "mar",
        "rio", "montanha", "canto", "voz", "silêncio", "paz", "vida", "sonho", "tempo",
        "memória", "saudade", "partida",
    ];
    let tx = conn.unchecked_transaction().unwrap();
    for i in 0..2000 {
        let mut lyrics = String::new();
        for line in 0..12 {
            for w in 0..6 {
                lyrics.push_str(words[(i * 7 + line * 3 + w * 11) % words.len()]);
                lyrics.push(' ');
            }
            lyrics.push('\n');
        }
        if i == 1234 {
            lyrics.push_str("\ntermo raríssimo procurado aqui");
        }
        tx.execute(
            "INSERT INTO songs (file_path, folder_id, title, artist, lyrics, has_lyrics, file_mtime, file_size)
             VALUES (?1, 1, ?2, ?3, ?4, 1, 0, 0)",
            params![
                format!("/f/{i}.mp3"),
                format!("Música {i}"),
                format!("Artista {}", i % 40),
                lyrics
            ],
        )
        .unwrap();
    }
    tx.commit().unwrap();

    // warm-up (primeira query paga custo de compilação do statement)
    search::search(&conn, "amor", 50).unwrap();

    let start = std::time::Instant::now();
    let results = search::search(&conn, "rarissimo", 50).unwrap();
    let elapsed = start.elapsed();

    assert_eq!(results.len(), 1);
    assert_eq!(results[0].song.title, "Música 1234");
    assert!(
        elapsed.as_millis() < 100,
        "busca levou {}ms (limite 100ms)",
        elapsed.as_millis()
    );

    // busca comum (muitos resultados) também dentro do limite
    let start = std::time::Instant::now();
    let results = search::search(&conn, "esperança coração", 50).unwrap();
    let elapsed = start.elapsed();
    assert!(!results.is_empty());
    assert!(results.len() <= 50, "respeita o limite");
    assert!(
        elapsed.as_millis() < 100,
        "busca comum levou {}ms (limite 100ms)",
        elapsed.as_millis()
    );
}

// ---------------------------------------------------------------------------
// Unit: sanitizador de query FTS.
// ---------------------------------------------------------------------------
#[test]
fn sanitize_builds_quoted_prefix_query() {
    assert_eq!(
        search::sanitize_fts_query("meu coração"),
        Some("\"meu\" \"coração\"*".to_string())
    );
    assert_eq!(
        search::sanitize_fts_query("  sol  "),
        Some("\"sol\"*".to_string())
    );
    // aspas/operadores são descartados como separadores
    assert_eq!(
        search::sanitize_fts_query("\"sol\" AND -lua*"),
        Some("\"sol\" \"AND\" \"lua\"*".to_string())
    );
    assert_eq!(search::sanitize_fts_query("\"*-()"), None);
    assert_eq!(search::sanitize_fts_query(""), None);
    assert_eq!(search::sanitize_fts_query("   "), None);
}
