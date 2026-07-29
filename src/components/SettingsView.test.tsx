import { fireEvent, render, screen, within } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setBackendForTests, type Backend } from "../lib/api";
import {
  AA_TEXTO_NORMAL,
  contrastRatio,
  corDoTexto,
} from "../test/contrast";
import {
  ACESSORIO_CANCELADO,
  ACESSORIO_CORROMPIDO,
  ACESSORIO_INDETERMINADO,
  ACESSORIO_INDISPONIVEL,
  ACESSORIO_PRONTO,
  ACESSORIO_SEM_BINARIO,
  ROTULO_DO_DISPARO,
  TRANSCRICAO_NO_FIM,
  estimativaTexto,
  rotuloBaixarAcessorio,
  textoDoAcessorioAusente,
  textoDoDownload,
  tituloDoAcessorio,
} from "../lib/curadoria";
import type { EstadoDaContagem } from "../lib/curadoria";
import type { AcessorioInfo, AcessorioProgresso, Contagem } from "../lib/api";
import type { Song } from "../lib/types";
import { useEnrichStore } from "../stores/enrichStore";
import { useLibraryStore } from "../stores/libraryStore";
import { useUiStore } from "../stores/uiStore";
import { ERROS_DE_GRAVACAO } from "../lib/mockBackend";
import { SettingsView } from "./SettingsView";

/** Fundo da tela de Configurações — todo texto novo é lido em cima dele. */
const FUNDO_CONFIGURACOES = "#F9FAFB";

/**
 * A CONTAGEM que o backend devolve (V10): total, quantas sem letra, a
 * estimativa PRONTA e as etapas que vão rodar. O frontend não recalcula nada
 * disso — a cópia em TypeScript já divergiu duas vezes (DECISIONS #80/#102).
 *
 * Instalação nova: sem o acessório do som e sem chave do Vagalume, só as
 * etapas 1 e 3 rodam.
 */
function contagem(over: Partial<Contagem> = {}): Contagem {
  return {
    total: 2,
    sem_letra: 2,
    segundos_estimados: 14,
    etapas: ["lendo etiquetas e nome do arquivo", "procurando no LRCLIB"],
    transcricao_disponivel: false,
    ...over,
  };
}

const pronta = (over: Partial<Contagem> = {}): EstadoDaContagem => ({
  estado: "pronta",
  contagem: contagem(over),
});

/** O texto que a tela deve mostrar, montado com os mesmos parâmetros dela. */
function estimativa(
  contagemAtual: EstadoDaContagem,
  musicasNaPasta: number,
): string {
  return estimativaTexto({ contagem: contagemAtual, musicasNaPasta });
}

/** O acessório do SOM desta máquina, no estado pedido. */
function acessorio(estado: AcessorioInfo["estado"]): AcessorioInfo {
  return {
    nome: "fpcalc",
    para_que_serve: "reconhecer a música pelo som",
    arquivo: "fpcalc-linux-x86_64",
    tamanho_bytes: 5_538_312,
    segundos_estimados: 6,
    executavel: true,
    estado,
    origem:
      "https://github.com/gabrielnader/cancioneiro/releases/download/acessorios-v1/fpcalc-linux-x86_64",
  };
}

/** O PROGRAMA da etapa 5 (V10) — 2 MB. */
function whisper(estado: AcessorioInfo["estado"]): AcessorioInfo {
  return {
    nome: "whisper-cli",
    para_que_serve: "escrever a letra ouvindo o áudio",
    arquivo: "whisper-cli-linux-x86_64",
    tamanho_bytes: 2_000_000,
    segundos_estimados: 2,
    executavel: true,
    estado,
    origem:
      "https://github.com/gabrielnader/cancioneiro/releases/download/acessorios-v1/whisper-cli-linux-x86_64",
  };
}

/** O MODELO da etapa 5 (V10) — 181 MB de DADO, que ninguém executa. */
function modelo(estado: AcessorioInfo["estado"]): AcessorioInfo {
  return {
    nome: "modelo-de-transcricao",
    para_que_serve: "entender o que é cantado — é o que o transcritor consulta",
    arquivo: "ggml-small-q5_1.bin",
    tamanho_bytes: 181_000_000,
    segundos_estimados: 181,
    executavel: false,
    estado,
    origem:
      "https://github.com/gabrielnader/cancioneiro/releases/download/acessorios-v1/ggml-small-q5_1.bin",
  };
}

function song(id: number, filePath: string, over: Partial<Song> = {}): Song {
  return {
    id,
    file_path: filePath,
    folder_id: 1,
    // título REAL: "Faixa 3" é placeholder de ripador para o funil, e uma
    // música de título placeholder está incompleta mesmo com letra (ALTO-2)
    title: `Canção ${id}`,
    artist: "Artista",
    album: null,
    duration_seconds: 100,
    has_lyrics: true,
    available: true,
    ...over,
  };
}

/** enrichCount da vez — cada teste pode trocá-lo antes de renderizar. */
let enrichCount: ReturnType<typeof vi.fn>;
let acessoriosEstado: ReturnType<typeof vi.fn>;
let acessorioBaixar: ReturnType<typeof vi.fn>;
let acessorioCancelar: ReturnType<typeof vi.fn>;
/** O ouvinte de `acessorio:progresso` que a tela registrou. */
let emitirProgressoDoAcessorio: ((p: AcessorioProgresso) => void) | null;

function estadoBase() {
  // a contagem de candidatas vem do BACKEND (mesma função da varredura):
  // por padrão, as duas incompletas do acervo de teste
  enrichCount = vi.fn(async (prefix: string) =>
    contagem(
      prefix === "/acervo/1"
        ? { total: 1, sem_letra: 1, segundos_estimados: 7 }
        : {},
    ),
  );
  acessoriosEstado = vi.fn(async () => [acessorio("ausente")]);
  acessorioBaixar = vi.fn(async () => ({
    cancelado: false,
    acessorio: acessorio("pronto"),
  }));
  acessorioCancelar = vi.fn(async () => {});
  emitirProgressoDoAcessorio = null;
  setBackendForTests({
    onScanProgress: vi.fn(async () => () => {}),
    enrichCount,
    acessoriosEstado,
    acessorioBaixar,
    acessorioCancelar,
    onAcessorioProgresso: vi.fn(async (cb: (p: AcessorioProgresso) => void) => {
      emitirProgressoDoAcessorio = cb;
      return () => {};
    }),
  } as unknown as Backend);
  useUiStore.setState({ view: "settings" });
  useLibraryStore.setState({
    folders: [{ id: 1, path: "/acervo", last_scanned_at: null }],
    allSongs: [
      song(1, "/acervo/1/completa.mp3"),
      song(2, "/acervo/1/sem_letra.mp3", { has_lyrics: false }),
      song(3, "/acervo/2/sem_artista.mp3", { artist: null }),
    ],
    folderFilter: null,
    scanning: null,
  });
  useEnrichStore.setState({
    status: "idle",
    overlayOpen: false,
    folderPrefix: "",
    proposals: [],
    progress: null,
    scanId: "",
    scannedTotal: 0,
    semLetraNoFim: [],
    segundosDeTranscricao: 0,
    transcricao: { disponivel: false, download: null },
    transcricaoProgress: null,
    transcricaoDispensada: false,
    applyErrors: {},
    scanInFlight: false,
    startScan: vi.fn(async () => {}),
  });
}

