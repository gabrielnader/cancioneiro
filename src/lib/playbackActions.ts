import { useLibraryStore } from "../stores/libraryStore";
import { usePlayerStore } from "../stores/playerStore";
import { usePlaylistStore } from "../stores/playlistStore";
import { useUiStore } from "../stores/uiStore";

/**
 * Ação do botão "▶ Tocar" e da barra de espaço (F4): com música carregada,
 * alterna play/pause; sem música carregada mas com uma selecionada, inicia a
 * seleção (na playlist aberta, entra na fila a partir dela). Sem seleção,
 * nenhuma ação — sem erro.
 */
export function playSelectedOrToggle(): void {
  const player = usePlayerStore.getState();
  if (player.current) {
    player.togglePlayPause();
    return;
  }

  const selectedId = useLibraryStore.getState().selectedSongId;
  if (selectedId === null) return;

  if (useUiStore.getState().view === "playlist") {
    const { items, activePlaylistId } = usePlaylistStore.getState();
    const index = items.findIndex((i) => i.song.id === selectedId);
    if (index >= 0) {
      player.playQueue(
        items.map((i) => i.song),
        index,
        activePlaylistId,
      );
      return;
    }
  }

  const selected = useLibraryStore
    .getState()
    .results.find((r) => r.song.id === selectedId)?.song;
  if (selected && selected.available) {
    player.playSong(selected);
  }
}
