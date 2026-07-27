import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { audioController } from "../hooks/playerAudioCore";
import { getBackend, type EnrichApply, type EnrichProposal } from "../lib/api";
import { useEnrichStore } from "../stores/enrichStore";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlayerStore } from "../stores/playerStore";
import { usePlaylistStore } from "../stores/playlistStore";
import { useToastStore } from "../stores/toastStore";

/** Seleção inicial: ALTA pré-marcada; MÉDIA/BAIXA a cargo do humano. */
function defaultSelection(proposals: EnrichProposal[]): Set<number> {
  return new Set(
    proposals
      .filter((p) => p.error === null && p.confidence === "alta")
      .map((p) => p.song_id),
  );
}

const BADGES: Record<
  EnrichProposal["confidence"],
  { label: string; className: string }
> = {
  alta: { label: "ALTA", className: "bg-[#DCFCE7] text-[#166534]" },
  media: { label: "MÉDIA", className: "bg-[#FEF9C3] text-[#854D0E]" },
  baixa: { label: "BAIXA", className: "bg-[#F3F4F6] text-[#6B7280]" },
};

function nomeCompleto(title: string, artist: string | null): string {
  return artist ? `${title} — ${artist}` : title;
}

/**
 * Overlay de revisão do "Completar dados desta pasta" (F13 — PRD V5):
 * progresso da varredura, lista de propostas com confiança e checkboxes e
 * aplicação em lote (nunca renomeia, nunca apaga dados existentes).
 */
