import { beforeEach, describe, expect, it } from "vitest";
import { playSelectedOrToggle } from "./playbackActions";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlayerStore } from "../stores/playerStore";
import { usePlaylistStore } from "../stores/playlistStore";
import { useUiStore } from "../stores/uiStore";
import type { Song } from "./types";

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

describe("playSelectedOrToggle (F4 — '▶ Tocar' e espaço com música selecionada)", () => {
  beforeEach(() => {
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
      selectedSongId: null,
    });
    usePlaylistStore.setState({ playlists: [], activePlaylistId: null, items: [] });
    useUiStore.setState({ view: "library" });
  });

  it("com música carregada: alterna play/pause (comportamento original)", () => {
    usePlayerStore.getState().playSong(song(1));
    playSelectedOrToggle();
    expect(usePlayerStore.getState().isPlaying).toBe(false);
    playSelectedOrToggle();
    expect(usePlayerStore.getState().isPlaying).toBe(true);
  });

  it("sem música carregada e com seleção na biblioteca: inicia a selecionada", () => {
    useLibraryStore.setState({ selectedSongId: 2 });
    playSelectedOrToggle();
    const s = usePlayerStore.getState();
    expect(s.current?.id).toBe(2);
    expect(s.isPlaying).toBe(true);
    expect(s.queue).toEqual([]);
  });

  it("sem música carregada e com seleção em playlist aberta: inicia a fila a partir dela", () => {
    useUiStore.setState({ view: "playlist" });
    usePlaylistStore.setState({
      activePlaylistId: 7,
      items: [
        { id: 10, playlist_id: 7, position: 0, song: song(1) },
        { id: 11, playlist_id: 7, position: 1, song: song(2) },
      ],
    });
    useLibraryStore.setState({ selectedSongId: 2 });
    playSelectedOrToggle();
    const s = usePlayerStore.getState();
    expect(s.current?.id).toBe(2);
    expect(s.playlistId).toBe(7);
    expect(s.queue.map((x) => x.id)).toEqual([1, 2]);
    usePlayerStore.getState().onEnded();
    expect(usePlayerStore.getState().isPlaying).toBe(false); // era a última
  });

  it("sem música carregada e sem seleção: nenhuma ação, sem erro (PRD F4)", () => {
    playSelectedOrToggle();
    const s = usePlayerStore.getState();
    expect(s.current).toBeNull();
    expect(s.isPlaying).toBe(false);
  });

  it("seleção indisponível (arquivo sumido) não inicia pela biblioteca", () => {
    useLibraryStore.setState({
      results: [{ song: { ...song(1), available: false }, snippet: null }],
      selectedSongId: 1,
    });
    playSelectedOrToggle();
    expect(usePlayerStore.getState().current).toBeNull();
  });
});
