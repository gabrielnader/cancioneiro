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
  CONFERENCIA_PRECISA_DO_SOM,
  estimativaTexto,
  rotuloBaixarAcessorio,
  textoDoAcessorioAusente,
  textoDoDownload,
  VAGALUME_URL,
} from "../lib/curadoria";
import type { ContagemCandidatas, EtapasLigadas } from "../lib/curadoria";
import type { AcessorioInfo, AcessorioProgresso } from "../lib/api";
import type { Modo } from "../lib/types";
import type { Song } from "../lib/types";
import { useEnrichStore } from "../stores/enrichStore";
import { useLibraryStore } from "../stores/libraryStore";
import { useUiStore } from "../stores/uiStore";
import { SettingsView } from "./SettingsView";

/** Fundo da tela de Configurações — todo texto novo é lido em cima dele. */
const FUNDO_CONFIGURACOES = "#F9FAFB";

/** Contagem já respondida pelo backend. */
const pronta = (total: number): ContagemCandidatas => ({ estado: "pronta", total });

/**
 * Instalação nova: o acessório do som não está aqui, e o Vagalume conta na
 * estimativa (a chave é nossa, embutida na build — V9).
 */
const SEM_SOM: EtapasLigadas = { som: false, vagalume: true };

/** O texto que a tela deve mostrar, montado com os mesmos parâmetros dela. */
function estimativa(
  contagem: ContagemCandidatas,
  musicasNaPasta: number,
  modo: Modo = "completar",
  etapas: EtapasLigadas = SEM_SOM,
): string {
  return estimativaTexto({ contagem, musicasNaPasta, modo, etapas });
}

