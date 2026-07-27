import { useEffect } from "react";
import { SEARCH_INPUT_ID } from "../components/SearchBar";
import { audioController } from "./playerAudioCore";
import { filterResultsByFolder } from "../lib/folderTree";
import { playSelectedOrToggle } from "../lib/playbackActions";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlayerStore } from "../stores/playerStore";
import { usePlaylistStore } from "../stores/playlistStore";
import { useUiStore } from "../stores/uiStore";
import type { Song } from "../lib/types";

function isTextInput(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" || target.tagName === "TEXTAREA")
  );
}

/** Foca a busca de qualquer tela: volta para a Biblioteca se preciso. */
function focusSearch() {
  const input = document.getElementById(SEARCH_INPUT_ID);
  if (input) {
    input.focus();
    return;
  }
  useUiStore.getState().setView("library");
  requestAnimationFrame(() => {
    document.getElementById(SEARCH_INPUT_ID)?.focus();
  });
}

/** Lista visível para navegação por teclado (biblioteca ou playlist aberta). */
function visibleSongs(): { songs: Song[]; playlistId: number | null } {
  const view = useUiStore.getState().view;
  if (view === "playlist") {
    const { items, activePlaylistId } = usePlaylistStore.getState();
    return { songs: items.map((i) => i.song), playlistId: activePlaylistId };
  }
  // respeita o filtro de pasta ativo (V4 F11): navega só o que está visível
  const { results, folderFilter } = useLibraryStore.getState();
  return {
    songs: filterResultsByFolder(results, folderFilter).map((r) => r.song),
    playlistId: null,
  };
}

/**
 * Atalhos globais (F2/F4/acessibilidade): espaço play/pause, "/" e Ctrl/Cmd+K
 * focam a busca, Esc limpa, ←/→ seek ∓5s, ↑/↓ navegam, Enter toca.
 */
export function useKeyboardShortcuts() {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const inInput = isTextInput(e.target);

      // Ctrl/Cmd+K funciona de qualquer lugar
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        focusSearch();
        return;
      }

      if (inInput) return; // digitação normal (espaço insere espaço etc.)

      switch (e.key) {
        case " ": {
          e.preventDefault(); // evita scroll da página
          // com música carregada alterna; com apenas seleção, inicia (F4)
          playSelectedOrToggle();
          break;
        }
        case "/": {
          e.preventDefault();
          focusSearch();
          break;
        }
        case "Escape": {
          useLibraryStore.getState().setQuery("");
          break;
        }
        case "ArrowLeft": {
          e.preventDefault();
          audioController.seekBy(-5);
          break;
        }
        case "ArrowRight": {
          e.preventDefault();
          audioController.seekBy(5);
          break;
        }
        case "ArrowDown":
        case "ArrowUp": {
          e.preventDefault();
          const { songs } = visibleSongs();
          if (songs.length === 0) break;
          const selectedId = useLibraryStore.getState().selectedSongId;
          const currentIndex = songs.findIndex((s) => s.id === selectedId);
          const delta = e.key === "ArrowDown" ? 1 : -1;
          const nextIndex =
            currentIndex === -1
              ? e.key === "ArrowDown"
                ? 0
                : songs.length - 1
              : Math.min(songs.length - 1, Math.max(0, currentIndex + delta));
          useLibraryStore.getState().select(songs[nextIndex].id);
          break;
        }
        case "Enter": {
          const { songs, playlistId } = visibleSongs();
          const selectedId = useLibraryStore.getState().selectedSongId;
          const index = songs.findIndex((s) => s.id === selectedId);
          if (index === -1) break;
          if (playlistId !== null) {
            usePlayerStore.getState().playQueue(songs, index, playlistId);
          } else {
            usePlayerStore.getState().playSong(songs[index]);
          }
          break;
        }
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
