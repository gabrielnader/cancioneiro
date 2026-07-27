import { useEffect, useState } from "react";
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
  const proposals = useEnrichStore((s) => s.proposals);
  const close = useEnrichStore((s) => s.close);
  const push = useToastStore((s) => s.push);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);

  // a varredura resolve com o overlay já aberto: re-inicializa a seleção
  useEffect(() => {
    setSelected(defaultSelection(proposals));
  }, [proposals]);

  if (status === "idle") return null;

  const closeButton = (
    <button
      type="button"
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
      (p) => p.error === null && selected.has(p.song_id),
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
      const updated = await getBackend().enrichApply(aplicacoes);
      // pós-save igual ao EditSongForm: library + playlists + player
      for (const song of updated) {
        useLibraryStore.getState().updateSong(song);
        usePlaylistStore.getState().updateSongInItems(song);
        usePlayerStore.getState().updateSongRefs(song);
      }
      push(`${updated.length} músicas atualizadas.`, "success");
      close();
    } catch {
      push("Não foi possível aplicar as alterações.", "error");
    } finally {
      setBusy(false);
    }
  }

  const counts = { alta: 0, media: 0, baixa: 0 };
  for (const p of proposals) counts[p.confidence]++;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-label="Completar dados"
    >
      <div className="flex max-h-[calc(100vh-4rem)] w-[640px] max-w-[calc(100vw-2rem)] flex-col rounded-lg bg-white p-5 shadow-xl">
        {status === "scanning" ? (
          <>
            <div className="flex items-center gap-3 py-4" role="status">
              <span
                aria-hidden="true"
                className="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-[#0F766E] border-t-transparent"
              />
              <p className="text-[15px] text-[#111827]">
                Buscando dados… isso pode demorar alguns minutos.
              </p>
            </div>
            <div className="mt-2 flex justify-end">{closeButton}</div>
          </>
        ) : proposals.length === 0 ? (
          <>
            <p className="py-4 text-[15px] text-[#111827]">
              Nenhuma música incompleta nesta pasta.
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
                          .filter((p) => p.error === null)
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
                const disabled = p.error !== null;
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
                      {p.error !== null ? (
                        <span className="block text-[13px] text-[#B91C1C]">
                          {p.error}
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
