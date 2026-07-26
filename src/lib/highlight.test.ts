import { describe, expect, it } from "vitest";
import { parseSnippet, HIGHLIGHT_START, HIGHLIGHT_END } from "./highlight";

describe("parseSnippet", () => {
  it("divide o snippet em segmentos normais e destacados", () => {
    const snippet = `meu ${HIGHLIGHT_START}coração${HIGHLIGHT_END} vai cantar`;
    expect(parseSnippet(snippet)).toEqual([
      { text: "meu ", highlighted: false },
      { text: "coração", highlighted: true },
      { text: " vai cantar", highlighted: false },
    ]);
  });

  it("suporta múltiplos destaques", () => {
    const snippet = `${HIGHLIGHT_START}sol${HIGHLIGHT_END} e ${HIGHLIGHT_START}lua${HIGHLIGHT_END}`;
    expect(parseSnippet(snippet)).toEqual([
      { text: "sol", highlighted: true },
      { text: " e ", highlighted: false },
      { text: "lua", highlighted: true },
    ]);
  });

  it("texto sem marcadores vira um único segmento", () => {
    expect(parseSnippet("sem marca")).toEqual([
      { text: "sem marca", highlighted: false },
    ]);
  });

  it("snippet vazio vira lista vazia", () => {
    expect(parseSnippet("")).toEqual([]);
  });
});
