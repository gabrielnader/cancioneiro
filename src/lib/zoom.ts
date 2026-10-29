/**
 * O "Tamanho da letra" do topo da tela (V15).
 *
 * Não muda só a fonte: muda o ZOOM da janela inteira, como o Ctrl+ do
 * navegador. É de propósito. O app foi escrito em pixels fixos (15px aqui,
 * 13px ali), e aumentar só o texto deixaria botões pequenos com letra grande
 * dentro, cortando. Com zoom tudo cresce junto — texto, botões, espaçamentos —
 * e, mais importante, a tela passa a ter MENOS pixels de largura, então o
 * layout estreito (lateral virando gaveta, etc.) entra sozinho quando a soma
 * de "Windows em 150%" com "letra muito grande" não cabe.
 *
 * Os três níveis param em 1,3 por causa do pior caso medido: um notebook
 * 1366×768 com o Windows em 150% deixa ~910px de largura útil; com 1,3 sobram
 * ~700, que é o mínimo em que a tela de ouvir ainda funciona sem rolar de lado.
 */
import { isTauri } from "./api";

export const NIVEIS_DE_ZOOM = [1, 1.15, 1.3] as const;

export type NivelDeZoom = 0 | 1 | 2;

/** O nome de cada nível, para leitor de tela e para o `title`. */
export const ROTULOS_DE_ZOOM: Record<NivelDeZoom, string> = {
  0: "Letra normal",
  1: "Letra grande",
  2: "Letra muito grande",
};

export async function aplicarZoom(nivel: NivelDeZoom): Promise<void> {
  const fator = NIVEIS_DE_ZOOM[nivel] ?? 1;
  if (isTauri()) {
    try {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      await getCurrentWebview().setZoom(fator);
      return;
    } catch (e) {
      // sem a permissão (versão antiga do arquivo de capacidades) cai no zoom
      // de CSS abaixo: pior que o da janela, mas a letra cresce do mesmo jeito
      console.error("[zoom] setZoom falhou, usando zoom de CSS:", e);
    }
  }
  // Fora do Tauri (navegador, testes): o zoom de CSS faz o mesmo papel visual.
  document.documentElement.style.zoom = fator === 1 ? "" : String(fator);
}
