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
}

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
