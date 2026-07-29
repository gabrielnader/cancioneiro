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
import {
  AVISO_NOME_ESCRITO,
  LABEL_SOM_DIZ,
  LABEL_SUA_ETIQUETA_DIZ,
  LABEL_SUBSTITUIR_LETRA,
  avisoLetraExistente,
  avisoSemPerguntarAoSom,
  rotuloAceitarSom,
  textoAplicado,
  textoSemPropostas,
} from "../lib/curadoria";
import type { Modo, Song } from "../lib/types";
import { useEnrichStore } from "../stores/enrichStore";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlayerStore } from "../stores/playerStore";
import { usePlaylistStore } from "../stores/playlistStore";
import { useToastStore } from "../stores/toastStore";
import { AA_TEXTO_NORMAL, contrastRatio, corDoTexto } from "../test/contrast";
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
    // por padrão a música NÃO tem letra: a proposta acrescenta
    has_lyrics: false,
    letra_origem: null,
    // V9 — dois avisos novos, ORTOGONAIS entre si e desligados por padrão
    conflito: null,
    substitui_nome_escrito: false,
    error: null,
    ...overrides,
  };
}

/**
 * O caso do CRÍTICO-1: a varredura achou letra para uma música que JÁ TEM
 * letra — e uma escrita ouvindo o áudio, corrigida à mão.
 */
const SOBRE_TRANSCRICAO = proposal({
  song_id: 5,
  file_path: "/acervo/5.mp3",
  current_title: "AudioTrack 03",
  current_artist: null,
  proposed_title: "Oh! Chuva",
  proposed_artist: "Falamansa",
  lyrics: "letra vinda do LRCLIB",
  confidence: "alta",
  has_lyrics: true,
  letra_origem: "transcricao",
});

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

