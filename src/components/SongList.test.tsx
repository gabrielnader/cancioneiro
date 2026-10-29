import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SongList } from "./SongList";
import { LyricsPanel } from "./LyricsPanel";
import { setBackendForTests, type Backend } from "../lib/api";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlayerStore } from "../stores/playerStore";
import { usePlaylistStore } from "../stores/playlistStore";
import type { SearchResult, Song } from "../lib/types";
import {
  AA_TEXTO_NORMAL,
  contrastRatio,
  corDoTexto,
  FUNDOS_DA_LINHA,
} from "../test/contrast";

// Virtualização depende de medidas reais de layout — inexistentes no jsdom.
// O mock empilha os itens usando estimateSize(index), como o virtualizer real:
// a altura da linha varia (snippet, nome do arquivo).
//
// E reproduz a MEMOIZAÇÃO do @tanstack/virtual-core 3.17.6: getMeasurements()
// só recalcula quando as dependências de getMeasurementOptions() mudam de
// identidade — [count, getItemKey, ...] — e `estimateSize` NÃO está entre elas.
// Sem isso o mock nunca falharia no defeito real: lista nova, mesma contagem,
// alturas da lista ANTERIOR.
vi.mock("@tanstack/react-virtual", async () => {
  const { useRef } = await import("react");
  interface Opts {
    count: number;
    estimateSize: (index: number) => number;
    getItemKey?: (index: number) => string | number;
  }
  interface Item {
    index: number;
    key: string | number;
    start: number;
    size: number;
  }
  return {
    useVirtualizer: (opts: Opts) => {
      const memo = useRef<{ deps: unknown[]; items: Item[] } | null>(null);
      const deps: unknown[] = [opts.count, opts.getItemKey];
      const stale =
        memo.current !== null && memo.current.deps.every((d, i) => d === deps[i]);
      if (!stale) {
        let start = 0;
        const items = Array.from({ length: opts.count }, (_, index) => {
          const size = opts.estimateSize(index);
          const item: Item = {
            index,
            key: opts.getItemKey ? opts.getItemKey(index) : index,
            start,
            size,
          };
          start += size;
          return item;
        });
        memo.current = { deps, items };
      }
      const items = memo.current!.items;
      return {
        getTotalSize: () => items.reduce((a, b) => a + b.size, 0),
        getVirtualItems: () => items,
        measureElement: () => {},
      };
    },
  };
});

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
      folderFilter: null,
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

  // Uso real: com título curto, o chip caía quase em cima de onde a pessoa
  // clica para selecionar — e clique errado no chip TROCA a busca inteira.
  // Chips e o botão de lista vivem no mesmo grupo à direita, separados do
  // bloco de texto (V15: a coluna de texto fica entre o botão de tocar e eles).
  it("chips ficam no grupo de ações à direita, longe do título e do artista", () => {
    // o botão de lista só existe havendo playlist, e ele é a outra metade do grupo
    usePlaylistStore.setState({
      playlists: [{ id: 1, name: "Culto", song_count: 0 }],
    });
    render(<SongList />);
    const chip = screen.getByRole("button", { name: "Tema: água" });
    const linha = chip.closest('[role="option"]')!;
    const lista = linha.querySelector('[data-testid="por-na-lista"]')!;
    // o menor ancestral comum do chip e do botão de lista é o grupo de ações
    let acoes: Element = chip.parentElement!;
    while (!acoes.contains(lista)) acoes = acoes.parentElement!;
    expect(acoes).not.toBe(linha);
    // e o título/artista ficam FORA dele
    expect(acoes.textContent).not.toContain("Rio Divino");
    expect(acoes.textContent).not.toContain("Alguém");
  });

  it("música sem temas não exibe chips", () => {
    render(<SongList />);
    const row = screen.getByText("Aurora").closest('[role="option"]')!;
    expect(row.querySelectorAll('[data-testid="tema-chip"]')).toHaveLength(0);
  });

  describe("ordem da linha (V15): tocar → título e selo → artista → temas → lista no fim", () => {
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

    it("o selo 'Sem letra' acompanha o título, e o artista vem na linha de baixo", () => {
      render(<SongList />);
      const row = screen.getByText("Brisa").closest('[role="option"]')!;
      const title = screen.getByText("Brisa");
      const artist = Array.from(row.querySelectorAll("p")).find(
        (el) => el.textContent === "Alguém",
      )!;
      const badge = Array.from(row.querySelectorAll("span")).find(
        (el) => el.textContent === "Sem letra",
      )!;
      // o botão de tocar vem antes de tudo: é a primeira coisa que a mão acha
      const tocar = screen.getByRole("button", { name: "Tocar Brisa" });
      expect(before(tocar, title)).toBe(true);
      expect(before(title, badge)).toBe(true);
      expect(before(badge, artist)).toBe(true);
      expect(title.parentElement!.contains(badge)).toBe(true);
    });

    it("artista antes dos chips de tema; o botão de lista é o último elemento da linha", () => {
      render(<SongList />);
      const row = screen.getByText("Rio Divino").closest('[role="option"]')!;
      const artist = Array.from(row.querySelectorAll("p")).find(
        (el) => el.textContent === "Alguém",
      )!;
      const chip = screen.getByRole("button", { name: "Tema: água" });
      const plus = row.querySelector('[data-testid="por-na-lista"]')!;
      expect(before(artist, chip)).toBe(true);
      expect(before(chip, plus)).toBe(true);
    });

    it("artista mantém truncate para não estourar a linha", () => {
      render(<SongList />);
      const row = screen.getByText("Aurora").closest('[role="option"]')!;
      const artist = Array.from(row.querySelectorAll("p")).find(
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
      expect(titulo.className).toContain("text-[17px]");
      expect(nome.className).toContain("text-[14px]");
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

    it("a linha do nome não engole badge/chips/lista: o selo fica com o título, e as ações à direita", () => {
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
      const selo = Array.from(row.querySelectorAll("span")).find(
        (e) => e.textContent === "Sem letra",
      )!;
      expect(linhaDoTitulo.contains(selo)).toBe(true);
      for (const el of [
        selo,
        screen.getByRole("button", { name: "Tema: capoeira" }),
        row.querySelector('[data-testid="por-na-lista"]')!,
      ]) {
        expect(nome.contains(el)).toBe(false);
      }
    });

    it("o nome do arquivo passa em AA (4.5:1) no fundo branco, no selecionado e no hover", () => {
      useLibraryStore.setState({
        results: [comArquivo(10, "Marinheiro só", "/acervo/barco.mp3")],
      });
      render(<SongList />);
      const nome = screen
        .getByText("Marinheiro só")
        .closest('[role="option"]')!
        .querySelector('[data-testid="song-filename"]')!;
      const cor = corDoTexto(nome.className);
      for (const [fundoNome, fundo] of Object.entries(FUNDOS_DA_LINHA)) {
        expect(
          contrastRatio(cor, fundo),
          `${cor} sobre ${fundoNome} (${fundo})`,
        ).toBeGreaterThanOrEqual(AA_TEXTO_NORMAL);
      }
      // ...e continua secundário: o olho tem de cair primeiro no título.
      expect(contrastRatio(cor, FUNDOS_DA_LINHA.branco)).toBeLessThan(
        contrastRatio("#111827", FUNDOS_DA_LINHA.branco),
      );
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

  // ---------------------------------------------------------------------------
  // Alturas da virtualização quando a LISTA TROCA mantendo a contagem.
  // O virtual-core memoiza as medidas em [count, getItemKey, ...] e ignora
  // `estimateSize`: sem uma chave que acompanhe a música, a lista nova é
  // desenhada com as alturas da lista anterior (linhas sobrepostas).
  // ---------------------------------------------------------------------------
  describe("alturas ao trocar a lista mantendo a mesma contagem", () => {
    /** Alturas dos invólucros posicionados pela virtualização. */
    function alturas(): string[] {
      return screen
        .getAllByRole("option")
        .map((o) => o.parentElement!.style.height);
    }

    /** Deslocamentos verticais (translateY) dos invólucros. */
    function deslocamentos(): string[] {
      return screen
        .getAllByRole("option")
        .map((o) => o.parentElement!.style.transform);
    }

    function comCaminho(id: number, title: string, filePath: string): SearchResult {
      return { song: { ...song(id, title), file_path: filePath }, snippet: null };
    }

    // V15 — padding 20 + borda 1 + a coluna de texto (título 24, artista 24,
    // nome do arquivo 20), nunca menos que o botão de tocar (48).
    // /a: título = nome do arquivo → sem linha do nome: 20 + 48 + 1 = 69px.
    // /b: nome do arquivo diferente do título → 20 + 68 + 1 = 89px.
    const PASTA_A = [
      comCaminho(1, "um", "/a/um.mp3"),
      comCaminho(2, "dois", "/a/dois.mp3"),
    ];
    const PASTA_B = [
      comCaminho(3, "Marinheiro só", "/b/barco - Marinheiro.mp3"),
      comCaminho(4, "Aurora", "/b/canto - Aurora.mp3"),
    ];

    it("trocar o filtro entre duas pastas com a MESMA quantidade remede as linhas", () => {
      useLibraryStore.setState({
        results: [...PASTA_A, ...PASTA_B],
        folderFilter: "/a",
      });
      render(<SongList />);
      expect(alturas()).toEqual(["69px", "69px"]);

      act(() => {
        useLibraryStore.setState({ folderFilter: "/b" });
      });
      expect(screen.getByText("Marinheiro só")).toBeInTheDocument();
      expect(alturas()).toEqual(["89px", "89px"]);
      expect(deslocamentos()).toEqual([
        "translateY(0px)",
        "translateY(89px)",
      ]);
    });

    it("repopular os resultados com a mesma contagem (ex.: salvar um título) remede as linhas", () => {
      useLibraryStore.setState({ results: PASTA_B, folderFilter: null });
      render(<SongList />);
      expect(alturas()).toEqual(["89px", "89px"]);

      // título passa a ser o próprio nome do arquivo → a segunda linha some
      act(() => {
        useLibraryStore.setState({
          results: [
            comCaminho(3, "barco - Marinheiro", "/b/barco - Marinheiro.mp3"),
            comCaminho(4, "canto - Aurora", "/b/canto - Aurora.mp3"),
          ],
        });
      });
      expect(screen.getByText("barco - Marinheiro")).toBeInTheDocument();
      expect(alturas()).toEqual(["69px", "69px"]);
      expect(deslocamentos()).toEqual([
        "translateY(0px)",
        "translateY(69px)",
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // V8/F17 — marca de instrumental. Uma música sem voz não é pendência: no
  // lugar do selo cinza "Sem letra" (cobrança que a varredura de letra vai
  // repetir para sempre) a linha diz "Instrumental" — informação.
  // -------------------------------------------------------------------------
  describe("selo de instrumental (V8/F17)", () => {
    function instrumental(id: number, title: string, hasLyrics = false): SearchResult {
      return {
        song: { ...song(id, title, hasLyrics), instrumental: true },
        snippet: null,
      };
    }

    /** O selo (span) com o texto exato, dentro da linha da música. */
    function selo(title: string, texto: string): HTMLElement | undefined {
      const row = screen.getByText(title).closest('[role="option"]')!;
      return Array.from(row.querySelectorAll("span")).find(
        (el) => el.textContent === texto,
      );
    }

    it("música instrumental mostra 'Instrumental' NO LUGAR de 'Sem letra'", () => {
      useLibraryStore.setState({
        results: [instrumental(10, "Doce Prelúdio")],
      });
      render(<SongList />);
      expect(selo("Doce Prelúdio", "Instrumental")).toBeDefined();
      expect(screen.queryByText("Sem letra")).not.toBeInTheDocument();
    });

    it("música comum sem letra continua com o selo 'Sem letra'", () => {
      render(<SongList />); // fixture "Brisa" é sem letra e não instrumental
      expect(screen.getAllByText("Sem letra")).toHaveLength(1);
      expect(screen.queryByText("Instrumental")).not.toBeInTheDocument();
    });

    it("instrumental COM letra registrada mostra o selo e nenhuma pendência", () => {
      useLibraryStore.setState({
        results: [instrumental(11, "Passeio pelo Jardim", true)],
      });
      render(<SongList />);
      expect(selo("Passeio pelo Jardim", "Instrumental")).toBeDefined();
      expect(screen.queryByText("Sem letra")).not.toBeInTheDocument();
    });

    it("é informação, não pendência: não usa o chip cinza preenchido do 'Sem letra'", () => {
      useLibraryStore.setState({
        results: [instrumental(10, "Doce Prelúdio"), { song: song(2, "Brisa", false), snippet: null }],
      });
      render(<SongList />);
      const info = selo("Doce Prelúdio", "Instrumental")!;
      const pendencia = selo("Brisa", "Sem letra")!;
      expect(pendencia.className).toContain("bg-surface-hover");
      expect(info.className).not.toContain("bg-surface-hover");
    });

    it("o selo passa em AA (4.5:1) no fundo branco, no selecionado e no hover", () => {
      useLibraryStore.setState({
        results: [instrumental(10, "Doce Prelúdio")],
      });
      render(<SongList />);
      const cor = corDoTexto(selo("Doce Prelúdio", "Instrumental")!.className);
      for (const [fundoNome, fundo] of Object.entries(FUNDOS_DA_LINHA)) {
        expect(
          contrastRatio(cor, fundo),
          `${cor} sobre ${fundoNome} (${fundo})`,
        ).toBeGreaterThanOrEqual(AA_TEXTO_NORMAL);
      }
    });
  });

  // -------------------------------------------------------------------------
  // V8/F17 — marcar no editor tem de mudar o selo na lista NA HORA: quem
  // acabou de dizer "isto é instrumental" não pode precisar reiniciar o app
  // para ver a pendência sumir.
  // -------------------------------------------------------------------------
  it("marcar 'Esta música é instrumental' no editor troca o selo da linha sem recarregar", async () => {
    const writeTags = vi.fn(
      async (
        songId: number,
        title: string,
        _artist: string | null,
        lyrics: string | null,
        _temas: string | null,
        instrumental?: boolean | null,
      ): Promise<Song> => ({
        ...song(songId, title, lyrics !== null),
        instrumental: instrumental === true,
      }),
    );
    setBackendForTests({
      getLyrics: vi.fn(async () => null),
      writeTags,
    } as unknown as Backend);
    useLibraryStore.setState({
      results: [{ song: song(20, "Doce Prelúdio", false), snippet: null }],
      selectedSongId: 20,
    });

    render(
      <>
        <SongList />
        <LyricsPanel />
      </>,
    );
    // antes: a música é uma pendência de letra
    expect(screen.getByText("Sem letra")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Esta música é instrumental" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Salvar no arquivo" }));

    await waitFor(() => expect(writeTags).toHaveBeenCalledTimes(1));
    expect(writeTags.mock.calls[0][5]).toBe(true);
    // o selo da linha troca na hora, sem reiniciar
    expect(await screen.findByText("Instrumental")).toBeInTheDocument();
    expect(screen.queryByText("Sem letra")).not.toBeInTheDocument();
  });

  it("lista tem papel de listbox com aria-selected no item selecionado", () => {
    useLibraryStore.setState({ selectedSongId: 2 });
    render(<SongList />);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    const options = screen.getAllByRole("option");
    expect(options[1]).toHaveAttribute("aria-selected", "true");
  });
});
