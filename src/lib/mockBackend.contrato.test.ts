import { beforeEach, describe, expect, it } from "vitest";
import type { EnrichProposal } from "./api";

import {
  ERRO_FPCALC,
  ERRO_FPCALC_NAO_EXECUTA,
  createMockBackend,
  discordaDoSom,
  isPlaceholder,
  similaridadeDeNomes,
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
): Promise<EnrichProposal[]> {
  return (await backend.enrichFolderScan(folderPrefix, scanId)).propostas;
}

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
  ["Asa Branca", "Asa Morena", true],
  ["Tim Maia", "Tom Jobim", true],
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

  /**
   * QA A1, do lado do mock. A métrica por trás do limiar 0,85 mudou no Rust
   * DEPOIS que este mock foi escrito: era coeficiente de Dice sobre bigramas
   * e passou a ser o `difflib.SequenceMatcher.ratio()` do
   * `tools/curadoria.py`, que é o que calibrou o 0,85 num acervo real de 94
   * arquivos. Um mock com a métrica velha condena estes sete pares.
   *
   * Por que doem tanto: uma troca de UM caractere destrói DOIS bigramas, e
   * nome de artista brasileiro é curto. E conflito faz o funil VOLTAR antes
   * das etapas de letra — com o Dice, um MP3 etiquetado "Luis Gonzaga" que o
   * AcoustID identifica como "Luiz Gonzaga" perdia as consultas ao LRCLIB
   * inteiras: **baixar o acessório piorava a música**, e a tela acusava a
   * etiqueta certa.
   *
   * Mesma tabela do `variacao_de_um_caractere_em_nome_curto_nao_e_conflito`
   * (`fingerprint.rs`), com os valores medidos lá.
   */
  const UM_CARACTERE: Array<[string, string, number]> = [
    // (atual, identificado, difflib medido no Rust)
    ["Luiz Gonzaga", "Luis Gonzaga", 0.9167],
    ["Nilson Chaves", "Nilton Chaves", 0.9231],
    ["Cabocla Jurema", "Cabocla Jurama", 0.9286],
    ["Zé Pilintra", "Zé Pelintra", 0.9091],
    ["Roda Viva", "Roda Vida", 0.8889],
    ["Ponto de Oxum", "Ponto de Ogum", 0.9231],
    ["Ponto de Iemanjá", "Ponto de Iansã", 0.8667],
  ];

  for (const [a, b, medido] of UM_CARACTERE) {
    it(`um caractere de diferença não é conflito: ${a} × ${b} (${medido})`, () => {
      expect(discordaDoSom(a, b)).toBe(false);
      expect(discordaDoSom(b, a)).toBe(false);
    });
  }

  /**
   * E o número em si, não só o veredito: se o mock devolvesse OUTRA
   * similaridade que por sorte cai do mesmo lado do 0,85, a próxima mudança
   * de limiar faria os dois lados divergirem de novo em silêncio. É a régua
   * que precisa ser a mesma, não o resultado de hoje.
   */
  it("a similaridade do mock reproduz os números medidos no Rust", () => {
    for (const [a, b, medido] of UM_CARACTERE) {
      expect(similaridadeDeNomes(a, b), `${a} × ${b}`).toBeCloseTo(medido, 4);
    }
  });

  // O `2·M/T` do difflib sobre casos extremos, como o Python os resolve.
  it("os casos de borda da similaridade batem com o difflib", () => {
    expect(similaridadeDeNomes("Asa Branca", "Asa Branca")).toBe(1);
    // dois vazios NÃO são a mesma música: divergência deliberada do Python,
    // documentada no `lyrics_fetch::similarity`
    expect(similaridadeDeNomes("", "")).toBe(0);
    expect(similaridadeDeNomes("abc", "xyz")).toBe(0);
    // "Ponto de Oxum" x "Ponto de Ogum" pontua ACIMA de "Roda Viva" x "Roda
    // Vida": nenhum limiar separa as classes, e é por isso que o número não
    // foi recalibrado — foi a métrica que foi portada
    expect(similaridadeDeNomes("Ponto de Oxum", "Ponto de Ogum")).toBeGreaterThan(
      similaridadeDeNomes("Roda Viva", "Roda Vida"),
    );
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

  // 1. is_placeholder — o caso caro da DECISIONS #89. V10: com o caminho
  //    único TODA música disponível entra na varredura, então o que a
  //    etiqueta truncada muda é a PROPOSTA — a etapa 1 volta a ter o que
  //    preencher, em vez de a música sair da lista em silêncio.
  it("etiqueta truncada pelo ID3 vale VAZIO, e a busca tem o que preencher", async () => {
    await backend.addFolder("/musicas/teste");
    const songs = await backend.listSongs();
    // uma música SEM letra: é ela que passa pelas etapas de letra (V10 — o
    // portão de completude virou o guarda dessas etapas, DECISIONS #102)
    const song = songs.find((s) => s.title === "Instrumental Sem Letra")!;
    await backend.writeTags(
      song.id,
      "Coração Sertanejo",
      "04 Faixa 4 Artista Desconheci",
      null,
      null,
    );
    const propostas = await varrer(backend, "", "s1");
    const linha = propostas.find((p) => p.song_id === song.id)!;
    // a etiqueta truncada não é etiqueta: o artista de verdade é proposto no
    // lugar dela, em vez de a música passar por completa e sumir para sempre
    expect(linha.proposed_artist).toBe("Artista Teste");
  });

  // ...e o contrário: um título REAL que a regra antiga engolia não pode
  //    virar proposta por engano — "Pista" é título do repertório, e propor
  //    trocá-lo pelo palpite do nome do arquivo apagaria a curadoria de alguém.
  it("'Pista' é título real: a música com ele não vira proposta", async () => {
    const song = await comLetra();
    await backend.writeTags(song.id, "Pista", "Artista Teste", "letra qualquer", null);
    const propostas = await varrer(backend, "", "s1");
    expect(propostas.map((p) => p.song_id)).not.toContain(song.id);
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
    const linhas = await varrer(backend, "", "s1");
    expect(linhas.find((p) => p.song_id === song.id)?.conflito ?? null).toBeNull();
  });

  // ...e a contenção curta, que o mock absolvia: "Sol" dentro de "Sol
  //    Nascente" são músicas diferentes, e engolir isso é o modo de falha que
  //    a etapa do som existe para pegar.
  it("nome curto contido num maior CONTINUA conflito", async () => {
    const song = await comLetra();
    await backend.writeTags(song.id, "Sol", "Artista Teste", null, null);
    backend._acessorio.estado = "pronto";
    backend._ensinarSom(song.file_path, {
      titulo: "Sol Nascente",
      artista: "Artista Teste",
      confianca: "alta",
    });
    const linhas = await varrer(backend, "", "s1");
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
    const linhas = await varrer(backend, "", "s1");
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
    const linhas = await varrer(backend, "", "s1");
    const linha = linhas.find((p) => p.song_id === semTags.id)!;
    expect(linha.conflito).toBeNull();
    expect(linha.proposed_title).toBe("Asa Branca");
  });

  // 4. campoEfetivo/propostaNoOp — dois placeholders diferentes valem o MESMO
  //    nada, e uma proposta que troca um por outro não é proposta.
  it("trocar um placeholder por outro não vira proposta", async () => {
    const song = await comLetra();
    await backend.writeTags(song.id, "AudioTrack 17", "faixa 3 mp3", null, null);
    const linhas = await varrer(backend, "", "s1");
    const linha = linhas.find((p) => p.song_id === song.id);
    // ela é candidata (as duas etiquetas valem vazio), mas o artista proposto
    // não pode ser o lixo que já estava lá
    expect(linha?.proposed_artist ?? "").not.toBe("faixa 3 mp3");
  });
});

