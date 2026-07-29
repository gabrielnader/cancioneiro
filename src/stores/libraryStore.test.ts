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
    onEnrichProgress: vi.fn(async () => () => {}),
    writeTags: vi.fn(async () => song(1, "Aurora")),
    // V10 — a contagem devolve um OBJETO: total, quantas sem letra, a
    // estimativa PRONTA e as etapas que vão rodar nesta máquina
    enrichCount: vi.fn(async () => ({
      total: 0,
      sem_letra: 0,
      segundos_estimados: 0,
      etapas: [],
      transcricao_disponivel: false,
    })),
    // QA A2 — a varredura devolve um OBJETO, não a lista de propostas; V10
    // acrescentou a fila da etapa 5 e o tempo dela
    enrichFolderScan: vi.fn(async () => ({
      propostas: [],
      sem_perguntar_ao_som: 0,
      sem_letra_no_fim: [],
      segundos_de_transcricao: 0,
    })),
    transcreverMusicas: vi.fn(async () => ({ propostas: [], razao_medida: null })),
    onTranscricaoProgresso: vi.fn(async () => () => {}),
    enrichSongScan: vi.fn(async () => null),
    enrichCancelScan: vi.fn(async () => {}),
    enrichApply: vi.fn(async () => []),
    // V9 — o contrato ganhou os acessórios; este fake implementa o Backend
    // inteiro de propósito: um fake parcial deixa de acusar quando a interface
    // cresce, que é como o mock e o Rust acabaram certificando contratos
    // diferentes (DECISIONS #88).
    acessoriosEstado: vi.fn(async () => []),
    acessorioBaixar: vi.fn(async () => {
      throw new Error("não há este acessório para este computador");
    }),
    acessorioCancelar: vi.fn(async () => {}),
    onAcessorioProgresso: vi.fn(async () => () => {}),
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

  describe("filtro de pasta (V4 — F11)", () => {
    it("folderFilter começa null e setFolderFilter define/limpa", () => {
      expect(useLibraryStore.getState().folderFilter).toBeNull();
      useLibraryStore.getState().setFolderFilter("/acervo/1");
      expect(useLibraryStore.getState().folderFilter).toBe("/acervo/1");
      useLibraryStore.getState().setFolderFilter(null);
      expect(useLibraryStore.getState().folderFilter).toBeNull();
    });

    it("loadLibrary carrega allSongs (biblioteca inteira, para a árvore)", async () => {
      await useLibraryStore.getState().loadLibrary();
      expect(useLibraryStore.getState().allSongs.map((s) => s.title)).toEqual([
        "Aurora",
        "Brisa",
      ]);
    });
  });

  describe("updateSong (V4 — F10)", () => {
    it("substitui a música em results e allSongs preservando o snippet", async () => {
      await useLibraryStore.getState().loadLibrary();
      const edited = { ...song(2, "Brisa Editada"), temas: "fé" };
      useLibraryStore.getState().updateSong(edited);
      const s = useLibraryStore.getState();
      expect(s.results.find((r) => r.song.id === 2)!.song.title).toBe(
        "Brisa Editada",
      );
      expect(s.allSongs.find((x) => x.id === 2)!.title).toBe("Brisa Editada");
      // músicas não editadas ficam intactas
      expect(s.results.find((r) => r.song.id === 1)!.song.title).toBe("Aurora");
    });
  });
});
