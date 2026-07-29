import { create } from "zustand";
import {
  getBackend,
  type EnrichApplyResult,
  type EnrichProgress,
  type EnrichProposal,
} from "../lib/api";
import { textoSemPropostas } from "../lib/curadoria";
import type { Modo } from "../lib/types";
import { useToastStore } from "./toastStore";
import { useUiStore } from "./uiStore";

/**
 * Reexportado por compatibilidade: a copy vive em `lib/curadoria` (testada
 * como função pura), e o resto do app continua importando daqui.
 */
export { textoSemPropostas };

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
  /**
   * O TRABALHO da varredura em curso (ou da última) — V9. Fica no store
   * porque o DESFECHO depende dele: "conferimos as 81 músicas incompletas"
   * é falso quando quem rodou foi a conferência, que olha as completas
   * justamente por serem o caso que a outra nunca alcança.
   */
  modo: Modo;
  proposals: EnrichProposal[];
  /** Último evento `enrich:progress`; null = ainda não chegou nenhum. */
  progress: EnrichProgress | null;
  /** Identificador da varredura em curso ("" = nenhuma) — chave do cancelamento. */
  scanId: string;
  /**
   * Quantas músicas incompletas a última varredura conferiu (total do último
   * evento de progresso). É o que separa "não havia nada a fazer" de
   * "conferimos N e não achamos nada" quando não sobra proposta nenhuma (A6).
   *
   * `null` = NÃO SABEMOS: a assinatura do progresso é best-effort e falha em
   * silêncio. Antes isso virava `0`, e o texto do zero afirmava que a pasta
   * estava completa — uma varredura de 95 músicas terminava anunciando
   * sucesso que ninguém verificou (QA MÉDIO-11).
   */
  scannedTotal: number | null;
  /**
   * Quantas músicas a etapa 2 deixou de perguntar ao som porque se desligou no
   * meio da última varredura (QA A2). Zero é o caso normal.
   *
   * Vem no RETORNO da varredura, e não do canal de progresso: é por isso que
   * ele não some quando a assinatura de progresso falha, ao contrário do
   * `scannedTotal`. Se a tela não disser este número, a pessoa vê uma linha
   * vermelha, o silêncio das outras 149, e conclui que o resto foi conferido —
   * a DECISIONS #86 acontecendo por omissão de escopo.
   */
  semPerguntarAoSom: number;
  /** Erros do último apply, por song_id — a linha fica visível com o erro (A5). */
  applyErrors: Record<number, string>;
  /**
   * Um invoke de varredura ainda não respondeu — inclusive DEPOIS de cancelar
   * (o backend só para na próxima música). Enquanto for true, disparar outra
   * varredura sobreporia as duas (M4).
   */
  scanInFlight: boolean;

  /** Dispara a varredura; ignora chamadas com uma varredura em andamento. */
  startScan: (folderPrefix: string, modo?: Modo) => Promise<void>;
  /** Esconde o overlay — a varredura CONTINUA rodando em segundo plano. */
  hideOverlay: () => void;
  /** Reabre o overlay (indicador da sidebar) sem disparar nada. */
  openOverlay: () => void;
  /** Cancela: para a varredura no backend e/ou descarta as propostas na tela. */
  close: () => void;
  /**
   * Depois de um apply com falhas: mantém na revisão SÓ as músicas que não
   * gravaram, cada uma com o erro devolvido (A5 — o usuário precisa ver que a
   * sugestão foi recusada, não silenciosamente perdida).
   */
  retainFailures: (falhas: EnrichApplyResult[]) => void;
}

// Guarda de corrida (mesmo padrão do runSearch do libraryStore): cancelar
// durante a varredura invalida o resultado que chegar depois.
let scanSeq = 0;
// contador de reserva: jsdom antigo/WebView sem crypto.randomUUID
let scanCounter = 0;

/**
 * Identificador de uma busca. Exportado porque o funil individual do editor
 * também precisa de um (B1): sem id, a busca de uma música só não podia ser
 * cancelada — e com a rede fora do ar ela segura o editor por mais de um
 * minuto.
 */
