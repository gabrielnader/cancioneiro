import { beforeEach, describe, expect, it } from "vitest";
import {
  createMockBackend,
  discordaDoSom,
  isPlaceholder,
  tituloEhDoIndexador,
  type MockBackend,
} from "./mockBackend";

/**
 * O PAR DE TESTES QUE A DECISIONS #88 PEDIU.
 *
 * "Mock que discorda do backend certifica o contrato errado." O E2E inteiro
 * roda contra o `mockBackend`, então cada regra que ele implementa de outro
 * jeito é uma afirmação verde sobre um produto que não existe.
 *
 * Este arquivo é a metade TypeScript de um par. A outra metade mora no Rust,
 * nos testes indicados caso a caso, e as duas usam a MESMA tabela de entradas
 * com o MESMO esperado. Não dá para chamar o Rust daqui (é outro processo e
 * outro alvo de compilação), então o esperado é fixado como DADO: cada valor
 * abaixo é o que o Rust produz hoje, conferido contra o `tools/curadoria.py`.
 *
 * Como manter: mudou a regra de um lado, esta tabela quebra — e a correção é
 * mexer nos DOIS. Divergir de novo passa a exigir apagar um teste, que é uma
 * coisa que alguém precisa justificar, em vez de acontecer por esquecimento.
 *
 * Por que este arquivo existe separado do `mockBackend.test.ts`: lá se testa o
 * COMPORTAMENTO do mock (o que ele devolve para a UI); aqui se testa a
 * FIDELIDADE dele ao backend. São perguntas diferentes, e a segunda é a que a
 * v0.9.0 foi reprovada por não fazer.
 */

// ---------------------------------------------------------------------------
// Regra 1 — is_placeholder (enrich.rs; espelho de eh_placeholder no Python)
// ---------------------------------------------------------------------------

/**
 * União das três tabelas do Rust:
 * `is_placeholder_detects_ripper_and_cddb_junk`,
 * `is_placeholder_keeps_real_names` e
 * `is_placeholder_matches_the_python_port`.
 *
 * As duas metades que a DECISIONS #89 mandou existir estão aqui e o mock não
 * as tinha: a regra de TRECHO (etiqueta truncada pelo limite do ID3 —
 * "04 Faixa 4 Artista Desconheci") e a do ruído de arquivo COM marca de
 * ripador ("1-2010 22-17-23)_converted"). Sem elas a música passava por
 * completa e sumia da curadoria para sempre.
 *
 * E a regressão que a mesma decisão mandou TIRAR também está: "Pista" sozinha
 * é título real no repertório, e condená-la apaga o trabalho de quem curou.
 */
const PLACEHOLDER: Array<[string, boolean]> = [
  // -- vazio, pontuação e números soltos ------------------------------------
  ["", true],
  ["   ", true],
  ["#", true],
  ["###", true],
  ["12", true],
  ["02", true],
  // -- "Faixa N" e parentes (com ou sem prefixo numérico) -------------------
  ["AudioTrack 02", true],
  ["02 AudioTrack 02", true],
  ["Audio Track 5", true],
  ["audiotrack", true],
  ["Faixa 8", true],
  ["faixa 2", true],
  ["Faixa", true],
  ["Track 10", true],
  ["track", true],
  ["Pista 3", true],
  // -- placeholders exatos de ripador/CDDB ----------------------------------
  ["no artist", true],
  ["No Artist", true],
  ["unknown artist", true],
  ["[Unknown Artist]", true],
  ["Artista Desconhecido", true],
  ["artista desconhecido", true],
  ["artist", true],
  ["no title", true],
  ["Sem Título", true],
  ["sem titulo", true],
  ["untitled", true],
  ["Unknown", true],
  // -- lixo de ripador com sujeira em volta: a regra de TRECHO --------------
  ["04 Faixa 4 Artista Desconheci", true],
  ["Artista Desconhecida", true],
  ["05 Unknown Artist", true],
  ["No Artist - 03", true],
  ["Titulo Desconheci", true],
  ["Unknown Title 3", true],
  ["Artista Desconhecido de Verdade", true],
  // -- só números e maquinário, COM marca de máquina junto ------------------
  ["1-2010 22-17-23)_converted", true],
  ["audiotrack 02 converted", true],
  ["Track 05 copy", true],
  ["faixa 3 mp3", true],
  ["22-17-23 converted", true],
  ["2010-05-03 gravacao", true],
  ["New Recording 12", true],
  ["Sem Titulo 4", true],
  ["untitled 1", true],
  ["01 audio", true],
  ["wav 3", true],
  // -- e o que NÃO pode virar placeholder -----------------------------------
  // palavra de maquinário SOZINHA é título; sem a marca da máquina a regra
  // do ruído não vale. Condenar aqui apaga o título de quem curou.
  ["Pista", false],
  ["Gravação", false],
  ["Nome", false],
  ["Sem Nome", false],
  ["Convertido", false],
  ["Copia", false],
  ["Recording", false],
  ["Audio", false],
  ["Nova Gravação", false],
  ["Sem Nome no Mundo", false],
  ["Pista de Dança", false],
  ["Faixa Nobre", false],
  ["Track Dois", false],
  ["Faixa de Gaza", false],
  ["O Artista", false],
  ["12 Horas", false],
  // -- títulos reais do repertório ------------------------------------------
  ["Oh! Chuva", false],
  ["Chegança", false],
  ["Antonio Nobrega", false],
  ["Cali", false],
  ["Música Espírita", false],
  ["Princesa Goiana", false],
  ["É cedo ainda", false],
];

