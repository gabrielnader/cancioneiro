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
  type TranscricaoProgresso,
} from "../lib/api";
import {
  AVISO_LETRA_DE_MAQUINA,
  AVISO_MARCAR_INSTRUMENTAL,
  AVISO_NOME_ESCRITO,
  EXPLICACAO_DA_CONFIANCA_DO_SOM,
  LABEL_SOM_DIZ,
  LABEL_SUA_ETIQUETA_DIZ,
  LABEL_SUBSTITUIR_LETRA,
  ROTULO_COMECAR_TRANSCRICAO,
  ROTULO_DA_LINHA_GRAVADA,
  SELO_DA_LINHA_GRAVADA,
  avisoDeTranscricaoPendente,
  avisoLetraExistente,
  avisoSemPerguntarAoSom,
  rotuloAceitarSom,
  rotuloDoRefrao,
  textoAplicado,
  textoDaOfertaDeTranscricao,
  textoDaTranscricaoIndisponivel,
  textoDoTempoDaTranscricao,
  textoSemPropostas,
  tituloDoGrupo,
} from "../lib/curadoria";
import { FONTE_TRANSCRICAO, type Song } from "../lib/types";
import { useEnrichStore } from "../stores/enrichStore";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlayerStore } from "../stores/playerStore";
import { usePlaylistStore } from "../stores/playlistStore";
import { useToastStore } from "../stores/toastStore";
import {
  AA_TEXTO_NORMAL,
  FUNDOS_DA_LINHA,
  TEXT_COLOR_RE,
  contrastRatio,
  corDoFundo,
  corDoTexto,
} from "../test/contrast";
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
    // V10 — três campos novos, todos desligados por padrão: a varredura não
    // marca instrumental, não extrai refrão e não tem aviso a dar
    marcar_instrumental: false,
    refrao: null,
    aviso: null,
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

/**
 * Abre o grupo dobrado (V10). Ele nasce FECHADO — 72 linhas iguais viram uma
 * frase —, e os testes que precisam ver as linhas o abrem, que é exatamente o
 * que a pessoa faz.
 */
function abrirDobrado() {
  fireEvent.click(screen.getByRole("button", { name: /abrir para ver/i }));
}

function ok(song: Song, aviso: string | null = null): EnrichApplyResult {
  return { song_id: song.id, song, error: null, aviso };
}

function failed(songId: number, error: string): EnrichApplyResult {
  return { song_id: songId, song: null, error, aviso: null };
}

