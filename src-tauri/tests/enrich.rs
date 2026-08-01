//! Testes de integração da F13 (PRD V5) — enriquecimento em lote no app:
//! enrich_scan (propostas via LRCLIB com fetcher stub, sem rede) e apply
//! (gravação via writer::write_tags, que no lote nunca apaga dados
//! existentes — só preenche/atualiza o que veio).

use cancioneiro_lib::enrich::{self, EnrichApply};
use cancioneiro_lib::error::AppError;
use cancioneiro_lib::{db, indexer, lyrics_fetch, lyrics_ovh, writer};
use rusqlite::Connection;
use std::cell::RefCell;
use std::fs;
use std::path::Path;
use std::time::Duration;

mod common;
use common::copy_fixture;

const ZERO: Duration = Duration::ZERO;

/// Callback de progresso ignorado pelos testes que não o exercitam.
const SEM_PROGRESSO: fn(usize, usize, &str, &str) = |_, _, _, _| {};

/// Predicado de cancelamento dos testes que não exercitam o "Cancelar".
const SEM_CANCELAMENTO: fn() -> bool = || false;

/// As etapas ligadas na máquina dos testes: nenhuma que dependa de acessório
/// baixado. A conta do TEMPO é exercitada em teste próprio.
const PADRAO: enrich::EtapasLigadas = enrich::EtapasLigadas {
    som: false,
    transcricao: false,
};

/// `enrich_scan` sem pausa de cortesia e sem progresso — a forma usada pela
/// maioria dos testes, que exercitam só as propostas.
fn scan_props(
    conn: &Connection,
    prefixo: &str,
    fetch: impl Fn(&str) -> Result<String, AppError>,
) -> Vec<enrich::EnrichProposal> {
    enrich::enrich_scan(
        conn,
        prefixo,
        fetch,
        ZERO,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap().propostas
}

/// Só os eventos que fazem a barra andar — a cadência de "1 evento inicial +
/// 1 por música" que existia antes das etapas (V8/F18) virem para dentro do
/// mesmo evento.
fn passos(eventos: &[(usize, usize, String, String)]) -> Vec<(usize, usize, String)> {
    eventos
        .iter()
        .filter(|e| e.3 == enrich::ETAPA_PREPARANDO || e.3 == enrich::ETAPA_CONCLUIDA)
        .map(|e| (e.0, e.1, e.2.clone()))
        .collect()
}

/// Copia fixtures para um tempdir com os nomes/subpastas pedidos, registra a
/// pasta e indexa. Devolve (tempdir, conn, folder_id).
fn setup_with(files: &[(&str, &str)]) -> (tempfile::TempDir, Connection, i64) {
    let dir = tempfile::tempdir().unwrap();
    for (src, dst) in files {
        let dest = dir.path().join(dst);
        fs::create_dir_all(dest.parent().unwrap()).unwrap();
        copy_fixture(src, &dest);
    }
    let conn = db::open_in_memory().unwrap();
    let folder_id = db::add_folder(&conn, dir.path().to_str().unwrap()).unwrap();
    indexer::scan_folder(&conn, folder_id, |_, _| {}).unwrap();
    (dir, conn, folder_id)
}

fn song_by_suffix(conn: &Connection, suffix: &str) -> db::Song {
    db::list_songs(conn)
        .unwrap()
        .into_iter()
        .find(|s| s.file_path.ends_with(suffix))
        .unwrap_or_else(|| panic!("{suffix} deveria estar indexada"))
}

// ---------------------------------------------------------------------------
// F13 — fluxo completo: scan acha a incompleta (sem tags), LRCLIB (stub)
// identifica com confiança ALTA (letra incluída na proposta — sem segunda
// rodada de rede) e apply grava tudo via write_tags; round-trip pelo disco.
// ---------------------------------------------------------------------------
#[test]
fn enrich_scan_proposes_and_apply_writes_full_flow() {
    let (_dir, conn, folder_id) = setup_with(&[
        ("sem_tags.mp3", "Falamansa - Oh! Chuva.mp3"),
        ("com_letra.mp3", "com_letra.mp3"),
    ]);
    let chuva = song_by_suffix(&conn, "Oh! Chuva.mp3");
    let dur = chuva.duration_seconds.expect("fixture tem duração") as f64;
    let letra = "Chove lá fora\ne aqui dentro também chove";
    let body = format!(
        r#"[{{"trackName": "Oh! Chuva", "artistName": "Falamansa",
             "duration": {dur}, "plainLyrics": "Chove lá fora\ne aqui dentro também chove"}}]"#
    );

    let urls: RefCell<Vec<String>> = RefCell::new(Vec::new());
    let props = enrich::enrich_scan(
        &conn,
        "",
        |url: &str| {
            urls.borrow_mut().push(url.to_string());
            Ok(body.clone())
        },
        ZERO,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap().propostas;

    // com_letra tem título+artista+letra: completa, fora da lista
    assert!(
        props.iter().all(|p| !p.file_path.ends_with("com_letra.mp3")),
        "música completa não entra no lote"
    );
    assert!(!urls.borrow().is_empty(), "incompleta gera consulta");

    let p = props
        .iter()
        .find(|p| p.song_id == chuva.id)
        .expect("proposta para a música incompleta");
    assert_eq!(p.confidence, "alta");
    assert_eq!(p.proposed_title, "Oh! Chuva");
    assert_eq!(p.proposed_artist.as_deref(), Some("Falamansa"));
    assert_eq!(p.lyrics.as_deref(), Some(letra), "letra vem na proposta");
    assert!(p.error.is_none());
    // dados atuais expostos para a UI de revisão
    assert_eq!(p.current_title, "Falamansa - Oh! Chuva");
    assert_eq!(p.current_artist, None);
    assert_eq!(p.file_path, chuva.file_path);

    // apply grava via write_tags e devolve um resultado por música
    let results = enrich::apply(
        &conn,
        &[EnrichApply {
            song_id: chuva.id,
            title: p.proposed_title.clone(),
            artist: p.proposed_artist.clone(),
            lyrics: p.lyrics.clone(),
            add_temas: Some("chuva".into()),
            current_title: p.current_title.clone(),
            current_artist: p.current_artist.clone(),
            fonte: None,
            substituir_letra: false,
            marcar_instrumental: false,
        }],
    )
    .unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].song_id, chuva.id);
    assert!(results[0].error.is_none());
    let song = results[0].song.as_ref().expect("gravada e reindexada");
    assert_eq!(song.id, chuva.id);
    assert_eq!(song.title, "Oh! Chuva");
    assert_eq!(song.artist.as_deref(), Some("Falamansa"));
    assert!(song.has_lyrics);
    assert_eq!(song.temas.as_deref(), Some("chuva"));

    // round-trip: rescan relê do disco exatamente o que foi gravado
    indexer::scan_folder(&conn, folder_id, |_, _| {}).unwrap();
    let reread = song_by_suffix(&conn, "Oh! Chuva.mp3");
    assert_eq!(reread.title, "Oh! Chuva");
    assert_eq!(reread.artist.as_deref(), Some("Falamansa"));
    assert_eq!(reread.temas.as_deref(), Some("chuva"));
    assert_eq!(db::get_lyrics(&conn, reread.id).unwrap().as_deref(), Some(letra));

    // agora completa: um novo enrich_scan não a propõe mais
    let props = scan_props(&conn, "", |_: &str| Ok("[]".into()));
    assert!(props.iter().all(|q| q.song_id != chuva.id));
}

// ---------------------------------------------------------------------------
// F13 — seleção: só músicas incompletas (sem letra OU título/artista
// placeholder) e só sob o prefixo de pasta pedido (vazio = todas).
// `sem_letra.mp3` tem tags reais e nenhum resultado do LRCLIB: o palpite
// reproduz exatamente as tags atuais, então a proposta seria um NO-OP e é
// descartada (ver no_op_proposal_is_never_produced).
// ---------------------------------------------------------------------------
#[test]
fn enrich_scan_selects_only_incomplete_songs_under_prefix() {
    let (dir, conn, _folder_id) = setup_with(&[
        ("com_letra.mp3", "com_letra.mp3"), // completa
        ("sem_letra.mp3", "sem_letra.mp3"), // tags reais, sem letra: no-op
        ("sem_tags.mp3", "Falamansa - Oh! Chuva.mp3"), // sem tags, raiz
        ("sem_tags.mp3", "Sub/Zeca - Camarão.mp3"), // sem tags, subpasta
    ]);

    // sem resultados do LRCLIB: tudo vira BAIXA (palpite de nome de arquivo)
    let props = scan_props(&conn, "", |_: &str| Ok("[]".into()));
    let mut paths: Vec<&str> = props.iter().map(|p| p.file_path.as_str()).collect();
    paths.sort();
    assert_eq!(props.len(), 2, "só as 2 que mudam algo: {paths:?}");
    assert!(props.iter().all(|p| p.confidence == "baixa"));
    assert!(props.iter().all(|p| p.lyrics.is_none()), "BAIXA nunca traz letra");
    assert!(props.iter().all(|p| p.error.is_none()));
    assert!(
        props.iter().all(|p| !p.file_path.ends_with("com_letra.mp3")),
        "música completa não entra no lote"
    );
    assert!(
        props.iter().all(|p| !p.file_path.ends_with("sem_letra.mp3")),
        "proposta que não mudaria nada não é produzida"
    );

    // Arquivo SEM tag nenhuma: o `title` do banco é invenção do indexador
    // (indexer.rs copia o nome do arquivo quando não há TIT2), então a etapa 1
    // divide o nome em título e artista em vez de repetir o nome cru. Antes
    // daqui saía título "Falamansa - Oh! Chuva" COM artista "Falamansa" — o
    // artista duplicado dentro do próprio título.
    let chuva = props
        .iter()
        .find(|p| p.file_path.ends_with("Oh! Chuva.mp3"))
        .unwrap();
    assert_eq!(chuva.proposed_title, "Oh! Chuva");
    assert_eq!(chuva.proposed_artist.as_deref(), Some("Falamansa"));

    // prefixo de pasta: só a da subpasta
    let prefix = dir
        .path()
        .canonicalize()
        .unwrap()
        .join("Sub")
        .to_string_lossy()
        .into_owned();
    let props = scan_props(&conn, &prefix, |_: &str| Ok("[]".into()));
    assert_eq!(props.len(), 1);
    assert!(props[0].file_path.ends_with("Camarão.mp3"));
}

// ---------------------------------------------------------------------------
// F13 — o prefixo de pasta casa FRONTEIRA de pasta, não string bruta: com as
// pastas irmãs "1" e "10", o prefixo ".../1" NÃO pode incluir ".../10/x.mp3"
// (mesma regra do isUnderFolder de src/lib/folderTree.ts).
// ---------------------------------------------------------------------------
#[test]
fn folder_prefix_matches_whole_path_segments_only() {
    let (dir, conn, _folder_id) = setup_with(&[
        ("sem_tags.mp3", "1/Falamansa - Um.mp3"),
        ("sem_tags.mp3", "10/Falamansa - Dez.mp3"),
    ]);
    let raiz = dir.path().canonicalize().unwrap();

    // prefixo ".../1" sem barra final: só a música da pasta "1"
    let prefixo = raiz.join("1").to_string_lossy().into_owned();
    let props = scan_props(&conn, &prefixo, |_: &str| Ok("[]".into()));
    let paths: Vec<&str> = props.iter().map(|p| p.file_path.as_str()).collect();
    assert_eq!(props.len(), 1, "prefixo .../1 não casa .../10: {paths:?}");
    assert!(props[0].file_path.ends_with("Falamansa - Um.mp3"));

    // prefixo com separador no fim: mesmo resultado
    let com_barra = format!("{prefixo}{}", std::path::MAIN_SEPARATOR);
    let props = scan_props(&conn, &com_barra, |_: &str| Ok("[]".into()));
    assert_eq!(props.len(), 1);
    assert!(props[0].file_path.ends_with("Falamansa - Um.mp3"));

    // e a pasta "10" continua alcançável pelo próprio prefixo
    let prefixo10 = raiz.join("10").to_string_lossy().into_owned();
    let props = scan_props(&conn, &prefixo10, |_: &str| Ok("[]".into()));
    assert_eq!(props.len(), 1);
    assert!(props[0].file_path.ends_with("Falamansa - Dez.mp3"));
}

// ---------------------------------------------------------------------------
// F13 — tag placeholder ("02 AudioTrack 02" / "no artist") é tratada como
// VAZIA: a música conta como incompleta, o placeholder nunca vira consulta
// nem proposta — vale o palpite do nome de arquivo.
// ---------------------------------------------------------------------------
#[test]
fn placeholder_tags_are_treated_as_empty_and_never_queried() {
    let (_dir, conn, _folder_id) =
        setup_with(&[("sem_letra.mp3", "Cheganca - Antonio Nobrega.mp3")]);
    let song = song_by_suffix(&conn, "Cheganca - Antonio Nobrega.mp3");
    writer::write_tags(&conn, song.id, "02 AudioTrack 02", Some("no artist"), None, None, None)
        .unwrap();

    let urls: RefCell<Vec<String>> = RefCell::new(Vec::new());
    let props = enrich::enrich_scan(
        &conn,
        "",
        |url: &str| {
            urls.borrow_mut().push(url.to_string());
            Ok("[]".into())
        },
        ZERO,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap().propostas;

    assert_eq!(props.len(), 1, "placeholder conta como incompleta");
    let p = &props[0];
    assert_eq!(p.confidence, "baixa");
    // palpite do NOME do arquivo (primeira ordem: Artista - Título)
    assert_eq!(p.proposed_title, "Antonio Nobrega");
    assert_eq!(p.proposed_artist.as_deref(), Some("Cheganca"));
    // atuais preservados para a UI mostrar o que será substituído
    assert_eq!(p.current_title, "02 AudioTrack 02");
    assert_eq!(p.current_artist.as_deref(), Some("no artist"));

    for url in urls.borrow().iter() {
        assert!(
            !url.contains("AudioTrack") && !url.contains("no%20artist"),
            "placeholder nunca vira consulta: {url}"
        );
    }
}

// ---------------------------------------------------------------------------
// F13 (V0.5, teste real) — proposta que NÃO MUDA NADA nunca é produzida: no
// acervo de 94 músicas o usuário viu linhas do tipo "Abrição de portas —
// Antônio Nóbrega" → "Abrição de portas — Antônio Nóbrega" (BAIXA, sem letra)
// e perdeu tempo tentando descobrir o que estava sendo sugerido.
// ---------------------------------------------------------------------------
#[test]
fn no_op_proposal_is_never_produced() {
    let (_dir, conn, _folder_id) = setup_with(&[
        // tags reais + nome de arquivo que reproduz exatamente as tags:
        // o palpite BAIXA seria idêntico ao atual — nada a revisar
        ("sem_letra.mp3", "Banda Fixture - Instrumental Sem Letra.mp3"),
        // sem tags: o nome revela o artista — muda algo, continua na lista
        ("sem_tags.mp3", "Falamansa - Oh! Chuva.mp3"),
    ]);

    let props = scan_props(&conn, "", |_: &str| Ok("[]".into()));

    let paths: Vec<&str> = props.iter().map(|p| p.file_path.as_str()).collect();
    assert_eq!(props.len(), 1, "só a que muda algo: {paths:?}");
    assert!(props[0].file_path.ends_with("Oh! Chuva.mp3"));
    assert_eq!(props[0].proposed_artist.as_deref(), Some("Falamansa"));

    // nenhuma proposta sobrevivente é um no-op
    for p in &props {
        let mudou_titulo = p.proposed_title.trim() != p.current_title.trim();
        let mudou_artista = p.proposed_artist.as_deref().unwrap_or("").trim()
            != p.current_artist.as_deref().unwrap_or("").trim();
        assert!(
            mudou_titulo || mudou_artista || p.lyrics.is_some() || p.error.is_some(),
            "proposta sem mudança alguma: {p:?}"
        );
    }
}

// ---------------------------------------------------------------------------
// F13 (V0.5) — o no-op NÃO pode engolir os casos úteis: título placeholder com
// palpite diferente continua sendo proposto (é o motivo do lote existir).
// ---------------------------------------------------------------------------
#[test]
fn placeholder_title_still_produces_proposal() {
    let (_dir, conn, _folder_id) =
        setup_with(&[("sem_letra.mp3", "Cheganca - Antonio Nobrega.mp3")]);
    let song = song_by_suffix(&conn, "Cheganca - Antonio Nobrega.mp3");
    writer::write_tags(&conn, song.id, "Faixa 5", Some("Banda Fixture"), None, None, None).unwrap();

    let props = scan_props(&conn, "", |_: &str| Ok("[]".into()));
    assert_eq!(props.len(), 1, "placeholder com palpite diferente é proposta");
    assert_eq!(props[0].current_title, "Faixa 5");
    assert_eq!(props[0].proposed_title, "Antonio Nobrega");
    assert_eq!(props[0].proposed_artist.as_deref(), Some("Banda Fixture"));
}

// ---------------------------------------------------------------------------
// F13 (V0.5) — proposta com LETRA sobrevive mesmo com título/artista iguais:
// a letra É a mudança.
// ---------------------------------------------------------------------------
#[test]
fn proposal_with_lyrics_survives_identical_title_and_artist() {
    let (_dir, conn, _folder_id) =
        setup_with(&[("sem_letra.mp3", "Banda Fixture - Instrumental Sem Letra.mp3")]);
    let song = song_by_suffix(&conn, "Instrumental Sem Letra.mp3");
    let dur = song.duration_seconds.unwrap() as f64;
    let body = format!(
        r#"[{{"trackName": "Instrumental Sem Letra", "artistName": "Banda Fixture",
             "duration": {dur}, "plainLyrics": "agora tem letra"}}]"#
    );

    let props = scan_props(&conn, "", move |_: &str| Ok(body.clone()));

    assert_eq!(props.len(), 1, "a letra é a mudança");
    assert_eq!(props[0].confidence, "alta");
    assert_eq!(props[0].proposed_title, props[0].current_title);
    assert_eq!(props[0].proposed_artist, props[0].current_artist);
    assert_eq!(props[0].lyrics.as_deref(), Some("agora tem letra"));
}

// ---------------------------------------------------------------------------
// F13 (V0.5) — proposta com ERRO sobrevive mesmo sem mudar nada: a UI mostra a
// linha desabilitada para o usuário saber que aquela música foi tentada e
// falhou (decisão 47).
// ---------------------------------------------------------------------------
#[test]
fn error_proposal_survives_even_when_it_changes_nothing() {
    let (_dir, conn, _folder_id) =
        setup_with(&[("sem_letra.mp3", "Banda Fixture - Instrumental Sem Letra.mp3")]);

    let props = enrich::enrich_scan(
        &conn,
        "",
        |_: &str| -> Result<String, AppError> { Err(AppError("sem conexão".into())) },
        ZERO,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap().propostas;

    assert_eq!(props.len(), 1, "linha de erro nunca é descartada como no-op");
    assert_eq!(props[0].error.as_deref(), Some("sem conexão"));
    assert_eq!(props[0].proposed_title, props[0].current_title);
    assert_eq!(props[0].proposed_artist, props[0].current_artist);
    assert!(props[0].lyrics.is_none());
}

// ---------------------------------------------------------------------------
// F13 — resultado do LRCLIB com trackName/artistName placeholder é descartado
// antes do score (nunca vira proposta).
// ---------------------------------------------------------------------------
#[test]
fn placeholder_results_from_lrclib_are_discarded() {
    let (_dir, conn, _folder_id) =
        setup_with(&[("sem_tags.mp3", "Falamansa - Oh! Chuva.mp3")]);
    let song = song_by_suffix(&conn, "Oh! Chuva.mp3");
    let dur = song.duration_seconds.unwrap() as f64;
    let body = format!(
        r#"[{{"trackName": "AudioTrack 5", "artistName": "Falamansa",
             "duration": {dur}, "plainLyrics": "letra lixo"}},
            {{"trackName": "Oh! Chuva", "artistName": "Artista Desconhecido",
             "duration": {dur}, "plainLyrics": "letra lixo"}}]"#
    );

    let props = scan_props(&conn, "", move |_: &str| Ok(body.clone()));
    assert_eq!(props.len(), 1);
    assert_eq!(props[0].confidence, "baixa");
    assert!(props[0].lyrics.is_none(), "resultado placeholder não vira proposta");
}

// ---------------------------------------------------------------------------
// F13 — confiança MÉDIA (dif de duração entre 8 e 15 s) ainda traz a letra.
// ---------------------------------------------------------------------------
#[test]
fn media_confidence_proposal_still_carries_lyrics() {
    let (_dir, conn, _folder_id) =
        setup_with(&[("sem_tags.mp3", "Falamansa - Oh! Chuva.mp3")]);
    let song = song_by_suffix(&conn, "Oh! Chuva.mp3");
    let dur = song.duration_seconds.unwrap() as f64 + 10.0; // dif 10s ⇒ média
    let body = format!(
        r#"[{{"trackName": "Oh! Chuva", "artistName": "Falamansa",
             "duration": {dur}, "plainLyrics": "letra"}}]"#
    );

    let props = scan_props(&conn, "", move |_: &str| Ok(body.clone()));
    assert_eq!(props.len(), 1);
    assert_eq!(props[0].confidence, "media");
    assert_eq!(props[0].lyrics.as_deref(), Some("letra"));
}

// ---------------------------------------------------------------------------
// F13 (V0.5, teste real) — progresso por música: no acervo de 94 músicas a
// varredura roda por minutos sem nenhum sinal de vida. `enrich_scan` avisa
// depois de CADA música, espelhando o callback |done, total| do indexer.
// ---------------------------------------------------------------------------
#[test]
fn enrich_scan_reports_progress_per_candidate_song() {
    let (_dir, conn, _folder_id) = setup_with(&[
        ("com_letra.mp3", "com_letra.mp3"), // V10: completa TAMBÉM é candidata
        ("sem_tags.mp3", "Falamansa - Oh! Chuva.mp3"),
        ("sem_tags.mp3", "Sub/Zeca - Camarão.mp3"),
        ("sem_letra.mp3", "sem_letra.mp3"),
    ]);

    let eventos: RefCell<Vec<(usize, usize, String, String)>> = RefCell::new(Vec::new());
    enrich::enrich_scan(
        &conn,
        "",
        |_: &str| Ok("[]".into()),
        ZERO,
        |done, total, atual, etapa| {
            eventos
                .borrow_mut()
                .push((done, total, atual.to_string(), etapa.to_string()))
        },
        SEM_CANCELAMENTO,
    )
    .unwrap().propostas;

    let todos = eventos.borrow();
    let ev = passos(&todos);
    // V10 — 4 músicas, TODAS candidatas (a completa entra: é nela que a
    // etiqueta errada aparece) + o evento inicial com done=0
    assert_eq!(ev.len(), 5, "1 evento inicial + 1 por candidata: {ev:?}");
    assert_eq!(ev[0].0, 0, "primeiro evento anuncia o total antes de começar");
    assert!(todos.iter().all(|e| e.1 == 4), "total = candidatas: {todos:?}");
    assert_eq!(
        ev.iter().map(|e| e.0).collect::<Vec<_>>(),
        vec![0, 1, 2, 3, 4],
        "done cresce de 1 em 1"
    );
    // e `done` NUNCA volta atrás, nem nos eventos de etapa
    assert!(
        todos.windows(2).all(|w| w[1].0 >= w[0].0),
        "done nunca regride: {todos:?}"
    );

    // `atual` é o NOME BASE do arquivo, nunca o caminho completo
    let mut nomes: Vec<&str> = ev[1..].iter().map(|e| e.2.as_str()).collect();
    nomes.sort();
    assert_eq!(
        nomes,
        vec![
            "Falamansa - Oh! Chuva.mp3",
            "Zeca - Camarão.mp3",
            "com_letra.mp3",
            "sem_letra.mp3"
        ]
    );
    assert!(
        todos.iter().all(|e| !e.2.contains(std::path::MAIN_SEPARATOR)),
        "nome base, não caminho: {todos:?}"
    );
}

// ---------------------------------------------------------------------------
// F13 (V0.5) — o progresso mede TRABALHO, não resultado: continua avançando
// nas músicas cuja proposta é descartada por ser no-op, nas que falham na rede
// e nas que sumiram do disco. A barra nunca trava nem termina antes do fim.
// ---------------------------------------------------------------------------
#[test]
fn progress_advances_for_dropped_failed_and_missing_songs() {
    let (_dir, conn, _folder_id) = setup_with(&[
        // tags reais + nome idêntico às tags: proposta descartada (no-op)
        ("sem_letra.mp3", "Banda Fixture - Instrumental Sem Letra.mp3"),
        ("sem_tags.mp3", "Falha.mp3"),   // erro de rede
        ("sem_tags.mp3", "Sumida.mp3"),  // arquivo apagado do disco
    ]);
    fs::remove_file(&song_by_suffix(&conn, "Sumida.mp3").file_path).unwrap();

    let eventos: RefCell<Vec<(usize, usize, String, String)>> = RefCell::new(Vec::new());
    let props = enrich::enrich_scan(
        &conn,
        "",
        |url: &str| {
            if url.contains("Instrumental") {
                Ok("[]".into()) // acha nada ⇒ palpite igual às tags ⇒ no-op
            } else {
                Err(AppError("sem conexão".into()))
            }
        },
        ZERO,
        |done, total, atual, etapa| {
            eventos
                .borrow_mut()
                .push((done, total, atual.to_string(), etapa.to_string()))
        },
        SEM_CANCELAMENTO,
    )
    .unwrap().propostas;

    // resultado: a no-op sumiu, as duas com erro ficaram
    assert_eq!(props.len(), 2, "só a no-op é descartada");
    assert!(props.iter().all(|p| p.error.is_some()));

    // progresso: as TRÊS candidatas contam, inclusive a descartada
    let todos = eventos.borrow();
    let ev = passos(&todos);
    assert_eq!(
        ev.iter().map(|e| e.0).collect::<Vec<_>>(),
        vec![0, 1, 2, 3],
        "progresso não trava na descartada nem na que falhou: {ev:?}"
    );
    assert!(todos.iter().all(|e| e.1 == 3), "total conta trabalho, não resultado");
    assert!(
        ev[1..]
            .iter()
            .any(|e| e.2 == "Banda Fixture - Instrumental Sem Letra.mp3"),
        "a música descartada também emite progresso: {ev:?}"
    );
}

// ---------------------------------------------------------------------------
// F13 — apply com None NÃO apaga: letra existente, artista e temas ficam;
// add_temas SOMA aos existentes (normalização/dedup do writer).
// ---------------------------------------------------------------------------
#[test]
fn apply_with_none_preserves_existing_lyrics_artist_and_temas() {
    let (_dir, conn, folder_id) = setup_with(&[("com_letra.mp3", "com_letra.mp3")]);
    let song = song_by_suffix(&conn, "com_letra.mp3");
    let letra_antes = db::get_lyrics(&conn, song.id).unwrap().expect("fixture tem letra");
    assert_eq!(song.temas.as_deref(), Some("água; esperança"));

    let results = enrich::apply(
        &conn,
        &[EnrichApply {
            song_id: song.id,
            title: "Coração Sertanejo".into(),
            artist: None,
            lyrics: None,
            add_temas: None,
            current_title: song.title.clone(),
            current_artist: song.artist.clone(),
            fonte: None,
            substituir_letra: false,
            marcar_instrumental: false,
        }],
    )
    .unwrap();
    let updated = results[0].song.as_ref().expect("gravada");
    assert_eq!(updated.artist.as_deref(), Some("Artista Teste"), "artista preservado");
    assert!(updated.has_lyrics, "letra preservada");
    assert_eq!(updated.temas.as_deref(), Some("água; esperança"), "temas preservados");
    assert_eq!(
        db::get_lyrics(&conn, song.id).unwrap().as_deref(),
        Some(letra_antes.as_str()),
        "lyrics None não mexe na letra existente"
    );

    // add_temas soma (dedup sem acento, ordenado) sem apagar os existentes
    let results = enrich::apply(
        &conn,
        &[EnrichApply {
            song_id: song.id,
            title: "Coração Sertanejo".into(),
            artist: None,
            lyrics: None,
            add_temas: Some("Chuva; agua".into()),
            current_title: song.title.clone(),
            current_artist: song.artist.clone(),
            fonte: None,
            substituir_letra: false,
            marcar_instrumental: false,
        }],
    )
    .unwrap();
    let updated = results[0].song.as_ref().expect("gravada");
    assert_eq!(updated.temas.as_deref(), Some("água; chuva; esperança"));

    // releitura do disco confirma que nada foi apagado no arquivo
    indexer::scan_folder(&conn, folder_id, |_, _| {}).unwrap();
    let reread = song_by_suffix(&conn, "com_letra.mp3");
    assert_eq!(reread.artist.as_deref(), Some("Artista Teste"));
    assert_eq!(reread.temas.as_deref(), Some("água; chuva; esperança"));
    assert_eq!(
        db::get_lyrics(&conn, reread.id).unwrap().as_deref(),
        Some(letra_antes.as_str())
    );
}

// ---------------------------------------------------------------------------
// V8/F17 — o lote NÃO desmarca instrumental: gravar título/artista/letra por
// cima de um arquivo marcado à mão preserva o TXXX:INSTRUMENTAL. "A escolha
// humana manda: marcada à mão, nenhuma rotina desmarca sozinha" (PRD V8).
// ---------------------------------------------------------------------------
#[test]
fn apply_never_clears_the_instrumental_mark() {
    let (_dir, conn, folder_id) = setup_with(&[("sem_letra.mp3", "sem_letra.mp3")]);
    let song = song_by_suffix(&conn, "sem_letra.mp3");

    // marca à mão, pelo mesmo caminho do editor do player
    writer::write_tags(
        &conn,
        song.id,
        &song.title,
        song.artist.as_deref(),
        None,
        None,
        Some(true),
    )
    .unwrap();

    let results = enrich::apply(
        &conn,
        &[EnrichApply {
            song_id: song.id,
            title: "Doce Prelúdio".into(),
            artist: Some("Banda Fixture".into()),
            lyrics: Some("Letra que o lote achou por aí".into()),
            add_temas: Some("prelúdio".into()),
            current_title: song.title.clone(),
            current_artist: song.artist.clone(),
            fonte: None,
            substituir_letra: false,
            marcar_instrumental: false,
        }],
    )
    .unwrap();

    let updated = results[0].song.as_ref().expect("gravada");
    assert!(updated.instrumental, "o lote não pode desmarcar sozinho");
    assert_eq!(updated.title, "Doce Prelúdio");

    // e o disco concorda: um scan do zero relê a marca
    indexer::scan_folder(&conn, folder_id, |_, _| {}).unwrap();
    assert!(song_by_suffix(&conn, "sem_letra.mp3").instrumental);
}

