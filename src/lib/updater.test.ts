import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getAppVersion,
  runUpdateCheck,
  tauriUpdaterDeps,
  useUpdateStore,
  type PendingUpdate,
  type UpdaterDeps,
} from "./updater";
import { useToastStore } from "../stores/toastStore";

/**
 * O plugin em si não é testado aqui (não roda em jsdom) — o que se testa é a
 * LÓGICA: quando há chamada de rede, o que é engolido em silêncio e o que
 * chega à tela.
 */

function pendingUpdate(over: Partial<PendingUpdate> = {}): PendingUpdate {
  return {
    version: "9.9.9",
    download: vi.fn(async () => {}),
    install: vi.fn(async () => {}),
    ...over,
  };
}

function deps(over: Partial<UpdaterDeps> = {}): UpdaterDeps {
  return {
    enabled: true,
    check: vi.fn(async () => null),
    relaunch: vi.fn(async () => {}),
    onReady: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  useUpdateStore.setState({ ready: false, restarting: false, restart: null });
  useToastStore.setState({ toasts: [] });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // o caminho silencioso loga em console.debug no modo dev; aqui só ruído
  vi.spyOn(console, "debug").mockImplementation(() => {});
});

describe("runUpdateCheck — preferência desligada", () => {
  it("não faz NENHUMA chamada de rede quando a verificação está desligada", async () => {
    const d = deps({ enabled: false });
    await runUpdateCheck(d);
    expect(d.check).not.toHaveBeenCalled();
    expect(d.onReady).not.toHaveBeenCalled();
    expect(useUpdateStore.getState().ready).toBe(false);
  });
});

