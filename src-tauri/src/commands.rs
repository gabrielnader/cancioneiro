use crate::db::{self, Folder, Playlist, PlaylistItem, Song};
use crate::error::{AppError, Result};
use crate::indexer;
use rusqlite::Connection;
use serde::Serialize;
use std::collections::HashMap;
use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::{AppHandle, Emitter, Manager, State};

// ---------------------------------------------------------------------------
// Por que alguns comandos são `#[tauri::command(async)]`
// ---------------------------------------------------------------------------
//
// Comando SEM `async` roda na THREAD PRINCIPAL — a mesma que desenha a
// janela. Enquanto ele não volta, o WebView não repinta e não recebe evento
// nenhum: o app inteiro congela e o sistema operacional troca o cursor pelo
// de "ocupado".
//
// Isso passou despercebido até o teste em campo da v0.8.0, e foi relatado
// como "não vi barra de progresso em lugar algum, só o cursor rodando". A
// barra existia, os eventos de progresso estavam sendo emitidos o tempo todo
// e o E2E os cobria — mas o E2E roda contra o mock no navegador, onde não há
// thread principal do Tauri para bloquear. **Nenhuma das quatro suítes podia
// pegar isto**: é um defeito que só existe dentro do binário.
//
// A marca vai em todo comando que pode demorar mais que um quadro de vídeo:
// as duas varreduras do funil (minutos, com rede), a indexação (que percorre
// o disco) e a gravação de etiquetas — `enrich_apply` reescreve dezenas de
// MP3s numa chamada só. Os demais são consultas de milissegundos ao SQLite, e
// pagar uma troca de thread neles só somaria latência.
//
// A regra para quem vier depois: se o comando faz rede, percorre disco ou
// escreve arquivo, ele é `(async)`.
//
// E a metade que faltava na regra (QA B5): **`(async)` não basta se o comando
// disputa o LOCK COMPARTILHADO com um que demora.** O `enrich_apply` segura o
// lock enquanto grava dezenas de MP3s; um comando síncrono que peça o mesmo
// lock nesse meio-tempo bloqueia a thread principal do mesmo jeito, só que
// pela porta do mutex. Quem pode ser chamado durante um lote longo usa
// `scan_conn()` — conexão dedicada quando o banco é um arquivo — e é
// `(async)`. Consulta de milissegundos que a UI só dispara em repouso
// continua no lock, que é o certo: uma conexão nova por tecla digitada seria
// pior.

/// Estado global: conexão SQLite protegida por mutex + caminho do arquivo do
/// banco (quando file-backed), para abrir conexões dedicadas de scan, + o
/// registro das varreduras de enriquecimento em andamento (QA M4).
pub struct Db {
    pub conn: Mutex<Connection>,
    pub path: Option<PathBuf>,
    /// Varreduras de enriquecimento VIVAS, por `scan_id` gerado no frontend:
    /// cada uma tem sua bandeira de cancelamento. A entrada nasce no início da
    /// varredura e morre no fim (inclusive quando ela falha ou é cancelada), de
    /// modo que o mapa não cresce sem limite e cancelar um id desconhecido —
    /// varredura já encerrada, id inventado — é um no-op inofensivo.
    scans: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// V10.4 — os ARQUIVOS de acessório que estão sendo baixados agora.
    ///
    /// É outra coisa que o mapa de cancelamento acima, que é por `download_id`:
    /// aqui a chave é o arquivo, porque o que não pode acontecer duas vezes ao
    /// mesmo tempo é a escrita do MESMO `.parcial`. Ver
    /// `dois_downloads_do_mesmo_arquivo_nao_correm_juntos`.
    downloads: Arc<Mutex<std::collections::HashSet<String>>>,
}

/// V10.4 — a frase de quem clicou duas vezes no mesmo download.
///
/// Ela existe para NÃO acontecer: a tela guarda o download em store global
/// desde esta versão, então voltar a Configurações mostra o que já está
/// rodando em vez de oferecer o botão de novo. Esta é a rede embaixo — e ela
/// diz o que está acontecendo, porque "não foi possível gravar" era exatamente
/// o que a pessoa lia antes.
pub const ERRO_DOWNLOAD_JA_EM_ANDAMENTO: &str =
    "este download já está em andamento — acompanhe o progresso em Configurações";

/// Enquanto este guard existe, o arquivo está travado para downloads novos.
/// A trava sai no `Drop`, então nenhum caminho de saída (erro, cancelamento,
/// pânico) deixa um acessório travado para sempre.
#[derive(Debug)]
pub struct DownloadEmCurso {
    arquivo: String,
    registro: Arc<Mutex<std::collections::HashSet<String>>>,
}

impl Drop for DownloadEmCurso {
    fn drop(&mut self) {
        if let Ok(mut vivos) = self.registro.lock() {
            vivos.remove(&self.arquivo);
        }
    }
}

impl Db {
    pub fn new(conn: Connection, path: Option<PathBuf>) -> Self {
        Db {
            conn: Mutex::new(conn),
            path,
            scans: Mutex::new(HashMap::new()),
            downloads: Arc::new(Mutex::new(std::collections::HashSet::new())),
        }
    }

    /// Reserva o arquivo para ESTE download. `Err` quando já há um em curso.
    fn download_begin(&self, arquivo: &str) -> Result<DownloadEmCurso> {
        let mut vivos = self
            .downloads
            .lock()
            .map_err(|_| AppError("estado dos downloads corrompido (lock poisoned)".into()))?;
        if !vivos.insert(arquivo.to_string()) {
            return Err(AppError(ERRO_DOWNLOAD_JA_EM_ANDAMENTO.into()));
        }
        Ok(DownloadEmCurso {
            arquivo: arquivo.to_string(),
            registro: Arc::clone(&self.downloads),
        })
    }

    fn lock(&self) -> Result<MutexGuard<'_, Connection>> {
        self.conn
            .lock()
            .map_err(|_| AppError("estado do banco corrompido (lock poisoned)".into()))
    }

    /// Registra uma varredura e devolve sua bandeira de cancelamento.
    /// Reiniciar um `scan_id` em uso substitui a bandeira antiga (a nova
    /// varredura nasce não-cancelada).
    ///
    /// Id VAZIO não é registrado: é o "não quero cancelamento" da varredura
    /// de uma música só (V8/F18). Registrá-lo daria a duas chamadas
    /// simultâneas a mesma chave, e faria um `enrich_cancel_scan("")`
    /// perdido derrubar uma varredura que ninguém pediu para parar.
    fn scan_begin(&self, scan_id: &str) -> Result<Arc<AtomicBool>> {
        let flag = Arc::new(AtomicBool::new(false));
        if scan_id.is_empty() {
            return Ok(flag);
        }
        self.scans
            .lock()
            .map_err(|_| AppError("estado das varreduras corrompido (lock poisoned)".into()))?
            .insert(scan_id.to_string(), Arc::clone(&flag));
        Ok(flag)
    }

    /// Desregistra a varredura (fim normal, erro ou cancelamento).
    fn scan_end(&self, scan_id: &str) {
        if let Ok(mut scans) = self.scans.lock() {
            scans.remove(scan_id);
        }
    }

    /// Marca a varredura `scan_id` como cancelada. Id desconhecido é no-op
    /// (nada é registrado — o mapa só guarda varreduras vivas).
    pub fn cancel_scan(&self, scan_id: &str) -> Result<()> {
        let scans = self
            .scans
            .lock()
            .map_err(|_| AppError("estado das varreduras corrompido (lock poisoned)".into()))?;
        if let Some(flag) = scans.get(scan_id) {
            flag.store(true, Ordering::SeqCst);
        }
        Ok(())
    }

    /// Quantas varreduras estão vivas (usado pelos testes de limpeza).
    #[cfg(test)]
    fn scans_vivas(&self) -> usize {
        self.scans.lock().unwrap().len()
    }

    /// Conexão para varreduras longas: dedicada (WAL) quando o banco é um
    /// arquivo, para não bloquear busca/listagem durante o scan; cai no lock
    /// compartilhado quando in-memory (testes).
    fn scan_conn(&self) -> Result<ScanConn<'_>> {
        match &self.path {
            Some(p) => Ok(ScanConn::Owned(db::open_at(p)?)),
            None => Ok(ScanConn::Shared(self.lock()?)),
        }
    }
}

enum ScanConn<'a> {
    Owned(Connection),
    Shared(MutexGuard<'a, Connection>),
}

impl Deref for ScanConn<'_> {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        match self {
            ScanConn::Owned(c) => c,
            ScanConn::Shared(g) => g,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ScanProgress {
    pub done: usize,
    pub total: usize,
}

/// Progresso da varredura de enriquecimento (evento `enrich:progress`):
/// `atual` é o NOME BASE do arquivo em processamento (vazio no evento inicial
/// com `done = 0`, emitido só para a UI já mostrar o total).
///
/// `etapa` (V8/F18) nomeia a etapa do funil em curso, já em pt-BR e pronta
/// para exibir: `"preparando"`, `"lendo etiquetas e nome do arquivo"`,
/// `"procurando no LRCLIB"`, `"procurando no lyrics.ovh"` ou `"concluída"` (as
/// constantes `enrich::ETAPA_*`). O PRD V8 pede status sempre visível "com
/// contagem e barra, a etapa atual do funil e o arquivo do momento", e uma
/// música sozinha leva segundos entre os palpites no LRCLIB e a consulta ao
/// lyrics.ovh. Só o evento `"concluída"` faz `done` crescer; os demais mudam o
/// texto sem mexer na barra.
///
/// `scan_id` (QA M4) identifica a varredura que emitiu o evento: sem ele, uma
/// varredura antiga que ainda não morreu embaralhava a barra de progresso da
/// varredura nova. A UI ignora eventos de um id que não é o dela.
#[derive(Debug, Clone, Serialize)]
pub struct EnrichProgress {
    pub done: usize,
    pub total: usize,
    pub atual: String,
    pub etapa: String,
    pub scan_id: String,
}

#[derive(Debug, Serialize)]
pub struct ScanResult {
    pub indexed: usize,
    pub skipped: usize,
    pub removed: usize,
    pub total: usize,
    pub missing_folders: Vec<String>,
}

#[tauri::command(async)]
pub fn add_folder(app: AppHandle, state: State<'_, Db>, path: String) -> Result<ScanResult> {
    let conn = state.scan_conn()?;
    let folder_id = db::add_folder(&conn, &path)?;
    let stats = indexer::scan_folder(&conn, folder_id, |done, total| {
        let _ = app.emit("scan:progress", ScanProgress { done, total });
    })?;
    Ok(ScanResult {
        indexed: stats.indexed,
        skipped: stats.skipped,
        removed: stats.removed,
        total: stats.total,
        missing_folders: vec![],
    })
}

#[tauri::command]
pub fn remove_folder(state: State<'_, Db>, folder_id: i64) -> Result<()> {
    let conn = state.lock()?;
    db::remove_folder(&conn, folder_id)
}

#[tauri::command]
pub fn list_folders(state: State<'_, Db>) -> Result<Vec<Folder>> {
    let conn = state.lock()?;
    db::list_folders(&conn)
}

/// Rescan incremental de todas as pastas (rodado na abertura e no botão
/// "Reindexar tudo").
#[tauri::command(async)]
pub fn scan(app: AppHandle, state: State<'_, Db>) -> Result<ScanResult> {
    let conn = state.scan_conn()?;
    let outcome = indexer::scan_all(&conn, |done, total| {
        let _ = app.emit("scan:progress", ScanProgress { done, total });
    })?;
    Ok(ScanResult {
        indexed: outcome.stats.indexed,
        skipped: outcome.stats.skipped,
        removed: outcome.stats.removed,
        total: outcome.stats.total,
        missing_folders: outcome.missing_folders,
    })
}

