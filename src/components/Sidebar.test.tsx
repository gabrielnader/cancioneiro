import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";
import { setBackendForTests, type Backend } from "../lib/api";
import { useEnrichStore } from "../stores/enrichStore";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlaylistStore } from "../stores/playlistStore";
import { useUiStore } from "../stores/uiStore";
import type { Song } from "../lib/types";

function song(id: number, filePath: string): Song {
  return {
    id,
    file_path: filePath,
    folder_id: 1,
    title: `Faixa ${id}`,
    artist: null,
    album: null,
    duration_seconds: 3,
    has_lyrics: false,
    available: true,
  };
}

describe("Sidebar — árvore de pastas (V4 F11)", () => {
  beforeEach(() => {
    setBackendForTests({
      listPlaylists: vi.fn(async () => []),
      getPlaylistItems: vi.fn(async () => []),
    } as unknown as Backend);
    useUiStore.setState({ view: "library" });
    usePlaylistStore.setState({ playlists: [], activePlaylistId: null, items: [] });
    useLibraryStore.setState({
      folders: [{ id: 1, path: "/acervo", last_scanned_at: null }],
      allSongs: [
        song(1, "/acervo/1/a.mp3"),
        song(2, "/acervo/1/b.mp3"),
        song(3, "/acervo/2/c.mp3"),
      ],
      folderFilter: null,
    });
  });

  it("renderiza a árvore sob Biblioteca: raiz e subpastas com contadores", () => {
    render(<Sidebar />);
    const root = screen.getByRole("button", { name: "Pasta acervo" });
    expect(root).toHaveTextContent("acervo");
    expect(root).toHaveTextContent("3");
    const um = screen.getByRole("button", { name: "Pasta 1" });
    expect(um).toHaveTextContent("2");
    const dois = screen.getByRole("button", { name: "Pasta 2" });
    expect(dois).toHaveTextContent("1");
  });

  it("clicar numa SUBPASTA define o filtro, abre a Biblioteca e fecha a playlist", () => {
    useUiStore.setState({ view: "playlist" });
    usePlaylistStore.setState({ activePlaylistId: 7 });
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: "Pasta 1" }));
    expect(useLibraryStore.getState().folderFilter).toBe("/acervo/1");
    expect(useUiStore.getState().view).toBe("library");
    expect(usePlaylistStore.getState().activePlaylistId).toBeNull();
  });

  it("clicar na pasta RAIZ não seta filtro — equivale a Biblioteca (V5 Q2)", () => {
    useUiStore.setState({ view: "playlist" });
    usePlaylistStore.setState({ activePlaylistId: 7 });
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: "Pasta acervo" }));
    expect(useLibraryStore.getState().folderFilter).toBeNull();
    expect(useUiStore.getState().view).toBe("library");
    expect(usePlaylistStore.getState().activePlaylistId).toBeNull();
  });

  it("clicar na pasta RAIZ com filtro de subpasta ativo LIMPA o filtro (V5 Q2)", () => {
    useLibraryStore.setState({ folderFilter: "/acervo/1" });
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: "Pasta acervo" }));
    expect(useLibraryStore.getState().folderFilter).toBeNull();
  });

  it("clicar em Biblioteca limpa o filtro de pasta", () => {
    useLibraryStore.setState({ folderFilter: "/acervo/1" });
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: "Biblioteca" }));
    expect(useLibraryStore.getState().folderFilter).toBeNull();
  });

  it("pasta ativa aparece destacada", () => {
    useLibraryStore.setState({ folderFilter: "/acervo/2" });
    render(<Sidebar />);
    const dois = screen.getByRole("button", { name: "Pasta 2" });
    expect(dois.className).toContain("text-[#0F766E]");
  });

  it("sem músicas não renderiza subpastas (raiz com contador 0)", () => {
    useLibraryStore.setState({ allSongs: [] });
    render(<Sidebar />);
    expect(screen.getByRole("button", { name: "Pasta acervo" })).toHaveTextContent("0");
    expect(screen.queryByRole("button", { name: "Pasta 1" })).not.toBeInTheDocument();
  });
});

