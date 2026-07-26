import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Backend } from "../lib/api";
import { setBackendForTests } from "../lib/api";
import { useLibraryStore } from "./libraryStore";
import type { Song } from "../lib/types";

function song(id: number, title: string, hasLyrics = true): Song {
  return {
    id,
    file_path: `/m/${title}.mp3`,
    folder_id: 1,
    title,
    artist: "Artista",
    album: null,
    duration_seconds: 3,
    has_lyrics: hasLyrics,
    available: true,
  };
}

function fakeBackend(overrides: Partial<Backend> = {}): Backend {
  return {
    addFolder: vi.fn(async () => ({
      indexed: 3,
      skipped: 0,
      removed: 0,
      total: 3,
      missing_folders: [],
    })),
    removeFolder: vi.fn(async () => {}),
    listFolders: vi.fn(async () => [
      { id: 1, path: "/m", last_scanned_at: null },
    ]),
    scan: vi.fn(async () => ({
      indexed: 0,
      skipped: 3,
      removed: 0,
      total: 3,
      missing_folders: ["/sumiu"],
    })),
    listSongs: vi.fn(async () => [song(1, "Aurora"), song(2, "Brisa")]),
    search: vi.fn(async (q: string) =>
      q === ""
        ? [
            { song: song(1, "Aurora"), snippet: null },
            { song: song(2, "Brisa"), snippet: null },
          ]
        : [{ song: song(2, "Brisa"), snippet: "com brisa leve" }],
    ),
    getLyrics: vi.fn(async () => "letra\ncompleta"),
    fileExists: vi.fn(async () => true),
    createPlaylist: vi.fn(async () => 1),
    deletePlaylist: vi.fn(async () => {}),
    listPlaylists: vi.fn(async () => []),
    getPlaylistItems: vi.fn(async () => []),
    addToPlaylist: vi.fn(async () => 1),
    removePlaylistItem: vi.fn(async () => {}),
    reorderPlaylist: vi.fn(async () => {}),
    pickFolder: vi.fn(async () => "/m"),
    fileSrc: (p: string) => p,
    onScanProgress: vi.fn(async () => () => {}),
    ...overrides,
  };
}

describe("libraryStore", () => {
  beforeEach(() => {
    setBackendForTests(fakeBackend());
    useLibraryStore.setState({
      results: [],
      folders: [],
      missingFolders: [],
      query: "",
      selectedSongId: null,
      scanning: null,
      libraryLoaded: false,
    });
  });

  it("loadLibrary carrega músicas (ordem do backend) e pastas", async () => {
    await useLibraryStore.getState().loadLibrary();
    const s = useLibraryStore.getState();
    expect(s.results.map((r) => r.song.title)).toEqual(["Aurora", "Brisa"]);
    expect(s.folders).toHaveLength(1);
    expect(s.libraryLoaded).toBe(true);
  });

  it("runSearch preenche resultados com snippet", async () => {
    await useLibraryStore.getState().runSearch("brisa");
    const s = useLibraryStore.getState();
    expect(s.results).toHaveLength(1);
    expect(s.results[0].song.title).toBe("Brisa");
    expect(s.results[0].snippet).toContain("brisa");
  });

  it("runSearch com campo vazio restaura a biblioteca completa", async () => {
    await useLibraryStore.getState().runSearch("brisa");
    await useLibraryStore.getState().runSearch("");
    expect(useLibraryStore.getState().results).toHaveLength(2);
  });

  it("resultados de busca antiga não sobrescrevem busca mais recente (guard de corrida)", async () => {
    let resolveSlow: (v: never[]) => void = () => {};
    const slow = new Promise<never[]>((res) => {
      resolveSlow = res;
    });
    setBackendForTests(
      fakeBackend({
        search: vi.fn((q: string) => {
          if (q === "lenta") return slow as Promise<never[]>;
          return Promise.resolve([
            { song: song(9, "Recente"), snippet: null },
          ]);
        }),
      }),
    );

    const p1 = useLibraryStore.getState().runSearch("lenta");
    await useLibraryStore.getState().runSearch("rapida");
    resolveSlow([]);
    await p1;

    expect(useLibraryStore.getState().results.map((r) => r.song.title)).toEqual([
      "Recente",
    ]);
  });

  it("select define selectedSongId", () => {
    useLibraryStore.getState().select(7);
    expect(useLibraryStore.getState().selectedSongId).toBe(7);
    useLibraryStore.getState().select(null);
    expect(useLibraryStore.getState().selectedSongId).toBeNull();
  });

  it("rescan atualiza missingFolders e recarrega a lista", async () => {
    await useLibraryStore.getState().rescan();
    const s = useLibraryStore.getState();
    expect(s.missingFolders).toEqual(["/sumiu"]);
    expect(s.results.length).toBeGreaterThan(0);
  });

  it("addFolder registra a pasta e recarrega biblioteca", async () => {
    const result = await useLibraryStore.getState().addFolder("/m");
    expect(result.total).toBe(3);
    expect(useLibraryStore.getState().results.length).toBe(2);
  });

  it("removeFolder recarrega pastas e biblioteca", async () => {
    await useLibraryStore.getState().loadLibrary();
    await useLibraryStore.getState().removeFolder(1);
    const s = useLibraryStore.getState();
    expect(s.results.length).toBe(2); // fake backend continua devolvendo 2
  });
});