// ---------------------------------------------------------------------------
// QA A2 — o retorno da varredura em lote, e a conta que ele carrega
// ---------------------------------------------------------------------------
//
// `enrich_folder_scan` deixou de devolver `EnrichProposal[]` e passa a
// devolver `{ propostas, sem_perguntar_ao_som }`. O mock precisa devolver o
// objeto COM A CONTA CALCULADA: um zero fixo faria a suíte inteira certificar
// um campo que nunca é exercitado, e a divergência só mudaria de lugar.

describe("contrato mock × Rust — o retorno da varredura (QA A2)", () => {
  let backend: MockBackend;

  beforeEach(() => {
    localStorage.clear();
    backend = createMockBackend();
  });

  /** Pasta indexada, acessório pronto, e o som ensinado para as três fixtures. */
  async function pastaComSom() {
    await backend.addFolder("/musicas/teste");
    backend._acessorio.estado = "pronto";
    return (await backend.listSongs()).map((s) => s.file_path).sort();
  }

  it("devolve um OBJETO, não a lista — e zero é o caso normal", async () => {
    await backend.addFolder("/musicas/teste");
    const r = await backend.enrichFolderScan("", "s1");
    expect(Array.isArray(r)).toBe(false);
    expect(Array.isArray(r.propostas)).toBe(true);
    expect(r.sem_perguntar_ao_som).toBe(0);
  });

  it("sem o acessório pronto a conta é zero: a etapa não existia para ninguém", async () => {
    await backend.addFolder("/musicas/teste");
    const caminhos = (await backend.listSongs()).map((s) => s.file_path);
    backend._ensinarFalhaDoSom(caminhos[0], ERRO_FPCALC_NAO_EXECUTA);
    const r = await backend.enrichFolderScan("", "s1");
    expect(r.sem_perguntar_ao_som).toBe(0);
  });

  // O caso do achado: o binário não SOBE nesta máquina. A primeira música
  // recebe a linha de erro; as seguintes nunca chegam a ser perguntadas.
  it("veredito sobre a máquina desliga a etapa e conta as que sobraram", async () => {
    const caminhos = await pastaComSom();
    backend._ensinarFalhaDoSom(caminhos[0], ERRO_FPCALC_NAO_EXECUTA);
    const r = await backend.enrichFolderScan("", "s1");
    // 3 candidatas (V10 — a varredura olha todas): a 1ª falhou (linha de
    // erro), as outras 2 não chegaram a ser perguntadas
    expect(r.sem_perguntar_ao_som).toBe(2);
    const linha = r.propostas.find((p) => p.file_path === caminhos[0])!;
    expect(linha.error).toBe(ERRO_FPCALC_NAO_EXECUTA);
  });

  // A incoerência que era o achado: um `fpcalc` que falha em UM arquivo (faixa
  // curta, gravação silenciosa) não é veredito sobre nada. Desligar a etapa no
  // primeiro soluço fazia uma conferência de 150 músicas perguntar ao som UMA
  // vez e deixar 149 com aparência de conferidas.
  it("falha de UM arquivo não desliga a etapa e não conta ninguém", async () => {
    const caminhos = await pastaComSom();
    backend._ensinarFalhaDoSom(caminhos[0], ERRO_FPCALC);
    // sem_tags.mp3 não tem etiqueta de gente: o som PODE preencher o título
    // dela, então a resposta dele é visível na proposta (DECISIONS #53)
    backend._ensinarSom(caminhos[2], {
      titulo: "Asa Branca",
      artista: "Luiz Gonzaga",
      confianca: "alta",
    });
    const r = await backend.enrichFolderScan("", "s1");
    expect(r.sem_perguntar_ao_som).toBe(0);
    // e a música seguinte FOI perguntada: o som respondeu por ela
    const seguinte = r.propostas.find((p) => p.file_path === caminhos[2])!;
    expect(seguinte.proposed_title).toBe("Asa Branca");
  });

  // A música que causou o desligamento NÃO entra na conta: ela tem a linha de
  // erro, que é a informação. Contá-la duas vezes inflaria o número que a
  // tela mostra — e o número é a única coisa que a pessoa tem para dimensionar
  // o estrago.
  it("a música que disparou o veredito não é contada duas vezes", async () => {
    const caminhos = await pastaComSom();
    backend._ensinarFalhaDoSom(caminhos[0], ERRO_FPCALC_NAO_EXECUTA);
    const { total: candidatas } = await backend.enrichCount("");
    const r = await backend.enrichFolderScan("", "s1");
    // a régua é a POPULAÇÃO da varredura, não o tamanho da lista de propostas:
    // proposta que não muda nada é descartada antes de chegar à UI, e usá-la
    // de referência mediria outra coisa
    expect(r.sem_perguntar_ao_som).toBe(candidatas - 1);
  });

  // Cada varredura recomeça do zero: o veredito é sobre AQUELA varredura, e
  // um contador acumulado diria "300 músicas" na terceira tentativa.
  it("a conta não vaza de uma varredura para a seguinte", async () => {
    const caminhos = await pastaComSom();
    backend._ensinarFalhaDoSom(caminhos[0], ERRO_FPCALC_NAO_EXECUTA);
    const primeira = await backend.enrichFolderScan("", "s1");
    const segunda = await backend.enrichFolderScan("", "s2");
    expect(segunda.sem_perguntar_ao_som).toBe(primeira.sem_perguntar_ao_som);
  });
});
