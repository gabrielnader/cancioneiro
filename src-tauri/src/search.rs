//! **A busca: a função central do produto, e a única coisa que ele existe
//! para fazer — achar uma música pelo pedaço de letra que alguém lembra.**
//!
//! # V13 — por que a busca passou a perdoar
//!
//! Boa parte das letras do acervo foi **escrita por máquina, ouvindo o
//! áudio**, e tem erro. Até aqui a busca exigia TODAS as palavras EXATAS (só
//! a última aceitava prefixo, para busca enquanto se digita), então `dormir`
//! não achava `dormi` — uma letra de diferença, e a música some.
//!
//! O que existe agora é uma **UNIÃO de duas buscas**, e nunca uma troca:
//!
//! 1. a **exata**, que é a de sempre, palavra por palavra, no índice FTS5;
//! 2. a **tolerante por SEQUÊNCIA**, que desliza uma janela do tamanho da
//!    consulta pela letra e aceita a posição quando a palavra é igual, é
//!    prefixo, ou está a **uma edição** de distância.
//!
//! As duas medições que decidiram este desenho estão na DECISIONS #188–#192,
//! e as duas conclusões que elas compraram estão codificadas aqui:
//!
//! - **pontuar palavras soltas é armadilha** — a variante "saco de palavras"
//!   achava 79% dos trechos, e trazia **68 resultados por busca** com a música
//!   certa em primeiro em 12% das vezes. O que alguém lembra é uma
//!   **sequência**; por isso a janela, e por isso a nota é a fração casada
//!   DELA;
//! - **somar, nunca trocar** — 5 dos 721 trechos medidos são achados pela
//!   busca exata e NÃO seriam pela tolerante (a transcrição destruiu o verso e
//!   a exata se safa por não exigir ordem). Perder caso que já funciona não se
//!   negocia, e a união garante isso **por construção**: a metade exata é a
//!   mesma função de antes, com o mesmo SQL.
//!
//! # A tolerância olha só a LETRA
//!
//! A busca inteira cruza título, artista, letra, temas, pastas e nome de
//! arquivo; a metade TOLERANTE pontua só a letra. Os outros campos são
//! etiqueta escrita por gente — não é lá que a máquina erra —, e o trecho
//! destacado (`snippet`) só existe para a letra: um resultado tolerante de
//! título seria uma linha na tela sem nada que explicasse por que ela veio.

use crate::db::{self, Song};
use crate::error::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::HashSet;
use std::ops::Range;

/// Marcadores de destaque no snippet (área de uso privado do Unicode — não
/// colidem com texto de letra real). O frontend converte em <mark>.
pub const HIGHLIGHT_START: char = '\u{E000}';
pub const HIGHLIGHT_END: char = '\u{E001}';

/// **A nota mínima da metade tolerante: 60% da janela casada.** Medido em 721
/// trechos de cinco palavras (DECISIONS #188) — 54% dos trechos achados, com
/// **1,1 resultado por busca** e a música certa em primeiro em 52% delas.
/// Baixá-lo é trocar precisão por ruído; se a busca ficar lenta, o botão a
/// girar é o teto de candidatos, nunca este número.
pub const NOTA_MINIMA: f64 = 0.60;

/// O limiar acima, em pontos percentuais. O mínimo de posições casadas de uma
/// janela sai daqui por conta INTEIRA — `(0,6 * 5.0_f64).ceil()` dá 4, e não
/// 3, porque 0,6 não existe em binário. Um trecho de cinco palavras com três
/// casadas é exatamente o limiar, e ele tem de entrar.
const NOTA_MINIMA_PCT: usize = 60;

/// **De 4 letras para cima uma edição é perdão; abaixo disso é outra
/// palavra.** `sol` e `sal`, `meu` e `seu` não são a mesma coisa lembrada
/// errado — são duas coisas, e perdoá-las devolveria a música errada.
const MENOR_PALAVRA_COM_PERDAO: usize = 4;

