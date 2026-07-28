//! V8/F18 fase 1 — o Vagalume como SEGUNDA fonte de letra dentro do app.
//!
//! Porte da disciplina de casamento do `tools/curadoria.py`
//! (`buscar_letra_vagalume` / `_confere_estrito`). Os testes espelham,
//! um a um, os achados de QA que moldaram aquela implementação — em
//! especial o que gravou a letra de "Ponto de Ogum" dentro de uma música
//! "Ponto de Oxum".
//!
//! NENHUM teste toca a rede: o acesso HTTP entra pelo mesmo `fetch`
//! injetável das outras fontes e a chave é sempre falsa.

use cancioneiro_lib::enrich::is_placeholder;
use cancioneiro_lib::error::AppError;
use cancioneiro_lib::vagalume::{self, VagalumeMatch};
use std::cell::RefCell;

const CHAVE: &str = "chave-vagalume-de-teste";
/// Texto inventado: nenhum teste depende de letra real de ninguém.
const LETRA: &str = "Primeira linha inventada\nSegunda linha inventada à toa";

/// O mesmo filtro que o enriquecimento usa nos dois lados da conversa.
const SEM_PLACEHOLDER: fn(&str, &str) -> bool =
    |t, a| !is_placeholder(t) && !is_placeholder(a);

/// Corpo de resposta do `/search.php` no formato real da API.
fn resposta(tipo: &str, artista: &str, musicas: &[(&str, &str)]) -> String {
    let mus: Vec<String> = musicas
        .iter()
        .map(|(nome, texto)| {
            format!(
                r#"{{"id":"m1","name":{},"url":"x","lang":1,"text":{}}}"#,
                serde_json::to_string(nome).unwrap(),
                serde_json::to_string(texto).unwrap()
            )
        })
        .collect();
    format!(
        r#"{{"type":{},"art":{{"id":"a1","name":{},"url":"x"}},"mus":[{}]}}"#,
        serde_json::to_string(tipo).unwrap(),
        serde_json::to_string(artista).unwrap(),
        mus.join(",")
    )
}

fn buscar(
    titulo: &str,
    artista: &str,
    corpo: &str,
) -> Option<VagalumeMatch> {
    let corpo = corpo.to_string();
    vagalume::fetch_lyrics_vagalume(
        titulo,
        artista,
        CHAVE,
        &|_url: &str| Ok(corpo.clone()),
        SEM_PLACEHOLDER,
    )
    .unwrap()
}

// ---------------------------------------------------------------------------
// O caminho feliz: type "exact" e as MESMAS palavras dos dois lados.
// ---------------------------------------------------------------------------
#[test]
fn exact_match_with_the_same_words_returns_the_lyrics() {
    let corpo = resposta("exact", "Coral Novo", &[("Água Viva", LETRA)]);
    let m = buscar("Água Viva", "Coral Novo", &corpo).expect("casamento exato");
    assert_eq!(m.lyrics, LETRA);
    assert_eq!(m.matched_title, "Água Viva");
    assert_eq!(m.matched_artist, "Coral Novo");
}

// ---------------------------------------------------------------------------
// Achado CRÍTICO do QA (DECISIONS #63): `type: "aprox"` é a própria API
// dizendo "isto NÃO é a música que você pediu, é a mais parecida que eu
// tenho". Tratá-lo como "exact" gravou a letra de "Ponto de Ogum" dentro de
// um arquivo "Ponto de Oxum" — com a marca de letra OFICIAL.
// ---------------------------------------------------------------------------
#[test]
fn type_aprox_is_refused_even_when_the_names_match_perfectly() {
    let corpo = resposta("aprox", "Coral Novo", &[("Água Viva", LETRA)]);
    assert!(
        buscar("Água Viva", "Coral Novo", &corpo).is_none(),
        r#""aprox" é a API avisando que devolveu OUTRA música"#
    );
}

#[test]
fn other_types_and_a_missing_type_field_are_refused() {
    for tipo in ["notfound", "song_notfound", "", "EXACT", "exact "] {
        let corpo = resposta(tipo, "Coral Novo", &[("Água Viva", LETRA)]);
        assert!(
            buscar("Água Viva", "Coral Novo", &corpo).is_none(),
            "type={tipo:?} não pode ser aceito"
        );
    }
    // resposta sem `type` nenhum: sem veredito da API não há em que se apoiar
    let sem_tipo = format!(
        r#"{{"art":{{"name":"Coral Novo"}},"mus":[{{"name":"Água Viva","text":{}}}]}}"#,
        serde_json::to_string(LETRA).unwrap()
    );
    assert!(buscar("Água Viva", "Coral Novo", &sem_tipo).is_none());
}

