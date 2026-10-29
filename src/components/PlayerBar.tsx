import { useRef, useState } from "react";
import { usePlayerAudio } from "../hooks/usePlayerAudio";
import { audioController } from "../hooks/playerAudioCore";
import { formatTime } from "../lib/formatTime";
import { playSelectedOrToggle } from "../lib/playbackActions";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlayerStore } from "../stores/playerStore";

/**
 * Barra do player fixa no rodapé (F4).
 *
 * V15 — maior, e nas cores do tema. Botões do tamanho de um dedo (o de tocar
 * com 64px), barra de progresso grossa e nomes legíveis: é o controle que se
 * usa no meio de uma reunião, com pressa e sem óculos. A barra escura fixa
 * (`--playerbar-*`) saiu: no tema claro ela era a única peça escura da tela,
 * e chamava mais atenção que a busca.
 */
export function PlayerBar() {
  const audioRef = useRef<HTMLAudioElement>(null);
  usePlayerAudio(audioRef);

  const current = usePlayerStore((s) => s.current);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const volume = usePlayerStore((s) => s.volume);
  const setVolume = usePlayerStore((s) => s.setVolume);
  const next = usePlayerStore((s) => s.next);
  const previous = usePlayerStore((s) => s.previous);
  const hasSelection = useLibraryStore((s) => s.selectedSongId !== null);

  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const progressRef = useRef<HTMLDivElement>(null);

  function handleSeek(e: React.MouseEvent<HTMLDivElement>) {
    const el = progressRef.current;
    if (!el || !duration) return;
    const rect = el.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    audioController.seekTo(ratio * duration);
    setCurrentTime(ratio * duration);
  }

  function handlePrevious() {
    const action = previous(audioController.getCurrentTime());
    if (action === "restart") {
      audioController.seekTo(0);
    }
  }

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  const botaoLateral =
    "flex h-12 w-12 shrink-0 items-center justify-center rounded-full border-2 border-border-strong bg-surface text-ink hover:bg-surface-hover disabled:opacity-40";

  return (
    <footer className="flex shrink-0 flex-wrap items-center gap-x-6 gap-y-2 border-t border-border bg-surface px-6 py-3 text-ink max-lg:gap-x-4 max-lg:px-4 max-lg:py-2 baixa:py-1.5">
      <audio
        ref={audioRef}
        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
        onDurationChange={(e) => setDuration(e.currentTarget.duration)}
        data-testid="player-audio"
      />

      {/* controles: a música tocando nunca sai da tela, e eles também não */}
      <div className="flex shrink-0 items-center gap-3">
        <button
          type="button"
          aria-label="Anterior"
          disabled={!current}
          className={botaoLateral}
          onClick={handlePrevious}
        >
          <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="3" height="14" rx="1" /><path d="M19 5.5v13a1 1 0 0 1-1.5.9L9 13.7a1 1 0 0 1 0-1.7l8.5-5.7a1 1 0 0 1 1.5.9Z" /></svg>
        </button>
        <button
          type="button"
          aria-label={isPlaying ? "Pausar" : "Tocar"}
          disabled={!current && !hasSelection}
          className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-brand-fill text-white hover:bg-brand-fill-hover disabled:bg-disabled baixa:h-14 baixa:w-14"
          onClick={playSelectedOrToggle}
        >
          {isPlaying ? (
            <svg aria-hidden="true" width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
          ) : (
            <svg aria-hidden="true" width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.9l10-6.5a1 1 0 0 0 0-1.7l-10-6.5A1 1 0 0 0 8 5.5Z" /></svg>
          )}
        </button>
        <button
          type="button"
          aria-label="Próxima"
          disabled={!current}
          className={botaoLateral}
          onClick={() => next()}
        >
          <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="16" y="5" width="3" height="14" rx="1" /><path d="M5 5.5v13a1 1 0 0 0 1.5.9l8.5-5.7a1 1 0 0 0 0-1.7L6.5 6.3A1 1 0 0 0 5 5.5Z" /></svg>
        </button>
      </div>

      {/* o que está tocando + progresso */}
      <div className="flex min-w-[220px] flex-1 flex-col gap-1.5 baixa:gap-0.5">
        <p className="flex min-w-0 items-baseline gap-3 truncate">
          <span className="truncate text-[18px] font-bold">
            {current?.title ?? "Nenhuma música tocando"}
          </span>
          {current?.artist && (
            <span className="truncate text-[16px] text-ink-secondary">{current.artist}</span>
          )}
        </p>
        <div className="flex w-full items-center gap-3">
          <span className="w-11 shrink-0 text-right text-[15px] tabular-nums text-ink-secondary">
            {formatTime(currentTime)}
          </span>
          {/* a área de clique é maior que a barra desenhada: acertar 10px
              de altura com o mouse é exigir mira */}
          <div
            ref={progressRef}
            role="slider"
            aria-label="Progresso da música"
            aria-valuemin={0}
            aria-valuemax={Math.floor(duration) || 0}
            aria-valuenow={Math.floor(currentTime)}
            tabIndex={current ? 0 : -1}
            className="flex h-6 flex-1 cursor-pointer items-center"
            onClick={handleSeek}
          >
            <div className="h-2.5 w-full overflow-hidden rounded-full bg-border">
              <div
                className="h-full bg-brand"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
          <span className="w-11 shrink-0 text-[15px] tabular-nums text-ink-secondary">
            {formatTime(duration)}
          </span>
        </div>
      </div>

      {/* volume — some quando falta espaço: o do computador continua valendo */}
      <div className="flex w-44 shrink-0 items-center gap-2 max-lg:baixa:hidden">
        <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-ink-secondary"><path d="M11 5 6 9H3v6h3l5 4Z" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M18.5 5.5a9 9 0 0 1 0 13" /></svg>
        <input
          type="range"
          aria-label="Volume"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={(e) => setVolume(Number(e.target.value))}
          className="h-6 w-full accent-brand"
        />
      </div>
    </footer>
  );
}
