import { useMemo } from "react";
import { filterResultsByFolder, folderName } from "../lib/folderTree";
import { hasSearchTokens } from "../lib/searchQuery";
import { useLibraryStore } from "../stores/libraryStore";
import { useToastStore } from "../stores/toastStore";
import { SearchBar } from "./SearchBar";
import { SongList } from "./SongList";
import { AddFolderButton } from "./AddFolderButton";

/** Coluna central: busca + lista (F1 UI / F2 / filtro de pasta V4 F11). */
export function LibraryView() {
  const results = useLibraryStore((s) => s.results);
  const query = useLibraryStore((s) => s.query);
  const folders = useLibraryStore((s) => s.folders);
  const missingFolders = useLibraryStore((s) => s.missingFolders);
  const scanning = useLibraryStore((s) => s.scanning);
  const libraryLoaded = useLibraryStore((s) => s.libraryLoaded);
  const folderFilter = useLibraryStore((s) => s.folderFilter);
  const setFolderFilter = useLibraryStore((s) => s.setFolderFilter);

  // A busca digitada é refinada pelo filtro de pasta ativo (V4 F11).
  const visibleResults = useMemo(
    () => filterResultsByFolder(results, folderFilter),
    [results, folderFilter],
  );

  const isEmptyLibrary =
    libraryLoaded && folders.length === 0 && results.length === 0;
  // Query só de operadores/pontuação é tratada como campo vazio pelo backend
  const isRealSearch = hasSearchTokens(query);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-canvas">
      {/* V15 — a busca é a protagonista da tela: título, caixa grande e a
          frase que tira o medo de errar. É a única coisa que a maioria das
          pessoas veio fazer aqui. */}
      <div className="shrink-0 px-6 pb-2 pt-5 max-lg:px-4 max-lg:pt-3 baixa:pt-2 baixa:pb-1">
        <SearchBar />
        {isRealSearch && !isEmptyLibrary && (
          <p className="mt-3 text-[16px] text-ink-secondary baixa:mt-1.5 muito-baixa:sr-only" aria-live="polite">
            <strong className="font-semibold text-ink">
              {visibleResults.length === 1
                ? "1 música"
                : `${visibleResults.length.toLocaleString("pt-BR")} músicas`}
            </strong>{" "}
            {visibleResults.length === 1 ? "encontrada" : "encontradas"}
          </p>
        )}
      </div>

      {folderFilter && (
        <div className="mx-6 mb-2 shrink-0 max-lg:mx-4">
          <button
            type="button"
            aria-label="Remover filtro de pasta"
            title={`Remover o filtro da pasta ${folderFilter}`}
            onClick={() => setFolderFilter(null)}
            className="inline-flex min-h-10 items-center gap-2 rounded-full bg-brand-soft px-4 text-[15px] font-medium text-brand hover:bg-brand-soft-hover"
          >
            <span>📁 {folderName(folderFilter)}</span>
            <span aria-hidden="true">×</span>
          </button>
        </div>
      )}

      {missingFolders.map((path) => (
        <MissingFolderBanner key={path} path={path} />
      ))}

      {scanning && (
        <div className="mx-4 mb-2 shrink-0">
          <p className="mb-1 text-[13px] text-ink-tertiary">
            Indexando… {scanning.done} de {scanning.total} arquivos
          </p>
          <div className="h-1.5 w-full overflow-hidden rounded bg-border">
            <div
              className="h-full bg-brand transition-[width]"
              style={{
                width:
                  scanning.total > 0
                    ? `${(scanning.done / scanning.total) * 100}%`
                    : "0%",
              }}
            />
          </div>
        </div>
      )}

      {isEmptyLibrary ? (
        <EmptyLibrary />
      ) : visibleResults.length === 0 && isRealSearch ? (
        <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
          <p className="text-[18px] text-ink-secondary">
            Nenhuma música encontrada para "{query.trim()}".
          </p>
          <p className="mt-2 text-[16px] text-ink-tertiary">
            Tente outras palavras do trecho que você lembra, ou só uma palavra.
          </p>
        </div>
      ) : (
        <SongList />
      )}
    </div>
  );
}

/** Empty state do primeiro uso (F1). */
function EmptyLibrary() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
      <h1 className="text-[22px] font-semibold text-ink">
        Sua biblioteca está vazia
      </h1>
      <p className="mt-2 text-ink-tertiary">
        Adicione uma pasta com suas músicas para começar.
      </p>
      <div className="mt-6">
        <AddFolderButton variant="primary" />
      </div>
    </div>
  );
}

/** Banner de pasta sumida (F1). */
function MissingFolderBanner({ path }: { path: string }) {
  const removeFolder = useLibraryStore((s) => s.removeFolder);
  const folders = useLibraryStore((s) => s.folders);
  const rescan = useLibraryStore((s) => s.rescan);
  const push = useToastStore((s) => s.push);

  const folder = folders.find((f) => f.path === path);

  return (
    <div className="mx-4 mb-2 flex shrink-0 flex-wrap items-center gap-3 rounded-md bg-warning-soft px-4 py-3">
      <p className="min-w-0 flex-1 text-[14px] text-warning-strong">
        A pasta {path} não foi encontrada. Verifique se o disco está conectado.
      </p>
      <div className="flex shrink-0 gap-2">
        <button
          type="button"
          className="rounded px-2 py-1 text-[14px] font-medium text-danger hover:bg-warning-accent"
          onClick={() => {
            if (folder) void removeFolder(folder.id);
          }}
        >
          Remover pasta
        </button>
        <button
          type="button"
          className="rounded px-2 py-1 text-[14px] font-medium text-brand hover:bg-warning-accent"
          onClick={() => {
            void rescan().catch((e) => push(String(e), "error"));
          }}
        >
          Tentar de novo
        </button>
      </div>
    </div>
  );
}