// ---------------------------------------------------------------------------
// A régua do Vagalume é PRÓPRIA e estrita (as mesmas palavras, na mesma
// ordem), e não a do LRCLIB: lá a DURAÇÃO confirma o casamento, aqui a prova
// textual é a única que existe. Cada par abaixo é uma colisão medida pelo QA
// sob a régua frouxa.
// ---------------------------------------------------------------------------
#[test]
fn strict_match_refuses_words_added_removed_or_swapped() {
    let colisoes = [
        ("Ponto de Oxum", "Ponto de Ogum"),   // sim 0,923
        ("Ponto de Iansã", "Ponto de Iemanjá"), // sim 0,867
        ("Cantiga", "Cantigas"),              // sim 0,933
        ("Asa Branca", "A Volta da Asa Branca"), // contenção
        ("Canoeiro", "Canoeiro II"),          // contenção
        ("Aquarela", "Aquarela do Brasil"),   // contenção
    ];
    for (pedido, devolvido) in colisoes {
        let corpo = resposta("exact", "Coral Novo", &[(devolvido, LETRA)]);
        assert!(
            buscar(pedido, "Coral Novo", &corpo).is_none(),
            "{pedido:?} não pode aceitar {devolvido:?}"
        );
    }
    // e o artista é conferido com a mesma régua
    let corpo = resposta("exact", "Coral Novo do Recife", &[("Água Viva", LETRA)]);
    assert!(
        buscar("Água Viva", "Coral Novo", &corpo).is_none(),
        "artista com palavra a mais não confere"
    );
}

// ---------------------------------------------------------------------------
// O que a régua PERDOA: acento, caixa, pontuação e conectivo — "Milionário &
// José Rico" é o mesmo artista que "Milionario y Jose Rico".
// ---------------------------------------------------------------------------
#[test]
fn strict_match_forgives_accent_case_punctuation_and_connectives() {
    let iguais = [
        ("Água Viva", "AGUA VIVA"),
        ("Água Viva", "Água  Viva!"),
        ("Oh! Chuva", "Oh Chuva"),
    ];
    for (pedido, devolvido) in iguais {
        let corpo = resposta("exact", "Coral Novo", &[(devolvido, LETRA)]);
        assert!(
            buscar(pedido, "Coral Novo", &corpo).is_some(),
            "{pedido:?} deveria aceitar {devolvido:?}"
        );
    }
    for (pedido, devolvido) in [
        ("Milionário & José Rico", "Milionario y Jose Rico"),
        ("Sandy e Junior", "Sandy & Junior"),
        ("Fulano feat Beltrano", "Fulano & Beltrano"),
    ] {
        let corpo = resposta("exact", devolvido, &[("Água Viva", LETRA)]);
        assert!(
            buscar("Água Viva", pedido, &corpo).is_some(),
            "artista {pedido:?} deveria aceitar {devolvido:?}"
        );
    }
}

// ---------------------------------------------------------------------------
// Única flexibilidade, e do lado do PEDIDO: tag de título no formato
// "Artista - Título" (visto no acervo real) vale também por cada segmento do
// traço — mas por IGUALDADE de palavras, nunca por contenção.
// ---------------------------------------------------------------------------
#[test]
fn a_dash_separated_request_also_matches_by_segment() {
    let corpo = resposta("exact", "Coral Novo", &[("Água Viva", LETRA)]);
    assert!(buscar("Coral Novo - Água Viva", "Coral Novo", &corpo).is_some());
    // travessão e meia-risca também
    assert!(buscar("Coral Novo — Água Viva", "Coral Novo", &corpo).is_some());
    // mas o segmento tem de bater INTEIRO
    let outro = resposta("exact", "Coral Novo", &[("Água", LETRA)]);
    assert!(buscar("Coral Novo - Água Viva", "Coral Novo", &outro).is_none());
}

