import { useState } from "react";
import { usePlaylistStore } from "../stores/playlistStore";
import { useUiStore } from "../stores/uiStore";
import { NewPlaylistDialog } from "./NewPlaylistDialog";

/** Sidebar esquerda 240px: navegação + playlists (F5). */
export function Sidebar() {
  const view = useUiStore((s) => s.view);
  const setView = useUiStore((s) => s.setView);
  const playlists = usePlaylistStore((s) => s.playlists);
  const activePlaylistId = usePlaylistStore((s) => s.activePlaylistId);
  const openPlaylist = usePlaylistStore((s) => s.openPlaylist);
  const closePlaylist = usePlaylistStore((s) => s.closePlaylist);
  const addToPlaylist = usePlaylistStore((s) => s.addToPlaylist);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dragOverId, setDragOverId] = useState<number | null>(null);

  function navClass(active: boolean) {
    return `block w-full rounded-md px-3 py-2 text-left text-[15px] ${
      active
        ? "bg-[#F0FDFA] font-medium text-[#0F766E]"
        : "text-[#111827] hover:bg-[#F3F4F6]"
    }`;
  }

  return (
    <nav className="flex h-full w-60 shrink-0 flex-col border-r border-[#E5E7EB] bg-white p-3">
      <p className="px-3 pb-2 pt-1 text-[17px] font-semibold text-[#0F766E]">
        Cancioneiro
      </p>
      <button
        type="button"
        className={navClass(view === "library")}
        onClick={() => {
          closePlaylist();
          setView("library");
        }}
      >
        Biblioteca
      </button>
      <button
        type="button"
        className={navClass(view === "settings")}
        onClick={() => {
          closePlaylist();
          setView("settings");
        }}
      >
        Configurações
      </button>

      <p className="mt-5 px-3 text-[12px] font-medium uppercase text-[#6B7280]">
        PLAYLISTS
      </p>
      <div className="mt-1 flex-1 overflow-y-auto">
        {playlists.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`${navClass(view === "playlist" && activePlaylistId === p.id)} ${
              dragOverId === p.id ? "ring-2 ring-[#0F766E]" : ""
            }`}
            onClick={() => {
              void openPlaylist(p.id);
              setView("playlist");
            }}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes("application/x-cancioneiro-song")) {
                e.preventDefault();
                setDragOverId(p.id);
              }
            }}
            onDragLeave={() => setDragOverId(null)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOverId(null);
              const songId = Number(
                e.dataTransfer.getData("application/x-cancioneiro-song"),
              );
              if (Number.isFinite(songId) && songId > 0) {
                void addToPlaylist(p.id, songId);
              }
            }}
          >
            <span className="flex items-center justify-between gap-2">
              <span className="truncate">{p.name}</span>
              <span className="shrink-0 text-[12px] text-[#9CA3AF]">
                {p.song_count}
              </span>
            </span>
          </button>
        ))}
      </div>
      <button
        type="button"
        className="mt-2 rounded-md px-3 py-2 text-left text-[15px] font-medium text-[#0F766E] hover:bg-[#F0FDFA]"
        onClick={() => setDialogOpen(true)}
      >
        Nova playlist
      </button>

      <NewPlaylistDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </nav>
  );
}
