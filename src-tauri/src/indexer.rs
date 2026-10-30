use crate::db;
use crate::error::{AppError, Result};
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::tag::{Accessor, ItemKey};
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashSet;
use std::path::Path;
use std::time::UNIX_EPOCH;
use walkdir::WalkDir;

#[derive(Debug, Default, PartialEq)]
pub struct ScanStats {
    /// Arquivos lidos/relidos (novos ou alterados).
    pub indexed: usize,
    /// Arquivos inalterados (skip por mtime+size).
    pub skipped: usize,
    /// Registros removidos (arquivo sumiu do disco).
    pub removed: usize,
    /// Arquivos com falha de leitura de tags (indexados com fallback).
    pub tag_errors: usize,
    /// Total de MP3s encontrados na pasta.
    pub total: usize,
}

#[derive(Debug, Default)]
pub struct ScanOutcome {
    pub stats: ScanStats,
    /// Pastas registradas cujo caminho não existe mais no disco.
    pub missing_folders: Vec<String>,
}

struct TagData {
    title: String,
    artist: Option<String>,
    album: Option<String>,
    duration_seconds: Option<i64>,
    lyrics: Option<String>,
    /// Temas do frame TXXX:TEMAS ("água; cura") — V2, PRD-v2-temas.md.
    temas: Option<String>,
    /// Procedência da letra atual, do frame TXXX:LETRA_ORIGEM ("transcricao")
    /// — V5/F14, PRD-v5-transcricao.md.
    letra_origem: Option<String>,
    /// Música sem voz, do frame TXXX:INSTRUMENTAL — V8/F17.
    instrumental: bool,
    /// true se a leitura de tags falhou e usamos fallback
    fallback: bool,
}

/// Lê a marca TXXX:INSTRUMENTAL (V8/F17). O frame é uma BANDEIRA, não um
/// texto: as duas ferramentas do produto gravam "1" para marcar, e DESMARCAR
/// é REMOVER o frame — nem o `embed_lyrics.py --nao-instrumental` nem o
/// `writer::write_tags` chegam a escrever "0" em lugar nenhum. Ausência do
/// frame, portanto, é o estado "não é instrumental".
///
/// Ainda assim os valores falsos são reconhecidos, porque o arquivo é o
/// banco de dados e ele passa por outras mãos: um "0" gravado por outro
/// tagger tem de ser lido como "não é". Simetricamente, "1", "true", "sim"
/// ou qualquer outro texto não-vazio contam como marca — na dúvida
/// respeita-se a marca, porque desrespeitá-la devolve o arquivo à fila de
/// letra e ele acaba recebendo a letra da versão cantada.
///
/// Conjunto reconhecido como NÃO marcado (o resto é marca): "0", "false",
/// "nao", "não", e o frame vazio/ausente. É o MESMO conjunto do
/// `INSTRUMENTAL_NAO` do `tools/embed_lyrics.py`, e tem de continuar sendo:
/// os dois stacks leem o mesmo arquivo e não podem discordar sobre o que ele
/// diz — divergir aqui põe o selo "Instrumental" na tela enquanto o script
/// segue transcrevendo o arquivo em toda execução. `integration.rs`
/// (`instrumental_marker_recognizes_the_same_value_set_as_the_python_tool`)
/// fixa o conjunto deste lado.
fn read_instrumental(tag: &lofty::tag::Tag) -> bool {
    read_txxx(tag, "INSTRUMENTAL")
        .map(|v| !matches!(v.to_lowercase().as_str(), "0" | "false" | "nao" | "não"))
        .unwrap_or(false)
}