// ---------------------------------------------------------------------------
// V8/F17 — a varredura em lote do app é uma ETAPA DE LETRA e, como todas as
// outras ("buscar-letra, identificar --com-letra, transcrever, Vagalume e a
// varredura em lote do app"), PULA o arquivo marcado como instrumental.
//
// Dois danos concretos quando não pulava: (1) um instrumental com título e
// artista corretos casa com a versão CANTADA da mesma peça no LRCLIB, sai
// ALTA, e ALTA chega pré-marcada na revisão (DECISIONS #49) — um clique
// grava a letra de outra gravação dentro do arquivo; (2) queima rede em todo
// instrumental, em toda varredura, que é exatamente a economia prometida
// pela F17.
// ---------------------------------------------------------------------------
#[test]
fn scan_skips_instrumental_songs_without_network_or_proposal() {
    let (_dir, conn, _folder_id) = setup_with(&[
        ("sem_letra.mp3", "Doce Prelúdio.mp3"),
        ("sem_tags.mp3", "Falamansa - Oh! Chuva.mp3"),
    ]);
    let preludio = song_by_suffix(&conn, "Doce Prelúdio.mp3");

    // marcada à mão no editor do player — com título e artista CORRETOS, que
    // é justamente o caso perigoso (a impressão digital deve preenchê-los).
    writer::write_tags(
        &conn,
        preludio.id,
        "Doce Prelúdio",
        Some("Banda Fixture"),
        None,
        None,
        Some(true),
    )
    .unwrap();

    // o stub devolve um casamento PERFEITO para qualquer consulta: se a
    // instrumental for consultada, ela vira proposta ALTA com letra.
    let dur = preludio.duration_seconds.expect("fixture tem duração") as f64;
    let body = format!(
        r#"[{{"trackName": "Doce Prelúdio", "artistName": "Banda Fixture",
             "duration": {dur}, "plainLyrics": "Letra da versão cantada"}}]"#
    );
    let urls: RefCell<Vec<String>> = RefCell::new(Vec::new());
    let props = enrich::enrich_scan(
        &conn,
        "",
        |url: &str| {
            urls.borrow_mut().push(url.to_string());
            Ok(body.clone())
        },
        ZERO,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap().propostas;

    assert!(
        !props.iter().any(|p| p.song_id == preludio.id),
        "instrumental não pode virar proposta: {:?}",
        props
            .iter()
            .filter(|p| p.song_id == preludio.id)
            .collect::<Vec<_>>()
    );
    assert!(
        !urls.borrow().iter().any(|u| u.contains("Prel")),
        "instrumental não pode gastar rede: {:?}",
        urls.borrow()
    );

    // a vizinha incompleta continua sendo processada normalmente — pular o
    // instrumental não pode virar pular a pasta.
    assert!(
        props.iter().any(|p| p.file_path.ends_with("Oh! Chuva.mp3")),
        "a música incompleta ao lado continua sendo proposta"
    );
}

// ---------------------------------------------------------------------------
// V10 — o instrumental CONTA no progresso, e é a mudança do caminho único: as
// etapas 1 e 2 rodam nele (ele pode e deve ganhar título e artista corretos),
// e é o áudio dele que a etapa 2 lê. O que ele não faz é gastar rede nas
// etapas de LETRA — e é isso que este teste continua provando.
// ---------------------------------------------------------------------------
#[test]
fn o_instrumental_conta_no_progresso_e_nao_gasta_rede_de_letra() {
    let (_dir, conn, _folder_id) = setup_with(&[
        ("sem_letra.mp3", "Doce Prelúdio.mp3"),
        ("sem_tags.mp3", "Falamansa - Oh! Chuva.mp3"),
    ]);
    let preludio = song_by_suffix(&conn, "Doce Prelúdio.mp3");
    writer::write_tags(
        &conn,
        preludio.id,
        "Doce Prelúdio",
        Some("Banda Fixture"),
        None,
        None,
        Some(true),
    )
    .unwrap();

    let progresso: RefCell<Vec<(usize, usize)>> = RefCell::new(Vec::new());
    enrich::enrich_scan(
        &conn,
        "",
        |_: &str| Ok("[]".into()),
        ZERO,
        |done, total, _, _| progresso.borrow_mut().push((done, total)),
        SEM_CANCELAMENTO,
    )
    .unwrap().propostas;

    let p = progresso.borrow();
    assert_eq!(p.first().copied(), Some((0, 2)), "total anunciado: {p:?}");
    assert_eq!(p.last().copied(), Some((2, 2)), "progresso completa: {p:?}");
}

// ---------------------------------------------------------------------------
// F13 — arquivo sumido do disco: vira proposta BAIXA com error, sem gastar
// rede; e apply nele falha com a mensagem padrão de arquivo não encontrado.
// ---------------------------------------------------------------------------
#[test]
fn missing_file_becomes_proposal_with_error_without_network() {
    let (_dir, conn, _folder_id) = setup_with(&[("sem_letra.mp3", "sem_letra.mp3")]);
    let song = song_by_suffix(&conn, "sem_letra.mp3");
    fs::remove_file(&song.file_path).unwrap();

    let calls = RefCell::new(0usize);
    let props = enrich::enrich_scan(
        &conn,
        "",
        |_: &str| {
            *calls.borrow_mut() += 1;
            Ok("[]".into())
        },
        ZERO,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap().propostas;
    assert_eq!(props.len(), 1);
    assert_eq!(props[0].confidence, "baixa");
    assert!(props[0].error.is_some(), "arquivo ausente reportado na proposta");
    assert_eq!(*calls.borrow(), 0, "arquivo sumido não gasta rede");

    // aplicar numa música cujo arquivo sumiu vira resultado com error (a
    // mensagem padrão do writer), sem abortar o lote
    let results = enrich::apply(
        &conn,
        &[EnrichApply {
            song_id: song.id,
            title: "T".into(),
            artist: None,
            lyrics: None,
            add_temas: None,
            current_title: song.title.clone(),
            current_artist: song.artist.clone(),
            fonte: None,
            substituir_letra: false,
            marcar_instrumental: false,
        }],
    )
    .unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].song_id, song.id);
    assert!(results[0].song.is_none());
    assert_eq!(
        results[0].error.as_deref(),
        Some(format!("arquivo não encontrado: {}", song.file_path).as_str())
    );
}

// ---------------------------------------------------------------------------
// F13 — apply NUNCA aborta no meio do lote: falha numa música vira entrada
// com `error` e as demais continuam sendo gravadas (a UI recebe o resultado
// de TODAS, inclusive das que já foram para o disco).
// ---------------------------------------------------------------------------
#[test]
fn apply_continues_batch_and_reports_per_song_errors() {
    let (_dir, conn, folder_id) = setup_with(&[
        ("sem_tags.mp3", "a_sem_tags.mp3"),
        ("sem_tags.mp3", "b_sem_tags.mp3"),
        ("sem_tags.mp3", "c_sem_tags.mp3"),
    ]);
    let a = song_by_suffix(&conn, "a_sem_tags.mp3");
    let b = song_by_suffix(&conn, "b_sem_tags.mp3");
    let c = song_by_suffix(&conn, "c_sem_tags.mp3");
    fs::remove_file(&b.file_path).unwrap(); // a 2ª do lote vai falhar

    let lote = [
        EnrichApply {
            song_id: a.id,
            title: "Título A".into(),
            artist: Some("Artista A".into()),
            lyrics: None,
            add_temas: None,
            current_title: a.title.clone(),
            current_artist: a.artist.clone(),
            fonte: None,
            substituir_letra: false,
            marcar_instrumental: false,
        },
        EnrichApply {
            song_id: b.id,
            title: "Título B".into(),
            artist: None,
            lyrics: None,
            add_temas: None,
            current_title: b.title.clone(),
            current_artist: b.artist.clone(),
            fonte: None,
            substituir_letra: false,
            marcar_instrumental: false,
        },
        EnrichApply {
            song_id: c.id,
            title: "Título C".into(),
            artist: None,
            lyrics: Some("letra c".into()),
            add_temas: None,
            current_title: c.title.clone(),
            current_artist: c.artist.clone(),
            fonte: None,
            substituir_letra: false,
            marcar_instrumental: false,
        },
    ];
    let results = enrich::apply(&conn, &lote).unwrap();

    assert_eq!(results.len(), 3, "um resultado por aplicação, na mesma ordem");

    // 1ª: gravada e reindexada
    assert_eq!(results[0].song_id, a.id);
    assert!(results[0].error.is_none());
    let song_a = results[0].song.as_ref().expect("1ª gravada");
    assert_eq!(song_a.title, "Título A");
    assert_eq!(song_a.artist.as_deref(), Some("Artista A"));

    // 2ª: falhou (arquivo sumido) com a mensagem do writer; lote continuou
    assert_eq!(results[1].song_id, b.id);
    assert!(results[1].song.is_none());
    assert_eq!(
        results[1].error.as_deref(),
        Some(format!("arquivo não encontrado: {}", b.file_path).as_str())
    );

    // 3ª: gravada mesmo com a 2ª tendo falhado
    assert_eq!(results[2].song_id, c.id);
    assert!(results[2].error.is_none());
    let song_c = results[2].song.as_ref().expect("3ª gravada");
    assert_eq!(song_c.title, "Título C");
    assert!(song_c.has_lyrics);

    // round-trip: o disco confirma que 1ª e 3ª foram realmente escritas
    indexer::scan_folder(&conn, folder_id, |_, _| {}).unwrap();
    assert_eq!(song_by_suffix(&conn, "a_sem_tags.mp3").title, "Título A");
    let c_reread = song_by_suffix(&conn, "c_sem_tags.mp3");
    assert_eq!(c_reread.title, "Título C");
    assert_eq!(
        db::get_lyrics(&conn, c_reread.id).unwrap().as_deref(),
        Some("letra c")
    );
}

// ---------------------------------------------------------------------------
// F13 — erro de rede por música: proposta BAIXA com error = "sem conexão";
// o lote nunca aborta (todas as incompletas ganham proposta).
// ---------------------------------------------------------------------------
#[test]
fn network_error_yields_baixa_proposal_and_never_aborts_batch() {
    let (_dir, conn, _folder_id) = setup_with(&[
        ("sem_letra.mp3", "sem_letra.mp3"),
        ("sem_tags.mp3", "sem_tags.mp3"),
    ]);

    let props = enrich::enrich_scan(
        &conn,
        "",
        |_: &str| -> Result<String, AppError> { Err(AppError("sem conexão".into())) },
        ZERO,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap().propostas;

    assert_eq!(props.len(), 2, "erro de rede nunca aborta o lote");
    for p in &props {
        assert_eq!(p.confidence, "baixa");
        assert_eq!(p.error.as_deref(), Some("sem conexão"));
        assert!(p.lyrics.is_none());
    }
}

// ---------------------------------------------------------------------------
// F13 — erro de rede num palpite POSTERIOR não descarta o candidato válido
// que um palpite anterior já achou: a proposta sai do candidato (sem error);
// a proposta de erro só vale quando nada aproveitável veio antes da falha.
// ---------------------------------------------------------------------------
#[test]
fn network_error_keeps_candidate_found_by_earlier_guess() {
    let (_dir, conn, _folder_id) =
        setup_with(&[("sem_tags.mp3", "Falamansa - Oh! Chuva.mp3")]);
    let song = song_by_suffix(&conn, "Oh! Chuva.mp3");
    let dur = song.duration_seconds.unwrap() as f64 + 10.0; // dif 10 s ⇒ MÉDIA
    let body = format!(
        r#"[{{"trackName": "Oh! Chuva", "artistName": "Falamansa",
             "duration": {dur}, "plainLyrics": "letra"}}]"#
    );

    // 1ª consulta acha candidato MÉDIA (não para o loop, só ALTA para);
    // 2ª consulta cai com erro de rede.
    let calls = RefCell::new(0usize);
    let props = enrich::enrich_scan(
        &conn,
        "",
        |_: &str| {
            *calls.borrow_mut() += 1;
            if *calls.borrow() == 1 {
                Ok(body.clone())
            } else {
                Err(AppError("sem conexão".into()))
            }
        },
        ZERO,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap().propostas;

    assert!(*calls.borrow() >= 2, "houve palpite depois do candidato válido");
    assert_eq!(props.len(), 1);
    let p = &props[0];
    assert_eq!(p.confidence, "media", "candidato achado antes do erro é mantido");
    assert_eq!(p.proposed_title, "Oh! Chuva");
    assert_eq!(p.proposed_artist.as_deref(), Some("Falamansa"));
    assert_eq!(p.lyrics.as_deref(), Some("letra"));
    assert!(p.error.is_none(), "erro posterior não vira error na proposta");
}

// ---------------------------------------------------------------------------
// F13 (QA A5) — proposta OBSOLETA nunca sobrescreve edição manual. A revisão
// do lote é montada na varredura (minutos) e o usuário pode editar a música à
// mão nesse meio-tempo: o apply confere o eco current_title/current_artist
// contra o banco e, se mudou, NÃO grava (arquivo byte a byte intacto).
// ---------------------------------------------------------------------------

const AVISO_OBSOLETA: &str = "a música mudou depois da varredura — sugestão ignorada";

#[test]
fn apply_writes_when_the_song_is_untouched_since_the_scan() {
    let (_dir, conn, _folder_id) = setup_with(&[("sem_tags.mp3", "Falamansa - Oh! Chuva.mp3")]);
    let song = song_by_suffix(&conn, "Oh! Chuva.mp3");

    let results = enrich::apply(
        &conn,
        &[EnrichApply {
            song_id: song.id,
            title: "Oh! Chuva".into(),
            artist: Some("Falamansa".into()),
            lyrics: Some("chove".into()),
            add_temas: None,
            current_title: song.title.clone(),
            current_artist: song.artist.clone(),
            fonte: None,
            substituir_letra: false,
            marcar_instrumental: false,
        }],
    )
    .unwrap();

    assert!(results[0].error.is_none(), "proposta fresca grava normalmente");
    let updated = results[0].song.as_ref().expect("gravada");
    assert_eq!(updated.title, "Oh! Chuva");
    assert_eq!(updated.artist.as_deref(), Some("Falamansa"));
}

#[test]
fn apply_refuses_stale_proposal_when_title_changed_after_the_scan() {
    let (_dir, conn, _folder_id) = setup_with(&[("sem_tags.mp3", "Falamansa - Oh! Chuva.mp3")]);
    let song = song_by_suffix(&conn, "Oh! Chuva.mp3");
    let titulo_na_varredura = song.title.clone();

    // o usuário corrige a música à mão DEPOIS da varredura
    writer::write_tags(&conn, song.id, "Título Corrigido à Mão", None, None, None, None)
        .unwrap();
    let bytes_antes = fs::read(&song.file_path).unwrap();

    let results = enrich::apply(
        &conn,
        &[EnrichApply {
            song_id: song.id,
            title: "Oh! Chuva".into(),
            artist: Some("Falamansa".into()),
            lyrics: Some("chove".into()),
            add_temas: None,
            current_title: titulo_na_varredura,
            current_artist: song.artist.clone(),
            fonte: None,
            substituir_letra: false,
            marcar_instrumental: false,
        }],
    )
    .unwrap();

    assert_eq!(results.len(), 1);
    assert_eq!(results[0].song_id, song.id);
    assert!(results[0].song.is_none());
    assert_eq!(results[0].error.as_deref(), Some(AVISO_OBSOLETA));

    // a edição manual continua de pé e o arquivo não foi tocado
    assert_eq!(song_by_suffix(&conn, "Oh! Chuva.mp3").title, "Título Corrigido à Mão");
    assert_eq!(
        fs::read(&song.file_path).unwrap(),
        bytes_antes,
        "proposta obsoleta não pode escrever byte algum"
    );
}

#[test]
fn apply_refuses_stale_proposal_when_only_the_artist_changed() {
    let (_dir, conn, _folder_id) = setup_with(&[("com_letra.mp3", "com_letra.mp3")]);
    let song = song_by_suffix(&conn, "com_letra.mp3");
    let artista_na_varredura = song.artist.clone();
    assert!(artista_na_varredura.is_some(), "fixture tem artista");

    // só o artista muda entre a varredura e o apply (título idêntico)
    writer::write_tags(&conn, song.id, &song.title, Some("Outro Artista"), None, None, None)
        .unwrap();
    let bytes_antes = fs::read(&song.file_path).unwrap();

    let results = enrich::apply(
        &conn,
        &[EnrichApply {
            song_id: song.id,
            title: song.title.clone(),
            artist: Some("Artista da Proposta".into()),
            lyrics: None,
            add_temas: None,
            current_title: song.title.clone(),
            current_artist: artista_na_varredura,
            fonte: None,
            substituir_letra: false,
            marcar_instrumental: false,
        }],
    )
    .unwrap();

    assert_eq!(results[0].error.as_deref(), Some(AVISO_OBSOLETA));
    assert!(results[0].song.is_none());
    assert_eq!(
        song_by_suffix(&conn, "com_letra.mp3").artist.as_deref(),
        Some("Outro Artista")
    );
    assert_eq!(fs::read(&song.file_path).unwrap(), bytes_antes);
}

#[test]
fn apply_compares_trimmed_and_treats_missing_artist_as_empty() {
    let (_dir, conn, _folder_id) = setup_with(&[("sem_tags.mp3", "Falamansa - Oh! Chuva.mp3")]);
    let song = song_by_suffix(&conn, "Oh! Chuva.mp3");
    assert_eq!(song.artist, None, "sem_tags não tem artista");

    // espaços nas pontas não são mudança; None e "" são o mesmo artista
    let results = enrich::apply(
        &conn,
        &[EnrichApply {
            song_id: song.id,
            title: "Oh! Chuva".into(),
            artist: Some("Falamansa".into()),
            lyrics: None,
            add_temas: None,
            current_title: format!("  {}  ", song.title),
            current_artist: Some("   ".into()),
            fonte: None,
            substituir_letra: false,
            marcar_instrumental: false,
        }],
    )
    .unwrap();

    assert!(results[0].error.is_none(), "trim/vazio não contam como mudança");
    assert_eq!(results[0].song.as_ref().unwrap().title, "Oh! Chuva");
}

#[test]
fn apply_batch_mixes_stale_and_fresh_without_aborting() {
    let (_dir, conn, folder_id) = setup_with(&[
        ("sem_tags.mp3", "a_sem_tags.mp3"),
        ("sem_tags.mp3", "b_sem_tags.mp3"),
        ("sem_tags.mp3", "c_sem_tags.mp3"),
    ]);
    let a = song_by_suffix(&conn, "a_sem_tags.mp3");
    let b = song_by_suffix(&conn, "b_sem_tags.mp3");
    let c = song_by_suffix(&conn, "c_sem_tags.mp3");

    // a 2ª foi editada à mão depois da varredura
    writer::write_tags(&conn, b.id, "B Editada à Mão", None, None, None, None).unwrap();
    let bytes_b_antes = fs::read(&b.file_path).unwrap();

    let results = enrich::apply(
        &conn,
        &[
            EnrichApply {
                song_id: a.id,
                title: "Título A".into(),
                artist: None,
                lyrics: None,
                add_temas: None,
                current_title: a.title.clone(),
                current_artist: a.artist.clone(),
                fonte: None,
                substituir_letra: false,
                marcar_instrumental: false,
            },
            EnrichApply {
                song_id: b.id,
                title: "Título B".into(),
                artist: None,
                lyrics: None,
                add_temas: None,
                current_title: b.title.clone(), // eco da varredura: obsoleto
                current_artist: b.artist.clone(),
                fonte: None,
                substituir_letra: false,
                marcar_instrumental: false,
            },
            EnrichApply {
                song_id: c.id,
                title: "Título C".into(),
                artist: None,
                lyrics: None,
                add_temas: None,
                current_title: c.title.clone(),
                current_artist: c.artist.clone(),
                fonte: None,
                substituir_letra: false,
                marcar_instrumental: false,
            },
        ],
    )
    .unwrap();

    assert_eq!(results.len(), 3, "um resultado por aplicação, na mesma ordem");
    assert!(results[0].error.is_none(), "1ª fresca: gravada");
    assert_eq!(results[1].error.as_deref(), Some(AVISO_OBSOLETA), "2ª obsoleta");
    assert!(results[1].song.is_none());
    assert!(results[2].error.is_none(), "o lote não aborta na obsoleta");

    assert_eq!(
        fs::read(&b.file_path).unwrap(),
        bytes_b_antes,
        "a música editada à mão fica byte a byte como estava"
    );
    indexer::scan_folder(&conn, folder_id, |_, _| {}).unwrap();
    assert_eq!(song_by_suffix(&conn, "a_sem_tags.mp3").title, "Título A");
    assert_eq!(song_by_suffix(&conn, "b_sem_tags.mp3").title, "B Editada à Mão");
    assert_eq!(song_by_suffix(&conn, "c_sem_tags.mp3").title, "Título C");
}

// ---------------------------------------------------------------------------
// V5/F14 (QA A3) — o repasse de letra do lote NÃO derruba a marca de
// transcrição: aplicar só título/artista/temas (lyrics: None ⇒ apply_one relê
// e regrava a MESMA letra) preserva TXXX:LETRA_ORIGEM.
// ---------------------------------------------------------------------------
#[test]
fn apply_pass_through_keeps_the_transcription_marker() {
    use lofty::config::{ParseOptions, WriteOptions};
    use lofty::file::AudioFile;
    use lofty::id3::v2::Id3v2Tag;
    use lofty::tag::TagExt;

    fn tag_de(path: &str) -> Id3v2Tag {
        lofty::mpeg::MpegFile::read_from(
            &mut fs::File::open(path).unwrap(),
            ParseOptions::new(),
        )
        .unwrap()
        .id3v2()
        .cloned()
        .unwrap_or_default()
    }

    let (_dir, conn, _folder_id) = setup_with(&[("com_letra.mp3", "com_letra.mp3")]);
    let song = song_by_suffix(&conn, "com_letra.mp3");

    // marca de transcrição gravada pelas ferramentas Python
    let mut tag = tag_de(&song.file_path);
    tag.insert_user_text("LETRA_ORIGEM".into(), "transcricao".into());
    tag.save_to_path(&song.file_path, WriteOptions::default()).unwrap();

    let results = enrich::apply(
        &conn,
        &[EnrichApply {
            song_id: song.id,
            title: "Título do Lote".into(),
            artist: Some("Artista do Lote".into()),
            lyrics: None, // repasse: o lote nunca apaga a letra
            add_temas: Some("chuva".into()),
            current_title: song.title.clone(),
            current_artist: song.artist.clone(),
            fonte: None,
            substituir_letra: false,
            marcar_instrumental: false,
        }],
    )
    .unwrap();
    assert!(results[0].error.is_none());

    assert_eq!(
        tag_de(&song.file_path).get_user_text("LETRA_ORIGEM"),
        Some("transcricao"),
        "lote que preserva a letra não pode apagar a marca legítima"
    );
}

// ===========================================================================
// QA MÉDIO-6 — chave recusada é uma notícia, não noventa e cinco.
//
// A chave errada não melhora entre uma música e a seguinte: repetir a
// consulta é gastar meio segundo por arquivo para receber a mesma rejeição e
// escrever a mesma linha de erro. A primeira música reporta; as demais pulam
// a etapa 4 em silêncio: sem nome real, não há o que conferir.
// ===========================================================================


// ===========================================================================
// QA ALTO-2 — quantas músicas a varredura vai olhar é UMA regra, e ela mora
// aqui. O frontend tinha uma cópia em TypeScript que já divergira desta; a
// contagem que a tela promete e o total que a barra de progresso anuncia
// precisam sair da MESMA `candidata`.
//
// V10 — a contagem deixou de ser um número. Com o caminho único, a etapa 2
// roda em TODAS e as etapas de letra só em quem não tem letra: "quantas
// músicas" não diz mais o tamanho do trabalho, e o tempo depende dos dois
// números.
// ===========================================================================
#[test]
fn a_contagem_e_a_mesma_regra_que_a_varredura_usa() {
    let (_dir, conn, _folder_id) = setup_with(&[
        ("sem_tags.mp3", "Pasta/Falamansa - Oh! Chuva.mp3"), // sem tag nenhuma
        ("sem_letra.mp3", "Pasta/sem_letra.mp3"),            // tem nomes, falta letra
        ("com_letra.mp3", "Pasta/com_letra.mp3"),            // completa
        ("sem_tags.mp3", "Outra/x.mp3"),                     // fora do prefixo
    ]);
    let raiz = song_by_suffix(&conn, "Oh! Chuva.mp3").file_path;
    let pasta = raiz.trim_end_matches("/Falamansa - Oh! Chuva.mp3").to_string();

    // o total anunciado pela varredura é a verdade a espelhar
    let eventos = RefCell::new(Vec::new());
    enrich::enrich_scan(
        &conn,
        &pasta,
        |_: &str| Ok("[]".to_string()),
        ZERO,
        |_, total, _, _| eventos.borrow_mut().push(total),
        SEM_CANCELAMENTO,
    )
    .unwrap();
    let total_da_varredura = eventos.borrow()[0];

    let c = enrich::contar(&conn, &pasta, PADRAO).unwrap();
    assert_eq!(c.total, 3, "TODAS as músicas da pasta, inclusive a completa");
    assert_eq!(c.sem_letra, 2, "só estas passam pelas etapas 3 e 4");
    assert_eq!(
        c.total, total_da_varredura,
        "a contagem prometida na tela é a mesma que a barra vai anunciar"
    );
    // prefixo vazio = biblioteca inteira
    assert_eq!(enrich::contar(&conn, "", PADRAO).unwrap().total, 4);
    // pasta que não existe
    let vazia = enrich::contar(&conn, "/lugar/nenhum", PADRAO).unwrap();
    assert_eq!((vazia.total, vazia.sem_letra), (0, 0));
}

/// A contagem não gasta rede e não propõe nada: ela existe para a tela poder
/// dizer o tamanho do trabalho ANTES de a pessoa mandar começar.
#[test]
fn a_contagem_nao_toca_a_rede() {
    let (_dir, conn, _folder_id) = setup_with(&[("sem_tags.mp3", "a - Um.mp3")]);
    assert_eq!(enrich::contar(&conn, "", PADRAO).unwrap().total, 1);
}

/// V10 — o INSTRUMENTAL continua contando no total (as etapas 1 e 2 rodam
/// nele: ele pode e deve ganhar título e artista corretos), e sai da conta das
/// etapas de LETRA — música sem voz não tem letra a buscar, em fonte nenhuma,
/// e cobrá-la para sempre era a pendência eterna que a marca veio resolver.
#[test]
fn o_instrumental_conta_no_total_e_sai_das_etapas_de_letra() {
    let (_dir, conn, _folder_id) = setup_with(&[("sem_letra.mp3", "sem_letra.mp3")]);
    let song = song_by_suffix(&conn, "sem_letra.mp3");
    let antes = enrich::contar(&conn, "", PADRAO).unwrap();
    assert_eq!((antes.total, antes.sem_letra), (1, 1));

    writer::write_tags(
        &conn,
        song.id,
        "Instrumental Sem Letra",
        Some("Banda Fixture"),
        None,
        None,
        Some(true),
    )
    .unwrap();
    let depois = enrich::contar(&conn, "", PADRAO).unwrap();
    assert_eq!((depois.total, depois.sem_letra), (1, 0));
}

/// **A estimativa usa os 2 s por música MEDIDOS em campo** — a antiga dizia
/// 0,3 s, e errar por 7x numa pasta de 150 músicas é a diferença entre "45
/// segundos" e "cinco minutos" (DECISIONS #85).
///
/// A conta mora no Rust por causa da DECISIONS #80: a cópia em TypeScript já
/// divergiu uma vez, e foi o botão do produto que ficou cinza por causa disso.
#[test]
fn a_estimativa_usa_o_custo_medido_de_cada_etapa() {
    assert_eq!(enrich::SEGUNDOS_ETAPA_SOM, 2, "medido em campo, não 0,3 s");
    let (_dir, conn, _f) = setup_with(&[
        ("sem_tags.mp3", "a - Um.mp3"),   // sem letra
        ("com_letra.mp3", "com_letra.mp3"), // com letra
    ]);
    let so_letra = enrich::contar(&conn, "", PADRAO).unwrap();
    assert_eq!((so_letra.total, so_letra.sem_letra), (2, 1));
    assert_eq!(
        so_letra.segundos_estimados,
        enrich::SEGUNDOS_ETAPA_LRCLIB + enrich::SEGUNDOS_ETAPA_LYRICS_OVH,
        "sem acessório e sem chave rodam as etapas 3 e 4 — a 4 não pede chave —, \
         e só na música que não tem letra"
    );

    let tudo = enrich::EtapasLigadas {
        som: true,
        transcricao: false,
    };
    let c = enrich::contar(&conn, "", tudo).unwrap();
    assert_eq!(
        c.segundos_estimados,
        2 * enrich::SEGUNDOS_ETAPA_SOM
            + enrich::SEGUNDOS_ETAPA_LRCLIB
            + enrich::SEGUNDOS_ETAPA_LYRICS_OVH,
        "a etapa do som roda em TODAS; as de letra, só em quem não tem letra"
    );

    // A tela lista o que ESTA máquina faz (DECISIONS #101), e a etapa 5 nunca
    // está aqui: ela é perguntada no fim.
    assert_eq!(
        c.etapas,
        vec![
            enrich::ETAPA_NOME_ARQUIVO,
            enrich::ETAPA_IMPRESSAO_DIGITAL,
            enrich::ETAPA_LRCLIB,
            enrich::ETAPA_LYRICS_OVH,
        ]
    );
    // V10 — a etapa 4 aparece SEMPRE: ela não pede chave nenhuma, então
    // nenhuma etapa do funil depende de credencial do usuário
    assert!(so_letra.etapas.contains(&enrich::ETAPA_LYRICS_OVH.to_string()));
    assert!(!so_letra.etapas.contains(&enrich::ETAPA_IMPRESSAO_DIGITAL.to_string()));
    assert!(!c.etapas.contains(&enrich::ETAPA_TRANSCRICAO.to_string()));
}

// ===========================================================================
// QA CRÍTICO-1 — o lote não pode trocar uma letra que já existe sem que quem
// revisa saiba e concorde.
//
// A repro: "Falamansa - Oh! Chuva.mp3" com TIT2 "AudioTrack 03", sem TPE1, e
// dentro dele uma transcrição corrigida à mão (TXXX:LETRA_ORIGEM =
// "transcricao"). Ela É candidata, e tem de continuar sendo: é assim que uma
// "Faixa 03" ganha o nome certo. Só que o palpite do nome do arquivo casa a
// duração no LRCLIB, sai ALTA, chega PRÉ-MARCADA — e um clique destruía horas
// de correção manual. O `tools/curadoria.py` recusa isso desde a DECISIONS
// #55; o app não tinha equivalente nem sabia mostrar que havia letra ali.
//
// A correção tem duas metades: a proposta CARREGA a informação (`has_lyrics`
// e a procedência do que seria sobrescrito) e a gravação exige consentimento
// EXPLÍCITO (`substituir_letra`).
// ===========================================================================