export function novoScanId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `scan-${Date.now()}-${++scanCounter}`;
}

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
  scanId: "",
  scannedTotal: 0,
  semPerguntarAoSom: 0,
  applyErrors: {},
  scanInFlight: false,
  modo: "completar",

  // o padrão é o trabalho barato, aqui como no Rust: a varredura que lê o
  // áudio de TODAS as músicas nunca acontece por omissão
  startScan: async (folderPrefix, modo = "completar") => {
    // bloqueia disparo duplo — inclusive com a varredura anterior cancelada
    // mas ainda respondendo (M4)
    if (get().status === "scanning" || get().scanInFlight) return;
    const seq = ++scanSeq;
    const scanId = novoScanId();
    set({
      status: "scanning",
      overlayOpen: true,
      folderPrefix,
      modo,
      proposals: [],
      progress: null,
      scanId,
      scannedTotal: 0,
      semPerguntarAoSom: 0,
      applyErrors: {},
      scanInFlight: true,
    });

    // Progresso é best-effort e NÃO pode atrasar a varredura: a assinatura
    // roda em paralelo (o listener já entra registrado no mesmo tick) e um
    // backend sem onEnrichProgress apenas mantém o aviso indeterminado.
    const listener: { unlisten: (() => void) | null } = { unlisten: null };
    const subscribing = (async () => {
      try {
        const unlisten = await getBackend().onEnrichProgress((p) => {
          // evento de OUTRA varredura (a zumbi que foi cancelada) não mexe na
          // barra desta — era assim que o progresso saía corrompido (M4)
          if (seq === scanSeq && p.scan_id === scanId) set({ progress: p });
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
      // A chave do Vagalume é preferência de quem usa (V8/F18) e viaja como
      // PARÂMETRO a cada varredura: o BACKEND não guarda credencial nenhuma —
      // quem guarda é o frontend, no localStorage das preferências, e a tela
      // de Configurações diz isso com todas as letras. Sem chave, a etapa é
      // pulada em silêncio — não é erro.
      // QA A2 — a resposta é um OBJETO, não a lista. O campo novo conta as
      // músicas que a etapa 2 deixou de perguntar depois de se desligar, e
      // sem ele não havia onde dizer que metade da varredura não aconteceu.
      const { propostas, sem_perguntar_ao_som: semPerguntarAoSom } =
        await getBackend().enrichFolderScan(
          folderPrefix,
          scanId,
          useUiStore.getState().vagalumeApiKey || null,
          modo,
        );
      if (seq !== scanSeq) return; // cancelado durante a busca: descarta
      // quantas candidatas foram efetivamente conferidas (A6); null quando o
      // canal de progresso não respondeu — nunca 0 por omissão (MÉDIO-11)
      const conferidas = get().progress?.total ?? null;
      const emSegundoPlano = !get().overlayOpen;
      if (emSegundoPlano && propostas.length === 0) {
        // nada a mostrar e ninguém olhando: só o aviso — que diz a verdade
        // sobre as N conferidas sem resultado, e sobre as que nem chegaram a
        // ser perguntadas ao som
        set({
          status: "idle",
          proposals: [],
          progress: null,
          scanId: "",
          scannedTotal: conferidas,
          semPerguntarAoSom,
        });
        useToastStore
          .getState()
          .push(
            textoSemPropostas(conferidas, modo, semPerguntarAoSom),
            // a etapa 2 ter parado no meio não é um desfecho bem-sucedido:
            // o mesmo tom de "tudo certo" era o que fazia o silêncio passar
            // por aprovação (QA A2)
            semPerguntarAoSom > 0 ? "warning" : "success",
          );
        return;
      }
      set({
        status: "review",
        proposals: propostas,
        progress: null,
        scanId: "",
        scannedTotal: conferidas,
        semPerguntarAoSom,
      });
      if (emSegundoPlano) {
        // o toast desta base não carrega ação de clique: quem leva de volta à
        // revisão é o indicador "Revisar N propostas" da sidebar
        useToastStore.getState().push(textoEncontrado(propostas.length), "success");
      }
    } catch {
      if (seq !== scanSeq) return;
      useToastStore
        .getState()
        .push("Sem conexão — a busca de dados precisa de internet.", "warning");
      set({
        status: "idle",
        overlayOpen: false,
        proposals: [],
        progress: null,
        scanId: "",
      });
    } finally {
      await subscribing;
      listener.unlisten?.();
      // o invoke respondeu: só agora outra varredura pode começar (M4)
      set({ scanInFlight: false });
    }
  },

  hideOverlay: () => set({ overlayOpen: false }),

  openOverlay: () => {
    if (get().status !== "idle") set({ overlayOpen: true });
  },

  close: () => {
    scanSeq++;
    const { status, scanId } = get();
    set({
      status: "idle",
      overlayOpen: false,
      proposals: [],
      progress: null,
      scanId: "",
      scannedTotal: 0,
      semPerguntarAoSom: 0,
      applyErrors: {},
    });
    // Cancelar de verdade: a guarda de corrida acima só descarta o RESULTADO;
    // sem isto a varredura seguia consultando o LRCLIB até o fim (M4).
    if (status === "scanning" && scanId) {
      try {
        void getBackend()
          .enrichCancelScan(scanId)
          .catch(() => {
            // backend antigo/sem o comando: a guarda de corrida basta
          });
      } catch {
        // backend sem enrichCancelScan (fakes de teste): idem
      }
    }
  },

  retainFailures: (falhas) => {
    const errors: Record<number, string> = {};
    for (const f of falhas) {
      errors[f.song_id] = f.error ?? "não foi possível gravar";
    }
    set((s) => ({
      status: "review",
      overlayOpen: true,
      proposals: s.proposals.filter((p) => p.song_id in errors),
      applyErrors: errors,
    }));
  },
}));
