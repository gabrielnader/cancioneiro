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
  /** Metadados editados (F10): atualiza current/fila sem tocar na reprodução. */
  updateSongRefs: (song: Song) => void;
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
          const { queue, queueIndex } = get();
          if (currentTimeSec > 3 || queueIndex === null) return "restart";
          // detached ou não, o item "anterior" ao atual é queueIndex - 1
          // (quando detached, queueIndex aponta para o próximo item).
          const prevIndex = queueIndex - 1;
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
          // V13.1 — emendar sozinho é comportamento de PLAYLIST: ali a pessoa
          // montou uma sequência e quer ouvi-la. Na biblioteca ela pediu UMA
          // música; seguir para a próxima da pasta sozinho seria decidir por
          // ela. O botão de próxima continua avançando nos dois casos — o que
          // muda é quem pede: a pessoa, ou o fim da faixa.
          if (get().playlistId === null) {
            set({ isPlaying: false });
            return;
          }
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
          const { current, queue, queueIndex, detached } = get();
          if (queueIndex === null || !current) {
            set({ queue: songs });
            return;
          }
          const newIndex = songs.findIndex((s) => s.id === current.id);
          if (newIndex >= 0) {
            set({ queue: songs, queueIndex: newIndex, detached: false });
            return;
          }
          // Música atual saiu da fila: continua tocando (detached) e o
          // "próximo" é o item que a seguia. Rastreia esse item pela
          // identidade — sobrevive a remoções/reordenações posteriores.
          const oldNext = queue[detached ? queueIndex : queueIndex + 1];
          let nextIndex: number;
          if (oldNext) {
            const found = songs.findIndex((s) => s.id === oldNext.id);
            // se o seguinte também saiu, cai no item que ocupa a posição
            // antiga (itens deslocam para a esquerda); fim da lista = para.
            nextIndex = found >= 0 ? found : Math.min(queueIndex, songs.length);
          } else {
            nextIndex = songs.length;
          }
          set({ queue: songs, queueIndex: nextIndex, detached: true });
        },

        updateSongRefs: (song) =>
          set((s) => ({
            current: s.current?.id === song.id ? song : s.current,
            queue: s.queue.map((q) => (q.id === song.id ? song : q)),
          })),

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
