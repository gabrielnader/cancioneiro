import { getBackend } from "../lib/api";
import type { Song } from "../lib/types";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlayerStore } from "../stores/playerStore";
import { useToastStore } from "../stores/toastStore";

/** Subconjunto de HTMLAudioElement usado pelo controlador (testável). */
export interface AudioLike {
  src: string;
  currentTime: number;
  play(): Promise<void>;
  pause(): void;
}

/**
 * Carrega a música atual no elemento de áudio, tratando arquivo ausente
 * conforme o PRD: avulsa → toast de erro e não toca; em playlist → toast de
 * aviso e pula para a próxima (o efeito reagirá à mudança de `current`).
 */
export async function loadCurrentIntoAudio(
  audio: AudioLike,
  song: Song,
): Promise<void> {
  const backend = getBackend();
  const player = usePlayerStore.getState();
  const exists = await backend.fileExists(song.file_path);

  if (!exists) {
    useLibraryStore.getState().markUnavailable(song.id);
    const inQueue = player.queueIndex !== null;
    if (inQueue) {
      useToastStore
        .getState()
        .push(`Pulando "${song.title}": arquivo não encontrado.`, "warning");
      usePlayerStore.getState().skipCurrent();
    } else {
      useToastStore
        .getState()
        .push(
          `Arquivo não encontrado: ${song.title}. A música foi removida da biblioteca?`,
          "error",
        );
      usePlayerStore.getState().setPlaying(false);
    }
    return;
  }

  audio.src = backend.fileSrc(song.file_path);
  audio.currentTime = 0;
  if (usePlayerStore.getState().isPlaying) {
    try {
      await audio.play();
    } catch (e) {
      console.error("[player] falha ao reproduzir:", e);
      useToastStore
        .getState()
        .push("Não foi possível reproduzir este arquivo.", "error");
      usePlayerStore.getState().setPlaying(false);
    }
  }
}

/**
 * Controlador global de seek — preenchido pelo hook usePlayerAudio para que
 * atalhos de teclado e a barra de progresso alcancem o elemento de áudio.
 */
export const audioController: {
  seekTo: (seconds: number) => void;
  seekBy: (delta: number) => void;
  getCurrentTime: () => number;
  /** Pausa o elemento imediatamente (sem esperar re-render) — usado antes de
   * gravar tags no arquivo em reprodução (lock de arquivo no Windows). */
  pause: () => void;
} = {
  seekTo: () => {},
  seekBy: () => {},
  getCurrentTime: () => 0,
  pause: () => {},
};
