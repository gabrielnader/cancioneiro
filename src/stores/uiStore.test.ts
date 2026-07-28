import { describe, expect, it } from "vitest";
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

// V8/F18 — a chave gratuita do Vagalume é preferência da pessoa, não segredo
// do produto: mora junto das outras preferências e sobrevive ao reinício.
describe("uiStore — chave do Vagalume (V8/F18)", () => {
  it("padrão: vazia — sem chave, a etapa do Vagalume é pulada em silêncio", () => {
    expect(createUiStore().getState().vagalumeApiKey).toBe("");
  });

  it("a chave é guardada sem espaços em volta e persiste entre sessões", async () => {
    const store = createUiStore();
    store.getState().setVagalumeApiKey("  minha-chave  ");
    expect(store.getState().vagalumeApiKey).toBe("minha-chave");

    const reopened = createUiStore();
    await Promise.resolve();
    expect(reopened.getState().vagalumeApiKey).toBe("minha-chave");
  });

  it("apagar o campo volta ao estado sem chave", () => {
    const store = createUiStore();
    store.getState().setVagalumeApiKey("x");
    store.getState().setVagalumeApiKey("");
    expect(store.getState().vagalumeApiKey).toBe("");
  });
});