function secaoCuradoria(): HTMLElement {
  return screen.getByRole("region", { name: "Curadoria do acervo" });
}

describe("SettingsView — seção de curadoria (V8 F18)", () => {
  beforeEach(estadoBase);

  it("explica o funil ANTES de qualquer clique, etapa por etapa e na ordem", async () => {
    render(<SettingsView />);
    await screen.findByText(estimativa(pronta(), 3));
    const secao = secaoCuradoria();
    const texto = secao.textContent ?? "";
    // os nomes das etapas vêm do backend (`Contagem.etapas`), com maiúscula
    expect(texto.indexOf("Lendo etiquetas e nome do arquivo")).toBeGreaterThan(-1);
    expect(texto.indexOf("Lendo etiquetas e nome do arquivo")).toBeLessThan(
      texto.indexOf("Procurando no LRCLIB"),
    );
    // nada é gravado sem revisão (DECISIONS #49/#58)
    expect(texto).toContain("Nada é gravado sem você conferir");
    // roda em segundo plano, e isso é dito antes de começar
    expect(texto).toContain("segundo plano");
  });

  // V10 — o texto que dizia "escrever a letra ouvindo o áudio ainda não é
  // feito aqui dentro" deixou de ser verdade nesta versão. Ele foi CONFERIDO
  // antes de ser reusado (DECISIONS #100): virou o anúncio da pergunta do fim.
  it("anuncia a etapa 5 como pergunta do FIM, sem prometê-la como etapa", () => {
    render(<SettingsView />);
    const texto = secaoCuradoria().textContent ?? "";
    expect(texto).toContain(TRANSCRICAO_NO_FIM);
    expect(texto).not.toContain("ainda não é feito");
    // e não manda ninguém para uma ferramenta de terminal que ela não tem
    expect(texto).not.toContain("ferramentas de curadoria");
  });

  // Sem o acessório baixado a etapa 2 não roda: listá-la seria prometer
  // trabalho que não vai acontecer (DECISIONS #101). Quem decide é o backend.
  it("a etapa do som só é listada quando o backend a manda", async () => {
    const primeira = render(<SettingsView />);
    await screen.findByText(estimativa(pronta(), 3));
    expect(secaoCuradoria().textContent).not.toContain("Reconhecendo pelo som");
    primeira.unmount();

    enrichCount.mockResolvedValue(
      contagem({
        etapas: [
          "lendo etiquetas e nome do arquivo",
          "reconhecendo pelo som",
          "procurando no LRCLIB",
        ],
        // um número que muda a FRASE, e não só o número: senão o texto da
        // estimativa antiga e o da nova seriam idênticos e o `findByText`
        // resolveria antes de a contagem nova chegar
        segundos_estimados: 1020,
      }),
    );
    render(<SettingsView />);
    await screen.findByText(estimativa(pronta({ segundos_estimados: 1020 }), 3));
    expect(secaoCuradoria().textContent).toContain("Reconhecendo pelo som");
  });

  it("começa na pasta selecionada na lateral — o contexto que o ✎ dava de graça", () => {
    useLibraryStore.setState({ folderFilter: "/acervo/1" });
    render(<SettingsView />);
    expect(screen.getByLabelText("Pasta a curar")).toHaveValue("/acervo/1");
  });

  it("sem filtro na lateral, começa em 'Toda a biblioteca' (prefixo vazio)", () => {
    render(<SettingsView />);
    expect(screen.getByLabelText("Pasta a curar")).toHaveValue("");
  });

  it("o seletor traz a mesma árvore da lateral, começando pela biblioteca inteira", () => {
    render(<SettingsView />);
    const opcoes = within(screen.getByLabelText("Pasta a curar")).getAllByRole(
      "option",
    );
    expect(opcoes.map((o) => o.textContent?.trim())).toEqual([
      "Toda a biblioteca",
      "acervo",
      "1",
      "2",
    ]);
  });

  // ALTO-2 — a contagem NÃO é recalculada em TypeScript: ela vem do backend,
  // pela mesma função que a varredura usa. A cópia local divergia em três
  // casos (instrumental sem artista, "Faixa 03", "Artista Desconhecido"),
  // subcontava até zero e desabilitava o único ponto de entrada do produto.
  it("a estimativa vem do backend e acompanha a pasta escolhida", async () => {
    render(<SettingsView />);
    expect(await screen.findByText(estimativa(pronta(), 3))).toBeInTheDocument();
    // a contagem leva a PASTA e nada mais (V10: não há modo nem credencial)
    expect(enrichCount).toHaveBeenCalledWith("");

    fireEvent.change(screen.getByLabelText("Pasta a curar"), {
      target: { value: "/acervo/1" },
    });
    expect(
      await screen.findByText(
        estimativa(pronta({ total: 1, sem_letra: 1, segundos_estimados: 7 }), 2),
      ),
    ).toBeInTheDocument();
    expect(enrichCount).toHaveBeenCalledWith("/acervo/1");
  });

  // A contagem virou uma chamada: enquanto ela não volta, a tela diz o que
  // está fazendo — e NUNCA desabilita o disparo por isso.
  it("contagem ainda em curso: texto honesto e botão liberado", () => {
    enrichCount.mockImplementation(() => new Promise(() => {}));
    render(<SettingsView />);
    expect(
      screen.getByText(estimativa({ estado: "contando" }, 3)),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Buscar dados desta pasta" }),
    ).toBeEnabled();
  });

  it("contagem que falhou não vira impedimento: admite e deixa buscar", async () => {
    enrichCount.mockRejectedValue(new Error("sem banco"));
    render(<SettingsView />);
    expect(
      await screen.findByText(estimativa({ estado: "indisponivel" }, 3)),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Buscar dados desta pasta" }),
    ).toBeEnabled();
  });

  it("dispara a varredura com o prefixo escolhido", () => {
    const startScan = vi.fn(async () => {});
    useEnrichStore.setState({ startScan });
    render(<SettingsView />);
    fireEvent.change(screen.getByLabelText("Pasta a curar"), {
      target: { value: "/acervo/2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Buscar dados desta pasta" }));
    expect(startScan).toHaveBeenCalledWith("/acervo/2", {
      disponivel: false,
      download: null,
    });
  });

  it("pasta sem nenhuma música disponível: não deixa disparar e diz por quê", async () => {
    enrichCount.mockResolvedValue(contagem({ total: 0, sem_letra: 0 }));
    useLibraryStore.setState({ allSongs: [song(1, "/acervo/1/completa.mp3")] });
    render(<SettingsView />);
    expect(
      await screen.findByText(
        estimativa(pronta({ total: 0, sem_letra: 0, segundos_estimados: 14 }), 1),
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Buscar dados desta pasta" }),
    ).toBeDisabled();
  });

  // MÉDIO-11 — sem pasta nenhuma a tela dizia "nenhuma música desta pasta
  // está sem título, artista ou letra": descrevia ZERO músicas como completas.
  it("biblioteca sem música: não afirma completude, diz o que fazer", async () => {
    enrichCount.mockResolvedValue(contagem({ total: 0, sem_letra: 0 }));
    useLibraryStore.setState({ allSongs: [], folders: [] });
    render(<SettingsView />);
    const secao = secaoCuradoria();
    expect(secao).toHaveTextContent("Não há nenhuma música nesta pasta");
    // o "aqui em Configurações" saiu no passe de redução: quem lê isto JÁ
    // está em Configurações, com o botão "Adicionar pasta" logo acima
    expect(secao).toHaveTextContent("Adicione uma pasta");
    await screen.findByText(/Não há nenhuma música nesta pasta/);
  });

  // MÉDIO-14 — <button> desabilitado não recebe foco e `title` não é anunciado
  // de forma confiável: quem usa teclado ou leitor de tela via um botão cinza
  // e nenhuma explicação. O motivo é TEXTO na tela, ligado ao botão.
  it("uma varredura já rodando bloqueia o disparo, com o motivo VISÍVEL", () => {
    useEnrichStore.setState({ status: "scanning" });
    render(<SettingsView />);
    const botao = screen.getByRole("button", { name: "Buscar dados desta pasta" });
    expect(botao).toBeDisabled();
    const motivo = screen.getByText(
      "Uma busca de dados já está em andamento — espere ela terminar.",
    );
    expect(motivo).toBeVisible();
    expect(botao).toHaveAttribute("aria-describedby", motivo.id);
  });

  // M4: depois do "Cancelar" o invoke ainda responde por alguns segundos —
  // e neste estado a tela não renderizava NADA (nem scanning, nem review).
  it("varredura cancelada e ainda respondendo: segue bloqueado, com o porquê na tela", () => {
    useEnrichStore.setState({ status: "idle", scanInFlight: true });
    render(<SettingsView />);
    expect(
      screen.getByRole("button", { name: "Buscar dados desta pasta" }),
    ).toBeDisabled();
    expect(
      screen.getByText(
        "Terminando de encerrar a busca anterior — aguarde alguns segundos.",
      ),
    ).toBeVisible();
  });

  it("com a varredura em segundo plano, a seção mostra contagem, etapa e o caminho de volta", () => {
    useEnrichStore.setState({
      status: "scanning",
      overlayOpen: false,
      progress: {
        done: 25,
        total: 95,
        atual: "x.mp3",
        etapa: "procurando no LRCLIB",
        scan_id: "s1",
      },
    });
    render(<SettingsView />);
    const secao = secaoCuradoria();
    expect(secao).toHaveTextContent("25 de 95");
    expect(secao).toHaveTextContent("procurando no LRCLIB");
    fireEvent.click(
      within(secao).getByRole("button", { name: "Acompanhar a busca" }),
    );
    expect(useEnrichStore.getState().overlayOpen).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// V9 — o acessório do som: nada baixa sozinho, e a tela diz o que vai baixar
// ---------------------------------------------------------------------------
describe("SettingsView — acessório do reconhecimento pelo som (V9)", () => {
  beforeEach(estadoBase);

  function blocoDoAcessorio(): HTMLElement {
    // o título do bloco é o "para que serve" que vem PRONTO do backend
    return screen.getByRole("region", {
      name: tituloDoAcessorio(acessorio("ausente")),
    });
  }

  it("ausente: diz para que serve, quanto ocupa e de onde vem — e só então oferece", async () => {
    render(<SettingsView />);
    const info = acessorio("ausente");
    expect(
      await screen.findByText(textoDoAcessorioAusente(info)),
    ).toBeInTheDocument();
    // a origem fica à vista: é a única forma de alguém conferir de onde veio
    expect(blocoDoAcessorio()).toHaveTextContent(info.origem);
    expect(
      screen.getByRole("button", { name: rotuloBaixarAcessorio(info, false) }),
    ).toBeEnabled();
    // e NADA baixou sozinho
    expect(acessorioBaixar).not.toHaveBeenCalled();
  });

  it("pronto: nenhum botão de download — baixou uma vez, não pergunta de novo", async () => {
    acessoriosEstado.mockResolvedValue([acessorio("pronto")]);
    render(<SettingsView />);
    expect(await screen.findByText(ACESSORIO_PRONTO)).toBeInTheDocument();
    expect(
      within(blocoDoAcessorio()).queryByRole("button", { name: /Baixar/ }),
    ).not.toBeInTheDocument();
  });

  // Sem drama e sem acusação: o arquivo foi descartado, e a saída é baixar
  // de novo — que é o que a pessoa pode fazer a respeito.
  it("corrompido: explica e oferece baixar DE NOVO", async () => {
    acessoriosEstado.mockResolvedValue([acessorio("corrompido")]);
    render(<SettingsView />);
    expect(await screen.findByText(ACESSORIO_CORROMPIDO)).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: rotuloBaixarAcessorio(acessorio("corrompido"), true),
      }),
    ).toBeEnabled();
  });

  it("lista vazia: não publicamos para este computador, e não há o que baixar", async () => {
    acessoriosEstado.mockResolvedValue([]);
    render(<SettingsView />);
    expect(await screen.findByText(ACESSORIO_SEM_BINARIO)).toBeInTheDocument();
    // não há bloco de acessório nenhum, e portanto nada para baixar
    expect(
      within(secaoCuradoria()).queryByRole("button", { name: /Baixar/ }),
    ).not.toBeInTheDocument();
  });

  it("indisponível nesta versão: também não oferece download", async () => {
    acessoriosEstado.mockResolvedValue([acessorio("indisponivel")]);
    render(<SettingsView />);
    expect(await screen.findByText(ACESSORIO_INDISPONIVEL)).toBeInTheDocument();
    expect(
      within(blocoDoAcessorio()).queryByRole("button", { name: /Baixar/ }),
    ).not.toBeInTheDocument();
  });

  it("estado que não pôde ser conferido: admite, sem inventar ausência", async () => {
    acessoriosEstado.mockRejectedValue(new Error("sem pasta de perfil"));
    render(<SettingsView />);
    expect(await screen.findByText(ACESSORIO_INDETERMINADO)).toBeInTheDocument();
    expect(
      within(secaoCuradoria()).queryByRole("button", { name: /Baixar/ }),
    ).not.toBeInTheDocument();
  });

  it("baixar mostra progresso, deixa cancelar e termina pronto", async () => {
    let concluir!: () => void;
    acessorioBaixar.mockImplementation(
      () =>
        new Promise((r) => {
          concluir = () => r({ cancelado: false, acessorio: acessorio("pronto") });
        }),
    );
    render(<SettingsView />);
    const botao = await screen.findByRole("button", {
      name: rotuloBaixarAcessorio(acessorio("ausente"), false),
    });
    await act(async () => {
      fireEvent.click(botao);
    });
    expect(acessorioBaixar).toHaveBeenCalledWith("fpcalc", expect.any(String));

    // o evento do backend vira barra e texto
    await act(async () => {
      emitirProgressoDoAcessorio?.({
        nome: "fpcalc",
        baixados: 1_048_576,
        total: 5_538_312,
        segundos_restantes: null,
        download_id: acessorioBaixar.mock.calls[0][1] as string,
      });
    });
    expect(
      screen.getByText(textoDoDownload(1_048_576, 5_538_312, null)),
    ).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: /download/i })).toHaveAttribute(
      "aria-valuenow",
      "1048576",
    );
    expect(screen.getByRole("button", { name: "Parar" })).toBeEnabled();

    await act(async () => {
      concluir();
    });
    expect(await screen.findByText(ACESSORIO_PRONTO)).toBeInTheDocument();
  });

  // O evento de OUTRO download não pode mexer nesta barra — mesma disciplina
  // do scan_id do funil (M4).
  it("progresso de outro download é descartado", async () => {
    acessorioBaixar.mockImplementation(() => new Promise(() => {}));
    render(<SettingsView />);
    const botao = await screen.findByRole("button", {
      name: rotuloBaixarAcessorio(acessorio("ausente"), false),
    });
    await act(async () => {
      fireEvent.click(botao);
    });
    await act(async () => {
      emitirProgressoDoAcessorio?.({
        nome: "fpcalc",
        baixados: 4_000_000,
        total: 5_538_312,
        segundos_restantes: null,
        download_id: "de-outra-janela",
      });
    });
    expect(
      screen.queryByText(textoDoDownload(4_000_000, 5_538_312, null)),
    ).not.toBeInTheDocument();
  });

  // `total: null` = o servidor não anunciou o tamanho. Nem barra falsa nem 0%.
  it("sem total anunciado: conta o que já veio, sem barra determinada", async () => {
    acessorioBaixar.mockImplementation(() => new Promise(() => {}));
    render(<SettingsView />);
    const botao = await screen.findByRole("button", {
      name: rotuloBaixarAcessorio(acessorio("ausente"), false),
    });
    await act(async () => {
      fireEvent.click(botao);
    });
    await act(async () => {
      emitirProgressoDoAcessorio?.({
        nome: "fpcalc",
        baixados: 1_048_576,
        total: null,
        segundos_restantes: null,
        download_id: acessorioBaixar.mock.calls[0][1] as string,
      });
    });
    expect(screen.getByText(textoDoDownload(1_048_576, null, null))).toBeInTheDocument();
    expect(screen.queryByRole("progressbar", { name: /download/i })).toBeNull();
  });

  // BAIXO-3 — `Content-Length` que mente PARA MENOS existe: proxy que
  // recomprime, CDN mal configurado, servidor que anuncia o tamanho do
  // pedaço. Com ele, a largura passava de 100% (a barra vazava do trilho) e o
  // `aria-valuenow` ficava MAIOR que o `aria-valuemax` — um progressbar
  // inválido, que leitor de tela anuncia como bem entender.
  //
  // A saída não é grampear em 100%: uma barra cheia enquanto o download
  // continua também mente. Total que o download já passou é total em que não
  // dá para confiar, e "não sabemos" é um estado (DECISIONS #86).
  it("Content-Length mentindo para menos: cai para indeterminado, sem barra inválida", async () => {
    acessorioBaixar.mockImplementation(() => new Promise(() => {}));
    render(<SettingsView />);
    const botao = await screen.findByRole("button", {
      name: rotuloBaixarAcessorio(acessorio("ausente"), false),
    });
    await act(async () => {
      fireEvent.click(botao);
    });
    await act(async () => {
      emitirProgressoDoAcessorio?.({
        nome: "fpcalc",
        baixados: 6_000_000,
        total: 5_538_312,
        segundos_restantes: null,
        download_id: acessorioBaixar.mock.calls[0][1] as string,
      });
    });
    // nenhuma barra determinada: nem >100%, nem 100% mentiroso
    expect(screen.queryByRole("progressbar", { name: /download/i })).toBeNull();
    // e o que já veio continua sendo contado — é o fato de que dispomos
    expect(screen.getByText(textoDoDownload(6_000_000, null, null))).toBeInTheDocument();
  });

  // Enquanto o total é confiável, a barra é barra: valores dentro da faixa e
  // largura dentro do trilho.
  it("com total confiável, a barra fica dentro da faixa que ela declara", async () => {
    acessorioBaixar.mockImplementation(() => new Promise(() => {}));
    render(<SettingsView />);
    const botao = await screen.findByRole("button", {
      name: rotuloBaixarAcessorio(acessorio("ausente"), false),
    });
    await act(async () => {
      fireEvent.click(botao);
    });
    await act(async () => {
      emitirProgressoDoAcessorio?.({
        nome: "fpcalc",
        baixados: 2_000_000,
        total: 5_538_312,
        segundos_restantes: null,
        download_id: acessorioBaixar.mock.calls[0][1] as string,
      });
    });
    const barra = screen.getByRole("progressbar", { name: /download/i });
    const agora = Number(barra.getAttribute("aria-valuenow"));
    const maximo = Number(barra.getAttribute("aria-valuemax"));
    expect(agora).toBeLessThanOrEqual(maximo);
    const largura = (barra.firstElementChild as HTMLElement).style.width;
    expect(Number.parseFloat(largura)).toBeLessThanOrEqual(100);
  });

  // Total zero é o mesmo problema por outro caminho: 0/0 vira NaN e a largura
  // sai como "NaN%", que o navegador simplesmente ignora.
  it("total anunciado como zero não desenha barra nenhuma", async () => {
    acessorioBaixar.mockImplementation(() => new Promise(() => {}));
    render(<SettingsView />);
    const botao = await screen.findByRole("button", {
      name: rotuloBaixarAcessorio(acessorio("ausente"), false),
    });
    await act(async () => {
      fireEvent.click(botao);
    });
    await act(async () => {
      emitirProgressoDoAcessorio?.({
        nome: "fpcalc",
        baixados: 0,
        total: 0,
        segundos_restantes: null,
        download_id: acessorioBaixar.mock.calls[0][1] as string,
      });
    });
    expect(screen.queryByRole("progressbar", { name: /download/i })).toBeNull();
  });

  it("parar cancela de verdade e o desfecho é dito como cancelamento", async () => {
    acessorioBaixar.mockResolvedValue({
      cancelado: true,
      acessorio: acessorio("ausente"),
    });
    render(<SettingsView />);
    const botao = await screen.findByRole("button", {
      name: rotuloBaixarAcessorio(acessorio("ausente"), false),
    });
    await act(async () => {
      fireEvent.click(botao);
    });
    expect(await screen.findByText(ACESSORIO_CANCELADO)).toBeInTheDocument();
    // e continua oferecendo o download, sem tratar isso como falha
    expect(
      screen.getByRole("button", {
        name: rotuloBaixarAcessorio(acessorio("ausente"), false),
      }),
    ).toBeEnabled();
  });

  // O backend manda a frase pronta em pt-BR (soma que não confere, rede que
  // caiu). A tela a mostra COMO VEIO — reescrevê-la aqui seria inventar uma
  // segunda versão da verdade para quem não tem a quem perguntar.
  /**
   * As frases que o backend manda prontas em pt-BR. A tela as mostra COMO
   * VIERAM — reescrevê-las aqui criaria uma segunda versão da verdade sobre
   * uma verificação de segurança (a soma SHA-256) e sobre falhas de disco,
   * para quem não tem a quem perguntar.
   *
   * As quatro últimas são novas (QA M4 do backend): antes as falhas de ESCRITA
   * subiam como `io::Error` e a pessoa lia a mensagem do sistema operacional,
   * em inglês, direto na tela. São as falhas PROVÁVEIS num parque de máquinas
   * que ninguém pode olhar.
   */
  const FRASES_DO_BACKEND = [
    "o arquivo baixado não confere com o esperado — foi descartado, e esta etapa fica desligada",
    "o download foi interrompido antes do fim — nada foi instalado",
    ERROS_DE_GRAVACAO.disco,
    ERROS_DE_GRAVACAO.permissao,
    ERROS_DE_GRAVACAO.emUso,
    ERROS_DE_GRAVACAO.gravacao,
  ];

  for (const frase of FRASES_DO_BACKEND) {
    it(`falha do backend aparece com as palavras do backend: "${frase.slice(0, 40)}…"`, async () => {
      acessorioBaixar.mockRejectedValue(new Error(frase));
      render(<SettingsView />);
      const botao = await screen.findByRole("button", {
        name: rotuloBaixarAcessorio(acessorio("ausente"), false),
      });
      await act(async () => {
        fireEvent.click(botao);
      });
      // texto EXATO: nada de recorte, reescrita ou prefixo "Error:"
      expect(await screen.findByText(frase)).toBeVisible();
    });
  }

  // Cada frase termina dizendo o que fazer, porque não há a quem perguntar —
  // e a que não diz (a genérica) é a única que não tem o que sugerir.
  it("as falhas de escrita terminam com um passo seguinte", () => {
    for (const frase of [
      ERROS_DE_GRAVACAO.disco,
      ERROS_DE_GRAVACAO.permissao,
      ERROS_DE_GRAVACAO.emUso,
    ]) {
      expect(frase.toLowerCase(), frase).toMatch(/tente|tente de novo/);
    }
  });

  it("o botão Parar chama o cancelamento com o id deste download", async () => {
    acessorioBaixar.mockImplementation(() => new Promise(() => {}));
    render(<SettingsView />);
    const botao = await screen.findByRole("button", {
      name: rotuloBaixarAcessorio(acessorio("ausente"), false),
    });
    await act(async () => {
      fireEvent.click(botao);
    });
    fireEvent.click(screen.getByRole("button", { name: "Parar" }));
    expect(acessorioCancelar).toHaveBeenCalledWith(
      acessorioBaixar.mock.calls[0][1],
    );
  });
});

