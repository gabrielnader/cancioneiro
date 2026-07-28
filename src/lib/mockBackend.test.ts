import { beforeEach, describe, expect, it } from "vitest";
import type { EnrichApply, EnrichProgress } from "./api";
import { createMockBackend, installMockBackend, type MockBackend } from "./mockBackend";
import { HIGHLIGHT_END, HIGHLIGHT_START } from "./highlight";
import type { ScanProgress, Song } from "./types";

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
  };
}

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
  });

  describe("fetchLyricsOnline (V4 — F10)", () => {
    it("título contendo 'coração sertanejo' (mesmo sem acento) devolve o match fixo", async () => {
      const match = await backend.fetchLyricsOnline(
        "coracao sertanejo",
        "Qualquer Artista",
        180,
      );
      expect(match).not.toBeNull();
      expect(match!.lyrics).toBe(FIXTURE_LYRICS);
      expect(match!.confidence).toBe("alta");
      expect(match!.matched_title).toBe("Coração Sertanejo");
    });

    it("título sem match devolve null", async () => {
      expect(await backend.fetchLyricsOnline("Outra Música", "A", 100)).toBeNull();
    });

    it("_offline = true rejeita com 'sem conexão'", async () => {
      backend._offline = true;
      await expect(
        backend.fetchLyricsOnline("Coração Sertanejo", "Artista Teste", 180),
      ).rejects.toThrow("sem conexão");
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
      const proposals = await backend.enrichFolderScan("", "s1");
      const paths = proposals.map((p) => p.file_path).sort();
      expect(paths).toEqual([
        "/musicas/teste/sem_letra.mp3",
        "/musicas/teste/sem_tags.mp3",
      ]);
    });

    // V8/F17 — a varredura em lote é etapa de LETRA e pula o instrumental,
    // igual ao enrich_scan do Rust. O mock precisa da mesma regra: é ele que
    // o E2E e os testes de store enxergam como "o backend".
    it("pula músicas instrumentais — nem candidata, nem no total do progresso", async () => {
      await backend.addFolder("/musicas/teste");
      backend._markAsInstrumental("/musicas/teste/sem_letra.mp3");

      const totais: number[] = [];
      const un = await backend.onEnrichProgress((p) => totais.push(p.total));
      const proposals = await backend.enrichFolderScan("", "s1");
      un();

      expect(proposals.map((p) => p.file_path)).toEqual([
        "/musicas/teste/sem_tags.mp3",
      ]);
      expect(new Set(totais)).toEqual(new Set([1]));
    });

    it("filtra por prefixo de pasta; '' = biblioteca inteira", async () => {
      await backend.addFolder("/a");
      await backend.addFolder("/b");
      const onlyA = await backend.enrichFolderScan("/a", "s1");
      expect(onlyA.length).toBeGreaterThan(0);
      expect(onlyA.every((p) => p.file_path.startsWith("/a/"))).toBe(true);
      const all = await backend.enrichFolderScan("", "s1");
      expect(all.length).toBe(onlyA.length * 2);
    });

    it("prefixo casa na FRONTEIRA de separador: '/acervo/1' NÃO inclui '/acervo/10'", async () => {
      await backend.addFolder("/acervo/1");
      await backend.addFolder("/acervo/10");
      const proposals = await backend.enrichFolderScan("/acervo/1", "s1");
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
      const proposals = await backend.enrichFolderScan("", "s1");
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
      const proposals = await backend.enrichFolderScan("", "s1");
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
      const proposals = await backend.enrichFolderScan("", "s1");
      const alta = proposals.find((p) => p.song_id === semTags.id)!;
      expect(alta.confidence).toBe("alta");
      expect(alta.proposed_title).toBe("Coração Sertanejo");
      expect(alta.proposed_artist).toBe("Artista Teste");
      expect(alta.lyrics).toBe(FIXTURE_LYRICS);
    });

    it("arquivo removido do disco vira proposta com error (linha desabilitada)", async () => {
      await backend.addFolder("/musicas/teste");
      backend._removeFileFromDisk("/musicas/teste/sem_letra.mp3");
      const proposals = await backend.enrichFolderScan("", "s1");
      const sumiu = proposals.find((p) =>
        p.file_path.endsWith("sem_letra.mp3"),
      )!;
      expect(sumiu.error).toContain("arquivo não encontrado");
      expect(sumiu.lyrics).toBeNull();
    });

    it("_offline = true NUNCA rejeita: cada proposta vem com error 'sem conexão' (DECISIONS #47)", async () => {
      await backend.addFolder("/musicas/teste");
      backend._offline = true;
      const proposals = await backend.enrichFolderScan("", "s1");
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

      const proposals = await backend.enrichFolderScan("", "s1");
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

      const proposals = await backend.enrichFolderScan("", "s1");
      const noop = proposals.find((p) => p.song_id === semTags.id)!;
      expect(noop.error).toBe("sem conexão");
      expect(noop.proposed_title).toBe(noop.current_title);
      expect(noop.proposed_artist).toBe(noop.current_artist);
      expect(noop.lyrics).toBeNull();
    });
  });

  describe("onEnrichProgress (V5 — F13)", () => {
    it("emite progresso por música durante enrichFolderScan e devolve unsubscribe", async () => {
      await backend.addFolder("/musicas/teste");
      const events: EnrichProgress[] = [];
      const unsub = await backend.onEnrichProgress((p) => events.push(p));

      await backend.enrichFolderScan("", "s1");
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
      await backend.enrichFolderScan("", "s1");
      expect(events.length).toBe(count);
    });

    // M4: sem o scan_id no evento a UI não distingue a varredura viva da zumbi
    it("todo evento carrega o scan_id da varredura que o emitiu", async () => {
      await backend.addFolder("/musicas/teste");
      const events: EnrichProgress[] = [];
      await backend.onEnrichProgress((p) => events.push(p));

      await backend.enrichFolderScan("", "scan-abc");
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

      const scan = backend.enrichFolderScan("", "scan-cancelada");
      await backend.enrichCancelScan("scan-cancelada");
      const proposals = await scan;

      expect(proposals).toEqual([]);
      // no máximo o evento inicial (done=0) escapou antes do cancelamento
      expect(events.filter((e) => e.done > 0)).toHaveLength(0);
    });

    it("cancelar uma varredura NÃO derruba a seguinte", async () => {
      await backend.addFolder("/musicas/teste");
      await backend.enrichCancelScan("scan-antiga");
      const proposals = await backend.enrichFolderScan("", "scan-nova");
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
        },
      ]);
      const updated = result.song!;
      expect(updated.title).toBe("Coração Sertanejo (revisado)");
      expect(updated.artist).toBe("Artista Teste");
      expect(updated.has_lyrics).toBe(true);
      expect(updated.temas).toBe("água; esperança");
      expect(await backend.getLyrics(comLetra.id)).toBe(FIXTURE_LYRICS);
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
        },
      ]);
      expect(result.song).toBeNull();
      expect(result.error).toContain("não encontrada");
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
