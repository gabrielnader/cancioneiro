import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { audioController } from "../hooks/playerAudioCore";
import { getBackend, type EnrichApply, type EnrichProposal } from "../lib/api";
import {
  LABEL_SUBSTITUIR_LETRA,
  avisoLetraExistente,
  textoAplicado,
  textoSemPropostas,
} from "../lib/curadoria";
import { useEnrichStore } from "../stores/enrichStore";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlayerStore } from "../stores/playerStore";
import { usePlaylistStore } from "../stores/playlistStore";
import { useToastStore } from "../stores/toastStore";

/**
 * Seleção inicial: ALTA pré-marcada; MÉDIA/BAIXA a cargo do humano.
 *
 * A pré-marcação continua (DECISIONS #49) PORQUE ela agora só aplica NOMES:
 * a letra que passaria por cima de uma letra existente depende de uma segunda
 * marcação, separada e sempre desmarcada (ver `substituiriaLetra`). Era essa
 * combinação — ALTA pré-marcada + letra embutida na mesma marcação — que
 * apagava uma transcrição corrigida à mão com um clique.
 */
function defaultSelection(
  proposals: EnrichProposal[],
  applyErrors: Record<number, string>,
): Set<number> {
  return new Set(
    proposals
      .filter(
        (p) =>
          p.error === null &&
          applyErrors[p.song_id] === undefined &&
          p.confidence === "alta",
      )
      .map((p) => p.song_id),
  );
}

/**
 * A recusa do backend quando falta consentimento cita, textualmente, o rótulo
 * da marcação. É por esse texto que a UI reconhece o caso: o banco pode estar
 * atrasado em relação ao arquivo (alguém escreveu a letra à mão DURANTE a
 * varredura), e aí quem sabe da verdade é o backend, não a proposta.
 */
function erroPedeConsentimento(erro: string | null): boolean {
  if (erro === null) return false;
  return erro.toLowerCase().includes(LABEL_SUBSTITUIR_LETRA.toLowerCase());
}

/** Esta linha gravaria letra NOVA por cima de uma letra que já existe? */
function substituiriaLetra(p: EnrichProposal, erro: string | null): boolean {
  if (p.lyrics === null) return false;
  return p.has_lyrics || erroPedeConsentimento(erro);
}

const BADGES: Record<
  EnrichProposal["confidence"],
  { label: string; className: string }
