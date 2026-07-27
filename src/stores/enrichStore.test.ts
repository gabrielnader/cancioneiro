import { beforeEach, describe, expect, it, vi } from "vitest";
import { setBackendForTests, type Backend, type EnrichProposal } from "../lib/api";
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
    useEnrichStore.setState({ status: "idle", folderPrefix: "", proposals: [] });
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

  it("falha da varredura inteira: toast 'Sem conexão…' e volta a idle", async () => {
    const enrichFolderScan = vi.fn(async () => {
      throw new Error("sem conexão");
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
  });
});
