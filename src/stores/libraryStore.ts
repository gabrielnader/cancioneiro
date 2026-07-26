import { create } from "zustand";
import { getBackend } from "../lib/api";
import type { Folder, ScanResult, SearchResult } from "../lib/types";

interface ScanningState {
  done: number;
  total: number;
}

interface LibraryState {
  /** Lista exibida na coluna central (busca ou biblioteca completa). */
  results: SearchResult[];
  query: string;
  selectedSongId: number | null;
  folders: Folder[];
  missingFolders: string[];
  scanning: ScanningState | null;
  libraryLoaded: boolean;

  setQuery: (q: string) => void;
  select: (songId: number | null) => void;
  loadLibrary: () => Promise<void>;
  runSearch: (query: string) => Promise<void>;
  addFolder: (path: string) => Promise<ScanResult>;
  removeFolder: (folderId: number) => Promise<void>;
  rescan: () => Promise<ScanResult>;
  setScanning: (s: ScanningState | null) => void;
  /** Marca visualmente uma música como indisponível (arquivo sumiu no play). */
  markUnavailable: (songId: number) => void;
}

let searchSeq = 0;

export const useLibraryStore = create<LibraryState>()((set, get) => ({
  results: [],
  query: "",
  selectedSongId: null,
  folders: [],
  missingFolders: [],
  scanning: null,
  libraryLoaded: false,

  setQuery: (q) => set({ query: q }),

  select: (songId) => set({ selectedSongId: songId }),

  loadLibrary: async () => {
    const backend = getBackend();
    const [results, folders] = await Promise.all([
      backend.search(get().query),
      backend.listFolders(),
    ]);
    set({ results, folders, libraryLoaded: true });
  },

  runSearch: async (query) => {
    const seq = ++searchSeq;
    const results = await getBackend().search(query);
    // Descarta respostas de buscas antigas que chegaram fora de ordem.
    if (seq === searchSeq) {
      set({ results });
    }
  },

  addFolder: async (path) => {
    const backend = getBackend();
    const result = await backend.addFolder(path);
    await get().loadLibrary();
    set({ scanning: null });
    return result;
  },

  removeFolder: async (folderId) => {
    const backend = getBackend();
    await backend.removeFolder(folderId);
    const missing = get().missingFolders;
    const removed = get().folders.find((f) => f.id === folderId);
    await get().loadLibrary();
    if (removed) {
      set({ missingFolders: missing.filter((p) => p !== removed.path) });
    }
  },

  rescan: async () => {
    const result = await getBackend().scan();
    set({ missingFolders: result.missing_folders });
    await get().loadLibrary();
    set({ scanning: null });
    return result;
  },

  setScanning: (s) => set({ scanning: s }),

  markUnavailable: (songId) =>
    set((state) => ({
      results: state.results.map((r) =>
        r.song.id === songId
          ? { ...r, song: { ...r.song, available: false } }
          : r,
      ),
    })),
}));
