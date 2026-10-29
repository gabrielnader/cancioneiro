import { fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  setBackendForTests,
  type Backend,
  type EnrichApply,
  type EnrichApplyResult,
  type EnrichProgress,
  type EnrichProposal,
  type TranscricaoProgresso,
} from "../lib/api";
import {
  AVISO_LETRA_DE_MAQUINA,
  AVISO_MARCAR_INSTRUMENTAL,
  avisoLetraExistente,
  LABEL_SUBSTITUIR_LETRA,
  ROTULO_COMECAR_TRANSCRICAO,
  textoDaOfertaDeTranscricao,
  textoDoTempoDaTranscricao,
  textoSemPropostas,
} from "../lib/curadoria";
import { FONTE_TRANSCRICAO, type Song } from "../lib/types";
import { decisoesPendentes, useEnrichStore } from "../stores/enrichStore";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlayerStore } from "../stores/playerStore";
import { usePlaylistStore } from "../stores/playlistStore";
import { useToastStore } from "../stores/toastStore";
import {
  AA_TEXTO_NORMAL,
  TEXT_COLOR_RE,
  contrastRatio,
  corDoFundo,
  corDoTexto,
} from "../test/contrast";
import { EnrichReview } from "./EnrichReview";

function song(id: number, title: string): Song {
  return {
    id,
    file_path: `/acervo/${id}.mp3`,
    folder_id: 1,
    title,
    artist: null,
    album: null,
    duration_seconds: 3,
    has_lyrics: false,
    available: true,
    temas: null,
  };
}

function proposal(overrides: Partial<EnrichProposal>): EnrichProposal {
  return {
    song_id: 1,
    file_path: "/acervo/1.mp3",
    current_title: "faixa 1",
    current_artist: null,
    proposed_title: "Faixa Um",
    proposed_artist: "Artista Um",
    lyrics: "letra da um",
    confidence: "alta",
    fonte: "LRCLIB",
    // por padrão a música NÃO tem letra: a proposta acrescenta
    has_lyrics: false,
    letra_origem: null,
    // V9 — dois avisos novos, ORTOGONAIS entre si e desligados por padrão
    conflito: null,
    substitui_nome_escrito: false,
    // V10 — três campos novos, todos desligados por padrão: a varredura não
    // marca instrumental, não extrai refrão e não tem aviso a dar
    marcar_instrumental: false,
    refrao: null,
    aviso: null,
    error: null,
    ...overrides,
  };
}


const ALTA = proposal({
  song_id: 1,
  file_path: "/acervo/1.mp3",
  current_title: "faixa 1",
  confidence: "alta",
});
const MEDIA = proposal({
  song_id: 2,
  file_path: "/acervo/2.mp3",
  current_title: "faixa 2",
  current_artist: "Alguém",
  proposed_title: "Faixa Dois",
  proposed_artist: "Artista Dois",
  lyrics: "letra da dois",
  confidence: "media",
});
const BAIXA = proposal({
  song_id: 3,
  file_path: "/acervo/3.mp3",
  current_title: "faixa 3",
  proposed_title: "Faixa Três",
  proposed_artist: null,
  lyrics: null,
  confidence: "baixa",
});


function ok(song: Song, aviso: string | null = null): EnrichApplyResult {
  return { song_id: song.id, song, error: null, aviso };
}


function renderReview(
  proposals: EnrichProposal[],
  scannedTotal = 0,
  /** Quantas a etapa 2 deixou de perguntar (QA A2) — zero é o caso normal. */
  semPerguntarAoSom = 0,
  /** V10 — a pergunta do fim, quando houve quem sobrasse sem letra. */
  fim: {
    semLetraNoFim?: number[];
    segundosDeTranscricao?: number;
    disponivel?: boolean;
    download?: { bytes: number; segundos: number } | null;
    /** QA A1 — a estimativa é medição desta máquina, ou palpite de fábrica? */
    medida?: boolean;
  } = {},
) {
  useEnrichStore.setState({
    status: "review",
    overlayOpen: true,
    folderPrefix: "",
    proposals,
    progress: null,
    scannedTotal,
    semPerguntarAoSom,
    semLetraNoFim: fim.semLetraNoFim ?? [],
    segundosDeTranscricao: fim.segundosDeTranscricao ?? 0,
    estimativaMedidaNestaMaquina: fim.medida ?? false,
    transcricao: {
      disponivel: fim.disponivel ?? false,
      download: fim.download ?? null,
    },
    transcricaoDispensada: false,
    transcricaoProgress: null,
    applyErrors: {},
    aplicadas: [],
    gravadas: {},
    avisosDaGravacao: {},
    mantidas: [],
    autoAplicadas: 0,
  });
  return render(<EnrichReview />);
}

function progresso(
  p: Omit<EnrichProgress, "scan_id"> | null,
): EnrichProgress | null {
  return p === null ? null : { ...p, scan_id: "scan-1" };
}

function renderScanning(progress: Omit<EnrichProgress, "scan_id"> | null = null) {
  useEnrichStore.setState({
    status: "scanning",
    overlayOpen: true,
    folderPrefix: "/x",
    proposals: [],
    progress: progresso(progress),
    scanId: "scan-1",
    scannedTotal: 0,
    applyErrors: {},
  });
  return render(<EnrichReview />);
}

