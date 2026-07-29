import { create } from "zustand";
import {
  getBackend,
  type EnrichApplyResult,
  type EnrichProgress,
  type EnrichProposal,
  type TranscricaoProgresso,
} from "../lib/api";
import { textoSemPropostas, type DownloadPendente } from "../lib/curadoria";
import { useToastStore } from "./toastStore";

/**
 * Reexportado por compatibilidade: a copy vive em `lib/curadoria` (testada
 * como função pura), e o resto do app continua importando daqui.
 */
export { textoSemPropostas };

/**
 * Estado do fluxo "Buscar dados desta pasta" (F13 — PRD V5; V10).
 *
 * A varredura é UM invoke que pode levar minutos (rede explícita), mas é
 * SOMENTE LEITURA: consulta o LRCLIB e lê o banco numa conexão dedicada, sem
 * tocar em arquivo nenhum. Por isso "varredura rodando" e "overlay visível"
 * são estados SEPARADOS — o usuário pode mandar a busca para segundo plano e
 * continuar usando o app. Só a gravação (apply) é modal e bloqueante.
 *
 * V10 acrescentou `transcribing`: a etapa 5 leva HORAS, e vale para ela tudo
 * o que vale para a varredura — segundo plano, cancelamento e app usável (a
 * lição da v0.8.1, DECISIONS #92).
 */
export type EnrichStatus = "idle" | "scanning" | "transcribing" | "review";

/** O que ESTA máquina pode fazer quanto à etapa 5, no momento do disparo. */
export interface EstadoDaTranscricao {
  /** O transcritor E o modelo estão prontos? Quem responde é `enrich_count`. */
  disponivel: boolean;
  /** O que falta baixar, quando falta — com tamanho e tempo (DECISIONS #106). */
  download: DownloadPendente | null;
}

interface EnrichState {
  status: EnrichStatus;
  /** O overlay de revisão está na tela? Independe do trabalho estar rodando. */
  overlayOpen: boolean;
  /** Prefixo varrido ("" = biblioteca inteira). */
  folderPrefix: string;
  proposals: EnrichProposal[];
  /** Último evento `enrich:progress`; null = ainda não chegou nenhum. */
  progress: EnrichProgress | null;
  /** Identificador do trabalho em curso ("" = nenhum) — chave do cancelamento. */
  scanId: string;
  /**
   * Quantas músicas a última varredura conferiu (total do último evento de
   * progresso). É o que separa "não havia nada a fazer" de "conferimos N e não
   * achamos nada" (A6).
   *
   * `null` = NÃO SABEMOS: a assinatura do progresso é best-effort e falha em
   * silêncio. Antes isso virava `0`, e o texto do zero afirmava que a pasta
   * estava completa (QA MÉDIO-11).
   */
  scannedTotal: number | null;
  /**
   * Quantas músicas a etapa 2 deixou de perguntar ao som porque se desligou no
   * meio da última varredura (QA A2). Zero é o caso normal.
   */
  semPerguntarAoSom: number;
  /**
   * V10 — quem chegou ao fim da varredura ainda sem letra, em ids. Vem PRONTO
   * do backend: a regra de quem sobrou é uma só, e deduzi-la das propostas
   * aqui seria a DECISIONS #80 de novo (uma proposta pode ter sido descartada
   * por no-op e a música continuar sem letra).
   */
  semLetraNoFim: number[];
  /** Segundos estimados para transcrever essas músicas, como o backend contou. */
  segundosDeTranscricao: number;
  /**
   * QA A1 — segundos de CPU por segundo de ÁUDIO **medidos nesta máquina** na
   * última fila da etapa 5; `null` enquanto nunca se mediu nada.
   *
   * Ela era descartada na chegada (`const { propostas } = ...`), e a
   * DECISIONS #106 promete o contrário: "a primeira transcrição desta máquina
   * devolve a razão real, e é ela que passa a valer". Só passa a valer o que
   * sobrevive ao retorno.
   *
   * A tela NÃO calcula nada com este número — a conta é do Rust (DECISIONS
   * #106), e a cópia em TypeScript já divergiu uma vez (DECISIONS #80). O que
   * ela faz é PARAR DE JOGAR FORA um campo do contrato: foi o descarte, e não
   * a falta de fórmula, que deixou a promessa da #106 desligada.
   *
   * Onde o laço se fecha é decisão do backend, e as duas saídas cabem aqui sem
   * mudar esta linha: se ele publicar por onde receber a razão de volta, é
   * daqui que ela sai; se ele passar a guardá-la sozinho, este valor vira o que
   * a tela sabe sobre a máquina — e continua sendo mais do que zero. Inventar o
   * parâmetro de envio antes de o contrato existir seria o defeito A2 desta
   * mesma rodada, do outro lado.
   *
   * Ela também NÃO é limpa pelo `close()`: é medição da MÁQUINA, e não desta
   * revisão.
   */
  razaoMedida: number | null;
  /** O que esta máquina pode fazer quanto à etapa 5 (vem do disparo). */
  transcricao: EstadoDaTranscricao;
  /** Último evento `transcricao:progresso`; null = nenhum ainda. */
  transcricaoProgress: TranscricaoProgresso | null;
  /**
   * A pessoa já respondeu "agora não" à pergunta do fim. Uma pergunta que
   * volta sozinha depois de respondida é o pop-up que se aprende a fechar sem
   * ler — e aí ele deixa de perguntar qualquer coisa.
   */
  transcricaoDispensada: boolean;
  /** Erros do último apply, por song_id — a linha fica visível com o erro (A5). */
  applyErrors: Record<number, string>;
  /**
   * Um invoke de varredura ainda não respondeu — inclusive DEPOIS de cancelar
   * (o backend só para na próxima música). Enquanto for true, disparar outra
   * varredura sobreporia as duas (M4).
   */
  scanInFlight: boolean;