// ---------------------------------------------------------------------------
// "Sem artista para conferir, não se consulta" — foi um casamento sem prova
// ("Lampejo" com uma faixa do Roberto Carlos) que ensinou isso ao projeto.
// ---------------------------------------------------------------------------
#[test]
fn without_both_sides_to_check_it_never_touches_the_network() {
    for (titulo, artista) in [("Água Viva", ""), ("", "Coral Novo"), ("", ""), ("  ", " ")] {
        let chamadas = RefCell::new(0usize);
        let r = vagalume::fetch_lyrics_vagalume(
            titulo,
            artista,
            CHAVE,
            &|_url: &str| {
                *chamadas.borrow_mut() += 1;
                Ok(resposta("exact", "Coral Novo", &[("Água Viva", LETRA)]))
            },
            SEM_PLACEHOLDER,
        )
        .unwrap();
        assert!(r.is_none(), "{titulo:?}/{artista:?} não pode casar");
        assert_eq!(*chamadas.borrow(), 0, "{titulo:?}/{artista:?} gastou rede");
    }
}

#[test]
fn placeholder_on_either_side_never_touches_the_network() {
    for (titulo, artista) in [
        ("AudioTrack 02", "Coral Novo"),
        ("Água Viva", "no artist"),
        ("Faixa 8", "[Unknown Artist]"),
    ] {
        let chamadas = RefCell::new(0usize);
        let r = vagalume::fetch_lyrics_vagalume(
            titulo,
            artista,
            CHAVE,
            &|_url: &str| {
                *chamadas.borrow_mut() += 1;
                Ok(resposta("exact", artista, &[(titulo, LETRA)]))
            },
            SEM_PLACEHOLDER,
        )
        .unwrap();
        assert!(r.is_none());
        assert_eq!(*chamadas.borrow(), 0, "placeholder não se consulta");
    }
}

/// Placeholder do LADO da resposta também é descartado (o mesmo filtro).
#[test]
fn placeholder_in_the_answer_is_discarded() {
    let corpo = resposta("exact", "no artist", &[("AudioTrack 02", LETRA)]);
    assert!(buscar("AudioTrack 02x", "no artistx", &corpo).is_none());
}

// ---------------------------------------------------------------------------
// A base comunitária às vezes devolve um CONVITE para o visitante contribuir
// no lugar da letra. Isso não é letra e não pode entrar no MP3.
// ---------------------------------------------------------------------------
#[test]
fn a_we_dont_have_this_lyric_notice_is_not_a_lyric() {
    for recado in [
        "Ainda não temos a letra desta música",
        "AINDA NAO TEMOS A LETRA",
        "Envie a letra desta canção",
        "Colabore com a letra",
        "letra não disponível",
        "Sem letra cadastrada",
    ] {
        let corpo = resposta("exact", "Coral Novo", &[("Água Viva", recado)]);
        assert!(
            buscar("Água Viva", "Coral Novo", &corpo).is_none(),
            "{recado:?} é recado da base, não letra"
        );
    }
    // ... e letra de verdade que MENCIONA a palavra "letra" continua passando
    let cancao = "Escrevi a letra dessa canção\nnuma noite de chuva";
    let corpo = resposta("exact", "Coral Novo", &[("Água Viva", cancao)]);
    assert_eq!(
        buscar("Água Viva", "Coral Novo", &corpo).map(|m| m.lyrics),
        Some(cancao.to_string())
    );
}

#[test]
fn empty_lyrics_are_discarded() {
    for texto in ["", "   ", "\n\n"] {
        let corpo = resposta("exact", "Coral Novo", &[("Água Viva", texto)]);
        assert!(buscar("Água Viva", "Coral Novo", &corpo).is_none());
    }
}

// ---------------------------------------------------------------------------
// `mus` é uma LISTA: a exata pode estar DEPOIS de uma variação. Vence a
// melhor, não a primeira.
// ---------------------------------------------------------------------------
#[test]
fn the_best_entry_wins_not_the_first_one() {
    // As duas passam na régua (o conectivo é grafia), mas só a segunda é
    // literalmente o título pedido — e é a que tem de vencer.
    let corpo = resposta(
        "exact",
        "Coral Novo",
        &[
            ("Vida & Morte", "letra da variação de grafia"),
            ("Vida e Morte", "letra da entrada exata"),
        ],
    );
    let m = buscar("Vida e Morte", "Coral Novo", &corpo).expect("alguma passa");
    assert_eq!(
        m.lyrics, "letra da entrada exata",
        "igualdade literal do título vence a variação de grafia"
    );
    assert_eq!(m.matched_title, "Vida e Morte");
}

