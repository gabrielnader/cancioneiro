//! Testes de integração da F13 (PRD V5) — enriquecimento em lote no app:
//! enrich_scan (propostas via LRCLIB com fetcher stub, sem rede) e apply
//! (gravação via writer::write_tags, que no lote nunca apaga dados
//! existentes — só preenche/atualiza o que veio).

use cancioneiro_lib::enrich::{self, EnrichApply};
use cancioneiro_lib::error::AppError;
use cancioneiro_lib::{db, indexer, writer};
use rusqlite::Connection;
use std::cell::RefCell;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

const ZERO: Duration = Duration::ZERO;

/// Callback de progresso ignorado pelos testes que não o exercitam.
const SEM_PROGRESSO: fn(usize, usize, &str) = |_, _, _| {};

/// `enrich_scan` sem pausa de cortesia nem progresso — a forma usada pela
/// maioria dos testes, que exercitam só as propostas.
fn scan_props(
    conn: &Connection,
    prefixo: &str,
    fetch: impl Fn(&str) -> Result<String, AppError>,
) -> Vec<enrich::EnrichProposal> {
    enrich::enrich_scan(conn, prefixo, fetch, ZERO, SEM_PROGRESSO).unwrap()
}

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("fixtures")
}

/// Copia fixtures para um tempdir com os nomes/subpastas pedidos, registra a
/// pasta e indexa. Devolve (tempdir, conn, folder_id).
fn setup_with(files: &[(&str, &str)]) -> (tempfile::TempDir, Connection, i64) {
    let dir = tempfile::tempdir().unwrap();
    for (src, dst) in files {
        let dest = dir.path().join(dst);
        fs::create_dir_all(dest.parent().unwrap()).unwrap();
        fs::copy(fixtures_dir().join(src), dest).unwrap();
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
    )
    .unwrap();

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

    // BAIXA com título real: preserva o título no palpite (nunca propõe
    // apagar) e acrescenta o artista que o nome do arquivo revela
    let chuva = props
        .iter()
        .find(|p| p.file_path.ends_with("Oh! Chuva.mp3"))
        .unwrap();
    assert_eq!(chuva.proposed_title, "Falamansa - Oh! Chuva");
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
    writer::write_tags(&conn, song.id, "02 AudioTrack 02", Some("no artist"), None, None)
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
    )
    .unwrap();

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
    writer::write_tags(&conn, song.id, "Faixa 5", Some("Banda Fixture"), None, None).unwrap();

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
    )
    .unwrap();

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
        ("com_letra.mp3", "com_letra.mp3"), // completa: NÃO é candidata
        ("sem_tags.mp3", "Falamansa - Oh! Chuva.mp3"),
        ("sem_tags.mp3", "Sub/Zeca - Camarão.mp3"),
        ("sem_letra.mp3", "sem_letra.mp3"),
    ]);

    let eventos: RefCell<Vec<(usize, usize, String)>> = RefCell::new(Vec::new());
    enrich::enrich_scan(
        &conn,
        "",
        |_: &str| Ok("[]".into()),
        ZERO,
        |done, total, atual| eventos.borrow_mut().push((done, total, atual.to_string())),
    )
    .unwrap();

    let ev = eventos.borrow();
    // 3 candidatas (a completa fica fora) + o evento inicial com done=0
    assert_eq!(ev.len(), 4, "1 evento inicial + 1 por candidata: {ev:?}");
    assert_eq!(ev[0].0, 0, "primeiro evento anuncia o total antes de começar");
    assert!(ev.iter().all(|e| e.1 == 3), "total = candidatas: {ev:?}");
    assert_eq!(
        ev.iter().map(|e| e.0).collect::<Vec<_>>(),
        vec![0, 1, 2, 3],
        "done cresce de 1 em 1"
    );

    // `atual` é o NOME BASE do arquivo, nunca o caminho completo
    let mut nomes: Vec<&str> = ev[1..].iter().map(|e| e.2.as_str()).collect();
    nomes.sort();
    assert_eq!(
        nomes,
        vec!["Falamansa - Oh! Chuva.mp3", "Zeca - Camarão.mp3", "sem_letra.mp3"]
    );
    assert!(
        ev.iter().all(|e| !e.2.contains(std::path::MAIN_SEPARATOR)),
        "nome base, não caminho: {ev:?}"
    );
    assert!(
        ev.iter().all(|e| e.2 != "com_letra.mp3"),
        "música completa nunca entra no progresso"
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

    let eventos: RefCell<Vec<(usize, usize, String)>> = RefCell::new(Vec::new());
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
        |done, total, atual| eventos.borrow_mut().push((done, total, atual.to_string())),
    )
    .unwrap();

    // resultado: a no-op sumiu, as duas com erro ficaram
    assert_eq!(props.len(), 2, "só a no-op é descartada");
    assert!(props.iter().all(|p| p.error.is_some()));

    // progresso: as TRÊS candidatas contam, inclusive a descartada
    let ev = eventos.borrow();
    assert_eq!(
        ev.iter().map(|e| e.0).collect::<Vec<_>>(),
        vec![0, 1, 2, 3],
        "progresso não trava na descartada nem na que falhou: {ev:?}"
    );
    assert!(ev.iter().all(|e| e.1 == 3), "total conta trabalho, não resultado");
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
    )
    .unwrap();
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
        },
        EnrichApply {
            song_id: b.id,
            title: "Título B".into(),
            artist: None,
            lyrics: None,
            add_temas: None,
        },
        EnrichApply {
            song_id: c.id,
            title: "Título C".into(),
            artist: None,
            lyrics: Some("letra c".into()),
            add_temas: None,
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
    )
    .unwrap();

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
    )
    .unwrap();

    assert!(*calls.borrow() >= 2, "houve palpite depois do candidato válido");
    assert_eq!(props.len(), 1);
    let p = &props[0];
    assert_eq!(p.confidence, "media", "candidato achado antes do erro é mantido");
    assert_eq!(p.proposed_title, "Oh! Chuva");
    assert_eq!(p.proposed_artist.as_deref(), Some("Falamansa"));
    assert_eq!(p.lyrics.as_deref(), Some("letra"));
    assert!(p.error.is_none(), "erro posterior não vira error na proposta");
}
