import { useCallback, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { filterResultsByFolder, songFileName } from "../lib/folderTree";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlayerStore } from "../stores/playerStore";
import type { SearchResult } from "../lib/types";
import { SongRow } from "./SongRow";

/**
 * Alturas fixas da virtualização (a linha não é medida). Cada linha de texto
 * tem `leading-*` explícito no `SongRow`, e é dele que saem estes números:
 * título e artista 24px, nome do arquivo 20px, trecho da letra 24px. A coluna
 * de texto nunca fica mais baixa que o botão de tocar (48px). O `py-2.5` da
 * linha soma 20px.
 *
 * V15 — linhas bem mais altas que antes (eram 40px): letra maior e um botão
 * de tocar do tamanho de um dedo. Com 8.000 músicas isso não pesa: só as
 * linhas na tela existem.
 */
const PADDING_DA_LINHA = 20;
const BOTAO_DE_TOCAR = 48;
const LINHA_DO_TITULO = 24;
const LINHA_DO_ARTISTA = 24;
const FILENAME_LINE_HEIGHT = 20;
const SNIPPET_LINE_HEIGHT = 24;

/** Altura da linha: o texto empilhado, nunca menos que o botão de tocar. */
function rowHeight(result: SearchResult | undefined): number {
  if (!result) return PADDING_DA_LINHA + BOTAO_DE_TOCAR;
  const texto =
    LINHA_DO_TITULO +
    (result.song.artist ? LINHA_DO_ARTISTA : 0) +
    (songFileName(result.song) ? FILENAME_LINE_HEIGHT : 0) +
    (result.snippet ? SNIPPET_LINE_HEIGHT : 0);
  // +1: a borda de baixo da linha
  return PADDING_DA_LINHA + Math.max(BOTAO_DE_TOCAR, texto) + 1;
}

/** Lista virtualizada de músicas (biblioteca/resultados de busca). */
export function SongList() {
  const allResults = useLibraryStore((s) => s.results);
  const folderFilter = useLibraryStore((s) => s.folderFilter);
  const selectedSongId = useLibraryStore((s) => s.selectedSongId);
  const select = useLibraryStore((s) => s.select);
  const playQueue = usePlayerStore((s) => s.playQueue);

  // Filtro de pasta ativo (V4 F11) refina a lista exibida.
  const results = useMemo(
    () => filterResultsByFolder(allResults, folderFilter),
    [allResults, folderFilter],
  );

  const parentRef = useRef<HTMLDivElement>(null);

  // Chave da linha = id da música, e NÃO o índice. Isso é obrigatório, não
  // enfeite: o virtual-core memoiza as medidas em [count, getItemKey, ...] e
  // `estimateSize` NÃO entra nessa lista. Sem uma chave que troque de
  // identidade junto com `results`, trocar a lista mantendo a contagem
  // (alternar entre duas pastas com o mesmo número de músicas, repopular os
  // resultados depois de salvar um título) reaproveitaria as alturas da lista
  // ANTERIOR — as linhas sairiam posicionadas por medidas de outras músicas.
  const getItemKey = useCallback(
    (index: number) => results[index]?.song.id ?? index,
    [results],
  );

  const virtualizer = useVirtualizer({
    count: results.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => rowHeight(results[index]),
    getItemKey,
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
                onPlay={() =>
                  // V13 — tocar da biblioteca monta a fila com a lista que está
                  // NA TELA (já filtrada por pasta e por busca), para o botão de
                  // próxima funcionar fora de playlist. `null` de playlist é o
                  // que distingue "fila da biblioteca" de "fila de playlist".
                  playQueue(
                    results.map((r) => r.song),
                    vi.index,
                    null,
                  )
                }
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
