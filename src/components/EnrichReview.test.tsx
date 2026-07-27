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

function renderReview(proposals: EnrichProposal[]) {
  useEnrichStore.setState({
    status: "review",
    overlayOpen: true,
    folderPrefix: "",
    proposals,
    progress: null,
  });
  return render(<EnrichReview />);
}

function renderScanning(progress: EnrichProgress | null = null) {
  useEnrichStore.setState({
    status: "scanning",
    overlayOpen: true,
    folderPrefix: "/x",
    proposals: [],
    progress,
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
    renderScanning({ done: 12, total: 94, atual: "Fulano - Canção.mp3" });
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
    renderScanning({ done: 1, total: 2, atual });
    expect(screen.getByText(atual).className).toContain("truncate");
  });

  it("'Deixar rodando em segundo plano' esconde o overlay e NÃO cancela a varredura", () => {
    renderScanning({ done: 3, total: 10, atual: "a.mp3" });
    fireEvent.click(
      screen.getByRole("button", { name: "Deixar rodando em segundo plano" }),
    );
    expect(useEnrichStore.getState().overlayOpen).toBe(false);
    expect(useEnrichStore.getState().status).toBe("scanning");
  });

  it("'Cancelar' durante a varredura descarta tudo e volta a idle", () => {
    renderScanning({ done: 3, total: 10, atual: "a.mp3" });
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(useEnrichStore.getState().status).toBe("idle");
    expect(useEnrichStore.getState().overlayOpen).toBe(false);
  });

  it("resultado vazio: 'Nada a ajustar nesta pasta.' com Fechar", () => {
    renderReview([]);
    expect(screen.getByText("Nada a ajustar nesta pasta.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Fechar" }));
    expect(useEnrichStore.getState().status).toBe("idle");
  });

  it("header com contadores por confiança", () => {
    renderReview([ALTA, MEDIA, BAIXA, COM_ERRO]);
    expect(
      screen.getByText("4 propostas — 1 alta, 1 média, 2 baixa"),
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
    expect(enrichApply).toHaveBeenCalledWith([
      {
        song_id: 1,
        title: "Faixa Um",
        artist: "Artista Um",
        lyrics: "letra da um",
        add_temas: null,
      },
      {
        song_id: 3,
        title: "Faixa Três",
        artist: null,
        lyrics: null,
        add_temas: null,
      },
    ]);
  });

  it("sucesso de 1: toast SINGULAR '1 música atualizada.', sincroniza stores e fecha", async () => {
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
    expect(toasts[0].message).toBe("1 música atualizada.");
    expect(toasts[0].kind).toBe("success");
    // pós-save igual ao EditSongForm: library + playlist + player
    expect(useLibraryStore.getState().allSongs[0].title).toBe("Faixa Um");
    expect(useLibraryStore.getState().results[0].song.title).toBe("Faixa Um");
    expect(usePlaylistStore.getState().items[0].song.title).toBe("Faixa Um");
    expect(usePlayerStore.getState().current?.title).toBe("Faixa Um");
    expect(useEnrichStore.getState().status).toBe("idle");
  });

  it("sucesso de várias: toast PLURAL 'N músicas atualizadas.'", async () => {
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
    expect(toasts[0].message).toBe("2 músicas atualizadas.");
    expect(toasts[0].kind).toBe("success");
    expect(useEnrichStore.getState().status).toBe("idle");
  });

  it("falha parcial: sincroniza as gravadas, toast de sucesso + toast de erro e fecha", async () => {
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
    expect(toasts[0].message).toBe("1 música atualizada.");
    expect(toasts[0].kind).toBe("success");
    expect(toasts[1].message).toBe("1 não pôde ser gravada.");
    expect(toasts[1].kind).toBe("error");
    // ao menos uma gravou: fecha
    expect(useEnrichStore.getState().status).toBe("idle");
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
      renderScanning({ done: 1, total: 5, atual: "a.mp3" });
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