/// Extrai um frame TXXX pela descrição (lofty expõe TXXX desconhecidos como
/// ItemKey::Unknown(descrição)). Texto em branco conta como ausente.
fn read_txxx(tag: &lofty::tag::Tag, desc: &str) -> Option<String> {
    tag.items()
        .find(|item| matches!(item.key(), ItemKey::Unknown(d) if d == desc))
        .and_then(|item| item.value().text())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn file_stem_title(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

/// Lê tags de um MP3 com lofty. Nunca falha: em erro de leitura devolve
/// fallback (título = nome do arquivo, sem letra), conforme F1 do PRD.
fn read_tags(path: &Path) -> TagData {
    let fallback = TagData {
        title: file_stem_title(path),
        artist: None,
        album: None,
        duration_seconds: None,
        lyrics: None,
        temas: None,
        letra_origem: None,
        instrumental: false,
        fallback: true,
    };

    let tagged = match ler_etiquetas(path) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("[indexer] falha ao ler tags de {path:?}: {e}");
            return fallback;
        }
    };

    let duration = tagged.properties().duration().as_secs() as i64;
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag());

    let (title, artist, album, lyrics, temas, letra_origem, instrumental) = match tag {
        Some(t) => {
            let title = t
                .title()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| file_stem_title(path));
            let artist = t
                .artist()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            let album = t
                .album()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            let lyrics = t
                .get_string(&ItemKey::Lyrics)
                .map(|s| s.to_string())
                .filter(|s| !s.trim().is_empty());
            let temas = read_txxx(t, "TEMAS");
            // V5/F14 — procedência da letra. A marca acompanha a letra que
            // está no arquivo (DECISIONS #54): letra sem marca é letra sem
            // procedência declarada, nunca "oficial" por dedução.
            let letra_origem = read_txxx(t, "LETRA_ORIGEM");
            // V8/F17 — música sem voz. A marca NUNCA é deduzida de "não tem
            // letra": ela existe justamente para separar as duas coisas.
            let instrumental = read_instrumental(t);
            (title, artist, album, lyrics, temas, letra_origem, instrumental)
        }
        None => (file_stem_title(path), None, None, None, None, None, false),
    };

    TagData {
        title,
        artist,
        album,
        duration_seconds: Some(duration),
        lyrics,
        temas,
        letra_origem,
        instrumental,
        fallback: false,
    }
}

/// Nomes das subpastas do arquivo relativos à pasta registrada, separados
/// por espaço (F12): /acervo/Barco/sub/x.mp3 com folder /acervo → "Barco
/// sub"; arquivo na raiz da pasta registrada → None. Só alimenta o índice de
/// busca (coluna songs.pastas na FTS) — a Song não expõe o valor.
fn pastas_for(folder_path: &str, file_path: &Path) -> Option<String> {
    let rel = file_path.parent()?.strip_prefix(folder_path).ok()?;
    let parts: Vec<String> = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(" "))
    }
}

/// Nome do arquivo a INDEXAR na busca (V8), ou None quando não há o que
/// indexar. Só alimenta o índice (coluna songs.arquivo na FTS) — a Song não
/// expõe o valor, como acontece com `pastas` (DECISIONS #46): a lista e o
/// painel já derivam o nome do file_path no frontend (songFileName).
///
/// Duas decisões deliberadas:
///
/// 1. SEM a extensão. Ninguém procura uma música digitando "mp3", e como todo
///    arquivo indexado é .mp3 (is_mp3), indexá-la daria ao token "mp3" o
///    acervo inteiro como resultado. `file_stem` já resolve o `.MP3` em caixa
///    alta e o ponto no meio do nome ("vol.2.mp3" → "vol.2").
///
/// 2. NADA quando o nome é o próprio título. Música sem tag entra com o nome
///    do arquivo COMO título (read_tags), e aí as duas colunas guardariam o
///    mesmo texto: recall idêntico, mas o bm25 soma as ocorrências das duas
///    e empurraria o acervo mal etiquetado para cima do bem etiquetado em
///    toda busca. A comparação ignora caixa e acento (fold_pt) porque o
///    tokenizador da FTS também ignora — para o ÍNDICE, "Coracao.mp3" sob o
///    título "Coração" é o mesmo texto. Na EXIBIÇÃO é o contrário (DECISIONS
///    #67: acento é diferença que se quer ver na tela), e é por isso que esta
///    regra vive aqui e não é a mesma do songFileName().
///
/// Nome que vira só pontuação ("-.mp3") não tem token nenhum a oferecer e sai
/// como None em vez de ocupar uma linha do índice.
fn arquivo_para_busca(path: &Path, title: &str) -> Option<String> {
    let stem = path.file_stem()?.to_string_lossy().trim().to_string();
    if stem.is_empty() || !stem.chars().any(char::is_alphanumeric) {
        return None;
    }
    if db::fold_pt(&stem) == db::fold_pt(title.trim()) {
        return None;
    }
    Some(stem)
}

