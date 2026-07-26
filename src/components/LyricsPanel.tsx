import { useEffect, useState } from "react";
import { getBackend } from "../lib/api";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlaylistStore } from "../stores/playlistStore";
import { FONT_SIZES_PX, useUiStore } from "../stores/uiStore";

/** Painel lateral direito (F3): letra da música selecionada. */
export function LyricsPanel() {
  const selectedSongId = useLibraryStore((s) => s.selectedSongId);
  const results = useLibraryStore((s) => s.results);
  const playlistItems = usePlaylistStore((s) => s.items);
  const fontLevel = useUiStore((s) => s.fontLevel);
  const cycleFontLevel = useUiStore((s) => s.cycleFontLevel);

  const selected =
    results.find((r) => r.song.id === selectedSongId)?.song ??
    playlistItems.find((i) => i.song.id === selectedSongId)?.song ??
    null;

  const [lyrics, setLyrics] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (selectedSongId === null || !selected?.has_lyrics) {
      setLyrics(null);
      return;
    }
    getBackend()
      .getLyrics(selectedSongId)
      .then((l) => {
        if (!cancelled) setLyrics(l);
      })
      .catch(() => {
        if (!cancelled) setLyrics(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedSongId, selected?.has_lyrics]);

  return (
    <aside
      className="flex h-full w-[380px] shrink-0 flex-col border-l border-[#E5E7EB] bg-[#FFFFFF]"
      aria-label="Painel de letra"
    >
      {selected === null ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <p className="text-center text-[#9CA3AF]">
            Selecione uma música para ver a letra.
          </p>
        </div>
      ) : (
        <>
          <div className="flex items-start justify-between gap-2 border-b border-[#E5E7EB] p-4">
            <div className="min-w-0">
              <h2 className="truncate text-[18px] font-semibold text-[#111827]">
                {selected.title}
              </h2>
              {selected.artist && (
                <p className="truncate text-[14px] text-[#6B7280]">
                  {selected.artist}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={cycleFontLevel}
              className="shrink-0 rounded px-2 py-1 text-[15px] font-medium text-[#374151] hover:bg-[#F3F4F6]"
              aria-label="Tamanho da fonte da letra"
              title="Tamanho da fonte"
            >
              Aa
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            {selected.has_lyrics && lyrics ? (
              <p
                data-testid="lyrics-body"
                className="whitespace-pre-wrap text-[#111827]"
                style={{ fontSize: FONT_SIZES_PX[fontLevel], lineHeight: 1.7 }}
              >
                {lyrics}
              </p>
            ) : selected.has_lyrics ? null : (
              <div className="pt-4">
                <p className="text-[#6B7280]">
                  Esta música ainda não tem letra registrada.
                </p>
                <p className="mt-2 text-[#9CA3AF]">
                  Use a ferramenta de curadoria para adicionar a letra ao arquivo.
                </p>
              </div>
            )}
          </div>
        </>
      )}
    </aside>
  );
}
