import { fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { audioController } from "../hooks/playerAudioCore";
import {
  setBackendForTests,
  type Backend,
  type EnrichApply,
  type EnrichApplyResult,
  type EnrichProgress,
  type EnrichProposal,
} from "../lib/api";
import { textoAplicado, textoSemPropostas } from "../lib/curadoria";
import type { Song } from "../lib/types";
import { useEnrichStore } from "../stores/enrichStore";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlayerStore } from "../stores/playerStore";
import { usePlaylistStore } from "../stores/playlistStore";
import { useToastStore } from "../stores/toastStore";
import { EnrichReview } from "./EnrichReview";

function song(id: number, title: string): Song {
  return {
    id,
    file_path: `/acervo/${id}.mp3`,
    folder_id: 1,
    title,
    artist: null,
    album: null,
    duration_seconds: 3,
    has_lyrics: false,
    available: true,
    temas: null,
  };
}

function proposal(overrides: Partial<EnrichProposal>): EnrichProposal {
  return {
    song_id: 1,
    file_path: "/acervo/1.mp3",
    current_title: "faixa 1",
    current_artist: null,
    proposed_title: "Faixa Um",
    proposed_artist: "Artista Um",
    lyrics: "letra da um",
    confidence: "alta",
    fonte: "LRCLIB",
    error: null,
    ...overrides,
  };
}

const ALTA = proposal({
  song_id: 1,
  file_path: "/acervo/1.mp3",
  current_title: "faixa 1",
  confidence: "alta",
});
const MEDIA = proposal({
  song_id: 2,
  file_path: "/acervo/2.mp3",
  current_title: "faixa 2",
  current_artist: "Alguém",
  proposed_title: "Faixa Dois",
  proposed_artist: "Artista Dois",
  lyrics: "letra da dois",
  confidence: "media",
});
const BAIXA = proposal({
  song_id: 3,
  file_path: "/acervo/3.mp3",
  current_title: "faixa 3",
  proposed_title: "Faixa Três",
  proposed_artist: null,
  lyrics: null,
  confidence: "baixa",
});
const COM_ERRO = proposal({
  song_id: 4,
  file_path: "/acervo/4.mp3",
  current_title: "faixa 4",
  proposed_title: "faixa 4",
  proposed_artist: null,
  lyrics: null,
  confidence: "baixa",
  error: "sem conexão",
});

function ok(song: Song): EnrichApplyResult {
  return { song_id: song.id, song, error: null };
}

function failed(songId: number, error: string): EnrichApplyResult {
  return { song_id: songId, song: null, error };
}

function renderReview(proposals: EnrichProposal[], scannedTotal = 0) {
  useEnrichStore.setState({
    status: "review",
    overlayOpen: true,
    folderPrefix: "",
    proposals,
    progress: null,
    scannedTotal,
    applyErrors: {},
  });
  return render(<EnrichReview />);
}

function progresso(
  p: Omit<EnrichProgress, "scan_id"> | null,
): EnrichProgress | null {
  return p === null ? null : { ...p, scan_id: "scan-1" };
}

function renderScanning(progress: Omit<EnrichProgress, "scan_id"> | null = null) {
  useEnrichStore.setState({
    status: "scanning",
    overlayOpen: true,
    folderPrefix: "/x",
    proposals: [],
    progress: progresso(progress),
    scanId: "scan-1",
    scannedTotal: 0,
    applyErrors: {},
  });
  return render(<EnrichReview />);
}

