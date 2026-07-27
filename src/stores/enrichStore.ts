import { create } from "zustand";
import { getBackend, type EnrichProposal } from "../lib/api";
import { useToastStore } from "./toastStore";

/**
 * Estado do fluxo "Completar dados desta pasta" (F13 — PRD V5): a varredura
 * é UM invoke que pode levar minutos (rede explícita); o overlay de revisão
 * (EnrichReview) mostra progresso, propostas e aplica as aceitas.
 */
export type EnrichStatus = "idle" | "scanning" | "review";

interface EnrichState {
  status: EnrichStatus;
  /** Prefixo varrido ("" = biblioteca inteira). */
  folderPrefix: string;
  proposals: EnrichProposal[];

  /** Dispara a varredura; ignora chamadas com uma varredura em andamento. */
  startScan: (folderPrefix: string) => Promise<void>;
  /** Fecha o overlay; uma varredura em andamento é descartada ao resolver. */
  close: () => void;
}

// Guarda de corrida (mesmo padrão do runSearch do libraryStore): fechar
// durante a varredura invalida o resultado que chegar depois.
let scanSeq = 0;

export const useEnrichStore = create<EnrichState>()((set, get) => ({
  status: "idle",
  folderPrefix: "",
  proposals: [],

  startScan: async (folderPrefix) => {
    if (get().status === "scanning") return; // bloqueia disparo duplo
    const seq = ++scanSeq;
    set({ status: "scanning", folderPrefix, proposals: [] });
    try {
      const proposals = await getBackend().enrichFolderScan(folderPrefix);
      if (seq !== scanSeq) return; // fechado durante a busca: descarta
      set({ status: "review", proposals });
    } catch {
      if (seq !== scanSeq) return;
      useToastStore
        .getState()
        .push("Sem conexão — a busca de dados precisa de internet.", "warning");
      set({ status: "idle", proposals: [] });
    }
  },

  close: () => {
    scanSeq++;
    set({ status: "idle", proposals: [] });
  },
}));
