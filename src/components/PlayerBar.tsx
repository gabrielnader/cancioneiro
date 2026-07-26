import { useRef, useState } from "react";
import { usePlayerAudio } from "../hooks/usePlayerAudio";
import { audioController } from "../hooks/playerAudioCore";
import { formatTime } from "../lib/formatTime";
import { usePlayerStore } from "../stores/playerStore";

/** Barra do player fixa no rodapé, 72px (F4). */
export function PlayerBar() {
  const audioRef = useRef<HTMLAudioElement>(null);
  usePlayerAudio(audioRef);

  const current = usePlayerStore((s) => s.current);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const volume = usePlayerStore((s) => s.volume);
  const setVolume = usePlayerStore((s) => s.setVolume);
  const togglePlayPause = usePlayerStore((s) => s.togglePlayPause);
  const next = usePlayerStore((s) => s.next);
  const previous = usePlayerStore((s) => s.previous);

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

  return (
    <footer className="flex h-[72px] shrink-0 items-center gap-4 bg-[#111827] px-4 text-[14px] text-[#F9FAFB]">
      <audio
        ref={audioRef}
        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
        onDurationChange={(e) => setDuration(e.currentTarget.duration)}
        data-testid="player-audio"
      />

      {/* capa genérica + título/artista */}
      <div className="flex w-56 min-w-0 items-center gap-3">
        <div
          aria-hidden="true"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-[#374151] text-[#9CA3AF]"
        >
          ♪
        </div>
        <div className="min-w-0">
          <p className="truncate font-medium">{current?.title ?? ""}</p>
          {current?.artist && (
            <p className="truncate text-[12px] text-[#9CA3AF]">{current.artist}</p>
          )}
        </div>
      </div>

      {/* controles + progresso */}
      <div className="flex min-w-0 flex-1 flex-col items-center gap-1">
        <div className="flex items-center gap-4">
          <button
            type="button"
            aria-label="Anterior"
            disabled={!current}
            className="text-[#F9FAFB] disabled:opacity-40"
            onClick={handlePrevious}
          >
            ⏮
          </button>
          <button
            type="button"
            aria-label={isPlaying ? "Pausar" : "Tocar"}
            disabled={!current}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-[#FFFFFF] text-[#111827] disabled:opacity-40"
            onClick={togglePlayPause}
          >
            {isPlaying ? "⏸" : "▶"}
          </button>
          <button
            type="button"
            aria-label="Próxima"
            disabled={!current}
            className="text-[#F9FAFB] disabled:opacity-40"
            onClick={() => next()}
          >
            ⏭
          </button>
        </div>
        <div className="flex w-full max-w-xl items-center gap-2">
          <span className="w-10 shrink-0 text-right text-[12px] text-[#9CA3AF]">
            {formatTime(currentTime)}
          </span>
          <div
            ref={progressRef}
            role="slider"
            aria-label="Progresso da música"
            aria-valuemin={0}
            aria-valuemax={Math.floor(duration) || 0}
            aria-valuenow={Math.floor(currentTime)}
            tabIndex={current ? 0 : -1}
            className="h-1.5 flex-1 cursor-pointer overflow-hidden rounded bg-[#374151]"
            onClick={handleSeek}
          >
            <div
              className="h-full bg-[#14B8A6]"
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className="w-10 shrink-0 text-[12px] text-[#9CA3AF]">
            {formatTime(duration)}
          </span>
        </div>
      </div>

      {/* volume */}
      <div className="flex w-40 shrink-0 items-center gap-2">
        <span aria-hidden="true" className="text-[#9CA3AF]">
          🔊
        </span>
        <input
          type="range"
          aria-label="Volume"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={(e) => setVolume(Number(e.target.value))}
          className="w-full accent-[#14B8A6]"
        />
      </div>
    </footer>
  );
}
