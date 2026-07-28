import { describe, expect, it } from "vitest";
import { buildFolderTree } from "./folderTree";
import {
  ETAPAS_DENTRO_DO_APP,
  ETAPAS_FORA_DO_APP,
  SEM_RESULTADO_INDIVIDUAL,
  VAGALUME_URL,
  estimativaTexto,
  musicasACurar,
  opcoesDePasta,
  textoAplicado,
  textoSemPropostas,
} from "./curadoria";
import type { Folder, Song } from "./types";

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

describe("musicasACurar — as candidatas do funil (V8/F18)", () => {
  const songs = [
    song(1, "/acervo/1/completa.mp3"),
    song(2, "/acervo/1/sem_letra.mp3", { has_lyrics: false }),
    song(3, "/acervo/1/sem_artista.mp3", { artist: null }),
    song(4, "/acervo/2/outra.mp3", { has_lyrics: false }),
    song(5, "/acervo/1/instrumental.mp3", { has_lyrics: false, instrumental: true }),
    song(6, "/acervo/1/sumida.mp3", { has_lyrics: false, available: false }),
  ];

  it('prefixo vazio = biblioteca inteira: só as incompletas, disponíveis e não-instrumentais', () => {
    expect(musicasACurar(songs, "").map((s) => s.id)).toEqual([2, 3, 4]);
  });

  it("prefixo de pasta casa na fronteira de separador, como a árvore lateral", () => {
    expect(musicasACurar(songs, "/acervo/1").map((s) => s.id)).toEqual([2, 3]);
    // "/acervo/1" não pode capturar "/acervo/10/..."
    expect(
      musicasACurar([song(7, "/acervo/10/x.mp3", { has_lyrics: false })], "/acervo/1"),
    ).toEqual([]);
  });

  it("instrumental fica de fora — toda etapa de letra pula o arquivo (V8/F17)", () => {
    expect(musicasACurar(songs, "").some((s) => s.id === 5)).toBe(false);
  });
});

describe("estimativaTexto — o que a pessoa lê ANTES de disparar", () => {
  it("zero candidatas: diz que não há o que procurar, sem prometer varredura", () => {
    expect(estimativaTexto(0)).toBe(
      "Nenhuma música desta pasta está sem título, artista ou letra —" +
        " não há nada para procurar.",
    );
  });

  it("uma candidata: singular", () => {
    expect(estimativaTexto(1)).toBe(
      "1 música desta pasta está incompleta. A busca leva menos de 2 minutos.",
    );
  });

  it("muitas candidatas: contagem e tempo estimado em minutos", () => {
    expect(estimativaTexto(95)).toBe(
      "95 músicas desta pasta estão incompletas. A busca leva cerca de 3 minutos.",
    );
  });
});

describe("opcoesDePasta — o seletor de Configurações", () => {
  const folders: Folder[] = [{ id: 1, path: "/acervo", last_scanned_at: null }];
  const tree = buildFolderTree(
    [
      song(1, "/acervo/1/a.mp3"),
      song(2, "/acervo/1/sub/b.mp3"),
      song(3, "/acervo/2/c.mp3"),
    ],
    folders,
  );

  it("começa por 'Toda a biblioteca' (prefixo vazio) e desce a árvore com o nível", () => {
    expect(opcoesDePasta(tree)).toEqual([
      { path: "", label: "Toda a biblioteca", nivel: 0 },
      { path: "/acervo", label: "acervo", nivel: 0 },
      { path: "/acervo/1", label: "1", nivel: 1 },
      { path: "/acervo/1/sub", label: "sub", nivel: 2 },
      { path: "/acervo/2", label: "2", nivel: 1 },
    ]);
  });

  it("biblioteca vazia: só a opção da biblioteca inteira", () => {
    expect(opcoesDePasta([])).toEqual([
      { path: "", label: "Toda a biblioteca", nivel: 0 },
    ]);
  });
});

