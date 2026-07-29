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
  /**
   * Música sem voz, do frame TXXX:INSTRUMENTAL (V8/F17). É informação sobre a
   * MÚSICA, não sobre a letra: a lista mostra "Instrumental" no lugar do selo
   * "Sem letra". Instrumental COM letra registrada é caso previsto — a letra
   * continua sendo exibida. Ausente/false = não marcada (o app nunca deduz a
   * marca de "não tem letra"; só a curadoria ou a escolha humana a põem).
   */
  instrumental?: boolean;
}

/** Valor de `Song.letra_origem` que a curadoria grava para letra transcrita. */
export const ORIGEM_TRANSCRICAO = "transcricao";

/**
 * Valor de `Song.letra_origem` para letra vinda do Vagalume (V8/F18) — o
 * mesmo que `tools/embed_lyrics.py` e o writer Rust gravam. Não é transcrição:
 * não puxa o aviso de "pode conter erros".
 */
export const ORIGEM_VAGALUME = "vagalume";

/**
 * O TRABALHO que uma varredura do funil faz (PRD V9) — atravessa o IPC como
 * texto minúsculo e sem acento, igual ao `enrich::Modo` do Rust.
 *
 * São dois trabalhos distintos, com custos distintos:
 * - `completar`: só as músicas incompletas, funil inteiro. É o padrão, e o
 *   padrão não muda — a ausência do campo no JSON também vale `completar`, de
 *   modo que esquecer de mandá-lo nunca dispara a varredura cara por engano.
 * - `conferencia`: TODAS as músicas disponíveis (inclusive as completas) e só
 *   a etapa do som. É o único jeito de achar etiqueta ERRADA, que a varredura
 *   de completude nunca alcança.
 */
export type Modo = "completar" | "conferencia";

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