export function EnrichReview() {
  const status = useEnrichStore((s) => s.status);
  const overlayOpen = useEnrichStore((s) => s.overlayOpen);
  const progress = useEnrichStore((s) => s.progress);
  const proposals = useEnrichStore((s) => s.proposals);
  const close = useEnrichStore((s) => s.close);
  const hideOverlay = useEnrichStore((s) => s.hideOverlay);
  const push = useToastStore((s) => s.push);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  // erros devolvidos pelo apply, por música (linhas ficam como as com error)
  const [applyErrors, setApplyErrors] = useState<Map<number, string>>(new Map());
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // a varredura resolve com o overlay já aberto: re-inicializa a seleção
  useEffect(() => {
    setSelected(defaultSelection(proposals));
    setApplyErrors(new Map());
  }, [proposals]);

  const visible = status !== "idle" && overlayOpen;

  // foco inicial entra no diálogo (a primeira ação existe em todos os estados)
  useEffect(() => {
    if (visible) closeButtonRef.current?.focus();
  }, [visible, status]);

  // Esc SAI do overlay; exceto no meio de uma gravação (busy). Durante a
  // varredura sair é MANDAR PARA SEGUNDO PLANO (a busca é somente leitura —
  // cancelar exige o botão explícito); na revisão descarta as propostas.
  useEffect(() => {
    if (!visible) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape" || busy) return;
      if (useEnrichStore.getState().status === "scanning") {
        hideOverlay();
      } else {
        close();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [visible, busy, close, hideOverlay]);

  if (!visible) return null;

  /** Erro da linha: o da proposta (varredura) ou o devolvido pelo apply. */
  function rowError(p: EnrichProposal): string | null {
    return p.error ?? applyErrors.get(p.song_id) ?? null;
  }

  /** Focus trap mínimo: Tab no fim volta ao início (e vice-versa). */
  function trapTab(e: ReactKeyboardEvent) {
    if (e.key !== "Tab") return;
    const root = dialogRef.current;
    if (!root) return;
    const focusables = Array.from(
      root.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    } else if (e.shiftKey && (active === first || !root.contains(active))) {
      e.preventDefault();
      last.focus();
    }
  }

  const closeButton = (
    <button
      type="button"
      ref={closeButtonRef}
      disabled={busy}
      onClick={close}
      className="rounded-md px-4 py-2 text-[15px] font-medium text-[#374151] hover:bg-[#F3F4F6] disabled:opacity-60"
    >
      Fechar
    </button>
  );

  function toggle(songId: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(songId)) {
        next.delete(songId);
      } else {
        next.add(songId);
      }
      return next;
    });
  }

  async function handleApply() {
    const chosen = proposals.filter(
      (p) => rowError(p) === null && selected.has(p.song_id),
    );
    if (chosen.length === 0) return;

    // Se a música tocando está entre as selecionadas, pausa ANTES de gravar
    // (o MP3 é reescrito; espelha o EditSongForm — lock de arquivo no Windows).
    const player = usePlayerStore.getState();
    if (
      player.current &&
      player.isPlaying &&
      chosen.some((p) => p.song_id === player.current!.id)
    ) {
      player.setPlaying(false);
      audioController.pause();
    }

    // nunca-apaga: null = "não mexer"; temas não fazem parte das propostas F13
    const aplicacoes: EnrichApply[] = chosen.map((p) => ({
      song_id: p.song_id,
      title: p.proposed_title,
      artist: p.proposed_artist ?? null,
      lyrics: p.lyrics ?? null,
      add_temas: null,
    }));

    setBusy(true);
    try {
      // o lote nunca aborta: um resultado por música, gravadas E falhas
      const results = await getBackend().enrichApply(aplicacoes);
      const gravadas = results.filter((r) => r.song !== null);
      const falhas = results.filter((r) => r.song === null);

      // pós-save igual ao EditSongForm: library + playlists + player —
      // TODA música gravada sincroniza, mesmo quando outras falharam
      for (const r of gravadas) {
        useLibraryStore.getState().updateSong(r.song!);
        usePlaylistStore.getState().updateSongInItems(r.song!);
        usePlayerStore.getState().updateSongRefs(r.song!);
      }

      if (gravadas.length > 0) {
        push(
          gravadas.length === 1
            ? "1 música atualizada."
            : `${gravadas.length} músicas atualizadas.`,
          "success",
        );
      }
      if (falhas.length > 0) {
        push(
          falhas.length === 1
            ? "1 não pôde ser gravada."
            : `${falhas.length} não puderam ser gravadas.`,
          "error",
        );
      }

      if (gravadas.length > 0) {
        close();
      } else {
        // TODAS falharam: overlay aberto para o usuário ver as linhas —
        // marca cada uma com o erro devolvido e desmarca
        setApplyErrors((prev) => {
          const next = new Map(prev);
          for (const r of falhas) {
            next.set(r.song_id, r.error ?? "não foi possível gravar");
          }
          return next;
        });
        setSelected((prev) => {
          const next = new Set(prev);
          for (const r of falhas) next.delete(r.song_id);
          return next;
        });
      }
    } catch {
      // defensivo: invoke rejeitado (erro de infraestrutura, não por música)
      push("Não foi possível aplicar as alterações.", "error");
    } finally {
      setBusy(false);
    }
  }

  const counts = { alta: 0, media: 0, baixa: 0 };
  for (const p of proposals) counts[p.confidence]++;

  return (
    <div
      ref={dialogRef}
      onKeyDown={trapTab}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-label="Completar dados"
    >
      <div className="flex max-h-[calc(100vh-4rem)] w-[640px] max-w-[calc(100vw-2rem)] flex-col rounded-lg bg-white p-5 shadow-xl">
        {status === "scanning" ? (
          <>
            {progress === null ? (
              // antes do primeiro evento não dá para estimar nada
              <div className="flex items-center gap-3 py-4" role="status">
                <span
                  aria-hidden="true"
                  className="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-[#0F766E] border-t-transparent"
                />
                <p className="text-[15px] text-[#111827]">
                  Buscando dados… isso pode demorar alguns minutos.
                </p>
              </div>
            ) : (
              <div className="py-4" role="status">
                <p className="mb-1 text-[15px] text-[#111827]">
                  Buscando dados… {progress.done} de {progress.total}
                </p>
                <div
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={progress.total}
                  aria-valuenow={progress.done}
                  className="h-1.5 w-full overflow-hidden rounded bg-[#E5E7EB]"
                >
                  <div
                    className="h-full bg-[#0F766E] transition-[width]"
                    style={{
                      width:
                        progress.total > 0
                          ? `${(progress.done / progress.total) * 100}%`
                          : "0%",
                    }}
                  />
                </div>
                {/* nome do arquivo pode ser enorme: trunca em uma linha */}
                <p
                  title={progress.atual}
                  className="mt-1 truncate text-[13px] text-[#6B7280]"
                >
                  {progress.atual}
                </p>
              </div>
            )}
            {/* a varredura é somente leitura: sair dela NÃO é cancelar */}
            <div className="mt-2 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                ref={closeButtonRef}
                onClick={hideOverlay}
                className="rounded-md px-4 py-2 text-[15px] font-medium text-[#0F766E] hover:bg-[#F0FDFA]"
              >
                Deixar rodando em segundo plano
              </button>
              <button
                type="button"
                onClick={close}
                className="rounded-md px-4 py-2 text-[15px] font-medium text-[#374151] hover:bg-[#F3F4F6]"
              >
                Cancelar
              </button>
            </div>
          </>
        ) : proposals.length === 0 ? (
          <>
            <p className="py-4 text-[15px] text-[#111827]">
              Nada a ajustar nesta pasta.
            </p>
            <div className="mt-2 flex justify-end">{closeButton}</div>
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 pb-3">
              <h2 className="text-[16px] font-semibold text-[#111827]">
                {proposals.length} propostas — {counts.alta} alta,{" "}
                {counts.media} média, {counts.baixa} baixa
              </h2>
              <span className="ml-auto flex gap-2">
                <button
                  type="button"
                  onClick={() =>
                    setSelected(
                      new Set(
                        proposals
                          .filter((p) => rowError(p) === null)
                          .map((p) => p.song_id),
                      ),
                    )
                  }
                  className="rounded-md px-2 py-1 text-[13px] font-medium text-[#0F766E] hover:bg-[#F0FDFA]"
                >
                  Marcar todas
                </button>
                <button
                  type="button"
                  onClick={() => setSelected(new Set())}
                  className="rounded-md px-2 py-1 text-[13px] font-medium text-[#0F766E] hover:bg-[#F0FDFA]"
                >
                  Desmarcar todas
                </button>
              </span>
            </div>

            <ul className="min-h-0 flex-1 divide-y divide-[#F3F4F6] overflow-y-auto">
              {proposals.map((p) => {
                const error = rowError(p);
                const disabled = error !== null;
                const badge = BADGES[p.confidence];
                return (
                  <li
                    key={p.song_id}
                    className={`flex items-start gap-3 py-2 ${disabled ? "opacity-60" : ""}`}
                  >
                    <input
                      type="checkbox"
                      aria-label={`Aplicar proposta: ${p.current_title}`}
                      disabled={disabled || busy}
                      checked={!disabled && selected.has(p.song_id)}
                      onChange={() => toggle(p.song_id)}
                      className="mt-1 h-4 w-4 shrink-0 accent-[#0F766E]"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[14px]">
                        <span className="truncate text-[#6B7280]">
                          {nomeCompleto(p.current_title, p.current_artist)}
                        </span>
                        <span aria-hidden="true" className="text-[#9CA3AF]">
                          →
                        </span>
                        <span className="truncate font-medium text-[#111827]">
                          {nomeCompleto(p.proposed_title, p.proposed_artist)}
                        </span>
                      </span>
                      {error !== null ? (
                        <span className="block text-[13px] text-[#B91C1C]">
                          {error}
                        </span>
                      ) : (
                        p.lyrics !== null && (
                          <span className="block text-[13px] text-[#0F766E]">
                            letra encontrada
                          </span>
                        )
                      )}
                    </span>
                    <span
                      className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold ${badge.className}`}
                    >
                      {badge.label}
                    </span>
                  </li>
                );
              })}
            </ul>

            <div className="mt-4 flex shrink-0 items-center justify-end gap-2">
              {closeButton}
              <button
                type="button"
                disabled={busy || selected.size === 0}
                onClick={() => void handleApply()}
                className={`rounded-md px-4 py-2 text-[15px] font-medium text-white ${
                  busy || selected.size === 0
                    ? "bg-[#9CA3AF]"
                    : "bg-[#0F766E] hover:bg-[#115E59]"
                }`}
              >
                Aplicar selecionadas ({selected.size})
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
