import { afterEach, describe, expect, it } from "vitest";
import { createUiStore, FONT_SIZES_PX } from "./uiStore";

describe("uiStore (F3 — persistência de painel e fonte)", () => {
  it("padrão: painel visível e fonte nível 0 (16px)", () => {
    const store = createUiStore();
    expect(store.getState().lyricsPanelVisible).toBe(true);
    expect(store.getState().fontLevel).toBe(0);
    expect(FONT_SIZES_PX[store.getState().fontLevel]).toBe(16);
  });

  it("níveis de fonte são 16/20/24px e ciclam", () => {
    expect(FONT_SIZES_PX).toEqual([16, 20, 24]);
    const store = createUiStore();
    store.getState().cycleFontLevel();
    expect(store.getState().fontLevel).toBe(1);
    store.getState().cycleFontLevel();
    expect(store.getState().fontLevel).toBe(2);
    store.getState().cycleFontLevel();
    expect(store.getState().fontLevel).toBe(0);
  });

  it("toggle e fonte persistem entre 'sessões' (novo store lê o localStorage)", async () => {
    const store = createUiStore();
    store.getState().toggleLyricsPanel();
    store.getState().cycleFontLevel();
    store.getState().cycleFontLevel();
    expect(store.getState().lyricsPanelVisible).toBe(false);
    expect(store.getState().fontLevel).toBe(2);

    // Simula reinício do app: nova instância hidrata do localStorage
    const reopened = createUiStore();
    await Promise.resolve();
    expect(reopened.getState().lyricsPanelVisible).toBe(false);
    expect(reopened.getState().fontLevel).toBe(2);
  });
});

// V11 — tema claro/escuro/automático, pedido pelos beta testers. Guardado no
// MESMO store das outras preferências (é o pedido explícito: "no mesmo lugar
// onde as outras preferências já são guardadas").
describe("uiStore — tema (V11)", () => {
  afterEach(() => {
    delete document.documentElement.dataset.theme;
  });

  it("padrão é automático (segue o sistema)", () => {
    expect(createUiStore().getState().theme).toBe("auto");
  });

  it("setTheme troca o estado e aplica no <html> via data-theme", () => {
    const store = createUiStore();
    store.getState().setTheme("dark");
    expect(store.getState().theme).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");

    store.getState().setTheme("light");
    expect(store.getState().theme).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("a escolha persiste entre 'sessões' (novo store lê o localStorage)", async () => {
    const store = createUiStore();
    store.getState().setTheme("dark");

    const reaberto = createUiStore();
    await Promise.resolve();
    expect(reaberto.getState().theme).toBe("dark");
  });

  it("está na mesma chave de localStorage das outras preferências", () => {
    const store = createUiStore();
    store.getState().setTheme("dark");
    const salvo = JSON.parse(localStorage.getItem("cancioneiro-ui") ?? "{}");
    expect(salvo.state.theme).toBe("dark");
  });
});

// V10 — a chave do Vagalume SAIU das preferências (DECISIONS #110): a etapa
// que a pedia foi removida do produto, e o `lyrics.ovh` que tomou o lugar dela
// não pede credencial nenhuma. Guardar preferência que nada lê é convite a
// alguém reintroduzir o campo "porque o estado já existe".
describe("uiStore — nenhuma credencial guardada (V10)", () => {
  it("não há preferência de chave, nem no estado nem no que é persistido", () => {
    const estado = createUiStore().getState() as unknown as Record<string, unknown>;
    expect(estado.vagalumeApiKey).toBeUndefined();
    expect(estado.setVagalumeApiKey).toBeUndefined();
    const salvo = localStorage.getItem("cancioneiro-ui") ?? "";
    expect(salvo.toLowerCase()).not.toContain("vagalume");
  });
});