> = {
  alta: { label: "ALTA", className: "bg-[#DCFCE7] text-[#166534]" },
  media: { label: "MÉDIA", className: "bg-[#FEF9C3] text-[#854D0E]" },
  // #6B7280 sobre #F3F4F6 dava 4,39:1 — abaixo de AA. #5B6472 dá 5,44:1
  // (DECISIONS #69: contraste mínimo vale para texto secundário também).
  baixa: { label: "BAIXA", className: "bg-[#F3F4F6] text-[#5B6472]" },
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
  const scannedTotal = useEnrichStore((s) => s.scannedTotal);
  // erros devolvidos pelo apply, por música (linhas ficam como as com error)
  const applyErrors = useEnrichStore((s) => s.applyErrors);
  const close = useEnrichStore((s) => s.close);
  const hideOverlay = useEnrichStore((s) => s.hideOverlay);
  const retainFailures = useEnrichStore((s) => s.retainFailures);
  const push = useToastStore((s) => s.push);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  /**
   * Consentimento POR LINHA para trocar uma letra que já existe. Vive separado
   * de `selected` de propósito: aplicar a linha e destruir a letra são duas
   * decisões diferentes, e só uma delas é reversível.
   */
  const [substituir, setSubstituir] = useState<Set<number>>(new Set());
  /**
   * Recusas de consentimento que a pessoa acabou de resolver marcando a
   * substituição: a linha volta a ser aplicável sem esperar nova varredura.
   */
  const [consentidos, setConsentidos] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  /** Único texto lido por leitor de tela: só transições, nunca cada arquivo. */
  const [anuncio, setAnuncio] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  // a varredura resolve com o overlay já aberto: re-inicializa a seleção
  useEffect(() => {
    setSelected(defaultSelection(proposals, applyErrors));
    setSubstituir(new Set());
    setConsentidos(new Set());
  }, [proposals, applyErrors]);

  const visible = status !== "idle" && overlayOpen;

  // M7: guarda quem tinha o foco ANTES do overlay e devolve ao sair (fechar,
  // Esc ou mandar para segundo plano) — antes o foco caía no <body>.
  useEffect(() => {
    if (!visible) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    return () => {
      const anterior = previouslyFocused.current;
      previouslyFocused.current = null;
      // o elemento pode ter saído do DOM enquanto o overlay estava aberto
      if (anterior?.isConnected && typeof anterior.focus === "function") {
        anterior.focus();
      }
    };
  }, [visible]);

  // foco inicial entra no diálogo (a primeira ação existe em todos os estados)
  useEffect(() => {
    if (visible) closeButtonRef.current?.focus();
  }, [visible, status]);

  // M6: a região viva anuncia só o começo e o desfecho da varredura. O
  // contador e o nome do arquivo mudam ~94 vezes e ficam FORA dela — quem
  // conta o progresso para a tecnologia assistiva é o aria-valuenow da barra.
  useEffect(() => {
    if (!visible) {
      setAnuncio("");
      return;
    }
    if (status === "scanning") {
      setAnuncio("A busca de dados começou. Isso pode demorar alguns minutos.");
      return;
    }
    const atual = useEnrichStore.getState();
    setAnuncio(
      atual.proposals.length === 0
        ? `Busca concluída. ${textoSemPropostas(atual.scannedTotal)}`
        : atual.proposals.length === 1
          ? "Busca concluída. 1 proposta para revisar."
          : `Busca concluída. ${atual.proposals.length} propostas para revisar.`,
    );
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
    if (p.error !== null) return p.error;
    const doApply = applyErrors[p.song_id];
    if (doApply === undefined) return null;
    // recusa por falta de consentimento que a pessoa já resolveu: a linha
    // volta a valer (o erro descrevia a tentativa anterior, não esta)
    if (consentidos.has(p.song_id) && erroPedeConsentimento(doApply)) return null;
    return doApply;
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

  /**
   * Marca/desmarca a substituição da letra desta linha. Marcar é também a
   * resposta ao backend que recusou por falta de consentimento: a linha
   * destrava e passa a valer para o próximo "Aplicar".
   */
  function toggleSubstituir(songId: number) {
    const marcando = !substituir.has(songId);
    const alternar = (prev: Set<number>) => {
      const next = new Set(prev);
      if (marcando) {
        next.add(songId);
      } else {
        next.delete(songId);
      }
      return next;
    };
    setSubstituir(alternar);
    setConsentidos(alternar);
    // marcar a substituição só faz sentido com a linha aplicada
    if (marcando) setSelected((prev) => new Set(prev).add(songId));
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

    // nunca-apaga: null = "não mexer"; temas não fazem parte das propostas F13.
    // current_* = o que a varredura viu: o backend recusa a proposta se a
    // música mudou desde então (A5), em vez de reverter a edição manual.
    //
    // CRÍTICO-1 — "nunca apaga" vale para a LETRA: quando a linha passaria por
    // cima de uma letra existente, a letra só viaja se a segunda marcação
    // estiver marcada. Sem ela a linha aplica só título e artista, que é o
    // valor real dessas linhas.
    const aplicacoes: EnrichApply[] = chosen.map((p) => {
      const trocaLetra = substituiriaLetra(p, applyErrors[p.song_id] ?? null);
      const consentida = substituir.has(p.song_id);
      const letra = trocaLetra && !consentida ? null : (p.lyrics ?? null);
      return {
        song_id: p.song_id,
        title: p.proposed_title,
        artist: p.proposed_artist ?? null,
        lyrics: letra,
        add_temas: null,
        current_title: p.current_title,
        current_artist: p.current_artist,
        // a procedência viaja junto: é ela que decide o TXXX:LETRA_ORIGEM
        fonte: p.fonte || null,
        ...(trocaLetra && consentida ? { substituir_letra: true } : {}),
      };
    });
    /** O que foi realmente ENVIADO por música — é isso que o aviso conta. */
    const enviado = new Map(aplicacoes.map((a) => [a.song_id, a]));

    // Estado ANTES da gravação: é a única forma honesta de dizer "ganhou
    // letra" — uma proposta com letra pode ser para uma música que já tinha
    // letra e só estava sem artista (o lote também as considera incompletas).
    const antes = new Map(
      useLibraryStore.getState().allSongs.map((s) => [s.id, s.has_lyrics]),
    );

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
        // PRD V8: "o aviso diz o que mudou ('47 músicas ganharam letra'), não
        // uma tarefa a fazer" — curadoria feita dentro do app já reindexou, e
        // por isso NÃO existe popup pedindo reindexação nem reinício.
        // Os dois grupos são disjuntos (quem ganhou letra não é recontada na
        // correção de nome): senão as contas somariam mais que o total.
        let ganharamLetra = 0;
        let letraSubstituida = 0;
        let nomeCorrigido = 0;
        for (const r of gravadas) {
          const p = proposals.find((x) => x.song_id === r.song_id);
          const a = enviado.get(r.song_id);
          if (!p || !a) continue;
          // conta pelo que FOI ENVIADO: a linha marcada sem substituição não
          // mandou letra nenhuma, e dizer que ela "ganhou letra" seria contar
          // uma mudança que não houve
          if (a.lyrics !== null) {
            if (antes.get(p.song_id) === true) {
              letraSubstituida++;
            } else {
              ganharamLetra++;
            }
          } else if (
            p.proposed_title !== p.current_title ||
            (p.proposed_artist ?? null) !== (p.current_artist ?? null)
          ) {
            nomeCorrigido++;
          }
        }
        push(
          textoAplicado({
            ganharamLetra,
            letraSubstituida,
            nomeCorrigido,
            gravadas: gravadas.length,
          }),
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

      if (falhas.length === 0) {
        close();
      } else {
        // A5: o que NÃO gravou fica na tela com o erro (uma proposta recusada
        // por estar velha some do lote sem que ninguém perceba, e o usuário
        // acharia que a sugestão foi aplicada). As que gravaram saem da lista.
        retainFailures(falhas);
      }
    } catch {
      // defensivo: invoke rejeitado (erro de infraestrutura, não por música)
      push("Não foi possível aplicar as alterações.", "error");
    } finally {
      setBusy(false);
    }
  }

  // MÉDIO-12 — o cabeçalho conta OFERTAS. Linha com erro não é proposta: ela
  // existe para informar que a música foi tentada e falhou, e somá-la à
  // confiança produzia "95 propostas — 0 alta, 0 média, 95 baixa" seguido de
  // um "Aplicar selecionadas (0)" desabilitado e sem explicação.
  const ofertas = proposals.filter((p) => rowError(p) === null);
  const comErro = proposals.length - ofertas.length;
  const counts = { alta: 0, media: 0, baixa: 0 };
  for (const p of ofertas) counts[p.confidence]++;
  const quantasOfertas =
    ofertas.length === 1 ? "1 proposta" : `${ofertas.length} propostas`;
  const tituloDoCabecalho =
    ofertas.length === 0
      ? "Nenhuma proposta para aplicar."
      : `${quantasOfertas} — ${counts.alta} alta, ${counts.media} média,` +
        ` ${counts.baixa} baixa`;

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
        {/* única região viva do overlay (M6): montada o tempo todo e com o
            texto trocando só nas transições — começo e fim da varredura */}
        <p className="sr-only" role="status">
          {anuncio}
        </p>
        {status === "scanning" ? (
          <>
            {progress === null ? (
              // antes do primeiro evento não dá para estimar nada
              <div className="flex items-center gap-3 py-4">
                <span
                  aria-hidden="true"
                  className="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-[#0F766E] border-t-transparent"
                />
                <p className="text-[15px] text-[#111827]">
                  Buscando dados… isso pode demorar alguns minutos.
                </p>
              </div>
            ) : (
              // sem live region aqui: o contador e o nome do arquivo mudam a
              // cada música — quem informa o avanço é o aria-valuenow (M6)
              <div className="py-4">
                <p className="mb-1 text-[15px] text-[#111827]">
                  Buscando dados… {progress.done} de {progress.total}
                </p>
                <div
                  role="progressbar"
                  aria-label="Progresso da busca de dados"
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
                {/* V8/F18 — a etapa do funil. Sem ela, minutos parados no
                    mesmo número parecem travamento; com ela, a pessoa vê que
                    a busca passou do arquivo para a rede. */}
                {progress.etapa && (
                  <p className="mt-1 text-[13px] text-[#5B6472]">
                    Etapa: {progress.etapa}
                  </p>
                )}
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
            {/* A6: "nada a ajustar" com 81 conferidas soava como "pasta
                completa" — o texto conta o que houve e para onde ir */}
            <p className="py-4 text-[15px] text-[#111827]">
              {textoSemPropostas(scannedTotal)}
            </p>
            <div className="mt-2 flex justify-end">{closeButton}</div>
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 pb-3">
              <h2 className="text-[16px] font-semibold text-[#111827]">
                {tituloDoCabecalho}
              </h2>
              <span className="ml-auto flex gap-2">
                <button
                  type="button"
                  // marca as linhas aplicáveis e SÓ isso: a substituição de
                  // letra nunca entra num gesto de massa (CRÍTICO-1)
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
                  onClick={() => {
                    setSelected(new Set());
                    // "nada será aplicado" inclui não trocar letra nenhuma
                    setSubstituir(new Set());
                    setConsentidos(new Set());
                  }}
                  className="rounded-md px-2 py-1 text-[13px] font-medium text-[#0F766E] hover:bg-[#F0FDFA]"
                >
                  Desmarcar todas
                </button>
              </span>
            </div>
            {comErro > 0 && (
              // as linhas de erro existem para INFORMAR (DECISIONS #47): dizer
              // quantas são aqui em cima evita a leitura de que a busca
              // "não achou nada" quando na verdade ela nem chegou lá
              <p className="pb-3 text-[13px] text-[#5B6472]">
                {comErro === 1
                  ? "1 música não pôde ser consultada — o motivo está na linha dela."
                  : `${comErro} músicas não puderam ser consultadas — o motivo está em cada linha.`}
              </p>
            )}

            <ul className="min-h-0 flex-1 divide-y divide-[#F3F4F6] overflow-y-auto">
              {proposals.map((p) => {
                const error = rowError(p);
                const disabled = error !== null;
                const badge = BADGES[p.confidence];
                const trocaLetra = substituiriaLetra(
                  p,
                  applyErrors[p.song_id] ?? null,
                );
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
                        {/* a seta é decorativa (aria-hidden), mas continua
                            sendo tinta na tela de quem enxerga pouco: #9CA3AF
                            dava 2,5:1 no branco. #6B7280 dá 4,8:1 e a varredura
                            de contraste deste arquivo não precisa de exceções
                            (DECISIONS #76). */}
                        <span aria-hidden="true" className="text-[#6B7280]">
                          →
                        </span>
                        <span className="truncate font-medium text-[#111827]">
                          {nomeCompleto(p.proposed_title, p.proposed_artist)}
                        </span>
                      </span>
                      {error !== null && (
                        <span className="block text-[13px] text-[#B91C1C]">
                          {error}
                        </span>
                      )}
                      {error === null && (
                        // V8/F18 — procedência sempre à vista: ALTA vinda do
                        // LRCLIB (que confere a duração) e ALTA vinda de um
                        // palpite de nome de arquivo não se decidem igual.
                        <span className="flex flex-wrap gap-x-2 text-[13px]">
                          {p.lyrics !== null && (
                            <span className="text-[#0F766E]">letra encontrada</span>
                          )}
                          {p.fonte && (
                            <span className="text-[#5B6472]">via {p.fonte}</span>
                          )}
                        </span>
                      )}
                      {/*
                        CRÍTICO-1 — a linha que substituiria uma letra existente
                        DIZ isso, visível, e traz a sua própria marcação. Ela
                        aparece mesmo com erro na linha: quando a recusa do
                        backend foi justamente a falta deste consentimento, é
                        aqui que a pessoa responde — senão a mensagem manda
                        marcar algo que não existe na tela.
                      */}
                      {trocaLetra && (
                        <>
                          <span className="mt-0.5 block text-[13px] text-[#854D0E]">
                            {avisoLetraExistente(p.letra_origem)}
                          </span>
                          <label className="mt-0.5 flex items-start gap-2 text-[13px] text-[#374151]">
                            <input
                              type="checkbox"
                              aria-label={`${LABEL_SUBSTITUIR_LETRA}: ${p.current_title}`}
                              disabled={busy}
                              checked={substituir.has(p.song_id)}
                              onChange={() => toggleSubstituir(p.song_id)}
                              className="mt-0.5 h-4 w-4 shrink-0 accent-[#0F766E]"
                            />
                            <span>{LABEL_SUBSTITUIR_LETRA}</span>
                          </label>
                        </>
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

            <div className="mt-4 flex shrink-0 flex-wrap items-center justify-end gap-2">
              {/*
                MÉDIO-12 — "Aplicar selecionadas (0)" cinza, sem uma palavra de
                explicação, era um beco: a pessoa tinha acabado de clicar em
                "Marcar todas" e nada acontecera.
              */}
              {selected.size === 0 && (
                <p className="mr-auto text-[13px] text-[#5B6472]">
                  {ofertas.length === 0
                    ? "Não há nada a aplicar nesta lista."
                    : "Marque ao menos uma linha para aplicar."}
                </p>
              )}
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
