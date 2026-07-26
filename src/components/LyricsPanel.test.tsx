import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LyricsPanel } from "./LyricsPanel";
import { setBackendForTests, type Backend } from "../lib/api";
import { useLibraryStore } from "../stores/libraryStore";
import type { Song } from "../lib/types";

const LYRICS = "Quando o sol amanhecer\nMeu coração vai cantar\n\nNão há noite sem estrela";

function song(id: number, hasLyrics: boolean): Song {
  return {
    id,
    file_path: `/m/${id}.mp3`,
    folder_id: 1,
    title: hasLyrics ? "Coração Sertanejo" : "Instrumental",
    artist: "Artista Teste",
    album: null,
    duration_seconds: 3,
    has_lyrics: hasLyrics,
    available: true,
    temas: hasLyrics ? "água; esperança" : null,
  };
}

function setupBackend() {
  setBackendForTests({
    getLyrics: vi.fn(async (id: number) => (id === 1 ? LYRICS : null)),
  } as unknown as Backend);
}

describe("LyricsPanel (F3)", () => {
  beforeEach(() => {
    setupBackend();
    useLibraryStore.setState({
      results: [
        { song: song(1, true), snippet: null },
        { song: song(2, false), snippet: null },
      ],
      selectedSongId: null,
    });
  });

  it("sem seleção: mostra a mensagem exata do PRD", () => {
    render(<LyricsPanel />);
    expect(
      screen.getByText("Selecione uma música para ver a letra."),
    ).toBeInTheDocument();
  });

  it("música com letra: exibe a letra integral preservando quebras de linha", async () => {
    useLibraryStore.setState({ selectedSongId: 1 });
    render(<LyricsPanel />);
    const body = await screen.findByTestId("lyrics-body");
    expect(body.textContent).toBe(LYRICS);
    // quebras preservadas via white-space: pre-wrap
    expect(body).toHaveClass("whitespace-pre-wrap");
    // cabeçalho com título e artista
    expect(screen.getByText("Coração Sertanejo")).toBeInTheDocument();
    expect(screen.getByText("Artista Teste")).toBeInTheDocument();
  });

  it("temas aparecem como chips no cabeçalho e o clique busca pelo tema (V2)", async () => {
    useLibraryStore.setState({ selectedSongId: 1 });
    render(<LyricsPanel />);
    await screen.findByTestId("lyrics-body");
    const chip = screen.getByRole("button", { name: "Tema: esperança" });
    expect(chip).toHaveTextContent("esperança");

    fireEvent.click(chip);
    expect(useLibraryStore.getState().query).toBe("esperança");
  });

  it("música sem letra: mensagens exatas do PRD", async () => {
    useLibraryStore.setState({ selectedSongId: 2 });
    render(<LyricsPanel />);
    expect(
      await screen.findByText("Esta música ainda não tem letra registrada."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Use a ferramenta de curadoria para adicionar a letra ao arquivo.",
      ),
    ).toBeInTheDocument();
  });
});
