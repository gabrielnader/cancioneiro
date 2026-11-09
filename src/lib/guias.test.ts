import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GRUPOS_DE_PERGUNTAS, GUIAS, PERGUNTAS, useGuiaStore } from "./guias";
import { posicaoDoBalao } from "../components/Guia";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlaylistStore } from "../stores/playlistStore";
import { useUiStore } from "../stores/uiStore";

const PASTA = { id: 1, path: "/m", missing: false } as never;

describe("Como faço? — os guias (V16.7)", () => {
  beforeEach(() => {
    useLibraryStore.setState({ folders: [PASTA], selectedSongId: null, query: "" });
    usePlaylistStore.setState({ playlists: [] });
    useUiStore.setState({ view: "library", zoomLevel: 0 });
  });
  afterEach(() => useGuiaStore.getState().parar());

  it("as perguntas do jeito que a pessoa pensa, em quatro grupos", () => {
    expect(GRUPOS_DE_PERGUNTAS.map((g) => g.titulo)).toEqual([
      "Ouvir",
      "Listas de músicas",
      "Nome, cantor e letra",
      "Pastas e o app",
    ]);
    const todas = PERGUNTAS.map((id) => GUIAS[id].pergunta);
    for (const p of [
      "Como eu acho uma música?",
      "Como eu toco uma música?",
      "Como eu vejo a letra de uma música?",
      "Como eu deixo a letra maior?",
      "Como eu crio uma lista de músicas?",
      "Como eu ponho uma música numa lista?",
      "Como eu mudo a ordem das músicas numa lista?",
      "Como eu escrevo uma anotação?",
      "Como eu corrijo o nome ou a letra de uma música?",
      "Como eu completo nome, cantor e letra das músicas?",
      "Como eu escrevo as letras ouvindo a música?",
      "Como eu confiro as sugestões?",
      "Como eu marco uma música como instrumental (sem letra)?",
      "Como eu acho as músicas de um tema?",
      "Como eu ponho outra pasta de músicas no app?",
      "Copiei músicas novas para a pasta. Como elas aparecem?",
      "Uma música diz que “não aceita gravação”. E agora?",
      "Como eu atualizo o app?",
      "Como eu deixo a tela clara ou escura?",
    ]) {
      expect(todas).toContain(p);
    }
    expect(new Set(PERGUNTAS).size).toBe(PERGUNTAS.length);
    // nenhum texto usa a palavra "ajuda" (pedido do dono do produto)
    for (const id of Object.keys(GUIAS) as (keyof typeof GUIAS)[]) {
      const g = GUIAS[id];
      for (const t of [g.pergunta, g.fim, ...g.passos.map((p) => p.texto)]) expect(t).not.toMatch(/ajuda/i);
    }
  });

  it("mudar a ordem sem nenhuma lista manda criar uma primeiro", () => {
    useGuiaStore.getState().iniciar("mudar-ordem");
    expect(useGuiaStore.getState().impedimento).toMatch(/crie uma/);
  });

  it("sem músicas, o guia diz o que fazer antes em vez de apontar o vazio", () => {
    useLibraryStore.setState({ folders: [] });
    useGuiaStore.getState().iniciar("tocar");
    expect(useGuiaStore.getState().estado).toBe("impedido");
    expect(useGuiaStore.getState().impedimento).toMatch(/adicione a pasta/);
  });

  it("pôr numa lista sem nenhuma lista manda criar uma primeiro", () => {
    useGuiaStore.getState().iniciar("por-na-lista");
    expect(useGuiaStore.getState().impedimento).toMatch(/crie uma/);
  });

  it("a condição avança: a lista criada passa do passo do nome", () => {
    useGuiaStore.getState().iniciar("criar-lista");
    const g = GUIAS["criar-lista"];
    const { inicio } = useGuiaStore.getState();
    const passoDoNome = g.passos.find((p) => p.alvo === "dialogo-nova-lista")!;
    expect(passoDoNome.quando!(inicio)).toBe(false);
    usePlaylistStore.setState({ playlists: [{ id: 1, name: "Sábado", song_count: 0 }] });
    expect(passoDoNome.quando!(inicio)).toBe(true);
  });

  it("começa em Configurações: o guia de tocar volta para a lista de músicas", () => {
    useUiStore.setState({ view: "settings" });
    useGuiaStore.getState().iniciar("tocar");
    expect(useUiStore.getState().view).toBe("library");
  });

  it("pula o passo que não é preciso e chega ao fim", () => {
    useLibraryStore.setState({ selectedSongId: 3 });
    useGuiaStore.getState().iniciar("anotacao");
    // a música já está escolhida: começa depois do "clique no nome"
    expect(GUIAS.anotacao.passos[useGuiaStore.getState().passo].alvo).not.toBe("linha");
    for (let i = 0; i < 5; i++) useGuiaStore.getState().avancar();
    expect(useGuiaStore.getState().estado).toBe("fim");
  });

  it("os primeiros passos sem pasta vão direto ao “Como faço?”", () => {
    useLibraryStore.setState({ folders: [] });
    useGuiaStore.getState().iniciar("primeiros-passos");
    const { passo, estado } = useGuiaStore.getState();
    expect(estado).toBe("andando");
    expect(GUIAS["primeiros-passos"].passos[passo].alvo).toBe("como-faco");
  });

  it("o balão fica embaixo do alvo, em cima quando não cabe, e dentro da tela", () => {
    const tela = { largura: 1280, altura: 800 };
    expect(posicaoDoBalao({ top: 100, left: 100, width: 200, height: 50 }, tela).top).toBe(166);
    expect(posicaoDoBalao({ top: 700, left: 100, width: 200, height: 60 }, tela).top).toBe(700 - 16 - 220);
    const estreita = posicaoDoBalao({ top: 100, left: 0, width: 50, height: 40 }, { largura: 390, altura: 800 });
    expect(estreita.left).toBeGreaterThanOrEqual(16);
  });
});

