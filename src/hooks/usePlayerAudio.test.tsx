import { act, render } from "@testing-library/react";
import { useRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePlayerAudio } from "./usePlayerAudio";
import { audioController } from "./playerAudioCore";
import { setBackendForTests, type Backend } from "../lib/api";
import { usePlayerStore } from "../stores/playerStore";
import { useToastStore } from "../stores/toastStore";
import { useLibraryStore } from "../stores/libraryStore";
import type { Song } from "../lib/types";

function song(id: number): Song {
  return {
    id,
    file_path: `/m/${id}.mp3`,
    folder_id: 1,
    title: `Faixa ${id}`,
    artist: null,
    album: null,
    duration_seconds: 3,
    has_lyrics: false,
    available: true,
  };
}

let audioEl: HTMLAudioElement | null = null;

function Harness() {
  const ref = useRef<HTMLAudioElement>(null);
  usePlayerAudio(ref);
  return (
    <audio
      ref={(el) => {
        (ref as React.MutableRefObject<HTMLAudioElement | null>).current = el;
        audioEl = el;
      }}
    />
  );
}

describe("usePlayerAudio (F4 — ligação store ↔ <audio>)", () => {
  beforeEach(() => {
    audioEl = null;
    // jsdom não implementa play/pause de mídia
    window.HTMLMediaElement.prototype.play = vi.fn(async () => {});
    window.HTMLMediaElement.prototype.pause = vi.fn(() => {});
    setBackendForTests({
      fileExists: vi.fn(async () => true),
      fileSrc: (p: string) => `asset://${p}`,
    } as unknown as Backend);
    usePlayerStore.setState({
      current: null,
      queue: [],
      queueIndex: null,
      detached: false,
      playlistId: null,
      isPlaying: false,
      volume: 0.8,
      playRequestId: 0,
    });
    useToastStore.setState({ toasts: [] });
    useLibraryStore.setState({ results: [] });
  });

  it("carrega a faixa no src quando playSong é chamado e aplica o volume", async () => {
    render(<Harness />);
    expect(audioEl!.volume).toBeCloseTo(0.8);

    await act(async () => {
      usePlayerStore.getState().playSong(song(1));
      await Promise.resolve();
    });
    expect(audioEl!.src).toContain("asset://");
    expect(window.HTMLMediaElement.prototype.play).toHaveBeenCalled();
  });

  it("evento 'ended' avança a fila (reprodução automática de playlist)", async () => {
    render(<Harness />);
    await act(async () => {
      usePlayerStore.getState().playQueue([song(1), song(2)], 0, 7);
      await Promise.resolve();
    });
    await act(async () => {
      audioEl!.dispatchEvent(new Event("ended"));
      await Promise.resolve();
    });
    expect(usePlayerStore.getState().current?.id).toBe(2);
    expect(usePlayerStore.getState().isPlaying).toBe(true);
  });

  it("evento 'error' com src carregado mostra o toast exato e pausa", async () => {
    render(<Harness />);
    await act(async () => {
      usePlayerStore.getState().playSong(song(1));
      await Promise.resolve();
    });
    await act(async () => {
      audioEl!.dispatchEvent(new Event("error"));
      await Promise.resolve();
    });
    expect(useToastStore.getState().toasts[0]?.message).toBe(
      "Não foi possível reproduzir este arquivo.",
    );
    expect(usePlayerStore.getState().isPlaying).toBe(false);
  });

  it("pausar via store chama pause() no elemento", async () => {
    render(<Harness />);
    await act(async () => {
      usePlayerStore.getState().playSong(song(1));
      await Promise.resolve();
    });
    await act(async () => {
      usePlayerStore.getState().togglePlayPause();
      await Promise.resolve();
    });
    expect(window.HTMLMediaElement.prototype.pause).toHaveBeenCalled();
  });

  it("audioController faz seek no elemento (seekTo/seekBy com clamp em 0)", async () => {
    render(<Harness />);
    await act(async () => {
      usePlayerStore.getState().playSong(song(1));
      await Promise.resolve();
    });
    audioController.seekTo(10);
    expect(audioEl!.currentTime).toBe(10);
    audioController.seekBy(-4);
    expect(audioEl!.currentTime).toBe(6);
    audioController.seekBy(-100);
    expect(audioEl!.currentTime).toBe(0);
    expect(audioController.getCurrentTime()).toBe(0);
  });
});
