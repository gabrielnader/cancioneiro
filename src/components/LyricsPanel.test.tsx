import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LyricsPanel } from "./LyricsPanel";
import { setBackendForTests, type Backend } from "../lib/api";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlayerStore } from "../stores/playerStore";
import { usePlaylistStore } from "../stores/playlistStore";
import { useToastStore } from "../stores/toastStore";
import {
  SEM_RESULTADO_INDIVIDUAL,
  SEM_RESULTADO_INSTRUMENTAL,
} from "../lib/curadoria";
import { useEnrichStore } from "../stores/enrichStore";
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
  let enrichSongScan: ReturnType<typeof vi.fn>;
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
        _instrumental?: boolean | null,
        letraOrigem?: string | null,
      ): Promise<Song> => ({
        ...song(songId, songId === 1),
        title,
        artist,
        temas,
        has_lyrics: lyrics !== null,
        letra_origem: letraOrigem ?? null,
      }),
    );
    enrichSongScan = vi.fn(async () => ({
      song_id: 1,
      file_path: "/acervo/1.mp3",
      current_title: "Coração Sertanejo",
      current_artist: "Artista Teste",
      proposed_title: "Coração Sertanejo",
      proposed_artist: "Artista Teste",
      lyrics: "Letra vinda da internet\nSegunda linha",
      confidence: "alta" as const,
      fonte: "LRCLIB",
      has_lyrics: true,
      letra_origem: null,
      error: null,
    }));
    setBackendForTests({
      getLyrics,
      writeTags,
      enrichSongScan,
      ...overrides,
    } as unknown as Backend);
  }

  beforeEach(() => {
    setupEditBackend();
    // MÉDIO-15: o editor consulta o estado do lote antes de ir à rede
    useEnrichStore.setState({ status: "idle", scanInFlight: false });
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
      screen.getByRole("button", { name: "Buscar dados na internet" }),
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
      // ALTO-4: esta gravação não declara procedência de letra nenhuma
      null,
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
      null,
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
      null,
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

  /*
    V8/F18 — o "Buscar letra na internet" (V4) FOI SUBSTITUÍDO por "Buscar
    dados na internet", que roda o funil inteiro nesta música: o que já está
    no arquivo, depois LRCLIB, depois Vagalume (com chave). Dois botões
    dizendo "buscar na internet", com a diferença invisível para quem não
    sabe o que é LRCLIB, seriam uma escolha às cegas — e o antigo perdia
    sempre, porque consultava uma fonte só e nunca corrigia título ou artista.
    O resultado aparece AQUI, na ficha, e nada vai para o disco antes do
    "Salvar no arquivo".
  */
  it("o botão antigo de buscar SÓ letra não existe mais", async () => {
    await enterEditMode();
    expect(
      screen.queryByRole("button", { name: "Buscar letra na internet" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Buscar dados na internet" }),
    ).toBeInTheDocument();
  });

  it("roda o funil nesta música e mostra o resultado na própria ficha", async () => {
    await enterEditMode();
    fireEvent.click(
      screen.getByRole("button", { name: "Buscar dados na internet" }),
    );
    await waitFor(() =>
      expect(enrichSongScan).toHaveBeenCalledWith(
        1,
        expect.any(String),
        "Coração Sertanejo",
        "Artista Teste",
      ),
    );
    // procedência e confiança à vista, como na revisão do lote
    expect(await screen.findByText(/via LRCLIB/)).toBeInTheDocument();
    expect(screen.getByText("ALTA")).toBeInTheDocument();
    expect(screen.getByText("letra encontrada")).toBeInTheDocument();
    // nada foi gravado nem preenchido sem a pessoa mandar
    expect(writeTags).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Letra")).toHaveValue(LYRICS);
  });

  // V10 — a busca não leva credencial nenhuma (DECISIONS #110): a etapa que
  // pedia chave saiu do produto, e o `lyrics.ovh` que a substituiu não pede
  // nada. O payload tem quatro argumentos, e nenhum deles é segredo.
  it("a busca individual não manda credencial nenhuma", async () => {
    await enterEditMode();
    fireEvent.click(
      screen.getByRole("button", { name: "Buscar dados na internet" }),
    );
    await waitFor(() =>
      expect(enrichSongScan).toHaveBeenCalledWith(
        1,
        expect.any(String),
        "Coração Sertanejo",
        "Artista Teste",
      ),
    );
    expect(enrichSongScan.mock.calls[0]).toHaveLength(4);
  });

  it("'Usar estes dados' preenche o formulário (confirmando a sobrescrita da letra)", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    enrichSongScan.mockResolvedValueOnce({
      song_id: 1,
      file_path: "/acervo/1.mp3",
      current_title: "Coração Sertanejo",
      current_artist: "Artista Teste",
      proposed_title: "Coração Sertanejo (ao vivo)",
      proposed_artist: "Outro Artista",
      lyrics: "Letra vinda da internet\nSegunda linha",
      confidence: "media",
      fonte: "Vagalume",
      has_lyrics: true,
      letra_origem: null,
      error: null,
    });
    await enterEditMode();
    fireEvent.click(
      screen.getByRole("button", { name: "Buscar dados na internet" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Usar estes dados" }));

    expect(confirmSpy).toHaveBeenCalledWith(
      "Substituir a letra atual pelo resultado da busca?",
    );
    expect(screen.getByLabelText("Título")).toHaveValue("Coração Sertanejo (ao vivo)");
    expect(screen.getByLabelText("Artista")).toHaveValue("Outro Artista");
    expect(screen.getByLabelText("Letra")).toHaveValue(
      "Letra vinda da internet\nSegunda linha",
    );
    // continua sendo o "Salvar no arquivo" quem grava
    expect(writeTags).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("confirmação negada mantém a letra rascunhada", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    await enterEditMode();
    fireEvent.click(
      screen.getByRole("button", { name: "Buscar dados na internet" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Usar estes dados" }));
    expect(screen.getByLabelText("Letra")).toHaveValue(LYRICS);
    confirmSpy.mockRestore();
  });

  it("letra vazia é preenchida sem pedir confirmação", async () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    useLibraryStore.setState({ selectedSongId: 2 });
    render(<LyricsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Editar" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Buscar dados na internet" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Usar estes dados" }));
    expect(screen.getByLabelText("Letra")).toHaveValue(
      "Letra vinda da internet\nSegunda linha",
    );
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  // V9 — o funil de UMA música também passa pela etapa do som, então ele
  // também devolve conflito. Sem tratá-lo aqui, o editor mostraria "Coração
  // Sertanejo → Coração Sertanejo" com um botão que não muda nada, e a
  // divergência — que é a informação inteira — ficaria invisível.
  describe("o som discorda da etiqueta (V9)", () => {
    function comConflito() {
      enrichSongScan.mockResolvedValueOnce({
        song_id: 1,
        file_path: "/acervo/1.mp3",
        current_title: "Coração Sertanejo",
        current_artist: "Artista Teste",
        // a linha de conflito não propõe nada: ela repete o que já está lá
        proposed_title: "Coração Sertanejo",
        proposed_artist: "Artista Teste",
        lyrics: null,
        confidence: "baixa",
        fonte: "reconhecimento pelo som",
        has_lyrics: true,
        letra_origem: null,
        conflito: {
          titulo: "Viver Feliz",
          artista: "Nilson Chaves",
          confianca: "alta",
        },
        substitui_nome_escrito: false,
        error: null,
      });
    }

    it("mostra os dois lados e não oferece 'Usar estes dados'", async () => {
      comConflito();
      await enterEditMode();
      fireEvent.click(
        screen.getByRole("button", { name: "Buscar dados na internet" }),
      );
      expect(await screen.findByText(/Sua etiqueta diz/)).toBeInTheDocument();
      expect(screen.getByText(/O som diz/)).toBeInTheDocument();
      expect(screen.getByText("Viver Feliz — Nilson Chaves")).toBeInTheDocument();
      // V10 — a confiança diz SOBRE O QUE ela fala, e uma frase desfaz o
      // engano: ela é do reconhecimento da GRAVAÇÃO, não da etiqueta
      expect(
        screen.getByText("gravação reconhecida com confiança alta"),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/A confiança é sobre qual gravação é esta/),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Usar estes dados" }),
      ).not.toBeInTheDocument();
    });

    it("aceitar o som preenche os nomes e não encosta na letra", async () => {
      comConflito();
      await enterEditMode();
      fireEvent.click(
        screen.getByRole("button", { name: "Buscar dados na internet" }),
      );
      fireEvent.click(
        await screen.findByRole("button", { name: "Usar o que o som diz" }),
      );
      expect(screen.getByLabelText("Título")).toHaveValue("Viver Feliz");
      expect(screen.getByLabelText("Artista")).toHaveValue("Nilson Chaves");
      // a letra da música certa não é esta, e o funil parou antes de procurá-la
      expect(screen.getByLabelText("Letra")).toHaveValue(LYRICS);
      // e continua sendo o "Salvar no arquivo" quem grava
      expect(writeTags).not.toHaveBeenCalled();
    });
  });

  it("'Descartar' fecha o resultado sem mexer em nada", async () => {
    await enterEditMode();
    fireEvent.click(
      screen.getByRole("button", { name: "Buscar dados na internet" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Descartar" }));
    expect(
      screen.queryByRole("button", { name: "Usar estes dados" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Letra")).toHaveValue(LYRICS);
  });

  // ~3% de cobertura no acervo real: "não achamos" é o desfecho MAIS COMUM e
  // não pode ler como fracasso nem como "esta música está completa".
  it("nada encontrado: aviso honesto na ficha, sem toast de erro", async () => {
    enrichSongScan.mockResolvedValueOnce(null);
    await enterEditMode();
    fireEvent.click(
      screen.getByRole("button", { name: "Buscar dados na internet" }),
    );
    expect(await screen.findByText(SEM_RESULTADO_INDIVIDUAL)).toBeInTheDocument();
    expect(useToastStore.getState().toasts).toEqual([]);
    expect(screen.getByLabelText("Letra")).toHaveValue(LYRICS);
  });

  it("erro por música (sem conexão) aparece na ficha, sem oferecer 'Usar'", async () => {
    enrichSongScan.mockResolvedValueOnce({
      song_id: 1,
      file_path: "/acervo/1.mp3",
      current_title: "Coração Sertanejo",
      current_artist: "Artista Teste",
      proposed_title: "Coração Sertanejo",
      proposed_artist: "Artista Teste",
      lyrics: null,
      confidence: "baixa",
      fonte: "LRCLIB",
      has_lyrics: true,
      letra_origem: null,
      error: "sem conexão",
    });
    await enterEditMode();
    fireEvent.click(
      screen.getByRole("button", { name: "Buscar dados na internet" }),
    );
    expect(await screen.findByText("sem conexão")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Usar estes dados" }),
    ).not.toBeInTheDocument();
  });

  it("invoke rejeitado: aviso de falta de conexão na ficha", async () => {
    enrichSongScan.mockRejectedValueOnce(new Error("sem conexão"));
    await enterEditMode();
    fireEvent.click(
      screen.getByRole("button", { name: "Buscar dados na internet" }),
    );
    expect(
      await screen.findByText("Sem conexão — a busca de dados precisa de internet."),
    ).toBeInTheDocument();
  });

  // O produto é lido em tela de notebook, em sala mal iluminada, por quem
  // está conduzindo uma reunião (DECISIONS #69) — inclusive esta ficha nova.
  it("todo texto do resultado inline passa em AA sobre o fundo do bloco", async () => {
    await enterEditMode();
    fireEvent.click(
      screen.getByRole("button", { name: "Buscar dados na internet" }),
    );
    const bloco = await screen.findByRole("status");
    const comCor = [...bloco.querySelectorAll<HTMLElement>("*"), bloco].filter(
      (el) => /text-\[#[0-9a-fA-F]{6}\]/.test(el.className),
    );
    expect(comCor.length).toBeGreaterThan(0);
    for (const el of comCor) {
      // o fundo é o do bloco, exceto nos selos, que trazem o próprio
      const proprio = /bg-\[(#[0-9a-fA-F]{6})\]/.exec(el.className);
      const fundo = proprio ? proprio[1] : "#F9FAFB";
      expect(
        contrastRatio(corDoTexto(el.className), fundo),
        `"${el.textContent?.slice(0, 30)}"`,
      ).toBeGreaterThanOrEqual(AA_TEXTO_NORMAL);
    }
  });

  it("loading: botão vira 'Buscando…' desabilitado e não trava Salvar", async () => {
    let resolveScan!: (v: unknown) => void;
    enrichSongScan.mockImplementationOnce(
      () => new Promise((resolve) => (resolveScan = resolve)),
    );
    await enterEditMode();
    fireEvent.click(
      screen.getByRole("button", { name: "Buscar dados na internet" }),
    );

    const buscando = screen.getByRole("button", { name: "Buscando…" });
    expect(buscando).toBeDisabled();
    expect(screen.getByRole("button", { name: "Salvar no arquivo" })).toBeEnabled();

    resolveScan(null);
    const restaurado = await screen.findByRole("button", {
      name: "Buscar dados na internet",
    });
    expect(restaurado).toBeEnabled();
  });

  // ALTO-3a — a pessoa abre "Faixa 03", digita o título real e clica buscar.
  // O backend procurava "Faixa 03": a correção dela nunca era usada, e nada na
  // tela dizia isso. Para quem não tem suporte, é um beco sem saída que parece
  // "a internet não tem a minha música".
  it("a busca leva o título e o artista DIGITADOS, não os do banco", async () => {
    await enterEditMode();
    fireEvent.change(screen.getByLabelText("Título"), {
      target: { value: "  Asa Branca  " },
    });
    fireEvent.change(screen.getByLabelText("Artista"), {
      target: { value: "Luiz Gonzaga" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Buscar dados na internet" }),
    );
    await waitFor(() =>
      expect(enrichSongScan).toHaveBeenCalledWith(
        1,
        expect.any(String),
        "Asa Branca",
        "Luiz Gonzaga",
      ),
    );
  });

  it("campo de artista vazio volta a valer como 'use o que está no arquivo'", async () => {
    await enterEditMode();
    fireEvent.change(screen.getByLabelText("Artista"), { target: { value: "  " } });
    fireEvent.click(
      screen.getByRole("button", { name: "Buscar dados na internet" }),
    );
    await waitFor(() =>
      expect(enrichSongScan).toHaveBeenCalledWith(
        1,
        expect.any(String),
        "Coração Sertanejo",
        null,
      ),
    );
  });

  // ALTO-3b — a música completa passou a ser consultada mesmo assim ("quem
  // clicou sabe o que quer"), e é isto que devolve ao app um caminho para
  // rebuscar a letra de uma música que já tem letra. A confirmação é a trava.
  it("música que já tem letra pode ser rebuscada, com confirmação antes de trocar", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    await enterEditMode();
    fireEvent.click(
      screen.getByRole("button", { name: "Buscar dados na internet" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Usar estes dados" }));
    expect(confirmSpy).toHaveBeenCalledWith(
      "Substituir a letra atual pelo resultado da busca?",
    );
    expect(screen.getByLabelText("Letra")).toHaveValue(
      "Letra vinda da internet\nSegunda linha",
    );
    confirmSpy.mockRestore();
  });

  // Recusar a troca de letra não pode jogar fora a correção de NOME que veio
  // junto: são duas decisões diferentes (a mesma regra da revisão em lote).
  it("recusar a troca de letra ainda aproveita título e artista", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    enrichSongScan.mockResolvedValueOnce({
      song_id: 1,
      file_path: "/acervo/1.mp3",
      current_title: "Coração Sertanejo",
      current_artist: "Artista Teste",
      proposed_title: "Coração Sertanejo (ao vivo)",
      proposed_artist: "Outro Artista",
      lyrics: "Letra vinda da internet",
      confidence: "media",
      fonte: "LRCLIB",
      has_lyrics: true,
      letra_origem: null,
      error: null,
    });
    await enterEditMode();
    fireEvent.click(
      screen.getByRole("button", { name: "Buscar dados na internet" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Usar estes dados" }));

    expect(screen.getByLabelText("Letra")).toHaveValue(LYRICS);
    expect(screen.getByLabelText("Título")).toHaveValue("Coração Sertanejo (ao vivo)");
    expect(screen.getByLabelText("Artista")).toHaveValue("Outro Artista");
    confirmSpy.mockRestore();
  });

  // ALTO-3b — instrumental para na etapa 1: nenhuma etapa de LETRA roda. Dizer
  // "não achamos nos sites de letra" contaria uma busca que não aconteceu.
  it("instrumental sem resultado: o aviso diz que letra não foi procurada", async () => {
    enrichSongScan.mockResolvedValueOnce(null);
    await enterEditMode();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Esta música é instrumental" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Buscar dados na internet" }),
    );
    expect(await screen.findByText(SEM_RESULTADO_INSTRUMENTAL)).toBeInTheDocument();
    expect(screen.queryByText(SEM_RESULTADO_INDIVIDUAL)).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // ALTO-4 — a procedência da letra aceita no editor
  // -------------------------------------------------------------------------
  // V10 — a fonte que DECLARA procedência é o `lyrics.ovh` (o Vagalume saiu,
  // DECISIONS #110). O valor gravado é o nome do serviço, e é assim que a
  // próxima ferramenta sabe de onde a letra veio.
  it("letra do lyrics.ovh aceita no editor é GRAVADA como vinda dele", async () => {
    enrichSongScan.mockResolvedValueOnce({
      song_id: 1,
      file_path: "/acervo/1.mp3",
      current_title: "Coração Sertanejo",
      current_artist: "Artista Teste",
      proposed_title: "Coração Sertanejo",
      proposed_artist: "Artista Teste",
      lyrics: "letra do lyrics.ovh",
      confidence: "media",
      fonte: "lyrics.ovh",
      has_lyrics: true,
      letra_origem: null,
      error: null,
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    await enterEditMode();
    fireEvent.click(
      screen.getByRole("button", { name: "Buscar dados na internet" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Usar estes dados" }));
    fireEvent.click(screen.getByRole("button", { name: "Salvar no arquivo" }));

    await waitFor(() => expect(writeTags).toHaveBeenCalled());
    expect(writeTags.mock.calls[0][6]).toBe("lyrics.ovh");
    confirmSpy.mockRestore();
  });

  it("letra do LRCLIB não inventa procedência: a marca é limpa", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    await enterEditMode();
    fireEvent.click(
      screen.getByRole("button", { name: "Buscar dados na internet" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Usar estes dados" }));
    fireEvent.click(screen.getByRole("button", { name: "Salvar no arquivo" }));

    await waitFor(() => expect(writeTags).toHaveBeenCalled());
    expect(writeTags.mock.calls[0][6]).toBeNull();
    confirmSpy.mockRestore();
  });

  // A marca descreve o TEXTO que está lá: se a pessoa mexeu na letra depois de
  // aceitar, ela não é mais a letra que o serviço devolveu.
  it("editar a letra à mão depois de aceitar apaga a procedência pendente", async () => {
    enrichSongScan.mockResolvedValueOnce({
      song_id: 1,
      file_path: "/acervo/1.mp3",
      current_title: "Coração Sertanejo",
      current_artist: "Artista Teste",
      proposed_title: "Coração Sertanejo",
      proposed_artist: "Artista Teste",
      lyrics: "letra do vagalume",
      confidence: "media",
      fonte: "Vagalume",
      has_lyrics: true,
      letra_origem: null,
      error: null,
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    await enterEditMode();
    fireEvent.click(
      screen.getByRole("button", { name: "Buscar dados na internet" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Usar estes dados" }));
    fireEvent.change(screen.getByLabelText("Letra"), {
      target: { value: "letra do vagalume, com um verso corrigido" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Salvar no arquivo" }));

    await waitFor(() => expect(writeTags).toHaveBeenCalled());
    expect(writeTags.mock.calls[0][6]).toBeNull();
    confirmSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // MÉDIO-15 — dois funis ao mesmo tempo dobram a taxa de consulta nos sites,
  // que é justamente o que a cortesia compartilhada existe para evitar.
  // -------------------------------------------------------------------------
  it("com uma varredura em lote rodando, a busca do editor fica bloqueada e diz por quê", async () => {
    useEnrichStore.setState({ status: "scanning", scanInFlight: true });
    await enterEditMode();
    const botao = screen.getByRole("button", { name: "Buscar dados na internet" });
    expect(botao).toBeDisabled();
    const motivo = screen.getByText(
      "A busca desta pasta está rodando — espere ela terminar para não" +
        " consultar os sites de letra duas vezes ao mesmo tempo.",
    );
    expect(motivo).toBeVisible();
    expect(botao).toHaveAttribute("aria-describedby", motivo.id);
    expect(enrichSongScan).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // B1 — sem id a busca individual era incancelável: offline, sete palpites de
  // 10 s cada deixavam o editor em "Buscando…" por mais de um minuto.
  // -------------------------------------------------------------------------
  it("durante a busca dá para cancelar, e o resultado que chegar depois é ignorado", async () => {
    const enrichCancelScan = vi.fn(async () => {});
    setupEditBackend({ enrichCancelScan } as unknown as Partial<Backend>);
    let resolveScan!: (v: unknown) => void;
    enrichSongScan.mockImplementationOnce(
      () => new Promise((resolve) => (resolveScan = resolve)),
    );
    await enterEditMode();
    fireEvent.click(
      screen.getByRole("button", { name: "Buscar dados na internet" }),
    );

    // enquanto busca, a tela avisa que isso pode demorar
    expect(
      screen.getByText(/pode demorar se os sites de letra estiverem lentos/),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancelar busca" }));
    await waitFor(() => expect(enrichCancelScan).toHaveBeenCalled());
    expect(
      await screen.findByRole("button", { name: "Buscar dados na internet" }),
    ).toBeEnabled();

    // a resposta atrasada da busca cancelada não pode aparecer na ficha
    await act(async () => {
      resolveScan(null);
    });
    expect(screen.queryByText(SEM_RESULTADO_INDIVIDUAL)).not.toBeInTheDocument();
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
      enrichSongScan: vi.fn(async () => null),
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
      enrichSongScan: vi.fn(async () => null),
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
