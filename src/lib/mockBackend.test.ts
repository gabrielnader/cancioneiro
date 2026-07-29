import { beforeEach, describe, expect, it } from "vitest";
import type { EnrichApply, EnrichProgress, EnrichProposal } from "./api";
import { createMockBackend, installMockBackend, type MockBackend } from "./mockBackend";
import { HIGHLIGHT_END, HIGHLIGHT_START } from "./highlight";
import type { Modo, ScanProgress, Song } from "./types";

/**
 * Payload de apply montado a partir da Song atual: current_title/current_artist
 * são o que a varredura viu (A5 — o backend recusa proposta velha).
 */
function aplicar(
  song: Song,
  campos: {
    title?: string;
    artist?: string | null;
    lyrics?: string | null;
    add_temas?: string | null;
    fonte?: string | null;
    substituir_letra?: boolean;
  },
): EnrichApply {
  return {
    song_id: song.id,
    title: campos.title ?? song.title,
    artist: campos.artist ?? null,
    lyrics: campos.lyrics ?? null,
    add_temas: campos.add_temas ?? null,
    current_title: song.title,
    current_artist: song.artist,
    fonte: campos.fonte ?? null,
    substituir_letra: campos.substituir_letra,
  };
}

const FIXTURE_LYRICS =
  "Quando o sol amanhecer\nMeu coração vai cantar\nA esperança vai nascer\nE a alegria vai chegar\n\nNão há noite sem estrela\nNão há dor que não se cura";

/**
 * As PROPOSTAS de uma varredura em lote.
 *
 * Desde o QA A2 o backend devolve um objeto (`{ propostas,
 * sem_perguntar_ao_som }`), e não a lista: só assim existe onde dizer que a
 * etapa do som se desligou no meio. Os testes que só olham as propostas
 * passam por aqui; os que olham a conta chamam `enrichFolderScan` direto.
 */
async function varrer(
  backend: MockBackend,
  folderPrefix: string,
  scanId: string,
  vagalumeKey: string | null = null,
  modo?: Modo,
): Promise<EnrichProposal[]> {
  return (await backend.enrichFolderScan(folderPrefix, scanId, vagalumeKey, modo))
    .propostas;
}

