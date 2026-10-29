import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { getBackend, type EnrichProposal } from "../lib/api";
import { estadoAtualDa, substituiriaLetra } from "../lib/aplicacao";
import {
  AVISO_LETRA_DE_MAQUINA,
  AVISO_MARCAR_INSTRUMENTAL,
  AVISO_NOME_ESCRITO,
  EXPLICACAO_DA_CONFIANCA_DO_SOM,
  ROTULO_COMECAR_TRANSCRICAO,
  agruparPorRisco,
  avisoLetraExistente,
  avisoSemPerguntarAoSom,
  confiancaDoSom,
  ehLetraDeMaquina,
  textoDaOfertaDeTranscricao,
  textoDaTranscricaoIndisponivel,
  textoDoProgressoDaTranscricao,
  textoDoTempoDaTranscricao,
  textoSemPropostas,
} from "../lib/curadoria";
import { decisoesPendentes, useEnrichStore } from "../stores/enrichStore";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlayerStore } from "../stores/playerStore";
import { useUiStore } from "../stores/uiStore";

function nomeCompleto(title: string, artist: string | null): string {
  return artist ? `${title} — ${artist}` : title;
}

/**
 * Overlay do trabalho da curadoria (F13 — PRD V5; V9; V10; V15).
 *
 * Três momentos, três desenhos:
 *
 * - **buscando** e **escrevendo as letras**: uma caixa no meio da tela, com o
 *   andamento e "Deixar rodando em segundo plano". Não mudaram na V15.
 * - **conferir** (V15): tela inteira, UMA sugestão por vez. Era uma lista com
 *   caixas de marcar agrupadas por risco — boa para quem conhece o produto, e
 *   uma parede para quem tem pouca prática. O que só preenche espaço vazio já
 *   foi gravado sozinho antes desta tela abrir (`aplicarOQueSoPreenche`); o
 *   que sobra aqui é o que TROCARIA algo, e cada um é uma decisão de três
 *   botões: usar o novo, manter, decidir depois.
 */
