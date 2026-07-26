import { describe, expect, it } from "vitest";
import { hasSearchTokens } from "./searchQuery";

describe("hasSearchTokens (espelha o sanitizador FTS do backend)", () => {
  it("true para texto com letras/números", () => {
    expect(hasSearchTokens("coração")).toBe(true);
    expect(hasSearchTokens("  sol ")).toBe(true);
    expect(hasSearchTokens('"estrela"')).toBe(true);
    expect(hasSearchTokens("a1")).toBe(true);
  });

  it("false para vazio ou apenas caracteres especiais (query tratada como vazia)", () => {
    expect(hasSearchTokens("")).toBe(false);
    expect(hasSearchTokens("   ")).toBe(false);
    expect(hasSearchTokens('"*-()')).toBe(false);
    expect(hasSearchTokens("!!!")).toBe(false);
  });
});
