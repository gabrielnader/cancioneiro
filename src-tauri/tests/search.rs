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

// ===========================================================================
// V13 — a busca que perdoa a letra escrita por máquina (a UNIÃO)
// ===========================================================================
//
// Boa parte das letras do acervo foi escrita por máquina, ouvindo o áudio, e
// tem erro. A busca até aqui exigia TODAS as palavras EXATAS (só a última
// aceitava prefixo), então `dormir` não achava `dormi` — uma letra.
//
// O que entrou é a UNIÃO: tudo que a busca de hoje acha, MAIS o que o
// casamento por SEQUÊNCIA achar na letra. Ver DECISIONS #188–#192.
// ---------------------------------------------------------------------------

/// O caso que abriu a rodada, e o primeiro teste escrito: uma letra
/// transcrita diz `dormi` onde a pessoa lembra `dormir`. Uma letra de
/// diferença — e o FTS5, que casa token inteiro (com prefixo só no último),
/// não tem como achar: `"dormir"*` casa `dormirei`, nunca `dormi`.
#[test]
fn dormir_encontra_a_letra_que_diz_dormi() {
    let conn = conn_with_songs(&[
        ("Noite Longa", None, Some("eu nao consigo dormi de tanto pensar em voce")),
        ("Outra", None, Some("nada aqui tem a ver com o assunto")),
    ]);

    let results = search::search(&conn, "dormir", 50).unwrap();
    assert_eq!(results.len(), 1, "a letra com o erro de máquina tem de aparecer");
    assert_eq!(results[0].song.title, "Noite Longa");

    // o trecho continua vindo destacado — a palavra apontada é a que a
    // máquina escreveu, e não a que a pessoa digitou
    let snippet = results[0].snippet.as_deref().expect("trecho destacado");
    assert!(
        snippet.contains(&format!("{HIGHLIGHT_START}dormi{HIGHLIGHT_END}")),
        "o trecho tem de destacar a palavra que ESTÁ na letra: {snippet:?}"
    );
}

/// **A união não é troca: o que a busca de hoje acha continua achado.**
///
/// Medido em 721 trechos de cinco palavras: 5 deles são achados pela busca de
/// hoje e NÃO seriam pelo casamento por sequência — a transcrição destruiu o
/// verso, as palavras sobreviveram espalhadas, e a busca de hoje se safa por
/// não exigir ORDEM. Perder caso que já funciona não se negocia (DECISIONS
/// #189).
///
/// O primeiro par é o da medição (`na minha casa se eu`); os outros quatro
/// são da MESMA família — verso desmontado, palavras espalhadas — e existem
/// para a regra ficar guardada por mais de um exemplo.
#[test]
fn a_uniao_preserva_os_trechos_que_so_a_busca_de_hoje_acha() {
    // (trecho lembrado, letra transcrita com o verso desmontado)
    let casos: &[(&str, &str)] = &[
        (
            "na minha casa se eu",
            "se eu quiser dancar\nposso ficar aqui\nminha vida na casa dos outros\neu nao sei",
        ),
        (
            "eu vou embora hoje cedo",
            "hoje eu acordei bem cedo\ne resolvi que vou seguir\nembora tudo esteja estranho",
        ),
        (
            "quando o sol nascer amanha",
            "amanha talvez o dia venha\ne quando nascer de novo\no sol vai me encontrar",
        ),
        (
            "meu amor nao vai morrer",
            "morrer de amor nao e pra mim\nvai que meu coracao aguenta",
        ),
        (
            "a gente se ve depois",
            "depois de tudo que passou\nse a gente ainda quiser\nve se me liga",
        ),
    ];

    for (trecho, letra) in casos {
        // a metade tolerante REPROVA este par — é isto que a união salva
        assert!(
            search::casamento_por_sequencia(trecho, letra).is_none(),
            "o par {trecho:?} deixou de ser um caso de união: a sequência agora o acha"
        );

        // e a busca inteira acha, porque a metade exata continua lá
        let conn = conn_with_songs(&[("Alvo", None, Some(letra))]);
        let results = search::search(&conn, trecho, 50).unwrap();
        assert_eq!(results.len(), 1, "trecho {trecho:?} se perdeu");
        assert_eq!(results[0].song.title, "Alvo");
    }
}

