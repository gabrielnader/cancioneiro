import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LibraryView } from "./LibraryView";
import { setBackendForTests, type Backend } from "../lib/api";
import { useLibraryStore } from "../stores/libraryStore";
import type { Song } from "../lib/types";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (opts: { count: number; estimateSize: () => number }) => ({
    getTotalSize: () => opts.count * opts.estimateSize(),
    getVirtualItems: () =>
      Array.from({ length: opts.count }, (_, index) => ({
        index,
        key: index,
        start: index * opts.estimateSize(),
        size: opts.estimateSize(),
      })),
    measureElement: () => {},
  }),
}));

function song(id: number, title: string): Song {
  return {
    id,
    file_path: `/m/${title}.mp3`,
    folder_id: 1,
    title,
    artist: null,
    album: null,
    duration_seconds: 3,
    has_lyrics: true,
    available: true,
  };
}

describe("LibraryView (F1 UI / F2)", () => {
  beforeEach(() => {
    setBackendForTests({
      search: vi.fn(async () => []),
      listFolders: vi.fn(async () => []),
    } as unknown as Backend);
    useLibraryStore.setState({
      results: [],
      folders: [],
      missingFolders: [],
      query: "",
      scanning: null,
      libraryLoaded: true,
      selectedSongId: null,
    });
  });

  it("biblioteca vazia: copies exatas do empty state (F1)", () => {
    render(<LibraryView />);
    expect(screen.getByText("Sua biblioteca está vazia")).toBeInTheDocument();
    expect(
      screen.getByText("Adicione uma pasta com suas músicas para começar."),
    ).toBeInTheDocument();
    expect(screen.getByText("Adicionar pasta")).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("Buscar por letra, título ou artista…"),
    ).toBeInTheDocument();
  });

  it("busca sem resultados: mensagens exatas do PRD", () => {
    useLibraryStore.setState({
      query: "inexistente",
      results: [],
      folders: [{ id: 1, path: "/m", last_scanned_at: null }],
    });
    render(<LibraryView />);
    expect(
      screen.getByText('Nenhuma música encontrada para "inexistente".'),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Tente palavras diferentes do trecho que você lembra."),
    ).toBeInTheDocument();
  });

  it("contador '{n} resultados' aparece em busca real", () => {
    useLibraryStore.setState({
      query: "aur",
      results: [{ song: song(1, "Aurora"), snippet: null }],
      folders: [{ id: 1, path: "/m", last_scanned_at: null }],
    });
    render(<LibraryView />);
    expect(screen.getByText("1 resultados")).toBeInTheDocument();
  });

  it("query só de caracteres especiais: sem contador e sem estado vazio (backend devolve tudo)", () => {
    useLibraryStore.setState({
      query: '"*-',
      results: [
        { song: song(1, "Aurora"), snippet: null },
        { song: song(2, "Brisa"), snippet: null },
      ],
      folders: [{ id: 1, path: "/m", last_scanned_at: null }],
    });
    render(<LibraryView />);
    expect(screen.queryByText(/resultados/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Nenhuma música encontrada/)).not.toBeInTheDocument();
    expect(screen.getByText("Aurora")).toBeInTheDocument();
  });

  it("banner de pasta sumida com copy e ações do PRD", () => {
    useLibraryStore.setState({
      missingFolders: ["/hd/externo"],
      folders: [{ id: 5, path: "/hd/externo", last_scanned_at: null }],
      results: [{ song: song(1, "Aurora"), snippet: null }],
    });
    render(<LibraryView />);
    expect(
      screen.getByText(
        "A pasta /hd/externo não foi encontrada. Verifique se o disco está conectado.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Remover pasta")).toBeInTheDocument();
    expect(screen.getByText("Tentar de novo")).toBeInTheDocument();
  });

  describe("filtro de pasta (V4 F11)", () => {
    function acervoSong(id: number, filePath: string, title: string): Song {
      return { ...song(id, title), file_path: filePath };
    }

    beforeEach(() => {
      useLibraryStore.setState({
        folders: [{ id: 1, path: "/acervo", last_scanned_at: null }],
        results: [
          { song: acervoSong(1, "/acervo/1/a.mp3", "Faixa Um"), snippet: null },
          { song: acervoSong(2, "/acervo/2/b.mp3", "Faixa Dois"), snippet: null },
          { song: acervoSong(3, "/acervo/10/c.mp3", "Faixa Dez"), snippet: null },
        ],
        folderFilter: "/acervo/1",
      });
    });

    it("mostra o chip 📁 {nome} × e lista só as músicas da subárvore", () => {
      render(<LibraryView />);
      const chip = screen.getByRole("button", { name: "Remover filtro de pasta" });
      expect(chip).toHaveTextContent("📁 1");
      expect(screen.getByText("Faixa Um")).toBeInTheDocument();
      expect(screen.queryByText("Faixa Dois")).not.toBeInTheDocument();
      // "10" não é "1": prefixo de pasta exato
      expect(screen.queryByText("Faixa Dez")).not.toBeInTheDocument();
    });

    it("clicar no chip limpa o filtro", () => {
      render(<LibraryView />);
      fireEvent.click(
        screen.getByRole("button", { name: "Remover filtro de pasta" }),
      );
      expect(useLibraryStore.getState().folderFilter).toBeNull();
    });

    it("contador '{n} resultados' conta o resultado JÁ filtrado", () => {
      useLibraryStore.setState({ query: "faixa" });
      render(<LibraryView />);
      expect(screen.getByText("1 resultados")).toBeInTheDocument();
    });

    it("busca sem matches dentro do filtro mostra o empty state de busca", () => {
      useLibraryStore.setState({
        query: "dois",
        results: [
          { song: acervoSong(2, "/acervo/2/b.mp3", "Faixa Dois"), snippet: null },
        ],
      });
      render(<LibraryView />);
      expect(
        screen.getByText('Nenhuma música encontrada para "dois".'),
      ).toBeInTheDocument();
    });

    it("sem filtro não há chip", () => {
      useLibraryStore.setState({ folderFilter: null });
      render(<LibraryView />);
      expect(
        screen.queryByRole("button", { name: "Remover filtro de pasta" }),
      ).not.toBeInTheDocument();
    });
  });

  it("progresso de indexação com copy exata", () => {
    useLibraryStore.setState({
      scanning: { done: 3, total: 10 },
      results: [{ song: song(1, "Aurora"), snippet: null }],
      folders: [{ id: 1, path: "/m", last_scanned_at: null }],
    });
    render(<LibraryView />);
    expect(screen.getByText("Indexando… 3 de 10 arquivos")).toBeInTheDocument();
  });
});
