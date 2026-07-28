import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LyricsPanel } from "./LyricsPanel";
import { setBackendForTests, type Backend } from "../lib/api";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlayerStore } from "../stores/playerStore";
import { usePlaylistStore } from "../stores/playlistStore";
import { useToastStore } from "../stores/toastStore";
import type { Song } from "../lib/types";
import {
  AA_TEXTO_NORMAL,
  contrastRatio,
  corDoTexto,
  FUNDOS_DA_LINHA,
} from "../test/contrast";

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

  // ---------------------------------------------------------------------------
  // V6 — nome do arquivo no painel. É aqui que a coordenadora confere "é mesmo
  // o arquivo que eu conheço?": nome inteiro, selecionável, junto do título.
  // ---------------------------------------------------------------------------
  describe("nome do arquivo (V6)", () => {
    function comCaminho(filePath: string, title = "Coração Sertanejo"): Song {
      return { ...song(1, true), file_path: filePath, title };
    }

    function renderCom(s: Song) {
      useLibraryStore.setState({
        results: [{ song: s, snippet: null }],
        selectedSongId: 1,
      });
      render(<LyricsPanel />);
    }

    it("mostra o nome do arquivo (sem a pasta) logo abaixo de título e artista", async () => {
      renderCom(comCaminho("/acervo/capoeira/barco - Marinheiro só (Capoeira).mp3"));
      const nome = await screen.findByTestId("panel-filename");
      expect(nome).toHaveTextContent("barco - Marinheiro só (Capoeira).mp3");
      expect(nome.textContent).not.toContain("/acervo");
      // depois do título e do artista, na ordem do documento
      const titulo = screen.getByText("Coração Sertanejo");
      const artista = screen.getByText("Artista Teste");
      expect(
        artista.compareDocumentPosition(nome) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        titulo.compareDocumentPosition(nome) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    it("nome inteiro (nada de truncar) e selecionável para copiar", async () => {
      const LONGO =
        "barco - Marinheiro só (Capoeira) - gravação ao vivo no encontro de 2019.mp3";
      renderCom(comCaminho(`/acervo/${LONGO}`));
      const nome = await screen.findByTestId("panel-filename");
      expect(nome.textContent).toBe(LONGO);
      expect(nome.className).not.toContain("truncate");
      expect(nome.className).toContain("select-text");
    });

    it("caminho Windows: mostra só o nome do arquivo", async () => {
      renderCom(comCaminho("C:\\acervo\\capoeira\\barco - Marinheiro.mp3"));
      const nome = await screen.findByTestId("panel-filename");
      expect(nome.textContent).toBe("barco - Marinheiro.mp3");
    });

    it("passa em AA (4.5:1) sobre o fundo branco do painel", async () => {
      renderCom(comCaminho("/acervo/barco - Marinheiro.mp3"));
      const nome = await screen.findByTestId("panel-filename");
      const cor = corDoTexto(nome.className);
      expect(
        contrastRatio(cor, FUNDOS_DA_LINHA.branco),
        `${cor} sobre o branco do painel`,
      ).toBeGreaterThanOrEqual(AA_TEXTO_NORMAL);
      // secundário em relação ao título (18px, #111827)
      expect(contrastRatio(cor, FUNDOS_DA_LINHA.branco)).toBeLessThan(
        contrastRatio("#111827", FUNDOS_DA_LINHA.branco),
      );
    });

    it("música sem tags (título = nome do arquivo): não repete o mesmo texto", async () => {
      renderCom(comCaminho("/acervo/sem_tags.mp3", "sem_tags"));
      await screen.findByText("sem_tags");
      expect(screen.queryByTestId("panel-filename")).not.toBeInTheDocument();
    });
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

describe("LyricsPanel — modo de edição (V4 F10)", () => {
  let writeTags: ReturnType<typeof vi.fn>;
  let fetchLyricsOnline: ReturnType<typeof vi.fn>;
  let getLyrics: ReturnType<typeof vi.fn>;

  function setupEditBackend(overrides: Partial<Backend> = {}) {
    getLyrics = vi.fn(async (id: number) => (id === 1 ? LYRICS : null));
    writeTags = vi.fn(
      async (
        songId: number,
        title: string,
        artist: string | null,
        lyrics: string | null,
        temas: string | null,
      ): Promise<Song> => ({
        ...song(songId, songId === 1),
        title,
        artist,
        temas,
        has_lyrics: lyrics !== null,
      }),
    );
    fetchLyricsOnline = vi.fn(async () => ({
      lyrics: "Letra vinda da internet\nSegunda linha",
      matched_title: "Coração Sertanejo",
      matched_artist: "Artista Teste",
      confidence: "alta" as const,
    }));
    setBackendForTests({
      getLyrics,
      writeTags,
      fetchLyricsOnline,
      ...overrides,
    } as unknown as Backend);
  }

  beforeEach(() => {
    setupEditBackend();
    useToastStore.setState({ toasts: [] });
    usePlaylistStore.setState({ items: [], activePlaylistId: null });
    usePlayerStore.setState({ current: null, isPlaying: false });
    useLibraryStore.setState({
      results: [
        { song: song(1, true), snippet: null },
        { song: song(2, false), snippet: null },
      ],
      selectedSongId: 1,
    });
  });

  async function enterEditMode() {
    render(<LyricsPanel />);
    await screen.findByTestId("lyrics-body");
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
  }

  it("botão Editar entra no modo edição com os valores atuais preenchidos", async () => {
    await enterEditMode();
    expect(screen.getByLabelText("Título")).toHaveValue("Coração Sertanejo");
    expect(screen.getByLabelText("Artista")).toHaveValue("Artista Teste");
    expect(screen.getByLabelText("Letra")).toHaveValue(LYRICS);
    // temas viram chips removíveis
    expect(
      screen.getByRole("button", { name: "Remover tema água" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Remover tema esperança" }),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Adicionar tema")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Buscar letra na internet" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Salvar no arquivo" }),
    ).toBeInTheDocument();
  });

  it("Editar fica desabilitado para música indisponível", async () => {
    useLibraryStore.setState({
      results: [{ song: { ...song(1, true), available: false }, snippet: null }],
      selectedSongId: 1,
    });
    render(<LyricsPanel />);
    expect(
      await screen.findByRole("button", { name: "Editar" }),
    ).toBeDisabled();
  });

  it("Cancelar descarta as alterações e volta ao modo leitura sem salvar", async () => {
    await enterEditMode();
    fireEvent.change(screen.getByLabelText("Título"), {
      target: { value: "Alterado" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(writeTags).not.toHaveBeenCalled();
    // voltou para o modo leitura com o título original
    expect(await screen.findByTestId("lyrics-body")).toBeInTheDocument();
    expect(screen.getByText("Coração Sertanejo")).toBeInTheDocument();
    expect(screen.queryByLabelText("Título")).not.toBeInTheDocument();
  });

  it("salvar com título vazio: borda vermelha + mensagem exata, não chama o backend", async () => {
    await enterEditMode();
    const titulo = screen.getByLabelText("Título");
    fireEvent.change(titulo, { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar no arquivo" }));
    expect(writeTags).not.toHaveBeenCalled();
    expect(screen.getByText("Dê um título à música.")).toBeInTheDocument();
    expect(titulo.className).toContain("border-[#B91C1C]");
  });

  it("salvar feliz: writeTags com os dados digitados, toast exato, atualiza stores e sai da edição", async () => {
    usePlaylistStore.setState({
      activePlaylistId: 5,
      items: [{ id: 9, playlist_id: 5, position: 0, song: song(1, true) }],
    });
    await enterEditMode();
    fireEvent.change(screen.getByLabelText("Título"), {
      target: { value: "Título Novo" },
    });
    // adiciona tema com Enter
    const temaInput = screen.getByPlaceholderText("Adicionar tema");
    fireEvent.change(temaInput, { target: { value: "fé" } });
    fireEvent.keyDown(temaInput, { key: "Enter" });
    expect(
      screen.getByRole("button", { name: "Remover tema fé" }),
    ).toBeInTheDocument();
    // remove um tema existente
    fireEvent.click(screen.getByRole("button", { name: "Remover tema água" }));

    fireEvent.click(screen.getByRole("button", { name: "Salvar no arquivo" }));

    await waitFor(() => expect(writeTags).toHaveBeenCalledTimes(1));
    expect(writeTags).toHaveBeenCalledWith(
      1,
      "Título Novo",
      "Artista Teste",
      LYRICS,
      "esperança; fé",
      // V8/F17: ninguém tocou no controle de instrumental, então o editor
      // não manda nada — a marca do MP3 fica como está.
      undefined,
    );
    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({
        message: "Alterações salvas em 1.mp3.",
        kind: "success",
      }),
    ]);
    // atualiza libraryStore.results e playlistStore.items
    expect(
      useLibraryStore.getState().results.find((r) => r.song.id === 1)!.song.title,
    ).toBe("Título Novo");
    expect(usePlaylistStore.getState().items[0].song.title).toBe("Título Novo");
    // sai do modo edição e re-exibe a letra
    expect(await screen.findByTestId("lyrics-body")).toBeInTheDocument();
    expect(screen.queryByLabelText("Título")).not.toBeInTheDocument();
  });

  it("BUG v0.4: tema digitado SEM Enter é incluído ao Salvar no arquivo", async () => {
    await enterEditMode();
    const temaInput = screen.getByPlaceholderText("Adicionar tema");
    fireEvent.change(temaInput, { target: { value: "fé" } });
    // usuário clica direto em Salvar, sem confirmar com Enter
    fireEvent.click(screen.getByRole("button", { name: "Salvar no arquivo" }));

    await waitFor(() => expect(writeTags).toHaveBeenCalledTimes(1));
    expect(writeTags).toHaveBeenCalledWith(
      1,
      "Coração Sertanejo",
      "Artista Teste",
      LYRICS,
      "água; esperança; fé",
      undefined,
    );
  });

  it("BUG v0.4: tema pendente duplicado (case-insensitive) não é incluído duas vezes ao Salvar", async () => {
    await enterEditMode();
    const temaInput = screen.getByPlaceholderText("Adicionar tema");
    fireEvent.change(temaInput, { target: { value: "ÁGUA" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar no arquivo" }));

    await waitFor(() => expect(writeTags).toHaveBeenCalledTimes(1));
    expect(writeTags).toHaveBeenCalledWith(
      1,
      "Coração Sertanejo",
      "Artista Teste",
      LYRICS,
      "água; esperança",
      undefined,
    );
  });

  it("BUG v0.4: blur no input de tema adiciona o chip e limpa o input", async () => {
    await enterEditMode();
    const temaInput = screen.getByPlaceholderText("Adicionar tema");
    fireEvent.change(temaInput, { target: { value: "fé" } });
    fireEvent.blur(temaInput);
    expect(
      screen.getByRole("button", { name: "Remover tema fé" }),
    ).toBeInTheDocument();
    expect(temaInput).toHaveValue("");
  });

  it("falha ao salvar: toast de erro exato e o formulário permanece com os dados", async () => {
    writeTags.mockRejectedValueOnce(new Error("lock"));
    await enterEditMode();
    fireEvent.change(screen.getByLabelText("Título"), {
      target: { value: "Título Que Falha" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Salvar no arquivo" }));

    await waitFor(() =>
      expect(useToastStore.getState().toasts).toEqual([
        expect.objectContaining({
          message: "Não foi possível salvar em 1.mp3.",
          kind: "error",
        }),
      ]),
    );
    expect(screen.getByLabelText("Título")).toHaveValue("Título Que Falha");
  });

  it("música em edição tocando: pausa antes de gravar", async () => {
    usePlayerStore.setState({ current: song(1, true), isPlaying: true });
    await enterEditMode();
    fireEvent.click(screen.getByRole("button", { name: "Salvar no arquivo" }));
    await waitFor(() => expect(writeTags).toHaveBeenCalled());
    expect(usePlayerStore.getState().isPlaying).toBe(false);
  });

  it("outra música tocando: NÃO pausa ao salvar", async () => {
    usePlayerStore.setState({ current: song(2, false), isPlaying: true });
    await enterEditMode();
    fireEvent.click(screen.getByRole("button", { name: "Salvar no arquivo" }));
    await waitFor(() => expect(writeTags).toHaveBeenCalled());
    expect(usePlayerStore.getState().isPlaying).toBe(true);
  });

  it("buscar letra usa título/artista digitados + duração e preenche a textarea (confirmando sobrescrita)", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    await enterEditMode();
    fireEvent.change(screen.getByLabelText("Título"), {
      target: { value: "Coração Digitado" },
    });
    fireEvent.change(screen.getByLabelText("Artista"), {
      target: { value: "Artista Digitado" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Buscar letra na internet" }),
    );
    await waitFor(() =>
      expect(fetchLyricsOnline).toHaveBeenCalledWith(
        "Coração Digitado",
        "Artista Digitado",
        3,
      ),
    );
    // textarea tinha conteúdo → confirmou com a copy exata antes de sobrescrever
    expect(confirmSpy).toHaveBeenCalledWith(
      "Substituir a letra atual pelo resultado da busca?",
    );
    expect(screen.getByLabelText("Letra")).toHaveValue(
      "Letra vinda da internet\nSegunda linha",
    );
    confirmSpy.mockRestore();
  });

  it("confirmação negada mantém a letra rascunhada", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    await enterEditMode();
    fireEvent.click(
      screen.getByRole("button", { name: "Buscar letra na internet" }),
    );
    await waitFor(() => expect(fetchLyricsOnline).toHaveBeenCalled());
    expect(screen.getByLabelText("Letra")).toHaveValue(LYRICS);
    confirmSpy.mockRestore();
  });

  it("textarea vazia preenche sem pedir confirmação", async () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    useLibraryStore.setState({ selectedSongId: 2 });
    render(<LyricsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Editar" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Buscar letra na internet" }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Letra")).toHaveValue(
        "Letra vinda da internet\nSegunda linha",
      ),
    );
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("busca sem resultado: toast warning exato", async () => {
    fetchLyricsOnline.mockResolvedValueOnce(null);
    await enterEditMode();
    fireEvent.click(
      screen.getByRole("button", { name: "Buscar letra na internet" }),
    );
    await waitFor(() =>
      expect(useToastStore.getState().toasts).toEqual([
        expect.objectContaining({
          message: "Letra não encontrada para este título e artista.",
          kind: "warning",
        }),
      ]),
    );
    // letra atual não é tocada
    expect(screen.getByLabelText("Letra")).toHaveValue(LYRICS);
  });

  it("sem conexão: toast warning exato", async () => {
    fetchLyricsOnline.mockRejectedValueOnce(new Error("sem conexão"));
    await enterEditMode();
    fireEvent.click(
      screen.getByRole("button", { name: "Buscar letra na internet" }),
    );
    await waitFor(() =>
      expect(useToastStore.getState().toasts).toEqual([
        expect.objectContaining({
          message: "Sem conexão — a busca de letra precisa de internet.",
          kind: "warning",
        }),
      ]),
    );
  });

  it("loading da busca (V5 Q5): botão vira 'Buscando…' desabilitado e restaura no sucesso", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    let resolveFetch!: (v: unknown) => void;
    fetchLyricsOnline.mockImplementationOnce(
      () => new Promise((resolve) => (resolveFetch = resolve)),
    );
    await enterEditMode();
    fireEvent.click(
      screen.getByRole("button", { name: "Buscar letra na internet" }),
    );

    // promise pendente: botão desabilitado com a copy exata (ellipsis U+2026)
    const buscando = screen.getByRole("button", { name: "Buscando…" });
    expect(buscando).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Buscar letra na internet" }),
    ).not.toBeInTheDocument();

    resolveFetch({
      lyrics: "Letra vinda da internet\nSegunda linha",
      matched_title: "Coração Sertanejo",
      matched_artist: "Artista Teste",
      confidence: "alta",
    });
    const restaurado = await screen.findByRole("button", {
      name: "Buscar letra na internet",
    });
    expect(restaurado).toBeEnabled();
    confirmSpy.mockRestore();
  });

  it("loading da busca (V5 Q5): restaura também quando não acha e quando dá erro", async () => {
    fetchLyricsOnline.mockResolvedValueOnce(null);
    await enterEditMode();
    const botao = () =>
      screen.getByRole("button", { name: "Buscar letra na internet" });
    fireEvent.click(botao());
    await waitFor(() => expect(botao()).toBeEnabled());

    fetchLyricsOnline.mockRejectedValueOnce(new Error("sem conexão"));
    fireEvent.click(botao());
    await waitFor(() => expect(botao()).toBeEnabled());
    // salvar não ficou travado pelo busy da busca
    expect(screen.getByRole("button", { name: "Salvar no arquivo" })).toBeEnabled();
  });

  it("trocar a música selecionada sai do modo edição", async () => {
    await enterEditMode();
    expect(screen.getByLabelText("Título")).toBeInTheDocument();
    useLibraryStore.setState({ selectedSongId: 2 });
    await waitFor(() =>
      expect(screen.queryByLabelText("Título")).not.toBeInTheDocument(),
    );
  });
});

// ---------------------------------------------------------------------------
// V5/F14 — aviso de letra vinda de transcrição automática. A marca
// TXXX:LETRA_ORIGEM descreve a letra ATUAL (DECISIONS #54), então o aviso vale
// exatamente pelo texto que está na tela.
// ---------------------------------------------------------------------------
describe("LyricsPanel — aviso de transcrição automática (V5 F14)", () => {
  const AVISO = "Letra transcrita automaticamente do áudio — pode conter erros.";

  function transcrita(overrides: Partial<Song> = {}): Song {
    return { ...song(1, true), letra_origem: "transcricao", ...overrides };
  }

  beforeEach(() => {
    setupBackend();
    useToastStore.setState({ toasts: [] });
    usePlaylistStore.setState({ items: [], activePlaylistId: null });
    usePlayerStore.setState({ current: null, isPlaying: false });
  });

  it("letra transcrita: aviso discreto logo acima da letra", async () => {
    useLibraryStore.setState({
      results: [{ song: transcrita(), snippet: null }],
      selectedSongId: 1,
    });
    render(<LyricsPanel />);

    const body = await screen.findByTestId("lyrics-body");
    const aviso = screen.getByTestId("lyrics-origem");
    expect(aviso).toHaveTextContent(AVISO);
    // vem ANTES da letra na ordem do documento
    expect(aviso.compareDocumentPosition(body)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("letra oficial (sem marca) e música sem letra: nenhum aviso", async () => {
    useLibraryStore.setState({
      results: [
        { song: song(1, true), snippet: null },
        { song: { ...song(2, false), letra_origem: "transcricao" }, snippet: null },
      ],
      selectedSongId: 1,
    });
    render(<LyricsPanel />);
    await screen.findByTestId("lyrics-body");
    expect(screen.queryByTestId("lyrics-origem")).not.toBeInTheDocument();

    // música sem letra nenhuma: nada a ressalvar, mesmo com marca residual
    act(() => useLibraryStore.setState({ selectedSongId: 2 }));
    await screen.findByText("Esta música ainda não tem letra registrada.");
    expect(screen.queryByTestId("lyrics-origem")).not.toBeInTheDocument();
  });

  it("salvar uma letra nova derruba o aviso na hora (sem reiniciar o app)", async () => {
    const NOVA = "Letra conferida à mão\nSegunda linha";
    // o backend limpa a marca ao trocar a letra e devolve a Song reindexada
    const writeTags = vi.fn(
      async (songId: number, title: string, artist: string | null): Promise<Song> => ({
        ...transcrita({ id: songId, title, artist }),
        letra_origem: null,
      }),
    );
    setBackendForTests({
      getLyrics: vi.fn(async () => LYRICS),
      writeTags,
      fetchLyricsOnline: vi.fn(async () => null),
    } as unknown as Backend);
    useLibraryStore.setState({
      results: [{ song: transcrita(), snippet: null }],
      selectedSongId: 1,
    });

    render(<LyricsPanel />);
    await screen.findByTestId("lyrics-body");
    expect(screen.getByTestId("lyrics-origem")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    fireEvent.change(screen.getByLabelText("Letra"), { target: { value: NOVA } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar no arquivo" }));

    await waitFor(() => expect(writeTags).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByTestId("lyrics-origem")).not.toBeInTheDocument(),
    );
    expect(
      useLibraryStore.getState().results[0].song.letra_origem,
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// V8/F17 — marca de instrumental no editor do player. É a ponta manual da
// funcionalidade: "Esta música é instrumental", salva junto com o resto do
// formulário, pelo mesmo write_tags (nenhum caminho de gravação novo).
// ---------------------------------------------------------------------------
describe("LyricsPanel — marca de instrumental (V8/F17)", () => {
  const ROTULO = "Esta música é instrumental";

  /** Música sem voz já marcada no arquivo. */
  function marcada(over: Partial<Song> = {}): Song {
    return { ...song(2, false), title: "Doce Prelúdio", instrumental: true, ...over };
  }

  function montar(s: Song, writeTags: ReturnType<typeof vi.fn>) {
    setBackendForTests({
      getLyrics: vi.fn(async () => (s.has_lyrics ? LYRICS : null)),
      writeTags,
      fetchLyricsOnline: vi.fn(async () => null),
    } as unknown as Backend);
    useLibraryStore.setState({
      results: [{ song: s, snippet: null }],
      selectedSongId: s.id,
    });
    render(<LyricsPanel />);
  }

  /** writeTags que devolve a Song com a marca que recebeu (como o backend). */
  function fakeWriteTags(base: Song) {
    return vi.fn(
      async (
        songId: number,
        title: string,
        artist: string | null,
        lyrics: string | null,
        temas: string | null,
        instrumental?: boolean | null,
      ): Promise<Song> => ({
        ...base,
        id: songId,
        title,
        artist,
        temas,
        has_lyrics: lyrics !== null,
        instrumental: instrumental === true,
      }),
    );
  }

  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
    usePlaylistStore.setState({ items: [], activePlaylistId: null });
    usePlayerStore.setState({ current: null, isPlaying: false });
  });

  it("o controle nasce marcado quando a música já é instrumental", async () => {
    montar(marcada(), fakeWriteTags(marcada()));
    fireEvent.click(await screen.findByRole("button", { name: "Editar" }));
    expect(screen.getByRole("checkbox", { name: ROTULO })).toBeChecked();
  });

  it("marcar à mão: salva pelo write_tags e a Song devolvida volta marcada", async () => {
    const base = song(2, false);
    const writeTags = fakeWriteTags(base);
    montar(base, writeTags);
    fireEvent.click(await screen.findByRole("button", { name: "Editar" }));

    const controle = screen.getByRole("checkbox", { name: ROTULO });
    expect(controle).not.toBeChecked();
    fireEvent.click(controle);
    fireEvent.click(screen.getByRole("button", { name: "Salvar no arquivo" }));

    await waitFor(() => expect(writeTags).toHaveBeenCalledTimes(1));
    expect(writeTags.mock.calls[0][5]).toBe(true);
    // a Song reindexada volta para os stores: o selo da lista muda no ato
    expect(
      useLibraryStore.getState().results[0].song.instrumental,
    ).toBe(true);
  });

  it("desmarcar à mão manda false — o editor é o único que desfaz a marca", async () => {
    const base = marcada();
    const writeTags = fakeWriteTags(base);
    montar(base, writeTags);
    fireEvent.click(await screen.findByRole("button", { name: "Editar" }));

    fireEvent.click(screen.getByRole("checkbox", { name: ROTULO }));
    fireEvent.click(screen.getByRole("button", { name: "Salvar no arquivo" }));

    await waitFor(() => expect(writeTags).toHaveBeenCalledTimes(1));
    expect(writeTags.mock.calls[0][5]).toBe(false);
    expect(
      useLibraryStore.getState().results[0].song.instrumental,
    ).toBe(false);
  });

  // O motivo do três-estados existir: a View do banco pode estar ATRASADA em
  // relação ao MP3 (a curadoria marcou o arquivo com o app aberto, ou antes
  // da varredura de inicialização). Aí o controle nasce desmarcado sem que
  // ninguém tenha desmarcado nada, e salvar uma correção de título apagaria
  // do MP3 uma marca feita à mão — "marcada à mão, nenhuma rotina desmarca
  // sozinha" (PRD V8/F17).
  it("salvar sem tocar no controle não manda instrumental — nem true, nem false", async () => {
    const base = song(2, false);
    const writeTags = fakeWriteTags(base);
    montar(base, writeTags);
    fireEvent.click(await screen.findByRole("button", { name: "Editar" }));

    fireEvent.change(screen.getByLabelText("Título"), {
      target: { value: "Doce Prelúdio" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Salvar no arquivo" }));

    await waitFor(() => expect(writeTags).toHaveBeenCalledTimes(1));
    expect(writeTags.mock.calls[0][5]).toBeUndefined();
  });

  it("música já marcada, salva sem tocar no controle: também não manda nada", async () => {
    const base = marcada();
    const writeTags = fakeWriteTags(base);
    montar(base, writeTags);
    fireEvent.click(await screen.findByRole("button", { name: "Editar" }));
    fireEvent.click(screen.getByRole("button", { name: "Salvar no arquivo" }));

    await waitFor(() => expect(writeTags).toHaveBeenCalledTimes(1));
    expect(writeTags.mock.calls[0][5]).toBeUndefined();
  });

  it("marcar e desmarcar de volta manda o valor explícito, não 'não mexer'", async () => {
    const base = song(2, false);
    const writeTags = fakeWriteTags(base);
    montar(base, writeTags);
    fireEvent.click(await screen.findByRole("button", { name: "Editar" }));

    const controle = screen.getByRole("checkbox", { name: ROTULO });
    fireEvent.click(controle); // marca
    fireEvent.click(controle); // e desmarca — decisão humana, vale false
    fireEvent.click(screen.getByRole("button", { name: "Salvar no arquivo" }));

    await waitFor(() => expect(writeTags).toHaveBeenCalledTimes(1));
    expect(writeTags.mock.calls[0][5]).toBe(false);
  });

  it("instrumental COM letra registrada continua exibindo a letra normalmente", async () => {
    const comLetra = marcada({ id: 1, has_lyrics: true });
    montar(comLetra, fakeWriteTags(comLetra));
    const body = await screen.findByTestId("lyrics-body");
    expect(body.textContent).toBe(LYRICS);
  });

  it("instrumental sem letra: informação, não cobrança de curadoria", async () => {
    montar(marcada(), fakeWriteTags(marcada()));
    expect(await screen.findByText("Música instrumental — sem letra.")).toBeInTheDocument();
    expect(
      screen.queryByText("Esta música ainda não tem letra registrada."),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        "Use a ferramenta de curadoria para adicionar a letra ao arquivo.",
      ),
    ).not.toBeInTheDocument();
  });
});