// ---------------------------------------------------------------------------
// V9 — os dois trabalhos: completar o que falta x conferir a etiqueta
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// V10 — o caminho único: os modos sumiram (DECISIONS #102)
// ---------------------------------------------------------------------------
//
// Modo é escolha, e escolha é pedágio para quem não tem a quem perguntar. Com
// os 2 s por música MEDIDOS em campo, separar "completar" de "conferir"
// custava 2 minutos e meio num acervo de 150 — e cobrava por eles que alguém
// que não sabe o que é terminal escolhesse entre dois nomes que não entende.
// Pior: a conferência era a única coisa que achava etiqueta ERRADA, e recurso
// que depende de o usuário adivinhar que existe é recurso que não existe.

describe("SettingsView — o caminho único (V10)", () => {
  beforeEach(estadoBase);

  it("há UM botão, e nenhuma escolha de trabalho a fazer antes", async () => {
    acessoriosEstado.mockResolvedValue([acessorio("pronto")]);
    render(<SettingsView />);
    await screen.findAllByText(ACESSORIO_PRONTO);
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    const secao = secaoCuradoria();
    expect(secao.textContent ?? "").not.toContain("Conferir se a etiqueta");
    expect(secao.textContent ?? "").not.toContain("Completar o que falta");
    expect(
      screen.getByRole("button", { name: ROTULO_DO_DISPARO }),
    ).toBeEnabled();
  });

  it("a contagem é pedida com a PASTA e nada mais", async () => {
    render(<SettingsView />);
    await screen.findByText(estimativa(pronta(), 3));
    expect(enrichCount).toHaveBeenCalledWith("");
    expect(enrichCount.mock.calls[0]).toHaveLength(1);
  });

  // DECISIONS #101 — a tela lista o que ESTA máquina faz. Quem decide isso é o
  // backend, na `Contagem.etapas`: aqui a lista só ganha a frase que explica.
  it("as etapas listadas são as que o backend disse que vão rodar", async () => {
    enrichCount.mockResolvedValue(
      contagem({
        etapas: [
          "lendo etiquetas e nome do arquivo",
          "reconhecendo pelo som",
          "procurando no LRCLIB",
          "procurando no Vagalume",
        ],
        segundos_estimados: 1020,
      }),
    );
    render(<SettingsView />);
    await screen.findByText(estimativa(pronta({ segundos_estimados: 1020 }), 3));
    const texto = secaoCuradoria().textContent ?? "";
    expect(texto.indexOf("Lendo etiquetas e nome do arquivo")).toBeLessThan(
      texto.indexOf("Reconhecendo pelo som"),
    );
    expect(texto.indexOf("Reconhecendo pelo som")).toBeLessThan(
      texto.indexOf("Procurando no LRCLIB"),
    );
    expect(texto).toContain("Procurando no Vagalume");
  });

  it("etapa que o backend não mandou não aparece na lista", async () => {
    render(<SettingsView />);
    await screen.findByText(estimativa(pronta(), 3));
    const texto = secaoCuradoria().textContent ?? "";
    expect(texto).not.toContain("Reconhecendo pelo som");
    expect(texto).not.toContain("Procurando no Vagalume");
  });

  // A estimativa vem PRONTA (DECISIONS #80): mudar só o número do backend
  // muda a frase inteira, e não há conta nenhuma em TypeScript para divergir.
  it("a estimativa é o número do backend, formatado", async () => {
    enrichCount.mockResolvedValue(
      contagem({ total: 150, sem_letra: 80, segundos_estimados: 1020 }),
    );
    render(<SettingsView />);
    expect(
      await screen.findByText(/150 músicas nesta pasta/),
    ).toBeInTheDocument();
    expect(screen.getByText(/por volta de 17 minutos/)).toBeInTheDocument();
  });

  it("dispara levando o que a máquina pode fazer quanto à etapa 5", async () => {
    const startScan = vi.fn(async () => {});
    useEnrichStore.setState({ startScan });
    enrichCount.mockResolvedValue(contagem({ transcricao_disponivel: true }));
    acessoriosEstado.mockResolvedValue([
      acessorio("pronto"),
      whisper("pronto"),
      modelo("pronto"),
    ]);
    render(<SettingsView />);
    await screen.findByText(estimativa(pronta(), 3));

    fireEvent.click(screen.getByRole("button", { name: ROTULO_DO_DISPARO }));
    expect(startScan).toHaveBeenCalledWith("", {
      disponivel: true,
      download: null,
    });
  });

  // Sem os acessórios, a pergunta do fim precisa do TAMANHO e do TEMPO para
  // oferecer o download (DECISIONS #106) — e quem os soma é a tela, a partir
  // do que o backend disse de cada acessório.
  it("sem os acessórios da etapa 5, o disparo leva o que falta baixar", async () => {
    const startScan = vi.fn(async () => {});
    useEnrichStore.setState({ startScan });
    acessoriosEstado.mockResolvedValue([
      acessorio("pronto"),
      whisper("ausente"),
      modelo("ausente"),
    ]);
    render(<SettingsView />);
    await screen.findByText(estimativa(pronta(), 3));

    fireEvent.click(screen.getByRole("button", { name: ROTULO_DO_DISPARO }));
    expect(startScan).toHaveBeenCalledWith("", {
      disponivel: false,
      download: { bytes: 183_000_000, segundos: 183 },
    });
  });

  it("zero músicas disponíveis: não deixa disparar e diz por quê", async () => {
    enrichCount.mockResolvedValue(contagem({ total: 0, sem_letra: 0 }));
    render(<SettingsView />);
    await screen.findByText(estimativa(pronta({ total: 0 }), 3));
    expect(screen.getByRole("button", { name: ROTULO_DO_DISPARO })).toBeDisabled();
    expect(
      screen.getByText("Não há música disponível nesta pasta para procurar."),
    ).toBeVisible();
  });

  // A etapa 5 leva HORAS e roda em segundo plano: voltar a Configurações tem
  // de mostrar em que pé ela está, e não liberar um segundo disparo por cima.
  it("com a transcrição rodando, a seção mostra o progresso e bloqueia o disparo", () => {
    useEnrichStore.setState({
      status: "transcribing",
      overlayOpen: false,
      transcricaoProgress: {
        done: 3,
        total: 47,
        atual: "Oh! Chuva.mp3",
        porcento_da_musica: 45,
        segundos_restantes: 9800,
        scan_id: "t1",
      },
    });
    render(<SettingsView />);
    const secao = secaoCuradoria();
    expect(secao).toHaveTextContent("Escrevendo as letras… 3 de 47");
    expect(screen.getByRole("button", { name: ROTULO_DO_DISPARO })).toBeDisabled();
    fireEvent.click(
      within(secao).getByRole("button", { name: "Acompanhar a escrita" }),
    );
    expect(useEnrichStore.getState().overlayOpen).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// V10 — os acessórios da etapa 5: 2 MB de programa e 181 MB de dado
// ---------------------------------------------------------------------------

describe("SettingsView — os acessórios da etapa 5 (V10)", () => {
  beforeEach(() => {
    estadoBase();
    acessoriosEstado.mockResolvedValue([
      acessorio("ausente"),
      whisper("ausente"),
      modelo("ausente"),
    ]);
  });

  it("cada acessório tem o seu bloco, com o para-que-serve do backend", async () => {
    render(<SettingsView />);
    for (const info of [acessorio("ausente"), whisper("ausente"), modelo("ausente")]) {
      expect(
        await screen.findByRole("region", { name: tituloDoAcessorio(info) }),
      ).toBeInTheDocument();
    }
  });

  // "um programa de 2 MB e um arquivo de 181 MB" é outra conversa que "dois
  // programas": o modelo é DADO, e ninguém o executa.
  it("o modelo é anunciado como arquivo, e o transcritor como programa", async () => {
    render(<SettingsView />);
    const bloco = await screen.findByRole("region", {
      name: tituloDoAcessorio(modelo("ausente")),
    });
    expect(bloco).toHaveTextContent("um arquivo de 172,6 MB");
    const programa = screen.getByRole("region", {
      name: tituloDoAcessorio(whisper("ausente")),
    });
    expect(programa).toHaveTextContent("um programa de 1,9 MB");
  });

  // DECISIONS #106 — para 180 MB a dispensa do tempo acabou.
  it("o download de 180 MB anuncia o tempo, e não só o tamanho", async () => {
    render(<SettingsView />);
    const bloco = await screen.findByRole("region", {
      name: tituloDoAcessorio(modelo("ausente")),
    });
    expect(bloco).toHaveTextContent("cerca de 3 minutos");
  });

  it("baixar o modelo pede o modelo, e não o acessório do som", async () => {
    render(<SettingsView />);
    const bloco = await screen.findByRole("region", {
      name: tituloDoAcessorio(modelo("ausente")),
    });
    await act(async () => {
      fireEvent.click(
        within(bloco).getByRole("button", {
          name: rotuloBaixarAcessorio(modelo("ausente"), false),
        }),
      );
    });
    expect(acessorioBaixar).toHaveBeenCalledWith(
      "modelo-de-transcricao",
      expect.any(String),
    );
  });

  // A velocidade MEDIDA troca a estimativa declarada assim que existe amostra
  // — e o evento de OUTRO acessório não mexe nesta barra.
  it("o progresso mostra quanto falta, pela velocidade medida", async () => {
    acessorioBaixar.mockImplementation(() => new Promise(() => {}));
    render(<SettingsView />);
    const bloco = await screen.findByRole("region", {
      name: tituloDoAcessorio(modelo("ausente")),
    });
    await act(async () => {
      fireEvent.click(
        within(bloco).getByRole("button", {
          name: rotuloBaixarAcessorio(modelo("ausente"), false),
        }),
      );
    });
    await act(async () => {
      emitirProgressoDoAcessorio?.({
        nome: "modelo-de-transcricao",
        baixados: 40_000_000,
        total: 181_000_000,
        segundos_restantes: 141,
        download_id: acessorioBaixar.mock.calls[0][1] as string,
      });
    });
    expect(
      within(bloco).getByText(
        textoDoDownload(40_000_000, 181_000_000, 141),
      ),
    ).toBeVisible();
    expect(
      within(bloco).getByText(/faltam cerca de 2 minutos/),
    ).toBeVisible();
  });

  it("o progresso de OUTRO acessório não mexe nesta barra", async () => {
    acessorioBaixar.mockImplementation(() => new Promise(() => {}));
    render(<SettingsView />);
    const bloco = await screen.findByRole("region", {
      name: tituloDoAcessorio(modelo("ausente")),
    });
    await act(async () => {
      fireEvent.click(
        within(bloco).getByRole("button", {
          name: rotuloBaixarAcessorio(modelo("ausente"), false),
        }),
      );
    });
    await act(async () => {
      emitirProgressoDoAcessorio?.({
        nome: "fpcalc",
        baixados: 5_000_000,
        total: 5_538_312,
        segundos_restantes: 1,
        download_id: acessorioBaixar.mock.calls[0][1] as string,
      });
    });
    expect(
      within(bloco).queryByText(textoDoDownload(5_000_000, 5_538_312, 1)),
    ).toBeNull();
  });

  // Baixar um dos dois não liga a etapa 5: ela exige os DOIS, e quem combina
  // os dois estados é o backend (DECISIONS #80).
  it("baixar só o programa não promete a etapa 5", async () => {
    enrichCount.mockImplementation(async () =>
      contagem({ transcricao_disponivel: false }),
    );
    acessoriosEstado.mockResolvedValue([
      acessorio("pronto"),
      whisper("pronto"),
      modelo("ausente"),
    ]);
    const startScan = vi.fn(async () => {});
    useEnrichStore.setState({ startScan });
    render(<SettingsView />);
    await screen.findByText(estimativa(pronta(), 3));
    fireEvent.click(screen.getByRole("button", { name: ROTULO_DO_DISPARO }));
    expect(startScan).toHaveBeenCalledWith("", {
      disponivel: false,
      download: { bytes: 181_000_000, segundos: 181 },
    });
  });
});

// ---------------------------------------------------------------------------
// V10 — nenhuma credencial na tela (DECISIONS #110)
// ---------------------------------------------------------------------------
//
// O Vagalume saiu do produto: API descontinuada, chave que o dono do produto
// nunca conseguiu, e código que nunca rodou contra o serviço real. O
// `lyrics.ovh` que tomou o lugar dele não pede nada — então o campo de chave e
// todo o texto que o explicava saíram da tela. Era o último pedágio de
// configuração do produto, numa tela usada por ~40 pessoas leigas.

describe("SettingsView — nenhuma credencial pedida (V10)", () => {
  beforeEach(estadoBase);

  it("não há campo de chave nenhum, e a seção não fala em credencial", async () => {
    render(<SettingsView />);
    await screen.findByText(estimativa(pronta(), 3));
    const texto = secaoCuradoria().textContent ?? "";
    expect(texto.toLowerCase()).not.toContain("chave");
    expect(texto.toLowerCase()).not.toContain("vagalume");
    expect(
      screen.queryByLabelText(/Chave do Vagalume/i),
    ).not.toBeInTheDocument();
    // nenhum campo de texto sobrou na seção: o seletor de pasta é um <select>
    expect(within(secaoCuradoria()).queryAllByRole("textbox")).toHaveLength(0);
  });

  it("a contagem é pedida sem credencial, e com um argumento só", async () => {
    render(<SettingsView />);
    await screen.findByText(estimativa(pronta(), 3));
    expect(enrichCount).toHaveBeenCalledWith("");
    expect(enrichCount.mock.calls[0]).toHaveLength(1);
  });

  // A etapa 4 aparece SEMPRE: ela não depende de nada que a pessoa tenha de
  // providenciar. Quem decide a lista continua sendo o backend.
  it("a etapa do lyrics.ovh é listada sem depender de nada", async () => {
    enrichCount.mockResolvedValue(
      contagem({
        etapas: [
          "lendo etiquetas e nome do arquivo",
          "procurando no LRCLIB",
          "procurando no lyrics.ovh",
        ],
        segundos_estimados: 18,
      }),
    );
    render(<SettingsView />);
    await screen.findByText(estimativa(pronta({ segundos_estimados: 18 }), 3));
    const texto = secaoCuradoria().textContent ?? "";
    expect(texto).toContain("Procurando no lyrics.ovh");
    // e a lista diz a fraqueza dela: é a única etapa cujo casamento o
    // programa não tem como conferir
    expect(texto).toContain("ele não diz de que música é a letra");
  });
});

describe("SettingsView — acessibilidade da seção nova", () => {
  beforeEach(estadoBase);

  /**
   * Fundo REAL do elemento: o do ancestral mais próximo que declara um, e
   * não o da página. O bloco de progresso é #F0FDFA e o texto dele nunca
   * tinha sido medido contra o próprio fundo.
   */
  function fundoDe(el: HTMLElement, raiz: HTMLElement): string {
    let atual: HTMLElement | null = el;
    while (atual) {
      const m = /bg-\[(#[0-9a-fA-F]{6})\]/.exec(atual.className ?? "");
      if (m) return m[1];
      if (atual === raiz) break;
      atual = atual.parentElement;
    }
    return FUNDO_CONFIGURACOES;
  }

  function varrerContraste(secao: HTMLElement): number {
    const comCor = [...secao.querySelectorAll<HTMLElement>("*")].filter((el) =>
      /text-\[#[0-9a-fA-F]{6}\]/.test(el.className),
    );
    for (const el of comCor) {
      const cor = corDoTexto(el.className);
      const razao = contrastRatio(cor, fundoDe(el, secao));
      expect(
        razao,
        `"${el.textContent?.slice(0, 40)}" em ${cor} sobre ${fundoDe(el, secao)}`,
      ).toBeGreaterThanOrEqual(AA_TEXTO_NORMAL);
    }
    return comCor.length;
  }

  // MÉDIO-14 — a varredura só rodava no estado `idle`, e a afirmação "varre
  // TODOS os elementos" (DECISIONS #76) só valia de um estado: o bloco de
  // progresso (#115E59 sobre #F0FDFA) nunca era medido.
  it("todo texto da curadoria passa em AA — em TODOS os estados da seção", async () => {
    // Os estados do acessório entram AQUI, e não numa varredura à parte: o
    // bloco novo é feito de texto secundário sobre fundo claro, que é
    // exatamente onde o contraste cai (DECISIONS #69). E a varredura precisa
    // ESPERAR a resposta do backend — antes de ela chegar o bloco não desenha
    // nada, e um sweep síncrono mediria uma tela que ninguém vê.
    const estados: Array<[string, () => void]> = [
      ["parada", () => {}],
      [
        "varrendo",
        () =>
          useEnrichStore.setState({
            status: "scanning",
            overlayOpen: false,
            progress: {
              done: 25,
              total: 95,
              atual: "x.mp3",
              etapa: "procurando no LRCLIB",
              scan_id: "s1",
            },
          }),
      ],
      [
        "revisão pendente",
        () => useEnrichStore.setState({ status: "review", proposals: [] }),
      ],
      [
        "encerrando",
        () => useEnrichStore.setState({ status: "idle", scanInFlight: true }),
      ],
      [
        "acessório pronto (e a conferência disponível)",
        () => acessoriosEstado.mockResolvedValue([acessorio("pronto")]),
      ],
      [
        "acessório corrompido",
        () => acessoriosEstado.mockResolvedValue([acessorio("corrompido")]),
      ],
      [
        "acessório indisponível nesta versão",
        () => acessoriosEstado.mockResolvedValue([acessorio("indisponivel")]),
      ],
      [
        "sem binário para este computador",
        () => acessoriosEstado.mockResolvedValue([]),
      ],
      [
        "estado do acessório desconhecido",
        () => acessoriosEstado.mockRejectedValue(new Error("sem perfil")),
      ],
    ];
    for (const [nome, preparar] of estados) {
      estadoBase();
      preparar();
      const { unmount } = render(<SettingsView />);
      // deixa a consulta do acessório e a contagem resolverem
      await act(async () => {});
      const medidos = varrerContraste(secaoCuradoria());
      expect(medidos, `estado ${nome} sem texto medido`).toBeGreaterThan(0);
      unmount();
    }
  });

  // O download é o único estado que não nasce de uma resposta do backend: ele
  // existe entre o clique e o desfecho, e tem barra, contagem e um botão.
  it("o texto do download em curso também passa em AA", async () => {
    acessorioBaixar.mockImplementation(() => new Promise(() => {}));
    render(<SettingsView />);
    const botao = await screen.findByRole("button", {
      name: rotuloBaixarAcessorio(acessorio("ausente"), false),
    });
    await act(async () => {
      fireEvent.click(botao);
    });
    await act(async () => {
      emitirProgressoDoAcessorio?.({
        nome: "fpcalc",
        baixados: 2_000_000,
        total: 5_538_312,
        segundos_restantes: null,
        download_id: acessorioBaixar.mock.calls[0][1] as string,
      });
    });
    expect(varrerContraste(secaoCuradoria())).toBeGreaterThan(0);
  });

  it("os controles da curadoria são alcançáveis por teclado (nativos, sem tabindex negativo)", () => {
    render(<SettingsView />);
    const secao = secaoCuradoria();
    const controles = secao.querySelectorAll<HTMLElement>("button, select, input");
    // V10 — o campo de chave saiu (DECISIONS #110): sobraram o seletor de
    // pasta, o disparo e os botões de download dos acessórios
    expect(controles.length).toBeGreaterThanOrEqual(2);
    for (const c of controles) {
      expect(c.getAttribute("tabindex")).not.toBe("-1");
    }
  });
});
