import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LyricsPanel } from "./LyricsPanel";
import {
  setBackendForTests,
  type AcessorioInfo,
  type Backend,
} from "../lib/api";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlayerStore } from "../stores/playerStore";
import { usePlaylistStore } from "../stores/playlistStore";
import { useToastStore } from "../stores/toastStore";
import {
  SEM_RESULTADO_INDIVIDUAL,
  SEM_RESULTADO_INSTRUMENTAL,
  dicaDeTranscreverEstaMusica,
} from "../lib/curadoria";
import { useEnrichStore } from "../stores/enrichStore";
import type { Song } from "../lib/types";
import {
  AA_TEXTO_NORMAL,
  BG_COLOR_RE,
  contrastRatio,
  corDoFundo,
  corDoTexto,
  FUNDOS_DA_LINHA,
  TEXT_COLOR_RE,
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
    expect(titulo.className).toContain("border-danger");
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
    // adiciona tema saindo do campo (V10.11: Enter aqui GRAVA a ficha inteira,
    // e este teste é o do clique no botão — o Enter tem o describe dele)
    const temaInput = screen.getByPlaceholderText("Adicionar tema");
    fireEvent.change(temaInput, { target: { value: "fé" } });
    fireEvent.blur(temaInput);
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
      (el) => TEXT_COLOR_RE.test(el.className),
    );
    expect(comCor.length).toBeGreaterThan(0);
    for (const el of comCor) {
      // o fundo é o do bloco, exceto nos selos, que trazem o próprio
      const fundo = corDoFundo(el.className) ?? corDoFundo("bg-canvas")!;
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

// ---------------------------------------------------------------------------
// V10.9 → V10.10 — A ETAPA 5 NA PORTA DE UMA MÚSICA, E O BOTÃO QUE NÃO COBRA
// O FUNIL INTEIRO ANTES.
//
// A V10.9 pôs a etapa 5 na ficha, mas pendurada no desfecho da busca: ela só
// aparecia DEPOIS de "Buscar dados na internet" e só quando as quatro etapas
// não achavam letra. Pedido do dono do produto, verbatim: *"No caso específico
// de mexer música por música quero um botão separado pra fazer transcrição. Pra
// não precisar rodar todo o fluxo pra depois só poder transcrever."*
//
// Com 3% de cobertura medida, quem já sabe que a música não está na internet
// pagava segundos de rede e uma leitura de impressão digital para só então
// poder transcrever.
//
// A oferta reusa a MESMA máquina das outras duas portas: `startTranscricao`
// recebe a fila por parâmetro desde a V10.6, e uma lista de um item é tudo o
// que falta. Um segundo caminho seria um segundo lugar onde a barra, o
// cancelamento e a revisão podem divergir (a lição do M4).
// ---------------------------------------------------------------------------
describe("LyricsPanel — o botão direto da etapa 5 na ficha (V10.10)", () => {
  /** O rótulo inteiro: o que o botão faz, e quanto custa. */
  const BOTAO =
    "Escrever a letra ouvindo o áudio (cerca de 4 minutos — pode levar mais" +
    " nesta máquina)";
  /** O rótulo quando JÁ HÁ letra: "de novo" é o que a pessoa veio fazer. */
  const BOTAO_DE_NOVO =
    "Escrever a letra de novo, ouvindo o áudio (cerca de 4 minutos — pode" +
    " levar mais nesta máquina)";
  const DICA_COM_LETRA = dicaDeTranscreverEstaMusica(true);
  const SEM_LETRA = "Esta música continua sem letra.";
  let startTranscricao: ReturnType<typeof vi.fn>;
  let transcricaoPendentesDaMusica: ReturnType<typeof vi.fn>;
  let enrichSongScan: ReturnType<typeof vi.fn>;

  /** Uma música sem letra — a que o desfecho típico deixa parada. */
  function semLetra(over: Partial<Song> = {}): Song {
    return { ...song(2, false), title: "Cadê o Gato", ...over };
  }

  /** Um acessório da etapa 5 que ainda não foi baixado nesta máquina. */
  function acessorio(
    nome: AcessorioInfo["nome"],
    bytes: number,
    segundos: number,
  ): AcessorioInfo {
    return {
      nome,
      arquivo: nome,
      para_que_serve: "",
      estado: "ausente",
      tamanho_bytes: bytes,
      segundos_estimados: segundos,
      tempo_medido_nesta_maquina: false,
      executavel: false,
      origem: "",
    };
  }

  /** O que a porta responde para uma música que a etapa 5 transcreveria. */
  function pendente(over: Record<string, unknown> = {}) {
    return {
      musicas: [2],
      segundos_estimados: 240,
      estimativa_medida_nesta_maquina: false,
      disponivel: true,
      ...over,
    };
  }

  function montar(s: Song = semLetra(), over: Partial<Backend> = {}) {
    setBackendForTests({
      getLyrics: vi.fn(async () => null),
      writeTags: vi.fn(async () => s),
      enrichSongScan,
      transcricaoPendentesDaMusica,
      ...over,
    } as unknown as Backend);
    useLibraryStore.setState({
      results: [{ song: s, snippet: null }],
      selectedSongId: s.id,
    });
    render(<LyricsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
  }

  /** O clique que a pessoa dá, e o desfecho típico que ele produz. */
  function buscar() {
    fireEvent.click(
      screen.getByRole("button", { name: "Buscar dados na internet" }),
    );
  }

  beforeEach(() => {
    // "não achamos nada" é o desfecho típico deste repertório, e é o padrão daqui
    enrichSongScan = vi.fn(async () => null);
    transcricaoPendentesDaMusica = vi.fn(async () => pendente());
    startTranscricao = vi.fn(async () => {});
    useEnrichStore.setState({
      status: "idle",
      scanInFlight: false,
      startTranscricao,
    });
    useToastStore.setState({ toasts: [] });
    usePlaylistStore.setState({ items: [], activePlaylistId: null });
    usePlayerStore.setState({ current: null, isPlaying: false });
  });

  /*
    ESTE TESTE MUDOU DE PROPÓSITO na V10.10, e é o conserto inteiro num
    assert.

    Ele guardava o contrário: "antes de buscar, a ficha não oferece a etapa 5",
    porque a V10.9 decidiu que naquele segundo a pergunta era outra (se a
    internet tem esta música). O uso desmentiu a premissa — quem abre uma ficha
    deste acervo em geral JÁ SABE que a internet não tem —, e o preço de estar
    errado era o funil inteiro antes de poder transcrever.

    A escolha às cegas que a V8 recusou continua recusada, e é por isso que o
    tempo está no rótulo: os dois botões desta tela dizem coisas diferentes e
    cada um traz o próprio custo.
  */
  it("o botão está na ficha ANTES de qualquer busca, com o tempo DESTA música", async () => {
    montar();
    expect(await screen.findByRole("button", { name: BOTAO })).toBeInTheDocument();
    expect(transcricaoPendentesDaMusica).toHaveBeenCalledWith(2);
    // e nada de rede: o funil não roda para a oferta existir
    expect(enrichSongScan).not.toHaveBeenCalled();
  });

  /*
    A MESMA MÁQUINA DAS OUTRAS PORTAS, com uma fila de um item: mesma barra,
    mesmo cancelamento, mesma revisão no fim. A lista sai da PORTA (é ela que
    aplica os portões da etapa 5), e não de um `[song.id]` montado aqui — montar
    o id na tela seria a tela decidindo o que a etapa 5 transcreve.
  */
  it("o botão manda a fila de um item pelo MESMO caminho, sem passar pelo funil", async () => {
    montar();
    fireEvent.click(await screen.findByRole("button", { name: BOTAO }));
    expect(startTranscricao).toHaveBeenCalledWith([2]);
    expect(enrichSongScan).not.toHaveBeenCalled();
  });

  /*
    A CONVIVÊNCIA DOS DOIS BOTÕES, RESOLVIDA: não há dois.

    A oferta da V10.9 aparecia depois da busca com um "Começar agora" — a mesma
    ação, num segundo botão, na mesma tela. É a duplicação que a V8 removeu
    quando havia dois "buscar na internet". Quem sobrou foi o botão permanente,
    porque ele responde antes e depois da busca; o "Começar agora" da ficha
    deixou de existir.
  */
  it("depois da busca que não achou letra, continua havendo UM botão só", async () => {
    montar();
    await screen.findByRole("button", { name: BOTAO });
    buscar();
    expect(await screen.findByText(SEM_RESULTADO_INDIVIDUAL)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Começar agora" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: /Escrever a letra ouvindo o áudio/ }),
    ).toHaveLength(1);
    // e a porta não é reperguntada por causa da busca (DECISIONS #162d)
    expect(transcricaoPendentesDaMusica).toHaveBeenCalledTimes(1);
  });

  /*
    O QUE O BOTÃO DESCREVE É O ARQUIVO E O FORMULÁRIO — nunca o resultado de uma
    busca. Proposta não é fato: nada foi gravado, e a música continua sem letra
    até alguém clicar. Um botão que some porque uma sugestão apareceu na tela é
    um botão que a pessoa vai procurar e não achar.

    Some, sim, quando a letra ENTRA no campo — aí a música deixou de estar sem
    letra, e é essa a mudança que importa.
  */
  it("com letra encontrada o botão fica, e passa a dizer 'de novo' quando ela entra no campo", async () => {
    enrichSongScan = vi.fn(async () => ({
      song_id: 2,
      file_path: "/m/2.mp3",
      current_title: "Cadê o Gato",
      current_artist: "Artista Teste",
      proposed_title: "Cadê o Gato",
      proposed_artist: "Artista Teste",
      lyrics: "achei a letra",
      confidence: "alta" as const,
      fonte: "LRCLIB",
      has_lyrics: false,
      letra_origem: null,
      conflito: null,
      substitui_nome_escrito: false,
      marcar_instrumental: false,
      refrao: null,
      aviso: null,
      error: null,
    }));
    montar();
    buscar();
    fireEvent.click(await screen.findByRole("button", { name: "Usar estes dados" }));
    /*
      V10.11 — o botão NÃO some mais: a DECISIONS #166 o tirava quando a letra
      entrava no campo, e o dono reverteu a #167 junto. O que muda é o rótulo,
      que passa a dizer que a letra vai ser REFEITA.
    */
    expect(
      screen.queryByRole("button", { name: BOTAO }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: BOTAO_DE_NOVO }),
    ).toBeInTheDocument();
  });

  /*
    A BUSCA QUE FALHOU POR FALTA DE INTERNET não muda nada aqui, e é de
    propósito: a etapa 5 não usa rede. A música que ficou sem letra porque o
    LRCLIB não respondeu é exatamente a que a transcrição resolve.
  */
  it("a busca que falhou por falta de internet não tira o botão", async () => {
    enrichSongScan = vi.fn(async () => {
      throw new Error("sem conexão");
    });
    montar();
    buscar();
    expect(
      await screen.findByText("Sem conexão — a busca de dados precisa de internet."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: BOTAO })).toBeInTheDocument();
  });

  /*
    QUEM DECIDE SE HÁ O QUE TRANSCREVER É O BACKEND. Música com letra,
    instrumental ou com o arquivo fora do disco voltam com a fila vazia, e a
    ficha não desenha nada — reescrever o portão aqui seria a #80 outra vez.

    A música que JÁ TEM LETRA cai neste caso, e é onde ela tem de cair: a etapa
    5 produziria uma SUBSTITUIÇÃO, que o `apply` só grava com consentimento
    explícito (DECISIONS #79) — minutos de CPU para chegar a uma caixa que a
    pessoa não tinha como prever, num formulário que MOSTRA a letra que ela
    pode corrigir à mão ali mesmo.
  */
  it("fila vazia do backend: não há botão e nada é afirmado", async () => {
    transcricaoPendentesDaMusica = vi.fn(async () =>
      pendente({ musicas: [], segundos_estimados: 0 }),
    );
    montar();
    await waitFor(() => expect(transcricaoPendentesDaMusica).toHaveBeenCalled());
    expect(
      screen.queryByRole("button", { name: /Escrever a letra ouvindo o áudio/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(SEM_LETRA, { exact: false })).not.toBeInTheDocument();
  });

  // "Não sabemos" é um estado (DECISIONS #86): a porta que não respondeu não
  // vira zero nem promessa — a ficha simplesmente não desenha o botão.
  it("porta que falhou não desenha nada", async () => {
    transcricaoPendentesDaMusica = vi.fn(async () => {
      throw new Error("banco ocupado");
    });
    montar();
    await waitFor(() => expect(transcricaoPendentesDaMusica).toHaveBeenCalled());
    expect(
      screen.queryByRole("button", { name: /Escrever a letra ouvindo o áudio/ }),
    ).not.toBeInTheDocument();
  });

  /*
    O FORMULÁRIO É MAIS ATUAL QUE O BANCO. Quem acabou de marcar "esta música é
    instrumental" declarou que não há voz no áudio; oferecer escrever a letra
    ouvindo o áudio contradiria o que ela acabou de dizer. É a mesma razão do
    `SEM_RESULTADO_INSTRUMENTAL`, que já existe por causa desta caixa — e o
    mesmo padrão da V10.9, não um terceiro.
  */
  it("marcada como instrumental no formulário, o botão sai da tela", async () => {
    montar();
    await screen.findByRole("button", { name: BOTAO });
    fireEvent.click(screen.getByLabelText("Esta música é instrumental"));
    expect(
      screen.queryByRole("button", { name: /Escrever a letra ouvindo o áudio/ }),
    ).not.toBeInTheDocument();
  });

  /*
    ESTE TESTE MUDOU DE PROPÓSITO NA V10.11, e a mudança é o item inteiro.

    Ele guardava "escrita a letra no campo, o botão sai da tela" (DECISIONS
    #166). O dono reverteu, com um caso concreto: um beta tester abriu uma
    música cuja letra terminava em `[MÚSICA]` — letra de transcrição,
    imperfeita — e queria exatamente refazê-la. **O caso em que a pessoa mais
    quer transcrever de novo é justamente aquele em que já existe letra ruim.**

    O que aparece no lugar do sumiço é a INFORMAÇÃO: o rótulo diz "de novo" e a
    dica diz que a letra atual não é apagada, e sim proposta para substituição.
  */
  it("com letra no campo, o botão fica e diz que a letra será refeita", async () => {
    montar();
    await screen.findByRole("button", { name: BOTAO });
    fireEvent.change(screen.getByLabelText("Letra"), {
      target: { value: "agora tem letra" },
    });
    const botao = screen.getByRole("button", { name: BOTAO_DE_NOVO });
    expect(botao).toBeInTheDocument();
    expect(botao).toHaveAttribute("title", DICA_COM_LETRA);
    expect(DICA_COM_LETRA).toBe(
      "Escreve a letra ouvindo o áudio desta música, sem usar a internet." +
        " A letra que está aqui não é apagada: a nova entra como proposta de" +
        " substituição, e você decide antes de gravar.",
    );
  });

  /*
    A DICA SEM LETRA continua a que sempre foi: não há nada a substituir, e
    inventar uma ressalva para um caso que não existe seria ruído.
  */
  it("sem letra no campo, a dica é a de sempre", async () => {
    montar();
    const botao = await screen.findByRole("button", { name: BOTAO });
    expect(botao).toHaveAttribute(
      "title",
      "Escreve a letra ouvindo o áudio desta música, sem usar a internet." +
        " Nada é gravado sem você conferir.",
    );
  });

  /*
    E A MÚSICA QUE JÁ CHEGA COM LETRA — a do relato — vê o botão desde o
    primeiro segundo da ficha, sem busca nenhuma antes. Quem responde se há o
    que transcrever continua sendo a PORTA (DECISIONS #155): a tela não monta
    `[song.id]` nenhum.
  */
  it("música que já tem letra vê o botão ao abrir a ficha, e a fila vem da porta", async () => {
    const comLetra = { ...semLetra(), has_lyrics: true };
    setBackendForTests({
      getLyrics: vi.fn(async () => "uma letra que termina em [MÚSICA]"),
      writeTags: vi.fn(async () => comLetra),
      enrichSongScan,
      transcricaoPendentesDaMusica,
    } as unknown as Backend);
    useLibraryStore.setState({
      results: [{ song: comLetra, snippet: null }],
      selectedSongId: comLetra.id,
    });
    render(<LyricsPanel />);
    // o "Editar" espera a letra carregar para o formulário não abrir vazio
    await screen.findByTestId("lyrics-body");
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));

    const botao = await screen.findByRole("button", { name: BOTAO_DE_NOVO });
    expect(transcricaoPendentesDaMusica).toHaveBeenCalledWith(2);

    fireEvent.click(botao);
    expect(startTranscricao).toHaveBeenCalledWith([2]);
    expect(enrichSongScan).not.toHaveBeenCalled();
  });

  /*
    O BLOCO DE DOWNLOAD, ESSE, CONTINUA PRESO AO CAMPO VAZIO — e não é uma
    exceção esquecida: a primeira frase dele é "Esta música continua sem letra.",
    e com o textarea cheio logo acima ela seria desmentida pela tela em volta.
    Quem tem letra e não tem os acessórios continua tendo o bloco permanente de
    Configurações, que é onde o download mora.
  */
  it("com letra no campo e sem acessórios, a frase de download não é dita", async () => {
    transcricaoPendentesDaMusica = vi.fn(async () => pendente({ disponivel: false }));
    montar();
    await waitFor(() => expect(transcricaoPendentesDaMusica).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("Letra"), {
      target: { value: "agora tem letra" },
    });
    buscar();
    await screen.findByText(SEM_RESULTADO_INDIVIDUAL);
    expect(screen.queryByText(SEM_LETRA, { exact: false })).not.toBeInTheDocument();
  });

  /*
    SEM OS ACESSÓRIOS NÃO HÁ BOTÃO: um botão que não faria nada é pior que a
    frase que diz o que fazer (DECISIONS #157) — e o padrão é o da pergunta do
    fim, a outra porta que não está em Configurações, com tamanho e tempo.

    A FRASE continua saindo depois da busca, e não o tempo todo: ela é a
    resposta ao beco que a busca acabou de produzir, e um parágrafo permanente
    dentro de um formulário é o que a #154(a) recusou. O botão pode ser
    permanente porque é uma AÇÃO que esta máquina executa; a frase manda a
    pessoa para outra tela.
  */
  it("sem os acessórios não há botão, e a saída aparece quando a busca não traz letra", async () => {
    transcricaoPendentesDaMusica = vi.fn(async () => pendente({ disponivel: false }));
    montar(semLetra(), {
      acessoriosEstado: vi.fn(async (): Promise<AcessorioInfo[]> => [
        acessorio("whisper-cli", 2_000_000, 1),
        acessorio("modelo-de-transcricao-grande", 1_533_763_059, 511),
      ]),
    });
    await waitFor(() => expect(transcricaoPendentesDaMusica).toHaveBeenCalled());
    expect(
      screen.queryByRole("button", { name: /Escrever a letra ouvindo o áudio/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(SEM_LETRA, { exact: false })).not.toBeInTheDocument();

    buscar();
    expect(
      await screen.findByText(
        "Esta música continua sem letra. Para escrever a letra ouvindo o áudio," +
          " baixe 1,4 GB em Configurações — cerca de 9 minutos.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Começar agora" }),
    ).not.toBeInTheDocument();
  });

  // Sem saber o tamanho (a leitura dos acessórios não voltou), não se inventa
  // número nenhum — mas o caminho continua sendo dito.
  it("sem saber o tamanho, o caminho é dito sem número inventado", async () => {
    transcricaoPendentesDaMusica = vi.fn(async () => pendente({ disponivel: false }));
    montar(semLetra(), {
      acessoriosEstado: vi.fn(async () => {
        throw new Error("não deu");
      }),
    });
    buscar();
    const texto = await screen.findByText(SEM_LETRA, { exact: false });
    expect(texto.textContent).toContain("Configurações");
    expect(texto.textContent).not.toMatch(/\d+(,\d)? (kB|MB|GB)/);
  });

  /*
    O botão novo entra na MESMA trava dos outros: enquanto uma varredura ou a
    etapa 5 estão rodando, ele não dispara um segundo trabalho pesado — e o
    motivo na tela diz QUAL trabalho está rodando (V10.9).
  */
  it("com a etapa 5 rodando, o botão para e o motivo fala da escrita", async () => {
    montar();
    await screen.findByRole("button", { name: BOTAO });
    act(() =>
      useEnrichStore.setState({ status: "transcribing", scanInFlight: true }),
    );
    const motivo = await screen.findByText(/espere elas terminarem/);
    expect(motivo.textContent).toContain("As letras estão sendo escritas");
    expect(screen.getByRole("button", { name: BOTAO })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Buscar dados na internet" }),
    ).toBeDisabled();
  });

  /*
    O CONSERTO QUE VEIO JUNTO COM A PORTA NOVA (V10.9), e que a V10.10 deixa
    ainda mais alcançável — agora dá para mandar transcrever sem nem buscar.

    Aplicada a letra na revisão, o arquivo passa a ter letra e a ficha continua
    aberta atrás, com o campo VAZIO — e "Salvar no arquivo" com o campo vazio
    APAGA a letra do arquivo (`None` remove o frame USLT). Seria o produto
    destruindo, num clique de hábito, o trabalho de minutos que ele acabou de
    fazer.

    O campo só é atualizado quando está VAZIO: nada que a pessoa tenha digitado
    é sobrescrito. Ela pode ter corrigido o título antes de mandar transcrever, e
    perder isso seria trocar um estrago por outro.
  */
  it("a letra que chegou ao arquivo com a ficha aberta preenche o campo vazio", async () => {
    const s = semLetra();
    const getLyrics = vi.fn(async () => "letra escrita ouvindo o áudio");
    montar(s, { getLyrics: vi.fn(async () => null) });
    await screen.findByLabelText("Letra");
    fireEvent.change(screen.getByLabelText("Título"), {
      target: { value: "Cadê o Gato (corrigido)" },
    });

    // é o que a revisão faz depois de gravar: a Song volta com letra
    setBackendForTests({
      getLyrics,
      writeTags: vi.fn(async () => s),
      enrichSongScan,
      transcricaoPendentesDaMusica,
    } as unknown as Backend);
    act(() =>
      useLibraryStore.getState().updateSong({ ...s, has_lyrics: true }),
    );

    await waitFor(() =>
      expect(screen.getByLabelText("Letra")).toHaveValue(
        "letra escrita ouvindo o áudio",
      ),
    );
    // e o que a pessoa digitou continua onde estava
    expect(screen.getByLabelText("Título")).toHaveValue("Cadê o Gato (corrigido)");
  });

  it("campo com texto digitado NÃO é sobrescrito pelo arquivo", async () => {
    const s = semLetra();
    montar(s, { getLyrics: vi.fn(async () => null) });
    await screen.findByLabelText("Letra");
    fireEvent.change(screen.getByLabelText("Letra"), {
      target: { value: "o que eu estava digitando" },
    });

    setBackendForTests({
      getLyrics: vi.fn(async () => "letra escrita ouvindo o áudio"),
      writeTags: vi.fn(async () => s),
      enrichSongScan,
      transcricaoPendentesDaMusica,
    } as unknown as Backend);
    act(() =>
      useLibraryStore.getState().updateSong({ ...s, has_lyrics: true }),
    );

    await waitFor(() => expect(screen.getByLabelText("Letra")).toBeInTheDocument());
    expect(screen.getByLabelText("Letra")).toHaveValue("o que eu estava digitando");
  });

  // O produto é lido em tela de notebook, em sala mal iluminada (DECISIONS
  // #69) — a saída sem acessórios entra na mesma régua.
  it("o texto da saída sem acessórios passa em AA sobre o verde-água do bloco", async () => {
    transcricaoPendentesDaMusica = vi.fn(async () => pendente({ disponivel: false }));
    montar();
    buscar();
    await screen.findByText(SEM_LETRA, { exact: false });
    const bloco = screen
      .getAllByRole("status")
      .find((el) => BG_COLOR_RE.test(el.className) && corDoFundo(el.className) === corDoFundo("bg-brand-soft"))!;
    const comCor = [...bloco.querySelectorAll<HTMLElement>("*"), bloco].filter(
      (el) => TEXT_COLOR_RE.test(el.className),
    );
    expect(comCor.length).toBeGreaterThan(0);
    for (const el of comCor) {
      const fundo = corDoFundo(el.className) ?? corDoFundo("bg-brand-soft")!;
      expect(
        contrastRatio(corDoTexto(el.className), fundo),
        `"${el.textContent?.slice(0, 30)}"`,
      ).toBeGreaterThanOrEqual(AA_TEXTO_NORMAL);
    }
  });
});

// ---------------------------------------------------------------------------
// V10.11 — 20, 40 TEMAS SEM QUEBRAR A TELA.
//
// Os dois beta testers sugeriram limitar a 10 temas por música. O dono recusou
// o limite — tema é o vocabulário da própria pessoa, e um teto rígido bate em
// alguém no pior momento, sem ninguém a quem perguntar — e mandou o layout
// aguentar. É o que estes testes guardam nas DUAS telas onde os temas de uma
// música aparecem inteiros: o cabeçalho da ficha e o formulário de edição.
// ---------------------------------------------------------------------------
describe("LyricsPanel — os temas dobrados na ficha (V10.11)", () => {
  /** 12 temas plausíveis: o caso do relato é bem maior, e cabe pela mesma régua. */
  const MUITOS = [
    "água", "esperança", "fé", "peregrinação", "advento", "louvor",
    "comunhão", "paz", "misericórdia", "cura", "natal", "páscoa",
  ];

  function comTemas(lista: string[]): Song {
    return { ...song(1, true), temas: lista.join("; ") };
  }

  function montar(s: Song) {
    setBackendForTests({
      getLyrics: vi.fn(async () => LYRICS),
      writeTags: vi.fn(async () => s),
      transcricaoPendentesDaMusica: vi.fn(async () => ({
        musicas: [],
        segundos_estimados: 0,
        estimativa_medida_nesta_maquina: false,
        disponivel: true,
      })),
    } as unknown as Backend);
    useLibraryStore.setState({
      results: [{ song: s, snippet: null }],
      selectedSongId: s.id,
    });
    render(<LyricsPanel />);
  }

  beforeEach(() => {
    useEnrichStore.setState({ status: "idle", scanInFlight: false });
    useToastStore.setState({ toasts: [] });
    usePlaylistStore.setState({ items: [], activePlaylistId: null });
    usePlayerStore.setState({ current: null, isPlaying: false });
  });

  it("no cabeçalho, 12 temas viram 3 chips e um '+9' que abre", async () => {
    montar(comTemas(MUITOS));
    await screen.findByTestId("lyrics-body");
    expect(screen.getAllByTestId("tema-chip")).toHaveLength(3);

    fireEvent.click(screen.getByRole("button", { name: "Mostrar os outros 9 temas" }));
    expect(screen.getAllByTestId("tema-chip")).toHaveLength(12);
  });

  /*
    NO FORMULÁRIO A MESMA RÉGUA, e o chip continua removível: dobrar é layout,
    e não um segundo modo de edição. Quem quer tirar o décimo tema abre a lista
    e clica no × dele, como faria com o primeiro.
  */
  it("no formulário, dobra igual e o chip revelado continua removível", async () => {
    montar(comTemas(MUITOS));
    await screen.findByTestId("lyrics-body");
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));

    expect(screen.getAllByTestId("tema-chip-editavel")).toHaveLength(3);
    expect(
      screen.queryByRole("button", { name: "Remover tema páscoa" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("tema-mais-editavel"));
    expect(screen.getAllByTestId("tema-chip-editavel")).toHaveLength(12);
    fireEvent.click(screen.getByRole("button", { name: "Remover tema páscoa" }));
    expect(screen.getAllByTestId("tema-chip-editavel")).toHaveLength(11);
  });

  /*
    O CHIP QUE A PESSOA ACABOU DE CRIAR NÃO NASCE ESCONDIDO.

    Com a lista dobrada, confirmar um tema o mandaria direto para trás do "+N" —
    e quem digitou e não viu nada acontecer conclui que não funcionou, e digita
    de novo. Confirmar um tema abre a lista, e é o único gesto que a abre
    sozinho.
  */
  it("confirmar um tema com a lista dobrada abre a lista, para o novo chip aparecer", async () => {
    montar(comTemas(MUITOS));
    await screen.findByTestId("lyrics-body");
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    expect(screen.getAllByTestId("tema-chip-editavel")).toHaveLength(3);

    const input = screen.getByPlaceholderText("Adicionar tema");
    fireEvent.change(input, { target: { value: "quaresma" } });
    fireEvent.blur(input);

    expect(screen.getAllByTestId("tema-chip-editavel")).toHaveLength(13);
    expect(
      screen.getByRole("button", { name: "Remover tema quaresma" }),
    ).toBeInTheDocument();
  });

  // Quatro temas continuam sendo quatro chips: dobrar um só não tira linha
  // nenhuma da tela e cobraria um clique por nada.
  it("com quatro temas nada é dobrado, nem na ficha nem no formulário", async () => {
    montar(comTemas(MUITOS.slice(0, 4)));
    await screen.findByTestId("lyrics-body");
    expect(screen.getAllByTestId("tema-chip")).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    expect(screen.getAllByTestId("tema-chip-editavel")).toHaveLength(4);
    expect(screen.queryByTestId("tema-mais")).not.toBeInTheDocument();
    expect(screen.queryByTestId("tema-mais-editavel")).not.toBeInTheDocument();
  });

  // Dobrar é de TELA: a gravação leva a lista inteira, aberta ou fechada.
  it("dobrado ou aberto, o que é gravado é a lista inteira", async () => {
    const s = comTemas(MUITOS);
    // tipado com os argumentos que o `writeTags` recebe: sem isso o `mock.calls`
    // é uma tupla vazia e o índice do campo de temas não compila
    const writeTags = vi.fn(async (..._args: unknown[]) => s);
    setBackendForTests({
      getLyrics: vi.fn(async () => LYRICS),
      writeTags,
      transcricaoPendentesDaMusica: vi.fn(async () => ({
        musicas: [],
        segundos_estimados: 0,
        estimativa_medida_nesta_maquina: false,
        disponivel: true,
      })),
    } as unknown as Backend);
    useLibraryStore.setState({
      results: [{ song: s, snippet: null }],
      selectedSongId: s.id,
    });
    render(<LyricsPanel />);
    await screen.findByTestId("lyrics-body");
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    fireEvent.click(screen.getByRole("button", { name: "Salvar no arquivo" }));

    await waitFor(() => expect(writeTags).toHaveBeenCalledTimes(1));
    expect(writeTags.mock.calls[0][4]).toBe(MUITOS.join("; "));
  });
});

// ---------------------------------------------------------------------------
// V10.11 — ENTER NO CAMPO DE TEMA SALVA O FORMULÁRIO INTEIRO.
//
// Relato dos beta testers: a pessoa digita um tema e sai usando o aplicativo,
// sem clicar em "Salvar no arquivo" — e perde o que digitou.
//
// A alternativa "Enter salva só o tema" foi RECUSADA pelo dono: meia tela
// salvando sozinha é pior que nenhuma. Quem corrige o título, digita um tema,
// aperta Enter e fecha ficaria com o tema no arquivo e o título perdido, e
// nada na tela diria que só metade foi.
// ---------------------------------------------------------------------------
describe("EditSongForm — Enter no campo de tema (V10.11)", () => {
  let writeTags: ReturnType<typeof vi.fn>;

  const COM_TEMAS: Song = { ...song(1, true), temas: "água; esperança" };

  function montar() {
    writeTags = vi.fn(async () => COM_TEMAS);
    setBackendForTests({
      getLyrics: vi.fn(async () => LYRICS),
      writeTags,
      transcricaoPendentesDaMusica: vi.fn(async () => ({
        musicas: [],
        segundos_estimados: 0,
        estimativa_medida_nesta_maquina: false,
        disponivel: true,
      })),
    } as unknown as Backend);
    useLibraryStore.setState({
      results: [{ song: COM_TEMAS, snippet: null }],
      selectedSongId: 1,
    });
    render(<LyricsPanel />);
  }

  async function editar() {
    montar();
    await screen.findByTestId("lyrics-body");
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
  }

  function enter(valor: string) {
    const input = screen.getByPlaceholderText("Adicionar tema");
    fireEvent.change(input, { target: { value: valor } });
    fireEvent.keyDown(input, { key: "Enter" });
  }

  beforeEach(() => {
    useEnrichStore.setState({ status: "idle", scanInFlight: false });
    useToastStore.setState({ toasts: [] });
    usePlaylistStore.setState({ items: [], activePlaylistId: null });
    usePlayerStore.setState({ current: null, isPlaying: false });
  });

  /*
    O CHIP ENTRA NA GRAVAÇÃO — e é este o assert inteiro do conserto. Salvar o
    estado de ANTES do Enter gravaria a ficha sem o tema que a pessoa acabou de
    digitar, que é o mesmo prejuízo com uma cara nova.
  */
  it("grava a ficha inteira, com o tema recém-digitado dentro", async () => {
    await editar();
    fireEvent.change(screen.getByLabelText("Título"), {
      target: { value: "Título Corrigido" },
    });
    enter("peregrinação");

    await waitFor(() => expect(writeTags).toHaveBeenCalledTimes(1));
    expect(writeTags).toHaveBeenCalledWith(
      1,
      "Título Corrigido",
      "Artista Teste",
      LYRICS,
      "água; esperança; peregrinação",
      undefined,
      null,
    );
    // uma gravação SÓ: o chip e a ficha não são dois writes
    expect(writeTags).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(useToastStore.getState().toasts).toEqual([
        expect.objectContaining({
          message: "Alterações salvas em 1.mp3.",
          kind: "success",
        }),
      ]),
    );
  });

  /*
    CAMPO VAZIO TAMBÉM SALVA, e é uma regra sem exceção invisível: Enter aqui
    grava a ficha. "Enter só funciona se você tiver digitado algo" é a regra que
    faz alguém apertar, não ver nada acontecer e não ter a quem perguntar — e o
    que acontece é exatamente o que o botão ao lado faz.
  */
  it("com o campo de tema vazio, Enter salva a ficha do mesmo jeito", async () => {
    await editar();
    fireEvent.change(screen.getByLabelText("Título"), {
      target: { value: "Só o título mudou" },
    });
    enter("");

    await waitFor(() => expect(writeTags).toHaveBeenCalledTimes(1));
    expect(writeTags.mock.calls[0][1]).toBe("Só o título mudou");
    // e os temas continuam os que estavam lá: campo vazio não cria chip nenhum
    expect(writeTags.mock.calls[0][4]).toBe("água; esperança");
  });

  /*
    A MESMA RECUSA DO BOTÃO: título vazio não grava, e a mensagem é a de sempre.
    Enter é o mesmo caminho, e não um segundo com regras próprias — mas o tema
    digitado vira chip do mesmo jeito (BUG v0.4 vale inclusive quando o título
    inválido aborta o save).
  */
  it("título vazio: Enter não grava, e o tema digitado não se perde", async () => {
    await editar();
    fireEvent.change(screen.getByLabelText("Título"), { target: { value: "  " } });
    enter("advento");

    expect(writeTags).not.toHaveBeenCalled();
    expect(screen.getByText("Dê um título à música.")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Remover tema advento" }),
    ).toBeInTheDocument();
  });

  /*
    A MÚSICA TOCANDO É PAUSADA ANTES DE GRAVAR — no Windows o arquivo pode estar
    em uso. É a regra do "Salvar no arquivo" desde a V4, e Enter a herda porque
    é o MESMO caminho, e não uma cópia dele.
  */
  it("pausa a música em edição antes de gravar, como o botão faz", async () => {
    await editar();
    act(() =>
      usePlayerStore.setState({ current: COM_TEMAS, isPlaying: true }),
    );
    enter("cura");

    await waitFor(() => expect(writeTags).toHaveBeenCalledTimes(1));
    expect(usePlayerStore.getState().isPlaying).toBe(false);
  });

  /*
    SE A GRAVAÇÃO FALHAR, A PESSOA VÊ O ERRO COMO VÊ HOJE — mesmo toast, mesmo
    texto — e o formulário continua aberto com o que ela digitou.
  */
  it("gravação recusada: o toast de erro é o mesmo, e nada se perde da tela", async () => {
    await editar();
    writeTags.mockRejectedValueOnce(new Error("arquivo em uso"));
    enter("louvor");

    await waitFor(() =>
      expect(useToastStore.getState().toasts).toEqual([
        expect.objectContaining({
          message: "Não foi possível salvar em 1.mp3.",
          kind: "error",
        }),
      ]),
    );
    expect(screen.getByLabelText("Título")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Remover tema louvor" }),
    ).toBeInTheDocument();
  });

  /*
    A DICA APARECE NO SEGUNDO EM QUE A PERGUNTA EXISTE. Enter que GRAVA NO
    ARQUIVO é surpreendente demais para ficar só num `title` de mouse parado —
    e uma linha permanente seria a prosa que a DECISIONS #100 proíbe.
  */
  it("a dica só aparece enquanto há texto no campo de tema", async () => {
    await editar();
    const DICA = "Enter confirma este tema e salva a ficha inteira no arquivo.";
    expect(screen.queryByText(DICA)).not.toBeInTheDocument();

    const input = screen.getByPlaceholderText("Adicionar tema");
    fireEvent.change(input, { target: { value: "nat" } });
    expect(screen.getByText(DICA)).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "" } });
    expect(screen.queryByText(DICA)).not.toBeInTheDocument();
  });
});
