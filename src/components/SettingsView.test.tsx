import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setBackendForTests, type Backend } from "../lib/api";
import {
  AA_TEXTO_NORMAL,
  contrastRatio,
  corDoTexto,
} from "../test/contrast";
import { estimativaTexto, VAGALUME_URL } from "../lib/curadoria";
import type { Song } from "../lib/types";
import { useEnrichStore } from "../stores/enrichStore";
import { useLibraryStore } from "../stores/libraryStore";
import { useUiStore } from "../stores/uiStore";
import { SettingsView } from "./SettingsView";

/** Fundo da tela de Configurações — todo texto novo é lido em cima dele. */
const FUNDO_CONFIGURACOES = "#F9FAFB";

function song(id: number, filePath: string, over: Partial<Song> = {}): Song {
  return {
    id,
    file_path: filePath,
    folder_id: 1,
    title: `Faixa ${id}`,
    artist: "Artista",
    album: null,
    duration_seconds: 100,
    has_lyrics: true,
    available: true,
    ...over,
  };
}

function estadoBase() {
  setBackendForTests({
    onScanProgress: vi.fn(async () => () => {}),
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

  it("a estimativa acompanha a pasta escolhida", () => {
    render(<SettingsView />);
    // biblioteca inteira: duas incompletas
    expect(screen.getByText(estimativaTexto(2))).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Pasta a curar"), {
      target: { value: "/acervo/1" },
    });
    expect(screen.getByText(estimativaTexto(1))).toBeInTheDocument();
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

  it("pasta sem nenhuma música incompleta: não deixa disparar e diz por quê", () => {
    useLibraryStore.setState({
      allSongs: [song(1, "/acervo/1/completa.mp3")],
    });
    render(<SettingsView />);
    const botao = screen.getByRole("button", { name: "Buscar dados desta pasta" });
    expect(botao).toBeDisabled();
    expect(screen.getByText(estimativaTexto(0))).toBeInTheDocument();
  });

  it("uma varredura já rodando bloqueia o disparo, com o motivo na dica", () => {
    useEnrichStore.setState({ status: "scanning" });
    render(<SettingsView />);
    const botao = screen.getByRole("button", { name: "Buscar dados desta pasta" });
    expect(botao).toBeDisabled();
    expect(botao).toHaveAttribute(
      "title",
      "Uma busca de dados já está em andamento",
    );
  });

  // M4: depois do "Cancelar" o invoke ainda responde por alguns segundos.
  it("varredura cancelada e ainda respondendo: segue bloqueado, com o porquê", () => {
    useEnrichStore.setState({ status: "idle", scanInFlight: true });
    render(<SettingsView />);
    expect(
      screen.getByRole("button", { name: "Buscar dados desta pasta" }),
    ).toHaveAttribute(
      "title",
      "Terminando de encerrar a busca anterior — aguarde alguns segundos",
    );
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

  it("todo texto da curadoria passa em AA (4,5:1) no fundo de Configurações", () => {
    render(<SettingsView />);
    const secao = secaoCuradoria();
    // varre TODOS os elementos da seção, não uma lista que o autor lembrou
    // (DECISIONS #76): texto novo entra passando ou não entra.
    const comCor = [...secao.querySelectorAll<HTMLElement>("*")].filter((el) =>
      /text-\[#[0-9a-fA-F]{6}\]/.test(el.className),
    );
    expect(comCor.length).toBeGreaterThan(0);
    for (const el of comCor) {
      const classe = el.className;
      const razao = contrastRatio(corDoTexto(classe), FUNDO_CONFIGURACOES);
      expect(
        razao,
        `"${el.textContent?.slice(0, 40)}" em ${corDoTexto(classe)}`,
      ).toBeGreaterThanOrEqual(AA_TEXTO_NORMAL);
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
