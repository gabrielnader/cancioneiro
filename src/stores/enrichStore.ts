import { create } from "zustand";
import {
  getBackend,
  type EnrichApplyResult,
  type EnrichProgress,
  type EnrichProposal,
  type TranscricaoProgresso,
} from "../lib/api";
import {
  avisoDeFalhasDeGravacao,
  avisoDeTranscricaoPendente,
  textoSemPropostas,
  type DownloadPendente,
} from "../lib/curadoria";
import type { Song } from "../lib/types";
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
   * QA A1 — a estimativa acima é MEDIÇÃO desta máquina, ou palpite de fábrica?
   *
   * É um FATO sobre o número, e não o número: o backend fechou o laço por
   * dentro (guarda a medição no banco e usa a razão real na varredura
   * seguinte) e expõe um booleano de propósito, para não convidar o TypeScript
   * a multiplicar (DECISIONS #80). Aqui ele decide UMA coisa: se a pergunta do
   * fim pode dizer "neste computador" ou tem de manter a ressalva.
   *
   * A `razao_medida` que a etapa 5 devolve é informativa e **não é guardada**:
   * a v0.10.0 pedia ao frontend que a guardasse e a reenviasse, e o frontend a
   * descartava — a promessa da DECISIONS #106 ficou desligada porque não havia
   * consumidor. Agora não há o que reenviar.
   */
  estimativaMedidaNestaMaquina: boolean;
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
   * V10.6 — as linhas JÁ GRAVADAS nesta revisão, pela POSIÇÃO na lista.
   *
   * Existe porque aplicar deixou de fechar a caixa. Era o fechamento que jogava
   * fora a lista das músicas sem letra, e recuperá-la custava a varredura
   * inteira — o relato de campo que trouxe esta versão. Com a caixa aberta, a
   * lista continua na tela, e a tela precisa dizer o que já aconteceu com cada
   * linha: sem isto ela ofereceria de novo o clique que acabou de acontecer, e
   * o `apply` recusaria a segunda tentativa com "a música mudou depois da
   * busca" — um erro inventado por nós.
   *
   * Por POSIÇÃO, e não por `song_id`, pelo mesmo motivo da seleção: a mesma
   * música pode ter duas linhas (o nome pendente e a letra da etapa 5), e cada
   * uma é uma decisão. Aplicar uma não decide a outra.
   */
  aplicadas: number[];
  /**
   * O que o disco tem AGORA, por música gravada nesta revisão.
   *
   * É o eco fresco: o `apply` recusa uma proposta cujo `current_title` não bate
   * mais com o arquivo (QA A5), e depois de gravar o nome de uma música o eco da
   * OUTRA linha dela ficou velho. Sem isto, aplicar a letra da etapa 5 depois de
   * aplicar o nome falharia com "a música mudou depois da busca" — e a música
   * mudou, sim: mudamos nós, um clique antes.
   *
   * Guarda a `Song` que o backend devolveu, e não campos escolhidos a dedo:
   * `has_lyrics` e `letra_origem` decidem o aviso de substituição de letra, e a
   * próxima coisa que precisar do estado real já vai estar aqui.
   */
  gravadas: Record<number, Song>;
  /**
   * V10.8 — o que o backend teve a CONTAR sobre uma gravação que deu certo, por
   * música: hoje, a etiqueta do MP3 que precisou ser normalizada para o arquivo
   * aceitar a gravação.
   *
   * Fica separado do `applyErrors` porque não é erro: a linha gravou, o áudio foi
   * conferido, e não há nada a refazer. Pôr isto em `applyErrors` desabilitaria e
   * apagaria justamente a linha que deu certo, e o cabeçalho do grupo diria que
   * ela "não pôde ser gravada" — o contrário do que aconteceu (a #139 outra vez).
   *
   * Por `song_id`, e não por posição: o aviso descreve o ARQUIVO, e o arquivo é o
   * mesmo nas duas linhas da mesma música.
   */
  avisosDaGravacao: Record<number, string>;
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
   * A etapa 5. Roda em segundo plano, é cancelável pelo mesmo `close()` e
   * acrescenta as propostas à revisão que já está aberta.
   *
   * Sem argumento, a fila é o `semLetraNoFim` da varredura — a pergunta do fim.
   * Com argumento, é a lista que a porta permanente de Configurações devolveu
   * (V10.6). É o MESMO caminho de propósito: mesma barra, mesmo cancelamento,
   * mesma revisão no fim. Um segundo caminho seria um segundo lugar onde os
   * três podem divergir (a lição do M4).
   */
  startTranscricao: (musicas?: readonly number[]) => Promise<void>;
  /** "Agora não": a pergunta do fim some desta revisão, e não volta sozinha. */
  dispensarTranscricao: () => void;
  /** Esconde o overlay — o trabalho CONTINUA rodando em segundo plano. */
  hideOverlay: () => void;
  /** Reabre o overlay (indicador da sidebar) sem disparar nada. */
  openOverlay: () => void;
  /** Cancela: para o trabalho no backend e/ou descarta as propostas na tela. */
  close: () => void;
  /**
   * Registra o desfecho de um apply: cada linha enviada fica gravada ou fica com
   * o erro que o backend devolveu (A5 — o usuário precisa ver que a sugestão foi
   * recusada, não silenciosamente perdida).
   *
   * **V10.6 — substituiu o `retainFailures`, e a troca é de propósito.** Aquele
   * mantinha na revisão SÓ as linhas que falharam, e isso só fazia sentido
   * enquanto aplicar FECHAVA a caixa: as gravadas saíam da lista porque a lista
   * ia embora de qualquer jeito. Como aplicar não fecha mais, a lista inteira
   * fica — e cada linha carrega o seu desfecho.
   *
   * `linhas` são as POSIÇÕES enviadas neste apply. Uma linha da mesma música que
   * não foi enviada continua sendo uma decisão em aberto.
   */
  registrarAplicacao: (
    linhas: readonly number[],
    resultados: readonly EnrichApplyResult[],
  ) => void;
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
  estimativaMedidaNestaMaquina: false,
  transcricao: SEM_TRANSCRICAO,
  transcricaoProgress: null,
  transcricaoDispensada: false,
  applyErrors: {},
  aplicadas: [],
  gravadas: {},
  avisosDaGravacao: {},
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
      // o fato acompanha a estimativa: sem número, não há o que qualificar
      estimativaMedidaNestaMaquina: false,
      transcricao,
      transcricaoProgress: null,
      transcricaoDispensada: false,
      applyErrors: {},
      aplicadas: [],
      gravadas: {},
      avisosDaGravacao: {},
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
        estimativa_medida_nesta_maquina: estimativaMedida,
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
          estimativaMedidaNestaMaquina: estimativaMedida ?? false,
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
        estimativaMedidaNestaMaquina: estimativaMedida ?? false,
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

  startTranscricao: async (musicas) => {
    const { semLetraNoFim, status, scanInFlight } = get();
    // V10.6 — a fila vem de Configurações quando ela é passada, e da pergunta
    // do fim quando não é. O resto do caminho é UM só.
    const fila = musicas ?? semLetraNoFim;
    if (fila.length === 0) return;
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
      // QA A1 — `razao_medida` e `razao_desta_maquina` vêm no retorno e são
      // INFORMATIVAS. Quem guarda a medição é o backend, e quem diz à tela o
      // que ela pode afirmar é o booleano da PRÓXIMA varredura: guardar aqui
      // seria uma segunda cópia de um estado que já tem dono (DECISIONS #80).
      const { propostas } = await getBackend().transcreverMusicas(
        [...fila],
        scanId,
      );
      if (seq !== scanSeq) return; // cancelado no meio: descarta
      set((s) => ({
        status: "review",
        // ACRESCENTA: a varredura pode ter deixado propostas que a pessoa
        // ainda não aplicou, e jogá-las fora seria perder trabalho dela
        proposals: [...s.proposals, ...propostas],
        transcricaoProgress: null,
        scanId: "",
        // a fila foi consumida: a pergunta do fim não se repete
        semLetraNoFim: [],
        segundosDeTranscricao: 0,
        estimativaMedidaNestaMaquina: false,
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
    const anterior = get();
    const { status, scanId } = anterior;
    /*
      V10.6 — fechar a revisão com a oferta de transcrição na tela AVISA, em vez
      de descartá-la em silêncio.

      Avisar sobre uma oferta que a pessoa não viu, ou que ela já respondeu com
      "agora não", seria ruído — e ruído numa tela sem suporte é dúvida. Daí
      exigir revisão aberta, gente sobrando e pergunta não dispensada.

      A condição NÃO é idêntica à que desenha a oferta: a tela também a desenha
      sem os acessórios, com o texto do download, e aqui isso não avisa. É de
      propósito, e não um esquecimento — a revisão é aberta DE DENTRO de
      Configurações, então fechá-la já devolve a pessoa à tela dos cartões de
      acessório. O aviso apontaria para onde ela está olhando.

      É INFORMATIVO, e não uma confirmação. Com o bloco permanente de
      Configurações a lista já não se perde: uma caixa perguntando "tem certeza?"
      cobraria uma decisão por um prejuízo que deixou de existir, e pop-up que se
      aprende a fechar sem ler é pop-up que não avisa mais nada.

      Cancelar uma varredura ou uma transcrição EM CURSO não passa por aqui: não
      há oferta ainda, e a frase falaria de uma lista que nem terminou de ser
      montada.
    */
    /*
      V10.9 — E FECHAR COM LINHAS QUE FALHARAM AO GRAVAR TAMBÉM AVISA.

      Relato de campo, verbatim: *"não sei quais são as duas outras músicas… pq
      fechei a tela em seguida"*. É a mesma família do defeito acima — a lista
      de que a pessoa precisa para agir depois evapora ao fechar a caixa —, e é
      PIOR: a oferta de transcrição continua inteira no bloco permanente de
      Configurações, e a lista das que não gravaram não continua em lugar
      nenhum. Nada aqui a guarda entre sessões; guardá-la é outra decisão, e o
      escopo desta é avisar.

      É `applyErrors`, e não `p.error`: falha de CONSULTA não é notícia nova
      nesta tela (não havia proposta, e repetir o clique não muda nada — a
      #140), enquanto a falha de GRAVAÇÃO é consequência direta do clique que a
      pessoa acabou de dar.

      DOIS AVISOS NUMA TELA SÓ, NÃO. As duas condições valem juntas no caso mais
      comum de todos: a varredura trouxe propostas, a pessoa aplicou, algumas
      recusaram, e ainda sobraram músicas sem letra. Empilhar dois toasts é
      ensinar a fechar toast sem ler, que é o mesmo argumento pelo qual a #137
      recusou a confirmação bloqueante. Juntar as duas frases numa só estouraria
      a régua da #100 e misturaria dois assuntos que a pessoa resolve em lugares
      diferentes.

      A FALHA VENCE, e por um critério só: ela é a única informação que some de
      verdade.
    */
    const naoGravadas = Object.keys(anterior.applyErrors).length;
    const avisoDeFalhas =
      status === "review" ? avisoDeFalhasDeGravacao(naoGravadas) : null;
    if (avisoDeFalhas !== null) {
      // "warning" pelo mesmo motivo do aviso de baixo: é um aviso, do mesmo
      // peso do da etapa 2 que parou no meio, e não um quarto tom de toast.
      useToastStore.getState().push(avisoDeFalhas, "warning");
    } else if (
      status === "review" &&
      anterior.transcricao.disponivel &&
      !anterior.transcricaoDispensada
    ) {
      const aviso = avisoDeTranscricaoPendente(anterior.semLetraNoFim.length);
      // "warning" e não um tom novo: é um aviso, do mesmo peso do da etapa 2
      // que parou no meio (`avisoSemPerguntarAoSom`).
      if (aviso !== null) useToastStore.getState().push(aviso, "warning");
    }
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
      // o fato acompanha a estimativa: sem número, não há o que qualificar
      estimativaMedidaNestaMaquina: false,
      transcricaoProgress: null,
      applyErrors: {},
      aplicadas: [],
      gravadas: {},
      avisosDaGravacao: {},
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

  registrarAplicacao: (linhas, resultados) => {
    const gravadasAgora: Record<number, Song> = {};
    const avisosAgora: Record<number, string> = {};
    set((s) => {
      // O mapa de erros é ATUALIZADO, não substituído: um erro de linha que não
      // foi retentada nesta rodada continua descrevendo o que aconteceu com
      // ela. Substituir apagaria a única informação de que aquela sugestão foi
      // recusada (DECISIONS #47).
      const applyErrors = { ...s.applyErrors };
      for (const r of resultados) {
        if (r.song !== null) {
          gravadasAgora[r.song_id] = r.song;
          // V10.8 — o desfecho DIZ o que foi feito: a frase do backend chega
          // pronta e é guardada como veio, para a linha a mostrar
          if (r.aviso !== null) avisosAgora[r.song_id] = r.aviso;
          // gravou depois de falhar: o erro descrevia a tentativa anterior
          delete applyErrors[r.song_id];
        } else {
          applyErrors[r.song_id] = r.error ?? "não foi possível gravar";
        }
      }
      const novas = linhas.filter((i) => {
        const p = s.proposals[i];
        return p !== undefined && gravadasAgora[p.song_id] !== undefined;
      });
      return {
        status: "review",
        overlayOpen: true,
        // A LISTA INTEIRA FICA. Aplicar não fecha mais a caixa, e era o
        // fechamento que jogava fora a oferta de transcrição.
        aplicadas: [...s.aplicadas, ...novas],
        gravadas: { ...s.gravadas, ...gravadasAgora },
        // ACUMULA, como o mapa de erros: um aviso de uma gravação anterior
        // continua descrevendo o que aconteceu com aquele arquivo, e a linha
        // dele continua na tela (aplicar não fecha mais a caixa)
        avisosDaGravacao: { ...s.avisosDaGravacao, ...avisosAgora },
        applyErrors,
      };
    });
  },
}));