/// A repro do QA, pronta para uso: devolve a Song e a transcrição que está
/// dentro do arquivo.
fn transcricao_com_nome_de_ripador() -> (tempfile::TempDir, Connection, db::Song, String) {
    use lofty::config::WriteOptions;
    use lofty::tag::TagExt;

    let (dir, conn, _folder_id) = setup_with(&[("com_letra.mp3", "Falamansa - Oh! Chuva.mp3")]);
    let song = song_by_suffix(&conn, "Oh! Chuva.mp3");
    let transcricao = db::get_lyrics(&conn, song.id)
        .unwrap()
        .expect("a fixture tem letra");

    // a marca que as ferramentas Python gravam...
    let mut tag = id3(&song.file_path);
    tag.insert_user_text("LETRA_ORIGEM".into(), "transcricao".into());
    tag.save_to_path(&song.file_path, WriteOptions::default()).unwrap();
    // ...e o TIT2 de ripador, pela porta do editor (que reindexa e preserva a
    // marca, porque a letra é repassada sem mudar)
    writer::write_tags(
        &conn,
        song.id,
        "AudioTrack 03",
        None,
        Some(&transcricao),
        None,
        None,
    )
    .unwrap();

    let song = song_by_suffix(&conn, "Oh! Chuva.mp3");
    assert!(song.has_lyrics, "a repro precisa de letra no arquivo");
    assert_eq!(song.letra_origem.as_deref(), Some("transcricao"));
    (dir, conn, song, transcricao)
}

/// Proposta do LRCLIB (ALTA, com letra) para a repro acima.
///
/// **V10 — a repro passou a entrar pela porta de UMA MÚSICA.** O caminho único
/// fechou a rota do LOTE: a varredura não roda mais as etapas de letra em quem
/// já tem letra, então este arquivo nunca mais recebe do lote uma proposta que
/// substituiria a transcrição corrigida à mão. A porta individual continua
/// rodando o funil inteiro, de propósito (quem clicou quer uma segunda
/// opinião, DECISIONS #81) — e é por isso que a trava do consentimento
/// continua sendo indispensável, e continua testada.
fn proposta_alta_sobre_a_transcricao(
    conn: &Connection,
    song: &db::Song,
    letra_nova: &str,
) -> enrich::EnrichProposal {
    let dur = song.duration_seconds.expect("fixture tem duração") as f64;
    let corpo = format!(
        r#"[{{"trackName": "Oh! Chuva", "artistName": "Falamansa",
             "duration": {dur}, "plainLyrics": {}}}]"#,
        serde_json::to_string(letra_nova).unwrap()
    );
    enrich::enrich_scan_song(
        conn,
        song.id,
        None,
        None,
        move |_url: &str| Ok(corpo.clone()),
        ZERO,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap()
    .expect("a música com nome de ripador continua sendo consultada")
}

#[test]
fn a_proposal_says_the_song_already_has_a_lyric_and_where_it_came_from() {
    let (_dir, conn, song, _transcricao) = transcricao_com_nome_de_ripador();
    let p = proposta_alta_sobre_a_transcricao(&conn, &song, "letra nova do LRCLIB");

    assert_eq!(p.confidence, "alta", "é a proposta pré-marcada da repro");
    assert!(p.lyrics.is_some(), "e ela traz letra: substituiria a atual");
    assert!(p.has_lyrics, "a proposta precisa DIZER que já há letra ali");
    assert_eq!(
        p.letra_origem.as_deref(),
        Some("transcricao"),
        "e de onde veio o que seria sobrescrito"
    );

    // a música sem letra nenhuma não carrega alarme falso
    let (_dir2, conn2, _fid) = setup_with(&[("sem_tags.mp3", "Falamansa - Oh! Chuva.mp3")]);
    let sem = song_by_suffix(&conn2, "Oh! Chuva.mp3");
    let p = proposta_alta_sobre_a_transcricao(&conn2, &sem, "letra nova do LRCLIB");
    assert!(!p.has_lyrics);
    assert_eq!(p.letra_origem, None);
}

#[test]
fn apply_refuses_to_replace_an_existing_lyric_without_consent() {
    let (_dir, conn, song, transcricao) = transcricao_com_nome_de_ripador();
    let p = proposta_alta_sobre_a_transcricao(&conn, &song, "letra nova do LRCLIB");

    let results = enrich::apply(
        &conn,
        &[EnrichApply {
            song_id: p.song_id,
            title: p.proposed_title.clone(),
            artist: p.proposed_artist.clone(),
            lyrics: p.lyrics.clone(),
            add_temas: None,
            current_title: p.current_title.clone(),
            current_artist: p.current_artist.clone(),
            fonte: Some(p.fonte.clone()),
            substituir_letra: false,
            marcar_instrumental: false,
        }],
    )
    .unwrap();

    assert_eq!(
        results[0].error.as_deref(),
        Some(enrich::AVISO_LETRA_EXISTENTE),
        "sem consentimento, a gravação é recusada"
    );
    assert!(results[0].song.is_none());

    // e o arquivo fica INTACTO: nem a letra, nem a marca, nem o título
    assert_eq!(
        db::get_lyrics(&conn, song.id).unwrap().as_deref(),
        Some(transcricao.as_str())
    );
    assert_eq!(
        id3(&song.file_path).get_user_text("LETRA_ORIGEM"),
        Some("transcricao")
    );
    let inalterada = song_by_suffix(&conn, "Oh! Chuva.mp3");
    assert_eq!(inalterada.title, "AudioTrack 03", "recusa não grava nada");
}

#[test]
fn apply_replaces_the_existing_lyric_when_consent_is_explicit() {
    // fonte LRCLIB: letra oficial, e letra oficial não leva marca nenhuma
    let (_dir, conn, song, _transcricao) = transcricao_com_nome_de_ripador();
    let p = proposta_alta_sobre_a_transcricao(&conn, &song, "letra nova do LRCLIB");

    let results = enrich::apply(
        &conn,
        &[EnrichApply {
            song_id: p.song_id,
            title: p.proposed_title.clone(),
            artist: p.proposed_artist.clone(),
            lyrics: p.lyrics.clone(),
            add_temas: None,
            current_title: p.current_title.clone(),
            current_artist: p.current_artist.clone(),
            fonte: Some(p.fonte.clone()),
            substituir_letra: true,
            marcar_instrumental: false,
        }],
    )
    .unwrap();

    assert_eq!(results[0].error, None, "com consentimento, grava");
    assert_eq!(
        db::get_lyrics(&conn, song.id).unwrap().as_deref(),
        Some("letra nova do LRCLIB")
    );
    assert_eq!(
        id3(&song.file_path).get_user_text("LETRA_ORIGEM"),
        None,
        "letra do LRCLIB é oficial: a marca de transcrição cai"
    );

    // ...e a mesma troca vinda da etapa 4 fica marcada como tal
    let (_dir, conn, song, _t) = transcricao_com_nome_de_ripador();
    let results = enrich::apply(
        &conn,
        &[EnrichApply {
            song_id: song.id,
            title: song.title.clone(),
            artist: None,
            lyrics: Some("letra nova da base comunitária".into()),
            add_temas: None,
            current_title: song.title.clone(),
            current_artist: song.artist.clone(),
            fonte: Some(enrich::FONTE_LYRICS_OVH.into()),
            substituir_letra: true,
            marcar_instrumental: false,
        }],
    )
    .unwrap();
    assert_eq!(results[0].error, None);
    assert_eq!(
        id3(&song.file_path).get_user_text("LETRA_ORIGEM"),
        Some("lyrics.ovh")
    );
}

/// Regravar a MESMA letra não é substituição — nada seria perdido, e recusar
/// aqui só produziria um erro incompreensível na revisão de quem aceitou uma
/// proposta que só mudava o título.
#[test]
fn an_identical_lyric_is_not_a_replacement() {
    let (_dir, conn, song, transcricao) = transcricao_com_nome_de_ripador();

    let results = enrich::apply(
        &conn,
        &[EnrichApply {
            song_id: song.id,
            title: "Oh! Chuva".into(),
            artist: Some("Falamansa".into()),
            // a mesma letra, com espaços a mais nas pontas
            lyrics: Some(format!("\n{transcricao}  ")),
            add_temas: None,
            current_title: song.title.clone(),
            current_artist: song.artist.clone(),
            fonte: None,
            substituir_letra: false,
            marcar_instrumental: false,
        }],
    )
    .unwrap();

    assert_eq!(results[0].error, None, "letra igual não é substituição");
    assert_eq!(
        results[0].song.as_ref().unwrap().title,
        "Oh! Chuva",
        "e o título proposto entra normalmente"
    );
    assert_eq!(
        id3(&song.file_path).get_user_text("LETRA_ORIGEM"),
        Some("transcricao"),
        "a letra não mudou, então a marca legítima continua valendo"
    );
}

// ---------------------------------------------------------------------------
// F13 (QA M4) — "Cancelar" cancela DE VERDADE: `enrich_scan` consulta o
// predicado de cancelamento entre músicas e volta cedo com o que já tem, sem
// gastar mais rede nem emitir mais progresso (a varredura zumbi corrompia a
// barra da varredura seguinte).
// ---------------------------------------------------------------------------
#[test]
fn enrich_scan_stops_early_when_cancelled_between_songs() {
    let (_dir, conn, _folder_id) = setup_with(&[
        ("sem_tags.mp3", "a - Um.mp3"),
        ("sem_tags.mp3", "b - Dois.mp3"),
        ("sem_tags.mp3", "c - Tres.mp3"),
        ("sem_tags.mp3", "d - Quatro.mp3"),
    ]);

    let musicas_consultadas: RefCell<Vec<String>> = RefCell::new(Vec::new());
    let eventos: RefCell<Vec<(usize, usize, String, String)>> = RefCell::new(Vec::new());
    let cancelada = std::cell::Cell::new(false);

    let props = enrich::enrich_scan(
        &conn,
        "",
        |url: &str| {
            musicas_consultadas.borrow_mut().push(url.to_string());
            Ok("[]".into())
        },
        ZERO,
        |done, total, atual, etapa| {
            eventos
                .borrow_mut()
                .push((done, total, atual.to_string(), etapa.to_string()));
            if etapa == enrich::ETAPA_CONCLUIDA && done == 1 {
                cancelada.set(true); // usuário clica "Cancelar" após a 1ª
            }
        },
        || cancelada.get(),
    )
    .unwrap().propostas;

    let todos = eventos.borrow();
    let ev = passos(&todos);
    assert_eq!(ev.iter().map(|e| e.0).collect::<Vec<_>>(), vec![0, 1],
        "o progresso para no cancelamento: {ev:?}");
    assert!(todos.iter().all(|e| e.1 == 4), "o total continua sendo o das candidatas");
    assert_eq!(
        todos.last().map(|e| e.3.as_str()),
        Some(enrich::ETAPA_CONCLUIDA),
        "nenhuma etapa nova começa depois do cancelamento: {todos:?}"
    );
    assert!(props.len() <= 1, "volta com o que já tinha: {props:?}");

    // nenhuma consulta de rede depois do cancelamento
    let consultas = musicas_consultadas.borrow();
    assert!(!consultas.is_empty(), "a 1ª música foi consultada");
    let nome_da_primeira = ev[1].2.clone();
    for url in consultas.iter() {
        for outra in ["Dois", "Tres", "Quatro", "Um"] {
            if !nome_da_primeira.contains(outra) {
                assert!(
                    !url.contains(outra),
                    "varredura cancelada não pode consultar {outra}: {url}"
                );
            }
        }
    }
}

#[test]
fn enrich_scan_cancelled_before_starting_does_nothing() {
    let (_dir, conn, _folder_id) = setup_with(&[("sem_tags.mp3", "a - Um.mp3")]);

    let chamadas = RefCell::new(0usize);
    let eventos = RefCell::new(0usize);
    let props = enrich::enrich_scan(
        &conn,
        "",
        |_: &str| {
            *chamadas.borrow_mut() += 1;
            Ok("[]".into())
        },
        ZERO,
        |_, _, _, _| *eventos.borrow_mut() += 1,
        || true,
    )
    .unwrap().propostas;

    assert!(props.is_empty());
    assert_eq!(*chamadas.borrow(), 0, "cancelada antes de começar: zero rede");
    assert_eq!(*eventos.borrow(), 0, "nem o evento inicial de progresso");
}

// ===========================================================================
// V8/F18 fase 1 — o funil dentro do app: etapas, fonte de cada proposta,
// lyrics.ovh como segunda fonte de letra e a varredura de UMA música só.
// ===========================================================================

/// Tag ID3v2 lida do disco — para conferir os frames que o funil grava.
fn id3(path: &str) -> lofty::id3::v2::Id3v2Tag {
    use lofty::config::ParseOptions;
    use lofty::file::AudioFile;
    lofty::mpeg::MpegFile::read_from(&mut fs::File::open(path).unwrap(), ParseOptions::new())
        .expect("arquivo deve continuar parseável")
        .id3v2()
        .cloned()
        .unwrap_or_default()
}

fn json(s: &str) -> String {
    serde_json::to_string(s).unwrap()
}

/// Corpo de resposta do lyrics.ovh.
/// Resposta do lyrics.ovh: só a letra. A fonte não devolve título nem artista
/// — é a fraqueza dela, e está registrada no módulo.
fn corpo_ovh(letra: &str) -> String {
    format!(r#"{{"lyrics":{}}}"#, json(letra))
}

/// Fetcher único que atende as DUAS fontes pela URL e registra tudo que foi
/// pedido — o mesmo desenho do `fetcher_de` da suíte Python.
fn fontes_de_letra<'a>(
    urls: &'a RefCell<Vec<String>>,
    lrclib: String,
    ovh: String,
) -> impl Fn(&str) -> Result<String, AppError> + 'a {
    move |url: &str| {
        urls.borrow_mut().push(url.to_string());
        if url.starts_with(lyrics_ovh::SEARCH_URL) {
            Ok(ovh.clone())
        } else {
            Ok(lrclib.clone())
        }
    }
}

fn urls_de(urls: &RefCell<Vec<String>>, fonte: &str) -> Vec<String> {
    urls.borrow()
        .iter()
        .filter(|u| u.contains(fonte))
        .cloned()
        .collect()
}

/// Uma música com tags REAIS e sem letra: a candidata típica da etapa 3 (o
/// a etapa 4 só é consultada com título E artista para conferir).
const LETRA_OVH: &str = "Primeira linha inventada\nSegunda linha inventada à toa";

// ---------------------------------------------------------------------------
// O funil por custo crescente: a etapa 4 recebe SÓ o que o LRCLIB não
// resolveu, e a proposta diz de onde veio (`fonte`) para quem revisa.
// ---------------------------------------------------------------------------
#[test]
fn a_etapa_4_responde_so_onde_o_lrclib_veio_vazio() {
    let (_dir, conn, _folder_id) = setup_with(&[("sem_letra.mp3", "sem_letra.mp3")]);
    let song = song_by_suffix(&conn, "sem_letra.mp3");

    let urls = RefCell::new(Vec::new());
    let props = enrich::enrich_scan(
        &conn,
        "",
        fontes_de_letra(
            &urls,
            "[]".into(), // o LRCLIB não tem este repertório
            corpo_ovh(LETRA_OVH),
        ),
        ZERO,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap().propostas;

    assert!(!urls_de(&urls, "lrclib").is_empty(), "o LRCLIB vem primeiro");
    assert_eq!(
        urls_de(&urls, "api.lyrics.ovh").len(),
        1,
        "uma consulta ao lyrics.ovh por música, nunca uma por palpite"
    );

    let p = props.iter().find(|p| p.song_id == song.id).expect("proposta");
    assert_eq!(p.fonte, "lyrics.ovh");
    assert_eq!(p.lyrics.as_deref(), Some(LETRA_OVH));
    assert_eq!(
        p.confidence, "media",
        "sem duração para confirmar, esta fonte nunca chega PRÉ-MARCADA na revisão (DECISIONS #49 + #63)"
    );
    assert!(p.error.is_none());
    // a régua estrita garante as MESMAS palavras: a etapa não troca nomes
    assert_eq!(p.proposed_title, song.title);
    assert_eq!(p.proposed_artist, song.artist);
}

#[test]
fn a_etapa_4_nao_e_consultada_quando_o_lrclib_ja_respondeu() {
    let (_dir, conn, _folder_id) = setup_with(&[("sem_letra.mp3", "sem_letra.mp3")]);
    let song = song_by_suffix(&conn, "sem_letra.mp3");
    let dur = song.duration_seconds.expect("fixture tem duração") as f64;
    let lrclib = format!(
        r#"[{{"trackName":"Instrumental Sem Letra","artistName":"Banda Fixture",
             "duration":{dur},"plainLyrics":"letra oficial do lrclib"}}]"#
    );

    let urls = RefCell::new(Vec::new());
    let props = enrich::enrich_scan(
        &conn,
        "",
        fontes_de_letra(&urls, lrclib, corpo_ovh("z")),
        ZERO,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap().propostas;

    assert!(
        urls_de(&urls, "api.lyrics.ovh").is_empty(),
        "cada etapa recebe só o que a anterior não resolveu: {:?}",
        urls.borrow()
    );
    let p = props.iter().find(|p| p.song_id == song.id).expect("proposta");
    assert_eq!(p.fonte, "LRCLIB");
    assert_eq!(p.lyrics.as_deref(), Some("letra oficial do lrclib"));
}

// ---------------------------------------------------------------------------
// Sem chave, a etapa é pulada em SILÊNCIO: nada de rede, nada de erro na
// tela, e todo o resto do funil funciona exatamente como antes. São 40
// pessoas sem suporte possível — quem não cadastrou chave nenhuma não pode
// tropeçar num erro que não sabe resolver.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// "Sem artista para conferir, não se consulta" (DECISIONS #63): a etapa 4
// não tem duração, então a igualdade de palavras dos DOIS lados é a única
// prova — e ela exige um pedido que já signifique alguma coisa. Palpite de
// nome de arquivo não é isso.
// ---------------------------------------------------------------------------
#[test]
fn a_etapa_4_nunca_e_consultada_a_partir_de_palpite_de_nome_de_arquivo() {
    let (_dir, conn, _folder_id) =
        setup_with(&[("sem_tags.mp3", "Falamansa - Oh! Chuva.mp3")]);

    let urls = RefCell::new(Vec::new());
    let props = enrich::enrich_scan(
        &conn,
        "",
        fontes_de_letra(
            &urls,
            "[]".into(),
            corpo_ovh(LETRA_OVH),
        ),
        ZERO,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap().propostas;

    assert!(
        urls_de(&urls, "api.lyrics.ovh").is_empty(),
        "arquivo sem tag real não vai ao lyrics.ovh: {:?}",
        urls.borrow()
    );
    // continua saindo a proposta de etapa 1, com a fonte declarada
    let p = props.first().expect("proposta de nome de arquivo");
    assert_eq!(p.fonte, "nome do arquivo");
    assert_eq!(p.confidence, "baixa");
    assert!(p.lyrics.is_none());
}

// ---------------------------------------------------------------------------
// Cada proposta declara a etapa que a produziu — a UI mostra isso, e o apply
// depende disso para gravar a procedência certa da letra.
// ---------------------------------------------------------------------------
#[test]
fn every_proposal_declares_the_stage_that_produced_it() {
    let (_dir, conn, _folder_id) = setup_with(&[
        ("sem_letra.mp3", "sem_letra.mp3"),              // vira lyrics.ovh
        ("sem_tags.mp3", "Falamansa - Oh! Chuva.mp3"),   // vira lrclib
        ("sem_tags.mp3", "Sumida.mp3"),                  // vira erro
    ]);
    let chuva = song_by_suffix(&conn, "Oh! Chuva.mp3");
    fs::remove_file(&song_by_suffix(&conn, "Sumida.mp3").file_path).unwrap();
    let dur = chuva.duration_seconds.expect("fixture tem duração") as f64;

    let urls = RefCell::new(Vec::new());
    let props = enrich::enrich_scan(
        &conn,
        "",
        |url: &str| {
            urls.borrow_mut().push(url.to_string());
            if url.starts_with(lyrics_ovh::SEARCH_URL) {
                Ok(corpo_ovh(LETRA_OVH))
            } else if url.contains("Chuva") {
                Ok(format!(
                    r#"[{{"trackName":"Oh! Chuva","artistName":"Falamansa",
                         "duration":{dur},"plainLyrics":"Chove lá fora"}}]"#
                ))
            } else {
                Ok("[]".into())
            }
        },
        ZERO,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap().propostas;

    let fonte_de = |sufixo: &str| {
        props
            .iter()
            .find(|p| p.file_path.ends_with(sufixo))
            .unwrap_or_else(|| panic!("proposta para {sufixo}"))
            .fonte
            .clone()
    };
    assert_eq!(fonte_de("sem_letra.mp3"), "lyrics.ovh");
    assert_eq!(fonte_de("Oh! Chuva.mp3"), "LRCLIB");
    assert_eq!(fonte_de("Sumida.mp3"), "erro");

    // vocabulário fechado: a UI só precisa saber traduzir estes quatro
    for p in &props {
        assert!(
            ["nome do arquivo", "LRCLIB", "lyrics.ovh", "erro"].contains(&p.fonte.as_str()),
            "fonte fora do vocabulário: {:?}",
            p.fonte
        );
    }
}

// ---------------------------------------------------------------------------
// PRD V8: "status sempre visível — a etapa atual do funil e o arquivo do
// momento". A varredura anuncia cada etapa em que entra, com o mesmo `done`
// (o texto muda, a barra não anda).
// ---------------------------------------------------------------------------
#[test]
fn the_scan_announces_every_funnel_stage_it_enters() {
    let (_dir, conn, _folder_id) = setup_with(&[("sem_letra.mp3", "sem_letra.mp3")]);

    let eventos: RefCell<Vec<(usize, usize, String, String)>> = RefCell::new(Vec::new());
    let urls = RefCell::new(Vec::new());
    enrich::enrich_scan(
        &conn,
        "",
        fontes_de_letra(
            &urls,
            "[]".into(),
            corpo_ovh(LETRA_OVH),
        ),
        ZERO,
        |done, total, atual, etapa| {
            eventos
                .borrow_mut()
                .push((done, total, atual.to_string(), etapa.to_string()))
        },
        SEM_CANCELAMENTO,
    )
    .unwrap().propostas;

    let ev = eventos.borrow();
    let etapas: Vec<&str> = ev.iter().map(|e| e.3.as_str()).collect();
    assert_eq!(
        etapas,
        vec![
            enrich::ETAPA_PREPARANDO,
            enrich::ETAPA_NOME_ARQUIVO,
            enrich::ETAPA_LRCLIB,
            enrich::ETAPA_LYRICS_OVH,
            enrich::ETAPA_CONCLUIDA,
        ],
        "o funil se anuncia na ordem de custo crescente: {ev:?}"
    );
    // só a etapa "concluída" faz a barra andar
    assert!(
        ev.iter()
            .all(|e| e.0 == usize::from(e.3 == enrich::ETAPA_CONCLUIDA) && e.1 == 1),
        "só a conclusão incrementa `done`: {ev:?}"
    );
    // o arquivo do momento acompanha a etapa (o inicial não tem arquivo)
    assert_eq!(ev[0].2, "");
    assert!(
        ev[1..].iter().all(|e| e.2 == "sem_letra.mp3"),
        "toda etapa diz em que arquivo está: {ev:?}"
    );
}

// ---------------------------------------------------------------------------
// Cortesia de rede para as DUAS fontes: uma pausa antes de cada consulta,
// menos a primeira. Sem isso, uma varredura de 95 arquivos vira uma rajada
// contra servidor alheio.
// ---------------------------------------------------------------------------
#[test]
fn the_courtesy_pause_applies_to_both_sources() {
    let (_dir, conn, _folder_id) = setup_with(&[("sem_letra.mp3", "sem_letra.mp3")]);

    let pausa = Duration::from_millis(60);
    let urls = RefCell::new(Vec::new());
    let inicio = std::time::Instant::now();
    enrich::enrich_scan(
        &conn,
        "",
        fontes_de_letra(
            &urls,
            "[]".into(),
            corpo_ovh(LETRA_OVH),
        ),
        pausa,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap().propostas;
    let gasto = inicio.elapsed();

    let consultas = urls.borrow().len();
    assert!(consultas >= 3, "2 palpites no LRCLIB + 1 lyrics.ovh: {consultas}");
    assert!(
        gasto >= pausa * (consultas as u32 - 1),
        "uma pausa por consulta, menos a primeira: {consultas} consultas em {gasto:?}"
    );
}

// ---------------------------------------------------------------------------
// Cancelar cancela a REDE, não só a fila: a bandeira é lida antes de cada
// consulta, inclusive antes da do lyrics.ovh.
// ---------------------------------------------------------------------------
#[test]
fn cancelling_stops_before_the_lyrics_ovh_query() {
    let (_dir, conn, _folder_id) = setup_with(&[("sem_letra.mp3", "sem_letra.mp3")]);

    let urls = RefCell::new(Vec::new());
    let cancelada = std::cell::Cell::new(false);
    let props = enrich::enrich_scan(
        &conn,
        "",
        |url: &str| {
            urls.borrow_mut().push(url.to_string());
            cancelada.set(true); // usuário cancela durante a 1ª consulta
            Ok("[]".to_string())
        },
        ZERO,
        SEM_PROGRESSO,
        || cancelada.get(),
    )
    .unwrap().propostas;

    assert_eq!(urls.borrow().len(), 1, "para na consulta seguinte");
    assert!(urls_de(&urls, "api.lyrics.ovh").is_empty(), "o lyrics.ovh nem começa");
    assert!(props.is_empty(), "volta com o que já tinha (nada)");
}

// ---------------------------------------------------------------------------
// Erro de rede na etapa 3 é erro POR MÚSICA, como o da etapa 2: a linha vira
// informação e o lote segue.
// ---------------------------------------------------------------------------
#[test]
fn a_lyrics_ovh_network_error_never_aborts_the_batch() {
    let (_dir, conn, _folder_id) = setup_with(&[
        ("sem_letra.mp3", "sem_letra.mp3"),
        ("sem_tags.mp3", "Falamansa - Oh! Chuva.mp3"),
    ]);

    let props = enrich::enrich_scan(
        &conn,
        "",
        |url: &str| {
            if url.starts_with(lyrics_ovh::SEARCH_URL) {
                Err(AppError("sem conexão".into()))
            } else {
                Ok("[]".to_string())
            }
        },
        ZERO,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap().propostas;

    let com_erro = props
        .iter()
        .find(|p| p.file_path.ends_with("sem_letra.mp3"))
        .expect("a música que falhou aparece na revisão");
    assert_eq!(com_erro.fonte, "erro");
    assert_eq!(com_erro.error.as_deref(), Some("sem conexão"));
    assert!(com_erro.lyrics.is_none(), "erro nunca traz letra");
    // a vizinha continua sendo processada
    assert!(props.iter().any(|p| p.file_path.ends_with("Oh! Chuva.mp3")));
}

// ---------------------------------------------------------------------------
// V10 — NENHUMA etapa do funil pede credencial do usuário (o Vagalume saiu,
// DECISIONS #110). O que sobra é a chave do AcoustID, que é NOSSA e vem
// compilada — e ela também não pode vazar para a proposta, para o erro nem
// para o banco.
// ---------------------------------------------------------------------------

/// QA MÉDIO-6 — os caminhos de erro de rede não vazam chave nenhuma, e a
/// mensagem chega crua à linha daquela música.
#[test]
fn none_of_the_new_network_messages_leak_the_key() {
    for mensagem in [
        lyrics_ovh::ERRO_FORA_DO_AR,
        "o site de letras pediu para esperar um pouco",
        "o site de letras está fora do ar agora",
        "o site de letras respondeu com erro",
        "sem conexão",
    ] {
        let (_dir, conn, _folder_id) = setup_with(&[("sem_letra.mp3", "sem_letra.mp3")]);
        let props = enrich::enrich_scan(
            &conn,
            "",
            |url: &str| {
                if url.starts_with(lyrics_ovh::SEARCH_URL) {
                    Err(AppError(mensagem.to_string()))
                } else {
                    Ok("[]".to_string())
                }
            },
            ZERO,
            SEM_PROGRESSO,
            SEM_CANCELAMENTO,
        )
        .unwrap().propostas;

        assert_eq!(props[0].error.as_deref(), Some(mensagem));
        assert!(
            !serde_json::to_string(&props).unwrap().contains("chave"),
            "a chave vazou pela mensagem {mensagem:?}"
        );
    }
}

// ---------------------------------------------------------------------------
// V8/F18 item 4 — procedência: letra da etapa 4 entra marcada
// (TXXX:LETRA_ORIGEM = "lyrics.ovh"), e a
// marca sobrevive ao round-trip pelo indexer.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ...e letra do LRCLIB NUNCA carrega o marcador de transcrição. Nem quando o
// arquivo já vinha marcado: a marca descreve a letra ATUAL (DECISIONS #54), e
// a nova letra é oficial.
// ---------------------------------------------------------------------------
#[test]
fn an_lrclib_lyric_never_carries_the_transcription_mark() {
    use lofty::config::WriteOptions;
    use lofty::tag::TagExt;

    let (_dir, conn, folder_id) = setup_with(&[("com_letra.mp3", "com_letra.mp3")]);
    let song = song_by_suffix(&conn, "com_letra.mp3");

    for (n, fonte) in [Some("LRCLIB".to_string()), None].into_iter().enumerate() {
        // o arquivo vinha de uma transcrição do tools/curadoria.py
        let mut tag = id3(&song.file_path);
        tag.insert_user_text("LETRA_ORIGEM".into(), "transcricao".into());
        tag.save_to_path(&song.file_path, WriteOptions::default())
            .unwrap();
        indexer::scan_folder(&conn, folder_id, |_, _| {}).unwrap();
        let atual = song_by_suffix(&conn, "com_letra.mp3");

        let results = enrich::apply(
            &conn,
            &[EnrichApply {
                song_id: atual.id,
                title: atual.title.clone(),
                artist: atual.artist.clone(),
                lyrics: Some(format!("letra oficial recém-achada {n}")),
                add_temas: None,
                current_title: atual.title.clone(),
                current_artist: atual.artist.clone(),
                fonte: fonte.clone(),
                // a troca da letra é o assunto deste teste: consentida
                substituir_letra: true,
                marcar_instrumental: false,
            }],
        )
        .unwrap();
        assert!(results[0].error.is_none(), "{:?}", results[0].error);
        assert_eq!(
            id3(&song.file_path).get_user_text("LETRA_ORIGEM"),
            None,
            "letra oficial (fonte {fonte:?}) não pode se declarar transcrição"
        );
    }
}

// ---------------------------------------------------------------------------
// A procedência descreve a letra ATUAL: aceitar só título/artista de uma
// proposta da etapa 4 (sem levar a letra) NÃO pode marcar o arquivo.
// ---------------------------------------------------------------------------
#[test]
fn declarar_a_fonte_sem_letra_nova_nao_marca_nada() {
    let (_dir, conn, _folder_id) = setup_with(&[("com_letra.mp3", "com_letra.mp3")]);
    let song = song_by_suffix(&conn, "com_letra.mp3");

    let results = enrich::apply(
        &conn,
        &[EnrichApply {
            song_id: song.id,
            title: "Outro Título".into(),
            artist: song.artist.clone(),
            lyrics: None, // repasse da letra que já estava lá
            add_temas: None,
            current_title: song.title.clone(),
            current_artist: song.artist.clone(),
            fonte: Some("lyrics.ovh".into()),
            substituir_letra: false,
            marcar_instrumental: false,
        }],
    )
    .unwrap();
    assert!(results[0].error.is_none());
    assert_eq!(
        id3(&song.file_path).get_user_text("LETRA_ORIGEM"),
        None,
        "sem letra nova não há procedência a declarar"
    );
}

// ---------------------------------------------------------------------------
// Proposta obsoleta continua sendo recusada — inclusive a da etapa 4, que é
// a que traz letra oficial e teria o efeito mais destrutivo (QA A5).
// ---------------------------------------------------------------------------
#[test]
fn uma_proposta_obsoleta_da_etapa_4_e_recusada() {
    let (_dir, conn, _folder_id) = setup_with(&[("sem_letra.mp3", "sem_letra.mp3")]);
    let song = song_by_suffix(&conn, "sem_letra.mp3");

    let results = enrich::apply(
        &conn,
        &[EnrichApply {
            song_id: song.id,
            title: song.title.clone(),
            artist: song.artist.clone(),
            lyrics: Some(LETRA_OVH.into()),
            add_temas: None,
            current_title: "o que a varredura viu, e já não é".into(),
            current_artist: song.artist.clone(),
            fonte: Some("lyrics.ovh".into()),
            substituir_letra: false,
            marcar_instrumental: false,
        }],
    )
    .unwrap();

    assert_eq!(
        results[0].error.as_deref(),
        Some(enrich::AVISO_PROPOSTA_OBSOLETA)
    );
    assert!(!song_by_suffix(&conn, "sem_letra.mp3").has_lyrics, "nada gravado");
    assert_eq!(id3(&song.file_path).get_user_text("LETRA_ORIGEM"), None);
}

// ---------------------------------------------------------------------------
// V8/F17+F18 — o instrumental sai das etapas de LETRA (LRCLIB e lyrics.ovh),
// mas continua elegível a título e artista: "instrumental sem letra ainda
// pode (e deve) ter título e artista corretos" (PRD V8).
// ---------------------------------------------------------------------------
#[test]
fn an_instrumental_skips_the_lyric_stages_but_still_gets_title_and_artist() {
    let (_dir, conn, _folder_id) =
        setup_with(&[("sem_tags.mp3", "Falamansa - Doce Prelúdio.mp3")]);
    let song = song_by_suffix(&conn, "Doce Prelúdio.mp3");
    // marcada à mão no editor: tem título, não tem artista, não tem letra
    writer::write_tags(&conn, song.id, "Doce Prelúdio", None, None, None, Some(true)).unwrap();

    let urls = RefCell::new(Vec::new());
    let etapas = RefCell::new(Vec::new());
    let props = enrich::enrich_scan(
        &conn,
        "",
        fontes_de_letra(
            &urls,
            // stub que casaria PERFEITAMENTE, se fosse consultado
            format!(
                r#"[{{"trackName":"Doce Prelúdio","artistName":"Falamansa",
                     "duration":{},"plainLyrics":"letra da versão cantada"}}]"#,
                song.duration_seconds.unwrap_or(0)
            ),
            corpo_ovh(LETRA_OVH),
        ),
        ZERO,
        |_, _, _, etapa| etapas.borrow_mut().push(etapa.to_string()),
        SEM_CANCELAMENTO,
    )
    .unwrap().propostas;

    assert!(urls.borrow().is_empty(), "nenhuma etapa de letra: {:?}", urls.borrow());
    assert_eq!(
        *etapas.borrow(),
        vec![
            enrich::ETAPA_PREPARANDO,
            enrich::ETAPA_NOME_ARQUIVO,
            enrich::ETAPA_CONCLUIDA
        ],
        "o funil para na etapa 1"
    );

    let p = props
        .iter()
        .find(|p| p.song_id == song.id)
        .expect("o instrumental continua elegível a título e artista");
    assert_eq!(p.fonte, "nome do arquivo");
    assert_eq!(p.proposed_title, "Doce Prelúdio");
    assert_eq!(
        p.proposed_artist.as_deref(),
        Some("Falamansa"),
        "o artista sai do nome do arquivo"
    );
    assert!(p.lyrics.is_none(), "instrumental nunca recebe letra do funil");
}