/// A nota é a fração casada da MELHOR janela de `n` palavras, e o limiar é
/// 0,60 — medido. Abaixo dele o resultado não entra: 79% de acerto com 68
/// resultados por busca é pior que não achar (DECISIONS #188).
#[test]
fn a_nota_e_a_fracao_da_melhor_janela_e_o_limiar_e_60_por_cento() {
    // 5 de 5 — a janela inteira
    let c = search::casamento_por_sequencia("na beira do mar sagrado", "na beira do mar sagrado")
        .expect("igual casa");
    assert!((c.nota - 1.0).abs() < 1e-9);

    // 4 de 5 (0,80): uma palavra trocada no meio
    let c = search::casamento_por_sequencia(
        "na beira do mar sagrado",
        "eu vi na beira do rio sagrado hoje",
    )
    .expect("4 de 5 entra");
    assert!((c.nota - 0.8).abs() < 1e-9, "nota {}", c.nota);

    // 3 de 5 (0,60) — o limiar é INCLUSIVO
    assert!(
        search::casamento_por_sequencia("na beira do mar sagrado", "na beira do rio bonito")
            .is_some(),
        "3 de 5 é exatamente 0,60 e entra"
    );

    // 2 de 5 (0,40) — fica de fora
    assert!(
        search::casamento_por_sequencia("na beira do mar sagrado", "na beira de um rio bonito")
            .is_none()
    );

    // texto MENOR que a consulta não vira nota alta por acidente: o
    // denominador continua sendo o tamanho da consulta
    assert!(search::casamento_por_sequencia("na beira do mar sagrado", "na beira").is_none());
}

/// **O perdão de uma edição só vale a partir de 4 letras.** Em palavra curta
/// uma letra já é outra palavra: `sol` e `sal` não são a mesma coisa lembrada
/// errado, são duas coisas.
#[test]
fn uma_edicao_so_perdoa_palavra_de_quatro_letras_ou_mais() {
    // 6 letras: `dormir` acha `dormi` (remoção)
    assert!(search::casamento_por_sequencia("dormir", "dormi").is_some());
    // 6 letras: troca no meio
    assert!(search::casamento_por_sequencia("cantar", "contar").is_some());
    // 4 letras: inserção
    assert!(search::casamento_por_sequencia("casa", "causa").is_some());
    // 3 letras: NÃO
    assert!(search::casamento_por_sequencia("sol", "sal").is_none());
    assert!(search::casamento_por_sequencia("meu", "seu").is_none());
    // duas edições nunca passam, por mais longa que seja a palavra
    assert!(search::casamento_por_sequencia("saudade", "saudede").is_some());
    assert!(search::casamento_por_sequencia("saudade", "soudede").is_none());
}

/// O prefixo continua valendo em TODAS as posições da janela (a busca roda
/// enquanto se digita), e acento/caixa saem antes da comparação — a mesma
/// normalização do FTS.
#[test]
fn a_sequencia_aceita_prefixo_em_qualquer_posicao_e_ignora_acento() {
    let c = search::casamento_por_sequencia("cora bat forte", "meu CORAÇÃO BATE forte demais")
        .expect("prefixo em qualquer posição");
    assert!((c.nota - 1.0).abs() < 1e-9);
}

/// **O que a busca de hoje acha vem PRIMEIRO.** Casamento exato é mais
/// confiável que casamento perdoado, e as duas notas não viram um número só.
#[test]
fn o_exato_vem_antes_do_tolerante() {
    let conn = conn_with_songs(&[
        // a máquina escreveu "dormi": só o tolerante acha
        ("Perdoada", None, Some("eu nao consigo dormi de tanto pensar")),
        // esta diz "dormir" com todas as letras: a busca de hoje acha
        ("Exata", None, Some("nao vou dormir enquanto o galo nao cantar")),
    ]);

    let results = search::search(&conn, "dormir", 50).unwrap();
    assert_eq!(results.len(), 2);
    assert_eq!(results[0].song.title, "Exata", "o exato vem primeiro");
    assert_eq!(results[1].song.title, "Perdoada");
}

/// A biblioteca inteira continua vindo com o campo vazio, e a metade
/// tolerante não inventa resultado onde não há nada parecido.
#[test]
fn a_tolerancia_nao_alarga_o_campo_vazio_nem_inventa_resultado() {
    let conn = conn_with_songs(&[
        ("Zebra", None, Some("qualquer letra")),
        ("Amanhecer", None, Some("outra letra")),
    ]);
    assert_eq!(search::search(&conn, "", 50).unwrap().len(), 2);
    assert_eq!(search::search(&conn, "   ", 50).unwrap().len(), 2);

    // nada parecido: nem exato nem tolerante
    assert!(search::search(&conn, "helicoptero submarino", 50).unwrap().is_empty());
}

