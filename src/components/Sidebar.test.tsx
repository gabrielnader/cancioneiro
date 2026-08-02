import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";
import { setBackendForTests, type Backend } from "../lib/api";
import { useEnrichStore } from "../stores/enrichStore";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlaylistStore } from "../stores/playlistStore";
import { useUiStore } from "../stores/uiStore";
import type { Song } from "../lib/types";

function song(id: number, filePath: string): Song {
  return {
    id,
    file_path: filePath,
    folder_id: 1,
    title: `Faixa ${id}`,
    artist: null,
    album: null,
    duration_seconds: 3,
    has_lyrics: false,
    available: true,
  };
}

/** Clica na setinha (não no nome) para abrir/fechar uma pasta. */
function abrirPasta(nome: string) {
  fireEvent.click(screen.getByRole("button", { name: `Abrir pasta ${nome}` }));
}

describe("Sidebar — árvore de pastas (V4 F11)", () => {
  beforeEach(() => {
    setBackendForTests({
      listPlaylists: vi.fn(async () => []),
      getPlaylistItems: vi.fn(async () => []),
    } as unknown as Backend);
    useUiStore.setState({ view: "library", openFolders: [] });
    usePlaylistStore.setState({ playlists: [], activePlaylistId: null, items: [] });
    useLibraryStore.setState({
      folders: [{ id: 1, path: "/acervo", last_scanned_at: null }],
      allSongs: [
        song(1, "/acervo/1/a.mp3"),
        song(2, "/acervo/1/b.mp3"),
        song(3, "/acervo/2/c.mp3"),
      ],
      folderFilter: null,
    });
  });

  it("renderiza a raiz sob Biblioteca, com o contador da subárvore inteira", () => {
    render(<Sidebar />);
    const root = screen.getByRole("button", { name: "Pasta acervo" });
    expect(root).toHaveTextContent("acervo");
    expect(root).toHaveTextContent("3");
  });

  // V12 — a árvore nasce FECHADA (relato de campo, 8.000 músicas): abrir é a
  // setinha, e só ela.
  it("as subpastas nascem FECHADAS: só aparecem depois de abrir a raiz", () => {
    render(<Sidebar />);
    expect(screen.queryByRole("button", { name: "Pasta 1" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pasta 2" })).not.toBeInTheDocument();
    abrirPasta("acervo");
    const um = screen.getByRole("button", { name: "Pasta 1" });
    expect(um).toHaveTextContent("2");
    const dois = screen.getByRole("button", { name: "Pasta 2" });
    expect(dois).toHaveTextContent("1");
  });

  it("clicar numa SUBPASTA define o filtro, abre a Biblioteca e fecha a playlist", () => {
    useUiStore.setState({ view: "playlist" });
    usePlaylistStore.setState({ activePlaylistId: 7 });
    render(<Sidebar />);
    abrirPasta("acervo");
    fireEvent.click(screen.getByRole("button", { name: "Pasta 1" }));
    expect(useLibraryStore.getState().folderFilter).toBe("/acervo/1");
    expect(useUiStore.getState().view).toBe("library");
    expect(usePlaylistStore.getState().activePlaylistId).toBeNull();
  });

  it("clicar na pasta RAIZ não seta filtro — equivale a Biblioteca (V5 Q2)", () => {
    useUiStore.setState({ view: "playlist" });
    usePlaylistStore.setState({ activePlaylistId: 7 });
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: "Pasta acervo" }));
    expect(useLibraryStore.getState().folderFilter).toBeNull();
    expect(useUiStore.getState().view).toBe("library");
    expect(usePlaylistStore.getState().activePlaylistId).toBeNull();
  });

  it("clicar na pasta RAIZ com filtro de subpasta ativo LIMPA o filtro (V5 Q2)", () => {
    useLibraryStore.setState({ folderFilter: "/acervo/1" });
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: "Pasta acervo" }));
    expect(useLibraryStore.getState().folderFilter).toBeNull();
  });

  it("clicar em Biblioteca limpa o filtro de pasta", () => {
    useLibraryStore.setState({ folderFilter: "/acervo/1" });
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: "Biblioteca" }));
    expect(useLibraryStore.getState().folderFilter).toBeNull();
  });

  // V12 — sem clique nenhum: a pasta que CONTÉM a seleção abre sozinha.
  it("pasta ativa aparece destacada, e a raiz que a contém já vem aberta", () => {
    useLibraryStore.setState({ folderFilter: "/acervo/2" });
    render(<Sidebar />);
    const dois = screen.getByRole("button", { name: "Pasta 2" });
    expect(dois.className).toContain("text-brand");
  });

  it("sem músicas não renderiza subpastas (raiz sem seta, contador 0)", () => {
    useLibraryStore.setState({ allSongs: [] });
    render(<Sidebar />);
    expect(screen.getByRole("button", { name: "Pasta acervo" })).toHaveTextContent("0");
    expect(
      screen.queryByRole("button", { name: "Abrir pasta acervo" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pasta 1" })).not.toBeInTheDocument();
  });
});

/*
  V12 (relato de campo) — "as subpastas ficam todas abertas... talvez seja bom
  poder minimizar as pastas, mais parecido com a visão de pastas no
  computador". A árvore passa a abrir/fechar pela setinha, nasce fechada,
  persiste entre sessões e abre sozinha em cima da seleção atual.
*/
describe("Sidebar — árvore de pastas recolhível, como um explorador (V12)", () => {
  beforeEach(() => {
    setBackendForTests({
      listPlaylists: vi.fn(async () => []),
      getPlaylistItems: vi.fn(async () => []),
    } as unknown as Backend);
    useUiStore.setState({ view: "library", openFolders: [] });
    usePlaylistStore.setState({ playlists: [], activePlaylistId: null, items: [] });
    useLibraryStore.setState({
      folders: [{ id: 1, path: "/acervo", last_scanned_at: null }],
      allSongs: [
        song(1, "/acervo/1/x/a.mp3"),
        song(2, "/acervo/1/x/b.mp3"),
        song(3, "/acervo/1/y/c.mp3"),
        song(4, "/acervo/2/d.mp3"),
      ],
      folderFilter: null,
    });
  });

  it("pasta-folha (sem subpasta) não tem seta nenhuma", () => {
    render(<Sidebar />);
    abrirPasta("acervo");
    abrirPasta("1");
    expect(
      screen.queryByRole("button", { name: /Abrir pasta y|Fechar pasta y/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pasta y" })).toBeInTheDocument();
  });

  it("clicar na seta abre; clicar de novo fecha — e some com os filhos", () => {
    render(<Sidebar />);
    expect(screen.queryByRole("button", { name: "Pasta 1" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Abrir pasta acervo" }));
    expect(screen.getByRole("button", { name: "Pasta 1" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Fechar pasta acervo" }));
    expect(screen.queryByRole("button", { name: "Pasta 1" })).not.toBeInTheDocument();
  });

  it("a setinha não filtra: abrir a pasta não muda o filtro ativo", () => {
    render(<Sidebar />);
    abrirPasta("acervo");
    expect(useLibraryStore.getState().folderFilter).toBeNull();
  });

  it("clicar no NOME não abre/fecha: subpastas continuam escondidas depois do clique", () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: "Pasta acervo" }));
    expect(screen.queryByRole("button", { name: "Pasta 1" })).not.toBeInTheDocument();
  });

  it("indentação cresce por nível", () => {
    render(<Sidebar />);
    abrirPasta("acervo");
    abrirPasta("1");
    const raiz = screen.getByRole("button", { name: "Fechar pasta acervo" });
    const nivel1 = screen.getByRole("button", { name: "Fechar pasta 1" });
    const nivel2 = screen.getByRole("button", { name: "Pasta y" });
    const margemDe = (el: HTMLElement) => parseFloat(el.style.marginLeft || "0");
    expect(margemDe(nivel1)).toBeGreaterThan(margemDe(raiz));
    // "Pasta y" é o botão de nome (sem seta): o wrapper dele é quem carrega a
    // indentação da seta-fantasma do mesmo nível
    expect(margemDe(nivel1)).toBeLessThan(
      parseFloat(
        (nivel2.parentElement!.querySelector("span")?.style.marginLeft as string) || "0",
      ),
    );
  });

  it("o estado aberto/fechado PERSISTE entre sessões (mesmo storage das outras preferências)", () => {
    const { unmount } = render(<Sidebar />);
    abrirPasta("acervo");
    expect(screen.getByRole("button", { name: "Pasta 1" })).toBeInTheDocument();
    unmount();

    // simula reabrir o app: novo render lendo o MESMO uiStore (persistido)
    render(<Sidebar />);
    expect(screen.getByRole("button", { name: "Pasta 1" })).toBeInTheDocument();

    const salvo = JSON.parse(localStorage.getItem("cancioneiro-ui") ?? "{}");
    expect(salvo.state.openFolders).toContain("/acervo");
  });

  it("a pasta que contém a seleção atual abre sozinha, mesmo sem nunca ter sido aberta na mão", () => {
    useLibraryStore.setState({ folderFilter: "/acervo/1/x" });
    render(<Sidebar />);
    // acervo -> 1 -> x: as duas pastas ancestrais da seleção vêm abertas, e
    // "x" (a própria selecionada) aparece — sem isso a pessoa clica um filtro
    // fundo e perde de vista onde ele está na árvore
    expect(screen.getByRole("button", { name: "Pasta 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pasta x" })).toBeInTheDocument();
  });

  it("uma pasta IRMÃ da seleção não abre sozinha (só quem está no caminho até ela)", () => {
    useLibraryStore.setState({ folderFilter: "/acervo/2" });
    render(<Sidebar />);
    // "2" é irmã de "1": a seleção está em "2", então "1" não teria por que se
    // abrir — mas como "2" não tem subpastas, o teste conclusivo é sobre "1"
    expect(screen.queryByRole("button", { name: "Pasta x" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pasta y" })).not.toBeInTheDocument();
  });

  it("abrir sozinha por causa da seleção não é persistido (não fica aberta depois de trocar de filtro)", () => {
    useLibraryStore.setState({ folderFilter: "/acervo/1/x" });
    const { rerender } = render(<Sidebar />);
    expect(screen.getByRole("button", { name: "Pasta x" })).toBeInTheDocument();

    useLibraryStore.setState({ folderFilter: "/acervo/2" });
    rerender(<Sidebar />);
    expect(screen.queryByRole("button", { name: "Pasta x" })).not.toBeInTheDocument();
  });
});

/*
  V8/F18 — o ✎ saiu da árvore de pastas NO MESMO lançamento que trouxe a seção
  de curadoria em Configurações. A lateral é para NAVEGAR: um botão que dispara
  horas de processamento no meio da navegação diária é convite a clique
  acidental (o mesmo problema que tirou os chips de tema de perto do título).
*/
describe("Sidebar — a árvore de pastas voltou a ser só navegação (V8 F18)", () => {
  beforeEach(() => {
    setBackendForTests({
      listPlaylists: vi.fn(async () => []),
      getPlaylistItems: vi.fn(async () => []),
    } as unknown as Backend);
    useUiStore.setState({ view: "library", openFolders: [] });
    usePlaylistStore.setState({ playlists: [], activePlaylistId: null, items: [] });
    useLibraryStore.setState({
      folders: [{ id: 1, path: "/acervo", last_scanned_at: null }],
      allSongs: [song(1, "/acervo/1/a.mp3"), song(2, "/acervo/2/b.mp3")],
      folderFilter: null,
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
    });
  });

  it("nenhuma pasta da árvore tem mais o botão de completar dados", () => {
    useLibraryStore.setState({ folderFilter: "/acervo/1" });
    render(<Sidebar />);
    expect(screen.queryByRole("button", { name: /Completar dados/ })).toBeNull();
    expect(screen.queryByText("✎")).toBeNull();
  });

  it("a árvore continua navegando normalmente: um botão por pasta, e só", () => {
    render(<Sidebar />);
    abrirPasta("acervo");
    const pastas = screen
      .getAllByRole("button")
      .filter((b) => b.getAttribute("aria-label")?.startsWith("Pasta "));
    expect(pastas.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Pasta acervo",
      "Pasta 1",
      "Pasta 2",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Pasta 1" }));
    expect(useLibraryStore.getState().folderFilter).toBe("/acervo/1");
  });

  // Ordem obrigatória do PRD: a varredura em lote não pode sumir do produto.
  it("a varredura em lote continua alcançável: Configurações está na lateral", () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: "Configurações" }));
    expect(useUiStore.getState().view).toBe("settings");
  });
});

describe("Sidebar — indicador de varredura em segundo plano (V5 F13)", () => {
  beforeEach(() => {
    setBackendForTests({
      listPlaylists: vi.fn(async () => []),
      getPlaylistItems: vi.fn(async () => []),
    } as unknown as Backend);
    useUiStore.setState({ view: "library" });
    usePlaylistStore.setState({ playlists: [], activePlaylistId: null, items: [] });
    useLibraryStore.setState({
      folders: [{ id: 1, path: "/acervo", last_scanned_at: null }],
      allSongs: [song(1, "/acervo/1/a.mp3")],
      folderFilter: null,
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
    });
  });

  it("não aparece quando o overlay está aberto (o overlay já mostra o progresso)", () => {
    useEnrichStore.setState({
      status: "scanning",
      overlayOpen: true,
      progress: {
        done: 2,
        total: 9,
        atual: "a.mp3",
        etapa: "procurando no LRCLIB",
        scan_id: "s1",
      },
    });
    render(<Sidebar />);
    expect(
      screen.queryByRole("button", { name: /Buscando dados/ }),
    ).not.toBeInTheDocument();
  });

  // V8/F18 — "progresso com contagem e barra, a etapa atual do funil e o
  // arquivo do momento". Na lateral cabem a contagem e a etapa; o arquivo,
  // que muda a cada segundo, fica no overlay.
  it("varrendo em segundo plano: contagem E etapa, e reabre o overlay no clique", () => {
    useEnrichStore.setState({
      status: "scanning",
      overlayOpen: false,
      progress: {
        done: 2,
        total: 9,
        atual: "a.mp3",
        etapa: "procurando no LRCLIB",
        scan_id: "s1",
      },
    });
    render(<Sidebar />);
    const indicador = screen.getByRole("button", {
      name: "Buscando dados… 2 de 9 — procurando no LRCLIB",
    });
    expect(indicador).toHaveTextContent("2 de 9");
    expect(indicador).toHaveTextContent("procurando no LRCLIB");
    fireEvent.click(indicador);
    expect(useEnrichStore.getState().overlayOpen).toBe(true);
  });

  it("backend sem etapa: o indicador continua com a contagem, sem sobra de texto", () => {
    useEnrichStore.setState({
      status: "scanning",
      overlayOpen: false,
      progress: { done: 2, total: 9, atual: "a.mp3", etapa: "", scan_id: "s1" },
    });
    render(<Sidebar />);
    expect(
      screen.getByRole("button", { name: "Buscando dados… 2 de 9" }),
    ).toBeInTheDocument();
  });

  it("sem progresso ainda: indicador sem contagem", () => {
    useEnrichStore.setState({ status: "scanning", overlayOpen: false });
    render(<Sidebar />);
    expect(
      screen.getByRole("button", { name: "Buscando dados…" }),
    ).toBeInTheDocument();
  });

  it("varredura terminada em segundo plano: botão 'Revisar N propostas' reabre a revisão", () => {
    useEnrichStore.setState({
      status: "review",
      overlayOpen: false,
      proposals: [
        { song_id: 1 } as never,
        { song_id: 2 } as never,
        { song_id: 3 } as never,
      ],
    });
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: "Revisar 3 propostas" }));
    expect(useEnrichStore.getState().overlayOpen).toBe(true);
  });

  it("uma proposta só: singular", () => {
    useEnrichStore.setState({
      status: "review",
      overlayOpen: false,
      proposals: [{ song_id: 1 } as never],
    });
    render(<Sidebar />);
    expect(
      screen.getByRole("button", { name: "Revisar 1 proposta" }),
    ).toBeInTheDocument();
  });

  it("idle: nenhum indicador", () => {
    render(<Sidebar />);
    expect(
      screen.queryByRole("button", { name: /Buscando dados|Revisar/ }),
    ).not.toBeInTheDocument();
  });
});