export function EnrichReview() {
  const status = useEnrichStore((s) => s.status);
  const overlayOpen = useEnrichStore((s) => s.overlayOpen);
  const progress = useEnrichStore((s) => s.progress);
  const transcricaoProgress = useEnrichStore((s) => s.transcricaoProgress);
  const close = useEnrichStore((s) => s.close);
  const hideOverlay = useEnrichStore((s) => s.hideOverlay);
  const autoAplicadas = useEnrichStore((s) => s.autoAplicadas);
  /** Único texto lido por leitor de tela: só transições, nunca cada arquivo. */
  const [anuncio, setAnuncio] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

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

  // M6: a região viva anuncia só o começo e o desfecho do trabalho. O contador
  // e o nome do arquivo mudam ~94 vezes e ficam FORA dela — quem conta o
  // progresso para a tecnologia assistiva é o aria-valuenow da barra.
  useEffect(() => {
    if (!visible) {
      setAnuncio("");
      return;
    }
    if (status === "scanning") {
      setAnuncio("A busca de dados começou. Isso pode demorar alguns minutos.");
      return;
    }
    if (status === "transcribing") {
      setAnuncio(
        "As letras começaram a ser escritas. Isso pode demorar horas, e dá" +
          " para continuar usando o aplicativo.",
      );
      return;
    }
    const atual = useEnrichStore.getState();
    const pendentes = decisoesPendentes(atual).length;
    const naoPerguntadas = avisoSemPerguntarAoSom(atual.semPerguntarAoSom);
    const desfecho =
      atual.proposals.length === 0
        ? textoSemPropostas(atual.scannedTotal, atual.semPerguntarAoSom)
        : `${pendentes === 1 ? "1 sugestão espera" : `${pendentes} sugestões esperam`} a sua decisão.${naoPerguntadas ? ` ${naoPerguntadas}` : ""}`;
    setAnuncio(`Busca concluída. ${desfecho}`);
    // `autoAplicadas`: o que só preenche é gravado DEPOIS de a revisão abrir,
    // e o número anunciado tem de ser o que sobrou para a pessoa decidir
  }, [visible, status, autoAplicadas]);

  // Esc SAI do overlay. Durante a varredura ou a transcrição sair é MANDAR
  // PARA SEGUNDO PLANO (as duas são somente leitura — cancelar exige o botão
  // explícito). V15 — na conferência também: as decisões pendentes continuam
  // esperando em Organizar, e um Esc não pode jogá-las fora.
  useEffect(() => {
    if (!visible) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      const atual = useEnrichStore.getState();
      if (atual.status === "review" && decisoesPendentes(atual).length === 0) {
        close();
      } else {
        hideOverlay();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [visible, close, hideOverlay]);

  if (!visible) return null;

  if (status === "review") {
    return (
      <>
        <p className="sr-only" role="status">
          {anuncio}
        </p>
        <Conferir />
      </>
    );
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

  return (
    <div
      ref={dialogRef}
      onKeyDown={trapTab}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-label="Completar dados"
    >
      <div className="flex max-h-[calc(100vh-4rem)] w-[640px] max-w-[calc(100vw-2rem)] flex-col rounded-2xl bg-surface p-6 shadow-xl">
        {/* única região viva do overlay (M6): montada o tempo todo e com o
            texto trocando só nas transições — começo e fim do trabalho */}
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
                  className="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-brand border-t-transparent"
                />
                <p className="text-[15px] text-ink">
                  Buscando dados… isso pode demorar alguns minutos.
                </p>
              </div>
            ) : (
              // sem live region aqui: o contador e o nome do arquivo mudam a
              // cada música — quem informa o avanço é o aria-valuenow (M6)
              <div className="py-4">
                <p className="mb-1 text-[15px] text-ink">
                  Buscando dados… {progress.done} de {progress.total}
                </p>
                <div
                  role="progressbar"
                  aria-label="Progresso da busca de dados"
                  aria-valuemin={0}
                  aria-valuemax={progress.total}
                  aria-valuenow={progress.done}
                  className="h-1.5 w-full overflow-hidden rounded bg-border"
                >
                  <div
                    className="h-full bg-brand transition-[width]"
                    style={{
                      width:
                        progress.total > 0
                          ? `${(progress.done / progress.total) * 100}%`
                          : "0%",
                    }}
                  />
                </div>
                {/* V8/F18 — a etapa do funil. Sem ela, minutos parados no
                    mesmo número parecem travamento. */}
                {progress.etapa && (
                  <p className="mt-1 text-[13px] text-ink-quaternary">
                    Etapa: {progress.etapa}
                  </p>
                )}
                {/* nome do arquivo pode ser enorme: trunca em uma linha */}
                <p
                  title={progress.atual}
                  className="mt-1 truncate text-[13px] text-ink-tertiary"
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
                className="rounded-md px-4 py-2 text-[15px] font-medium text-brand hover:bg-brand-soft"
              >
                Deixar rodando em segundo plano
              </button>
              <button
                type="button"
                onClick={close}
                className="rounded-md px-4 py-2 text-[15px] font-medium text-ink-secondary hover:bg-surface-hover"
              >
                Cancelar
              </button>
            </div>
          </>
        ) : status === "transcribing" ? (
          /*
            V10 — a etapa 5 leva HORAS. Tudo o que vale para a varredura vale
            aqui, e mais uma coisa: uma única música leva minutos, então a
            barra precisa andar DENTRO dela ou parece travada (DECISIONS #92).
          */
          <>
            {transcricaoProgress === null ? (
              <div className="flex items-center gap-3 py-4">
                <span
                  aria-hidden="true"
                  className="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-brand border-t-transparent"
                />
                <p className="text-[15px] text-ink">
                  Escrevendo as letras… isso pode demorar horas.
                </p>
              </div>
            ) : (
              <div className="py-4">
                <p className="mb-1 text-[15px] text-ink">
                  {textoDoProgressoDaTranscricao(
                    transcricaoProgress.done,
                    transcricaoProgress.total,
                  )}
                </p>
                <div
                  role="progressbar"
                  aria-label="Progresso da escrita das letras"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(
                    transcricaoProgress.total > 0
                      ? ((transcricaoProgress.done +
                          transcricaoProgress.porcento_da_musica / 100) /
                          transcricaoProgress.total) *
                          100
                      : 0,
                  )}
                  className="h-1.5 w-full overflow-hidden rounded bg-border"
                >
                  <div
                    className="h-full bg-brand transition-[width]"
                    style={{
                      width:
                        transcricaoProgress.total > 0
                          ? `${((transcricaoProgress.done + transcricaoProgress.porcento_da_musica / 100) / transcricaoProgress.total) * 100}%`
                          : "0%",
                    }}
                  />
                </div>
                {/* o tempo que falta vem da velocidade MEDIDA — e enquanto não
                    houver medição, a tela diz QUANDO o número vai aparecer */}
                <p className="mt-1 text-[13px] text-ink-quaternary">
                  {textoDoTempoDaTranscricao(transcricaoProgress.segundos_restantes)}
                </p>
                <p
                  title={transcricaoProgress.atual}
                  className="mt-1 truncate text-[13px] text-ink-tertiary"
                >
                  {transcricaoProgress.atual}
                </p>
              </div>
            )}
            <div className="mt-2 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                ref={closeButtonRef}
                onClick={hideOverlay}
                className="rounded-md px-4 py-2 text-[15px] font-medium text-brand hover:bg-brand-soft"
              >
                Deixar rodando em segundo plano
              </button>
              <button
                type="button"
                onClick={close}
                className="rounded-md px-4 py-2 text-[15px] font-medium text-ink-secondary hover:bg-surface-hover"
              >
                Cancelar
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

/** Um campo comparado: o que o arquivo tem hoje, e o que ficaria. */
interface Campo {
  rotulo: string;
  hoje: string;
  novo: string;
  letra?: boolean;
}

const VAZIO = "(vazio)";

/** De onde a sugestão veio, dito como gente diz. */
function origemDa(p: EnrichProposal): string {
  if (p.conflito) return "o Cancioneiro reconheceu a gravação pelo som.";
  if (p.marcar_instrumental) return "o Cancioneiro ouviu a música e não encontrou voz.";
  if (ehLetraDeMaquina(p.fonte)) return "o computador escreveu a letra ouvindo a música.";
  if (p.fonte === "nome do arquivo") return "o nome do arquivo.";
  return p.fonte ? `${p.fonte}.` : "a busca na internet.";
}

const BOTAO_GRANDE =
  "flex min-h-14 items-center justify-center gap-2 rounded-xl px-5 text-[17px] font-semibold disabled:opacity-50";
const PRINCIPAL = `${BOTAO_GRANDE} bg-brand-fill text-white hover:bg-brand-fill-hover`;
const SECUNDARIO = `${BOTAO_GRANDE} border-2 border-border-strong bg-surface text-ink hover:bg-surface-hover`;

/**
 * V15 — a conferência, UMA sugestão por vez.
 *
 * As regras de segurança da lista antiga continuam todas aqui, só que ditas
 * de outro jeito:
 *
 * - **trocar uma letra que existe** pede um botão que DIZ isso ("Trocar a
 *   letra pela nova") — o clique nele é o consentimento separado da CRÍTICO-1;
 * - **marcar como instrumental** idem ("Marcar como instrumental"), e nunca
 *   entra no "usar em todas" (#71);
 * - **conflito** mostra as duas fontes lado a lado, com quem disse o quê;
 * - **"usar o novo em todas"** existe, pergunta de novo antes, e NÃO alcança
 *   trocas de letra nem marcas de instrumental: essas continuam uma por uma.
 */
function Conferir() {
  const proposals = useEnrichStore((s) => s.proposals);
  const aplicadas = useEnrichStore((s) => s.aplicadas);
  const mantidas = useEnrichStore((s) => s.mantidas);
  const gravadas = useEnrichStore((s) => s.gravadas);
  const applyErrors = useEnrichStore((s) => s.applyErrors);
  const avisosDaGravacao = useEnrichStore((s) => s.avisosDaGravacao);
  const autoAplicadas = useEnrichStore((s) => s.autoAplicadas);
  const scannedTotal = useEnrichStore((s) => s.scannedTotal);
  const semPerguntarAoSom = useEnrichStore((s) => s.semPerguntarAoSom);
  const semLetraNoFim = useEnrichStore((s) => s.semLetraNoFim);
  const segundosDeTranscricao = useEnrichStore((s) => s.segundosDeTranscricao);
  const estimativaMedida = useEnrichStore((s) => s.estimativaMedidaNestaMaquina);
  const transcricao = useEnrichStore((s) => s.transcricao);
  const transcricaoDispensada = useEnrichStore((s) => s.transcricaoDispensada);
  const startTranscricao = useEnrichStore((s) => s.startTranscricao);
  const dispensarTranscricao = useEnrichStore((s) => s.dispensarTranscricao);
  const aplicarLinhas = useEnrichStore((s) => s.aplicarLinhas);
  const manter = useEnrichStore((s) => s.manter);
  const close = useEnrichStore((s) => s.close);
  const hideOverlay = useEnrichStore((s) => s.hideOverlay);
  const overlayOpen = useEnrichStore((s) => s.overlayOpen);
  const allSongs = useLibraryStore((s) => s.allSongs);
  const tocandoId = usePlayerStore((s) => (s.isPlaying ? (s.current?.id ?? null) : null));

  /** "Decidir depois", nesta visita. Ao reabrir, elas voltam para a fila. */
  const [adiadas, setAdiadas] = useState<Set<number>>(new Set());
  const [confirmandoTodas, setConfirmandoTodas] = useState(false);
  const [busy, setBusy] = useState(false);
  /** A letra que o arquivo tem hoje, para a comparação lado a lado. */
  const [letraDeHoje, setLetraDeHoje] = useState<string | null | undefined>(undefined);
  const primeiroBotao = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (overlayOpen) setAdiadas(new Set());
  }, [overlayOpen]);

  /** A fila, na ORDEM DE RISCO (a mesma da lista antiga). */
  const fila = useMemo(() => {
    const gravada = new Set(aplicadas);
    const pendentes = new Set(decisoesPendentes({ proposals, aplicadas, mantidas }));
    const ordem = agruparPorRisco(
      proposals,
      (p) => p.error ?? applyErrors[p.song_id] ?? null,
      (i) => gravada.has(i),
    ).flatMap((g) => g.propostas.map((p) => proposals.indexOf(p)));
    return ordem.filter((i) => pendentes.has(i) && !adiadas.has(i));
  }, [proposals, aplicadas, mantidas, applyErrors, adiadas]);

  const linha = fila[0];
  const p = linha === undefined ? undefined : proposals[linha];
  const atual = p ? estadoAtualDa(p, gravadas) : undefined;
  const erroDaLinha = p ? (applyErrors[p.song_id] ?? null) : null;
  const trocaLetra = p && atual ? substituiriaLetra(p, atual, erroDaLinha) : false;

  // a letra de hoje só é buscada quando a comparação precisa dela
  useEffect(() => {
    setLetraDeHoje(undefined);
    if (!p || p.lyrics === null || p.conflito || !atual?.has_lyrics) return;
    let vivo = true;
    void getBackend()
      .getLyrics(p.song_id)
      .then((l) => vivo && setLetraDeHoje(l))
      .catch(() => vivo && setLetraDeHoje(null));
    return () => {
      vivo = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linha, p?.song_id, atual?.has_lyrics]);

  // a próxima sugestão chega com o foco no botão principal
  useEffect(() => {
    primeiroBotao.current?.focus();
  }, [linha]);

  /** As que o "usar em todas" alcança: nunca troca de letra nem instrumental. */
  const emMassa = fila.filter((i) => {
    const q = proposals[i];
    const a = estadoAtualDa(q, gravadas);
    return !q.marcar_instrumental && !substituiriaLetra(q, a, applyErrors[q.song_id] ?? null);
  });
  const ficamFora = fila.length - emMassa.length;

  function sair(paraOuvir: boolean) {
    // com decisões adiadas a revisão continua viva: elas esperam em Organizar
    if (decisoesPendentes({ proposals, aplicadas, mantidas }).length > 0) hideOverlay();
    else close();
    if (paraOuvir) useUiStore.getState().setView("library");
  }

  function ouvir() {
    if (!p) return;
    const player = usePlayerStore.getState();
    if (player.current?.id === p.song_id) {
      player.togglePlayPause();
      return;
    }
    const musica = allSongs.find((m) => m.id === p.song_id);
    if (musica?.available) player.playSong(musica);
  }

  async function usarONovo() {
    if (linha === undefined || !p) return;
    setBusy(true);
    try {
      // o clique num botão que DIZ "Trocar a letra pela nova" é o
      // consentimento separado (CRÍTICO-1): só vale para esta música
      await aplicarLinhas([linha], { consentiu: (id) => trocaLetra && id === p.song_id });
    } finally {
      setBusy(false);
    }
  }

  async function usarEmTodas() {
    setBusy(true);
    try {
      await aplicarLinhas(emMassa);
    } finally {
      setBusy(false);
      setConfirmandoTodas(false);
    }
  }

  const perguntaDoFim = semLetraNoFim.length > 0 && !transcricaoDispensada;
  const naoConsultadas = proposals.filter((q) => q.error !== null);
  const atualizadas = Object.keys(gravadas).length;
  const ajustes = Object.entries(avisosDaGravacao);

  const campos: Campo[] =
    p && atual
      ? [
          {
            rotulo: "Nome da música",
            hoje: atual.current_title,
            novo: p.conflito ? p.conflito.titulo : p.proposed_title,
          },
          {
            rotulo: "Quem canta",
            hoje: atual.current_artist ?? VAZIO,
            novo: (p.conflito ? p.conflito.artista : p.proposed_artist) ?? VAZIO,
          },
          ...(p.lyrics !== null && !p.conflito
            ? [
                {
                  rotulo: "Letra",
                  letra: true,
                  hoje: !atual.has_lyrics
                    ? "(sem letra)"
                    : letraDeHoje === undefined
                      ? "Carregando…"
                      : (letraDeHoje ?? "(não foi possível ler a letra de hoje)"),
                  novo: p.lyrics,
                },
              ]
            : []),
          ...(p.marcar_instrumental
            ? [{ rotulo: "Instrumental", hoje: "Não marcada", novo: "Marcada como instrumental" }]
            : []),
        ]
      : [];

  const avisos: string[] = p
    ? [
        // a confiança é do RECONHECIMENTO da gravação, não de a etiqueta estar
        // errada: sem a frase que desfaz o engano, "alta" lê como "troque já"
        ...(p.conflito
          ? [confiancaDoSom(p.conflito.confianca), EXPLICACAO_DA_CONFIANCA_DO_SOM]
          : []),
        ...(p.lyrics !== null && ehLetraDeMaquina(p.fonte) ? [AVISO_LETRA_DE_MAQUINA] : []),
        ...(p.marcar_instrumental ? [AVISO_MARCAR_INSTRUMENTAL] : []),
        ...(p.substitui_nome_escrito ? [AVISO_NOME_ESCRITO] : []),
        ...(trocaLetra ? [avisoLetraExistente(atual?.letra_origem ?? null)] : []),
        ...(p.aviso ? [p.aviso] : []),
      ]
    : [];

  const rotuloPrincipal = trocaLetra
    ? "Trocar a letra pela nova"
    : p?.marcar_instrumental
      ? "Marcar como instrumental"
      : "Usar o novo";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Conferir sugestões"
      className="fixed inset-0 z-50 flex flex-col bg-canvas text-ink"
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-border bg-surface px-5 py-2.5 max-lg:px-3 baixa:py-1.5">
        <button
          type="button"
          onClick={() => sair(false)}
          className="flex min-h-12 shrink-0 items-center gap-2 rounded-xl border-2 border-border-strong px-4 text-[16px] font-semibold text-ink hover:bg-surface-hover"
        >
          <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
          Voltar
        </button>
        <h1 className="min-w-0 flex-1 truncate text-[21px] font-bold text-brand">
          Conferir sugestões
        </h1>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-8 py-6 max-lg:px-4 max-lg:py-4">
        <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-5">
          {p && !confirmandoTodas ? (
            <>
              <p className="text-[17px] text-ink-secondary">
                {fila.length === 1 ? (
                  <>Falta <strong className="font-semibold text-ink">1</strong> para conferir</>
                ) : (
                  <>Faltam <strong className="font-semibold text-ink">{fila.length}</strong> para conferir</>
                )}
              </p>

              <div className="flex flex-wrap items-center gap-4">
                <div className="min-w-0 flex-1 basis-72">
                  <h2 className="text-[23px] font-bold leading-tight">
                    {nomeCompleto(atual!.current_title, atual!.current_artist)}
                  </h2>
                  <p className="mt-1.5 text-[16px] text-ink-secondary">
                    <strong className="font-semibold text-ink">De onde veio a sugestão:</strong>{" "}
                    {origemDa(p)}
                  </p>
                </div>
                <button type="button" onClick={ouvir} className={SECUNDARIO}>
                  {tocandoId === p.song_id ? (
                    <>
                      <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
                      Parar de ouvir
                    </>
                  ) : (
                    <>
                      <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.9l10-6.5a1 1 0 0 0 0-1.7l-10-6.5A1 1 0 0 0 8 5.5Z" /></svg>
                      Ouvir esta música
                    </>
                  )}
                </button>
              </div>

              {avisos.length > 0 && (
                <ul className="flex flex-col gap-2 rounded-xl bg-warning-soft px-4 py-3 text-[16px] leading-relaxed text-warning">
                  {avisos.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
              )}
              {erroDaLinha !== null && (
                <p role="alert" className="rounded-xl bg-danger-soft px-4 py-3 text-[16px] text-danger">
                  Não deu para gravar: {erroDaLinha}
                </p>
              )}

              <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,320px),1fr))] gap-4">
                {(["hoje", "novo"] as const).map((lado) => (
                  <section
                    key={lado}
                    aria-label={lado === "hoje" ? "Como está hoje" : "Como ficaria"}
                    className={`flex flex-col gap-3 rounded-2xl border-2 bg-surface p-5 max-lg:p-4 ${
                      lado === "hoje" ? "border-border" : "border-brand"
                    }`}
                  >
                    <h3 className={`text-[17px] font-bold ${lado === "hoje" ? "text-ink-secondary" : "text-brand"}`}>
                      {lado === "hoje" ? "Como está hoje" : "Como ficaria"}
                    </h3>
                    {campos.map((c) => {
                      const muda = c.hoje !== c.novo;
                      return (
                        <div
                          key={c.rotulo}
                          className={`flex flex-col gap-1 rounded-xl px-4 py-2.5 ${
                            muda ? (lado === "hoje" ? "bg-surface-hover" : "bg-brand-soft") : ""
                          }`}
                        >
                          <div className="flex justify-between gap-2 text-[15px] text-ink-secondary">
                            <span>{c.rotulo}</span>
                            <span className={muda && lado === "novo" ? "font-bold text-brand-strong" : ""}>
                              {muda ? (lado === "novo" ? "muda" : "") : "igual"}
                            </span>
                          </div>
                          <div
                            className={`text-[18px] ${muda && lado === "novo" ? "font-semibold" : ""} ${
                              c.letra ? "max-h-56 overflow-y-auto whitespace-pre-line leading-relaxed baixa:max-h-32" : "break-words"
                            } ${muda ? "text-ink" : "text-ink-secondary"}`}
                          >
                            {lado === "hoje" ? c.hoje : c.novo}
                          </div>
                        </div>
                      );
                    })}
                  </section>
                ))}
              </div>
            </>
          ) : confirmandoTodas ? (
            <section className="mx-auto mt-6 flex max-w-2xl flex-col gap-4 rounded-2xl border-2 border-warning bg-warning-soft p-6">
              <h2 className="text-[22px] font-bold">
                Usar o novo em {emMassa.length === 1 ? "1 sugestão" : `${emMassa.length} sugestões`}?
              </h2>
              <p className="text-[17px] leading-relaxed text-ink-secondary">
                Isso troca o nome e quem canta nessas músicas pelo que o Cancioneiro
                sugeriu, sem você ver uma por uma.
              </p>
              {ficamFora > 0 && (
                <p className="text-[17px] leading-relaxed text-ink-secondary">
                  {ficamFora === 1
                    ? "1 sugestão que trocaria uma letra ou marcaria como instrumental continua esperando você."
                    : `${ficamFora} sugestões que trocariam uma letra ou marcariam como instrumental continuam esperando você, uma por uma.`}
                </p>
              )}
              <div className="flex flex-wrap gap-3">
                <button type="button" disabled={busy} onClick={() => void usarEmTodas()} className={PRINCIPAL}>
                  Sim, usar em todas
                </button>
                <button type="button" disabled={busy} onClick={() => setConfirmandoTodas(false)} className={SECUNDARIO}>
                  Não, quero ver uma por uma
                </button>
              </div>
            </section>
          ) : (
            <Fim
              semNada={proposals.length === 0}
              textoSemNada={textoSemPropostas(scannedTotal, semPerguntarAoSom)}
              autoAplicadas={autoAplicadas}
              atualizadas={atualizadas}
              mantidas={mantidas.length}
              adiadas={adiadas.size}
              avisoSom={avisoSemPerguntarAoSom(semPerguntarAoSom)}
              naoConsultadas={naoConsultadas}
              ajustes={ajustes.map(([id, texto]) => ({
                nome: allSongs.find((m) => m.id === Number(id))?.title ?? "",
                texto,
              }))}
              pergunta={
                perguntaDoFim
                  ? {
                      texto: transcricao.disponivel
                        ? textoDaOfertaDeTranscricao(
                            semLetraNoFim.length,
                            segundosDeTranscricao,
                            estimativaMedida,
                          )
                        : textoDaTranscricaoIndisponivel(semLetraNoFim.length, transcricao.download),
                      disponivel: transcricao.disponivel,
                      comecar: () => void startTranscricao(),
                      agoraNao: dispensarTranscricao,
                    }
                  : null
              }
              sair={sair}
            />
          )}
        </div>
      </main>

      {p && !confirmandoTodas && (
        <footer
          aria-label="Sua decisão"
          className="flex shrink-0 flex-wrap items-center gap-3 border-t border-border bg-surface px-6 py-3 max-lg:px-4 baixa:py-2"
        >
          <button ref={primeiroBotao} type="button" disabled={busy} onClick={() => void usarONovo()} className={PRINCIPAL}>
            <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 5 5L20 7" /></svg>
            {rotuloPrincipal}
          </button>
          <button type="button" disabled={busy} onClick={() => linha !== undefined && manter(linha)} className={SECUNDARIO}>
            Manter como está
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => linha !== undefined && setAdiadas((s) => new Set(s).add(linha))}
            className={SECUNDARIO}
          >
            Decidir depois
          </button>
          {emMassa.length > 1 && (
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirmandoTodas(true)}
              className="ml-auto min-h-12 rounded-xl px-3 text-[16px] font-semibold text-brand underline underline-offset-4 hover:bg-brand-soft max-lg:ml-0"
            >
              Usar o novo em todas as {emMassa.length}
            </button>
          )}
        </footer>
      )}
    </div>
  );
}