describe("contrato mock × Rust — is_placeholder (DECISIONS #88, #89)", () => {
  for (const [texto, esperado] of PLACEHOLDER) {
    it(`${JSON.stringify(texto)} → ${esperado}`, () => {
      expect(isPlaceholder(texto)).toBe(esperado);
    });
  }

  /**
   * O caso nomeado na DECISIONS #89, isolado porque é o que custa mais caro:
   * uma etiqueta assim julgada REAL deixa a música "completa", e completa
   * significa fora de toda varredura, para sempre, sem ninguém a quem
   * perguntar por que a música sumiu da curadoria.
   */
  it("etiqueta truncada pelo ID3 não passa por etiqueta de verdade", () => {
    expect(isPlaceholder("04 Faixa 4 Artista Desconheci")).toBe(true);
  });

  /** E o inverso, que é o incidente do `_RUIDO_DE_ARQUIVO` reencenado. */
  it("'Pista' sozinha é título real — condená-la apagaria a curadoria de alguém", () => {
    expect(isPlaceholder("Pista")).toBe(false);
    expect(isPlaceholder("Pista 3")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Regra 2 — fingerprint::discorda (o som CONTRADIZ esta etiqueta?)
// ---------------------------------------------------------------------------

/**
 * Tabela do teste
 * `discorda_reconhece_variacao_de_grafia_e_condena_musica_diferente`
 * (`fingerprint.rs`), mais os dois casos que a v0.9.0 do mock errava.
 *
 * As duas peças que faltavam no mock nasceram na V9 e valem dinheiro:
 *
 * - **piso de contenção** (`MIN_CONTENCAO`): sem ele, toda etiqueta curta
 *   contida numa longa era absolvida — "Sol" dentro de "Sol Nascente" são
 *   músicas diferentes, e o mock deixava o conflito passar;
 * - **tolerância de grafia** (`LIMIAR_MESMA_GRAFIA` sobre o coeficiente de
 *   Dice): sem ela, "Milionário & José Rico" contra "Milionário y José Rico"
 *   virava conflito. Seis dos oito conflitos do acervo real de 94 arquivos
 *   eram a mesma música escrita de outro jeito — um mock que os condena
 *   certifica uma tela cheia de alarme falso.
 */
const DISCORDA: Array<[string, string, boolean]> = [
  // variação de grafia: mesma música, nenhum conflito
  ["Milionário & José Rico", "Milionário y José Rico", false],
  ["Toinho do Alagoas", "Toinho de Alagoas", false],
  // contenção: um nome inteiro dentro do outro
  ["Adventício - Lampejo", "Lampejo", false],
  ["Marinheiro Só (dj mitsu remix)", "Marinheiro Só", false],
  // música diferente: continua conflito
  ["Satania", "Sabrina", true],
  ["Ponto de Oxum", "Ponto de Ogum", true],
  // contenção curta demais não absolve
  ["Sol", "Sol Nascente", true],
  // campo vazio ou placeholder não contradiz nada — só espera ser preenchido
  ["", "Asa Branca", false],
  ["Faixa 05", "Asa Branca", false],
  ["Asa Branca", "", false],
  // o caso do PRD V9: etiqueta errada de verdade
  ["Te ver feliz, te ver contente", "Viver Feliz", true],
  ["Caetano Veloso", "Nilson Chaves", true],
];

describe("contrato mock × Rust — discorda (V9)", () => {
  for (const [atual, identificado, esperado] of DISCORDA) {
    it(`${JSON.stringify(atual)} × ${JSON.stringify(identificado)} → ${esperado}`, () => {
      expect(discordaDoSom(atual, identificado)).toBe(esperado);
    });
  }

  /**
   * A regra é simétrica no Rust (a contenção compara a curta com a longa, sem
   * olhar de que lado veio) e precisa ser aqui: o funil a chama com a etiqueta
   * de um lado e o som do outro, e trocar a ordem não pode mudar a resposta.
   */
  it("a resposta não depende de qual lado é a etiqueta", () => {
    for (const [atual, identificado, esperado] of DISCORDA) {
      expect(
        discordaDoSom(identificado, atual),
        `${identificado} × ${atual}`,
      ).toBe(esperado);
    }
  });
});

// ---------------------------------------------------------------------------
// Regra 3 — titulo_e_o_nome_do_arquivo (DECISIONS #91)
// ---------------------------------------------------------------------------

/**
 * `enrich.rs:titulo_e_o_nome_do_arquivo` compara os textos EXATOS (só com as
 * pontas aparadas). O mock comparava NORMALIZADO, e a diferença não é
 * acadêmica: um `Oh! Chuva.mp3` com TIT2 `Oh Chuva` é etiqueta escrita por
 * gente para o Rust e invenção do indexador para o mock.
 *
 * Isso decide três coisas de uma vez — se o som pode CONTRADIZER aquele
 * título (conflito), se a etapa 2 pode preenchê-lo, e se a linha ganha o aviso
 * de "isto troca um nome que já existe". Um mock mais frouxo aqui certifica
 * uma tela que nunca avisa.
 */
const DO_INDEXADOR: Array<[string, string, boolean]> = [
  // o caso puro: sem TIT2, o indexador copiou o nome do arquivo
  ["Falamansa - Oh! Chuva", "Falamansa - Oh! Chuva.mp3", true],
  ["08 Na dança das Folhas", "08 Na dança das Folhas.mp3", true],
  // pontas aparadas, e nada além disso
  ["  Oh! Chuva  ", "Oh! Chuva.mp3", true],
  // a divergência que o QA achou: pontuação e acento CONTAM
  ["Oh Chuva", "Oh! Chuva.mp3", false],
  ["oh! chuva", "Oh! Chuva.mp3", false],
  ["Chegança", "Cheganca.mp3", false],
  // etiqueta que nada tem a ver com o nome do arquivo
  ["Asa Branca", "faixa01.mp3", false],
  // arquivo sem extensão: o stem é o nome inteiro
  ["Asa Branca", "Asa Branca", true],
];

describe("contrato mock × Rust — título inventado pelo indexador (#91)", () => {
  for (const [titulo, arquivo, esperado] of DO_INDEXADOR) {
    it(`${JSON.stringify(titulo)} em ${JSON.stringify(arquivo)} → ${esperado}`, () => {
      expect(tituloEhDoIndexador(titulo, arquivo)).toBe(esperado);
    });
  }
});

// ---------------------------------------------------------------------------
// A outra metade: as regras CHEGAM aos quatro pontos que dependem delas
// ---------------------------------------------------------------------------
//
// Predicado certo e fiação errada dá o mesmo prejuízo que predicado errado.
// Na V9 quatro regras passaram a depender do `is_placeholder`, e o E2E
// certifica o contrato pelo comportamento delas — não pelo predicado. Por
// isso cada uma tem aqui um caso que passa pelo backend inteiro.

describe("as regras chegam ao funil (V9)", () => {
  let backend: MockBackend;

  beforeEach(() => {
    localStorage.clear();
    backend = createMockBackend();
  });

  /** A fixture com título, artista e letra — a "completa" da pasta. */
  async function comLetra() {
    await backend.addFolder("/musicas/teste");
    const songs = await backend.listSongs();
    return songs.find((s) => s.file_path === "/musicas/teste/com_letra.mp3")!;
  }

  // 1. candidataDoFunil — o caso caro da DECISIONS #89. Com a etiqueta
  //    truncada julgada REAL, a música fica "completa" e some da curadoria
  //    para sempre: ninguém nunca vai saber que ela está ali.
  it("etiqueta truncada pelo ID3 devolve a música à contagem de candidatas", async () => {
    const song = await comLetra();
    await backend.writeTags(
      song.id,
      "Coração Sertanejo",
      "04 Faixa 4 Artista Desconheci",
      "letra qualquer",
      null,
    );
    expect(await backend.enrichCount("", "completar")).toBe(3);
  });

  // ...e o contrário: um título REAL que a regra antiga engolia não pode
  //    virar candidata por engano — "Pista" é título do repertório.
  it("'Pista' é título real: a música com ele continua completa", async () => {
    const song = await comLetra();
    await backend.writeTags(song.id, "Pista", "Artista Teste", "letra qualquer", null);
    expect(await backend.enrichCount("", "completar")).toBe(2);
  });

  // 2. discordaDoSom — variação de grafia não pode virar conflito. Seis dos
  //    oito conflitos do acervo real de 94 arquivos eram exatamente isto.
  it("o som com outra grafia do mesmo nome não abre conflito", async () => {
    const song = await comLetra();
    await backend.writeTags(
      song.id,
      "Coração Sertanejo",
      "Milionário & José Rico",
      null,
      null,
    );
    backend._acessorio.estado = "pronto";
    backend._ensinarSom(song.file_path, {
      titulo: "Coração Sertanejo",
      artista: "Milionário y José Rico",
      confianca: "alta",
    });
    const linhas = await backend.enrichFolderScan("", "s1", null, "conferencia");
    expect(linhas.find((p) => p.song_id === song.id)?.conflito ?? null).toBeNull();
  });

  // ...e a contenção curta, que o mock absolvia: "Sol" dentro de "Sol
  //    Nascente" são músicas diferentes, e engolir isso é o modo de falha
  //    que o modo de conferência existe para pegar.
  it("nome curto contido num maior CONTINUA conflito", async () => {
    const song = await comLetra();
    await backend.writeTags(song.id, "Sol", "Artista Teste", null, null);
    backend._acessorio.estado = "pronto";
    backend._ensinarSom(song.file_path, {
      titulo: "Sol Nascente",
      artista: "Artista Teste",
      confianca: "alta",
    });
    const linhas = await backend.enrichFolderScan("", "s1", null, "conferencia");
    expect(linhas.find((p) => p.song_id === song.id)?.conflito).toEqual({
      titulo: "Sol Nascente",
      artista: "Artista Teste",
      confianca: "alta",
    });
  });

  // 3. substituiNomeEscrito, via tituloEscrito — uma etiqueta que difere do
  //    nome do arquivo só na pontuação É etiqueta de gente, e trocá-la
  //    precisa avisar. Com a comparação normalizada ela era invisível.
  it("etiqueta que difere do nome do arquivo só na pontuação é nome ESCRITO", async () => {
    await backend.addFolder("/musicas/teste");
    const songs = await backend.listSongs();
    // `sem_tags.mp3` chega com title = "sem_tags": é o indexador copiando o
    // nome por falta de TIT2. Alguém então ARRUMA a etiqueta à mão para
    // "Sem Tags" — mesma chave normalizada, texto diferente.
    const semTags = songs.find((s) => s.file_path.endsWith("sem_tags.mp3"))!;
    expect(semTags.title).toBe("sem_tags");
    await backend.writeTags(semTags.id, "Sem Tags", null, null, null);

    backend._acessorio.estado = "pronto";
    backend._ensinarSom(semTags.file_path, {
      titulo: "Asa Branca",
      artista: "Luiz Gonzaga",
      confianca: "alta",
    });
    const linhas = await backend.enrichFolderScan("", "s1", null, "conferencia");
    const linha = linhas.find((p) => p.song_id === semTags.id)!;
    // etiqueta de GENTE: o som a CONTRADIZ, e isso é conflito. Comparando
    // normalizado ela passava por invenção do indexador, e o som sobrescrevia
    // o título arrumado à mão sem conflito e sem aviso nenhum.
    expect(linha.conflito).not.toBeNull();
    expect(linha.proposed_title).toBe("Sem Tags");
  });

  // ...e o caso do indexador de verdade, que não pode virar conflito: seria a
  // etapa 2 falhando justamente na metade pior etiquetada do acervo, que é a
  // população que ela existe para resolver (DECISIONS #91).
  it("título que É o nome do arquivo continua invenção do indexador", async () => {
    await backend.addFolder("/musicas/teste");
    const songs = await backend.listSongs();
    const semTags = songs.find((s) => s.file_path.endsWith("sem_tags.mp3"))!;
    backend._acessorio.estado = "pronto";
    backend._ensinarSom(semTags.file_path, {
      titulo: "Asa Branca",
      artista: "Luiz Gonzaga",
      confianca: "alta",
    });
    const linhas = await backend.enrichFolderScan("", "s1", null, "conferencia");
    const linha = linhas.find((p) => p.song_id === semTags.id)!;
    expect(linha.conflito).toBeNull();
    expect(linha.proposed_title).toBe("Asa Branca");
  });

  // 4. campoEfetivo/propostaNoOp — dois placeholders diferentes valem o MESMO
  //    nada, e uma proposta que troca um por outro não é proposta.
  it("trocar um placeholder por outro não vira proposta", async () => {
    const song = await comLetra();
    await backend.writeTags(song.id, "AudioTrack 17", "faixa 3 mp3", null, null);
    const linhas = await backend.enrichFolderScan("", "s1", null, "completar");
    const linha = linhas.find((p) => p.song_id === song.id);
    // ela é candidata (as duas etiquetas valem vazio), mas o artista proposto
    // não pode ser o lixo que já estava lá
    expect(linha?.proposed_artist ?? "").not.toBe("faixa 3 mp3");
  });
});
