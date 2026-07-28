export interface Song {
  id: number;
  file_path: string;
  folder_id: number;
  title: string;
  artist: string | null;
  album: string | null;
  duration_seconds: number | null;
  has_lyrics: boolean;
  available: boolean;
  /** Temas do frame TXXX:TEMAS, unidos por "; " (V2). Ausente/null = sem temas. */
  temas?: string | null;
  /**
   * Procedência da letra ATUAL, do frame TXXX:LETRA_ORIGEM (V5/F14):
   * ORIGEM_TRANSCRICAO = letra produzida automaticamente a partir do áudio.
   * Ausente/null = sem procedência declarada. Trocar a letra derruba a marca
   * no backend (DECISIONS #54), então ela sempre descreve o texto exibido.
   */
  letra_origem?: string | null;
}

/** Valor de `Song.letra_origem` que a curadoria grava para letra transcrita. */
export const ORIGEM_TRANSCRICAO = "transcricao";

export interface SearchResult {
  song: Song;
  snippet: string | null;
}

export interface Folder {
  id: number;
  path: string;
  last_scanned_at: string | null;
}

export interface Playlist {
  id: number;
  name: string;
  song_count: number;
}

export interface PlaylistItem {
  id: number;
  playlist_id: number;
  position: number;
  song: Song;
}

/** Resultado da busca de letra online (LRCLIB via backend — V4 F10). */
export interface LyricsMatch {
  lyrics: string;
  matched_title: string;
  matched_artist: string;
  confidence: "alta" | "media";
}

export interface ScanResult {
  indexed: number;
  skipped: number;
  removed: number;
  total: number;
  missing_folders: string[];
}

export interface ScanProgress {
  done: number;
  total: number;
}
