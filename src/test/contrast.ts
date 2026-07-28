/**
 * Contraste WCAG 2.1 para os testes de acessibilidade da interface.
 *
 * O produto é usado por coordenadoras em notebooks, muitas vezes em salas mal
 * iluminadas: texto secundário também precisa passar em AA (4.5:1), e passar
 * em TODOS os fundos em que a linha pode aparecer — não só no branco.
 */

/** Fundos possíveis de uma linha da lista (normal, selecionada, hover). */
export const FUNDOS_DA_LINHA = {
  branco: "#FFFFFF",
  selecionado: "#F0FDFA",
  hover: "#F3F4F6",
} as const;

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

/** Cor do texto declarada em uma classe Tailwind arbitrária `text-[#RRGGBB]`. */
export function corDoTexto(className: string): string {
  const m = /text-\[(#[0-9a-fA-F]{6})\]/.exec(className);
  if (!m) throw new Error(`sem cor de texto em: ${className}`);
  return m[1];
}