#[tauri::command]
pub fn list_songs(state: State<'_, Db>) -> Result<Vec<Song>> {
    let conn = state.lock()?;
    db::list_songs(&conn)
}

#[tauri::command]
pub fn search(state: State<'_, Db>, query: String) -> Result<Vec<crate::search::SearchResult>> {
    let conn = state.lock()?;
    crate::search::search(&conn, &query, 200)
}

#[tauri::command]
pub fn get_lyrics(state: State<'_, Db>, song_id: i64) -> Result<Option<String>> {
    let conn = state.lock()?;
    db::get_lyrics(&conn, song_id)
}

/// Usado pelo player antes de tocar: o arquivo ainda existe no disco?
#[tauri::command]
pub fn file_exists(path: String) -> bool {
    Path::new(&path).is_file()
}

// ---------------------------------------------------------------------------
// Playlists (F5)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn create_playlist(state: State<'_, Db>, name: String) -> Result<i64> {
    let conn = state.lock()?;
    db::create_playlist(&conn, &name)
}

#[tauri::command]
pub fn delete_playlist(state: State<'_, Db>, playlist_id: i64) -> Result<()> {
    let conn = state.lock()?;
    db::delete_playlist(&conn, playlist_id)
}

#[tauri::command]
pub fn list_playlists(state: State<'_, Db>) -> Result<Vec<Playlist>> {
    let conn = state.lock()?;
    db::list_playlists(&conn)
}

#[tauri::command]
pub fn get_playlist_items(state: State<'_, Db>, playlist_id: i64) -> Result<Vec<PlaylistItem>> {
    let conn = state.lock()?;
    db::get_playlist_items(&conn, playlist_id)
}

#[tauri::command]
pub fn add_to_playlist(state: State<'_, Db>, playlist_id: i64, song_id: i64) -> Result<i64> {
    let conn = state.lock()?;
    db::add_song_to_playlist(&conn, playlist_id, song_id)
}

#[tauri::command]
pub fn remove_playlist_item(state: State<'_, Db>, item_id: i64) -> Result<()> {
    let conn = state.lock()?;
    db::remove_playlist_item(&conn, item_id)
}

#[tauri::command]
pub fn reorder_playlist(
    state: State<'_, Db>,
    playlist_id: i64,
    item_ids: Vec<i64>,
) -> Result<()> {
    let conn = state.lock()?;
    db::reorder_playlist(&conn, playlist_id, &item_ids)
}

// ---------------------------------------------------------------------------
// Curadoria no player (F10 — PRD V4)
// ---------------------------------------------------------------------------

/// Grava TIT2/TPE1/USLT/TXXX:TEMAS/TXXX:INSTRUMENTAL no MP3 (nunca renomeia,
/// nunca toca o áudio), reindexa o arquivo e devolve a Song atualizada.
///
/// `instrumental` (V8/F17) tem três estados: `true` marca, `false` desmarca e
/// `null` (ausente no JSON) significa "não mexer" — ver writer::write_tags.
///
/// `letra_origem` (V8/F18) é a procedência da letra que está sendo gravada,
/// e o editor a informa quando sabe: `"vagalume"` quando o texto no
/// formulário veio de uma proposta da base comunitária. Ausente = o
/// comportamento de sempre (a marca cai quando a letra muda, porque letra
/// oficial não é transcrição). Existe porque a letra aceita de uma proposta e
/// salva pelo editor perdia, na volta, a marca que o funil tinha acabado de
/// gravar. Ver `writer::write_tags_com_origem`.
#[allow(clippy::too_many_arguments)]
#[tauri::command(async)]
pub fn write_tags(
    state: State<'_, Db>,
    song_id: i64,
    title: String,
    artist: Option<String>,
    lyrics: Option<String>,
    temas: Option<String>,
    instrumental: Option<bool>,
    letra_origem: Option<String>,
) -> Result<Song> {
    let conn = state.lock()?;
    // V10.8 — o `aviso` da gravação (a etiqueta que precisou ser normalizada)
    // NÃO chega ao editor: este comando devolve a Song, e é o que o formulário
    // usa. A escolha está registrada na DECISIONS #152(b), com o motivo — e a
    // GARANTIA do áudio conferido vale igual aqui, porque ela mora no writer, e
    // não no caminho que chamou.
    crate::writer::write_tags_com_origem(
        &conn,
        song_id,
        &title,
        artist.as_deref(),
        lyrics.as_deref(),
        temas.as_deref(),
        instrumental,
        letra_origem.as_deref(),
    )
    .map(|g| g.song)
}

/// Para onde uma requisição do funil pode ir. A lista é FECHADA, e é o que
/// torna o inviolável "nada do acervo sai da máquina" uma garantia
/// executável em vez de uma promessa: um endereço montado errado (ou vindo
/// de dado do próprio acervo) não consegue virar requisição para outro
/// servidor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Destino {
    Lrclib,
    /// lyrics.ovh (V10) — a fonte de letra que tomou o lugar do Vagalume, e
    /// que não pede chave nenhuma.
    LyricsOvh,
    /// AcoustID (V9) — recebe um resumo acústico, nunca o áudio.
    Acoustid,
}

fn destino_de(url: &str) -> Option<Destino> {
    if url.starts_with(crate::lyrics_ovh::SEARCH_URL) {
        Some(Destino::LyricsOvh)
    } else if url.starts_with(crate::lyrics_fetch::SEARCH_URL) {
        Some(Destino::Lrclib)
    } else if url.starts_with(crate::fingerprint::LOOKUP_URL) {
        Some(Destino::Acoustid)
    } else {
        None
    }
}

/// Fetcher real (ureq) do funil, compartilhado por `enrich_folder_scan` e
/// `enrich_song_scan`. GET com timeout de 10 s e User-Agent
/// "Cancioneiro/0.9".
///
/// A primeira coisa que ele faz é conferir o DESTINO: só LRCLIB, lyrics.ovh e
/// AcoustID passam (ver `Destino`).
///
/// 404 no lyrics.ovh é resposta legítima ("não conheço esta música") e vira
/// corpo vazio, que o módulo lê como "sem resultado". Chamar
/// isso de falha de rede transformaria repertório desconhecido em erro na tela
/// do usuário — e num acervo de cobertura ~3% seriam 145 linhas vermelhas
/// acusando a internet de quem está olhando.
///
/// As demais falhas viram mensagens DISTINTAS (ver `mensagem_de_status`).
pub(crate) fn funil_fetcher(url: &str) -> Result<String> {
    let Some(destino) = destino_de(url) else {
        return Err(AppError("endereço de rede não permitido".into()));
    };
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(10))
        .user_agent("Cancioneiro/0.9")
        .build();
    match agent.get(url).call() {
        Ok(resp) => resp
            .into_string()
            .map_err(|_| AppError("sem conexão".into())),
        Err(ureq::Error::Status(404, _)) if destino == Destino::LyricsOvh => Ok(String::new()),
        Err(ureq::Error::Status(status, _)) => {
            Err(AppError(mensagem_de_status(status, destino).into()))
        }
        // transporte: DNS que não resolve, tempo esgotado, conexão recusada.
        // Aqui "sem conexão" é a verdade, e continua sendo o texto.
        Err(_) => Err(AppError("sem conexão".into())),
    }
}

/// O que dizer a quem está olhando a tela quando o servidor RESPONDEU, mas
/// não com o que se pediu.
///
/// Dizer "sem conexão" para tudo (o que este fetcher fazia) manda a pessoa
/// investigar a própria internet, que está ótima, e repete a acusação errada
/// em cada uma das linhas da varredura. As frases são curtas, sem jargão e
/// sem número de código solto — quem cura são ~40 pessoas que não abrem
/// terminal e não têm a quem perguntar; esta frase é a explicação inteira.
///
/// Cada destino fala de si: chamar o AcoustID de "site de letras" seria
/// mandar a pessoa procurar defeito no lugar errado — ele não devolve letra
/// nenhuma.
///
/// São TEXTO FIXO, sem interpolação: é o que garante que a chave do AcoustID
/// (a única que o produto tem, e ela é NOSSA) nunca apareça numa mensagem de
/// erro.
fn mensagem_de_status(status: u16, destino: Destino) -> &'static str {
    match (status, destino) {
        // a chave do AcoustID é NOSSA e vem compilada: não há nada que a pessoa
        // possa fazer, e mandá-la conferir uma chave que ela nunca digitou
        // seria mandá-la procurar defeito onde não há
        (401 | 403, Destino::Acoustid) => crate::fingerprint::ERRO_CHAVE_RECUSADA,
        // O lyrics.ovh não tem chave NENHUMA — é a razão de ele existir no
        // funil —, e cai com frequência: toda falha dele fala de
        // indisponibilidade, nunca de cadastro. A frase precisa ser DELE, e
        // não a genérica do "site de letras", para a pessoa não procurar
        // defeito no site errado. Ela também NÃO desliga a etapa: o funil
        // registra o erro daquela música e segue (QA A2).
        (_, Destino::LyricsOvh) => crate::lyrics_ovh::ERRO_FORA_DO_AR,
        // o LRCLIB não tem chave nenhuma: 401/403 lá é outra coisa
        (429, Destino::Acoustid) => "o reconhecimento pelo som pediu para esperar um pouco",
        (500..=599, Destino::Acoustid) => "o reconhecimento pelo som está fora do ar agora",
        (_, Destino::Acoustid) => crate::fingerprint::ERRO_RESPOSTA,
        (429, _) => "o site de letras pediu para esperar um pouco",
        (500..=599, _) => "o site de letras está fora do ar agora",
        (_, _) => "o site de letras respondeu com erro",
    }
}

// ---------------------------------------------------------------------------
// Acessórios (F18 fase 2 — PRD V9)
// ---------------------------------------------------------------------------

/// O endereço é do lançamento de acessórios?
///
/// Função à parte, e não um `if` dentro do fetcher, para a suíte poder
/// exercitar a trava sem abrir conexão nenhuma: um teste que "confirma" o
/// endereço legítimo chamando o fetcher baixaria 13 MB de binário a cada
/// rodada de CI.
fn destino_de_acessorio_permitido(url: &str) -> bool {
    url.starts_with(crate::acessorios::URL_BASE)
}

/// Fetcher real dos acessórios. Ponto de rede SEPARADO do funil, e com a
/// mesma disciplina: só o lançamento de acessórios passa.
///
/// A trava vale para o endereço que NÓS montamos. O GitHub responde a esse
/// endereço com um redirecionamento para o próprio armazenamento dele, e o
/// `ureq` o segue — é assim que um download do GitHub funciona. Isso não
/// abre porta nenhuma: quem escolhe o destino inicial é o catálogo compilado,
/// nada do acervo é enviado, e o que chega é conferido byte a byte pelo
/// SHA-256 antes de virar arquivo executável. **A soma é a autoridade, não a
/// origem** — é ela que torna o redirecionamento inofensivo.
///
/// Sem timeout total: são 5 MB numa conexão que pode ser ruim, e derrubar o
/// download aos 10 s seria transformar internet lenta em defeito. O que
/// existe é timeout de CONEXÃO, e o cancelamento da pessoa, que é verificado
/// a cada pedaço.
fn acessorio_fetcher(url: &str) -> Result<crate::acessorios::Corpo> {
    if !destino_de_acessorio_permitido(url) {
        return Err(AppError("endereço de rede não permitido".into()));
    }
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(15))
        .user_agent("Cancioneiro/0.9")
        .build();
    let resp = agent.get(url).call().map_err(|e| match e {
        ureq::Error::Status(404, _) => AppError(
            "o arquivo não está mais disponível para download nesta versão do aplicativo".into(),
        ),
        ureq::Error::Status(status, _) if (500..=599).contains(&status) => {
            AppError("o servidor de downloads está fora do ar agora".into())
        }
        ureq::Error::Status(_, _) => AppError("o servidor de downloads respondeu com erro".into()),
        _ => AppError("sem conexão".into()),
    })?;
    let total = resp
        .header("Content-Length")
        .and_then(|v| v.parse::<u64>().ok());
    Ok(crate::acessorios::Corpo {
        total,
        bytes: Box::new(resp.into_reader()),
    })
}