describe("Como faço? — de dentro de uma lista (V16.7)", () => {
  it("o guia volta para todas as músicas, onde está o que ele aponta", () => {
    useLibraryStore.setState({ folders: [{ id: 1, path: "/m", missing: false } as never] });
    usePlaylistStore.setState({ playlists: [{ id: 1, name: "Sábado", song_count: 0 }] });
    useUiStore.setState({ view: "playlist" });
    useGuiaStore.getState().iniciar("por-na-lista");
    expect(useUiStore.getState().view).toBe("library");
    useGuiaStore.getState().parar();
  });
});

describe("Como faço? — o que a tela não tem agora (V16.10)", () => {
  it("todo guia de Organizar começa indo para lá, e só pula esse passo quando já está lá", () => {
    useLibraryStore.setState({ folders: [{ id: 1, path: "/m", missing: false } as never] });
    useUiStore.setState({ view: "library" });
    for (const id of ["completar", "escrever-letras", "adicionar-pasta", "musicas-novas", "atualizar", "tela-escura"] as const) {
      useGuiaStore.getState().iniciar(id);
      expect(GUIAS[id].passos[useGuiaStore.getState().passo].alvo).toBe("organizar");
      useGuiaStore.getState().parar();
    }
    useUiStore.setState({ view: "settings" });
    useGuiaStore.getState().iniciar("completar");
    expect(GUIAS.completar.passos[useGuiaStore.getState().passo].alvo).toBe("pasta-e-tempo");
    useGuiaStore.getState().parar();
  });

  it("o passo cujo lugar pode não existir tem a frase do que fazer", () => {
    const conferir = GUIAS.conferir.passos.find((p) => p.alvo === "conferir")!;
    expect(conferir.semAlvo).toMatch(/não há nada esperando/);
    expect(GUIAS["consertar-arquivo"].passos[GUIAS["consertar-arquivo"].passos.length - 1].semAlvo).toMatch(/nenhum arquivo precisa/);
  });

  it("o guia de completar não promete o que o app não faz", () => {
    // o vazio É preenchido sem conferência; só a troca espera a pessoa
    const textos = [GUIAS.completar.fim, ...GUIAS.completar.passos.map((p) => p.texto)].join(" ");
    expect(textos).toMatch(/vazio é preenchido sozinho/);
    expect(textos).not.toMatch(/Nada é gravado sem você/);
  });
});
