import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setBackendForTests, type Backend } from "../lib/api";
import {
  AA_TEXTO_NORMAL,
  contrastRatio,
  corDoTexto,
} from "../test/contrast";
import { estimativaTexto, VAGALUME_URL } from "../lib/curadoria";
import type { ContagemCandidatas } from "../lib/curadoria";
import type { Song } from "../lib/types";
import { useEnrichStore } from "../stores/enrichStore";
import { useLibraryStore } from "../stores/libraryStore";
import { useUiStore } from "../stores/uiStore";
import { SettingsView } from "./SettingsView";

/** Fundo da tela de Configurações — todo texto novo é lido em cima dele. */
const FUNDO_CONFIGURACOES = "#F9FAFB";

/** Contagem já respondida pelo backend. */
const pronta = (total: number): ContagemCandidatas => ({ estado: "pronta", total });

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

function estadoBase() {
  // a contagem de candidatas vem do BACKEND (mesma função da varredura):
  // por padrão, as duas incompletas do acervo de teste
  enrichCount = vi.fn(async (prefix: string) => (prefix === "/acervo/1" ? 1 : 2));
  setBackendForTests({
    onScanProgress: vi.fn(async () => () => {}),
    enrichCount,
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

  // A Fase 1 não faz impressão digital nem transcrição. Quem cura não tem a
  // quem perguntar: prometer as etapas pesadas seria abandonar a pessoa.
  it("é honesta sobre o que ainda NÃO é feito dentro do app", () => {
    render(<SettingsView />);
    const texto = secaoCuradoria().textContent ?? "";
    expect(texto).toContain("ainda não");
    expect(texto).toContain("ferramentas de curadoria");
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
    expect(await screen.findByText(estimativaTexto(pronta(2), 3))).toBeInTheDocument();
    expect(enrichCount).toHaveBeenCalledWith("");

    fireEvent.change(screen.getByLabelText("Pasta a curar"), {
      target: { value: "/acervo/1" },
    });
    expect(await screen.findByText(estimativaTexto(pronta(1), 2))).toBeInTheDocument();
    expect(enrichCount).toHaveBeenCalledWith("/acervo/1");
  });

  // A contagem virou uma chamada: enquanto ela não volta, a tela diz o que
  // está fazendo — e NUNCA desabilita o disparo por isso.
  it("contagem ainda em curso: texto honesto e botão liberado", () => {
    enrichCount.mockImplementation(() => new Promise(() => {}));
    render(<SettingsView />);
    expect(
      screen.getByText(estimativaTexto({ estado: "contando" }, 3)),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Buscar dados desta pasta" }),
    ).toBeEnabled();
  });

  it("contagem que falhou não vira impedimento: admite e deixa buscar", async () => {
    enrichCount.mockRejectedValue(new Error("sem banco"));
    render(<SettingsView />);
    expect(
      await screen.findByText(estimativaTexto({ estado: "indisponivel" }, 3)),
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
    expect(startScan).toHaveBeenCalledWith("/acervo/2");
  });

  it("pasta sem nenhuma música incompleta: não deixa disparar e diz por quê", async () => {
    enrichCount.mockResolvedValue(0);
    useLibraryStore.setState({ allSongs: [song(1, "/acervo/1/completa.mp3")] });
    render(<SettingsView />);
    expect(
      await screen.findByText(estimativaTexto(pronta(0), 1)),
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
    expect(secao).toHaveTextContent("Adicione uma pasta de música");
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

describe("SettingsView — chave do Vagalume (V8 F18)", () => {
  beforeEach(estadoBase);

  it("explica o que é, que é gratuita e onde pegar", () => {
    render(<SettingsView />);
    const texto = secaoCuradoria().textContent ?? "";
    expect(texto).toContain("gratuita");
    expect(texto).toContain(VAGALUME_URL);
    // ausência de chave não é erro: a etapa é só pulada
    expect(texto).toContain("Sem a chave");
  });

  // MÉDIO-10 — a chave É gravada em disco (localStorage das preferências), e
  // quatro lugares diziam que não. A decisão de produto é mantê-la guardada:
  // 40 pessoas sem suporte redigitando uma chave a cada sessão é pior. O que
  // muda é a verdade do texto, que é a única coisa que essas pessoas têm.
  it("diz a verdade sobre onde a chave fica guardada e para onde ela vai", () => {
    render(<SettingsView />);
    const texto = secaoCuradoria().textContent ?? "";
    expect(texto).toContain("Ela fica guardada nas preferências do aplicativo");
    expect(texto).toContain("neste computador");
    expect(texto).toContain("não vai para o banco de músicas");
    expect(texto).toContain("não vai para nenhum outro lugar além do próprio Vagalume");
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
  it("todo texto da curadoria passa em AA — em TODOS os estados da seção", () => {
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
    ];
    for (const [nome, preparar] of estados) {
      estadoBase();
      preparar();
      const { unmount } = render(<SettingsView />);
      const medidos = varrerContraste(secaoCuradoria());
      expect(medidos, `estado ${nome} sem texto medido`).toBeGreaterThan(0);
      unmount();
    }
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