/** O acessório desta máquina, no estado pedido. */
function acessorio(estado: AcessorioInfo["estado"]): AcessorioInfo {
  return {
    nome: "fpcalc",
    para_que_serve: "reconhecer a música pelo som",
    arquivo: "fpcalc-linux-x86_64",
    tamanho_bytes: 5_538_312,
    estado,
    origem:
      "https://github.com/gabrielnader/cancioneiro/releases/download/acessorios-v1/fpcalc-linux-x86_64",
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
  enrichCount = vi.fn(async (prefix: string) => (prefix === "/acervo/1" ? 1 : 2));
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
  useUiStore.setState({ view: "settings", vagalumeApiKey: "" });
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

  it("explica o funil ANTES de qualquer clique, etapa por etapa e na ordem", () => {
    render(<SettingsView />);
    const secao = secaoCuradoria();
    const texto = secao.textContent ?? "";
    expect(texto.indexOf("O que já está no arquivo")).toBeGreaterThan(-1);
    expect(texto.indexOf("O que já está no arquivo")).toBeLessThan(
      texto.indexOf("LRCLIB"),
    );
    expect(texto.indexOf("LRCLIB")).toBeLessThan(texto.indexOf("Vagalume"));
    // nada é gravado sem revisão (DECISIONS #49/#58)
    expect(texto).toContain("Nada é gravado sem você conferir");
    // roda em segundo plano, e isso é dito antes de começar
    expect(texto).toContain("segundo plano");
  });

  // V9 — o app passou a reconhecer pelo som, e o texto que negava as duas
  // etapas pesadas foi CONFERIDO antes de ser encurtado: hoje ele nega uma só.
  it("é honesta sobre o que ainda NÃO é feito dentro do app", () => {
    render(<SettingsView />);
    const texto = secaoCuradoria().textContent ?? "";
    expect(texto).toContain("Escrever a letra ouvindo o áudio ainda não é feito");
    // e não manda mais ninguém para uma ferramenta de terminal que ela não tem
    expect(texto).not.toContain("ferramentas de curadoria");
  });

  // Sem o acessório baixado a etapa 2 não roda: listá-la seria prometer
  // trabalho que não vai acontecer.
  it("a etapa do som só é listada quando o acessório está pronto", async () => {
    render(<SettingsView />);
    await screen.findByText(estimativa(pronta(2), 3));
    expect(secaoCuradoria().textContent).not.toContain("Reconhecer pelo som");

    acessoriosEstado.mockResolvedValue([acessorio("pronto")]);
    const { unmount } = render(<SettingsView />);
    await screen.findAllByText(ACESSORIO_PRONTO);
    expect(screen.getAllByRole("region", { name: "Curadoria do acervo" })[1]
      .textContent).toContain("Reconhecer pelo som");
    unmount();
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
    expect(await screen.findByText(estimativa(pronta(2), 3))).toBeInTheDocument();
    // a contagem viaja com o MODO: a conferência olha outra população
    expect(enrichCount).toHaveBeenCalledWith("", "completar");

    fireEvent.change(screen.getByLabelText("Pasta a curar"), {
      target: { value: "/acervo/1" },
    });
    expect(await screen.findByText(estimativa(pronta(1), 2))).toBeInTheDocument();
    expect(enrichCount).toHaveBeenCalledWith("/acervo/1", "completar");
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
    expect(startScan).toHaveBeenCalledWith("/acervo/2", "completar");
  });

  it("pasta sem nenhuma música incompleta: não deixa disparar e diz por quê", async () => {
    enrichCount.mockResolvedValue(0);
    useLibraryStore.setState({ allSongs: [song(1, "/acervo/1/completa.mp3")] });
    render(<SettingsView />);
    expect(
      await screen.findByText(estimativa(pronta(0), 1)),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Buscar dados desta pasta" }),
    ).toBeDisabled();
  });

  // MÉDIO-11 — sem pasta nenhuma a tela dizia "nenhuma música desta pasta
  // está sem título, artista ou letra": descrevia ZERO músicas como completas.
  it("biblioteca sem música: não afirma completude, diz o que fazer", async () => {
    enrichCount.mockResolvedValue(0);
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
    return screen.getByRole("region", { name: "Reconhecer música pelo som" });
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
    expect(
      within(blocoDoAcessorio()).queryByRole("button", { name: /Baixar/ }),
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
      within(blocoDoAcessorio()).queryByRole("button", { name: /Baixar/ }),
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
        download_id: acessorioBaixar.mock.calls[0][1] as string,
      });
    });
    expect(
      screen.getByText(textoDoDownload(1_048_576, 5_538_312)),
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
        download_id: "de-outra-janela",
      });
    });
    expect(
      screen.queryByText(textoDoDownload(4_000_000, 5_538_312)),
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
        download_id: acessorioBaixar.mock.calls[0][1] as string,
      });
    });
    expect(screen.getByText(textoDoDownload(1_048_576, null))).toBeInTheDocument();
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
  it("falha do backend aparece com as palavras do backend", async () => {
    const frase =
      "o arquivo baixado não confere com o esperado — foi descartado, e esta etapa fica desligada";
    acessorioBaixar.mockRejectedValue(new Error(frase));
    render(<SettingsView />);
    const botao = await screen.findByRole("button", {
      name: rotuloBaixarAcessorio(acessorio("ausente"), false),
    });
    await act(async () => {
      fireEvent.click(botao);
    });
    expect(await screen.findByText(new RegExp(frase))).toBeInTheDocument();
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
describe("SettingsView — o modo de conferência (V9)", () => {
  beforeEach(estadoBase);

  function opcaoConferir(): HTMLElement {
    return screen.getByRole("radio", { name: /Conferir se a etiqueta/ });
  }

  it("o padrão é completar o que falta, e nunca a conferência", async () => {
    acessoriosEstado.mockResolvedValue([acessorio("pronto")]);
    render(<SettingsView />);
    await screen.findByText(ACESSORIO_PRONTO);
    expect(
      screen.getByRole("radio", { name: /Completar o que falta/ }),
    ).toBeChecked();
    expect(opcaoConferir()).not.toBeChecked();
  });

  // Sem o acessório a conferência é impossível: o motivo é TEXTO na tela, e
  // não `title=` num controle desabilitado (DECISIONS #87).
  it("sem o acessório, a conferência fica indisponível com o motivo visível", async () => {
    render(<SettingsView />);
    await screen.findByText(estimativa(pronta(2), 3));
    expect(opcaoConferir()).toBeDisabled();
    const motivo = screen.getByText(CONFERENCIA_PRECISA_DO_SOM);
    expect(motivo).toBeVisible();
    expect(opcaoConferir()).toHaveAttribute("aria-describedby", motivo.id);
  });

  it("com o acessório, escolher a conferência troca contagem, texto e botão", async () => {
    acessoriosEstado.mockResolvedValue([acessorio("pronto")]);
    enrichCount.mockImplementation(async (_prefixo: string, modo?: Modo) =>
      modo === "conferencia" ? 150 : 2,
    );
    render(<SettingsView />);
    await screen.findByText(ACESSORIO_PRONTO);

    fireEvent.click(opcaoConferir());
    expect(
      await screen.findByText(
        estimativa(pronta(150), 3, "conferencia", { som: true, vagalume: true }),
      ),
    ).toBeInTheDocument();
    expect(enrichCount).toHaveBeenCalledWith("", "conferencia");
    // o botão diz qual dos dois trabalhos vai começar
    expect(
      screen.getByRole("button", { name: "Conferir esta pasta" }),
    ).toBeEnabled();
  });

  // "Nenhuma música precisa de busca agora" seria falso aqui: a conferência
  // não olha completude nenhuma. Estado raro, mas só é verdade sobre a tela o
  // que o teste visitou (DECISIONS #87).
  it("conferência sem nada a conferir: o motivo fala a língua do modo", async () => {
    acessoriosEstado.mockResolvedValue([acessorio("pronto")]);
    enrichCount.mockImplementation(async (_prefixo: string, modo?: Modo) =>
      modo === "conferencia" ? 0 : 2,
    );
    render(<SettingsView />);
    await screen.findByText(ACESSORIO_PRONTO);

    fireEvent.click(opcaoConferir());
    expect(
      await screen.findByText("Não há o que conferir nesta pasta."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Conferir esta pasta" }),
    ).toBeDisabled();
  });

  it("disparar em conferência leva o modo à varredura", async () => {
    const startScan = vi.fn(async () => {});
    useEnrichStore.setState({ startScan });
    acessoriosEstado.mockResolvedValue([acessorio("pronto")]);
    render(<SettingsView />);
    await screen.findByText(ACESSORIO_PRONTO);

    fireEvent.click(opcaoConferir());
    fireEvent.click(screen.getByRole("button", { name: "Conferir esta pasta" }));
    expect(startScan).toHaveBeenCalledWith("", "conferencia");
  });
});

describe("SettingsView — chave do Vagalume (V8 F18)", () => {
  beforeEach(estadoBase);

  // V9 — a chave passou a ser NOSSA, embutida em tempo de build. O campo
  // continua existindo (tem precedência, é a saída se a nossa for bloqueada),
  // mas deixou de ser pedágio: o texto diz que normalmente não é preciso.
  it("diz que só é preciso preencher se o Vagalume parar, e onde pegar", () => {
    render(<SettingsView />);
    const texto = secaoCuradoria().textContent ?? "";
    expect(texto).toContain("Só é preciso preencher");
    expect(texto).toContain("gratuita");
    expect(texto).toContain(VAGALUME_URL);
  });

  // MÉDIO-10 — a chave É gravada em disco (localStorage das preferências), e
  // quatro lugares diziam que não. A decisão de produto é mantê-la guardada:
  // 40 pessoas sem suporte redigitando uma chave a cada sessão é pior. O que
  // muda é a verdade do texto, que é a única coisa que essas pessoas têm.
  it("diz a verdade sobre onde a chave fica guardada e para onde ela vai", () => {
    render(<SettingsView />);
    const texto = secaoCuradoria().textContent ?? "";
    // encurtar NÃO podia jogar fora nada disto: é o que a pessoa precisa
    // saber sobre uma credencial dela guardada por nós (DECISIONS #84)
    expect(texto).toContain("Ela fica guardada neste computador");
    expect(texto).toContain("Não entra no banco de músicas");
    expect(texto).toContain("não é escrita nos MP3");
    expect(texto).toContain("não vai a lugar nenhum além do próprio Vagalume");
  });

  it("digitar guarda nas preferências; apagar volta ao estado sem chave", () => {
    render(<SettingsView />);
    const campo = screen.getByLabelText("Chave do Vagalume (opcional)");
    fireEvent.change(campo, { target: { value: "minha-chave" } });
    expect(useUiStore.getState().vagalumeApiKey).toBe("minha-chave");
    fireEvent.change(campo, { target: { value: "" } });
    expect(useUiStore.getState().vagalumeApiKey).toBe("");
  });

  // É a chave de um serviço gratuito da própria pessoa, num app sem conta e
  // sem telemetria: esconder atrás de bolinhas só atrapalharia conferir a
  // colagem. Mas ela nunca vai para log.
  it("é um campo de texto comum, conferível — não um campo de senha", () => {
    render(<SettingsView />);
    expect(screen.getByLabelText("Chave do Vagalume (opcional)")).toHaveAttribute(
      "type",
      "text",
    );
  });

  it("a chave já guardada aparece no campo ao reabrir Configurações", () => {
    useUiStore.setState({ vagalumeApiKey: "guardada" });
    render(<SettingsView />);
    expect(screen.getByLabelText("Chave do Vagalume (opcional)")).toHaveValue(
      "guardada",
    );
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
        download_id: acessorioBaixar.mock.calls[0][1] as string,
      });
    });
    expect(varrerContraste(secaoCuradoria())).toBeGreaterThan(0);
  });

  it("os controles da curadoria são alcançáveis por teclado (nativos, sem tabindex negativo)", () => {
    render(<SettingsView />);
    const secao = secaoCuradoria();
    const controles = secao.querySelectorAll<HTMLElement>("button, select, input");
    expect(controles.length).toBeGreaterThanOrEqual(3);
    for (const c of controles) {
      expect(c.getAttribute("tabindex")).not.toBe("-1");
    }
  });
});
