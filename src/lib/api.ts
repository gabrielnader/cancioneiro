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
 * Proposta de enriquecimento em lote (F13 — PRD V5), espelhando o struct
 * Rust EnrichProposal (serde sem rename: chaves snake_case no JSON).
 */
export interface EnrichProposal {
  song_id: number;
  file_path: string;
  current_title: string;
  current_artist: string | null;
  proposed_title: string;
  proposed_artist: string | null;
  /** Letra achada no LRCLIB (vem na proposta — o apply não volta à rede). */
  lyrics: string | null;
  confidence: "alta" | "media" | "baixa";
  /** Erro por música (ex.: "sem conexão") — a linha fica desabilitada. */
  error: string | null;
}

/**
 * Aplicação aceita pelo usuário (F13). `null` em artist/lyrics/add_temas =
 * "não mexer" — o lote nunca apaga dados existentes.
 */
export interface EnrichApply {
  song_id: number;
  title: string;
  artist: string | null;
  lyrics: string | null;
  add_temas: string | null;
}

/**
 * Resultado POR MÚSICA do enrich_apply (chaves snake_case, como no serde do
 * struct Rust): o lote nunca aborta no meio — cada aplicação grava ou falha
 * individualmente.
 */
export interface EnrichApplyResult {
  song_id: number;
  /** Não-nulo = gravada e reindexada. */
  song: Song | null;
  /** Não-nulo = falhou nesta música (ex.: "arquivo não encontrado: …"). */
  error: string | null;
}

/**
 * Camada de acesso ao backend. Em produção fala com os comandos Tauri via
 * invoke; fora do Tauri (dev no navegador / E2E Playwright) usa o backend
 * mockado em memória (./mockBackend), mantendo a mesma interface.
 */
export interface Backend {
  addFolder(path: string): Promise<ScanResult>;
  removeFolder(folderId: number): Promise<void>;
  listFolders(): Promise<Folder[]>;
  scan(): Promise<ScanResult>;
  listSongs(): Promise<Song[]>;
  search(query: string): Promise<SearchResult[]>;
  getLyrics(songId: number): Promise<string | null>;
  fileExists(path: string): Promise<boolean>;
  createPlaylist(name: string): Promise<number>;
  deletePlaylist(playlistId: number): Promise<void>;
  listPlaylists(): Promise<Playlist[]>;
  getPlaylistItems(playlistId: number): Promise<PlaylistItem[]>;
  addToPlaylist(playlistId: number, songId: number): Promise<number>;
  removePlaylistItem(itemId: number): Promise<void>;
  reorderPlaylist(playlistId: number, itemIds: number[]): Promise<void>;
  pickFolder(): Promise<string | null>;
  fileSrc(filePath: string): string;
  onScanProgress(cb: (p: ScanProgress) => void): Promise<() => void>;
  /** Grava TIT2/TPE1/USLT/TXXX:TEMAS no MP3 e devolve a Song reindexada (V4 F10). */
  writeTags(
    songId: number,
    title: string,
    artist: string | null,
    lyrics: string | null,
    temas: string | null,
  ): Promise<Song>;
  /** Busca a letra online por título+artista+duração — único ponto de rede (V4 F10). */
  fetchLyricsOnline(
    title: string,
    artist: string | null,
    durationSeconds: number,
  ): Promise<LyricsMatch | null>;
  /**
   * Identifica no LRCLIB as músicas incompletas sob folderPrefix ("" =
   * biblioteca inteira) — ponto de rede EXPLÍCITO, pode levar minutos (F13).
   */
  enrichFolderScan(folderPrefix: string): Promise<EnrichProposal[]>;
  /**
   * Aplica as propostas aceitas (nunca renomeia, nunca apaga) — F13. Devolve
   * um resultado por música e NUNCA aborta o lote no meio: falhas viram
   * entradas com `error`, as demais gravam normalmente.
   */
  enrichApply(aplicacoes: EnrichApply[]): Promise<EnrichApplyResult[]>;
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function tauriBackend(): Backend {
  return {
    async addFolder(path) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<ScanResult>("add_folder", { path });
    },
    async removeFolder(folderId) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("remove_folder", { folderId });
    },
    async listFolders() {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<Folder[]>("list_folders");
    },
    async scan() {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<ScanResult>("scan");
    },
    async listSongs() {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<Song[]>("list_songs");
    },
    async search(query) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<SearchResult[]>("search", { query });
    },
    async getLyrics(songId) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<string | null>("get_lyrics", { songId });
    },
    async fileExists(path) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<boolean>("file_exists", { path });
    },
    async createPlaylist(name) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<number>("create_playlist", { name });
    },
    async deletePlaylist(playlistId) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("delete_playlist", { playlistId });
    },
    async listPlaylists() {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<Playlist[]>("list_playlists");
    },
    async getPlaylistItems(playlistId) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<PlaylistItem[]>("get_playlist_items", { playlistId });
    },
    async addToPlaylist(playlistId, songId) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<number>("add_to_playlist", { playlistId, songId });
    },
    async removePlaylistItem(itemId) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("remove_playlist_item", { itemId });
    },
    async reorderPlaylist(playlistId, itemIds) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("reorder_playlist", { playlistId, itemIds });
    },
    async pickFolder() {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const result = await open({ directory: true, multiple: false });
      return typeof result === "string" ? result : null;
    },
    fileSrc(filePath) {
      // convertFileSrc é síncrono e disponível quando rodando no Tauri
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const internals = (window as any).__TAURI_INTERNALS__;
      return internals.convertFileSrc(filePath) as string;
    },
    async onScanProgress(cb) {
      const { listen } = await import("@tauri-apps/api/event");
      return listen<ScanProgress>("scan:progress", (e) => cb(e.payload));
    },
    async writeTags(songId, title, artist, lyrics, temas) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<Song>("write_tags", { songId, title, artist, lyrics, temas });
    },
    async fetchLyricsOnline(title, artist, durationSeconds) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<LyricsMatch | null>("fetch_lyrics_online", {
        title,
        artist,
        durationSeconds,
      });
    },
    async enrichFolderScan(folderPrefix) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<EnrichProposal[]>("enrich_folder_scan", { folderPrefix });
    },
    async enrichApply(aplicacoes) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<EnrichApplyResult[]>("enrich_apply", { aplicacoes });
    },
  };
}

let backend: Backend | null = null;

export function getBackend(): Backend {
  if (backend) return backend;
  if (isTauri()) {
    backend = tauriBackend();
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const injected = (window as any).__CANCIONEIRO_MOCK__ as Backend | undefined;
    if (!injected) {
      throw new Error(
        "Fora do Tauri é preciso instalar o mock: import { installMockBackend } from './mockBackend'",
      );
    }
    backend = injected;
  }
  return backend;
}

/** Somente para testes: substitui o backend ativo. */
export function setBackendForTests(b: Backend | null): void {
  backend = b;
}
