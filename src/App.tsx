import { useEffect, useRef } from "react";
import { EnrichReview } from "./components/EnrichReview";
import { LibraryView } from "./components/LibraryView";
import { LyricsPanel } from "./components/LyricsPanel";
import { PlayerBar } from "./components/PlayerBar";
import { PlaylistView } from "./components/PlaylistView";
import { SettingsView } from "./components/SettingsView";
import { Sidebar } from "./components/Sidebar";
import { Toasts } from "./components/Toasts";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { getBackend } from "./lib/api";
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
      className="fixed bottom-20 left-4 z-50 flex w-96 max-w-[calc(100vw-2rem)] items-start gap-3 rounded-md bg-[#F0FDFA] px-4 py-3 text-[14px] text-[#115E59] shadow-md ring-1 ring-[#99F6E4]"
    >
      <p className="min-w-0 flex-1">
        Atualização pronta. Reinicie o Cancioneiro para usar a versão nova.
      </p>
      <button
        type="button"
        disabled={restarting}
        className="shrink-0 rounded bg-[#0F766E] px-3 py-1.5 text-[14px] font-medium text-white hover:bg-[#0D5F58] disabled:opacity-50"
        onClick={() => void runRestart()}
      >
        {restarting ? "Reiniciando…" : "Reiniciar agora"}
      </button>
      <button
        type="button"
        aria-label="Dispensar aviso de atualização"
        className="shrink-0 rounded px-1 text-[16px] leading-none text-[#0F766E] hover:bg-[#CCFBF1]"
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

    // V7/F16 — a checagem de atualização roda à parte, sem `await` de ninguém:
    // não segura a abertura da janela, o scan nem a busca. Falha em silêncio.
    void checkForUpdatesOnStartup();
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
          {/*
            Flutuante porque precisa existir em TODAS as views (decisão 25):
            escondido o painel, é o único caminho de volta. Mas as medidas
            têm de casar com a linha da busca da LibraryView — antes ficava
            4px acima e mais baixo que o campo, e o espaço reservado lá
            (pr-*) era menor que a largura do texto "Ocultar detalhes", então
            o botão montava em cima do campo. top-4/right-4 alinham com o
            p-4 do cabeçalho e py-2/text-[15px] igualam a altura do input; o
            E2E mede as duas caixas e falha se voltarem a se sobrepor.
          */}
          <button
            type="button"
            data-testid="toggle-detalhes"
            className="absolute right-4 top-4 z-10 whitespace-nowrap rounded-md bg-white/90 px-3 py-2 text-[15px] font-medium text-[#0F766E] shadow-sm ring-1 ring-[#E5E7EB] hover:bg-[#F0FDFA]"
            onClick={toggleLyricsPanel}
          >
            {/* o painel virou ficha completa (título, artista, temas, letra,
                edição) — a copy fala em "detalhes" (V5 Q4) */}
            {lyricsPanelVisible ? "Ocultar detalhes" : "Mostrar detalhes"}
          </button>
        </main>
        {lyricsPanelVisible && <LyricsPanel />}
      </div>
      <PlayerBar />
      <EnrichReview />
      <UpdateNotice />
      <Toasts />
    </div>
  );
}

export default App;
