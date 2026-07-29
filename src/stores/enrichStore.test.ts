import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  setBackendForTests,
  type Backend,
  type EnrichProgress,
  type EnrichProposal,
  type EnrichScanResult,
} from "../lib/api";
import { textoSemPropostas } from "../lib/curadoria";
import { useEnrichStore } from "./enrichStore";
import { useToastStore } from "./toastStore";
import { useUiStore } from "./uiStore";

function proposal(overrides: Partial<EnrichProposal> = {}): EnrichProposal {
  return {
    song_id: 1,
    file_path: "/acervo/a.mp3",
    current_title: "a",
    current_artist: null,
    proposed_title: "A Canção",
    proposed_artist: "Artista",
    lyrics: "letra",
    confidence: "alta",
    fonte: "LRCLIB",
    // a música não tinha letra: a proposta acrescenta (CRÍTICO-1 — é o par
    // has_lyrics + lyrics que diz se a aplicação DESTRUIRIA uma letra)
    has_lyrics: false,
    letra_origem: null,
    // V9 — a proposta comum não é conflito e não troca nome escrito por gente
    conflito: null,
    substitui_nome_escrito: false,
    error: null,
    ...overrides,
  };
}

/**
 * O que a varredura em lote devolve desde o QA A2: um OBJETO, não a lista.
 * `sem_perguntar_ao_som` conta as músicas que a etapa 2 deixou de perguntar
 * depois de se desligar — zero é o caso normal, e é o padrão daqui.
 */
function scanResult(
  propostas: EnrichProposal[],
  semPerguntarAoSom = 0,
): EnrichScanResult {
  return { propostas, sem_perguntar_ao_som: semPerguntarAoSom };
}