describe("mockBackend", () => {
  let backend: MockBackend;

  beforeEach(() => {
    localStorage.clear();
    backend = createMockBackend();
  });

  describe("addFolder", () => {
    it("cria 3 músicas fixture-like na pasta dada com file_paths corretos", async () => {
      const result = await backend.addFolder("/musicas/teste");
      expect(result.indexed).toBe(3);
      expect(result.total).toBe(3);

      const songs = await backend.listSongs();
      expect(songs).toHaveLength(3);

      const paths = songs.map((s) => s.file_path).sort();
      expect(paths).toEqual([
        "/musicas/teste/com_letra.mp3",
        "/musicas/teste/sem_letra.mp3",
        "/musicas/teste/sem_tags.mp3",
      ]);

      const comLetra = songs.find((s) => s.file_path.endsWith("com_letra.mp3"))!;
      expect(comLetra.title).toBe("Coração Sertanejo");
      expect(comLetra.artist).toBe("Artista Teste");
      expect(comLetra.has_lyrics).toBe(true);
      expect(comLetra.duration_seconds).toBe(3);
      expect(comLetra.available).toBe(true);

      const semLetra = songs.find((s) => s.file_path.endsWith("sem_letra.mp3"))!;
      expect(semLetra.title).toBe("Instrumental Sem Letra");
      expect(semLetra.artist).toBe("Banda Fixture");
      expect(semLetra.has_lyrics).toBe(false);
      expect(semLetra.duration_seconds).toBe(2);

      const semTags = songs.find((s) => s.file_path.endsWith("sem_tags.mp3"))!;
      expect(semTags.title).toBe("sem_tags");
      expect(semTags.artist).toBeNull();
      expect(semTags.has_lyrics).toBe(false);
    });

    it("guarda a letra EXATA da fixture com_letra (acentos e quebras de linha)", async () => {
      await backend.addFolder("/musicas/teste");
      const songs = await backend.listSongs();
      const comLetra = songs.find((s) => s.title === "Coração Sertanejo")!;
      const lyrics = await backend.getLyrics(comLetra.id);
      expect(lyrics).toBe(FIXTURE_LYRICS);
    });

    it("registra a pasta em listFolders", async () => {
      await backend.addFolder("/musicas/teste");
      const folders = await backend.listFolders();
      expect(folders).toHaveLength(1);
      expect(folders[0].path).toBe("/musicas/teste");
    });

    it("não duplica músicas ao adicionar a mesma pasta duas vezes", async () => {
      await backend.addFolder("/musicas/teste");
      const second = await backend.addFolder("/musicas/teste");
      expect(second.indexed).toBe(0);
      expect(second.total).toBe(3);

      const songs = await backend.listSongs();
      expect(songs).toHaveLength(3);
      const folders = await backend.listFolders();
      expect(folders).toHaveLength(1);
    });

    it("pasta com 'vazia' no path retorna total=0 e não cria músicas, mas registra a pasta", async () => {
      const result = await backend.addFolder("/musicas/vazia");
      expect(result.total).toBe(0);
      expect(result.indexed).toBe(0);
      expect(await backend.listSongs()).toHaveLength(0);
      const folders = await backend.listFolders();
      expect(folders.map((f) => f.path)).toContain("/musicas/vazia");
    });

    it("IDs são autoincrementais e estáveis entre pastas distintas", async () => {
      await backend.addFolder("/a");
      await backend.addFolder("/b");
      const songs = await backend.listSongs();
      const ids = songs.map((s) => s.id);
      expect(new Set(ids).size).toBe(6);
      expect(Math.max(...ids)).toBeGreaterThan(Math.min(...ids));
    });
  });

  describe("removeFolder (cascade)", () => {
    it("remove as músicas da pasta e os playlist_items dessas músicas", async () => {
      await backend.addFolder("/musicas/teste");
      const songs = await backend.listSongs();
      const playlistId = await backend.createPlaylist("Minha Playlist");
      await backend.addToPlaylist(playlistId, songs[0].id);
      await backend.addToPlaylist(playlistId, songs[1].id);

      const folders = await backend.listFolders();
      await backend.removeFolder(folders[0].id);

      expect(await backend.listSongs()).toHaveLength(0);
      expect(await backend.listFolders()).toHaveLength(0);
      expect(await backend.getPlaylistItems(playlistId)).toHaveLength(0);
      // a playlist em si continua existindo
      const playlists = await backend.listPlaylists();
      expect(playlists).toHaveLength(1);
      expect(playlists[0].song_count).toBe(0);
    });

    it("não afeta músicas de outras pastas", async () => {
      await backend.addFolder("/a");
      await backend.addFolder("/b");
      const folders = await backend.listFolders();
      const folderA = folders.find((f) => f.path === "/a")!;
      await backend.removeFolder(folderA.id);
      const songs = await backend.listSongs();
      expect(songs).toHaveLength(3);
      expect(songs.every((s) => s.file_path.startsWith("/b/"))).toBe(true);
    });
  });

  describe("search", () => {
    beforeEach(async () => {
      await backend.addFolder("/musicas/teste");
    });

    it("ignora diacríticos: 'coracao' encontra 'Coração Sertanejo'", async () => {
      const results = await backend.search("coracao");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].song.title).toBe("Coração Sertanejo");
    });

    it("último token funciona como prefixo: 'amanh' encontra 'amanhecer' na letra", async () => {
      const results = await backend.search("amanh");
      expect(results).toHaveLength(1);
      expect(results[0].song.title).toBe("Coração Sertanejo");
    });

    it("query só com caracteres especiais não lança erro e retorna todas em ordem alfabética", async () => {
      const results = await backend.search('"*-!');
      expect(results).toHaveLength(3);
      const titles = results.map((r) => r.song.title);
      expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b)));
      expect(results.every((r) => r.snippet === null)).toBe(true);
    });

    it("query vazia retorna todas as músicas em ordem alfabética por título, snippet null", async () => {
      const results = await backend.search("");
      expect(results).toHaveLength(3);
      const titles = results.map((r) => r.song.title);
      expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b)));
      expect(results.every((r) => r.snippet === null)).toBe(true);
    });

    it("match na letra gera snippet com marcadores de destaque em torno do termo", async () => {
      const results = await backend.search("esperança");
      expect(results).toHaveLength(1);
      const snippet = results[0].snippet;
      expect(snippet).not.toBeNull();
      expect(snippet).toContain(`${HIGHLIGHT_START}esperança${HIGHLIGHT_END}`);
    });

    it("match apenas em título/artista tem snippet null", async () => {
      const results = await backend.search("sertanejo");
      expect(results).toHaveLength(1);
      expect(results[0].song.title).toBe("Coração Sertanejo");
      expect(results[0].snippet).toBeNull();
    });

    it("match apenas no artista funciona ('fixture' → Banda Fixture)", async () => {
      const results = await backend.search("fixture");
      expect(results).toHaveLength(1);
      expect(results[0].song.title).toBe("Instrumental Sem Letra");
      expect(results[0].snippet).toBeNull();
    });

    it("todos os tokens precisam estar presentes (AND)", async () => {
      const results = await backend.search("coração inexistentexyz");
      expect(results).toHaveLength(0);
    });

    it("matches em título vêm antes de matches só na letra", async () => {
      // "sem" está no título de "Instrumental Sem Letra" e "sem_tags",
      // e na letra de "Coração Sertanejo" ("sem estrela")
      const results = await backend.search("sem");
      expect(results).toHaveLength(3);
      const first2 = results.slice(0, 2).map((r) => r.song.title).sort();
      expect(first2).toEqual(["Instrumental Sem Letra", "sem_tags"]);
      expect(results[2].song.title).toBe("Coração Sertanejo");
    });

    // V8 — o nome do arquivo também é buscável (as coordenadoras se organizam
    // por ele há anos): "com_letra" só existe no NOME de com_letra.mp3, cujas
    // tags dizem "Coração Sertanejo" / "Artista Teste".
    it("encontra pelo nome do arquivo, sem snippet de letra", async () => {
      const results = await backend.search("com_letra");
      expect(results).toHaveLength(1);
      expect(results[0].song.title).toBe("Coração Sertanejo");
      expect(results[0].song.file_path).toContain("com_letra.mp3");
      expect(results[0].snippet).toBeNull();
    });

    it("a extensão não é buscável: 'mp3' não devolve o acervo inteiro", async () => {
      const results = await backend.search("mp3");
      expect(results).toHaveLength(0);
    });

    it("não retorna músicas sem match", async () => {
      const results = await backend.search("estrela");
      expect(results).toHaveLength(1);
      expect(results[0].song.title).toBe("Coração Sertanejo");
    });
  });

  describe("getLyrics", () => {
    it("retorna null para música sem letra", async () => {
      await backend.addFolder("/musicas/teste");
      const songs = await backend.listSongs();
      const semLetra = songs.find((s) => s.title === "Instrumental Sem Letra")!;
      expect(await backend.getLyrics(semLetra.id)).toBeNull();
    });

    it("rejeita para id inexistente", async () => {
      await expect(backend.getLyrics(99999)).rejects.toThrow();
    });
  });

  describe("playlists", () => {
    it("createPlaylist retorna id e listPlaylists reflete o nome", async () => {
      const id = await backend.createPlaylist("Sertanejas");
      const playlists = await backend.listPlaylists();
      expect(playlists).toHaveLength(1);
      expect(playlists[0].id).toBe(id);
      expect(playlists[0].name).toBe("Sertanejas");
      expect(playlists[0].song_count).toBe(0);
    });

    it("createPlaylist com nome vazio ou só whitespace rejeita", async () => {
      await expect(backend.createPlaylist("")).rejects.toThrow();
      await expect(backend.createPlaylist("   ")).rejects.toThrow();
    });

    it("addToPlaylist adiciona no fim com positions 0-based", async () => {
      await backend.addFolder("/musicas/teste");
      const songs = await backend.listSongs();
      const id = await backend.createPlaylist("P");
      await backend.addToPlaylist(id, songs[0].id);
      await backend.addToPlaylist(id, songs[1].id);
      await backend.addToPlaylist(id, songs[2].id);

      const items = await backend.getPlaylistItems(id);
      expect(items.map((i) => i.position)).toEqual([0, 1, 2]);
      expect(items.map((i) => i.song.id)).toEqual([songs[0].id, songs[1].id, songs[2].id]);

      const playlists = await backend.listPlaylists();
      expect(playlists[0].song_count).toBe(3);
    });

    it("removePlaylistItem renumera positions", async () => {
      await backend.addFolder("/musicas/teste");
      const songs = await backend.listSongs();
      const id = await backend.createPlaylist("P");
      await backend.addToPlaylist(id, songs[0].id);
      await backend.addToPlaylist(id, songs[1].id);
      await backend.addToPlaylist(id, songs[2].id);

      const before = await backend.getPlaylistItems(id);
      await backend.removePlaylistItem(before[1].id);

      const after = await backend.getPlaylistItems(id);
      expect(after).toHaveLength(2);
      expect(after.map((i) => i.position)).toEqual([0, 1]);
      expect(after.map((i) => i.song.id)).toEqual([songs[0].id, songs[2].id]);
    });

    it("reorderPlaylist aplica a nova ordem de itemIds", async () => {
      await backend.addFolder("/musicas/teste");
      const songs = await backend.listSongs();
      const id = await backend.createPlaylist("P");
      await backend.addToPlaylist(id, songs[0].id);
      await backend.addToPlaylist(id, songs[1].id);
      await backend.addToPlaylist(id, songs[2].id);

      const items = await backend.getPlaylistItems(id);
      const newOrder = [items[2].id, items[0].id, items[1].id];
      await backend.reorderPlaylist(id, newOrder);

      const after = await backend.getPlaylistItems(id);
      expect(after.map((i) => i.id)).toEqual(newOrder);
      expect(after.map((i) => i.position)).toEqual([0, 1, 2]);
    });

    it("deletePlaylist remove a playlist e seus itens", async () => {
      await backend.addFolder("/musicas/teste");
      const songs = await backend.listSongs();
      const id = await backend.createPlaylist("P");
      await backend.addToPlaylist(id, songs[0].id);
      await backend.deletePlaylist(id);
      expect(await backend.listPlaylists()).toHaveLength(0);
    });
  });

  describe("fileExists / _removeFileFromDisk / scan", () => {
    it("fileExists é true por padrão e false após _removeFileFromDisk", async () => {
      await backend.addFolder("/musicas/teste");
      const path = "/musicas/teste/com_letra.mp3";
      expect(await backend.fileExists(path)).toBe(true);
      backend._removeFileFromDisk(path);
      expect(await backend.fileExists(path)).toBe(false);
    });

    it("scan remove do índice músicas cujo arquivo foi deletado do disco", async () => {
      await backend.addFolder("/musicas/teste");
      backend._removeFileFromDisk("/musicas/teste/com_letra.mp3");

      const result = await backend.scan();
      expect(result.removed).toBe(1);
      expect(result.total).toBe(2);

      const songs = await backend.listSongs();
      expect(songs).toHaveLength(2);
      expect(songs.some((s) => s.file_path.endsWith("com_letra.mp3"))).toBe(false);
    });

    it("scan sem mudanças não remove nada", async () => {
      await backend.addFolder("/musicas/teste");
      const result = await backend.scan();
      expect(result.removed).toBe(0);
      expect(result.total).toBe(3);
      expect(await backend.listSongs()).toHaveLength(3);
    });
  });

  describe("pickFolder / fileSrc", () => {
    it("pickFolder retorna /musicas/mock por padrão e respeita _nextPickedFolder", async () => {
      expect(await backend.pickFolder()).toBe("/musicas/mock");
      backend._nextPickedFolder = "/outra/pasta";
      expect(await backend.pickFolder()).toBe("/outra/pasta");
    });

    it("fileSrc mapeia basenames de fixtures e usa fallback tocável", () => {
      expect(backend.fileSrc("/qualquer/pasta/com_letra.mp3")).toBe("/fixtures/com_letra.mp3");
      expect(backend.fileSrc("/x/sem_letra.mp3")).toBe("/fixtures/sem_letra.mp3");
      expect(backend.fileSrc("/x/sem_tags.mp3")).toBe("/fixtures/sem_tags.mp3");
      expect(backend.fileSrc("/x/desconhecida.mp3")).toBe("/fixtures/sem_letra.mp3");
    });
  });

  describe("onScanProgress", () => {
    it("emite progresso sintético durante addFolder e retorna unsubscribe", async () => {
      const events: ScanProgress[] = [];
      const unsub = await backend.onScanProgress((p) => events.push(p));

      await backend.addFolder("/musicas/teste");
      expect(events.length).toBeGreaterThan(0);
      const last = events[events.length - 1];
      expect(last.done).toBe(last.total);
      expect(events.every((e) => e.done <= e.total)).toBe(true);

      unsub();
      const count = events.length;
      await backend.scan();
      expect(events.length).toBe(count);
    });
  });

  describe("persistência em localStorage", () => {
    it("um novo createMockBackend() relê o estado persistido", async () => {
      await backend.addFolder("/musicas/teste");
      const playlistId = await backend.createPlaylist("Persistida");
      const songs = await backend.listSongs();
      await backend.addToPlaylist(playlistId, songs[0].id);

      // simula restart do app (novo backend, mesmo localStorage)
      const reborn = createMockBackend();
      expect(await reborn.listSongs()).toHaveLength(3);
      expect(await reborn.listFolders()).toHaveLength(1);
      const playlists = await reborn.listPlaylists();
      expect(playlists).toHaveLength(1);
      expect(playlists[0].name).toBe("Persistida");
      const items = await reborn.getPlaylistItems(playlists[0].id);
      expect(items).toHaveLength(1);
      expect(items[0].song.title).toBe(songs[0].title);
    });

    it("_reset limpa o estado e a persistência", async () => {
      await backend.addFolder("/musicas/teste");
      backend._reset();
      expect(await backend.listSongs()).toHaveLength(0);
      expect(await backend.listFolders()).toHaveLength(0);
      const reborn = createMockBackend();
      expect(await reborn.listSongs()).toHaveLength(0);
    });

    it("IDs continuam autoincrementais após restart (sem colisão)", async () => {
      await backend.addFolder("/a");
      const reborn = createMockBackend();
      await reborn.addFolder("/b");
      const songs = await reborn.listSongs();
      expect(new Set(songs.map((s) => s.id)).size).toBe(6);
    });
  });

  describe("temas (V2)", () => {
    it("busca por tema sem acento encontra a música, com snippet null", async () => {
      const backend = createMockBackend();
      await backend.addFolder("/musicas/mock");
      const results = await backend.search("agua");
      expect(results).toHaveLength(1);
      expect(results[0].song.title).toBe("Coração Sertanejo");
      expect(results[0].song.temas).toBe("água; esperança");
      expect(results[0].snippet).toBeNull();
    });

    it("multi-token título + tema encontra (AND)", async () => {
      const backend = createMockBackend();
      await backend.addFolder("/musicas/mock");
      const results = await backend.search("sertanejo agua");
      expect(results).toHaveLength(1);
      expect(results[0].snippet).toBeNull();
    });

    it("músicas sem temas retornam temas null", async () => {
      const backend = createMockBackend();
      await backend.addFolder("/musicas/mock");
      const songs = await backend.listSongs();
      const semLetra = songs.find((s) => s.title === "Instrumental Sem Letra");
      expect(semLetra?.temas).toBeNull();
    });
  });

  describe("_seedSongs", () => {
    it("popula N músicas sintéticas com títulos, artistas cíclicos e letras", async () => {
      backend._seedSongs(50);
      const songs = await backend.listSongs();
      expect(songs).toHaveLength(50);
      expect(songs.some((s) => s.title === "Música 1")).toBe(true);
      expect(songs.some((s) => s.title === "Música 50")).toBe(true);
      const artists = new Set(songs.map((s) => s.artist));
      expect(artists.size).toBeGreaterThan(1);
      const lyrics = await backend.getLyrics(songs[0].id);
      expect(lyrics).not.toBeNull();
      expect(lyrics!.split("\n").length).toBeGreaterThanOrEqual(8);
    });

    it("busca em biblioteca de 2000 músicas é rápida", async () => {
      backend._seedSongs(2000);
      const songs = await backend.listSongs();
      expect(songs).toHaveLength(2000);

      const start = performance.now();
      const results = await backend.search("musica");
      const elapsed = performance.now() - start;
      expect(results.length).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(250);
    });
  });

  describe("writeTags (V4 — F10)", () => {
    it("atualiza título, artista, letra e temas e devolve a Song atualizada", async () => {
      await backend.addFolder("/musicas/teste");
      const songs = await backend.listSongs();
      const semTags = songs.find((s) => s.title === "sem_tags")!;

      const saved = await backend.writeTags(
        semTags.id,
        "Canção Editada",
        "Novo Artista",
        "Primeira linha\nSegunda linha",
        "fé; Alegria",
      );
      expect(saved.id).toBe(semTags.id);
      expect(saved.title).toBe("Canção Editada");
      expect(saved.artist).toBe("Novo Artista");
      expect(saved.has_lyrics).toBe(true);
      // arquivo NUNCA é renomeado
      expect(saved.file_path).toBe(semTags.file_path);

      expect(await backend.getLyrics(semTags.id)).toBe(
        "Primeira linha\nSegunda linha",
      );
      const after = (await backend.listSongs()).find((s) => s.id === semTags.id)!;
      expect(after.title).toBe("Canção Editada");
    });

    it("normaliza temas: trim, minúsculas, dedup e ordem", async () => {
      await backend.addFolder("/musicas/teste");
      const [first] = await backend.listSongs();
      const saved = await backend.writeTags(
        first.id,
        first.title,
        first.artist,
        null,
        " Fé ;alegria; FÉ ; Água",
      );
      // trim + minúsculas + dedup + ordem sem acento (espelha a normalização Python)
      expect(saved.temas).toBe("água; alegria; fé");
    });

    it("letra vazia remove a letra (has_lyrics false) e temas vazios viram null", async () => {
      await backend.addFolder("/musicas/teste");
      const songs = await backend.listSongs();
      const comLetra = songs.find((s) => s.title === "Coração Sertanejo")!;
      const saved = await backend.writeTags(
        comLetra.id,
        comLetra.title,
        comLetra.artist,
        "",
        "",
      );
      expect(saved.has_lyrics).toBe(false);
      expect(saved.temas).toBeNull();
      expect(await backend.getLyrics(comLetra.id)).toBeNull();
    });

    it("rejeita título vazio sem alterar nada", async () => {
      await backend.addFolder("/musicas/teste");
      const [first] = await backend.listSongs();
      await expect(
        backend.writeTags(first.id, "   ", null, null, null),
      ).rejects.toThrow("título vazio");
      const after = (await backend.listSongs()).find((s) => s.id === first.id)!;
      expect(after.title).toBe(first.title);
    });

    it("rejeita quando o arquivo foi removido do disco", async () => {
      await backend.addFolder("/musicas/teste");
      const [first] = await backend.listSongs();
      backend._removeFileFromDisk(first.file_path);
      await expect(
        backend.writeTags(first.id, "Novo Título", null, null, null),
      ).rejects.toThrow("removido do disco");
    });

    it("busca por trecho da letra nova encontra a música (índice atualizado)", async () => {
      await backend.addFolder("/musicas/teste");
      const songs = await backend.listSongs();
      const semTags = songs.find((s) => s.title === "sem_tags")!;
      await backend.writeTags(
        semTags.id,
        "Canção Editada",
        null,
        "verso totalmente exclusivo xyzabc",
        null,
      );
      const results = await backend.search("xyzabc");
      expect(results).toHaveLength(1);
      expect(results[0].song.title).toBe("Canção Editada");
    });

    it("persiste a edição em localStorage (sobrevive a restart)", async () => {
      await backend.addFolder("/musicas/teste");
      const [first] = await backend.listSongs();
      await backend.writeTags(first.id, "Persistida Editada", null, null, null);
      const reborn = createMockBackend();
      const songs = await reborn.listSongs();
      expect(songs.find((s) => s.id === first.id)!.title).toBe(
        "Persistida Editada",
      );
    });

    it("rejeita para id inexistente", async () => {
      await expect(
        backend.writeTags(99999, "Título", null, null, null),
      ).rejects.toThrow();
    });

    // ALTO-4 — letra do Vagalume aceita pelo EDITOR perdia a procedência:
    // write_tags limpava a marca (a letra mudou) e nada era gravado no lugar,
    // então a mesma letra ficava indistinguível de uma do LRCLIB. Duas pilhas
    // no mesmo acervo, dois arquivos diferentes no disco.
    it("letraOrigem 'vagalume' grava a procedência da letra nova", async () => {
      await backend.addFolder("/musicas/teste");
      const songs = await backend.listSongs();
      const semLetra = songs.find((s) => s.title === "Instrumental Sem Letra")!;

      const saved = await backend.writeTags(
        semLetra.id,
        semLetra.title,
        semLetra.artist,
        "letra do vagalume",
        null,
        null,
        "vagalume",
      );
      expect(saved.letra_origem).toBe("vagalume");
    });

    it("sem letraOrigem, letra nova continua limpando a marca (DECISIONS #54)", async () => {
      await backend.addFolder("/musicas/teste");
      const songs = await backend.listSongs();
      const comLetra = songs.find((s) => s.title === "Coração Sertanejo")!;
      backend._markAsTranscribed(comLetra.file_path);

      const saved = await backend.writeTags(
        comLetra.id,
        comLetra.title,
        comLetra.artist,
        "letra editada à mão",
        null,
      );
      expect(saved.letra_origem).toBeNull();
    });

    it("letra inalterada preserva a marca, mesmo sem letraOrigem", async () => {
      await backend.addFolder("/musicas/teste");
      const songs = await backend.listSongs();
      const comLetra = songs.find((s) => s.title === "Coração Sertanejo")!;
      backend._markAsTranscribed(comLetra.file_path);

      const saved = await backend.writeTags(
        comLetra.id,
        "Outro Título",
        comLetra.artist,
        FIXTURE_LYRICS,
        null,
      );
      expect(saved.letra_origem).toBe("transcricao");
    });
  });

  // B2/contrato 6: `fetch_lyrics_online` saiu do backend. Quem busca letra
  // hoje é o funil (enrichSongScan), que passa pelas três etapas e diz de onde
  // veio o dado — dois botões "buscar na internet" eram escolha às cegas.
  describe("fetch_lyrics_online — a superfície antiga não existe mais", () => {
    it("o backend não expõe mais fetchLyricsOnline", () => {
      expect(
        (backend as unknown as Record<string, unknown>).fetchLyricsOnline,
      ).toBeUndefined();
    });
  });

  describe("letra_origem — transcrição automática (V5 — F14)", () => {
    /** A música da fixture que tem letra, já marcada como transcrita. */
    async function comLetraTranscrita(): Promise<Song> {
      await backend.addFolder("/musicas/teste");
      backend._markAsTranscribed("/musicas/teste/com_letra.mp3");
      const songs = await backend.listSongs();
      return songs.find((s) => s.file_path === "/musicas/teste/com_letra.mp3")!;
    }

    it("músicas indexadas nascem sem procedência declarada", async () => {
      await backend.addFolder("/musicas/teste");
      const songs = await backend.listSongs();
      expect(songs.every((s) => s.letra_origem === null)).toBe(true);
    });

    it("_markAsTranscribed marca só o arquivo indicado e a marca chega na Song", async () => {
      const marcada = await comLetraTranscrita();
      expect(marcada.letra_origem).toBe("transcricao");
      const outras = (await backend.listSongs()).filter((s) => s.id !== marcada.id);
      expect(outras.every((s) => s.letra_origem === null)).toBe(true);
      // chega igual pela busca e pelas playlists
      const [hit] = await backend.search("Coração Sertanejo");
      expect(hit.song.letra_origem).toBe("transcricao");
    });

    it("letra nova derruba a marca; repassar a mesma letra preserva (DECISIONS #54)", async () => {
      const marcada = await comLetraTranscrita();

      // repasse da letra idêntica (caminho do lote): a marca continua válida
      const igual = await backend.writeTags(
        marcada.id,
        "Outro Título",
        marcada.artist,
        FIXTURE_LYRICS,
        marcada.temas ?? null,
      );
      expect(igual.letra_origem).toBe("transcricao");

      const editada = await backend.writeTags(
        marcada.id,
        igual.title,
        igual.artist,
        "Letra conferida à mão",
        igual.temas ?? null,
      );
      expect(editada.letra_origem).toBeNull();
      const depois = (await backend.listSongs()).find((s) => s.id === marcada.id)!;
      expect(depois.letra_origem).toBeNull();
    });

    it("apagar a letra derruba a marca e gravar letra nunca a inventa", async () => {
      const marcada = await comLetraTranscrita();
      const semLetra = await backend.writeTags(marcada.id, marcada.title, null, null, null);
      expect(semLetra.has_lyrics).toBe(false);
      expect(semLetra.letra_origem).toBeNull();

      // arquivo sem marca nenhuma não ganha uma ao receber letra
      const songs = await backend.listSongs();
      const semTags = songs.find((s) => s.title === "sem_tags")!;
      const comLetraNova = await backend.writeTags(
        semTags.id,
        semTags.title,
        null,
        "Letra digitada",
        null,
      );
      expect(comLetraNova.letra_origem).toBeNull();
    });

    it("persiste em localStorage (sobrevive a reload)", async () => {
      const marcada = await comLetraTranscrita();
      const reborn = createMockBackend();
      const songs = await reborn.listSongs();
      expect(songs.find((s) => s.id === marcada.id)!.letra_origem).toBe("transcricao");
    });
  });

  describe("instrumental — marca de música sem voz (V8 — F17)", () => {
    /** A fixture sem letra, marcada como instrumental pela curadoria. */
    async function instrumental(): Promise<Song> {
      await backend.addFolder("/musicas/teste");
      backend._markAsInstrumental("/musicas/teste/sem_letra.mp3");
      const songs = await backend.listSongs();
      return songs.find((s) => s.file_path === "/musicas/teste/sem_letra.mp3")!;
    }

    it("músicas indexadas nascem sem a marca (nunca deduzida de 'sem letra')", async () => {
      await backend.addFolder("/musicas/teste");
      const songs = await backend.listSongs();
      expect(songs.every((s) => s.instrumental === false)).toBe(true);
    });

    it("_markAsInstrumental marca só o arquivo indicado e a marca chega na Song", async () => {
      const marcada = await instrumental();
      expect(marcada.instrumental).toBe(true);
      const outras = (await backend.listSongs()).filter((s) => s.id !== marcada.id);
      expect(outras.every((s) => s.instrumental === false)).toBe(true);
      const [hit] = await backend.search("Instrumental Sem Letra");
      expect(hit.song.instrumental).toBe(true);
    });

    it("writeTags marca com true e desmarca com false", async () => {
      const songs = (await backend.addFolder("/musicas/teste"), await backend.listSongs());
      const alvo = songs.find((s) => s.title === "sem_tags")!;

      const marcada = await backend.writeTags(alvo.id, alvo.title, null, null, null, true);
      expect(marcada.instrumental).toBe(true);

      const desmarcada = await backend.writeTags(alvo.id, alvo.title, null, null, null, false);
      expect(desmarcada.instrumental).toBe(false);
    });

    it("writeTags sem informar a marca NÃO a desfaz, nem ao trocar a letra", async () => {
      const marcada = await instrumental();

      // gravação comum (título/artista) — o lote do "Completar dados" faz assim
      const editada = await backend.writeTags(marcada.id, "Doce Prelúdio", "Banda", null, null);
      expect(editada.instrumental).toBe(true);

      // e escrever letra também não desmarca: instrumental COM letra é previsto
      const comLetra = await backend.writeTags(
        marcada.id,
        editada.title,
        editada.artist,
        "Uma letra que apareceu",
        null,
      );
      expect(comLetra.instrumental).toBe(true);
      expect(comLetra.has_lyrics).toBe(true);
    });

    it("persiste em localStorage (sobrevive a reload)", async () => {
      const marcada = await instrumental();
      const reborn = createMockBackend();
      const songs = await reborn.listSongs();
      expect(songs.find((s) => s.id === marcada.id)!.instrumental).toBe(true);
    });
  });

  describe("_seedFolderTree (V4 — F11)", () => {
    it("cria /acervo com músicas em /acervo/1 e /acervo/2", async () => {
      backend._seedFolderTree();
      const folders = await backend.listFolders();
      expect(folders.map((f) => f.path)).toContain("/acervo");
      const songs = await backend.listSongs();
      const um = songs.find((s) => s.file_path === "/acervo/1/a.mp3");
      const dois = songs.find((s) => s.file_path === "/acervo/2/b.mp3");
      expect(um?.title).toBe("Faixa Um");
      expect(dois?.title).toBe("Faixa Dois");
      const acervo = folders.find((f) => f.path === "/acervo")!;
      expect(um?.folder_id).toBe(acervo.id);
    });

    it("é idempotente (não duplica ao chamar duas vezes)", async () => {
      backend._seedFolderTree();
      backend._seedFolderTree();
      const songs = await backend.listSongs();
      expect(songs.filter((s) => s.file_path.startsWith("/acervo/"))).toHaveLength(2);
      const folders = await backend.listFolders();
      expect(folders.filter((f) => f.path === "/acervo")).toHaveLength(1);
    });

    it("persiste em localStorage (sobrevive a reload)", async () => {
      backend._seedFolderTree();
      const reborn = createMockBackend();
      const songs = await reborn.listSongs();
      expect(songs.some((s) => s.file_path === "/acervo/1/a.mp3")).toBe(true);
    });
  });

  describe("enrichFolderScan (V5 — F13)", () => {
    it("retorna propostas SÓ para músicas incompletas (com_letra completa fica de fora)", async () => {
      await backend.addFolder("/musicas/teste");
      const proposals = await varrer(backend, "", "s1", null);
      const paths = proposals.map((p) => p.file_path).sort();
      expect(paths).toEqual([
        "/musicas/teste/sem_letra.mp3",
        "/musicas/teste/sem_tags.mp3",
      ]);
    });

    // V8/F17 + ALTO-5 — instrumental com título e artista prontos está
    // COMPLETA (a marca dispensa a letra): não entra na varredura. O que
    // mudou nesta rodada é o outro lado — ver "instrumental sem artista".
    it("instrumental com os dois nomes prontos está completa: nem candidata, nem no total", async () => {
      await backend.addFolder("/musicas/teste");
      backend._markAsInstrumental("/musicas/teste/sem_letra.mp3");

      const totais: number[] = [];
      const un = await backend.onEnrichProgress((p) => totais.push(p.total));
      const proposals = await varrer(backend, "", "s1", null);
      un();

      expect(proposals.map((p) => p.file_path)).toEqual([
        "/musicas/teste/sem_tags.mp3",
      ]);
      expect(new Set(totais)).toEqual(new Set([1]));
    });

    // ALTO-5, o único caso em que as três implementações discordavam: uma
    // pasta de instrumentais marcados pela CLI, sem etiqueta de artista. O
    // Rust os entrega (PRD V8/F17: "instrumental sem letra ainda pode — e
    // deve — ter título e artista corretos"); o mock os excluía.
    it("instrumental SEM artista é candidata: nome ela ainda pode ganhar", async () => {
      await backend.addFolder("/musicas/teste");
      const songs = await backend.listSongs();
      const semTags = songs.find((s) => s.title === "sem_tags")!;
      backend._markAsInstrumental(semTags.file_path);

      const proposals = await varrer(backend, "", "s1", null);
      expect(proposals.map((p) => p.song_id)).toContain(semTags.id);
    });

    // O curto-circuito de instrumental DENTRO do funil permanece: não é
    // filtro de completude, é integridade. Um instrumental com nomes certos
    // casa com a versão CANTADA no LRCLIB e sai ALTA — pré-marcada.
    it("nenhuma etapa de LETRA roda para instrumental: a letra da versão cantada não é proposta", async () => {
      await backend.addFolder("/musicas/teste");
      const songs = await backend.listSongs();
      const semLetra = songs.find((s) => s.title === "Instrumental Sem Letra")!;

      // sem a marca, o LRCLIB conhece esta música e a proposta traz letra
      const antes = (await varrer(backend, "", "s1", null)).find(
        (p) => p.song_id === semLetra.id,
      )!;
      expect(antes.lyrics).not.toBeNull();

      // com a marca ela continua candidata (está sem artista), mas nenhuma
      // etapa de letra roda: nada de gravar a versão cantada num arquivo
      // que não tem voz
      backend._markAsInstrumental(semLetra.file_path);
      await backend.writeTags(semLetra.id, semLetra.title, null, null, null);
      const depois = (await varrer(backend, "", "s2", "chave")).filter(
        (p) => p.song_id === semLetra.id && p.lyrics !== null,
      );
      expect(depois).toEqual([]);
    });

    // ALTO-2 — "Faixa 03" é placeholder para o Rust (tag-lixo de ripador):
    // vale VAZIO, e uma música sem título real é incompleta mesmo com letra.
    it("título placeholder ('Faixa 03') deixa a música incompleta, mesmo com letra e artista", async () => {
      await backend.addFolder("/musicas/teste");
      const songs = await backend.listSongs();
      const comLetra = songs.find((s) => s.title === "Coração Sertanejo")!;
      await backend.writeTags(comLetra.id, "Faixa 03", "Artista Teste", FIXTURE_LYRICS, null);

      const proposals = await varrer(backend, "", "s1", null);
      expect(proposals.map((p) => p.song_id)).toContain(comLetra.id);
    });

    it("artista placeholder ('Artista Desconhecido') também deixa incompleta", async () => {
      await backend.addFolder("/musicas/teste");
      const songs = await backend.listSongs();
      const comLetra = songs.find((s) => s.title === "Coração Sertanejo")!;
      await backend.writeTags(
        comLetra.id,
        "Coração Sertanejo",
        "Artista Desconhecido",
        FIXTURE_LYRICS,
        null,
      );

      const proposals = await varrer(backend, "", "s1", null);
      expect(proposals.map((p) => p.song_id)).toContain(comLetra.id);
    });

    // A proposta carrega o que a revisão precisa para não destruir nada
    // (CRÍTICO-1): se a música JÁ tem letra, e de que tipo ela é.
    it("toda proposta diz se a música já tem letra e de que procedência", async () => {
      await backend.addFolder("/musicas/teste");
      const songs = await backend.listSongs();
      const comLetra = songs.find((s) => s.title === "Coração Sertanejo")!;
      backend._markAsTranscribed(comLetra.file_path);
      await backend.writeTags(comLetra.id, "Faixa 03", null, FIXTURE_LYRICS, null);

      const proposta = (await varrer(backend, "", "s1", null)).find(
        (p) => p.song_id === comLetra.id,
      )!;
      expect(proposta.has_lyrics).toBe(true);
      expect(proposta.letra_origem).toBe("transcricao");

      const semTags = (await varrer(backend, "", "s2", null)).find((p) =>
        p.file_path.endsWith("sem_tags.mp3"),
      )!;
      expect(semTags.has_lyrics).toBe(false);
      expect(semTags.letra_origem).toBeNull();
    });

    it("filtra por prefixo de pasta; '' = biblioteca inteira", async () => {
      await backend.addFolder("/a");
      await backend.addFolder("/b");
      const onlyA = await varrer(backend, "/a", "s1", null);
      expect(onlyA.length).toBeGreaterThan(0);
      expect(onlyA.every((p) => p.file_path.startsWith("/a/"))).toBe(true);
      const all = await varrer(backend, "", "s1", null);
      expect(all.length).toBe(onlyA.length * 2);
    });

    it("prefixo casa na FRONTEIRA de separador: '/acervo/1' NÃO inclui '/acervo/10'", async () => {
      await backend.addFolder("/acervo/1");
      await backend.addFolder("/acervo/10");
      const proposals = await varrer(backend, "/acervo/1", "s1", null);
      expect(proposals.length).toBeGreaterThan(0);
      expect(
        proposals.every((p) => p.file_path.startsWith("/acervo/1/")),
      ).toBe(true);
      expect(
        proposals.some((p) => p.file_path.startsWith("/acervo/10/")),
      ).toBe(false);
    });

    it("música com artista mas sem letra vira MÉDIA com letra encontrada", async () => {
      await backend.addFolder("/musicas/teste");
      const proposals = await varrer(backend, "", "s1", null);
      const semLetra = proposals.find((p) =>
        p.file_path.endsWith("sem_letra.mp3"),
      )!;
      expect(semLetra.confidence).toBe("media");
      expect(semLetra.current_title).toBe("Instrumental Sem Letra");
      expect(semLetra.proposed_title).toBe("Instrumental Sem Letra");
      expect(semLetra.proposed_artist).toBe("Banda Fixture");
      expect(semLetra.lyrics).not.toBeNull();
      expect(semLetra.error).toBeNull();
    });

    it("música sem artista vira BAIXA com palpite do nome do arquivo, sem letra", async () => {
      await backend.addFolder("/musicas/teste");
      const proposals = await varrer(backend, "", "s1", null);
      const semTags = proposals.find((p) =>
        p.file_path.endsWith("sem_tags.mp3"),
      )!;
      expect(semTags.confidence).toBe("baixa");
      expect(semTags.proposed_title).toBe("sem tags");
      expect(semTags.proposed_artist).toBeNull();
      expect(semTags.lyrics).toBeNull();
      expect(semTags.error).toBeNull();
    });

    it("título contendo 'coração sertanejo' vira ALTA com o match fixo do LRCLIB", async () => {
      await backend.addFolder("/musicas/teste");
      const songs = await backend.listSongs();
      const semTags = songs.find((s) => s.title === "sem_tags")!;
      await backend.writeTags(semTags.id, "Coracao Sertanejo", null, null, null);
      const proposals = await varrer(backend, "", "s1", null);
      const alta = proposals.find((p) => p.song_id === semTags.id)!;
      expect(alta.confidence).toBe("alta");
      expect(alta.proposed_title).toBe("Coração Sertanejo");
      expect(alta.proposed_artist).toBe("Artista Teste");
      expect(alta.lyrics).toBe(FIXTURE_LYRICS);
    });

    it("arquivo removido do disco vira proposta com error (linha desabilitada)", async () => {
      await backend.addFolder("/musicas/teste");
      backend._removeFileFromDisk("/musicas/teste/sem_letra.mp3");
      const proposals = await varrer(backend, "", "s1", null);
      const sumiu = proposals.find((p) =>
        p.file_path.endsWith("sem_letra.mp3"),
      )!;
      expect(sumiu.error).toContain("arquivo não encontrado");
      expect(sumiu.lyrics).toBeNull();
    });

    it("_offline = true NUNCA rejeita: cada proposta vem com error 'sem conexão' (DECISIONS #47)", async () => {
      await backend.addFolder("/musicas/teste");
      backend._offline = true;
      const proposals = await varrer(backend, "", "s1", null);
      expect(proposals).toHaveLength(2);
      expect(proposals.every((p) => p.error === "sem conexão")).toBe(true);
      expect(proposals.every((p) => p.lyrics === null)).toBe(true);
    });

    it("descarta proposta no-op (proposto == atual e sem letra): não há o que decidir", async () => {
      await backend.addFolder("/musicas/teste");
      const songs = await backend.listSongs();
      const semTags = songs.find((s) => s.title === "sem_tags")!;
      // título já idêntico ao palpite do nome do arquivo, sem artista e sem
      // letra: a linha "atual → proposto" seria igual dos dois lados
      await backend.writeTags(semTags.id, "sem tags", null, null, null);

      const proposals = await varrer(backend, "", "s1", null);
      expect(proposals.some((p) => p.song_id === semTags.id)).toBe(false);
      // a MÉDIA (mesmo título/artista) SOBREVIVE porque carrega letra
      expect(proposals.map((p) => p.file_path)).toEqual([
        "/musicas/teste/sem_letra.mp3",
      ]);
    });

    it("no-op COM erro continua na lista (linha desabilitada, o usuário precisa ver)", async () => {
      await backend.addFolder("/musicas/teste");
      const songs = await backend.listSongs();
      const semTags = songs.find((s) => s.title === "sem_tags")!;
      await backend.writeTags(semTags.id, "sem tags", null, null, null);
      backend._offline = true;

      const proposals = await varrer(backend, "", "s1", null);
      const noop = proposals.find((p) => p.song_id === semTags.id)!;
      expect(noop.error).toBe("sem conexão");
      expect(noop.proposed_title).toBe(noop.current_title);
      expect(noop.proposed_artist).toBe(noop.current_artist);
      expect(noop.lyrics).toBeNull();
    });
  });

  describe("o funil no app (V8 — F18): procedência, etapa e Vagalume", () => {
    it("toda proposta diz de ONDE veio, em pt-BR e pronto para exibir", async () => {
      await backend.addFolder("/musicas/teste");
      const proposals = await varrer(backend, "", "s1", null);
      const semLetra = proposals.find((p) => p.file_path.endsWith("sem_letra.mp3"))!;
      const semTags = proposals.find((p) => p.file_path.endsWith("sem_tags.mp3"))!;
      expect(semLetra.fonte).toBe("LRCLIB");
      expect(semTags.fonte).toBe("nome do arquivo");
    });

    it("o progresso carrega a etapa do funil junto da contagem", async () => {
      await backend.addFolder("/musicas/teste");
      const events: EnrichProgress[] = [];
      await backend.onEnrichProgress((p) => events.push(p));
      await varrer(backend, "", "s1", null);

      // nenhum evento sai sem etapa: é o que a tela mostra durante minutos
      expect(events.every((e) => e.etapa.length > 0)).toBe(true);
      expect(events[0].etapa).toBe("preparando");
      expect(events.some((e) => e.etapa === "procurando no LRCLIB")).toBe(true);
    });

    // "quando ausente o passo é pulado silenciosamente" — sem chave não há
    // aviso, erro nem etapa a mais: a busca simplesmente termina antes.
    it("sem chave do Vagalume a etapa é pulada em silêncio", async () => {
      await backend.addFolder("/musicas/teste");
      const events: EnrichProgress[] = [];
      await backend.onEnrichProgress((p) => events.push(p));
      const proposals = await varrer(backend, "", "s1", null);

      expect(proposals.some((p) => p.fonte === "Vagalume")).toBe(false);
      expect(events.some((e) => e.etapa.includes("Vagalume"))).toBe(false);
      expect(proposals.every((p) => p.error === null)).toBe(true);
    });

    // ALTO-5.3 — a regra real (enrich.rs): o Vagalume só é consultado quando
    // há título E artista REAIS para conferir. Ele não tem duração; a
    // igualdade de palavras dos dois lados é a única prova que existe, e ela
    // precisa de um pedido que já signifique alguma coisa.
    it("com chave, música de tags reais que o LRCLIB não conhece passa pelo Vagalume", async () => {
      await backend.addFolder("/musicas/teste");
      const songs = await backend.listSongs();
      const semTags = songs.find((s) => s.title === "sem_tags")!;
      await backend.writeTags(semTags.id, "Ponto de Oxum", "Grupo Fixture", null, null);

      const events: EnrichProgress[] = [];
      await backend.onEnrichProgress((p) => events.push(p));
      const proposals = await varrer(backend, "", "s1", "chave-de-teste");

      const doVagalume = proposals.find((p) => p.song_id === semTags.id)!;
      expect(doVagalume.fonte).toBe("Vagalume");
      expect(doVagalume.lyrics).toBe(FIXTURE_LYRICS);
      expect(doVagalume.confidence).toBe("media");
      expect(events.some((e) => e.etapa === "procurando no Vagalume")).toBe(true);
    });

    // DECISIONS #63 — foi esta fonte que uma vez gravou "Ponto de Ogum"
    // dentro de "Ponto de Oxum". Sem tag real dos DOIS lados não há o que
    // conferir: identificar quem não tem tag é trabalho da impressão digital.
    it("sem artista real, nem com chave o Vagalume é consultado", async () => {
      await backend.addFolder("/musicas/teste");
      const events: EnrichProgress[] = [];
      await backend.onEnrichProgress((p) => events.push(p));
      const proposals = await varrer(backend, "", "s1", "chave-de-teste");

      const semTags = proposals.find((p) => p.file_path.endsWith("sem_tags.mp3"))!;
      expect(semTags.fonte).toBe("nome do arquivo");
      expect(semTags.lyrics).toBeNull();
      expect(events.some((e) => e.etapa === "procurando no Vagalume")).toBe(false);
    });

    it("artista placeholder não conta como etiqueta real para o Vagalume", async () => {
      await backend.addFolder("/musicas/teste");
      const songs = await backend.listSongs();
      const semTags = songs.find((s) => s.title === "sem_tags")!;
      await backend.writeTags(
        semTags.id,
        "Ponto de Oxum",
        "Artista Desconhecido",
        null,
        null,
      );

      const events: EnrichProgress[] = [];
      await backend.onEnrichProgress((p) => events.push(p));
      const proposals = await varrer(backend, "", "s1", "chave-de-teste");
      // V9 — a asserção deixou de procurar a LINHA desta música: com o
      // `campo_efetivo` do Rust dos dois lados do no-op (que o mock não
      // tinha), "Artista Desconhecido" vale o mesmo que artista vazio e a
      // linha não muda nada, então ela nem chega à revisão. A regra que este
      // teste guarda é outra, e continua sendo verificável direto: o Vagalume
      // não é consultado sem etiqueta REAL dos dois lados.
      expect(proposals.every((p) => p.fonte !== "Vagalume")).toBe(true);
      expect(events.some((e) => e.etapa === "procurando no Vagalume")).toBe(false);
    });

    // Chave recusada é veredito sobre a VARREDURA INTEIRA, não sobre uma
    // música: 95 linhas repetindo "a chave foi recusada" seriam 95 cópias do
    // mesmo aviso, e a etapa 3 continuaria batendo num serviço que já disse
    // não. A primeira música reporta; as seguintes pulam em silêncio.
    it("chave recusada: a primeira música avisa e a etapa 3 desliga pelo resto da varredura", async () => {
      await backend.addFolder("/musicas/teste");
      const songs = await backend.listSongs();
      const semLetra = songs.find((s) => s.title === "Instrumental Sem Letra")!;
      const semTags = songs.find((s) => s.title === "sem_tags")!;
      // as duas com tags reais que o LRCLIB não conhece: as duas chegariam
      // à etapa do Vagalume
      await backend.writeTags(semLetra.id, "Xote da Alegria", "Banda Fixture", null, null);
      await backend.writeTags(semTags.id, "Ponto de Oxum", "Grupo Fixture", null, null);
      backend._vagalumeKeyRecusada = true;

      const totais: number[] = [];
      await backend.onEnrichProgress((p) => totais.push(p.total));
      const proposals = await varrer(backend, "", "s1", "chave-errada");

      // as duas foram conferidas...
      expect(totais[0]).toBe(2);
      // ...e só a primeira reporta a chave recusada; a outra passou em
      // silêncio (sem proposta, porque não havia nada além da letra a propor)
      const comErro = proposals.filter((p) => p.error !== null);
      expect(comErro).toHaveLength(1);
      expect(comErro[0].song_id).toBe(semLetra.id);
      expect(comErro[0].error).toBe(
        "a chave do Vagalume foi recusada — confira se copiou a chave inteira",
      );
      expect(proposals.some((p) => p.song_id === semTags.id && p.error !== null)).toBe(
        false,
      );
    });

    it("cada busca individual julga a chave por conta própria", async () => {
      await backend.addFolder("/musicas/teste");
      const songs = await backend.listSongs();
      const semTags = songs.find((s) => s.title === "sem_tags")!;
      await backend.writeTags(semTags.id, "Ponto de Oxum", "Grupo Fixture", null, null);
      backend._vagalumeKeyRecusada = true;

      const proposta = await backend.enrichSongScan(semTags.id, "chave-errada");
      expect(proposta!.error).toBe(
        "a chave do Vagalume foi recusada — confira se copiou a chave inteira",
      );
    });

    // A régua estrita garante que o Vagalume devolveu as MESMAS palavras das
    // tags atuais: a etapa não propõe trocar nome nenhum, a letra é a
    // mudança inteira.
    it("o caminho do Vagalume nunca propõe título ou artista novos", async () => {
      await backend.addFolder("/musicas/teste");
      const songs = await backend.listSongs();
      const semTags = songs.find((s) => s.title === "sem_tags")!;
      await backend.writeTags(semTags.id, "Ponto de Oxum", "Grupo Fixture", null, null);

      const proposta = (await varrer(backend, "", "s1", "chave"))!.find(
        (p) => p.song_id === semTags.id,
      )!;
      expect(proposta.proposed_title).toBe("Ponto de Oxum");
      expect(proposta.proposed_artist).toBe("Grupo Fixture");
    });
  });

  // ALTO-2 — a contagem que a seção de curadoria mostra ANTES de disparar sai
  // do backend, pelo MESMO predicado da varredura. Regra duplicada em
  // TypeScript foi exatamente o que subcontou até zerar o botão.
  describe("enrichCount — a contagem de candidatas (V8 — F18)", () => {
    it("bate com o total do progresso da varredura, música por música", async () => {
      await backend.addFolder("/musicas/teste");
      const totais: number[] = [];
      await backend.onEnrichProgress((p) => totais.push(p.total));
      await varrer(backend, "", "s1", null);

      expect(await backend.enrichCount("")).toBe(totais[0]);
    });

    it("respeita o prefixo de pasta, na fronteira de separador", async () => {
      await backend.addFolder("/acervo/1");
      await backend.addFolder("/acervo/10");
      const um = await backend.enrichCount("/acervo/1");
      const tudo = await backend.enrichCount("");
      expect(um).toBeGreaterThan(0);
      expect(tudo).toBe(um * 2);
    });

    it("conta o instrumental sem artista — que o Rust também conta", async () => {
      await backend.addFolder("/musicas/teste");
      const songs = await backend.listSongs();
      const semTags = songs.find((s) => s.title === "sem_tags")!;
      backend._markAsInstrumental(semTags.file_path);
      expect(await backend.enrichCount("")).toBe(2);
    });

    it("pasta inteira completa conta zero", async () => {
      await backend.addFolder("/musicas/teste");
      const songs = await backend.listSongs();
      for (const s of songs) {
        await backend.writeTags(s.id, s.title, "Artista", "uma letra", null);
      }
      expect(await backend.enrichCount("")).toBe(0);
    });
  });

  describe("enrichSongScan — o caso pontual do editor (V8 — F18)", () => {
    it("roda o MESMO funil em uma música só e devolve a proposta", async () => {
      await backend.addFolder("/musicas/teste");
      const songs = await backend.listSongs();
      const semLetra = songs.find((s) => s.title === "Instrumental Sem Letra")!;

      const proposta = (await backend.enrichSongScan(semLetra.id, null))!;
      expect(proposta.song_id).toBe(semLetra.id);
      expect(proposta.fonte).toBe("LRCLIB");
      expect(proposta.lyrics).toBe(FIXTURE_LYRICS);
      expect(proposta.confidence).toBe("media");
    });

    it("não emite progresso: é uma música, não uma varredura", async () => {
      await backend.addFolder("/musicas/teste");
      const songs = await backend.listSongs();
      const events: EnrichProgress[] = [];
      await backend.onEnrichProgress((p) => events.push(p));
      await backend.enrichSongScan(songs[0].id, null);
      expect(events).toEqual([]);
    });

    it("nada a propor devolve null (o editor mostra o aviso honesto)", async () => {
      await backend.addFolder("/musicas/teste");
      const songs = await backend.listSongs();
      const semTags = songs.find((s) => s.title === "sem_tags")!;
      // título já igual ao palpite do nome do arquivo e sem letra a oferecer
      await backend.writeTags(semTags.id, "sem tags", null, null, null);
      expect(await backend.enrichSongScan(semTags.id, null)).toBeNull();
    });

    // O filtro do LOTE existe para poupar rede em centenas de arquivos. Um
    // pedido explícito, música por música, não é poupança nenhuma — e recusar
    // em silêncio deixaria a pessoa clicando num botão que não faz nada.
    // ALTO-3b: música COMPLETA é consultada mesmo assim ("quem clicou sabe o
    // que quer"), e é isso que devolve um caminho para rebuscar uma letra.
    it("pedido à mão roda mesmo em música completa, que já tem letra", async () => {
      await backend.addFolder("/musicas/teste");
      const songs = await backend.listSongs();
      const comLetra = songs.find((s) => s.title === "Coração Sertanejo")!;

      const proposta = await backend.enrichSongScan(comLetra.id, null);
      expect(proposta).not.toBeNull();
      expect(proposta!.fonte).toBe("LRCLIB");
      // a revisão do editor precisa saber que existe letra ali (CRÍTICO-1)
      expect(proposta!.has_lyrics).toBe(true);
    });

    // ...mas o curto-circuito de INSTRUMENTAL permanece: ele não é filtro de
    // completude, é integridade (nenhuma etapa de letra roda sem voz).
    it("instrumental: o funil roda, mas nenhuma etapa de letra", async () => {
      await backend.addFolder("/musicas/teste");
      const songs = await backend.listSongs();
      const semTags = songs.find((s) => s.title === "sem_tags")!;
      backend._markAsInstrumental(semTags.file_path);

      const proposta = await backend.enrichSongScan(semTags.id, "chave");
      expect(proposta).not.toBeNull();
      expect(proposta!.lyrics).toBeNull();
      expect(proposta!.fonte).toBe("nome do arquivo");
    });

    // ALTO-3a — a pessoa abre "Faixa 03", digita "Coracao Sertanejo" e clica
    // buscar. Sem isto, o backend procurava "Faixa 03": a correção dela nunca
    // era usada e nada na tela dizia isso.
    it("o que está DIGITADO no editor substitui a etiqueta do banco na busca", async () => {
      await backend.addFolder("/musicas/teste");
      const songs = await backend.listSongs();
      const semTags = songs.find((s) => s.title === "sem_tags")!;

      const semAjuda = await backend.enrichSongScan(semTags.id, null);
      expect(semAjuda?.fonte).toBe("nome do arquivo");

      const comTitulo = await backend.enrichSongScan(
        semTags.id,
        null,
        "busca-1",
        "Coracao Sertanejo",
        null,
      );
      expect(comTitulo!.fonte).toBe("LRCLIB");
      expect(comTitulo!.confidence).toBe("alta");
      expect(comTitulo!.lyrics).toBe(FIXTURE_LYRICS);
    });

    it("digitar título E artista reais abre a etapa do Vagalume", async () => {
      await backend.addFolder("/musicas/teste");
      const songs = await backend.listSongs();
      const semTags = songs.find((s) => s.title === "sem_tags")!;

      const proposta = await backend.enrichSongScan(
        semTags.id,
        "chave",
        "busca-1",
        "Ponto de Oxum",
        "Grupo Fixture",
      );
      expect(proposta!.fonte).toBe("Vagalume");
      expect(proposta!.proposed_title).toBe("Ponto de Oxum");
    });

    // B1 — sem id a busca individual era incancelável: offline, sete palpites
    // de 10 s cada deixavam o editor em "Buscando…" por mais de um minuto.
    it("cancelar pelo scanId encerra a busca individual", async () => {
      await backend.addFolder("/musicas/teste");
      const songs = await backend.listSongs();
      backend._enrichDelayMs = 5;
      const busca = backend.enrichSongScan(songs[0].id, null, "individual-1");
      await backend.enrichCancelScan("individual-1");
      expect(await busca).toBeNull();
      backend._enrichDelayMs = 0;
    });

    it("sem conexão devolve a proposta com o erro, nunca rejeita", async () => {
      await backend.addFolder("/musicas/teste");
      const songs = await backend.listSongs();
      backend._offline = true;
      const proposta = (await backend.enrichSongScan(songs[0].id, null))!;
      expect(proposta.error).toBe("sem conexão");
    });

    it("música que não existe devolve null", async () => {
      expect(await backend.enrichSongScan(9999, null)).toBeNull();
    });
  });

  describe("onEnrichProgress (V5 — F13)", () => {
    it("emite progresso por música durante enrichFolderScan e devolve unsubscribe", async () => {
      await backend.addFolder("/musicas/teste");
      const events: EnrichProgress[] = [];
      const unsub = await backend.onEnrichProgress((p) => events.push(p));

      await varrer(backend, "", "s1", null);
      expect(events.length).toBeGreaterThan(0);
      // primeiro evento chega ANTES do trabalho começar
      expect(events[0].done).toBe(0);
      const last = events[events.length - 1];
      expect(last.done).toBe(last.total);
      expect(events.every((e) => e.done <= e.total)).toBe(true);
      // "atual" é o nome do arquivo em processamento
      expect(events.some((e) => e.atual.endsWith(".mp3"))).toBe(true);
      expect(events.every((e) => !e.atual.includes("/"))).toBe(true);

      unsub();
      const count = events.length;
      await varrer(backend, "", "s1", null);
      expect(events.length).toBe(count);
    });

    // M4: sem o scan_id no evento a UI não distingue a varredura viva da zumbi
    it("todo evento carrega o scan_id da varredura que o emitiu", async () => {
      await backend.addFolder("/musicas/teste");
      const events: EnrichProgress[] = [];
      await backend.onEnrichProgress((p) => events.push(p));

      await varrer(backend, "", "scan-abc", null);
      expect(events.length).toBeGreaterThan(0);
      expect(events.every((e) => e.scan_id === "scan-abc")).toBe(true);
    });
  });

  describe("enrichCancelScan (V5 — F13, M4)", () => {
    it("cancelar para a emissão de progresso e resolve a varredura sem propostas", async () => {
      await backend.addFolder("/musicas/teste");
      backend._enrichDelayMs = 5;
      const events: EnrichProgress[] = [];
      await backend.onEnrichProgress((p) => events.push(p));

      const scan = varrer(backend, "", "scan-cancelada", null);
      await backend.enrichCancelScan("scan-cancelada");
      const proposals = await scan;

      expect(proposals).toEqual([]);
      // no máximo o evento inicial (done=0) escapou antes do cancelamento
      expect(events.filter((e) => e.done > 0)).toHaveLength(0);
    });

    it("cancelar uma varredura NÃO derruba a seguinte", async () => {
      await backend.addFolder("/musicas/teste");
      await backend.enrichCancelScan("scan-antiga");
      const proposals = await varrer(backend, "", "scan-nova", null);
      expect(proposals.length).toBeGreaterThan(0);
    });
  });

  describe("enrichApply (V5 — F13, resultados por música)", () => {
    it("aplica título/artista/letra e devolve resultados com a Song atualizada", async () => {
      await backend.addFolder("/musicas/teste");
      const songs = await backend.listSongs();
      const semTags = songs.find((s) => s.title === "sem_tags")!;
      const results = await backend.enrichApply([
        {
          song_id: semTags.id,
          title: "Título Novo",
          artist: "Artista Novo",
          lyrics: "linha um\nlinha dois",
          add_temas: null,
          current_title: semTags.title,
          current_artist: semTags.artist,
          fonte: null,
        },
      ]);
      expect(results).toHaveLength(1);
      expect(results[0].song_id).toBe(semTags.id);
      expect(results[0].error).toBeNull();
      expect(results[0].song!.title).toBe("Título Novo");
      expect(results[0].song!.artist).toBe("Artista Novo");
      expect(results[0].song!.has_lyrics).toBe(true);
      // NUNCA renomeia
      expect(results[0].song!.file_path).toBe(semTags.file_path);
      expect(await backend.getLyrics(semTags.id)).toBe("linha um\nlinha dois");
    });

    it("null NUNCA apaga: artist/lyrics/add_temas null preservam os valores atuais", async () => {
      await backend.addFolder("/musicas/teste");
      const songs = await backend.listSongs();
      const comLetra = songs.find((s) => s.title === "Coração Sertanejo")!;
      const [result] = await backend.enrichApply([
        {
          song_id: comLetra.id,
          title: "Coração Sertanejo (revisado)",
          artist: null,
          lyrics: null,
          add_temas: null,
          current_title: comLetra.title,
          current_artist: comLetra.artist,
          fonte: null,
        },
      ]);
      const updated = result.song!;
      expect(updated.title).toBe("Coração Sertanejo (revisado)");
      expect(updated.artist).toBe("Artista Teste");
      expect(updated.has_lyrics).toBe(true);
      expect(updated.temas).toBe("água; esperança");
      expect(await backend.getLyrics(comLetra.id)).toBe(FIXTURE_LYRICS);
    });

    // V8/F18 — a procedência ecoada pela UI decide o TXXX:LETRA_ORIGEM: letra
    // do Vagalume fica marcada como tal; de qualquer outra fonte LIMPA a marca
    // (letra oficial nunca é transcrição — DECISIONS #54).
    it("fonte 'Vagalume' grava a procedência; outra fonte limpa a marca", async () => {
      await backend.addFolder("/musicas/teste");
      const songs = await backend.listSongs();
      const semLetra = songs.find((s) => s.title === "Instrumental Sem Letra")!;
      backend._markAsTranscribed(semLetra.file_path);

      const [doVagalume] = await backend.enrichApply([
        aplicar(semLetra, { lyrics: "letra do vagalume", fonte: "Vagalume" }),
      ]);
      expect(doVagalume.song!.letra_origem).toBe("vagalume");

      const [doLrclib] = await backend.enrichApply([
        aplicar(
          { ...semLetra, title: doVagalume.song!.title },
          {
            lyrics: "letra do lrclib",
            fonte: "LRCLIB",
            // agora existe letra no arquivo: trocá-la exige consentimento
            substituir_letra: true,
          },
        ),
      ]);
      expect(doLrclib.song!.letra_origem).toBeNull();
    });

    it("add_temas SOMA aos temas existentes (dedup e ordem do writer)", async () => {
      await backend.addFolder("/musicas/teste");
      const songs = await backend.listSongs();
      const comLetra = songs.find((s) => s.title === "Coração Sertanejo")!;
      const [result] = await backend.enrichApply([
        {
          song_id: comLetra.id,
          title: comLetra.title,
          artist: null,
          lyrics: null,
          add_temas: "fé; Água",
          current_title: comLetra.title,
          current_artist: comLetra.artist,
          fonte: null,
        },
      ]);
      expect(result.song!.temas).toBe("água; esperança; fé");
    });

    it("aplica várias músicas de uma vez e persiste em localStorage", async () => {
      await backend.addFolder("/musicas/teste");
      const songs = await backend.listSongs();
      const semLetra = songs.find((s) => s.title === "Instrumental Sem Letra")!;
      const semTags = songs.find((s) => s.title === "sem_tags")!;
      const results = await backend.enrichApply([
        aplicar(semLetra, { title: "Um", lyrics: "la" }),
        aplicar(semTags, { title: "Dois", artist: "A" }),
      ]);
      expect(results.map((r) => r.song!.title)).toEqual(["Um", "Dois"]);
      const reborn = createMockBackend();
      const after = await reborn.listSongs();
      expect(after.find((s) => s.id === semLetra.id)!.title).toBe("Um");
      expect(after.find((s) => s.id === semTags.id)!.title).toBe("Dois");
    });

    it("NUNCA aborta o lote: arquivo deletado vira erro por música e as demais gravam", async () => {
      await backend.addFolder("/musicas/teste");
      const songs = await backend.listSongs();
      const semLetra = songs.find((s) => s.title === "Instrumental Sem Letra")!;
      const semTags = songs.find((s) => s.title === "sem_tags")!;
      backend._removeFileFromDisk(semLetra.file_path);

      const results = await backend.enrichApply([
        aplicar(semLetra, { title: "Um", lyrics: "la" }),
        aplicar(semTags, { title: "Dois", artist: "A" }),
      ]);
      expect(results).toHaveLength(2);

      const falhou = results.find((r) => r.song_id === semLetra.id)!;
      expect(falhou.song).toBeNull();
      expect(falhou.error).toBe(
        `arquivo não encontrado: ${semLetra.file_path}`,
      );

      const gravou = results.find((r) => r.song_id === semTags.id)!;
      expect(gravou.error).toBeNull();
      expect(gravou.song!.title).toBe("Dois");
      // a que gravou persiste; a que falhou fica intocada
      const reborn = createMockBackend();
      const after = await reborn.listSongs();
      expect(after.find((s) => s.id === semTags.id)!.title).toBe("Dois");
      expect(after.find((s) => s.id === semLetra.id)!.title).toBe(
        "Instrumental Sem Letra",
      );
    });

    // A5: a proposta velha reverteria em silêncio a edição feita durante a
    // varredura — o backend (e o mock) recusam e a UI mostra a recusa.
    it("recusa a proposta cuja música mudou depois da varredura", async () => {
      await backend.addFolder("/musicas/teste");
      const songs = await backend.listSongs();
      const semTags = songs.find((s) => s.title === "sem_tags")!;
      const proposta = aplicar(semTags, {
        title: "Palpite do LRCLIB",
        artist: "Palpite",
      });
      // o usuário editou a música à mão enquanto a varredura rodava
      await backend.writeTags(semTags.id, "Nome Certo à Mão", null, null, null);

      const [result] = await backend.enrichApply([proposta]);
      expect(result.song).toBeNull();
      expect(result.error).toContain("mudou depois da busca");
      // a edição manual continua de pé
      const depois = await backend.listSongs();
      expect(depois.find((s) => s.id === semTags.id)!.title).toBe(
        "Nome Certo à Mão",
      );
    });

    it("recusa também quando só o ARTISTA mudou depois da varredura", async () => {
      await backend.addFolder("/musicas/teste");
      const songs = await backend.listSongs();
      const semLetra = songs.find((s) => s.title === "Instrumental Sem Letra")!;
      const proposta = aplicar(semLetra, { lyrics: "letra achada" });
      await backend.writeTags(
        semLetra.id,
        semLetra.title,
        "Outro Artista",
        null,
        null,
      );

      const [result] = await backend.enrichApply([proposta]);
      expect(result.song).toBeNull();
      expect(result.error).toContain("mudou depois da busca");
    });

    it("a recusa é por música: as demais do lote gravam normalmente", async () => {
      await backend.addFolder("/musicas/teste");
      const songs = await backend.listSongs();
      const semLetra = songs.find((s) => s.title === "Instrumental Sem Letra")!;
      const semTags = songs.find((s) => s.title === "sem_tags")!;
      const propostas = [
        aplicar(semLetra, { title: "Um", lyrics: "la" }),
        aplicar(semTags, { title: "Dois", artist: "A" }),
      ];
      await backend.writeTags(semLetra.id, "Editada à Mão", null, null, null);

      const results = await backend.enrichApply(propostas);
      expect(results[0].song).toBeNull();
      expect(results[0].error).toContain("mudou depois da busca");
      expect(results[1].error).toBeNull();
      expect(results[1].song!.title).toBe("Dois");
    });

    // CRÍTICO-1 — a linha "letra encontrada" chegava pré-marcada e um clique
    // apagava uma transcrição corrigida à mão. O backend passa a RECUSAR
    // gravar letra por cima de letra sem consentimento explícito.
    it("recusa gravar letra por cima de letra existente sem substituir_letra", async () => {
      await backend.addFolder("/musicas/teste");
      const songs = await backend.listSongs();
      const comLetra = songs.find((s) => s.title === "Coração Sertanejo")!;

      const [result] = await backend.enrichApply([
        aplicar(comLetra, { lyrics: "outra letra qualquer", fonte: "LRCLIB" }),
      ]);
      expect(result.song).toBeNull();
      expect(result.error).toBe(
        'esta música já tem letra — marque "substituir a letra atual" para trocá-la',
      );
      // e a letra que estava lá continua lá
      expect(await backend.getLyrics(comLetra.id)).toBe(FIXTURE_LYRICS);
    });

    it("com substituir_letra a troca acontece", async () => {
      await backend.addFolder("/musicas/teste");
      const songs = await backend.listSongs();
      const comLetra = songs.find((s) => s.title === "Coração Sertanejo")!;

      const [result] = await backend.enrichApply([
        aplicar(comLetra, {
          lyrics: "outra letra qualquer",
          fonte: "LRCLIB",
          substituir_letra: true,
        }),
      ]);
      expect(result.error).toBeNull();
      expect(await backend.getLyrics(comLetra.id)).toBe("outra letra qualquer");
    });

    it("música sem letra nenhuma não precisa de consentimento", async () => {
      await backend.addFolder("/musicas/teste");
      const songs = await backend.listSongs();
      const semLetra = songs.find((s) => s.title === "Instrumental Sem Letra")!;

      const [result] = await backend.enrichApply([
        aplicar(semLetra, { lyrics: "letra nova", fonte: "LRCLIB" }),
      ]);
      expect(result.error).toBeNull();
      expect(await backend.getLyrics(semLetra.id)).toBe("letra nova");
    });

    it("repassar a MESMA letra não é substituição e não pede consentimento", async () => {
      await backend.addFolder("/musicas/teste");
      const songs = await backend.listSongs();
      const comLetra = songs.find((s) => s.title === "Coração Sertanejo")!;

      const [result] = await backend.enrichApply([
        aplicar(comLetra, { lyrics: FIXTURE_LYRICS, fonte: "LRCLIB" }),
      ]);
      expect(result.error).toBeNull();
    });

    // ALTO-5 — o mock comparava com `!==` cru enquanto o `mesmo_valor` do
    // Rust apara espaços e trata None/"" como o mesmo ausente. A diferença
    // recusava propostas boas dizendo "a música mudou".
    it("obsolescência: espaço nas pontas e ausente/vazio valem o mesmo valor", async () => {
      await backend.addFolder("/musicas/teste");
      const songs = await backend.listSongs();
      const semTags = songs.find((s) => s.title === "sem_tags")!;

      const [result] = await backend.enrichApply([
        {
          song_id: semTags.id,
          title: "Nome Novo",
          artist: "Artista Novo",
          lyrics: null,
          add_temas: null,
          current_title: "  sem_tags  ",
          // o banco tem null; a proposta ecoou "" — é o mesmo ausente
          current_artist: "",
          fonte: null,
        },
      ]);
      expect(result.error).toBeNull();
      expect(result.song!.title).toBe("Nome Novo");
    });

    it("id inexistente vira resultado com error (não rejeita)", async () => {
      const [result] = await backend.enrichApply([
        {
          song_id: 99999,
          title: "X",
          artist: null,
          lyrics: null,
          add_temas: null,
          current_title: "X",
          current_artist: null,
          fonte: null,
        },
      ]);
      expect(result.song).toBeNull();
      expect(result.error).toContain("não encontrada");
    });
  });

  // -------------------------------------------------------------------------
  // V9 — acessórios: nada baixa sozinho, e o que não confere não é instalado
  // -------------------------------------------------------------------------
  describe("acessórios (V9 — F18 fase 2)", () => {
    it("por padrão existe um acessório para esta máquina, e ele está ausente", async () => {
      const [fpcalc] = await backend.acessoriosEstado();
      expect(fpcalc.nome).toBe("fpcalc");
      expect(fpcalc.estado).toBe("ausente");
      // a frase que a tela mostra vem do backend, pronta em pt-BR
      expect(fpcalc.para_que_serve).toBe("reconhecer a música pelo som");
      expect(fpcalc.tamanho_bytes).toBeGreaterThan(0);
      expect(fpcalc.origem).toContain("acessorios-v1");
    });

    // Lista vazia significa "não publicamos binário para este computador" —
    // é diferente de "ausente", e a tela não pode oferecer download.
    it("máquina sem binário publicado: lista vazia", async () => {
      backend._acessorio.publicado = false;
      expect(await backend.acessoriosEstado()).toEqual([]);
    });

    it("baixar emite progresso com o download_id de quem pediu e termina pronto", async () => {
      const eventos: Array<{ baixados: number; total: number | null; id: string }> = [];
      await backend.onAcessorioProgresso((p) =>
        eventos.push({ baixados: p.baixados, total: p.total, id: p.download_id }),
      );

      const desfecho = await backend.acessorioBaixar("fpcalc", "dl-1");
      expect(desfecho.cancelado).toBe(false);
      expect(desfecho.acessorio.estado).toBe("pronto");
      expect(eventos.length).toBeGreaterThan(1);
      expect(eventos.every((e) => e.id === "dl-1")).toBe(true);
      // o último evento fecha no tamanho anunciado
      expect(eventos[eventos.length - 1].baixados).toBe(
        desfecho.acessorio.tamanho_bytes,
      );
      // e o estado persiste: baixou uma vez, não pergunta de novo (regra 3)
      const [depois] = await backend.acessoriosEstado();
      expect(depois.estado).toBe("pronto");
    });

    // `total: null` = o servidor não anunciou o tamanho. A UI precisa
    // sobreviver a isso sem inventar 0 (DECISIONS #86).
    it("servidor que não anuncia o tamanho: total null nos eventos", async () => {
      backend._acessorio.anunciaTotal = false;
      const totais: Array<number | null> = [];
      await backend.onAcessorioProgresso((p) => totais.push(p.total));
      await backend.acessorioBaixar("fpcalc", "dl-1");
      expect(totais.every((t) => t === null)).toBe(true);
    });

    it("cancelar devolve cancelado=true e NÃO instala nada", async () => {
      backend._acessorio.atrasoMs = 1;
      const pendente = backend.acessorioBaixar("fpcalc", "dl-1");
      await backend.acessorioCancelar("dl-1");
      const desfecho = await pendente;
      expect(desfecho.cancelado).toBe(true);
      expect(desfecho.acessorio.estado).toBe("ausente");
    });

    it("cancelar um download que não existe é no-op silencioso", async () => {
      await expect(backend.acessorioCancelar("nunca-existiu")).resolves.toBeUndefined();
    });

    // Soma que não confere: o arquivo é descartado e a frase vem PRONTA do
    // backend — a UI a mostra como veio, sem reescrever.
    it("soma que não confere: rejeita com a frase do backend e o cache fica vazio", async () => {
      backend._acessorio.erro = "soma";
      await expect(backend.acessorioBaixar("fpcalc", "dl-1")).rejects.toThrow(
        "não confere com o esperado",
      );
      const [depois] = await backend.acessoriosEstado();
      expect(depois.estado).toBe("ausente");
    });

    // "corrompido" é tratado como ausente no resto do produto: o download
    // seguinte passa por cima.
    it("corrompido: baixar de novo repara", async () => {
      backend._acessorio.estado = "corrompido";
      const [antes] = await backend.acessoriosEstado();
      expect(antes.estado).toBe("corrompido");
      const desfecho = await backend.acessorioBaixar("fpcalc", "dl-1");
      expect(desfecho.acessorio.estado).toBe("pronto");
    });

    // Sem a chave do AcoustID compilada, o acessório não teria o que fazer:
    // 5 MB baixados para nada é pior que não oferecer.
    it("indisponível nesta build: não instala e diz por quê", async () => {
      backend._acessorio.estado = "indisponivel";
      await expect(backend.acessorioBaixar("fpcalc", "dl-1")).rejects.toThrow(
        "não está disponível nesta versão",
      );
    });

    it("acessório que não existe para esta máquina: erro próprio", async () => {
      await expect(backend.acessorioBaixar("whisper", "dl-1")).rejects.toThrow(
        "não há este acessório para este computador",
      );
    });
  });

  // -------------------------------------------------------------------------
  // V9 — o som no funil, o modo de conferência e as linhas de conflito
  // -------------------------------------------------------------------------
  describe("o funil com a etapa do som (V9)", () => {
    /** Pasta indexada com o acessório já pronto e o som ensinado. */
    async function comSom(diz: {
      titulo: string;
      artista: string;
      confianca?: "alta" | "media";
    }): Promise<Song> {
      await backend.addFolder("/musicas/teste");
      backend._acessorio.estado = "pronto";
      backend._ensinarSom("/musicas/teste/com_letra.mp3", {
        titulo: diz.titulo,
        artista: diz.artista,
        confianca: diz.confianca ?? "alta",
      });
      const songs = await backend.listSongs();
      return songs.find((s) => s.file_path === "/musicas/teste/com_letra.mp3")!;
    }

    it("sem o acessório pronto, a etapa do som não roda", async () => {
      await backend.addFolder("/musicas/teste");
      backend._ensinarSom("/musicas/teste/com_letra.mp3", {
        titulo: "Outra Música",
        artista: "Outro Artista",
        confianca: "alta",
      });
      const propostas = await varrer(backend, "", "s1", null, "completar");
      expect(propostas.every((p) => p.conflito === null)).toBe(true);
    });

    // O caso real que criou o modo: "Te ver feliz, te ver contente" /
    // "Caetano Veloso" que é "Viver Feliz", do Nilson Chaves.
    it("conferência: o som contra a etiqueta vira CONFLITO, sem propor troca", async () => {
      const song = await comSom({ titulo: "Viver Feliz", artista: "Nilson Chaves" });
      const propostas = await varrer(backend, "", "s1", null, "conferencia");
      const linha = propostas.find((p) => p.song_id === song.id)!;

      expect(linha.conflito).toEqual({
        titulo: "Viver Feliz",
        artista: "Nilson Chaves",
        confianca: "alta",
      });
      // a linha informa: o proposto REPETE o atual e a confiança é sempre baixa
      expect(linha.proposed_title).toBe(song.title);
      expect(linha.proposed_artist).toBe(song.artist);
      expect(linha.confidence).toBe("baixa");
      // nenhuma etapa de letra rodou sob um nome que o som contradisse
      expect(linha.lyrics).toBeNull();
      expect(linha.fonte).toBe("reconhecimento pelo som");
      // conflito e troca de nome escrito são avisos ORTOGONAIS
      expect(linha.substitui_nome_escrito).toBe(false);
    });

    it("conferência alcança a música COMPLETA, que a outra varredura nunca vê", async () => {
      await comSom({ titulo: "Viver Feliz", artista: "Nilson Chaves" });
      // com_letra tem título, artista e letra: ela não é candidata de completar
      expect(await backend.enrichCount("", "completar")).toBe(2);
      expect(await backend.enrichCount("", "conferencia")).toBe(3);
    });

    it("conferência não procura letra nenhuma — é o outro trabalho", async () => {
      await backend.addFolder("/musicas/teste");
      backend._acessorio.estado = "pronto";
      const propostas = await varrer(backend, "", "s1", null, "conferencia");
      expect(propostas.every((p) => p.lyrics === null)).toBe(true);
    });

    it("som que CONCORDA com a etiqueta não vira linha nenhuma", async () => {
      await comSom({ titulo: "Coração Sertanejo", artista: "Artista Teste" });
      const propostas = await varrer(backend, "", "s1", null, "conferencia");
      expect(propostas.some((p) => p.conflito !== null)).toBe(false);
    });

    // O modo é opcional no contrato e ausente vale "completar": esquecer o
    // campo nunca pode disparar a varredura que lê o áudio de todas.
    it("sem modo, é a varredura de sempre", async () => {
      await backend.addFolder("/musicas/teste");
      expect(await backend.enrichCount("")).toBe(await backend.enrichCount("", "completar"));
    });
  });

  describe("substitui_nome_escrito (V9)", () => {
    it("preencher campo vazio NÃO conta como troca", async () => {
      await backend.addFolder("/musicas/teste");
      const propostas = await varrer(backend, "", "s1", null, "completar");
      // sem_letra tem artista real e título real fora do catálogo: quem muda
      // aqui é a sem_tags, que não tem etiqueta nenhuma
      const semTags = propostas.find((p) => p.file_path.endsWith("sem_tags.mp3"))!;
      expect(semTags.substitui_nome_escrito).toBe(false);
    });

    it("trocar um título REAL por outro conta como troca", async () => {
      await backend.addFolder("/musicas/teste");
      backend._acessorio.estado = "pronto";
      // o som identifica a mesma música com a grafia oficial, que difere da
      // etiqueta só o bastante para não ser conflito... aqui usamos o caminho
      // direto: a etiqueta é placeholder-free e a proposta muda o artista
      const songs = await backend.listSongs();
      const semLetra = songs.find((s) => s.title === "Instrumental Sem Letra")!;
      await backend.writeTags(semLetra.id, "Coração Sertanejo", "Outro Artista", null, null);
      const propostas = await varrer(backend, "", "s1", null, "completar");
      const linha = propostas.find((p) => p.song_id === semLetra.id)!;
      // o catálogo do LRCLIB devolve "Artista Teste" no lugar de "Outro Artista"
      expect(linha.proposed_artist).toBe("Artista Teste");
      expect(linha.substitui_nome_escrito).toBe(true);
    });

    it("proposta com artista vazio não avisa de uma troca que não vai acontecer", async () => {
      await backend.addFolder("/musicas/teste");
      const propostas = await varrer(backend, "", "s1", null, "completar");
      for (const p of propostas) {
        if ((p.proposed_artist ?? "") === "") {
          expect(p.substitui_nome_escrito).toBe(false);
        }
      }
    });
  });

  describe("installMockBackend", () => {
    it("atribui o backend a window.__CANCIONEIRO_MOCK__ e retorna", () => {
      const installed = installMockBackend();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((window as any).__CANCIONEIRO_MOCK__).toBe(installed);
      expect(typeof installed.addFolder).toBe("function");
      expect(typeof installed._seedSongs).toBe("function");
    });
  });
});
