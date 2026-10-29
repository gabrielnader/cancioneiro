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
    <div className="w-full">
      {/* V15 — título visível em vez de só placeholder: o placeholder some na
          primeira letra digitada, e com ele a lembrança do que se pode buscar */}
      <label
        htmlFor={SEARCH_INPUT_ID}
        className="mb-2 block text-[21px] font-bold text-ink max-lg:text-[19px] baixa:mb-1 baixa:text-[18px] muito-baixa:sr-only"
      >
        Procurar uma música
      </label>
      <div className="flex min-h-16 items-center gap-3 rounded-2xl border-2 border-brand bg-surface pl-5 pr-2 shadow-sm focus-within:ring-4 focus-within:ring-brand-soft-hover baixa:min-h-13 baixa:pl-4">
        <svg aria-hidden="true" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" className="shrink-0 text-brand"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
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
          placeholder="Um pedaço da letra, o nome ou quem canta"
          aria-describedby="busca-ajuda"
          className="min-w-0 flex-1 bg-transparent py-3 text-[21px] text-ink outline-none placeholder:text-ink-tertiary baixa:py-2 baixa:text-[19px]"
        />
        {query && (
          <button
            type="button"
            aria-label="Limpar busca"
            className="min-h-11 shrink-0 rounded-xl bg-surface-hover px-4 text-[16px] font-semibold text-ink-secondary hover:bg-border"
            onClick={() => {
              setQuery("");
              inputRef.current?.focus();
            }}
          >
            Limpar
          </button>
        )}
      </div>
      <p id="busca-ajuda" className="mt-2 text-[15px] text-ink-secondary baixa:hidden">
        Pode digitar um pedaço da letra, o nome da música ou quem canta. Não
        precisa acertar tudo.
      </p>
    </div>
  );
}
