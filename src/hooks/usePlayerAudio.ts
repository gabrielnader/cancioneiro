import { useEffect, type RefObject } from "react";
import { usePlayerStore } from "../stores/playerStore";
import { useToastStore } from "../stores/toastStore";
import { audioController, loadCurrentIntoAudio } from "./playerAudioCore";

/**
 * Liga o elemento <audio> ao playerStore: carga da faixa, play/pause, volume,
 * fim de faixa (avanço automático em playlist) e erros de decodificação.
 */
export function usePlayerAudio(audioRef: RefObject<HTMLAudioElement | null>) {
  const currentId = usePlayerStore((s) => s.current?.id ?? null);
  const playRequestId = usePlayerStore((s) => s.playRequestId);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const volume = usePlayerStore((s) => s.volume);

  // Carrega a faixa quando muda (ou quando há novo pedido explícito de play)
  useEffect(() => {
    const audio = audioRef.current;
    const song = usePlayerStore.getState().current;
    if (!audio || !song) return;
    void loadCurrentIntoAudio(audio, song);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId, playRequestId]);

  // Play/pause
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !audio.src) return;
    if (isPlaying) {
      audio.play().catch((e) => {
        console.error("[player] play() falhou:", e);
      });
    } else {
      audio.pause();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying]);

  // Volume (persistido)
  useEffect(() => {
    const audio = audioRef.current;
    if (audio) audio.volume = volume;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [volume]);

  // Eventos do elemento + controlador global de seek
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onEnded = () => usePlayerStore.getState().onEnded();
    const onError = () => {
      // erros disparados sem src carregado não interessam
      if (!audio.src) return;
      console.error("[player] erro de mídia:", audio.error);
      useToastStore
        .getState()
        .push("Não foi possível reproduzir este arquivo.", "error");
      usePlayerStore.getState().setPlaying(false);
    };
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("error", onError);

    audioController.seekTo = (seconds) => {
      audio.currentTime = Math.max(0, seconds);
    };
    audioController.seekBy = (delta) => {
      audio.currentTime = Math.max(0, audio.currentTime + delta);
    };
    audioController.getCurrentTime = () => audio.currentTime;

    return () => {
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
      audioController.seekTo = () => {};
      audioController.seekBy = () => {};
      audioController.getCurrentTime = () => 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
