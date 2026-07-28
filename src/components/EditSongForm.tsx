import { useState } from "react";
import { audioController } from "../hooks/playerAudioCore";
import { getBackend, type EnrichProposal } from "../lib/api";
import { SEM_RESULTADO_INDIVIDUAL } from "../lib/curadoria";
import type { Song } from "../lib/types";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlayerStore } from "../stores/playerStore";
import { usePlaylistStore } from "../stores/playlistStore";
import { useToastStore } from "../stores/toastStore";
import { useUiStore } from "../stores/uiStore";

function basename(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath;
}

/** Rótulo de confiança, igual ao da revisão em lote (mesma linguagem). */
const BADGE_CONFIANCA: Record<EnrichProposal["confidence"], string> = {
  alta: "ALTA",
  media: "MÉDIA",
  baixa: "BAIXA",
};

const CLASSE_CONFIANCA: Record<EnrichProposal["confidence"], string> = {
  alta: "bg-[#DCFCE7] text-[#166534]",
  media: "bg-[#FEF9C3] text-[#854D0E]",
  baixa: "bg-[#F3F4F6] text-[#5B6472]",
};

/**
 * O que a busca do funil desta música devolveu. É estado da FICHA, não do
 * disco: nada aqui foi gravado — quem grava continua sendo "Salvar no
 * arquivo".
 */
type ResultadoBusca =
  | { tipo: "proposta"; proposta: EnrichProposal }
  | { tipo: "vazio" }
  | { tipo: "falha"; mensagem: string };

interface EditSongFormProps {
  song: Song;
  /** Letra atual (já carregada pelo painel); "" quando não há. */
  initialLyrics: string;
  /** Cancelar: descarta e volta ao modo leitura. */
  onCancel: () => void;
  /** Salvou com sucesso: sair da edição e re-exibir a letra. */
  onSaved: () => void;
}

/**
 * Formulário de edição de metadados no painel de letra (V4 — F10).
 * Grava tags via write_tags; "Buscar letra na internet" é o único ponto de
 * rede do app e falha graciosamente sem conexão.
 */