// ---------------------------------------------------------------------------
// Enriquecimento em lote (F13 — PRD V5)
// ---------------------------------------------------------------------------

/// Cortesia com as APIs entre consultas — das DUAS fontes.
const PAUSA_CORTESIA: std::time::Duration = std::time::Duration::from_millis(300);

/// Emissor de `enrich:progress` para uma varredura (por `scan_id`).
fn emissor_de_progresso(
    app: AppHandle,
    scan_id: String,
) -> impl Fn(usize, usize, &str, &str) {
    move |done, total, atual, etapa| {
        let _ = app.emit(
            "enrich:progress",
            EnrichProgress {
                done,
                total,
                atual: atual.to_string(),
                etapa: etapa.to_string(),
                scan_id: scan_id.clone(),
            },
        );
    }
}

/// Passa TODAS as músicas disponíveis sob `folder_prefix` (vazio = biblioteca
/// inteira) pelo funil — etiquetas/nome do arquivo → som (AcoustID) → LRCLIB →
/// lyrics.ovh — e devolve as propostas para a UI de revisão.
///
/// V10 — não há mais modo, e o portão de completude saiu da porta de entrada
/// (DECISIONS #102): as etapas 1 e 2 rodam em todas, as de letra só em quem não
/// tem letra. **Nenhum parâmetro de credencial**: o Vagalume, que era a única
/// etapa a exigir chave do usuário, saiu (DECISIONS #110), e a do AcoustID é
/// nossa e vem compilada. Há teste que falha se alguém acrescentar um.
///
/// Ponto de rede EXPLÍCITO acionado pelo usuário (a seção de curadoria em
/// Configurações); pausa de cortesia de 300 ms entre consultas, valendo para
/// todas as fontes. Erro de rede por música vira proposta com
/// `error` — o lote nunca aborta. Usa conexão dedicada (scan_conn) para não
/// travar busca/listagem durante a varredura, que dura minutos.
///
/// Emite `enrich:progress` (EnrichProgress) a cada etapa e a cada música
/// concluída — no acervo real são minutos de varredura, e o invoke sozinho
/// não dá sinal de vida. Todo evento carrega o `scan_id` (gerado pelo
/// frontend) para a UI descartar o que vier de uma varredura antiga.
///
/// Cancelável por `enrich_cancel_scan(scan_id)`: a varredura verifica a
/// bandeira entre músicas e antes de cada consulta, e volta cedo com as
/// propostas que já tiver.
///
/// **A resposta é um OBJETO, não a lista de propostas** (mudou na correção do
/// QA A2): `{ propostas, sem_perguntar_ao_som }`. O segundo campo conta as
/// músicas que teriam sido perguntadas ao som e não foram, porque a etapa 2
/// se desligou no meio — sem ele, a tela mostrava uma linha de erro e o
/// silêncio das outras, e o silêncio era lido como aprovação (DECISIONS #86).
/// Zero é o caso normal e não merece texto na tela.
#[tauri::command(async)]
pub fn enrich_folder_scan(
    app: AppHandle,
    state: State<'_, Db>,
    folder_prefix: String,
    scan_id: String,
) -> Result<crate::enrich::EnrichScanResult> {
    let cancel = state.scan_begin(&scan_id)?;
    let fontes = fontes_do_funil(&app);
    let progresso = emissor_de_progresso(app, scan_id.clone());
    let resultado = (|| {
        let conn = state.scan_conn()?;
        crate::enrich::enrich_scan(
            &conn,
            &folder_prefix,
            fontes,
            PAUSA_CORTESIA,
            progresso,
            || cancel.load(Ordering::SeqCst),
        )
    })();
    state.scan_end(&scan_id); // a entrada morre sempre — o mapa não cresce
    resultado
}

/// Quantas músicas a varredura de `folder_prefix` (vazio = biblioteca
/// inteira) vai olhar, para a tela poder dizer o tamanho do trabalho ANTES de
/// a pessoa mandar começar. Sem rede, sem gravação: é a mesma
/// `enrich::candidata` da varredura, contada (QA ALTO-2 — havia uma segunda
/// cópia da regra em TypeScript, já divergente).
///
/// É `(async)` e usa CONEXÃO DEDICADA (QA B5). Era síncrono e pegava o lock
/// compartilhado — o mesmo que o `enrich_apply` segura enquanto grava dezenas
/// de MP3s —, então uma contagem disparada durante a gravação parava a thread
/// que desenha a janela até o lote terminar. É a DECISIONS #92 entrando pela
/// porta do mutex em vez da porta do comando síncrono, e a V9 dispara esta
/// contagem mais vezes (a cada troca de pasta e de modo). Ela lê a biblioteca
/// inteira: percorrer o banco já basta para o `(async)`.
#[tauri::command(async)]
pub fn enrich_count(
    app: AppHandle,
    state: State<'_, Db>,
    folder_prefix: String,
) -> Result<crate::enrich::Contagem> {
    let etapas = etapas_ligadas(&app);
    let conn = state.scan_conn()?;
    crate::enrich::contar(&conn, &folder_prefix, etapas)
}

/// **A segunda porta da etapa 5**: quantas e quais músicas de `folder_prefix`
/// (vazio = biblioteca inteira) estão sem letra, e quanto tempo transcrevê-las
/// leva NESTA máquina.
///
/// V10.6 — existe porque "quais músicas estão sem letra" é fato PERMANENTE da
/// biblioteca, e estava amarrado ao resultado de uma varredura: a oferta só
/// vivia dentro da caixa de revisão, e fechar a caixa (aplicar, Esc, mandar
/// para segundo plano) jogava a lista fora. Recuperá-la custava a varredura
/// inteira — minutos, num acervo grande. O banco sempre soube responder isto.
///
/// Sem rede e sem gravação, como a `enrich_count`. `(async)` e com CONEXÃO
/// DEDICADA pelo mesmo motivo dela (QA B5): ela lê a biblioteca inteira, e
/// pegar o lock compartilhado enquanto o `enrich_apply` grava dezenas de MP3s
/// pararia a thread que desenha a janela (DECISIONS #92).
#[tauri::command(async)]
pub fn transcricao_pendentes(
    app: AppHandle,
    state: State<'_, Db>,
    folder_prefix: String,
) -> Result<crate::enrich::PendentesDaTranscricao> {
    // O modelo que vale AQUI, porque é dele que sai o tempo: o preferido que
    // estiver pronto, e o oferecido enquanto nenhum está (V10.2). A mesma
    // escolha do `fontes_do_funil`, que é quem monta a pergunta do fim.
    let modelo = diretorio_de_cache(&app).map_or_else(
        |_| crate::transcricao::modelo_oferecido(),
        |cache| crate::transcricao::modelo_desta_maquina(&cache),
    );
    // e o "posso transcrever" sai da MESMA função que a contagem usa: combinar
    // dois estados de acessório é regra, e regra duplicada diverge (#80)
    let disponivel = etapas_ligadas(&app).transcricao;
    let conn = state.scan_conn()?;
    crate::enrich::pendentes_da_transcricao(&conn, &folder_prefix, modelo, disponivel)
}

/// Quais etapas realmente rodam NESTA máquina, nesta build.
///
/// A tela lista o que esta máquina faz, não o que o produto sabe fazer
/// (DECISIONS #101): sem o acessório baixado a etapa não aparece no funil,
/// porque listá-la seria prometer trabalho que não vai acontecer. E o custo da
/// varredura depende exatamente disto — a etapa 2 são 2 s por música, medidos
/// em campo, e numa pasta de 150 músicas são cinco minutos que a pessoa
/// precisa saber ANTES.
fn etapas_ligadas(app: &AppHandle) -> crate::enrich::EtapasLigadas {
    let cache = diretorio_de_cache(app).ok();
    crate::enrich::EtapasLigadas {
        som: fpcalc_pronto(app).is_some()
            && !crate::fingerprint::chave_acoustid().trim().is_empty(),
        transcricao: cache
            .as_deref()
            .and_then(crate::transcricao::acessorios_prontos)
            .is_some(),
    }
}

/// O MESMO funil, numa música só: o "completar dados desta música" do editor
/// (PRD V8/F18). Devolve `null` quando procuramos e não veio nada novo. Nada
/// é gravado aqui; a proposta devolvida entra no mesmo `enrich_apply` do
/// lote.
///
/// Ao contrário do lote, esta porta NÃO pula a música completa (QA ALTO-3b):
/// quem apertou o botão está olhando aquele arquivo e quer uma segunda
/// opinião. `title`/`artist` são o que está no formulário do editor naquele
/// momento e, quando vêm, mandam na consulta — o backend procurava pela
/// etiqueta velha do banco enquanto a pessoa já tinha digitado o nome certo
/// (QA ALTO-3a). Os dois são opcionais: sem eles vale o que está no banco.
///
/// `scan_id` é OPCIONAL porque o caso pontual do editor são segundos, não
/// minutos: quem não manda um id não ganha cancelamento e recebe os eventos
/// de progresso com `scan_id` vazio (que a UI já descarta, por serem de uma
/// varredura que não é a dela). Quem manda um id ganha os dois, pelo mesmo
/// `enrich_cancel_scan(scan_id)` do lote.
#[tauri::command(async)]
pub fn enrich_song_scan(
    app: AppHandle,
    state: State<'_, Db>,
    song_id: i64,
    scan_id: Option<String>,
    title: Option<String>,
    artist: Option<String>,
) -> Result<Option<crate::enrich::EnrichProposal>> {
    let scan_id = scan_id.unwrap_or_default();
    let cancel = state.scan_begin(&scan_id)?;
    let fontes = fontes_do_funil(&app);
    let progresso = emissor_de_progresso(app, scan_id.clone());
    let resultado = (|| {
        let conn = state.scan_conn()?;
        crate::enrich::enrich_scan_song(
            &conn,
            song_id,
            title.as_deref(),
            artist.as_deref(),
            fontes,
            PAUSA_CORTESIA,
            progresso,
            || cancel.load(Ordering::SeqCst),
        )
    })();
    state.scan_end(&scan_id);
    resultado
}

/// Progresso da etapa 5 (evento `transcricao:progresso`).
///
/// `porcento_da_musica` existe porque UMA música leva minutos: uma barra que
/// só anda entre arquivos fica parada tempo demais para parecer viva, e a
/// v0.8.1 já ensinou o custo de deixar a pessoa olhando para uma tela parada.
///
/// `segundos_restantes` é a estimativa do que falta da FILA inteira, pela
/// velocidade medida nesta máquina — `null` enquanto nenhuma música terminou,
/// porque antes disso não há o que medir e um número inventado seria pior que
/// nenhum (DECISIONS #85 e #86).
#[derive(Debug, Clone, Serialize)]
pub struct TranscricaoProgresso {
    pub done: usize,
    pub total: usize,
    pub atual: String,
    pub porcento_da_musica: u8,
    pub segundos_restantes: Option<u64>,
    pub scan_id: String,
}