/** O fim da conferência: o que aconteceu, e para onde ir. */
function Fim({
  semNada,
  textoSemNada,
  autoAplicadas,
  atualizadas,
  mantidas,
  adiadas,
  avisoSom,
  naoConsultadas,
  ajustes,
  pergunta,
  sair,
}: {
  semNada: boolean;
  textoSemNada: string;
  autoAplicadas: number;
  atualizadas: number;
  mantidas: number;
  adiadas: number;
  avisoSom: string | null;
  naoConsultadas: EnrichProposal[];
  ajustes: { nome: string; texto: string }[];
  pergunta: {
    texto: string;
    disponivel: boolean;
    comecar: () => void;
    agoraNao: () => void;
  } | null;
  sair: (paraOuvir: boolean) => void;
}) {
  const plural = (n: number, um: string, varios: string) => (n === 1 ? um : varios);
  return (
    <section className="mx-auto mt-4 flex w-full max-w-2xl flex-col gap-5 rounded-2xl border-2 border-border bg-surface p-7 max-lg:p-5">
      <div className="flex items-center gap-4">
        <div aria-hidden="true" className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 5 5L20 7" /></svg>
        </div>
        <h2 className="text-[24px] font-bold">
          {semNada ? "Busca concluída" : adiadas > 0 ? "Por agora, é isso" : "Pronto! Você conferiu todas."}
        </h2>
      </div>

      {semNada ? (
        <p className="text-[18px] leading-relaxed text-ink-secondary">{textoSemNada}</p>
      ) : (
        <ul className="flex flex-col gap-1.5 text-[18px] text-ink-secondary">
          {autoAplicadas > 0 && (
            <li>
              <strong className="text-ink">{autoAplicadas}</strong>{" "}
              {plural(autoAplicadas, "música foi completada sozinha", "músicas foram completadas sozinhas")}{" "}
              (só o que estava vazio).
            </li>
          )}
          {atualizadas > autoAplicadas && (
            <li>
              <strong className="text-ink">{atualizadas - autoAplicadas}</strong>{" "}
              {plural(atualizadas - autoAplicadas, "ficou com o que você escolheu", "ficaram com o que você escolheu")}.
            </li>
          )}
          {mantidas > 0 && (
            <li>
              <strong className="text-ink">{mantidas}</strong>{" "}
              {plural(mantidas, "ficou como estava", "ficaram como estavam")}.
            </li>
          )}
          {adiadas > 0 && (
            <li>
              <strong className="text-ink">{adiadas}</strong>{" "}
              {plural(adiadas, "ficou para depois — ela espera em Organizar", "ficaram para depois — elas esperam em Organizar")}.
            </li>
          )}
        </ul>
      )}

      {avisoSom && (
        <p className="rounded-xl bg-warning-soft px-4 py-3 text-[16px] leading-relaxed text-warning">
          {avisoSom}
        </p>
      )}

      {naoConsultadas.length > 0 && (
        <details className="text-[16px] text-ink-secondary">
          <summary className="cursor-pointer font-semibold text-ink">
            {plural(
              naoConsultadas.length,
              "1 música não pôde ser procurada",
              `${naoConsultadas.length} músicas não puderam ser procuradas`,
            )}
          </summary>
          <ul className="mt-2 flex flex-col gap-1.5">
            {naoConsultadas.map((q) => (
              <li key={`${q.song_id}-${q.error}`}>
                <span className="text-ink">{nomeCompleto(q.current_title, q.current_artist)}</span>
                {" — "}
                {q.error}
              </li>
            ))}
          </ul>
        </details>
      )}

      {ajustes.length > 0 && (
        <details className="text-[16px] text-ink-secondary">
          <summary className="cursor-pointer font-semibold text-ink">
            {plural(ajustes.length, "1 arquivo precisou de um ajuste para gravar", `${ajustes.length} arquivos precisaram de um ajuste para gravar`)}
          </summary>
          <ul className="mt-2 flex flex-col gap-1.5">
            {ajustes.map((a) => (
              <li key={a.nome + a.texto}>
                <span className="text-ink">{a.nome}</span> — {a.texto}
              </li>
            ))}
          </ul>
        </details>
      )}

      {/*
        V10 — a pergunta do fim. Ela é feita AQUI porque é aqui que pode ser
        respondida com informação: o app já sabe quantas sobraram sem letra e
        quanto tempo isso leva nesta máquina.
      */}
      {pergunta && (
        <div className="rounded-xl bg-brand-soft px-5 py-4">
          <p className="text-[17px] leading-relaxed text-brand-strong">{pergunta.texto}</p>
          <div className="mt-3 flex flex-wrap gap-3">
            {pergunta.disponivel && (
              <button type="button" onClick={pergunta.comecar} className={PRINCIPAL}>
                {ROTULO_COMECAR_TRANSCRICAO}
              </button>
            )}
            <button type="button" onClick={pergunta.agoraNao} className={SECUNDARIO}>
              Agora não
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-3">
        <button type="button" onClick={() => sair(false)} className={SECUNDARIO}>
          Voltar para Organizar
        </button>
        <button type="button" onClick={() => sair(true)} className={PRINCIPAL}>
          Ir ouvir música
        </button>
      </div>
    </section>
  );
}
