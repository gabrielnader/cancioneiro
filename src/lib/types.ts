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
/**
 * Valor de `Song.letra_origem` de letra vinda do Vagalume — **HERANÇA, só de
 * leitura** (V10, DECISIONS #110).
 *
 * A etapa do Vagalume saiu do produto e **nada mais escreve este valor**. Ele
 * continua aqui por um motivo: o `tools/curadoria.py` o grava, e arquivos do
 * acervo real já o carregam. Valor que o programa não reconhece não é lixo a
 * limpar — "nunca apagar dado existente" vale para INTERPRETAR dado existente
 * também. Não é transcrição: não puxa o aviso de "pode conter erros".
 */
export const ORIGEM_VAGALUME = "vagalume";

/**
 * Valor de `Song.letra_origem` de letra vinda do `lyrics.ovh` — a fonte de
 * letra da etapa 4 (V10), que não pede credencial nenhuma. Também não é
 * transcrição.
 */
export const ORIGEM_LYRICS_OVH = "lyrics.ovh";

/**
 * Valor de `EnrichProposal.fonte` da etapa 4 (V10) — o mesmo texto do
 * `enrich::FONTE_LYRICS_OVH`. É por ele que o `apply` grava
 * `TXXX:LETRA_ORIGEM=lyrics.ovh`.
 */
export const FONTE_LYRICS_OVH = "lyrics.ovh";

/**
 * Valor de `EnrichProposal.fonte` da etapa 5 (V10) — o mesmo texto do
 * `enrich::FONTE_TRANSCRICAO` do Rust. É por ele que a revisão reconhece a
 * letra escrita por MÁQUINA (que puxa o aviso de conferir antes de aplicar) e
 * é ele que o `apply` usa para gravar `TXXX:LETRA_ORIGEM=transcricao`.
 */
export const FONTE_TRANSCRICAO = "transcrição do áudio";

/**
 * V10 — `Modo` SAIU do produto (DECISIONS #102). Havia dois trabalhos a
 * escolher antes de começar ("completar o que falta" x "conferir se a etiqueta
 * está certa"), e a escolha custava 2 minutos e meio num acervo de 150 músicas
 * enquanto cobrava de quem não sabe o que é terminal uma decisão entre dois
 * nomes que ela não entende. Pior: a conferência era a única coisa que achava
 * etiqueta ERRADA, e recurso que depende de o usuário adivinhar que existe é
 * recurso que não existe.
 *
 * Uma varredura só, em todas as músicas da pasta. O tipo não volta: ele é
 * citado aqui para que ninguém o reintroduza sem ler o porquê.
 */

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
