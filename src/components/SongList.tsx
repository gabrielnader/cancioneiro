import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlayerStore } from "../stores/playerStore";
import { SongRow } from "./SongRow";

const ROW_HEIGHT = 40;
const ROW_WITH_SNIPPET_HEIGHT = 62;

/** Lista virtualizada de músicas (biblioteca/resultados de busca). */
export function SongList() {
  const results = useLibraryStore((s) => s.results);
  const selectedSongId = useLibraryStore((s) => s.selectedSongId);
  const select = useLibraryStore((s) => s.select);
  const playSong = usePlayerStore((s) => s.playSong);

  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: results.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) =>
      results[index]?.snippet ? ROW_WITH_SNIPPET_HEIGHT : ROW_HEIGHT,
    overscan: 12,
  });

  return (
    <div
      ref={parentRef}
      role="listbox"
      aria-label="Músicas"
      className="flex-1 overflow-y-auto"
    >
      <div
        className="relative w-full"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((vi) => {
          const result = results[vi.index];
          if (!result) return null;
          return (
            <div
              key={result.song.id}
              className="absolute left-0 top-0 w-full"
              style={{ transform: `translateY(${vi.start}px)`, height: vi.size }}
            >
              <SongRow
                song={result.song}
                snippet={result.snippet}
                selected={selectedSongId === result.song.id}
                onSelect={() => select(result.song.id)}
                onPlay={() => playSong(result.song)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