/// ...e o instrumental que já tem título E artista continua ENTRANDO na
/// varredura (V10 — as etapas 1 e 2 rodam em todas), mas não gasta uma
/// consulta sequer nas etapas de LETRA: a economia prometida pela F17 mudou de
/// lugar, não sumiu. E como nada muda nele, a proposta cai por no-op.
#[test]
fn o_instrumental_com_os_dois_nomes_entra_mas_nao_gasta_rede() {
    let (_dir, conn, _folder_id) = setup_with(&[("sem_letra.mp3", "sem_letra.mp3")]);
    let song = song_by_suffix(&conn, "sem_letra.mp3");
    writer::write_tags(
        &conn,
        song.id,
        "Instrumental Sem Letra",
        Some("Banda Fixture"),
        None,
        None,
        Some(true),
    )
    .unwrap();

    let eventos = RefCell::new(Vec::new());
    let urls = RefCell::new(Vec::new());
    let props = enrich::enrich_scan(
        &conn,
        "",
        fontes_de_letra(
            &urls,
            "[]".into(),
            corpo_ovh(LETRA_OVH),
        ),
        ZERO,
        |done, total, _, _| eventos.borrow_mut().push((done, total)),
        SEM_CANCELAMENTO,
    )
    .unwrap().propostas;

    assert!(props.is_empty(), "nada muda nele: a proposta cai por no-op");
    assert!(urls.borrow().is_empty(), "e não gastou rede nenhuma");
    assert_eq!(
        eventos.borrow().first().copied(),
        Some((0, 1)),
        "entra na contagem: a etapa do som lê o áudio dele"
    );
}

// ---------------------------------------------------------------------------
// V8/F18 — o MESMO funil numa música só ("no editar de cada música, a versão
// individual: rodar o funil só naquele arquivo, para o caso pontual").
// ---------------------------------------------------------------------------
#[test]
fn scan_song_runs_the_same_funnel_on_a_single_file() {
    let (_dir, conn, _folder_id) = setup_with(&[
        ("sem_letra.mp3", "sem_letra.mp3"),
        ("sem_tags.mp3", "Falamansa - Oh! Chuva.mp3"), // a vizinha, intocada
    ]);
    let song = song_by_suffix(&conn, "sem_letra.mp3");

    let urls = RefCell::new(Vec::new());
    let eventos: RefCell<Vec<(usize, usize, String, String)>> = RefCell::new(Vec::new());
    let p = enrich::enrich_scan_song(
        &conn,
        song.id,
        None,
        None,
        fontes_de_letra(
            &urls,
            "[]".into(),
            corpo_ovh(LETRA_OVH),
        ),
        ZERO,
        |done, total, atual, etapa| {
            eventos
                .borrow_mut()
                .push((done, total, atual.to_string(), etapa.to_string()))
        },
        SEM_CANCELAMENTO,
    )
    .unwrap()
    .expect("uma proposta para esta música");

    assert_eq!(p.song_id, song.id);
    assert_eq!(p.fonte, "lyrics.ovh");
    assert_eq!(p.lyrics.as_deref(), Some(LETRA_OVH));

    // uma música só: a vizinha nem é olhada
    assert!(
        urls.borrow().iter().all(|u| !u.contains("Chuva")),
        "a versão individual não varre a pasta: {:?}",
        urls.borrow()
    );
    let etapas: Vec<String> = eventos.borrow().iter().map(|e| e.3.clone()).collect();
    assert_eq!(
        etapas,
        vec![
            enrich::ETAPA_PREPARANDO,
            enrich::ETAPA_NOME_ARQUIVO,
            enrich::ETAPA_LRCLIB,
            enrich::ETAPA_LYRICS_OVH,
            enrich::ETAPA_CONCLUIDA
        ]
    );
    assert_eq!(eventos.borrow().last().unwrap().0, 1);
    assert!(eventos.borrow().iter().all(|e| e.1 == 1), "total = 1");

    // a proposta entra no MESMO apply do lote
    let results = enrich::apply(
        &conn,
        &[EnrichApply {
            song_id: p.song_id,
            title: p.proposed_title.clone(),
            artist: p.proposed_artist.clone(),
            lyrics: p.lyrics.clone(),
            add_temas: None,
            current_title: p.current_title.clone(),
            current_artist: p.current_artist.clone(),
            fonte: Some(p.fonte.clone()),
            substituir_letra: false,
            marcar_instrumental: false,
        }],
    )
    .unwrap();
    assert!(results[0].error.is_none());
    assert!(results[0].song.as_ref().unwrap().has_lyrics);
}

// ---------------------------------------------------------------------------
// QA ALTO-3b — quem clicou sabe o que quer. A varredura de UMA música não
// usa mais o filtro de completude do LOTE como portão: a música completa é
// consultada mesmo assim.
//
// Antes ela devolvia `Ok(None)` sem tocar a rede, e a tela imprimia "não
// achamos esta música nos sites de letra" — uma afirmação sobre uma busca que
// nunca aconteceu. A pessoa clicava de novo, e de novo, e recebia a mesma
// mentira. O botão só existe porque alguém está olhando aquele arquivo e quer
// uma segunda opinião; negá-la em silêncio é pior do que gastar meio segundo.
// ---------------------------------------------------------------------------
#[test]
fn scan_song_consults_the_sources_even_for_a_complete_song() {
    let (_dir, conn, _folder_id) = setup_with(&[("com_letra.mp3", "com_letra.mp3")]);
    let song = song_by_suffix(&conn, "com_letra.mp3");
    assert!(song.has_lyrics, "a fixture é a música COMPLETA");

    let urls = RefCell::new(Vec::new());
    let eventos = RefCell::new(Vec::new());
    let r = enrich::enrich_scan_song(
        &conn,
        song.id,
        None,
        None,
        // as duas fontes vêm vazias: é isso que o teste quer exercitar
        fontes_de_letra(&urls, "[]".into(), "{}".into()),
        ZERO,
        |done, total, _, _| eventos.borrow_mut().push((done, total)),
        SEM_CANCELAMENTO,
    )
    .unwrap();

    assert!(
        !urls.borrow().is_empty(),
        "a busca precisa ACONTECER antes de a tela dizer que nada foi achado"
    );
    assert_eq!(
        *eventos.borrow().first().unwrap(),
        (0, 1),
        "e ela conta como uma música a processar, não como zero"
    );
    // as duas fontes vieram vazias: `None` aqui significa "procuramos e não
    // veio nada novo", que é a única coisa que ele passa a significar
    assert!(r.is_none());
}

/// QA ALTO-3a — o título e o artista que a pessoa ACABOU de digitar no editor
/// são os que vão para a consulta. Enquanto o backend procurava por "Faixa
/// 03" (a etiqueta velha do banco), quem digitou "Asa Branca" via a busca
/// falhar sem entender por quê.
#[test]
fn scan_song_searches_for_what_the_person_typed() {
    let (_dir, conn, _folder_id) = setup_with(&[("sem_tags.mp3", "Faixa 03.mp3")]);
    let song = song_by_suffix(&conn, "Faixa 03.mp3");
    writer::write_tags(&conn, song.id, "Faixa 03", None, None, None, None).unwrap();
    let song = song_by_suffix(&conn, "Faixa 03.mp3");

    let urls = RefCell::new(Vec::new());
    enrich::enrich_scan_song(
        &conn,
        song.id,
        Some("Asa Branca"),
        Some("Luiz Gonzaga"),
        // as duas fontes vêm vazias: é isso que o teste quer exercitar
        fontes_de_letra(&urls, "[]".into(), "{}".into()),
        ZERO,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap();

    let consultas = urls.borrow().join(" ");
    assert!(
        consultas.contains("Asa%20Branca") && consultas.contains("Luiz%20Gonzaga"),
        "o texto digitado tem de chegar às fontes: {consultas}"
    );
    // e a etapa 4, que exige título E artista reais, passa a ser consultada
    assert!(
        !urls_de(&urls, "api.lyrics.ovh").is_empty(),
        "com nomes digitados há o que conferir na base comunitária"
    );
}

/// ...mas o texto digitado é PALPITE, não estado. `current_title` e
/// `current_artist` continuam saindo do BANCO: eles são o eco que o `apply`
/// confere contra o disco antes de gravar (QA A5). Se o digitado virasse eco,
/// a conferência aprovaria a si mesma e a proteção contra proposta obsoleta
/// deixaria de existir.
#[test]
fn scan_song_echoes_the_database_values_never_the_typed_ones() {
    let (_dir, conn, _folder_id) = setup_with(&[("sem_tags.mp3", "Faixa 03.mp3")]);
    let song = song_by_suffix(&conn, "Faixa 03.mp3");
    writer::write_tags(&conn, song.id, "Faixa 03", Some("Ripador"), None, None, None).unwrap();
    let song = song_by_suffix(&conn, "Faixa 03.mp3");
    let dur = song.duration_seconds.unwrap() as f64;

    let corpo = format!(
        r#"[{{"trackName": "Asa Branca", "artistName": "Luiz Gonzaga",
             "duration": {dur}, "plainLyrics": "Quando olhei a terra ardendo"}}]"#
    );
    let p = enrich::enrich_scan_song(
        &conn,
        song.id,
        Some("Asa Branca"),
        Some("Luiz Gonzaga"),
        move |_: &str| Ok(corpo.clone()),
        ZERO,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap()
    .expect("o palpite digitado acha a música");

    assert_eq!(p.current_title, "Faixa 03", "o eco é o que está no banco");
    assert_eq!(p.current_artist.as_deref(), Some("Ripador"));
    assert_eq!(p.proposed_title, "Asa Branca");
}

/// O curto-circuito de instrumental NÃO é filtro de completude, e por isso
/// sobrevive à remoção do portão: um instrumental com título e artista casa
/// com a versão CANTADA da mesma peça no LRCLIB, e gravar aquela letra dentro
/// deste arquivo é o defeito que a marca veio impedir.
#[test]
fn scan_song_still_skips_the_lyric_stages_of_an_instrumental() {
    let (_dir, conn, _folder_id) = setup_with(&[("sem_letra.mp3", "sem_letra.mp3")]);
    let song = song_by_suffix(&conn, "sem_letra.mp3");
    writer::write_tags(
        &conn,
        song.id,
        "Instrumental Sem Letra",
        Some("Banda Fixture"),
        None,
        None,
        Some(true),
    )
    .unwrap();

    let urls = RefCell::new(Vec::new());
    let r = enrich::enrich_scan_song(
        &conn,
        song.id,
        None,
        None,
        fontes_de_letra(
            &urls,
            "[]".into(),
            corpo_ovh(LETRA_OVH),
        ),
        ZERO,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap();

    assert!(urls.borrow().is_empty(), "nenhuma etapa de LETRA acontece");
    assert!(r.is_none(), "e não sobra proposta: os nomes já estão certos");
}

#[test]
fn scan_song_returns_none_when_the_funnel_finds_nothing_new() {
    let (_dir, conn, _folder_id) = setup_with(&[("sem_letra.mp3", "sem_letra.mp3")]);
    let song = song_by_suffix(&conn, "sem_letra.mp3");

    // nenhuma das duas fontes tem a música: o palpite repetiria as tags
    let r = enrich::enrich_scan_song(
        &conn,
        song.id,
        None,
        None,
        |_: &str| Ok("[]".to_string()),
        ZERO,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap();
    assert!(r.is_none(), "proposta que não muda nada não vira sugestão");
}

#[test]
fn scan_song_errors_for_an_unknown_song() {
    let (_dir, conn, _folder_id) = setup_with(&[("sem_letra.mp3", "sem_letra.mp3")]);
    let err = enrich::enrich_scan_song(
        &conn,
        999_999,
        None,
        None,
        |_: &str| Ok("[]".to_string()),
        ZERO,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .expect_err("id inexistente é defeito, não resultado");
    assert!(err.to_string().contains("música não encontrada"));
}

#[test]
fn scan_song_is_cancellable_like_the_batch() {
    let (_dir, conn, _folder_id) = setup_with(&[("sem_letra.mp3", "sem_letra.mp3")]);
    let song = song_by_suffix(&conn, "sem_letra.mp3");

    let chamadas = RefCell::new(0usize);
    let r = enrich::enrich_scan_song(
        &conn,
        song.id,
        None,
        None,
        |_: &str| {
            *chamadas.borrow_mut() += 1;
            Ok("[]".to_string())
        },
        ZERO,
        SEM_PROGRESSO,
        || true,
    )
    .unwrap();
    assert!(r.is_none());
    assert_eq!(*chamadas.borrow(), 0, "cancelada antes de começar: zero rede");
}

// ---------------------------------------------------------------------------
// A etapa 1 e o título que o INDEXADOR inventou (QA da F18 fase 1)
// ---------------------------------------------------------------------------

/// Arquivo sem tag nenhuma e sem " - " no nome: a limpeza do nome (underscore,
/// prefixo de faixa) é a única coisa que a etapa 1 tem a oferecer, e era
/// exatamente ela que se perdia.
///
/// `indexer.rs` copia o nome do arquivo para o `title` quando o MP3 não tem
/// TIT2. O funil lia esse título como ETIQUETA REAL e o preferia ao palpite
/// limpo, então a proposta saía igual ao que já estava lá e o `e_no_op` a
/// derrubava: a etapa que se chama "nome do arquivo" não entregava nada
/// justamente para quem não tem tag nenhuma — a metade pior etiquetada de um
/// acervo de verdade.
#[test]
fn a_title_invented_by_the_indexer_is_cleaned_instead_of_repeated() {
    let (_dir, conn, _folder_id) = setup_with(&[("sem_tags.mp3", "01_Asa_Branca.mp3")]);

    let props = scan_props(&conn, "", |_: &str| Ok("[]".into()));

    let p = props
        .iter()
        .find(|p| p.file_path.ends_with("01_Asa_Branca.mp3"))
        .expect("a limpeza do nome do arquivo É a proposta");
    assert_eq!(p.fonte, "nome do arquivo");
    assert_eq!(p.confidence, "baixa");
    assert_eq!(p.proposed_title, "Asa Branca");
    assert_eq!(
        p.current_title, "01_Asa_Branca",
        "o 'atual' continua sendo o que o banco tem — é o eco que o apply confere"
    );
}

/// O contrapeso: título que é igual ao nome do arquivo porque o arquivo está
/// BEM nomeado não vira proposta nenhuma. Sem esta metade, todo acervo bem
/// etiquetado ganharia uma linha de revisão propondo o que já está lá.
#[test]
fn a_well_named_file_whose_title_matches_it_proposes_nothing() {
    let (_dir, conn, _folder_id) = setup_with(&[("sem_letra.mp3", "Asa Branca.mp3")]);
    let song = song_by_suffix(&conn, "Asa Branca.mp3");
    writer::write_tags(
        &conn,
        song.id,
        "Asa Branca",
        Some("Luiz Gonzaga"),
        None,
        None,
        None,
    )
    .unwrap();

    let props = scan_props(&conn, "", |_: &str| Ok("[]".into()));

    assert!(
        props.iter().all(|p| !p.file_path.ends_with("Asa Branca.mp3")),
        "nada a propor: o título já é o nome certo"
    );
}

// ===========================================================================
// V9/F18 fase 2 — a etapa 2 (impressão digital) e o modo de CONFERÊNCIA
// ===========================================================================
//
// O funil foi reordenado: a impressão digital não é fonte de LETRA, é fonte
// de IDENTIDADE, e identidade é ENTRADA das etapas de letra. Ela passou a
// vir logo depois das etiquetas:
//
//   1 etiquetas/nome → 2 impressão digital → 3 LRCLIB → 4 lyrics.ovh
//
// Duas consequências que estes testes fixam:
//
// - com nome verdadeiro em mãos, as etapas de letra recebem UM palpite, e
//   não a cascata de até sete do `gerar_palpites` (até seis idas à rede a
//   menos por música);
// - um nome que o AcoustID devolveu mas a régua RECUSOU não pode vazar para
//   as etapas seguintes: elas voltam aos palpites locais. Nome errado
//   propagado viraria letra errada com cara de certa, porque LRCLIB e
//   AcoustID conferem pela MESMA duração e erram juntos.

use cancioneiro_lib::fingerprint::Impressao;

/// Impressão digital de mentira — os testes nunca executam o `fpcalc`.
fn impressao(duracao: f64) -> Impressao {
    Impressao {
        duracao,
        fingerprint: "AQAADEMENTIRA".into(),
    }
}

/// Fontes do funil com a etapa 2 LIGADA: um `fpcalc` de mentira e a chave do
/// AcoustID. `impressao: None` faz o "binário" falhar, que é como se
/// comporta um acessório quebrado.
struct ComSom<F> {
    fetch: F,
    impressao: Option<Impressao>,
    chave: String,
    /// Arquivos em que o "fpcalc" falha, com a mensagem de cada um: é assim
    /// que se distingue "este MP3 não deu" de "o acessório não roda aqui".
    falhas: Vec<(String, &'static str)>,
}

impl<F> ComSom<F> {
    fn nova(fetch: F, duracao: f64) -> Self {
        ComSom {
            fetch,
            impressao: Some(impressao(duracao)),
            chave: "chave-acoustid-de-teste".into(),
            falhas: Vec::new(),
        }
    }

    /// O "fpcalc" falha SÓ nestes arquivos, com esta mensagem.
    fn falhando_em(mut self, arquivos: &[&str], erro: &'static str) -> Self {
        self.falhas = arquivos.iter().map(|a| ((*a).to_string(), erro)).collect();
        self
    }
}

impl<F> enrich::Fontes for ComSom<F>
where
    F: Fn(&str) -> Result<String, AppError>,
{
    fn buscar(&self, url: &str) -> Result<String, AppError> {
        (self.fetch)(url)
    }
    fn reconhece_pelo_som(&self) -> bool {
        true
    }
    fn impressao_digital(
        &self,
        mp3: &Path,
        _cancelado: &dyn Fn() -> bool,
    ) -> Option<Result<Impressao, AppError>> {
        // QA A2 — o `fpcalc` de verdade falha em ALGUNS arquivos e não em
        // outros (faixa curta, gravação silenciosa, MP3 danificado): o falso
        // precisa saber fazer isso, senão nenhum teste alcança a diferença
        // entre "este arquivo não deu" e "o acessório não roda".
        let nome = mp3
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        if let Some((_, erro)) = self.falhas.iter().find(|(f, _)| *f == nome) {
            return Some(Err(AppError((*erro).into())));
        }
        Some(match &self.impressao {
            Some(i) => Ok(i.clone()),
            None => Err(AppError(
                cancioneiro_lib::fingerprint::ERRO_FPCALC.into(),
            )),
        })
    }
    fn chave_acoustid(&self) -> &str {
        &self.chave
    }
}

/// Resposta do AcoustID com UMA gravação.
fn acoustid(score: f64, titulo: &str, artista: &str, duracao: f64) -> String {
    format!(
        r#"{{"status": "ok", "results": [{{"score": {score},
             "recordings": [{{"title": "{titulo}", "duration": {duracao},
                              "artists": [{{"name": "{artista}"}}]}}]}}]}}"#
    )
}

/// Fetcher que distribui por destino e guarda as URLs vistas.
fn roteador<'a>(
    urls: &'a RefCell<Vec<String>>,
    acoustid_body: &'a str,
    lrclib_body: &'a str,
    ovh_body: &'a str,
) -> impl Fn(&str) -> Result<String, AppError> + 'a {
    move |url: &str| {
        urls.borrow_mut().push(url.to_string());
        if url.starts_with(cancioneiro_lib::fingerprint::LOOKUP_URL) {
            Ok(acoustid_body.to_string())
        } else if url.starts_with(lyrics_ovh::SEARCH_URL) {
            Ok(ovh_body.to_string())
        } else {
            Ok(lrclib_body.to_string())
        }
    }
}

fn urls_para(urls: &RefCell<Vec<String>>, prefixo: &str) -> Vec<String> {
    urls.borrow()
        .iter()
        .filter(|u| u.starts_with(prefixo))
        .cloned()
        .collect()
}

fn scan_com<S: enrich::Fontes>(conn: &Connection, fontes: S) -> Vec<enrich::EnrichProposal> {
    enrich::enrich_scan(
        conn,
        "",
        fontes,
        ZERO,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap().propostas
}

// ---------------------------------------------------------------------------
// A etapa 2 dá o nome, e as etapas de letra procuram POR ELE
// ---------------------------------------------------------------------------
#[test]
fn com_o_nome_do_som_o_lrclib_recebe_um_palpite_so() {
    let (_dir, conn, _f) = setup_with(&[("sem_tags.mp3", "Falamansa - Oh! Chuva.mp3")]);
    let song = song_by_suffix(&conn, "Oh! Chuva.mp3");
    let dur = song.duration_seconds.unwrap() as f64;

    let urls = RefCell::new(Vec::new());
    let letra = format!(
        r#"[{{"trackName": "Viver Feliz", "artistName": "Nilson Chaves",
             "duration": {dur}, "plainLyrics": "a letra certa"}}]"#
    );
    let props = scan_com(
        &conn,
        ComSom::nova(
            roteador(
                &urls,
                &acoustid(0.95, "Viver Feliz", "Nilson Chaves", dur),
                &letra,
                "{}",
            ),
            dur,
        ),
    );

    // UMA consulta ao LRCLIB — não a cascata de palpites do nome do arquivo
    let lrclib = urls_para(&urls, cancioneiro_lib::lyrics_fetch::SEARCH_URL);
    assert_eq!(lrclib.len(), 1, "um palpite só: {lrclib:?}");
    assert!(
        lrclib[0].contains("Viver") && lrclib[0].contains("Nilson"),
        "a consulta usa o nome que o SOM deu: {}",
        lrclib[0]
    );
    // e a impressão digital foi consultada antes de tudo
    assert_eq!(
        urls_para(&urls, cancioneiro_lib::fingerprint::LOOKUP_URL).len(),
        1
    );

    let p = &props[0];
    assert_eq!(p.proposed_title, "Viver Feliz");
    assert_eq!(p.proposed_artist.as_deref(), Some("Nilson Chaves"));
    assert_eq!(p.lyrics.as_deref(), Some("a letra certa"));
    assert!(p.conflito.is_none(), "etiqueta inventada pelo indexador não conflita");
}

/// Nome que veio do SOM nunca chega PRÉ-MARCADO com letra junto: a régua do
/// LRCLIB confirma pela duração, e o AcoustID confirmou pela MESMA duração —
/// as duas erram juntas. O teto é MÉDIA, e quem cura dá o clique.
#[test]
fn letra_achada_por_nome_do_som_nunca_chega_pre_marcada() {
    let (_dir, conn, _f) = setup_with(&[("sem_tags.mp3", "Falamansa - Oh! Chuva.mp3")]);
    let song = song_by_suffix(&conn, "Oh! Chuva.mp3");
    let dur = song.duration_seconds.unwrap() as f64;
    let urls = RefCell::new(Vec::new());
    let letra = format!(
        r#"[{{"trackName": "Viver Feliz", "artistName": "Nilson Chaves",
             "duration": {dur}, "plainLyrics": "a letra certa"}}]"#
    );
    let props = scan_com(
        &conn,
        ComSom::nova(
            roteador(
                &urls,
                &acoustid(0.95, "Viver Feliz", "Nilson Chaves", dur),
                &letra,
                "{}",
            ),
            dur,
        ),
    );
    assert_eq!(props[0].confidence, "media");
    assert_eq!(props[0].fonte, enrich::FONTE_LRCLIB);
}

// ---------------------------------------------------------------------------
// O nome RECUSADO pela régua não vaza para a frente
// ---------------------------------------------------------------------------
#[test]
fn nome_recusado_pela_regua_nao_vaza_para_as_etapas_de_letra() {
    let (_dir, conn, _f) = setup_with(&[("sem_tags.mp3", "Falamansa - Oh! Chuva.mp3")]);
    let song = song_by_suffix(&conn, "Oh! Chuva.mp3");
    let dur = song.duration_seconds.unwrap() as f64;

    // três formas de o casamento ser recusado — nenhuma pode vazar o nome
    for (rotulo, corpo) in [
        ("pontuação abaixo de 0,7", acoustid(0.4, "Nome Recusado", "Artista Recusado", dur)),
        (
            "duração fora do teto de 15 s",
            acoustid(0.99, "Nome Recusado", "Artista Recusado", dur + 60.0),
        ),
        (
            "metadado de ripador",
            acoustid(0.99, "AudioTrack 03", "Unknown Artist", dur),
        ),
    ] {
        let urls = RefCell::new(Vec::new());
        scan_com(
            &conn,
            ComSom::nova(roteador(&urls, &corpo, "[]", "{}"), dur),
            );
        let lrclib = urls_para(&urls, cancioneiro_lib::lyrics_fetch::SEARCH_URL);
        assert!(
            lrclib.len() > 1,
            "{rotulo}: sem identidade, valem os palpites locais ({lrclib:?})"
        );
        assert!(
            lrclib.iter().all(|u| !u.contains("Recusado")),
            "{rotulo}: nome recusado vazou para a etapa de letra: {lrclib:?}"
        );
    }
}

