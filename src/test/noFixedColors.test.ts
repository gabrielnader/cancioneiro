import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * V11 — depois de migrar todo `src/components/**` para os tokens de tema
 * (`text-brand`, `bg-warning-soft`, ...), nenhum componente deveria voltar a
 * escrever uma cor fixa (`text-[#RRGGBB]`, `bg-[#fff]`, ...): isso reintroduz
 * exatamente o problema que motivou o tema — cor que não muda com claro/
 * escuro porque está gravada em hex dentro do componente.
 *
 * `PlayerBar.tsx` usa `bg-[var(--playerbar-bg)]` (uma variável CSS dentro do
 * arbitrary value, não um hex) — de propósito, documentado no próprio
 * arquivo: a barra é sempre escura, nos dois temas. O regex abaixo só
 * reconhece `#RRGGBB`/`#RGB` literais, então esse padrão passa sem precisar
 * de exceção nenhuma.
 */
const COMPONENTS_DIR = join(process.cwd(), "src", "components");
const HEX_COLOR_RE = /#[0-9a-fA-F]{3,8}\b/;

/** Comentários (`//` e `/* ... *​/`) não contam: só interessa CÓDIGO. */
function semComentarios(fonte: string): string {
  return fonte
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((linha) => linha.replace(/\/\/.*$/, ""))
    .join("\n");
}

function arquivosDeComponente(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entrada) => {
    const caminho = join(dir, entrada.name);
    if (entrada.isDirectory()) return arquivosDeComponente(caminho);
    if (!entrada.name.endsWith(".tsx") || entrada.name.endsWith(".test.tsx")) return [];
    return [caminho];
  });
}

describe("nenhum componente usa cor fixa (V11 — tema claro/escuro)", () => {
  const arquivos = arquivosDeComponente(COMPONENTS_DIR);

  it("achou arquivos para varrer (o teste não passa por engano, vazio)", () => {
    expect(arquivos.length).toBeGreaterThan(10);
  });

  for (const caminho of arquivos) {
    const nome = caminho.slice(COMPONENTS_DIR.length + 1);
    it(`${nome} não declara cor em hex`, () => {
      const codigo = semComentarios(readFileSync(caminho, "utf-8"));
      const achado = HEX_COLOR_RE.exec(codigo);
      expect(achado, achado ? `encontrado "${achado[0]}" em ${nome}` : undefined).toBeNull();
    });
  }
});
