import { useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { filterResultsByFolder, songFileName } from "../lib/folderTree";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlayerStore } from "../stores/playerStore";
import type { SearchResult } from "../lib/types";
import { SongRow } from "./SongRow";

/**
 * Alturas fixas da virtualização (a linha não é medida). Cada linha extra tem
 * altura própria e SOMA à base — a linha do nome do arquivo (V6) usa
 * leading-4 = 16px, o snippet mantém os 22px de sempre.
 */
const ROW_HEIGHT = 40;
const FILENAME_LINE_HEIGHT = 16;
const SNIPPET_LINE_HEIGHT = 22;

/** Altura da linha: base + nome do arquivo (quando exibido) + snippet. */
function rowHeight(result: SearchResult | undefined): number {
  if (!result) return ROW_HEIGHT;
  return (
    ROW_HEIGHT +
    (songFileName(result.song) ? FILENAME_LINE_HEIGHT : 0) +
    (result.snippet ? SNIPPET_LINE_HEIGHT : 0)
  );
}

/** Lista virtualizada de músicas (biblioteca/resultados de busca). */
export function SongList() {
  const allResults = useLibraryStore((s) => s.results);
  const folderFilter = useLibraryStore((s) => s.folderFilter);
  const selectedSongId = useLibraryStore((s) => s.selectedSongId);
  const select = useLibraryStore((s) => s.select);
  const playSong = usePlayerStore((s) => s.playSong);

  // Filtro de pasta ativo (V4 F11) refina a lista exibida.
  const results = useMemo(
    () => filterResultsByFolder(allResults, folderFilter),
    [allResults, folderFilter],
  );

  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: results.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => rowHeight(results[index]),
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
