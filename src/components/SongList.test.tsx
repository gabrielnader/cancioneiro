import { render, screen, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SongList } from "./SongList";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlayerStore } from "../stores/playerStore";
import type { SearchResult, Song } from "../lib/types";

// Virtualização depende de medidas reais de layout — inexistentes no jsdom.
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

function song(id: number, title: string, hasLyrics = true): Song {
  return {
    id,
    file_path: `/m/${title}.mp3`,
    folder_id: 1,
    title,
    artist: "Alguém",
    album: null,
    duration_seconds: 3,
    has_lyrics: hasLyrics,
    available: true,
  };
}

function results(): SearchResult[] {
  return [
    { song: song(1, "Aurora"), snippet: null },
    { song: song(2, "Brisa", false), snippet: null },
    {
      song: song(3, "Coração"),
      snippet: "meu coração vai cantar",
    },
    { song: { ...song(4, "Rio Divino"), temas: "água; cura" }, snippet: null },
  ];
}

describe("SongList (F1 UI / F2 / F3)", () => {
  beforeEach(() => {
    useLibraryStore.setState({
      results: results(),
      selectedSongId: null,
      query: "",
    });
    usePlayerStore.setState({ current: null, isPlaying: false });
  });

  it("clique único seleciona e NÃO inicia reprodução", () => {
    render(<SongList />);
    fireEvent.click(screen.getByText("Aurora"));
    expect(useLibraryStore.getState().selectedSongId).toBe(1);
    expect(usePlayerStore.getState().current).toBeNull();
    expect(usePlayerStore.getState().isPlaying).toBe(false);
  });

  it("duplo-clique dispara reprodução da música clicada", () => {
    render(<SongList />);
    fireEvent.doubleClick(screen.getByText("Aurora"));
    expect(usePlayerStore.getState().current?.id).toBe(1);
  });

  it("badge 'Sem letra' aparece apenas em músicas sem letra", () => {
    render(<SongList />);
    const badges = screen.getAllByText("Sem letra");
    expect(badges).toHaveLength(1);
  });

  it("snippet com termo destacado é renderizado com <mark>", () => {
    render(<SongList />);
    const mark = screen.getByText("coração");
    expect(mark.tagName).toBe("MARK");
  });

  it("chips de tema aparecem na linha e o clique busca pelo tema sem selecionar a música (V2)", () => {
    render(<SongList />);
    const chip = screen.getByRole("button", { name: "Tema: água" });
    expect(chip).toHaveTextContent("água");
    expect(screen.getByRole("button", { name: "Tema: cura" })).toBeInTheDocument();

    fireEvent.click(chip);
    expect(useLibraryStore.getState().query).toBe("água");
    // clique no chip não seleciona nem toca a música
    expect(useLibraryStore.getState().selectedSongId).toBeNull();
    expect(usePlayerStore.getState().current).toBeNull();
  });

  it("música sem temas não exibe chips", () => {
    render(<SongList />);
    const row = screen.getByText("Aurora").closest('[role="option"]')!;
    expect(row.querySelectorAll('[data-testid="tema-chip"]')).toHaveLength(0);
  });

  it("lista tem papel de listbox com aria-selected no item selecionado", () => {
    useLibraryStore.setState({ selectedSongId: 2 });
    render(<SongList />);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    const options = screen.getAllByRole("option");
    expect(options[1]).toHaveAttribute("aria-selected", "true");
  });
});