describe("textoSemPropostas — 'não achamos' não pode soar como 'está completa'", () => {
  it("nenhuma candidata: diz exatamente isso, sem prometer completude por engano", () => {
    expect(textoSemPropostas(0)).toBe(
      "Nenhuma música desta pasta estava incompleta — todas já têm título," +
        " artista e letra.",
    );
  });

  it("com candidatas conferidas: conta o que houve, nega o fracasso e nega a completude", () => {
    const texto = textoSemPropostas(81);
    expect(texto).toContain("Conferimos as 81 músicas incompletas desta pasta");
    expect(texto).toContain("não achamos nenhuma delas nos sites de letra");
    // não é fracasso e não é "acervo completo" (DECISIONS #60)
    expect(texto).toContain("Isso é comum e não quer dizer que a pasta esteja completa");
    // honesto sobre a etapa que a Fase 1 não faz
    expect(texto).toContain(
      "Escrever a letra ouvindo o áudio ainda não é feito pelo aplicativo",
    );
  });

  it("uma candidata só: singular", () => {
    expect(textoSemPropostas(1)).toContain(
      "Conferimos a única música incompleta desta pasta",
    );
  });

  it("o caso pontual do editor recebe o mesmo cuidado", () => {
    expect(SEM_RESULTADO_INDIVIDUAL).toContain("Isso é comum");
    expect(SEM_RESULTADO_INDIVIDUAL).toContain(
      "Escrever a letra ouvindo o áudio ainda não é feito pelo aplicativo",
    );
    // não pode soar como "esta música está completa"
    expect(SEM_RESULTADO_INDIVIDUAL).not.toContain("completa");
  });
});

describe("textoAplicado — o aviso final diz o que MUDOU, nunca uma tarefa", () => {
  it("só letras: a frase do PRD", () => {
    expect(textoAplicado(47, 0, 47)).toBe(
      "47 músicas ganharam letra. A biblioteca já está atualizada.",
    );
  });

  it("letras e correções de nome", () => {
    expect(textoAplicado(12, 3, 15)).toBe(
      "12 músicas ganharam letra e 3 tiveram título ou artista corrigidos." +
        " A biblioteca já está atualizada.",
    );
  });

  it("só correções de nome", () => {
    expect(textoAplicado(0, 1, 1)).toBe(
      "1 música teve título ou artista corrigido. A biblioteca já está atualizada.",
    );
  });

  it("singular da letra", () => {
    expect(textoAplicado(1, 0, 1)).toBe(
      "1 música ganhou letra. A biblioteca já está atualizada.",
    );
  });

  it("gravou sem mudar conteúdo: não inventa ganho que não houve", () => {
    expect(textoAplicado(0, 0, 2)).toBe(
      "2 músicas foram gravadas, sem mudança no conteúdo.",
    );
  });

  // PRD V8: "não haverá popup pedindo para reindexar nem para reiniciar"
  it("nunca pede reindexação nem reinício", () => {
    for (const t of [
      textoAplicado(47, 0, 47),
      textoAplicado(12, 3, 15),
      textoAplicado(0, 1, 1),
      textoAplicado(0, 0, 2),
    ]) {
      expect(t.toLowerCase()).not.toContain("reindex");
      expect(t.toLowerCase()).not.toContain("reinici");
    }
  });
});

describe("o que a seção de curadoria promete", () => {
  it("as etapas de dentro do app são as três da Fase 1, nesta ordem", () => {
    expect(ETAPAS_DENTRO_DO_APP.map((e) => e.nome)).toEqual([
      "O que já está no arquivo",
      "LRCLIB",
      "Vagalume",
    ]);
  });

  // A Fase 1 NÃO faz impressão digital nem transcrição: mencioná-las sem
  // dizer que ainda dependem do script seria promessa falsa para quem não
  // tem a quem perguntar.
  it("o que ainda não é feito aqui é dito com todas as letras", () => {
    expect(ETAPAS_FORA_DO_APP).toContain("ainda não");
    expect(ETAPAS_FORA_DO_APP).toContain("ferramentas de curadoria");
  });

  it("o endereço da chave gratuita do Vagalume é o oficial", () => {
    expect(VAGALUME_URL).toBe("https://auth.vagalume.com.br/settings/api/");
  });
});
