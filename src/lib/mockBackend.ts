import type { Backend, EnrichApply, EnrichProposal } from "./api";
import { HIGHLIGHT_END, HIGHLIGHT_START } from "./highlight";
import type {
  Folder,
  LyricsMatch,
  Playlist,
  PlaylistItem,
  ScanProgress,
  ScanResult,
  SearchResult,
  Song,
} from "./types";

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
  /** Zera o estado em memória e a persistência. */
  _reset(): void;
  /** Valor devolvido pelo próximo pickFolder(). */
  _nextPickedFolder: string;
  /** Simula falta de rede: fetchLyricsOnline e enrichFolderScan rejeitam com "sem conexão" (V4/V5). */
  _offline: boolean;
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

export function createMockBackend(): MockBackend {
  let state = loadState();
  const progressListeners = new Set<(p: ScanProgress) => void>();

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

  function songWords(song: SongRecord): string[] {
    return tokenize(
      `${song.title} ${song.artist ?? ""} ${song.lyrics ?? ""} ${song.temas ?? ""}`,
    );
  }

  const backend: MockBackend = {
    _nextPickedFolder: "/musicas/mock",
    _offline: false,

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
      song.lyrics = lyrics?.trim() ? lyrics : null;
      song.has_lyrics = song.lyrics !== null;
      song.temas = normalizeTemas(temas);
      save();
      return toSong(song);
    },

    async fetchLyricsOnline(
      title: string,
      artist: string | null,
      _durationSeconds: number,
    ): Promise<LyricsMatch | null> {
      if (backend._offline) {
        throw new Error("sem conexão");
      }
      if (normalize(title).includes("coracao sertanejo")) {
        return {
          lyrics: FIXTURE_LYRICS,
          matched_title: "Coração Sertanejo",
          matched_artist: artist?.trim() || "Artista Teste",
          confidence: "alta",
        };
      }
      return null;
    },

    async enrichFolderScan(folderPrefix: string): Promise<EnrichProposal[]> {
      // Mesma convenção do fetchLyricsOnline: sem rede, o invoke rejeita.
      if (backend._offline) {
        throw new Error("sem conexão");
      }
      const proposals: EnrichProposal[] = [];
      for (const song of state.songs) {
        if (!song.available) continue;
        if (folderPrefix && !song.file_path.startsWith(folderPrefix)) continue;
        // incompleta = sem letra OU sem artista (regra simplificada do Rust)
        const completa = song.has_lyrics && song.artist !== null;
        if (completa) continue;

        const base = {
          song_id: song.id,
          file_path: song.file_path,
          current_title: song.title,
          current_artist: song.artist,
        };

        // arquivo sumido do disco: proposta com error, sem gastar "rede"
        if (state.deletedFiles.includes(song.file_path)) {
          proposals.push({
            ...base,
            proposed_title: song.title,
            proposed_artist: song.artist,
            lyrics: null,
            confidence: "baixa",
            error: `arquivo não encontrado: ${song.file_path}`,
          });
          continue;
        }

        // "LRCLIB" determinístico: o único hit ALTA é o da fixture (mesmo
        // conhecimento do fetchLyricsOnline)
        if (normalize(song.title).includes("coracao sertanejo")) {
          proposals.push({
            ...base,
            proposed_title: "Coração Sertanejo",
            proposed_artist: "Artista Teste",
            lyrics: FIXTURE_LYRICS,
            confidence: "alta",
            error: null,
          });
          continue;
        }

        // título+artista reais → match MÉDIA com letra encontrada
        if (song.artist !== null) {
          proposals.push({
            ...base,
            proposed_title: song.title,
            proposed_artist: song.artist,
            lyrics: FIXTURE_LYRICS,
            confidence: "media",
            error: null,
          });
          continue;
        }

        // resto: BAIXA — palpite do nome do arquivo, sem letra
        const stem = (song.file_path.split(/[\\/]/).pop() ?? "")
          .replace(/\.mp3$/i, "")
          .replace(/_/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        const divisor = stem.indexOf(" - ");
        const [guessArtist, guessTitle] =
          divisor > 0
            ? [stem.slice(0, divisor).trim(), stem.slice(divisor + 3).trim()]
            : [null, stem];
        proposals.push({
          ...base,
          proposed_title: guessTitle || song.title,
          proposed_artist: guessArtist,
          lyrics: null,
          confidence: "baixa",
          error: null,
        });
      }
      return proposals;
    },

    async enrichApply(aplicacoes: EnrichApply[]): Promise<Song[]> {
      const updated: Song[] = [];
      for (const ap of aplicacoes) {
        const song = state.songs.find((s) => s.id === ap.song_id);
        if (!song) {
          throw new Error(`música não encontrada: ${ap.song_id}`);
        }
        if (state.deletedFiles.includes(song.file_path)) {
          throw new Error(`arquivo removido do disco: ${song.file_path}`);
        }
        if (!ap.title.trim()) {
          throw new Error("título vazio");
        }
        // o lote NUNCA apaga: null/vazio preserva o valor atual do arquivo;
        // NUNCA renomeia (file_path intocado)
        song.title = ap.title.trim();
        if (ap.artist?.trim()) {
          song.artist = ap.artist.trim();
        }
        if (ap.lyrics?.trim()) {
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
        updated.push(toSong(song));
      }
      save();
      return updated;
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