/// **O teto de músicas que a metade tolerante pontua por tecla digitada.**
///
/// O acervo do dono tem 8.000 músicas e a busca roda enquanto se digita.
/// Quem escolhe os candidatos é o FTS5 — uma consulta com OR dos termos, que
/// é índice e é barata —, e o Rust pontua a sequência só neles.
///
/// **300 é medido, e não um número redondo** (release, 8.000 músicas COM
/// letra, a pior busca do banco de medição — oito palavras comuns):
///
/// | teto | pior busca |
/// |------|-----------|
/// | 100  | 61 ms |
/// | 300  | 62 ms |
/// | 1000 | 89 ms |
/// | 3000 | 159 ms |
/// | sem teto (8.000) | 358 ms |
///
/// A régua é o **debounce da caixa, 150 ms**: acima dele a busca vira fila, e
/// a lista passa a responder à tecla anterior. De 100 para 300 o custo não se
/// mede (o gasto está na consulta ao índice, não na pontuação), então 300 é
/// recall de graça; 3.000 já encosta na régua e 8.000 a estoura.
///
/// O corte é feito por `rank` (bm25): o que sai da lista é sempre o que tem
/// MENOS palavras da consulta. Para o teto custar um resultado, a música certa
/// precisaria ter menos termos em comum com o que foi digitado do que 300
/// outras — e aí a nota dela dificilmente chegaria a 0,60. Ver DECISIONS #192.
pub const CANDIDATOS: usize = 300;

/// Quantas palavras o trecho destacado mostra. É o mesmo 12 do `snippet()` do
/// FTS5 logo abaixo: os dois casamentos produzem trecho do mesmo tamanho, e
/// ninguém adivinha pela largura da linha qual metade da busca o achou.
const PALAVRAS_DO_TRECHO: usize = 12;

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
    let tokens = tokens_do_input(input);
    if tokens.is_empty() {
        return None;
    }
    let mut parts: Vec<String> = tokens.iter().map(|t| format!("\"{t}\"")).collect();
    parts.last_mut().unwrap().push('*');
    Some(parts.join(" "))
}

/// A consulta que ESCOLHE OS CANDIDATOS da metade tolerante: os mesmos tokens,
/// agora com **OR** e todos com prefixo.
///
/// OR porque a música procurada é justamente aquela em que alguma palavra saiu
/// errada — exigir todas (o AND da busca exata) devolveria só o que a exata já
/// devolve, e a metade tolerante não teria o que somar.
///
/// Prefixo em TODOS porque duas das três formas de casar uma posição são
/// "igual" e "é prefixo": o filtro do índice fica alinhado com a régua que
/// pontua depois.
///
/// **E cada palavra de 4 letras para cima entra TAMBÉM sem a última letra.**
/// A terceira forma de casar — uma edição — não tem como ser pedida ao FTS5,
/// que só sabe procurar prefixo; sem isto, `dormir` nunca chegaria à letra que
/// diz `dormi`, porque ela não seria nem candidata, e o caso que abriu esta
/// rodada continuaria perdido. Cortar a ÚLTIMA letra é o pedaço de tolerância
/// que cabe num índice de prefixo, e é onde a máquina mais erra: o fim da
/// palavra (`dormir`/`dormi`, `falam`/`fala`, `casas`/`casa`).
///
/// O que fica de fora, e fica escrito: erro no COMEÇO da palavra
/// (`cantar`/`contar`) só vira candidato pelas OUTRAS palavras da consulta —
/// numa busca de uma palavra só, ele se perde. Alargar mais o prefixo (três
/// letras, digamos) traria "cor", "corpo" e "correr" atrás de "coração":
/// candidato demais para achar de menos.
fn consulta_de_candidatos(input: &str) -> Option<String> {
    let tokens = tokens_do_input(input);
    if tokens.is_empty() {
        return None;
    }
    let mut termos: Vec<String> = Vec::with_capacity(tokens.len() * 2);
    for t in tokens {
        termos.push(format!("\"{t}\"*"));
        let letras: Vec<char> = t.chars().collect();
        if letras.len() >= MENOR_PALAVRA_COM_PERDAO {
            let sem_a_ultima: String = letras[..letras.len() - 1].iter().collect();
            termos.push(format!("\"{sem_a_ultima}\"*"));
        }
    }
    Some(termos.join(" OR "))
}

fn tokens_do_input(input: &str) -> Vec<&str> {
    input
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .collect()
}

// ---------------------------------------------------------------------------
// O casamento por sequência
// ---------------------------------------------------------------------------

/// Uma palavra do texto: a chave normalizada (faixa dentro de `Palavras`) e
/// onde ela começa/termina no texto ORIGINAL — é isso que deixa o trecho
/// destacado sair com a grafia, o acento e a pontuação de verdade.
struct Palavra {
    chave: Range<usize>,
    inicio: usize,
    fim: usize,
}

