import { useEffect, useState } from "react";
import { getBackend } from "../lib/api";
import type { Song } from "../lib/types";
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
  const addToPlaylist = usePlaylistStore((s) => s.addToPlaylist);

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
  /** V14 — o painel de acrescentar músicas, aberto por padrão na playlist vazia. */
  const [busca, setBusca] = useState("");
  const [achados, setAchados] = useState<Song[]>([]);
  const [temas, setTemas] = useState<[string, number][]>([]);
  const [tema, setTema] = useState("");

  useEffect(() => {
    void getBackend()
      .listTemas()
      .then(setTemas)
      .catch(() => setTemas([]));
  }, []);

  useEffect(() => {
    const termo = busca.trim();
    if (!termo) {
      setAchados([]);
      return;
    }
    // espera de 150 ms, a mesma da busca da biblioteca: digitar não dispara
    // uma consulta por tecla
    const t = setTimeout(() => {
      void getBackend()
        .search(termo)
        .then((r) => setAchados(r.slice(0, 30).map((x) => x.song)))
        .catch(() => setAchados([]));
    }, 150);
    return () => clearTimeout(t);
  }, [busca]);

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
    <div className="flex h-full min-w-0 flex-1 flex-col bg-canvas">
      {/* `flex-wrap`: título e dois botões não cabem lado a lado em tela
          estreita, e sem wrap o último sairia para fora da tela */}
      <div className="flex shrink-0 flex-wrap items-center gap-3 px-6 pb-3 pt-5 max-lg:px-4 max-lg:pt-3">
        {/*
          `flex-1` (base 0), e não só `min-w-0`: a quebra de linha do flex é
          decidida pelo tamanho NATURAL do item, então um nome de playlist
          comprido empurrava os dois botões para baixo mesmo sobrando espaço
          para eles. Com base 0 o título cede a largura primeiro (truncando,
          que é o que ele já fazia) e só quando os botões realmente não cabem
          é que o último desce de linha.
        */}
        <h1 className="min-w-0 flex-1 truncate text-[24px] font-bold text-ink">
          {playlist.name}
        </h1>
        <button
          type="button"
          className="min-h-12 shrink-0 rounded-xl bg-brand-fill px-5 text-[17px] font-semibold text-white hover:bg-brand-fill-hover disabled:bg-disabled"
          disabled={items.length === 0}
          onClick={() => startPlaylist(0)}
        >
          ▶ Tocar playlist
        </button>
        <button
          type="button"
          className="ml-auto min-h-12 shrink-0 rounded-xl px-4 text-[16px] font-semibold text-danger hover:bg-danger-soft"
          onClick={() => setConfirmingDelete(true)}
        >
          Excluir playlist
        </button>
      </div>

      {/* V14 — acrescentar músicas SEM sair da playlist. A ordem importa aqui
          (a playlist é uma sequência para tocar), então cada adição vai para o
          FIM, na ordem em que a pessoa clica. */}
      <div className="shrink-0 border-b border-border px-6 pb-4 max-lg:px-4">
        <input
          type="text"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder="Buscar música para acrescentar…"
          aria-label="Buscar música para acrescentar"
          className="min-h-14 w-full rounded-xl border-2 border-border-strong bg-surface px-4 text-[18px] text-ink outline-none placeholder:text-ink-tertiary focus:border-brand"
        />
        {achados.length > 0 && (
          <div className="mt-2 max-h-64 overflow-y-auto rounded-xl border border-border bg-surface">
            {achados.map((s) => (
              <button
                key={s.id}
                type="button"
                className="flex min-h-12 w-full items-center justify-between gap-2 px-4 py-2 text-left text-[16px] text-ink hover:bg-surface-hover"
                onClick={() => void addToPlaylist(activePlaylistId, s.id)}
              >
                <span className="truncate">
                  {s.title}
                  {s.artist ? ` — ${s.artist}` : ""}
                </span>
                <span className="shrink-0 font-semibold text-brand">+ Pôr na lista</span>
              </button>
            ))}
          </div>
        )}
        {temas.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[16px]">
            <label htmlFor="tema-lote" className="text-ink-tertiary">
              Ou acrescentar tudo de um tema:
            </label>
            <select
              id="tema-lote"
              value={tema}
              onChange={(e) => setTema(e.target.value)}
              className="min-h-11 rounded-xl border-2 border-border-strong bg-surface px-3 text-ink"
            >
              <option value="">escolha um tema</option>
              {temas.map(([nome, n]) => (
                <option key={nome} value={nome}>
                  {nome} ({n})
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={!tema}
              className="min-h-11 rounded-xl border-2 border-brand px-4 font-semibold text-brand hover:bg-brand-soft disabled:border-border disabled:text-disabled"
              onClick={() => {
                const escolhido = tema;
                void getBackend()
                  .songsByTema(escolhido)
                  .then(async (musicas) => {
                    // em série: a ordem da playlist é a ordem daqui
                    for (const m of musicas) {
                      await addToPlaylist(activePlaylistId, m.id);
                    }
                    setTema("");
                  });
              }}
            >
              Acrescentar
            </button>
          </div>
        )}
      </div>

      {items.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center">
          <p className="max-w-md text-[17px] text-ink-secondary">
            Esta playlist está vazia. Use a busca acima para acrescentar
            músicas — ou{" "}
            <strong className="font-medium text-ink-secondary">
              arraste uma música da biblioteca
            </strong>{" "}
            e solte no nome da playlist, na coluna da esquerda.
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
                className={`group flex min-h-16 cursor-default select-none items-center gap-4 border-b border-border px-6 py-2 max-lg:gap-3 max-lg:px-4 ${
                  isCurrent
                    ? "bg-brand-soft"
                    : selectedSongId === item.song.id
                      ? "bg-brand-soft"
                      : "hover:bg-surface-hover"
                } ${dropIndex === index && dragIndex !== null ? "border-t-2 border-brand" : ""}`}
              >
                <span className="w-7 shrink-0 text-right text-[15px] text-ink-tertiary">
                  {index + 1}
                </span>
                {/* V15 — tocar com UM clique, a partir desta música (ver SongRow) */}
                <button
                  type="button"
                  aria-label={`Tocar ${item.song.title}`}
                  disabled={unavailable}
                  onClick={(e) => {
                    e.stopPropagation();
                    startPlaylist(index);
                  }}
                  onDoubleClick={(e) => e.stopPropagation()}
                  className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-brand-fill text-white hover:bg-brand-fill-hover disabled:bg-disabled"
                >
                  <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.9l10-6.5a1 1 0 0 0 0-1.7l-10-6.5A1 1 0 0 0 8 5.5Z" /></svg>
                </button>
                <span className="flex min-w-0 flex-1 flex-col">
                <span
                  className={`truncate text-[17px] font-semibold ${
                    unavailable
                      ? "text-disabled"
                      : isCurrent
                        ? "text-brand"
                        : "text-ink"
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
                  <span className="truncate text-[16px] text-ink-secondary">
                    {item.song.artist}
                  </span>
                )}
                </span>
                {/* V15 — sempre visível: só com o mouse em cima, quem não
                    sabia que ele existia nunca o achava */}
                <button
                  type="button"
                  aria-label={`Remover ${item.song.title} da playlist`}
                  className="flex min-h-11 shrink-0 items-center gap-1 rounded-xl px-3 text-[15px] font-semibold text-ink-secondary hover:bg-danger-soft hover:text-danger"
                  onClick={(e) => {
                    e.stopPropagation();
                    void removeItem(item.id);
                  }}
                >
                  <span aria-hidden="true" className="text-[18px] leading-none">×</span>
                  <span aria-hidden="true" className="max-md:hidden">Tirar</span>
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