/// A etapa 5: escreve a letra ouvindo o áudio das músicas pedidas.
///
/// **Comando à parte, e não uma etapa da varredura** (PRD V10). A varredura
/// custa segundos por música; esta custa MINUTOS, e a pergunta só pode ser
/// feita no fim, quando o app já sabe quantas sobraram e quanto tempo isso
/// leva aqui. `song_ids` é exatamente o `sem_letra_no_fim` que
/// `enrich_folder_scan` devolveu — a regra de quem sobrou é uma só, e mora no
/// backend (DECISIONS #80).
///
/// Nada é gravado: o que sai são propostas, para o mesmo `enrich_apply` da
/// varredura. Inclusive a de marcar instrumental, que é o desfecho de uma
/// música cujo áudio foi ouvido até o fim sem voz nenhuma.
///
/// Cancelável por `enrich_cancel_scan(scan_id)`, e o cancelamento é consultado
/// a cada 20 ms DENTRO da música — não entre uma e outra, que aqui seria
/// esperar minutos por um clique.
///
/// `(async)` pela DECISIONS #92, com folga: percorre disco, executa processo e
/// leva horas.
#[tauri::command(async)]
pub fn transcrever_musicas(
    app: AppHandle,
    state: State<'_, Db>,
    song_ids: Vec<i64>,
    scan_id: String,
) -> Result<crate::enrich::TranscricaoResultado> {
    let cache = diretorio_de_cache(&app)?;
    // Qual modelo roda é decidido AQUI, uma vez por fila: o preferido que
    // estiver pronto, e o outro quando ele não está (V10.2). O `modelo` viaja
    // junto porque é ele que diz sob que chave a medição desta fila é guardada.
    let transcritor = crate::transcricao::acessorios_prontos(&cache)
        .ok_or_else(|| AppError(crate::transcricao::ERRO_SEM_MODELO.into()))?;
    // A pasta de trabalho da decodificação. Fica ao lado do cache dos
    // acessórios, sob o perfil do usuário: é onde o aplicativo já grava 180 MB
    // e onde ele TEM permissão. O acervo nunca recebe arquivo nosso.
    let pasta_temporaria = cache.join("temporarios");
    let cancel = state.scan_begin(&scan_id)?;

    // O relógio da fila: é dele que sai o "faltam N minutos" honesto. Começa
    // antes da primeira música porque é isso que a pessoa está esperando.
    let inicio = std::time::Instant::now();
    let id_evento = scan_id.clone();
    let progresso = |done: usize, total: usize, atual: &str, porcento: u8| {
        // a média por música JÁ FEITA — medição, não referência. Antes da
        // primeira não há o que medir, e um número inventado seria pior que
        // nenhum (DECISIONS #85).
        let segundos_restantes = (done > 0).then(|| {
            let por_musica = inicio.elapsed().as_secs_f64() / done as f64;
            (por_musica * (total - done) as f64).ceil() as u64
        });
        let _ = app.emit(
            "transcricao:progresso",
            TranscricaoProgresso {
                done,
                total,
                atual: atual.to_string(),
                porcento_da_musica: porcento,
                segundos_restantes,
                scan_id: id_evento.clone(),
            },
        );
    };

    let resultado = (|| {
        let conn = state.scan_conn()?;
        crate::enrich::transcricao_scan(
            &conn,
            transcritor.modelo,
            &song_ids,
            |mp3, cancelado, por_musica| {
                crate::transcricao::transcrever(
                    &transcritor.programa,
                    &transcritor.arquivo_do_modelo,
                    mp3,
                    // o WAV temporário vai para a pasta de dados do
                    // aplicativo — NUNCA para o lado do MP3 (ver o cabeçalho
                    // da decodificação em transcricao.rs)
                    &pasta_temporaria,
                    crate::transcricao::IDIOMA,
                    cancelado,
                    por_musica,
                )
            },
            progresso,
            || cancel.load(Ordering::SeqCst),
        )
    })();
    state.scan_end(&scan_id);
    resultado
}

/// Cancela a varredura `scan_id` de verdade (QA M4): a bandeira é lida entre
/// músicas e a varredura volta cedo, parando de consultar o LRCLIB e de emitir
/// progresso. Id desconhecido (varredura já encerrada) é no-op silencioso.
#[tauri::command]
pub fn enrich_cancel_scan(state: State<'_, Db>, scan_id: String) -> Result<()> {
    state.cancel_scan(&scan_id)
}

/// Aplica as propostas aceitas (write_tags por música; nunca renomeia, nunca
/// apaga dados existentes — só preenche/atualiza o que veio). Devolve um
/// resultado por música (`song` = gravada e reindexada; `error` = falhou):
/// falha numa música NÃO aborta o lote, então a UI fica em sincronia com o
/// que realmente foi para o disco.
#[tauri::command(async)]
pub fn enrich_apply(
    state: State<'_, Db>,
    aplicacoes: Vec<crate::enrich::EnrichApply>,
) -> Result<Vec<crate::enrich::EnrichApplyResult>> {
    let conn = state.lock()?;
    crate::enrich::apply(&conn, &aplicacoes)
}

// ---------------------------------------------------------------------------
// As fontes do funil (rede + acessório) montadas para uma varredura
// ---------------------------------------------------------------------------

/// Implementação real de `enrich::Fontes`: a rede pelo `funil_fetcher` e a
/// impressão digital pelo `fpcalc` do cache, quando ele está lá.
struct FontesDoFunil {
    /// `None` = o acessório não está pronto → etapa do som pulada em
    /// SILÊNCIO. É o estado normal de quem ainda não baixou, não um erro.
    fpcalc: Option<PathBuf>,
    chave_acoustid: &'static str,
    /// V10.2 — o modelo que a etapa 5 usaria nesta máquina. A varredura não a
    /// roda, mas é ela que monta a pergunta do fim, e o tempo depende de qual
    /// modelo vai rodar.
    modelo: &'static crate::transcricao::Modelo,
}

impl crate::enrich::Fontes for FontesDoFunil {
    fn buscar(&self, url: &str) -> Result<String> {
        funil_fetcher(url)
    }
    fn reconhece_pelo_som(&self) -> bool {
        self.fpcalc.is_some()
    }
    fn impressao_digital(
        &self,
        mp3: &Path,
        cancelado: &dyn Fn() -> bool,
    ) -> Option<Result<crate::fingerprint::Impressao>> {
        self.fpcalc
            .as_ref()
            .map(|fpcalc| crate::fingerprint::impressao_digital(fpcalc, mp3, cancelado))
    }
    fn chave_acoustid(&self) -> &str {
        self.chave_acoustid
    }
    fn modelo_da_transcricao(&self) -> &'static crate::transcricao::Modelo {
        self.modelo
    }
}

/// Monta as fontes para UMA varredura. A soma do acessório é conferida aqui,
/// uma vez por varredura e não uma vez por música: são milissegundos, e
/// protege contra o arquivo ter sido trocado no disco depois de instalado —
/// o que é conferido antes de executar precisa continuar sendo o que se
/// executa.
fn fontes_do_funil(app: &AppHandle) -> FontesDoFunil {
    FontesDoFunil {
        fpcalc: fpcalc_pronto(app),
        chave_acoustid: crate::fingerprint::chave_acoustid(),
        modelo: diretorio_de_cache(app)
            .map_or_else(
                |_| crate::transcricao::modelo_oferecido(),
                |cache| crate::transcricao::modelo_desta_maquina(&cache),
            ),
    }
}

/// Caminho do `fpcalc` quando ele está no cache E a soma confere. Qualquer
/// outra situação (sem pasta de perfil, acessório ausente, arquivo trocado)
/// devolve `None`, e a etapa some sem dizer nada.
fn fpcalc_pronto(app: &AppHandle) -> Option<PathBuf> {
    let cache = diretorio_de_cache(app).ok()?;
    crate::acessorios::caminho_pronto(crate::acessorios::FPCALC, &cache)
}

/// Pasta de cache dos acessórios, sob o perfil do usuário — a mesma pasta de
/// dados onde vive o banco.
fn diretorio_de_cache(app: &AppHandle) -> Result<PathBuf> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|_| AppError("não foi possível achar a pasta do aplicativo".into()))?;
    Ok(crate::acessorios::diretorio_de_cache(&base))
}

// ---------------------------------------------------------------------------
// Comandos dos acessórios (F18 fase 2 — PRD V9)
// ---------------------------------------------------------------------------

/// Um acessório como a tela precisa vê-lo. Tudo que a regra 1 do PRD V9 pede
/// para dizer ANTES de baixar ("o que vai baixar, quanto ocupa") mais o
/// estado atual.
#[derive(Debug, Clone, Serialize)]
pub struct AcessorioInfo {
    /// Identidade estável, e o que `acessorio_baixar` recebe: "fpcalc".
    pub nome: String,
    /// Para que serve, em pt-BR e pronto para exibir.
    pub para_que_serve: String,
    /// Nome do arquivo, igual no lançamento e no cache.
    pub arquivo: String,
    /// Quanto ocupa, em bytes.
    pub tamanho_bytes: u64,
    /// Quanto tempo o download deve levar, em segundos. A dispensa do tempo
    /// valia para 5 MB; para os 1,5 GB do modelo grande, não vale — sem isto a
    /// tela oferece um download sem dizer se ele leva três minutos ou três
    /// horas.
    ///
    /// V10.4 — o número sai da banda MEDIDA nesta máquina quando ela existe, e
    /// da referência declarada (`acessorios::BANDA_REFERENCIA_BYTES_S`)
    /// enquanto não existe. Qual das duas está na tela é o
    /// `tempo_medido_nesta_maquina` abaixo. Durante o download quem fala é o
    /// `segundos_restantes` do progresso, que é sempre medido.
    pub segundos_estimados: u64,
    /// O `segundos_estimados` acima é MEDIÇÃO desta máquina, ou o número de
    /// fábrica?
    ///
    /// É um FATO sobre o número, e não o número — mesma escolha da
    /// DECISIONS #124 para a razão da transcrição, e pelo mesmo motivo:
    /// mandar a banda para o frontend convidaria o TypeScript a fazer a conta
    /// de novo (DECISIONS #80). Aqui ele decide UMA coisa: se a tela diz
    /// "cerca de X" com a ressalva de conexão lenta, ou sem ela.
    pub tempo_medido_nesta_maquina: bool,
    /// "ausente" | "pronto" | "corrompido" | "indisponivel".
    pub estado: String,
    /// É um PROGRAMA que o aplicativo executa (`true`) ou um DADO que ele só
    /// lê (`false`)? O modelo de transcrição é dado — 180 MB que ninguém
    /// executa —, e a tela precisa poder dizer isso: "um programa de 2 MB e um
    /// arquivo de 180 MB" é uma conversa diferente de "dois programas".
    pub executavel: bool,
    /// De onde ele vem — a "origem só para explicar na tela" do PRD V9.
    pub origem: String,
}

/// Progresso do download (evento `acessorio:progresso`).
///
/// `total` é `null` quando o servidor não anuncia o tamanho: "não sabemos" é
/// um estado, e um zero no lugar seria lido pela barra como 0% de um arquivo
/// vazio (DECISIONS #86).
#[derive(Debug, Clone, Serialize)]
pub struct AcessorioProgresso {
    pub nome: String,
    pub baixados: u64,
    pub total: Option<u64>,
    /// Quanto ainda falta, em segundos, pela velocidade MEDIDA desta conexão
    /// (V10). `null` enquanto a amostra é curta demais para render número
    /// honesto, e quando o servidor não anuncia o tamanho — "não sabemos" é um
    /// estado (DECISIONS #86), e num download de 180 MB um "faltam 0 segundos"
    /// que dura dez minutos é pior que nenhum número.
    pub segundos_restantes: Option<u64>,
    pub download_id: String,
}

