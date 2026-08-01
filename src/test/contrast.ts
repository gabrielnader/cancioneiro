/**
 * Contraste WCAG 2.1 para os testes de acessibilidade da interface.
 *
 * O produto é usado por coordenadoras em notebooks, muitas vezes em salas mal
 * iluminadas: texto secundário também precisa passar em AA (4.5:1), e passar
 * em TODOS os fundos em que a linha pode aparecer — não só no branco.
 *
 * V11 — os componentes pararam de escrever hex direto (`text-[#RRGGBB]`) e
 * passaram a usar os tokens de tema (`text-ink-quaternary`, `bg-brand-soft`,
 * ...). Este arquivo lê os valores de UMA fonte só — o `index.css` de
 * verdade — em vez de duplicar os hex aqui: duplicar é como o claro e o
 * escuro divergiam sem ninguém perceber antes desta versão.
 *
 * Lido com `node:fs`, e não com um `import ... ?raw` do Vite: o plugin do
 * Tailwind intercepta todo import de `.css` (mesmo com `?raw`) e devolve
 * conteúdo vazio — `fs.readFileSync` lê o arquivo em disco direto, por fora
 * do pipeline do Vite, e evita esse conflito. O caminho parte de
 * `process.cwd()` (a raiz do projeto, de onde o `vitest` sempre roda) e não
 * de `import.meta.url`: sob o ambiente `jsdom` o Vite resolve `import.meta.url`
 * contra a location falsa do jsdom (`http://localhost:3000/...`), não contra
 * o arquivo real em disco.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const indexCssRaw = readFileSync(resolve(process.cwd(), "src/index.css"), "utf-8");

/** Conteúdo de um bloco `seletor { ... }` do CSS bruto (sem chaves aninhadas). */
function blocoCss(css: string, seletor: string): string {
  const inicio = css.indexOf(seletor);
  if (inicio === -1) throw new Error(`bloco não encontrado em index.css: ${seletor}`);
  const abre = css.indexOf("{", inicio);
  const fecha = css.indexOf("}", abre);
  return css.slice(abre + 1, fecha);
}

/** Todo par `--color-nome: #hex;` de um bloco. */
function coresDoBloco(bloco: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /--color-([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bloco))) {
    // maiúsculo: é assim que o hex sempre apareceu nos testes (herdado de
    // antes desta versão, quando eles liam `text-[#RRGGBB]` direto).
    out[m[1]] = m[2].toUpperCase();
  }
  return out;
}

/** Tokens do tema CLARO (o `@theme` do index.css já É o claro, por definição). */
const CORES_CLARO = coresDoBloco(blocoCss(indexCssRaw, "@theme"));
/** Tokens do tema ESCURO (`:root[data-theme="dark"]`). */
const CORES_ESCURO = coresDoBloco(blocoCss(indexCssRaw, ':root[data-theme="dark"]'));

const NOMES_POR_TAMANHO = [...new Set([...Object.keys(CORES_CLARO), "white", "black"])].sort(
  (a, b) => b.length - a.length,
);

/** Um utilitário `prefixo-token` (ex.: `text-ink-quaternary`, `bg-brand-soft`). */
function extrairToken(className: string, prefixo: "text" | "bg" | "border"): string | null {
  const re = new RegExp(`(?:^|\\s)${prefixo}-(${NOMES_POR_TAMANHO.join("|")})(?=[\\s"]|$)`);
  const m = re.exec(className);
  return m ? m[1] : null;
}

function corDoToken(nome: string, tema: "claro" | "escuro"): string {
  if (nome === "white") return "#FFFFFF";
  if (nome === "black") return "#000000";
  const mapa = tema === "escuro" ? CORES_ESCURO : CORES_CLARO;
  const hex = mapa[nome];
  if (!hex) throw new Error(`token de cor sem valor em index.css: ${nome} (${tema})`);
  return hex;
}

/**
 * Testa se uma classe declara cor de texto/fundo via token (`text-brand`,
 * `bg-warning-soft`, ...) — para varreduras que precisam achar "todo elemento
 * com cor" sem resolver o valor.
 */
export const TEXT_COLOR_RE = new RegExp(
  `(?:^|\\s)text-(${NOMES_POR_TAMANHO.join("|")})(?=[\\s"]|$)`,
);
export const BG_COLOR_RE = new RegExp(
  `(?:^|\\s)bg-(${NOMES_POR_TAMANHO.join("|")})(?=[\\s"]|$)`,
);

/** Contraste mínimo exigido pela WCAG 2.1 AA para texto normal. */
export const AA_TEXTO_NORMAL = 4.5;

/** Luminância relativa (WCAG 2.1) de uma cor "#RRGGBB". */
export function relativeLuminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`cor inesperada: ${hex}`);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(m[1].slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Razão de contraste (WCAG 2.1) entre duas cores "#RRGGBB". */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [claro, escuro] = la > lb ? [la, lb] : [lb, la];
  return (claro + 0.05) / (escuro + 0.05);
}

/**
 * Cor do texto declarada numa classe Tailwind `text-<token>` — resolvida
 * contra o tema CLARO por padrão (é o que os testes existentes assumem;
 * passe `"escuro"` para conferir o par escuro do mesmo componente).
 */
export function corDoTexto(className: string, tema: "claro" | "escuro" = "claro"): string {
  const nome = extrairToken(className, "text");
  if (!nome) throw new Error(`sem cor de texto em: ${className}`);
  return corDoToken(nome, tema);
}

/** Cor de fundo declarada numa classe Tailwind `bg-<token>`, ou `null` se não houver. */
export function corDoFundo(
  className: string,
  tema: "claro" | "escuro" = "claro",
): string | null {
  const nome = extrairToken(className, "bg");
  return nome ? corDoToken(nome, tema) : null;
}

/** Fundos possíveis de uma linha da lista (normal, selecionada, hover), no tema claro. */
export const FUNDOS_DA_LINHA = {
  branco: CORES_CLARO.surface,
  selecionado: CORES_CLARO["brand-soft"],
  hover: CORES_CLARO["surface-hover"],
} as const;

/** Os mesmos três fundos, no tema escuro (usado pelos testes de tema escuro). */
export const FUNDOS_DA_LINHA_ESCURO = {
  branco: CORES_ESCURO.surface,
  selecionado: CORES_ESCURO["brand-soft"],
  hover: CORES_ESCURO["surface-hover"],
} as const;
