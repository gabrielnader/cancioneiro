import { create } from "zustand";
import { getBackend } from "../lib/api";
import type { Playlist, PlaylistItem } from "../lib/types";
import { usePlayerStore } from "./playerStore";

interface PlaylistState {
  playlists: Playlist[];
  /** Playlist aberta na coluna central (null = biblioteca). */
  activePlaylistId: number | null;
  items: PlaylistItem[];

  loadPlaylists: () => Promise<void>;
  openPlaylist: (playlistId: number) => Promise<void>;
  closePlaylist: () => void;
  createPlaylist: (name: string) => Promise<number>;
  deletePlaylist: (playlistId: number) => Promise<void>;
  addToPlaylist: (playlistId: number, songId: number) => Promise<void>;
  removeItem: (itemId: number) => Promise<void>;
  reorder: (itemIds: number[]) => Promise<void>;
}

/** Mantém a fila do player alinhada quando a playlist tocando muda. */
function syncPlayerIfPlaying(playlistId: number, items: PlaylistItem[]) {
  const player = usePlayerStore.getState();
  if (player.playlistId === playlistId) {
    player.syncQueue(items.map((i) => i.song));
  }
}

export const usePlaylistStore = create<PlaylistState>()((set, get) => ({
  playlists: [],
  activePlaylistId: null,
  items: [],

  loadPlaylists: async () => {
    set({ playlists: await getBackend().listPlaylists() });
  },

  openPlaylist: async (playlistId) => {
    const items = await getBackend().getPlaylistItems(playlistId);
    set({ activePlaylistId: playlistId, items });
  },

  closePlaylist: () => set({ activePlaylistId: null, items: [] }),

  createPlaylist: async (name) => {
    const id = await getBackend().createPlaylist(name);
    await get().loadPlaylists();
    return id;
  },

  deletePlaylist: async (playlistId) => {
    await getBackend().deletePlaylist(playlistId);
    if (get().activePlaylistId === playlistId) {
      set({ activePlaylistId: null, items: [] });
    }
    await get().loadPlaylists();
  },

  addToPlaylist: async (playlistId, songId) => {
    await getBackend().addToPlaylist(playlistId, songId);
    await get().loadPlaylists();
    if (get().activePlaylistId === playlistId) {
      const items = await getBackend().getPlaylistItems(playlistId);
      set({ items });
      syncPlayerIfPlaying(playlistId, items);
    } else {
      const items = await getBackend().getPlaylistItems(playlistId);
      syncPlayerIfPlaying(playlistId, items);
    }
  },

  removeItem: async (itemId) => {
    const playlistId = get().activePlaylistId;
    if (playlistId === null) return;
    await getBackend().removePlaylistItem(itemId);
    const items = await getBackend().getPlaylistItems(playlistId);
    set({ items });
    await get().loadPlaylists();
    syncPlayerIfPlaying(playlistId, items);
  },

  reorder: async (itemIds) => {
    const playlistId = get().activePlaylistId;
    if (playlistId === null) return;
    await getBackend().reorderPlaylist(playlistId, itemIds);
    const items = await getBackend().getPlaylistItems(playlistId);
    set({ items });
    syncPlayerIfPlaying(playlistId, items);
  },
}));