describe("Sidebar — Completar dados (V5 F13)", () => {
  beforeEach(() => {
    setBackendForTests({
      listPlaylists: vi.fn(async () => []),
      getPlaylistItems: vi.fn(async () => []),
    } as unknown as Backend);
    useUiStore.setState({ view: "library" });
    usePlaylistStore.setState({ playlists: [], activePlaylistId: null, items: [] });
    useLibraryStore.setState({
      folders: [{ id: 1, path: "/acervo", last_scanned_at: null }],
      allSongs: [song(1, "/acervo/1/a.mp3"), song(2, "/acervo/2/b.mp3")],
      folderFilter: null,
    });
    useEnrichStore.setState({
      status: "idle",
      overlayOpen: false,
      folderPrefix: "",
      proposals: [],
      progress: null,
      scanId: "",
      scannedTotal: 0,
      applyErrors: {},
      scanInFlight: false,
    });
  });

  it("SUBPASTA tem o botão 'Completar dados desta pasta' que dispara com o caminho da pasta", () => {
    const startScan = vi.fn(async () => {});
    useEnrichStore.setState({ startScan });
    render(<Sidebar />);
    fireEvent.click(
      screen.getByRole("button", { name: "Completar dados da pasta 1" }),
    );
    expect(startScan).toHaveBeenCalledWith("/acervo/1");
  });

  it("RAIZ tem 'Completar dados da biblioteca' que dispara com prefixo vazio", () => {
    const startScan = vi.fn(async () => {});
    useEnrichStore.setState({ startScan });
    render(<Sidebar />);
    fireEvent.click(
      screen.getByRole("button", { name: "Completar dados da biblioteca" }),
    );
    expect(startScan).toHaveBeenCalledWith("");
  });

  it("botão da subpasta não dispara o filtro de pasta (clique não propaga)", () => {
    const startScan = vi.fn(async () => {});
    useEnrichStore.setState({ startScan });
    render(<Sidebar />);
    fireEvent.click(
      screen.getByRole("button", { name: "Completar dados da pasta 2" }),
    );
    expect(useLibraryStore.getState().folderFilter).toBeNull();
    expect(startScan).toHaveBeenCalledWith("/acervo/2");
  });

  it("botão fica visível (block) quando a pasta está selecionada — alcançável por toque", () => {
    useLibraryStore.setState({ folderFilter: "/acervo/1" });
    render(<Sidebar />);
    const selecionada = screen.getByRole("button", {
      name: "Completar dados da pasta 1",
    });
    expect(selecionada.className).toContain("block");
    const outra = screen.getByRole("button", {
      name: "Completar dados da pasta 2",
    });
    expect(outra.className).toContain("hidden");
  });

  it("uma varredura em andamento desabilita o ✎ de TODAS as pastas (só uma por vez)", () => {
    useEnrichStore.setState({ status: "scanning" });
    render(<Sidebar />);
    for (const name of [
      "Completar dados da biblioteca",
      "Completar dados da pasta 1",
      "Completar dados da pasta 2",
    ]) {
      const botao = screen.getByRole("button", { name });
      expect(botao).toBeDisabled();
      expect(botao).toHaveAttribute(
        "title",
        "Uma busca de dados já está em andamento",
      );
    }
  });

  // M4: depois de "Cancelar" o invoke ainda está na rede por alguns segundos;
  // liberar o ✎ aí começava uma segunda varredura por cima da primeira.
  it("varredura cancelada mas ainda respondendo: ✎ segue desabilitado, com o porquê", () => {
    useEnrichStore.setState({ status: "idle", scanInFlight: true });
    render(<Sidebar />);
    const botao = screen.getByRole("button", {
      name: "Completar dados da biblioteca",
    });
    expect(botao).toBeDisabled();
    expect(botao).toHaveAttribute(
      "title",
      "Terminando de encerrar a busca anterior — aguarde alguns segundos",
    );
  });

  it("nada rodando: ✎ habilitado", () => {
    render(<Sidebar />);
    expect(
      screen.getByRole("button", { name: "Completar dados da biblioteca" }),
    ).toBeEnabled();
  });
});

describe("Sidebar — indicador de varredura em segundo plano (V5 F13)", () => {
  beforeEach(() => {
    setBackendForTests({
      listPlaylists: vi.fn(async () => []),
      getPlaylistItems: vi.fn(async () => []),
    } as unknown as Backend);
    useUiStore.setState({ view: "library" });
    usePlaylistStore.setState({ playlists: [], activePlaylistId: null, items: [] });
    useLibraryStore.setState({
      folders: [{ id: 1, path: "/acervo", last_scanned_at: null }],
      allSongs: [song(1, "/acervo/1/a.mp3")],
      folderFilter: null,
    });
    useEnrichStore.setState({
      status: "idle",
      overlayOpen: false,
      folderPrefix: "",
      proposals: [],
      progress: null,
      scanId: "",
      scannedTotal: 0,
      applyErrors: {},
      scanInFlight: false,
    });
  });

  it("não aparece quando o overlay está aberto (o overlay já mostra o progresso)", () => {
    useEnrichStore.setState({
      status: "scanning",
      overlayOpen: true,
      progress: { done: 2, total: 9, atual: "a.mp3", scan_id: "s1" },
    });
    render(<Sidebar />);
    expect(
      screen.queryByRole("button", { name: /Buscando dados/ }),
    ).not.toBeInTheDocument();
  });

  it("varrendo em segundo plano: mostra a contagem e reabre o overlay no clique", () => {
    useEnrichStore.setState({
      status: "scanning",
      overlayOpen: false,
      progress: { done: 2, total: 9, atual: "a.mp3", scan_id: "s1" },
    });
    render(<Sidebar />);
    const indicador = screen.getByRole("button", {
      name: "Buscando dados… 2 de 9",
    });
    fireEvent.click(indicador);
    expect(useEnrichStore.getState().overlayOpen).toBe(true);
  });

  it("sem progresso ainda: indicador sem contagem", () => {
    useEnrichStore.setState({ status: "scanning", overlayOpen: false });
    render(<Sidebar />);
    expect(
      screen.getByRole("button", { name: "Buscando dados…" }),
    ).toBeInTheDocument();
  });

  it("varredura terminada em segundo plano: botão 'Revisar N propostas' reabre a revisão", () => {
    useEnrichStore.setState({
      status: "review",
      overlayOpen: false,
      proposals: [
        { song_id: 1 } as never,
        { song_id: 2 } as never,
        { song_id: 3 } as never,
      ],
    });
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: "Revisar 3 propostas" }));
    expect(useEnrichStore.getState().overlayOpen).toBe(true);
  });

  it("uma proposta só: singular", () => {
    useEnrichStore.setState({
      status: "review",
      overlayOpen: false,
      proposals: [{ song_id: 1 } as never],
    });
    render(<Sidebar />);
    expect(
      screen.getByRole("button", { name: "Revisar 1 proposta" }),
    ).toBeInTheDocument();
  });

  it("idle: nenhum indicador", () => {
    render(<Sidebar />);
    expect(
      screen.queryByRole("button", { name: /Buscando dados|Revisar/ }),
    ).not.toBeInTheDocument();
  });
});