/// Desfecho de `acessorio_baixar`. `cancelado` é um CAMPO, e não algo a
/// deduzir do estado: cancelar e falhar em silêncio terminam os dois com o
/// acessório ausente, e a tela precisa saber qual dos dois aconteceu sem
/// adivinhar.
#[derive(Debug, Clone, Serialize)]
pub struct AcessorioDownload {
    pub cancelado: bool,
    pub acessorio: AcessorioInfo,
}

/// Para que serve cada acessório, em pt-BR — aparece cru na tela, como TÍTULO
/// do bloco (`tituloDoAcessorio` põe a maiúscula).
///
/// Régua da DECISIONS #100: a primeira frase diz o que é, o resto só existe se
/// responder a uma pergunta que a pessoa faria naquele momento, e jargão nosso
/// não aparece. Aqui a régua tem um segundo dono: **são dois cartões para uma
/// etapa só** — um programa e um arquivo —, e quem lê não sabe o que é um
/// modelo, nem tem a quem perguntar.
fn para_que_serve(nome: &str) -> &'static str {
    match nome {
        crate::acessorios::FPCALC => "reconhecer a música pelo som",
        crate::acessorios::WHISPER_CLI => "escrever a letra ouvindo o áudio",
        // Duas entradas para uma etapa só, e a frase precisa explicar por quê:
        // são 2 MB de programa e 1,4 GB de dado, e a pessoa vai ver os dois.
        //
        // V10.5 — a frase MUDOU quando o segundo modelo saiu do catálogo. Ela
        // dizia "entender MELHOR o que é cantado — é bem mais lento, e o
        // aplicativo usa este quando ele está aqui", porque a pergunta diante
        // de dois cartões parecidos era "preciso dos dois? qual roda?". Essa
        // pergunta deixou de existir, e uma tela que a responde está falando de
        // um arquivo que não está lá.
        //
        // A pergunta que sobra, diante de um cartão só e de 1,4 GB, é "o que eu
        // perco se não baixar?" — e é essa que a segunda metade responde. Sem
        // dizer "modelo" nem o tamanho: o tamanho já está no cartão logo
        // abaixo.
        crate::acessorios::MODELO_WHISPER_GRANDE => {
            "entender o que é cantado — sem ele o aplicativo não escreve letra \
             nenhuma"
        }
        _ => "",
    }
}

fn info_de(
    acessorio: &crate::acessorios::Acessorio,
    cache: &Path,
    tem_chave: bool,
    banda: Option<u64>,
) -> AcessorioInfo {
    let mut estado = crate::acessorios::estado(acessorio, cache);
    // Sem a chave do AcoustID compilada nesta build, o `fpcalc` não teria o
    // que fazer. Oferecer um download de 5 MB que não pode servir para nada
    // seria pior que não oferecer nada — e "indisponível nesta versão" é
    // exatamente o que está acontecendo.
    //
    // A etapa 5 não depende de chave nenhuma: ela roda LOCAL, que é o que
    // torna aceitável transcrever acervos que o dono do produto não pode ver.
    if !tem_chave && acessorio.nome == crate::acessorios::FPCALC {
        estado = crate::acessorios::Estado::Indisponivel;
    }
    AcessorioInfo {
        nome: acessorio.nome.to_string(),
        para_que_serve: para_que_serve(acessorio.nome).to_string(),
        arquivo: acessorio.arquivo.to_string(),
        tamanho_bytes: acessorio.tamanho_bytes,
        segundos_estimados: crate::acessorios::segundos_estimados(acessorio.tamanho_bytes, banda),
        tempo_medido_nesta_maquina: banda.is_some_and(|b| b > 0),
        estado: estado.como_texto().to_string(),
        executavel: acessorio.executavel,
        origem: acessorio.url(),
    }
}

/// Os acessórios que existem para ESTE computador, com o estado de cada um.
///
/// Lista vazia significa que não publicamos binário para esta plataforma — e
/// a tela deve dizer isso, em vez de oferecer um download que não serviria.
///
/// É `(async)` porque confere a soma dos arquivos do cache: lê alguns MB de
/// disco, e comando síncrono roda na thread que desenha a janela
/// (DECISIONS #92).
#[tauri::command(async)]
pub fn acessorios_estado(app: AppHandle, state: State<'_, Db>) -> Result<Vec<AcessorioInfo>> {
    let cache = diretorio_de_cache(&app)?;
    let tem_chave = !crate::fingerprint::chave_acoustid().is_empty();
    let banda = banda_desta_maquina(&state);
    Ok(crate::acessorios::catalogo_desta_maquina()
        .into_iter()
        .map(|a| info_de(a, &cache, tem_chave, banda))
        .collect())
}

/// A banda que esta máquina já mediu, ou `None`.
///
/// Falha de banco NÃO derruba a tela de acessórios: sem o número medido vale a
/// referência, que é exatamente o estado de quem nunca baixou nada. Uma
/// estimativa é conveniência, e conveniência não bloqueia o único caminho de
/// entrada de um recurso (DECISIONS #80).
fn banda_desta_maquina(state: &Db) -> Option<u64> {
    let conn = state.lock().ok()?;
    db::banda_medida(&conn).ok().flatten().map(|b| b as u64)
}

/// Baixa o acessório `nome`, confere a soma e o instala. Nada baixa sozinho:
/// este comando só existe porque alguém clicou depois de ler o que ia
/// baixar e quanto ocupava.
///
/// Emite `acessorio:progresso` a cada pedaço, com o `download_id` que o
/// frontend gerou — a mesma disciplina do `scan_id` do funil, e pelo mesmo
/// motivo: um download antigo não pode embaralhar a barra do novo.
///
/// Cancelável por `acessorio_cancelar(download_id)`, verificado DENTRO do
/// download e não só entre arquivos.
///
/// Devolve o desfecho: `cancelado` diz se a pessoa parou, e `acessorio` traz
/// o estado final. Falha de rede ou soma que não confere viram `Err` com uma
/// frase em pt-BR — e, nos dois casos, nada foi instalado.
#[tauri::command(async)]
pub fn acessorio_baixar(
    app: AppHandle,
    state: State<'_, Db>,
    nome: String,
    download_id: String,
) -> Result<AcessorioDownload> {
    let cache = diretorio_de_cache(&app)?;
    let tem_chave = !crate::fingerprint::chave_acoustid().is_empty();
    let acessorio = crate::acessorios::desta_maquina(&nome)
        .ok_or_else(|| AppError(crate::acessorios::ERRO_ACESSORIO_DESCONHECIDO.into()))?;
    if !tem_chave && acessorio.nome == crate::acessorios::FPCALC {
        return Err(AppError(crate::acessorios::ERRO_INDISPONIVEL.into()));
    }

    // V10.4 — a trava do ARQUIVO vem ANTES de qualquer coisa cara: dois
    // downloads do mesmo acessório escreveriam o mesmo `.parcial`, e o
    // primeiro a terminar troca o arquivo de nome por baixo do segundo. O
    // guard solta sozinho em todo caminho de saída (ver `DownloadEmCurso`).
    let _em_curso = state.download_begin(acessorio.arquivo)?;

    let cancel = state.scan_begin(&download_id)?;
    let nome_evento = acessorio.nome.to_string();
    let id_evento = download_id.clone();
    // O relógio começa aqui, e não no primeiro byte: o que a pessoa espera
    // inclui o tempo de abrir a conexão.
    let inicio = std::time::Instant::now();
    // V10.4 — o último progresso, guardado para a MEDIÇÃO da banda.
    //
    // É o par que o `segundos_restantes` já usava a cada pedaço e que era
    // jogado fora no fim. Tem de ser lido AQUI, e não depois do `baixar`: o
    // que vem depois do último byte é `sync_all` e a releitura de 1,5 GB para
    // conferir a soma — tempo de disco, não de rede. Contá-lo faria a máquina
    // se medir como mais lenta do que é, que é o erro que esta rodada veio
    // consertar.
    let ultimo_progresso = Mutex::new((0u64, std::time::Duration::ZERO));
    let resultado = crate::acessorios::baixar(
        acessorio,
        &cache,
        acessorio_fetcher,
        |baixados, total| {
            let decorridos = inicio.elapsed();
            if let Ok(mut ultimo) = ultimo_progresso.lock() {
                *ultimo = (baixados, decorridos);
            }
            let _ = app.emit(
                "acessorio:progresso",
                AcessorioProgresso {
                    nome: nome_evento.clone(),
                    baixados,
                    total,
                    segundos_restantes: crate::acessorios::segundos_restantes(
                        baixados, total, decorridos,
                    ),
                    download_id: id_evento.clone(),
                },
            );
        },
        || cancel.load(Ordering::SeqCst),
    );
    state.scan_end(&download_id);

    let cancelado = matches!(resultado, Ok(None));
    // A banda é medida no download que CHEGOU AO FIM: um cancelamento ou uma
    // queda no meio mediriam a parte que veio, e a parte que veio de um
    // download interrompido não descreve a conexão (ela costuma ser a rápida,
    // antes de a rede piorar).
    if matches!(resultado, Ok(Some(_))) {
        registrar_banda(&state, &ultimo_progresso);
    }
    resultado?;
    Ok(AcessorioDownload {
        cancelado,
        acessorio: info_de(acessorio, &cache, tem_chave, banda_desta_maquina(&state)),
    })
}

/// Guarda o que este download ensinou sobre a conexão desta máquina.
///
/// Amostra curta demais não vira medição (`acessorios::banda_medida` decide), e
/// falha de banco não derruba um download que deu certo: perder a medição
/// custa uma estimativa de fábrica no próximo download, e nada mais.
fn registrar_banda(state: &Db, ultimo: &Mutex<(u64, std::time::Duration)>) {
    let Ok((bytes, decorridos)) = ultimo.lock().map(|u| *u) else {
        return;
    };
    if crate::acessorios::banda_medida(bytes, decorridos).is_none() {
        return;
    }
    if let Ok(conn) = state.lock() {
        let _ = db::somar_banda(&conn, bytes as f64, decorridos.as_secs_f64());
    }
}

