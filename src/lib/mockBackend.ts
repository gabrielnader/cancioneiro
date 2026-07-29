import type {
  Backend,
  EnrichApply,
  EnrichApplyResult,
  EnrichProgress,
  EnrichProposal,
} from "./api";
import { isUnderFolder } from "./folderTree";
import { HIGHLIGHT_END, HIGHLIGHT_START } from "./highlight";
import type {
  Folder,
  Playlist,
  PlaylistItem,
  ScanProgress,
  ScanResult,
  SearchResult,
  Song,
} from "./types";
import { ORIGEM_TRANSCRICAO, ORIGEM_VAGALUME } from "./types";

/**
 * Backend em memória com a mesma semântica do backend Rust (src-tauri),
 * usado quando o app roda fora do Tauri: dev no navegador e E2E Playwright.
 *
 * Estado persistido em localStorage ("cancioneiro-mock-db") para que os
 * testes E2E de persistência (reload da página = "restart" do app) passem.
 */
export interface MockBackend extends Backend {
  /** Popula N músicas sintéticas ("Música 1"..N) para testes de volume. */
  _seedSongs(count: number): void;
  /** Simula a deleção do arquivo no disco (fileExists → false; scan remove do índice). */
  _removeFileFromDisk(filePath: string): void;
  /**
   * Simula o que a curadoria (`tools/curadoria.py transcrever`) deixa no MP3:
   * TXXX:LETRA_ORIGEM = "transcricao". Compõe com qualquer seed — é assim que
   * testes e E2E produzem uma música com letra transcrita.
   */
  _markAsTranscribed(filePath: string): void;
  /**
   * Simula o que a curadoria deixa no MP3 de uma música sem voz:
   * TXXX:INSTRUMENTAL = "1" (V8/F17). Compõe com qualquer seed — é assim que
   * testes e E2E produzem uma música instrumental.
   */
  _markAsInstrumental(filePath: string): void;
  /** Zera o estado em memória e a persistência. */
  _reset(): void;
  /** Valor devolvido pelo próximo pickFolder(). */
  _nextPickedFolder: string;
  /**
   * Simula falta de rede: o funil NUNCA rejeita — cada proposta vem com
   * error "sem conexão" e a linha fica desabilitada (V5, DECISIONS #47 —
   * mesma semântica do backend real).
   */
  _offline: boolean;
  /**
   * Atraso artificial POR MÚSICA na varredura F13 (0 = instantâneo). Só o E2E
   * usa: sem ele a varredura mockada termina no mesmo tick e não dá para ver a
   * barra de progresso nem o modo "segundo plano".
   */
  _enrichDelayMs: number;
  /**
   * Simula uma chave do Vagalume recusada pelo serviço (HTTP 401): a etapa 3
   * falha com `ERRO_CHAVE_RECUSADA` e, como no Rust, desliga-se pelo resto da
   * varredura — a primeira música avisa, as seguintes pulam em silêncio.
   */
  _vagalumeKeyRecusada: boolean;
  /** Popula a pasta /acervo com subpastas 1/ e 2/ para o E2E da árvore (V4 F11). */
  _seedFolderTree(): void;
}

const STORAGE_KEY = "cancioneiro-mock-db";

interface SongRecord extends Song {
  lyrics: string | null;
}

interface PlaylistRecord {
  id: number;
  name: string;
}

interface PlaylistItemRecord {
  id: number;
  playlist_id: number;
  position: number;
  song_id: number;
}

interface DbState {
  folders: Folder[];
  songs: SongRecord[];
  playlists: PlaylistRecord[];
  playlistItems: PlaylistItemRecord[];
  deletedFiles: string[];
  nextFolderId: number;
  nextSongId: number;
  nextPlaylistId: number;
  nextItemId: number;
}

function freshState(): DbState {
  return {
    folders: [],
    songs: [],
    playlists: [],
    playlistItems: [],
    deletedFiles: [],
    nextFolderId: 1,
    nextSongId: 1,
    nextPlaylistId: 1,
    nextItemId: 1,
  };
}

function loadState(): DbState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return freshState();
    const parsed = JSON.parse(raw) as Partial<DbState>;
    return { ...freshState(), ...parsed };
  } catch {
    return freshState();
  }
}

/** Letra EXATA da fixture com_letra.mp3 (mesma do backend Rust de testes). */
const FIXTURE_LYRICS =
  "Quando o sol amanhecer\nMeu coração vai cantar\nA esperança vai nascer\nE a alegria vai chegar\n\nNão há noite sem estrela\nNão há dor que não se cura";

const FIXTURE_BASENAMES = ["com_letra.mp3", "sem_letra.mp3", "sem_tags.mp3"];

