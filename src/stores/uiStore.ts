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
   * V10 — `vagalumeApiKey` SAIU (DECISIONS #110).
   *
   * A etapa do Vagalume foi removida do produto (API descontinuada, chave que
   * o dono do produto nunca conseguiu, código que nunca rodou contra o serviço
   * real), e o `lyrics.ovh` que tomou o lugar dela não pede credencial. Com
   * isso **nenhuma etapa do funil pede nada de quem usa**, e não há mais
   * preferência de credencial a guardar — nem em disco, nem em memória.
   *
   * A chave que existir no `localStorage` de instalações antigas fica lá,
   * inerte: o `persist` do zustand ignora chave que o estado não declara, e
   * apagar preferência alheia não é trabalho desta versão.
   */
  toggleLyricsPanel: () => void;
  cycleFontLevel: () => void;
  setView: (view: View) => void;
  setCheckUpdatesOnStart: (value: boolean) => void;
}

export function createUiStore() {
  return create<UiState>()(
    persist(
      (set) => ({
        lyricsPanelVisible: true,
        fontLevel: 0,
        view: "library" as View,
        checkUpdatesOnStart: true,
        toggleLyricsPanel: () =>
          set((s) => ({ lyricsPanelVisible: !s.lyricsPanelVisible })),
        cycleFontLevel: () =>
          set((s) => ({ fontLevel: ((s.fontLevel + 1) % 3) as FontLevel })),
        setView: (view) => set({ view }),
        setCheckUpdatesOnStart: (value) => set({ checkUpdatesOnStart: value }),
      }),
      {
        name: "cancioneiro-ui",
        partialize: (s) => ({
          lyricsPanelVisible: s.lyricsPanelVisible,
          fontLevel: s.fontLevel,
          checkUpdatesOnStart: s.checkUpdatesOnStart,
        }),
      },
    ),
  );
}

export const useUiStore = createUiStore();
