import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  setBackendForTests,
  type Backend,
  type EnrichProgress,
  type EnrichProposal,
  type EnrichScanResult,
  type TranscricaoProgresso,
} from "../lib/api";
import { textoSemPropostas } from "../lib/curadoria";
import { useEnrichStore } from "./enrichStore";
import { useToastStore } from "./toastStore";

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
    // V10 — a varredura nunca marca instrumental nem extrai refrão: as duas
    // coisas saem da etapa 5, que é outro comando
    marcar_instrumental: false,
    refrao: null,
    aviso: null,
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
  /**
   * V10 — quem sobrou sem letra, e o tempo de transcrever isso. A lista vem
   * do backend em ids, porque é exatamente o que `transcreverMusicas` recebe.
   */
  semLetraNoFim: number[] = [],
  segundosDeTranscricao = 0,
  /**
   * QA A1 — a estimativa acima é medição desta máquina? O padrão é `false`
   * porque é o estado de toda instalação nova: só a primeira fila da etapa 5
   * produz amostra.
   */
  estimativaMedida = false,
): EnrichScanResult {
  return {
    propostas,
    sem_perguntar_ao_som: semPerguntarAoSom,
    sem_letra_no_fim: semLetraNoFim,
    segundos_de_transcricao: segundosDeTranscricao,
    estimativa_medida_nesta_maquina: estimativaMedida,
  };
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
      semLetraNoFim: [],
      segundosDeTranscricao: 0,
      estimativaMedidaNestaMaquina: false,
      transcricao: { disponivel: false, download: null },
      transcricaoProgress: null,
      transcricaoDispensada: false,
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
    expect(enrichFolderScan).toHaveBeenCalledWith("/acervo/1", expect.any(String));
    expect(useEnrichStore.getState().status).toBe("review");
    expect(useEnrichStore.getState().proposals).toEqual(proposals);
  });

  // V10 — nenhuma etapa do funil pede credencial (DECISIONS #110): a etapa do
  // Vagalume saiu do produto e o `lyrics.ovh` que a substituiu não pede nada.
  // O payload tem DOIS argumentos, e nenhum deles é segredo — há guarda no
  // backend contra a volta de um parâmetro de credencial.
  it("o disparo não manda credencial nenhuma", async () => {
    const enrichFolderScan = vi.fn(async () => scanResult([]));
    setBackendForTests({ enrichFolderScan } as unknown as Backend);

    await useEnrichStore.getState().startScan("");

    expect(enrichFolderScan).toHaveBeenCalledWith("", expect.any(String));
    expect(enrichFolderScan.mock.calls[0]).toHaveLength(2);
  });

  // V10 — os modos sumiram (DECISIONS #102): há UMA varredura, e o payload
  // não leva mais `modo`. Um campo a mais seria ignorado pelo backend, mas
  // mandá-lo manteria vivo, no frontend, o vocabulário que o produto abandonou.
  it("o disparo não manda modo nenhum, e o desfecho vazio é o único que existe", async () => {
    const enrichFolderScan = vi.fn(async () => scanResult([]));
    setBackendForTests({ enrichFolderScan } as unknown as Backend);

    const pending = useEnrichStore.getState().startScan("");
    useEnrichStore.getState().hideOverlay();
    await pending;

    expect(enrichFolderScan).toHaveBeenCalledWith("", expect.any(String));
    expect(enrichFolderScan.mock.calls[0]).toHaveLength(2);
    expect(useToastStore.getState().toasts[0].message).toBe(
      textoSemPropostas(null),
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
        textoSemPropostas(null),
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
        textoSemPropostas(81),
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
        textoSemPropostas(1),
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
      await useEnrichStore.getState().startScan("");
      expect(useEnrichStore.getState().semPerguntarAoSom).toBe(37);
    });

    it("a conta zera a cada varredura nova — nunca sobra da anterior", async () => {
      setBackendForTests({
        enrichFolderScan: vi.fn(async () => scanResult([proposal()], 37)),
      } as unknown as Backend);
      await useEnrichStore.getState().startScan("");
      expect(useEnrichStore.getState().semPerguntarAoSom).toBe(37);

      setBackendForTests({
        enrichFolderScan: vi.fn(async () => scanResult([proposal()])),
      } as unknown as Backend);
      await useEnrichStore.getState().startScan("");
      expect(useEnrichStore.getState().semPerguntarAoSom).toBe(0);
    });

    it("fechar a revisão também zera a conta", async () => {
      setBackendForTests({
        enrichFolderScan: vi.fn(async () => scanResult([proposal()], 37)),
      } as unknown as Backend);
      await useEnrichStore.getState().startScan("");
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

      const pending = useEnrichStore.getState().startScan("");
      useEnrichStore.getState().hideOverlay();
      await pending;

      const toast = useToastStore.getState().toasts[0];
      expect(toast.message).toBe(textoSemPropostas(null, 37));
      expect(toast.message).toContain("37");
      expect(toast.kind).toBe("warning");
    });

    it("sem propostas e com tudo perguntado: o toast é o de sempre", async () => {
      setBackendForTests({
        enrichFolderScan: vi.fn(async () => scanResult([])),
      } as unknown as Backend);

      const pending = useEnrichStore.getState().startScan("");
      useEnrichStore.getState().hideOverlay();
      await pending;

      const toast = useToastStore.getState().toasts[0];
      expect(toast.message).toBe(textoSemPropostas(null));
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
  // -------------------------------------------------------------------------
  // V10 — a etapa 5, perguntada no FIM
  // -------------------------------------------------------------------------
  //
  // Não é modo, não é caixa marcada antes. Terminada a varredura, o store tem
  // em mãos QUEM sobrou sem letra e QUANTO TEMPO isso leva nesta máquina — e é
  // só aí que a pergunta pode ser respondida com informação.

  describe("a pergunta do fim (V10)", () => {
    /** Resultado com 47 músicas sobrando e 3 horas de trabalho. */
    const comSobra = () =>
      scanResult([proposal()], 0, [10, 11, 12], 10_800);

    it("guarda quem sobrou sem letra e o tempo de transcrever", async () => {
      setBackendForTests({
        enrichFolderScan: vi.fn(async () => comSobra()),
      } as unknown as Backend);
      await useEnrichStore.getState().startScan("");

      expect(useEnrichStore.getState().semLetraNoFim).toEqual([10, 11, 12]);
      expect(useEnrichStore.getState().segundosDeTranscricao).toBe(10_800);
    });

    // A tela precisa saber se OFERECE o trabalho ou o download, e quem sabe
    // disso é a contagem do backend (`transcricao_disponivel`).
    it("o disparo carrega o que a máquina pode fazer, sem deduzir nada", async () => {
      setBackendForTests({
        enrichFolderScan: vi.fn(async () => comSobra()),
      } as unknown as Backend);
      await useEnrichStore.getState().startScan("", {
        disponivel: true,
        download: null,
      });
      expect(useEnrichStore.getState().transcricao.disponivel).toBe(true);
    });

    it("uma varredura nova zera a sobra da anterior", async () => {
      setBackendForTests({
        enrichFolderScan: vi.fn(async () => comSobra()),
      } as unknown as Backend);
      await useEnrichStore.getState().startScan("");
      setBackendForTests({
        enrichFolderScan: vi.fn(async () => scanResult([proposal()])),
      } as unknown as Backend);
      await useEnrichStore.getState().startScan("");
      expect(useEnrichStore.getState().semLetraNoFim).toEqual([]);
    });

    // Sem propostas E sem sobra, a varredura termina em segundo plano com um
    // toast. Com SOBRA, ela tem uma pergunta a fazer — e pergunta não cabe num
    // toast que some em 5 segundos.
    it("com músicas sobrando, o fim em segundo plano abre a revisão em vez de sumir", async () => {
      setBackendForTests({
        enrichFolderScan: vi.fn(async () => scanResult([], 0, [10], 300)),
      } as unknown as Backend);

      const pending = useEnrichStore.getState().startScan("", {
        disponivel: true,
        download: null,
      });
      useEnrichStore.getState().hideOverlay();
      await pending;

      expect(useEnrichStore.getState().status).toBe("review");
      expect(useEnrichStore.getState().semLetraNoFim).toEqual([10]);
    });

    it("sem nada sobrando, o desfecho vazio continua sendo um toast", async () => {
      setBackendForTests({
        enrichFolderScan: vi.fn(async () => scanResult([])),
      } as unknown as Backend);

      const pending = useEnrichStore.getState().startScan("");
      useEnrichStore.getState().hideOverlay();
      await pending;

      expect(useEnrichStore.getState().status).toBe("idle");
      expect(useToastStore.getState().toasts).toHaveLength(1);
    });

    // Dispensar é uma resposta: a pergunta não pode voltar sozinha na mesma
    // revisão, ou vira o pop-up que se aprende a fechar sem ler.
    it("dispensar a oferta cala a pergunta desta revisão", async () => {
      setBackendForTests({
        enrichFolderScan: vi.fn(async () => comSobra()),
      } as unknown as Backend);
      await useEnrichStore.getState().startScan("");
      expect(useEnrichStore.getState().transcricaoDispensada).toBe(false);
      useEnrichStore.getState().dispensarTranscricao();
      expect(useEnrichStore.getState().transcricaoDispensada).toBe(true);
    });
  });

  describe("startTranscricao — horas de trabalho em segundo plano", () => {
    function backendComTranscricao(over: Partial<Backend> = {}): Backend {
      return {
        enrichFolderScan: vi.fn(async () =>
          scanResult([], 0, [10, 11], 600),
        ),
        transcreverMusicas: vi.fn(async () => ({
          propostas: [proposal({ song_id: 10, fonte: "transcrição do áudio" })],
          razao_medida: 1.2,
          razao_desta_maquina: 1.2,
        })),
        onTranscricaoProgresso: vi.fn(async () => () => {}),
        ...over,
      } as unknown as Backend;
    }

    it("manda ao backend exatamente os ids que a varredura devolveu", async () => {
      const backend = backendComTranscricao();
      setBackendForTests(backend);
      await useEnrichStore.getState().startScan("", {
        disponivel: true,
        download: null,
      });

      await useEnrichStore.getState().startTranscricao();

      expect(backend.transcreverMusicas).toHaveBeenCalledWith(
        [10, 11],
        expect.any(String),
      );
    });

    it("as propostas da etapa 5 entram na MESMA revisão", async () => {
      setBackendForTests(backendComTranscricao());
      await useEnrichStore.getState().startScan("", {
        disponivel: true,
        download: null,
      });
      await useEnrichStore.getState().startTranscricao();

      expect(useEnrichStore.getState().status).toBe("review");
      expect(useEnrichStore.getState().proposals).toHaveLength(1);
      expect(useEnrichStore.getState().proposals[0].song_id).toBe(10);
    });

    // A varredura que veio antes pode ter deixado propostas na tela: a etapa 5
    // ACRESCENTA, não substitui — jogar fora o que a pessoa ainda não aplicou
    // seria perder trabalho dela.
    it("acrescenta às propostas que já estavam na revisão", async () => {
      setBackendForTests(
        backendComTranscricao({
          enrichFolderScan: vi.fn(async () =>
            scanResult([proposal({ song_id: 1 })], 0, [10, 11], 600),
          ),
        }),
      );
      await useEnrichStore.getState().startScan("", {
        disponivel: true,
        download: null,
      });
      await useEnrichStore.getState().startTranscricao();

      expect(
        useEnrichStore.getState().proposals.map((p) => p.song_id),
      ).toEqual([1, 10]);
    });

    /*
      QA A1 — o laço fecha no BACKEND, e a tela não guarda cópia.

      A v0.10.0 pedia ao frontend que guardasse `razao_medida` e a mandasse de
      volta; o `startTranscricao` fazia `const { propostas } = ...` e o campo
      caía no chão, então a promessa da DECISIONS #106 ficou desligada sem
      ninguém notar — não havia consumidor que reclamasse.

      A saída não foi guardar melhor: foi tirar o dono duplicado. O backend
      soma a medição no banco e usa a razão real na varredura seguinte; o que
      chega aqui é INFORMATIVO, e guardá-lo seria uma segunda cópia de um
      estado que já tem dono (DECISIONS #80).
    */
    it("a razão que a etapa 5 devolve não vira estado da tela", async () => {
      setBackendForTests(backendComTranscricao());
      await useEnrichStore.getState().startScan("", {
        disponivel: true,
        download: null,
      });
      await useEnrichStore.getState().startTranscricao();

      // nenhum campo do store carrega a razão: quem a guarda é o backend
      expect(Object.keys(useEnrichStore.getState())).not.toContain("razaoMedida");
      expect(
        JSON.stringify(useEnrichStore.getState()),
        "a razão não pode estar escondida em campo nenhum",
      ).not.toContain("1.2");
    });

    /*
      E o que a tela USA é o FATO, não o número: `estimativa_medida_nesta_maquina`
      vem da VARREDURA, porque é lá que a pergunta do fim é montada.
    */
    it("o fato sobre a estimativa vem da varredura e fica no store", async () => {
      setBackendForTests(
        backendComTranscricao({
          enrichFolderScan: vi.fn(async () =>
            scanResult([], 0, [10, 11], 600, true),
          ),
        }),
      );
      await useEnrichStore.getState().startScan("", {
        disponivel: true,
        download: null,
      });

      expect(useEnrichStore.getState().estimativaMedidaNestaMaquina).toBe(true);
    });

    // Instalação nova: nunca se mediu nada, e a tela precisa saber disso para
    // não afirmar "neste computador" sobre um número de fábrica.
    it("sem medição, o fato é falso — e é o padrão", async () => {
      setBackendForTests(backendComTranscricao());
      await useEnrichStore.getState().startScan("", {
        disponivel: true,
        download: null,
      });

      expect(useEnrichStore.getState().estimativaMedidaNestaMaquina).toBe(false);
    });

    it("o progresso do evento chega ao store, e o de outra fila é descartado", async () => {
      let emitir: ((p: unknown) => void) | null = null;
      /** O que a tela via DURANTE a fila — depois dela o progresso é limpo. */
      const vistos: Array<TranscricaoProgresso | null> = [];
      setBackendForTests(
        backendComTranscricao({
          onTranscricaoProgresso: vi.fn(async (cb) => {
            emitir = cb as (p: unknown) => void;
            return () => {};
          }),
          transcreverMusicas: vi.fn(async (_ids: number[], scanId: string) => {
            emitir?.({
              done: 1,
              total: 2,
              atual: "Oh! Chuva.mp3",
              porcento_da_musica: 45,
              segundos_restantes: 9800,
              scan_id: scanId,
            });
            vistos.push(useEnrichStore.getState().transcricaoProgress);
            // evento de uma fila zumbi (cancelada e ainda respondendo): a
            // mesma disciplina do scan_id da varredura, e pelo mesmo motivo
            emitir?.({
              done: 99,
              total: 99,
              atual: "de outra fila.mp3",
              porcento_da_musica: 0,
              segundos_restantes: null,
              scan_id: "fila-zumbi",
            });
            vistos.push(useEnrichStore.getState().transcricaoProgress);
            return { propostas: [], razao_medida: null, razao_desta_maquina: 1 };
          }),
        }),
      );
      await useEnrichStore.getState().startScan("", {
        disponivel: true,
        download: null,
      });
      await useEnrichStore.getState().startTranscricao();

      expect(vistos[0]?.atual).toBe("Oh! Chuva.mp3");
      expect(vistos[0]?.porcento_da_musica).toBe(45);
      expect(vistos[0]?.segundos_restantes).toBe(9800);
      // o evento alheio não mexeu na barra desta fila
      expect(vistos[1]?.atual).toBe("Oh! Chuva.mp3");
      // e, terminada a fila, o progresso não fica pendurado na tela
      expect(useEnrichStore.getState().transcricaoProgress).toBeNull();
    });

    // A etapa 5 roda em SEGUNDO PLANO e o app tem de continuar usável: sair da
    // janela não pode parar horas de trabalho (a lição da v0.8.1).
    it("esconder o overlay não interrompe a transcrição", async () => {
      const backend = backendComTranscricao();
      setBackendForTests(backend);
      await useEnrichStore.getState().startScan("", {
        disponivel: true,
        download: null,
      });
      const pendente = useEnrichStore.getState().startTranscricao();
      useEnrichStore.getState().hideOverlay();
      await pendente;
      expect(backend.transcreverMusicas).toHaveBeenCalledTimes(1);
      expect(useEnrichStore.getState().proposals).toHaveLength(1);
    });

    // Cancelar horas de CPU precisa cancelar de verdade: é o MESMO comando da
    // varredura (o backend cancela as duas coisas pelo scan_id).
    it("close cancela a fila no backend", async () => {
      const enrichCancelScan = vi.fn(async () => {});
      setBackendForTests(backendComTranscricao({ enrichCancelScan }));
      await useEnrichStore.getState().startScan("", {
        disponivel: true,
        download: null,
      });
      void useEnrichStore.getState().startTranscricao();
      useEnrichStore.getState().close();
      expect(enrichCancelScan).toHaveBeenCalledTimes(1);
    });

    it("não dispara duas filas ao mesmo tempo", async () => {
      const backend = backendComTranscricao({
        transcreverMusicas: vi.fn(
          () => new Promise(() => {}),
        ) as unknown as Backend["transcreverMusicas"],
      });
      setBackendForTests(backend);
      await useEnrichStore.getState().startScan("", {
        disponivel: true,
        download: null,
      });
      void useEnrichStore.getState().startTranscricao();
      await useEnrichStore.getState().startTranscricao();
      // deixa a primeira fila chegar ao invoke antes de contar
      await Promise.resolve();
      await Promise.resolve();
      expect(backend.transcreverMusicas).toHaveBeenCalledTimes(1);
    });

    it("sem ninguém na fila, não chama o backend", async () => {
      const backend = backendComTranscricao({
        enrichFolderScan: vi.fn(async () => scanResult([proposal()])),
      });
      setBackendForTests(backend);
      await useEnrichStore.getState().startScan("");
      await useEnrichStore.getState().startTranscricao();
      expect(backend.transcreverMusicas).not.toHaveBeenCalled();
    });

    // Falha da etapa 5 não pode sumir: são horas de espera, e a pessoa
    // precisa saber que elas não produziram nada.
    it("falha do comando vira aviso, e a revisão não fica travada", async () => {
      setBackendForTests(
        backendComTranscricao({
          transcreverMusicas: vi.fn(async () => {
            throw new Error("o programa que escreve a letra não está instalado");
          }),
        }),
      );
      await useEnrichStore.getState().startScan("", {
        disponivel: true,
        download: null,
      });
      await useEnrichStore.getState().startTranscricao();

      const toast = useToastStore.getState().toasts[useToastStore.getState().toasts.length - 1];
      expect(toast.kind).toBe("error");
      expect(useEnrichStore.getState().status).not.toBe("transcribing");
    });
  });
});
