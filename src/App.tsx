import { useEffect, useRef } from "react";
import { EnrichReview } from "./components/EnrichReview";
import { LibraryView } from "./components/LibraryView";
import { LyricsPanel } from "./components/LyricsPanel";
import { PlayerBar } from "./components/PlayerBar";
import { PlaylistView } from "./components/PlaylistView";
import { SettingsView } from "./components/SettingsView";
import { Sidebar } from "./components/Sidebar";
import { Toasts } from "./components/Toasts";
import { TopBar } from "./components/TopBar";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { getBackend } from "./lib/api";
import { watchSystemTheme } from "./lib/theme";
import { checkForUpdatesOnStartup, useUpdateStore } from "./lib/updater";
import { useLibraryStore } from "./stores/libraryStore";
import { usePlaylistStore } from "./stores/playlistStore";
import { useUiStore } from "./stores/uiStore";

/**
 * Aviso discreto e NÃO-MODAL de atualização baixada (V7/F16). Fica no canto
 * inferior esquerdo, longe dos toasts, e não some sozinho: o app só reinicia
 * quando a pessoa mandar — pode haver música tocando numa reunião.
 */
function UpdateNotice() {
  const ready = useUpdateStore((s) => s.ready);
  const restarting = useUpdateStore((s) => s.restarting);
  const runRestart = useUpdateStore((s) => s.runRestart);
  const dismiss = useUpdateStore((s) => s.dismiss);

  if (!ready) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-28 left-4 z-50 flex w-96 max-w-[calc(100vw-2rem)] items-start gap-3 rounded-md bg-brand-soft px-4 py-3 text-[14px] text-brand-strong shadow-md ring-1 ring-brand-ring"
    >
      <p className="min-w-0 flex-1">
        Atualização pronta. Reinicie o Cancioneiro para usar a versão nova.
      </p>
      <button
        type="button"
        disabled={restarting}
        className="shrink-0 rounded bg-brand-fill px-3 py-1.5 text-[14px] font-medium text-white hover:bg-brand-fill-hover disabled:opacity-50"
        onClick={() => void runRestart()}
      >
        {restarting ? "Reiniciando…" : "Reiniciar agora"}
      </button>
      <button
        type="button"
        aria-label="Dispensar aviso de atualização"
        className="shrink-0 rounded px-1 text-[16px] leading-none text-brand hover:bg-brand-soft-hover"
        onClick={dismiss}
      >
        ×
      </button>
    </div>
  );
}

function App() {
  useKeyboardShortcuts();
  const view = useUiStore((s) => s.view);
  const lyricsPanelVisible = useUiStore((s) => s.lyricsPanelVisible);
  const startedRef = useRef(false);

  // Inicialização: carrega biblioteca/playlists e roda rescan incremental em
  // background (F1, fluxo 5).
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const { loadLibrary, rescan, setScanning } = useLibraryStore.getState();
    const { loadPlaylists } = usePlaylistStore.getState();

    void (async () => {
      await Promise.all([loadLibrary(), loadPlaylists()]);
      const unlisten = await getBackend().onScanProgress((p) =>
        setScanning({ done: p.done, total: p.total }),
      );
      try {
        await rescan();
      } catch (e) {
        console.error("[app] rescan inicial falhou:", e);
      } finally {
        setScanning(null);
        unlisten();
      }
    })();

    // V7/F16 — a checagem de atualização roda à parte, sem `await` de ninguém:
    // não segura a abertura da janela, o scan nem a busca. Falha em silêncio.
    void checkForUpdatesOnStartup();
  }, []);

  // V15 — em tela estreita os detalhes abrem POR CIMA da lista. Abrir o app
  // assim seria esconder a busca logo na chegada: começam fechados, e o botão
  // "Mostrar detalhes" do topo os traz quando a pessoa quiser.
  useEffect(() => {
    if (window.innerWidth < 1024 && useUiStore.getState().lyricsPanelVisible) {
      useUiStore.getState().toggleLyricsPanel();
    }
  }, []);

  // V11 — só importa para "automático": se o SO mudar de aparência com o
  // app aberto, o tema segue junto sem precisar reabrir (main.tsx só cobre
  // o instante inicial).
  useEffect(() => {
    return watchSystemTheme(() => useUiStore.getState().theme);
  }, []);

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {/* V15 — a barra do topo: tamanho da letra, detalhes e a porta entre
          ouvir e organizar. Substitui o botão flutuante de detalhes, que
          precisava de uma faixa reservada em cada tela para não cobrir nada. */}
      <TopBar />
      {/* `relative`: em tela estreita a lateral e os detalhes viram camadas
          por cima da lista, presas a esta faixa (nunca ao topo nem ao player) */}
      <div className="relative flex min-h-0 flex-1">
        {view !== "settings" && <Sidebar />}
        <main className="relative flex min-w-0 flex-1">
          {view === "settings" ? (
            <SettingsView />
          ) : view === "playlist" ? (
            <PlaylistView />
          ) : (
            <LibraryView />
          )}
        </main>
        {lyricsPanelVisible && view !== "settings" && <LyricsPanel />}
      </div>
      <PlayerBar />
      <EnrichReview />
      <UpdateNotice />
      <Toasts />
    </div>
  );
}

export default App;