/// Um texto quebrado em palavras normalizadas.
///
/// As chaves moram todas num vetor só, e cada palavra guarda a sua faixa nele:
/// uma `String` por palavra seriam centenas de alocações por música, vezes
/// centenas de candidatos, a cada tecla digitada.
struct Palavras {
    chaves: Vec<char>,
    palavras: Vec<Palavra>,
}

impl Palavras {
    fn chave(&self, i: usize) -> &[char] {
        &self.chaves[self.palavras[i].chave.clone()]
    }

    fn total(&self) -> usize {
        self.palavras.len()
    }
}

/// Quebra o texto em palavras com a MESMA normalização do índice: minúsculas,
/// sem acento, só alfanumérico (`unicode61 remove_diacritics 2` do FTS5, que
/// é `db::fold_pt` do lado do Rust).
///
/// A marca combinante (o acento SOLTO da forma NFD, que o macOS entrega nos
/// caminhos de arquivo) conta como parte da palavra, e não como separador:
/// sem isso "coração" em NFD viraria duas palavras, "cora" e "cao", e a janela
/// deslizaria por um texto que não existe.
fn palavras(texto: &str) -> Palavras {
    let mut chaves: Vec<char> = Vec::with_capacity(texto.len());
    let mut palavras: Vec<Palavra> = Vec::new();
    let mut inicio: Option<usize> = None;
    let mut comeco_da_chave = 0usize;
    let mut fim = 0usize;

    for (i, c) in texto.char_indices() {
        let combinante = db::is_combining_mark(c);
        if c.is_alphanumeric() || (combinante && inicio.is_some()) {
            if inicio.is_none() {
                inicio = Some(i);
                comeco_da_chave = chaves.len();
            }
            if !combinante {
                chaves.extend(c.to_lowercase().map(db::strip_diacritic));
            }
            fim = i + c.len_utf8();
        } else if let Some(ini) = inicio.take() {
            palavras.push(Palavra { chave: comeco_da_chave..chaves.len(), inicio: ini, fim });
        }
    }
    if let Some(ini) = inicio {
        palavras.push(Palavra { chave: comeco_da_chave..chaves.len(), inicio: ini, fim });
    }
    Palavras { chaves, palavras }
}

/// Uma posição da janela casa quando a palavra da letra é **igual**, começa
/// com o que foi digitado (**prefixo** — a busca roda enquanto se digita), ou
/// está a **uma edição** de distância.
fn casa(digitada: &[char], na_letra: &[char]) -> bool {
    if digitada.is_empty() {
        return false;
    }
    if na_letra.starts_with(digitada) {
        return true;
    }
    digitada.len() >= MENOR_PALAVRA_COM_PERDAO && ate_uma_edicao(digitada, na_letra)
}

/// Uma troca, uma inserção ou uma remoção separam as duas palavras?
///
/// Não é uma distância de Levenshtein: é a pergunta "cabe em uma edição?",
/// respondida numa passada só, sem matriz. Isto roda milhões de vezes por
/// tecla digitada — a matriz seria o custo da busca inteira.
fn ate_uma_edicao(a: &[char], b: &[char]) -> bool {
    let (curta, longa) = if a.len() <= b.len() { (a, b) } else { (b, a) };
    if longa.len() - curta.len() > 1 {
        return false;
    }
    let mesmo_tamanho = curta.len() == longa.len();
    let (mut i, mut j, mut edicoes) = (0usize, 0usize, 0usize);
    while i < curta.len() && j < longa.len() {
        if curta[i] == longa[j] {
            i += 1;
            j += 1;
            continue;
        }
        edicoes += 1;
        if edicoes > 1 {
            return false;
        }
        // tamanhos iguais: é troca, e as duas andam. Tamanhos diferentes: é
        // inserção/remoção, e só a palavra longa anda.
        if mesmo_tamanho {
            i += 1;
        }
        j += 1;
    }
    // o que sobrar no fim de uma delas é a edição que ainda cabe
    edicoes + (longa.len() - j) + (curta.len() - i) <= 1
}

/// Onde a melhor janela casou, e quanto dela casou.
#[derive(Debug, Clone, Copy)]
pub struct Casamento {
    /// Fração casada da janela — de `NOTA_MINIMA` a 1,0.
    pub nota: f64,
    /// Índice, em palavras, da primeira palavra da janela dentro do texto.
    pub primeira_palavra: usize,
}

