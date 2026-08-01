import { afterEach, describe, expect, it, vi } from "vitest";
import { applyTheme, resolveTheme, watchSystemTheme } from "./theme";

/**
 * jsdom não implementa `matchMedia` (ver comentário em theme.ts) — os testes
 * que precisam dele instalam um fake mínimo e desfazem no fim, para não
 * vazar entre arquivos de teste.
 */
function instalarMatchMediaFake(matches: boolean) {
  const listeners = new Set<() => void>();
  const mql = {
    matches,
    media: "(prefers-color-scheme: dark)",
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  window.matchMedia = vi.fn(() => mql as unknown as MediaQueryList);
  return {
    disparar: () => listeners.forEach((fn) => fn()),
    listeners,
  };
}

describe("resolveTheme (V11)", () => {
  it("claro e escuro valem literalmente, sem olhar o sistema", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("light", false)).toBe("light");
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("automático segue o sistema", () => {
    expect(resolveTheme("auto", true)).toBe("dark");
    expect(resolveTheme("auto", false)).toBe("light");
  });
});

describe("applyTheme (V11)", () => {
  afterEach(() => {
    delete document.documentElement.dataset.theme;
    // @ts-expect-error — devolve ao estado "sem matchMedia" do jsdom puro
    delete window.matchMedia;
  });

  it("claro e escuro forçados não dependem do sistema", () => {
    instalarMatchMediaFake(true);
    applyTheme("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    applyTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("automático aplica o que o sistema disser", () => {
    instalarMatchMediaFake(true);
    applyTheme("auto");
    expect(document.documentElement.dataset.theme).toBe("dark");

    instalarMatchMediaFake(false);
    applyTheme("auto");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("sem matchMedia (jsdom puro), automático não quebra e cai no claro", () => {
    applyTheme("auto");
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});

describe("watchSystemTheme (V11)", () => {
  afterEach(() => {
    delete document.documentElement.dataset.theme;
    // @ts-expect-error — idem
    delete window.matchMedia;
  });

  it("reaplica o tema quando o SO muda de aparência, só importa para automático", () => {
    const fake = instalarMatchMediaFake(false);
    applyTheme("auto");
    expect(document.documentElement.dataset.theme).toBe("light");

    const parar = watchSystemTheme(() => "auto");
    expect(fake.listeners.size).toBe(1);

    // simula o SO virando escuro no meio do uso
    const mql = (window.matchMedia as ReturnType<typeof vi.fn>).mock.results[0]
      .value as { matches: boolean };
    mql.matches = true;
    fake.disparar();
    expect(document.documentElement.dataset.theme).toBe("dark");

    parar();
    expect(fake.listeners.size).toBe(0);
  });

  it("sem matchMedia, devolve um no-op seguro (sem lançar)", () => {
    const parar = watchSystemTheme(() => "auto");
    expect(() => parar()).not.toThrow();
  });
});