// ---------------------------------------------------------------------------
// Divergência entre o som e a etiqueta REAL: CONFLITO, nunca correção
// ---------------------------------------------------------------------------
//
// O caso real: um arquivo etiquetado "Te ver feliz, te ver contente" /
// "Caetano Veloso" que é, de verdade, "Viver Feliz" do Nilson Chaves.
// "Caetano Veloso" não é placeholder por regra nenhuma — só o som denuncia.
#[test]
fn divergencia_entre_o_som_e_a_etiqueta_real_e_conflito() {
    let (_dir, conn, _f) = setup_with(&[("sem_letra.mp3", "musica.mp3")]);
    let song = song_by_suffix(&conn, "musica.mp3");
    writer::write_tags(
        &conn,
        song.id,
        "Te ver feliz, te ver contente",
        Some("Caetano Veloso"),
        None,
        None,
        None,
    )
    .unwrap();
    let dur = song.duration_seconds.unwrap() as f64;

    let urls = RefCell::new(Vec::new());
    let props = scan_com(
        &conn,
        ComSom::nova(
            roteador(
                &urls,
                &acoustid(0.95, "Viver Feliz", "Nilson Chaves", dur),
                "[]",
                "{}",
            ),
            dur,
        ),
    );

    let p = props
        .iter()
        .find(|p| p.song_id == song.id)
        .expect("o conflito é INFORMAÇÃO: a linha existe");
    let c = p.conflito.as_ref().expect("a divergência é declarada");
    assert_eq!(c.titulo, "Viver Feliz");
    assert_eq!(c.artista, "Nilson Chaves");
    assert_eq!(c.confianca, "alta", "a confiança é a da identificação");

    // a etiqueta NÃO é corrigida sozinha, e a linha nunca chega pré-marcada
    assert_eq!(p.proposed_title, "Te ver feliz, te ver contente");
    assert_eq!(p.proposed_artist.as_deref(), Some("Caetano Veloso"));
    assert_eq!(p.confidence, "baixa", "conflito nunca é pré-marcado");
    assert_eq!(p.fonte, enrich::FONTE_IMPRESSAO_DIGITAL);
    assert!(p.lyrics.is_none());

    // e o funil PARA: procurar letra sob um nome que o som acabou de
    // contradizer é o caminho para gravar a letra da música errada
    assert!(
        urls_para(&urls, cancioneiro_lib::lyrics_fetch::SEARCH_URL).is_empty(),
        "conflito não consulta letra"
    );
    assert!(urls_para(&urls, lyrics_ovh::SEARCH_URL).is_empty());
}

/// Variação de grafia NÃO é conflito (o `_discorda` do Python): tratá-la
/// como contradição desperdiçaria identificação boa.
#[test]
fn variacao_de_grafia_nao_vira_conflito() {
    let (_dir, conn, _f) = setup_with(&[("sem_letra.mp3", "musica.mp3")]);
    let song = song_by_suffix(&conn, "musica.mp3");
    writer::write_tags(
        &conn,
        song.id,
        "Cantiga do Sabiá",
        Some("Milionário & José Rico"),
        None,
        None,
        None,
    )
    .unwrap();
    let dur = song.duration_seconds.unwrap() as f64;
    let urls = RefCell::new(Vec::new());
    let props = scan_com(
        &conn,
        ComSom::nova(
            roteador(
                &urls,
                &acoustid(0.95, "Cantiga do Sabia", "Milionario y Jose Rico", dur),
                "[]",
                "{}",
            ),
            dur,
        ),
    );
    assert!(
        props.iter().all(|p| p.conflito.is_none()),
        "mesma música escrita de outro jeito não é contradição"
    );
    // a etiqueta REAL é preservada: a identificação só preenche o que falta
    assert!(props
        .iter()
        .all(|p| p.proposed_title != "Cantiga do Sabia"));
}

// ---------------------------------------------------------------------------
// V10 — O CAMINHO ÚNICO: uma varredura só, que faz tudo, em todas as músicas
// ---------------------------------------------------------------------------

/// **A varredura alcança a música COMPLETA — sem ninguém escolher modo.**
///
/// Era isto que o modo de conferência fazia, e ele era o único jeito de achar
/// etiqueta ERRADA (o caso "Caetano Veloso" que era Nilson Chaves). Recurso
/// que depende de o usuário adivinhar que existe é recurso que não existe: a
/// música que mais precisa da pergunta é justamente a que PARECE completa.
///
/// E o que a etapa 2 encontra nela continua sendo CONFLITO: mostra os dois
/// lados, não pré-marca nada, não corrige sozinha.
#[test]
fn a_varredura_alcanca_a_musica_completa_e_o_som_denuncia_a_etiqueta() {
    let (_dir, conn, _f) = setup_with(&[("com_letra.mp3", "com_letra.mp3")]);
    let song = song_by_suffix(&conn, "com_letra.mp3");
    let dur = song.duration_seconds.unwrap() as f64;
    assert!(song.has_lyrics && song.artist.is_some(), "a fixture é completa");

    let urls = RefCell::new(Vec::new());
    let props = scan_com(
        &conn,
        ComSom::nova(
            roteador(&urls, &acoustid(0.95, "Outra Coisa", "Outro Artista", dur), "[]", "{}"),
            dur,
        ),
    );
    let p = props
        .iter()
        .find(|p| p.song_id == song.id)
        .expect("a varredura alcança a música completa");
    assert!(p.conflito.is_some(), "o som contradiz a etiqueta");
    assert_eq!(p.confidence, "baixa", "conflito nunca chega pré-marcado");

    // o som foi perguntado, e nenhuma etapa de LETRA rodou: ela já tem letra
    assert_eq!(
        urls_para(&urls, cancioneiro_lib::fingerprint::LOOKUP_URL).len(),
        1
    );
    assert!(urls_para(&urls, cancioneiro_lib::lyrics_fetch::SEARCH_URL).is_empty());
    assert!(urls_para(&urls, lyrics_ovh::SEARCH_URL).is_empty());
}

/// **As etapas 3 e 4 rodam SÓ em quem não tem letra.** Não faz sentido buscar
/// letra para quem já tem — e se achasse, a proposta seria uma substituição
/// que o `apply` recusa sem consentimento explícito (DECISIONS #79): custo
/// alto para um resultado que o produto já decidiu não aplicar sozinho.
#[test]
fn as_etapas_de_letra_rodam_so_em_quem_nao_tem_letra() {
    let (_dir, conn, _f) = setup_with(&[
        ("com_letra.mp3", "com_letra.mp3"),
        ("sem_tags.mp3", "Falamansa - Oh! Chuva.mp3"),
    ]);
    let com = song_by_suffix(&conn, "com_letra.mp3");
    let sem = song_by_suffix(&conn, "Oh! Chuva.mp3");

    let urls = RefCell::new(Vec::new());
    let props = scan_com(
        &conn,
        |url: &str| {
            urls.borrow_mut().push(url.to_string());
            Ok("[]".to_string())
        },
    );
    assert!(
        !urls_para(&urls, cancioneiro_lib::lyrics_fetch::SEARCH_URL).is_empty(),
        "a que NÃO tem letra foi ao LRCLIB"
    );
    // a que tem letra não gerou proposta nenhuma (o no-op a derruba) e não
    // gastou uma consulta sequer com o próprio nome
    assert!(props.iter().all(|p| p.song_id != com.id));
    let nome_da_completa = com.title.replace(' ', "+");
    assert!(
        !urls.borrow().iter().any(|u| u.contains(&nome_da_completa)),
        "nenhuma consulta com o nome da música que já tem letra"
    );
    assert!(props.iter().any(|p| p.song_id == sem.id));
}

/// **A pergunta do fim.** A varredura devolve QUEM sobrou sem letra e quanto
/// tempo a etapa 5 levaria — porque a pergunta só pode ser feita quando pode
/// ser respondida com informação.
///
/// A lista vem em ids, e não em contagem, porque é exatamente o que o comando
/// da etapa 5 recebe: a regra de quem sobrou é UMA (DECISIONS #80).
#[test]
fn a_varredura_diz_quem_sobrou_sem_letra_e_quanto_tempo_isso_leva() {
    let (_dir, conn, _f) = setup_with(&[
        ("com_letra.mp3", "com_letra.mp3"),
        ("sem_tags.mp3", "Falamansa - Oh! Chuva.mp3"),
        ("sem_letra.mp3", "instrumental.mp3"),
    ]);
    let sem = song_by_suffix(&conn, "Oh! Chuva.mp3");
    let inst = song_by_suffix(&conn, "instrumental.mp3");
    writer::write_tags(&conn, inst.id, "Frevo", Some("Orquestra"), None, None, Some(true))
        .unwrap();

    let r = enrich::enrich_scan(
        &conn,
        "",
        |_: &str| Ok("[]".to_string()),
        ZERO,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap();

    assert_eq!(
        r.sem_letra_no_fim,
        vec![sem.id],
        "quem já tem letra não sobra, e instrumental não é transcrito"
    );
    assert!(
        r.segundos_de_transcricao > 0,
        "e a pergunta do fim vem com o tempo, não só com o número"
    );
}

/// A música que GANHOU letra na varredura não sobra para a etapa 5 — senão a
/// pergunta do fim cobraria horas de CPU por um trabalho já feito.
#[test]
fn quem_ganhou_letra_na_varredura_nao_sobra_para_a_transcricao() {
    let (_dir, conn, _f) = setup_with(&[("sem_tags.mp3", "Falamansa - Oh! Chuva.mp3")]);
    let song = song_by_suffix(&conn, "Oh! Chuva.mp3");
    let dur = song.duration_seconds.unwrap() as f64;
    let corpo = format!(
        r#"[{{"trackName": "Oh! Chuva", "artistName": "Falamansa",
             "duration": {dur}, "plainLyrics": "Chove lá fora"}}]"#
    );
    let r = enrich::enrich_scan(
        &conn,
        "",
        move |_: &str| Ok(corpo.clone()),
        ZERO,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap();
    assert!(r.propostas.iter().any(|p| p.lyrics.is_some()));
    assert!(
        r.sem_letra_no_fim.is_empty(),
        "achou letra: não sobra para a etapa 5"
    );
    assert_eq!(r.segundos_de_transcricao, 0);
}

/// A porta de UMA música continua sendo o funil INTEIRO, inclusive sobre a
/// letra que já existe: quem clicou quer uma segunda opinião, e responder
/// "não achamos" a uma busca que não aconteceu é mentir (DECISIONS #81).
#[test]
fn a_musica_avulsa_consulta_mesmo_tendo_letra() {
    let (_dir, conn, _f) = setup_with(&[("com_letra.mp3", "com_letra.mp3")]);
    let song = song_by_suffix(&conn, "com_letra.mp3");
    let urls = RefCell::new(Vec::new());
    enrich::enrich_scan_song(
        &conn,
        song.id,
        None,
        None,
        |url: &str| {
            urls.borrow_mut().push(url.to_string());
            Ok("[]".to_string())
        },
        ZERO,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap();
    assert!(
        !urls_para(&urls, cancioneiro_lib::lyrics_fetch::SEARCH_URL).is_empty(),
        "o botão de uma música procura mesmo com letra no arquivo"
    );
}

// ---------------------------------------------------------------------------
// Instrumental, acessório ausente e binário quebrado
// ---------------------------------------------------------------------------

/// A etapa 2 dá título e artista SEM tocar em letra — é o oposto das etapas
/// de letra, e por isso o instrumental entra nela. As etapas 3 e 4 continuam
/// pulando o arquivo (DECISIONS #81).
#[test]
fn instrumental_entra_na_etapa_2_e_continua_fora_das_etapas_de_letra() {
    let (_dir, conn, _f) = setup_with(&[("sem_tags.mp3", "instrumental.mp3")]);
    let song = song_by_suffix(&conn, "instrumental.mp3");
    writer::write_tags(&conn, song.id, "Faixa 03", None, None, None, Some(true)).unwrap();
    let dur = song.duration_seconds.unwrap() as f64;

    let urls = RefCell::new(Vec::new());
    let props = scan_com(
        &conn,
        ComSom::nova(
            roteador(
                &urls,
                &acoustid(0.95, "Frevo Nº 1", "Orquestra Popular", dur),
                r#"[{"trackName":"x","artistName":"y","duration":1,"plainLyrics":"letra alheia"}]"#,
                "{}",
            ),
            dur,
        ),
    );

    let p = &props[0];
    assert_eq!(p.proposed_title, "Frevo Nº 1", "o som deu o título");
    assert_eq!(p.proposed_artist.as_deref(), Some("Orquestra Popular"));
    assert_eq!(p.fonte, enrich::FONTE_IMPRESSAO_DIGITAL);
    assert!(p.lyrics.is_none(), "instrumental nunca recebe letra");
    assert_eq!(
        urls_para(&urls, cancioneiro_lib::fingerprint::LOOKUP_URL).len(),
        1
    );
    assert!(urls_para(&urls, cancioneiro_lib::lyrics_fetch::SEARCH_URL).is_empty());
}

/// Sem o acessório no cache, a etapa 2 não existe — em SILÊNCIO. É o estado
/// normal de quem ainda não baixou, e o funil se comporta exatamente como na
/// v0.8.1.
#[test]
fn sem_o_acessorio_o_funil_fica_exatamente_como_era() {
    let (_dir, conn, _f) = setup_with(&[("sem_tags.mp3", "Falamansa - Oh! Chuva.mp3")]);
    let urls = RefCell::new(Vec::new());
    let props = scan_com(
        &conn,
        // um simples fetcher: sem etapa 2 (é o padrão do `Fontes`)
        |url: &str| {
            urls.borrow_mut().push(url.to_string());
            Ok("[]".to_string())
        },
    );
    assert!(
        urls_para(&urls, cancioneiro_lib::fingerprint::LOOKUP_URL).is_empty(),
        "nenhuma consulta de reconhecimento"
    );
    assert!(urls_para(&urls, cancioneiro_lib::lyrics_fetch::SEARCH_URL).len() > 1);
    assert_eq!(props.len(), 1);
    assert!(props[0].error.is_none(), "ausência de acessório não é erro");
    assert!(props[0].conflito.is_none());
}

/// QA A2 — o acessório que NÃO RODA nesta máquina é veredito: reporta uma vez
/// e desliga a etapa, em vez de 95 linhas com a mesma acusação
/// (DECISIONS #83). E a varredura passa a DIZER quantas ficaram sem ser
/// perguntadas.
#[test]
fn fpcalc_que_nao_executa_reporta_uma_vez_desliga_a_etapa_e_conta_as_que_sobraram() {
    let (_dir, conn, _f) = setup_with(&[
        ("sem_tags.mp3", "a - um.mp3"),
        ("sem_tags.mp3", "b - dois.mp3"),
        ("sem_tags.mp3", "c - tres.mp3"),
    ]);
    let urls = RefCell::new(Vec::new());
    let fontes = ComSom {
        fetch: roteador(&urls, "{}", "[]", "{}"),
        impressao: Some(impressao(180.0)),
        chave: "chave-acoustid-de-teste".into(),
        // o binário não sobe: acontece em TODOS os arquivos
        falhas: vec![
            ("a - um.mp3".into(), cancioneiro_lib::fingerprint::ERRO_FPCALC_NAO_EXECUTA),
            ("b - dois.mp3".into(), cancioneiro_lib::fingerprint::ERRO_FPCALC_NAO_EXECUTA),
            ("c - tres.mp3".into(), cancioneiro_lib::fingerprint::ERRO_FPCALC_NAO_EXECUTA),
        ],
    };
    let r = enrich::enrich_scan(
        &conn,
        "",
        fontes,
        ZERO,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap();

    let com_erro = r.propostas.iter().filter(|p| p.error.is_some()).count();
    assert_eq!(com_erro, 1, "a primeira reporta; as demais pulam em silêncio");
    assert_eq!(
        r.sem_perguntar_ao_som, 2,
        "e a varredura sabe dizer quantas não foram perguntadas"
    );
}

/// QA A2 — falha do `fpcalc` num ARQUIVO não desliga a etapa do resto.
///
/// Medido pelo QA com o `fpcalc` de verdade nas fixtures do projeto: faixa
/// silenciosa e MP3 danificado saem com código 2, e num acervo de gravação de
/// casa isso é comum. Desligar a etapa no primeiro soluço fazia uma varredura
/// de conferência de 4 músicas perguntar ao som ZERO vezes e devolver uma
/// linha vermelha — e a pessoa, que esperou minutos por um trabalho caro que
/// disparou de propósito, concluía que o resto estava conferido.
#[test]
fn falha_do_fpcalc_num_arquivo_nao_desliga_a_etapa_do_resto() {
    let (_dir, conn, _f) = setup_with(&[
        ("sem_tags.mp3", "a - um.mp3"),
        ("sem_tags.mp3", "b - dois.mp3"),
        ("sem_tags.mp3", "c - tres.mp3"),
        ("sem_tags.mp3", "d - quatro.mp3"),
    ]);
    let urls = RefCell::new(Vec::new());
    let resposta = acoustid(0.95, "Asa Branca", "Luiz Gonzaga", 180.0);
    let fontes = ComSom::nova(roteador(&urls, &resposta, "[]", "{}"), 180.0)
    // só o PRIMEIRO arquivo falha — exatamente a reprodução do QA
    .falhando_em(&["a - um.mp3"], cancioneiro_lib::fingerprint::ERRO_FPCALC);

    let r = enrich::enrich_scan(
        &conn,
        "",
        fontes,
        ZERO,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap();

    assert_eq!(
        urls_para(&urls, cancioneiro_lib::fingerprint::LOOKUP_URL).len(),
        3,
        "as outras TRÊS foram perguntadas ao AcoustID"
    );
    let com_erro = r.propostas.iter().filter(|p| p.error.is_some()).count();
    assert_eq!(com_erro, 1, "o erro é só da música que falhou");
    assert_eq!(
        r.sem_perguntar_ao_som, 0,
        "nenhuma ficou sem ser perguntada: a etapa não foi desligada"
    );
}

/// E a chave recusada pelo AcoustID continua sendo veredito — a coerência que
/// faltava: para as fontes de letra nenhum erro desliga a etapa, para
/// o som qualquer erro desligava.
#[test]
fn chave_recusada_pelo_acoustid_desliga_a_etapa_e_conta_o_resto() {
    let (_dir, conn, _f) = setup_with(&[
        ("sem_tags.mp3", "a - um.mp3"),
        ("sem_tags.mp3", "b - dois.mp3"),
        ("sem_tags.mp3", "c - tres.mp3"),
    ]);
    let urls = RefCell::new(Vec::new());
    // o `consultar_acoustid` transforma status=error em ERRO_RESPOSTA; para
    // exercitar a RECUSA usamos o fetcher devolvendo o erro nomeado. As
    // demais fontes respondem "não temos" — com o caminho único elas rodam
    // nestas músicas (nenhuma tem letra), e o que se mede aqui é só a etapa 2.
    let fontes = ComSom::nova(
        move |url: &str| {
            urls.borrow_mut().push(url.to_string());
            if url.starts_with(cancioneiro_lib::fingerprint::LOOKUP_URL) {
                Err(AppError(cancioneiro_lib::fingerprint::ERRO_CHAVE_RECUSADA.into()))
            } else {
                Ok("[]".to_string())
            }
        },
        180.0,
    );
    let r = enrich::enrich_scan(
        &conn,
        "",
        fontes,
        ZERO,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap();

    let com_erro = r.propostas.iter().filter(|p| p.error.is_some()).count();
    assert_eq!(com_erro, 1);
    assert_eq!(r.sem_perguntar_ao_som, 2);
}

/// O caso normal não inventa aviso nenhum: sem desligamento, o contador é
/// zero e a tela não tem o que dizer.
#[test]
fn sem_desligamento_nenhuma_musica_fica_sem_ser_perguntada() {
    let (_dir, conn, _f) = setup_with(&[
        ("sem_tags.mp3", "a - um.mp3"),
        ("sem_tags.mp3", "b - dois.mp3"),
    ]);
    let urls = RefCell::new(Vec::new());
    let r = enrich::enrich_scan(
        &conn,
        "",
        ComSom::nova(
            roteador(&urls, r#"{"status":"ok","results":[]}"#, "[]", "{}"),
            180.0,
        ),
        ZERO,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap();
    assert_eq!(r.sem_perguntar_ao_som, 0);
}

/// A duração que o `fpcalc` mediu é PROVA (decodificou o áudio); a do
/// cabeçalho já mentiu por uma ordem de grandeza (DECISIONS #72). Quando o
/// som foi lido, é ela que confere o candidato do LRCLIB.
#[test]
fn a_duracao_medida_pelo_fpcalc_manda_no_lrclib() {
    let (_dir, conn, _f) = setup_with(&[("sem_tags.mp3", "Falamansa - Oh! Chuva.mp3")]);
    let song = song_by_suffix(&conn, "Oh! Chuva.mp3");
    let dur_real = song.duration_seconds.unwrap() as f64;

    // o AcoustID não reconhece (etapa 2 sem resultado), mas o fpcalc mediu a
    // duração — e o candidato do LRCLIB só bate com a duração MEDIDA
    let letra = format!(
        r#"[{{"trackName": "Oh! Chuva", "artistName": "Falamansa",
             "duration": {dur_real}, "plainLyrics": "chove"}}]"#
    );
    let urls = RefCell::new(Vec::new());
    let fontes = ComSom {
        fetch: roteador(&urls, r#"{"status":"ok","results":[]}"#, &letra, "{}"),
        impressao: Some(impressao(dur_real)),
        chave: "chave-acoustid-de-teste".into(),
        falhas: Vec::new(),
    };
    let props = scan_com(&conn, fontes);
    assert_eq!(props[0].lyrics.as_deref(), Some("chove"));
    assert_eq!(props[0].confidence, "alta", "sem identidade do som, a régua é a de sempre");
}

/// Vale nas DUAS entradas: a música avulsa do editor também passa pela
/// etapa 2.
#[test]
fn a_musica_avulsa_do_editor_tambem_pergunta_ao_som() {
    let (_dir, conn, _f) = setup_with(&[("sem_letra.mp3", "musica.mp3")]);
    let song = song_by_suffix(&conn, "musica.mp3");
    writer::write_tags(
        &conn,
        song.id,
        "Te ver feliz, te ver contente",
        Some("Caetano Veloso"),
        None,
        None,
        None,
    )
    .unwrap();
    let dur = song.duration_seconds.unwrap() as f64;
    let urls = RefCell::new(Vec::new());

    let p = enrich::enrich_scan_song(
        &conn,
        song.id,
        None,
        None,
        ComSom::nova(
            roteador(
                &urls,
                &acoustid(0.95, "Viver Feliz", "Nilson Chaves", dur),
                "[]",
                "{}",
            ),
            dur,
        ),
        ZERO,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap()
    .expect("o conflito é resultado, não vazio");
    let c = p.conflito.as_ref().unwrap();
    assert_eq!(c.titulo, "Viver Feliz");
    assert_eq!(c.artista, "Nilson Chaves");
}

// ===========================================================================
// V9 — a proposta AVISA quando trocaria um nome ESCRITO POR GENTE
// ===========================================================================
//
// A decisão 79 do lado das etiquetas. O LRCLIB devolve a grafia oficial, e a
// grafia oficial quase sempre difere da que a pessoa digitou: "Ponto de
// Oxum" volta como "Ponto de Oxum (Ao Vivo)", ALTA, PRÉ-MARCADA, e um clique
// em "Aplicar selecionadas" leva embora a curadoria de quem digitou.
//
// O que está errado não é a troca — a tela de revisão mostra o valor atual
// ao lado do proposto, então trocar nome não é invisível como trocar letra
// era. O que está errado é a PRÉ-MARCAÇÃO transformar em um clique o que
// deveria ser uma escolha por linha. O backend entrega a informação; o
// frontend decide o que fazer com ela.
//
// "Escrito por gente" exclui três coisas: campo vazio, placeholder de
// ripador, e o título que o indexador inventou a partir do nome do arquivo
// (DECISIONS #91). Preencher um branco ou substituir "Faixa 03" continua
// pré-marcável — é justamente para isso que a varredura existe.

/// Prepara uma música com as etiquetas pedidas e devolve (song, duração).
fn com_etiquetas(
    conn: &Connection,
    sufixo: &str,
    titulo: &str,
    artista: Option<&str>,
) -> (db::Song, f64) {
    let song = song_by_suffix(conn, sufixo);
    writer::write_tags(conn, song.id, titulo, artista, None, None, None).unwrap();
    let song = song_by_suffix(conn, sufixo);
    let dur = song.duration_seconds.unwrap() as f64;
    (song, dur)
}

/// Resposta do LRCLIB com um candidato de duração idêntica (⇒ ALTA).
fn lrclib(titulo: &str, artista: &str, dur: f64, letra: &str) -> String {
    format!(
        r#"[{{"trackName": "{titulo}", "artistName": "{artista}",
             "duration": {dur}, "plainLyrics": "{letra}"}}]"#
    )
}

#[test]
fn trocar_titulo_curado_por_outra_grafia_avisa() {
    let (_dir, conn, _f) = setup_with(&[("sem_letra.mp3", "ponto.mp3")]);
    let (song, dur) = com_etiquetas(&conn, "ponto.mp3", "Ponto de Oxum", Some("Coral Novo"));
    let corpo = lrclib("Ponto de Oxum (Ao Vivo)", "Coral Novo", dur, "letra oficial");

    let props = scan_props(&conn, "", |_: &str| Ok(corpo.clone()));
    let p = props.iter().find(|p| p.song_id == song.id).unwrap();

    assert_eq!(p.confidence, "alta", "a duração bate: é o caso perigoso");
    assert_eq!(p.proposed_title, "Ponto de Oxum (Ao Vivo)");
    assert!(
        p.substitui_nome_escrito,
        "trocaria um título que uma pessoa escreveu"
    );
}

#[test]
fn trocar_artista_curado_por_outra_grafia_avisa() {
    let (_dir, conn, _f) = setup_with(&[("sem_letra.mp3", "ponto.mp3")]);
    let (song, dur) = com_etiquetas(&conn, "ponto.mp3", "Ponto de Oxum", Some("Coral Novo"));
    // mesmo título, artista diferente: o aviso é por QUALQUER um dos dois
    let corpo = lrclib("Ponto de Oxum", "Coral Novo de Salvador", dur, "letra");

    let props = scan_props(&conn, "", |_: &str| Ok(corpo.clone()));
    let p = props.iter().find(|p| p.song_id == song.id).unwrap();
    assert_eq!(p.proposed_title, "Ponto de Oxum");
    assert!(p.substitui_nome_escrito, "o artista escrito seria trocado");
}

/// A MESMA troca do teste acima — "Ponto de Oxum" → "Ponto de Oxum (Ao
/// Vivo)", ALTA —, mas por cima de etiqueta de ripador. Aqui não há
/// curadoria para proteger: é exatamente para isto que a varredura existe, e
/// a linha continua pré-marcável.
#[test]
fn substituir_placeholder_de_ripador_nao_avisa() {
    let (_dir, conn, _f) =
        setup_with(&[("sem_letra.mp3", "Coral Novo - Ponto de Oxum.mp3")]);
    let (song, dur) = com_etiquetas(
        &conn,
        "Ponto de Oxum.mp3",
        "Faixa 03",
        Some("no artist"),
    );
    let corpo = lrclib("Ponto de Oxum (Ao Vivo)", "Coral Novo", dur, "letra");

    let props = scan_props(&conn, "", |_: &str| Ok(corpo.clone()));
    let p = props.iter().find(|p| p.song_id == song.id).unwrap();
    assert_eq!(p.confidence, "alta");
    assert_eq!(p.proposed_title, "Ponto de Oxum (Ao Vivo)");
    assert!(
        !p.substitui_nome_escrito,
        "'Faixa 03' não foi escrito por gente — é para isso que a varredura existe"
    );
}

#[test]
fn substituir_o_titulo_que_o_indexador_inventou_nao_avisa() {
    // arquivo SEM TIT2: o `title` do banco é o nome do arquivo copiado pelo
    // indexador (DECISIONS #91), não etiqueta de ninguém
    let (_dir, conn, _f) = setup_with(&[("sem_tags.mp3", "Falamansa - Oh! Chuva.mp3")]);
    let song = song_by_suffix(&conn, "Oh! Chuva.mp3");
    let dur = song.duration_seconds.unwrap() as f64;
    let corpo = lrclib("Oh! Chuva", "Falamansa", dur, "chove");

    let props = scan_props(&conn, "", |_: &str| Ok(corpo.clone()));
    let p = props.iter().find(|p| p.song_id == song.id).unwrap();
    assert_eq!(p.current_title, "Falamansa - Oh! Chuva", "o que o indexador pôs");
    assert_eq!(p.proposed_title, "Oh! Chuva");
    assert!(
        !p.substitui_nome_escrito,
        "invenção do indexador não é curadoria de ninguém"
    );
}

#[test]
fn preencher_campo_vazio_nao_avisa() {
    let (_dir, conn, _f) = setup_with(&[("sem_letra.mp3", "ponto.mp3")]);
    // título escrito, artista VAZIO: a proposta preenche o branco
    let (song, dur) = com_etiquetas(&conn, "ponto.mp3", "Ponto de Oxum", None);
    let corpo = lrclib("Ponto de Oxum", "Coral Novo", dur, "letra");

    let props = scan_props(&conn, "", |_: &str| Ok(corpo.clone()));
    let p = props.iter().find(|p| p.song_id == song.id).unwrap();
    assert_eq!(p.proposed_artist.as_deref(), Some("Coral Novo"));
    assert!(
        !p.substitui_nome_escrito,
        "ganhar artista onde não havia nenhum não substitui nada"
    );
}

#[test]
fn so_a_letra_mudando_nao_avisa() {
    let (_dir, conn, _f) = setup_with(&[("sem_letra.mp3", "ponto.mp3")]);
    let (song, dur) = com_etiquetas(&conn, "ponto.mp3", "Ponto de Oxum", Some("Coral Novo"));
    // o LRCLIB devolve os MESMOS nomes: a letra é a mudança inteira
    let corpo = lrclib("Ponto de Oxum", "Coral Novo", dur, "a letra");

    let props = scan_props(&conn, "", |_: &str| Ok(corpo.clone()));
    let p = props.iter().find(|p| p.song_id == song.id).unwrap();
    assert_eq!(p.lyrics.as_deref(), Some("a letra"));
    assert!(!p.substitui_nome_escrito);
}

/// Espaço das pontas não é troca — a comparação é por valor EFETIVO, a mesma
/// noção que o `e_no_op` usa dos dois lados.
#[test]
fn diferenca_so_de_espaco_nao_avisa() {
    let (_dir, conn, _f) = setup_with(&[("sem_letra.mp3", "ponto.mp3")]);
    let (song, dur) = com_etiquetas(&conn, "ponto.mp3", "Ponto de Oxum", Some("Coral Novo"));
    let corpo = lrclib("  Ponto de Oxum  ", "Coral Novo", dur, "a letra");

    let props = scan_props(&conn, "", |_: &str| Ok(corpo.clone()));
    let p = props.iter().find(|p| p.song_id == song.id).unwrap();
    assert!(!p.substitui_nome_escrito, "' Oxum ' não é outro nome");
}

/// A linha de CONFLITO nunca avisa substituição: ela não propõe troca
/// nenhuma (os nomes propostos são os atuais), e já não é pré-marcada por
/// construção. São dois mecanismos separados, e continuam separados.
#[test]
fn a_linha_de_conflito_nao_avisa_substituicao() {
    let (_dir, conn, _f) = setup_with(&[("sem_letra.mp3", "musica.mp3")]);
    let (song, dur) = com_etiquetas(
        &conn,
        "musica.mp3",
        "Te ver feliz, te ver contente",
        Some("Caetano Veloso"),
    );
    let urls = RefCell::new(Vec::new());
    let props = scan_com(
        &conn,
        ComSom::nova(
            roteador(
                &urls,
                &acoustid(0.95, "Viver Feliz", "Nilson Chaves", dur),
                "[]",
                "{}",
            ),
            dur,
        ),
    );
    let p = props.iter().find(|p| p.song_id == song.id).unwrap();
    assert!(p.conflito.is_some());
    assert!(!p.substitui_nome_escrito, "conflito não propõe troca");
}

// ---------------------------------------------------------------------------
// QA M5 — instalar o acessório não pode PIORAR o resultado
//
// `identidade_util` devolvia os valores DA ETIQUETA quando ela era real, mas
// devolvia-os dentro de um `Some` — e o resto do funil lê esse `Some` como
// "temos o nome verdadeiro, vindo do som". Duas consequências, as duas na
// direção errada: a cascata de palpites virava UM palpite (perdendo a quebra
// de "Adventício - Lampejo" em título e artista) e a letra achada levava o
// teto de confiança MÉDIA, tirando a pré-marcação de uma ALTA que não tinha
// nada de arriscado — o nome não veio do som, veio da etiqueta que já estava
// lá. A máquina que baixou o acessório achava MENOS letras e pedia MAIS
// cliques, que é o oposto do que a tela promete ao oferecer o download.
// ---------------------------------------------------------------------------

/// Quando o som não acrescenta NADA — a etiqueta já era real e a
/// identificação só a confirma —, o resultado tem de ser idêntico ao de quem
/// não baixou o acessório. É a régua inteira em uma frase.
#[test]
fn identidade_que_so_ecoa_a_etiqueta_nao_muda_nada_no_funil() {
    let letra_de = |dur: f64| {
        format!(
            r#"[{{"trackName": "Asa Branca", "artistName": "Luiz Gonzaga",
                 "duration": {dur}, "plainLyrics": "quando olhei a terra ardendo"}}]"#
        )
    };

    // COM som: a etiqueta é real dos dois lados e o AcoustID confirma os
    // mesmos nomes
    let (_dir, conn, _f) = setup_with(&[("sem_letra.mp3", "musica.mp3")]);
    let (_song, dur) = com_etiquetas(&conn, "musica.mp3", "Asa Branca", Some("Luiz Gonzaga"));
    let urls_com = RefCell::new(Vec::new());
    let letra = letra_de(dur);
    let com_som = scan_com(
        &conn,
        ComSom::nova(
            roteador(
                &urls_com,
                &acoustid(0.95, "Asa Branca", "Luiz Gonzaga", dur),
                &letra,
                "{}",
            ),
            dur,
        ),
    );

    // SEM som: o mesmo arquivo, o mesmo LRCLIB, sem acessório nenhum
    let (_dir2, conn2, _f2) = setup_with(&[("sem_letra.mp3", "musica.mp3")]);
    let (_s2, dur2) = com_etiquetas(&conn2, "musica.mp3", "Asa Branca", Some("Luiz Gonzaga"));
    assert!((dur - dur2).abs() < 1e-9, "as duas fixtures têm a mesma duração");
    let sem_som = scan_props(&conn2, "", |_url: &str| Ok(letra_de(dur2)));

    assert_eq!(com_som.len(), 1);
    assert_eq!(sem_som.len(), 1);
    let (c, s) = (&com_som[0], &sem_som[0]);
    assert_eq!(c.lyrics, s.lyrics, "a letra achada é a mesma");
    assert_eq!(
        c.confidence, s.confidence,
        "e a confiança também: o teto do som não se aplica a nome de etiqueta"
    );
    assert_eq!(c.confidence, "alta", "a duração confirmou, como sempre");
    assert_eq!(c.proposed_title, s.proposed_title);
    assert_eq!(c.proposed_artist, s.proposed_artist);
}

