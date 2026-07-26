import { hasSearchTokens } from "../lib/searchQuery";
import { useLibraryStore } from "../stores/libraryStore";
import { useToastStore } from "../stores/toastStore";
import { SearchBar } from "./SearchBar";
import { SongList } from "./SongList";
import { AddFolderButton } from "./AddFolderButton";

/** Coluna central: busca + lista (F1 UI / F2). */
export function LibraryView() {
  const results = useLibraryStore((s) => s.results);
  const query = useLibraryStore((s) => s.query);
  const folders = useLibraryStore((s) => s.folders);
  const missingFolders = useLibraryStore((s) => s.missingFolders);
  const scanning = useLibraryStore((s) => s.scanning);
  const libraryLoaded = useLibraryStore((s) => s.libraryLoaded);

  const isEmptyLibrary =
    libraryLoaded && folders.length === 0 && results.length === 0;
  // Query só de operadores/pontuação é tratada como campo vazio pelo backend
  const isRealSearch = hasSearchTokens(query);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-[#F9FAFB]">
      <div className="shrink-0 p-4 pb-2 pr-36">
        <SearchBar />
        {isRealSearch && !isEmptyLibrary && (
          <p className="mt-2 text-[13px] text-[#6B7280]">
            {results.length} resultados
          </p>
        )}
      </div>

      {missingFolders.map((path) => (
        <MissingFolderBanner key={path} path={path} />
      ))}

      {scanning && (
        <div className="mx-4 mb-2 shrink-0">
          <p className="mb-1 text-[13px] text-[#6B7280]">
            Indexando… {scanning.done} de {scanning.total} arquivos
          </p>
          <div className="h-1.5 w-full overflow-hidden rounded bg-[#E5E7EB]">
            <div
              className="h-full bg-[#0F766E] transition-[width]"
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
      ) : results.length === 0 && isRealSearch ? (
        <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
          <p className="text-[#6B7280]">
            Nenhuma música encontrada para "{query.trim()}".
          </p>
          <p className="mt-1 text-[#9CA3AF]">
            Tente palavras diferentes do trecho que você lembra.
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
      <h1 className="text-[22px] font-semibold text-[#111827]">
        Sua biblioteca está vazia
      </h1>
      <p className="mt-2 text-[#6B7280]">
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
    <div className="mx-4 mb-2 flex shrink-0 flex-wrap items-center gap-3 rounded-md bg-[#FEF3C7] px-4 py-3">
      <p className="min-w-0 flex-1 text-[14px] text-[#92400E]">
        A pasta {path} não foi encontrada. Verifique se o disco está conectado.
      </p>
      <div className="flex shrink-0 gap-2">
        <button
          type="button"
          className="rounded px-2 py-1 text-[14px] font-medium text-[#B91C1C] hover:bg-[#FDE68A]"
          onClick={() => {
            if (folder) void removeFolder(folder.id);
          }}
        >
          Remover pasta
        </button>
        <button
          type="button"
          className="rounded px-2 py-1 text-[14px] font-medium text-[#0F766E] hover:bg-[#FDE68A]"
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
