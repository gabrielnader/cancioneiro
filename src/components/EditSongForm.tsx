import { useState } from "react";
import { audioController } from "../hooks/playerAudioCore";
import { getBackend } from "../lib/api";
import type { Song } from "../lib/types";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlayerStore } from "../stores/playerStore";
import { usePlaylistStore } from "../stores/playlistStore";
import { useToastStore } from "../stores/toastStore";

function basename(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath;
}

interface EditSongFormProps {
  song: Song;
  /** Letra atual (já carregada pelo painel); "" quando não há. */
  initialLyrics: string;
  /** Cancelar: descarta e volta ao modo leitura. */
  onCancel: () => void;
  /** Salvou com sucesso: sair da edição e re-exibir a letra. */
  onSaved: () => void;
}

/**
 * Formulário de edição de metadados no painel de letra (V4 — F10).
 * Grava tags via write_tags; "Buscar letra na internet" é o único ponto de
 * rede do app e falha graciosamente sem conexão.
 */
export function EditSongForm({
  song,
  initialLyrics,
  onCancel,
  onSaved,
}: EditSongFormProps) {
  const push = useToastStore((s) => s.push);
  const [title, setTitle] = useState(song.title);
  const [artist, setArtist] = useState(song.artist ?? "");
  const [temas, setTemas] = useState<string[]>(() =>
    (song.temas ?? "")
      .split(";")
      .map((t) => t.trim())
      .filter(Boolean),
  );
  const [temaInput, setTemaInput] = useState("");
  const [lyrics, setLyrics] = useState(initialLyrics);
  const [titleError, setTitleError] = useState(false);
  const [busy, setBusy] = useState(false);
  // busy próprio da busca de letra (V5 Q5): não trava Salvar/Cancelar
  const [fetchBusy, setFetchBusy] = useState(false);

  /**
   * Confirma o texto pendente do input de tema como chip e devolve a lista
   * resultante — handleSave precisa dela na hora (setState é assíncrono).
   * BUG v0.4: tema digitado sem Enter era perdido ao salvar.
   */
  function commitTemaInput(): string[] {
    const tema = temaInput.trim();
    setTemaInput("");
    if (!tema || temas.some((t) => t.toLowerCase() === tema.toLowerCase())) {
      return temas;
    }
    const next = [...temas, tema];
    setTemas(next);
    return next;
  }

  async function handleFetchLyrics() {
    setFetchBusy(true);
    try {
      const match = await getBackend().fetchLyricsOnline(
        title.trim(),
        artist.trim() ? artist.trim() : null,
        song.duration_seconds ?? 0,
      );
      if (!match) {
        push("Letra não encontrada para este título e artista.", "warning");
        return;
      }
      if (
        lyrics.trim() &&
        !window.confirm("Substituir a letra atual pelo resultado da busca?")
      ) {
        return;
      }
      setLyrics(match.lyrics);
    } catch {
      push("Sem conexão — a busca de letra precisa de internet.", "warning");
    } finally {
      setFetchBusy(false);
    }
  }

  async function handleSave() {
    // tema digitado e não confirmado com Enter conta como se tivesse dado
    // Enter (BUG v0.4) — inclusive quando o título inválido aborta o save.
    const finalTemas = commitTemaInput();

    if (!title.trim()) {
      setTitleError(true);
      return;
    }
    setTitleError(false);

    // Se a música em edição está tocando, pausa ANTES de gravar (o arquivo
    // pode estar em uso no Windows) e mantém pausado depois (PRD V4).
    // audioController.pause age direto no elemento — sem esperar re-render,
    // fechando a janela de corrida entre o pause e o write no disco.
    const player = usePlayerStore.getState();
    if (player.current?.id === song.id && player.isPlaying) {
      player.setPlaying(false);
      audioController.pause();
    }

    setBusy(true);
    try {
      const saved = await getBackend().writeTags(
        song.id,
        title.trim(),
        artist.trim() ? artist.trim() : null,
        lyrics.trim() ? lyrics : null,
        finalTemas.length > 0 ? finalTemas.join("; ") : null,
      );
      useLibraryStore.getState().updateSong(saved);
      usePlaylistStore.getState().updateSongInItems(saved);
      usePlayerStore.getState().updateSongRefs(saved);
      push(`Alterações salvas em ${basename(song.file_path)}.`, "success");
      onSaved();
    } catch {
      push(`Não foi possível salvar em ${basename(song.file_path)}.`, "error");
    } finally {
      setBusy(false);
    }
  }

  const inputClass = (error: boolean) =>
    `w-full rounded-md border bg-white px-3 py-2 text-[15px] text-[#111827] outline-none ${
      error
        ? "border-[#B91C1C]"
        : "border-[#D1D5DB] focus:border-[#0F766E]"
    }`;

  return (
    <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
      <div>
        <label
          htmlFor="edit-titulo"
          className="mb-1 block text-[13px] font-medium text-[#374151]"
        >
          Título
        </label>
        <input
          id="edit-titulo"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className={inputClass(titleError)}
        />
        {titleError && (
          <p className="mt-1 text-[13px] text-[#B91C1C]">
            Dê um título à música.
          </p>
        )}
      </div>

      <div>
        <label
          htmlFor="edit-artista"
          className="mb-1 block text-[13px] font-medium text-[#374151]"
        >
          Artista
        </label>
        <input
          id="edit-artista"
          type="text"
          value={artist}
          onChange={(e) => setArtist(e.target.value)}
          className={inputClass(false)}
        />
      </div>

      <div>
        <p className="mb-1 text-[13px] font-medium text-[#374151]">Temas</p>
        <div className="flex flex-wrap items-center gap-1.5">
          {temas.map((tema) => (
            <span
              key={tema}
              className="inline-flex max-w-40 items-center gap-1 rounded-full bg-[#F0FDFA] px-2 py-0.5 text-[12px] text-[#0F766E]"
            >
              <span className="truncate">{tema}</span>
              <button
                type="button"
                aria-label={`Remover tema ${tema}`}
                className="shrink-0 rounded-full px-0.5 hover:bg-[#ccfbf1]"
                onClick={() => setTemas(temas.filter((t) => t !== tema))}
              >
                ×
              </button>
            </span>
          ))}
          <input
            type="text"
            value={temaInput}
            placeholder="Adicionar tema"
            aria-label="Adicionar tema"
            onChange={(e) => setTemaInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitTemaInput();
              }
            }}
            // sair do campo confirma o tema pendente como chip (BUG v0.4)
            onBlur={commitTemaInput}
            className="min-w-28 flex-1 rounded-md border border-[#D1D5DB] bg-white px-2 py-1 text-[13px] text-[#111827] outline-none placeholder:text-[#9CA3AF] focus:border-[#0F766E]"
          />
        </div>
      </div>

      <div className="flex min-h-32 flex-1 flex-col">
        <label
          htmlFor="edit-letra"
          className="mb-1 block text-[13px] font-medium text-[#374151]"
        >
          Letra
        </label>
        <textarea
          id="edit-letra"
          value={lyrics}
          onChange={(e) => setLyrics(e.target.value)}
          className="w-full flex-1 resize-none rounded-md border border-[#D1D5DB] bg-white px-3 py-2 text-[15px] leading-relaxed text-[#111827] outline-none focus:border-[#0F766E]"
        />
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy || fetchBusy}
          onClick={() => void handleFetchLyrics()}
          className="rounded-md border border-[#0F766E] px-3 py-1.5 text-[14px] font-medium text-[#0F766E] hover:bg-[#F0FDFA] disabled:opacity-60"
        >
          {fetchBusy ? "Buscando…" : "Buscar letra na internet"}
        </button>
        <span className="ml-auto flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 text-[14px] font-medium text-[#374151] hover:bg-[#F3F4F6] disabled:opacity-60"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleSave()}
            className="rounded-md bg-[#0F766E] px-3 py-1.5 text-[14px] font-medium text-white hover:bg-[#115E59] disabled:opacity-60"
          >
            Salvar no arquivo
          </button>
        </span>
      </div>
    </div>
  );
}
