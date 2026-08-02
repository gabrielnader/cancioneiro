import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { audioController } from "../hooks/playerAudioCore";
import { getBackend, type EnrichApply, type EnrichProposal } from "../lib/api";
import {
  AVISO_LETRA_DE_MAQUINA,
  AVISO_MARCAR_INSTRUMENTAL,
  AVISO_NOME_ESCRITO,
  EXPLICACAO_DA_CONFIANCA_DO_SOM,
  LABEL_SOM_DIZ,
  LABEL_SUA_ETIQUETA_DIZ,
  LABEL_SUBSTITUIR_LETRA,
  ROTULO_COMECAR_TRANSCRICAO,
  ROTULO_DA_LINHA_GRAVADA,
  SELO_DA_LINHA_GRAVADA,
  agruparPorRisco,
  avisoLetraExistente,
  avisoSemPerguntarAoSom,
  compararConflito,
  confiancaDoSom,
  destacarDiferenca,
  ehLetraDeMaquina,
  grupoDaProposta,
  rotuloDaMarcacao,
  rotuloDoRefrao,
  textoAplicado,
  textoDaOfertaDeTranscricao,
  textoDaTranscricaoIndisponivel,
  textoDoCabecalho,
  textoDoGrupoDobrado,
  textoDoProgressoDaTranscricao,
  textoDoTempoDaTranscricao,
  textoSemPropostas,
  tituloDoGrupo,
  type GrupoDaRevisao,
} from "../lib/curadoria";
import { useEnrichStore } from "../stores/enrichStore";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlayerStore } from "../stores/playerStore";
import { usePlaylistStore } from "../stores/playlistStore";
import { useToastStore } from "../stores/toastStore";

/**
 * Seleção inicial: o corte é por RISCO, não por confiança (PRD V10).
 *
 * A medição que mandou nesta rodada, do dono do produto revisando 53 músicas:
 * *"eu nem li as sugestões em baixa… não deu vontade de ler mesmo"*. Não é
 * preferência, é comportamento — e é o que as 40 pessoas vão fazer.
 *
 * Chega marcado o que **não tem nada a perder**:
 *
 * - o grupo dobrado (`preenchimentos`): a proposta só preenche campo VAZIO.
 *   Antes só a ALTA vinha marcada, e por isso os 72 palpites de nome de
 *   arquivo — que acertam quase sempre e são a principal coisa que o app faz
 *   por este repertório — chegavam desmarcados no meio do ruído;
 * - a letra achada em ALTA, como sempre (DECISIONS #49).
 *
 * Nunca chega marcado o que desfaz trabalho humano:
 *
 * - trocar um título ou artista ESCRITO POR GENTE (V9);
 * - o conflito, que nem é proposta — são duas fontes discordando;
 * - marcar como instrumental, que tira o arquivo da fila de letra para sempre
 *   e só o editor desfaz (DECISIONS #71);
 * - substituir uma letra existente, que tem a sua própria marcação separada
 *   (DECISIONS #79).
 */