function renderReview(
  proposals: EnrichProposal[],
  scannedTotal = 0,
  /** Quantas a etapa 2 deixou de perguntar (QA A2) — zero é o caso normal. */
  semPerguntarAoSom = 0,
  modo: Modo = "completar",
) {
  useEnrichStore.setState({
    status: "review",
    overlayOpen: true,
    folderPrefix: "",
    proposals,
    progress: null,
    scannedTotal,
    semPerguntarAoSom,
    modo,
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
    expect(screen.getByText(textoSemPropostas(0, "completar"))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Fechar" }));
    expect(useEnrichStore.getState().status).toBe("idle");
  });

  // A6: 94 conferidas, zero achadas. "Nada a ajustar" fazia o coordenador
  // ler "pasta completa" — o texto tem que dizer o que aconteceu de verdade.
  it("resultado vazio COM candidatas: diz quantas foram conferidas e aponta a transcrição", () => {
    renderReview([], 81);
    expect(screen.getByText(textoSemPropostas(81, "completar"))).toBeInTheDocument();
    expect(screen.queryByText(textoSemPropostas(0, "completar"))).not.toBeInTheDocument();
  });

  it("resultado vazio com UMA candidata: texto no singular", () => {
    renderReview([], 1);
    expect(screen.getByText(textoSemPropostas(1, "completar"))).toBeInTheDocument();
  });

  // MÉDIO-12 — as linhas de ERRO entravam na conta por confiança: com o lote
  // inteiro falhando a pessoa lia "95 propostas — 0 alta, 0 média, 95 baixa",
  // clicava "Marcar todas" (que ignora erros) e recebia "Aplicar selecionadas
  // (0)", desabilitado, sem uma linha de explicação.
  it("header conta só as OFERTAS; as linhas com erro são ditas à parte", () => {
    renderReview([ALTA, MEDIA, BAIXA, COM_ERRO]);
    expect(
      screen.getByText("3 propostas — 1 alta, 1 média, 1 baixa"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "1 música não pôde ser consultada — o motivo está na linha dela.",
      ),
    ).toBeInTheDocument();
  });

  it("todas com erro: o header não promete proposta nenhuma", () => {
    renderReview([COM_ERRO]);
    expect(
      screen.getByText("Nenhuma proposta para aplicar."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "1 música não pôde ser consultada — o motivo está na linha dela.",
      ),
    ).toBeInTheDocument();
  });

  it("nada marcado: o botão desabilitado vem com o motivo escrito", () => {
    renderReview([MEDIA]);
    expect(
      screen.getByRole("button", { name: "Aplicar selecionadas (0)" }),
    ).toBeDisabled();
    expect(
      screen.getByText("Marque ao menos uma linha para aplicar."),
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
    expect(toasts[0].message).toBe(
      textoAplicado({
        ganharamLetra: 1,
        letraSubstituida: 0,
        nomeCorrigido: 0,
        gravadas: 1,
      }),
    );
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
    expect(toasts[0].message).toBe(
      textoAplicado({
        ganharamLetra: 2,
        letraSubstituida: 0,
        nomeCorrigido: 0,
        gravadas: 2,
      }),
    );
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
    expect(toasts[0].message).toBe(
      textoAplicado({
        ganharamLetra: 1,
        letraSubstituida: 0,
        nomeCorrigido: 0,
        gravadas: 1,
      }),
    );
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

  // -------------------------------------------------------------------------
  // CRÍTICO-1 — a revisão não sabia nem mostrava que uma letra seria destruída
  // -------------------------------------------------------------------------
  describe("proposta que substituiria uma letra existente", () => {
    it("a linha DIZ que já existe letra, e de que tipo ela é", () => {
      renderReview([SOBRE_TRANSCRICAO]);
      expect(
        screen.getByText(avisoLetraExistente("transcricao")),
      ).toBeInTheDocument();
    });

    it("música com letra sem procedência declarada: o aviso genérico", () => {
      renderReview([proposal({ has_lyrics: true, letra_origem: null })]);
      expect(screen.getByText(avisoLetraExistente(null))).toBeInTheDocument();
    });

    it("música sem letra nenhuma não ganha aviso nem marcação de substituição", () => {
      renderReview([ALTA]);
      expect(screen.queryByText(/já tem letra/)).not.toBeInTheDocument();
      expect(
        screen.queryByRole("checkbox", { name: new RegExp(LABEL_SUBSTITUIR_LETRA) }),
      ).not.toBeInTheDocument();
    });

    it("a marcação de substituir nasce DESMARCADA, mesmo em proposta ALTA pré-marcada", () => {
      renderReview([SOBRE_TRANSCRICAO]);
      // a pré-marcação de ALTA continua (DECISIONS #49) — mas agora ela só
      // aplica NOMES, e é isso que a torna segura de novo
      expect(
        screen.getByRole("checkbox", { name: /Aplicar proposta/ }),
      ).toBeChecked();
      expect(
        screen.getByRole("checkbox", { name: new RegExp(LABEL_SUBSTITUIR_LETRA) }),
      ).not.toBeChecked();
    });

    it("sem a marcação, aplicar manda lyrics: null — só título e artista", async () => {
      const enrichApply = vi.fn(async (aplicacoes: EnrichApply[]) =>
        aplicacoes.map((a) => ok(song(a.song_id, a.title))),
      );
      setBackendForTests({ enrichApply } as unknown as Backend);
      renderReview([SOBRE_TRANSCRICAO]);

      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Aplicar selecionadas (1)" }),
        );
      });
      expect(enrichApply).toHaveBeenCalledWith([
        {
          song_id: 5,
          title: "Oh! Chuva",
          artist: "Falamansa",
          lyrics: null,
          add_temas: null,
          current_title: "AudioTrack 03",
          current_artist: null,
          fonte: "LRCLIB",
        },
      ]);
    });

    it("com a marcação, a letra viaja junto do consentimento", async () => {
      const enrichApply = vi.fn(async (aplicacoes: EnrichApply[]) =>
        aplicacoes.map((a) => ok(song(a.song_id, a.title))),
      );
      setBackendForTests({ enrichApply } as unknown as Backend);
      renderReview([SOBRE_TRANSCRICAO]);

      fireEvent.click(
        screen.getByRole("checkbox", { name: new RegExp(LABEL_SUBSTITUIR_LETRA) }),
      );
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Aplicar selecionadas (1)" }),
        );
      });
      expect(enrichApply).toHaveBeenCalledWith([
        expect.objectContaining({
          song_id: 5,
          lyrics: "letra vinda do LRCLIB",
          substituir_letra: true,
        }),
      ]);
    });

    it("'Marcar todas' NUNCA marca a substituição de letra", () => {
      renderReview([SOBRE_TRANSCRICAO, MEDIA]);
      fireEvent.click(screen.getByRole("button", { name: "Marcar todas" }));
      expect(
        screen.getByRole("checkbox", { name: new RegExp(LABEL_SUBSTITUIR_LETRA) }),
      ).not.toBeChecked();
      expect(
        screen.getByRole("button", { name: "Aplicar selecionadas (2)" }),
      ).toBeEnabled();
    });

    it("'Desmarcar todas' desfaz também a substituição", () => {
      renderReview([SOBRE_TRANSCRICAO]);
      const substituir = screen.getByRole("checkbox", {
        name: new RegExp(LABEL_SUBSTITUIR_LETRA),
      });
      fireEvent.click(substituir);
      expect(substituir).toBeChecked();
      fireEvent.click(screen.getByRole("button", { name: "Desmarcar todas" }));
      expect(
        screen.getByRole("checkbox", { name: new RegExp(LABEL_SUBSTITUIR_LETRA) }),
      ).not.toBeChecked();
    });

    // MÉDIO-13 — a metade destrutiva ficava invisível: a linha era contada
    // como "teve título ou artista corrigido".
    it("o aviso final conta a letra substituída, separada das que ganharam letra", async () => {
      setBackendForTests({
        enrichApply: vi.fn(async (aplicacoes: EnrichApply[]) =>
          aplicacoes.map((a) => ok(song(a.song_id, a.title))),
        ),
      } as unknown as Backend);
      useLibraryStore.setState({
        allSongs: [
          { ...song(1, "faixa 1"), has_lyrics: false },
          { ...song(5, "AudioTrack 03"), has_lyrics: true },
        ],
      });

      renderReview([ALTA, SOBRE_TRANSCRICAO]);
      fireEvent.click(
        screen.getByRole("checkbox", { name: new RegExp(LABEL_SUBSTITUIR_LETRA) }),
      );
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Aplicar selecionadas (2)" }),
        );
      });

      expect(useToastStore.getState().toasts[0].message).toBe(
        textoAplicado({
          ganharamLetra: 1,
          letraSubstituida: 1,
          nomeCorrigido: 0,
          gravadas: 2,
        }),
      );
    });

    // O backend pode recusar mesmo assim: o banco dizia "sem letra" e o
    // arquivo tinha (alguém escreveu à mão durante a varredura). A linha
    // precisa mostrar a mensagem — e oferecer o caminho que ela indica.
    it("recusa do backend por falta de consentimento: mensagem na linha e saída à mão", async () => {
      const recusa =
        'esta música já tem letra — marque "substituir a letra atual" para trocá-la';
      const enrichApply = vi
        .fn<(a: EnrichApply[]) => Promise<EnrichApplyResult[]>>()
        .mockResolvedValueOnce([failed(1, recusa)])
        .mockResolvedValueOnce([ok(song(1, "Faixa Um"))]);
      setBackendForTests({ enrichApply } as unknown as Backend);

      renderReview([ALTA]);
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Aplicar selecionadas (1)" }),
        );
      });

      // a linha continua na tela, com o motivo escrito
      expect(screen.getByText(recusa)).toBeInTheDocument();
      // e com a marcação que o próprio texto manda usar
      const substituir = screen.getByRole("checkbox", {
        name: new RegExp(LABEL_SUBSTITUIR_LETRA),
      });
      expect(substituir).toBeEnabled();

      fireEvent.click(substituir);
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Aplicar selecionadas (1)" }),
        );
      });
      expect(enrichApply).toHaveBeenCalledTimes(2);
      expect(enrichApply.mock.calls[1][0][0]).toMatchObject({
        lyrics: "letra da um",
        substituir_letra: true,
      });
    });
  });

  // -------------------------------------------------------------------------
  // V9 — o som contra a etiqueta: dois lados, nada pré-marcado
  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // QA A2 — o que a varredura NÃO fez também é desfecho
  // -------------------------------------------------------------------------
  //
  // Uma falha do `fpcalc` desligava a etapa 2 pelo resto da varredura. A tela
  // mostrava UMA linha vermelha e o silêncio das outras 149 — e o silêncio era
  // lido como aprovação. O backend passou a contar; se a tela não disser o
  // número, o defeito continua igual (DECISIONS #86).
  describe("as músicas que não chegaram a ser perguntadas ao som", () => {
    it("zero não desenha aviso nenhum — é o caso normal", () => {
      renderReview([ALTA]);
      const dialog = screen.getByRole("dialog", { name: "Completar dados" });
      expect(dialog.textContent ?? "").not.toContain("não chegaram a ser perguntadas");
      expect(dialog.textContent ?? "").not.toContain("não chegou a ser perguntada");
    });

    it("com propostas, o aviso aparece com o número", () => {
      renderReview([ALTA], 40, 37, "conferencia");
      expect(
        screen.getByText(avisoSemPerguntarAoSom(37, "conferencia")!),
      ).toBeVisible();
    });

    // A lista rola: um aviso sobre o ALCANCE da varredura embaixo de 95 linhas
    // é um aviso que ninguém lê. Ele fica acima do cabeçalho de contagem.
    it("o aviso vem antes do cabeçalho de contagem, e não no fim da lista", () => {
      renderReview([ALTA], 40, 37, "conferencia");
      const aviso = screen.getByText(avisoSemPerguntarAoSom(37, "conferencia")!);
      const cabecalho = screen.getByRole("heading", { level: 2 });
      // Node.DOCUMENT_POSITION_FOLLOWING = o cabeçalho vem DEPOIS do aviso.
      // Comparar posição no DOM, e não índice no texto, porque a região viva
      // (sr-only) repete o mesmo aviso lá em cima e enganaria um indexOf.
      expect(
        aviso.compareDocumentPosition(cabecalho) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    // Sem propostas o desfecho é UM texto só: o de sempre já passa a contar as
    // não perguntadas, então dois avisos seriam a mesma coisa dita duas vezes.
    it("sem propostas, o desfecho vazio é quem conta — sem texto repetido", () => {
      renderReview([], 40, 37, "conferencia");
      expect(
        screen.getByText(textoSemPropostas(40, "conferencia", 37)),
      ).toBeVisible();
      expect(
        screen.queryByText(avisoSemPerguntarAoSom(37, "conferencia")!),
      ).not.toBeInTheDocument();
    });

    // Quem ouve a tela em vez de vê-la recebe o mesmo desfecho, não um resumo
    // otimista: a região viva é o único texto que o leitor de tela anuncia.
    it("a região viva anuncia o desfecho junto com o número", () => {
      renderReview([ALTA], 40, 37, "conferencia");
      const vivo = document.querySelector("[role='status']");
      expect(vivo?.textContent ?? "").toContain("37");
    });

    it("o aviso passa em AA sobre o próprio fundo", () => {
      renderReview([ALTA], 40, 37, "conferencia");
      const aviso = screen.getByText(avisoSemPerguntarAoSom(37, "conferencia")!);
      // #854D0E sobre #FEF3C7 — o mesmo par do selo CONFLITO, já medido
      expect(contrastRatio("#854D0E", "#FEF3C7")).toBeGreaterThanOrEqual(
        AA_TEXTO_NORMAL,
      );
      expect(corDoTexto(aviso.className)).toBe("#854D0E");
    });
  });

  describe("linha de conflito", () => {
    /** O caso real: a etiqueta diz Caetano, o som diz Nilson Chaves. */
    const CONFLITO = proposal({
      song_id: 7,
      file_path: "/acervo/7.mp3",
      current_title: "Te ver feliz, te ver contente",
      current_artist: "Caetano Veloso",
      // o proposto REPETE o atual: a linha informa, não corrige
      proposed_title: "Te ver feliz, te ver contente",
      proposed_artist: "Caetano Veloso",
      lyrics: null,
      confidence: "baixa",
      fonte: "reconhecimento pelo som",
      conflito: {
        titulo: "Viver Feliz",
        artista: "Nilson Chaves",
        confianca: "alta",
      },
    });

    it("mostra os DOIS lados, cada um nomeado por quem o disse", () => {
      renderReview([CONFLITO]);
      const dialog = screen.getByRole("dialog", { name: "Completar dados" });
      const texto = dialog.textContent ?? "";
      // a etiqueta vem antes do som: é o que a pessoa reconhece
      expect(texto.indexOf(LABEL_SUA_ETIQUETA_DIZ)).toBeGreaterThan(-1);
      expect(texto.indexOf(LABEL_SUA_ETIQUETA_DIZ)).toBeLessThan(
        texto.indexOf(LABEL_SOM_DIZ),
      );
      expect(
        screen.getByText("Te ver feliz, te ver contente — Caetano Veloso"),
      ).toBeInTheDocument();
      expect(
        screen.getByText("Viver Feliz — Nilson Chaves"),
      ).toBeInTheDocument();
      // e a confiança MOSTRADA é a do reconhecimento, não a da linha
      expect(screen.getByText("confiança alta")).toBeInTheDocument();
    });

    // "Atual → proposto" diria que o app já escolheu um lado. Não escolheu:
    // nada foi proposto, duas fontes discordam.
    it("não usa a seta de proposta nem o selo de confiança da linha", () => {
      renderReview([CONFLITO]);
      expect(screen.queryByText("BAIXA")).not.toBeInTheDocument();
      expect(screen.getByText("CONFLITO")).toBeInTheDocument();
    });

    it("nunca chega pré-marcada, e o rótulo diz o que se aceita", () => {
      renderReview([CONFLITO]);
      const caixa = screen.getByRole("checkbox", {
        name: rotuloAceitarSom("Te ver feliz, te ver contente"),
      });
      expect(caixa).not.toBeChecked();
      expect(caixa).toBeEnabled();
    });

    // Aceitar troca um título E um artista escritos por gente, com base numa
    // identificação cuja taxa de falso positivo o projeto NÃO mediu. É a
    // ação mais destrutiva da tela: ela não entra em gesto de massa, pela
    // mesma razão da substituição de letra (DECISIONS #79).
    it("'Marcar todas' NÃO aceita conflito nenhum", () => {
      renderReview([CONFLITO, MEDIA]);
      fireEvent.click(screen.getByRole("button", { name: "Marcar todas" }));
      expect(
        screen.getByRole("checkbox", {
          name: rotuloAceitarSom("Te ver feliz, te ver contente"),
        }),
      ).not.toBeChecked();
      expect(
        screen.getByRole("button", { name: "Aplicar selecionadas (1)" }),
      ).toBeEnabled();
    });

    it("aceitar manda o que o SOM disse, e letra nenhuma", async () => {
      const enrichApply = vi.fn(async (aplicacoes: EnrichApply[]) =>
        aplicacoes.map((a) => ok(song(a.song_id, a.title))),
      );
      setBackendForTests({ enrichApply } as unknown as Backend);
      renderReview([CONFLITO]);

      fireEvent.click(
        screen.getByRole("checkbox", {
          name: rotuloAceitarSom("Te ver feliz, te ver contente"),
        }),
      );
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Aplicar selecionadas (1)" }),
        );
      });
      expect(enrichApply).toHaveBeenCalledWith([
        {
          song_id: 7,
          title: "Viver Feliz",
          artist: "Nilson Chaves",
          lyrics: null,
          add_temas: null,
          current_title: "Te ver feliz, te ver contente",
          current_artist: "Caetano Veloso",
          fonte: "reconhecimento pelo som",
        },
      ]);
    });

    /**
     * SUGESTÃO-3, avaliada e RECUSADA — e por isso fixada em teste.
     *
     * A proposta era gravar só o campo que DIVERGIU quando um dos dois
     * coincide. Três razões para não:
     *
     * 1. **o rótulo é "Aceitar o que o som diz"**, e a linha mostra o lado do
     *    som inteiro, com título e artista juntos. Gravar metade dele seria
     *    aplicar algo DIFERENTE do que a pessoa leu — num produto sem suporte,
     *    aplicar exatamente o texto exibido vale mais que a economia;
     * 2. **saber qual campo divergiu exige o `discorda`** (contenção mínima e
     *    tolerância de grafia). Ele mora no Rust e no mock; trazê-lo para a
     *    UI seria a QUARTA implementação da mesma regra, que é exatamente o
     *    defeito das DECISIONS #80 e #88;
     * 3. **o campo que coincide é gravado com o mesmo valor** — escrita
     *    inócua. O único caso com efeito real é o de grafia (o som escreve
     *    "y" onde a etiqueta tinha "&"), e nesse caso a pessoa leu as duas
     *    grafias lado a lado antes de marcar.
     *
     * Se um dia o backend mandar QUAL campo divergiu (como já manda
     * `confianca`), a conta muda: aí não é regra duplicada, é dado.
     */
    it("aceitar aplica o lado do som INTEIRO, inclusive o campo que coincide", async () => {
      const enrichApply = vi.fn(async (aplicacoes: EnrichApply[]) =>
        aplicacoes.map((a) => ok(song(a.song_id, a.title))),
      );
      setBackendForTests({ enrichApply } as unknown as Backend);
      // só o ARTISTA diverge: o título é o mesmo dos dois lados
      const soArtista = proposal({
        song_id: 8,
        file_path: "/acervo/8.mp3",
        current_title: "Sol Nascente",
        current_artist: "Alceu Valença",
        proposed_title: "Sol Nascente",
        proposed_artist: "Alceu Valença",
        lyrics: null,
        confidence: "baixa",
        fonte: "reconhecimento pelo som",
        conflito: {
          titulo: "Sol Nascente",
          artista: "Chico César",
          confianca: "alta",
        },
      });
      renderReview([soArtista]);
      fireEvent.click(
        screen.getByRole("checkbox", { name: rotuloAceitarSom("Sol Nascente") }),
      );
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Aplicar selecionadas (1)" }),
        );
      });
      const enviado = enrichApply.mock.calls[0][0][0];
      // o título vai junto, com o MESMO valor que já estava lá — escrita
      // inócua, e o que a pessoa leu na linha
      expect(enviado.title).toBe("Sol Nascente");
      expect(enviado.artist).toBe("Chico César");
    });

    it("o aviso final conta a correção de nome vinda do som", async () => {
      setBackendForTests({
        enrichApply: vi.fn(async (aplicacoes: EnrichApply[]) =>
          aplicacoes.map((a) => ok(song(a.song_id, a.title))),
        ),
      } as unknown as Backend);
      renderReview([CONFLITO]);
      fireEvent.click(
        screen.getByRole("checkbox", {
          name: rotuloAceitarSom("Te ver feliz, te ver contente"),
        }),
      );
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Aplicar selecionadas (1)" }),
        );
      });
      // o proposto REPETE o atual nesta linha: contar pelo `proposed_*` diria
      // "gravada, sem mudança no conteúdo" sobre uma troca de nome
      expect(useToastStore.getState().toasts[0].message).toBe(
        textoAplicado({
          ganharamLetra: 0,
          letraSubstituida: 0,
          nomeCorrigido: 1,
          gravadas: 1,
        }),
      );
    });

    it("o cabeçalho conta as divergências à parte das propostas", () => {
      renderReview([CONFLITO, MEDIA]);
      expect(
        screen.getByText(
          "1 proposta — 0 alta, 1 média, 0 baixa; e 1 em que o som discorda da etiqueta",
        ),
      ).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // V9 — ALTA que trocaria um nome escrito por gente não chega pré-marcada
  // -------------------------------------------------------------------------
  describe("proposta que trocaria um nome escrito por gente", () => {
    const NOME_ESCRITO = proposal({
      song_id: 8,
      file_path: "/acervo/8.mp3",
      current_title: "Ponto de Oxum",
      current_artist: "Grupo do Terreiro",
      proposed_title: "Ponto de Oxum (Ao Vivo)",
      proposed_artist: "Grupo do Terreiro",
      lyrics: null,
      confidence: "alta",
      substitui_nome_escrito: true,
    });

    it("ALTA sim, pré-marcada não — e a linha diz por quê", () => {
      renderReview([NOME_ESCRITO, ALTA]);
      // as duas são ALTA: o que difere é o padrão da marcação
      expect(screen.getAllByText("ALTA")).toHaveLength(2);
      expect(
        screen.getByRole("checkbox", { name: /Ponto de Oxum/ }),
      ).not.toBeChecked();
      // a outra ALTA, que só preenche branco, continua pré-marcada
      expect(screen.getByRole("checkbox", { name: /faixa 1/ })).toBeChecked();
      expect(screen.getByText(AVISO_NOME_ESCRITO)).toBeInTheDocument();
    });

    // O que muda é só o PADRÃO: "Marcar todas" é ação explícita de quem leu a
    // tela, e continua marcando tudo.
    it("'Marcar todas' continua marcando esta linha", () => {
      renderReview([NOME_ESCRITO]);
      fireEvent.click(screen.getByRole("button", { name: "Marcar todas" }));
      expect(
        screen.getByRole("checkbox", { name: /Ponto de Oxum/ }),
      ).toBeChecked();
    });

    it("preencher branco e limpar lixo de ripador continuam pré-marcáveis", () => {
      renderReview([ALTA]);
      expect(screen.getByRole("checkbox", { name: /faixa 1/ })).toBeChecked();
      expect(screen.queryByText(AVISO_NOME_ESCRITO)).not.toBeInTheDocument();
    });
  });

  // O overlay é lido em notebook, em sala mal iluminada, por quem está
  // conduzindo uma reunião (DECISIONS #69/#76). O texto novo desta rodada — o
  // aviso de letra existente, o rótulo da substituição, a nota das linhas com
  // erro e o motivo do botão desabilitado — entra medido, ou não entra.
  it("todo texto do overlay passa em AA sobre o fundo em que aparece", () => {
    // as linhas NOVAS entram medidas, ou não entram (DECISIONS #69/#76): o
    // conflito traz selo e rótulos próprios, e o aviso de nome escrito é
    // texto secundário — que é justamente onde o contraste costuma cair
    renderReview([
      SOBRE_TRANSCRICAO,
      MEDIA,
      COM_ERRO,
      proposal({
        song_id: 7,
        current_title: "Te ver feliz",
        current_artist: "Caetano Veloso",
        proposed_title: "Te ver feliz",
        proposed_artist: "Caetano Veloso",
        lyrics: null,
        confidence: "baixa",
        fonte: "reconhecimento pelo som",
        conflito: {
          titulo: "Viver Feliz",
          artista: "Nilson Chaves",
          confianca: "media",
        },
      }),
      proposal({
        song_id: 8,
        current_title: "Ponto de Oxum",
        proposed_title: "Ponto de Oxum (Ao Vivo)",
        lyrics: null,
        confidence: "alta",
        substitui_nome_escrito: true,
      }),
    ]);
    const dialog = screen.getByRole("dialog", { name: "Completar dados" });
    const comCor = [...dialog.querySelectorAll<HTMLElement>("*")].filter((el) =>
      /text-\[#[0-9a-fA-F]{6}\]/.test(el.className),
    );
    expect(comCor.length).toBeGreaterThan(0);
    for (const el of comCor) {
      // o fundo é o do diálogo (branco), exceto nos selos, que trazem o seu
      const proprio = /bg-\[(#[0-9a-fA-F]{6})\]/.exec(el.className);
      const fundo = proprio ? proprio[1] : "#FFFFFF";
      expect(
        contrastRatio(corDoTexto(el.className), fundo),
        `"${el.textContent?.slice(0, 40)}"`,
      ).toBeGreaterThanOrEqual(AA_TEXTO_NORMAL);
    }
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