/// Upsert de uma música por file_path (INSERT ... ON CONFLICT preserva o id —
/// e portanto os itens de playlist que apontam para ela).
fn upsert_song(
    conn: &Connection,
    folder_id: i64,
    path_str: &str,
    tags: &TagData,
    pastas: Option<&str>,
    mtime: i64,
    size: i64,
) -> Result<()> {
    let has_lyrics = tags.lyrics.is_some();
    // V8 — nome do arquivo buscável, derivado aqui (e não pelo chamador) para
    // que o scan e a reindexação de um arquivo só nunca divirjam. Depende do
    // título final, então é recalculado sempre que as tags mudam.
    let arquivo = arquivo_para_busca(Path::new(path_str), &tags.title);
    conn.execute(
        "INSERT INTO songs
            (file_path, folder_id, title, artist, album, duration_seconds,
             has_lyrics, lyrics, temas, letra_origem, instrumental, pastas, arquivo,
             file_mtime, file_size, available, indexed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, 1, datetime('now'))
         ON CONFLICT(file_path) DO UPDATE SET
            folder_id = excluded.folder_id,
            title = excluded.title,
            artist = excluded.artist,
            album = excluded.album,
            duration_seconds = excluded.duration_seconds,
            has_lyrics = excluded.has_lyrics,
            lyrics = excluded.lyrics,
            temas = excluded.temas,
            letra_origem = excluded.letra_origem,
            instrumental = excluded.instrumental,
            pastas = excluded.pastas,
            arquivo = excluded.arquivo,
            file_mtime = excluded.file_mtime,
            file_size = excluded.file_size,
            available = 1,
            indexed_at = datetime('now')",
        params![
            path_str,
            folder_id,
            tags.title,
            tags.artist,
            tags.album,
            tags.duration_seconds,
            has_lyrics as i64,
            tags.lyrics,
            tags.temas,
            tags.letra_origem,
            tags.instrumental as i64,
            pastas,
            arquivo,
            mtime,
            size
        ],
    )?;
    Ok(())
}

