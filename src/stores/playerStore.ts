import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Song } from "../lib/types";

export type PreviousAction = "moved" | "restart";

interface PlayerState {
  /** Música carregada no player (pode estar pausada). */
  current: Song | null;
  /** Contexto de reprodução (itens da playlist); vazio = música avulsa. */
  queue: Song[];
  /**
   * Índice da música atual na fila. Quando `detached` é true, a música atual
   * foi removida da fila e `queueIndex` aponta para o PRÓXIMO item a tocar.
   */
  queueIndex: number | null;
  detached: boolean;
  playlistId: number | null;
  isPlaying: boolean;
  volume: number;
  /** Incrementa a cada pedido explícito de play — força recarga/reinício do áudio. */
  playRequestId: number;

  playSong: (song: Song) => void;
  playQueue: (songs: Song[], startIndex: number, playlistId: number | null) => void;
  togglePlayPause: () => void;
  setPlaying: (playing: boolean) => void;
  /** Avança para a próxima da fila. Retorna false se não havia próxima. */
  next: () => boolean;
  /** Regra do PRD: >3s reinicia a faixa; ≤3s volta para a anterior. */
  previous: (currentTimeSec: number) => PreviousAction;
  /** Fim natural da música: avança na fila ou para. */
  onEnded: () => void;
  /** Arquivo ausente: pula o item atual; retorna false se a fila acabou. */
  skipCurrent: () => boolean;
  /** Reflete mudanças na playlist em reprodução sem interromper o áudio. */
  syncQueue: (songs: Song[]) => void;
  setVolume: (v: number) => void;
}

export function createPlayerStore() {
  return create<PlayerState>()(
    persist(
      (set, get) => ({
        current: null,
        queue: [],
        queueIndex: null,
        detached: false,
        playlistId: null,
        isPlaying: false,
        volume: 1,
        playRequestId: 0,

        playSong: (song) =>
          set((s) => ({
            current: song,
            queue: [],
            queueIndex: null,
            detached: false,
            playlistId: null,
            isPlaying: true,
            playRequestId: s.playRequestId + 1,
          })),

        playQueue: (songs, startIndex, playlistId) => {
          const song = songs[startIndex];
          if (!song) return;
          set((s) => ({
            current: song,
            queue: songs,
            queueIndex: startIndex,
            detached: false,
            playlistId,
            isPlaying: true,
            playRequestId: s.playRequestId + 1,
          }));
        },

        togglePlayPause: () => {
          const { current, isPlaying } = get();
          if (!current) return;
          set({ isPlaying: !isPlaying });
        },

        setPlaying: (playing) => {
          if (!get().current) return;
          set({ isPlaying: playing });
        },

        next: () => {
          const { queue, queueIndex, detached } = get();
          if (queueIndex === null) return false;
          const nextIndex = detached ? queueIndex : queueIndex + 1;
          const song = queue[nextIndex];
          if (!song) return false;
          set({
            current: song,
            queueIndex: nextIndex,
            detached: false,
            isPlaying: true,
          });
          return true;
        },

        previous: (currentTimeSec) => {
          const { queue, queueIndex, detached } = get();
          if (currentTimeSec > 3 || queueIndex === null) return "restart";
          // detached: o índice já aponta para o próximo item; o "anterior"
          // ao atual é o item antes desse índice.
          const prevIndex = detached ? queueIndex - 1 : queueIndex - 1;
          const song = queue[prevIndex];
          if (!song) return "restart";
          set({
            current: song,
            queueIndex: prevIndex,
            detached: false,
            isPlaying: true,
          });
          return "moved";
        },

        onEnded: () => {
          if (!get().next()) {
            set({ isPlaying: false });
          }
        },

        skipCurrent: () => {
          const moved = get().next();
          if (!moved) {
            set({ isPlaying: false });
          }
          return moved;
        },

        syncQueue: (songs) => {
          const { current, queueIndex, detached } = get();
          if (queueIndex === null || !current) {
            set({ queue: songs });
            return;
          }
          const newIndex = songs.findIndex((s) => s.id === current.id);
          if (newIndex >= 0) {
            set({ queue: songs, queueIndex: newIndex, detached: false });
          } else {
            // Música atual saiu da fila: continua tocando; o próximo é o item
            // que ocupava a posição seguinte — que agora está no índice onde
            // a atual estava (itens deslocam para a esquerda).
            const nextIndex = Math.min(
              detached ? queueIndex : queueIndex,
              songs.length,
            );
            set({ queue: songs, queueIndex: nextIndex, detached: true });
          }
        },

        setVolume: (v) => set({ volume: Math.min(1, Math.max(0, v)) }),
      }),
      {
        name: "cancioneiro-player",
        partialize: (s) => ({ volume: s.volume }),
      },
    ),
  );
}

export const usePlayerStore = createPlayerStore();