/** Remove diacríticos (NFD) e baixa a caixa — espelha remove_diacritics do FTS5. */
function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/** Tokens alfanuméricos normalizados (split em não-alfanuméricos). */
function tokenize(text: string): string[] {
  return normalize(text)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Verifica se todos os tokens da query casam com a lista de palavras:
 * tokens intermediários casam palavra inteira; o último casa como prefixo
 * (comportamento de "busca enquanto digita" do FTS5 com `token*`).
 */
function matchesAll(words: string[], tokens: string[]): boolean {
  return tokens.every((token, i) => {
    const isLast = i === tokens.length - 1;
    return isLast
      ? words.some((w) => w.startsWith(token))
      : words.includes(token);
  });
}

/**
 * Normalização de temas do writer Rust/Python: trim, minúsculas, dedup e
 * ordem alfabética sem acento. Lista vazia → null (remove o TXXX:TEMAS).
 */
function normalizeTemas(raw: string | null): string | null {
  if (!raw) return null;
  const seen = new Set<string>();
  const list: string[] = [];
  for (const part of raw.split(";")) {
    const tema = part.trim().toLowerCase();
    if (!tema || seen.has(tema)) continue;
    seen.add(tema);
    list.push(tema);
  }
  if (list.length === 0) return null;
  list.sort((a, b) => normalize(a).localeCompare(normalize(b)));
  return list.join("; ");
}

function wordMatchesAnyToken(word: string, tokens: string[]): boolean {
  const norm = tokenize(word).join("");
  if (!norm) return false;
  return tokens.some((token, i) =>
    i === tokens.length - 1 ? norm.startsWith(token) : norm === token,
  );
}

/**
 * Trecho da letra (~12 palavras) em torno da primeira ocorrência de um token,
 * com cada palavra que casa envolta em HIGHLIGHT_START/HIGHLIGHT_END
 * (mesmos marcadores do comando `search` do Rust — ver src/lib/highlight.ts).
 */
function buildSnippet(lyrics: string, tokens: string[]): string | null {
  const words = lyrics.split(/\s+/).filter(Boolean);
  const firstIdx = words.findIndex((w) => wordMatchesAnyToken(w, tokens));
  if (firstIdx === -1) return null;

  const WINDOW = 12;
  const start = Math.max(0, firstIdx - Math.floor(WINDOW / 2) + 1);
  const end = Math.min(words.length, start + WINDOW);

  const parts = words.slice(start, end).map((w) =>
    wordMatchesAnyToken(w, tokens) ? `${HIGHLIGHT_START}${w}${HIGHLIGHT_END}` : w,
  );
  let snippet = parts.join(" ");
  if (start > 0) snippet = `…${snippet}`;
  if (end < words.length) snippet = `${snippet}…`;
  return snippet;
}

function toSong(record: SongRecord): Song {
  return {
    id: record.id,
    file_path: record.file_path,
    folder_id: record.folder_id,
    title: record.title,
    artist: record.artist,
    album: record.album,
    duration_seconds: record.duration_seconds,
    has_lyrics: record.has_lyrics,
    available: record.available,
    temas: record.temas ?? null,
    letra_origem: record.letra_origem ?? null,
    instrumental: record.instrumental === true,
  };
}

const SEED_ARTISTS = [
  "Artista do Sertão",
  "Banda da Estrada",
  "Dupla Coração",
  "Trio Nordestino",
  "Cantores da Lua",
];

const SEED_WORDS = [
  "saudade", "estrada", "viola", "lua", "sertão", "coração", "amor", "chuva",
  "flor", "campo", "rio", "noite", "sol", "vento", "canção", "esperança",
  "alegria", "festa", "beijo", "caminho", "cidade", "praia", "mar", "céu",
  "estrela", "sonho", "vida", "tempo", "distância", "abraço", "madrugada",
  "violão", "poeira", "boiada", "fogueira", "rancho", "janela", "retrato",
];

function seedLyrics(songIndex: number): string {
  const lines: string[] = [];
  for (let line = 0; line < 10; line++) {
    const words: string[] = [];
    for (let w = 0; w < 5; w++) {
      words.push(SEED_WORDS[(songIndex * 7 + line * 3 + w) % SEED_WORDS.length]);
    }
    lines.push(words.join(" "));
  }
  return lines.join("\n");
}

/** Nome-base do arquivo (sem diretório) — o que o progresso F13 exibe. */
function nomeArquivo(song: { file_path: string }): string {
  return song.file_path.split(/[\\/]/).pop() ?? "";
}

/**
 * Nome do arquivo que ENTRA NA BUSCA (V8) — espelha songs.arquivo do backend
 * (indexer::arquivo_para_busca): nome-base SEM a extensão, e vazio quando ele
 * é o próprio título (música sem tag), para o mesmo texto não pesar duas vezes
 * no índice. O snippet continua saindo só da letra, aqui como lá.
 */
function arquivoParaBusca(song: SongRecord): string {
  const stem = nomeArquivo(song).replace(/\.[^.]+$/, "");
  return normalize(stem) === normalize(song.title.trim()) ? "" : stem;
}

/**
 * Proposta que não pede decisão nenhuma: proposto idêntico ao atual e sem
 * letra para acrescentar. O teste real (acervo de 94 músicas) mostrou linhas
 * "atual → proposto" iguais, sem nada a decidir — o backend Rust as descarta
 * na origem e o mock espelha. Propostas COM letra ou COM erro continuam: a
 * letra é o ganho e a linha com erro precisa ficar visível (desabilitada).
 */
/**
 * Etapas do funil (V8/F18) como o backend as manda para a tela: pt-BR, prontas
 * para exibir. O evento inicial (done=0) sai com a etapa de preparo, antes de
 * qualquer consulta.
 */
const ETAPA_PREPARANDO = "preparando";
const FONTE_ARQUIVO = "nome do arquivo";
const FONTE_LRCLIB = "LRCLIB";
const FONTE_VAGALUME = "Vagalume";
/** Fonte das linhas que existem para INFORMAR a falha (enrich::FONTE_ERRO). */
const FONTE_ERRO = "erro";

/**
 * Recusa do apply quando a gravação trocaria uma letra que já existe sem o
 * consentimento explícito da revisão (CRÍTICO-1). Texto idêntico ao do Rust:
 * ele aparece na linha, e é o único lugar onde a pessoa vai ler o que fazer.
 */
/**
 * Chave do Vagalume rejeitada pelo serviço — mesmo texto do
 * `vagalume::ERRO_CHAVE_RECUSADA`. É o único erro de rede que vale para a
 * varredura INTEIRA: os outros ("fora do ar", "espere um pouco") podem ter
 * sido soluço, e a música seguinte merece a tentativa.
 */
const ERRO_CHAVE_RECUSADA =
  "a chave do Vagalume foi recusada — confira se copiou a chave inteira";

const RECUSA_LETRA_EXISTENTE =
  'esta música já tem letra — marque "substituir a letra atual" para trocá-la';

// ---------------------------------------------------------------------------
// Placeholders — porte do `is_placeholder` do Rust (que por sua vez porta o
// `eh_placeholder` do tools/curadoria.py). Tag placeholder vale VAZIO em todo
// ponto: não é palpite, não abre o Vagalume e NÃO marca a música como
// completa. Foi por não olhar isto que a contagem do app dava zero num CD
// ripado inteiro de "Faixa 01…12 / Artista Desconhecido".
// ---------------------------------------------------------------------------

const PLACEHOLDERS_EXATOS = new Set([
  "artist", "no artist", "unknown artist", "artista desconhecido",
  "artista desconhecida", "unknown", "desconhecido", "desconhecida",
  "no title", "sem titulo", "untitled", "unknown title", "titulo desconhecido",
]);

/** Chave normalizada: sem acento, minúscula, só alfanumérico e espaço. */
function chaveDeTag(texto: string): string {
  return normalize(texto)
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** "AudioTrack 02", "02 Faixa 3", "track", "Pista 3"… */
const PLACEHOLDER_FAIXA = /^(?:\d+ )?(?:audio ?track|faixa|track|pista)(?: ?\d+)?$/;

function isPlaceholder(texto: string): boolean {
  const chave = chaveDeTag(texto);
  if (chave === "" || /^\d+$/.test(chave)) return true;
  if (PLACEHOLDERS_EXATOS.has(chave)) return true;
  return PLACEHOLDER_FAIXA.test(chave);
}

/** A tag como o funil a enxerga: placeholder vira string vazia. */
function tagReal(texto: string | null | undefined): string {
  const t = (texto ?? "").trim();
  return isPlaceholder(t) ? "" : t;
}

/**
 * Dois campos valem o MESMO valor (porte do `mesmo_valor` do Rust): espaços
 * das pontas removidos, `null` e "" tratados como o mesmo ausente. Comparar
 * com `!==` cru recusava propostas boas dizendo "a música mudou".
 */
function mesmoValor(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? "").trim() === (b ?? "").trim();
}

/**
 * O "LRCLIB" do mock: um catálogo minúsculo e determinístico, com as músicas
 * das fixtures. Quem tem tag real FORA do catálogo é exatamente o caso que a
 * etapa 3 existe para atender — é assim que o mock ganha um caminho de
 * Vagalume sem contrariar a regra real (título E artista de verdade).
 */
const LRCLIB_CATALOGO: Record<
  string,
  { titulo: string; artista: string; alta: boolean }
> = {
  // a única ALTA: a duração confere (é a fixture com_letra)
  "coracao sertanejo": {
    titulo: "Coração Sertanejo",
    artista: "Artista Teste",
    alta: true,
  },
  "instrumental sem letra": {
    titulo: "Instrumental Sem Letra",
    artista: "Banda Fixture",
    alta: false,
  },
};

/**
 * Etapa do funil em que uma proposta com esta procedência foi resolvida —
 * mesmas strings do backend Rust (enrich::ETAPA_*), que é quem a UI mostra.
 *
 * O Rust emite um evento ao ENTRAR em cada etapa e outro ao concluir a música;
 * o mock coalesce isso num evento por música, com a etapa que a resolveu: sem
 * latência de rede os eventos sairiam todos no mesmo tique e a tela só mostraria
 * o último.
 */
function etapaDaFonte(fonte: string): string {
  if (fonte === FONTE_LRCLIB) return "procurando no LRCLIB";
  if (fonte === FONTE_VAGALUME) return "procurando no Vagalume";
  return "lendo etiquetas e nome do arquivo";
}

function propostaNoOp(p: EnrichProposal): boolean {
  return (
    p.error === null &&
    p.lyrics === null &&
    p.proposed_title === p.current_title &&
    p.proposed_artist === p.current_artist
  );
}

export function createMockBackend(): MockBackend {
  let state = loadState();
  const progressListeners = new Set<(p: ScanProgress) => void>();
  const enrichProgressListeners = new Set<(p: EnrichProgress) => void>();
  /** Varreduras que pediram cancelamento e ainda não pararam (M4). */
  const enrichCancelled = new Set<string>();

  function save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // storage cheio/indisponível: segue apenas em memória
    }
  }

  function emitProgress(total: number): void {
    for (let done = 0; done <= total; done++) {
      const payload: ScanProgress = { done, total };
      progressListeners.forEach((cb) => cb(payload));
    }
  }

  function emitEnrichProgress(
    scanId: string,
    done: number,
    total: number,
    atual: string,
    etapa: string,
  ): void {
    // o evento carrega a varredura que o emitiu: a UI ignora o que vier de
    // uma varredura já cancelada (M4). `etapa` (V8/F18) é a etapa do funil em
    // curso, em pt-BR e pronta para exibir.
    const payload: EnrichProgress = { done, total, atual, etapa, scan_id: scanId };
    enrichProgressListeners.forEach((cb) => cb(payload));
  }

  function renumber(playlistId: number): void {
    state.playlistItems
      .filter((i) => i.playlist_id === playlistId)
      .sort((a, b) => a.position - b.position)
      .forEach((item, idx) => {
        item.position = idx;
      });
  }

  function removeSongs(predicate: (s: SongRecord) => boolean): number {
    const doomed = state.songs.filter(predicate);
    if (doomed.length === 0) return 0;
    const doomedIds = new Set(doomed.map((s) => s.id));
    state.songs = state.songs.filter((s) => !doomedIds.has(s.id));
    const touched = new Set(
      state.playlistItems
        .filter((i) => doomedIds.has(i.song_id))
        .map((i) => i.playlist_id),
    );
    state.playlistItems = state.playlistItems.filter((i) => !doomedIds.has(i.song_id));
    touched.forEach(renumber);
    return doomed.length;
  }

  /**
   * Candidata da varredura — o MESMO predicado que o `enrichCount` usa
   * (ALTO-2/ALTO-5). Porte do `candidata` do Rust:
   *
   * - indisponível fica de fora;
   * - completa = título E artista REAIS (placeholder vale vazio) mais letra;
   * - para o INSTRUMENTAL a letra sai da conta (V8/F17): sem voz não há letra
   *   a buscar em fonte nenhuma. Mas ele NÃO é excluído — "instrumental sem
   *   letra ainda pode (e deve) ter título e artista corretos" (PRD V8), e era
   *   justamente essa pasta que o app declarava completa com o botão cinza.
   */
  function candidataDoFunil(song: SongRecord, folderPrefix: string): boolean {
    if (!song.available) return false;
    // prefixo casa na FRONTEIRA de separador ("/m/1" não casa "/m/10/a.mp3"),
    // como isUnderFolder e o backend Rust
    if (folderPrefix && !isUnderFolder(song.file_path, folderPrefix)) return false;
    const nomesProntos = tagReal(song.title) !== "" && tagReal(song.artist) !== "";
    const completa = nomesProntos && (song.instrumental === true || song.has_lyrics);
    return !completa;
  }

  /**
   * O funil inteiro para UMA música (V8/F18), na ordem de custo crescente:
   * o que já está no arquivo → LRCLIB → Vagalume (só com chave). É o mesmo
   * caminho para o lote e para o caso pontual do editor — duas implementações
   * divergiriam, e é justamente a procedência que a pessoa usa para decidir.
   *
   * `digitado` são o título/artista VIVOS do editor, quando existem: quem
   * clicou já corrigiu a etiqueta errada, e procurar pela etiqueta velha era
   * um beco sem saída com cara de "a internet não tem a minha música".
   */
  function propostaDoFunil(
    song: SongRecord,
    vagalumeKey: string | null,
    digitado?: { title?: string | null; artist?: string | null },
    /** Estado da VARREDURA (não da música): a chave já foi recusada? */
    estado: { chaveRecusada: boolean } = { chaveRecusada: false },
  ): EnrichProposal {
    const tituloTag = tagReal(digitado?.title ?? song.title);
    const artistaTag = tagReal(digitado?.artist ?? song.artist);
    const base = {
      song_id: song.id,
      file_path: song.file_path,
      current_title: song.title,
      current_artist: song.artist,
      // CRÍTICO-1: a revisão precisa saber que existe letra ali, e de que tipo
      has_lyrics: song.has_lyrics,
      letra_origem: song.letra_origem ?? null,
    };

    /** Palpite da etapa 1: tag REAL vence o nome do arquivo (nunca apaga). */
    function propostaDoArquivo(error: string | null): EnrichProposal {
      const bruto = nomeArquivo(song).replace(/\.[^.]+$/, "");
      const stem = bruto.replace(/_/g, " ").replace(/\s+/g, " ").trim();
      const divisor = stem.indexOf(" - ");
      const [guessArtist, guessTitle] =
        divisor > 0
          ? [stem.slice(0, divisor).trim(), stem.slice(divisor + 3).trim()]
          : [null, stem];
      // Um título que é o PRÓPRIO nome do arquivo não é etiqueta de ninguém:
      // foi o indexador que o copiou do disco quando o MP3 não tinha TIT2
      // (mesma noção do arquivoParaBusca daqui de cima). Tratá-lo como tag
      // real faria a etapa 1 propor exatamente o que já está lá — e é só por
      // isso que uma música sem tag nenhuma tem o que receber aqui.
      const tituloEhOArquivo = chaveDeTag(bruto) === chaveDeTag(song.title);
      const tituloDeTag = tituloEhOArquivo ? "" : tituloTag;
      return {
        ...base,
        proposed_title: tituloDeTag || guessTitle || song.title,
        proposed_artist: artistaTag || guessArtist,
        lyrics: null,
        confidence: "baixa",
        fonte: error !== null ? FONTE_ERRO : FONTE_ARQUIVO,
        error,
      };
    }

    // arquivo sumido do disco: reporta sem gastar "rede"
    if (state.deletedFiles.includes(song.file_path)) {
      return propostaDoArquivo(`arquivo não encontrado: ${song.file_path}`);
    }

    // V8/F17 — as etapas 2 e 3 são etapas de LETRA e param aqui para música
    // sem voz. NÃO é filtro de completude (o instrumental é candidato e pode
    // ganhar nome): é integridade. Um instrumental com nomes certos casa com
    // a versão CANTADA no LRCLIB, sai ALTA e chega PRÉ-MARCADA (DECISIONS
    // #49) — um clique gravaria a letra de outra gravação no arquivo.
    if (song.instrumental === true) {
      return propostaDoArquivo(null);
    }

    // sem rede: o backend real NUNCA rejeita — o erro vem POR MÚSICA
    // na proposta e a linha fica desabilitada (DECISIONS #47)
    if (backend._offline) {
      return propostaDoArquivo("sem conexão");
    }

    // --- etapa 2: LRCLIB (título + duração conferida) ----------------------
    const hit = LRCLIB_CATALOGO[chaveDeTag(tituloTag)];
    if (hit) {
      return {
        ...base,
        proposed_title: hit.titulo,
        proposed_artist: hit.artista,
        lyrics: FIXTURE_LYRICS,
        confidence: hit.alta ? "alta" : "media",
        fonte: FONTE_LRCLIB,
        error: null,
      };
    }

    // --- etapa 3: Vagalume, só com chave E com as DUAS tags reais ----------
    //
    // A regra é a do enrich.rs: o Vagalume não tem duração, e a igualdade de
    // palavras dos dois lados é a única prova que existe — ela precisa de um
    // pedido que já signifique alguma coisa. Palpite de nome de arquivo não é
    // isso. E o caminho NUNCA propõe nome novo: a letra é a mudança inteira
    // (DECISIONS #63 — "Ponto de Ogum" dentro de "Ponto de Oxum").
    if (vagalumeKey && tituloTag && artistaTag && !estado.chaveRecusada) {
      if (backend._vagalumeKeyRecusada) {
        // veredito sobre a varredura inteira: registra e desliga a etapa —
        // repetir o mesmo aviso em 95 linhas não informa ninguém, e insistir
        // seria bater num serviço que já disse não
        estado.chaveRecusada = true;
        return propostaDoArquivo(ERRO_CHAVE_RECUSADA);
      }
      return {
        ...base,
        proposed_title: tituloTag,
        proposed_artist: artistaTag,
        lyrics: FIXTURE_LYRICS,
        confidence: "media",
        fonte: FONTE_VAGALUME,
        error: null,
      };
    }

    // resto: só o palpite da etapa 1
    return propostaDoArquivo(null);
  }

  function songWords(song: SongRecord): string[] {
    return tokenize(
      `${song.title} ${song.artist ?? ""} ${song.lyrics ?? ""} ${song.temas ?? ""} ${arquivoParaBusca(song)}`,
    );
  }

  const backend: MockBackend = {
    _nextPickedFolder: "/musicas/mock",
    _offline: false,
    _enrichDelayMs: 0,
    _vagalumeKeyRecusada: false,

    async addFolder(path: string): Promise<ScanResult> {
      let folder = state.folders.find((f) => f.path === path);
      if (!folder) {
        folder = { id: state.nextFolderId++, path, last_scanned_at: null };
        state.folders.push(folder);
      }
      folder.last_scanned_at = new Date().toISOString();

      // pasta "vazia" simula pasta sem nenhum MP3 (PRD F1: ainda é registrada)
      if (path.includes("vazia")) {
        emitProgress(0);
        save();
        return { indexed: 0, skipped: 0, removed: 0, total: 0, missing_folders: [] };
      }

      const fixtures: Array<Omit<SongRecord, "id" | "folder_id">> = [
        {
          file_path: `${path}/com_letra.mp3`,
          title: "Coração Sertanejo",
          artist: "Artista Teste",
          album: null,
          duration_seconds: 3,
          has_lyrics: true,
          available: true,
          lyrics: FIXTURE_LYRICS,
          temas: "água; esperança",
        },
        {
          file_path: `${path}/sem_letra.mp3`,
          title: "Instrumental Sem Letra",
          artist: "Banda Fixture",
          album: null,
          duration_seconds: 2,
          has_lyrics: false,
          available: true,
          lyrics: null,
        },
        {
          file_path: `${path}/sem_tags.mp3`,
          title: "sem_tags",
          artist: null,
          album: null,
          duration_seconds: 2,
          has_lyrics: false,
          available: true,
          lyrics: null,
        },
      ];

      let indexed = 0;
      let skipped = 0;
      for (const fixture of fixtures) {
        const exists = state.songs.some((s) => s.file_path === fixture.file_path);
        if (exists) {
          skipped++;
          continue;
        }
        state.songs.push({ ...fixture, id: state.nextSongId++, folder_id: folder.id });
        indexed++;
      }

      const total = state.songs.filter((s) => s.folder_id === folder.id).length;
      emitProgress(total);
      save();
      return { indexed, skipped, removed: 0, total, missing_folders: [] };
    },

    async removeFolder(folderId: number): Promise<void> {
      state.folders = state.folders.filter((f) => f.id !== folderId);
      removeSongs((s) => s.folder_id === folderId);
      save();
    },

    async listFolders(): Promise<Folder[]> {
      return state.folders.map((f) => ({ ...f }));
    },

    async scan(): Promise<ScanResult> {
      const deleted = new Set(state.deletedFiles);
      const removed = removeSongs((s) => deleted.has(s.file_path));
      const total = state.songs.length;
      emitProgress(total);
      save();
      return { indexed: 0, skipped: total, removed, total, missing_folders: [] };
    },

    async listSongs(): Promise<Song[]> {
      return state.songs.map(toSong);
    },

    async search(query: string): Promise<SearchResult[]> {
      const tokens = tokenize(query);

      // query vazia / só caracteres especiais → biblioteca completa, alfabética
      if (tokens.length === 0) {
        return [...state.songs]
          .sort((a, b) => a.title.localeCompare(b.title))
          .map((song) => ({ song: toSong(song), snippet: null }));
      }

      const matched: Array<{ song: SongRecord; snippet: string | null; rank: number }> = [];
      for (const song of state.songs) {
        if (!matchesAll(songWords(song), tokens)) continue;

        const titleArtistWords = tokenize(`${song.title} ${song.artist ?? ""}`);
        const titleArtistOnly = matchesAll(titleArtistWords, tokens);
        const snippet =
          !titleArtistOnly && song.lyrics ? buildSnippet(song.lyrics, tokens) : null;

        // relevância aproximada do rank FTS5: match em título/artista primeiro
        const titleWords = tokenize(song.title);
        const rank = matchesAll(titleWords, tokens) || titleArtistOnly ? 0 : 1;
        matched.push({ song, snippet, rank });
      }

      matched.sort(
        (a, b) => a.rank - b.rank || a.song.title.localeCompare(b.song.title),
      );
      return matched.map((m) => ({ song: toSong(m.song), snippet: m.snippet }));
    },

    async getLyrics(songId: number): Promise<string | null> {
      const song = state.songs.find((s) => s.id === songId);
      if (!song) {
        throw new Error(`Música não encontrada: id ${songId}`);
      }
      return song.lyrics;
    },

    async fileExists(path: string): Promise<boolean> {
      return !state.deletedFiles.includes(path);
    },

    async createPlaylist(name: string): Promise<number> {
      if (!name.trim()) {
        throw new Error("O nome da playlist não pode ser vazio.");
      }
      const playlist: PlaylistRecord = { id: state.nextPlaylistId++, name };
      state.playlists.push(playlist);
      save();
      return playlist.id;
    },

    async deletePlaylist(playlistId: number): Promise<void> {
      state.playlists = state.playlists.filter((p) => p.id !== playlistId);
      state.playlistItems = state.playlistItems.filter(
        (i) => i.playlist_id !== playlistId,
      );
      save();
    },

    async listPlaylists(): Promise<Playlist[]> {
      return state.playlists.map((p) => ({
        id: p.id,
        name: p.name,
        song_count: state.playlistItems.filter((i) => i.playlist_id === p.id).length,
      }));
    },

    async getPlaylistItems(playlistId: number): Promise<PlaylistItem[]> {
      return state.playlistItems
        .filter((i) => i.playlist_id === playlistId)
        .sort((a, b) => a.position - b.position)
        .flatMap((item) => {
          const song = state.songs.find((s) => s.id === item.song_id);
          if (!song) return [];
          return [
            {
              id: item.id,
              playlist_id: item.playlist_id,
              position: item.position,
              song: toSong(song),
            },
          ];
        });
    },

    async addToPlaylist(playlistId: number, songId: number): Promise<number> {
      const playlist = state.playlists.find((p) => p.id === playlistId);
      if (!playlist) throw new Error(`Playlist não encontrada: id ${playlistId}`);
      const song = state.songs.find((s) => s.id === songId);
      if (!song) throw new Error(`Música não encontrada: id ${songId}`);

      const position = state.playlistItems.filter(
        (i) => i.playlist_id === playlistId,
      ).length;
      const item: PlaylistItemRecord = {
        id: state.nextItemId++,
        playlist_id: playlistId,
        position,
        song_id: songId,
      };
      state.playlistItems.push(item);
      save();
      return item.id;
    },

    async removePlaylistItem(itemId: number): Promise<void> {
      const item = state.playlistItems.find((i) => i.id === itemId);
      if (!item) return;
      state.playlistItems = state.playlistItems.filter((i) => i.id !== itemId);
      renumber(item.playlist_id);
      save();
    },

    async reorderPlaylist(playlistId: number, itemIds: number[]): Promise<void> {
      itemIds.forEach((itemId, idx) => {
        const item = state.playlistItems.find(
          (i) => i.id === itemId && i.playlist_id === playlistId,
        );
        if (item) item.position = idx;
      });
      renumber(playlistId);
      save();
    },

    async pickFolder(): Promise<string | null> {
      return backend._nextPickedFolder;
    },

    fileSrc(filePath: string): string {
      const basename = filePath.split(/[\\/]/).pop() ?? "";
      if (FIXTURE_BASENAMES.includes(basename)) {
        return `/fixtures/${basename}`;
      }
      // fallback tocável para músicas sintéticas/seed
      return "/fixtures/sem_letra.mp3";
    },

    async writeTags(
      songId: number,
      title: string,
      artist: string | null,
      lyrics: string | null,
      temas: string | null,
      instrumental?: boolean | null,
      letraOrigem?: string | null,
    ): Promise<Song> {
      const song = state.songs.find((s) => s.id === songId);
      if (!song) {
        throw new Error(`Música não encontrada: id ${songId}`);
      }
      if (!title.trim()) {
        throw new Error("título vazio");
      }
      if (state.deletedFiles.includes(song.file_path)) {
        throw new Error(`arquivo removido do disco: ${song.file_path}`);
      }
      // grava só as tags — NUNCA renomeia (file_path intocado)
      song.title = title.trim();
      song.artist = artist?.trim() ? artist.trim() : null;
      const letraAnterior = song.lyrics;
      song.lyrics = lyrics?.trim() ? lyrics : null;
      song.has_lyrics = song.lyrics !== null;
      // A marca de origem descreve a letra ATUAL (DECISIONS #54): trocar ou
      // apagar a letra a derruba; repassar a mesma letra (caminho do lote) a
      // preserva. Nunca inventa marca em arquivo que não tinha.
      if (song.lyrics !== letraAnterior) {
        // ALTO-4 — quem grava DECLARA a procedência da letra que está
        // gravando: `null` limpa a marca (comportamento de sempre) e
        // "vagalume" a registra. Sem isso, a letra que o editor aceitou do
        // Vagalume ficava indistinguível de uma do LRCLIB, e o mesmo acervo
        // virava duas pilhas.
        song.letra_origem = letraOrigem ?? null;
      }
      // A marca de instrumental descreve a MÚSICA, não a letra (V8/F17): só a
      // escolha explícita mexe nela. `undefined`/null = "não mexer", e por isso
      // trocar a letra — ou o lote gravando título/artista — não desmarca.
      if (instrumental === true || instrumental === false) {
        song.instrumental = instrumental;
      }
      song.temas = normalizeTemas(temas);
      save();
      return toSong(song);
    },

    async enrichFolderScan(
      folderPrefix: string,
      scanId: string,
      vagalumeKey: string | null = null,
    ): Promise<EnrichProposal[]> {
      enrichCancelled.delete(scanId);
      // candidatas pré-contadas ANTES do trabalho (como o scan_all): o total
      // do progresso não muda no meio da varredura
      const candidatas = state.songs.filter((song) =>
        candidataDoFunil(song, folderPrefix),
      );

      const total = candidatas.length;
      const proposals: EnrichProposal[] = [];
      // vale para a varredura toda, como o `chave_recusada` do Rust
      const estado = { chaveRecusada: false };
      // primeiro evento com done=0 antes de começar: só o total na tela
      // (mesmo contrato do Rust — `atual` vazio nesse evento)
      emitEnrichProgress(scanId, 0, total, "", ETAPA_PREPARANDO);

      for (let i = 0; i < total; i++) {
        const song = candidatas[i];
        // no app real cada música é uma ida ao LRCLIB (segundos)
        if (backend._enrichDelayMs > 0) {
          await new Promise((r) => setTimeout(r, backend._enrichDelayMs));
        }
        // cancelada: para de emitir e resolve sem propostas (M4)
        if (enrichCancelled.has(scanId)) {
          enrichCancelled.delete(scanId);
          return [];
        }
        const proposta = propostaDoFunil(song, vagalumeKey, undefined, estado);
        proposals.push(proposta);
        // emitido DEPOIS de cada música, com o nome da que acabou de sair e a
        // etapa em que ela foi resolvida (mesmo ponto do on_progress do Rust)
        emitEnrichProgress(
          scanId,
          i + 1,
          total,
          nomeArquivo(song),
          etapaDaFonte(proposta.fonte),
        );
      }
      enrichCancelled.delete(scanId);
      // propostas sem nada a decidir não chegam à UI (mesmo corte do Rust)
      return proposals.filter((p) => !propostaNoOp(p));
    },

    async enrichCount(folderPrefix: string): Promise<number> {
      // MESMA função que a varredura usa (ALTO-2): é o ponto inteiro deste
      // comando existir — a contagem não pode discordar do que vai rodar.
      return state.songs.filter((song) => candidataDoFunil(song, folderPrefix))
        .length;
    },

    async enrichSongScan(
      songId: number,
      vagalumeKey: string | null = null,
      scanId: string | null = null,
      title: string | null = null,
      artist: string | null = null,
    ): Promise<EnrichProposal | null> {
      const song = state.songs.find((s) => s.id === songId);
      if (!song) return null;
      if (scanId) enrichCancelled.delete(scanId);
      // no app real esta é uma ida à rede que pode levar dezenas de segundos
      if (backend._enrichDelayMs > 0) {
        await new Promise((r) => setTimeout(r, backend._enrichDelayMs));
      }
      // B1 — a busca individual é cancelável: com a rede fora do ar ela
      // segurava o editor em "Buscando…" por mais de um minuto, sem saída
      if (scanId && enrichCancelled.has(scanId)) {
        enrichCancelled.delete(scanId);
        return null;
      }
      // O caso pontual é pedido À MÃO, música por música: aqui a marca de
      // instrumental e a completude NÃO excluem ninguém — quem clicou sabe o
      // que quer, e o filtro do lote existe para poupar rede em centenas de
      // arquivos, não para recusar um pedido explícito. (O curto-circuito de
      // letra para instrumental continua DENTRO do funil: é integridade.)
      const proposta = propostaDoFunil(song, vagalumeKey, { title, artist });
      // sem letra nova E sem nada a corrigir = procuramos e não veio nada novo
      return propostaNoOp(proposta) ? null : proposta;
    },

    async enrichCancelScan(scanId: string): Promise<void> {
      // marca e sai: a varredura para na próxima música (como o Rust, que
      // checa a flag entre as idas ao LRCLIB)
      enrichCancelled.add(scanId);
    },

    async onEnrichProgress(cb: (p: EnrichProgress) => void): Promise<() => void> {
      enrichProgressListeners.add(cb);
      return () => {
        enrichProgressListeners.delete(cb);
      };
    },

    async enrichApply(aplicacoes: EnrichApply[]): Promise<EnrichApplyResult[]> {
      // NUNCA aborta o lote: cada música grava ou falha individualmente e o
      // resultado volta por música (mesma semântica do backend Rust)
      const results: EnrichApplyResult[] = [];
      for (const ap of aplicacoes) {
        const song = state.songs.find((s) => s.id === ap.song_id);
        if (!song) {
          results.push({
            song_id: ap.song_id,
            song: null,
            error: `música não encontrada: ${ap.song_id}`,
          });
          continue;
        }
        if (state.deletedFiles.includes(song.file_path)) {
          results.push({
            song_id: ap.song_id,
            song: null,
            error: `arquivo não encontrado: ${song.file_path}`,
          });
          continue;
        }
        if (!ap.title.trim()) {
          results.push({ song_id: ap.song_id, song: null, error: "título vazio" });
          continue;
        }
        // A5: a varredura demora minutos; se a música mudou nesse meio-tempo
        // (edição à mão), a proposta está velha e reverteria o trabalho do
        // usuário em silêncio — recusa por música, o lote segue
        if (
          !mesmoValor(song.title, ap.current_title) ||
          !mesmoValor(song.artist, ap.current_artist)
        ) {
          results.push({
            song_id: ap.song_id,
            song: null,
            error:
              `a música mudou depois da busca ("${song.title}") —` +
              " refaça a busca de dados",
          });
          continue;
        }
        // o lote NUNCA apaga: null/vazio preserva o valor atual do arquivo;
        // NUNCA renomeia (file_path intocado)
        song.title = ap.title.trim();
        if (ap.artist?.trim()) {
          song.artist = ap.artist.trim();
        }
        // CRÍTICO-1 — nunca apagar vale também para a LETRA: gravar letra
        // nova por cima de uma que já existe exige o consentimento explícito
        // da revisão. Sem ele o backend recusa, e a linha mostra o que fazer.
        // Repassar a MESMA letra não é substituição (é o caminho do lote que
        // preserva a marca de origem).
        if (
          ap.lyrics?.trim() &&
          song.lyrics !== null &&
          song.lyrics !== ap.lyrics &&
          ap.substituir_letra !== true
        ) {
          results.push({
            song_id: ap.song_id,
            song: null,
            error: RECUSA_LETRA_EXISTENTE,
          });
          continue;
        }
        if (ap.lyrics?.trim()) {
          // Mesma regra do writer: letra diferente invalida a marca de origem
          // e, quando a gravação DECLARA a procedência (V8/F18), grava a nova.
          // Letra do Vagalume fica marcada como tal; qualquer outra fonte
          // limpa a marca — letra oficial nunca é transcrição.
          if (song.lyrics !== ap.lyrics) {
            song.letra_origem =
              ap.fonte?.toLowerCase() === "vagalume" ? ORIGEM_VAGALUME : null;
          }
          song.lyrics = ap.lyrics;
          song.has_lyrics = true;
        }
        if (ap.add_temas?.trim()) {
          // temas SOMAM aos existentes (normalização deduplica e ordena)
          const joined = song.temas
            ? `${song.temas}; ${ap.add_temas}`
            : ap.add_temas;
          song.temas = normalizeTemas(joined);
        }
        results.push({ song_id: ap.song_id, song: toSong(song), error: null });
      }
      save();
      return results;
    },

    async onScanProgress(cb: (p: ScanProgress) => void): Promise<() => void> {
      progressListeners.add(cb);
      return () => {
        progressListeners.delete(cb);
      };
    },

    _seedSongs(count: number): void {
      let folder = state.folders.find((f) => f.path === "/musicas/seed");
      if (!folder) {
        folder = {
          id: state.nextFolderId++,
          path: "/musicas/seed",
          last_scanned_at: new Date().toISOString(),
        };
        state.folders.push(folder);
      }
      for (let i = 1; i <= count; i++) {
        state.songs.push({
          id: state.nextSongId++,
          file_path: `/musicas/seed/musica_${i}.mp3`,
          folder_id: folder.id,
          title: `Música ${i}`,
          artist: SEED_ARTISTS[(i - 1) % SEED_ARTISTS.length],
          album: null,
          duration_seconds: 120 + (i % 120),
          has_lyrics: true,
          available: true,
          lyrics: seedLyrics(i),
        });
      }
      save();
    },

    _seedFolderTree(): void {
      let folder = state.folders.find((f) => f.path === "/acervo");
      if (!folder) {
        folder = {
          id: state.nextFolderId++,
          path: "/acervo",
          last_scanned_at: new Date().toISOString(),
        };
        state.folders.push(folder);
      }
      const seeds = [
        { file_path: "/acervo/1/a.mp3", title: "Faixa Um" },
        { file_path: "/acervo/2/b.mp3", title: "Faixa Dois" },
      ];
      for (const seed of seeds) {
        if (state.songs.some((s) => s.file_path === seed.file_path)) continue;
        state.songs.push({
          id: state.nextSongId++,
          file_path: seed.file_path,
          folder_id: folder.id,
          title: seed.title,
          artist: null,
          album: null,
          duration_seconds: 2,
          has_lyrics: false,
          available: true,
          lyrics: null,
        });
      }
      save();
    },

    _markAsTranscribed(filePath: string): void {
      const song = state.songs.find((s) => s.file_path === filePath);
      if (!song) return;
      song.letra_origem = ORIGEM_TRANSCRICAO;
      save();
    },

    _markAsInstrumental(filePath: string): void {
      const song = state.songs.find((s) => s.file_path === filePath);
      if (!song) return;
      song.instrumental = true;
      save();
    },

    _removeFileFromDisk(filePath: string): void {
      if (!state.deletedFiles.includes(filePath)) {
        state.deletedFiles.push(filePath);
      }
      save();
    },

    _reset(): void {
      state = freshState();
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        // ignora storage indisponível
      }
    },
  };

  return backend;
}

/** Instala o mock na global lida por getBackend() (src/lib/api.ts). */
export function installMockBackend(): MockBackend {
  const backend = createMockBackend();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__CANCIONEIRO_MOCK__ = backend;
  return backend;
}