/// Reindexa um único arquivo (F10): re-stata mtime/size, relê as tags e faz
/// upsert — usado pelo writer logo após gravar tags, para o banco (e a FTS,
/// via triggers) refletirem o disco sem esperar um rescan. As pastas (F12)
/// são derivadas do caminho da pasta registrada, lido do banco.
pub(crate) fn index_single_file(conn: &Connection, folder_id: i64, path: &Path) -> Result<()> {
    let folder_path: String = conn
        .query_row(
            "SELECT path FROM folders WHERE id = ?1",
            params![folder_id],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(|| AppError(format!("pasta não registrada: {folder_id}")))?;
    let md = std::fs::metadata(path)?;
    let mtime = file_mtime_epoch(&md);
    let size = md.len() as i64;
    let tags = read_tags(path);
    let pastas = pastas_for(&folder_path, path);
    upsert_song(
        conn,
        folder_id,
        &path.to_string_lossy(),
        &tags,
        pastas.as_deref(),
        mtime,
        size,
    )
}

fn file_mtime_epoch(md: &std::fs::Metadata) -> i64 {
    // Milissegundos: resolução de segundos deixaria passar um arquivo editado
    // no mesmo segundo da indexação (com o mesmo tamanho).
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Lê as etiquetas — e, quando a leitura cai por TEXTO ilegível, tenta de novo
/// sobre uma cópia consertada na memória (V15.1, ver `conserto_id3`).
///
/// Sem isto, um quadro técnico estragado (o ano, o programa que gravou) fazia o
/// app ignorar TODAS as etiquetas do arquivo: mostrava o nome do arquivo no
/// lugar do título, "(vazio)" no artista, e a curadoria oferecia "preencher" o
/// que nunca esteve vazio. A leitura não escreve nada: o conserto só vai para o
/// arquivo quando a pessoa grava.
fn ler_etiquetas(path: &Path) -> lofty::error::Result<lofty::file::TaggedFile> {
    match lofty::read_from_path(path) {
        Err(e) if crate::conserto_id3::e_erro_de_texto(&e) => {
            let bytes = std::fs::read(path)?;
            match crate::conserto_id3::consertar_codificacao_ausente(&bytes) {
                Some((consertado, _)) => {
                    lofty::probe::Probe::new(std::io::Cursor::new(consertado))
                        .guess_file_type()?
                        .read()
                }
                None => Err(e),
            }
        }
        lido => lido,
    }
}

fn is_mp3(path: &Path) -> bool {
    path.extension()
        .map(|e| e.to_string_lossy().eq_ignore_ascii_case("mp3"))
        .unwrap_or(false)
}

/// O nome começa com ponto — isto é, o sistema o esconde de quem abre a pasta.
///
/// Existe por um defeito de campo: no Windows a biblioteca apareceu cheia de
/// `._musica.mp3` ao lado de cada `musica.mp3`. São arquivos que o **macOS**
/// deixa para trás ao copiar música para um pendrive ou para um zip
/// (AppleDouble: guardam ícone e atributos estendidos, nunca áudio). Têm
/// quatro quilobytes, não tocam, e dobram a lista exatamente no acervo de
/// quem trouxe as músicas de um Mac.
///
/// Esconder um arquivo é o jeito que TODO sistema tem de dizer "isto não é
/// conteúdo, é maquinaria" — o `.Trashes` e o `.Spotlight-V100` do pendrive
/// dizem a mesma coisa. Então a regra não é sobre AppleDouble: é sobre ponto.
///
/// Nada é apagado nem renomeado: o arquivo continua exatamente onde está, só
/// deixa de entrar no índice. Quem já tem esses registros no banco os perde na
/// próxima varredura, pela mesma linha que remove música que saiu da pasta.
fn e_oculto(path: &Path) -> bool {
    path.file_name()
        .map(|n| n.to_string_lossy().starts_with('.'))
        .unwrap_or(false)
}

/// Os MP3s de uma pasta, do jeito que a varredura os vê.
///
/// Um lugar só, e não a mesma expressão copiada em dois: quem conta para a
/// barra de progresso e quem indexa TÊM de concordar, senão a barra promete um
/// número e o trabalho entrega outro. Pastas ocultas são podadas inteiras
/// (`.Trashes`, `.fseventsd`) — descer nelas é gastar tempo de disco para
/// jogar tudo fora no filtro seguinte.
///
/// A raiz nunca é podada: a pessoa pode ter escolhido uma pasta que mora
/// dentro de um caminho com ponto, e aí recusar a própria raiz seria dizer
/// que a pasta está vazia.
fn mp3s_da_pasta(folder_path: &str) -> impl Iterator<Item = walkdir::DirEntry> + '_ {
    WalkDir::new(folder_path)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| e.depth() == 0 || !e_oculto(e.path()))
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file() && is_mp3(e.path()))
}

