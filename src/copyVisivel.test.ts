import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A VARREDURA DA ÁRVORE — o teste que olha onde ninguém lembrou de olhar.
 *
 * A decisão 76 nomeou o modo de falha: teste que só confere o lugar de que o
 * autor se lembrou. A decisão 110 mandou o Vagalume sair da tela — o campo de
 * chave E o texto que o explicava —, e os testes que guardavam isso olhavam o
 * `lib/curadoria` e a seção de Configurações. Sobrou, oito meses de leitura
 * adiante, a dica do botão "Buscar dados na internet" no editor de música,
 * prometendo uma etapa que não existe mais e omitindo as duas que rodam.
 *
 * Este arquivo não guarda uma tela: guarda a ÁRVORE. Qualquer arquivo novo
 * entra na varredura sozinho, que é a única forma de a próxima remoção não
 * deixar resto.
 */

const RAIZ = path.resolve(__dirname);

/** Todo `.ts`/`.tsx` de produção sob `src/` — testes e utilitários de teste fora. */
function arquivosDeProducao(dir: string = RAIZ): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entrada) => {
    const completo = path.join(dir, entrada.name);
    if (entrada.isDirectory()) {
      // `src/test/` é andaime de teste (matchers de contraste, setup)
      return entrada.name === "test" ? [] : arquivosDeProducao(completo);
    }
    if (!/\.tsx?$/.test(entrada.name)) return [];
    if (/\.(test|spec)\.tsx?$/.test(entrada.name)) return [];
    return [completo];
  });
}

/**
 * O código sem os comentários.
 *
 * Comentário não chega a olho nenhum, e a DECISIONS #110 é explícita em manter
 * a HISTÓRIA escrita: metade dos comentários do funil cita o Vagalume para
 * explicar por que a régua do casamento estrito é como é. Apagar a explicação
 * junto com o recurso é o que transforma um comentário em afirmação que
 * ninguém pode mais conferir.
 *
 * O varredor é um autômato de estados, e não uma expressão regular, porque
 * `// dentro de "aspas"` e `"texto com // barras"` são coisas diferentes — e
 * é justamente dentro das aspas que mora o texto que a pessoa lê.
 */
export function semComentarios(fonte: string): string {
  let saida = "";
  let i = 0;
  type Estado = "codigo" | "linha" | "bloco" | '"' | "'" | "`";
  let estado: Estado = "codigo";
  while (i < fonte.length) {
    const c = fonte[i];
    const proximo = fonte[i + 1];
    if (estado === "codigo") {
      if (c === "/" && proximo === "/") {
        estado = "linha";
        i += 2;
        continue;
      }
      if (c === "/" && proximo === "*") {
        estado = "bloco";
        i += 2;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") estado = c;
      saida += c;
      i++;
      continue;
    }
    if (estado === "linha") {
      if (c === "\n") {
        estado = "codigo";
        saida += c;
      }
      i++;
      continue;
    }
    if (estado === "bloco") {
      if (c === "*" && proximo === "/") {
        estado = "codigo";
        i += 2;
      } else {
        // preserva as quebras: as linhas do relatório de falha continuam certas
        if (c === "\n") saida += c;
        i++;
      }
      continue;
    }
    // dentro de texto: a barra invertida escapa o caractere seguinte
    if (c === "\\") {
      saida += c + (proximo ?? "");
      i += 2;
      continue;
    }
    if (c === estado) estado = "codigo";
    saida += c;
    i++;
  }
  return saida;
}

/**
 * As ocorrências que NÃO são texto de tela, com o motivo de cada uma.
 *
 * A lista é curta de propósito, e cada entrada é uma afirmação conferível: se
 * alguém acrescentar uma, precisa escrever por quê. Vaga não entra.
 */
const PERMITIDAS: Array<{ arquivo: string; trecho: string; porque: string }> = [
  {
    arquivo: "lib/types.ts",
    trecho: 'export const ORIGEM_VAGALUME = "vagalume"',
    porque:
      "valor de TXXX:LETRA_ORIGEM que o tools/curadoria.py gravou e que" +
      " arquivos do acervo real carregam. Nada mais o escreve e nada o apaga:" +
      " é dado a INTERPRETAR, não texto a mostrar (DECISIONS #110).",
  },
];

describe("a árvore de componentes não promete o que foi removido", () => {
  const arquivos = arquivosDeProducao();

  // Guarda do próprio guarda: um glob quebrado passaria calado, e um teste que
  // não lê nada é verde por não fazer nada.
  it("a varredura enxerga a árvore inteira", () => {
    expect(arquivos.length).toBeGreaterThan(20);
    expect(arquivos.some((f) => f.endsWith("EditSongForm.tsx"))).toBe(true);
    expect(arquivos.some((f) => f.endsWith("SettingsView.tsx"))).toBe(true);
  });

  // O varredor precisa ser confiável nas duas direções, ou o teste acima é
  // teatro: comentário some, texto entre aspas FICA.
  it("o varredor tira comentário e preserva texto", () => {
    expect(semComentarios('// some\nconst a = "fica";')).not.toContain("some");
    expect(semComentarios('const a = "fica";')).toContain("fica");
    expect(semComentarios('const a = "http://x // y";')).toContain("// y");
    expect(semComentarios("/* some */ const a = 1;")).not.toContain("some");
    expect(semComentarios('const a = "diz \\"oi\\""; // some')).toContain("oi");
  });

  it("'Vagalume' não sobrou em texto que alguém lê", () => {
    const achados: string[] = [];
    for (const arquivo of arquivos) {
      const relativo = path.relative(RAIZ, arquivo).replace(/\\/g, "/");
      const linhas = semComentarios(readFileSync(arquivo, "utf8")).split("\n");
      linhas.forEach((linha, i) => {
        if (!/vagalume/i.test(linha)) return;
        const permitida = PERMITIDAS.some(
          (p) => p.arquivo === relativo && linha.includes(p.trecho),
        );
        if (!permitida) achados.push(`${relativo}:${i + 1}: ${linha.trim()}`);
      });
    }
    expect(achados).toEqual([]);
  });
});
