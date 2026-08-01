/**
 * Tema claro/escuro (V11). `ThemePref` é o que a pessoa ESCOLHE (guardado no
 * `uiStore`); "automático" não é um terceiro valor de tema — ele só decide
 * QUAL dos dois (claro/escuro) vale, olhando o sistema operacional.
 */
export type ThemePref = "light" | "dark" | "auto";
export type ResolvedTheme = "light" | "dark";

const DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)";

/** O tema efetivo para uma preferência, dado se o SO está no modo escuro. */
export function resolveTheme(pref: ThemePref, systemPrefersDark: boolean): ResolvedTheme {
  if (pref === "auto") return systemPrefersDark ? "dark" : "light";
  return pref;
}

function systemPrefersDark(): boolean {
  // jsdom (testes) não implementa matchMedia por padrão; trata como claro.
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(DARK_MEDIA_QUERY).matches;
}

/**
 * Aplica o tema resolvido no `<html>` via `data-theme` — é nele que o CSS
 * (index.css) pendura os valores de cada tema, com especificidade maior que
 * o `@media (prefers-color-scheme)` puro. Chamado de forma SÍNCRONA em
 * `main.tsx`, antes do primeiro render: é isso que evita a piscada de claro
 * ao abrir o app no escuro (DECISIONS).
 */
export function applyTheme(pref: ThemePref): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = resolveTheme(pref, systemPrefersDark());
}

/**
 * Mantém o tema em dia quando o SO muda de aparência NO MEIO do uso (só
 * importa para "automático" — nos outros dois o valor já está fixo). Chamado
 * uma vez, do efeito de inicialização do App; devolve a função de limpeza.
 */
export function watchSystemTheme(getPref: () => ThemePref): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const mq = window.matchMedia(DARK_MEDIA_QUERY);
  const onChange = () => applyTheme(getPref());
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}
