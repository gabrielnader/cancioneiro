import { useEffect, useState } from "react";
import { getBackend } from "../lib/api";
import { getAppVersion } from "../lib/updater";
import { useLibraryStore } from "../stores/libraryStore";
import { useToastStore } from "../stores/toastStore";
import { useUiStore } from "../stores/uiStore";
import { AddFolderButton } from "./AddFolderButton";
import { ConfirmDialog } from "./ConfirmDialog";

/** Configurações (F1): pastas observadas, remover, reindexar. (V7/F16: atualização.) */
export function SettingsView() {
  const folders = useLibraryStore((s) => s.folders);
  const removeFolder = useLibraryStore((s) => s.removeFolder);
  const rescan = useLibraryStore((s) => s.rescan);
  const setScanning = useLibraryStore((s) => s.setScanning);
  const scanning = useLibraryStore((s) => s.scanning);
  const push = useToastStore((s) => s.push);
  const [confirmingFolderId, setConfirmingFolderId] = useState<number | null>(null);
  const checkUpdatesOnStart = useUiStore((s) => s.checkUpdatesOnStart);
  const setCheckUpdatesOnStart = useUiStore((s) => s.setCheckUpdatesOnStart);
  const [appVersion, setAppVersion] = useState<string | null>(null);

  // Versão vinda do próprio app (nunca uma string no código) — null no modo
  // web, onde a linha simplesmente não aparece.
  useEffect(() => {
    let alive = true;
    void getAppVersion().then((v) => {
      if (alive) setAppVersion(v);
    });
    return () => {
      alive = false;
    };
  }, []);

  async function handleRescan() {
    const unlisten = await getBackend().onScanProgress((p) =>
      setScanning({ done: p.done, total: p.total }),
    );
    try {
      const result = await rescan();
      push(`${result.total} músicas indexadas.`, "success");
    } catch (e) {
      push(String(e), "error");
    } finally {
      setScanning(null);
      unlisten();
    }
  }

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto bg-[#F9FAFB] p-6 pr-36">
      <h1 className="text-[22px] font-semibold text-[#111827]">Configurações</h1>

      <section className="mt-6">
        <h2 className="text-[15px] font-medium text-[#111827]">
          Pastas de música
        </h2>
        {folders.length === 0 ? (
          <p className="mt-2 text-[#6B7280]">Nenhuma pasta adicionada.</p>
        ) : (
          <ul className="mt-2 divide-y divide-[#E5E7EB] rounded-md border border-[#E5E7EB] bg-white">
            {folders.map((f) => (
              <li
                key={f.id}
                className="flex items-center justify-between gap-4 px-4 py-2.5"
              >
                <span className="min-w-0 truncate text-[#111827]">{f.path}</span>
                <button
                  type="button"
                  className="shrink-0 rounded px-2 py-1 text-[14px] font-medium text-[#B91C1C] hover:bg-[#FEE2E2]"
                  onClick={() => setConfirmingFolderId(f.id)}
                >
                  Remover
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4 flex gap-3">
          <AddFolderButton variant="outline" />
          <button
            type="button"
            disabled={scanning !== null}
            className="rounded-md border border-[#0F766E] bg-transparent px-4 py-2 text-[15px] font-medium text-[#0F766E] hover:bg-[#F0FDFA] disabled:opacity-50"
            onClick={() => void handleRescan()}
          >
            Reindexar tudo
          </button>
        </div>
        {scanning && (
          <div className="mt-4 max-w-md">
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
      </section>

      <section className="mt-8">
        <h2 className="text-[15px] font-medium text-[#111827]">Atualizações</h2>
        <label className="mt-2 flex max-w-md items-start gap-3">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 accent-[#0F766E]"
            checked={checkUpdatesOnStart}
            onChange={(e) => setCheckUpdatesOnStart(e.target.checked)}
          />
          <span>
            <span className="text-[#111827]">
              Verificar atualizações ao abrir
            </span>
            <span className="mt-0.5 block text-[13px] text-[#6B7280]">
              Consulta apenas se existe uma versão nova. Nada do seu acervo sai
              do computador. Desligado, o Cancioneiro não acessa a internet ao
              abrir.
            </span>
          </span>
        </label>
        {appVersion && (
          <p className="mt-4 text-[13px] text-[#6B7280]">
            Versão instalada: {appVersion}
          </p>
        )}
      </section>

      <ConfirmDialog
        open={confirmingFolderId !== null}
        title="Remover esta pasta da biblioteca? Os arquivos não serão apagados do disco."
        confirmLabel="Remover"
        onCancel={() => setConfirmingFolderId(null)}
        onConfirm={() => {
          if (confirmingFolderId !== null) {
            void removeFolder(confirmingFolderId);
          }
          setConfirmingFolderId(null);
        }}
      />
    </div>
  );
}
