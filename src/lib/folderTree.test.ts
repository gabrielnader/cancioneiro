import { describe, expect, it } from "vitest";
import { buildFolderTree, filterResultsByFolder, isUnderFolder } from "./folderTree";
import type { Folder, SearchResult, Song } from "./types";

function song(id: number, filePath: string, folderId = 1): Song {
  return {
    id,
    file_path: filePath,
    folder_id: folderId,
    title: `Música ${id}`,
    artist: null,
    album: null,
    duration_seconds: 3,
    has_lyrics: false,
    available: true,
  };
}

function folder(id: number, path: string): Folder {
  return { id, path, last_scanned_at: null };
}

describe("isUnderFolder", () => {
  it("é true para arquivo dentro da pasta (separador /)", () => {
    expect(isUnderFolder("/acervo/1/a.mp3", "/acervo/1")).toBe(true);
    expect(isUnderFolder("/acervo/1/sub/b.mp3", "/acervo/1")).toBe(true);
  });

  it("não confunde pastas cujo nome é prefixo uma da outra ('1' vs '10')", () => {
    expect(isUnderFolder("/acervo/10/a.mp3", "/acervo/1")).toBe(false);
    expect(isUnderFolder("/acervo/1/a.mp3", "/acervo/10")).toBe(false);
    expect(isUnderFolder("/acervo/10/a.mp3", "/acervo/10")).toBe(true);
  });

  it("é false para o próprio caminho da pasta e para caminhos fora dela", () => {
    expect(isUnderFolder("/acervo/1", "/acervo/1")).toBe(false);
    expect(isUnderFolder("/outra/a.mp3", "/acervo")).toBe(false);
  });

  it("aceita separador Windows (\\\\)", () => {
    expect(isUnderFolder("C:\\musicas\\1\\a.mp3", "C:\\musicas\\1")).toBe(true);
    expect(isUnderFolder("C:\\musicas\\10\\a.mp3", "C:\\musicas\\1")).toBe(false);
  });
});

describe("buildFolderTree", () => {
  it("cria uma raiz por pasta registrada com o nome da última parte do path", () => {
    const tree = buildFolderTree(
      [song(1, "/acervo/a.mp3")],
      [folder(1, "/acervo")],
    );
    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe("acervo");
    expect(tree[0].path).toBe("/acervo");
    expect(tree[0].count).toBe(1);
    expect(tree[0].children).toEqual([]);
  });

  it("deriva subpastas 1/ e 2/ dos file_path, com contadores por subárvore", () => {
    const songs = [
      song(1, "/acervo/1/a.mp3"),
      song(2, "/acervo/1/b.mp3"),
      song(3, "/acervo/2/c.mp3"),
      song(4, "/acervo/raiz.mp3"),
    ];
    const tree = buildFolderTree(songs, [folder(1, "/acervo")]);
    expect(tree).toHaveLength(1);
    const root = tree[0];
    // contador da raiz inclui toda a subárvore
    expect(root.count).toBe(4);
    expect(root.children.map((c) => c.name)).toEqual(["1", "2"]);
    const um = root.children[0];
    expect(um.path).toBe("/acervo/1");
    expect(um.count).toBe(2);
    const dois = root.children[1];
    expect(dois.path).toBe("/acervo/2");
    expect(dois.count).toBe(1);
  });

  it("aninha subpastas em profundidade e conta a subárvore inteira", () => {
    const songs = [
      song(1, "/acervo/1/x/a.mp3"),
      song(2, "/acervo/1/x/b.mp3"),
      song(3, "/acervo/1/c.mp3"),
    ];
    const tree = buildFolderTree(songs, [folder(1, "/acervo")]);
    const um = tree[0].children[0];
    expect(um.name).toBe("1");
    expect(um.count).toBe(3);
    expect(um.children).toHaveLength(1);
    expect(um.children[0].name).toBe("x");
    expect(um.children[0].path).toBe("/acervo/1/x");
    expect(um.children[0].count).toBe(2);
  });

  it("pastas sem MP3 não aparecem (só subpastas derivadas de músicas)", () => {
    const tree = buildFolderTree(
      [song(1, "/acervo/1/a.mp3")],
      [folder(1, "/acervo")],
    );
    expect(tree[0].children.map((c) => c.name)).toEqual(["1"]);
  });

  it("músicas fora de qualquer pasta registrada não entram na árvore", () => {
    const tree = buildFolderTree(
      [song(1, "/fora/a.mp3"), song(2, "/acervo/b.mp3")],
      [folder(1, "/acervo")],
    );
    expect(tree[0].count).toBe(1);
  });

  it("múltiplas pastas registradas geram múltiplas raízes", () => {
    const tree = buildFolderTree(
      [song(1, "/a/x.mp3"), song(2, "/b/y.mp3")],
      [folder(1, "/a"), folder(2, "/b")],
    );
    expect(tree.map((n) => n.name)).toEqual(["a", "b"]);
    expect(tree.map((n) => n.count)).toEqual([1, 1]);
  });

  it("pasta registrada sem nenhuma música vira raiz com count 0", () => {
    const tree = buildFolderTree([], [folder(1, "/musicas/vazia")]);
    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe("vazia");
    expect(tree[0].count).toBe(0);
  });

  it("não confunde '1' com '10' ao derivar subpastas", () => {
    const songs = [song(1, "/m/1/a.mp3"), song(2, "/m/10/b.mp3")];
    const tree = buildFolderTree(songs, [folder(1, "/m")]);
    const names = tree[0].children.map((c) => c.name);
    expect(names).toContain("1");
    expect(names).toContain("10");
    const um = tree[0].children.find((c) => c.name === "1")!;
    expect(um.count).toBe(1);
  });
});

describe("filterResultsByFolder", () => {
  const results: SearchResult[] = [
    { song: song(1, "/acervo/1/a.mp3"), snippet: null },
    { song: song(2, "/acervo/10/b.mp3"), snippet: null },
    { song: song(3, "/acervo/2/c.mp3"), snippet: null },
  ];

  it("sem filtro (null) devolve a lista original", () => {
    expect(filterResultsByFolder(results, null)).toBe(results);
  });

  it("com filtro devolve só as músicas da subárvore (prefixo exato de pasta)", () => {
    const filtered = filterResultsByFolder(results, "/acervo/1");
    expect(filtered.map((r) => r.song.id)).toEqual([1]);
  });
});
