import { describe, expect, it } from "vitest";
import { textoDoRecebimento } from "./pacoteDoGrupo";

// V16 — o único sinal do recebimento por trás é este aviso, e só quando algo
// mudou: silêncio quando não há o que contar
describe("textoDoRecebimento", () => {
  const r = (preenchidas: number, com_letra_nova: number) => ({
    reconhecidas: 10,
    preenchidas,
    com_letra_nova,
    falhas: 0,
  });

  it("nada preenchido (ou sem pacote): nenhum aviso", () => {
    expect(textoDoRecebimento(null)).toBeNull();
    expect(textoDoRecebimento(r(0, 0))).toBeNull();
  });

  it("conta as letras que chegaram, que é o que a pessoa quer saber", () => {
    expect(textoDoRecebimento(r(5, 3))).toBe("As letras do grupo chegaram: 3 músicas ganharam letra.");
    expect(textoDoRecebimento(r(1, 1))).toBe("As letras do grupo chegaram: 1 música ganhou letra.");
  });

  it("sem letra nova, conta as músicas completadas", () => {
    expect(textoDoRecebimento(r(4, 0))).toBe("As letras do grupo completaram 4 músicas.");
  });
});
