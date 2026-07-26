import { beforeEach, describe, expect, it } from "vitest";
import { createMockBackend, installMockBackend, type MockBackend } from "./mockBackend";
import { HIGHLIGHT_END, HIGHLIGHT_START } from "./highlight";
import type { ScanProgress } from "./types";

const FIXTURE_LYRICS =
  "Quando o sol amanhecer\nMeu coração vai cantar\nA esperança vai nascer\nE a alegria vai chegar\n\nNão há noite sem estrela\nNão há dor que não se cura";

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
