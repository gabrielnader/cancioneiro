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

/**
 * V11 (achado de campo) — o guarda acima só via HEX, e `bg-white` não é hex:
 * é a paleta padrão do Tailwind, que o guarda nunca soube reconhecer. Foi
 * assim que o fundo fixo do modal de revisão (EnrichReview) sobreviveu à
 * varredura inteira. Este segundo guarda cobre as classes `bg-*`/`text-*`/
 * `border-*` que citam a paleta padrão em vez de um token do tema — mesmo
 * sem hex nenhum escrito no componente.
 */
const FAMILIAS_TAILWIND = [
  "gray",
  "slate",
  "neutral",
  "zinc",
  "stone",
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
];
const NON_TOKEN_COLOR_RE = new RegExp(
  `\\b(bg|text|border)-(white|black|(?:${FAMILIAS_TAILWIND.join("|")})-\\d{2,3})\\b`,
  "g",
);

/**
 * Exceções nomeadas — cada uma com o porquê, para não virar buraco genérico
 * que deixaria passar o próximo `bg-white`:
 *
 * - `bg-black/NN` (cortina atrás de um modal — ConfirmDialog, NewPlaylistDialog,
 *   EnrichReview): a cortina escura sobre o conteúdo por trás funciona igual
 *   nos dois temas — ela não é "o fundo do app", não muda com o tema.
 * - `text-white` perto de `-fill` (bg-brand-fill/bg-danger-fill) ou de
 *   `bg-disabled`: essas cores de FUNDO são constantes nos dois temas
 *   (index.css) e já passam em AA com texto branco nos dois — variar o texto
 *   junto seria inverter uma cor pensada para NÃO inverter (ver o comentário
 *   de `--color-brand-fill` no index.css).
 *
 * `bg-white` puro (o bug desta versão), qualquer `text-black`/`border-black`
 * e toda a família cinza/colorida numerada (`gray-100`, `red-500`, ...)
 * continuam SEM exceção.
 */
function excecaoValida(
  codigo: string,
  prefixo: string,
  token: string,
  inicio: number,
  tamanho: number,
): boolean {
  if (prefixo === "bg" && token === "black") {
    const depois = codigo.slice(inicio + tamanho, inicio + tamanho + 2);
    return /^\/\d/.test(depois);
  }
  if (prefixo === "text" && token === "white") {
    const janela = codigo.slice(Math.max(0, inicio - 400), inicio + 400);
    return /-fill\b|bg-disabled\b/.test(janela);
  }
  return false;
}

describe("nenhum componente usa classe da paleta padrão do Tailwind fora de token (V11 — guarda estendido)", () => {
  const arquivos = arquivosDeComponente(COMPONENTS_DIR);

  for (const caminho of arquivos) {
    const nome = caminho.slice(COMPONENTS_DIR.length + 1);
    it(`${nome} não usa bg-white/text-white/bg-black/gray-NNN/... fora das exceções nomeadas`, () => {
      const codigo = semComentarios(readFileSync(caminho, "utf-8"));
      const achados: string[] = [];
      const re = new RegExp(NON_TOKEN_COLOR_RE.source, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(codigo))) {
        const [inteiro, prefixo, token] = m;
        if (excecaoValida(codigo, prefixo, token, m.index, inteiro.length)) continue;
        achados.push(`"${inteiro}" em ${nome}`);
      }
      expect(achados, achados.join("; ") || undefined).toEqual([]);
    });
  }
});
