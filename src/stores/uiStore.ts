import { create } from "zustand";
import { persist } from "zustand/middleware";
import { applyTheme, type ThemePref } from "../lib/theme";

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
   * V11 — tema claro/escuro, pedido pelos beta testers. Guardado no MESMO
   * lugar das outras preferências (este store, mesma chave de localStorage):
   * não havia motivo para inventar um segundo depósito só para isto.
   * Padrão "auto" (segue o sistema) — ninguém pediu para o app decidir por
   * ela sem perguntar ao SO primeiro.
   */
  theme: ThemePref;
  /**
   * V12 — pastas ABERTAS da árvore lateral (relato de campo: acervo de ~8.000
   * músicas, subpastas todas abertas ao mesmo tempo). Guarda só o que foi
   * ABERTO NA MÃO, por caminho de pasta; o padrão é fechado, e quem contém a
   * seleção atual abre sozinha (calculado no `Sidebar`, sem entrar aqui — não
   * é preciso persistir o que já é derivável do filtro ativo). Mesmo store e
   * mesma chave das outras preferências.
   */
  openFolders: string[];
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
  setTheme: (theme: ThemePref) => void;
  toggleFolder: (path: string) => void;
}

export function createUiStore() {
  return create<UiState>()(
    persist(
      (set) => ({
        lyricsPanelVisible: true,
        fontLevel: 0,
        view: "library" as View,
        checkUpdatesOnStart: true,
        theme: "auto",
        openFolders: [],
        toggleLyricsPanel: () =>
          set((s) => ({ lyricsPanelVisible: !s.lyricsPanelVisible })),
        cycleFontLevel: () =>
          set((s) => ({ fontLevel: ((s.fontLevel + 1) % 3) as FontLevel })),
        setView: (view) => set({ view }),
        setCheckUpdatesOnStart: (value) => set({ checkUpdatesOnStart: value }),
        setTheme: (theme) => {
          set({ theme });
          applyTheme(theme);
        },
        toggleFolder: (path) =>
          set((s) => ({
            openFolders: s.openFolders.includes(path)
              ? s.openFolders.filter((p) => p !== path)
              : [...s.openFolders, path],
          })),
      }),
      {
        name: "cancioneiro-ui",
        partialize: (s) => ({
          lyricsPanelVisible: s.lyricsPanelVisible,
          fontLevel: s.fontLevel,
          checkUpdatesOnStart: s.checkUpdatesOnStart,
          theme: s.theme,
          openFolders: s.openFolders,
        }),
        // V11 — reaplica o tema já resolvido assim que o `persist` termina de
        // ler o localStorage (troca de aba, ou qualquer hidratação tardia).
        // O `main.tsx` já aplicou uma vez de forma síncrona antes do render
        // (evita a piscada); isto cobre o caso raro de a hidratação mudar o
        // valor depois disso.
        onRehydrateStorage: () => (state) => {
          if (state) applyTheme(state.theme);
        },
      },
    ),
  );
}

export const useUiStore = createUiStore();
