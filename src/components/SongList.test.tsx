import { render, screen, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SongList } from "./SongList";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlayerStore } from "../stores/playerStore";
import { usePlaylistStore } from "../stores/playlistStore";
import type { SearchResult, Song } from "../lib/types";

// Virtualização depende de medidas reais de layout — inexistentes no jsdom.
// O mock empilha os itens usando estimateSize(index), como o virtualizer real:
// a altura da linha varia (snippet, nome do arquivo).
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (opts: { count: number; estimateSize: (index: number) => number }) => {
    const sizes = () =>
      Array.from({ length: opts.count }, (_, index) => opts.estimateSize(index));
    return {
      getTotalSize: () => sizes().reduce((a, b) => a + b, 0),
      getVirtualItems: () => {
        let start = 0;
        return sizes().map((size, index) => {
          const item = { index, key: index, start, size };
          start += size;
          return item;
        });
      },
      measureElement: () => {},
    };
  },
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

  describe("ordem da linha (V5 Q3): título → artista → badge/temas → '+' no fim", () => {
    /** a aparece antes de b no DOM? */
    function before(a: Element, b: Element): boolean {
      return Boolean(
        a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
    }

    beforeEach(() => {
      usePlaylistStore.setState({
        playlists: [{ id: 1, name: "Culto", song_count: 0 }],
      });
    });

    it("artista vem logo após o título, antes do badge 'Sem letra'", () => {
      render(<SongList />);
      const row = screen.getByText("Brisa").closest('[role="option"]')!;
      const title = screen.getByText("Brisa");
      const artist = row.querySelector("span.text-\\[13px\\]")!;
      expect(artist).toHaveTextContent("Alguém");
      const badge = Array.from(row.querySelectorAll("span")).find(
        (el) => el.textContent === "Sem letra",
      )!;
      expect(before(title, artist)).toBe(true);
      expect(before(artist, badge)).toBe(true);
    });

    it("artista antes dos chips de tema; botão '+' é o último elemento da linha", () => {
      render(<SongList />);
      const row = screen.getByText("Rio Divino").closest('[role="option"]')!;
      const artist = Array.from(row.querySelectorAll("span")).find(
        (el) => el.textContent === "Alguém",
      )!;
      const chip = screen.getByRole("button", { name: "Tema: água" });
      const plus = row.querySelector('[aria-label="Adicionar à playlist"]')!;
      expect(before(artist, chip)).toBe(true);
      expect(before(chip, plus)).toBe(true);
    });

    it("artista mantém truncate para não estourar a linha", () => {
      render(<SongList />);
      const row = screen.getByText("Aurora").closest('[role="option"]')!;
      const artist = Array.from(row.querySelectorAll("span")).find(
        (el) => el.textContent === "Alguém",
      )!;
      expect(artist.className).toContain("truncate");
    });
  });

  // -------------------------------------------------------------------------
  // V6 — nome do arquivo na linha. As coordenadoras se organizam por nome de
  // arquivo há anos: ele entra como SEGUNDA linha (soma, não troca), abaixo do
  // título/artista, em corpo menor e cinza.
  // -------------------------------------------------------------------------
  describe("nome do arquivo na linha (V6)", () => {
    const LONGO =
      "barco - Marinheiro só (Capoeira) - gravação ao vivo no encontro de 2019.mp3";

    function comArquivo(id: number, title: string, filePath: string): SearchResult {
      return { song: { ...song(id, title), file_path: filePath }, snippet: null };
    }

    it("linha mostra o nome do arquivo além do título e do artista", () => {
      useLibraryStore.setState({
        results: [
          comArquivo(10, "Marinheiro só", "/acervo/capoeira/barco - Marinheiro só.mp3"),
        ],
      });
      render(<SongList />);
      const row = screen.getByText("Marinheiro só").closest('[role="option"]')!;
      const nome = row.querySelector('[data-testid="song-filename"]')!;
      expect(nome).toHaveTextContent("barco - Marinheiro só.mp3");
      // só o nome do arquivo, sem a pasta (a pasta já está na árvore lateral)
      expect(nome.textContent).not.toContain("/acervo");
    });

    it("o título continua vindo antes e em corpo maior que o nome do arquivo", () => {
      useLibraryStore.setState({
        results: [comArquivo(10, "Marinheiro só", "/acervo/barco.mp3")],
      });
      render(<SongList />);
      const row = screen.getByText("Marinheiro só").closest('[role="option"]')!;
      const titulo = screen.getByText("Marinheiro só");
      const nome = row.querySelector('[data-testid="song-filename"]')!;
      expect(
        titulo.compareDocumentPosition(nome) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(titulo.className).toContain("text-[15px]");
      expect(nome.className).toContain("text-[12px]");
    });

    it("nome longo trunca com reticências e expõe o nome inteiro no title", () => {
      useLibraryStore.setState({
        results: [comArquivo(10, "Marinheiro só", `/acervo/${LONGO}`)],
      });
      render(<SongList />);
      const nome = screen
        .getByText("Marinheiro só")
        .closest('[role="option"]')!
        .querySelector('[data-testid="song-filename"]')!;
      expect(nome.className).toContain("truncate");
      expect(nome).toHaveAttribute("title", LONGO);
    });

    it("caminho Windows: mostra só o nome do arquivo", () => {
      useLibraryStore.setState({
        results: [
          comArquivo(10, "Marinheiro só", "C:\\acervo\\capoeira\\barco - Marinheiro.mp3"),
        ],
      });
      render(<SongList />);
      const nome = screen
        .getByText("Marinheiro só")
        .closest('[role="option"]')!
        .querySelector('[data-testid="song-filename"]')!;
      expect(nome).toHaveTextContent("barco - Marinheiro.mp3");
      expect(nome.textContent).not.toContain("acervo");
    });

    it("música sem tags (título = nome do arquivo): não repete o mesmo texto", () => {
      useLibraryStore.setState({
        results: [comArquivo(10, "sem_tags", "/acervo/sem_tags.mp3")],
      });
      render(<SongList />);
      const row = screen.getByText("sem_tags").closest('[role="option"]')!;
      expect(row.querySelector('[data-testid="song-filename"]')).toBeNull();
    });

    it("a linha do nome não empurra badge/chips/'+' para fora: eles seguem na linha do título", () => {
      usePlaylistStore.setState({
        playlists: [{ id: 1, name: "Culto", song_count: 0 }],
      });
      useLibraryStore.setState({
        results: [
          {
            song: {
              ...song(10, "Marinheiro só", false),
              file_path: `/acervo/${LONGO}`,
              temas: "capoeira",
            },
            snippet: null,
          },
        ],
        selectedSongId: 10,
      });
      render(<SongList />);
      const row = screen.getByText("Marinheiro só").closest('[role="option"]')!;
      const linhaDoTitulo = screen.getByText("Marinheiro só").parentElement!;
      const nome = row.querySelector('[data-testid="song-filename"]')!;
      for (const el of [
        Array.from(row.querySelectorAll("span")).find(
          (e) => e.textContent === "Sem letra",
        )!,
        screen.getByRole("button", { name: "Tema: capoeira" }),
        row.querySelector('[aria-label="Adicionar à playlist"]')!,
      ]) {
        expect(linhaDoTitulo.contains(el)).toBe(true);
        expect(nome.contains(el)).toBe(false);
      }
    });

    it("a altura virtualizada acompanha a linha extra do nome do arquivo", () => {
      useLibraryStore.setState({
        results: [
          comArquivo(10, "Marinheiro só", "/acervo/barco.mp3"),
          // sem tags: sem linha extra
          comArquivo(11, "sem_tags", "/acervo/sem_tags.mp3"),
        ],
      });
      render(<SongList />);
      const [comNome, semNome] = screen
        .getAllByRole("option")
        .map((o) => o.parentElement!.style.height);
      expect(parseInt(semNome, 10)).toBeGreaterThan(0);
      expect(parseInt(comNome, 10)).toBeGreaterThan(parseInt(semNome, 10));
    });
  });

  it("lista tem papel de listbox com aria-selected no item selecionado", () => {
    useLibraryStore.setState({ selectedSongId: 2 });
    render(<SongList />);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    const options = screen.getAllByRole("option");
    expect(options[1]).toHaveAttribute("aria-selected", "true");
  });
});
