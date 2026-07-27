import { create } from "zustand";
import { getBackend, type EnrichProgress, type EnrichProposal } from "../lib/api";
import { useToastStore } from "./toastStore";

/**
 * Estado do fluxo "Completar dados desta pasta" (F13 — PRD V5).
 *
 * A varredura é UM invoke que pode levar minutos (rede explícita), mas é
 * SOMENTE LEITURA: consulta o LRCLIB e lê o banco numa conexão dedicada, sem
 * tocar em arquivo nenhum. Por isso "varredura rodando" e "overlay visível"
 * são estados SEPARADOS — o usuário pode mandar a busca para segundo plano e
 * continuar usando o app. Só a gravação (apply) é modal e bloqueante: é
 * rápida e mexe nos MP3.
 */
export type EnrichStatus = "idle" | "scanning" | "review";

interface EnrichState {
  status: EnrichStatus;
  /** O overlay de revisão está na tela? Independe de a varredura estar rodando. */
  overlayOpen: boolean;
  /** Prefixo varrido ("" = biblioteca inteira). */
  folderPrefix: string;
  proposals: EnrichProposal[];
  /** Último evento `enrich:progress`; null = ainda não chegou nenhum. */
  progress: EnrichProgress | null;

  /** Dispara a varredura; ignora chamadas com uma varredura em andamento. */
  startScan: (folderPrefix: string) => Promise<void>;
  /** Esconde o overlay — a varredura CONTINUA rodando em segundo plano. */
  hideOverlay: () => void;
  /** Reabre o overlay (indicador da sidebar) sem disparar nada. */
  openOverlay: () => void;
  /** Cancela: descarta a varredura em andamento e/ou as propostas na tela. */
  close: () => void;
}

// Guarda de corrida (mesmo padrão do runSearch do libraryStore): cancelar
// durante a varredura invalida o resultado que chegar depois.
let scanSeq = 0;

function textoEncontrado(n: number): string {
  return n === 1
    ? "Dados encontrados para 1 música — abra a revisão para conferir."
    : `Dados encontrados para ${n} músicas — abra a revisão para conferir.`;
}

export const useEnrichStore = create<EnrichState>()((set, get) => ({
  status: "idle",
  overlayOpen: false,
  folderPrefix: "",
  proposals: [],
  progress: null,

  startScan: async (folderPrefix) => {
    if (get().status === "scanning") return; // bloqueia disparo duplo
    const seq = ++scanSeq;
    set({
      status: "scanning",
      overlayOpen: true,
      folderPrefix,
      proposals: [],
      progress: null,
    });

    // Progresso é best-effort e NÃO pode atrasar a varredura: a assinatura
    // roda em paralelo (o listener já entra registrado no mesmo tick) e um
    // backend sem onEnrichProgress apenas mantém o aviso indeterminado.
    const listener: { unlisten: (() => void) | null } = { unlisten: null };
    const subscribing = (async () => {
      try {
        const unlisten = await getBackend().onEnrichProgress((p) => {
          if (seq === scanSeq) set({ progress: p });
        });
        if (seq === scanSeq) {
          listener.unlisten = unlisten;
        } else {
          unlisten();
        }
      } catch {
        // sem canal de progresso: overlay segue com o aviso de demora
      }
    })();

    try {
      const proposals = await getBackend().enrichFolderScan(folderPrefix);
      if (seq !== scanSeq) return; // cancelado durante a busca: descarta
      const emSegundoPlano = !get().overlayOpen;
      if (emSegundoPlano && proposals.length === 0) {
        // nada a mostrar e ninguém olhando: só o aviso
        set({ status: "idle", proposals: [], progress: null });
        useToastStore.getState().push("Nada a ajustar nesta pasta.", "success");
        return;
      }
      set({ status: "review", proposals, progress: null });
      if (emSegundoPlano) {
        // o toast desta base não carrega ação de clique: quem leva de volta à
        // revisão é o indicador "Revisar N propostas" da sidebar
        useToastStore.getState().push(textoEncontrado(proposals.length), "success");
      }
    } catch {
      if (seq !== scanSeq) return;
      useToastStore
        .getState()
        .push("Sem conexão — a busca de dados precisa de internet.", "warning");
      set({ status: "idle", overlayOpen: false, proposals: [], progress: null });
    } finally {
      await subscribing;
      listener.unlisten?.();
    }
  },

  hideOverlay: () => set({ overlayOpen: false }),

  openOverlay: () => {
    if (get().status !== "idle") set({ overlayOpen: true });
  },

  close: () => {
    scanSeq++;
    set({
      status: "idle",
      overlayOpen: false,
      proposals: [],
      progress: null,
    });
  },
}));