describe("EnrichReview (V5 — F13)", () => {
  beforeEach(() => {
    setBackendForTests(null);
    useEnrichStore.setState({
      status: "idle",
      overlayOpen: false,
      folderPrefix: "",
      proposals: [],
      progress: null,
      scanId: "",
      scannedTotal: 0,
      semPerguntarAoSom: 0,
      semLetraNoFim: [],
      segundosDeTranscricao: 0,
      transcricao: { disponivel: false, download: null },
      transcricaoProgress: null,
      transcricaoDispensada: false,
      applyErrors: {},
      aplicadas: [],
      gravadas: {},
      avisosDaGravacao: {},
      scanInFlight: false,
    });
    useToastStore.setState({ toasts: [] });
    useLibraryStore.setState({ allSongs: [], results: [] });
    usePlaylistStore.setState({ playlists: [], activePlaylistId: null, items: [] });
    usePlayerStore.setState({
      current: null,
      queue: [],
      queueIndex: null,
      detached: false,
      playlistId: null,
      isPlaying: false,
    });
  });

  it("não renderiza nada quando idle", () => {
    const { container } = render(<EnrichReview />);
    expect(container).toBeEmptyDOMElement();
  });

  it("não renderiza nada quando a revisão está em segundo plano (overlay fechado)", () => {
    useEnrichStore.setState({
      status: "review",
      overlayOpen: false,
      folderPrefix: "",
      proposals: [ALTA],
      progress: null,
    });
    const { container } = render(<EnrichReview />);
    expect(container).toBeEmptyDOMElement();
  });

  it("antes do primeiro evento de progresso mantém o aviso indeterminado", () => {
    renderScanning(null);
    expect(
      screen.getByText("Buscando dados… isso pode demorar alguns minutos."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("com progresso mostra barra determinada, contagem e o arquivo atual", () => {
    renderScanning({
      done: 12,
      total: 94,
      atual: "Fulano - Canção.mp3",
      etapa: "procurando no LRCLIB",
    });
    expect(screen.getByText("Buscando dados… 12 de 94")).toBeInTheDocument();
    expect(screen.getByText("Fulano - Canção.mp3")).toBeInTheDocument();
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "12");
    expect(bar).toHaveAttribute("aria-valuemax", "94");
    expect(
      screen.queryByText("Buscando dados… isso pode demorar alguns minutos."),
    ).not.toBeInTheDocument();
  });

  it("nome de arquivo comprido é truncado (não quebra o layout)", () => {
    const atual = `${"nome muito comprido ".repeat(20)}.mp3`;
    renderScanning({ done: 1, total: 2, atual, etapa: "procurando no LRCLIB" });
    expect(screen.getByText(atual).className).toContain("truncate");
  });

  // V8/F18 — "progresso com contagem e barra, a ETAPA atual do funil e o
  // arquivo do momento". Sem a etapa, minutos parados no mesmo número
  // parecem travamento.
  it("mostra a etapa do funil junto da contagem e do arquivo", () => {
    renderScanning({
      done: 25,
      total: 95,
      atual: "a.mp3",
      etapa: "procurando no Vagalume",
    });
    expect(screen.getByText("Etapa: procurando no Vagalume")).toBeInTheDocument();
    expect(screen.getByText("Buscando dados… 25 de 95")).toBeInTheDocument();
  });

  it("backend sem etapa: a linha da etapa some, o resto continua", () => {
    renderScanning({ done: 25, total: 95, atual: "a.mp3", etapa: "" });
    expect(screen.queryByText(/^Etapa:/)).not.toBeInTheDocument();
    expect(screen.getByText("Buscando dados… 25 de 95")).toBeInTheDocument();
  });

  it("'Deixar rodando em segundo plano' esconde o overlay e NÃO cancela a varredura", () => {
    renderScanning({
      done: 3,
      total: 10,
      atual: "a.mp3",
      etapa: "procurando no LRCLIB",
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Deixar rodando em segundo plano" }),
    );
    expect(useEnrichStore.getState().overlayOpen).toBe(false);
    expect(useEnrichStore.getState().status).toBe("scanning");
  });

  it("'Cancelar' durante a varredura descarta tudo e volta a idle", () => {
    renderScanning({
      done: 3,
      total: 10,
      atual: "a.mp3",
      etapa: "procurando no LRCLIB",
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(useEnrichStore.getState().status).toBe("idle");
    expect(useEnrichStore.getState().overlayOpen).toBe(false);
  });


  // A6: 94 conferidas, zero achadas. "Nada a ajustar" fazia o coordenador
  // ler "pasta completa" — o texto tem que dizer o que aconteceu de verdade.
  it("resultado vazio COM candidatas: diz quantas foram conferidas e aponta a transcrição", () => {
    renderReview([], 81);
    expect(screen.getByText(textoSemPropostas(81))).toBeInTheDocument();
    expect(screen.queryByText(textoSemPropostas(0))).not.toBeInTheDocument();
  });

  it("resultado vazio com UMA candidata: texto no singular", () => {
    renderReview([], 1);
    expect(screen.getByText(textoSemPropostas(1))).toBeInTheDocument();
  });

  // MÉDIO-12 — as linhas de ERRO entravam na conta por confiança: com o lote
  // inteiro falhando a pessoa lia "95 propostas — 0 alta, 0 média, 95 baixa",
  // clicava "Marcar todas" (que ignora erros) e recebia "Aplicar selecionadas
  // (0)", desabilitado, sem uma linha de explicação.

  // V10 — o cabeçalho contava por CONFIANÇA ("0 alta, 0 média, 95 baixa"), e
  // era ele ensinando a ignorar as de baixa. Quem diz o que cada coisa é agora
  // é o título de cada grupo; aqui fica só o tamanho do trabalho.
  it("o cabeçalho não fala mais em confiança", () => {
    renderReview([ALTA, MEDIA, BAIXA]);
    const h2 = screen.getByRole("heading", { level: 2 });
    expect(h2.textContent ?? "").not.toContain("baixa");
    expect(h2.textContent ?? "").not.toContain("alta");
  });

  // V10 — a letra em ALTA continua pré-marcada (DECISIONS #49); a letra em
  // MÉDIA, não. A BAIXA sem letra saiu desta conversa: ela só preenche campo
  // vazio, então mora no grupo dobrado e chega MARCADA (o corte é por risco).


  // V8/F18 — a MESMA confiança significa coisas diferentes vindo do LRCLIB
  // (com duração conferida) ou de um palpite de nome de arquivo. Quem decide
  // precisa ver a procedência sem abrir nada.


  // V10 — BAIXA sem letra é preenchimento de campo vazio: ela chega MARCADA,
  // no grupo dobrado, e continua DESMARCÁVEL uma a uma (dobrado ≠ escondido).

  // A5: o backend recusa a proposta cuja música mudou depois da varredura —
  // aplicar não pode reverter em silêncio a edição manual do usuário.

  // -------------------------------------------------------------------------
  // CRÍTICO-1 — a revisão não sabia nem mostrava que uma letra seria destruída
  // -------------------------------------------------------------------------
  describe("proposta que substituiria uma letra existente", () => {


    it("música sem letra nenhuma não ganha aviso nem marcação de substituição", () => {
      renderReview([ALTA]);
      expect(screen.queryByText(/já tem letra/)).not.toBeInTheDocument();
      expect(
        screen.queryByRole("checkbox", { name: new RegExp(LABEL_SUBSTITUIR_LETRA) }),
      ).not.toBeInTheDocument();
    });

    // MÉDIO-13 — a metade destrutiva ficava invisível: a linha era contada
    // como "teve título ou artista corrigido".

    // O backend pode recusar mesmo assim: o banco dizia "sem letra" e o
    // arquivo tinha (alguém escreveu à mão durante a varredura). A linha
    // precisa mostrar a mensagem — e oferecer o caminho que ela indica.
  });

  // -------------------------------------------------------------------------
  // V9 — o som contra a etiqueta: dois lados, nada pré-marcado
  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // QA A2 — o que a varredura NÃO fez também é desfecho
  // -------------------------------------------------------------------------
  //
  // Uma falha do `fpcalc` desligava a etapa 2 pelo resto da varredura. A tela
  // mostrava UMA linha vermelha e o silêncio das outras 149 — e o silêncio era
  // lido como aprovação. O backend passou a contar; se a tela não disser o
  // número, o defeito continua igual (DECISIONS #86).
  describe("as músicas que não chegaram a ser perguntadas ao som", () => {


    // A lista rola: um aviso sobre o ALCANCE da varredura embaixo de 95 linhas
    // é um aviso que ninguém lê. Ele fica acima do cabeçalho de contagem.

    // Sem propostas o desfecho é UM texto só: o de sempre já passa a contar as
    // não perguntadas, então dois avisos seriam a mesma coisa dita duas vezes.

    // Quem ouve a tela em vez de vê-la recebe o mesmo desfecho, não um resumo
    // otimista: a região viva é o único texto que o leitor de tela anuncia.
    it("a região viva anuncia o desfecho junto com o número", () => {
      renderReview([ALTA], 40, 37);
      const vivo = document.querySelector("[role='status']");
      expect(vivo?.textContent ?? "").toContain("37");
    });

  });


  // -------------------------------------------------------------------------
  // V9 — ALTA que trocaria um nome escrito por gente não chega pré-marcada
  // -------------------------------------------------------------------------

  // O overlay é lido em notebook, em sala mal iluminada, por quem está
  // conduzindo uma reunião (DECISIONS #69/#76). O texto novo desta rodada — o
  // aviso de letra existente, o rótulo da substituição, a nota das linhas com
  // erro e o motivo do botão desabilitado — entra medido, ou não entra.

  /*
    Achado de campo (V11) — o teste acima só conferia o tema CLARO (o
    "#FFFFFF" fixo de fallback era, coincidentemente, o `bg-white` que o
    modal tinha antes do conserto). Nada neste arquivo conferia o ESCURO:
    foi assim que o fundo fixo sobreviveu à bateria inteira de contraste.
    Estes três testes repetem a mesma varredura — review, varredura e
    transcrição — resolvendo cada token contra `CORES_ESCURO` (a mesma fonte
    do index.css que os utilitários de `contrast.ts` já leem).
  */
  describe("achado de campo — contraste no tema ESCURO (V11)", () => {
    /** Fundo do CARD do modal no escuro — mesma fonte que resolve os tokens. */
    const fundoDoDialogEscuro = corDoFundo("bg-surface", "escuro")!;

    function conferirContrasteEscuro(dialog: HTMLElement) {
      const comCor = [...dialog.querySelectorAll<HTMLElement>("*")].filter((el) =>
        TEXT_COLOR_RE.test(el.className),
      );
      expect(comCor.length).toBeGreaterThan(0);
      for (const el of comCor) {
        const fundo = corDoFundo(el.className, "escuro") ?? fundoDoDialogEscuro;
        expect(
          contrastRatio(corDoTexto(el.className, "escuro"), fundo),
          `"${el.textContent?.slice(0, 40)}" sobre ${fundo}`,
        ).toBeGreaterThanOrEqual(AA_TEXTO_NORMAL);
      }
    }


    it("a barra de progresso da VARREDURA passa em AA no escuro", () => {
      renderScanning({
        done: 25,
        total: 95,
        atual: "barco - Marinheiro só.mp3",
        etapa: "procurando no LRCLIB",
      });
      conferirContrasteEscuro(screen.getByRole("dialog", { name: "Completar dados" }));
    });

    it("a barra de progresso da TRANSCRIÇÃO passa em AA no escuro", () => {
      useEnrichStore.setState({
        status: "transcribing",
        overlayOpen: true,
        proposals: [],
        progress: null,
        scanId: "t1",
        semLetraNoFim: [1, 2],
        segundosDeTranscricao: 600,
        transcricao: { disponivel: true, download: null },
        transcricaoProgress: {
          done: 3,
          total: 47,
          atual: "barco - Marinheiro só.mp3",
          porcento_da_musica: 40,
          segundos_restantes: 120,
          scan_id: "t1",
        },
        applyErrors: {},
      });
      render(<EnrichReview />);
      conferirContrasteEscuro(screen.getByRole("dialog", { name: "Completar dados" }));
    });
  });

  describe("modal: Esc e foco (QA achado 3)", () => {

    it("Esc DURANTE a varredura manda para segundo plano (não cancela)", () => {
      renderScanning({
        done: 1,
        total: 5,
        atual: "a.mp3",
        etapa: "procurando no LRCLIB",
      });
      fireEvent.keyDown(window, { key: "Escape" });
      expect(useEnrichStore.getState().overlayOpen).toBe(false);
      expect(useEnrichStore.getState().status).toBe("scanning");
    });


    // M7: sem isso o Esc largava o foco no <body> e o teclado voltava do zero

    it("mandar para segundo plano também devolve o foco", () => {
      const abridor = document.createElement("button");
      document.body.appendChild(abridor);
      abridor.focus();

      const { rerender } = renderScanning({
   done: 1,
   total: 5,
   atual: "a.mp3",
   etapa: "procurando no LRCLIB",
 });
      fireEvent.click(
        screen.getByRole("button", { name: "Deixar rodando em segundo plano" }),
      );
      rerender(<EnrichReview />);
      expect(document.activeElement).toBe(abridor);
      abridor.remove();
    });

    it("quem abriu saiu do DOM: fechar não quebra", () => {
      const abridor = document.createElement("button");
      document.body.appendChild(abridor);
      abridor.focus();

      const { rerender } = renderReview([ALTA]);
      abridor.remove();
      fireEvent.keyDown(window, { key: "Escape" });
      expect(() => rerender(<EnrichReview />)).not.toThrow();
    });

    // M6: role="status" em volta do contador + barra + nome do arquivo fazia
    // uma varredura de 94 músicas ser anunciada ~94 vezes, com nome de arquivo.
    it("o nome do arquivo em processamento NÃO fica dentro de região viva", () => {
      renderScanning({
        done: 12,
        total: 94,
        atual: "Fulano - Canção.mp3",
        etapa: "procurando no LRCLIB",
      });
      const arquivo = screen.getByText("Fulano - Canção.mp3");
      expect(arquivo.closest("[role='status']")).toBeNull();
      expect(arquivo.closest("[aria-live]")).toBeNull();
      expect(
        screen.getByText("Buscando dados… 12 de 94").closest("[role='status']"),
      ).toBeNull();
      // a barra continua contando a história para a tecnologia assistiva
      expect(screen.getByRole("progressbar")).toHaveAttribute(
        "aria-valuenow",
        "12",
      );
    });


    it("varredura sem resultado: a região viva conta o desfecho honesto", () => {
      renderReview([], 81);
      expect(screen.getByRole("status")).toHaveTextContent(
        "Busca concluída. Conferimos as 81 músicas desta pasta",
      );
    });

  });
  // ---------------------------------------------------------------------------
  // V10 — a revisão ordenada por RISCO
  // ---------------------------------------------------------------------------
  //
  // "Eu nem li as sugestões em baixa — não deu vontade de ler mesmo", numa
  // revisão de 53 músicas. Não é preferência: é o que 40 pessoas vão fazer.

  describe("os três campos novos da proposta (V10)", () => {
    const TRANSCRITA = proposal({
      song_id: 40,
      current_title: "sem_tags",
      proposed_title: "sem_tags",
      proposed_artist: null,
      lyrics: "na beira do mar sagrado",
      confidence: "media",
      fonte: FONTE_TRANSCRICAO,
      refrao: "na beira do mar sagrado",
    });
    const SEM_VOZ = proposal({
      song_id: 41,
      current_title: "Chorinho",
      proposed_title: "Chorinho",
      lyrics: null,
      confidence: "media",
      fonte: FONTE_TRANSCRICAO,
      marcar_instrumental: true,
      aviso: "20 caracteres em 5m00s de áudio dão 0,07, abaixo do mínimo de 0,30",
    });


    it("letra de máquina avisa que precisa de conferência antes de aplicar", () => {
      renderReview([TRANSCRITA]);
      expect(screen.getByText(AVISO_LETRA_DE_MAQUINA)).toBeVisible();
    });

    it("letra do LRCLIB não puxa o aviso de máquina", () => {
      renderReview([ALTA]);
      expect(screen.queryByText(AVISO_LETRA_DE_MAQUINA)).not.toBeInTheDocument();
    });

    it("a linha de instrumental diz o que a marca faz, e mostra o motivo medido", () => {
      renderReview([SEM_VOZ]);
      expect(screen.getByText(AVISO_MARCAR_INSTRUMENTAL)).toBeVisible();
      expect(screen.getByText(SEM_VOZ.aviso!)).toBeVisible();
    });

    // `aviso` é diferente de `error`: a linha CONTINUA aplicável.

    // QA A2 — a linha que grava DUAS coisas anuncia as duas. A etapa 5 do
    // Rust deixou de propor nome (o palpite da etapa 1 já foi entregue na
    // mesma revisão), mas o rótulo é DERIVADO da proposta e não de uma frase
    // fixa: qualquer linha que marque instrumental E mude nome — hoje, o
    // conflito resolvido à mão do editor — continua dizendo as duas.

  });

  // ---------------------------------------------------------------------------
  // V10 — duas linhas da MESMA música, uma gravação só
  // ---------------------------------------------------------------------------
  //
  // A etapa 5 acrescenta propostas à revisão que já está aberta, e a música que
  // sobrou sem letra é justamente a que costuma ter uma proposta de NOME
  // pendente (foi por não ter etiqueta que ela não achou letra em base
  // nenhuma). Então a mesma música aparece em dois grupos: o nome no dobrado, a
  // letra em "letras encontradas".
  //
  // Cada linha continua sendo uma decisão — é o modelo da tela inteira. O que
  // não pode é virarem DUAS gravações: o `apply` confere o eco
  // `current_title`/`current_artist` contra o disco (QA A5), então a segunda
  // seria recusada com "a música mudou depois da busca" — uma falha inventada
  // por nós, num lote que a pessoa marcou inteiro.


  // ---------------------------------------------------------------------------
  // V10 — a ressalva do lyrics.ovh (DECISIONS #110)
  // ---------------------------------------------------------------------------
  //
  // Esta fonte NÃO devolve o nome da música: é a única etapa do funil cujo
  // casamento o programa não tem como conferir. Ela pode entregar a letra de
  // "Ponto de Ogum" para um pedido de "Ponto de Oxum" e ninguém percebe.
  //
  // O teto MÉDIA tira a pré-marcação, mas só protege quem saiba POR QUÊ — e a
  // medição de campo foi "eu nem li as sugestões em baixa, não deu vontade de
  // ler mesmo". A ressalva tem de estar VISÍVEL na linha.

  describe("a ressalva da fonte que não dá para conferir", () => {
    const RESSALVA =
      "este site não diz a que música a letra pertence, então não deu para" +
      " conferir se ela é desta — vale ler antes de aplicar";
    const DO_OVH = proposal({
      song_id: 50,
      current_title: "Ponto de Oxum",
      current_artist: "Grupo Fixture",
      proposed_title: "Ponto de Oxum",
      proposed_artist: "Grupo Fixture",
      lyrics: "uma letra qualquer",
      confidence: "media",
      fonte: "lyrics.ovh",
      aviso: RESSALVA,
    });

    it("aparece na linha, com as palavras do backend", () => {
      renderReview([DO_OVH]);
      expect(screen.getByText(RESSALVA)).toBeVisible();
    });

    // Nem `title=`, nem atrás de expandir: a linha dela mora no grupo das
    // letras encontradas, que é aberto por padrão.

    // É AVISO, não `error`: a linha continua aplicável — quem revisou e leu a
    // letra pode aplicá-la.

    // Ela é RESSALVA, e tem o peso das outras ressalvas da linha (a de trocar
    // nome escrito, a de substituir letra): quem varre a lista rápido precisa
    // ver que esta linha pede leitura, não só um clique.

    // ...e o `aviso` da etapa 5 é outra coisa: "20 caracteres em 5m00s dão
    // 0,07, abaixo do mínimo de 0,30" é a MEDIÇÃO que sustenta a conclusão,
    // logo abaixo da ressalva que já está em âmbar. Duas linhas âmbar seguidas
    // na mesma proposta é o ruído que ensina a ignorar as duas.

    // Aviso em toda linha ensina a ignorar todos: a linha do LRCLIB (que
    // confere pela duração) não recebe ressalva nenhuma.
    it("linha de outra fonte não ganha ressalva", () => {
      renderReview([ALTA]);
      expect(screen.queryByText(RESSALVA)).not.toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // V10 — a pergunta do fim, e as horas de trabalho
  // ---------------------------------------------------------------------------

  describe("a pergunta do fim", () => {

    /*
      QA M3 — o número da pergunta é o que o BACKEND mandou, e nada mais.

      O backend vai parar de incluir em `sem_letra_no_fim` as músicas que
      voltaram com erro (elas não ficaram sem letra: elas não foram
      perguntadas). A tela não pode ter uma conta própria por cima disso — a
      DECISIONS #80 é exatamente esse defeito, e o preço dele foi o botão do
      produto ficando cinza porque duas cópias da mesma regra divergiram.

      Aqui a lista do backend tem UMA música e a revisão mostra três linhas de
      erro. Se a tela contasse alguma coisa, o número mudaria.
    */
    it("a conta é a do backend, mesmo com linhas de erro na tela", () => {
      const comErro = (id: number) =>
        proposal({
          song_id: id,
          current_title: `faixa ${id}`,
          lyrics: null,
          error: "sem conexão",
        });
      renderReview([comErro(81), comErro(82), comErro(83)], 50, 0, {
        semLetraNoFim: [81],
        segundosDeTranscricao: 600,
        disponivel: true,
      });
      expect(
        screen.getByText(textoDaOfertaDeTranscricao(1, 600)),
      ).toBeVisible();
      expect(screen.getByText(/Sobrou 1 música sem letra/)).toBeVisible();
    });

    // E a lista viaja inteira para a etapa 5: nem filtrada nem recontada.
    it("os ids mandados são os do backend, sem filtro da tela", async () => {
      const transcreverMusicas = vi.fn(async () => ({
        propostas: [],
        razao_medida: null,
      }));
      setBackendForTests({
        transcreverMusicas,
        onTranscricaoProgresso: vi.fn(async () => () => {}),
      } as unknown as Backend);
      renderReview(
        [proposal({ song_id: 81, lyrics: null, error: "sem conexão" })],
        50,
        0,
        { semLetraNoFim: [81, 82], segundosDeTranscricao: 600, disponivel: true },
      );
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: ROTULO_COMECAR_TRANSCRICAO }),
        );
      });
      expect(transcreverMusicas).toHaveBeenCalledWith([81, 82], expect.any(String));
    });

    /*
      QA A1 — a mesma pergunta, com e sem medição.

      A frase do PRD ("cerca de 3 horas neste computador") só pode ser dita
      quando o número é desta máquina. Enquanto ele é de fábrica — e ele nasce
      de fábrica em toda instalação — a tela mantém a ressalva, porque o erro
      tem sinal conhecido: o transcritor do macOS sai sem Metal e sem
      Accelerate, então o palpite é otimista (DECISIONS #85).
    */


    it("sem ninguém sobrando, não pergunta nada", () => {
      renderReview([ALTA], 50);
      expect(
        screen.queryByRole("button", { name: ROTULO_COMECAR_TRANSCRICAO }),
      ).not.toBeInTheDocument();
    });

    // Para 180 MB a dispensa do tempo acabou: quem não tem os acessórios vê o
    // caminho do download, com tamanho E tempo.


  });

  // ---------------------------------------------------------------------------
  // QA M2 — a etapa 5 chega HORAS depois, numa revisão que já foi conferida
  // ---------------------------------------------------------------------------
  //
  // Ela ACRESCENTA propostas à lista aberta. A seleção era recalculada do zero
  // a cada mudança de identidade de `proposals`: o grupo dobrado que a pessoa
  // desmarcou de propósito voltava pré-marcado, e o que ela marcou à mão se
  // perdia — sem aviso, e depois de horas de espera em que ela pode nem estar
  // olhando.

  describe("acompanhar horas de trabalho", () => {
    function renderTranscrevendo(
      p: Partial<TranscricaoProgresso> | null = null,
    ) {
      useEnrichStore.setState({
        status: "transcribing",
        overlayOpen: true,
        proposals: [],
        progress: null,
        scanId: "t1",
        semLetraNoFim: [1, 2],
        segundosDeTranscricao: 600,
        transcricao: { disponivel: true, download: null },
        transcricaoProgress:
          p === null
            ? null
            : {
                done: 0,
                total: 47,
                atual: "",
                porcento_da_musica: 0,
                segundos_restantes: null,
                scan_id: "t1",
                ...p,
              },
        applyErrors: {},
      });
      return render(<EnrichReview />);
    }

    it("antes do primeiro evento, não inventa número nenhum", () => {
      renderTranscrevendo(null);
      expect(screen.getByText(/Escrevendo as letras/)).toBeVisible();
      expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    });

    it("mostra a fila, o arquivo e o quanto da música já foi", () => {
      renderTranscrevendo({
        done: 3,
        total: 47,
        atual: "Oh! Chuva.mp3",
        porcento_da_musica: 45,
        segundos_restantes: 9800,
      });
      expect(screen.getByText("Escrevendo as letras… 3 de 47")).toBeVisible();
      expect(screen.getByText("Oh! Chuva.mp3")).toBeVisible();
      expect(screen.getByText(textoDoTempoDaTranscricao(9800))).toBeVisible();
    });

    // Uma música leva MINUTOS: a barra tem de andar DENTRO dela, ou parece
    // travada por quatro minutos (a lição da v0.8.1).
    it("a barra anda dentro da música, e não só entre músicas", () => {
      const { rerender } = renderTranscrevendo({
        done: 3,
        total: 47,
        atual: "a.mp3",
        porcento_da_musica: 0,
      });
      const antes = Number(
        screen.getByRole("progressbar").getAttribute("aria-valuenow"),
      );
      act(() => {
        useEnrichStore.setState({
          transcricaoProgress: {
            done: 3,
            total: 47,
            atual: "a.mp3",
            porcento_da_musica: 90,
            segundos_restantes: null,
            scan_id: "t1",
          },
        });
      });
      rerender(<EnrichReview />);
      const depois = Number(
        screen.getByRole("progressbar").getAttribute("aria-valuenow"),
      );
      expect(depois).toBeGreaterThan(antes);
    });

    // `segundos_restantes` é null até a primeira música terminar: inventar um
    // número antes disso é a DECISIONS #85.
    it("sem medição, diz QUANDO o número vai aparecer", () => {
      renderTranscrevendo({ done: 0, total: 47, atual: "a.mp3" });
      expect(screen.getByText(textoDoTempoDaTranscricao(null))).toBeVisible();
    });

    it("dá para deixar rodando em segundo plano, e para cancelar", () => {
      renderTranscrevendo({ done: 1, total: 47, atual: "a.mp3" });
      fireEvent.click(
        screen.getByRole("button", { name: "Deixar rodando em segundo plano" }),
      );
      expect(useEnrichStore.getState().overlayOpen).toBe(false);
      expect(useEnrichStore.getState().status).toBe("transcribing");
    });

    it("cancelar para a fila e volta a idle", () => {
      setBackendForTests({
        enrichCancelScan: vi.fn(async () => {}),
      } as unknown as Backend);
      renderTranscrevendo({ done: 1, total: 47, atual: "a.mp3" });
      fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
      expect(useEnrichStore.getState().status).toBe("idle");
    });
  });
  // =========================================================================
  // V10.6 — aplicar não fecha a caixa, e a oferta de transcrição sobrevive
  // =========================================================================
  //
  // Relato de campo, verbatim: *"Achei que eu poderia clicar em aplicar e depois
  // trabalhar nas transcrições, mas não aconteceu… Simplesmente fechou a caixa e
  // aplicou essas 28… Mas agora tenho que começar de novo pra chegar na parte de
  // transcrição de novo."*
  //
  // O que se perdia não era um clique: era a varredura inteira — minutos, numa
  // biblioteca grande. As duas ações competiam, e a ordem importava de um jeito
  // que ninguém adivinha.
  describe("aplicar não fecha a caixa (V10.6)", () => {
    /*
      V10.8 — O DESFECHO DIZ O QUE FOI FEITO, NA LINHA.

      A gravação que só foi possível depois de normalizar a etiqueta do MP3 (a
      sobra entre a etiqueta declarada e o primeiro quadro, medida em sete
      arquivos de um acervo real) devolve uma frase no `aviso` do resultado. Ela
      tem de CHEGAR À TELA: sem isso o programa teria mexido num byte do arquivo
      de alguém sem pedir e sem contar — e sem pedir é a decisão do produto (a
      pessoa já mandou gravar), mas sem contar é segredo.
    */

    /*
      O caso que o relato de campo descreve inteiro: aplicar as 28 propostas de
      nome e DEPOIS mandar transcrever, na mesma caixa, sem varredura nova.
    */

    /*
      A segunda linha da MESMA música continua aplicável — e é o caso típico:
      a música que sobrou sem letra tem uma proposta de NOME pendente, e ganha a
      linha da letra quando a etapa 5 termina.

      Sem o eco fresco, esta segunda aplicação seria recusada com "a música mudou
      depois da busca" (QA A5) — e ela mudou, sim: mudamos nós, um clique antes.
    */

    // A5 — o que NÃO gravou fica na tela com o motivo, agora ao lado do que
    // gravou. Antes as gravadas saíam da lista, e quem visse só as recusadas não
    // tinha como saber que o resto foi.

    // Só o "Fechar" (e o Esc) fecham a caixa.


    /*
      V10.6, item 2 — fechar com a oferta na tela AVISA. Informativo, e não uma
      confirmação: com o bloco permanente de Configurações a lista já não se
      perde.
    */


    // "Agora não" é uma resposta: quem respondeu não é avisado de novo.

    /*
      Contraste AA no estado NOVO. A linha gravada NÃO recebe opacidade: ela é o
      registro do que a pessoa acabou de fazer, e é o que ela vai reler para
      conferir — opacidade em cima do cinza secundário derrubaria o contraste
      abaixo de AA (DECISIONS #69). O apagado fica para a linha com ERRO, cuja
      informação é a frase vermelha.
    */

    // Esc DURANTE a varredura continua sendo "segundo plano", não fechar — e
    // segundo plano não descarta nada, então não avisa nada.
    it("Esc durante a varredura continua mandando para segundo plano", () => {
      renderScanning({ done: 3, total: 10, atual: "a.mp3", etapa: "" });
      fireEvent.keyDown(window, { key: "Escape" });
      expect(useEnrichStore.getState().status).toBe("scanning");
      expect(useEnrichStore.getState().overlayOpen).toBe(false);
      expect(useToastStore.getState().toasts).toHaveLength(0);
    });
  });
});

// ===========================================================================
// V15 — Conferir: UMA sugestão por vez
// ===========================================================================
//
// A lista com caixas de marcar agrupadas por risco virou uma tela de três
// botões por sugestão. O que só preenchia já foi gravado sozinho antes desta
// tela abrir (ver enrichStore.test); aqui ficam as que TROCARIAM algo. Cada
// teste abaixo é uma proteção da lista antiga, dita do jeito novo.
describe("Conferir (V15) — uma sugestão por vez", () => {
  /** Backend que grava o que receber, ecoando a música gravada. */
  function gravador(falhaEm: number[] = []) {
    const enrichApply = vi.fn(async (aplicacoes: EnrichApply[]) =>
      aplicacoes.map((a) =>
        falhaEm.includes(a.song_id)
          ? { song_id: a.song_id, song: null, error: "arquivo em uso", aviso: null }
          : ok({
              ...song(a.song_id, a.title),
              artist: a.artist,
              has_lyrics: a.lyrics !== null,
            }),
      ),
    );
    const getLyrics = vi.fn(async () => "a letra que está lá hoje");
    setBackendForTests({ enrichApply, getLyrics } as unknown as Backend);
    return enrichApply;
  }

  /** Nome escrito por gente: nunca é gravado sozinho, sempre é decisão. */
  function nomeEscrito(id: number, titulo: string): EnrichProposal {
    return proposal({
      song_id: id,
      file_path: `/acervo/${id}.mp3`,
      current_title: titulo,
      current_artist: "Quem Escreveu",
      proposed_title: `${titulo} (oficial)`,
      proposed_artist: "Quem o Site Diz",
      lyrics: null,
      substitui_nome_escrito: true,
    });
  }

  async function clicar(nome: string | RegExp) {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: nome }));
    });
  }

  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
    useLibraryStore.setState({ allSongs: [], results: [] });
    usePlayerStore.setState({ current: null, queue: [], queueIndex: null, isPlaying: false });
  });

  it("mostra UMA sugestão, com quanto falta, e as duas versões lado a lado", () => {
    gravador();
    renderReview([nomeEscrito(1, "Asa Branca"), nomeEscrito(2, "Carinhoso")]);
    expect(screen.getByRole("heading", { name: "Asa Branca — Quem Escreveu" })).toBeInTheDocument();
    expect(screen.queryByText(/Carinhoso/)).toBeNull();
    expect(screen.getByText((_, el) => el?.tagName === "P" && el.textContent === "Faltam 2 para conferir")).toBeInTheDocument();
    const hoje = screen.getByRole("region", { name: "Como está hoje" });
    const novo = screen.getByRole("region", { name: "Como ficaria" });
    expect(hoje).toHaveTextContent("Asa Branca");
    expect(novo).toHaveTextContent("Asa Branca (oficial)");
    expect(novo).toHaveTextContent("muda");
  });

  it("'Usar o novo' grava SÓ esta sugestão, e a próxima aparece", async () => {
    const enrichApply = gravador();
    renderReview([nomeEscrito(1, "Asa Branca"), nomeEscrito(2, "Carinhoso")]);
    await clicar("Usar o novo");
    expect(enrichApply).toHaveBeenCalledTimes(1);
    expect(enrichApply.mock.calls[0][0].map((a) => a.song_id)).toEqual([1]);
    expect(screen.getByRole("heading", { name: "Carinhoso — Quem Escreveu" })).toBeInTheDocument();
  });

  it("conflito: as duas fontes lado a lado, e aceitar grava o que o SOM disse", async () => {
    const enrichApply = gravador();
    renderReview([
      proposal({
        current_title: "Trem das Onze",
        current_artist: "Demônios da Garoa",
        proposed_title: "Trem das Onze",
        proposed_artist: "Demônios da Garoa",
        lyrics: null,
        conflito: { titulo: "Trem das Onze", artista: "Adoniran Barbosa", confianca: "media" },
      }),
    ]);
    expect(screen.getByText(/reconheceu a gravação pelo som/)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Como ficaria" })).toHaveTextContent("Adoniran Barbosa");
    await clicar("Usar o novo");
    const [a] = enrichApply.mock.calls[0][0];
    expect(a.artist).toBe("Adoniran Barbosa");
    expect(a.lyrics).toBeNull();
  });

  it("trocar uma letra que existe: o botão DIZ isso, mostra a letra de hoje, e o clique é o consentimento", async () => {
    const enrichApply = gravador();
    renderReview([
      proposal({ has_lyrics: true, letra_origem: "manual", lyrics: "a letra nova", confidence: "alta" }),
    ]);
    expect(screen.queryByRole("button", { name: "Usar o novo" })).toBeNull();
    expect(screen.getByText(avisoLetraExistente("manual"))).toBeInTheDocument();
    expect(await screen.findByText("a letra que está lá hoje")).toBeInTheDocument();
    await clicar("Trocar a letra pela nova");
    const [a] = enrichApply.mock.calls[0][0];
    expect(a.lyrics).toBe("a letra nova");
    expect(a.substituir_letra).toBe(true);
  });

  it("instrumental: o botão diz o que faz, o aviso aparece, e a marca viaja como true", async () => {
    const enrichApply = gravador();
    renderReview([proposal({ lyrics: null, marcar_instrumental: true, aviso: "medido: 0,07" })]);
    expect(screen.getByText(AVISO_MARCAR_INSTRUMENTAL)).toBeInTheDocument();
    await clicar("Marcar como instrumental");
    expect(enrichApply.mock.calls[0][0][0].marcar_instrumental).toBe(true);
  });

  it("letra escrita pelo computador avisa ANTES do clique", () => {
    gravador();
    renderReview([proposal({ fonte: FONTE_TRANSCRICAO, confidence: "alta" })]);
    expect(screen.getByText(AVISO_LETRA_DE_MAQUINA)).toBeInTheDocument();
  });

  it("'Manter como está' não grava nada e passa para a próxima", async () => {
    const enrichApply = gravador();
    renderReview([nomeEscrito(1, "Asa Branca"), nomeEscrito(2, "Carinhoso")]);
    await clicar("Manter como está");
    expect(enrichApply).not.toHaveBeenCalled();
    expect(useEnrichStore.getState().mantidas).toEqual([0]);
    expect(screen.getByRole("heading", { name: "Carinhoso — Quem Escreveu" })).toBeInTheDocument();
  });

  it("'Decidir depois' não decide: a sugestão continua esperando em Organizar", async () => {
    gravador();
    renderReview([nomeEscrito(1, "Asa Branca")]);
    await clicar("Decidir depois");
    expect(screen.getByText(/ficou para depois/)).toBeInTheDocument();
    await clicar("Voltar para Organizar");
    const s = useEnrichStore.getState();
    // mandada para segundo plano, e não jogada fora
    expect(s.overlayOpen).toBe(false);
    expect(s.status).toBe("review");
    expect(decisoesPendentes(s)).toEqual([0]);
  });

  it("'Usar o novo em todas' pergunta antes, e nunca alcança troca de letra nem instrumental", async () => {
    const enrichApply = gravador();
    renderReview([
      nomeEscrito(1, "Asa Branca"),
      nomeEscrito(2, "Carinhoso"),
      proposal({ song_id: 3, has_lyrics: true, lyrics: "nova", confidence: "alta" }),
      proposal({ song_id: 4, lyrics: null, marcar_instrumental: true }),
    ]);
    await clicar("Usar o novo em todas as 2");
    // ainda nada gravado: é uma pergunta
    expect(enrichApply).not.toHaveBeenCalled();
    expect(screen.getByText(/2 sugestões que trocariam uma letra ou marcariam como instrumental continuam esperando/)).toBeInTheDocument();
    await clicar("Sim, usar em todas");
    const enviadas = enrichApply.mock.calls[0][0];
    expect(enviadas.map((a) => a.song_id)).toEqual([1, 2]);
    expect(enviadas.some((a) => a.substituir_letra || a.marcar_instrumental)).toBe(false);
    // as duas que ficaram de fora continuam na fila
    expect(decisoesPendentes(useEnrichStore.getState())).toEqual([2, 3]);
  });

  it("'Não, quero ver uma por uma' volta sem gravar nada", async () => {
    const enrichApply = gravador();
    renderReview([nomeEscrito(1, "Asa Branca"), nomeEscrito(2, "Carinhoso")]);
    await clicar("Usar o novo em todas as 2");
    await clicar("Não, quero ver uma por uma");
    expect(enrichApply).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Asa Branca — Quem Escreveu" })).toBeInTheDocument();
  });

  it("gravação que falha fica na tela com o motivo, e a sugestão continua na fila (A5)", async () => {
    gravador([1]);
    renderReview([nomeEscrito(1, "Asa Branca")]);
    await clicar("Usar o novo");
    expect(screen.getByRole("alert")).toHaveTextContent("Não deu para gravar: arquivo em uso");
    expect(screen.getByRole("heading", { name: "Asa Branca — Quem Escreveu" })).toBeInTheDocument();
  });

  it("no fim: conta o que aconteceu, e faz a pergunta do fim (V10)", async () => {
    gravador();
    renderReview([nomeEscrito(1, "Asa Branca")], 10, 0, {
      semLetraNoFim: [5, 6],
      segundosDeTranscricao: 360,
      disponivel: true,
    });
    await clicar("Usar o novo");
    expect(screen.getByRole("heading", { name: "Pronto! Você conferiu todas." })).toBeInTheDocument();
    expect(screen.getByText(textoDaOfertaDeTranscricao(2, 360, false))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: ROTULO_COMECAR_TRANSCRICAO })).toBeInTheDocument();
  });

  it("a música que nem pôde ser procurada não é decisão: aparece no fim, com o motivo", () => {
    gravador();
    renderReview([proposal({ error: "o site de letras está fora do ar agora" })], 1);
    expect(screen.queryByRole("button", { name: "Usar o novo" })).toBeNull();
    expect(screen.getByText("1 música não pôde ser procurada")).toBeInTheDocument();
  });

  it("Esc com decisões pendentes manda para segundo plano — não joga nada fora", () => {
    gravador();
    renderReview([nomeEscrito(1, "Asa Branca")]);
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    const s = useEnrichStore.getState();
    expect(s.overlayOpen).toBe(false);
    expect(s.status).toBe("review");
    expect(s.proposals).toHaveLength(1);
  });

  it("'Ouvir esta música' toca a própria música, e o botão vira 'Parar de ouvir'", async () => {
    gravador();
    useLibraryStore.setState({ allSongs: [song(1, "Asa Branca")] });
    renderReview([nomeEscrito(1, "Asa Branca")]);
    await clicar("Ouvir esta música");
    expect(usePlayerStore.getState().current?.id).toBe(1);
    expect(screen.getByRole("button", { name: "Parar de ouvir" })).toBeInTheDocument();
  });
});
