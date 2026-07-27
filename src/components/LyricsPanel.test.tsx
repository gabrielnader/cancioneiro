import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LyricsPanel } from "./LyricsPanel";
import { setBackendForTests, type Backend } from "../lib/api";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlayerStore } from "../stores/playerStore";
import { usePlaylistStore } from "../stores/playlistStore";
import { useToastStore } from "../stores/toastStore";
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