/// Cancela o download `download_id`. Id desconhecido (download já encerrado)
/// é no-op silencioso, igual ao cancelamento de varredura — os dois usam o
/// mesmo registro de trabalhos longos vivos.
#[tauri::command]
pub fn acessorio_cancelar(state: State<'_, Db>, download_id: String) -> Result<()> {
    state.cancel_scan(&download_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn estado() -> Db {
        Db::new(db::open_in_memory().unwrap(), None)
    }

    // -----------------------------------------------------------------------
    // QA M4 — registro de cancelamento: a bandeira nasce baixada, cancelar a
    // levanta, e a entrada some no fim da varredura (o mapa não cresce).
    // -----------------------------------------------------------------------
    #[test]
    fn cancel_scan_raises_the_flag_of_the_running_scan() {
        let state = estado();
        let flag = state.scan_begin("scan-1").unwrap();
        assert!(!flag.load(Ordering::SeqCst), "varredura nasce não-cancelada");

        state.cancel_scan("scan-1").unwrap();
        assert!(flag.load(Ordering::SeqCst), "cancelar levanta a bandeira");

        state.scan_end("scan-1");
        assert_eq!(state.scans_vivas(), 0, "entrada limpa no fim da varredura");
    }

    /// V8/F18 — a varredura de UMA música pode vir sem `scan_id` (o editor
    /// não oferece "Cancelar" para o caso pontual). Id vazio não entra no
    /// mapa: duas chamadas simultâneas não disputariam a mesma chave, e um
    /// `enrich_cancel_scan("")` perdido não derruba varredura nenhuma.
    #[test]
    fn an_empty_scan_id_is_never_registered() {
        let state = estado();
        let flag = state.scan_begin("").unwrap();
        assert_eq!(state.scans_vivas(), 0, "id vazio não entra no mapa");

        state.cancel_scan("").unwrap();
        assert!(!flag.load(Ordering::SeqCst), "e não pode ser cancelado");
        state.scan_end("");
        assert_eq!(state.scans_vivas(), 0);
    }

    #[test]
    fn cancelling_unknown_scan_id_is_a_harmless_no_op() {
        let state = estado();
        // id que nunca existiu
        state.cancel_scan("nunca-existiu").unwrap();
        // id de varredura já encerrada
        state.scan_begin("scan-1").unwrap();
        state.scan_end("scan-1");
        state.cancel_scan("scan-1").unwrap();

        assert_eq!(
            state.scans_vivas(),
            0,
            "cancelar id desconhecido não registra nada (mapa não cresce)"
        );
    }

    #[test]
    fn cancelling_one_scan_does_not_touch_another() {
        let state = estado();
        let a = state.scan_begin("scan-a").unwrap();
        let b = state.scan_begin("scan-b").unwrap();

        state.cancel_scan("scan-a").unwrap();
        assert!(a.load(Ordering::SeqCst));
        assert!(!b.load(Ordering::SeqCst), "cada varredura tem sua bandeira");

        state.scan_end("scan-a");
        state.scan_end("scan-b");
        assert_eq!(state.scans_vivas(), 0);
    }

    // -----------------------------------------------------------------------
    // V10.5 — a tela precisa dizer o que o MODELO é, em uma frase
    // -----------------------------------------------------------------------

    /// **Todo acessório do catálogo tem a sua frase.** O `para_que_serve` vira
    /// o TÍTULO do bloco na tela (`tituloDoAcessorio`); um acessório sem frase
    /// aparece como um cartão sem nome, com um botão de baixar 1,5 GB.
    #[test]
    fn todo_acessorio_do_catalogo_diz_para_que_serve() {
        for a in crate::acessorios::CATALOGO {
            assert!(
                !para_que_serve(a.nome).is_empty(),
                "{} ({}) não tem frase",
                a.nome,
                a.arquivo
            );
        }
    }

    /// **A frase do modelo responde à pergunta que a pessoa faz AGORA — e essa
    /// pergunta mudou (V10.5).**
    ///
    /// *Mudou de propósito, e não por acidente.* Ele exigia que as frases dos
    /// DOIS modelos se distinguissem e que a do grande respondesse "preciso dos
    /// dois? qual roda?". Com um cartão só essa pergunta não existe mais, e
    /// mantê-la respondida seria a tela falando de um arquivo que não está lá.
    /// A pergunta que sobra, diante de um único cartão de 1,4 GB, é **"o que eu
    /// perco se não baixar?"**.
    ///
    /// Régua da DECISIONS #100: a primeira frase diz o que é; o resto só existe
    /// se responder a uma pergunta que a pessoa faria naquele momento; cabe em
    /// 2 frases e 210 caracteres; e jargão nosso não aparece.
    #[test]
    fn a_frase_do_modelo_diz_o_que_ele_faz_e_o_que_falta_sem_ele() {
        let modelo = para_que_serve(crate::acessorios::MODELO_WHISPER_GRANDE);
        let programa = para_que_serve(crate::acessorios::WHISPER_CLI);
        assert_ne!(modelo, programa, "duas frases iguais não distinguem nada");

        for t in [modelo, programa] {
            assert!(
                t.chars().count() <= 210,
                "{} caracteres, o teto é 210: {t:?}",
                t.chars().count()
            );
            assert!(
                t.matches(['.', '!', '?']).count() <= 1,
                "cabe em uma frase — é um TÍTULO de bloco: {t:?}"
            );
            assert!(
                t.chars().next().is_some_and(char::is_lowercase),
                "a tela põe a maiúscula: {t:?}"
            );
            assert!(!t.contains('\n') && !t.contains("  "), "texto corrido: {t:?}");
            for jargao in [
                "modelo", "quantiz", "whisper", "ggml", "transcri", "small",
                "medium", "cache", "acessório", "parâmetro", "byte", "cpu",
            ] {
                assert!(
                    !t.to_lowercase().contains(jargao),
                    "{t:?} tem jargão: {jargao}"
                );
            }
        }
        // a frase não pode mais comparar com um arquivo que saiu do catálogo
        for sumiu in ["melhor", "mais lento", "mais devagar", "rápido", "usa este"] {
            assert!(
                !modelo.contains(sumiu),
                "{modelo:?} compara com o modelo que saiu: {sumiu:?}"
            );
        }
        // e diz o que a pessoa perde sem ele — é o que justifica 1,4 GB
        assert!(
            modelo.contains("sem ele"),
            "a frase precisa dizer o que falta sem este arquivo: {modelo:?}"
        );
    }

    // -----------------------------------------------------------------------
    // QA M4 — o evento enrich:progress carrega a identidade da varredura
    // (snake_case, sem renames: é o contrato com o frontend).
    // -----------------------------------------------------------------------
    #[test]
    fn enrich_progress_event_carries_the_scan_id_and_the_stage() {
        let json = serde_json::to_value(EnrichProgress {
            done: 2,
            total: 7,
            atual: "Falamansa - Oh! Chuva.mp3".into(),
            etapa: crate::enrich::ETAPA_LYRICS_OVH.into(),
            scan_id: "scan-42".into(),
        })
        .unwrap();

        assert_eq!(json["done"], 2);
        assert_eq!(json["total"], 7);
        assert_eq!(json["atual"], "Falamansa - Oh! Chuva.mp3");
        assert_eq!(json["etapa"], "procurando no lyrics.ovh");
        assert_eq!(json["scan_id"], "scan-42");
        // o evento tem exatamente estes cinco campos, em snake_case
        let campos: Vec<&String> = json.as_object().unwrap().keys().collect();
        assert_eq!(campos, ["atual", "done", "etapa", "scan_id", "total"]);
    }

    // -----------------------------------------------------------------------
    // V8/F18 — o vocabulário de `etapa` é FECHADO e estável: a UI traduz cada
    // valor para uma frase em pt-BR, e um valor novo apareceria cru na tela de
    // quem não tem a quem perguntar.
    // -----------------------------------------------------------------------
    #[test]
    fn the_stage_vocabulary_is_closed_and_stable() {
        use crate::enrich::*;
        // na ORDEM em que a pessoa as lê durante uma varredura (V9: a
        // impressão digital passou a vir ANTES das fontes de letra, porque
        // é o nome dela que as alimenta)
        assert_eq!(
            [
                ETAPA_PREPARANDO,
                ETAPA_NOME_ARQUIVO,
                ETAPA_IMPRESSAO_DIGITAL,
                ETAPA_LRCLIB,
                ETAPA_LYRICS_OVH,
                ETAPA_TRANSCRICAO,
                ETAPA_CONCLUIDA
            ],
            [
                "preparando",
                "lendo etiquetas e nome do arquivo",
                "reconhecendo pelo som",
                "procurando no LRCLIB",
                "procurando no lyrics.ovh",
                "escrevendo a letra ouvindo o áudio",
                "concluída"
            ]
        );
        assert_eq!(
            [
                FONTE_NOME_ARQUIVO,
                FONTE_IMPRESSAO_DIGITAL,
                FONTE_LRCLIB,
                FONTE_LYRICS_OVH,
                FONTE_TRANSCRICAO,
                FONTE_ERRO
            ],
            [
                "nome do arquivo",
                "reconhecimento pelo som",
                "LRCLIB",
                "lyrics.ovh",
                "transcrição do áudio",
                "erro"
            ]
        );
    }

    // -----------------------------------------------------------------------
    // V8/F18 — a proposta chega ao frontend com `fonte`, em snake_case e sem
    // renames, junto dos campos que a revisão já usava.
    // -----------------------------------------------------------------------
    #[test]
    fn enrich_proposal_serializes_the_source_of_the_data() {
        let json = serde_json::to_value(crate::enrich::EnrichProposal {
            song_id: 7,
            file_path: "/m/a.mp3".into(),
            current_title: "Faixa 5".into(),
            current_artist: None,
            proposed_title: "Chegança".into(),
            proposed_artist: Some("Antônio Nóbrega".into()),
            lyrics: Some("letra".into()),
            confidence: "alta".into(),
            fonte: crate::enrich::FONTE_LYRICS_OVH.into(),
            has_lyrics: true,
            letra_origem: Some("transcricao".into()),
            substitui_nome_escrito: true,
            conflito: None,
            marcar_instrumental: false,
            refrao: None,
            aviso: None,
            error: None,
        })
        .unwrap();

        assert_eq!(json["fonte"], "lyrics.ovh");
        assert_eq!(json["confidence"], "alta");
        // QA CRÍTICO-1 — a revisão precisa saber que aceitar esta linha
        // SUBSTITUIRIA uma letra, e o que seria sobrescrito
        assert_eq!(json["has_lyrics"], true);
        assert_eq!(json["letra_origem"], "transcricao");
        let campos: Vec<&String> = json.as_object().unwrap().keys().collect();
        assert_eq!(
            campos,
            [
                // V10 — `aviso` explica uma proposta APLICÁVEL (o instrumental
                // que a etapa 5 concluiu), ao contrário de `error`, que
                // descreve uma linha que a pessoa não pode aplicar
                "aviso",
                "confidence",
                "conflito",
                "current_artist",
                "current_title",
                "error",
                "file_path",
                "fonte",
                "has_lyrics",
                "letra_origem",
                "lyrics",
                // V10 — a etapa 5 ouviu o áudio inteiro e não achou voz
                "marcar_instrumental",
                "proposed_artist",
                "proposed_title",
                // V10 — o trecho mais repetido, só para a revisão reconhecer a
                // música de relance
                "refrao",
                "song_id",
                "substitui_nome_escrito",
            ]
        );
        // V9 — a revisão precisa saber que aceitar esta linha trocaria um
        // nome que uma PESSOA escreveu, para não pré-marcá-la
        assert_eq!(json["substitui_nome_escrito"], true);
    }

    /// V9 — o outro lado da divergência atravessa o IPC inteiro: sem os dois
    /// valores, a tela não tem como mostrar os dois lados, e mostrar um lado
    /// só de uma contradição é pior que não mostrar nada.
    #[test]
    fn a_proposta_de_conflito_leva_os_dois_lados_para_a_tela() {
        let json = serde_json::to_value(crate::enrich::EnrichProposal {
            song_id: 7,
            file_path: "/m/a.mp3".into(),
            current_title: "Te ver feliz, te ver contente".into(),
            current_artist: Some("Caetano Veloso".into()),
            proposed_title: "Te ver feliz, te ver contente".into(),
            proposed_artist: Some("Caetano Veloso".into()),
            lyrics: None,
            confidence: "baixa".into(),
            fonte: crate::enrich::FONTE_IMPRESSAO_DIGITAL.into(),
            has_lyrics: true,
            letra_origem: None,
            substitui_nome_escrito: false,
            conflito: Some(crate::enrich::Conflito {
                titulo: "Viver Feliz".into(),
                artista: "Nilson Chaves".into(),
                confianca: "alta".into(),
            }),
            marcar_instrumental: false,
            refrao: None,
            aviso: None,
            error: None,
        })
        .unwrap();

        assert_eq!(json["conflito"]["titulo"], "Viver Feliz");
        assert_eq!(json["conflito"]["artista"], "Nilson Chaves");
        assert_eq!(json["conflito"]["confianca"], "alta");
        assert_eq!(json["fonte"], "reconhecimento pelo som");
        // a etiqueta atual NÃO é corrigida sozinha, e a linha nunca chega
        // pré-marcada (só "alta" é pré-marcada — DECISIONS #49)
        assert_eq!(json["proposed_title"], "Te ver feliz, te ver contente");
        assert_eq!(json["confidence"], "baixa");
        let campos: Vec<&String> = json["conflito"].as_object().unwrap().keys().collect();
        assert_eq!(campos, ["artista", "confianca", "titulo"]);
    }

    /// V10 — **os modos sumiram do contrato de IPC.** Nenhum comando aceita
    /// `modo`, e um payload que ainda o mande é simplesmente ignorado pelo
    /// serde: o frontend antigo não quebra, e a varredura que roda é a única
    /// que existe.
    ///
    /// Modo é escolha, e escolha é pedágio para quem não tem a quem
    /// perguntar. Pior: a conferência era a única coisa que achava etiqueta
    /// errada, e recurso que depende de o usuário adivinhar que existe é
    /// recurso que não existe.
    #[test]
    fn o_contrato_de_ipc_nao_tem_mais_modo_de_varredura() {
        let contagem = crate::enrich::Contagem {
            total: 150,
            sem_letra: 80,
            segundos_estimados: 1_020,
            etapas: vec!["lendo etiquetas e nome do arquivo".into()],
            transcricao_disponivel: false,
        };
        let json = serde_json::to_value(&contagem).unwrap();
        let campos: Vec<&String> = json.as_object().unwrap().keys().collect();
        assert_eq!(
            campos,
            [
                "etapas",
                "segundos_estimados",
                "sem_letra",
                "total",
                "transcricao_disponivel"
            ],
            "a contagem virou objeto: só o total não diz mais o tamanho do trabalho"
        );
        assert!(!json.as_object().unwrap().contains_key("modo"));
    }

    /// **V10.6 — a segunda porta da etapa 5 tem contrato próprio, e ele é o
    /// MESMO trio que a varredura já devolvia.**
    ///
    /// A `Contagem` não recebeu os ids: ela descreve o custo da VARREDURA, e
    /// pendurar nela a lista da etapa 5 poria milhares de ids na resposta que
    /// a tela pede a cada troca de pasta — a conferência que a DECISIONS #125
    /// acabou de tirar do caminho. São duas perguntas, e cada uma tem a sua
    /// porta.
    #[test]
    fn o_contrato_da_porta_permanente_da_etapa_5() {
        let pendentes = crate::enrich::PendentesDaTranscricao {
            musicas: vec![7, 9, 11],
            segundos_estimados: 10_800,
            estimativa_medida_nesta_maquina: true,
            disponivel: true,
        };
        let json = serde_json::to_value(&pendentes).unwrap();
        let campos: Vec<&String> = json.as_object().unwrap().keys().collect();
        assert_eq!(
            campos,
            [
                "disponivel",
                "estimativa_medida_nesta_maquina",
                "musicas",
                "segundos_estimados"
            ],
            "ids, tempo, procedência do tempo e o que esta máquina pode fazer"
        );
        // os ids saem como números, que é o que `transcrever_musicas` recebe
        assert_eq!(json["musicas"], serde_json::json!([7, 9, 11]));

        // e a `Contagem` NÃO ganhou lista nenhuma
        let contagem = serde_json::to_value(crate::enrich::Contagem::default()).unwrap();
        assert!(!contagem.as_object().unwrap().contains_key("musicas"));
    }

    /// O eco de `fonte` é OPCIONAL: um payload sem ele continua válido e vale
    /// como "não sei de onde veio" (a marca de procedência é limpa, nunca
    /// inventada). O mesmo vale para o consentimento de substituir letra:
    /// ausente é NÃO — a omissão nunca pode autorizar uma sobrescrita.
    #[test]
    fn enrich_apply_accepts_the_source_echo_and_survives_without_it() {
        let com: crate::enrich::EnrichApply = serde_json::from_str(
            r#"{"song_id": 7, "title": "T", "artist": null, "lyrics": "L",
                "add_temas": null, "current_title": "T", "current_artist": null,
                "fonte": "Vagalume", "substituir_letra": true}"#,
        )
        .unwrap();
        assert_eq!(com.fonte.as_deref(), Some("Vagalume"));
        assert!(com.substituir_letra);

        let sem: crate::enrich::EnrichApply = serde_json::from_str(
            r#"{"song_id": 7, "title": "T", "artist": null, "lyrics": "L",
                "add_temas": null, "current_title": "T", "current_artist": null}"#,
        )
        .unwrap();
        assert_eq!(sem.fonte, None);
        assert!(!sem.substituir_letra, "ausente = não substituir");
    }

    // -----------------------------------------------------------------------
    // V8/F18 — "nenhuma telemetria, nada do acervo sai da máquina": o único
    // fetcher do funil recusa qualquer destino que não esteja na lista,
    // ANTES de abrir conexão. Roda offline: nenhuma das URLs abaixo chega a
    // virar requisição.
    //
    // V10 — a lista passou a ter QUATRO destinos (o lyrics.ovh entrou), e a
    // regra "rede só em pontos explícitos e enumerados" só vale se a lista
    // estiver certa. O teste inclui um sósia de cada host: um prefixo que
    // "começa igual" é exatamente como um destino não previsto entraria.
    // -----------------------------------------------------------------------
    #[test]
    fn the_fetcher_refuses_any_host_outside_the_enumerated_list() {
        for url in [
            "https://exemplo.invalido/coleta",
            "http://localhost:9/x",
            "file:///etc/passwd",
            "https://lrclib.net.exemplo.invalido/api/search?q=x",
            "https://api.vagalume.com.br.exemplo.invalido/search.php",
            "https://api.acoustid.org.exemplo.invalido/v2/lookup",
            // V10 — os sósias do destino novo
            "https://api.lyrics.ovh.exemplo.invalido/v1/A/B",
            "https://api.lyrics.ovh.br/v1/A/B",
            "http://api.lyrics.ovh/v1/A/B", // sem TLS não passa
            "https://api.lyrics.ovh/v2/A/B", // outra versão do caminho
            "https://lyrics.ovh/v1/A/B",
            // o lançamento de acessórios NÃO é destino do funil: cada
            // fetcher tem a sua lista, e nenhuma empresta para a outra
            crate::acessorios::URL_BASE,
            "",
        ] {
            let err = funil_fetcher(url).expect_err("destino {url} deveria ser recusado");
            assert_eq!(err.to_string(), "endereço de rede não permitido");
        }
    }

    /// ...e os três destinos legítimos passam pela trava (o erro que sobra é
    /// de rede, não de permissão — a suíte roda sem internet).
    ///
    /// V10 — continuam TRÊS, mas o do meio mudou: o Vagalume saiu e o
    /// lyrics.ovh entrou (DECISIONS #110).
    #[test]
    fn the_three_legitimate_destinations_pass_the_guard() {
        for url in [
            crate::lyrics_fetch::SEARCH_URL,
            crate::lyrics_ovh::SEARCH_URL,
            crate::fingerprint::LOOKUP_URL,
        ] {
            if let Err(e) = funil_fetcher(url) {
                assert_ne!(
                    e.to_string(),
                    "endereço de rede não permitido",
                    "{url} é destino legítimo"
                );
            }
        }
    }

    /// V9 — a MESMA disciplina no fetcher dos acessórios, e ela importa mais
    /// aqui do que em qualquer outro lugar: o que este fetcher traz vira
    /// arquivo EXECUTÁVEL na máquina de quem clicou. Só o lançamento de
    /// acessórios passa, e nenhum endereço parecido passa junto. Roda
    /// offline: nenhuma das URLs abaixo chega a virar requisição.
    #[test]
    fn o_fetcher_de_acessorios_so_aceita_o_lancamento_de_acessorios() {
        for url in [
            "https://exemplo.invalido/fpcalc",
            "http://localhost:9/fpcalc",
            "file:///bin/sh",
            // domínio PARECIDO com o do GitHub
            "https://github.com.exemplo.invalido/gabrielnader/cancioneiro/releases/download/acessorios-v1/fpcalc-linux-x86_64",
            // GitHub de verdade, outro repositório
            "https://github.com/outra/pessoa/releases/download/acessorios-v1/fpcalc-linux-x86_64",
            // o repositório certo, mas outro lançamento (a tag é FIXA: é
            // dela que vêm as somas compiladas)
            "https://github.com/gabrielnader/cancioneiro/releases/download/acessorios-v2/fpcalc-linux-x86_64",
            // destinos do funil não valem aqui
            crate::lyrics_fetch::SEARCH_URL,
            crate::lyrics_ovh::SEARCH_URL,
            crate::fingerprint::LOOKUP_URL,
            "",
        ] {
            assert!(
                !destino_de_acessorio_permitido(url),
                "destino {url} deveria ser recusado"
            );
        }
    }

    /// ...e todo endereço do catálogo passa pela trava. Sem o par, a trava
    /// poderia estar recusando tudo e os dois testes continuariam verdes.
    #[test]
    fn os_enderecos_do_catalogo_passam_pela_trava_dos_acessorios() {
        for acessorio in crate::acessorios::CATALOGO {
            assert!(
                destino_de_acessorio_permitido(&acessorio.url()),
                "{} é destino legítimo",
                acessorio.arquivo
            );
        }
    }

    /// O download é registrado no MESMO mapa de trabalhos longos vivos das
    /// varreduras, então ele ganha o cancelamento de graça — e um id
    /// desconhecido continua sendo no-op inofensivo.
    #[test]
    fn o_download_de_acessorio_e_cancelavel_pelo_mesmo_registro() {
        let state = estado();
        let flag = state.scan_begin("download-1").unwrap();
        assert!(!flag.load(Ordering::SeqCst));
        state.cancel_scan("download-1").unwrap();
        assert!(flag.load(Ordering::SeqCst));
        state.scan_end("download-1");
        assert_eq!(state.scans_vivas(), 0);
    }

    // -----------------------------------------------------------------------
    // V10.4 — DOIS DOWNLOADS DO MESMO ARQUIVO NÃO PODEM CONVIVER
    // -----------------------------------------------------------------------
    //
    // Os dois escreveriam o MESMO `.parcial`, e o primeiro a terminar troca o
    // arquivo de nome (ou o apaga, se a soma não bater) por baixo do segundo —
    // que então não acha mais o que conferir. Era o caminho de campo da
    // v0.10.1: a tela perdia o download ao sair de Configurações, a pessoa
    // voltava, clicava de novo, e o segundo download morria com uma frase que
    // falava de gravação.
    //
    // A trava é por ARQUIVO, e não por nome de acessório: é o `.parcial` que
    // colide, e dois nomes de catálogo podem um dia apontar para o mesmo
    // arquivo. A tela também impede (a store recusa o segundo clique), mas a
    // regra mora aqui porque é aqui que ela é verdadeira — a v0.10.1 provou o
    // custo de uma garantia que só existe no frontend.

    #[test]
    fn dois_downloads_do_mesmo_arquivo_nao_correm_juntos() {
        let state = estado();
        let primeiro = state
            .download_begin("ggml-medium.bin")
            .expect("o primeiro download entra");

        let erro = state
            .download_begin("ggml-medium.bin")
            .expect_err("o segundo é recusado enquanto o primeiro vive");
        assert_eq!(erro.to_string(), ERRO_DOWNLOAD_JA_EM_ANDAMENTO);

        // e a frase não é a de gravação: o problema não é o disco desta pessoa
        assert!(!erro.to_string().contains("gravar"));

        drop(primeiro);
        state
            .download_begin("ggml-medium.bin")
            .expect("terminado o primeiro, o mesmo arquivo baixa de novo");
    }

    // -----------------------------------------------------------------------
    // V10.4 — o laço da banda se fecha (defeito de campo D3)
    // -----------------------------------------------------------------------

    /// **O que este download mediu vale para o próximo.** É a DECISIONS #112
    /// aplicada ao download: o produto já media a velocidade para pintar a
    /// barra e jogava a medição fora no fim, então a tela continuava
    /// prometendo o número de fábrica para sempre — que foi o "26 minutos"
    /// para um download de 3 do relato de campo.
    ///
    /// O teste percorre o laço inteiro sem Tauri: medir, guardar, reler,
    /// estimar.
    #[test]
    fn a_medicao_de_um_download_vira_a_estimativa_do_proximo() {
        let conn = db::open_in_memory().unwrap();
        // exatamente o caso de campo: 1,5 GB em menos de 3 minutos
        let bytes = 1_533_763_059u64;
        let relogio = std::time::Duration::from_secs(175);

        let banda = crate::acessorios::banda_medida(bytes, relogio)
            .expect("1,5 GB em 175 s é amostra de sobra");
        db::somar_banda(&conn, bytes as f64, relogio.as_secs_f64()).unwrap();
        let guardada = db::banda_medida(&conn).unwrap().expect("a máquina se mediu") as u64;
        assert_eq!(guardada, banda, "o que voltou do banco é o que foi medido");

        let de_fabrica = crate::acessorios::segundos_estimados(bytes, None);
        let medida = crate::acessorios::segundos_estimados(bytes, Some(guardada));
        assert!(
            medida < de_fabrica,
            "a máquina medida deixa de receber o número de fábrica \
             ({medida} s contra {de_fabrica} s)"
        );
        assert!(
            (170..=185).contains(&medida),
            "e o número novo é o que a máquina levou de verdade: {medida} s"
        );
    }

    /// O `AcessorioInfo` DIZ de onde veio o número — a tela precisa saber se
    /// mantém a ressalva de internet lenta ou não (mesma escolha da #124).
    #[test]
    fn o_acessorio_diz_se_o_tempo_e_medido_ou_de_fabrica() {
        let dir = tempfile::tempdir().unwrap();
        let modelo = crate::acessorios::desta_maquina(crate::acessorios::MODELO_WHISPER_GRANDE)
            .expect("o modelo grande existe aqui");

        let de_fabrica = info_de(modelo, dir.path(), true, None);
        assert!(!de_fabrica.tempo_medido_nesta_maquina);

        let medido = info_de(modelo, dir.path(), true, Some(9_000_000));
        assert!(medido.tempo_medido_nesta_maquina);
        assert!(
            medido.segundos_estimados < de_fabrica.segundos_estimados,
            "a máquina rápida não recebe o número da conexão modesta"
        );

        // banda zero não é medição: seria uma divisão por zero servida na tela
        let zero = info_de(modelo, dir.path(), true, Some(0));
        assert!(!zero.tempo_medido_nesta_maquina);
        assert_eq!(zero.segundos_estimados, de_fabrica.segundos_estimados);
    }

    /// Arquivos DIFERENTES continuam podendo baixar ao mesmo tempo: eles não
    /// disputam `.parcial` nenhum, e travar um pelo outro seria inventar uma
    /// fila que ninguém pediu.
    #[test]
    fn downloads_de_arquivos_diferentes_convivem() {
        let state = estado();
        let _modelo = state.download_begin("ggml-medium.bin").unwrap();
        let _fpcalc = state
            .download_begin("fpcalc-linux-x86_64")
            .expect("outro arquivo, outro parcial");
    }

    /// A trava é liberada mesmo quando o download FALHA — o guard solta no
    /// `Drop`, então não há caminho de saída que deixe o acessório travado
    /// para sempre. Um acessório que nunca mais baixa, num produto sem
    /// suporte, é o recurso morto em silêncio.
    #[test]
    fn a_trava_do_download_e_solta_ate_quando_o_download_entra_em_panico() {
        let state = estado();
        let resultado = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = state.download_begin("ggml-medium.bin").unwrap();
            panic!("o download explodiu no meio");
        }));
        assert!(resultado.is_err());
        state
            .download_begin("ggml-medium.bin")
            .expect("a trava saiu junto com o guard");
    }

    // -----------------------------------------------------------------------
    // DECISIONS #15/#48 — a JANELA DE ESCRITA não pode crescer com a F18. A
    // varredura, que dura minutos, roda em conexão DEDICADA e não segura o
    // mutex que busca/listagem usam; o apply, que são segundos, continua no
    // lock compartilhado. As duas varreduras novas (pasta e música) usam a
    // mesma `scan_conn`, então valem para as duas.
    // -----------------------------------------------------------------------
    #[test]
    fn a_running_scan_never_holds_the_lock_that_search_needs() {
        let dir = tempfile::tempdir().unwrap();
        let caminho = dir.path().join("cancioneiro.db");
        let state = Db::new(db::open_at(&caminho).unwrap(), Some(caminho.clone()));

        let varredura = state.scan_conn().unwrap();
        // com a varredura em curso, a busca continua entrando
        let busca = state.lock().expect("o lock da busca continua livre");
        assert!(db::list_songs(&busca).is_ok());
        drop(busca);
        // e a conexão da varredura é OUTRA, não o guard compartilhado
        assert!(matches!(varredura, ScanConn::Owned(_)));
    }

    /// Banco in-memory (só nos testes) não tem arquivo para reabrir: aí a
    /// varredura cai no lock compartilhado mesmo — comportamento inalterado.
    #[test]
    fn an_in_memory_database_falls_back_to_the_shared_lock() {
        let state = estado();
        assert!(matches!(state.scan_conn().unwrap(), ScanConn::Shared(_)));
    }

    // -----------------------------------------------------------------------
    // QA MÉDIO-6 — resposta do servidor não é "sem conexão". Antes, um 429
    // (plausível a 300 ms × 95 músicas), um 500 ou uma chave digitada errada
    // produziam todos a MESMA frase, e a pessoa terminava com dezenas de
    // linhas culpando uma internet que estava ótima. Não há a quem perguntar:
    // a frase é a explicação inteira.
    // -----------------------------------------------------------------------
    #[test]
    fn each_http_failure_says_what_actually_happened() {
        // V10 — sobrou UMA chave no produto, e ela é NOSSA: a do AcoustID, que
        // vem compilada. Não há nada que a pessoa possa fazer a respeito, e
        // mandá-la conferir uma chave que ela nunca digitou seria mandá-la
        // procurar defeito onde não há. (A do Vagalume era do usuário e tinha
        // frase própria; o Vagalume saiu — DECISIONS #110.)
        assert_eq!(
            mensagem_de_status(401, Destino::Acoustid),
            crate::fingerprint::ERRO_CHAVE_RECUSADA
        );
        // o LRCLIB não tem chave nenhuma: 401/403 lá é outra coisa
        assert_eq!(
            mensagem_de_status(401, Destino::Lrclib),
            "o site de letras respondeu com erro"
        );
        // e o lyrics.ovh também não: TODA falha dele fala de
        // indisponibilidade, porque não há cadastro nenhum a conferir
        for status in [400, 401, 403, 429, 500, 502, 503] {
            assert_eq!(
                mensagem_de_status(status, Destino::LyricsOvh),
                crate::lyrics_ovh::ERRO_FORA_DO_AR,
                "status {status}"
            );
        }

        assert_eq!(
            mensagem_de_status(429, Destino::Lrclib),
            "o site de letras pediu para esperar um pouco"
        );
        for fora_do_ar in [500, 502, 503, 504] {
            assert_eq!(
                mensagem_de_status(fora_do_ar, Destino::Lrclib),
                "o site de letras está fora do ar agora",
                "status {fora_do_ar}"
            );
        }
        for outro in [400, 404, 410, 418] {
            assert_eq!(
                mensagem_de_status(outro, Destino::Lrclib),
                "o site de letras respondeu com erro",
                "status {outro}"
            );
        }
    }

    /// O AcoustID fala de SI, e nunca se chama "site de letras": ele não
    /// devolve letra nenhuma, e mandar a pessoa procurar defeito num site de
    /// letras quando o que falhou foi o reconhecimento é mandá-la procurar
    /// no lugar errado.
    #[test]
    fn o_reconhecimento_pelo_som_nunca_se_chama_site_de_letras() {
        for status in [400, 401, 403, 404, 429, 500, 502, 503] {
            let msg = mensagem_de_status(status, Destino::Acoustid);
            assert!(!msg.contains("letras"), "status {status}: {msg}");
            assert!(msg.contains("som"), "status {status}: {msg}");
        }
    }

    /// Nenhuma dessas frases pode carregar chave nenhuma: elas são texto
    /// FIXO, sem interpolação, e é assim que a garantia se sustenta.
    ///
    /// V10 — sobrou UMA chave no produto, a do AcoustID, e ela é nossa: o
    /// Vagalume saiu (DECISIONS #110) e o lyrics.ovh nunca teve.
    #[test]
    fn no_network_message_can_ever_carry_the_key() {
        for chave in ["minha-chave-secreta-do-acoustid"] {
            for status in [400, 401, 403, 404, 429, 500, 502, 503] {
                for destino in [Destino::Lrclib, Destino::LyricsOvh, Destino::Acoustid] {
                    assert!(
                        !mensagem_de_status(status, destino).contains(chave),
                        "status {status}, destino {destino:?}"
                    );
                }
            }
        }
    }

    /// **Nenhuma etapa do funil exige credencial do usuário** (V10).
    ///
    /// Era o Vagalume que exigia, e ele saiu (DECISIONS #110). O que sobrou
    /// vem tudo compilado ou não vem: a chave do AcoustID é NOSSA (modelo
    /// por-aplicativo deles), o LRCLIB e o lyrics.ovh não têm chave nenhuma.
    /// Isso apaga da tela de configuração um campo de chave de API e o
    /// parágrafo que o explicava — para 40 pessoas que não sabem o que é uma
    /// chave de API.
    ///
    /// Este teste é uma GUARDA: ele falha se alguém acrescentar um parâmetro
    /// de credencial a qualquer comando do funil.
    #[test]
    fn nenhum_comando_do_funil_pede_credencial_do_usuario() {
        // as assinaturas, lidas do próprio código-fonte deste arquivo: é o
        // único jeito de um teste enxergar um PARÂMETRO
        let fonte = include_str!("commands.rs");
        for comando in [
            "pub fn enrich_count(",
            "pub fn enrich_folder_scan(",
            "pub fn enrich_song_scan(",
            "pub fn transcricao_pendentes(",
            "pub fn transcrever_musicas(",
        ] {
            let i = fonte.find(comando).expect(comando);
            let assinatura = &fonte[i..i + fonte[i..].find(" -> Result").expect("retorno")];
            for proibido in ["vagalume_key", "api_key", "apikey", "chave", "token"] {
                assert!(
                    !assinatura.contains(proibido),
                    "{comando} pede credencial: {proibido}"
                );
            }
        }
    }

    // -----------------------------------------------------------------------
    // QA A5 — o eco da proposta chega do frontend em snake_case, sem renames.
    // -----------------------------------------------------------------------
    #[test]
    fn enrich_apply_deserializes_the_proposal_echo_from_snake_case() {
        let ap: crate::enrich::EnrichApply = serde_json::from_str(
            r#"{"song_id": 7, "title": "Oh! Chuva", "artist": "Falamansa",
                "lyrics": null, "add_temas": null,
                "current_title": "Falamansa - Oh! Chuva", "current_artist": null}"#,
        )
        .unwrap();

        assert_eq!(ap.song_id, 7);
        assert_eq!(ap.current_title, "Falamansa - Oh! Chuva");
        assert_eq!(ap.current_artist, None);
    }
}
