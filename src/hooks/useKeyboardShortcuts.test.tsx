import { fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";
import { SEARCH_INPUT_ID } from "../components/SearchBar";
import { useEnrichStore } from "../stores/enrichStore";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlayerStore } from "../stores/playerStore";
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

function Harness() {
  useKeyboardShortcuts();
  return (
    <div>
      <input id={SEARCH_INPUT_ID} aria-label="busca" />
    </div>
  );
}

describe("useKeyboardShortcuts (F4 — espaço e navegação)", () => {
  beforeEach(() => {
    useLibraryStore.setState({
      results: [
        { song: song(1), snippet: null },
        { song: song(2), snippet: null },
      ],
      selectedSongId: null,
      query: "",
    });
    usePlayerStore.setState({
      current: null,
      queue: [],
      queueIndex: null,
      detached: false,
      playlistId: null,
      isPlaying: false,
    });
    useEnrichStore.setState({
      status: "idle",
      overlayOpen: false,
      folderPrefix: "",
      proposals: [],
      progress: null,
    });
  });

  it("espaço alterna play/pause quando há música e o foco não está na busca", () => {
    render(<Harness />);
    usePlayerStore.getState().playSong(song(1));
    expect(usePlayerStore.getState().isPlaying).toBe(true);

    fireEvent.keyDown(document.body, { key: " ", code: "Space" });
    expect(usePlayerStore.getState().isPlaying).toBe(false);

    fireEvent.keyDown(document.body, { key: " ", code: "Space" });
    expect(usePlayerStore.getState().isPlaying).toBe(true);
  });

  it("espaço dentro do campo de busca NÃO pausa a música", () => {
    const { container } = render(<Harness />);
    usePlayerStore.getState().playSong(song(1));

    const input = container.querySelector<HTMLInputElement>(`#${SEARCH_INPUT_ID}`)!;
    input.focus();
    fireEvent.keyDown(input, { key: " ", code: "Space" });
    expect(usePlayerStore.getState().isPlaying).toBe(true);
  });

  it("espaço sem música carregada não faz nada nem lança erro", () => {
    render(<Harness />);
    fireEvent.keyDown(document.body, { key: " ", code: "Space" });
    expect(usePlayerStore.getState().isPlaying).toBe(false);
    expect(usePlayerStore.getState().current).toBeNull();
  });

  it("↑/↓ navegam a seleção da lista e Enter toca a selecionada", () => {
    render(<Harness />);
    fireEvent.keyDown(document.body, { key: "ArrowDown" });
    expect(useLibraryStore.getState().selectedSongId).toBe(1);
    fireEvent.keyDown(document.body, { key: "ArrowDown" });
    expect(useLibraryStore.getState().selectedSongId).toBe(2);
    fireEvent.keyDown(document.body, { key: "ArrowUp" });
    expect(useLibraryStore.getState().selectedSongId).toBe(1);

    fireEvent.keyDown(document.body, { key: "Enter" });
    expect(usePlayerStore.getState().current?.id).toBe(1);
    expect(usePlayerStore.getState().isPlaying).toBe(true);
  });

  it("'/' foca o campo de busca", () => {
    const { container } = render(<Harness />);
    fireEvent.keyDown(document.body, { key: "/" });
    const input = container.querySelector(`#${SEARCH_INPUT_ID}`);
    expect(document.activeElement).toBe(input);
  });

  it("Ctrl+K foca o campo de busca", () => {
    const { container } = render(<Harness />);
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    expect(document.activeElement).toBe(
      container.querySelector(`#${SEARCH_INPUT_ID}`),
    );
  });

  it("setas ←/→ fazem seek de ∓5s fora de inputs", async () => {
    const { audioController } = await import("./playerAudioCore");
    const calls: number[] = [];
    const original = audioController.seekBy;
    audioController.seekBy = (d) => calls.push(d);

    render(<Harness />);
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    fireEvent.keyDown(document.body, { key: "ArrowLeft" });
    expect(calls).toEqual([5, -5]);

    audioController.seekBy = original;
  });

  it("Esc fora do campo limpa a busca", () => {
    render(<Harness />);
    useLibraryStore.setState({ query: "algo" });
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(useLibraryStore.getState().query).toBe("");
  });

  describe("com o overlay de enriquecimento VISÍVEL (modal suspende os atalhos)", () => {
    it("espaço NÃO alterna play/pause", () => {
      render(<Harness />);
      usePlayerStore.getState().playSong(song(1));
      expect(usePlayerStore.getState().isPlaying).toBe(true);

      useEnrichStore.setState({ status: "review", overlayOpen: true });
      fireEvent.keyDown(document.body, { key: " ", code: "Space" });
      expect(usePlayerStore.getState().isPlaying).toBe(true);
    });

    it("Esc NÃO limpa a busca (o modal é quem trata o Esc)", () => {
      render(<Harness />);
      useLibraryStore.setState({ query: "algo" });
      useEnrichStore.setState({ status: "review", overlayOpen: true });
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(useLibraryStore.getState().query).toBe("algo");
    });

    it("setas, Enter e '/' também ficam suspensos (inclusive durante a varredura)", () => {
      const { container } = render(<Harness />);
      useEnrichStore.setState({ status: "scanning", overlayOpen: true });

      fireEvent.keyDown(document.body, { key: "ArrowDown" });
      expect(useLibraryStore.getState().selectedSongId).toBeNull();

      fireEvent.keyDown(document.body, { key: "Enter" });
      expect(usePlayerStore.getState().current).toBeNull();

      fireEvent.keyDown(document.body, { key: "/" });
      expect(document.activeElement).not.toBe(
        container.querySelector(`#${SEARCH_INPUT_ID}`),
      );
    });
  });

  describe("com a varredura em SEGUNDO PLANO (overlay escondido: o app segue usável)", () => {
    it("espaço continua alternando play/pause", () => {
      render(<Harness />);
      usePlayerStore.getState().playSong(song(1));
      useEnrichStore.setState({ status: "scanning", overlayOpen: false });

      fireEvent.keyDown(document.body, { key: " ", code: "Space" });
      expect(usePlayerStore.getState().isPlaying).toBe(false);
    });

    it("setas continuam navegando e Esc continua limpando a busca", () => {
      render(<Harness />);
      useLibraryStore.setState({ query: "algo" });
      useEnrichStore.setState({ status: "scanning", overlayOpen: false });

      fireEvent.keyDown(document.body, { key: "ArrowDown" });
      expect(useLibraryStore.getState().selectedSongId).toBe(1);

      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(useLibraryStore.getState().query).toBe("");
    });

    it("revisão pendente em segundo plano também não suspende os atalhos", () => {
      render(<Harness />);
      usePlayerStore.getState().playSong(song(1));
      useEnrichStore.setState({ status: "review", overlayOpen: false });

      fireEvent.keyDown(document.body, { key: " ", code: "Space" });
      expect(usePlayerStore.getState().isPlaying).toBe(false);
    });
  });
});