// ---------------------------------------------------------------------------
// A base devolve entidades HTML no texto ("&quot;", "&#39;"). Sem
// desescapar, elas entram no MP3 e no índice de busca do player.
// ---------------------------------------------------------------------------
#[test]
fn html_entities_come_out_as_text() {
    let corpo = resposta(
        "exact",
        "Coral Novo",
        &[(
            "Água Viva",
            "Ela disse &quot;vem&quot; &#39;agora&#39;\nvocê &amp; eu &lt;3",
        )],
    );
    let m = buscar("Água Viva", "Coral Novo", &corpo).expect("casamento exato");
    assert_eq!(m.lyrics, "Ela disse \"vem\" 'agora'\nvocê & eu <3");
}

// ---------------------------------------------------------------------------
// Sem chave, a etapa é PULADA em silêncio: nada de rede, nada de erro — o
// resto do funil continua funcionando exatamente como antes.
// ---------------------------------------------------------------------------
#[test]
fn without_a_key_there_is_no_network_and_no_error() {
    for chave in ["", "   "] {
        let chamadas = RefCell::new(0usize);
        let r = vagalume::fetch_lyrics_vagalume(
            "Água Viva",
            "Coral Novo",
            chave,
            &|_url: &str| {
                *chamadas.borrow_mut() += 1;
                Ok(resposta("exact", "Coral Novo", &[("Água Viva", LETRA)]))
            },
            SEM_PLACEHOLDER,
        )
        .unwrap();
        assert!(r.is_none(), "sem chave não há resultado");
        assert_eq!(*chamadas.borrow(), 0, "sem chave não há rede");
    }
}

// ---------------------------------------------------------------------------
// A URL leva art, mus e apikey, percent-encoded — e é o ÚNICO lugar onde a
// chave aparece.
// ---------------------------------------------------------------------------
#[test]
fn the_url_carries_art_mus_and_the_key_percent_encoded() {
    let capturada = RefCell::new(String::new());
    let _ = vagalume::fetch_lyrics_vagalume(
        "Água Viva",
        "Coral & Novo",
        CHAVE,
        &|url: &str| {
            *capturada.borrow_mut() = url.to_string();
            Ok("{}".into())
        },
        SEM_PLACEHOLDER,
    )
    .unwrap();
    let url = capturada.borrow().clone();
    assert_eq!(
        url,
        "https://api.vagalume.com.br/search.php\
         ?art=Coral%20%26%20Novo&mus=%C3%81gua%20Viva&apikey=chave-vagalume-de-teste"
    );
}

// ---------------------------------------------------------------------------
// Erro de rede sobe para o chamador (o lote o transforma em erro POR MÚSICA),
// e a mensagem NUNCA carrega a chave — ela não pode vazar para log, toast ou
// relatório.
// ---------------------------------------------------------------------------
#[test]
fn a_network_error_propagates_without_leaking_the_key() {
    let err = vagalume::fetch_lyrics_vagalume(
        "Água Viva",
        "Coral Novo",
        CHAVE,
        &|_url: &str| Err(AppError("sem conexão".into())),
        SEM_PLACEHOLDER,
    )
    .expect_err("erro do fetcher propaga");
    assert_eq!(err.to_string(), "sem conexão");
    assert!(!err.to_string().contains(CHAVE));
}

// ---------------------------------------------------------------------------
// Corpo vazio, inválido ou fora de forma = "não temos" (nunca erro): a base
// responde 404 com corpo vazio para música que não conhece.
// ---------------------------------------------------------------------------
#[test]
fn an_empty_or_malformed_body_is_simply_no_result() {
    for corpo in [
        "",
        "   ",
        "não é json",
        "[]",
        "null",
        r#"{"type":"exact"}"#,
        r#"{"type":"exact","art":{"name":"Coral Novo"},"mus":"Água Viva"}"#,
        r#"{"type":"exact","art":{"name":"Coral Novo"},"mus":[1,2]}"#,
    ] {
        assert!(
            buscar("Água Viva", "Coral Novo", corpo).is_none(),
            "corpo {corpo:?} deveria ser 'sem resultado'"
        );
    }
}
