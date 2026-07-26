import { useEffect } from "react";
import { useDebounce } from "../hooks/useDebounce";
import { useLibraryStore } from "../stores/libraryStore";

export const SEARCH_INPUT_ID = "busca-principal";

/** Campo de busca (F2): debounce de 150ms, foco automático, Esc limpa. */
export function SearchBar() {
  const query = useLibraryStore((s) => s.query);
  const setQuery = useLibraryStore((s) => s.setQuery);
  const runSearch = useLibraryStore((s) => s.runSearch);
  const debouncedQuery = useDebounce(query, 150);

  useEffect(() => {
    void runSearch(debouncedQuery);
  }, [debouncedQuery, runSearch]);

  return (
    <input
      id={SEARCH_INPUT_ID}
      type="text"
      autoFocus
      value={query}
      onChange={(e) => setQuery(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          setQuery("");
          (e.target as HTMLInputElement).blur();
        }
      }}
      placeholder="Buscar por letra, título ou artista…"
      aria-label="Buscar por letra, título ou artista"
      className="w-full rounded-md border border-[#D1D5DB] bg-[#FFFFFF] px-3 py-2 text-[15px] text-[#111827] outline-none placeholder:text-[#9CA3AF] focus:border-[#0F766E]"
    />
  );
}
