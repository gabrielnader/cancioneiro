import { getBackend, isTauri, type ResumoDoRecebimento } from "./api";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlayerStore } from "../stores/playerStore";
import { useToastStore } from "../stores/toastStore";
import { useUiStore } from "../stores/uiStore";

/**
 * V16 — o pacote de letras do grupo, recebido POR TRÁS ao abrir o app.
 *
 * Decisão do dono do produto: sem cartão e sem botão — "um passo a mais é um
 * passo que os usuários podem não dar". Por isso ele é a gravação mais
 * estreita do app: só preenche o que está VAZIO (ver `pacote.rs`), e quem
 * autoriza a ida à internet é a mesma preferência da atualização
 * ("Verificar atualizações ao abrir"). Desligada, nada sai do computador.
 *
 * Falha em silêncio, como a atualização: sem internet, sem pacote publicado,
 * nada acontece e nada aparece. O que aparece é só o desfecho bom.
 */
export async function receberPacoteAoAbrir(): Promise<void> {
  if (!isTauri() || !useUiStore.getState().checkUpdatesOnStart) return;
  let resumo: ResumoDoRecebimento | null;
  try {
    resumo = await getBackend().receberPacoteDoGrupo();
  } catch {
    return;
  }
  const texto = textoDoRecebimento(resumo);
  if (texto === null) return;
  await useLibraryStore.getState().loadLibrary();
  useToastStore.getState().push(texto, "success");
}

/** O aviso discreto do que chegou; `null` quando nada mudou. */
export function textoDoRecebimento(r: ResumoDoRecebimento | null): string | null {
  if (!r || r.preenchidas === 0) return null;
  if (r.com_letra_nova > 0) {
    return r.com_letra_nova === 1
      ? "As letras do grupo chegaram: 1 música ganhou letra."
      : `As letras do grupo chegaram: ${r.com_letra_nova} músicas ganharam letra.`;
  }
  return r.preenchidas === 1
    ? "As letras do grupo completaram 1 música."
    : `As letras do grupo completaram ${r.preenchidas} músicas.`;
}

/**
 * Avisa o backend de qual ARQUIVO está no player (tocando ou pausado): o
 * recebimento nunca o grava, porque reescrever o arquivo que o player lê pode
 * cortar o som. Devolve a função que para de vigiar.
 */
export function vigiarOQueEstaTocando(): () => void {
  let ultimo: string | null = null;
  const avisar = (caminho: string | null) => {
    if (caminho === ultimo) return;
    ultimo = caminho;
    void getBackend()
      .definirTocando(caminho)
      .catch(() => {});
  };
  avisar(usePlayerStore.getState().current?.file_path ?? null);
  return usePlayerStore.subscribe((s) => avisar(s.current?.file_path ?? null));
}