  /**
   * Dispara a varredura; ignora chamadas com uma varredura em andamento.
   *
   * `transcricao` é o que a CONTAGEM já disse sobre esta máquina. Ele viaja no
   * disparo, e não é consultado aqui, porque quem tem a contagem e a lista de
   * acessórios é a tela de Configurações — e porque combinar dois estados de
   * acessório é regra, que não pode existir em dois lugares.
   */
  startScan: (
    folderPrefix: string,
    transcricao?: EstadoDaTranscricao,
  ) => Promise<void>;
  /**
   * A etapa 5, sobre `semLetraNoFim`. Roda em segundo plano, é cancelável pelo
   * mesmo `close()` e acrescenta as propostas à revisão que já está aberta.
   */
  startTranscricao: () => Promise<void>;
  /** "Agora não": a pergunta do fim some desta revisão, e não volta sozinha. */
  dispensarTranscricao: () => void;
  /** Esconde o overlay — o trabalho CONTINUA rodando em segundo plano. */
  hideOverlay: () => void;
  /** Reabre o overlay (indicador da sidebar) sem disparar nada. */
  openOverlay: () => void;
  /** Cancela: para o trabalho no backend e/ou descarta as propostas na tela. */
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
 * Identificador de um trabalho longo. Exportado porque o funil individual do
 * editor e os downloads de acessório também precisam de um: sem id, o trabalho
 * não pode ser cancelado.
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

/** Estado inicial da etapa 5: nada sabido, nada oferecido. */
const SEM_TRANSCRICAO: EstadoDaTranscricao = { disponivel: false, download: null };

export const useEnrichStore = create<EnrichState>()((set, get) => ({
  status: "idle",
  overlayOpen: false,
  folderPrefix: "",
  proposals: [],
  progress: null,
  scanId: "",
  scannedTotal: 0,
  semPerguntarAoSom: 0,
  semLetraNoFim: [],
  segundosDeTranscricao: 0,
  razaoMedida: null,
  transcricao: SEM_TRANSCRICAO,
  transcricaoProgress: null,
  transcricaoDispensada: false,
  applyErrors: {},
  scanInFlight: false,

  startScan: async (folderPrefix, transcricao = SEM_TRANSCRICAO) => {
    // bloqueia disparo duplo — inclusive com a varredura anterior cancelada
    // mas ainda respondendo (M4)
    if (get().status === "scanning" || get().scanInFlight) return;
    const seq = ++scanSeq;
    const scanId = novoScanId();
    set({
      status: "scanning",
      overlayOpen: true,
      folderPrefix,
      proposals: [],
      progress: null,
      scanId,
      scannedTotal: 0,
      semPerguntarAoSom: 0,
      semLetraNoFim: [],
      segundosDeTranscricao: 0,
      transcricao,
      transcricaoProgress: null,
      transcricaoDispensada: false,
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
      // V10 — o payload não leva `modo` (DECISIONS #102) nem credencial
      // nenhuma (DECISIONS #110). O backend ignoraria os dois, mas mandá-los
      // manteria vivo no frontend um vocabulário que o produto abandonou — e,
      // no caso da credencial, há guarda no backend contra a volta dela.
      const {
        propostas,
        sem_perguntar_ao_som: semPerguntarAoSom,
        sem_letra_no_fim: semLetraNoFim,
        segundos_de_transcricao: segundosDeTranscricao,
      } = await getBackend().enrichFolderScan(folderPrefix, scanId);
      if (seq !== scanSeq) return; // cancelado durante a busca: descarta
      // quantas candidatas foram efetivamente conferidas (A6); null quando o
      // canal de progresso não respondeu — nunca 0 por omissão (MÉDIO-11)
      const conferidas = get().progress?.total ?? null;
      const emSegundoPlano = !get().overlayOpen;
      // V10 — "não há nada a mostrar" deixou de ser só "zero propostas": com
      // músicas sobrando sem letra existe uma PERGUNTA a fazer, e pergunta não
      // cabe num toast que some em 5 segundos.
      const temPergunta = (semLetraNoFim?.length ?? 0) > 0;
      if (emSegundoPlano && propostas.length === 0 && !temPergunta) {
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
          semLetraNoFim: [],
          segundosDeTranscricao: 0,
        });
        useToastStore
          .getState()
          .push(
            textoSemPropostas(conferidas, semPerguntarAoSom),
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
        semLetraNoFim: semLetraNoFim ?? [],
        segundosDeTranscricao: segundosDeTranscricao ?? 0,
      });
      if (emSegundoPlano && propostas.length > 0) {
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

  startTranscricao: async () => {
    const { semLetraNoFim, status, scanInFlight } = get();
    if (semLetraNoFim.length === 0) return;
    // a etapa 5 leva horas: duas filas ao mesmo tempo disputariam a CPU e
    // embaralhariam as duas barras (mesma disciplina do M4)
    if (status === "scanning" || status === "transcribing" || scanInFlight) return;

    const seq = ++scanSeq;
    const scanId = novoScanId();
    set({
      status: "transcribing",
      overlayOpen: true,
      scanId,
      transcricaoProgress: null,
      scanInFlight: true,
    });

    const listener: { unlisten: (() => void) | null } = { unlisten: null };
    const subscribing = (async () => {
      try {
        const unlisten = await getBackend().onTranscricaoProgresso((p) => {
          if (seq === scanSeq && p.scan_id === scanId) {
            set({ transcricaoProgress: p });
          }
        });
        if (seq === scanSeq) {
          listener.unlisten = unlisten;
        } else {
          unlisten();
        }
      } catch {
        // sem canal de progresso: a janela fica no aviso indeterminado
      }
    })();

    // Aqui a assinatura é esperada ANTES do invoke, ao contrário da varredura.
    // O primeiro evento é o que anuncia o total, e ele sai no instante em que
    // o comando começa: perdê-lo deixaria a janela num aviso indeterminado até
    // a primeira música terminar — que aqui são MINUTOS, não milissegundos. O
    // custo é o de resolver um `listen()`, e a falha já é engolida acima.
    await subscribing;

    try {
      // QA A1 — `razao_medida` vem no contrato e era jogada fora aqui. Ela é o
      // que a DECISIONS #106 chama de "razão real desta máquina"; sem guardá-la
      // não há laço a fechar.
      const { propostas, razao_medida: razaoMedida } =
        await getBackend().transcreverMusicas(semLetraNoFim, scanId);
      if (seq !== scanSeq) return; // cancelado no meio: descarta
      set((s) => ({
        status: "review",
        // `null` = esta fila não mediu nada (só erros, ou cancelada antes da
        // primeira música). Não sobrescreve uma medição anterior, e nunca vira
        // zero: "0 vezes o áudio" anunciaria transcrição instantânea.
        razaoMedida: razaoMedida ?? s.razaoMedida,
        // ACRESCENTA: a varredura pode ter deixado propostas que a pessoa
        // ainda não aplicou, e jogá-las fora seria perder trabalho dela
        proposals: [...s.proposals, ...propostas],
        transcricaoProgress: null,
        scanId: "",
        // a fila foi consumida: a pergunta do fim não se repete
        semLetraNoFim: [],
        segundosDeTranscricao: 0,
      }));
      if (!get().overlayOpen && propostas.length > 0) {
        useToastStore.getState().push(textoEncontrado(propostas.length), "success");
      }
    } catch (e) {
      if (seq !== scanSeq) return;
      // horas de espera que não produziram nada não podem terminar em
      // silêncio: a frase vem pronta do backend, em pt-BR
      useToastStore.getState().push(String(e).replace(/^Error:\s*/, ""), "error");
      set((s) => ({
        status: s.proposals.length > 0 ? "review" : "idle",
        transcricaoProgress: null,
        scanId: "",
      }));
    } finally {
      await subscribing;
      listener.unlisten?.();
      set({ scanInFlight: false });
    }
  },

  dispensarTranscricao: () => set({ transcricaoDispensada: true }),

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
      semLetraNoFim: [],
      segundosDeTranscricao: 0,
      transcricaoProgress: null,
      applyErrors: {},
    });
    // Cancelar de verdade: a guarda de corrida acima só descarta o RESULTADO;
    // sem isto a varredura seguia consultando o LRCLIB até o fim (M4) — e a
    // etapa 5 seguiria queimando CPU por horas, que é o MESMO comando de
    // cancelamento no backend.
    if ((status === "scanning" || status === "transcribing") && scanId) {
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