/// Título que é a etiqueta ("Adventício - Lampejo") continua rendendo a
/// CASCATA — a quebra em título/artista é justamente o que acha a letra desse
/// arquivo. O som ter preenchido o artista não torna o título verdadeiro.
#[test]
fn artista_vindo_do_som_nao_reduz_a_cascata_de_palpites_do_titulo() {
    let (_dir, conn, _f) = setup_with(&[("sem_letra.mp3", "musica.mp3")]);
    // título REAL, mas no formato "Artista - Título"; artista vazio
    let (_song, dur) = com_etiquetas(&conn, "musica.mp3", "Adventício - Lampejo", None);
    let urls = RefCell::new(Vec::new());
    let props = scan_com(
        &conn,
        ComSom::nova(
            // o som identifica "Lampejo" (contido no título: não é conflito)
            // e traz o artista que faltava
            roteador(&urls, &acoustid(0.95, "Lampejo", "Adventício", dur), "[]", "{}"),
            dur,
        ),
    );

    let lrclib = urls_para(&urls, cancioneiro_lib::lyrics_fetch::SEARCH_URL);
    assert!(
        lrclib.len() > 1,
        "a cascata continua: o título ainda é a etiqueta, não o som — {lrclib:?}"
    );
    // a consulta é "{título} {artista}": o palpite quebrado pede "Lampejo"
    // como TÍTULO, que é o que acha a letra deste arquivo
    assert!(
        lrclib.iter().any(|u| u.contains("q=Lampejo")),
        "e a quebra em título/artista está entre os palpites: {lrclib:?}"
    );
    assert_eq!(props.len(), 1);
}

/// E o caso que o teto existe para proteger continua protegido: quando o
/// TÍTULO veio do som, é um palpite só e a confiança é MÉDIA.
#[test]
fn titulo_vindo_do_som_ainda_rende_um_palpite_so_e_teto_media() {
    let (_dir, conn, _f) = setup_with(&[("sem_tags.mp3", "Falamansa - Oh! Chuva.mp3")]);
    let song = song_by_suffix(&conn, "Oh! Chuva.mp3");
    let dur = song.duration_seconds.unwrap() as f64;
    let urls = RefCell::new(Vec::new());
    let letra = format!(
        r#"[{{"trackName": "Viver Feliz", "artistName": "Nilson Chaves",
             "duration": {dur}, "plainLyrics": "a letra certa"}}]"#
    );
    let props = scan_com(
        &conn,
        ComSom::nova(
            roteador(
                &urls,
                &acoustid(0.95, "Viver Feliz", "Nilson Chaves", dur),
                &letra,
                "{}",
            ),
            dur,
        ),
    );
    assert_eq!(
        urls_para(&urls, cancioneiro_lib::lyrics_fetch::SEARCH_URL).len(),
        1,
        "com o título vindo do som, um palpite basta"
    );
    assert_eq!(props[0].confidence, "media", "e o teto do som vale");
}

// ===========================================================================
// V10 — A ETAPA 5: escrever a letra ouvindo o áudio
//
// O motor é INJETADO: a suíte roda sem o `whisper-cli` e sem os 180 MB do
// modelo. O que se prova aqui é o que o app FAZ com o que o motor devolve —
// e sobretudo o que ele se recusa a fazer.
// ===========================================================================

use cancioneiro_lib::transcricao::{self, Duracao, SaidaDoMotor};

/// Nunca cancela, nunca reporta progresso.
const SEM_PROGRESSO_5: fn(usize, usize, &str, u8) = |_, _, _, _| {};

/// Um motor de mentira que devolve sempre o mesmo texto e a mesma duração.
fn motor(
    texto: &'static str,
    duracao: f64,
) -> impl Fn(&Path, &dyn Fn() -> bool, &dyn Fn(u8)) -> Result<Option<SaidaDoMotor>, AppError> {
    move |_mp3, _cancelado, progresso| {
        progresso(50);
        Ok(Some(SaidaDoMotor {
            texto: texto.to_string(),
            duracao: Duracao::completa(duracao),
        }))
    }
}

/// Um motor de mentira que também GASTA relógio — é o que torna a razão
/// medida (segundos de máquina por segundo de áudio) diferente de zero.
fn motor_lento(
    texto: &'static str,
    duracao: f64,
    gasto: Duration,
) -> impl Fn(&Path, &dyn Fn() -> bool, &dyn Fn(u8)) -> Result<Option<SaidaDoMotor>, AppError> {
    move |_mp3, _cancelado, _progresso| {
        std::thread::sleep(gasto);
        Ok(Some(SaidaDoMotor {
            texto: texto.to_string(),
            duracao: Duracao::completa(duracao),
        }))
    }
}

fn transcrever(
    conn: &Connection,
    ids: &[i64],
    motor: impl Fn(&Path, &dyn Fn() -> bool, &dyn Fn(u8)) -> Result<Option<SaidaDoMotor>, AppError>,
) -> enrich::TranscricaoResultado {
    enrich::transcricao_scan(
        conn,
        transcricao::modelo_oferecido(),
        ids,
        motor,
        SEM_PROGRESSO_5,
        SEM_CANCELAMENTO,
    )
    .unwrap()
}

/// A letra escrita pela máquina chega como PROPOSTA, com a fonte visível, e
/// **sem tocar em título e artista**. É a garantia central da etapa 5: ela não
/// identifica música nenhuma, então não há nome para propor — e portanto não
/// há como sobrescrever etiqueta real, em confiança nenhuma.
#[test]
fn a_transcricao_propoe_letra_e_nunca_encosta_na_etiqueta() {
    let (_dir, conn, _f) = setup_with(&[("sem_letra.mp3", "sem_letra.mp3")]);
    let song = song_by_suffix(&conn, "sem_letra.mp3");
    writer::write_tags(&conn, song.id, "Cantiga", Some("Dona Zica"), None, None, None).unwrap();
    let song = song_by_suffix(&conn, "sem_letra.mp3");

    let letra = "Na beira do mar sagrado\nNa beira do mar sagrado\nEu vi Iemanjá chegar";
    let r = transcrever(&conn, &[song.id], motor(letra, 120.0));

    let p = &r.propostas[0];
    assert_eq!(p.lyrics.as_deref(), Some(letra));
    assert_eq!(p.fonte, enrich::FONTE_TRANSCRICAO);
    assert_eq!(p.confidence, "media", "letra de máquina nunca chega pré-marcada");
    assert_eq!(p.proposed_title, "Cantiga", "o título é o que já estava lá");
    assert_eq!(p.proposed_artist.as_deref(), Some("Dona Zica"));
    assert!(!p.substitui_nome_escrito, "não há nome a substituir");
    assert!(p.conflito.is_none(), "sem nome vindo daqui, não há conflito");
    assert_eq!(
        p.refrao.as_deref(),
        Some("na beira do mar sagrado"),
        "o trecho mais repetido, para a revisão reconhecer a música"
    );
    assert!(r.razao_medida.is_some(), "a máquina foi medida");
}

/// Transcrição vazia com áudio LEGÍVEL marca instrumental (V7/F16) — como
/// PROPOSTA, porque a marca tira o arquivo da fila de letra para sempre. E a
/// explicação vai em `aviso`, não em `error`: a linha PODE ser aplicada.
#[test]
fn transcricao_vazia_propoe_a_marca_de_instrumental_com_a_conta_a_vista() {
    let (_dir, conn, _f) = setup_with(&[("sem_letra.mp3", "sem_letra.mp3")]);
    let song = song_by_suffix(&conn, "sem_letra.mp3");

    let r = transcrever(&conn, &[song.id], motor("", 300.0));
    let p = &r.propostas[0];
    assert!(p.marcar_instrumental);
    assert!(p.lyrics.is_none());
    assert!(p.error.is_none(), "não é falha: a linha é aplicável");
    assert!(p.aviso.is_some(), "e diz por quê");
}

/// **Sem prova de duração, ADIADA.** O cabeçalho do MP3 já mentiu por uma
/// ordem de grandeza (DECISIONS #72), e marcar instrumental por engano tira a
/// música da fila de letra para sempre. Nada é gravado, e a linha diz o que
/// fazer.
#[test]
fn transcricao_rala_sem_duracao_provada_nao_grava_nada() {
    let (_dir, conn, _f) = setup_with(&[("sem_letra.mp3", "sem_letra.mp3")]);
    let song = song_by_suffix(&conn, "sem_letra.mp3");
    // a fixture tem 2 s; o CABEÇALHO passa a dizer 5 minutos, que é
    // exatamente o modo de falha da DECISIONS #72 (300 s lidos como 2365 s)
    conn.execute("UPDATE songs SET duration_seconds = 300 WHERE id = ?1", [song.id])
        .unwrap();

    // motor que devolve texto ralo e NÃO informa a duração
    let r = transcrever(&conn, &[song.id], motor("la la la", 0.0));
    let p = &r.propostas[0];
    assert!(!p.marcar_instrumental, "nada é decidido sem prova");
    assert!(p.lyrics.is_none());
    assert!(p.error.is_some(), "a linha informa e não se aplica");
    assert_eq!(p.fonte, enrich::FONTE_ERRO);
}

/// **Instrumental não é transcrito** (PRD V10, DECISIONS #71). A trava existe
/// mesmo com as portas já não mandando essa música para cá: o caminho normal
/// nunca chega nela, e é por isso que a recusa precisa existir.
///
/// **ESTE TESTE MUDOU DE PROPÓSITO NA V10.11, e a metade que saiu é o conserto.**
/// Ele guardava DUAS recusas — o instrumental e a música que já tem letra —, e a
/// segunda deixou de existir: com o botão da ficha valendo também para quem tem
/// letra (DECISIONS #167 revertida), a recusa passaria a gastar o clique de quem
/// leu "cerca de 4 minutos" no rótulo. O que ela protegia continua no `apply`,
/// que é onde o consentimento da DECISIONS #79 sempre morou de verdade — e há
/// teste próprio para isso (`a_letra_refeita_nao_entra_no_arquivo_sem_o_consentimento`).
///
/// A assimetria entre as duas é a diferença entre as coisas que elas dizem: a
/// marca de instrumental afirma que NÃO HÁ VOZ no áudio, e transcrever contra
/// ela é gastar minutos para desmentir quem ouviu; ter letra não afirma nada
/// sobre o áudio — e, quando a letra é uma transcrição imperfeita, é o próprio
/// motivo de querer refazê-la.
#[test]
fn a_etapa_5_recusa_o_instrumental() {
    let (_dir, conn, _f) = setup_with(&[("sem_letra.mp3", "instrumental.mp3")]);
    let inst = song_by_suffix(&conn, "instrumental.mp3");
    writer::write_tags(&conn, inst.id, "Frevo", Some("Orquestra"), None, None, Some(true))
        .unwrap();

    let chamadas = RefCell::new(0);
    let r = enrich::transcricao_scan(
        &conn,
        transcricao::modelo_oferecido(),
        &[inst.id],
        |_mp3: &Path, _c: &dyn Fn() -> bool, _p: &dyn Fn(u8)| {
            *chamadas.borrow_mut() += 1;
            Ok(Some(SaidaDoMotor {
                texto: "letra que não deveria existir".into(),
                duracao: Duracao::completa(120.0),
            }))
        },
        SEM_PROGRESSO_5,
        SEM_CANCELAMENTO,
    )
    .unwrap();

    assert_eq!(*chamadas.borrow(), 0, "não gastou CPU");
    assert_eq!(
        r.propostas[0].error.as_deref(),
        Some(enrich::AVISO_INSTRUMENTAL_NAO_TRANSCREVE)
    );
    assert!(r.propostas.iter().all(|p| p.lyrics.is_none()));
    // a frase é texto corrido, sem a quebra de linha do código
    let msg = enrich::AVISO_INSTRUMENTAL_NAO_TRANSCREVE;
    assert!(!msg.contains("  ") && !msg.contains('\n'), "{msg:?}");
}

/// Binário que não sobe é veredito sobre a MÁQUINA: reporta e desliga a etapa
/// pelo resto da fila, em vez de repetir a mesma acusação 47 vezes (a mesma
/// regra da etapa 2, QA A2). Falha de UM arquivo não desliga nada.
#[test]
fn transcritor_que_nao_executa_desliga_a_etapa_e_falha_de_arquivo_nao() {
    let (_dir, conn, _f) = setup_with(&[
        ("sem_letra.mp3", "a.mp3"),
        ("sem_letra.mp3", "b.mp3"),
        ("sem_letra.mp3", "c.mp3"),
    ]);
    let ids: Vec<i64> = ["a.mp3", "b.mp3", "c.mp3"]
        .iter()
        .map(|n| song_by_suffix(&conn, n).id)
        .collect();

    let chamadas = RefCell::new(0);
    let r = enrich::transcricao_scan(
        &conn,
        transcricao::modelo_oferecido(),
        &ids,
        |_mp3: &Path, _c: &dyn Fn() -> bool, _p: &dyn Fn(u8)| {
            *chamadas.borrow_mut() += 1;
            Err(AppError(transcricao::ERRO_NAO_EXECUTA.into()))
        },
        SEM_PROGRESSO_5,
        SEM_CANCELAMENTO,
    )
    .unwrap();
    assert_eq!(*chamadas.borrow(), 1, "tentou uma vez e desligou");
    assert_eq!(r.propostas.len(), 3, "mas todas as linhas explicam por quê");

    // e o erro de UM arquivo não desliga a etapa das outras
    let chamadas = RefCell::new(0);
    enrich::transcricao_scan(
        &conn,
        transcricao::modelo_oferecido(),
        &ids,
        |_mp3: &Path, _c: &dyn Fn() -> bool, _p: &dyn Fn(u8)| {
            *chamadas.borrow_mut() += 1;
            Err(AppError(transcricao::ERRO_AUDIO.into()))
        },
        SEM_PROGRESSO_5,
        SEM_CANCELAMENTO,
    )
    .unwrap();
    assert_eq!(*chamadas.borrow(), 3, "cada arquivo teve a sua chance");
}

/// Cancelar para a fila onde está, com o que já tem. É a etapa que leva
/// MINUTOS por música: um cancelamento que só é consultado no fim não é
/// cancelamento.
#[test]
fn cancelar_para_a_fila_da_transcricao_com_o_que_ja_tem() {
    let (_dir, conn, _f) = setup_with(&[
        ("sem_letra.mp3", "a.mp3"),
        ("sem_letra.mp3", "b.mp3"),
        ("sem_letra.mp3", "c.mp3"),
    ]);
    let ids: Vec<i64> = ["a.mp3", "b.mp3", "c.mp3"]
        .iter()
        .map(|n| song_by_suffix(&conn, n).id)
        .collect();

    let feitas = RefCell::new(0);
    let r = enrich::transcricao_scan(
        &conn,
        transcricao::modelo_oferecido(),
        &ids,
        |_mp3: &Path, _c: &dyn Fn() -> bool, _p: &dyn Fn(u8)| {
            *feitas.borrow_mut() += 1;
            Ok(Some(SaidaDoMotor {
                texto: "uma letra qualquer bem comprida para não ser rala".into(),
                duracao: Duracao::completa(30.0),
            }))
        },
        SEM_PROGRESSO_5,
        || *feitas.borrow() >= 1, // cancela depois da primeira
    )
    .unwrap();
    assert_eq!(r.propostas.len(), 1, "voltou com o que já tinha");
}

/// O `apply` da etapa 5 grava a letra **marcada como transcrição**
/// (`TXXX:LETRA_ORIGEM = "transcricao"`, o mesmo valor do
/// `tools/embed_lyrics.py`) — é a marca que o curador aprendeu a ler como
/// "isto pode estar errado".
#[test]
fn aplicar_a_transcricao_grava_a_marca_de_procedencia() {
    let (_dir, conn, _f) = setup_with(&[("sem_letra.mp3", "sem_letra.mp3")]);
    let song = song_by_suffix(&conn, "sem_letra.mp3");
    let r = transcrever(&conn, &[song.id], motor("a letra que a máquina ouviu", 60.0));
    let p = &r.propostas[0];

    let res = enrich::apply(
        &conn,
        &[EnrichApply {
            song_id: song.id,
            title: p.proposed_title.clone(),
            artist: p.proposed_artist.clone(),
            lyrics: p.lyrics.clone(),
            add_temas: None,
            current_title: p.current_title.clone(),
            current_artist: p.current_artist.clone(),
            fonte: Some(p.fonte.clone()),
            substituir_letra: false,
            marcar_instrumental: false,
        }],
    )
    .unwrap();
    assert!(res[0].error.is_none(), "{:?}", res[0].error);
    let depois = song_by_suffix(&conn, "sem_letra.mp3");
    assert_eq!(depois.letra_origem.as_deref(), Some("transcricao"));
    assert_eq!(
        db::get_lyrics(&conn, song.id).unwrap().as_deref(),
        Some("a letra que a máquina ouviu")
    );
}

/// E o `apply` da proposta de INSTRUMENTAL grava a marca — só quando quem
/// revisou confirmou. **Nunca desmarca**: desmarcar continua sendo
/// exclusividade do editor (DECISIONS #71).
#[test]
fn aplicar_marca_o_instrumental_confirmado_e_nunca_desmarca() {
    let (_dir, conn, _f) = setup_with(&[("sem_letra.mp3", "sem_letra.mp3")]);
    let song = song_by_suffix(&conn, "sem_letra.mp3");
    let r = transcrever(&conn, &[song.id], motor("", 300.0));
    let p = &r.propostas[0];
    assert!(p.marcar_instrumental);

    let aplicar = |marcar: bool, s: &db::Song| {
        enrich::apply(
            &conn,
            &[EnrichApply {
                song_id: s.id,
                title: s.title.clone(),
                artist: s.artist.clone(),
                lyrics: None,
                add_temas: None,
                current_title: s.title.clone(),
                current_artist: s.artist.clone(),
                fonte: Some(enrich::FONTE_TRANSCRICAO.into()),
                substituir_letra: false,
                marcar_instrumental: marcar,
            }],
        )
        .unwrap()
    };

    let res = aplicar(true, &song);
    assert!(res[0].error.is_none(), "{:?}", res[0].error);
    assert!(song_by_suffix(&conn, "sem_letra.mp3").instrumental);

    // uma segunda aplicação SEM a marca não a desfaz
    let agora = song_by_suffix(&conn, "sem_letra.mp3");
    let res = aplicar(false, &agora);
    assert!(res[0].error.is_none(), "{:?}", res[0].error);
    assert!(
        song_by_suffix(&conn, "sem_letra.mp3").instrumental,
        "nenhuma rotina desmarca sozinha"
    );
}

