import { useMemo, useState } from "react";
import { buildFolderTree, type FolderNode } from "../lib/folderTree";
import { useEnrichStore } from "../stores/enrichStore";
import { useLibraryStore } from "../stores/libraryStore";
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
  const folders = useLibraryStore((s) => s.folders);
  const allSongs = useLibraryStore((s) => s.allSongs);
  const setFolderFilter = useLibraryStore((s) => s.setFolderFilter);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dragOverId, setDragOverId] = useState<number | null>(null);

  // Árvore de pastas do acervo (V4 — F11), derivada dos file_path.
  const folderTree = useMemo(
    () => buildFolderTree(allSongs, folders),
    [allSongs, folders],
  );

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
          setFolderFilter(null);
          setView("library");
        }}
      >
        Biblioteca
      </button>
      {folderTree.length > 0 && (
        <div className="max-h-64 shrink-0 overflow-y-auto">
          {folderTree.map((node) => (
            <FolderTreeItem key={node.path} node={node} level={0} />
          ))}
        </div>
      )}
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

      <EnrichBackgroundIndicator />

      <NewPlaylistDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </nav>
  );
}

/**
 * Rodapé da sidebar com a varredura F13 que roda em segundo plano: mostra a
 * contagem enquanto busca e vira "Revisar N propostas" quando termina sem o
 * overlay na tela (o toast desta base não carrega ação de clique). Clicar
 * reabre o overlay.
 */
function EnrichBackgroundIndicator() {
  const status = useEnrichStore((s) => s.status);
  const overlayOpen = useEnrichStore((s) => s.overlayOpen);
  const progress = useEnrichStore((s) => s.progress);
  const proposals = useEnrichStore((s) => s.proposals);
  const openOverlay = useEnrichStore((s) => s.openOverlay);

  if (status === "idle" || overlayOpen) return null;

  const label =
    status === "scanning"
      ? progress
        ? `Buscando dados… ${progress.done} de ${progress.total}`
        : "Buscando dados…"
      : proposals.length === 1
        ? "Revisar 1 proposta"
        : `Revisar ${proposals.length} propostas`;

  return (
    <button
      type="button"
      onClick={openOverlay}
      title="Abrir a revisão de dados"
      className="mt-2 truncate rounded-md bg-[#F0FDFA] px-3 py-2 text-left text-[13px] font-medium text-[#0F766E] hover:bg-[#CCFBF1]"
    >
      {label}
    </button>
  );
}

/**
 * Item recursivo da árvore de pastas (V4 — F11): clique numa SUBPASTA filtra a
 * biblioteca. A pasta RAIZ (level 0, pasta registrada) equivale a "Biblioteca":
 * clicar nela LIMPA o filtro — sem chip 📁 (V5 Q2, o × na raiz assustava).
 */
function FolderTreeItem({ node, level }: { node: FolderNode; level: number }) {
  const folderFilter = useLibraryStore((s) => s.folderFilter);
  const setFolderFilter = useLibraryStore((s) => s.setFolderFilter);
  const setView = useUiStore((s) => s.setView);
  const closePlaylist = usePlaylistStore((s) => s.closePlaylist);
  const startScan = useEnrichStore((s) => s.startScan);
  // só UMA varredura por vez: com uma rodando (inclusive em segundo plano, de
  // outra pasta) o ✎ de todas as pastas fica desabilitado
  const scanning = useEnrichStore((s) => s.status === "scanning");
  const isRoot = level === 0;
  const active = !isRoot && folderFilter === node.path;
  // raiz = Biblioteca (Q2): conta como "selecionada" quando não há filtro
  const enrichVisible = isRoot ? folderFilter === null : active;

  return (
    <>
      <span className="group relative flex w-full items-center gap-1 pr-2">
        <button
          type="button"
          aria-label={`Pasta ${node.name}`}
          title={node.path}
          className={`flex min-w-0 flex-1 items-center justify-between gap-2 rounded-md py-1 pr-2 text-left text-[14px] ${
            active
              ? "bg-[#F0FDFA] font-medium text-[#0F766E]"
              : "text-[#374151] hover:bg-[#F3F4F6]"
          }`}
          style={{ paddingLeft: 20 + level * 14 }}
          onClick={() => {
            closePlaylist();
            setFolderFilter(isRoot ? null : node.path);
            setView("library");
          }}
        >
          <span className="truncate">{node.name}</span>
          <span className="shrink-0 text-[12px] text-[#9CA3AF]">{node.count}</span>
        </button>
        {/* F13: dispara o "Completar dados" da pasta (raiz = biblioteca
            inteira, prefixo ""). Como o "+" do SongRow (DECISIONS #31):
            hover + visível quando selecionada, para toque/teclado. */}
        <button
          type="button"
          aria-label={
            isRoot
              ? "Completar dados da biblioteca"
              : `Completar dados da pasta ${node.name}`
          }
          disabled={scanning}
          title={
            scanning
              ? "Uma busca de dados já está em andamento"
              : isRoot
                ? "Completar dados da biblioteca"
                : "Completar dados desta pasta"
          }
          className={`h-6 w-6 shrink-0 rounded text-[13px] text-[#374151] hover:bg-[#E5E7EB] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent group-hover:block ${
            enrichVisible ? "block" : "hidden"
          }`}
          onClick={() => void startScan(isRoot ? "" : node.path)}
        >
          ✎
        </button>
      </span>
      {node.children.map((child) => (
        <FolderTreeItem key={child.path} node={child} level={level + 1} />
      ))}
    </>
  );
}
