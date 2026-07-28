import { useState } from "react";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlayerStore } from "../stores/playerStore";
import { usePlaylistStore } from "../stores/playlistStore";
import { useUiStore } from "../stores/uiStore";
import { ConfirmDialog } from "./ConfirmDialog";

/** Coluna central com a playlist aberta (F5). */
export function PlaylistView() {
  const playlists = usePlaylistStore((s) => s.playlists);
  const activePlaylistId = usePlaylistStore((s) => s.activePlaylistId);
  const items = usePlaylistStore((s) => s.items);
  const removeItem = usePlaylistStore((s) => s.removeItem);
  const reorder = usePlaylistStore((s) => s.reorder);
  const deletePlaylist = usePlaylistStore((s) => s.deletePlaylist);

  const select = useLibraryStore((s) => s.select);
  const selectedSongId = useLibraryStore((s) => s.selectedSongId);
  const playQueue = usePlayerStore((s) => s.playQueue);
  const playerCurrentId = usePlayerStore((s) => s.current?.id ?? null);
  const playerPlaylistId = usePlayerStore((s) => s.playlistId);
  const playerIsPlaying = usePlayerStore((s) => s.isPlaying);
  const setView = useUiStore((s) => s.setView);

  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const playlist = playlists.find((p) => p.id === activePlaylistId);
  if (!playlist || activePlaylistId === null) return null;

  function startPlaylist(startIndex = 0) {
    if (items.length === 0) return;
    playQueue(
      items.map((i) => i.song),
      startIndex,
      activePlaylistId,
    );
  }

  function handleDrop() {
    if (dragIndex === null || dropIndex === null || dragIndex === dropIndex) {
      setDragIndex(null);
      setDropIndex(null);
      return;
    }
    const ids = items.map((i) => i.id);
    const [moved] = ids.splice(dragIndex, 1);
    ids.splice(dropIndex, 0, moved);
    void reorder(ids);
    setDragIndex(null);
    setDropIndex(null);
  }

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-[#F9FAFB]">
      {/*
        `pr-[var(--faixa-detalhes)]` reserva a faixa do botão flutuante
        "Ocultar/Mostrar detalhes" (App.tsx) — este cabeçalho ficava com
        `pr-36` e o "Excluir playlist" saía 20 px por baixo do botão a 1280
        e 72 px a 1024 (o minWidth da janela).

        `flex-wrap` é a outra metade do conserto: o título mais os dois
        botões não CABEM na faixa livre a 1024 com o painel aberto, e sem
        wrap o flex transborda para a direita — de volta para debaixo do
        botão. Com wrap, o "Excluir playlist" desce para a linha de baixo:
        cabeçalho mais alto, mas o botão inteiro visível e clicável — em vez
        de 72 px dele escondidos atrás de outro botão.
      */}
      <div className="flex shrink-0 flex-wrap items-center gap-3 p-4 pr-[var(--faixa-detalhes)]">
        {/*
          `flex-1` (base 0), e não só `min-w-0`: a quebra de linha do flex é
          decidida pelo tamanho NATURAL do item, então um nome de playlist
          comprido empurrava os dois botões para baixo mesmo sobrando espaço
          para eles. Com base 0 o título cede a largura primeiro (truncando,
          que é o que ele já fazia) e só quando os botões realmente não cabem
          é que o último desce de linha.
        */}
        <h1 className="min-w-0 flex-1 truncate text-[22px] font-semibold text-[#111827]">
          {playlist.name}
        </h1>
        <button
          type="button"
          className="shrink-0 rounded-md bg-[#0F766E] px-4 py-2 text-[15px] font-medium text-[#FFFFFF] hover:bg-[#0d675f] disabled:bg-[#9CA3AF]"
          disabled={items.length === 0}
          onClick={() => startPlaylist(0)}
        >
          ▶ Tocar playlist
        </button>
        <button
          type="button"
          className="ml-auto shrink-0 rounded-md px-3 py-2 text-[14px] font-medium text-[#B91C1C] hover:bg-[#FEE2E2]"
          onClick={() => setConfirmingDelete(true)}
        >
          Excluir playlist
        </button>
      </div>

      {items.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center">
          <p className="text-[#6B7280]">
            Esta playlist está vazia. Adicione músicas pela busca ou biblioteca.
          </p>
        </div>
      ) : (
        <div role="listbox" aria-label={`Playlist ${playlist.name}`} className="flex-1 overflow-y-auto">
          {items.map((item, index) => {
            const isCurrent =
              playerCurrentId === item.song.id && playerPlaylistId === activePlaylistId;
            const unavailable = !item.song.available;
            return (
              <div
                key={item.id}
                role="option"
                aria-selected={selectedSongId === item.song.id}
                draggable
                onDragStart={() => setDragIndex(index)}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDropIndex(index);
                }}
                onDrop={handleDrop}
                onDragEnd={() => {
                  setDragIndex(null);
                  setDropIndex(null);
                }}
                onClick={() => select(item.song.id)}
                onDoubleClick={() => startPlaylist(index)}
                className={`group flex min-h-9 cursor-default select-none items-center gap-3 px-4 py-1.5 ${
                  isCurrent
                    ? "bg-[#F0FDFA]"
                    : selectedSongId === item.song.id
                      ? "bg-[#F0FDFA]"
                      : "hover:bg-[#F3F4F6]"
                } ${dropIndex === index && dragIndex !== null ? "border-t-2 border-[#0F766E]" : ""}`}
              >
                <span className="w-6 shrink-0 text-right text-[13px] text-[#9CA3AF]">
                  {index + 1}
                </span>
                <span
                  className={`truncate text-[15px] font-medium ${
                    unavailable
                      ? "text-[#9CA3AF]"
                      : isCurrent
                        ? "text-[#0F766E]"
                        : "text-[#111827]"
                  }`}
                >
                  {isCurrent && playerIsPlaying && (
                    <span aria-hidden="true" className="mr-1 motion-safe:animate-pulse">
                      ♪
                    </span>
                  )}
                  {item.song.title}
                </span>
                {item.song.artist && (
                  <span className="truncate text-[13px] text-[#6B7280]">
                    {item.song.artist}
                  </span>
                )}
                <button
                  type="button"
                  aria-label={`Remover ${item.song.title} da playlist`}
                  className="ml-auto hidden h-6 w-6 shrink-0 rounded text-[#374151] hover:bg-[#E5E7EB] group-hover:block"
                  onClick={(e) => {
                    e.stopPropagation();
                    void removeItem(item.id);
                  }}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={confirmingDelete}
        title={`Excluir a playlist "${playlist.name}"? As músicas não serão apagadas.`}
        confirmLabel="Excluir"
        onCancel={() => setConfirmingDelete(false)}
        onConfirm={() => {
          setConfirmingDelete(false);
          void deletePlaylist(activePlaylistId).then(() => setView("library"));
        }}
      />
    </div>
  );
}
