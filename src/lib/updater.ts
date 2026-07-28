import { create } from "zustand";
import { isTauri } from "./api";
import { useUiStore } from "../stores/uiStore";

/**
 * V7/F16 — atualização automática.
 *
 * Regra central: o caminho SILENCIOSO é o comum. Sem rede, DNS falhando,
 * GitHub fora do ar, manifesto inválido, assinatura recusada ou simplesmente
 * nenhuma versão nova → nada acontece, nada aparece. Qualquer erro visível
 * nesse caminho é bug.
 *
 * Regra número dois: o app NUNCA reinicia sozinho — a coordenadora pode estar
 * com uma música tocando numa reunião. Por isso a atualização é apenas BAIXADA
 * em segundo plano; `install()` (que no Windows encerra o processo para rodar o
 * instalador) só roda quando a pessoa clica em "Reiniciar agora".
 */

/** Atualização já anunciada pelo manifesto, ainda não baixada. */
export interface PendingUpdate {
  version: string;
  /** Baixa o pacote e valida a assinatura. Não instala nada. */
  download: () => Promise<void>;
  /**
   * Aplica o pacote baixado. No Windows isto encerra o app e entrega ao
   * instalador (a promise nunca resolve) — só chamar a pedido da pessoa.
   */
  install: () => Promise<void>;
}

/** Tudo que o fluxo toca no mundo externo, injetável para teste. */
export interface UpdaterDeps {
  /** Preferência "Verificar atualizações ao abrir". Falso = zero rede. */
  enabled: boolean;
  check: () => Promise<PendingUpdate | null>;
  relaunch: () => Promise<void>;
  /** Exibe o aviso discreto; recebe a ação do botão "Reiniciar agora". */
  onReady: (restart: () => Promise<void>) => void;
}

/** Erro engolido: só log de desenvolvimento, jamais UI. */
function silent(stage: string, e: unknown): void {
  if (import.meta.env?.DEV) {
    console.debug(`[updater] ${stage} (silencioso):`, e);
  }
}

/**
 * Fluxo completo da checagem. Nunca rejeita: toda falha vira silêncio.
 * Nunca bloqueia nada — quem chama não espera por ela.
 */
export async function runUpdateCheck(deps: UpdaterDeps): Promise<void> {
  // desligado em Configurações: nenhuma chamada de rede acontece
  if (!deps.enabled) return;

  let update: PendingUpdate | null;
  try {
    update = await deps.check();
  } catch (e) {
    silent("checagem falhou", e);
    return;
  }
  // sem versão nova é o caso mais comum: nada a fazer, nada a dizer
  if (!update) return;

  try {
    await update.download();
  } catch (e) {
    // falha no meio do download: silêncio também; tenta de novo na próxima
    // abertura (PRD V7, item 4)
    silent("download falhou", e);
    return;
  }

  const ready = update;
  deps.onReady(async () => {
    try {
      await ready.install();
      // no Windows a linha abaixo é inalcançável (o install já encerrou o
      // processo); no macOS/Linux é ela que reabre o app já atualizado
      await deps.relaunch();
    } catch (e) {
      // o aviso continua na tela para a pessoa tentar de novo
      silent("reinício falhou", e);
    }
  });
}

// ---------------------------------------------------------------------------
// Aviso discreto (não-modal)
// ---------------------------------------------------------------------------

/**
 * O toastStore some sozinho em 5s e não carrega ação clicável — o aviso de
 * atualização precisa ficar até a pessoa decidir. Daí este estado próprio,
 * renderizado como uma faixa discreta pelo App.
 */
interface UpdateNoticeState {
  /** Atualização baixada e esperando o "Reiniciar agora". */
  ready: boolean;
  /** Reinício em andamento (evita clique duplo). */
  restarting: boolean;
  restart: (() => Promise<void>) | null;
  show: (restart: () => Promise<void>) => void;
  dismiss: () => void;
  runRestart: () => Promise<void>;
}

export const useUpdateStore = create<UpdateNoticeState>()((set, get) => ({
  ready: false,
  restarting: false,
  restart: null,
  show: (restart) => set({ ready: true, restarting: false, restart }),
  dismiss: () => set({ ready: false, restarting: false, restart: null }),
  runRestart: async () => {
    const { restart, restarting } = get();
    if (!restart || restarting) return;
    set({ restarting: true });
    try {
      await restart();
    } finally {
      set({ restarting: false });
    }
  },
}));

// ---------------------------------------------------------------------------
// Ligação com os plugins Tauri (import dinâmico: fora do Tauri nem carrega)
// ---------------------------------------------------------------------------

export function tauriUpdaterDeps(enabled: boolean): UpdaterDeps {
  return {
    enabled,
    async check() {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (!update) return null;
      return {
        version: update.version,
        download: () => update.download(),
        install: () => update.install(),
      };
    },
    async relaunch() {
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    },
    onReady: (restart) => useUpdateStore.getState().show(restart),
  };
}

/**
 * Ponto de entrada do App, chamado DEPOIS que a janela abre. Inerte no modo
 * web (dev no navegador / E2E): sem Tauri não há plugin nem rede.
 */
export async function checkForUpdatesOnStartup(): Promise<void> {
  if (!isTauri()) return;
  const enabled = useUiStore.getState().checkUpdatesOnStart;
  await runUpdateCheck(tauriUpdaterDeps(enabled));
}

/**
 * Versão instalada, lida do próprio app (nunca uma constante no código, que
 * envelhece calada). `null` fora do Tauri — a UI simplesmente não a mostra.
 */
export async function getAppVersion(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    return await getVersion();
  } catch (e) {
    silent("versão indisponível", e);
    return null;
  }
}