export function EditSongForm({
  song,
  initialLyrics,
  onCancel,
  onSaved,
}: EditSongFormProps) {
  const push = useToastStore((s) => s.push);
  const [title, setTitle] = useState(song.title);
  const [artist, setArtist] = useState(song.artist ?? "");
  const [temas, setTemas] = useState<string[]>(() =>
    (song.temas ?? "")
      .split(";")
      .map((t) => t.trim())
      .filter(Boolean),
  );
  const [temaInput, setTemaInput] = useState("");
  // V8/F17 — a marca de instrumental é escolha humana e viaja no MP3
  // (TXXX:INSTRUMENTAL). O editor é o único lugar do app que a desfaz, mas
  // só quando alguém MEXE no controle: `write_tags` recebe `undefined`
  // ("não mexer") enquanto ninguém tocou nele.
  //
  // Por que não basta mandar o estado do checkbox: a Song vem do banco, e o
  // banco pode estar atrasado em relação ao MP3 — a curadoria marcou o
  // arquivo com o app aberto, ou antes da varredura de inicialização. Aí o
  // controle nasce desmarcado sem que ninguém tenha desmarcado nada, e
  // salvar uma correção de título apagaria do arquivo uma marca feita à mão.
  // "Marcada à mão, nenhuma rotina desmarca sozinha" (PRD V8/F17).
  const [instrumental, setInstrumental] = useState(song.instrumental === true);
  const [instrumentalTocado, setInstrumentalTocado] = useState(false);
  const [lyrics, setLyrics] = useState(initialLyrics);
  const [titleError, setTitleError] = useState(false);
  const [busy, setBusy] = useState(false);
  // busy próprio da busca (V5 Q5): não trava Salvar/Cancelar
  const [fetchBusy, setFetchBusy] = useState(false);
  // V8/F18 — resultado do funil desta música, mostrado na própria ficha
  const [resultado, setResultado] = useState<ResultadoBusca | null>(null);

  /**
   * Confirma o texto pendente do input de tema como chip e devolve a lista
   * resultante — handleSave precisa dela na hora (setState é assíncrono).
   * BUG v0.4: tema digitado sem Enter era perdido ao salvar.
   */
  function commitTemaInput(): string[] {
    const tema = temaInput.trim();
    setTemaInput("");
    if (!tema || temas.some((t) => t.toLowerCase() === tema.toLowerCase())) {
      return temas;
    }
    const next = [...temas, tema];
    setTemas(next);
    return next;
  }

  /**
   * V8/F18 — o funil inteiro nesta música (o "caso pontual" do PRD).
   *
   * Substituiu o "Buscar letra na internet" da V4, que consultava só o LRCLIB
   * e só sabia trazer letra. Dois botões dizendo "buscar na internet", com a
   * diferença invisível para quem não sabe o que é LRCLIB, seriam uma escolha
   * às cegas — e a escolha errada é silenciosamente pior. Este botão faz tudo
   * o que o antigo fazia e mais: passa pelas três etapas, diz de onde veio o
   * dado e também corrige título e artista.
   *
   * A busca NÃO grava e NÃO preenche nada sozinha: o resultado aparece na
   * ficha, com procedência e confiança, e só entra no formulário se a pessoa
   * mandar (mesma regra do lote — nada é aplicado sem revisão).
   */
  async function handleBuscarDados() {
    setFetchBusy(true);
    setResultado(null);
    try {
      const proposta = await getBackend().enrichSongScan(
        song.id,
        useUiStore.getState().vagalumeApiKey || null,
      );
      setResultado(proposta ? { tipo: "proposta", proposta } : { tipo: "vazio" });
    } catch {
      // o resultado é inline: um toast some sozinho e esta é a única
      // explicação que a pessoa vai receber — não há suporte para perguntar
      setResultado({
        tipo: "falha",
        mensagem: "Sem conexão — a busca de dados precisa de internet.",
      });
    } finally {
      setFetchBusy(false);
    }
  }

  /** Traz a proposta para o formulário (ainda sem tocar no arquivo). */
  function usarProposta(p: EnrichProposal) {
    if (
      p.lyrics !== null &&
      lyrics.trim() &&
      // copy mantida da V4: é a pergunta que as pessoas já conhecem
      !window.confirm("Substituir a letra atual pelo resultado da busca?")
    ) {
      return;
    }
    if (p.proposed_title.trim()) setTitle(p.proposed_title);
    if (p.proposed_artist?.trim()) setArtist(p.proposed_artist);
    if (p.lyrics !== null) setLyrics(p.lyrics);
    setResultado(null);
  }

  async function handleSave() {
    // tema digitado e não confirmado com Enter conta como se tivesse dado
    // Enter (BUG v0.4) — inclusive quando o título inválido aborta o save.
    const finalTemas = commitTemaInput();

    if (!title.trim()) {
      setTitleError(true);
      return;
    }
    setTitleError(false);

    // Se a música em edição está tocando, pausa ANTES de gravar (o arquivo
    // pode estar em uso no Windows) e mantém pausado depois (PRD V4).
    // audioController.pause age direto no elemento — sem esperar re-render,
    // fechando a janela de corrida entre o pause e o write no disco.
    const player = usePlayerStore.getState();
    if (player.current?.id === song.id && player.isPlaying) {
      player.setPlaying(false);
      audioController.pause();
    }

    setBusy(true);
    try {
      const saved = await getBackend().writeTags(
        song.id,
        title.trim(),
        artist.trim() ? artist.trim() : null,
        lyrics.trim() ? lyrics : null,
        finalTemas.length > 0 ? finalTemas.join("; ") : null,
        // três estados (V8/F17): undefined = "não mexer na marca"
        instrumentalTocado ? instrumental : undefined,
      );
      useLibraryStore.getState().updateSong(saved);
      usePlaylistStore.getState().updateSongInItems(saved);
      usePlayerStore.getState().updateSongRefs(saved);
      push(`Alterações salvas em ${basename(song.file_path)}.`, "success");
      onSaved();
    } catch {
      push(`Não foi possível salvar em ${basename(song.file_path)}.`, "error");
    } finally {
      setBusy(false);
    }
  }

  const inputClass = (error: boolean) =>
    `w-full rounded-md border bg-white px-3 py-2 text-[15px] text-[#111827] outline-none ${
      error
        ? "border-[#B91C1C]"
        : "border-[#D1D5DB] focus:border-[#0F766E]"
    }`;

  return (
    <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
      <div>
        <label
          htmlFor="edit-titulo"
          className="mb-1 block text-[13px] font-medium text-[#374151]"
        >
          Título
        </label>
        <input
          id="edit-titulo"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className={inputClass(titleError)}
        />
        {titleError && (
          <p className="mt-1 text-[13px] text-[#B91C1C]">
            Dê um título à música.
          </p>
        )}
      </div>

      <div>
        <label
          htmlFor="edit-artista"
          className="mb-1 block text-[13px] font-medium text-[#374151]"
        >
          Artista
        </label>
        <input
          id="edit-artista"
          type="text"
          value={artist}
          onChange={(e) => setArtist(e.target.value)}
          className={inputClass(false)}
        />
      </div>

      <div>
        <p className="mb-1 text-[13px] font-medium text-[#374151]">Temas</p>
        <div className="flex flex-wrap items-center gap-1.5">
          {temas.map((tema) => (
            <span
              key={tema}
              className="inline-flex max-w-40 items-center gap-1 rounded-full bg-[#F0FDFA] px-2 py-0.5 text-[12px] text-[#0F766E]"
            >
              <span className="truncate">{tema}</span>
              <button
                type="button"
                aria-label={`Remover tema ${tema}`}
                className="shrink-0 rounded-full px-0.5 hover:bg-[#ccfbf1]"
                onClick={() => setTemas(temas.filter((t) => t !== tema))}
              >
                ×
              </button>
            </span>
          ))}
          <input
            type="text"
            value={temaInput}
            placeholder="Adicionar tema"
            aria-label="Adicionar tema"
            onChange={(e) => setTemaInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitTemaInput();
              }
            }}
            // sair do campo confirma o tema pendente como chip (BUG v0.4)
            onBlur={commitTemaInput}
            className="min-w-28 flex-1 rounded-md border border-[#D1D5DB] bg-white px-2 py-1 text-[13px] text-[#111827] outline-none placeholder:text-[#9CA3AF] focus:border-[#0F766E]"
          />
        </div>
      </div>

      {/*
        V8/F17 — fica junto da letra porque é dela que a pessoa está falando:
        "não tem letra porque não tem voz". Marcar aqui tira a música das
        varreduras de letra e troca o selo "Sem letra" por "Instrumental".
      */}
      <div>
        <label
          htmlFor="edit-instrumental"
          className="flex items-center gap-2 text-[14px] text-[#374151]"
        >
          <input
            id="edit-instrumental"
            type="checkbox"
            checked={instrumental}
            onChange={(e) => {
              setInstrumental(e.target.checked);
              setInstrumentalTocado(true);
            }}
            className="h-4 w-4 accent-[#0F766E]"
          />
          Esta música é instrumental
        </label>
      </div>

      <div className="flex min-h-32 flex-1 flex-col">
        <label
          htmlFor="edit-letra"
          className="mb-1 block text-[13px] font-medium text-[#374151]"
        >
          Letra
        </label>
        <textarea
          id="edit-letra"
          value={lyrics}
          onChange={(e) => setLyrics(e.target.value)}
          className="w-full flex-1 resize-none rounded-md border border-[#D1D5DB] bg-white px-3 py-2 text-[15px] leading-relaxed text-[#111827] outline-none focus:border-[#0F766E]"
        />
      </div>

      {/*
        V8/F18 — o resultado do funil desta música, na própria ficha. Fica
        acima dos botões, entre a letra e a ação: é o que a pessoa precisa ler
        antes de decidir. Nada daqui foi para o disco.
      */}
      {resultado && (
        <div
          role="status"
          className="shrink-0 rounded-md border border-[#E5E7EB] bg-[#F9FAFB] p-3"
        >
          {resultado.tipo === "vazio" ? (
            <p className="text-[13px] leading-relaxed text-[#374151]">
              {SEM_RESULTADO_INDIVIDUAL}
            </p>
          ) : resultado.tipo === "falha" ? (
            <p className="text-[13px] text-[#B91C1C]">{resultado.mensagem}</p>
          ) : resultado.proposta.error !== null ? (
            <p className="text-[13px] text-[#B91C1C]">{resultado.proposta.error}</p>
          ) : (
            <>
              <p className="flex flex-wrap items-center gap-2 text-[13px] text-[#5B6472]">
                <span
                  className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${
                    CLASSE_CONFIANCA[resultado.proposta.confidence]
                  }`}
                >
                  {BADGE_CONFIANCA[resultado.proposta.confidence]}
                </span>
                <span>via {resultado.proposta.fonte}</span>
                {resultado.proposta.lyrics !== null && (
                  <span className="text-[#0F766E]">letra encontrada</span>
                )}
              </p>
              <dl className="mt-2 space-y-0.5 text-[13px]">
                <div className="flex gap-2">
                  <dt className="shrink-0 text-[#5B6472]">Título:</dt>
                  <dd className="min-w-0 break-words text-[#111827]">
                    {resultado.proposta.proposed_title}
                  </dd>
                </div>
                {resultado.proposta.proposed_artist && (
                  <div className="flex gap-2">
                    <dt className="shrink-0 text-[#5B6472]">Artista:</dt>
                    <dd className="min-w-0 break-words text-[#111827]">
                      {resultado.proposta.proposed_artist}
                    </dd>
                  </div>
                )}
              </dl>
              <p className="mt-2 text-[13px] text-[#5B6472]">
                Nada foi gravado ainda: use os dados, confira, e só então salve
                no arquivo.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => usarProposta(resultado.proposta)}
                  className="rounded-md bg-[#0F766E] px-3 py-1.5 text-[14px] font-medium text-white hover:bg-[#115E59]"
                >
                  Usar estes dados
                </button>
                <button
                  type="button"
                  onClick={() => setResultado(null)}
                  className="rounded-md px-3 py-1.5 text-[14px] font-medium text-[#374151] hover:bg-[#F3F4F6]"
                >
                  Descartar
                </button>
              </div>
            </>
          )}
        </div>
      )}

      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={fetchBusy}
          title="Procura título, artista e letra desta música: primeiro no próprio arquivo, depois no LRCLIB e no Vagalume"
          onClick={() => void handleBuscarDados()}
          className="rounded-md border border-[#0F766E] px-3 py-1.5 text-[14px] font-medium text-[#0F766E] hover:bg-[#F0FDFA] disabled:opacity-60"
        >
          {fetchBusy ? "Buscando…" : "Buscar dados na internet"}
        </button>
        <span className="ml-auto flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 text-[14px] font-medium text-[#374151] hover:bg-[#F3F4F6] disabled:opacity-60"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleSave()}
            className="rounded-md bg-[#0F766E] px-3 py-1.5 text-[14px] font-medium text-white hover:bg-[#115E59] disabled:opacity-60"
          >
            Salvar no arquivo
          </button>
        </span>
      </div>
    </div>
  );
}
