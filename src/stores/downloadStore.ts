import { create } from "zustand";
import { getBackend, type AcessorioInfo, type AcessorioProgresso } from "../lib/api";
import { ACESSORIO_CANCELADO } from "../lib/curadoria";
import { novoScanId } from "./enrichStore";

/**
 * V10.4 — O DOWNLOAD DE ACESSÓRIO, FORA DA TELA QUE O PEDIU.
 *
 * O relato de campo da v0.10.1, verbatim: *"coloquei pra baixar o modelo novo
 * e sai da pagina. o download parou e tive que começar de novo."* São 1,5 GB
 * perdidos por trocar de aba — e, pior, perdidos EM SILÊNCIO: a pessoa volta e
 * o download simplesmente não está lá.
 *
 * **O que realmente morria.** O invoke não. `acessorio_baixar` é
 * `#[tauri::command(async)]`: ele roda no backend e não sabe que alguém
 * navegou. O que morria era tudo o que a pessoa podia ver dele — o `useState`
 * do progresso, a assinatura de `acessorio:progresso` e o lugar onde o
 * desfecho ia aparecer viviam dentro de `CartaoDoAcessorio`, e o `App.tsx`
 * DESMONTA a tela de Configurações ao trocar de view. Voltar recriava o
 * componente do zero: barra nenhuma, mensagem nenhuma, e o botão "Baixar" de
 * volta como se nada estivesse acontecendo.
 *
 * Esse botão era a parte perigosa. Clicar nele disparava um SEGUNDO download
 * do mesmo acessório, escrevendo o MESMO `.parcial` do primeiro — e o primeiro
 * a terminar troca o arquivo de nome por baixo do outro. É o caminho mais
 * provável do "não foi possível salvar nesse computador" que apareceu aos 85%
 * no mesmo relato.
 *
 * **Por que uma store, e não um `useRef` mais esperto.** O trabalho é do
 * APLICATIVO, não da tela — exatamente como a varredura e a transcrição, que
 * moram no `enrichStore` pelo mesmo motivo (o PRD V9 promete segundo plano
 * "sem travar busca nem reprodução"). Uma store é o único lugar onde o estado
 * sobrevive à desmontagem sem depender de a tela ficar aberta.
 *
 * As duas regras que o QA M4 comprou caro, e que continuam valendo aqui:
 * **um download por acessório** (o `download_id` já existia; faltava alguém
 * recusar o segundo) e **evento com id alheio é descartado** (o download
 * abandonado continua vivo no backend e continua emitindo).
 */

/** O progresso de UM download vivo. */
export interface ProgressoDoDownload {
  /** Identidade do download em curso — é ela que filtra os eventos (M4). */
  downloadId: string;
  baixados: number;
  /** `null` = o servidor não anunciou o tamanho (DECISIONS #86). */
  total: number | null;
  /** Pela velocidade MEDIDA; `null` enquanto a amostra é curta. */
  segundosRestantes: number | null;
}

interface DownloadState {
  /** Downloads vivos, por nome de acessório. */
  emCurso: Record<string, ProgressoDoDownload>;
  /**
   * O desfecho do último download de cada acessório — cancelamento ou a frase
   * que o backend mandou pronta.
   *
   * Ela mora aqui, e não na tela, porque a falha pode acontecer com a pessoa
   * na biblioteca: quando ela voltar a Configurações, a frase tem de estar
   * esperando. "Voltei e não tinha nada" foi como o defeito foi descrito.
   */
  mensagens: Record<string, string>;
  /**
   * O estado que o próprio download devolveu, por acessório. A lista de
   * Configurações é remontada a cada visita e relida do backend; isto é o que
   * a atualiza quando o download termina com a tela ABERTA.
   */
  resultados: Record<string, AcessorioInfo>;

  /**
   * A assinatura de `acessorio:progresso` é UMA para o aplicativo inteiro, e
   * ela mora no estado — não numa variável do módulo — para `setState` do
   * estado inicial ser um reset de VERDADE (uma variável de módulo sobrevive
   * ao reset, e aí o teste seguinte herda uma assinatura que não existe mais).
   *
   * Antes era uma assinatura por clique, solta no `finally` do próprio
   * download — e sair da tela no meio fazia aquele `finally` nunca rodar:
   * cada visita a Configurações somava um ouvinte que nunca saía. Esta nasce
   * com o primeiro download vivo e some com o último.
   */
  soltarAssinatura: (() => void) | null;
  /** Assinatura em voo, para dois downloads simultâneos não abrirem duas. */
  assinando: Promise<void> | null;

