import { useEffect, useState } from "react";
import { getBackend } from "../lib/api";
import type { SituacaoDoArquivo, Song } from "../lib/types";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlayerStore } from "../stores/playerStore";
import { usePlaylistStore } from "../stores/playlistStore";

/** Como a frase chama o que o arquivo é por dentro. */
function nomeDoFormato(s: SituacaoDoArquivo): string {
  return s.conteudo === "mp4" ? "M4A" : "WAV";
}

/** O que o conserto faz com o som, na língua de quem vai aprovar. */
export function textoDoConserto(s: SituacaoDoArquivo): string {
  return s.recodifica
    ? "Consertar transforma o som em MP3. A diferença é muito pequena, e o original fica guardado na pasta do app: dá para voltar atrás."
    : "Consertar só tira o som de dentro do WAV, sem mudar nada nele. O original fica guardado na pasta do app: dá para voltar atrás.";
}

function atualizar(song: Song) {
  useLibraryStore.getState().updateSong(song);
  usePlaylistStore.getState().updateSongInItems(song);
  usePlayerStore.getState().updateSongRefs(song);
}

/**
 * V16.4 — nos detalhes da música: o arquivo com nome de MP3 que por dentro é
 * WAV ou M4A não aceita gravação, e aqui a pessoa aprova o conserto. Depois de
 * consertado, o "Voltar ao som original".
 */
export function ConsertarArquivo({ song }: { song: Song }) {
  const [situacao, setSituacao] = useState<SituacaoDoArquivo | null>(null);
  const [confirmando, setConfirmando] = useState<"consertar" | "voltar" | null>(null);
  const [trabalhando, setTrabalhando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    // backend sem a função (testes antigos) = MP3 de verdade: nada a mostrar
    Promise.resolve()
      .then(() => getBackend().situacaoDoArquivo(song.id))
      .then((s) => vivo && setSituacao(s))
      .catch(() => vivo && setSituacao(null));
    return () => {
      vivo = false;
    };
  }, [song.id]);

  async function fazer(acao: "consertar" | "voltar") {
    setTrabalhando(true);
    setErro(null);
    try {
      const b = getBackend();
      const nova = acao === "consertar" ? await b.consertarArquivo(song.id) : await b.voltarAoSomOriginal(song.id);
      atualizar(nova);
      setSituacao(await b.situacaoDoArquivo(song.id));
      setConfirmando(null);
    } catch (e) {
      setErro(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setTrabalhando(false);
    }
  }

  if (!situacao) return null;

  const botao =
    "rounded-lg px-3 py-1.5 text-[15px] font-semibold disabled:opacity-60";

  if (situacao.conteudo !== "mp3") {
    return (
      <div data-testid="consertar-arquivo" className="mb-4 rounded-lg border-2 border-warning bg-warning-soft px-3 py-3">
        <p className="text-[15px] font-semibold text-ink">Este arquivo não aceita gravação</p>
        <p className="mt-1 text-[15px] text-ink-secondary">
          Ele tem nome de MP3, mas por dentro é um {nomeDoFormato(situacao)}. Por isso o app não consegue gravar
          nome, letra nem anotação nele.
        </p>
        <p className="mt-1 text-[15px] text-ink-secondary">{textoDoConserto(situacao)}</p>
        {confirmando === "consertar" ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-[15px] text-ink">Consertar este arquivo agora?</span>
            <button
              type="button"
              disabled={trabalhando}
              onClick={() => void fazer("consertar")}
              className={`${botao} bg-brand-fill text-white hover:bg-brand-fill-hover`}
            >
              {trabalhando ? "Consertando…" : "Sim, consertar"}
            </button>
            <button
              type="button"
              disabled={trabalhando}
              onClick={() => setConfirmando(null)}
              className={`${botao} text-ink-secondary hover:bg-surface-hover`}
            >
              Cancelar
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmando("consertar")}
            className={`${botao} mt-2 bg-brand-fill text-white hover:bg-brand-fill-hover`}
          >
            Consertar o arquivo
          </button>
        )}
        {erro && (
          <p role="alert" className="mt-2 text-[14px] text-danger">
            Não deu para consertar: {erro}
          </p>
        )}
      </div>
    );
  }

  if (!situacao.original_guardado) return null;

  return (
    <div data-testid="original-guardado" className="mb-3 text-[14px] text-ink-secondary">
      {confirmando === "voltar" ? (
        <div className="flex flex-col gap-2 rounded-lg bg-surface-hover px-3 py-2">
          <span className="text-[15px] text-ink">
            O arquivo volta a ser como era antes do conserto. O que foi gravado nele depois (nome, letra, anotação)
            se perde. Voltar mesmo assim?
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={trabalhando}
              onClick={() => void fazer("voltar")}
              className={`${botao} bg-brand-fill text-white hover:bg-brand-fill-hover`}
            >
              {trabalhando ? "Voltando…" : "Sim, voltar"}
            </button>
            <button
              type="button"
              disabled={trabalhando}
              onClick={() => setConfirmando(null)}
              className={`${botao} text-ink-secondary hover:bg-surface-hover`}
            >
              Cancelar
            </button>
          </div>
        </div>
      ) : (
        <>
          Este arquivo foi consertado.{" "}
          <button
            type="button"
            onClick={() => setConfirmando("voltar")}
            className="rounded px-1 font-medium text-brand hover:bg-brand-soft"
          >
            Voltar ao som original
          </button>
        </>
      )}
      {erro && (
        <p role="alert" className="mt-2 text-[14px] text-danger">
          Não deu para voltar: {erro}
        </p>
      )}
    </div>
  );
}