/// **A régua da metade tolerante, exatamente como foi medida.** `None` quando
/// nenhuma janela chega a `NOTA_MINIMA`.
///
/// Pública porque é ela, e não a busca inteira, que os testes precisam poder
/// interrogar: é assim que os cinco trechos que só a busca exata acha ficam
/// guardados como o que são — casos em que ESTA função diz "não".
pub fn casamento_por_sequencia(consulta: &str, texto: &str) -> Option<Casamento> {
    melhor_janela(&palavras(consulta), &palavras(texto))
}

fn melhor_janela(alvo: &Palavras, texto: &Palavras) -> Option<Casamento> {
    let n = alvo.total();
    if n == 0 || texto.total() == 0 {
        return None;
    }
    // conta inteira, para 0,6 não virar 0,6000000000000001 (ver NOTA_MINIMA_PCT)
    let minimo = (n * NOTA_MINIMA_PCT).div_ceil(100);
    // texto menor que a consulta tem UMA janela (a curta), e o denominador
    // continua sendo `n`: meia letra não vira nota cheia por ser meia letra.
    let ultimo_inicio = texto.total().saturating_sub(n);

    let mut melhor_casaram = 0usize;
    let mut melhor_inicio = 0usize;
    for inicio in 0..=ultimo_inicio {
        let mut casaram = 0usize;
        for k in 0..n {
            // se nem casando tudo que falta esta janela passa da melhor, ela
            // já não interessa — é o que segura o custo em letra comprida
            if casaram + (n - k) <= melhor_casaram {
                break;
            }
            if inicio + k < texto.total() && casa(alvo.chave(k), texto.chave(inicio + k)) {
                casaram += 1;
            }
        }
        if casaram > melhor_casaram {
            melhor_casaram = casaram;
            melhor_inicio = inicio;
        }
        if melhor_casaram == n {
            break;
        }
    }

    (melhor_casaram >= minimo).then(|| Casamento {
        nota: melhor_casaram as f64 / n as f64,
        primeira_palavra: melhor_inicio,
    })
}

/// O trecho da letra em volta da janela que casou, com as palavras casadas
/// entre os marcadores de destaque.
///
/// O destaque cai na palavra que ESTÁ NA LETRA — que é justamente a que a
/// máquina escreveu errado. Ver ali a diferença entre o que se lembrava e o
/// que está gravado é metade do que a pessoa foi buscar.
fn trecho_da_janela(letra: &str, texto: &Palavras, alvo: &Palavras, janela: usize) -> String {
    let n = alvo.total();
    let fim_da_janela = (janela + n).min(texto.total());
    let sobra = PALAVRAS_DO_TRECHO.saturating_sub(fim_da_janela - janela);
    let comeco = janela.saturating_sub(sobra / 2);
    let fim = (comeco + PALAVRAS_DO_TRECHO.max(fim_da_janela - janela)).min(texto.total());

    let mut trecho = String::new();
    if comeco > 0 {
        trecho.push('…');
    }
    for i in comeco..fim {
        if i > comeco {
            // o que havia ENTRE as duas palavras no texto original (espaço,
            // vírgula, quebra de linha) — o trecho é a letra, não uma
            // reescrita dela
            trecho.push_str(&letra[texto.palavras[i - 1].fim..texto.palavras[i].inicio]);
        }
        let palavra = &letra[texto.palavras[i].inicio..texto.palavras[i].fim];
        let destacada = (janela..fim_da_janela).contains(&i)
            && casa(alvo.chave(i - janela), texto.chave(i));
        if destacada {
            trecho.push(HIGHLIGHT_START);
            trecho.push_str(palavra);
            trecho.push(HIGHLIGHT_END);
        } else {
            trecho.push_str(palavra);
        }
    }
    if fim < texto.total() {
        trecho.push('…');
    }
    trecho
}

// ---------------------------------------------------------------------------
// A busca
// ---------------------------------------------------------------------------

