import { useLibraryStore } from "../stores/libraryStore";
import { useUiStore } from "../stores/uiStore";

interface TemaChipsProps {
  /** Valor cru do campo temas ("água; cura") ou null/undefined. */
  temas: string | null | undefined;
}

/**
 * Chips de tema (V2 — F8): tocar num chip preenche a busca com o tema,
 * voltando para a Biblioteca se necessário.
 */
export function TemaChips({ temas }: TemaChipsProps) {
  const setQuery = useLibraryStore((s) => s.setQuery);
  const setView = useUiStore((s) => s.setView);

  if (!temas) return null;
  const list = temas
    .split(";")
    .map((t) => t.trim())
    .filter(Boolean);
  if (list.length === 0) return null;

  return (
    <>
      {list.map((tema) => (
        <button
          key={tema}
          type="button"
          data-testid="tema-chip"
          aria-label={`Tema: ${tema}`}
          title={`Buscar pelo tema "${tema}"`}
          className="max-w-32 shrink-0 truncate rounded-full bg-[#F0FDFA] px-2 py-0.5 text-[12px] text-[#0F766E] hover:bg-[#ccfbf1]"
          onClick={(e) => {
            e.stopPropagation();
            setQuery(tema);
            setView("library");
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          {tema}
        </button>
      ))}
    </>
  );
}
