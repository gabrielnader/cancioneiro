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

  it("as perguntas do jeito que a pessoa pensa, em três grupos", () => {
    expect(GRUPOS_DE_PERGUNTAS.map((g) => g.titulo)).toEqual(["Ouvir", "Listas de músicas", "Organizar"]);
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
      "Como eu completo as letras que faltam?",
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
