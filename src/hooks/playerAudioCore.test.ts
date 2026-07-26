import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadCurrentIntoAudio, type AudioLike } from "./playerAudioCore";
import { setBackendForTests, type Backend } from "../lib/api";
import { usePlayerStore } from "../stores/playerStore";
import { useLibraryStore } from "../stores/libraryStore";
import { useToastStore } from "../stores/toastStore";
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

function fakeAudio(): AudioLike & { played: boolean } {
  return {
    src: "",
    currentTime: 99,
    played: false,
    async play() {
      this.played = true;
    },
    pause() {
      this.played = false;
    },
  };
}

let existing: Set<string>;

beforeEach(() => {
  existing = new Set(["/m/1.mp3", "/m/2.mp3", "/m/3.mp3"]);
  setBackendForTests({
    fileExists: vi.fn(async (p: string) => existing.has(p)),
    fileSrc: (p: string) => `asset://${p}`,
  } as unknown as Backend);
  usePlayerStore.setState({
    current: null,
    queue: [],
    queueIndex: null,
    detached: false,
    playlistId: null,
    isPlaying: false,
  });
  useLibraryStore.setState({
    results: [
      { song: song(1), snippet: null },
      { song: song(2), snippet: null },
    ],
  });
  useToastStore.setState({ toasts: [] });
});

describe("loadCurrentIntoAudio (F4/F5 — arquivo ausente e carga do áudio)", () => {
  it("arquivo existe: define src via asset protocol, zera tempo e toca", async () => {
    const audio = fakeAudio();
    usePlayerStore.getState().playSong(song(1));
    await loadCurrentIntoAudio(audio, usePlayerStore.getState().current!);
    expect(audio.src).toBe("asset:///m/1.mp3");
    expect(audio.currentTime).toBe(0);
    expect(audio.played).toBe(true);
  });

  it("música avulsa com arquivo ausente: toast exato, não inicia, item fica indisponível", async () => {
    const audio = fakeAudio();
    existing.delete("/m/1.mp3");
    usePlayerStore.getState().playSong(song(1, "Sumida"));
    await loadCurrentIntoAudio(audio, usePlayerStore.getState().current!);

    expect(audio.src).toBe("");
    expect(audio.played).toBe(false);
    expect(usePlayerStore.getState().isPlaying).toBe(false);
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toBe(
      "Arquivo não encontrado: Sumida. A música foi removida da biblioteca?",
    );
    expect(toasts[0].kind).toBe("error");
    const item = useLibraryStore
      .getState()
      .results.find((r) => r.song.id === 1);
    expect(item?.song.available).toBe(false);
  });

  it("em playlist: item ausente é pulado com toast e a próxima toca", async () => {
    const audio = fakeAudio();
    existing.delete("/m/1.mp3");
    usePlayerStore.getState().playQueue([song(1, "Ausente"), song(2)], 0, 7);
    await loadCurrentIntoAudio(audio, usePlayerStore.getState().current!);

    const toasts = useToastStore.getState().toasts;
    expect(toasts[0].message).toBe('Pulando "Ausente": arquivo não encontrado.');
    expect(toasts[0].kind).toBe("warning");
    // o store avançou para a próxima; quem recarrega o áudio é o efeito
    expect(usePlayerStore.getState().current?.id).toBe(2);
    expect(usePlayerStore.getState().isPlaying).toBe(true);
  });

  it("falha do play() (decodificação): toast exato e pausa", async () => {
    const audio = fakeAudio();
    audio.play = async () => {
      throw new Error("decode error");
    };
    usePlayerStore.getState().playSong(song(1));
    await loadCurrentIntoAudio(audio, usePlayerStore.getState().current!);

    expect(useToastStore.getState().toasts[0]?.message).toBe(
      "Não foi possível reproduzir este arquivo.",
    );
    expect(usePlayerStore.getState().isPlaying).toBe(false);
  });

  it("última da playlist ausente: para a reprodução", async () => {
    const audio = fakeAudio();
    existing.delete("/m/2.mp3");
    usePlayerStore.getState().playQueue([song(1), song(2, "Fim")], 1, 7);
    await loadCurrentIntoAudio(audio, usePlayerStore.getState().current!);

    expect(usePlayerStore.getState().isPlaying).toBe(false);
    expect(useToastStore.getState().toasts[0].message).toBe(
      'Pulando "Fim": arquivo não encontrado.',
    );
  });
});
