import { useState } from "react";
import { usePlaylistStore } from "../stores/playlistStore";
import { useUiStore } from "../stores/uiStore";

interface NewPlaylistDialogProps {
  open: boolean;
  onClose: () => void;
}

/** Diálogo "Nova playlist" (F5), com validação de nome vazio. */
export function NewPlaylistDialog({ open, onClose }: NewPlaylistDialogProps) {
  const createPlaylist = usePlaylistStore((s) => s.createPlaylist);
  const openPlaylist = usePlaylistStore((s) => s.openPlaylist);
  const setView = useUiStore((s) => s.setView);
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);

  if (!open) return null;

  const nameEmpty = name.trim() === "";
  const showError = touched && nameEmpty;

  async function handleCreate() {
    if (nameEmpty) return;
    const id = await createPlaylist(name.trim());
    setName("");
    setTouched(false);
    onClose();
    await openPlaylist(id);
    setView("playlist");
  }

  function handleClose() {
    setName("");
    setTouched(false);
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-label="Nova playlist"
    >
      <div className="w-[420px] max-w-[calc(100vw-2rem)] rounded-lg bg-surface p-5 shadow-xl">
        <h2 className="text-[18px] font-semibold text-ink">Nova playlist</h2>
        <input
          type="text"
          autoFocus
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setTouched(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleCreate();
            if (e.key === "Escape") handleClose();
          }}
          placeholder="Nome da playlist"
          className={`mt-4 w-full rounded-md border px-3 py-2 text-[15px] outline-none placeholder:text-disabled ${
            showError
              ? "border-danger"
              : "border-border-strong focus:border-brand"
          }`}
        />
        {showError && (
          <p className="mt-1 text-[13px] text-danger">Dê um nome à playlist.</p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md px-4 py-2 text-[15px] font-medium text-ink-secondary hover:bg-surface-hover"
            onClick={handleClose}
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={nameEmpty}
            className={`rounded-md px-4 py-2 text-[15px] font-medium text-white ${
              nameEmpty ? "bg-disabled" : "bg-brand-fill hover:bg-brand-fill-hover"
            }`}
            onClick={() => void handleCreate()}
          >
            Criar
          </button>
        </div>
      </div>
    </div>
  );
}