function defaultSelection(
  proposals: EnrichProposal[],
  applyErrors: Record<number, string>,
  aplicadas: ReadonlySet<number>,
): Set<number> {
  const marcadas = new Set<number>();
  proposals.forEach((p, i) => {
    if (p.error !== null || applyErrors[p.song_id] !== undefined) return;
    // V10.6 — linha já gravada não é decisão: pré-marcá-la ofereceria de novo o
    // clique que acabou de acontecer
    if (aplicadas.has(i)) return;
    const grupo = grupoDaProposta(p, null);
    if (grupo === "preenchimentos" || (grupo === "letras" && p.confidence === "alta")) {
      marcadas.add(i);
    }
  });
  return marcadas;
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

/**
 * Esta linha gravaria letra NOVA por cima de uma letra que já existe?
 *
 * `atual` é o estado do ARQUIVO, e não o eco da proposta: uma gravação anterior
 * DESTA revisão pode ter posto letra ali (V10.6 — aplicar não fecha mais a
 * caixa), e a linha que vem depois tem de avisar sobre a letra que existe agora.
 */
function substituiriaLetra(
  p: Pick<EnrichProposal, "lyrics">,
  atual: { has_lyrics: boolean },
  erro: string | null,
): boolean {
  if (p.lyrics === null) return false;
  return atual.has_lyrics || erroPedeConsentimento(erro);
}

const BADGES: Record<
  EnrichProposal["confidence"],
  { label: string; className: string }
> = {
  alta: { label: "ALTA", className: "bg-success-soft text-success" },
  media: { label: "MÉDIA", className: "bg-warning-soft-alt text-warning" },
  // `ink-tertiary` sobre `surface-hover` dava 4,39:1 — abaixo de AA.
  // `ink-quaternary` dá 5,44:1 (DECISIONS #69: contraste mínimo vale para
  // texto secundário também).
  baixa: { label: "BAIXA", className: "bg-surface-hover text-ink-quaternary" },
};

/**
 * A linha de conflito não tem confiança que sirva de rótulo: a dela é sempre
 * "baixa" (para nunca chegar pré-marcada), e "BAIXA" descreveria um palpite
 * fraco — que não é o caso. O que ela é está escrito no selo.
 */
const BADGE_CONFLITO = {
  label: "CONFLITO",
  className: "bg-warning-soft text-warning",
};

/** V10 — a etapa 5 concluiu que não há voz: também não é palpite fraco. */
const BADGE_SEM_VOZ = {
  label: "SEM VOZ",
  className: "bg-warning-soft text-warning",
};

/**
 * V10.6 — a linha já foi gravada nesta revisão.
 *
 * Ela existe porque aplicar deixou de fechar a caixa (era o fechamento que
 * jogava fora a lista das músicas sem letra). `brand-strong` sobre
 * `brand-soft-hover` dá 6,7:1 no claro (e passa também no escuro) — o mesmo
 * verde do resto do produto, acima de AA.
 */
const BADGE_GRAVADA = {
  label: SELO_DA_LINHA_GRAVADA,
  className: "bg-brand-soft-hover text-brand-strong",
};

function nomeCompleto(title: string, artist: string | null): string {
  return artist ? `${title} — ${artist}` : title;
}

/**
 * Um lado de um campo em conflito, com a palavra exclusiva em destaque.
 *
 * O caso real repetia o título nas duas linhas e obrigava a comparar dois
 * textos com o olho. O que é igual já saiu (ver `compararConflito`); aqui, o
 * que os dois lados repetem fica apagado e o que só um lado diz ganha peso —
 * "Xangai" aparece nos dois créditos, e é justamente ele que faz os dois
 * parecerem iguais de relance.
 */
function LadoDoConflito({ texto, contra }: { texto: string; contra: string }) {
  if (texto === "") {
    // campo vazio de um dos lados é informação: "(sem artista)" diz que a
    // etiqueta não tem nada ali, e some do texto seria a pessoa concluindo que
    // os dois dizem a mesma coisa
    return <span className="text-ink-quaternary italic">(vazio)</span>;
  }
  return (
    <>
      {destacarDiferenca(texto, contra).map((pedaco, i) => (
        <span
          key={`${pedaco.texto}-${i}`}
          className={
            pedaco.difere ? "font-semibold text-ink" : "text-ink-quaternary"
          }
        >
          {i > 0 ? " " : ""}
          {pedaco.texto}
        </span>
      ))}
    </>
  );
}

/**
 * Overlay de revisão (F13 — PRD V5; V9; V10): progresso da varredura, a lista
 * de propostas ORDENADA POR RISCO, a pergunta do fim sobre a etapa 5 e a
 * aplicação em lote (que nunca renomeia e nunca apaga dados existentes).
 */
export function EnrichReview() {
  const status = useEnrichStore((s) => s.status);
  const overlayOpen = useEnrichStore((s) => s.overlayOpen);
  const progress = useEnrichStore((s) => s.progress);
  const proposals = useEnrichStore((s) => s.proposals);
  const scannedTotal = useEnrichStore((s) => s.scannedTotal);
  // QA A2 — quantas músicas a etapa 2 deixou de perguntar depois de se
  // desligar. Zero é o caso normal e não vira texto nenhum.
  const semPerguntarAoSom = useEnrichStore((s) => s.semPerguntarAoSom);
  // V10 — a pergunta do fim
  const semLetraNoFim = useEnrichStore((s) => s.semLetraNoFim);
  const segundosDeTranscricao = useEnrichStore((s) => s.segundosDeTranscricao);
  // QA A1 — o fato sobre a estimativa: só com ele a frase pode dizer "neste
  // computador" sem afirmar uma medição que não houve (DECISIONS #86 e #106).
  const estimativaMedida = useEnrichStore((s) => s.estimativaMedidaNestaMaquina);
  const transcricao = useEnrichStore((s) => s.transcricao);
  const transcricaoProgress = useEnrichStore((s) => s.transcricaoProgress);
  const transcricaoDispensada = useEnrichStore((s) => s.transcricaoDispensada);
  const startTranscricao = useEnrichStore((s) => s.startTranscricao);
  const dispensarTranscricao = useEnrichStore((s) => s.dispensarTranscricao);
  // erros devolvidos pelo apply, por música (linhas ficam como as com error)
  const applyErrors = useEnrichStore((s) => s.applyErrors);
  // V10.6 — as linhas já gravadas nesta revisão, e o que o disco tem agora
  const aplicadasNaOrdem = useEnrichStore((s) => s.aplicadas);
  const estadoGravado = useEnrichStore((s) => s.gravadas);
  // V10.8 — o que o backend teve a contar sobre uma gravação que DEU CERTO
  const avisosDaGravacao = useEnrichStore((s) => s.avisosDaGravacao);
  const close = useEnrichStore((s) => s.close);
  const hideOverlay = useEnrichStore((s) => s.hideOverlay);
  const registrarAplicacao = useEnrichStore((s) => s.registrarAplicacao);
  const push = useToastStore((s) => s.push);
  /** As linhas gravadas, para consulta por posição. */
  const aplicadas = useMemo(
    () => new Set(aplicadasNaOrdem),
    [aplicadasNaOrdem],
  );
  /**
   * As linhas marcadas, pela POSIÇÃO na lista — não pelo `song_id`.
   *
   * A etapa 5 acrescenta propostas a uma revisão aberta, e a música que sobrou
   * sem letra é justamente a que costuma ter uma proposta de NOME pendente:
   * a mesma música ganha duas linhas, e cada uma é uma decisão. Com a seleção
   * por `song_id`, marcar a letra marcava o nome também — uma caixa mexendo em
   * outra, que é o oposto de "nada é gravado sem você conferir".
   */
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
  /**
   * Os grupos ABERTOS. O grupo dobrado nasce fechado — e só ele; os outros
   * nascem abertos porque cada linha deles pede uma decisão própria.
   */
  const [abertos, setAbertos] = useState<Set<GrupoDaRevisao>>(new Set());
  const [busy, setBusy] = useState(false);
  /** Único texto lido por leitor de tela: só transições, nunca cada arquivo. */
  const [anuncio, setAnuncio] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  /**
   * A lista de propostas do render anterior, para distinguir a lista TROCADA
   * (varredura nova) da lista ACRESCENTADA (a etapa 5 chegando).
   */
  const propostasAnteriores = useRef<readonly EnrichProposal[]>([]);

  // a varredura resolve com o overlay já aberto: re-inicializa a seleção
  useEffect(() => {
    const anteriores = propostasAnteriores.current;
    propostasAnteriores.current = proposals;
    /*
      QA M2 — a etapa 5 termina HORAS depois e ACRESCENTA propostas a esta
      revisão. `proposals` muda de identidade, e recalcular a seleção do zero
      apagava a conferência já feita: o grupo dobrado que a pessoa desmarcou
      de propósito voltava pré-marcado, e o que ela marcou à mão sumia — sem
      aviso, e possivelmente sem ninguém olhando.

      "Acrescentou" é reconhecido por REFERÊNCIA: o `startTranscricao` faz
      `[...anteriores, ...novas]`, então as antigas continuam sendo os MESMOS
      objetos nas MESMAS posições — e a seleção é por posição. Qualquer outra
      mudança (varredura nova, fechar) cai no caminho de baixo e recomeça do
      padrão, que é o comportamento de sempre.

      V10.6 — e a LISTA IGUAL não mexe em nada. Aplicar deixou de fechar a
      caixa, então o que muda depois de um apply é `applyErrors`/`aplicadas`, com
      `proposals` continuando o MESMO array. Recalcular o padrão aqui apagaria a
      conferência da pessoa a cada gravação — a mesma perda do M2, por outra
      porta.
    */
    if (proposals === anteriores) return;
    const acrescentou =
      anteriores.length > 0 &&
      proposals.length > anteriores.length &&
      anteriores.every((p, i) => proposals[i] === p);
    const padrao = defaultSelection(proposals, applyErrors, aplicadas);
    if (acrescentou) {
      // o padrão vale só para as propostas NOVAS — ninguém as viu ainda
      setSelected((atual) => {
        const juntas = new Set(atual);
        for (const i of padrao) if (i >= anteriores.length) juntas.add(i);
        return juntas;
      });
      // consentimentos e o grupo que a pessoa abriu também são conferência
      // feita: zerá-los aqui fecharia a lista debaixo da mão dela
      return;
    }
    setSelected(padrao);
    setSubstituir(new Set());
    setConsentidos(new Set());
    setAbertos(new Set());
  }, [proposals, applyErrors, aplicadas]);

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
    // QA A2 — o aviso das músicas não perguntadas entra também aqui: quem ouve
    // a tela em vez de vê-la recebe o mesmo desfecho, não um resumo otimista.
    const naoPerguntadas = avisoSemPerguntarAoSom(atual.semPerguntarAoSom);
    const desfecho =
      atual.proposals.length === 0
        ? textoSemPropostas(atual.scannedTotal, atual.semPerguntarAoSom)
        : atual.proposals.length === 1
          ? `1 proposta para revisar.${naoPerguntadas ? ` ${naoPerguntadas}` : ""}`
          : `${atual.proposals.length} propostas para revisar.${naoPerguntadas ? ` ${naoPerguntadas}` : ""}`;
    setAnuncio(`Busca concluída. ${desfecho}`);
  }, [visible, status]);

  // Esc SAI do overlay; exceto no meio de uma gravação (busy). Durante a
  // varredura ou a transcrição sair é MANDAR PARA SEGUNDO PLANO (as duas são
  // somente leitura — cancelar exige o botão explícito); na revisão descarta.
  useEffect(() => {
    if (!visible) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape" || busy) return;
      const atual = useEnrichStore.getState().status;
      if (atual === "scanning" || atual === "transcribing") {
        hideOverlay();
      } else {
        close();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [visible, busy, close, hideOverlay]);

  if (!visible) return null;

  /**
   * O que o ARQUIVO tem agora para esta música (V10.6).
   *
   * A proposta carrega o eco do instante da varredura, e aplicar deixou de
   * fechar a caixa: uma gravação desta mesma revisão pode ter mudado o nome e a
   * letra do arquivo. Quem manda o eco velho no apply seguinte é recusado com "a
   * música mudou depois da busca" (QA A5) — e ela mudou, sim: mudamos nós, um
   * clique antes. A `Song` que o backend devolveu é a verdade mais nova que
   * existe aqui.
   */
  function estadoAtual(p: EnrichProposal): {
    current_title: string;
    current_artist: string | null;
    has_lyrics: boolean;
    letra_origem: string | null;
  } {
    const g = estadoGravado[p.song_id];
    if (g === undefined) {
      return {
        current_title: p.current_title,
        current_artist: p.current_artist,
        has_lyrics: p.has_lyrics,
        letra_origem: p.letra_origem,
      };
    }
    return {
      current_title: g.title,
      current_artist: g.artist,
      has_lyrics: g.has_lyrics,
      letra_origem: g.letra_origem ?? null,
    };
  }

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
      className="rounded-md px-4 py-2 text-[15px] font-medium text-ink-secondary hover:bg-surface-hover disabled:opacity-60"
    >
      Fechar
    </button>
  );

  function toggle(linha: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(linha)) {
        next.delete(linha);
      } else {
        next.add(linha);
      }
      return next;
    });
  }

  /**
   * Marca/desmarca a substituição da letra desta linha. Marcar é também a
   * resposta ao backend que recusou por falta de consentimento: a linha
   * destrava e passa a valer para o próximo "Aplicar".
   */
  function toggleSubstituir(songId: number, linha: number) {
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
    if (marcando) setSelected((prev) => new Set(prev).add(linha));
  }

  async function handleApply() {
    /*
      As POSIÇÕES enviadas neste apply — é por elas que a linha vira "gravada".
      A linha já gravada nunca entra: aplicar duas vezes a mesma linha
      escreveria o mesmo dado por cima e, quando o nome mudou, seria recusada
      com "a música mudou depois da busca" (V10.6).
    */
    const linhas = proposals.flatMap((p, i) =>
      rowError(p) === null && selected.has(i) && !aplicadas.has(i) ? [i] : [],
    );
    const chosen = linhas.map((i) => proposals[i]);
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

    /**
     * UMA gravação por música, mesmo com duas linhas marcadas.
     *
     * Cada linha é uma decisão (o modelo da tela inteira), mas o `apply`
     * confere o eco `current_title`/`current_artist` contra o disco antes de
     * gravar (QA A5): duas gravações para a mesma música fariam a segunda ser
     * recusada com "a música mudou depois da busca" — uma falha inventada por
     * nós, no meio de um lote que a pessoa marcou inteiro.
     *
     * A ordem das linhas é a ordem de RISCO, então a primeira que propõe nome
     * é a que manda no nome; a letra vem de quem a traz, com a procedência
     * DELA (é o `fonte` que decide o `TXXX:LETRA_ORIGEM`).
     */
    const porMusica = new Map<number, EnrichApply>();
    for (const p of chosen) {
      const atual = estadoAtual(p);
      const trocaLetra = substituiriaLetra(p, atual, applyErrors[p.song_id] ?? null);
      const consentida = substituir.has(p.song_id);
      const letra = trocaLetra && !consentida ? null : (p.lyrics ?? null);
      // V9 — aceitar um conflito é aceitar o que o SOM disse: `proposed_*`
      // repete a etiqueta atual nessas linhas (elas não propõem nada), então
      // gravar dali seria gravar o que já está lá.
      const daLinha: EnrichApply = {
        song_id: p.song_id,
        title: p.conflito ? p.conflito.titulo : p.proposed_title,
        artist: p.conflito ? p.conflito.artista : (p.proposed_artist ?? null),
        lyrics: p.conflito ? null : letra,
        add_temas: null,
        // V10.6 — o eco é o do ARQUIVO agora, e não o do instante da varredura:
        // uma gravação desta mesma revisão pode ter mudado o nome
        current_title: atual.current_title,
        current_artist: atual.current_artist,
        // a procedência viaja junto: é ela que decide o TXXX:LETRA_ORIGEM
        fonte: p.fonte || null,
        ...(trocaLetra && consentida ? { substituir_letra: true } : {}),
        // V10 — a marca de instrumental só viaja quando a proposta a trouxe E
        // a pessoa marcou a linha. Nunca `false`: desmarcar continua sendo
        // exclusividade do editor (DECISIONS #71).
        ...(p.marcar_instrumental ? { marcar_instrumental: true } : {}),
      };
      const anterior = porMusica.get(p.song_id);
      if (!anterior) {
        porMusica.set(p.song_id, daLinha);
        continue;
      }
      // Junta as decisões: o NOME é o da primeira linha que propôs um (ela vem
      // antes na ordem de risco), e a LETRA é a da linha que a trouxe — com o
      // `fonte` dela, senão a procedência gravada seria a da linha errada.
      const nomeNovo =
        anterior.title !== anterior.current_title ||
        (anterior.artist ?? null) !== (anterior.current_artist ?? null);
      porMusica.set(p.song_id, {
        ...anterior,
        title: nomeNovo ? anterior.title : daLinha.title,
        artist: nomeNovo ? anterior.artist : daLinha.artist,
        lyrics: anterior.lyrics ?? daLinha.lyrics,
        fonte: anterior.lyrics !== null ? anterior.fonte : daLinha.fonte,
        ...(anterior.substituir_letra || daLinha.substituir_letra
          ? { substituir_letra: true }
          : {}),
        ...(anterior.marcar_instrumental || daLinha.marcar_instrumental
          ? { marcar_instrumental: true }
          : {}),
      });
    }
    const aplicacoes: EnrichApply[] = [...porMusica.values()];
    /** O que foi realmente ENVIADO por música — é isso que o aviso conta. */
    const enviado = new Map(aplicacoes.map((a) => [a.song_id, a]));

    // Estado ANTES da gravação: é a única forma honesta de dizer "ganhou
    // letra" — uma proposta com letra pode ser para uma música que já tinha
    // letra e só estava sem artista.
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
        // uma tarefa a fazer". Os grupos são disjuntos: senão as contas
        // somariam mais que o total.
        let ganharamLetra = 0;
        let letraSubstituida = 0;
        let marcadasInstrumental = 0;
        let nomeCorrigido = 0;
        for (const r of gravadas) {
          const p = proposals.find((x) => x.song_id === r.song_id);
          const a = enviado.get(r.song_id);
          if (!p || !a) continue;
          // V10.6 — o "antes" desta gravação é o estado do ARQUIVO, e não o eco
          // da varredura: numa segunda aplicação da mesma música o nome já é o
          // que gravamos, e comparar com o eco velho contaria uma correção que
          // não houve
          const atual = estadoAtual(p);
          // conta pelo que FOI ENVIADO: a linha marcada sem substituição não
          // mandou letra nenhuma, e dizer que ela "ganhou letra" seria contar
          // uma mudança que não houve
          if (a.lyrics !== null) {
            if (antes.get(p.song_id) === true) {
              letraSubstituida++;
            } else {
              ganharamLetra++;
            }
          } else if (a.marcar_instrumental === true) {
            // V10 — a marca é a mudança desta linha, e a única deste aviso que
            // NÃO aparece na lista depois: a música some da fila de letra
            marcadasInstrumental++;
          } else if (
            // compara com o que FOI ENVIADO, não com `proposed_*`: na linha de
            // conflito o proposto repete o atual, e contar por ele diria
            // "gravada, sem mudança no conteúdo" sobre uma troca de nome
            a.title !== atual.current_title ||
            (a.artist ?? null) !== (atual.current_artist ?? null)
          ) {
            nomeCorrigido++;
          }
        }
        push(
          textoAplicado({
            ganharamLetra,
            letraSubstituida,
            marcadasInstrumental,
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

      /*
        V10.6 — APLICAR NÃO FECHA A CAIXA.

        Era isto que jogava fora a lista das músicas sem letra: a oferta de
        transcrição vivia dentro desta caixa, e recuperá-la custava a varredura
        inteira — minutos, numa biblioteca grande. Agora a caixa fica, cada linha
        recebe o seu desfecho (gravada, ou o erro do backend) e a oferta continua
        onde estava. Fechar passou a ser só do botão "Fechar" e do Esc.

        A5 continua valendo, e melhor: a linha que não gravou fica na tela com o
        motivo, ao lado das que gravaram — antes as gravadas saíam da lista, e
        quem visse só as recusadas não tinha como saber que o resto foi.
      */
      registrarAplicacao(linhas, results);
      // as linhas gravadas saem da seleção (não há o que aplicar nelas), e as
      // que falharam também: quem responde a um erro é a marcação de
      // consentimento, e o "Aplicar" volta a valer com ela
      setSelected((prev) => {
        const next = new Set(prev);
        for (const i of linhas) next.delete(i);
        return next;
      });
    } catch {
      // defensivo: invoke rejeitado (erro de infraestrutura, não por música)
      push("Não foi possível aplicar as alterações.", "error");
    } finally {
      setBusy(false);
    }
  }

  // MÉDIO-12 — o cabeçalho conta OFERTAS. Linha com erro não é proposta: ela
  // existe para informar que a música foi tentada e falhou. V10.6 — nem linha
  // JÁ GRAVADA: ela não é mais uma decisão, e contá-la faria o cabeçalho pedir
  // uma conferência que já aconteceu.
  const ofertas = proposals.filter(
    (p, i) => rowError(p) === null && !aplicadas.has(i),
  );
  const grupos = agruparPorRisco(proposals, rowError, (i) => aplicadas.has(i));
  const tituloDoCabecalho = textoDoCabecalho(ofertas.length);

  /** As linhas de um grupo que podem ser marcadas em massa. */
  function marcaveisDoGrupo(grupo: GrupoDaRevisao): number[] {
    return (
      grupos
        .find((g) => g.grupo === grupo)
        ?.propostas.map((p) => proposals.indexOf(p))
        .filter((i) => rowError(proposals[i]) === null && !aplicadas.has(i)) ?? []
    );
  }

  /** V10 — a pergunta do fim: só depois da varredura, e só uma vez. */
  const perguntaDoFim =
    status === "review" && semLetraNoFim.length > 0 && !transcricaoDispensada;

  /** Uma linha da revisão — a mesma para todos os grupos. */
  function Linha({ p, linha }: { p: EnrichProposal; linha: number }) {
    const error = rowError(p);
    /** V10.6 — esta linha já foi gravada nesta revisão. */
    const gravada = aplicadas.has(linha);
    const disabled = error !== null || gravada;
    const atual = estadoAtual(p);
    const badge = gravada
      ? // a confiança descrevia um palpite a decidir, e não há mais nada a
        // decidir nesta linha: deixá-la ali a faria parecer pendente
        BADGE_GRAVADA
      : p.conflito
        ? BADGE_CONFLITO
        : p.marcar_instrumental
          ? BADGE_SEM_VOZ
          : BADGES[p.confidence];
    const trocaLetra =
      !gravada && substituiriaLetra(p, atual, applyErrors[p.song_id] ?? null);
    const comparacao = p.conflito
      ? compararConflito(
          { titulo: p.current_title, artista: p.current_artist },
          { titulo: p.conflito.titulo, artista: p.conflito.artista },
        )
      : null;
    return (
      <li
        className={`flex items-start gap-3 py-2 ${
          // a linha com ERRO fica apagada: ela não é acionável e o que importa
          // nela é a frase vermelha. A GRAVADA fica em tinta cheia — ela é o
          // registro do que a pessoa acabou de fazer, e é o que ela vai reler
          // para conferir; opacidade em cima do cinza secundário derrubaria o
          // contraste abaixo de AA (DECISIONS #69)
          error !== null ? "opacity-60" : ""
        }`}
      >
        <input
          type="checkbox"
          // o rótulo diz o que ESTA linha decide: a mesma música pode ter duas
          // (o nome pendente e o que a etapa 5 trouxe), e duas caixas com o
          // mesmo nome são indistinguíveis para quem ouve a tela
          aria-label={rotuloDaMarcacao(p)}
          disabled={disabled || busy}
          checked={!disabled && selected.has(linha)}
          onChange={() => toggle(linha)}
          className="mt-1 h-4 w-4 shrink-0 accent-brand"
        />
        <span className="min-w-0 flex-1">
          {comparacao ? (
            /*
              V9 + V10 — aqui NÃO cabe "atual → proposto": nada foi proposto.
              Duas fontes discordam, cada uma nomeada por quem a disse. E o que
              as duas dizem IGUAL sai da comparação: repetir o título nas duas
              linhas obrigava a compará-las com o olho.
            */
            <span className="flex flex-col gap-0.5 text-[14px]">
              {comparacao.iguais.map((igual) => (
                <span key={igual.campo} className="break-words text-ink">
                  {igual.valor}
                </span>
              ))}
              {comparacao.diferem.map((campo) => (
                <span key={campo.campo} className="flex flex-col gap-0.5">
                  <span className="min-w-0 break-words">
                    <span className="text-ink-quaternary">{LABEL_SUA_ETIQUETA_DIZ}:</span>{" "}
                    <LadoDoConflito texto={campo.etiqueta} contra={campo.som} />
                  </span>
                  <span className="min-w-0 break-words">
                    <span className="text-ink-quaternary">{LABEL_SOM_DIZ}:</span>{" "}
                    <LadoDoConflito texto={campo.som} contra={campo.etiqueta} />
                  </span>
                </span>
              ))}
              <span className="text-[13px] text-ink-quaternary">
                {confiancaDoSom(p.conflito!.confianca)}
              </span>
            </span>
          ) : (
            <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[14px]">
              <span className="truncate text-ink-tertiary">
                {nomeCompleto(p.current_title, p.current_artist)}
              </span>
              {/* a seta é decorativa (aria-hidden), mas continua sendo tinta
                  na tela de quem enxerga pouco: `disabled` dava 2,5:1 no branco.
                  `ink-tertiary` dá 4,8:1 (DECISIONS #76). */}
              <span aria-hidden="true" className="text-ink-tertiary">
                →
              </span>
              <span className="truncate font-medium text-ink">
                {nomeCompleto(p.proposed_title, p.proposed_artist)}
              </span>
            </span>
          )}
          {error !== null && (
            <span className="block text-[13px] text-danger">{error}</span>
          )}
          {/*
            V10.6 — o desfecho da linha, para quem acabou de aplicar e continua
            olhando a mesma caixa. Ela não pede nada: é registro.
          */}
          {gravada && (
            <span className="block text-[13px] font-medium text-brand">
              {ROTULO_DA_LINHA_GRAVADA}
            </span>
          )}
          {/*
            V10.8 — o desfecho de uma gravação que precisou consertar algo no
            arquivo. Vem DEPOIS do "Gravada no arquivo." de propósito: a primeira
            coisa a ler é que deu certo, e só então o que foi preciso fazer para
            dar certo.

            Cinza secundário, e não âmbar: âmbar é ressalva ("vale ler antes de
            aplicar"), e aqui não há nada a decidir nem a conferir — a gravação
            aconteceu, o áudio foi conferido, e isto é registro. Âmbar numa linha
            que deu certo ensinaria a ler âmbar como enfeite.
          */}
          {gravada && avisosDaGravacao[p.song_id] !== undefined && (
            <span className="mt-0.5 block text-[13px] leading-relaxed text-ink-quaternary">
              {avisosDaGravacao[p.song_id]}
            </span>
          )}
          {error === null && !gravada && (
            // V8/F18 — procedência sempre à vista: ALTA vinda do LRCLIB (que
            // confere a duração) e ALTA vinda de um palpite de nome de arquivo
            // não se decidem igual.
            <span className="flex flex-wrap gap-x-2 text-[13px]">
              {p.lyrics !== null && (
                <span className="text-brand">letra encontrada</span>
              )}
              {p.fonte && <span className="text-ink-quaternary">via {p.fonte}</span>}
            </span>
          )}
          {/*
            V10 — o refrão existe para reconhecer a música SEM abrir a letra.
            Quem vai conferir 47 letras escritas por máquina precisa disto na
            linha, ou vai aplicar no escuro.
          */}
          {error === null && p.refrao && (
            <span className="mt-0.5 block truncate text-[13px] text-ink-quaternary">
              {rotuloDoRefrao(p.refrao)}
            </span>
          )}
          {/* V5/F14 — letra de transcrição é letra de MÁQUINA, e a revisão diz
              isso ANTES de aplicar (o painel de letra avisa depois). */}
          {error === null && !gravada && p.lyrics !== null && ehLetraDeMaquina(p.fonte) && (
            <span className="mt-0.5 block text-[13px] text-warning">
              {AVISO_LETRA_DE_MAQUINA}
            </span>
          )}
          {/*
            V10 — a marca de instrumental tira o arquivo da fila de letra para
            sempre, e só o editor a desfaz: a linha diz o que o clique faz, e o
            `aviso` do backend traz a medição que sustenta a conclusão.
          */}
          {error === null && !gravada && p.marcar_instrumental && (
            <span className="mt-0.5 block text-[13px] text-warning">
              {AVISO_MARCAR_INSTRUMENTAL}
            </span>
          )}
          {/*
            `aviso` é diferente de `error`: ele explica uma linha APLICÁVEL.
            Pôr isto em `error` desabilitaria justamente a linha que precisa de
            um clique.

            O PESO muda com o que o aviso é. Na linha da etapa 4 (lyrics.ovh)
            ele é uma RESSALVA — "este site não diz a que música a letra
            pertence" —, e essa fonte é a única do funil cujo casamento o
            programa não tem como conferir: ela pode entregar a letra de "Ponto
            de Ogum" para um pedido de "Ponto de Oxum" e ninguém percebe. O
            teto MÉDIA tira a pré-marcação, mas só protege quem saiba POR QUÊ,
            e a medição de campo foi "eu nem li as sugestões em baixa". Então
            aqui ele tem o âmbar das outras ressalvas da linha.

            Na linha de instrumental ele é a MEDIÇÃO que sustenta a conclusão
            ("20 caracteres em 5m00s dão 0,07"), logo abaixo de uma ressalva
            que já está em âmbar — e duas linhas âmbar seguidas na mesma
            proposta é o ruído que ensina a ignorar as duas.
          */}
          {error === null && p.aviso && (
            <span
              className={`mt-0.5 block text-[13px] leading-relaxed ${
                p.marcar_instrumental ? "text-ink-quaternary" : "text-warning"
              }`}
            >
              {p.aviso}
            </span>
          )}
          {/*
            V9 — proposta que trocaria um nome escrito por gente chega
            DESMARCADA, e a linha diz por quê: sem isto o selo verde ao lado de
            uma caixa vazia não se explica.
          */}
          {error === null && !gravada && p.substitui_nome_escrito && (
            <span className="mt-0.5 block text-[13px] text-warning">
              {AVISO_NOME_ESCRITO}
            </span>
          )}
          {/*
            CRÍTICO-1 — a linha que substituiria uma letra existente DIZ isso,
            visível, e traz a sua própria marcação. Ela aparece mesmo com erro:
            quando a recusa do backend foi a falta deste consentimento, é aqui
            que a pessoa responde.
          */}
          {trocaLetra && (
            <>
              <span className="mt-0.5 block text-[13px] text-warning">
                {avisoLetraExistente(p.letra_origem)}
              </span>
              <label className="mt-0.5 flex items-start gap-2 text-[13px] text-ink-secondary">
                <input
                  type="checkbox"
                  aria-label={`${LABEL_SUBSTITUIR_LETRA}: ${p.current_title}`}
                  disabled={busy}
                  checked={substituir.has(p.song_id)}
                  onChange={() => toggleSubstituir(p.song_id, linha)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-brand"
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
      {/* V11 (achado de campo) — era `bg-white` fixo: no escuro o fundo
          continuava branco com texto claro por cima, ilegível. `bg-surface`
          é o mesmo branco no claro e o card escuro no escuro, igual ao
          ConfirmDialog e ao NewPlaylistDialog. */}
      <div className="flex max-h-[calc(100vh-4rem)] w-[640px] max-w-[calc(100vw-2rem)] flex-col rounded-lg bg-surface p-5 shadow-xl">
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
        ) : proposals.length === 0 && !perguntaDoFim ? (
          <>
            {/* A6: "nada a ajustar" com 81 conferidas soava como "pasta
                completa" — o texto conta o que houve e para onde ir */}
            <p className="py-4 text-[15px] text-ink">
              {textoSemPropostas(scannedTotal, semPerguntarAoSom)}
            </p>
            <div className="mt-2 flex justify-end">{closeButton}</div>
          </>
        ) : (
          <>
            {/*
              QA A2 — o desfecho COM propostas também precisa dizer o que NÃO
              foi feito. Fica acima do cabeçalho, e não no fim da lista, porque
              a lista rola. Zero não desenha nada.
            */}
            {avisoSemPerguntarAoSom(semPerguntarAoSom) !== null && (
              <p className="mb-2 rounded-md bg-warning-soft px-3 py-2 text-[13px] leading-relaxed text-warning">
                {avisoSemPerguntarAoSom(semPerguntarAoSom)}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2 pb-3">
              <h2 className="text-[16px] font-semibold text-ink">
                {tituloDoCabecalho}
              </h2>
              <span className="ml-auto flex gap-2">
                <button
                  type="button"
                  // marca as linhas aplicáveis e SÓ isso. Três coisas nunca
                  // entram num gesto de massa: substituir uma letra
                  // (CRÍTICO-1), aceitar o que o som diz contra uma etiqueta
                  // real (V9) e marcar uma música como instrumental (V10) —
                  // esta última some da fila de letra para sempre e só o
                  // editor a desfaz.
                  // V10.6 — e a linha JÁ GRAVADA também não: não há o que
                  // marcar nela.
                  onClick={() =>
                    setSelected(
                      new Set(
                        proposals.flatMap((p, i) =>
                          rowError(p) === null &&
                          !aplicadas.has(i) &&
                          p.conflito === null &&
                          !p.marcar_instrumental
                            ? [i]
                            : [],
                        ),
                      ),
                    )
                  }
                  className="rounded-md px-2 py-1 text-[13px] font-medium text-brand hover:bg-brand-soft"
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
                  className="rounded-md px-2 py-1 text-[13px] font-medium text-brand hover:bg-brand-soft"
                >
                  Desmarcar todas
                </button>
              </span>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {grupos.map(({ grupo, propostas }) => {
                /*
                  Nascem FECHADOS o grupo dobrado e — desde a V10.6 — o das
                  GRAVADAS; os outros, abertos.

                  Dobrado não é escondido: a frase diz o número e o que aquelas
                  linhas são, e o grupo continua abrível. No grupo dobrado ela
                  diz também o que o clique fará, e por isso ele tem a marcação
                  em massa; no das gravadas não há clique nenhum a descrever —
                  28 linhas "Gravada no arquivo." empurrariam a oferta de
                  transcrição para fora da tela, que é justamente o que esta
                  versão veio consertar.
                */
                const dobravel = grupo === "preenchimentos" || grupo === "gravadas";
                const comMarcacaoEmMassa = grupo === "preenchimentos";
                const aberto = !dobravel || abertos.has(grupo);
                const marcaveis = marcaveisDoGrupo(grupo);
                const todasMarcadas =
                  marcaveis.length > 0 && marcaveis.every((i) => selected.has(i));
                return (
                  <section key={grupo} className="border-t border-surface-hover pt-2">
                    <div className="flex flex-wrap items-center gap-2 pb-1">
                      {comMarcacaoEmMassa && (
                        <input
                          type="checkbox"
                          aria-label={textoDoGrupoDobrado(propostas)}
                          disabled={busy}
                          checked={todasMarcadas}
                          onChange={() =>
                            setSelected((prev) => {
                              const next = new Set(prev);
                              for (const i of marcaveis) {
                                if (todasMarcadas) next.delete(i);
                                else next.add(i);
                              }
                              return next;
                            })
                          }
                          className="h-4 w-4 shrink-0 accent-brand"
                        />
                      )}
                      <h3 className="text-[14px] font-medium text-ink">
                        {comMarcacaoEmMassa
                          ? textoDoGrupoDobrado(propostas)
                          : tituloDoGrupo(grupo, propostas.length)}
                      </h3>
                      {dobravel && (
                        <button
                          type="button"
                          aria-expanded={aberto}
                          onClick={() =>
                            setAbertos((prev) => {
                              const next = new Set(prev);
                              if (next.has(grupo)) next.delete(grupo);
                              else next.add(grupo);
                              return next;
                            })
                          }
                          className="rounded-md px-2 py-1 text-[13px] font-medium text-brand hover:bg-brand-soft"
                        >
                          {aberto ? "fechar" : "abrir para ver"}
                        </button>
                      )}
                    </div>
                    {/*
                      V10 — a confiança do reconhecimento é do RECONHECIMENTO
                      DA GRAVAÇÃO, não da etiqueta estar errada. A frase fica
                      no grupo, e não em cada linha: repetida, vira ruído.
                    */}
                    {grupo === "conflitos" && (
                      <p className="pb-1 text-[13px] leading-relaxed text-ink-quaternary">
                        {EXPLICACAO_DA_CONFIANCA_DO_SOM}
                      </p>
                    )}
                    {aberto && (
                      <ul className="divide-y divide-surface-hover">
                        {propostas.map((p) => (
                          <Linha
                            key={`${p.song_id}-${proposals.indexOf(p)}`}
                            p={p}
                            linha={proposals.indexOf(p)}
                          />
                        ))}
                      </ul>
                    )}
                  </section>
                );
              })}
            </div>

            {/*
              V10 — a pergunta do fim. Ela é feita AQUI porque é aqui que pode
              ser respondida com informação: o app já sabe quantas sobraram sem
              letra e quanto tempo isso leva nesta máquina.
            */}
            {perguntaDoFim && (
              <div className="mt-3 shrink-0 rounded-md bg-brand-soft px-4 py-3">
                <p className="text-[14px] leading-relaxed text-brand-strong">
                  {transcricao.disponivel
                    ? textoDaOfertaDeTranscricao(
                        semLetraNoFim.length,
                        segundosDeTranscricao,
                        estimativaMedida,
                      )
                    : textoDaTranscricaoIndisponivel(
                        semLetraNoFim.length,
                        transcricao.download,
                      )}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {transcricao.disponivel && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void startTranscricao()}
                      className="rounded-md bg-brand-fill px-3 py-1.5 text-[14px] font-medium text-white hover:bg-brand-fill-hover disabled:bg-disabled"
                    >
                      {ROTULO_COMECAR_TRANSCRICAO}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={dispensarTranscricao}
                    className="rounded-md px-3 py-1.5 text-[14px] font-medium text-brand-strong hover:bg-brand-soft-hover"
                  >
                    Agora não
                  </button>
                </div>
              </div>
            )}

            <div className="mt-4 flex shrink-0 flex-wrap items-center justify-end gap-2">
              {/*
                MÉDIO-12 — "Aplicar selecionadas (0)" cinza, sem uma palavra de
                explicação, era um beco: a pessoa tinha acabado de clicar em
                "Marcar todas" e nada acontecera.
              */}
              {selected.size === 0 && (
                <p className="mr-auto text-[13px] text-ink-quaternary">
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
                    ? "bg-disabled"
                    : "bg-brand-fill hover:bg-brand-fill-hover"
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