describe("runUpdateCheck — caminhos silenciosos (o comum)", () => {
  it("sem rede (check rejeita): silêncio total, nada na tela, nada em toast", async () => {
    const d = deps({
      check: vi.fn(async () => {
        throw new Error("error sending request for url (dns error)");
      }),
    });
    await expect(runUpdateCheck(d)).resolves.toBeUndefined();
    expect(d.onReady).not.toHaveBeenCalled();
    expect(useUpdateStore.getState().ready).toBe(false);
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it("manifesto inválido / assinatura recusada (check rejeita): também silêncio", async () => {
    const d = deps({
      check: vi.fn(async () => {
        throw new Error("invalid signature");
      }),
    });
    await runUpdateCheck(d);
    expect(useUpdateStore.getState().ready).toBe(false);
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it("nenhuma versão nova (check devolve null): nada acontece", async () => {
    const d = deps({ check: vi.fn(async () => null) });
    await runUpdateCheck(d);
    expect(d.check).toHaveBeenCalledTimes(1);
    expect(d.onReady).not.toHaveBeenCalled();
    expect(useUpdateStore.getState().ready).toBe(false);
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it("download falha no meio: silêncio, nenhum aviso, nada é instalado", async () => {
    const install = vi.fn(async () => {});
    const update = pendingUpdate({
      download: vi.fn(async () => {
        throw new Error("connection reset");
      }),
      install,
    });
    const d = deps({ check: vi.fn(async () => update) });
    await runUpdateCheck(d);
    expect(install).not.toHaveBeenCalled();
    expect(d.onReady).not.toHaveBeenCalled();
    expect(useUpdateStore.getState().ready).toBe(false);
    expect(useToastStore.getState().toasts).toEqual([]);
  });
});

describe("runUpdateCheck — versão nova disponível", () => {
  it("baixa em segundo plano e SÓ ENTÃO mostra o aviso", async () => {
    const update = pendingUpdate();
    const d = deps({ check: vi.fn(async () => update) });
    await runUpdateCheck(d);
    expect(update.download).toHaveBeenCalledTimes(1);
    expect(d.onReady).toHaveBeenCalledTimes(1);
  });

  it("NUNCA instala nem reinicia sozinho — só ao acionar a ação", async () => {
    const update = pendingUpdate();
    const d = deps({ check: vi.fn(async () => update) });
    let restart: (() => Promise<void>) | null = null;
    d.onReady = vi.fn((r) => {
      restart = r;
    });

    await runUpdateCheck(d);
    // baixou, mas nada de instalar/reiniciar por conta própria
    expect(update.install).not.toHaveBeenCalled();
    expect(d.relaunch).not.toHaveBeenCalled();

    await restart!();
    expect(update.install).toHaveBeenCalledTimes(1);
    expect(d.relaunch).toHaveBeenCalledTimes(1);
  });

  it("falha ao reiniciar não estoura para a UI (o aviso continua)", async () => {
    const update = pendingUpdate({
      install: vi.fn(async () => {
        throw new Error("permissão negada");
      }),
    });
    const d = deps({ check: vi.fn(async () => update) });
    await runUpdateCheck(d);
    const restart = (d.onReady as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as () => Promise<void>;
    await expect(restart()).resolves.toBeUndefined();
    expect(d.relaunch).not.toHaveBeenCalled();
  });

  it("o onReady padrão publica o aviso no useUpdateStore", async () => {
    const update = pendingUpdate();
    const d = deps({
      check: vi.fn(async () => update),
      onReady: (r) => useUpdateStore.getState().show(r),
    });
    await runUpdateCheck(d);
    expect(useUpdateStore.getState().ready).toBe(true);
    expect(useUpdateStore.getState().restart).toBeTypeOf("function");
  });
});

describe("useUpdateStore (aviso não-modal)", () => {
  it("começa escondido", () => {
    expect(useUpdateStore.getState().ready).toBe(false);
    expect(useUpdateStore.getState().restart).toBeNull();
  });

  it("runRestart chama a ação uma vez só e marca 'reiniciando'", async () => {
    let resolveRestart: () => void = () => {};
    const restart = vi.fn(
      () =>
        new Promise<void>((res) => {
          resolveRestart = res;
        }),
    );
    useUpdateStore.getState().show(restart);
    const first = useUpdateStore.getState().runRestart();
    expect(useUpdateStore.getState().restarting).toBe(true);
    // clique duplo não dispara de novo
    await useUpdateStore.getState().runRestart();
    expect(restart).toHaveBeenCalledTimes(1);
    resolveRestart();
    await first;
    expect(useUpdateStore.getState().restarting).toBe(false);
  });

  it("runRestart sem ação registrada é inofensivo", async () => {
    await expect(
      useUpdateStore.getState().runRestart(),
    ).resolves.toBeUndefined();
  });

  it("dismiss esconde o aviso", () => {
    useUpdateStore.getState().show(async () => {});
    useUpdateStore.getState().dismiss();
    expect(useUpdateStore.getState().ready).toBe(false);
    expect(useUpdateStore.getState().restart).toBeNull();
  });
});

describe("tauriUpdaterDeps (adaptação dos plugins)", () => {
  it("check devolve null quando o plugin não vê versão nova", async () => {
    vi.doMock("@tauri-apps/plugin-updater", () => ({
      check: vi.fn(async () => null),
    }));
    const { tauriUpdaterDeps: fresh } = await import("./updater");
    expect(await fresh(true).check()).toBeNull();
    vi.doUnmock("@tauri-apps/plugin-updater");
  });

  it("mapeia version/download/install do Update do plugin", async () => {
    const download = vi.fn(async () => {});
    const install = vi.fn(async () => {});
    vi.doMock("@tauri-apps/plugin-updater", () => ({
      check: vi.fn(async () => ({ version: "1.2.3", download, install })),
    }));
    vi.resetModules();
    const { tauriUpdaterDeps: fresh } = await import("./updater");
    const update = await fresh(true).check();
    expect(update?.version).toBe("1.2.3");
    await update?.download();
    await update?.install();
    expect(download).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledTimes(1);
    vi.doUnmock("@tauri-apps/plugin-updater");
    vi.resetModules();
  });

  it("relaunch delega ao plugin process", async () => {
    const relaunch = vi.fn(async () => {});
    vi.doMock("@tauri-apps/plugin-process", () => ({ relaunch }));
    vi.resetModules();
    const { tauriUpdaterDeps: fresh } = await import("./updater");
    await fresh(true).relaunch();
    expect(relaunch).toHaveBeenCalledTimes(1);
    vi.doUnmock("@tauri-apps/plugin-process");
    vi.resetModules();
  });

  it("onReady publica no store do aviso", () => {
    tauriUpdaterDeps(true).onReady(async () => {});
    expect(useUpdateStore.getState().ready).toBe(true);
  });

  it("repassa a preferência recebida", () => {
    expect(tauriUpdaterDeps(false).enabled).toBe(false);
    expect(tauriUpdaterDeps(true).enabled).toBe(true);
  });
});

describe("checkForUpdatesOnStartup — modo web (E2E/navegador)", () => {
  it("é inerte fora do Tauri: não importa plugin nenhum", async () => {
    const { checkForUpdatesOnStartup } = await import("./updater");
    await expect(checkForUpdatesOnStartup()).resolves.toBeUndefined();
    expect(useUpdateStore.getState().ready).toBe(false);
  });

  it("dentro do Tauri respeita a preferência desligada (nenhuma rede)", async () => {
    const check = vi.fn(async () => null);
    vi.doMock("@tauri-apps/plugin-updater", () => ({ check }));
    vi.resetModules();
    const { checkForUpdatesOnStartup: fresh } = await import("./updater");
    const { useUiStore } = await import("../stores/uiStore");
    useUiStore.setState({ checkUpdatesOnStart: false });
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    // @ts-expect-error jsdom: marca a presença do Tauri como no runtime real
    window.__TAURI_INTERNALS__ = {};
    await fresh();
    expect(check).not.toHaveBeenCalled();
    // @ts-expect-error limpeza
    delete window.__TAURI_INTERNALS__;
    vi.doUnmock("@tauri-apps/plugin-updater");
    vi.resetModules();
  });
});

describe("getAppVersion", () => {
  it("devolve null fora do Tauri (a UI simplesmente não mostra)", async () => {
    await expect(getAppVersion()).resolves.toBeNull();
  });

  it("lê a versão do app quando dentro do Tauri", async () => {
    vi.doMock("@tauri-apps/api/app", () => ({
      getVersion: vi.fn(async () => "0.4.0"),
    }));
    vi.resetModules();
    const { getAppVersion: fresh } = await import("./updater");
    // @ts-expect-error jsdom
    window.__TAURI_INTERNALS__ = {};
    await expect(fresh()).resolves.toBe("0.4.0");
    // @ts-expect-error limpeza
    delete window.__TAURI_INTERNALS__;
    vi.doUnmock("@tauri-apps/api/app");
    vi.resetModules();
  });

  it("erro ao ler a versão vira null, nunca exceção", async () => {
    vi.doMock("@tauri-apps/api/app", () => ({
      getVersion: vi.fn(async () => {
        throw new Error("sem IPC");
      }),
    }));
    vi.resetModules();
    const { getAppVersion: fresh } = await import("./updater");
    // @ts-expect-error jsdom
    window.__TAURI_INTERNALS__ = {};
    await expect(fresh()).resolves.toBeNull();
    // @ts-expect-error limpeza
    delete window.__TAURI_INTERNALS__;
    vi.doUnmock("@tauri-apps/api/app");
    vi.resetModules();
  });
});
