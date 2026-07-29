//! Testes de integração da F13 (PRD V5) — enriquecimento em lote no app:
//! enrich_scan (propostas via LRCLIB com fetcher stub, sem rede) e apply
//! (gravação via writer::write_tags, que no lote nunca apaga dados
//! existentes — só preenche/atualiza o que veio).

use cancioneiro_lib::enrich::{self, EnrichApply};
use cancioneiro_lib::error::AppError;
use cancioneiro_lib::{db, indexer, vagalume, writer};
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

/// Chave do Vagalume dos testes que não exercitam a etapa 3 (sem chave, ela
/// é pulada em silêncio).
const SEM_CHAVE: &str = "";

/// Chave falsa dos testes que exercitam a etapa 3 — o Vagalume nunca é
/// consultado de verdade (o `fetch` é sempre um stub).
const CHAVE_VG: &str = "chave-vagalume-de-teste";

/// `enrich_scan` sem pausa de cortesia, sem progresso e sem Vagalume — a
/// forma usada pela maioria dos testes, que exercitam só as propostas.
fn scan_props(
    conn: &Connection,
    prefixo: &str,
    fetch: impl Fn(&str) -> Result<String, AppError>,
) -> Vec<enrich::EnrichProposal> {
    enrich::enrich_scan(
        conn,
        prefixo,
        enrich::Modo::Completar,
        fetch,
        SEM_CHAVE,
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
        enrich::Modo::Completar,
        |url: &str| {
            urls.borrow_mut().push(url.to_string());
            Ok(body.clone())
        },
        SEM_CHAVE,
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
        enrich::Modo::Completar,
        |url: &str| {
            urls.borrow_mut().push(url.to_string());
            Ok("[]".into())
        },
        SEM_CHAVE,
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
        enrich::Modo::Completar,
        |_: &str| -> Result<String, AppError> { Err(AppError("sem conexão".into())) },
        SEM_CHAVE,
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
        ("com_letra.mp3", "com_letra.mp3"), // completa: NÃO é candidata
        ("sem_tags.mp3", "Falamansa - Oh! Chuva.mp3"),
        ("sem_tags.mp3", "Sub/Zeca - Camarão.mp3"),
        ("sem_letra.mp3", "sem_letra.mp3"),
    ]);

    let eventos: RefCell<Vec<(usize, usize, String, String)>> = RefCell::new(Vec::new());
    enrich::enrich_scan(
        &conn,
        "",
        enrich::Modo::Completar,
        |_: &str| Ok("[]".into()),
        SEM_CHAVE,
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
    // 3 candidatas (a completa fica fora) + o evento inicial com done=0
    assert_eq!(ev.len(), 4, "1 evento inicial + 1 por candidata: {ev:?}");
    assert_eq!(ev[0].0, 0, "primeiro evento anuncia o total antes de começar");
    assert!(todos.iter().all(|e| e.1 == 3), "total = candidatas: {todos:?}");
    assert_eq!(
        ev.iter().map(|e| e.0).collect::<Vec<_>>(),
        vec![0, 1, 2, 3],
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
        vec!["Falamansa - Oh! Chuva.mp3", "Zeca - Camarão.mp3", "sem_letra.mp3"]
    );
    assert!(
        todos.iter().all(|e| !e.2.contains(std::path::MAIN_SEPARATOR)),
        "nome base, não caminho: {todos:?}"
    );
    assert!(
        todos.iter().all(|e| e.2 != "com_letra.mp3"),
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

    let eventos: RefCell<Vec<(usize, usize, String, String)>> = RefCell::new(Vec::new());
    let props = enrich::enrich_scan(
        &conn,
        "",
        enrich::Modo::Completar,
        |url: &str| {
            if url.contains("Instrumental") {
                Ok("[]".into()) // acha nada ⇒ palpite igual às tags ⇒ no-op
            } else {
                Err(AppError("sem conexão".into()))
            }
        },
        SEM_CHAVE,
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
        enrich::Modo::Completar,
        |url: &str| {
            urls.borrow_mut().push(url.to_string());
            Ok(body.clone())
        },
        SEM_CHAVE,
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
// V8/F17 — o instrumental sai também da CONTAGEM do progresso: `total` mede
// trabalho a fazer, e uma barra que conta arquivos que ninguém vai consultar
// para em "3 de 5" para sempre.
// ---------------------------------------------------------------------------
#[test]
fn scan_progress_total_excludes_instrumental_songs() {
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
        enrich::Modo::Completar,
        |_: &str| Ok("[]".into()),
        SEM_CHAVE,
        ZERO,
        |done, total, _, _| progresso.borrow_mut().push((done, total)),
        SEM_CANCELAMENTO,
    )
    .unwrap().propostas;

    let p = progresso.borrow();
    assert_eq!(p.first().copied(), Some((0, 1)), "total anunciado: {p:?}");
    assert_eq!(p.last().copied(), Some((1, 1)), "progresso completa: {p:?}");
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
        enrich::Modo::Completar,
        |_: &str| {
            *calls.borrow_mut() += 1;
            Ok("[]".into())
        },
        SEM_CHAVE,
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
        enrich::Modo::Completar,
        |_: &str| -> Result<String, AppError> { Err(AppError("sem conexão".into())) },
        SEM_CHAVE,
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
        enrich::Modo::Completar,
        |_: &str| {
            *calls.borrow_mut() += 1;
            if *calls.borrow() == 1 {
                Ok(body.clone())
            } else {
                Err(AppError("sem conexão".into()))
            }
        },
        SEM_CHAVE,
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
// o Vagalume em silêncio, exatamente como já acontece quando não há chave.
// ===========================================================================
#[test]
fn a_rejected_key_switches_the_vagalume_stage_off_for_the_rest_of_the_scan() {
    let (_dir, conn, _folder_id) = setup_with(&[
        ("sem_letra.mp3", "Uma.mp3"),
        ("sem_letra.mp3", "Duas.mp3"),
    ]);
    // as duas precisam de tags reais para a etapa 3 ser alcançada
    for (suffix, titulo) in [("Uma.mp3", "Ponto de Oxum"), ("Duas.mp3", "Ponto de Iansã")] {
        let s = song_by_suffix(&conn, suffix);
        writer::write_tags(&conn, s.id, titulo, Some("Coral Novo"), None, None, None).unwrap();
    }

    let urls = RefCell::new(Vec::new());
    let props = enrich::enrich_scan(
        &conn,
        "",
        enrich::Modo::Completar,
        |url: &str| {
            urls.borrow_mut().push(url.to_string());
            if url.contains("vagalume") {
                Err(AppError(vagalume::ERRO_CHAVE_RECUSADA.into()))
            } else {
                Ok("[]".to_string())
            }
        },
        CHAVE_VG,
        ZERO,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap().propostas;

    assert_eq!(
        urls_de(&urls, "vagalume").len(),
        1,
        "a chave recusada é consultada UMA vez: {:?}",
        urls_de(&urls, "vagalume")
    );
    // e o LRCLIB, que não usa chave nenhuma, foi consultado pelas duas
    let no_lrclib = urls_de(&urls, "lrclib").join(" ");
    assert!(no_lrclib.contains("Oxum") && no_lrclib.contains("Ians"));
    // UMA linha explica o problema; a outra nem aparece — sem a etapa 3 não
    // sobra nada a propor para ela, e uma linha muda repetindo a mesma
    // acusação seria só ruído na revisão
    let com_erro: Vec<&str> = props.iter().filter_map(|p| p.error.as_deref()).collect();
    assert_eq!(com_erro, vec![vagalume::ERRO_CHAVE_RECUSADA]);
    // a chave nunca entra na explicação
    assert!(!serde_json::to_string(&props).unwrap().contains(CHAVE_VG));
}

/// Um erro de rede QUALQUER do Vagalume (fora do ar, 429) não desliga a
/// etapa: ele pode ter sido um soluço, e a música seguinte merece a tentativa.
/// Só a chave recusada é veredito sobre a varredura inteira.
#[test]
fn a_passing_vagalume_failure_does_not_switch_the_stage_off() {
    let (_dir, conn, _folder_id) = setup_with(&[
        ("sem_letra.mp3", "Uma.mp3"),
        ("sem_letra.mp3", "Duas.mp3"),
    ]);
    for (suffix, titulo) in [("Uma.mp3", "Ponto de Oxum"), ("Duas.mp3", "Ponto de Iansã")] {
        let s = song_by_suffix(&conn, suffix);
        writer::write_tags(&conn, s.id, titulo, Some("Coral Novo"), None, None, None).unwrap();
    }

    let urls = RefCell::new(Vec::new());
    enrich::enrich_scan(
        &conn,
        "",
        enrich::Modo::Completar,
        |url: &str| {
            urls.borrow_mut().push(url.to_string());
            if url.contains("vagalume") {
                Err(AppError("o site de letras está fora do ar agora".into()))
            } else {
                Ok("[]".to_string())
            }
        },
        CHAVE_VG,
        ZERO,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap().propostas;

    assert_eq!(urls_de(&urls, "vagalume").len(), 2, "as duas são tentadas");
}

// ===========================================================================
// QA ALTO-2 — quantas músicas a varredura vai olhar é UMA regra, e ela mora
// aqui. O frontend tinha uma cópia em TypeScript que já divergira desta; a
// contagem que a tela promete e o total que a barra de progresso anuncia
// precisam sair da MESMA `candidata`.
// ===========================================================================
#[test]
fn count_candidatas_is_the_same_rule_the_scan_uses() {
    let (_dir, conn, _folder_id) = setup_with(&[
        ("sem_tags.mp3", "Pasta/Falamansa - Oh! Chuva.mp3"), // sem tag nenhuma
        ("sem_letra.mp3", "Pasta/sem_letra.mp3"),            // tem nomes, falta letra
        ("com_letra.mp3", "Pasta/com_letra.mp3"),            // completa: fora
        ("sem_tags.mp3", "Outra/x.mp3"),                     // fora do prefixo
    ]);
    let raiz = song_by_suffix(&conn, "Oh! Chuva.mp3").file_path;
    let pasta = raiz.trim_end_matches("/Falamansa - Oh! Chuva.mp3").to_string();

    // o total anunciado pela varredura é a verdade a espelhar
    let eventos = RefCell::new(Vec::new());
    enrich::enrich_scan(
        &conn,
        &pasta,
        enrich::Modo::Completar,
        |_: &str| Ok("[]".to_string()),
        SEM_CHAVE,
        ZERO,
        |_, total, _, _| eventos.borrow_mut().push(total),
        SEM_CANCELAMENTO,
    )
    .unwrap().propostas;
    let total_da_varredura = eventos.borrow()[0];

    assert_eq!(enrich::count_candidatas(&conn, &pasta, enrich::Modo::Completar).unwrap(), 2);
    assert_eq!(
        enrich::count_candidatas(&conn, &pasta, enrich::Modo::Completar).unwrap(),
        total_da_varredura,
        "a contagem prometida na tela é a mesma que a barra vai anunciar"
    );
    // prefixo vazio = biblioteca inteira
    assert_eq!(enrich::count_candidatas(&conn, "", enrich::Modo::Completar).unwrap(), 3);
    // pasta sem nada a completar
    assert_eq!(
        enrich::count_candidatas(&conn, "/lugar/nenhum", enrich::Modo::Completar).unwrap(),
        0
    );
}

/// A contagem não gasta rede e não propõe nada: ela existe para a tela poder
/// dizer "vou olhar N músicas" ANTES de a pessoa mandar começar.
#[test]
fn count_candidatas_never_touches_the_network() {
    let (_dir, conn, _folder_id) = setup_with(&[("sem_tags.mp3", "a - Um.mp3")]);
    assert_eq!(enrich::count_candidatas(&conn, "", enrich::Modo::Completar).unwrap(), 1);
}

/// O instrumental com título E artista não tem o que completar (a letra não
/// conta para ele, V8/F17) — e some da contagem, exatamente como some da
/// varredura.
#[test]
fn count_candidatas_excludes_instrumentals_with_both_names() {
    let (_dir, conn, _folder_id) = setup_with(&[("sem_letra.mp3", "sem_letra.mp3")]);
    let song = song_by_suffix(&conn, "sem_letra.mp3");
    assert_eq!(enrich::count_candidatas(&conn, "", enrich::Modo::Completar).unwrap(), 1);

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
    assert_eq!(enrich::count_candidatas(&conn, "", enrich::Modo::Completar).unwrap(), 0);
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
    scan_props(conn, "", move |_url: &str| Ok(corpo.clone()))
        .into_iter()
        .find(|p| p.song_id == song.id)
        .expect("a música com nome de ripador continua candidata")
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

    // ...e a mesma troca vinda do Vagalume fica marcada como tal
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
            fonte: Some(enrich::FONTE_VAGALUME.into()),
            substituir_letra: true,
        }],
    )
    .unwrap();
    assert_eq!(results[0].error, None);
    assert_eq!(
        id3(&song.file_path).get_user_text("LETRA_ORIGEM"),
        Some("vagalume")
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
        enrich::Modo::Completar,
        |url: &str| {
            musicas_consultadas.borrow_mut().push(url.to_string());
            Ok("[]".into())
        },
        SEM_CHAVE,
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
        enrich::Modo::Completar,
        |_: &str| {
            *chamadas.borrow_mut() += 1;
            Ok("[]".into())
        },
        SEM_CHAVE,
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
// Vagalume como segunda fonte de letra e a varredura de UMA música só.
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

/// Corpo de resposta do `/search.php` do Vagalume, no formato real da API.
fn corpo_vagalume(titulo: &str, artista: &str, letra: &str) -> String {
    format!(
        r#"{{"type":"exact","art":{{"name":{}}},"mus":[{{"name":{},"text":{}}}]}}"#,
        json(artista),
        json(titulo),
        json(letra)
    )
}

/// Fetcher único que atende as DUAS fontes pela URL e registra tudo que foi
/// pedido — o mesmo desenho do `fetcher_de` da suíte Python.
fn duas_fontes<'a>(
    urls: &'a RefCell<Vec<String>>,
    lrclib: String,
    vagalume: String,
) -> impl Fn(&str) -> Result<String, AppError> + 'a {
    move |url: &str| {
        urls.borrow_mut().push(url.to_string());
        if url.contains("vagalume") {
            Ok(vagalume.clone())
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
/// Vagalume só é consultado com título E artista para conferir).
const LETRA_VG: &str = "Primeira linha inventada\nSegunda linha inventada à toa";

// ---------------------------------------------------------------------------
// O funil por custo crescente: o Vagalume recebe SÓ o que o LRCLIB não
// resolveu, e a proposta diz de onde veio (`fonte`) para quem revisa.
// ---------------------------------------------------------------------------
#[test]
fn vagalume_answers_only_where_lrclib_came_up_empty() {
    let (_dir, conn, _folder_id) = setup_with(&[("sem_letra.mp3", "sem_letra.mp3")]);
    let song = song_by_suffix(&conn, "sem_letra.mp3");

    let urls = RefCell::new(Vec::new());
    let props = enrich::enrich_scan(
        &conn,
        "",
        enrich::Modo::Completar,
        duas_fontes(
            &urls,
            "[]".into(), // o LRCLIB não tem este repertório
            corpo_vagalume("Instrumental Sem Letra", "Banda Fixture", LETRA_VG),
        ),
        CHAVE_VG,
        ZERO,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap().propostas;

    assert!(!urls_de(&urls, "lrclib").is_empty(), "o LRCLIB vem primeiro");
    assert_eq!(
        urls_de(&urls, "vagalume").len(),
        1,
        "uma consulta ao Vagalume por música, nunca uma por palpite"
    );

    let p = props.iter().find(|p| p.song_id == song.id).expect("proposta");
    assert_eq!(p.fonte, "Vagalume");
    assert_eq!(p.lyrics.as_deref(), Some(LETRA_VG));
    assert_eq!(
        p.confidence, "media",
        "sem duração para confirmar, o Vagalume nunca chega PRÉ-MARCADO na          revisão (DECISIONS #49 + #63)"
    );
    assert!(p.error.is_none());
    // a régua estrita garante as MESMAS palavras: a etapa não troca nomes
    assert_eq!(p.proposed_title, song.title);
    assert_eq!(p.proposed_artist, song.artist);
}

#[test]
fn vagalume_is_not_asked_when_lrclib_already_answered() {
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
        enrich::Modo::Completar,
        duas_fontes(&urls, lrclib, corpo_vagalume("x", "y", "z")),
        CHAVE_VG,
        ZERO,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap().propostas;

    assert!(
        urls_de(&urls, "vagalume").is_empty(),
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
#[test]
fn without_a_key_the_vagalume_stage_is_silently_skipped() {
    let (_dir, conn, _folder_id) = setup_with(&[("sem_letra.mp3", "sem_letra.mp3")]);

    for chave in ["", "   "] {
        let urls = RefCell::new(Vec::new());
        let etapas = RefCell::new(Vec::new());
        let props = enrich::enrich_scan(
            &conn,
            "",
            enrich::Modo::Completar,
            duas_fontes(
                &urls,
                "[]".into(),
                corpo_vagalume("Instrumental Sem Letra", "Banda Fixture", LETRA_VG),
            ),
            chave,
            ZERO,
            |_, _, _, etapa| etapas.borrow_mut().push(etapa.to_string()),
            SEM_CANCELAMENTO,
        )
        .unwrap().propostas;

        assert!(urls_de(&urls, "vagalume").is_empty(), "sem chave, sem rede");
        assert!(
            !etapas.borrow().iter().any(|e| e == enrich::ETAPA_VAGALUME),
            "sem chave, a etapa nem é anunciada"
        );
        assert!(
            props.iter().all(|p| p.error.is_none()),
            "sem chave não é erro: {props:?}"
        );
        // o LRCLIB continua sendo consultado normalmente
        assert!(!urls_de(&urls, "lrclib").is_empty());
    }
}

// ---------------------------------------------------------------------------
// "Sem artista para conferir, não se consulta" (DECISIONS #63): o Vagalume
// não tem duração, então a igualdade de palavras dos DOIS lados é a única
// prova — e ela exige um pedido que já signifique alguma coisa. Palpite de
// nome de arquivo não é isso.
// ---------------------------------------------------------------------------
#[test]
fn vagalume_is_never_asked_from_a_filename_guess() {
    let (_dir, conn, _folder_id) =
        setup_with(&[("sem_tags.mp3", "Falamansa - Oh! Chuva.mp3")]);

    let urls = RefCell::new(Vec::new());
    let props = enrich::enrich_scan(
        &conn,
        "",
        enrich::Modo::Completar,
        duas_fontes(
            &urls,
            "[]".into(),
            corpo_vagalume("Oh! Chuva", "Falamansa", LETRA_VG),
        ),
        CHAVE_VG,
        ZERO,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap().propostas;

    assert!(
        urls_de(&urls, "vagalume").is_empty(),
        "arquivo sem tag real não vai ao Vagalume: {:?}",
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
        ("sem_letra.mp3", "sem_letra.mp3"),              // vira vagalume
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
        enrich::Modo::Completar,
        |url: &str| {
            urls.borrow_mut().push(url.to_string());
            if url.contains("vagalume") {
                Ok(corpo_vagalume(
                    "Instrumental Sem Letra",
                    "Banda Fixture",
                    LETRA_VG,
                ))
            } else if url.contains("Chuva") {
                Ok(format!(
                    r#"[{{"trackName":"Oh! Chuva","artistName":"Falamansa",
                         "duration":{dur},"plainLyrics":"Chove lá fora"}}]"#
                ))
            } else {
                Ok("[]".into())
            }
        },
        CHAVE_VG,
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
    assert_eq!(fonte_de("sem_letra.mp3"), "Vagalume");
    assert_eq!(fonte_de("Oh! Chuva.mp3"), "LRCLIB");
    assert_eq!(fonte_de("Sumida.mp3"), "erro");

    // vocabulário fechado: a UI só precisa saber traduzir estes quatro
    for p in &props {
        assert!(
            ["nome do arquivo", "LRCLIB", "Vagalume", "erro"].contains(&p.fonte.as_str()),
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
        enrich::Modo::Completar,
        duas_fontes(
            &urls,
            "[]".into(),
            corpo_vagalume("Instrumental Sem Letra", "Banda Fixture", LETRA_VG),
        ),
        CHAVE_VG,
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
            enrich::ETAPA_VAGALUME,
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
        enrich::Modo::Completar,
        duas_fontes(
            &urls,
            "[]".into(),
            corpo_vagalume("Instrumental Sem Letra", "Banda Fixture", LETRA_VG),
        ),
        CHAVE_VG,
        pausa,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap().propostas;
    let gasto = inicio.elapsed();

    let consultas = urls.borrow().len();
    assert!(consultas >= 3, "2 palpites no LRCLIB + 1 Vagalume: {consultas}");
    assert!(
        gasto >= pausa * (consultas as u32 - 1),
        "uma pausa por consulta, menos a primeira: {consultas} consultas em {gasto:?}"
    );
}

// ---------------------------------------------------------------------------
// Cancelar cancela a REDE, não só a fila: a bandeira é lida antes de cada
// consulta, inclusive antes da do Vagalume.
// ---------------------------------------------------------------------------
#[test]
fn cancelling_stops_before_the_vagalume_query() {
    let (_dir, conn, _folder_id) = setup_with(&[("sem_letra.mp3", "sem_letra.mp3")]);

    let urls = RefCell::new(Vec::new());
    let cancelada = std::cell::Cell::new(false);
    let props = enrich::enrich_scan(
        &conn,
        "",
        enrich::Modo::Completar,
        |url: &str| {
            urls.borrow_mut().push(url.to_string());
            cancelada.set(true); // usuário cancela durante a 1ª consulta
            Ok("[]".to_string())
        },
        CHAVE_VG,
        ZERO,
        SEM_PROGRESSO,
        || cancelada.get(),
    )
    .unwrap().propostas;

    assert_eq!(urls.borrow().len(), 1, "para na consulta seguinte");
    assert!(urls_de(&urls, "vagalume").is_empty(), "o Vagalume nem começa");
    assert!(props.is_empty(), "volta com o que já tinha (nada)");
}

// ---------------------------------------------------------------------------
// Erro de rede na etapa 3 é erro POR MÚSICA, como o da etapa 2: a linha vira
// informação e o lote segue.
// ---------------------------------------------------------------------------
#[test]
fn a_vagalume_network_error_never_aborts_the_batch() {
    let (_dir, conn, _folder_id) = setup_with(&[
        ("sem_letra.mp3", "sem_letra.mp3"),
        ("sem_tags.mp3", "Falamansa - Oh! Chuva.mp3"),
    ]);

    let props = enrich::enrich_scan(
        &conn,
        "",
        enrich::Modo::Completar,
        |url: &str| {
            if url.contains("vagalume") {
                Err(AppError("sem conexão".into()))
            } else {
                Ok("[]".to_string())
            }
        },
        CHAVE_VG,
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
// A chave é do usuário: vive num lugar só (a query string da consulta) e não
// pode vazar para a proposta, para o erro nem para o banco.
// ---------------------------------------------------------------------------
#[test]
fn the_api_key_never_leaves_the_query_string() {
    let (_dir, conn, _folder_id) = setup_with(&[("sem_letra.mp3", "sem_letra.mp3")]);

    let consultas_vg = std::cell::Cell::new(0usize);
    let props = enrich::enrich_scan(
        &conn,
        "",
        enrich::Modo::Completar,
        |url: &str| {
            if url.contains("vagalume") {
                consultas_vg.set(consultas_vg.get() + 1);
                assert!(url.contains(CHAVE_VG), "a chave vai na consulta");
                Err(AppError("sem conexão".into()))
            } else {
                Ok("[]".to_string())
            }
        },
        CHAVE_VG,
        ZERO,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap().propostas;
    assert_eq!(consultas_vg.get(), 1, "o Vagalume foi mesmo consultado");
    assert_eq!(
        props[0].error.as_deref(),
        Some("sem conexão"),
        "e o erro que chega à UI não carrega a chave: {:?}",
        props[0].error
    );

    let json = serde_json::to_string(&props).unwrap();
    assert!(!json.contains(CHAVE_VG), "a chave não entra na proposta");

    // ...nem no BANCO DE MÚSICAS: o esquema inteiro (tabelas e colunas) não
    // menciona chave nenhuma. A do usuário fica guardada nas preferências
    // locais do aplicativo, na máquina dela, e nunca é enviada a lugar nenhum
    // além do próprio Vagalume.
    let mut stmt = conn
        .prepare("SELECT ifnull(sql, '') FROM sqlite_master")
        .unwrap();
    let esquema: String = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .map(|t| t.unwrap())
        .collect::<Vec<_>>()
        .join("\n")
        .to_lowercase();
    assert!(
        !esquema.contains("chave") && !esquema.contains("apikey") && !esquema.contains("api_key"),
        "o banco não guarda chave de API: {esquema}"
    );
}

/// QA MÉDIO-6 — e os caminhos de erro NOVOS também não vazam a chave. É
/// justamente a mensagem de "chave recusada" que teria a desculpa de mostrar
/// o valor para ajudar a conferir; ela não mostra.
#[test]
fn none_of_the_new_network_messages_leak_the_key() {
    for mensagem in [
        vagalume::ERRO_CHAVE_RECUSADA,
        "o site de letras pediu para esperar um pouco",
        "o site de letras está fora do ar agora",
        "o site de letras respondeu com erro",
        "sem conexão",
    ] {
        let (_dir, conn, _folder_id) = setup_with(&[("sem_letra.mp3", "sem_letra.mp3")]);
        let props = enrich::enrich_scan(
            &conn,
            "",
            enrich::Modo::Completar,
            |url: &str| {
                if url.contains("vagalume") {
                    Err(AppError(mensagem.into()))
                } else {
                    Ok("[]".to_string())
                }
            },
            CHAVE_VG,
            ZERO,
            SEM_PROGRESSO,
            SEM_CANCELAMENTO,
        )
        .unwrap().propostas;

        assert_eq!(props[0].error.as_deref(), Some(mensagem));
        assert!(
            !serde_json::to_string(&props).unwrap().contains(CHAVE_VG),
            "a chave vazou pela mensagem {mensagem:?}"
        );
    }
}

// ---------------------------------------------------------------------------
// V8/F18 item 4 — procedência: letra do Vagalume entra marcada
// (TXXX:LETRA_ORIGEM = "vagalume", o mesmo valor do tools/curadoria.py), e a
// marca sobrevive ao round-trip pelo indexer.
// ---------------------------------------------------------------------------
#[test]
fn applying_a_vagalume_lyric_records_its_provenance() {
    let (_dir, conn, folder_id) = setup_with(&[("sem_letra.mp3", "sem_letra.mp3")]);
    let song = song_by_suffix(&conn, "sem_letra.mp3");
    let bytes_antes = fs::read(&song.file_path).unwrap();

    let urls = RefCell::new(Vec::new());
    let props = enrich::enrich_scan(
        &conn,
        "",
        enrich::Modo::Completar,
        duas_fontes(
            &urls,
            "[]".into(),
            corpo_vagalume("Instrumental Sem Letra", "Banda Fixture", LETRA_VG),
        ),
        CHAVE_VG,
        ZERO,
        SEM_PROGRESSO,
        SEM_CANCELAMENTO,
    )
    .unwrap().propostas;
    let p = props.iter().find(|p| p.song_id == song.id).expect("proposta");

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
            fonte: Some(p.fonte.clone()), // eco da proposta
            substituir_letra: false,
        }],
    )
    .unwrap();
    assert!(results[0].error.is_none(), "{:?}", results[0].error);

    assert_eq!(
        id3(&song.file_path).get_user_text("LETRA_ORIGEM"),
        Some("vagalume"),
        "a letra do Vagalume entra marcada, como no tools/curadoria.py"
    );
    let gravada = results[0].song.as_ref().unwrap();
    assert!(gravada.has_lyrics);
    assert_eq!(gravada.letra_origem.as_deref(), Some("vagalume"));

    // inviolável: nunca renomeia, nunca move, nunca mexe no áudio
    assert!(Path::new(&song.file_path).is_file(), "mesmo caminho");
    let bytes_depois = fs::read(&song.file_path).unwrap();
    // o áudio fica no FIM do arquivo, depois do bloco ID3v2 que cresceu
    let cauda = |b: &[u8]| b[b.len() - 2048..].to_vec();
    assert_eq!(
        cauda(&bytes_antes),
        cauda(&bytes_depois),
        "os frames de áudio ficam byte a byte iguais"
    );

    // round-trip: o rescan relê a marca do disco
    indexer::scan_folder(&conn, folder_id, |_, _| {}).unwrap();
    assert_eq!(
        song_by_suffix(&conn, "sem_letra.mp3").letra_origem.as_deref(),
        Some("vagalume")
    );
}

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
// proposta do Vagalume (sem levar a letra) NÃO pode marcar o arquivo.
// ---------------------------------------------------------------------------
#[test]
fn declaring_vagalume_without_a_new_lyric_marks_nothing() {
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
            fonte: Some("Vagalume".into()),
            substituir_letra: false,
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
// Proposta obsoleta continua sendo recusada — inclusive a do Vagalume, que é
// a que traz letra oficial e teria o efeito mais destrutivo (QA A5).
// ---------------------------------------------------------------------------
#[test]
fn a_stale_vagalume_proposal_is_refused() {
    let (_dir, conn, _folder_id) = setup_with(&[("sem_letra.mp3", "sem_letra.mp3")]);
    let song = song_by_suffix(&conn, "sem_letra.mp3");

    let results = enrich::apply(
        &conn,
        &[EnrichApply {
            song_id: song.id,
            title: song.title.clone(),
            artist: song.artist.clone(),
            lyrics: Some(LETRA_VG.into()),
            add_temas: None,
            current_title: "o que a varredura viu, e já não é".into(),
            current_artist: song.artist.clone(),
            fonte: Some("Vagalume".into()),
            substituir_letra: false,
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
// V8/F17+F18 — o instrumental sai das etapas de LETRA (LRCLIB e Vagalume),
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
        enrich::Modo::Completar,
        duas_fontes(
            &urls,
            // stub que casaria PERFEITAMENTE, se fosse consultado
            format!(
                r#"[{{"trackName":"Doce Prelúdio","artistName":"Falamansa",
                     "duration":{},"plainLyrics":"letra da versão cantada"}}]"#,
                song.duration_seconds.unwrap_or(0)
            ),
            corpo_vagalume("Doce Prelúdio", "Falamansa", LETRA_VG),
        ),
        CHAVE_VG,
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

/// ...e o instrumental que já tem título E artista sai da varredura inteira:
/// a letra não conta para ele, então não há o que completar (a economia
/// prometida pela F17).
#[test]
fn an_instrumental_with_both_names_is_not_even_a_candidate() {
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
        enrich::Modo::Completar,
        duas_fontes(
            &urls,
            "[]".into(),
            corpo_vagalume("Instrumental Sem Letra", "Banda Fixture", LETRA_VG),
        ),
        CHAVE_VG,
        ZERO,
        |done, total, _, _| eventos.borrow_mut().push((done, total)),
        SEM_CANCELAMENTO,
    )
    .unwrap().propostas;

    assert!(props.is_empty());
    assert!(urls.borrow().is_empty());
    assert_eq!(*eventos.borrow(), vec![(0, 0)], "não entra nem na contagem");
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
        duas_fontes(
            &urls,
            "[]".into(),
            corpo_vagalume("Instrumental Sem Letra", "Banda Fixture", LETRA_VG),
        ),
        CHAVE_VG,
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
    assert_eq!(p.fonte, "Vagalume");
    assert_eq!(p.lyrics.as_deref(), Some(LETRA_VG));

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
            enrich::ETAPA_VAGALUME,
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
        duas_fontes(&urls, "[]".into(), corpo_vagalume("x", "y", "z")),
        CHAVE_VG,
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
        duas_fontes(&urls, "[]".into(), corpo_vagalume("x", "y", "z")),
        CHAVE_VG,
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
    // e o Vagalume, que exige título E artista reais, passa a ser consultado
    assert!(
        !urls_de(&urls, "vagalume").is_empty(),
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
        SEM_CHAVE,
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
        duas_fontes(
            &urls,
            "[]".into(),
            corpo_vagalume("Instrumental Sem Letra", "Banda Fixture", LETRA_VG),
        ),
        CHAVE_VG,
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
        CHAVE_VG,
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
        SEM_CHAVE,
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
        CHAVE_VG,
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
//   1 etiquetas/nome → 2 impressão digital → 3 LRCLIB → 4 Vagalume
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
    vagalume_body: &'a str,
) -> impl Fn(&str) -> Result<String, AppError> + 'a {
    move |url: &str| {
        urls.borrow_mut().push(url.to_string());
        if url.starts_with(cancioneiro_lib::fingerprint::LOOKUP_URL) {
            Ok(acoustid_body.to_string())
        } else if url.starts_with(vagalume::SEARCH_URL) {
            Ok(vagalume_body.to_string())
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

fn scan_com<S: enrich::Fontes>(
    conn: &Connection,
    modo: enrich::Modo,
    fontes: S,
    chave_vagalume: &str,
) -> Vec<enrich::EnrichProposal> {
    enrich::enrich_scan(
        conn,
        "",
        modo,
        fontes,
        chave_vagalume,
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
        enrich::Modo::Completar,
        ComSom::nova(
            roteador(
                &urls,
                &acoustid(0.95, "Viver Feliz", "Nilson Chaves", dur),
                &letra,
                "{}",
            ),
            dur,
        ),
        SEM_CHAVE,
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
        enrich::Modo::Completar,
        ComSom::nova(
            roteador(
                &urls,
                &acoustid(0.95, "Viver Feliz", "Nilson Chaves", dur),
                &letra,
                "{}",
            ),
            dur,
        ),
        SEM_CHAVE,
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
            enrich::Modo::Completar,
            ComSom::nova(roteador(&urls, &corpo, "[]", "{}"), dur),
            SEM_CHAVE,
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
        enrich::Modo::Completar,
        ComSom::nova(
            roteador(
                &urls,
                &acoustid(0.95, "Viver Feliz", "Nilson Chaves", dur),
                "[]",
                "{}",
            ),
            dur,
        ),
        CHAVE_VG,
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
    assert!(urls_para(&urls, vagalume::SEARCH_URL).is_empty());
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
        enrich::Modo::Completar,
        ComSom::nova(
            roteador(
                &urls,
                &acoustid(0.95, "Cantiga do Sabia", "Milionario y Jose Rico", dur),
                "[]",
                "{}",
            ),
            dur,
        ),
        SEM_CHAVE,
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
// Modo CONFERÊNCIA — inclui as músicas completas, e só pergunta ao som
// ---------------------------------------------------------------------------
#[test]
fn a_conferencia_alcanca_a_musica_completa_que_a_varredura_normal_nao_ve() {
    let (_dir, conn, _f) = setup_with(&[("com_letra.mp3", "com_letra.mp3")]);
    let song = song_by_suffix(&conn, "com_letra.mp3");
    let dur = song.duration_seconds.unwrap() as f64;
    assert!(song.has_lyrics && song.artist.is_some(), "a fixture é completa");

    // varredura de COMPLETAR: a música completa não entra, nem gasta rede
    let urls = RefCell::new(Vec::new());
    let props = scan_com(
        &conn,
        enrich::Modo::Completar,
        ComSom::nova(
            roteador(&urls, &acoustid(0.95, "Outra Coisa", "Outro Artista", dur), "[]", "{}"),
            dur,
        ),
        SEM_CHAVE,
    );
    assert!(props.is_empty(), "completar não olha música completa");
    assert!(urls.borrow().is_empty(), "e não gasta rede com ela");

    // CONFERÊNCIA: entra, e o som denuncia a etiqueta
    let urls = RefCell::new(Vec::new());
    let props = scan_com(
        &conn,
        enrich::Modo::Conferencia,
        ComSom::nova(
            roteador(&urls, &acoustid(0.95, "Outra Coisa", "Outro Artista", dur), "[]", "{}"),
            dur,
        ),
        CHAVE_VG,
    );
    let p = props
        .iter()
        .find(|p| p.song_id == song.id)
        .expect("a conferência alcança a música completa");
    assert!(p.conflito.is_some());

    // a conferência é UM trabalho: perguntar ao som. Nenhuma etapa de letra.
    assert_eq!(
        urls_para(&urls, cancioneiro_lib::fingerprint::LOOKUP_URL).len(),
        1
    );
    assert!(urls_para(&urls, cancioneiro_lib::lyrics_fetch::SEARCH_URL).is_empty());
    assert!(urls_para(&urls, vagalume::SEARCH_URL).is_empty());
}

/// A contagem prévia é a MESMA regra da varredura, nos dois modos (o defeito
/// ALTO-2 foi uma segunda cópia da regra divergindo em silêncio).
#[test]
fn a_contagem_previa_acompanha_o_modo() {
    let (_dir, conn, _f) = setup_with(&[
        ("com_letra.mp3", "com_letra.mp3"),
        ("sem_tags.mp3", "Falamansa - Oh! Chuva.mp3"),
    ]);
    assert_eq!(
        enrich::count_candidatas(&conn, "", enrich::Modo::Completar).unwrap(),
        1,
        "completar só olha a incompleta"
    );
    assert_eq!(
        enrich::count_candidatas(&conn, "", enrich::Modo::Conferencia).unwrap(),
        2,
        "a conferência olha todas as disponíveis"
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
        enrich::Modo::Completar,
        ComSom::nova(
            roteador(
                &urls,
                &acoustid(0.95, "Frevo Nº 1", "Orquestra Popular", dur),
                r#"[{"trackName":"x","artistName":"y","duration":1,"plainLyrics":"letra alheia"}]"#,
                "{}",
            ),
            dur,
        ),
        CHAVE_VG,
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
        enrich::Modo::Completar,
        // um simples fetcher: sem etapa 2 (é o padrão do `Fontes`)
        |url: &str| {
            urls.borrow_mut().push(url.to_string());
            Ok("[]".to_string())
        },
        SEM_CHAVE,
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
        enrich::Modo::Conferencia,
        fontes,
        SEM_CHAVE,
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
        enrich::Modo::Conferencia,
        fontes,
        SEM_CHAVE,
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
/// faltava: para o Vagalume só `ERRO_CHAVE_RECUSADA` desligava a etapa, para
/// o som qualquer erro desligava.
#[test]
fn chave_recusada_pelo_acoustid_desliga_a_etapa_e_conta_o_resto() {
    let (_dir, conn, _f) = setup_with(&[
        ("sem_tags.mp3", "a - um.mp3"),
        ("sem_tags.mp3", "b - dois.mp3"),
        ("sem_tags.mp3", "c - tres.mp3"),
    ]);
    let urls = RefCell::new(Vec::new());
    let recusa = format!(
        r#"{{"status": "error", "error": {{"message": "invalid api key"}}}}"#
    );
    // o `consultar_acoustid` transforma status=error em ERRO_RESPOSTA; para
    // exercitar a RECUSA usamos o fetcher devolvendo o erro nomeado
    let fontes = ComSom::nova(
        move |url: &str| {
            urls.borrow_mut().push(url.to_string());
            if url.starts_with(cancioneiro_lib::fingerprint::LOOKUP_URL) {
                Err(AppError(cancioneiro_lib::fingerprint::ERRO_CHAVE_RECUSADA.into()))
            } else {
                Ok(recusa.clone())
            }
        },
        180.0,
    );
    let r = enrich::enrich_scan(
        &conn,
        "",
        enrich::Modo::Conferencia,
        fontes,
        SEM_CHAVE,
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
        enrich::Modo::Conferencia,
        ComSom::nova(
            roteador(&urls, r#"{"status":"ok","results":[]}"#, "[]", "{}"),
            180.0,
        ),
        SEM_CHAVE,
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
    let props = scan_com(&conn, enrich::Modo::Completar, fontes, SEM_CHAVE);
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
        SEM_CHAVE,
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
        enrich::Modo::Completar,
        ComSom::nova(
            roteador(
                &urls,
                &acoustid(0.95, "Viver Feliz", "Nilson Chaves", dur),
                "[]",
                "{}",
            ),
            dur,
        ),
        SEM_CHAVE,
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
        enrich::Modo::Completar,
        ComSom::nova(
            roteador(
                &urls_com,
                &acoustid(0.95, "Asa Branca", "Luiz Gonzaga", dur),
                &letra,
                "{}",
            ),
            dur,
        ),
        SEM_CHAVE,
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
        enrich::Modo::Completar,
        ComSom::nova(
            // o som identifica "Lampejo" (contido no título: não é conflito)
            // e traz o artista que faltava
            roteador(&urls, &acoustid(0.95, "Lampejo", "Adventício", dur), "[]", "{}"),
            dur,
        ),
        SEM_CHAVE,
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
        enrich::Modo::Completar,
        ComSom::nova(
            roteador(
                &urls,
                &acoustid(0.95, "Viver Feliz", "Nilson Chaves", dur),
                &letra,
                "{}",
            ),
            dur,
        ),
        SEM_CHAVE,
    );
    assert_eq!(
        urls_para(&urls, cancioneiro_lib::lyrics_fetch::SEARCH_URL).len(),
        1,
        "com o título vindo do som, um palpite basta"
    );
    assert_eq!(props[0].confidence, "media", "e o teto do som vale");
}