describe("enrichStore (V5 — F13)", () => {
  beforeEach(() => {
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
      modo: "completar",
    });
    useToastStore.setState({ toasts: [] });
    setBackendForTests(null);
  });

  it("startScan: scanning → review com as propostas do backend", async () => {
    const proposals = [proposal()];
    const enrichFolderScan = vi.fn(async () => scanResult(proposals));
    setBackendForTests({ enrichFolderScan } as unknown as Backend);

    const pending = useEnrichStore.getState().startScan("/acervo/1");
    expect(useEnrichStore.getState().status).toBe("scanning");
    expect(useEnrichStore.getState().folderPrefix).toBe("/acervo/1");
    await pending;

    // sem chave do Vagalume configurada, o parâmetro vai como null
    // V9 — o modo viaja com a varredura: o padrão é o trabalho barato
    expect(enrichFolderScan).toHaveBeenCalledWith(
      "/acervo/1",
      expect.any(String),
      null,
      "completar",
    );
    expect(useEnrichStore.getState().status).toBe("review");
    expect(useEnrichStore.getState().proposals).toEqual(proposals);
  });

  // V8/F18 — a chave é preferência de quem usa e viaja como PARÂMETRO da
  // varredura; o backend não guarda credencial nenhuma.
  it("startScan leva a chave do Vagalume configurada nas preferências", async () => {
    const enrichFolderScan = vi.fn(async () => scanResult([]));
    setBackendForTests({ enrichFolderScan } as unknown as Backend);
    useUiStore.getState().setVagalumeApiKey("chave-da-pessoa");

    await useEnrichStore.getState().startScan("");

    expect(enrichFolderScan).toHaveBeenCalledWith(
      "",
      expect.any(String),
      "chave-da-pessoa",
      "completar",
    );
    useUiStore.getState().setVagalumeApiKey("");
  });

  // V9 — a conferência é OUTRO trabalho, disparado de propósito. O store
  // guarda qual deles rodou: o desfecho vazio de uma conferência não pode ser
  // narrado como o de uma busca de dados ("conferimos as N incompletas").
  it("startScan leva o modo pedido, e o desfecho vazio fala a língua dele", async () => {
    const enrichFolderScan = vi.fn(async () => scanResult([]));
    setBackendForTests({ enrichFolderScan } as unknown as Backend);

    const pending = useEnrichStore.getState().startScan("", "conferencia");
    expect(useEnrichStore.getState().modo).toBe("conferencia");
    useEnrichStore.getState().hideOverlay();
    await pending;

    expect(enrichFolderScan).toHaveBeenCalledWith(
      "",
      expect.any(String),
      null,
      "conferencia",
    );
    expect(useToastStore.getState().toasts[0].message).toBe(
      textoSemPropostas(null, "conferencia"),
    );
  });

  it("bloqueia disparo duplo enquanto a varredura está em andamento", async () => {
    let resolve!: (r: EnrichScanResult) => void;
    const enrichFolderScan = vi.fn(
      () => new Promise<EnrichScanResult>((r) => (resolve = r)),
    );
    setBackendForTests({ enrichFolderScan } as unknown as Backend);

    const first = useEnrichStore.getState().startScan("");
    await useEnrichStore.getState().startScan("/outra");
    expect(enrichFolderScan).toHaveBeenCalledTimes(1);
    expect(useEnrichStore.getState().folderPrefix).toBe("");

    resolve(scanResult([proposal()]));
    await first;
    expect(useEnrichStore.getState().status).toBe("review");
  });

  it("fechar DURANTE a varredura descarta o resultado quando ele chegar (guarda de corrida)", async () => {
    let resolve!: (r: EnrichScanResult) => void;
    const enrichFolderScan = vi.fn(
      () => new Promise<EnrichScanResult>((r) => (resolve = r)),
    );
    setBackendForTests({ enrichFolderScan } as unknown as Backend);

    const pending = useEnrichStore.getState().startScan("");
    useEnrichStore.getState().close();
    expect(useEnrichStore.getState().status).toBe("idle");

    resolve(scanResult([proposal()]));
    await pending;
    expect(useEnrichStore.getState().status).toBe("idle");
    expect(useEnrichStore.getState().proposals).toEqual([]);
  });

  // Caminho DEFENSIVO: o backend real nunca rejeita por rede (erros viram
  // proposals com error — DECISIONS #47); um invoke rejeitado (infraestrutura)
  // é testado com um fake injetado que rejeita, não com o _offline do mock.
  it("invoke rejeitado (defensivo): toast 'Sem conexão…' e volta a idle", async () => {
    const enrichFolderScan = vi.fn(async () => {
      throw new Error("falha de infraestrutura");
    });
    setBackendForTests({ enrichFolderScan } as unknown as Backend);

    await useEnrichStore.getState().startScan("");
    expect(useEnrichStore.getState().status).toBe("idle");
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toBe(
      "Sem conexão — a busca de dados precisa de internet.",
    );
    expect(toasts[0].kind).toBe("warning");
  });

  it("falha após fechar não emite toast (resultado descartado)", async () => {
    let reject!: (e: Error) => void;
    const enrichFolderScan = vi.fn(
      () => new Promise<EnrichScanResult>((_r, rj) => (reject = rj)),
    );
    setBackendForTests({ enrichFolderScan } as unknown as Backend);

    const pending = useEnrichStore.getState().startScan("");
    useEnrichStore.getState().close();
    reject(new Error("sem conexão"));
    await pending;
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("close limpa as propostas da revisão", async () => {
    setBackendForTests({
      enrichFolderScan: vi.fn(async () => scanResult([proposal()])),
    } as unknown as Backend);
    await useEnrichStore.getState().startScan("");
    expect(useEnrichStore.getState().status).toBe("review");
    useEnrichStore.getState().close();
    expect(useEnrichStore.getState().status).toBe("idle");
    expect(useEnrichStore.getState().proposals).toEqual([]);
    expect(useEnrichStore.getState().overlayOpen).toBe(false);
  });

  describe("progresso da varredura (evento enrich:progress)", () => {
    it("guarda {done,total,atual} conforme os eventos chegam e zera ao terminar", async () => {
      let emit!: (p: EnrichProgress) => void;
      let resolve!: (r: EnrichScanResult) => void;
      const onEnrichProgress = vi.fn(async (cb: (p: EnrichProgress) => void) => {
        emit = cb;
        return () => {};
      });
      setBackendForTests({
        onEnrichProgress,
        enrichFolderScan: vi.fn(
          () => new Promise<EnrichScanResult>((r) => (resolve = r)),
        ),
      } as unknown as Backend);

      const pending = useEnrichStore.getState().startScan("");
      // antes do primeiro evento: sem progresso (overlay fica indeterminado)
      expect(useEnrichStore.getState().progress).toBeNull();
      await Promise.resolve();
      const scan_id = useEnrichStore.getState().scanId;

      emit({
        done: 0,
        total: 94,
        atual: "a.mp3",
        etapa: "procurando no LRCLIB",
        scan_id,
      });
      expect(useEnrichStore.getState().progress).toEqual({
        done: 0,
        total: 94,
        atual: "a.mp3",
        etapa: "procurando no LRCLIB",
        scan_id,
      });
      emit({
        done: 12,
        total: 94,
        atual: "b.mp3",
        etapa: "procurando no LRCLIB",
        scan_id,
      });
      expect(useEnrichStore.getState().progress?.done).toBe(12);

      resolve(scanResult([proposal()]));
      await pending;
      expect(useEnrichStore.getState().progress).toBeNull();
    });

    // M4: o "Cancelar" antigo só soltava a guarda de corrida — a varredura
    // zumbi continuava emitindo e ESTRAGAVA a barra da varredura seguinte.
    it("IGNORA eventos de progresso de outra varredura (zumbi da anterior)", async () => {
      let emit!: (p: EnrichProgress) => void;
      setBackendForTests({
        onEnrichProgress: vi.fn(async (cb: (p: EnrichProgress) => void) => {
          emit = cb;
          return () => {};
        }),
        enrichFolderScan: vi.fn(() => new Promise<EnrichScanResult>(() => {})),
      } as unknown as Backend);

      void useEnrichStore.getState().startScan("");
      await Promise.resolve();
      const scan_id = useEnrichStore.getState().scanId;

      emit({
        done: 90,
        total: 94,
        atual: "zumbi.mp3",
        etapa: "procurando no LRCLIB",
        scan_id: "varredura-antiga",
      });
      expect(useEnrichStore.getState().progress).toBeNull();

      emit({
        done: 1,
        total: 3,
        atual: "atual.mp3",
        etapa: "procurando no LRCLIB",
        scan_id,
      });
      expect(useEnrichStore.getState().progress?.done).toBe(1);
      expect(useEnrichStore.getState().progress?.total).toBe(3);
    });
  });

  describe("cancelamento de verdade (M4)", () => {
    it("close DURANTE a varredura chama enrichCancelScan com o scanId da varredura", async () => {
      const enrichCancelScan = vi.fn(async () => {});
      setBackendForTests({
        enrichCancelScan,
        enrichFolderScan: vi.fn(() => new Promise<EnrichScanResult>(() => {})),
      } as unknown as Backend);

      void useEnrichStore.getState().startScan("");
      const scanId = useEnrichStore.getState().scanId;
      expect(scanId).not.toBe("");

      useEnrichStore.getState().close();
      await Promise.resolve();
      expect(enrichCancelScan).toHaveBeenCalledWith(scanId);
      expect(useEnrichStore.getState().scanId).toBe("");
    });

    it("close na revisão (nada rodando) NÃO chama enrichCancelScan", async () => {
      const enrichCancelScan = vi.fn(async () => {});
      setBackendForTests({
        enrichCancelScan,
        enrichFolderScan: vi.fn(async () => scanResult([proposal()])),
      } as unknown as Backend);

      await useEnrichStore.getState().startScan("");
      useEnrichStore.getState().close();
      await Promise.resolve();
      expect(enrichCancelScan).not.toHaveBeenCalled();
    });

    it("backend sem enrichCancelScan não quebra o cancelamento", async () => {
      setBackendForTests({
        enrichFolderScan: vi.fn(() => new Promise<EnrichScanResult>(() => {})),
      } as unknown as Backend);
      void useEnrichStore.getState().startScan("");
      expect(() => useEnrichStore.getState().close()).not.toThrow();
      expect(useEnrichStore.getState().status).toBe("idle");
    });

    it("scanInFlight segue true depois do cancelamento até o invoke responder", async () => {
      let resolve!: (r: EnrichScanResult) => void;
      const enrichFolderScan = vi.fn(
        () => new Promise<EnrichScanResult>((r) => (resolve = r)),
      );
      setBackendForTests({
        enrichFolderScan,
        enrichCancelScan: vi.fn(async () => {}),
      } as unknown as Backend);

      const pending = useEnrichStore.getState().startScan("");
      expect(useEnrichStore.getState().scanInFlight).toBe(true);

      useEnrichStore.getState().close();
      expect(useEnrichStore.getState().status).toBe("idle");
      // o invoke ainda está na rede: uma segunda varredura sobreporia as duas
      expect(useEnrichStore.getState().scanInFlight).toBe(true);
      await useEnrichStore.getState().startScan("/outra");
      expect(enrichFolderScan).toHaveBeenCalledTimes(1);

      resolve(scanResult([]));
      await pending;
      expect(useEnrichStore.getState().scanInFlight).toBe(false);
      // agora sim: nova varredura permitida
      void useEnrichStore.getState().startScan("/outra");
      expect(enrichFolderScan).toHaveBeenCalledTimes(2);
    });

    it("cancela a assinatura ao terminar a varredura", async () => {
      const unlisten = vi.fn();
      setBackendForTests({
        onEnrichProgress: vi.fn(async () => unlisten),
        enrichFolderScan: vi.fn(async () => scanResult([proposal()])),
      } as unknown as Backend);

      await useEnrichStore.getState().startScan("");
      expect(unlisten).toHaveBeenCalledTimes(1);
    });

    it("backend sem onEnrichProgress não quebra a varredura", async () => {
      setBackendForTests({
        enrichFolderScan: vi.fn(async () => scanResult([proposal()])),
      } as unknown as Backend);
      await useEnrichStore.getState().startScan("");
      expect(useEnrichStore.getState().status).toBe("review");
    });
  });

  describe("segundo plano (a varredura é somente leitura — não trava o app)", () => {
    it("hideOverlay esconde o overlay e a varredura CONTINUA (resultado chega na store)", async () => {
      let resolve!: (r: EnrichScanResult) => void;
      setBackendForTests({
        enrichFolderScan: vi.fn(
          () => new Promise<EnrichScanResult>((r) => (resolve = r)),
        ),
      } as unknown as Backend);

      const pending = useEnrichStore.getState().startScan("/acervo");
      expect(useEnrichStore.getState().overlayOpen).toBe(true);

      useEnrichStore.getState().hideOverlay();
      expect(useEnrichStore.getState().overlayOpen).toBe(false);
      expect(useEnrichStore.getState().status).toBe("scanning");

      const proposals = [proposal(), proposal({ song_id: 2 })];
      resolve(scanResult(proposals));
      await pending;
      expect(useEnrichStore.getState().status).toBe("review");
      expect(useEnrichStore.getState().proposals).toEqual(proposals);
      // o overlay NÃO se abre sozinho: o usuário está trabalhando
      expect(useEnrichStore.getState().overlayOpen).toBe(false);
    });

    it("fim em segundo plano COM propostas: toast avisando (plural)", async () => {
      setBackendForTests({
        enrichFolderScan: vi.fn(async () =>
          scanResult([proposal(), proposal({ song_id: 2 })]),
        ),
      } as unknown as Backend);

      const pending = useEnrichStore.getState().startScan("");
      useEnrichStore.getState().hideOverlay();
      await pending;

      const toasts = useToastStore.getState().toasts;
      expect(toasts).toHaveLength(1);
      expect(toasts[0].message).toBe(
        "Dados encontrados para 2 músicas — abra a revisão para conferir.",
      );
      expect(useEnrichStore.getState().status).toBe("review");
    });

    it("fim em segundo plano com UMA proposta: toast no singular", async () => {
      setBackendForTests({
        enrichFolderScan: vi.fn(async () => scanResult([proposal()])),
      } as unknown as Backend);

      const pending = useEnrichStore.getState().startScan("");
      useEnrichStore.getState().hideOverlay();
      await pending;

      expect(useToastStore.getState().toasts[0].message).toBe(
        "Dados encontrados para 1 música — abra a revisão para conferir.",
      );
    });

    // MÉDIO-11 — este backend nem tem canal de progresso: não sabemos quantas
    // músicas foram conferidas. Antes isso virava `0`, e o aviso afirmava que
    // a pasta estava completa. Sem o número, o texto não conta ninguém.
    it("fim em segundo plano SEM propostas e SEM progresso: aviso sem contagem inventada", async () => {
      setBackendForTests({
        enrichFolderScan: vi.fn(async () => scanResult([])),
      } as unknown as Backend);

      const pending = useEnrichStore.getState().startScan("");
      useEnrichStore.getState().hideOverlay();
      await pending;

      expect(useEnrichStore.getState().scannedTotal).toBeNull();
      expect(useToastStore.getState().toasts[0].message).toBe(
        textoSemPropostas(null, "completar"),
      );
      expect(useEnrichStore.getState().status).toBe("idle");
      expect(useEnrichStore.getState().overlayOpen).toBe(false);
    });

    // A6: com ~3% de cobertura do LRCLIB o normal é varrer 94 e achar zero —
    // "nada a ajustar" fazia o coordenador entender "pasta completa".
    it("fim em segundo plano SEM propostas mas COM candidatas: toast honesto com o N varrido", async () => {
      let emit!: (p: EnrichProgress) => void;
      let resolve!: (r: EnrichScanResult) => void;
      setBackendForTests({
        onEnrichProgress: vi.fn(async (cb: (p: EnrichProgress) => void) => {
          emit = cb;
          return () => {};
        }),
        enrichFolderScan: vi.fn(
          () => new Promise<EnrichScanResult>((r) => (resolve = r)),
        ),
      } as unknown as Backend);

      const pending = useEnrichStore.getState().startScan("");
      useEnrichStore.getState().hideOverlay();
      await Promise.resolve();
      const scan_id = useEnrichStore.getState().scanId;
      emit({
        done: 81,
        total: 81,
        atual: "z.mp3",
        etapa: "procurando no LRCLIB",
        scan_id,
      });
      resolve(scanResult([]));
      await pending;

      expect(useToastStore.getState().toasts[0].message).toBe(
        textoSemPropostas(81, "completar"),
      );
      expect(useEnrichStore.getState().status).toBe("idle");
    });

    it("uma candidata só: o texto honesto vai para o singular", async () => {
      let emit!: (p: EnrichProgress) => void;
      let resolve!: (r: EnrichScanResult) => void;
      setBackendForTests({
        onEnrichProgress: vi.fn(async (cb: (p: EnrichProgress) => void) => {
          emit = cb;
          return () => {};
        }),
        enrichFolderScan: vi.fn(
          () => new Promise<EnrichScanResult>((r) => (resolve = r)),
        ),
      } as unknown as Backend);

      const pending = useEnrichStore.getState().startScan("");
      useEnrichStore.getState().hideOverlay();
      await Promise.resolve();
      emit({
        done: 1,
        total: 1,
        atual: "z.mp3",
        etapa: "procurando no LRCLIB",
        scan_id: useEnrichStore.getState().scanId,
      });
      resolve(scanResult([]));
      await pending;

      expect(useToastStore.getState().toasts[0].message).toBe(
        textoSemPropostas(1, "completar"),
      );
    });

    it("scannedTotal guarda o total varrido (último evento) para a tela de resultado", async () => {
      let emit!: (p: EnrichProgress) => void;
      let resolve!: (r: EnrichScanResult) => void;
      setBackendForTests({
        onEnrichProgress: vi.fn(async (cb: (p: EnrichProgress) => void) => {
          emit = cb;
          return () => {};
        }),
        enrichFolderScan: vi.fn(
          () => new Promise<EnrichScanResult>((r) => (resolve = r)),
        ),
      } as unknown as Backend);

      const pending = useEnrichStore.getState().startScan("");
      await Promise.resolve();
      emit({
        done: 94,
        total: 94,
        atual: "z.mp3",
        etapa: "procurando no LRCLIB",
        scan_id: useEnrichStore.getState().scanId,
      });
      resolve(scanResult([]));
      await pending;

      expect(useEnrichStore.getState().scannedTotal).toBe(94);
      expect(useEnrichStore.getState().status).toBe("review");
    });
  });

  // -------------------------------------------------------------------------
  // QA A2 — o retorno virou objeto, e o número que ele traz precisa chegar
  // -------------------------------------------------------------------------
  //
  // `enrich_folder_scan` deixou de devolver `EnrichProposal[]`. Se o store
  // continuasse tratando a resposta como array, o app real receberia um objeto
  // onde espera uma lista — e nenhuma suíte pegaria, porque o mock devolve o
  // que o mock quiser. É a classe de defeito da DECISIONS #92: só existe
  // dentro do binário.
  describe("o resultado da varredura (QA A2)", () => {
    it("lê as propostas de dentro do objeto, não da resposta inteira", async () => {
      setBackendForTests({
        enrichFolderScan: vi.fn(async () => scanResult([proposal()])),
      } as unknown as Backend);
      await useEnrichStore.getState().startScan("");
      expect(useEnrichStore.getState().proposals).toHaveLength(1);
      expect(useEnrichStore.getState().proposals[0].song_id).toBe(1);
    });

    it("guarda quantas músicas não chegaram a ser perguntadas ao som", async () => {
      setBackendForTests({
        enrichFolderScan: vi.fn(async () => scanResult([proposal()], 37)),
      } as unknown as Backend);
      await useEnrichStore.getState().startScan("", "conferencia");
      expect(useEnrichStore.getState().semPerguntarAoSom).toBe(37);
    });

    it("a conta zera a cada varredura nova — nunca sobra da anterior", async () => {
      setBackendForTests({
        enrichFolderScan: vi.fn(async () => scanResult([proposal()], 37)),
      } as unknown as Backend);
      await useEnrichStore.getState().startScan("", "conferencia");
      expect(useEnrichStore.getState().semPerguntarAoSom).toBe(37);

      setBackendForTests({
        enrichFolderScan: vi.fn(async () => scanResult([proposal()])),
      } as unknown as Backend);
      await useEnrichStore.getState().startScan("", "conferencia");
      expect(useEnrichStore.getState().semPerguntarAoSom).toBe(0);
    });

    it("fechar a revisão também zera a conta", async () => {
      setBackendForTests({
        enrichFolderScan: vi.fn(async () => scanResult([proposal()], 37)),
      } as unknown as Backend);
      await useEnrichStore.getState().startScan("", "conferencia");
      useEnrichStore.getState().close();
      expect(useEnrichStore.getState().semPerguntarAoSom).toBe(0);
    });

    // O desfecho em segundo plano é onde o silêncio mais engana: a pessoa
    // mandou conferir e foi fazer outra coisa. Um toast verde dizendo
    // "conferimos 40 e o som não contradisse nenhuma" com 37 nunca perguntadas
    // é a DECISIONS #86 em uma linha.
    it("sem propostas e com a etapa parada: o toast conta, e não é de sucesso", async () => {
      setBackendForTests({
        enrichFolderScan: vi.fn(async () => scanResult([], 37)),
      } as unknown as Backend);

      const pending = useEnrichStore.getState().startScan("", "conferencia");
      useEnrichStore.getState().hideOverlay();
      await pending;

      const toast = useToastStore.getState().toasts[0];
      expect(toast.message).toBe(textoSemPropostas(null, "conferencia", 37));
      expect(toast.message).toContain("37");
      expect(toast.kind).toBe("warning");
    });

    it("sem propostas e com tudo perguntado: o toast é o de sempre", async () => {
      setBackendForTests({
        enrichFolderScan: vi.fn(async () => scanResult([])),
      } as unknown as Backend);

      const pending = useEnrichStore.getState().startScan("", "conferencia");
      useEnrichStore.getState().hideOverlay();
      await pending;

      const toast = useToastStore.getState().toasts[0];
      expect(toast.message).toBe(textoSemPropostas(null, "conferencia"));
      expect(toast.kind).toBe("success");
    });
  });

  describe("retainFailures — o que não gravou fica na tela (A5)", () => {
    it("mantém só as linhas que falharam, com o erro devolvido pelo backend", async () => {
      setBackendForTests({
        enrichFolderScan: vi.fn(async () =>
          scanResult([proposal({ song_id: 1 }), proposal({ song_id: 2 })]),
        ),
      } as unknown as Backend);
      await useEnrichStore.getState().startScan("");

      useEnrichStore.getState().retainFailures([
        { song_id: 2, song: null, error: "a música mudou depois da busca" },
      ]);

      const state = useEnrichStore.getState();
      expect(state.status).toBe("review");
      expect(state.proposals.map((p) => p.song_id)).toEqual([2]);
      expect(state.applyErrors).toEqual({
        2: "a música mudou depois da busca",
      });
    });

    it("erro nulo vira uma mensagem genérica (nunca uma linha sem explicação)", async () => {
      setBackendForTests({
        enrichFolderScan: vi.fn(async () => scanResult([proposal({ song_id: 1 })])),
      } as unknown as Backend);
      await useEnrichStore.getState().startScan("");
      useEnrichStore
        .getState()
        .retainFailures([{ song_id: 1, song: null, error: null }]);
      expect(useEnrichStore.getState().applyErrors[1]).toBe(
        "não foi possível gravar",
      );
    });

    it("close e uma nova varredura limpam os erros do apply anterior", async () => {
      setBackendForTests({
        enrichFolderScan: vi.fn(async () => scanResult([proposal({ song_id: 1 })])),
      } as unknown as Backend);
      await useEnrichStore.getState().startScan("");
      useEnrichStore
        .getState()
        .retainFailures([{ song_id: 1, song: null, error: "falhou" }]);

      useEnrichStore.getState().close();
      expect(useEnrichStore.getState().applyErrors).toEqual({});

      await useEnrichStore.getState().startScan("");
      expect(useEnrichStore.getState().applyErrors).toEqual({});
    });

    it("fim com o overlay ABERTO não emite toast (o overlay já mostra o resultado)", async () => {
      setBackendForTests({
        enrichFolderScan: vi.fn(async () => scanResult([proposal()])),
      } as unknown as Backend);
      await useEnrichStore.getState().startScan("");
      expect(useToastStore.getState().toasts).toHaveLength(0);
      expect(useEnrichStore.getState().overlayOpen).toBe(true);
    });

    it("openOverlay reabre a revisão sem disparar nova varredura", async () => {
      const enrichFolderScan = vi.fn(async () => scanResult([proposal()]));
      setBackendForTests({ enrichFolderScan } as unknown as Backend);

      const pending = useEnrichStore.getState().startScan("");
      useEnrichStore.getState().hideOverlay();
      await pending;

      useEnrichStore.getState().openOverlay();
      expect(useEnrichStore.getState().overlayOpen).toBe(true);
      expect(useEnrichStore.getState().status).toBe("review");
      expect(enrichFolderScan).toHaveBeenCalledTimes(1);
    });

    it("varredura em segundo plano ainda bloqueia um segundo disparo", async () => {
      const enrichFolderScan = vi.fn(
        () => new Promise<EnrichScanResult>(() => {}),
      );
      setBackendForTests({ enrichFolderScan } as unknown as Backend);

      void useEnrichStore.getState().startScan("");
      useEnrichStore.getState().hideOverlay();
      await useEnrichStore.getState().startScan("/outra");
      expect(enrichFolderScan).toHaveBeenCalledTimes(1);
    });

    it("cancelar (close) durante varredura em segundo plano descarta o resultado", async () => {
      let resolve!: (r: EnrichScanResult) => void;
      setBackendForTests({
        enrichFolderScan: vi.fn(
          () => new Promise<EnrichScanResult>((r) => (resolve = r)),
        ),
      } as unknown as Backend);

      const pending = useEnrichStore.getState().startScan("");
      useEnrichStore.getState().hideOverlay();
      useEnrichStore.getState().close();

      resolve(scanResult([proposal()]));
      await pending;
      expect(useEnrichStore.getState().status).toBe("idle");
      expect(useEnrichStore.getState().proposals).toEqual([]);
      expect(useToastStore.getState().toasts).toHaveLength(0);
    });
  });
});
