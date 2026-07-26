import { beforeEach, describe, expect, it } from "vitest";
import { createPlayerStore, usePlayerStore } from "./playerStore";
import type { Song } from "../lib/types";

function song(id: number, title = `Faixa ${id}`): Song {
  return {
    id,
    file_path: `/m/${id}.mp3`,
    folder_id: 1,
    title,
    artist: null,
    album: null,
    duration_seconds: 3,
    has_lyrics: false,
    available: true,
  };
}

const S1 = song(1);
const S2 = song(2);
const S3 = song(3);

describe("playerStore (F4/F5)", () => {
  beforeEach(() => {
    usePlayerStore.setState({
      current: null,
      queue: [],
      queueIndex: null,
      detached: false,
      playlistId: null,
      isPlaying: false,
      volume: 1,
    });
  });

  it("playSong toca música avulsa sem fila", () => {
    usePlayerStore.getState().playSong(S1);
    const s = usePlayerStore.getState();
    expect(s.current?.id).toBe(1);
    expect(s.isPlaying).toBe(true);
    expect(s.queue).toEqual([]);
    expect(s.playlistId).toBeNull();
  });

  it("música avulsa: ao terminar, para (não avança sozinho)", () => {
    usePlayerStore.getState().playSong(S1);
    usePlayerStore.getState().onEnded();
    const s = usePlayerStore.getState();
    expect(s.isPlaying).toBe(false);
    expect(s.current?.id).toBe(1);
  });

  it("playQueue inicia no índice pedido e avança automaticamente até o fim", () => {
    usePlayerStore.getState().playQueue([S1, S2, S3], 0, 42);
    let s = usePlayerStore.getState();
    expect(s.current?.id).toBe(1);
    expect(s.playlistId).toBe(42);
    expect(s.isPlaying).toBe(true);

    usePlayerStore.getState().onEnded();
    s = usePlayerStore.getState();
    expect(s.current?.id).toBe(2);
    expect(s.isPlaying).toBe(true);

    usePlayerStore.getState().onEnded();
    s = usePlayerStore.getState();
    expect(s.current?.id).toBe(3);

    // fim da última: para e mantém a última carregada (botão volta a ▶)
    usePlayerStore.getState().onEnded();
    s = usePlayerStore.getState();
    expect(s.isPlaying).toBe(false);
    expect(s.current?.id).toBe(3);
  });

  it("togglePlayPause alterna somente quando há música carregada", () => {
    usePlayerStore.getState().togglePlayPause();
    expect(usePlayerStore.getState().isPlaying).toBe(false);

    usePlayerStore.getState().playSong(S1);
    usePlayerStore.getState().togglePlayPause();
    expect(usePlayerStore.getState().isPlaying).toBe(false);
    usePlayerStore.getState().togglePlayPause();
    expect(usePlayerStore.getState().isPlaying).toBe(true);
  });

  it("next navega na fila; no fim não faz nada", () => {
    usePlayerStore.getState().playQueue([S1, S2], 0, null);
    expect(usePlayerStore.getState().next()).toBe(true);
    expect(usePlayerStore.getState().current?.id).toBe(2);
    expect(usePlayerStore.getState().next()).toBe(false);
    expect(usePlayerStore.getState().current?.id).toBe(2);
  });

  it("previous: nos 3 primeiros segundos volta faixa; depois de 3s reinicia", () => {
    usePlayerStore.getState().playQueue([S1, S2], 1, null);

    // após 3s → 'restart'
    expect(usePlayerStore.getState().previous(4.2)).toBe("restart");
    expect(usePlayerStore.getState().current?.id).toBe(2);

    // dentro de 3s → volta para a anterior
    expect(usePlayerStore.getState().previous(1.5)).toBe("moved");
    expect(usePlayerStore.getState().current?.id).toBe(1);

    // primeira faixa, dentro de 3s → reinicia
    expect(usePlayerStore.getState().previous(1.0)).toBe("restart");
    expect(usePlayerStore.getState().current?.id).toBe(1);
  });

  it("remover da playlist a música em reprodução não interrompe o áudio; próximo é o item seguinte da lista atualizada", () => {
    usePlayerStore.getState().playQueue([S1, S2, S3], 1, 7);
    expect(usePlayerStore.getState().current?.id).toBe(2);

    // S2 (em reprodução) foi removida da playlist
    usePlayerStore.getState().syncQueue([S1, S3]);
    let s = usePlayerStore.getState();
    expect(s.current?.id).toBe(2); // áudio atual não é interrompido
    expect(s.isPlaying).toBe(true);

    // próximo passa a ser S3 (o item que seguia S2 na lista atualizada)
    usePlayerStore.getState().onEnded();
    s = usePlayerStore.getState();
    expect(s.current?.id).toBe(3);
  });

  it("syncQueue com a música atual ainda presente apenas realinha o índice", () => {
    usePlayerStore.getState().playQueue([S1, S2, S3], 2, 7);
    usePlayerStore.getState().syncQueue([S3, S1, S2]);
    const s = usePlayerStore.getState();
    expect(s.current?.id).toBe(3);
    usePlayerStore.getState().onEnded();
    expect(usePlayerStore.getState().current?.id).toBe(1);
  });

  it("remoções compostas: remover a atual e depois um item ANTES do ponteiro ainda avança para o item certo", () => {
    // toca B em [A,B,C]; remove B (atual, detached); remove A; próximo deve ser C
    usePlayerStore.getState().playQueue([S1, S2, S3], 1, 7);
    usePlayerStore.getState().syncQueue([S1, S3]);
    usePlayerStore.getState().syncQueue([S3]);
    usePlayerStore.getState().onEnded();
    const s = usePlayerStore.getState();
    expect(s.current?.id).toBe(3);
    expect(s.isPlaying).toBe(true);
  });

  it("reordenar a playlist enquanto detached mantém o próximo correto", () => {
    // toca B em [A,B,C]; remove B (próximo = C); reordena para [C,A]
    usePlayerStore.getState().playQueue([S1, S2, S3], 1, 7);
    usePlayerStore.getState().syncQueue([S1, S3]);
    usePlayerStore.getState().syncQueue([S3, S1]);
    usePlayerStore.getState().onEnded();
    expect(usePlayerStore.getState().current?.id).toBe(3);
  });

  it("remover a última música da fila em reprodução: ao terminar, para", () => {
    usePlayerStore.getState().playQueue([S1, S2], 1, 7);
    usePlayerStore.getState().syncQueue([S1]);
    usePlayerStore.getState().onEnded();
    const s = usePlayerStore.getState();
    expect(s.isPlaying).toBe(false);
    expect(s.current?.id).toBe(2);
  });

  it("skipCurrent avança pulando o item (arquivo ausente) e informa se havia próximo", () => {
    usePlayerStore.getState().playQueue([S1, S2], 0, 7);
    expect(usePlayerStore.getState().skipCurrent()).toBe(true);
    expect(usePlayerStore.getState().current?.id).toBe(2);
    // última da fila ausente → para
    expect(usePlayerStore.getState().skipCurrent()).toBe(false);
    expect(usePlayerStore.getState().isPlaying).toBe(false);
  });

  it("volume persiste no localStorage (nova instância hidrata)", async () => {
    usePlayerStore.getState().setVolume(0.37);
    expect(usePlayerStore.getState().volume).toBeCloseTo(0.37);

    const reopened = createPlayerStore();
    await Promise.resolve();
    expect(reopened.getState().volume).toBeCloseTo(0.37);
    // estado transitório não persiste
    expect(reopened.getState().current).toBeNull();
    expect(reopened.getState().isPlaying).toBe(false);
  });

  it("setVolume limita a faixa 0..1", () => {
    usePlayerStore.getState().setVolume(1.5);
    expect(usePlayerStore.getState().volume).toBe(1);
    usePlayerStore.getState().setVolume(-0.2);
    expect(usePlayerStore.getState().volume).toBe(0);
  });
});