describe("EnrichReview (V5 — F13)", () => {
  beforeEach(() => {
    setBackendForTests(null);
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
    useToastStore.setState({ toasts: [] });
    useLibraryStore.setState({ allSongs: [], results: [] });
    usePlaylistStore.setState({ playlists: [], activePlaylistId: null, items: [] });
    usePlayerStore.setState({
      current: null,
      queue: [],
      queueIndex: null,
      detached: false,
      playlistId: null,
      isPlaying: false,
    });
  });

  it("não renderiza nada quando idle", () => {
    const { container } = render(<EnrichReview />);
    expect(container).toBeEmptyDOMElement();
  });

  it("não renderiza nada quando a revisão está em segundo plano (overlay fechado)", () => {
    useEnrichStore.setState({
      status: "review",
      overlayOpen: false,
      folderPrefix: "",
      proposals: [ALTA],
      progress: null,
    });
    const { container } = render(<EnrichReview />);
    expect(container).toBeEmptyDOMElement();
  });

  it("antes do primeiro evento de progresso mantém o aviso indeterminado", () => {
    renderScanning(null);
    expect(
      screen.getByText("Buscando dados… isso pode demorar alguns minutos."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("com progresso mostra barra determinada, contagem e o arquivo atual", () => {
    renderScanning({
      done: 12,
      total: 94,
      atual: "Fulano - Canção.mp3",
      etapa: "procurando no LRCLIB",
    });
    expect(screen.getByText("Buscando dados… 12 de 94")).toBeInTheDocument();
    expect(screen.getByText("Fulano - Canção.mp3")).toBeInTheDocument();
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "12");
    expect(bar).toHaveAttribute("aria-valuemax", "94");
    expect(
      screen.queryByText("Buscando dados… isso pode demorar alguns minutos."),
    ).not.toBeInTheDocument();
  });

  it("nome de arquivo comprido é truncado (não quebra o layout)", () => {
    const atual = `${"nome muito comprido ".repeat(20)}.mp3`;
    renderScanning({ done: 1, total: 2, atual, etapa: "procurando no LRCLIB" });
    expect(screen.getByText(atual).className).toContain("truncate");
  });

  // V8/F18 — "progresso com contagem e barra, a ETAPA atual do funil e o
  // arquivo do momento". Sem a etapa, minutos parados no mesmo número
  // parecem travamento.
  it("mostra a etapa do funil junto da contagem e do arquivo", () => {
    renderScanning({
      done: 25,
      total: 95,
      atual: "a.mp3",
      etapa: "procurando no Vagalume",
    });
    expect(screen.getByText("Etapa: procurando no Vagalume")).toBeInTheDocument();
    expect(screen.getByText("Buscando dados… 25 de 95")).toBeInTheDocument();
  });

  it("backend sem etapa: a linha da etapa some, o resto continua", () => {
    renderScanning({ done: 25, total: 95, atual: "a.mp3", etapa: "" });
    expect(screen.queryByText(/^Etapa:/)).not.toBeInTheDocument();
    expect(screen.getByText("Buscando dados… 25 de 95")).toBeInTheDocument();
  });

  it("'Deixar rodando em segundo plano' esconde o overlay e NÃO cancela a varredura", () => {
    renderScanning({
      done: 3,
      total: 10,
      atual: "a.mp3",
      etapa: "procurando no LRCLIB",
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Deixar rodando em segundo plano" }),
    );
    expect(useEnrichStore.getState().overlayOpen).toBe(false);
    expect(useEnrichStore.getState().status).toBe("scanning");
  });

  it("'Cancelar' durante a varredura descarta tudo e volta a idle", () => {
    renderScanning({
      done: 3,
      total: 10,
      atual: "a.mp3",
      etapa: "procurando no LRCLIB",
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(useEnrichStore.getState().status).toBe("idle");
    expect(useEnrichStore.getState().overlayOpen).toBe(false);
  });

  it("resultado vazio SEM candidatas: diz que não havia nada incompleto, com Fechar", () => {
    renderReview([], 0);
    expect(screen.getByText(textoSemPropostas(0))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Fechar" }));
    expect(useEnrichStore.getState().status).toBe("idle");
  });

  // A6: 94 conferidas, zero achadas. "Nada a ajustar" fazia o coordenador
  // ler "pasta completa" — o texto tem que dizer o que aconteceu de verdade.
  it("resultado vazio COM candidatas: diz quantas foram conferidas e aponta a transcrição", () => {
    renderReview([], 81);
    expect(screen.getByText(textoSemPropostas(81))).toBeInTheDocument();
    expect(screen.queryByText(textoSemPropostas(0))).not.toBeInTheDocument();
  });

  it("resultado vazio com UMA candidata: texto no singular", () => {
    renderReview([], 1);
    expect(screen.getByText(textoSemPropostas(1))).toBeInTheDocument();
  });

  it("header com contadores por confiança", () => {
    renderReview([ALTA, MEDIA, BAIXA, COM_ERRO]);
    expect(
      screen.getByText("4 propostas — 1 alta, 1 média, 2 baixa"),
    ).toBeInTheDocument();
  });

  it("header no singular quando sobra uma proposta só", () => {
    renderReview([ALTA]);
    expect(
      screen.getByText("1 proposta — 1 alta, 0 média, 0 baixa"),
    ).toBeInTheDocument();
  });

  it("ALTA vem pré-marcada; MÉDIA e BAIXA desmarcadas; linha com erro desabilitada", () => {
    renderReview([ALTA, MEDIA, BAIXA, COM_ERRO]);
    expect(screen.getByRole("checkbox", { name: /faixa 1/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /faixa 2/ })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /faixa 3/ })).not.toBeChecked();
    const errored = screen.getByRole("checkbox", { name: /faixa 4/ });
    expect(errored).not.toBeChecked();
    expect(errored).toBeDisabled();
    expect(screen.getByText("sem conexão")).toBeInTheDocument();
  });

  it("mostra badges de confiança em maiúsculas e o indicador de letra", () => {
    renderReview([ALTA, MEDIA, BAIXA]);
    expect(screen.getByText("ALTA")).toBeInTheDocument();
    expect(screen.getByText("MÉDIA")).toBeInTheDocument();
    expect(screen.getByText("BAIXA")).toBeInTheDocument();
    // ALTA e MÉDIA têm letra; BAIXA não
    expect(screen.getAllByText("letra encontrada")).toHaveLength(2);
    // atual → proposto
    expect(screen.getByText(/Faixa Dois — Artista Dois/)).toBeInTheDocument();
  });

  // V8/F18 — a MESMA confiança significa coisas diferentes vindo do LRCLIB
  // (com duração conferida) ou de um palpite de nome de arquivo. Quem decide
  // precisa ver a procedência sem abrir nada.
  it("cada linha mostra de onde o dado veio", () => {
    renderReview([
      proposal({ song_id: 1, current_title: "faixa 1", fonte: "LRCLIB" }),
      proposal({
        song_id: 2,
        current_title: "faixa 2",
        lyrics: null,
        confidence: "baixa",
        fonte: "nome do arquivo",
      }),
    ]);
    expect(screen.getByText("via LRCLIB")).toBeInTheDocument();
    expect(screen.getByText("via nome do arquivo")).toBeInTheDocument();
  });

  it("linha com erro mostra o erro, não a procedência", () => {
    renderReview([COM_ERRO]);
    expect(screen.getByText("sem conexão")).toBeInTheDocument();
    expect(screen.queryByText(/^via /)).not.toBeInTheDocument();
  });

  it("BAIXA é marcável (quem decide é o humano)", () => {
    renderReview([BAIXA]);
    const checkbox = screen.getByRole("checkbox", { name: /faixa 3/ });
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();
    expect(
      screen.getByRole("button", { name: "Aplicar selecionadas (1)" }),
    ).toBeEnabled();
  });

  it("Marcar todas marca só as linhas sem erro; Desmarcar todas zera", () => {
    renderReview([ALTA, MEDIA, BAIXA, COM_ERRO]);
    fireEvent.click(screen.getByRole("button", { name: "Marcar todas" }));
    expect(screen.getByRole("checkbox", { name: /faixa 1/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /faixa 2/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /faixa 3/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /faixa 4/ })).not.toBeChecked();
    expect(
      screen.getByRole("button", { name: "Aplicar selecionadas (3)" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Desmarcar todas" }));
    expect(screen.getByRole("checkbox", { name: /faixa 1/ })).not.toBeChecked();
    expect(
      screen.getByRole("button", { name: "Aplicar selecionadas (0)" }),
    ).toBeDisabled();
  });

  it("aplicar monta o payload nunca-apaga (?? null) só com as selecionadas", async () => {
    const enrichApply = vi.fn(async (aplicacoes: EnrichApply[]) =>
      aplicacoes.map((a) => ok(song(a.song_id, a.title))),
    );
    setBackendForTests({ enrichApply } as unknown as Backend);
    renderReview([ALTA, MEDIA, BAIXA, COM_ERRO]);

    // seleção: ALTA (pré) + BAIXA (manual); MÉDIA fica de fora
    fireEvent.click(screen.getByRole("checkbox", { name: /faixa 3/ }));
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Aplicar selecionadas (2)" }),
      );
    });

    expect(enrichApply).toHaveBeenCalledTimes(1);
    // current_title/current_artist viajam junto (A5): o backend recusa a
    // proposta cuja música mudou depois da varredura
    expect(enrichApply).toHaveBeenCalledWith([
      {
        song_id: 1,
        title: "Faixa Um",
        artist: "Artista Um",
        lyrics: "letra da um",
        add_temas: null,
        current_title: "faixa 1",
        current_artist: null,
        // V8/F18 — a procedência ecoa a proposta: é ela que decide o
        // TXXX:LETRA_ORIGEM gravado pelo writer
        fonte: "LRCLIB",
      },
      {
        song_id: 3,
        title: "Faixa Três",
        artist: null,
        lyrics: null,
        add_temas: null,
        current_title: "faixa 3",
        current_artist: null,
        fonte: "LRCLIB",
      },
    ]);
  });

  it("sucesso de 1: o aviso diz o que MUDOU, sincroniza stores e fecha", async () => {
    const updated: Song = {
      ...song(1, "Faixa Um"),
      artist: "Artista Um",
      has_lyrics: true,
    };
    setBackendForTests({
      enrichApply: vi.fn(async () => [ok(updated)]),
    } as unknown as Backend);

    const before = song(1, "faixa 1");
    useLibraryStore.setState({
      allSongs: [before],
      results: [{ song: before, snippet: null }],
    });
    usePlaylistStore.setState({
      items: [{ id: 10, playlist_id: 5, position: 0, song: before }],
    });
    usePlayerStore.setState({ current: before, queue: [before], queueIndex: 0 });

    renderReview([ALTA]);
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Aplicar selecionadas (1)" }),
      );
    });

    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toBe(textoAplicado(1, 0, 1));
    expect(toasts[0].kind).toBe("success");
    // pós-save igual ao EditSongForm: library + playlist + player
    expect(useLibraryStore.getState().allSongs[0].title).toBe("Faixa Um");
    expect(useLibraryStore.getState().results[0].song.title).toBe("Faixa Um");
    expect(usePlaylistStore.getState().items[0].song.title).toBe("Faixa Um");
    expect(usePlayerStore.getState().current?.title).toBe("Faixa Um");
    expect(useEnrichStore.getState().status).toBe("idle");
  });

  it("sucesso de várias: o aviso conta quantas ganharam letra", async () => {
    setBackendForTests({
      enrichApply: vi.fn(async (aplicacoes: EnrichApply[]) =>
        aplicacoes.map((a) => ok(song(a.song_id, a.title))),
      ),
    } as unknown as Backend);

    renderReview([ALTA, MEDIA]);
    fireEvent.click(screen.getByRole("checkbox", { name: /faixa 2/ }));
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Aplicar selecionadas (2)" }),
      );
    });

    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toBe(textoAplicado(2, 0, 2));
    expect(toasts[0].kind).toBe("success");
    expect(useEnrichStore.getState().status).toBe("idle");
  });

  it("falha parcial: sincroniza as gravadas e MANTÉM na tela só a que falhou, com o erro", async () => {
    const gravada: Song = { ...song(1, "Faixa Um"), artist: "Artista Um" };
    setBackendForTests({
      enrichApply: vi.fn(async () => [
        ok(gravada),
        failed(2, "arquivo não encontrado: /acervo/2.mp3"),
      ]),
    } as unknown as Backend);

    const before = song(1, "faixa 1");
    useLibraryStore.setState({
      allSongs: [before, song(2, "faixa 2")],
      results: [{ song: before, snippet: null }],
    });

    renderReview([ALTA, MEDIA]);
    fireEvent.click(screen.getByRole("checkbox", { name: /faixa 2/ }));
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Aplicar selecionadas (2)" }),
      );
    });

    // a gravada sincroniza MESMO com outra falhando
    expect(useLibraryStore.getState().allSongs[0].title).toBe("Faixa Um");
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(2);
    expect(toasts[0].message).toBe(textoAplicado(1, 0, 1));
    expect(toasts[0].kind).toBe("success");
    expect(toasts[1].message).toBe("1 não pôde ser gravada.");
    expect(toasts[1].kind).toBe("error");
    // A5: a recusada NÃO some de vista — some quem gravou
    expect(useEnrichStore.getState().status).toBe("review");
    expect(
      screen.getByText("arquivo não encontrado: /acervo/2.mp3"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("checkbox", { name: /faixa 1/ }),
    ).not.toBeInTheDocument();
    const restante = screen.getByRole("checkbox", { name: /faixa 2/ });
    expect(restante).toBeDisabled();
    expect(restante).not.toBeChecked();
  });

  // A5: o backend recusa a proposta cuja música mudou depois da varredura —
  // aplicar não pode reverter em silêncio a edição manual do usuário.
  it("proposta recusada por estar velha: fica visível com o erro e conta no toast", async () => {
    const gravada: Song = { ...song(1, "Faixa Um"), artist: "Artista Um" };
    setBackendForTests({
      enrichApply: vi.fn(async () => [
        ok(gravada),
        failed(
          2,
          'a música mudou depois da busca ("Nome Editado") — refaça a busca',
        ),
      ]),
    } as unknown as Backend);

    renderReview([ALTA, MEDIA]);
    fireEvent.click(screen.getByRole("checkbox", { name: /faixa 2/ }));
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Aplicar selecionadas (2)" }),
      );
    });

    const toasts = useToastStore.getState().toasts;
    expect(toasts[1].message).toBe("1 não pôde ser gravada.");
    expect(
      screen.getByText(
        'a música mudou depois da busca ("Nome Editado") — refaça a busca',
      ),
    ).toBeInTheDocument();
    // mesmo tratamento visual das linhas com erro da varredura
    expect(screen.getByRole("checkbox", { name: /faixa 2/ })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Aplicar selecionadas (0)" }),
    ).toBeDisabled();
  });

  it("TODAS falharam: só toast de erro, overlay aberto, linhas marcadas com o erro e desmarcadas", async () => {
    setBackendForTests({
      enrichApply: vi.fn(async () => [
        failed(1, "arquivo não encontrado: /acervo/1.mp3"),
        failed(2, "arquivo não encontrado: /acervo/2.mp3"),
      ]),
    } as unknown as Backend);

    renderReview([ALTA, MEDIA]);
    fireEvent.click(screen.getByRole("checkbox", { name: /faixa 2/ }));
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Aplicar selecionadas (2)" }),
      );
    });

    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toBe("2 não puderam ser gravadas.");
    expect(toasts[0].kind).toBe("error");
    // overlay continua aberto para o usuário ver as linhas com erro
    expect(useEnrichStore.getState().status).toBe("review");
    expect(
      screen.getByText("arquivo não encontrado: /acervo/1.mp3"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("arquivo não encontrado: /acervo/2.mp3"),
    ).toBeInTheDocument();
    // linhas com erro: desmarcadas e desabilitadas (mesmo estilo das com error)
    const cb1 = screen.getByRole("checkbox", { name: /faixa 1/ });
    const cb2 = screen.getByRole("checkbox", { name: /faixa 2/ });
    expect(cb1).not.toBeChecked();
    expect(cb1).toBeDisabled();
    expect(cb2).not.toBeChecked();
    expect(cb2).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Aplicar selecionadas (0)" }),
    ).toBeDisabled();
  });

  it("pausa o áudio antes de aplicar quando a música tocando está entre as selecionadas", async () => {
    const pauseSpy = vi.spyOn(audioController, "pause");
    setBackendForTests({
      enrichApply: vi.fn(async () => [ok(song(1, "Faixa Um"))]),
    } as unknown as Backend);
    usePlayerStore.setState({ current: song(1, "faixa 1"), isPlaying: true });

    renderReview([ALTA]);
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Aplicar selecionadas (1)" }),
      );
    });

    expect(pauseSpy).toHaveBeenCalled();
    expect(usePlayerStore.getState().isPlaying).toBe(false);
    pauseSpy.mockRestore();
  });

  it("não pausa quando a música tocando NÃO está entre as selecionadas", async () => {
    const pauseSpy = vi.spyOn(audioController, "pause");
    setBackendForTests({
      enrichApply: vi.fn(async () => [ok(song(1, "Faixa Um"))]),
    } as unknown as Backend);
    usePlayerStore.setState({ current: song(99, "outra"), isPlaying: true });

    renderReview([ALTA]);
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Aplicar selecionadas (1)" }),
      );
    });

    expect(pauseSpy).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().isPlaying).toBe(true);
    pauseSpy.mockRestore();
  });

  it("invoke rejeitado (erro de infraestrutura): toast genérico e a revisão continua aberta", async () => {
    setBackendForTests({
      enrichApply: vi.fn(async () => {
        throw new Error("falhou");
      }),
    } as unknown as Backend);
    renderReview([ALTA]);
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Aplicar selecionadas (1)" }),
      );
    });
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].kind).toBe("error");
    expect(useEnrichStore.getState().status).toBe("review");
  });

  it("Fechar na revisão fecha o overlay", () => {
    renderReview([ALTA]);
    fireEvent.click(screen.getByRole("button", { name: "Fechar" }));
    expect(useEnrichStore.getState().status).toBe("idle");
  });

  describe("modal: Esc e foco (QA achado 3)", () => {
    it("Esc fecha o overlay na revisão", () => {
      renderReview([ALTA]);
      fireEvent.keyDown(window, { key: "Escape" });
      expect(useEnrichStore.getState().status).toBe("idle");
    });

    it("Esc DURANTE a varredura manda para segundo plano (não cancela)", () => {
      renderScanning({
        done: 1,
        total: 5,
        atual: "a.mp3",
        etapa: "procurando no LRCLIB",
      });
      fireEvent.keyDown(window, { key: "Escape" });
      expect(useEnrichStore.getState().overlayOpen).toBe(false);
      expect(useEnrichStore.getState().status).toBe("scanning");
    });

    it("o foco inicial entra no diálogo (botão Fechar) ao abrir", () => {
      renderReview([ALTA]);
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Fechar" }),
      );
    });

    // M7: sem isso o Esc largava o foco no <body> e o teclado voltava do zero
    it("ao fechar, o foco volta para quem abriu o overlay", () => {
      const abridor = document.createElement("button");
      abridor.textContent = "✎";
      document.body.appendChild(abridor);
      abridor.focus();

      const { rerender } = renderReview([ALTA]);
      expect(document.activeElement).not.toBe(abridor);

      fireEvent.keyDown(window, { key: "Escape" });
      rerender(<EnrichReview />);
      expect(document.activeElement).toBe(abridor);
      abridor.remove();
    });

    it("mandar para segundo plano também devolve o foco", () => {
      const abridor = document.createElement("button");
      document.body.appendChild(abridor);
      abridor.focus();

      const { rerender } = renderScanning({
   done: 1,
   total: 5,
   atual: "a.mp3",
   etapa: "procurando no LRCLIB",
 });
      fireEvent.click(
        screen.getByRole("button", { name: "Deixar rodando em segundo plano" }),
      );
      rerender(<EnrichReview />);
      expect(document.activeElement).toBe(abridor);
      abridor.remove();
    });

    it("quem abriu saiu do DOM: fechar não quebra", () => {
      const abridor = document.createElement("button");
      document.body.appendChild(abridor);
      abridor.focus();

      const { rerender } = renderReview([ALTA]);
      abridor.remove();
      fireEvent.keyDown(window, { key: "Escape" });
      expect(() => rerender(<EnrichReview />)).not.toThrow();
    });

    // M6: role="status" em volta do contador + barra + nome do arquivo fazia
    // uma varredura de 94 músicas ser anunciada ~94 vezes, com nome de arquivo.
    it("o nome do arquivo em processamento NÃO fica dentro de região viva", () => {
      renderScanning({
        done: 12,
        total: 94,
        atual: "Fulano - Canção.mp3",
        etapa: "procurando no LRCLIB",
      });
      const arquivo = screen.getByText("Fulano - Canção.mp3");
      expect(arquivo.closest("[role='status']")).toBeNull();
      expect(arquivo.closest("[aria-live]")).toBeNull();
      expect(
        screen.getByText("Buscando dados… 12 de 94").closest("[role='status']"),
      ).toBeNull();
      // a barra continua contando a história para a tecnologia assistiva
      expect(screen.getByRole("progressbar")).toHaveAttribute(
        "aria-valuenow",
        "12",
      );
    });

    it("a região viva anuncia só as transições: início e fim da varredura", () => {
      const { rerender } = renderScanning({
   done: 1,
   total: 94,
   atual: "a.mp3",
   etapa: "procurando no LRCLIB",
 });
      const regiao = screen.getByRole("status");
      expect(regiao).toHaveTextContent(
        "A busca de dados começou. Isso pode demorar alguns minutos.",
      );

      // eventos de progresso não mexem no que é anunciado
      act(() => {
        useEnrichStore.setState({
          progress: { done: 2, total: 94, atual: "b.mp3", etapa: "procurando no LRCLIB", scan_id: "scan-1" },
        });
      });
      expect(screen.getByRole("status")).toHaveTextContent(
        "A busca de dados começou. Isso pode demorar alguns minutos.",
      );

      act(() => {
        useEnrichStore.setState({
          status: "review",
          proposals: [ALTA, MEDIA],
          progress: null,
        });
      });
      rerender(<EnrichReview />);
      expect(screen.getByRole("status")).toHaveTextContent(
        "Busca concluída. 2 propostas para revisar.",
      );
    });

    it("varredura sem resultado: a região viva conta o desfecho honesto", () => {
      renderReview([], 81);
      expect(screen.getByRole("status")).toHaveTextContent(
        "Busca concluída. Conferimos as 81 músicas incompletas desta pasta",
      );
    });

    it("Tab no último elemento volta ao primeiro (focus trap); Shift+Tab no primeiro vai ao último", () => {
      renderReview([ALTA]);
      const dialog = screen.getByRole("dialog", { name: "Completar dados" });
      const first = screen.getByRole("button", { name: "Marcar todas" });
      const last = screen.getByRole("button", {
        name: "Aplicar selecionadas (1)",
      });

      last.focus();
      fireEvent.keyDown(dialog, { key: "Tab" });
      expect(document.activeElement).toBe(first);

      first.focus();
      fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
      expect(document.activeElement).toBe(last);
    });
  });
});