/// Busca em título, artista, letra, temas, pastas (F12) e NOME DO ARQUIVO
/// (V8). Query vazia/só-especiais devolve a biblioteca completa em ordem
/// alfabética (comportamento do PRD para campo limpo), sem snippets.
///
/// **A UNIÃO (V13):** primeiro o que a busca exata acha — que é o que o
/// produto sempre achou, com o mesmo SQL —, depois o que o casamento por
/// sequência achar na letra, por nota decrescente. As duas ordens não viram um
/// número só: casamento exato é mais confiável que casamento perdoado, e
/// misturá-los faria a nota de um empurrar o outro para baixo sem que ninguém
/// pudesse dizer por quê.
pub fn search(conn: &Connection, input: &str, limit: usize) -> Result<Vec<SearchResult>> {
    let Some(fts_query) = sanitize_fts_query(input) else {
        return Ok(db::list_songs(conn)?
            .into_iter()
            .map(|song| SearchResult { song, snippet: None })
            .collect());
    };

    let mut resultados = busca_exata(conn, &fts_query, limit)?;
    // a exata já encheu a tela: não há vaga para somar, e pontuar candidato
    // seria trabalho para jogar fora
    if resultados.len() >= limit {
        return Ok(resultados);
    }
    let vagas = limit - resultados.len();
    let ja_achadas: HashSet<i64> = resultados.iter().map(|r| r.song.id).collect();
    resultados.extend(busca_tolerante(conn, input, &ja_achadas, vagas)?);
    Ok(resultados)
}

/// A busca de sempre, palavra por palavra, no índice FTS5.
///
/// O snippet vem SEMPRE da coluna de letra: `snippet(songs_fts, 2, ...)` —
/// índice 2 = lyrics na FTS (title, artist, lyrics, temas, pastas, arquivo).
/// Match só em tema/pasta/nome de arquivo portanto nunca gera snippet (o
/// marcador de destaque não aparece e o filter abaixo descarta). Coluna nova
/// na FTS entra no FIM para este índice não escorregar — ver FTS_SCHEMA e
/// `fts_column_order_pins_lyrics_at_index_2` em db.rs.
fn busca_exata(conn: &Connection, fts_query: &str, limit: usize) -> Result<Vec<SearchResult>> {
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

    // O snippet é a última coluna do SELECT, logo após as da Song — derivado
    // de SONG_COLS para não quebrar quando a Song ganha um campo (V5/F14).
    let snippet_idx = db::song_col_count();
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
            let raw_snippet: Option<String> = r.get(snippet_idx)?;
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

/// A metade tolerante: o FTS5 escolhe os candidatos (índice, barato), o Rust
/// pontua a sequência só neles (caro, e por isso com teto).
///
/// A letra é lida em duas etapas de propósito. A primeira pega só os `rowid`
/// ordenados por `rank` — deixar o `JOIN` dentro dessa consulta faria o SQLite
/// carregar a letra INTEIRA de todas as músicas casadas para depois jogar
/// fora todas menos as do teto.
fn busca_tolerante(
    conn: &Connection,
    input: &str,
    ja_achadas: &HashSet<i64>,
    vagas: usize,
) -> Result<Vec<SearchResult>> {
    let Some(consulta) = consulta_de_candidatos(input) else {
        return Ok(Vec::new());
    };
    let alvo = palavras(input);
    if alvo.total() == 0 {
        return Ok(Vec::new());
    }

    let candidatos: Vec<i64> = {
        let mut stmt = conn.prepare_cached(
            "SELECT rowid FROM songs_fts WHERE songs_fts MATCH ?1 ORDER BY rank LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![consulta, CANDIDATOS as i64], |r| r.get(0))?;
        rows.collect::<std::result::Result<_, _>>()?
    };

    let mut achadas: Vec<(f64, i64, String)> = Vec::new();
    let mut ler_letra = conn.prepare_cached(
        "SELECT lyrics FROM songs WHERE id = ?1 AND lyrics IS NOT NULL AND lyrics <> ''",
    )?;
    for id in candidatos {
        // o que a busca exata já achou está na tela: pontuar de novo só
        // produziria a mesma música duas vezes
        if ja_achadas.contains(&id) {
            continue;
        }
        let letra: Option<String> = ler_letra
            .query_row(params![id], |r| r.get(0))
            .optional()?;
        let Some(letra) = letra else { continue };
        let texto = palavras(&letra);
        let Some(casamento) = melhor_janela(&alvo, &texto) else {
            continue;
        };
        achadas.push((
            casamento.nota,
            id,
            trecho_da_janela(&letra, &texto, &alvo, casamento.primeira_palavra),
        ));
    }

    // nota decrescente; empate mantém a ordem do `rank` do FTS5 (sort estável)
    achadas.sort_by(|a, b| b.0.total_cmp(&a.0));
    achadas.truncate(vagas);

    let mut resultados = Vec::with_capacity(achadas.len());
    for (_, id, trecho) in achadas {
        if let Some(song) = db::get_song(conn, id)? {
            resultados.push(SearchResult { song, snippet: Some(trecho) });
        }
    }
    Ok(resultados)
}