/// A varredura e a etapa 5 se encaixam: quem sobra da primeira é exatamente o
/// que a segunda recebe, e o que a segunda escreve some da próxima varredura.
#[test]
fn o_que_sobra_da_varredura_e_o_que_a_etapa_5_recebe() {
    let (_dir, conn, _f) = setup_with(&[("sem_letra.mp3", "sem_letra.mp3")]);
    let r = enrich::enrich_scan(
        &conn,
        "",
        |_: &str| Ok("[]".to_string()),
        ZERO,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap();
    assert_eq!(r.sem_letra_no_fim.len(), 1);

    let t = transcrever(
        &conn,
        &r.sem_letra_no_fim,
        motor("Chove lá fora\nE aqui dentro canta o coração", 60.0),
    );
    let p = &t.propostas[0];
    let __res = enrich::apply(
        &conn,
        &[EnrichApply {
            song_id: p.song_id,
            title: p.proposed_title.clone(),
            artist: p.proposed_artist.clone(),
            lyrics: p.lyrics.clone(),
            add_temas: None,
            current_title: p.current_title.clone(),
            current_artist: p.current_artist.clone(),
            fonte: Some(p.fonte.clone()),
            substituir_letra: false,
            marcar_instrumental: false,
        }],
    )
    .unwrap();
    assert!(__res[0].error.is_none(), "{:?}", __res[0].error);

    let depois = enrich::enrich_scan(
        &conn,
        "",
        |_: &str| Ok("[]".to_string()),
        ZERO,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap();
    assert!(
        depois.sem_letra_no_fim.is_empty(),
        "a música transcrita não volta para a fila da etapa 5"
    );
}

// ===========================================================================
// V10 — ETAPA 4: lyrics.ovh, a fonte SEM CHAVE, antes da fonte COM CHAVE
// ===========================================================================


fn com_tags(conn: &Connection, arquivo: &str, titulo: &str, artista: &str) -> db::Song {
    let song = song_by_suffix(conn, arquivo);
    writer::write_tags(conn, song.id, titulo, Some(artista), None, None, None).unwrap();
    song_by_suffix(conn, arquivo)
}

/// **A etapa 4 roda sem credencial nenhuma.**
///
/// É a razão de ela existir, e de ela ter substituído o Vagalume: API
/// descontinuada, chave inalcançável, e um módulo que nunca rodou contra o
/// serviço real (DECISIONS #110). Nenhuma etapa do funil pede credencial do
/// usuário agora.
#[test]
fn a_etapa_4_acha_letra_sem_credencial_nenhuma() {
    let (_dir, conn, _f) = setup_with(&[("sem_letra.mp3", "sem_letra.mp3")]);
    let song = com_tags(&conn, "sem_letra.mp3", "Asa Branca", "Luiz Gonzaga");

    let urls = RefCell::new(Vec::new());
    let props = enrich::enrich_scan(
        &conn,
        "",
        fontes_de_letra(&urls, "[]".into(), r#"{"lyrics": "Quando olhei a terra ardendo"}"#.into()),
        ZERO,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap()
    .propostas;

    let p = props.iter().find(|p| p.song_id == song.id).expect("proposta");
    assert_eq!(p.fonte, enrich::FONTE_LYRICS_OVH);
    assert_eq!(p.lyrics.as_deref(), Some("Quando olhei a terra ardendo"));
    // MÉDIA, nunca ALTA: sem duração não há confirmação independente, e ALTA
    // chega PRÉ-MARCADA (DECISIONS #49)
    assert_eq!(p.confidence, "media");
    // e a etapa não propõe trocar nome nenhum
    assert_eq!(p.proposed_title, "Asa Branca");
    assert_eq!(p.proposed_artist.as_deref(), Some("Luiz Gonzaga"));
}

/// A ordem das fontes de letra: LRCLIB (que confere pela DURAÇÃO) e depois
/// lyrics.ovh (que não tem duração e por isso é mais rígida e tem teto MÉDIA).
#[test]
fn a_ordem_e_lrclib_e_depois_lyrics_ovh() {
    let (_dir, conn, _f) = setup_with(&[("sem_letra.mp3", "sem_letra.mp3")]);
    com_tags(&conn, "sem_letra.mp3", "Asa Branca", "Luiz Gonzaga");

    let urls = RefCell::new(Vec::new());
    enrich::enrich_scan(
        &conn,
        "",
        // nenhuma das três acha nada: assim as três são consultadas
        fontes_de_letra(&urls, "[]".into(), "{}".into()),
        ZERO,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap();

    let vistas = urls.borrow().clone();
    let posicao = |agulha: &str| vistas.iter().position(|u| u.contains(agulha));
    let lrclib = posicao("lrclib.net").expect("o LRCLIB foi consultado");
    let ovh = posicao("api.lyrics.ovh").expect("o lyrics.ovh foi consultado");
    assert!(
        lrclib < ovh,
        "o LRCLIB vem primeiro: ele confere pela DURAÇÃO, e a etapa 4 não tem \
         duração para conferir nada ({vistas:?})"
    );
    // e são só DUAS fontes de letra: nenhuma terceira apareceu
    assert!(
        vistas.iter().all(|u| u.contains("lrclib.net") || u.contains("api.lyrics.ovh")),
        "destino inesperado: {vistas:?}"
    );
}

/// Achou no lyrics.ovh: o Vagalume nem é consultado. O funil só passa adiante
/// o que a etapa anterior não resolveu.
#[test]
fn achando_no_ovh_a_transcricao_nao_e_cobrada() {
    let (_dir, conn, _f) = setup_with(&[("sem_letra.mp3", "sem_letra.mp3")]);
    com_tags(&conn, "sem_letra.mp3", "Asa Branca", "Luiz Gonzaga");

    let urls = RefCell::new(Vec::new());
    let props = enrich::enrich_scan(
        &conn,
        "",
        fontes_de_letra(&urls, "[]".into(), r#"{"lyrics": "a letra que o ovh tem"}"#.into()),
        ZERO,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap()
    .propostas;

    assert_eq!(props[0].fonte, enrich::FONTE_LYRICS_OVH);
    assert!(props[0].lyrics.is_some(), "e a letra vem na proposta");
}

/// **O lyrics.ovh cai com frequência, e a queda dele é erro de UMA MÚSICA.**
///
/// A etapa NÃO se desliga: desligar no primeiro soluço deixaria as outras 149
/// músicas com a aparência de conferidas (a mesma correção do QA A2 no
/// `fpcalc`). Cada arquivo tem a sua chance, e a linha de cada um diz o que
/// aconteceu com ele.
#[test]
fn a_queda_do_ovh_e_erro_de_uma_musica_e_nao_desliga_a_etapa() {
    let (_dir, conn, _f) = setup_with(&[
        ("sem_letra.mp3", "a.mp3"),
        ("sem_letra.mp3", "b.mp3"),
    ]);
    for nome in ["a.mp3", "b.mp3"] {
        com_tags(&conn, nome, "Asa Branca", "Luiz Gonzaga");
    }

    let urls = RefCell::new(Vec::new());
    let props = enrich::enrich_scan(
        &conn,
        "",
        |url: &str| {
            urls.borrow_mut().push(url.to_string());
            if url.starts_with(lyrics_ovh::SEARCH_URL) {
                Err(AppError(lyrics_ovh::ERRO_FORA_DO_AR.into()))
            } else {
                Ok("[]".to_string())
            }
        },
        ZERO,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap()
    .propostas;

    // as DUAS foram tentadas: a falha da primeira não desligou a etapa
    assert_eq!(urls_de(&urls, "api.lyrics.ovh").len(), 2);
    assert_eq!(props.len(), 2);
    for p in &props {
        assert_eq!(
            p.error.as_deref(),
            Some(lyrics_ovh::ERRO_FORA_DO_AR),
            "cada linha diz o que aconteceu com ela"
        );
        assert!(p.lyrics.is_none(), "erro nunca traz letra");
    }
}

/// Quando ninguém acha letra, a queda do lyrics.ovh VIRA a linha de erro
/// daquela música — a pessoa precisa saber que a busca foi tentada e falhou.
#[test]
fn quando_ninguem_acha_a_queda_do_ovh_aparece_na_linha() {
    let (_dir, conn, _f) = setup_with(&[("sem_letra.mp3", "sem_letra.mp3")]);
    com_tags(&conn, "sem_letra.mp3", "Asa Branca", "Luiz Gonzaga");

    let props = enrich::enrich_scan(
        &conn,
        "",
        |url: &str| {
            if url.starts_with(lyrics_ovh::SEARCH_URL) {
                Err(AppError(lyrics_ovh::ERRO_FORA_DO_AR.into()))
            } else {
                Ok("[]".to_string())
            }
        },
        ZERO,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap()
    .propostas;
    assert_eq!(
        props[0].error.as_deref(),
        Some(lyrics_ovh::ERRO_FORA_DO_AR)
    );
    assert_eq!(props[0].fonte, enrich::FONTE_ERRO);
}

/// Aplicar a letra do lyrics.ovh grava a procedência certa em
/// `TXXX:LETRA_ORIGEM` — o dado viaja no MP3, e as duas pilhas precisam falar
/// a mesma língua (DECISIONS #82).
#[test]
fn aplicar_a_letra_do_ovh_grava_a_procedencia() {
    let (_dir, conn, _f) = setup_with(&[("sem_letra.mp3", "sem_letra.mp3")]);
    let song = com_tags(&conn, "sem_letra.mp3", "Asa Branca", "Luiz Gonzaga");
    let urls = RefCell::new(Vec::new());
    let props = enrich::enrich_scan(
        &conn,
        "",
        fontes_de_letra(&urls, "[]".into(), r#"{"lyrics": "a letra sem cadastro"}"#.into()),
        ZERO,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap()
    .propostas;
    let p = &props[0];

    let res = enrich::apply(
        &conn,
        &[EnrichApply {
            song_id: song.id,
            title: p.proposed_title.clone(),
            artist: p.proposed_artist.clone(),
            lyrics: p.lyrics.clone(),
            add_temas: None,
            current_title: p.current_title.clone(),
            current_artist: p.current_artist.clone(),
            fonte: Some(p.fonte.clone()),
            substituir_letra: false,
            marcar_instrumental: false,
        }],
    )
    .unwrap();
    assert!(res[0].error.is_none(), "{:?}", res[0].error);
    let depois = song_by_suffix(&conn, "sem_letra.mp3");
    assert_eq!(
        depois.letra_origem.as_deref(),
        Some("lyrics.ovh"),
        "e NÃO \"vagalume\" nem \"transcricao\""
    );
}

/// A música que ganhou letra do lyrics.ovh não sobra para a etapa 6: a
/// pergunta do fim não pode cobrar horas de CPU por um trabalho já feito.
#[test]
fn quem_ganhou_letra_no_ovh_nao_sobra_para_a_transcricao() {
    let (_dir, conn, _f) = setup_with(&[("sem_letra.mp3", "sem_letra.mp3")]);
    com_tags(&conn, "sem_letra.mp3", "Asa Branca", "Luiz Gonzaga");
    let urls = RefCell::new(Vec::new());
    let r = enrich::enrich_scan(
        &conn,
        "",
        fontes_de_letra(&urls, "[]".into(), r#"{"lyrics": "a letra sem cadastro"}"#.into()),
        ZERO,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap();
    assert!(r.propostas[0].lyrics.is_some());
    assert!(r.sem_letra_no_fim.is_empty());
}

/// **A ressalva da etapa 4 chega à TELA, e nunca sai vazia.**
///
/// O módulo documenta que esta fonte não devolve título nem artista — não há
/// segundo lado a conferir, e o programa não tem como saber se a letra é mesmo
/// desta música. Escrever isso no cabeçalho e não dizer a quem vai clicar não
/// protege ninguém: o teto MÉDIA tira a pré-marcação, mas só protege alguém
/// que saiba POR QUÊ. Numa revisão de 53 músicas o dono do produto disse que
/// não leu as linhas de baixa confiança — "não deu vontade de ler mesmo".
///
/// Este teste é a guarda contra a próxima refatoração apagar a ressalva sem
/// ninguém notar: **toda** proposta desta fonte carrega o aviso, nos dois
/// caminhos por onde o nome consultado pode chegar (a etiqueta e o som).
#[test]
fn toda_proposta_da_etapa_4_carrega_a_ressalva_de_que_nada_foi_conferido() {
    // caminho 1: o nome vem da ETIQUETA
    let (_dir, conn, _f) = setup_with(&[("sem_letra.mp3", "sem_letra.mp3")]);
    com_tags(&conn, "sem_letra.mp3", "Asa Branca", "Luiz Gonzaga");
    let urls = RefCell::new(Vec::new());
    let props = enrich::enrich_scan(
        &conn,
        "",
        fontes_de_letra(&urls, "[]".into(), corpo_ovh("a letra sem cadastro")),
        ZERO,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap()
    .propostas;

    // caminho 2: o nome vem do SOM
    let (_dir2, conn2, _f2) = setup_with(&[("sem_tags.mp3", "Falamansa - Oh! Chuva.mp3")]);
    let song2 = song_by_suffix(&conn2, "Oh! Chuva.mp3");
    let dur = song2.duration_seconds.unwrap() as f64;
    let urls2 = RefCell::new(Vec::new());
    let props2 = scan_com(
        &conn2,
        ComSom::nova(
            roteador(
                &urls2,
                &acoustid(0.95, "Oh! Chuva", "Falamansa", dur),
                "[]",
                &corpo_ovh("a letra sem cadastro"),
            ),
            dur,
        ),
    );

    let mut vistas = 0;
    for p in props.iter().chain(props2.iter()) {
        if p.fonte != enrich::FONTE_LYRICS_OVH {
            continue;
        }
        vistas += 1;
        let aviso = p.aviso.as_deref().unwrap_or_default();
        assert!(!aviso.trim().is_empty(), "proposta sem ressalva: {p:?}");
        assert_eq!(aviso, lyrics_ovh::AVISO_SEM_CONFERENCIA);
        // e ela vive no `aviso`, não no `error`: a linha PODE ser aplicada
        assert!(p.error.is_none(), "a ressalva não desabilita a linha");
        assert_eq!(p.confidence, "media", "e continua sem pré-marcação");
    }
    assert_eq!(vistas, 2, "os dois caminhos produziram proposta da etapa 4");
}

/// ...e a ressalva **não polui as outras linhas**. O LRCLIB confere pela
/// DURAÇÃO e o som tem a régua do AcoustID: pôr a mesma ressalva neles
/// ensinaria a ignorá-la em todos.
#[test]
fn a_ressalva_da_etapa_4_nao_aparece_nas_outras_fontes() {
    let (_dir, conn, _f) = setup_with(&[("sem_tags.mp3", "Falamansa - Oh! Chuva.mp3")]);
    let song = song_by_suffix(&conn, "Oh! Chuva.mp3");
    let dur = song.duration_seconds.unwrap() as f64;

    // LRCLIB acha (confere pela duração): sem ressalva
    let corpo = format!(
        r#"[{{"trackName":"Oh! Chuva","artistName":"Falamansa",
             "duration":{dur},"plainLyrics":"Chove lá fora"}}]"#
    );
    let props = scan_props(&conn, "", move |_url: &str| Ok(corpo.clone()));
    let p = &props[0];
    assert_eq!(p.fonte, enrich::FONTE_LRCLIB);
    assert_eq!(p.aviso, None, "o LRCLIB confere pela duração");

    // o SOM identifica (régua do AcoustID): sem ressalva
    let urls = RefCell::new(Vec::new());
    let props = scan_com(
        &conn,
        ComSom::nova(
            roteador(&urls, &acoustid(0.95, "Oh! Chuva", "Falamansa", dur), "[]", "{}"),
            dur,
        ),
    );
    let p = props.iter().find(|p| p.song_id == song.id).expect("proposta");
    assert_eq!(p.fonte, enrich::FONTE_IMPRESSAO_DIGITAL);
    assert_eq!(p.aviso, None, "o som tem a régua do AcoustID");
}

// ===========================================================================
// QA A2 — a etapa 5 não propõe NOME, e agora o teste diz a verdade
// ===========================================================================

/// **O teste que faltava.** `a_transcricao_propoe_letra_e_nunca_encosta_na
/// _etiqueta` passava por usar música com etiqueta REAL: nesse caso o palpite
/// da etapa 1 empata com a etiqueta e a linha sai igual. A música TÍPICA da
/// etapa 5 é a outra — CD ripado, "AudioTrack 03", sem artista —, e nela o
/// Rust propunha "Oh! Chuva" / "Falamansa" sob o rótulo da transcrição, num
/// módulo cujo comentário jura que "não há nome vindo daqui".
///
/// Nada era destruído: o palpite preserva etiqueta escrita. O defeito era o
/// rótulo — preenchimento de branco vindo do nome do arquivo, anunciado como
/// letra escrita ouvindo o áudio. E era redundante: a etapa 1 roda em TODAS as
/// músicas da pasta na MESMA varredura que produziu esta lista, então esse
/// palpite já foi entregue, já está na revisão, e repeti-lo aqui só cobra uma
/// segunda leitura de quem vai conferir 47 letras.
#[test]
fn a_etapa_5_nao_propoe_nome_nem_quando_o_campo_esta_em_branco() {
    let (_dir, conn, _f) = setup_with(&[("sem_letra.mp3", "Falamansa - Oh! Chuva.mp3")]);
    let song = song_by_suffix(&conn, "Oh! Chuva.mp3");
    // a etiqueta do CD ripado: placeholder no título, nada no artista
    writer::write_tags(&conn, song.id, "AudioTrack 03", None, None, None, None).unwrap();
    let song = song_by_suffix(&conn, "Oh! Chuva.mp3");
    assert_eq!(song.title, "AudioTrack 03");
    assert_eq!(song.artist, None);

    let r = transcrever(&conn, &[song.id], motor("uma letra bem comprida aqui", 120.0));
    let p = &r.propostas[0];
    assert_eq!(
        p.proposed_title, "AudioTrack 03",
        "a etapa 5 ecoa o que está no arquivo; quem propõe nome é a etapa 1"
    );
    assert_eq!(p.proposed_artist, None, "e muito menos inventa um artista");
    assert!(!p.substitui_nome_escrito);

    // e o mesmo arquivo, pela etapa 1, CONTINUA propondo o nome: o valor não
    // se perdeu, ele só voltou para a linha que o anuncia
    let props = scan_props(&conn, "", |_url: &str| Ok("[]".to_string()));
    let etapa1 = props
        .iter()
        .find(|p| p.file_path.ends_with("Oh! Chuva.mp3"))
        .expect("a etapa 1 propõe o nome do arquivo");
    assert_eq!(etapa1.proposed_title, "Oh! Chuva");
    assert_eq!(etapa1.proposed_artist.as_deref(), Some("Falamansa"));
    assert_eq!(etapa1.fonte, enrich::FONTE_NOME_ARQUIVO, "e o rótulo diz de onde veio");
}

/// A marca de instrumental também não vem acompanhada de nome. Era o pior
/// caso: `marcar_instrumental=true` com um título e um artista novos na mesma
/// linha, sob a fonte "transcrição".
#[test]
fn a_proposta_de_instrumental_tambem_nao_carrega_nome() {
    let (_dir, conn, _f) = setup_with(&[("sem_letra.mp3", "Falamansa - Oh! Chuva.mp3")]);
    let song = song_by_suffix(&conn, "Oh! Chuva.mp3");
    writer::write_tags(&conn, song.id, "AudioTrack 03", None, None, None, None).unwrap();
    let song = song_by_suffix(&conn, "Oh! Chuva.mp3");

    let p = &transcrever(&conn, &[song.id], motor("", 300.0)).propostas[0];
    assert!(p.marcar_instrumental);
    assert_eq!(p.proposed_title, "AudioTrack 03");
    assert_eq!(p.proposed_artist, None);
}

// ===========================================================================
// QA M3 — a pergunta do fim só conta quem a etapa 5 consegue transcrever
// ===========================================================================

/// Música cujo MP3 sumiu do disco não entra em `sem_letra_no_fim`.
///
/// Ela inflava a contagem e o tempo ("sobraram 47 músicas… cerca de 3 horas"),
/// e depois gastava uma vaga da fila para produzir a única coisa que a etapa 5
/// consegue fazer com um arquivo ausente: uma linha de erro.
#[test]
fn a_musica_que_sumiu_do_disco_nao_entra_na_pergunta_do_fim() {
    let (dir, conn, _f) = setup_with(&[
        ("sem_letra.mp3", "fica.mp3"),
        ("sem_letra.mp3", "some.mp3"),
    ]);
    let fica = song_by_suffix(&conn, "fica.mp3");
    let some = song_by_suffix(&conn, "some.mp3");
    fs::remove_file(dir.path().join("some.mp3")).unwrap();

    let r = enrich::enrich_scan(
        &conn,
        "",
        |_url: &str| Ok("[]".to_string()),
        ZERO,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap();

    assert_eq!(r.sem_letra_no_fim, vec![fica.id]);
    assert!(
        !r.sem_letra_no_fim.contains(&some.id),
        "arquivo ausente não é trabalho da etapa 5, é linha de erro"
    );
    assert!(r.segundos_de_transcricao > 0, "e a estimativa conta só quem sobrou");
}

/// **Erro de REDE continua contando.** A etapa 5 não usa rede: a música que
/// ficou sem letra porque o LRCLIB não respondeu é exatamente a que a
/// transcrição resolve, e tirá-la da conta seria esconder o trabalho que o
/// produto sabe fazer.
#[test]
fn erro_de_rede_nao_tira_a_musica_da_pergunta_do_fim() {
    let (_dir, conn, _f) = setup_with(&[("sem_letra.mp3", "sem_letra.mp3")]);
    let song = song_by_suffix(&conn, "sem_letra.mp3");
    writer::write_tags(&conn, song.id, "Cantiga", Some("Dona Zica"), None, None, None).unwrap();

    let r = enrich::enrich_scan(
        &conn,
        "",
        |_url: &str| Err(AppError("sem conexão".into())),
        ZERO,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap();
    assert_eq!(r.sem_letra_no_fim, vec![song.id]);
}

// ===========================================================================
// QA A1 — a razão MEDIDA volta e passa a valer, sem passar pelo frontend
// ===========================================================================

/// **A promessa da DECISIONS #106, agora executável.** Ela dizia: "a primeira
/// transcrição desta máquina devolve a razão real, e é ela que passa a valer".
/// O número era calculado, serializado, tipado e testado — e não tinha
/// consumidor nenhum no repositório: a estimativa da tela usava sempre a
/// constante declarada de 1,0.
#[test]
fn a_razao_medida_e_guardada_pelo_backend_e_manda_na_estimativa_seguinte() {
    let (_dir, conn, _f) = setup_with(&[("sem_letra.mp3", "sem_letra.mp3")]);
    let song = song_by_suffix(&conn, "sem_letra.mp3");
    // uma canção de 4 minutos, para a amostra passar do piso
    conn.execute("UPDATE songs SET duration_seconds = 240 WHERE id = ?1", [song.id])
        .unwrap();

    // antes de qualquer transcrição: a estimativa é a DECLARADA
    let antes = enrich::enrich_scan(
        &conn,
        "",
        |_url: &str| Ok("[]".to_string()),
        ZERO,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap();
    assert_eq!(
        antes.segundos_de_transcricao,
        (240.0 * transcricao::RAZAO_DE_REFERENCIA_DO_GRANDE).ceil() as u64,
        "240 s de áudio pela razão de REFERÊNCIA do modelo que roda aqui"
    );

    // uma execução da etapa 5 que gasta bem mais relógio do que áudio — é o
    // caso real: máquina modesta, whisper.cpp sem Metal e sem Accelerate
    let r = enrich::transcricao_scan(
        &conn,
        transcricao::modelo_oferecido(),
        &[song.id],
        motor_lento("uma letra bem comprida", 600.0, Duration::from_millis(60)),
        SEM_PROGRESSO_5,
        SEM_CANCELAMENTO,
    )
    .unwrap();
    assert!(r.razao_medida.is_some());
    assert!(
        r.razao_desta_maquina > 0.0,
        "e o resultado diz qual razão passa a valer daqui em diante"
    );

    // e a varredura SEGUINTE já usa a razão medida, sem o frontend guardar
    // nem reenviar nada
    let depois = enrich::enrich_scan(
        &conn,
        "",
        |_url: &str| Ok("[]".to_string()),
        ZERO,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap();
    assert_ne!(
        depois.segundos_de_transcricao, antes.segundos_de_transcricao,
        "a medição desta máquina passou a valer"
    );
    let esperado = (240.0 * r.razao_desta_maquina).ceil() as u64;
    assert_eq!(depois.segundos_de_transcricao, esperado);

    // e a tela sabe QUAL dos dois números está mostrando: sem este fato, a
    // frase honesta é sempre a pior das duas (DECISIONS #86)
    assert!(!antes.estimativa_medida_nesta_maquina, "antes era de fábrica");
    assert!(
        depois.estimativa_medida_nesta_maquina,
        "e agora é medição desta máquina — é o que autoriza o \"neste computador\""
    );
}

/// **Amostra curta não vira estimativa.** É a mesma regra do
/// `segundos_restantes` do download (DECISIONS #106): número medido sobre
/// amostra minúscula é pior que número declarado, porque parece mais
/// verdadeiro. Uma faixa de 30 s numa máquina que estava compilando outra
/// coisa não manda na estimativa de um acervo inteiro.
#[test]
fn amostra_curta_demais_nao_troca_a_estimativa_declarada() {
    let (_dir, conn, _f) = setup_with(&[("sem_letra.mp3", "sem_letra.mp3")]);
    let song = song_by_suffix(&conn, "sem_letra.mp3");
    conn.execute("UPDATE songs SET duration_seconds = 240 WHERE id = ?1", [song.id])
        .unwrap();

    // 30 s de áudio: muito abaixo do piso de 300 s
    let r = enrich::transcricao_scan(
        &conn,
        transcricao::modelo_oferecido(),
        &[song.id],
        motor_lento("uma letra bem comprida", 30.0, Duration::from_millis(60)),
        SEM_PROGRESSO_5,
        SEM_CANCELAMENTO,
    )
    .unwrap();
    assert!(r.razao_medida.is_some(), "a execução mediu");
    assert_eq!(
        r.razao_desta_maquina,
        transcricao::RAZAO_DE_REFERENCIA_DO_GRANDE,
        "mas a amostra ainda não vale: continua a de referência"
    );

    let depois = enrich::enrich_scan(
        &conn,
        "",
        |_url: &str| Ok("[]".to_string()),
        ZERO,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap();
    assert_eq!(
        depois.segundos_de_transcricao,
        (240.0 * transcricao::RAZAO_DE_REFERENCIA_DO_GRANDE).ceil() as u64
    );
    assert!(
        !depois.estimativa_medida_nesta_maquina,
        "e a tela continua com a ressalva, porque o número ainda é de fábrica"
    );
}

// ===========================================================================
// V10.2 — a estimativa segue O MODELO, e não só a máquina
// ===========================================================================

/// Fontes de funil que declaram QUAL modelo esta máquina usaria. É o único
/// jeito de a suíte alcançar o caminho da máquina que baixou o `medium`: os
/// arquivos reais têm 1,7 GB e a soma é conferida contra o catálogo.
struct ComModelo(&'static transcricao::Modelo);

impl enrich::Fontes for ComModelo {
    fn buscar(&self, _url: &str) -> Result<String, AppError> {
        Ok("[]".to_string())
    }
    fn modelo_da_transcricao(&self) -> &'static transcricao::Modelo {
        self.0
    }
}

/// **A razão de fábrica é a DO MODELO que roda aqui.**
///
/// *Mudou de propósito, e não por acidente (V10.5).* Ele comparava as duas
/// estimativas de fábrica da mesma pasta, uma por modelo baixado — a
/// convivência dos dois acabou com a medição no acervo real. O que ele fixa
/// agora é que a estimativa que a pergunta do fim mostra sai da razão do modelo
/// que a máquina realmente vai usar (3,0), e não do 1,0 que era do `small`:
/// prometer 3 horas para um trabalho de 9 é a DECISIONS #85 por uma porta nova.
#[test]
fn a_estimativa_de_fabrica_e_a_do_modelo_que_roda_aqui() {
    let (_dir, conn, _f) = setup_with(&[("sem_letra.mp3", "sem_letra.mp3")]);
    let song = song_by_suffix(&conn, "sem_letra.mp3");
    conn.execute("UPDATE songs SET duration_seconds = 240 WHERE id = ?1", [song.id])
        .unwrap();

    let estimar = |modelo| {
        enrich::enrich_scan(&conn, "", ComModelo(modelo), ZERO, SEM_PROGRESSO, SEM_CANCELAMENTO)
            .unwrap()
    };
    let oferecido = estimar(transcricao::modelo_oferecido());
    assert_eq!(
        transcricao::modelo_oferecido().nome,
        transcricao::MODELOS[0].nome,
        "com um modelo só, o oferecido e o preferido são o mesmo"
    );
    assert_eq!(
        oferecido.segundos_de_transcricao,
        (240.0 * transcricao::RAZAO_DE_REFERENCIA_DO_GRANDE).ceil() as u64,
        "o modelo que entende melhor custa mais, e a tela diz isso ANTES"
    );
    assert!(!oferecido.estimativa_medida_nesta_maquina, "é de fábrica");
}

/// **A medição do modelo que SAIU não move a estimativa do que ficou.**
///
/// *Mudou de propósito, e não por acidente (V10.5).* Ele media com um dos dois
/// modelos e conferia que o outro não se mexia. Agora ele descreve a máquina de
/// quem usou a v0.10.x: a linha do `ggml-small-q5_1.bin` continua no banco e
/// **não é lida por ninguém** — é lixo inofensivo, e é assim que fica.
///
/// Reetiquetá-la para o modelo atual seria afirmar que uma medição feita com um
/// motor vale para outro (DECISIONS #72), com erro de fator ~3 para MENOS na
/// única frase que diz quanto tempo o trabalho leva. Apagá-la seria o programa
/// mexendo por conta própria em dado que já existe.
#[test]
fn a_medicao_do_modelo_que_saiu_nao_move_a_estimativa_do_que_ficou() {
    let (_dir, conn, _f) = setup_with(&[("sem_letra.mp3", "sem_letra.mp3")]);
    let song = song_by_suffix(&conn, "sem_letra.mp3");
    conn.execute("UPDATE songs SET duration_seconds = 240 WHERE id = ?1", [song.id])
        .unwrap();

    // como a v0.10.x deixou esta máquina: uma noite inteira medida com o
    // `small`, sob a chave DELE
    let chave_do_pequeno = format!("{}:ggml-small-q5_1.bin", db::MEDICAO_TRANSCRICAO);
    db::somar_medicao(&conn, &chave_do_pequeno, 6000.0, 3000.0).unwrap();

    let estimativa = enrich::enrich_scan(
        &conn,
        "",
        ComModelo(transcricao::MODELOS[0]),
        ZERO,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap();
    assert!(
        !estimativa.estimativa_medida_nesta_maquina,
        "para o modelo que ficou, a estimativa continua sendo de fábrica — \
         ninguém o mediu aqui"
    );
    assert_eq!(
        estimativa.segundos_de_transcricao,
        (240.0 * transcricao::RAZAO_DE_REFERENCIA_DO_GRANDE).ceil() as u64,
        "a medição do modelo que saiu NÃO vaza para o número do que ficou"
    );

    // e medir COM o modelo atual passa a valer, na chave dele
    let r = enrich::transcricao_scan(
        &conn,
        transcricao::MODELOS[0],
        &[song.id],
        motor_lento("uma letra bem comprida", 600.0, Duration::from_millis(60)),
        SEM_PROGRESSO_5,
        SEM_CANCELAMENTO,
    )
    .unwrap();
    assert!(r.razao_medida.is_some());
    let depois = enrich::enrich_scan(
        &conn,
        "",
        ComModelo(transcricao::MODELOS[0]),
        ZERO,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap();
    assert!(depois.estimativa_medida_nesta_maquina);
}

/// A medição ACUMULA entre execuções, e é por isso que ela é guardada como
/// dois somatórios e não como uma razão pronta: uma música de 30 s no fim do
/// dia não pode mandar na estimativa de um acervo de 150.
#[test]
fn a_medicao_acumula_entre_execucoes() {
    let (_dir, conn, _f) = setup_with(&[("sem_letra.mp3", "sem_letra.mp3")]);
    let song = song_by_suffix(&conn, "sem_letra.mp3");

    for _ in 0..3 {
        enrich::transcricao_scan(
            &conn,
            transcricao::modelo_oferecido(),
            &[song.id],
            motor_lento("uma letra bem comprida", 200.0, Duration::from_millis(40)),
            SEM_PROGRESSO_5,
            SEM_CANCELAMENTO,
        )
        .unwrap();
    }
    // V10.2 — a chave é a DO MODELO, e não mais a genérica: a soma de um
    // modelo três vezes mais lento com a de outro não descreve nenhum dos dois.
    let modelo = transcricao::modelo_oferecido();
    let razao = db::razao_medida(&conn, &modelo.chave_de_medicao(), 300.0)
        .unwrap()
        .expect("600 s acumulados passam do piso");
    assert!(razao > 0.0);
    assert_eq!(
        db::razao_medida(&conn, db::MEDICAO_TRANSCRICAO, 300.0).unwrap(),
        None,
        "nada é guardado sob a chave sem modelo — ela é só o prefixo"
    );
}

// ===========================================================================
// QA B4 — disco cheio é veredito sobre a máquina, não sobre 47 músicas
// ===========================================================================

/// O `ERRO_TEMPORARIO` (pasta de trabalho que não aceita escrita — na prática,
/// disco cheio) desliga a etapa pelo resto da fila, como o binário que não
/// sobe já fazia. Sem isto, um disco cheio produzia 47 linhas idênticas
/// culpando 47 músicas inocentes, e 47 tentativas de escrever um WAV que não
/// cabe.
#[test]
fn disco_cheio_desliga_a_fila_em_vez_de_acusar_cada_musica() {
    let (_dir, conn, _f) = setup_with(&[
        ("sem_letra.mp3", "a.mp3"),
        ("sem_letra.mp3", "b.mp3"),
        ("sem_letra.mp3", "c.mp3"),
    ]);
    let ids: Vec<i64> = ["a.mp3", "b.mp3", "c.mp3"]
        .iter()
        .map(|n| song_by_suffix(&conn, n).id)
        .collect();

    let tentativas = std::cell::Cell::new(0usize);
    let r = enrich::transcricao_scan(
        &conn,
        transcricao::modelo_oferecido(),
        &ids,
        |_mp3: &Path, _c: &dyn Fn() -> bool, _p: &dyn Fn(u8)| {
            tentativas.set(tentativas.get() + 1);
            Err(AppError(transcricao::ERRO_TEMPORARIO.into()))
        },
        SEM_PROGRESSO_5,
        SEM_CANCELAMENTO,
    )
    .unwrap();

    assert_eq!(tentativas.get(), 1, "o disco cheio foi descoberto UMA vez");
    assert_eq!(r.propostas.len(), 3, "e as três músicas continuam com a sua linha");
    for p in &r.propostas {
        assert_eq!(
            p.error.as_deref(),
            Some(transcricao::ERRO_TEMPORARIO),
            "e a frase é a VERDADEIRA — disco cheio não acusa o programa de não executar"
        );
    }
}

// ===========================================================================
// A regra de COLETÂNEA vale por SLOT — emenda à DECISIONS #105
// ===========================================================================

/// **`Diversos` no TÍTULO é um título, e a pessoa o vê todo dia.**
///
/// A #105 argumentou "rótulos que NENHUMA canção usa como nome" pensando no
/// campo do ARTISTA — que é onde o ripador escreve "Various Artists". Só que a
/// regra entrou no `is_placeholder`, que roda nos dois campos. Consequência:
/// uma música intitulada "Diversos" passava a valer VAZIO, o palpite do nome
/// do arquivo entrava por cima, `substitui_nome_escrito` saía `false` — sem o
/// aviso de troca, sem ficar fora da pré-marcação — e a linha caía no grupo
/// dobrado dos preenchimentos, pré-marcada, sob a frase "N músicas SEM TÍTULO
/// OU ARTISTA vão receber o nome que está no arquivo".
///
/// Para essa música a frase é FALSA, e é ela que sustenta a pré-marcação do
/// grupo: um clique em "Aplicar selecionadas" levava embora um título que a
/// revisão nunca mostrou. É o pior modo de falha do projeto (DECISIONS #65 e
/// #89), pela porta que a #105 abriu.
#[test]
fn rotulo_de_coletanea_no_titulo_continua_sendo_titulo() {
    for texto in ["Diversos", "Vários", "Varias", "Coletânea", "Various", "VA"] {
        assert!(
            !enrich::is_placeholder(enrich::Campo::Titulo, texto),
            "{texto:?} como TÍTULO é o nome que alguém vê na biblioteca"
        );
    }
}

/// E o inverso — a lição da DECISIONS #89, que é o que limita toda mudança
/// nesta lista: ao restringir, o caso que a #105 existe para resolver tem de
/// continuar resolvido.
#[test]
fn rotulo_de_coletanea_no_artista_continua_valendo_vazio() {
    for texto in [
        "Various Artists",
        "[Various Artists]",
        "V.A.",
        "VA",
        "Vários",
        "Diversos",
        "Coletânea",
        "compilation",
    ] {
        assert!(
            enrich::is_placeholder(enrich::Campo::Artista, texto),
            "{texto:?} como ARTISTA é rótulo de ripador, não gente"
        );
    }
    // "Vá" é o verbo, e o `norm` tira o acento: as duas chegariam à mesma
    // chave. Nos DOIS campos ele sobrevive.
    assert!(!enrich::is_placeholder(enrich::Campo::Artista, "Vá"));
    assert!(!enrich::is_placeholder(enrich::Campo::Titulo, "Vá"));
    // e nenhum nome real de uma palavra caiu em outra regra ao restringir
    for texto in ["Vai", "Vamos", "Valsa", "Variações", "Compilado", "Artista", "Pista"] {
        assert!(!enrich::is_placeholder(enrich::Campo::Artista, texto), "{texto:?}");
        assert!(!enrich::is_placeholder(enrich::Campo::Titulo, texto), "{texto:?}");
    }
}

/// Ponta a ponta: a música com título "Diversos" e artista "Various Artists"
/// tem o ARTISTA preenchido e o TÍTULO preservado — e a proposta que trocaria
/// o título aparece como TROCA, nunca como preenchimento de branco.
#[test]
fn titulo_diversos_sobrevive_a_varredura_e_o_artista_lixo_e_preenchido() {
    let (_dir, conn, _f) = setup_with(&[("sem_letra.mp3", "Falamansa - Oh! Chuva.mp3")]);
    let song = song_by_suffix(&conn, "Oh! Chuva.mp3");
    writer::write_tags(
        &conn,
        song.id,
        "Diversos",
        Some("Various Artists"),
        None,
        None,
        None,
    )
    .unwrap();

    let props = scan_props(&conn, "", |_url: &str| Ok("[]".to_string()));
    let p = props
        .iter()
        .find(|p| p.file_path.ends_with("Oh! Chuva.mp3"))
        .expect("a música entra na varredura");
    assert_eq!(
        p.proposed_title, "Diversos",
        "o título escrito é preservado; a etapa 1 nunca propõe apagar"
    );
    assert_eq!(
        p.proposed_artist.as_deref(),
        Some("Falamansa"),
        "e o artista-lixo é preenchido, que é o que a #105 veio fazer"
    );
    assert!(
        !p.substitui_nome_escrito,
        "não troca nome escrito nenhum: o título fica e o artista estava vazio"
    );
}

// ===========================================================================
// V10.6 — "quais músicas estão sem letra" é FATO PERMANENTE da biblioteca,
// não resultado de varredura.
//
// O defeito de campo: a oferta de transcrição vivia só dentro da caixa de
// revisão, e a caixa fechava ao aplicar. Fechá-la jogava fora a lista das
// músicas sem letra — e recuperá-la custava a varredura inteira, que numa
// biblioteca grande são minutos.
//
// A lista nunca precisou da varredura para existir: o banco responde a
// qualquer momento. `pendentes_da_transcricao` é essa porta, e a regra que ela
// aplica é a MESMA `a_etapa_5_tem_o_que_fazer` da pergunta do fim — uma regra
// só, num lugar só (DECISIONS #80).
// ===========================================================================

/// A porta sem varredura devolve exatamente o que a varredura devolveria.
///
/// Este é o teste que impede as duas de divergirem: se alguém acrescentar um
/// portão em uma delas, os dois números param de bater e este teste falha.
#[test]
fn a_lista_de_quem_esta_sem_letra_existe_sem_varredura_nenhuma() {
    let (_dir, conn, _f) = setup_with(&[
        ("sem_tags.mp3", "Pasta/Falamansa - Oh! Chuva.mp3"), // sem letra
        ("sem_letra.mp3", "Pasta/sem_letra.mp3"),            // sem letra
        ("com_letra.mp3", "Pasta/com_letra.mp3"),            // já tem letra
        ("sem_letra.mp3", "Outra/fora.mp3"),                 // fora do prefixo
    ]);
    let raiz = song_by_suffix(&conn, "Oh! Chuva.mp3").file_path;
    let pasta = raiz.trim_end_matches("/Falamansa - Oh! Chuva.mp3").to_string();

    let sem_varredura = enrich::pendentes_da_transcricao(
        &conn,
        &pasta,
        transcricao::modelo_oferecido(),
        true,
    )
    .unwrap();

    // a varredura é a outra porta para o MESMO fato
    let varrido = enrich::enrich_scan(
        &conn,
        &pasta,
        |_url: &str| Ok("[]".to_string()),
        ZERO,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap();

    assert_eq!(
        sem_varredura.musicas, varrido.sem_letra_no_fim,
        "a mesma regra, os mesmos ids, na mesma ordem — sem gastar rede nenhuma"
    );
    assert_eq!(sem_varredura.musicas.len(), 2, "só as duas sem letra da pasta");
    assert_eq!(
        sem_varredura.segundos_estimados, varrido.segundos_de_transcricao,
        "e a MESMA estimativa: duas contas seriam duas verdades (DECISIONS #80)"
    );
    assert_eq!(
        sem_varredura.estimativa_medida_nesta_maquina,
        varrido.estimativa_medida_nesta_maquina,
        "e o mesmo fato sobre o número"
    );
    assert!(sem_varredura.disponivel, "o que a máquina pode fazer viaja junto");

    // prefixo vazio = biblioteca inteira
    let tudo =
        enrich::pendentes_da_transcricao(&conn, "", transcricao::modelo_oferecido(), false)
            .unwrap();
    assert_eq!(tudo.musicas.len(), 3);
    assert!(!tudo.disponivel);
}

/// Os portões da etapa 5 valem aqui INTEIROS, e não pela metade: instrumental
/// não é transcrito (V8/F17), música com letra não entra, e arquivo que sumiu
/// do disco não é trabalho — é linha de erro (QA M3).
#[test]
fn a_porta_sem_varredura_aplica_os_mesmos_portoes_da_etapa_5() {
    let (dir, conn, _f) = setup_with(&[
        ("sem_letra.mp3", "fica.mp3"),
        ("sem_letra.mp3", "some.mp3"),
        ("sem_letra.mp3", "instrumental.mp3"),
        ("com_letra.mp3", "com_letra.mp3"),
    ]);
    let fica = song_by_suffix(&conn, "fica.mp3");
    let instrumental = song_by_suffix(&conn, "instrumental.mp3");
    fs::remove_file(dir.path().join("some.mp3")).unwrap();
    writer::write_tags(
        &conn,
        instrumental.id,
        "Chorinho",
        Some("Regional"),
        None,
        None,
        Some(true),
    )
    .unwrap();

    let p =
        enrich::pendentes_da_transcricao(&conn, "", transcricao::modelo_oferecido(), true)
            .unwrap();
    assert_eq!(
        p.musicas,
        vec![fica.id],
        "sobrou uma: o instrumental não é transcrito, a que tem letra não entra, \
         e a que sumiu do disco não é trabalho"
    );
}

/// **A estimativa medida vale nas DUAS portas.** A DECISIONS #112 fechou o
/// laço da medição pelo backend; abrir uma segunda porta que ignorasse a
/// medição faria a mesma biblioteca ter dois tempos diferentes na mesma tela.
#[test]
fn a_porta_sem_varredura_usa_a_razao_medida_desta_maquina() {
    let (_dir, conn, _f) = setup_with(&[("sem_letra.mp3", "sem_letra.mp3")]);
    let song = song_by_suffix(&conn, "sem_letra.mp3");
    conn.execute("UPDATE songs SET duration_seconds = 240 WHERE id = ?1", [song.id])
        .unwrap();
    let modelo = transcricao::modelo_oferecido();

    let antes = enrich::pendentes_da_transcricao(&conn, "", modelo, true).unwrap();
    assert!(!antes.estimativa_medida_nesta_maquina);
    assert_eq!(
        antes.segundos_estimados,
        (240.0 * transcricao::RAZAO_DE_REFERENCIA_DO_GRANDE).ceil() as u64
    );

    enrich::transcricao_scan(
        &conn,
        modelo,
        &[song.id],
        motor_lento("uma letra bem comprida", 600.0, Duration::from_millis(60)),
        SEM_PROGRESSO_5,
        SEM_CANCELAMENTO,
    )
    .unwrap();

    let depois = enrich::pendentes_da_transcricao(&conn, "", modelo, true).unwrap();
    assert!(
        depois.estimativa_medida_nesta_maquina,
        "é o que autoriza o \"neste computador\" nesta porta também"
    );
    assert_ne!(depois.segundos_estimados, antes.segundos_estimados);
}

/// **O que difere entre as duas portas é o MOMENTO, não a regra.**
///
/// A pergunta do fim desconta quem acabou de ganhar uma proposta de letra na
/// mesma varredura: cobrar minutos de CPU por uma música cuja letra está ali na
/// lista, esperando um clique, seria cobrar caro por algo que o clique resolve.
///
/// A porta permanente não tem varredura a descontar — ela responde o fato de
/// AGORA, que é o que uma tela permanente pode afirmar. Aplicada a proposta, o
/// fato muda e as duas voltam a dizer a mesma coisa.
///
/// É a metade Rust do par que a DECISIONS #88 pede; a outra está em
/// `mockBackend.contrato.test.ts`.
#[test]
fn a_porta_permanente_responde_o_agora_e_a_pergunta_do_fim_desconta_o_que_achou() {
    let (_dir, conn, _f) = setup_with(&[("sem_letra.mp3", "sem_letra.mp3")]);
    let song = song_by_suffix(&conn, "sem_letra.mp3");
    let dur = song.duration_seconds.expect("fixture tem duração") as f64;
    let modelo = transcricao::modelo_oferecido();
    let body = format!(
        r#"[{{"trackName": "Sem Letra", "artistName": "Banda Fixture",
             "duration": {dur}, "plainLyrics": "chove chuva"}}]"#
    );

    let r = enrich::enrich_scan(
        &conn,
        "",
        |_url: &str| Ok(body.clone()),
        ZERO,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap();
    let p = r
        .propostas
        .iter()
        .find(|p| p.song_id == song.id && p.lyrics.is_some())
        .expect("a varredura achou letra para esta música");
    assert!(
        r.sem_letra_no_fim.is_empty(),
        "a pergunta do fim não cobra CPU por uma letra que está na lista"
    );

    let antes = enrich::pendentes_da_transcricao(&conn, "", modelo, true).unwrap();
    assert_eq!(
        antes.musicas,
        vec![song.id],
        "a porta permanente diz o fato de AGORA: o arquivo continua sem letra"
    );

    enrich::apply(
        &conn,
        &[EnrichApply {
            song_id: song.id,
            title: p.proposed_title.clone(),
            artist: p.proposed_artist.clone(),
            lyrics: p.lyrics.clone(),
            add_temas: None,
            current_title: p.current_title.clone(),
            current_artist: p.current_artist.clone(),
            fonte: None,
            substituir_letra: false,
            marcar_instrumental: false,
        }],
    )
    .unwrap();

    let depois = enrich::pendentes_da_transcricao(&conn, "", modelo, true).unwrap();
    assert_eq!(
        depois.musicas, r.sem_letra_no_fim,
        "aplicada a proposta, o fato mudou e as duas dizem a mesma coisa"
    );
    assert_eq!(depois.segundos_estimados, 0);
}

// ===========================================================================
// V10.9 — a etapa 5 na porta de UMA música.
//
// O funil individual do editor (`enrich_scan_song`) roda as etapas 1 a 4 e para
// ali. A etapa 5 custa minutos e vive em comando próprio, e por isso não
// entrava — mas com 3% de cobertura medida, "as quatro etapas não acharam
// nada" é o desfecho TÍPICO daquele clique, e a única coisa que resolveria
// aquela música ficava a duas telas de distância, numa fila que é a pasta
// inteira.
//
// A porta nova é a `pendentes_da_transcricao` num escopo diferente: MESMO
// struct, MESMO predicado (`a_etapa_5_tem_o_que_fazer`) e MESMA estimativa
// (`transcricao::estimativa_da_transcricao`). Uma segunda conta daria dois
// tempos para a mesma música na mesma tela, e ninguém saberia qual acreditar
// (DECISIONS #80).
// ===========================================================================

/// A porta de uma música devolve a linha DELA, e o mesmo número que a porta da
/// pasta daria para ela sozinha.
///
/// Este é o teste que impede as duas de divergirem: um portão a mais em uma
/// delas, ou uma segunda conta de tempo, e os números param de bater.
#[test]
fn a_porta_de_uma_musica_diz_o_mesmo_que_a_porta_da_pasta_diria_dela() {
    let (_dir, conn, _f) = setup_with(&[
        ("sem_letra.mp3", "Pasta/sem_letra.mp3"),
        ("sem_tags.mp3", "Pasta/Falamansa - Oh! Chuva.mp3"),
    ]);
    let alvo = song_by_suffix(&conn, "sem_letra.mp3");
    let modelo = transcricao::modelo_oferecido();

    let uma =
        enrich::pendentes_da_transcricao_da_musica(&conn, alvo.id, modelo, true).unwrap();
    assert_eq!(
        uma.musicas,
        vec![alvo.id],
        "a fila é de um item, e é o que o `transcrever_musicas` recebe"
    );
    assert!(uma.disponivel, "o que a máquina pode fazer viaja junto");

    // a mesma música, medida pela porta da pasta: a estimativa é de uma conta
    // só, e a duração é a mesma
    let duracao = alvo.duration_seconds.expect("a fixture tem duração") as f64;
    let (segundos, medida) =
        transcricao::estimativa_da_transcricao(&conn, modelo, [duracao].into_iter());
    assert_eq!(uma.segundos_estimados, segundos);
    assert_eq!(uma.estimativa_medida_nesta_maquina, medida);

    // e o total da pasta é MAIOR: a porta de uma música não é a da pasta com
    // outro nome
    let pasta =
        enrich::pendentes_da_transcricao(&conn, "", modelo, true).unwrap();
    assert_eq!(pasta.musicas.len(), 2);
    assert!(pasta.segundos_estimados > uma.segundos_estimados);
}

/// Os portões da etapa 5 valem aqui, e a ficha não reescreve nenhum deles —
/// **menos um, e é o backend que o decide, não a tela**.
///
/// V10.11: a música que já tem letra PASSA nesta porta (teste próprio, logo
/// abaixo desta seção). Instrumental e arquivo que sumiu do disco continuam
/// fora, exatamente como na porta da pasta — e é isso que este teste guarda,
/// para a exceção da letra não virar "o portão desta porta é frouxo".
#[test]
fn a_porta_de_uma_musica_aplica_os_mesmos_portoes_da_etapa_5() {
    let (dir, conn, _f) = setup_with(&[
        ("sem_letra.mp3", "fica.mp3"),
        ("sem_letra.mp3", "some.mp3"),
        ("sem_letra.mp3", "instrumental.mp3"),
        ("com_letra.mp3", "com_letra.mp3"),
    ]);
    let modelo = transcricao::modelo_oferecido();
    let fica = song_by_suffix(&conn, "fica.mp3");
    let some = song_by_suffix(&conn, "some.mp3");
    let instrumental = song_by_suffix(&conn, "instrumental.mp3");
    let com_letra = song_by_suffix(&conn, "com_letra.mp3");
    fs::remove_file(dir.path().join("some.mp3")).unwrap();
    writer::write_tags(
        &conn,
        instrumental.id,
        "Chorinho",
        Some("Regional"),
        None,
        None,
        Some(true),
    )
    .unwrap();

    let pendentes = |id: i64| {
        enrich::pendentes_da_transcricao_da_musica(&conn, id, modelo, true).unwrap()
    };

    assert_eq!(pendentes(fica.id).musicas, vec![fica.id]);
    for (id, porque) in [
        (some.id, "o arquivo sumiu do disco: não é trabalho, é linha de erro"),
        (instrumental.id, "instrumental não é transcrito (V8/F17)"),
    ] {
        let p = pendentes(id);
        assert!(p.musicas.is_empty(), "{porque}");
        assert_eq!(p.segundos_estimados, 0, "e sem fila não há tempo a anunciar");
    }
    // e o portão que esta porta NÃO tem, para a assimetria ficar num assert
    assert_eq!(
        pendentes(com_letra.id).musicas,
        vec![com_letra.id],
        "quem já tem letra entra AQUI — é o caso do relato de campo (V10.11)"
    );
}

/// Id que não existe no banco não é erro: é uma música sem nada a transcrever.
///
/// A ficha pode ter sido aberta sobre uma música que saiu do acervo entre o
/// clique e a resposta. Devolver erro faria a tela mostrar uma falha por um
/// fato normal, e num produto sem suporte uma falha inventada é pior que o
/// silêncio.
#[test]
fn id_que_nao_existe_devolve_fila_vazia_em_vez_de_erro() {
    let (_dir, conn, _f) = setup_with(&[("sem_letra.mp3", "sem_letra.mp3")]);
    let p = enrich::pendentes_da_transcricao_da_musica(
        &conn,
        999_999,
        transcricao::modelo_oferecido(),
        true,
    )
    .unwrap();
    assert!(p.musicas.is_empty());
    assert_eq!(p.segundos_estimados, 0);
    assert!(p.disponivel, "o fato sobre a MÁQUINA não depende da música");
}

// ===========================================================================
// V10.10 — "SEM CONEXÃO" MENTIA, E ESCONDIA QUE O FUNIL TINHA ABORTADO
//
// Relato de campo: o dono clicou em "Buscar dados na internet" numa música e
// leu **"sem conexão"** em vermelho, com a internet dele funcionando — ele
// tinha acabado de baixar 1,4 GB no mesmo aplicativo.
//
// Eram dois defeitos somados, e o segundo é o que dói:
//
// **(a)** o ramo de TRANSPORTE do `funil_fetcher` (DNS que não resolveu, 10 s
// esgotados, conexão recusada) dizia "sem conexão" para todo servidor mudo. Um
// servidor que não responde não é a internet da pessoa caindo, e o funil fala
// com até TRÊS hosts diferentes: se outro respondeu na mesma varredura, a
// acusação é comprovadamente falsa.
//
// **(b)** um erro qualquer na etapa 2 ABORTAVA o funil ("rede caída derruba
// todas as fontes"). O argumento vale se a rede caiu; para um servidor só sem
// responder — ou para o `fpcalc` que falha em três de cada quatro arquivos do
// acervo real — ele não vale, e as etapas 3 e 4 nunca eram consultadas. A tela
// dizia "sem conexão", e a pessoa lia "a internet não tem a letra".
// ===========================================================================

/// Um servidor mudo não impede os SEGUINTES de tentar.
///
/// É o coração do relato: o LRCLIB não respondeu, e o lyrics.ovh — outro host,
/// outro provedor — tinha a letra. Abortar aqui é jogar fora a única fonte que
/// resolveria a música.
#[test]
fn um_servidor_mudo_nao_impede_as_etapas_seguintes_de_tentar() {
    let (_dir, conn, _f) = setup_with(&[("sem_letra.mp3", "sem_letra.mp3")]);
    let props = scan_props(&conn, "", |url: &str| {
        if url.starts_with(lyrics_ovh::SEARCH_URL) {
            Ok(corpo_ovh("a letra que o outro host tinha"))
        } else {
            Err(AppError(lyrics_fetch::ERRO_SEM_RESPOSTA.into()))
        }
    });

    assert_eq!(props.len(), 1);
    assert_eq!(
        props[0].lyrics.as_deref(),
        Some("a letra que o outro host tinha"),
        "a etapa 4 tem de ter sido consultada mesmo com a etapa 3 muda"
    );
    assert!(props[0].error.is_none(), "achou letra: não há erro a mostrar");
}

/// Com outro host respondendo, a linha NOMEIA o servidor mudo e não acusa a
/// internet de quem está olhando.
#[test]
fn com_outro_host_respondendo_a_linha_nao_acusa_a_internet() {
    let (_dir, conn, _f) = setup_with(&[("sem_letra.mp3", "sem_letra.mp3")]);
    let props = scan_props(&conn, "", |url: &str| {
        if url.starts_with(lyrics_ovh::SEARCH_URL) {
            Ok(corpo_ovh("")) // respondeu, e não tinha a letra
        } else {
            Err(AppError(lyrics_fetch::ERRO_SEM_RESPOSTA.into()))
        }
    });

    let erro = props[0].error.as_deref().expect("a falha continua sendo dita");
    assert_eq!(erro, lyrics_fetch::ERRO_SEM_RESPOSTA);
    assert_ne!(erro, enrich::ERRO_SEM_CONEXAO);
    assert!(!erro.contains("internet"), "a internet dela está boa: {erro}");
}

/// Nenhum host respondeu: aí sim a frase fala da internet — e diz por que ela
/// está afirmando isso.
#[test]
fn nenhum_host_respondeu_e_so_ai_a_linha_fala_da_internet() {
    let (_dir, conn, _f) = setup_with(&[("sem_letra.mp3", "sem_letra.mp3")]);
    let props = scan_props(&conn, "", |url: &str| {
        if url.starts_with(lyrics_ovh::SEARCH_URL) {
            Err(AppError(lyrics_ovh::ERRO_SEM_RESPOSTA.into()))
        } else {
            Err(AppError(lyrics_fetch::ERRO_SEM_RESPOSTA.into()))
        }
    });

    assert_eq!(props[0].error.as_deref(), Some(enrich::ERRO_SEM_CONEXAO));
}

/// A intenção original PRESERVADA: com a rede caída de verdade, a varredura
/// para de gastar o tempo de quem está esperando.
///
/// A evidência custa as consultas de UMA música — dois hosts mudos e nenhum
/// respondendo. Da segunda música em diante não sai mais nada pela rede.
#[test]
fn com_a_rede_caida_a_segunda_musica_nao_gasta_mais_consulta() {
    let (_dir, conn, _f) = setup_with(&[
        ("sem_letra.mp3", "a - um.mp3"),
        ("sem_letra.mp3", "b - dois.mp3"),
        ("sem_letra.mp3", "c - tres.mp3"),
    ]);
    let urls = RefCell::new(Vec::new());
    let props = scan_props(&conn, "", |url: &str| {
        urls.borrow_mut().push(url.to_string());
        if url.starts_with(lyrics_ovh::SEARCH_URL) {
            Err(AppError(lyrics_ovh::ERRO_SEM_RESPOSTA.into()))
        } else {
            Err(AppError(lyrics_fetch::ERRO_SEM_RESPOSTA.into()))
        }
    });

    assert_eq!(props.len(), 3, "as três continuam na revisão (DECISIONS #47)");
    assert_eq!(
        urls.borrow().len(),
        2,
        "a evidência custou dois hosts, e nenhuma música depois dela gastou rede: {:?}",
        urls.borrow()
    );
    for p in &props {
        assert_eq!(
            p.error.as_deref(),
            Some(enrich::ERRO_SEM_CONEXAO),
            "a mesma frase para todas: a rede caiu para a varredura inteira"
        );
    }
}

/// Servidor que RESPONDE com erro não é rede caída — e a rodada da V9 já
/// separava esse caso por frase. Aqui ele é separado também pelo COMPORTAMENTO:
/// nenhuma etapa é pulada, e ninguém acusa a internet.
#[test]
fn servidor_que_responde_com_erro_nao_e_evidencia_de_rede_caida() {
    let (_dir, conn, _f) = setup_with(&[
        ("sem_letra.mp3", "a - um.mp3"),
        ("sem_letra.mp3", "b - dois.mp3"),
    ]);
    let urls = RefCell::new(Vec::new());
    let props = scan_props(&conn, "", |url: &str| {
        urls.borrow_mut().push(url.to_string());
        Err(AppError("o site de letras pediu para esperar um pouco".into()))
    });

    assert_eq!(
        urls.borrow().len(),
        4,
        "duas etapas em cada uma das duas músicas: {:?}",
        urls.borrow()
    );
    for p in &props {
        assert_eq!(
            p.error.as_deref(),
            Some("o site de letras pediu para esperar um pouco")
        );
    }
}

/// A etapa 2 que falha deixou de derrubar as etapas de LETRA.
///
/// Vale para o servidor mudo e vale para o `fpcalc`, que falha em três de cada
/// quatro arquivos do acervo real (QA A2): a falha de um acessório local não
/// diz nada sobre o LRCLIB, e abortar ali era pular as duas etapas que
/// resolvem a música.
#[test]
fn a_falha_da_etapa_2_nao_derruba_mais_as_etapas_de_letra() {
    let (_dir, conn, _f) = setup_with(&[("sem_letra.mp3", "sem_letra.mp3")]);
    let song = song_by_suffix(&conn, "sem_letra.mp3");
    // a duração que vale é a PROVADA pelo fpcalc (180 s no falso), e não a do
    // cabeçalho: quem lê o som manda no casamento do LRCLIB
    let corpo = lrclib(&song.title, song.artist.as_deref().unwrap_or(""), 180.0, "a letra");

    let urls = RefCell::new(Vec::new());
    let fontes = ComSom::nova(
        move |url: &str| {
            urls.borrow_mut().push(url.to_string());
            if url.starts_with(cancioneiro_lib::fingerprint::LOOKUP_URL) {
                // o AcoustID não respondeu: um host mudo, e só
                Err(AppError(cancioneiro_lib::fingerprint::ERRO_SEM_RESPOSTA.into()))
            } else {
                Ok(corpo.clone())
            }
        },
        180.0,
    );
    let props = enrich::enrich_scan(&conn, "", fontes, ZERO, SEM_PROGRESSO, SEM_CANCELAMENTO)
        .unwrap()
        .propostas;

    assert_eq!(
        props[0].lyrics.as_deref(),
        Some("a letra"),
        "o LRCLIB tinha a letra, e o funil chegou até ele"
    );
    assert!(props[0].error.is_none());
}

// ===========================================================================
// V10.11 — O BOTÃO DE TRANSCREVER APARECE MESMO PARA QUEM JÁ TEM LETRA.
//
// A DECISIONS #167 escondia o botão da ficha quando a música já tinha letra, e
// o dono reverteu a decisão com um caso concreto: um beta tester abriu uma
// música cuja letra terminava em `[MÚSICA]` — letra vinda de transcrição,
// imperfeita — e queria exatamente refazê-la. **O caso em que a pessoa mais
// quer transcrever de novo é justamente aquele em que já existe letra ruim.**
//
// O que muda, e o que NÃO muda:
//
// - muda a porta de UMA MÚSICA (`pendentes_da_transcricao_da_musica`), que
//   passa a devolver a fila com a música que tem letra;
// - muda a trava do `transcricao_scan`, que recusava a fila com um erro em
//   pt-BR — sem isso o botão novo levaria a pessoa a uma linha de erro depois
//   de nada;
// - **não muda a varredura em lote nem o bloco de Configurações**: as duas
//   continuam pulando quem tem letra (DECISIONS #136), porque lá ninguém pediu
//   por aquela música em particular;
// - **não muda o consentimento** (DECISIONS #79): o que sai daqui é uma
//   PROPOSTA, e a substituição continua exigindo a marcação na revisão.
// ===========================================================================

/// A porta de UMA música oferece a etapa 5 para quem já tem letra — e a porta
/// da pasta, sobre a MESMA música, continua não oferecendo.
///
/// As duas divergem em um portão só, e é este teste que fixa qual: o resto
/// (instrumental, arquivo que sumiu do disco) vale igual nas duas.
#[test]
fn a_porta_de_uma_musica_oferece_a_etapa_5_para_quem_ja_tem_letra() {
    let (_dir, conn, _f) = setup_with(&[
        ("com_letra.mp3", "Pasta/com_letra.mp3"),
        ("sem_letra.mp3", "Pasta/sem_letra.mp3"),
    ]);
    let com_letra = song_by_suffix(&conn, "com_letra.mp3");
    let modelo = transcricao::modelo_oferecido();

    let uma =
        enrich::pendentes_da_transcricao_da_musica(&conn, com_letra.id, modelo, true)
            .unwrap();
    assert_eq!(
        uma.musicas,
        vec![com_letra.id],
        "a letra que já existe é justamente o motivo de querer refazê-la"
    );
    assert!(
        uma.segundos_estimados > 0,
        "e o tempo é anunciado, porque é ele que vai no rótulo do botão"
    );

    // a porta da pasta, sobre a mesma biblioteca, continua pulando essa música
    let pasta = enrich::pendentes_da_transcricao(&conn, "", modelo, true).unwrap();
    assert!(
        !pasta.musicas.contains(&com_letra.id),
        "em lote ninguém pediu por esta música: a regra da #136 vale inteira"
    );
    assert_eq!(pasta.musicas.len(), 1, "só a que está sem letra");
}

/// A varredura em lote NÃO passou a oferecer quem tem letra na pergunta do fim.
///
/// `sem_letra_no_fim` é o outro consumidor do portão de lote, e ele alimenta a
/// mesma fila. Se o portão de uma música tivesse sido escrito por cima do de
/// lote, este teste ficaria vermelho — que é o ponto de ele existir.
#[test]
fn a_pergunta_do_fim_continua_pulando_quem_ja_tem_letra() {
    let (_dir, conn, _f) = setup_with(&[
        ("com_letra.mp3", "com_letra.mp3"),
        ("sem_letra.mp3", "sem_letra.mp3"),
    ]);
    let com_letra = song_by_suffix(&conn, "com_letra.mp3");
    let sem_letra = song_by_suffix(&conn, "sem_letra.mp3");

    let r = enrich::enrich_scan(
        &conn,
        "",
        |_url: &str| Ok("[]".to_string()),
        ZERO,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap();

    assert_eq!(r.sem_letra_no_fim, vec![sem_letra.id]);
    assert!(!r.sem_letra_no_fim.contains(&com_letra.id));
}

/// A fila que chega com uma música que tem letra é TRANSCRITA, e o desfecho é
/// uma proposta de substituição — não uma linha de erro.
///
/// A trava que recusava isto existia enquanto ninguém podia pedir legitimamente
/// (DECISIONS #167). Com o botão da ficha, alguém pode — e a trava passaria a
/// gastar o clique de quem leu "cerca de 4 minutos" para devolver um "não".
///
/// **O que protege a letra existente continua onde sempre esteve**: o `apply`,
/// que só grava por cima com o consentimento marcado (DECISIONS #79). A
/// proposta sai daqui com `has_lyrics` verdadeiro, que é o que faz a revisão
/// desenhar a caixa.
#[test]
fn a_etapa_5_transcreve_quem_ja_tem_letra_quando_a_fila_pede() {
    let (_dir, conn, _f) = setup_with(&[("com_letra.mp3", "com_letra.mp3")]);
    let com_letra = song_by_suffix(&conn, "com_letra.mp3");

    let r = transcrever(
        &conn,
        &[com_letra.id],
        motor("a letra refeita inteira ouvindo o áudio de novo", 30.0),
    );

    assert_eq!(r.propostas.len(), 1);
    let p = &r.propostas[0];
    assert_eq!(p.error, None, "não é mais uma recusa");
    assert_eq!(
        p.lyrics.as_deref(),
        Some("a letra refeita inteira ouvindo o áudio de novo")
    );
    assert!(
        p.has_lyrics,
        "o eco diz que já há letra no arquivo — é ele que faz a revisão \
         pedir o consentimento de substituição (DECISIONS #79)"
    );
    assert_eq!(
        p.confidence, "media",
        "letra de máquina nunca chega pré-marcada (DECISIONS #49)"
    );
}

/// E o `apply` continua recusando a substituição sem consentimento, mesmo
/// vindo da etapa 5 pedida na ficha.
///
/// É a garantia inteira do item: nada é sobrescrito sem clique. A linha volta
/// com a frase que cita o rótulo da marcação, que é como a tela a reconhece.
#[test]
fn a_letra_refeita_nao_entra_no_arquivo_sem_o_consentimento() {
    let (_dir, conn, _f) = setup_with(&[("com_letra.mp3", "com_letra.mp3")]);
    let com_letra = song_by_suffix(&conn, "com_letra.mp3");
    let antes = db::get_lyrics(&conn, com_letra.id).unwrap();

    let resultados = enrich::apply(
        &conn,
        &[EnrichApply {
            song_id: com_letra.id,
            title: com_letra.title.clone(),
            artist: com_letra.artist.clone(),
            lyrics: Some("a letra refeita ouvindo o áudio".into()),
            add_temas: None,
            current_title: com_letra.title.clone(),
            current_artist: com_letra.artist.clone(),
            fonte: None,
            substituir_letra: false,
            marcar_instrumental: false,
        }],
    )
    .unwrap();

    assert_eq!(resultados.len(), 1);
    let erro = resultados[0].error.as_deref().expect("a linha foi recusada");
    assert!(
        erro.contains("substituir a letra atual"),
        "a recusa cita o rótulo da marcação: {erro:?}"
    );
    assert_eq!(
        db::get_lyrics(&conn, com_letra.id).unwrap(),
        antes,
        "e o arquivo continua com a letra que tinha"
    );
}
