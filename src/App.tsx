import { useEffect, useRef } from "react";
import { LibraryView } from "./components/LibraryView";
import { LyricsPanel } from "./components/LyricsPanel";
import { PlayerBar } from "./components/PlayerBar";
import { PlaylistView } from "./components/PlaylistView";
import { SettingsView } from "./components/SettingsView";
import { Sidebar } from "./components/Sidebar";
import { Toasts } from "./components/Toasts";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { getBackend } from "./lib/api";
import { useLibraryStore } from "./stores/libraryStore";
import { usePlaylistStore } from "./stores/playlistStore";
import { useUiStore } from "./stores/uiStore";

function App() {
  useKeyboardShortcuts();
  const view = useUiStore((s) => s.view);
  const lyricsPanelVisible = useUiStore((s) => s.lyricsPanelVisible);
  const toggleLyricsPanel = useUiStore((s) => s.toggleLyricsPanel);
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
  }, []);

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="relative flex min-w-0 flex-1">
          {view === "settings" ? (
            <SettingsView />
          ) : view === "playlist" ? (
            <PlaylistView />
          ) : (
            <LibraryView />
          )}
          <button
            type="button"
            className="absolute right-3 top-3 z-10 rounded-md bg-white/90 px-3 py-1.5 text-[14px] font-medium text-[#0F766E] shadow-sm ring-1 ring-[#E5E7EB] hover:bg-[#F0FDFA]"
            onClick={toggleLyricsPanel}
          >
            {lyricsPanelVisible ? "Ocultar letra" : "Mostrar letra"}
          </button>
        </main>
        {lyricsPanelVisible && <LyricsPanel />}
      </div>
      <PlayerBar />
      <Toasts />
    </div>
  );
}

export default App;