function renderReview(
  proposals: EnrichProposal[],
  scannedTotal = 0,
  /** Quantas a etapa 2 deixou de perguntar (QA A2) — zero é o caso normal. */
  semPerguntarAoSom = 0,
  /** V10 — a pergunta do fim, quando houve quem sobrasse sem letra. */
  fim: {
    semLetraNoFim?: number[];
    segundosDeTranscricao?: number;
    disponivel?: boolean;
    download?: { bytes: number; segundos: number } | null;
    /** QA A1 — a estimativa é medição desta máquina, ou palpite de fábrica? */
    medida?: boolean;
  } = {},
) {
  useEnrichStore.setState({
    status: "review",
    overlayOpen: true,
    folderPrefix: "",
    proposals,
    progress: null,
    scannedTotal,
    semPerguntarAoSom,
    semLetraNoFim: fim.semLetraNoFim ?? [],
    segundosDeTranscricao: fim.segundosDeTranscricao ?? 0,
    estimativaMedidaNestaMaquina: fim.medida ?? false,
    transcricao: {
      disponivel: fim.disponivel ?? false,
      download: fim.download ?? null,
    },
    transcricaoDispensada: false,
    transcricaoProgress: null,
    applyErrors: {},
    aplicadas: [],
    gravadas: {},
    avisosDaGravacao: {},
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
      semPerguntarAoSom: 0,
      semLetraNoFim: [],
      segundosDeTranscricao: 0,
      transcricao: { disponivel: false, download: null },
      transcricaoProgress: null,
      transcricaoDispensada: false,
      applyErrors: {},
      aplicadas: [],
      gravadas: {},
      avisosDaGravacao: {},
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

  // MÉDIO-12 — as linhas de ERRO entravam na conta por confiança: com o lote
  // inteiro falhando a pessoa lia "95 propostas — 0 alta, 0 média, 95 baixa",
  // clicava "Marcar todas" (que ignora erros) e recebia "Aplicar selecionadas
  // (0)", desabilitado, sem uma linha de explicação.
  it("header conta só as OFERTAS; as linhas com erro são ditas à parte", () => {
    renderReview([ALTA, MEDIA, BAIXA, COM_ERRO]);
    expect(screen.getByText("3 propostas para conferir")).toBeInTheDocument();
    expect(
      screen.getByText(
        "1 música não pôde ser consultada — o motivo está na linha dela",
      ),
    ).toBeInTheDocument();
  });

  // V10 — o cabeçalho contava por CONFIANÇA ("0 alta, 0 média, 95 baixa"), e
  // era ele ensinando a ignorar as de baixa. Quem diz o que cada coisa é agora
  // é o título de cada grupo; aqui fica só o tamanho do trabalho.
  it("o cabeçalho não fala mais em confiança", () => {
    renderReview([ALTA, MEDIA, BAIXA]);
    const h2 = screen.getByRole("heading", { level: 2 });
    expect(h2.textContent ?? "").not.toContain("baixa");
    expect(h2.textContent ?? "").not.toContain("alta");
  });

  it("todas com erro: o header não promete proposta nenhuma", () => {
    renderReview([COM_ERRO]);
    expect(
      screen.getByText("Nenhuma proposta para aplicar."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "1 música não pôde ser consultada — o motivo está na linha dela",
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
    expect(screen.getByText("1 proposta para conferir")).toBeInTheDocument();
  });

  // V10 — a letra em ALTA continua pré-marcada (DECISIONS #49); a letra em
  // MÉDIA, não. A BAIXA sem letra saiu desta conversa: ela só preenche campo
  // vazio, então mora no grupo dobrado e chega MARCADA (o corte é por risco).
  it("letra em ALTA vem pré-marcada; em MÉDIA não; linha com erro desabilitada", () => {
    renderReview([ALTA, MEDIA, BAIXA, COM_ERRO]);
    expect(screen.getByRole("checkbox", { name: /faixa 1/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /faixa 2/ })).not.toBeChecked();
    const errored = screen.getByRole("checkbox", { name: /faixa 4/ });
    expect(errored).not.toBeChecked();
    expect(errored).toBeDisabled();
    expect(screen.getByText("sem conexão")).toBeInTheDocument();
  });

  it("mostra badges de confiança em maiúsculas e o indicador de letra", () => {
    renderReview([ALTA, MEDIA, BAIXA]);
    abrirDobrado();
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
    abrirDobrado();
    expect(screen.getByText("via LRCLIB")).toBeInTheDocument();
    expect(screen.getByText("via nome do arquivo")).toBeInTheDocument();
  });

  it("linha com erro mostra o erro, não a procedência", () => {
    renderReview([COM_ERRO]);
    expect(screen.getByText("sem conexão")).toBeInTheDocument();
    expect(screen.queryByText(/^via /)).not.toBeInTheDocument();
  });

  // V10 — BAIXA sem letra é preenchimento de campo vazio: ela chega MARCADA,
  // no grupo dobrado, e continua DESMARCÁVEL uma a uma (dobrado ≠ escondido).
  it("a linha do grupo dobrado é desmarcável uma a uma", () => {
    renderReview([BAIXA]);
    abrirDobrado();
    const checkbox = screen.getByRole("checkbox", { name: /faixa 3/ });
    expect(checkbox).toBeChecked();
    fireEvent.click(checkbox);
    expect(checkbox).not.toBeChecked();
    expect(
      screen.getByRole("button", { name: "Aplicar selecionadas (0)" }),
    ).toBeDisabled();
  });

  it("Marcar todas marca só as linhas sem erro; Desmarcar todas zera", () => {
    renderReview([ALTA, MEDIA, BAIXA, COM_ERRO]);
    abrirDobrado();
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

    // seleção: ALTA (letra, pré-marcada) + BAIXA (preenchimento, marcada por
    // padrão no grupo dobrado); MÉDIA fica de fora
    expect(
      screen.getByRole("button", { name: "Aplicar selecionadas (2)" }),
    ).toBeEnabled();
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
        marcadasInstrumental: 0,
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
    /*
      V10.6 — aplicar NÃO FECHA a caixa. Era o fechamento que jogava fora a
      lista das músicas sem letra, e recuperá-la custava a varredura inteira.
    */
    expect(useEnrichStore.getState().status).toBe("review");
    expect(useEnrichStore.getState().overlayOpen).toBe(true);
    expect(useEnrichStore.getState().aplicadas).toEqual([0]);
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
        marcadasInstrumental: 0,
        nomeCorrigido: 0,
        gravadas: 2,
      }),
    );
    expect(toasts[0].kind).toBe("success");
    expect(useEnrichStore.getState().status).toBe("review");
    expect(useEnrichStore.getState().aplicadas).toEqual([0, 1]);
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
        marcadasInstrumental: 0,
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
    /*
      V10.7 — e o cabeçalho dela fala de GRAVAÇÃO. A linha foi consultada com
      sucesso (é a proposta que está ali); o cabeçalho antigo dizia "não pôde ser
      consultada", que é o oposto do que aconteceu.
    */
    expect(
      screen.getByRole("heading", {
        level: 3,
        name: "1 música não pôde ser gravada no arquivo — o motivo está na linha dela",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/não pôde ser consultada/),
    ).not.toBeInTheDocument();
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
    // V10.7 — as duas falharam ao GRAVAR, e o cabeçalho diz isso
    expect(
      screen.getByRole("heading", {
        level: 3,
        name: "2 músicas não puderam ser gravadas no arquivo — o motivo está em cada linha",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/não puderam ser consultadas/),
    ).not.toBeInTheDocument();
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
          marcadasInstrumental: 0,
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
      renderReview([ALTA], 40, 37);
      expect(
        screen.getByText(avisoSemPerguntarAoSom(37)!),
      ).toBeVisible();
    });

    // A lista rola: um aviso sobre o ALCANCE da varredura embaixo de 95 linhas
    // é um aviso que ninguém lê. Ele fica acima do cabeçalho de contagem.
    it("o aviso vem antes do cabeçalho de contagem, e não no fim da lista", () => {
      renderReview([ALTA], 40, 37);
      const aviso = screen.getByText(avisoSemPerguntarAoSom(37)!);
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
      renderReview([], 40, 37);
      expect(
        screen.getByText(textoSemPropostas(40, 37)),
      ).toBeVisible();
      expect(
        screen.queryByText(avisoSemPerguntarAoSom(37)!),
      ).not.toBeInTheDocument();
    });

    // Quem ouve a tela em vez de vê-la recebe o mesmo desfecho, não um resumo
    // otimista: a região viva é o único texto que o leitor de tela anuncia.
    it("a região viva anuncia o desfecho junto com o número", () => {
      renderReview([ALTA], 40, 37);
      const vivo = document.querySelector("[role='status']");
      expect(vivo?.textContent ?? "").toContain("37");
    });

    it("o aviso passa em AA sobre o próprio fundo", () => {
      renderReview([ALTA], 40, 37);
      const aviso = screen.getByText(avisoSemPerguntarAoSom(37)!);
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
      // V10 — os dois lados aparecem CAMPO A CAMPO, e não como duas linhas de
      // "título — artista": aqui os dois campos diferem, então os dois são
      // comparados lado a lado.
      expect(texto).toContain("Te ver feliz, te ver contente");
      expect(texto).toContain("Caetano Veloso");
      expect(texto).toContain("Viver Feliz");
      expect(texto).toContain("Nilson Chaves");
      // e a confiança MOSTRADA é a do reconhecimento, dizendo sobre o que fala
      expect(
        screen.getByText("gravação reconhecida com confiança alta"),
      ).toBeInTheDocument();
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
          marcadasInstrumental: 0,
          nomeCorrigido: 1,
          gravadas: 1,
        }),
      );
    });

    // V10 — a divergência deixou de ser um número no cabeçalho e virou o
    // PRIMEIRO grupo da lista: ela é a coisa mais arriscada da tela, e o lugar
    // dela é o topo, não um sufixo de contagem.
    it("a divergência é o primeiro grupo, com título próprio", () => {
      renderReview([MEDIA, CONFLITO]);
      const grupos = screen
        .getAllByRole("heading", { level: 3 })
        .map((h) => h.textContent ?? "");
      expect(grupos[0]).toBe("1 música em que o som discorda da etiqueta");
      expect(screen.getByText("2 propostas para conferir")).toBeInTheDocument();
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
      TEXT_COLOR_RE.test(el.className),
    );
    expect(comCor.length).toBeGreaterThan(0);
    for (const el of comCor) {
      // o fundo é o do diálogo (branco), exceto nos selos, que trazem o seu
      const fundo = corDoFundo(el.className) ?? "#FFFFFF";
      expect(
        contrastRatio(corDoTexto(el.className), fundo),
        `"${el.textContent?.slice(0, 40)}"`,
      ).toBeGreaterThanOrEqual(AA_TEXTO_NORMAL);
    }
  });

  /*
    Achado de campo (V11) — o teste acima só conferia o tema CLARO (o
    "#FFFFFF" fixo de fallback era, coincidentemente, o `bg-white` que o
    modal tinha antes do conserto). Nada neste arquivo conferia o ESCURO:
    foi assim que o fundo fixo sobreviveu à bateria inteira de contraste.
    Estes três testes repetem a mesma varredura — review, varredura e
    transcrição — resolvendo cada token contra `CORES_ESCURO` (a mesma fonte
    do index.css que os utilitários de `contrast.ts` já leem).
  */
  describe("achado de campo — contraste no tema ESCURO (V11)", () => {
    /** Fundo do CARD do modal no escuro — mesma fonte que resolve os tokens. */
    const fundoDoDialogEscuro = corDoFundo("bg-surface", "escuro")!;

    function conferirContrasteEscuro(dialog: HTMLElement) {
      const comCor = [...dialog.querySelectorAll<HTMLElement>("*")].filter((el) =>
        TEXT_COLOR_RE.test(el.className),
      );
      expect(comCor.length).toBeGreaterThan(0);
      for (const el of comCor) {
        const fundo = corDoFundo(el.className, "escuro") ?? fundoDoDialogEscuro;
        expect(
          contrastRatio(corDoTexto(el.className, "escuro"), fundo),
          `"${el.textContent?.slice(0, 40)}" sobre ${fundo}`,
        ).toBeGreaterThanOrEqual(AA_TEXTO_NORMAL);
      }
    }

    it("a lista de revisão passa em AA no escuro (badges, avisos, comparação de conflito)", () => {
      renderReview([
        SOBRE_TRANSCRICAO,
        MEDIA,
        BAIXA,
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
      conferirContrasteEscuro(screen.getByRole("dialog", { name: "Completar dados" }));
    });

    it("a barra de progresso da VARREDURA passa em AA no escuro", () => {
      renderScanning({
        done: 25,
        total: 95,
        atual: "barco - Marinheiro só.mp3",
        etapa: "procurando no LRCLIB",
      });
      conferirContrasteEscuro(screen.getByRole("dialog", { name: "Completar dados" }));
    });

    it("a barra de progresso da TRANSCRIÇÃO passa em AA no escuro", () => {
      useEnrichStore.setState({
        status: "transcribing",
        overlayOpen: true,
        proposals: [],
        progress: null,
        scanId: "t1",
        semLetraNoFim: [1, 2],
        segundosDeTranscricao: 600,
        transcricao: { disponivel: true, download: null },
        transcricaoProgress: {
          done: 3,
          total: 47,
          atual: "barco - Marinheiro só.mp3",
          porcento_da_musica: 40,
          segundos_restantes: 120,
          scan_id: "t1",
        },
        applyErrors: {},
      });
      render(<EnrichReview />);
      conferirContrasteEscuro(screen.getByRole("dialog", { name: "Completar dados" }));
    });
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
        "Busca concluída. Conferimos as 81 músicas desta pasta",
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
  // ---------------------------------------------------------------------------
  // V10 — a revisão ordenada por RISCO
  // ---------------------------------------------------------------------------
  //
  // "Eu nem li as sugestões em baixa — não deu vontade de ler mesmo", numa
  // revisão de 53 músicas. Não é preferência: é o que 40 pessoas vão fazer.

  describe("a ordem por risco", () => {
    const CONFLITO_R = proposal({
      song_id: 20,
      current_title: "Meninos",
      current_artist: "Renato Teixeira & Xangai",
      proposed_title: "Meninos",
      proposed_artist: "Renato Teixeira & Xangai",
      lyrics: null,
      confidence: "baixa",
      fonte: "reconhecimento pelo som",
      conflito: {
        titulo: "Meninos",
        artista: "Xangai & Quinteto da Paraíba",
        confianca: "alta",
      },
    });
    const COM_LETRA = proposal({ song_id: 21, lyrics: "uma letra" });
    const SEM_VOZ = proposal({
      song_id: 22,
      lyrics: null,
      confidence: "media",
      fonte: "transcrição do áudio",
      marcar_instrumental: true,
      aviso: "20 caracteres em 5m00s de áudio dão 0,07, abaixo do mínimo de 0,30",
    });
    const NOME_ESCRITO = proposal({
      song_id: 23,
      lyrics: null,
      substitui_nome_escrito: true,
    });
    const VAZIO = proposal({
      song_id: 24,
      current_title: "sem_tags",
      current_artist: null,
      proposed_title: "Oh! Chuva",
      proposed_artist: "Falamansa",
      lyrics: null,
      confidence: "baixa",
      fonte: "nome do arquivo",
    });

    /** Os cabeçalhos de grupo, na ordem em que aparecem na tela. */
    function gruposNaTela(): string[] {
      return screen
        .getAllByRole("heading", { level: 3 })
        .map((h) => h.textContent ?? "");
    }

    it("de cima para baixo: conflitos, letras, sem voz, nomes escritos, dobrado", () => {
      renderReview([VAZIO, NOME_ESCRITO, SEM_VOZ, COM_LETRA, CONFLITO_R, COM_ERRO]);
      const grupos = gruposNaTela();
      expect(grupos[0]).toContain("o som discorda da etiqueta");
      expect(grupos[1]).toContain("letra encontrada");
      expect(grupos[2]).toContain("sem voz no áudio");
      expect(grupos[3]).toContain("troca de nome");
      expect(grupos[4]).toContain("sem título ou artista");
      expect(grupos[5]).toContain("não pôde ser consultada");
    });

    it("grupo que não tem linha não vira cabeçalho vazio", () => {
      renderReview([VAZIO]);
      expect(gruposNaTela()).toHaveLength(1);
    });

    /*
      V10.7 — as duas falhas na MESMA tela, cada uma com o seu cabeçalho.

      A que falhou ao GRAVAR vem primeiro: é consequência do clique que a pessoa
      acabou de dar, e é a única cujo motivo aponta para algo que ela pode
      conferir no computador dela. A que não pôde ser CONSULTADA é registro de
      que a música foi tentada (DECISIONS #47) — não há o que aplicar nela.
    */
    it("a falha da gravação e a da consulta são dois grupos, e a da gravação vem antes", () => {
      useEnrichStore.setState({
        status: "review",
        overlayOpen: true,
        proposals: [COM_ERRO, VAZIO, COM_LETRA],
        // a linha da letra foi consultada com sucesso e recusada na gravação
        applyErrors: { [COM_LETRA.song_id]: "o arquivo recusou" },
        aplicadas: [],
        gravadas: {},
      });
      render(<EnrichReview />);
      const grupos = gruposNaTela();
      expect(grupos[0]).toContain("sem título ou artista");
      expect(grupos[1]).toBe(
        "1 música não pôde ser gravada no arquivo — o motivo está na linha dela",
      );
      expect(grupos[2]).toBe(
        "1 música não pôde ser consultada — o motivo está na linha dela",
      );
    });

    // O grupo dobrado é a resposta ao "não deu vontade de ler": 72 linhas
    // iguais viram UMA frase que diz o número e o que o clique fará.
    describe("o grupo dobrado", () => {
      const muitos = Array.from({ length: 72 }, (_, i) =>
        proposal({
          song_id: 100 + i,
          current_title: `sem_tags_${i}`,
          proposed_title: `Canção ${i}`,
          proposed_artist: "Artista",
          lyrics: null,
          confidence: "baixa",
          fonte: "nome do arquivo",
        }),
      );

      it("fechado por padrão: a frase com o número, e nenhuma das 72 linhas", () => {
        renderReview(muitos);
        expect(
          screen.getByText(
            "72 músicas sem título ou artista vão receber o nome que está no arquivo",
          ),
        ).toBeVisible();
        expect(screen.queryByText("Canção 0")).not.toBeInTheDocument();
      });

      // Dobrado NÃO é escondido: nada é gravado sem revisão, e esconder seria
      // perder a correção. Continua abrível, visível e desmarcável.
      it("abrir mostra as linhas, uma a uma", () => {
        renderReview(muitos);
        fireEvent.click(screen.getByRole("button", { name: /abrir para ver/i }));
        expect(screen.getByText(/Canção 0/)).toBeVisible();
        expect(
          screen.getByRole("checkbox", { name: "Aplicar proposta: sem_tags_0" }),
        ).toBeVisible();
      });

      // Marcado por padrão: preencher um campo vazio não tem nada a perder, e
      // a frase com o número é a conferência.
      it("marcado por padrão, e o número do botão inclui as 72", () => {
        renderReview(muitos);
        expect(
          screen.getByRole("button", { name: "Aplicar selecionadas (72)" }),
        ).toBeEnabled();
      });

      it("desmarcar o grupo inteiro é um clique", () => {
        renderReview(muitos);
        fireEvent.click(
          screen.getByRole("checkbox", { name: /72 músicas sem título ou artista/ }),
        );
        expect(
          screen.getByRole("button", { name: "Aplicar selecionadas (0)" }),
        ).toBeDisabled();
      });
    });

    // O corte é por RISCO: baixa confiança não quer dizer "provavelmente
    // errado", quer dizer "sem prova externa".
    it("preencher campo vazio chega marcado mesmo em BAIXA", () => {
      renderReview([VAZIO]);
      // marcado com o grupo ainda fechado: a frase com o número é a
      // conferência, e o botão já conta a linha
      expect(
        screen.getByRole("button", { name: "Aplicar selecionadas (1)" }),
      ).toBeEnabled();
      fireEvent.click(screen.getByRole("button", { name: /abrir para ver/i }));
      expect(
        screen.getByRole("checkbox", { name: "Aplicar proposta: sem_tags" }),
      ).toBeChecked();
    });

    it("trocar nome escrito por gente continua desmarcado, em qualquer confiança", () => {
      renderReview([
        proposal({
          song_id: 30,
          current_title: "Ponto de Oxum",
          confidence: "alta",
          lyrics: null,
          substitui_nome_escrito: true,
        }),
      ]);
      expect(
        screen.getByRole("checkbox", { name: "Aplicar proposta: Ponto de Oxum" }),
      ).not.toBeChecked();
    });

    it("marcar instrumental nunca chega marcado, nem entra no 'Marcar todas'", () => {
      renderReview([SEM_VOZ, VAZIO]);
      // o rótulo diz TUDO que a linha decide, e não "aplicar proposta": esta
      // proposta também traz nome, e o clique grava os dois (QA A2)
      const caixa = screen.getByRole("checkbox", {
        name: "Marcar como instrumental e gravar o nome Faixa Um — Artista Um: faixa 1",
      });
      expect(caixa).not.toBeChecked();
      fireEvent.click(screen.getByRole("button", { name: "Marcar todas" }));
      expect(caixa).not.toBeChecked();
    });
  });

  describe("o conflito destaca o que difere (V10)", () => {
    const CONFLITO_R = proposal({
      song_id: 20,
      current_title: "Meninos",
      current_artist: "Renato Teixeira & Xangai",
      proposed_title: "Meninos",
      proposed_artist: "Renato Teixeira & Xangai",
      lyrics: null,
      confidence: "baixa",
      fonte: "reconhecimento pelo som",
      conflito: {
        titulo: "Meninos",
        artista: "Xangai & Quinteto da Paraíba",
        confianca: "alta",
      },
    });

    // O título se repetia nas duas linhas e a pessoa tinha de comparar dois
    // textos com o olho.
    it("o que é igual aparece uma vez só", () => {
      renderReview([CONFLITO_R]);
      expect(screen.getAllByText("Meninos")).toHaveLength(1);
    });

    it("o campo que difere aparece dos dois lados, nomeado por quem disse", () => {
      renderReview([CONFLITO_R]);
      expect(screen.getByText(`${LABEL_SUA_ETIQUETA_DIZ}:`)).toBeVisible();
      expect(screen.getByText(`${LABEL_SOM_DIZ}:`)).toBeVisible();
      expect(screen.getByText("Quinteto")).toBeVisible();
      expect(screen.getByText("Renato")).toBeVisible();
    });

    // "Xangai" está nos dois créditos: é o que faz os dois textos parecerem
    // iguais de relance, e por isso não é destacado.
    it("a palavra que os dois lados repetem não é destacada", () => {
      renderReview([CONFLITO_R]);
      const repetida = screen.getAllByText("Xangai");
      for (const p of repetida) {
        expect(p.className).not.toContain("font-semibold");
      }
      expect(screen.getByText("Quinteto").className).toContain("font-semibold");
    });

    // "confiança alta" enganava: ela é sobre QUAL GRAVAÇÃO é esta.
    it("a confiança diz sobre o que ela fala, e uma frase explica o resto", () => {
      renderReview([CONFLITO_R]);
      expect(
        screen.getByText("gravação reconhecida com confiança alta"),
      ).toBeVisible();
      expect(screen.getByText(EXPLICACAO_DA_CONFIANCA_DO_SOM)).toBeVisible();
    });

    it("a explicação aparece UMA vez, e não por linha", () => {
      renderReview([CONFLITO_R, { ...CONFLITO_R, song_id: 21 }]);
      expect(screen.getAllByText(EXPLICACAO_DA_CONFIANCA_DO_SOM)).toHaveLength(1);
    });
  });

  describe("os três campos novos da proposta (V10)", () => {
    const TRANSCRITA = proposal({
      song_id: 40,
      current_title: "sem_tags",
      proposed_title: "sem_tags",
      proposed_artist: null,
      lyrics: "na beira do mar sagrado",
      confidence: "media",
      fonte: FONTE_TRANSCRICAO,
      refrao: "na beira do mar sagrado",
    });
    const SEM_VOZ = proposal({
      song_id: 41,
      current_title: "Chorinho",
      proposed_title: "Chorinho",
      lyrics: null,
      confidence: "media",
      fonte: FONTE_TRANSCRICAO,
      marcar_instrumental: true,
      aviso: "20 caracteres em 5m00s de áudio dão 0,07, abaixo do mínimo de 0,30",
    });

    it("o refrão fica na linha, para reconhecer a música sem abrir a letra", () => {
      renderReview([TRANSCRITA]);
      expect(
        screen.getByText(rotuloDoRefrao("na beira do mar sagrado")),
      ).toBeVisible();
    });

    it("letra de máquina avisa que precisa de conferência antes de aplicar", () => {
      renderReview([TRANSCRITA]);
      expect(screen.getByText(AVISO_LETRA_DE_MAQUINA)).toBeVisible();
    });

    it("letra do LRCLIB não puxa o aviso de máquina", () => {
      renderReview([ALTA]);
      expect(screen.queryByText(AVISO_LETRA_DE_MAQUINA)).not.toBeInTheDocument();
    });

    it("a linha de instrumental diz o que a marca faz, e mostra o motivo medido", () => {
      renderReview([SEM_VOZ]);
      expect(screen.getByText(AVISO_MARCAR_INSTRUMENTAL)).toBeVisible();
      expect(screen.getByText(SEM_VOZ.aviso!)).toBeVisible();
    });

    // `aviso` é diferente de `error`: a linha CONTINUA aplicável.
    it("o aviso não desabilita a linha", () => {
      renderReview([SEM_VOZ]);
      expect(
        screen.getByRole("checkbox", {
          name:
            "Marcar como instrumental e gravar o nome Chorinho — Artista Um: Chorinho",
        }),
      ).toBeEnabled();
    });

    // QA A2 — a linha que grava DUAS coisas anuncia as duas. A etapa 5 do
    // Rust deixou de propor nome (o palpite da etapa 1 já foi entregue na
    // mesma revisão), mas o rótulo é DERIVADO da proposta e não de uma frase
    // fixa: qualquer linha que marque instrumental E mude nome — hoje, o
    // conflito resolvido à mão do editor — continua dizendo as duas.
    it("a caixa que grava marca e nome anuncia as duas coisas", () => {
      renderReview([
        proposal({
          song_id: 42,
          current_title: "AudioTrack 03",
          current_artist: null,
          proposed_title: "Oh! Chuva",
          proposed_artist: "Falamansa",
          lyrics: null,
          confidence: "media",
          fonte: FONTE_TRANSCRICAO,
          marcar_instrumental: true,
          aviso: "o áudio foi ouvido inteiro e não há voz nenhuma nele",
        }),
      ]);
      expect(
        screen.getByRole("checkbox", {
          name:
            "Marcar como instrumental e gravar o nome Oh! Chuva — Falamansa:" +
            " AudioTrack 03",
        }),
      ).toBeEnabled();
    });

    it("aceitar a linha manda marcar_instrumental ao backend", async () => {
      const enrichApply = vi.fn(async (aps: EnrichApply[]) =>
        aps.map((a) => ok(song(a.song_id, a.title))),
      );
      setBackendForTests({ enrichApply } as unknown as Backend);
      renderReview([SEM_VOZ]);
      fireEvent.click(
        screen.getByRole("checkbox", {
          name:
            "Marcar como instrumental e gravar o nome Chorinho — Artista Um: Chorinho",
        }),
      );
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Aplicar selecionadas (1)" }),
        );
      });
      expect(enrichApply.mock.calls[0][0][0]).toMatchObject({
        song_id: 41,
        marcar_instrumental: true,
        lyrics: null,
      });
    });

    it("linha comum nunca manda marcar_instrumental", async () => {
      const enrichApply = vi.fn(async (aps: EnrichApply[]) =>
        aps.map((a) => ok(song(a.song_id, a.title))),
      );
      setBackendForTests({ enrichApply } as unknown as Backend);
      renderReview([ALTA]);
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Aplicar selecionadas (1)" }),
        );
      });
      expect(enrichApply.mock.calls[0][0][0].marcar_instrumental).toBeUndefined();
    });

    it("o aviso e o refrão passam em AA sobre o fundo da linha", () => {
      renderReview([SEM_VOZ, TRANSCRITA]);
      for (const texto of [
        AVISO_MARCAR_INSTRUMENTAL,
        rotuloDoRefrao("na beira do mar sagrado"),
      ]) {
        const cor = corDoTexto(screen.getByText(texto).className);
        for (const fundo of Object.values(FUNDOS_DA_LINHA)) {
          expect(contrastRatio(cor, fundo), `${texto} sobre ${fundo}`).
            toBeGreaterThanOrEqual(AA_TEXTO_NORMAL);
        }
      }
    });
  });

  // ---------------------------------------------------------------------------
  // V10 — duas linhas da MESMA música, uma gravação só
  // ---------------------------------------------------------------------------
  //
  // A etapa 5 acrescenta propostas à revisão que já está aberta, e a música que
  // sobrou sem letra é justamente a que costuma ter uma proposta de NOME
  // pendente (foi por não ter etiqueta que ela não achou letra em base
  // nenhuma). Então a mesma música aparece em dois grupos: o nome no dobrado, a
  // letra em "letras encontradas".
  //
  // Cada linha continua sendo uma decisão — é o modelo da tela inteira. O que
  // não pode é virarem DUAS gravações: o `apply` confere o eco
  // `current_title`/`current_artist` contra o disco (QA A5), então a segunda
  // seria recusada com "a música mudou depois da busca" — uma falha inventada
  // por nós, num lote que a pessoa marcou inteiro.

  describe("duas linhas da mesma música", () => {
    const NOME = proposal({
      song_id: 60,
      current_title: "sem_tags",
      current_artist: null,
      proposed_title: "Oh! Chuva",
      proposed_artist: "Falamansa",
      lyrics: null,
      confidence: "baixa",
      fonte: "nome do arquivo",
    });
    const LETRA_DE_MAQUINA = proposal({
      song_id: 60,
      current_title: "sem_tags",
      current_artist: null,
      // a etapa 5 não propõe nome: ela repete o que está no arquivo
      proposed_title: "sem_tags",
      proposed_artist: null,
      lyrics: "na beira do mar sagrado",
      confidence: "media",
      fonte: FONTE_TRANSCRICAO,
      refrao: "na beira do mar sagrado",
    });

    it("as duas aparecem, cada uma no seu grupo e com a sua marcação", () => {
      renderReview([NOME, LETRA_DE_MAQUINA]);
      expect(screen.getByText("1 letra encontrada")).toBeVisible();
      expect(screen.getByText(/1 música sem título ou artista/)).toBeVisible();
    });

    it("aplicar as duas grava UMA vez, com o nome e a letra juntos", async () => {
      const enrichApply = vi.fn(async (aps: EnrichApply[]) =>
        aps.map((a) => ok(song(a.song_id, a.title))),
      );
      setBackendForTests({ enrichApply } as unknown as Backend);
      renderReview([NOME, LETRA_DE_MAQUINA]);

      // o grupo dobrado já chega marcado; a letra de máquina, não — e o rótulo
      // dela diz o que ela é
      fireEvent.click(
        screen.getByRole("checkbox", {
          name: "Aplicar a letra escrita ouvindo o áudio: sem_tags",
        }),
      );
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Aplicar selecionadas (2)" }),
        );
      });

      const enviadas = enrichApply.mock.calls[0][0];
      expect(enviadas).toHaveLength(1);
      expect(enviadas[0]).toMatchObject({
        song_id: 60,
        // o nome vem da linha que propõe nome...
        title: "Oh! Chuva",
        artist: "Falamansa",
        // ...e a letra da linha que traz letra, com a procedência DELA (é o
        // `fonte` que decide o TXXX:LETRA_ORIGEM)
        lyrics: "na beira do mar sagrado",
        fonte: FONTE_TRANSCRICAO,
      });
    });

    it("marcar só uma das duas grava só o que ela decide", async () => {
      const enrichApply = vi.fn(async (aps: EnrichApply[]) =>
        aps.map((a) => ok(song(a.song_id, a.title))),
      );
      setBackendForTests({ enrichApply } as unknown as Backend);
      renderReview([NOME, LETRA_DE_MAQUINA]);

      // só o nome (o dobrado vem marcado; a letra fica de fora)
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Aplicar selecionadas (1)" }),
        );
      });
      const enviadas = enrichApply.mock.calls[0][0];
      expect(enviadas).toHaveLength(1);
      expect(enviadas[0].title).toBe("Oh! Chuva");
      expect(enviadas[0].lyrics).toBeNull();
    });

    // A marca de instrumental é a outra saída da etapa 5, e ela também não
    // pode brigar com a proposta de nome pendente.
    it("nome mais 'sem voz' também viram uma gravação só", async () => {
      const enrichApply = vi.fn(async (aps: EnrichApply[]) =>
        aps.map((a) => ok(song(a.song_id, a.title))),
      );
      setBackendForTests({ enrichApply } as unknown as Backend);
      const semVoz = proposal({
        song_id: 60,
        current_title: "sem_tags",
        current_artist: null,
        proposed_title: "sem_tags",
        proposed_artist: null,
        lyrics: null,
        confidence: "media",
        fonte: FONTE_TRANSCRICAO,
        marcar_instrumental: true,
        aviso: "o áudio foi ouvido inteiro e não há voz nenhuma nele",
      });
      renderReview([NOME, semVoz]);
      fireEvent.click(
        screen.getByRole("checkbox", { name: "Marcar como instrumental: sem_tags" }),
      );
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Aplicar selecionadas (2)" }),
        );
      });
      const enviadas = enrichApply.mock.calls[0][0];
      expect(enviadas).toHaveLength(1);
      expect(enviadas[0]).toMatchObject({
        title: "Oh! Chuva",
        marcar_instrumental: true,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // V10 — a ressalva do lyrics.ovh (DECISIONS #110)
  // ---------------------------------------------------------------------------
  //
  // Esta fonte NÃO devolve o nome da música: é a única etapa do funil cujo
  // casamento o programa não tem como conferir. Ela pode entregar a letra de
  // "Ponto de Ogum" para um pedido de "Ponto de Oxum" e ninguém percebe.
  //
  // O teto MÉDIA tira a pré-marcação, mas só protege quem saiba POR QUÊ — e a
  // medição de campo foi "eu nem li as sugestões em baixa, não deu vontade de
  // ler mesmo". A ressalva tem de estar VISÍVEL na linha.

  describe("a ressalva da fonte que não dá para conferir", () => {
    const RESSALVA =
      "este site não diz a que música a letra pertence, então não deu para" +
      " conferir se ela é desta — vale ler antes de aplicar";
    const DO_OVH = proposal({
      song_id: 50,
      current_title: "Ponto de Oxum",
      current_artist: "Grupo Fixture",
      proposed_title: "Ponto de Oxum",
      proposed_artist: "Grupo Fixture",
      lyrics: "uma letra qualquer",
      confidence: "media",
      fonte: "lyrics.ovh",
      aviso: RESSALVA,
    });

    it("aparece na linha, com as palavras do backend", () => {
      renderReview([DO_OVH]);
      expect(screen.getByText(RESSALVA)).toBeVisible();
    });

    // Nem `title=`, nem atrás de expandir: a linha dela mora no grupo das
    // letras encontradas, que é aberto por padrão.
    it("não depende de abrir nada para ser lida", () => {
      renderReview([DO_OVH]);
      expect(screen.getByText("1 letra encontrada")).toBeVisible();
      expect(screen.getByText(RESSALVA)).toBeVisible();
    });

    // É AVISO, não `error`: a linha continua aplicável — quem revisou e leu a
    // letra pode aplicá-la.
    it("não desabilita a linha, e ela não chega marcada", () => {
      renderReview([DO_OVH]);
      const caixa = screen.getByRole("checkbox", {
        name: "Aplicar proposta: Ponto de Oxum",
      });
      expect(caixa).toBeEnabled();
      expect(caixa).not.toBeChecked();
    });

    // Ela é RESSALVA, e tem o peso das outras ressalvas da linha (a de trocar
    // nome escrito, a de substituir letra): quem varre a lista rápido precisa
    // ver que esta linha pede leitura, não só um clique.
    it("tem o peso visual de uma ressalva, e passa em AA em todos os fundos", () => {
      renderReview([DO_OVH]);
      const cor = corDoTexto(screen.getByText(RESSALVA).className);
      expect(cor).toBe("#854D0E");
      for (const fundo of Object.values(FUNDOS_DA_LINHA)) {
        expect(contrastRatio(cor, fundo), `ressalva sobre ${fundo}`).
          toBeGreaterThanOrEqual(AA_TEXTO_NORMAL);
      }
    });

    // ...e o `aviso` da etapa 5 é outra coisa: "20 caracteres em 5m00s dão
    // 0,07, abaixo do mínimo de 0,30" é a MEDIÇÃO que sustenta a conclusão,
    // logo abaixo da ressalva que já está em âmbar. Duas linhas âmbar seguidas
    // na mesma proposta é o ruído que ensina a ignorar as duas.
    it("a medição que acompanha o instrumental fica em tom secundário", () => {
      const semVoz = proposal({
        song_id: 51,
        current_title: "Chorinho",
        proposed_title: "Chorinho",
        lyrics: null,
        confidence: "media",
        fonte: FONTE_TRANSCRICAO,
        marcar_instrumental: true,
        aviso: "20 caracteres em 5m00s de áudio dão 0,07, abaixo do mínimo de 0,30",
      });
      renderReview([semVoz]);
      expect(corDoTexto(screen.getByText(semVoz.aviso!).className)).toBe("#5B6472");
    });

    // Aviso em toda linha ensina a ignorar todos: a linha do LRCLIB (que
    // confere pela duração) não recebe ressalva nenhuma.
    it("linha de outra fonte não ganha ressalva", () => {
      renderReview([ALTA]);
      expect(screen.queryByText(RESSALVA)).not.toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // V10 — a pergunta do fim, e as horas de trabalho
  // ---------------------------------------------------------------------------

  describe("a pergunta do fim", () => {
    it("com músicas sobrando e a etapa 5 pronta: oferece começar agora", () => {
      renderReview([ALTA], 50, 0, {
        semLetraNoFim: [1, 2, 3],
        segundosDeTranscricao: 10_800,
        disponivel: true,
      });
      expect(
        screen.getByText(textoDaOfertaDeTranscricao(3, 10_800)),
      ).toBeVisible();
      expect(
        screen.getByRole("button", { name: ROTULO_COMECAR_TRANSCRICAO }),
      ).toBeEnabled();
    });

    /*
      QA M3 — o número da pergunta é o que o BACKEND mandou, e nada mais.

      O backend vai parar de incluir em `sem_letra_no_fim` as músicas que
      voltaram com erro (elas não ficaram sem letra: elas não foram
      perguntadas). A tela não pode ter uma conta própria por cima disso — a
      DECISIONS #80 é exatamente esse defeito, e o preço dele foi o botão do
      produto ficando cinza porque duas cópias da mesma regra divergiram.

      Aqui a lista do backend tem UMA música e a revisão mostra três linhas de
      erro. Se a tela contasse alguma coisa, o número mudaria.
    */
    it("a conta é a do backend, mesmo com linhas de erro na tela", () => {
      const comErro = (id: number) =>
        proposal({
          song_id: id,
          current_title: `faixa ${id}`,
          lyrics: null,
          error: "sem conexão",
        });
      renderReview([comErro(81), comErro(82), comErro(83)], 50, 0, {
        semLetraNoFim: [81],
        segundosDeTranscricao: 600,
        disponivel: true,
      });
      expect(
        screen.getByText(textoDaOfertaDeTranscricao(1, 600)),
      ).toBeVisible();
      expect(screen.getByText(/Sobrou 1 música sem letra/)).toBeVisible();
    });

    // E a lista viaja inteira para a etapa 5: nem filtrada nem recontada.
    it("os ids mandados são os do backend, sem filtro da tela", async () => {
      const transcreverMusicas = vi.fn(async () => ({
        propostas: [],
        razao_medida: null,
      }));
      setBackendForTests({
        transcreverMusicas,
        onTranscricaoProgresso: vi.fn(async () => () => {}),
      } as unknown as Backend);
      renderReview(
        [proposal({ song_id: 81, lyrics: null, error: "sem conexão" })],
        50,
        0,
        { semLetraNoFim: [81, 82], segundosDeTranscricao: 600, disponivel: true },
      );
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: ROTULO_COMECAR_TRANSCRICAO }),
        );
      });
      expect(transcreverMusicas).toHaveBeenCalledWith([81, 82], expect.any(String));
    });

    /*
      QA A1 — a mesma pergunta, com e sem medição.

      A frase do PRD ("cerca de 3 horas neste computador") só pode ser dita
      quando o número é desta máquina. Enquanto ele é de fábrica — e ele nasce
      de fábrica em toda instalação — a tela mantém a ressalva, porque o erro
      tem sinal conhecido: o transcritor do macOS sai sem Metal e sem
      Accelerate, então o palpite é otimista (DECISIONS #85).
    */
    it("com a medição feita, a pergunta devolve o 'neste computador'", () => {
      renderReview([ALTA], 50, 0, {
        semLetraNoFim: [1, 2, 3],
        segundosDeTranscricao: 10_800,
        disponivel: true,
        medida: true,
      });
      expect(
        screen.getByText(textoDaOfertaDeTranscricao(3, 10_800, true)),
      ).toBeVisible();
      expect(screen.getByText(/neste computador/)).toBeVisible();
    });

    it("sem medição, a pergunta não afirma nada sobre esta máquina", () => {
      renderReview([ALTA], 50, 0, {
        semLetraNoFim: [1, 2, 3],
        segundosDeTranscricao: 10_800,
        disponivel: true,
      });
      expect(screen.queryByText(/neste computador/)).not.toBeInTheDocument();
      expect(screen.getByText(/pode levar mais nesta máquina/)).toBeVisible();
    });

    it("sem ninguém sobrando, não pergunta nada", () => {
      renderReview([ALTA], 50);
      expect(
        screen.queryByRole("button", { name: ROTULO_COMECAR_TRANSCRICAO }),
      ).not.toBeInTheDocument();
    });

    // Para 180 MB a dispensa do tempo acabou: quem não tem os acessórios vê o
    // caminho do download, com tamanho E tempo.
    it("sem os acessórios: oferece o download, com tamanho e tempo", () => {
      renderReview([ALTA], 50, 0, {
        semLetraNoFim: [1, 2, 3],
        segundosDeTranscricao: 10_800,
        disponivel: false,
        download: { bytes: 183_000_000, segundos: 183 },
      });
      expect(
        screen.getByText(
          textoDaTranscricaoIndisponivel(3, { bytes: 183_000_000, segundos: 183 }),
        ),
      ).toBeVisible();
      expect(
        screen.queryByRole("button", { name: ROTULO_COMECAR_TRANSCRICAO }),
      ).not.toBeInTheDocument();
    });

    it("'Agora não' cala a pergunta sem fechar a revisão", () => {
      renderReview([ALTA], 50, 0, {
        semLetraNoFim: [1],
        segundosDeTranscricao: 300,
        disponivel: true,
      });
      fireEvent.click(screen.getByRole("button", { name: "Agora não" }));
      expect(
        screen.queryByRole("button", { name: ROTULO_COMECAR_TRANSCRICAO }),
      ).not.toBeInTheDocument();
      expect(useEnrichStore.getState().status).toBe("review");
    });

    it("começar dispara a etapa 5 com os ids que a varredura devolveu", async () => {
      const transcreverMusicas = vi.fn(async () => ({
        propostas: [],
        razao_medida: null,
      }));
      setBackendForTests({
        transcreverMusicas,
        onTranscricaoProgresso: vi.fn(async () => () => {}),
      } as unknown as Backend);
      renderReview([ALTA], 50, 0, {
        semLetraNoFim: [7, 8],
        segundosDeTranscricao: 600,
        disponivel: true,
      });
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: ROTULO_COMECAR_TRANSCRICAO }),
        );
      });
      expect(transcreverMusicas).toHaveBeenCalledWith([7, 8], expect.any(String));
    });
  });

  // ---------------------------------------------------------------------------
  // QA M2 — a etapa 5 chega HORAS depois, numa revisão que já foi conferida
  // ---------------------------------------------------------------------------
  //
  // Ela ACRESCENTA propostas à lista aberta. A seleção era recalculada do zero
  // a cada mudança de identidade de `proposals`: o grupo dobrado que a pessoa
  // desmarcou de propósito voltava pré-marcado, e o que ela marcou à mão se
  // perdia — sem aviso, e depois de horas de espera em que ela pode nem estar
  // olhando.
  describe("a etapa 5 não apaga a conferência já feita", () => {
    /** Preenchimento (grupo dobrado, pré-marcado por padrão). */
    const PREENCHE = proposal({
      song_id: 70,
      current_title: "sem_tags",
      current_artist: null,
      proposed_title: "Oh! Chuva",
      proposed_artist: "Falamansa",
      lyrics: null,
      confidence: "baixa",
      fonte: "nome do arquivo",
    });
    /** Letra em MÉDIA: nunca chega pré-marcada. */
    const LETRA_MEDIA = proposal({
      song_id: 71,
      current_title: "Chegança",
      current_artist: "Antonio Nobrega",
      proposed_title: "Chegança",
      proposed_artist: "Antonio Nobrega",
      lyrics: "ó da barca",
      confidence: "media",
      fonte: "lyrics.ovh",
      aviso: "este site não diz a que música a letra pertence",
    });
    /** O que a etapa 5 traz horas depois. */
    const DA_TRANSCRICAO = proposal({
      song_id: 72,
      current_title: "AudioTrack 03",
      current_artist: null,
      proposed_title: "Oh! Chuva",
      proposed_artist: "Falamansa",
      lyrics: "chove chuva",
      confidence: "media",
      fonte: FONTE_TRANSCRICAO,
      refrao: "chove chuva",
    });

    /** Acrescenta as propostas da etapa 5, como o `startTranscricao` faz. */
    function chegaATranscricao(novas: EnrichProposal[]) {
      act(() => {
        useEnrichStore.setState((s) => ({
          proposals: [...s.proposals, ...novas],
          semLetraNoFim: [],
          segundosDeTranscricao: 0,
        }));
      });
    }

    const caixaDoPreenchimento = () =>
      screen.getByRole("checkbox", { name: "Aplicar proposta: sem_tags" });
    const caixaDaLetra = () =>
      screen.getByRole("checkbox", { name: "Aplicar proposta: Chegança" });

    it("o que a pessoa desmarcou continua desmarcado", () => {
      renderReview([PREENCHE, LETRA_MEDIA]);
      // o grupo dobrado nasce fechado: abrir para chegar à linha
      fireEvent.click(screen.getByRole("button", { name: "abrir para ver" }));
      expect(caixaDoPreenchimento()).toBeChecked();
      fireEvent.click(caixaDoPreenchimento());
      expect(caixaDoPreenchimento()).not.toBeChecked();

      chegaATranscricao([DA_TRANSCRICAO]);

      expect(caixaDoPreenchimento()).not.toBeChecked();
    });

    it("o que a pessoa marcou à mão continua marcado", () => {
      renderReview([PREENCHE, LETRA_MEDIA]);
      expect(caixaDaLetra()).not.toBeChecked();
      fireEvent.click(caixaDaLetra());

      chegaATranscricao([DA_TRANSCRICAO]);

      expect(caixaDaLetra()).toBeChecked();
    });

    // O padrão continua valendo — para as propostas NOVAS, que ninguém viu
    // ainda. Letra de máquina é MÉDIA, então ela chega desmarcada.
    it("as propostas novas recebem o padrão delas", () => {
      renderReview([PREENCHE, LETRA_MEDIA]);
      chegaATranscricao([DA_TRANSCRICAO]);
      expect(
        screen.getByRole("checkbox", {
          name:
            "Aplicar a letra escrita ouvindo o áudio e gravar o nome" +
            " Oh! Chuva — Falamansa: AudioTrack 03",
        }),
      ).not.toBeChecked();
    });

    // ...e um preenchimento NOVO chega pré-marcado, como chegaria numa
    // varredura: preservar a seleção antiga não pode virar "nada mais é
    // pré-marcado".
    it("preenchimento novo chega pré-marcado, como sempre", () => {
      renderReview([LETRA_MEDIA]);
      chegaATranscricao([
        proposal({
          song_id: 73,
          current_title: "faixa_09",
          current_artist: null,
          proposed_title: "Asa Branca",
          proposed_artist: "Luiz Gonzaga",
          lyrics: null,
          confidence: "baixa",
          fonte: "nome do arquivo",
        }),
      ]);
      fireEvent.click(screen.getByRole("button", { name: "abrir para ver" }));
      expect(
        screen.getByRole("checkbox", { name: "Aplicar proposta: faixa_09" }),
      ).toBeChecked();
    });

    // Uma varredura NOVA é outra coisa: a lista foi trocada, não acrescentada,
    // e aí o padrão vale para tudo de novo.
    it("uma varredura nova recomeça do padrão", () => {
      renderReview([PREENCHE, LETRA_MEDIA]);
      fireEvent.click(screen.getByRole("button", { name: "abrir para ver" }));
      fireEvent.click(caixaDoPreenchimento());
      expect(caixaDoPreenchimento()).not.toBeChecked();

      act(() => {
        useEnrichStore.setState({ proposals: [PREENCHE, LETRA_MEDIA] });
      });

      fireEvent.click(screen.getByRole("button", { name: "abrir para ver" }));
      expect(caixaDoPreenchimento()).toBeChecked();
    });
  });

  describe("acompanhar horas de trabalho", () => {
    function renderTranscrevendo(
      p: Partial<TranscricaoProgresso> | null = null,
    ) {
      useEnrichStore.setState({
        status: "transcribing",
        overlayOpen: true,
        proposals: [],
        progress: null,
        scanId: "t1",
        semLetraNoFim: [1, 2],
        segundosDeTranscricao: 600,
        transcricao: { disponivel: true, download: null },
        transcricaoProgress:
          p === null
            ? null
            : {
                done: 0,
                total: 47,
                atual: "",
                porcento_da_musica: 0,
                segundos_restantes: null,
                scan_id: "t1",
                ...p,
              },
        applyErrors: {},
      });
      return render(<EnrichReview />);
    }

    it("antes do primeiro evento, não inventa número nenhum", () => {
      renderTranscrevendo(null);
      expect(screen.getByText(/Escrevendo as letras/)).toBeVisible();
      expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    });

    it("mostra a fila, o arquivo e o quanto da música já foi", () => {
      renderTranscrevendo({
        done: 3,
        total: 47,
        atual: "Oh! Chuva.mp3",
        porcento_da_musica: 45,
        segundos_restantes: 9800,
      });
      expect(screen.getByText("Escrevendo as letras… 3 de 47")).toBeVisible();
      expect(screen.getByText("Oh! Chuva.mp3")).toBeVisible();
      expect(screen.getByText(textoDoTempoDaTranscricao(9800))).toBeVisible();
    });

    // Uma música leva MINUTOS: a barra tem de andar DENTRO dela, ou parece
    // travada por quatro minutos (a lição da v0.8.1).
    it("a barra anda dentro da música, e não só entre músicas", () => {
      const { rerender } = renderTranscrevendo({
        done: 3,
        total: 47,
        atual: "a.mp3",
        porcento_da_musica: 0,
      });
      const antes = Number(
        screen.getByRole("progressbar").getAttribute("aria-valuenow"),
      );
      act(() => {
        useEnrichStore.setState({
          transcricaoProgress: {
            done: 3,
            total: 47,
            atual: "a.mp3",
            porcento_da_musica: 90,
            segundos_restantes: null,
            scan_id: "t1",
          },
        });
      });
      rerender(<EnrichReview />);
      const depois = Number(
        screen.getByRole("progressbar").getAttribute("aria-valuenow"),
      );
      expect(depois).toBeGreaterThan(antes);
    });

    // `segundos_restantes` é null até a primeira música terminar: inventar um
    // número antes disso é a DECISIONS #85.
    it("sem medição, diz QUANDO o número vai aparecer", () => {
      renderTranscrevendo({ done: 0, total: 47, atual: "a.mp3" });
      expect(screen.getByText(textoDoTempoDaTranscricao(null))).toBeVisible();
    });

    it("dá para deixar rodando em segundo plano, e para cancelar", () => {
      renderTranscrevendo({ done: 1, total: 47, atual: "a.mp3" });
      fireEvent.click(
        screen.getByRole("button", { name: "Deixar rodando em segundo plano" }),
      );
      expect(useEnrichStore.getState().overlayOpen).toBe(false);
      expect(useEnrichStore.getState().status).toBe("transcribing");
    });

    it("cancelar para a fila e volta a idle", () => {
      setBackendForTests({
        enrichCancelScan: vi.fn(async () => {}),
      } as unknown as Backend);
      renderTranscrevendo({ done: 1, total: 47, atual: "a.mp3" });
      fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
      expect(useEnrichStore.getState().status).toBe("idle");
    });
  });
  // =========================================================================
  // V10.6 — aplicar não fecha a caixa, e a oferta de transcrição sobrevive
  // =========================================================================
  //
  // Relato de campo, verbatim: *"Achei que eu poderia clicar em aplicar e depois
  // trabalhar nas transcrições, mas não aconteceu… Simplesmente fechou a caixa e
  // aplicou essas 28… Mas agora tenho que começar de novo pra chegar na parte de
  // transcrição de novo."*
  //
  // O que se perdia não era um clique: era a varredura inteira — minutos, numa
  // biblioteca grande. As duas ações competiam, e a ordem importava de um jeito
  // que ninguém adivinha.
  describe("aplicar não fecha a caixa (V10.6)", () => {
    function backendQueGrava() {
      setBackendForTests({
        enrichApply: vi.fn(async (aplicacoes: EnrichApply[]) =>
          aplicacoes.map((a) => ok({ ...song(a.song_id, a.title), artist: a.artist })),
        ),
      } as unknown as Backend);
    }

    /*
      O grupo das gravadas nasce FECHADO, como o dobrado — 28 linhas "Gravada no
      arquivo." empurrariam a oferta de transcrição para fora da tela, que é
      justamente o que esta versão veio consertar. Ele é o ÚLTIMO da ordem.
    */
    function abrirGravadas() {
      const botoes = screen.getAllByRole("button", { name: /abrir para ver/i });
      fireEvent.click(botoes[botoes.length - 1]);
    }

    async function aplicar() {
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: /Aplicar selecionadas/ }),
        );
      });
    }

    it("a caixa continua aberta, e a oferta de transcrição continua nela", async () => {
      backendQueGrava();
      renderReview([ALTA], 0, 0, {
        semLetraNoFim: [10, 11, 12],
        segundosDeTranscricao: 10_800,
        disponivel: true,
      });
      expect(
        screen.getByText(textoDaOfertaDeTranscricao(3, 10_800)),
      ).toBeVisible();

      await aplicar();

      // a caixa NÃO fechou
      expect(screen.getByRole("dialog", { name: "Completar dados" })).toBeVisible();
      // e a oferta está lá, com o MESMO número: `sem_letra_no_fim` exclui, no
      // backend, quem a varredura achou letra — nenhuma linha aplicável pode
      // tirar alguém dessa lista
      expect(
        screen.getByText(textoDaOfertaDeTranscricao(3, 10_800)),
      ).toBeVisible();
      expect(
        screen.getByRole("button", { name: ROTULO_COMECAR_TRANSCRICAO }),
      ).toBeEnabled();
    });

    it("a linha gravada fica na tela, marcada e sem poder ser aplicada de novo", async () => {
      backendQueGrava();
      renderReview([ALTA]);
      await aplicar();

      // dobrado não é escondido: a frase do grupo já diz o desfecho
      expect(screen.getByText(tituloDoGrupo("gravadas", 1))).toBeVisible();
      abrirGravadas();
      expect(screen.getByText(ROTULO_DA_LINHA_GRAVADA)).toBeVisible();
      expect(screen.getByText(SELO_DA_LINHA_GRAVADA)).toBeVisible();
      const caixa = screen.getByRole("checkbox", { name: /faixa 1/ });
      expect(caixa).toBeDisabled();
      expect(caixa).not.toBeChecked();
      // e o botão não oferece mais nada a aplicar
      expect(
        screen.getByRole("button", { name: "Aplicar selecionadas (0)" }),
      ).toBeDisabled();
      expect(screen.getByText("Não há nada a aplicar nesta lista.")).toBeVisible();
    });

    /*
      V10.8 — O DESFECHO DIZ O QUE FOI FEITO, NA LINHA.

      A gravação que só foi possível depois de normalizar a etiqueta do MP3 (a
      sobra entre a etiqueta declarada e o primeiro quadro, medida em sete
      arquivos de um acervo real) devolve uma frase no `aviso` do resultado. Ela
      tem de CHEGAR À TELA: sem isso o programa teria mexido num byte do arquivo
      de alguém sem pedir e sem contar — e sem pedir é a decisão do produto (a
      pessoa já mandou gravar), mas sem contar é segredo.
    */
    it("a gravação que normalizou a etiqueta conta isso na linha", async () => {
      const frase =
        "para conseguir gravar, o programa corrigiu uma medida errada por dentro " +
        "da etiqueta deste MP3";
      setBackendForTests({
        enrichApply: vi.fn(async (aplicacoes: EnrichApply[]) =>
          aplicacoes.map((a) =>
            ok({ ...song(a.song_id, a.title), artist: a.artist }, frase),
          ),
        ),
      } as unknown as Backend);
      renderReview([ALTA]);
      await aplicar();

      abrirGravadas();
      // deu certo é a primeira coisa a ler; o que foi preciso fazer vem depois
      expect(screen.getByText(ROTULO_DA_LINHA_GRAVADA)).toBeVisible();
      expect(screen.getByText(frase)).toBeVisible();
      // e continua sendo uma linha gravada: nada a decidir, nada desabilitado
      // por erro
      expect(screen.getByRole("checkbox", { name: /faixa 1/ })).toBeDisabled();
      expect(screen.getByText(tituloDoGrupo("gravadas", 1))).toBeVisible();
      expect(
        screen.queryByText(tituloDoGrupo("nao-gravadas", 1)),
        "a linha gravou: dizer que ela não pôde ser gravada é a #139 outra vez",
      ).not.toBeInTheDocument();
    });

    it("a gravação comum não mostra frase nenhuma além do desfecho", async () => {
      backendQueGrava();
      renderReview([ALTA]);
      await aplicar();
      abrirGravadas();
      expect(screen.getByText(ROTULO_DA_LINHA_GRAVADA)).toBeVisible();
      expect(
        screen.queryByText(/corrigiu uma medida errada/),
        "aviso que aparece sempre é ruído que se aprende a ignorar",
      ).not.toBeInTheDocument();
    });

    it("a linha gravada sai do grupo dela e vai para o fim, num grupo próprio", async () => {
      backendQueGrava();
      renderReview([ALTA, MEDIA]);
      fireEvent.click(screen.getByRole("checkbox", { name: /faixa 2/ }));
      await aplicar();

      expect(screen.getByText(tituloDoGrupo("gravadas", 2))).toBeVisible();
      // e o grupo das letras encontradas sumiu: não sobrou nada nele
      expect(screen.queryByText(tituloDoGrupo("letras", 2))).not.toBeInTheDocument();
    });

    it("'Marcar todas' não ressuscita a linha gravada", async () => {
      backendQueGrava();
      renderReview([ALTA, MEDIA]);
      await aplicar(); // só a ALTA vem pré-marcada
      fireEvent.click(screen.getByRole("button", { name: "Marcar todas" }));
      expect(
        screen.getByRole("button", { name: "Aplicar selecionadas (1)" }),
        "só a MÉDIA, que ainda não foi gravada",
      ).toBeEnabled();
    });

    /*
      O caso que o relato de campo descreve inteiro: aplicar as 28 propostas de
      nome e DEPOIS mandar transcrever, na mesma caixa, sem varredura nova.
    */
    it("aplicar e depois transcrever, na mesma caixa e sem varrer de novo", async () => {
      const transcreverMusicas = vi.fn(async () => ({
        propostas: [
          proposal({
            song_id: 10,
            file_path: "/acervo/10.mp3",
            current_title: "AudioTrack 10",
            proposed_title: "AudioTrack 10",
            proposed_artist: null,
            lyrics: "na beira do mar",
            fonte: FONTE_TRANSCRICAO,
            confidence: "media",
          }),
        ],
        razao_medida: 1.2,
        razao_desta_maquina: 1.2,
      }));
      setBackendForTests({
        enrichApply: vi.fn(async (aplicacoes: EnrichApply[]) =>
          aplicacoes.map((a) => ok(song(a.song_id, a.title))),
        ),
        transcreverMusicas,
        onTranscricaoProgresso: vi.fn(async () => () => {}),
      } as unknown as Backend);
      renderReview([ALTA], 0, 0, {
        semLetraNoFim: [10],
        segundosDeTranscricao: 600,
        disponivel: true,
      });

      await aplicar();
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: ROTULO_COMECAR_TRANSCRICAO }),
        );
      });

      expect(transcreverMusicas).toHaveBeenCalledWith([10], expect.any(String));
      // a letra escrita entra na MESMA revisão, ao lado da linha gravada
      expect(screen.getByText(AVISO_LETRA_DE_MAQUINA)).toBeVisible();
      abrirGravadas();
      expect(screen.getByText(ROTULO_DA_LINHA_GRAVADA)).toBeVisible();
      // e a linha gravada continua sendo a única gravada
      expect(useEnrichStore.getState().aplicadas).toEqual([0]);
    });

    /*
      A segunda linha da MESMA música continua aplicável — e é o caso típico:
      a música que sobrou sem letra tem uma proposta de NOME pendente, e ganha a
      linha da letra quando a etapa 5 termina.

      Sem o eco fresco, esta segunda aplicação seria recusada com "a música mudou
      depois da busca" (QA A5) — e ela mudou, sim: mudamos nós, um clique antes.
    */
    it("aplicar o nome e depois a letra da MESMA música manda o eco do arquivo", async () => {
      const enrichApply = vi.fn(async (aplicacoes: EnrichApply[]) =>
        aplicacoes.map((a) => ok({ ...song(a.song_id, a.title), artist: a.artist })),
      );
      setBackendForTests({ enrichApply } as unknown as Backend);
      const nome = proposal({
        song_id: 7,
        file_path: "/acervo/7.mp3",
        current_title: "AudioTrack 07",
        proposed_title: "Oh! Chuva",
        proposed_artist: "Falamansa",
        lyrics: null,
        confidence: "baixa",
      });
      const letra = proposal({
        song_id: 7,
        file_path: "/acervo/7.mp3",
        current_title: "AudioTrack 07",
        proposed_title: "AudioTrack 07",
        proposed_artist: null,
        lyrics: "na beira do mar",
        fonte: FONTE_TRANSCRICAO,
        confidence: "media",
      });
      renderReview([letra, nome]);

      // a linha do NOME chega pré-marcada (grupo dobrado); a da letra, não
      await aplicar();
      expect(enrichApply.mock.calls[0][0][0].current_title).toBe("AudioTrack 07");
      expect(enrichApply.mock.calls[0][0][0].title).toBe("Oh! Chuva");

      // agora a letra, na mesma caixa
      fireEvent.click(
        screen.getByRole("checkbox", { name: /Aplicar a letra escrita/ }),
      );
      await aplicar();
      expect(enrichApply).toHaveBeenCalledTimes(2);
      expect(
        enrichApply.mock.calls[1][0][0].current_title,
        "o eco é o do ARQUIVO agora, e não o do instante da varredura",
      ).toBe("Oh! Chuva");
      expect(enrichApply.mock.calls[1][0][0].lyrics).toBe("na beira do mar");
    });

    // A5 — o que NÃO gravou fica na tela com o motivo, agora ao lado do que
    // gravou. Antes as gravadas saíam da lista, e quem visse só as recusadas não
    // tinha como saber que o resto foi.
    it("a que falhou fica com o erro, ao lado da que gravou", async () => {
      setBackendForTests({
        enrichApply: vi.fn(async () => [
          ok(song(1, "Faixa Um")),
          failed(2, "a música mudou depois da busca"),
        ]),
      } as unknown as Backend);
      renderReview([ALTA, MEDIA]);
      fireEvent.click(screen.getByRole("checkbox", { name: /faixa 2/ }));
      await aplicar();

      expect(screen.getByText("a música mudou depois da busca")).toBeVisible();
      abrirGravadas();
      expect(screen.getByText(ROTULO_DA_LINHA_GRAVADA)).toBeVisible();
    });

    // Só o "Fechar" (e o Esc) fecham a caixa.
    it("o Fechar continua fechando", async () => {
      backendQueGrava();
      renderReview([ALTA]);
      await aplicar();
      fireEvent.click(screen.getByRole("button", { name: "Fechar" }));
      expect(useEnrichStore.getState().status).toBe("idle");
    });

    it("o Esc continua fechando a revisão", async () => {
      backendQueGrava();
      renderReview([ALTA]);
      await aplicar();
      fireEvent.keyDown(window, { key: "Escape" });
      expect(useEnrichStore.getState().status).toBe("idle");
    });

    /*
      V10.6, item 2 — fechar com a oferta na tela AVISA. Informativo, e não uma
      confirmação: com o bloco permanente de Configurações a lista já não se
      perde.
    */
    it("fechar com a oferta na tela avisa onde ela continua", () => {
      renderReview([ALTA], 0, 0, {
        semLetraNoFim: [10, 11],
        segundosDeTranscricao: 600,
        disponivel: true,
      });
      fireEvent.click(screen.getByRole("button", { name: "Fechar" }));
      const toasts = useToastStore.getState().toasts;
      expect(toasts).toHaveLength(1);
      expect(toasts[0].message).toBe(avisoDeTranscricaoPendente(2));
    });

    it("o Esc avisa igual — a mesma saída, o mesmo aviso", () => {
      renderReview([ALTA], 0, 0, {
        semLetraNoFim: [10, 11],
        segundosDeTranscricao: 600,
        disponivel: true,
      });
      fireEvent.keyDown(window, { key: "Escape" });
      expect(useToastStore.getState().toasts[0].message).toBe(
        avisoDeTranscricaoPendente(2),
      );
    });

    // "Agora não" é uma resposta: quem respondeu não é avisado de novo.
    it("respondida a oferta com 'Agora não', fechar não avisa nada", () => {
      renderReview([ALTA], 0, 0, {
        semLetraNoFim: [10, 11],
        segundosDeTranscricao: 600,
        disponivel: true,
      });
      fireEvent.click(screen.getByRole("button", { name: "Agora não" }));
      fireEvent.click(screen.getByRole("button", { name: "Fechar" }));
      expect(useToastStore.getState().toasts).toHaveLength(0);
    });

    /*
      Contraste AA no estado NOVO. A linha gravada NÃO recebe opacidade: ela é o
      registro do que a pessoa acabou de fazer, e é o que ela vai reler para
      conferir — opacidade em cima do cinza secundário derrubaria o contraste
      abaixo de AA (DECISIONS #69). O apagado fica para a linha com ERRO, cuja
      informação é a frase vermelha.
    */
    it("o selo e a frase da linha gravada passam em AA", async () => {
      backendQueGrava();
      renderReview([ALTA]);
      await aplicar();
      abrirGravadas();

      const selo = screen.getByText(SELO_DA_LINHA_GRAVADA);
      expect(
        contrastRatio(corDoTexto(selo.className), "#CCFBF1"),
        "o selo GRAVADA",
      ).toBeGreaterThanOrEqual(AA_TEXTO_NORMAL);

      const frase = screen.getByText(ROTULO_DA_LINHA_GRAVADA);
      for (const fundo of Object.values(FUNDOS_DA_LINHA)) {
        expect(
          contrastRatio(corDoTexto(frase.className), fundo),
          `a frase sobre ${fundo}`,
        ).toBeGreaterThanOrEqual(AA_TEXTO_NORMAL);
      }
      // e a linha inteira fica em tinta cheia
      expect(frase.closest("li")!.className).not.toContain("opacity");
    });

    // Esc DURANTE a varredura continua sendo "segundo plano", não fechar — e
    // segundo plano não descarta nada, então não avisa nada.
    it("Esc durante a varredura continua mandando para segundo plano", () => {
      renderScanning({ done: 3, total: 10, atual: "a.mp3", etapa: "" });
      fireEvent.keyDown(window, { key: "Escape" });
      expect(useEnrichStore.getState().status).toBe("scanning");
      expect(useEnrichStore.getState().overlayOpen).toBe(false);
      expect(useToastStore.getState().toasts).toHaveLength(0);
    });
  });
});
