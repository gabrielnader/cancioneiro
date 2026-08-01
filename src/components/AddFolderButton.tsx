import { useEffect, useRef } from "react";
import { getBackend } from "../lib/api";
import { useLibraryStore } from "../stores/libraryStore";
import { useToastStore } from "../stores/toastStore";

interface AddFolderButtonProps {
  variant: "primary" | "outline";
}

/** Botão "Adicionar pasta": diálogo nativo + indexação com progresso (F1). */
export function AddFolderButton({ variant }: AddFolderButtonProps) {
  const addFolder = useLibraryStore((s) => s.addFolder);
  const setScanning = useLibraryStore((s) => s.setScanning);
  const push = useToastStore((s) => s.push);
  const unlisten = useRef<(() => void) | null>(null);

  useEffect(
    () => () => {
      unlisten.current?.();
    },
    [],
  );

  async function handleClick() {
    const backend = getBackend();
    const path = await backend.pickFolder();
    if (!path) return;
    unlisten.current = await backend.onScanProgress((p) =>
      setScanning({ done: p.done, total: p.total }),
    );
    try {
      const result = await addFolder(path);
      if (result.total === 0) {
        push("Nenhum MP3 encontrado nesta pasta.", "warning");
      } else {
        push(`${result.total} músicas indexadas.`, "success");
      }
    } catch (e) {
      push(String(e), "error");
    } finally {
      setScanning(null);
      unlisten.current?.();
      unlisten.current = null;
    }
  }

  const className =
    variant === "primary"
      ? "rounded-md bg-brand-fill px-4 py-2 text-[15px] font-medium text-white hover:bg-brand-fill-hover"
      : "rounded-md border border-brand bg-transparent px-4 py-2 text-[15px] font-medium text-brand hover:bg-brand-soft";

  return (
    <button type="button" className={className} onClick={() => void handleClick()}>
      Adicionar pasta
    </button>
  );
}