/// Match só em título/artista/tema/pasta/arquivo continua SEM trecho — a
/// metade tolerante olha só a LETRA, e por isso não muda essa regra.
#[test]
fn a_tolerancia_olha_so_a_letra_e_nao_inventa_trecho_para_titulo() {
    let conn = conn_with_songs(&[("Aurora Boreal", Some("Trio Norte"), Some("letra sem o termo"))]);
    // A música É candidata (o "aurora" bate no título), e mesmo assim
    // "aurora borel" não a traz: a metade tolerante pontua a LETRA, e o
    // título é etiqueta escrita por gente — não é onde a máquina erra.
    assert!(search::search(&conn, "aurora borel", 50).unwrap().is_empty());
    // e o match de título continua sem trecho destacado
    let results = search::search(&conn, "aurora", 50).unwrap();
    assert_eq!(results.len(), 1);
    assert!(results[0].snippet.is_none());
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
// V13 — O ACERVO DO DONO: 8.000 músicas COM LETRA, e a busca roda enquanto se
// digita. Percorrer a letra inteira das 8.000 a cada tecla é inviável; o que
// segura o tempo é o FTS5 escolher os candidatos (índice) e o Rust pontuar a
// sequência só neles, com TETO (`search::CANDIDATOS`).
//
// Este teste é a régua que impede o teto de crescer sem que alguém meça: os
// números medidos estão na DECISIONS #192. Ele mede consultas de 3, 5 e 8
// palavras — inclusive a PIOR delas, a de palavras comuns, que é a que enche
// a lista de candidatos.
// ---------------------------------------------------------------------------
#[test]
fn busca_em_8000_musicas_com_letra_responde_enquanto_se_digita() {
    let conn = db::open_in_memory().unwrap();
    conn.execute("INSERT INTO folders (path) VALUES ('/f')", [])
        .unwrap();

    // vocabulário de canção brasileira — o que enche uma letra de verdade
    let words = [
        "amor", "esperança", "coração", "alegria", "caminho", "estrada", "luz", "sombra",
        "noite", "dia", "sol", "lua", "estrela", "vento", "chuva", "flor", "campo", "mar",
        "rio", "montanha", "canto", "voz", "silêncio", "paz", "vida", "sonho", "tempo",
        "memória", "saudade", "partida",
    ];
    let tx = conn.unchecked_transaction().unwrap();
    for i in 0..8000 {
        // ~240 palavras por letra: o porte de uma canção inteira
        let mut lyrics = String::with_capacity(1600);
        for line in 0..40 {
            for w in 0..6 {
                lyrics.push_str(words[(i * 7 + line * 3 + w * 11) % words.len()]);
                lyrics.push(' ');
            }
            lyrics.push('\n');
        }
        // UMA música guarda o trecho procurado — com o erro de máquina no
        // meio ("beira" virou "beirra", "sagrado" virou "sagrada")
        if i == 4321 {
            lyrics.push_str("\nna beirra do mar sagrada eu vi o barco velho passar devagar\n");
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

    // warm-up (a primeira query paga a compilação dos statements)
    search::search(&conn, "amor", 200).unwrap();

    // O produto roda em RELEASE, e lá o teto é o debounce da caixa de busca:
    // 150 ms. `cargo test` roda em DEBUG, e nele o SQLite embutido é compilado
    // sem otimização (o `cc` usa o opt-level do perfil) — as mesmas buscas
    // custam de 3 a 4 vezes mais. Os dois números medidos estão na DECISIONS
    // #192; a régua aqui é a de cada perfil, e não uma média que não descreve
    // nenhum dos dois.
    let limite = if cfg!(debug_assertions) { 500 } else { 150 };
    let cronometrar = |consulta: &str| {
        let start = std::time::Instant::now();
        let results = search::search(&conn, consulta, 200).unwrap();
        let ms = start.elapsed().as_millis();
        println!("  {ms:>4}ms  {:>3} resultados  {consulta:?}", results.len());
        assert!(
            ms < limite,
            "busca {consulta:?} levou {ms}ms (limite {limite}ms — o botão a girar é o \
             teto de candidatos, nunca o limiar nem a tolerância)"
        );
        results
    };

    println!("\n=== busca em 8.000 músicas com letra ===");
    // 3, 5 e 8 palavras como a pessoa LEMBRA — a letra guardada tem os erros
    // ("beirra", "sagrada"), e só o casamento por sequência as acha
    for consulta in [
        "na beira do",
        "na beira do mar sagrado",
        "na beira do mar sagrado eu vi o",
    ] {
        let r = cronometrar(consulta);
        assert!(
            r.iter().any(|r| r.song.title == "Música 4321"),
            "o trecho {consulta:?} tem de achar a letra com o erro de máquina"
        );
    }

    // as PIORES: palavras comuns, que casam em quase todo o acervo
    cronometrar("amor e saudade");
    cronometrar("amor e saudade na estrada");
    cronometrar("amor e saudade na estrada de casa com sol");
    // e a de uma letra só, que é o primeiro instante de quem está digitando
    cronometrar("a");
    println!();
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
