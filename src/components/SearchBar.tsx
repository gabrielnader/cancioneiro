import { useEffect, useRef } from "react";
import { useDebounce } from "../hooks/useDebounce";
import { useLibraryStore } from "../stores/libraryStore";

export const SEARCH_INPUT_ID = "busca-principal";

/**
 * Campo de busca (F2): debounce de 150ms, foco automático, Esc limpa.
 * Botão "×" dentro do campo limpa a query e devolve o foco (V5 Q1).
 */
export function SearchBar() {
  const query = useLibraryStore((s) => s.query);
  const setQuery = useLibraryStore((s) => s.setQuery);
  const runSearch = useLibraryStore((s) => s.runSearch);
  const debouncedQuery = useDebounce(query, 150);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void runSearch(debouncedQuery);
  }, [debouncedQuery, runSearch]);

  return (
    <div className="relative w-full">
      <input
        ref={inputRef}
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
        className="w-full rounded-md border border-[#D1D5DB] bg-[#FFFFFF] px-3 py-2 pr-9 text-[15px] text-[#111827] outline-none placeholder:text-[#9CA3AF] focus:border-[#0F766E]"
      />
      {query && (
        <button
          type="button"
          aria-label="Limpar busca"
          title="Limpar busca"
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-1.5 text-[18px] leading-none text-[#6B7280] hover:bg-[#F3F4F6] hover:text-[#111827]"
          onClick={() => {
            setQuery("");
            inputRef.current?.focus();
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}