/// Varre uma pasta registrada: indexa MP3s novos/alterados (skip incremental
/// por mtime+size), remove do índice arquivos que sumiram, atualiza
/// last_scanned_at. `progress` recebe (concluídos, total).
pub fn scan_folder<F: FnMut(usize, usize)>(
    conn: &Connection,
    folder_id: i64,
    mut progress: F,
) -> Result<ScanStats> {
    let folder_path: String = conn
        .query_row(
            "SELECT path FROM folders WHERE id = ?1",
            params![folder_id],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(|| AppError(format!("pasta não registrada: {folder_id}")))?;

    if !Path::new(&folder_path).is_dir() {
        return Err(AppError(format!("pasta não encontrada: {folder_path}")));
    }

    // Pasta existe: tudo que está nela volta a ficar disponível.
    conn.execute(
        "UPDATE songs SET available = 1 WHERE folder_id = ?1",
        params![folder_id],
    )?;

    let files: Vec<walkdir::DirEntry> = mp3s_da_pasta(&folder_path).collect();

    let mut stats = ScanStats {
        total: files.len(),
        ..Default::default()
    };
    let mut seen: HashSet<String> = HashSet::with_capacity(files.len());
    let mut done = 0usize;
    progress(0, stats.total);

    for entry in files {
        let path = entry.path();
        let path_str = path.to_string_lossy().into_owned();
        seen.insert(path_str.clone());

        let md = match entry.metadata() {
            Ok(m) => m,
            Err(e) => {
                eprintln!("[indexer] metadata falhou para {path:?}: {e}");
                done += 1;
                progress(done, stats.total);
                continue;
            }
        };
        let mtime = file_mtime_epoch(&md);
        let size = md.len() as i64;

        let existing: Option<(i64, i64)> = conn
            .query_row(
                "SELECT file_mtime, file_size FROM songs WHERE file_path = ?1",
                params![path_str],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;

        if existing == Some((mtime, size)) {
            stats.skipped += 1;
            done += 1;
            progress(done, stats.total);
            continue;
        }

        let tags = read_tags(path);
        if tags.fallback {
            stats.tag_errors += 1;
        }
        let pastas = pastas_for(&folder_path, path);
        upsert_song(conn, folder_id, &path_str, &tags, pastas.as_deref(), mtime, size)?;
        stats.indexed += 1;
        done += 1;
        progress(done, stats.total);
    }

    // Remove do índice arquivos desta pasta que sumiram do disco.
    let indexed_paths: Vec<(i64, String)> = {
        let mut stmt =
            conn.prepare("SELECT id, file_path FROM songs WHERE folder_id = ?1")?;
        let rows = stmt.query_map(params![folder_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<std::result::Result<_, _>>()?
    };
    for (id, path) in indexed_paths {
        if !seen.contains(&path) {
            conn.execute("DELETE FROM songs WHERE id = ?1", params![id])?;
            stats.removed += 1;
        }
    }

    conn.execute(
        "UPDATE folders SET last_scanned_at = datetime('now') WHERE id = ?1",
        params![folder_id],
    )?;

    Ok(stats)
}

/// Varre todas as pastas registradas. Pastas cujo caminho sumiu do disco não
/// têm as músicas deletadas: elas são marcadas indisponíveis e a pasta é
/// reportada em `missing_folders` (F1 do PRD).
pub fn scan_all<F: FnMut(usize, usize)>(
    conn: &Connection,
    mut progress: F,
) -> Result<ScanOutcome> {
    let folders = db::list_folders(conn)?;
    let mut outcome = ScanOutcome::default();

    // Pré-conta os MP3s de todas as pastas existentes para que o progresso
    // reportado seja global ("n de total"), não reiniciando a cada pasta.
    let mut grand_total = 0usize;
    let mut existing: Vec<&db::Folder> = Vec::new();
    for folder in &folders {
        if Path::new(&folder.path).is_dir() {
            grand_total += count_mp3s(&folder.path);
            existing.push(folder);
        }
    }

    let mut base = 0usize;
    for folder in &folders {
        if !Path::new(&folder.path).is_dir() {
            conn.execute(
                "UPDATE songs SET available = 0 WHERE folder_id = ?1",
                params![folder.id],
            )?;
            outcome.missing_folders.push(folder.path.clone());
            continue;
        }
        let stats = scan_folder(conn, folder.id, |done, _local_total| {
            progress(base + done, grand_total);
        })?;
        base += stats.total;
        outcome.stats.indexed += stats.indexed;
        outcome.stats.skipped += stats.skipped;
        outcome.stats.removed += stats.removed;
        outcome.stats.tag_errors += stats.tag_errors;
        outcome.stats.total += stats.total;
    }

    Ok(outcome)
}

fn count_mp3s(folder_path: &str) -> usize {
    mp3s_da_pasta(folder_path).count()
}

#[cfg(test)]
mod tests {
    use super::{arquivo_para_busca, mp3s_da_pasta, pastas_for};
    use std::path::Path;

    /// O acervo que veio de um Mac não entra dobrado.
    ///
    /// Defeito relatado no Windows: ao lado de cada `musica.mp3` aparecia um
    /// `._musica.mp3` que não tocava e sujava a lista. É o rastro que o macOS
    /// deixa ao copiar para pendrive ou zip — e no acervo de quem cura a
    /// coleção num Mac e ouve num PC, isso é a biblioteca inteira em dobro.
    #[test]
    fn the_scan_ignores_what_the_system_hides() {
        let dir = tempfile::tempdir().expect("tempdir");
        let raiz = dir.path();
        std::fs::write(raiz.join("musica.mp3"), b"").unwrap();
        // o sósia do macOS, que é o caso que abriu este teste
        std::fs::write(raiz.join("._musica.mp3"), b"").unwrap();
        // e qualquer outro oculto: a regra é sobre o ponto, não sobre o macOS
        std::fs::write(raiz.join(".rascunho.mp3"), b"").unwrap();

        // pasta oculta inteira (o `.Trashes` do pendrive): podada, não visitada
        let lixeira = raiz.join(".Trashes");
        std::fs::create_dir(&lixeira).unwrap();
        std::fs::write(lixeira.join("apagada.mp3"), b"").unwrap();

        // subpasta NORMAL continua entrando — a poda é dos ocultos, não da
        // recursão
        let sub = raiz.join("Capoeira");
        std::fs::create_dir(&sub).unwrap();
        std::fs::write(sub.join("roda.mp3"), b"").unwrap();

        let mut achados: Vec<String> = mp3s_da_pasta(&raiz.to_string_lossy())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        achados.sort();
        assert_eq!(achados, vec!["musica.mp3", "roda.mp3"]);
    }

    /// A raiz escolhida pela pessoa vale mesmo que ELA comece com ponto.
    ///
    /// Recusar a própria raiz seria responder "a pasta está vazia" a quem
    /// acabou de apontar para uma pasta cheia de música — e ela não tem a quem
    /// perguntar por quê.
    #[test]
    fn a_chosen_root_is_never_pruned_for_its_own_name() {
        let dir = tempfile::tempdir().expect("tempdir");
        let raiz = dir.path().join(".acervo");
        std::fs::create_dir(&raiz).unwrap();
        std::fs::write(raiz.join("musica.mp3"), b"").unwrap();

        assert_eq!(mp3s_da_pasta(&raiz.to_string_lossy()).count(), 1);
    }

    #[test]
    fn arquivo_para_busca_uses_stem_without_extension() {
        // nome real do acervo: o que a coordenadora digitaria está aqui
        assert_eq!(
            arquivo_para_busca(
                Path::new("/acervo/Barco/barco - Marinheiro só (Capoeira).mp3"),
                "Marinheiro Só"
            )
            .as_deref(),
            Some("barco - Marinheiro só (Capoeira)")
        );
        // extensão em CAIXA ALTA também sai (é extensão, não conteúdo)
        assert_eq!(
            arquivo_para_busca(Path::new("/acervo/Abrir a sessão ####.MP3"), "Abertura")
                .as_deref(),
            Some("Abrir a sessão ####")
        );
        // nome que é só pontuação depois de tirar a extensão: nada a indexar
        assert_eq!(arquivo_para_busca(Path::new("/acervo/-.mp3"), "Sem Nome"), None);
        // ponto no meio do nome: só a ÚLTIMA parte é extensão
        assert_eq!(
            arquivo_para_busca(Path::new("/acervo/canto pra iemanja vol.2.mp3"), "Canto")
                .as_deref(),
            Some("canto pra iemanja vol.2")
        );
    }

    #[test]
    fn arquivo_para_busca_skips_name_already_equal_to_title() {
        // Música sem tag: o indexer usa o nome do arquivo COMO título. Indexar
        // o mesmo texto duas vezes não acrescenta recall nenhum e só distorce
        // o rank (bm25 soma as ocorrências das duas colunas), empurrando o
        // acervo mal etiquetado para cima do bem etiquetado. Mesma ideia do
        // songFileName() da lista (DECISIONS #67): nome é soma, não repetição.
        assert_eq!(arquivo_para_busca(Path::new("/acervo/sem_tags.mp3"), "sem_tags"), None);
        // caixa e acento não fazem diferença para o ÍNDICE (o tokenizador da
        // FTS já ignora os dois) — ao contrário da EXIBIÇÃO, onde "Coracao.mp3"
        // sob "Coração" é justamente a diferença que se quer ver na tela.
        assert_eq!(
            arquivo_para_busca(Path::new("/acervo/Coracao.mp3"), "coração"),
            None
        );
        // diferença de verdade continua entrando
        assert_eq!(
            arquivo_para_busca(Path::new("/acervo/barco - coração.mp3"), "Coração").as_deref(),
            Some("barco - coração")
        );
    }

    // O macOS — a plataforma que o dono do produto usa — entrega os caminhos
    // em NFD: "Coração.mp3" chega como "Corac<U+0327>a<U+0303>o.mp3", enquanto
    // o TIT2 lido da tag vem em NFC. São o mesmo texto na tela, e o
    // tokenizador da FTS (unicode61 remove_diacritics 2) produz o mesmo token
    // para os dois — então indexar os dois é indexar duas vezes a mesma
    // palavra, que é exatamente o que esta função existe para evitar.
    #[test]
    fn arquivo_para_busca_treats_nfd_path_and_nfc_title_as_the_same_name() {
        let nfd = Path::new("/acervo/Corac\u{0327}a\u{0303}o.mp3");
        assert_eq!(arquivo_para_busca(nfd, "Coração"), None);
        // e o contrário (path NFC, título NFD vindo de uma tag decomposta)
        assert_eq!(
            arquivo_para_busca(Path::new("/acervo/Coração.mp3"), "Corac\u{0327}a\u{0303}o"),
            None
        );
        // nome diferente continua entrando, venha em que forma vier
        assert_eq!(
            arquivo_para_busca(Path::new("/acervo/barco - Corac\u{0327}a\u{0303}o.mp3"), "Coração")
                .as_deref(),
            Some("barco - Corac\u{0327}a\u{0303}o")
        );
    }

    #[test]
    fn pastas_for_derives_relative_subfolder_names() {
        // subpastas relativas à pasta registrada, separadas por espaço
        assert_eq!(
            pastas_for("/acervo", Path::new("/acervo/Barco/sub/x.mp3")).as_deref(),
            Some("Barco sub")
        );
        assert_eq!(
            pastas_for("/acervo", Path::new("/acervo/Canções/y.mp3")).as_deref(),
            Some("Canções")
        );
        // arquivo na raiz da pasta registrada: sem pasta
        assert_eq!(pastas_for("/acervo", Path::new("/acervo/x.mp3")), None);
        // caminho fora da pasta registrada (defensivo): sem pasta
        assert_eq!(pastas_for("/acervo", Path::new("/outro/x.mp3")), None);
    }
}
