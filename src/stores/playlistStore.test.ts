import { beforeEach, describe, expect, it, vi } from "vitest";
import { setBackendForTests, type Backend } from "../lib/api";
import { usePlaylistStore } from "./playlistStore";
import { usePlayerStore } from "./playerStore";
import type { PlaylistItem, Song } from "../lib/types";

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

let items: PlaylistItem[];

function fakeBackend(): Backend {
  return {
    listPlaylists: vi.fn(async () => [
      { id: 7, name: "Reunião", song_count: items.length },
    ]),
    getPlaylistItems: vi.fn(async () => items),
    createPlaylist: vi.fn(async (name: string) => {
      if (!name.trim()) throw new Error("nome vazio");
      return 8;
    }),
    deletePlaylist: vi.fn(async () => {}),
    addToPlaylist: vi.fn(async () => 99),
    removePlaylistItem: vi.fn(async (itemId: number) => {
      items = items
        .filter((i) => i.id !== itemId)
        .map((i, idx) => ({ ...i, position: idx }));
    }),
    reorderPlaylist: vi.fn(async (_pid: number, itemIds: number[]) => {
      items = itemIds
        .map((id, idx) => ({ ...items.find((i) => i.id === id)!, position: idx }));
    }),
  } as unknown as Backend;
}

describe("playlistStore (F5)", () => {
  beforeEach(() => {
    items = [
      { id: 10, playlist_id: 7, position: 0, song: song(1) },
      { id: 11, playlist_id: 7, position: 1, song: song(2) },
      { id: 12, playlist_id: 7, position: 2, song: song(3) },
    ];
    setBackendForTests(fakeBackend());
    usePlaylistStore.setState({ playlists: [], activePlaylistId: null, items: [] });
    usePlayerStore.setState({
      current: null,
      queue: [],
      queueIndex: null,
      detached: false,
      playlistId: null,
      isPlaying: false,
    });
  });

  it("loadPlaylists e openPlaylist carregam dados", async () => {
    await usePlaylistStore.getState().loadPlaylists();
    expect(usePlaylistStore.getState().playlists).toHaveLength(1);

    await usePlaylistStore.getState().openPlaylist(7);
    const s = usePlaylistStore.getState();
    expect(s.activePlaylistId).toBe(7);
    expect(s.items.map((i) => i.song.id)).toEqual([1, 2, 3]);
  });

  it("reorder atualiza itens e sincroniza a fila do player quando a playlist está tocando", async () => {
    await usePlaylistStore.getState().openPlaylist(7);
    usePlayerStore
      .getState()
      .playQueue(items.map((i) => i.song), 0, 7);

    await usePlaylistStore.getState().reorder([12, 10, 11]);
    expect(
      usePlaylistStore.getState().items.map((i) => i.song.id),
    ).toEqual([3, 1, 2]);
    // fila do player refletida (current continua a mesma, índice realinhado)
    expect(usePlayerStore.getState().queue.map((s) => s.id)).toEqual([3, 1, 2]);
    expect(usePlayerStore.getState().current?.id).toBe(1);
  });

  it("removeItem da música em reprodução mantém o áudio e sincroniza a fila", async () => {
    await usePlaylistStore.getState().openPlaylist(7);
    usePlayerStore
      .getState()
      .playQueue(items.map((i) => i.song), 1, 7);
    expect(usePlayerStore.getState().current?.id).toBe(2);

    await usePlaylistStore.getState().removeItem(11);
    expect(usePlayerStore.getState().current?.id).toBe(2);
    expect(usePlayerStore.getState().isPlaying).toBe(true);
    usePlayerStore.getState().onEnded();
    expect(usePlayerStore.getState().current?.id).toBe(3);
  });

  it("não sincroniza a fila quando outra playlist está tocando", async () => {
    await usePlaylistStore.getState().openPlaylist(7);
    usePlayerStore.getState().playQueue([song(9)], 0, 99);
    await usePlaylistStore.getState().reorder([12, 11, 10]);
    expect(usePlayerStore.getState().queue.map((s) => s.id)).toEqual([9]);
  });

  it("createPlaylist recarrega a lista e retorna o id", async () => {
    const id = await usePlaylistStore.getState().createPlaylist("Nova");
    expect(id).toBe(8);
  });

  it("deletePlaylist fecha a playlist se era a ativa", async () => {
    await usePlaylistStore.getState().openPlaylist(7);
    await usePlaylistStore.getState().deletePlaylist(7);
    expect(usePlaylistStore.getState().activePlaylistId).toBeNull();
  });
});
