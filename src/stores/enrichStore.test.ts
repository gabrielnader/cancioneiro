import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  setBackendForTests,
  type Backend,
  type EnrichProgress,
  type EnrichProposal,
} from "../lib/api";
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
    error: null,
    ...overrides,
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
    });
    useToastStore.setState({ toasts: [] });
    setBackendForTests(null);
  });

  it("startScan: scanning → review com as propostas do backend", async () => {
    const proposals = [proposal()];
    const enrichFolderScan = vi.fn(async () => proposals);
    setBackendForTests({ enrichFolderScan } as unknown as Backend);

    const pending = useEnrichStore.getState().startScan("/acervo/1");
    expect(useEnrichStore.getState().status).toBe("scanning");
    expect(useEnrichStore.getState().folderPrefix).toBe("/acervo/1");
    await pending;

    expect(enrichFolderScan).toHaveBeenCalledWith("/acervo/1");
    expect(useEnrichStore.getState().status).toBe("review");
    expect(useEnrichStore.getState().proposals).toEqual(proposals);
  });

  it("bloqueia disparo duplo enquanto a varredura está em andamento", async () => {
    let resolve!: (p: EnrichProposal[]) => void;
    const enrichFolderScan = vi.fn(
      () => new Promise<EnrichProposal[]>((r) => (resolve = r)),
    );
    setBackendForTests({ enrichFolderScan } as unknown as Backend);

    const first = useEnrichStore.getState().startScan("");
    await useEnrichStore.getState().startScan("/outra");
    expect(enrichFolderScan).toHaveBeenCalledTimes(1);
    expect(useEnrichStore.getState().folderPrefix).toBe("");

    resolve([proposal()]);
    await first;
    expect(useEnrichStore.getState().status).toBe("review");
  });

  it("fechar DURANTE a varredura descarta o resultado quando ele chegar (guarda de corrida)", async () => {
    let resolve!: (p: EnrichProposal[]) => void;
    const enrichFolderScan = vi.fn(
      () => new Promise<EnrichProposal[]>((r) => (resolve = r)),
    );
    setBackendForTests({ enrichFolderScan } as unknown as Backend);

    const pending = useEnrichStore.getState().startScan("");
    useEnrichStore.getState().close();
    expect(useEnrichStore.getState().status).toBe("idle");

    resolve([proposal()]);
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
      () => new Promise<EnrichProposal[]>((_r, rj) => (reject = rj)),
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
      enrichFolderScan: vi.fn(async () => [proposal()]),
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
      let resolve!: (p: EnrichProposal[]) => void;
      const onEnrichProgress = vi.fn(async (cb: (p: EnrichProgress) => void) => {
        emit = cb;
        return () => {};
      });
      setBackendForTests({
        onEnrichProgress,
        enrichFolderScan: vi.fn(
          () => new Promise<EnrichProposal[]>((r) => (resolve = r)),
        ),
      } as unknown as Backend);

      const pending = useEnrichStore.getState().startScan("");
      // antes do primeiro evento: sem progresso (overlay fica indeterminado)
      expect(useEnrichStore.getState().progress).toBeNull();
      await Promise.resolve();

      emit({ done: 0, total: 94, atual: "a.mp3" });
      expect(useEnrichStore.getState().progress).toEqual({
        done: 0,
        total: 94,
        atual: "a.mp3",
      });
      emit({ done: 12, total: 94, atual: "b.mp3" });
      expect(useEnrichStore.getState().progress?.done).toBe(12);

      resolve([proposal()]);
      await pending;
      expect(useEnrichStore.getState().progress).toBeNull();
    });

    it("cancela a assinatura ao terminar a varredura", async () => {
      const unlisten = vi.fn();
      setBackendForTests({
        onEnrichProgress: vi.fn(async () => unlisten),
        enrichFolderScan: vi.fn(async () => [proposal()]),
      } as unknown as Backend);

      await useEnrichStore.getState().startScan("");
      expect(unlisten).toHaveBeenCalledTimes(1);
    });

    it("backend sem onEnrichProgress não quebra a varredura", async () => {
      setBackendForTests({
        enrichFolderScan: vi.fn(async () => [proposal()]),
      } as unknown as Backend);
      await useEnrichStore.getState().startScan("");
      expect(useEnrichStore.getState().status).toBe("review");
    });
  });

  describe("segundo plano (a varredura é somente leitura — não trava o app)", () => {
    it("hideOverlay esconde o overlay e a varredura CONTINUA (resultado chega na store)", async () => {
      let resolve!: (p: EnrichProposal[]) => void;
      setBackendForTests({
        enrichFolderScan: vi.fn(
          () => new Promise<EnrichProposal[]>((r) => (resolve = r)),
        ),
      } as unknown as Backend);

      const pending = useEnrichStore.getState().startScan("/acervo");
      expect(useEnrichStore.getState().overlayOpen).toBe(true);

      useEnrichStore.getState().hideOverlay();
      expect(useEnrichStore.getState().overlayOpen).toBe(false);
      expect(useEnrichStore.getState().status).toBe("scanning");

      const proposals = [proposal(), proposal({ song_id: 2 })];
      resolve(proposals);
      await pending;
      expect(useEnrichStore.getState().status).toBe("review");
      expect(useEnrichStore.getState().proposals).toEqual(proposals);
      // o overlay NÃO se abre sozinho: o usuário está trabalhando
      expect(useEnrichStore.getState().overlayOpen).toBe(false);
    });

    it("fim em segundo plano COM propostas: toast avisando (plural)", async () => {
      setBackendForTests({
        enrichFolderScan: vi.fn(async () => [
          proposal(),
          proposal({ song_id: 2 }),
        ]),
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
        enrichFolderScan: vi.fn(async () => [proposal()]),
      } as unknown as Backend);

      const pending = useEnrichStore.getState().startScan("");
      useEnrichStore.getState().hideOverlay();
      await pending;

      expect(useToastStore.getState().toasts[0].message).toBe(
        "Dados encontrados para 1 música — abra a revisão para conferir.",
      );
    });

    it("fim em segundo plano SEM propostas: toast 'Nada a ajustar' e volta a idle", async () => {
      setBackendForTests({
        enrichFolderScan: vi.fn(async () => []),
      } as unknown as Backend);

      const pending = useEnrichStore.getState().startScan("");
      useEnrichStore.getState().hideOverlay();
      await pending;

      expect(useToastStore.getState().toasts[0].message).toBe(
        "Nada a ajustar nesta pasta.",
      );
      expect(useEnrichStore.getState().status).toBe("idle");
      expect(useEnrichStore.getState().overlayOpen).toBe(false);
    });

    it("fim com o overlay ABERTO não emite toast (o overlay já mostra o resultado)", async () => {
      setBackendForTests({
        enrichFolderScan: vi.fn(async () => [proposal()]),
      } as unknown as Backend);
      await useEnrichStore.getState().startScan("");
      expect(useToastStore.getState().toasts).toHaveLength(0);
      expect(useEnrichStore.getState().overlayOpen).toBe(true);
    });

    it("openOverlay reabre a revisão sem disparar nova varredura", async () => {
      const enrichFolderScan = vi.fn(async () => [proposal()]);
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
        () => new Promise<EnrichProposal[]>(() => {}),
      );
      setBackendForTests({ enrichFolderScan } as unknown as Backend);

      void useEnrichStore.getState().startScan("");
      useEnrichStore.getState().hideOverlay();
      await useEnrichStore.getState().startScan("/outra");
      expect(enrichFolderScan).toHaveBeenCalledTimes(1);
    });

    it("cancelar (close) durante varredura em segundo plano descarta o resultado", async () => {
      let resolve!: (p: EnrichProposal[]) => void;
      setBackendForTests({
        enrichFolderScan: vi.fn(
          () => new Promise<EnrichProposal[]>((r) => (resolve = r)),
        ),
      } as unknown as Backend);

      const pending = useEnrichStore.getState().startScan("");
      useEnrichStore.getState().hideOverlay();
      useEnrichStore.getState().close();

      resolve([proposal()]);
      await pending;
      expect(useEnrichStore.getState().status).toBe("idle");
      expect(useEnrichStore.getState().proposals).toEqual([]);
      expect(useToastStore.getState().toasts).toHaveLength(0);
    });
  });
});
