import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Níveis de fonte da letra (F3): 16/20/24px. */
export const FONT_SIZES_PX = [16, 20, 24] as const;

export type FontLevel = 0 | 1 | 2;

/** Tela ativa na coluna central. 'playlist' usa playlistStore.activePlaylistId. */
export type View = "library" | "settings" | "playlist";

interface UiState {
  lyricsPanelVisible: boolean;
  fontLevel: FontLevel;
  view: View;
  /**
   * V7/F16 — "Verificar atualizações ao abrir". Ligado por padrão; desligado,
   * nenhuma chamada de rede acontece na abertura (rede isolada).
   */
  checkUpdatesOnStart: boolean;
  /**
   * V8/F18 — chave gratuita e PESSOAL do Vagalume, digitada por quem usa.
   * Fica junto das outras preferências (localStorage) porque é isso que ela
   * é: uma preferência de uma conta gratuita da própria pessoa, num app sem
   * telemetria e sem servidor. Vazia = a etapa do Vagalume é pulada em
   * silêncio. Nunca é impressa em log.
   */
  vagalumeApiKey: string;
  toggleLyricsPanel: () => void;
  cycleFontLevel: () => void;
  setView: (view: View) => void;
  setCheckUpdatesOnStart: (value: boolean) => void;
  setVagalumeApiKey: (value: string) => void;
}

export function createUiStore() {
  return create<UiState>()(
    persist(
      (set) => ({
        lyricsPanelVisible: true,
        fontLevel: 0,
        view: "library" as View,
        checkUpdatesOnStart: true,
        vagalumeApiKey: "",
        toggleLyricsPanel: () =>
          set((s) => ({ lyricsPanelVisible: !s.lyricsPanelVisible })),
        cycleFontLevel: () =>
          set((s) => ({ fontLevel: ((s.fontLevel + 1) % 3) as FontLevel })),
        setView: (view) => set({ view }),
        setCheckUpdatesOnStart: (value) => set({ checkUpdatesOnStart: value }),
        // colar de um site costuma trazer espaço/quebra de linha junto, e a
        // chave iria assim para a URL da consulta
        setVagalumeApiKey: (value) => set({ vagalumeApiKey: value.trim() }),
      }),
      {
        name: "cancioneiro-ui",
        partialize: (s) => ({
          lyricsPanelVisible: s.lyricsPanelVisible,
          fontLevel: s.fontLevel,
          checkUpdatesOnStart: s.checkUpdatesOnStart,
          vagalumeApiKey: s.vagalumeApiKey,
        }),
      },
    ),
  );
}

export const useUiStore = createUiStore();