  /** Baixa o acessório. Chamada repetida com um download vivo é ignorada. */
  baixar: (nome: string) => Promise<void>;
  /** Pede o cancelamento do download vivo deste acessório. */
  parar: (nome: string) => void;
}

/** Estado zerado — exportado para os testes partirem sempre do mesmo lugar. */
export function estadoInicialDosDownloads(): Pick<
  DownloadState,
  "emCurso" | "mensagens" | "resultados" | "soltarAssinatura" | "assinando"
> {
  return {
    emCurso: {},
    mensagens: {},
    resultados: {},
    soltarAssinatura: null,
    assinando: null,
  };
}

async function garantirAssinatura(): Promise<void> {
  const { soltarAssinatura, assinando } = useDownloadStore.getState();
  if (soltarAssinatura) return;
  if (assinando) return assinando;
  const emVoo = (async () => {
    try {
      const soltar = await getBackend().onAcessorioProgresso(aoProgresso);
      useDownloadStore.setState({ soltarAssinatura: soltar });
    } catch {
      // Sem canal de progresso o download CONTINUA: só não há barra. A
      // assinatura é conveniência, e conveniência não cancela 1,5 GB.
    } finally {
      useDownloadStore.setState({ assinando: null });
    }
  })();
  useDownloadStore.setState({ assinando: emVoo });
  await emVoo;
}

function talvezSoltarAssinatura(): void {
  const { emCurso, soltarAssinatura } = useDownloadStore.getState();
  if (Object.keys(emCurso).length > 0) return;
  soltarAssinatura?.();
  useDownloadStore.setState({ soltarAssinatura: null });
}

/**
 * Um evento de progresso. Ele só vale para o download que está vivo NAQUELE
 * acessório e com AQUELE id — o download abandonado continua no backend e
 * continua emitindo, e pintar a barra nova com o progresso dele é o defeito
 * que o `scan_id` resolveu no funil (QA M4).
 */
function aoProgresso(p: AcessorioProgresso): void {
  const atual = useDownloadStore.getState().emCurso[p.nome];
  if (!atual || atual.downloadId !== p.download_id) return;
  useDownloadStore.setState((s) => ({
    emCurso: {
      ...s.emCurso,
      [p.nome]: {
        downloadId: atual.downloadId,
        baixados: p.baixados,
        total: p.total,
        segundosRestantes: p.segundos_restantes,
      },
    },
  }));
}

/** Tira a entrada de `nome` do mapa, devolvendo um mapa novo. */
function sem<T>(mapa: Record<string, T>, nome: string): Record<string, T> {
  const { [nome]: _fora, ...resto } = mapa;
  return resto;
}

export const useDownloadStore = create<DownloadState>((set, get) => ({
  ...estadoInicialDosDownloads(),

  baixar: async (nome) => {
    // A recusa é SÍNCRONA e vem antes de qualquer `await`: entre o clique e a
    // primeira volta do laço de eventos cabe um segundo clique, e é ele que
    // faria dois downloads escreverem o mesmo `.parcial`.
    if (get().emCurso[nome]) return;
    const downloadId = novoScanId();
    set((s) => ({
      // o total só aparece quando o servidor o anunciar: começar em 0 de 0
      // desenharia uma barra cheia de um arquivo vazio (DECISIONS #86)
      emCurso: {
        ...s.emCurso,
        [nome]: { downloadId, baixados: 0, total: null, segundosRestantes: null },
      },
      // o desfecho do download ANTERIOR não descreve este
      mensagens: sem(s.mensagens, nome),
    }));

    await garantirAssinatura();
    try {
      const desfecho = await getBackend().acessorioBaixar(nome, downloadId);
      set((s) => ({
        // `cancelado` é campo, não dedução: cancelar e falhar terminam os dois
        // com o acessório ausente, e a tela precisa dizer qual dos dois foi
        mensagens: desfecho.cancelado
          ? { ...s.mensagens, [nome]: ACESSORIO_CANCELADO }
          : sem(s.mensagens, nome),
        resultados: { ...s.resultados, [nome]: desfecho.acessorio },
      }));
    } catch (e) {
      // a frase já vem em pt-BR e explicando o que aconteceu com o arquivo
      set((s) => ({
        mensagens: { ...s.mensagens, [nome]: String(e).replace(/^Error:\s*/, "") },
      }));
    } finally {
      set((s) => ({ emCurso: sem(s.emCurso, nome) }));
      talvezSoltarAssinatura();
    }
  },

  parar: (nome) => {
    const atual = get().emCurso[nome];
    if (!atual) return;
    void getBackend().acessorioCancelar(atual.downloadId);
  },
}));
