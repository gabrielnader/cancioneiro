import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { songFileName } from "../lib/folderTree";
import { parseSnippet } from "../lib/highlight";
import type { Song } from "../lib/types";
import { usePlayerStore } from "../stores/playerStore";
import { usePlaylistStore } from "../stores/playlistStore";
import { TemaChips } from "./TemaChips";

interface SongRowProps {
  song: Song;
  snippet: string | null;
  selected: boolean;
  onSelect: () => void;
  onPlay: () => void;
}

/** Linha de música (biblioteca/busca): clique seleciona, duplo-clique toca. */
export function SongRow({ song, snippet, selected, onSelect, onPlay }: SongRowProps) {
  const isCurrent = usePlayerStore((s) => s.current?.id === song.id);
  const isPlaying = usePlayerStore((s) => s.isPlaying && s.current?.id === song.id);
  const playlists = usePlaylistStore((s) => s.playlists);
  const addToPlaylist = usePlaylistStore((s) => s.addToPlaylist);
  // Menu em portal: as linhas virtualizadas usam transform (stacking context
  // próprio), então um dropdown inline ficaria por baixo da linha seguinte.
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const plusRef = useRef<HTMLButtonElement>(null);

  // V6 — o nome do arquivo é como as coordenadoras já se organizam; entra como
  // segunda linha (soma, não troca): não disputa espaço com badge/temas/"+".
  const nomeArquivo = songFileName(song);

  const titleColor = !song.available
    ? "text-[#9CA3AF]"
    : isCurrent
      ? "text-[#0F766E]"
      : "text-[#111827]";

  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(
          "application/x-cancioneiro-song",
          String(song.id),
        );
      }}
      onClick={onSelect}
      onDoubleClick={() => {
        if (song.available) onPlay();
      }}
      className={`group relative flex min-h-9 cursor-default select-none flex-col justify-center px-4 py-1.5 ${
        selected || isCurrent ? "bg-[#F0FDFA]" : "hover:bg-[#F3F4F6]"
      }`}
    >
      <div className="flex items-center gap-2">
        {isPlaying && (
          <span
            aria-hidden="true"
            className="text-[#0F766E] motion-safe:animate-pulse"
          >
            ♪
          </span>
        )}
        {/* Ordem da linha (V5 Q3): título → artista → badge → temas → "+" */}
        <span className={`min-w-0 truncate text-[15px] font-medium ${titleColor}`}>
          {song.title}
        </span>
        {song.artist && (
          <span className="max-w-40 truncate text-[13px] text-[#6B7280]">
            {song.artist}
          </span>
        )}
        {!song.has_lyrics && (
          <span className="shrink-0 rounded bg-[#F3F4F6] px-1.5 py-0.5 text-[12px] text-[#6B7280]">
            Sem letra
          </span>
        )}
        {song.temas && (
          <span className="flex min-w-0 shrink items-center gap-1.5 overflow-hidden">
            <TemaChips temas={song.temas} />
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center">
          {playlists.length > 0 && (
            <button
              ref={plusRef}
              type="button"
              aria-label="Adicionar à playlist"
              title="Adicionar à playlist"
              className={`h-6 w-6 rounded text-[#374151] hover:bg-[#E5E7EB] group-hover:block ${
                // além do hover (PRD), fica visível na linha selecionada —
                // sem isso não há como adicionar via toque ou teclado
                selected || menuPos ? "block" : "hidden"
              }`}
              onClick={(e) => {
                e.stopPropagation();
                if (menuPos) {
                  setMenuPos(null);
                } else {
                  const rect = plusRef.current!.getBoundingClientRect();
                  setMenuPos({ top: rect.bottom + 4, left: rect.right - 224 });
                }
              }}
            >
              +
            </button>
          )}
        </span>
      </div>
      {nomeArquivo && (
        <p
          data-testid="song-filename"
          title={nomeArquivo}
          // #5B6472 e não o cinza-claro de antes: em 12px o texto precisa
          // passar em AA (4.5:1) nos TRÊS fundos da linha — branco (5.98:1),
          // selecionado #F0FDFA (5.74:1) e hover #F3F4F6 (5.44:1). Ainda muito
          // mais claro que o título (#111827, 17.74:1): o olho cai nele primeiro.
          className="truncate text-[12px] leading-4 text-[#5B6472]"
        >
          {nomeArquivo}
        </p>
      )}
      {snippet && (
        <p className="mt-0.5 truncate text-[13px] text-[#6B7280]">
          {parseSnippet(snippet).map((seg, i) =>
            seg.highlighted ? (
              <mark key={i} className="rounded-sm bg-[#FDE68A] px-0.5 text-[#78350F]">
                {seg.text}
              </mark>
            ) : (
              <span key={i}>{seg.text}</span>
            ),
          )}
        </p>
      )}

      {menuPos &&
        createPortal(
          <>
            <div
              className="fixed inset-0 z-40"
              onClick={(e) => {
                e.stopPropagation();
                setMenuPos(null);
              }}
            />
            <div
              className="fixed z-50 w-56 rounded border border-[#E5E7EB] bg-white py-1 shadow-lg"
              style={{ top: menuPos.top, left: Math.max(8, menuPos.left) }}
              onClick={(e) => e.stopPropagation()}
            >
              <p className="px-3 py-1 text-[12px] uppercase text-[#6B7280]">
                Adicionar à playlist
              </p>
              {playlists.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="block w-full px-3 py-1.5 text-left text-[#374151] hover:bg-[#F3F4F6]"
                  onClick={() => {
                    setMenuPos(null);
                    void addToPlaylist(p.id, song.id);
                  }}
                >
                  {p.name}
                </button>
              ))}
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}
