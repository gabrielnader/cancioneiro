/**
 * A versão do aplicativo, para aparecer ao lado do nome.
 *
 * Existe porque, sem suporte a quem perguntar, "qual versão você tem?" é a
 * primeira pergunta de todo relato — e a pessoa precisa conseguir ler isso na
 * tela, sem abrir menu nenhum.
 *
 * Fora do Tauri (testes, navegador) devolve vazio: melhor não mostrar nada do
 * que mostrar um número inventado.
 */
export async function versaoDoApp(): Promise<string> {
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    return await getVersion();
  } catch {
    return "";
  }
}
