import { beforeEach, describe, expect, it } from "vitest";
import type { EnrichProposal } from "./api";
import { grupoDaProposta } from "./curadoria";

import {
  AVISO_ETIQUETA_NORMALIZADA,
  ERRO_FPCALC,
  ERRO_FPCALC_NAO_EXECUTA,
  createMockBackend,
  discordaDoSom,
  isPlaceholder,
  similaridadeDeNomes,
  tituloEhDoIndexador,
  type Campo,
  type MockBackend,
} from "./mockBackend";

/**
 * Os dois slots. O `is_placeholder` do Rust passou a exigi-lo (`Campo`), e as
 * tabelas rodam nos dois sempre que a régua NÃO deveria diferir: é a varredura
 * que impede a próxima regra "de artista" de vazar para o título.
 */
const CAMPOS: Campo[] = ["titulo", "artista"];

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
  // A régua NÃO muda entre os campos para nada desta tabela: lixo de ripador é
  // lixo nos dois, e nome real é nome nos dois. Rodar as duas colunas é o que
  // impede a próxima regra "por slot" de vazar para o campo errado sem ninguém
  // perceber — foi exatamente assim que a #105 chegou ao título.
  for (const [texto, esperado] of PLACEHOLDER) {
    for (const campo of CAMPOS) {
      it(`${campo}: ${JSON.stringify(texto)} → ${esperado}`, () => {
        expect(isPlaceholder(campo, texto)).toBe(esperado);
      });
    }
  }

  /**
   * O caso nomeado na DECISIONS #89, isolado porque é o que custa mais caro:
   * uma etiqueta assim julgada REAL deixa a música "completa", e completa
   * significa fora de toda varredura, para sempre, sem ninguém a quem
   * perguntar por que a música sumiu da curadoria.
   */
  it("etiqueta truncada pelo ID3 não passa por etiqueta de verdade", () => {
    expect(isPlaceholder("artista", "04 Faixa 4 Artista Desconheci")).toBe(true);
    expect(isPlaceholder("titulo", "04 Faixa 4 Artista Desconheci")).toBe(true);
  });

  /** E o inverso, que é o incidente do `_RUIDO_DE_ARQUIVO` reencenado. */
  it("'Pista' sozinha é título real — condená-la apagaria a curadoria de alguém", () => {
    expect(isPlaceholder("titulo", "Pista")).toBe(false);
    expect(isPlaceholder("titulo", "Pista 3")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Regra 1b — os rótulos de COLETÂNEA valem POR SLOT (DECISIONS #105 + QA B2)
// ---------------------------------------------------------------------------
//
// Duas correções na mesma regra, e as duas nasceram aqui:
//
// 1. O mock não tinha regra NENHUMA para eles. A #105 existia só no Rust, e
//    divergência por OMISSÃO é a mais silenciosa que há — nenhum teste falha
//    por uma regra que ninguém escreveu.
// 2. A regra do Rust rodava nos DOIS campos, e o argumento dela ("rótulos que
//    nenhuma canção usa como NOME") foi escrito pensando em ARTISTA. Uma
//    música intitulada "Diversos" valia VAZIO: o palpite do nome do arquivo
//    entrava por cima, sem aviso de troca, PRÉ-MARCADA num grupo dobrado cuja
//    frase promete tratar de "músicas sem título ou artista". O clique levava
//    embora um título que a pessoa vê na biblioteca.
//
// O predicado do Rust passou a exigir o slot (`is_placeholder(Campo, &str)`),
// e o mock faz igual. Tabelas do `rotulo_de_coletanea_nao_e_artista`, do
// `rotulo_de_coletanea_no_titulo_e_titulo`, do
// `nenhum_titulo_legitimo_de_uma_palavra_cai_na_regra_nova` e do
// `va_sem_acento_e_rotulo_e_va_com_acento_e_titulo` (`enrich.rs`).

/** [texto, é placeholder como TÍTULO, é placeholder como ARTISTA] */
const COLETANEA: Array<[string, boolean, boolean]> = [
  // -- rótulo de coletânea: nome de NINGUÉM, logo só o artista o recusa ------
  ["Various Artists", false, true],
  ["various artist", false, true],
  ["[Various Artists]", false, true],
  ["Various", false, true],
  ["Vários Artistas", false, true],
  ["Vários Intérpretes", false, true],
  ["Artistas Variados", false, true],
  ["Artistas Diversos", false, true],
  ["Intérpretes Diversos", false, true],
  ["Vários", false, true],
  ["Várias", false, true],
  ["Diversos", false, true],
  ["V.A.", false, true],
  ["V. A.", false, true],
  ["VA", false, true],
  ["va", false, true],
  ["Compilation", false, true],
  ["Compilação", false, true],
  ["compilacao", false, true],
  ["Coletânea", false, true],
  ["coletanea", false, true],
  ["Coletâneas", false, true],
  // -- a LIÇÃO DA DECISÃO 89: nomes de uma palavra que não podem cair --------
  // Nenhum destes é rótulo em campo nenhum. "Pista" está aqui porque foi o
  // incidente original; os outros, porque a #105 os nomeou um a um.
  ["Vai", false, false],
  ["Vamos", false, false],
  ["Valsa", false, false],
  ["Variações", false, false],
  ["Compilado", false, false],
  ["Artista", false, false],
  ["Pista", false, false],
  // "Vá" é o VERBO, e a normalização tira o acento: as duas grafias chegariam
  // à mesma chave. A única prova disponível é o acento do texto ORIGINAL —
  // por isso "VA" sem acento é rótulo (no artista) e "Vá" não é em campo
  // nenhum. Condenar "Vá" apagaria o título de alguém (DECISIONS #105).
  ["Vá", false, false],
];

describe("contrato mock × Rust — rótulo de coletânea vale por SLOT (QA B2)", () => {
  for (const [texto, noTitulo, noArtista] of COLETANEA) {
    it(`${JSON.stringify(texto)} → título ${noTitulo}, artista ${noArtista}`, () => {
      expect(isPlaceholder("titulo", texto)).toBe(noTitulo);
      expect(isPlaceholder("artista", texto)).toBe(noArtista);
    });
  }

  /*
    O predicado não tem valor padrão de propósito: um `is_placeholder` sem slot
    generaliza sozinho na próxima vez, e foi assim que a #105 chegou ao título.
    No Rust quem cobra em cada chamada é o compilador; aqui é o `tsc`.

    Quem afirma é o `@ts-expect-error`, não o `expect`: se alguém tornar o
    parâmetro opcional, o erro esperado deixa de acontecer e o `tsc` reprova a
    diretiva. É o teste rodando na compilação, que é onde ele vale.
  */
  it("não existe pergunta de placeholder sem campo", () => {
    // @ts-expect-error — o slot é obrigatório nas duas linguagens
    const semSlot = () => isPlaceholder("Diversos");
    expect(typeof semSlot).toBe("function");
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
      // a régua da contradição é a MESMA nos dois campos para esta tabela
      for (const campo of CAMPOS) {
        expect(discordaDoSom(campo, atual, identificado), campo).toBe(esperado);
      }
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
        discordaDoSom("titulo", identificado, atual),
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
      expect(discordaDoSom("titulo", a, b)).toBe(false);
      expect(discordaDoSom("titulo", b, a)).toBe(false);
    });
  }

  /*
    QA B2 — é AQUI que a régua por slot muda um veredito.

    `discorda` começa absolvendo o que for placeholder dos dois lados (campo
    vazio não contradiz nada, só espera ser preenchido). Com o slot:

    - "Various Artists" no crédito é placeholder de ARTISTA, então o som
      dizendo "Luiz Gonzaga" NÃO abre conflito — ele preenche;
    - "Diversos" no TÍTULO é um título de verdade, então o som dizendo outra
      coisa CONTRADIZ, e a linha vai para o topo da revisão em vez de sumir
      dentro do grupo dobrado pré-marcado.

    Antes do slot os dois casos respondiam "não contradiz", e o segundo era
    perda de dado silenciosa.
  */
  it("rótulo de coletânea não contradiz no artista, mas contradiz no título", () => {
    expect(discordaDoSom("artista", "Various Artists", "Luiz Gonzaga")).toBe(false);
    expect(discordaDoSom("artista", "Diversos", "Luiz Gonzaga")).toBe(false);
    expect(discordaDoSom("titulo", "Diversos", "Asa Branca")).toBe(true);
    expect(discordaDoSom("titulo", "Coletânea", "Asa Branca")).toBe(true);
  });

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

  /*
    1b. QA B2 — o rótulo de coletânea vale por SLOT, e este é o desfecho.

    O que este teste fixava antes: um título "Diversos" valia VAZIO, o palpite
    do nome do arquivo entrava por cima, `substitui_nome_escrito` era FALSE
    (logo sem o aviso "isto troca um título que já existe" e sem sair da
    pré-marcação) e a linha caía no grupo `preenchimentos` — DOBRADO, FECHADO e
    PRÉ-MARCADO, sob a frase "N músicas sem título ou artista vão receber o
    nome que está no arquivo". Frase falsa para essa música: ela TEM título, e
    a pessoa o vê na biblioteca. Um clique levava o título embora sem que a
    revisão o tivesse mostrado.

    Agora o predicado exige o slot nos dois lados, e o desfecho é o oposto:
    "Diversos" é título REAL, o funil não tem o que propor, e não há linha
    nenhuma. Nada a apagar é melhor que um aviso sobre o apagamento.
  */
  it("título 'Diversos' é título real: não há proposta, e nada se perde", async () => {
    await backend.addFolder("/musicas/teste");
    const songs = await backend.listSongs();
    const song = songs.find((s) => s.title === "Instrumental Sem Letra")!;
    // sem artista: é o caso puro, sem etapa de letra para embaralhar o desfecho
    await backend.writeTags(song.id, "Diversos", null, null, null);
    const propostas = await varrer(backend, "", "s1");
    expect(propostas.map((p) => p.song_id)).not.toContain(song.id);
  });

  /*
    E quando o som discorda, o título "Diversos" vai para o CONFLITO — o topo
    da revisão, com os dois lados nomeados —, e não para o grupo dobrado. Era
    exatamente este caminho que engolia o título: como placeholder ele não
    contradizia nada, então o som PREENCHIA por cima em silêncio.
  */
  it("com o som discordando, 'Diversos' no título abre CONFLITO", async () => {
    await backend.addFolder("/musicas/teste");
    const songs = await backend.listSongs();
    const song = songs.find((s) => s.title === "Instrumental Sem Letra")!;
    await backend.writeTags(song.id, "Diversos", null, null, null);
    backend._acessorio.estado = "pronto";
    backend._ensinarSom(song.file_path, {
      titulo: "Asa Branca",
      artista: "Luiz Gonzaga",
      confianca: "alta",
    });
    const propostas = await varrer(backend, "", "s1");
    const linha = propostas.find((p) => p.song_id === song.id)!;
    expect(linha.conflito).not.toBeNull();
    expect(grupoDaProposta(linha, null)).toBe("conflitos");
    // e o título que a pessoa vê continua intocado na proposta
    expect(linha.current_title).toBe("Diversos");
  });

  /*
    O ESPELHO, e é ele que mostra que a regra não foi só apagada: no slot do
    ARTISTA o rótulo continua sendo nome de ninguém. O som não contradiz — ele
    PREENCHE, que é o que a decisão 105 existia para conseguir.
  */
  it("'Various Artists' no artista não é conflito: o som preenche", async () => {
    await backend.addFolder("/musicas/teste");
    const songs = await backend.listSongs();
    const song = songs.find((s) => s.title === "Instrumental Sem Letra")!;
    await backend.writeTags(song.id, "Asa Branca", "Various Artists", null, null);
    backend._acessorio.estado = "pronto";
    backend._ensinarSom(song.file_path, {
      titulo: "Asa Branca",
      artista: "Luiz Gonzaga",
      confianca: "alta",
    });
    const propostas = await varrer(backend, "", "s1");
    const linha = propostas.find((p) => p.song_id === song.id)!;
    expect(linha.conflito).toBeNull();
    expect(linha.proposed_artist).toBe("Luiz Gonzaga");
    // preencher campo vazio não é trocar nome escrito (DECISIONS #53)
    expect(linha.substitui_nome_escrito).toBe(false);
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

// ---------------------------------------------------------------------------
// Regra 6 — a etapa 5 NÃO propõe nome: ela ECOA o arquivo (QA A2)
// ---------------------------------------------------------------------------
//
// Duas correções, e o par mudou de lado no meio do caminho.
//
// O mock devolvia `proposed_* = atual` com um comentário chamando isso de
// "garantia de construção", e o Rust fazia o contrário: `proposta_baixa`, ou
// seja, o palpite do NOME DO ARQUIVO. Rodado pelo QA numa música típica da
// etapa 5, `AudioTrack 03` / None saía `Oh! Chuva` / `Falamansa` sob o rótulo
// da transcrição. O comentário dos dois lados afirmava o oposto do código.
//
// O backend resolveu tirando o NOME em vez de corrigir os textos, e o
// argumento é de medição: **o palpite já foi entregue**. A etapa 1 roda em
// TODAS as músicas da pasta (DECISIONS #102) e `sem_letra_no_fim` sai da mesma
// varredura, então toda música que chega à etapa 5 já tem a sua linha de
// "preencher o branco" na MESMA revisão. Repetir aqui é a mesma conta sobre o
// mesmo nome de arquivo, cobrando uma segunda leitura de quem já vai conferir
// 47 letras de máquina.
//
// O que sai é o ECO do que está no arquivo — e o eco não pode ser vazio: o
// `apply` grava `ap.title` como veio, e título vazio APAGARIA a etiqueta.
describe("contrato mock × Rust — a etapa 5 ecoa o nome (QA A2)", () => {
  let backend: MockBackend;

  beforeEach(() => {
    localStorage.clear();
    backend = createMockBackend();
  });

  /**
   * Uma música sem letra, com etiqueta de ripador no título — a candidata
   * típica da etapa 5. Devolve o registro depois da regravação.
   */
  async function comEtiquetaDeRipador(artista: string | null) {
    // a etapa 5 só existe com os dois acessórios prontos
    backend._estadoDoAcessorio("whisper-cli", "pronto");
    backend._estadoDoAcessorio("modelo-de-transcricao-grande", "pronto");
    await backend.addFolder("/musicas/teste");
    const songs = await backend.listSongs();
    const song = songs.find((s) => s.file_path === "/musicas/teste/sem_letra.mp3")!;
    await backend.writeTags(song.id, "AudioTrack 03", artista, null, null);
    return song;
  }

  it("ecoa a etiqueta do arquivo, mesmo quando ela é placeholder", async () => {
    const song = await comEtiquetaDeRipador(null);
    backend._ensinarTranscricao(song.file_path, {
      instrumental: "20 caracteres em 5m00s dão 0,07 caractere por segundo",
    });
    const { propostas } = await backend.transcreverMusicas([song.id], "t1");
    const p = propostas[0];
    // o palpite "sem letra" NÃO aparece aqui: a etapa 1 já o entregou, na
    // mesma revisão, sob o rótulo que o anuncia
    expect(p.current_title).toBe("AudioTrack 03");
    expect(p.proposed_title).toBe("AudioTrack 03");
    expect(p.proposed_artist).toBeNull();
    expect(p.marcar_instrumental).toBe(true);
    expect(p.substitui_nome_escrito).toBe(false);
  });

  it("etiqueta REAL também é ecoada, sem ganhar nem perder nada", async () => {
    const song = await comEtiquetaDeRipador("Falamansa");
    backend._ensinarTranscricao(song.file_path, {
      letra: "chove chuva",
      refrao: "chove chuva",
    });
    const { propostas } = await backend.transcreverMusicas([song.id], "t1");
    const p = propostas[0];
    expect(p.proposed_title).toBe("AudioTrack 03");
    expect(p.proposed_artist).toBe("Falamansa");
    expect(p.lyrics).toBe("chove chuva");
  });

  // A linha que não se aplica (adiada ou falha) sai do mesmo lugar: ela
  // informa, e o nome que carrega é o do arquivo.
  it("a linha que só informa carrega o mesmo eco", async () => {
    const song = await comEtiquetaDeRipador(null);
    backend._ensinarTranscricao(song.file_path, { erro: "o motor não respondeu" });
    const { propostas } = await backend.transcreverMusicas([song.id], "t1");
    const p = propostas[0];
    expect(p.error).toBe("o motor não respondeu");
    expect(p.proposed_title).toBe("AudioTrack 03");
  });

  /*
    O eco NÃO pode ser vazio. O `apply` grava `ap.title` como veio, e o Rust
    guarda o palpite da etapa 1 justamente para este caso: música cuja etiqueta
    de título é string vazia no banco. Sem esta trava a etapa 5 apagaria a
    única coisa que a biblioteca tinha para mostrar.
  */
  it("título vazio no banco cai no palpite, e não em string vazia", async () => {
    backend._estadoDoAcessorio("whisper-cli", "pronto");
    backend._estadoDoAcessorio("modelo-de-transcricao-grande", "pronto");
    await backend.addFolder("/musicas/teste");
    const songs = await backend.listSongs();
    const song = songs.find((s) => s.file_path === "/musicas/teste/sem_letra.mp3")!;
    // o `writeTags` recusa título vazio (e é bom que recuse): o estado só
    // chega ao banco por indexação de MP3 sem TIT2
    backend._forcarTituloVazio(song.file_path);
    backend._ensinarTranscricao(song.file_path, {
      letra: "chove chuva",
      refrao: null,
    });
    const { propostas } = await backend.transcreverMusicas([song.id], "t1");
    expect(propostas[0].proposed_title).toBe("sem letra");
  });
});

// ---------------------------------------------------------------------------
// Regra 7 — quem entra em `sem_letra_no_fim` (QA M3)
// ---------------------------------------------------------------------------
//
// O predicado virou `a_etapa_5_tem_o_que_fazer` no Rust, e ganhou uma
// condição que o mock não tinha: **o arquivo precisa existir**. A música cujo
// MP3 sumiu do disco inflava o total e o tempo estimado da pergunta do fim, e
// depois gastava uma vaga da fila para produzir uma linha de erro — a única
// coisa que a etapa 5 consegue fazer com um arquivo que não está lá.
//
// Erro de REDE não tira ninguém da lista, e é de propósito: a etapa 5 não usa
// rede. A música que ficou sem letra porque o LRCLIB não respondeu é
// exatamente a que a transcrição resolve.
describe("contrato mock × Rust — sem_letra_no_fim (QA M3)", () => {
  let backend: MockBackend;

  beforeEach(() => {
    localStorage.clear();
    backend = createMockBackend();
  });

  it("arquivo que sumiu do disco não entra na conta da pergunta do fim", async () => {
    await backend.addFolder("/musicas/teste");
    const songs = await backend.listSongs();
    const sumida = songs.find((s) => s.file_path === "/musicas/teste/sem_letra.mp3")!;
    const inteira = songs.find((s) => s.file_path === "/musicas/teste/sem_tags.mp3")!;
    backend._removeFileFromDisk(sumida.file_path);
    const r = await backend.enrichFolderScan("", "s1");
    expect(r.sem_letra_no_fim).not.toContain(sumida.id);
    expect(r.sem_letra_no_fim).toContain(inteira.id);
  });

  // A rede fora do ar deixa TODO MUNDO sem letra, e todo mundo continua na
  // lista: é o caso em que a etapa 5 mais vale a pena.
  it("sem conexão, quem ficou sem letra continua na conta", async () => {
    await backend.addFolder("/musicas/teste");
    backend._offline = true;
    const r = await backend.enrichFolderScan("", "s1");
    const songs = await backend.listSongs();
    const semLetra = songs.filter((s) => !s.has_lyrics).map((s) => s.id);
    expect([...r.sem_letra_no_fim].sort()).toEqual([...semLetra].sort());
  });
});

// ---------------------------------------------------------------------------
// Regra 8 — a SEGUNDA porta da etapa 5 (V10.6)
// ---------------------------------------------------------------------------
//
// `transcricaoPendentes` responde "quais músicas estão sem letra" sem varredura
// nenhuma, porque isso é fato permanente da biblioteca e não resultado de uma
// tela. Se o mock aplicasse aqui uma regra diferente da do `sem_letra_no_fim`,
// o E2E certificaria um bloco de Configurações que oferece um trabalho que a
// fila não vai fazer — a família de divergências da DECISIONS #88.
describe("contrato mock × Rust — a porta permanente da etapa 5 (V10.6)", () => {
  let backend: MockBackend;

  beforeEach(() => {
    localStorage.clear();
    backend = createMockBackend();
  });

  it("devolve exatamente o que a varredura devolveria, sem varrer", async () => {
    await backend.addFolder("/musicas/teste");
    // sem rede a varredura não acha letra nenhuma, e é aí que as duas portas
    // descrevem o MESMO instante — a comparação de maçã com maçã
    backend._offline = true;
    const r = await backend.enrichFolderScan("", "s1");
    const p = await backend.transcricaoPendentes("");
    expect(p.musicas).toEqual(r.sem_letra_no_fim);
    expect(p.segundos_estimados).toBe(r.segundos_de_transcricao);
    expect(p.estimativa_medida_nesta_maquina).toBe(
      r.estimativa_medida_nesta_maquina,
    );
  });

  /**
   * **O que difere entre as duas portas é o MOMENTO, não a regra.**
   *
   * A pergunta do fim desconta quem acabou de ganhar uma proposta de letra
   * naquela varredura (`proposta.lyrics !== null`): oferecer a transcrição de
   * uma música cuja letra está ali na lista, esperando um clique, seria cobrar
   * minutos de CPU por algo que um clique resolve.
   *
   * A porta permanente não tem varredura a descontar: ela responde o fato de
   * AGORA, que é o que uma tela permanente pode afirmar. Aplicada a proposta, o
   * fato muda e o número dela cai sozinho — é o mesmo predicado, num instante
   * diferente.
   */
  it("a pergunta do fim desconta a letra que a varredura ACHOU; a porta permanente responde o agora", async () => {
    await backend.addFolder("/musicas/teste");
    const r = await backend.enrichFolderScan("", "s1");
    const p = await backend.transcricaoPendentes("");
    const achou = r.propostas.filter((x) => x.lyrics !== null).map((x) => x.song_id);
    expect(achou.length).toBeGreaterThan(0);
    for (const id of achou) {
      expect(r.sem_letra_no_fim).not.toContain(id);
      expect(p.musicas).toContain(id);
    }
    // aplicada a letra, as duas voltam a dizer a mesma coisa
    const proposta = r.propostas.find((x) => x.lyrics !== null)!;
    await backend.enrichApply([
      {
        song_id: proposta.song_id,
        title: proposta.proposed_title,
        artist: proposta.proposed_artist,
        lyrics: proposta.lyrics,
        add_temas: null,
        current_title: proposta.current_title,
        current_artist: proposta.current_artist,
        fonte: proposta.fonte,
      },
    ]);
    expect((await backend.transcricaoPendentes("")).musicas).toEqual(
      r.sem_letra_no_fim,
    );
  });

  it("os portões da etapa 5 valem inteiros: instrumental, letra e arquivo", async () => {
    await backend.addFolder("/musicas/teste");
    const songs = await backend.listSongs();
    const sumida = songs.find((s) => s.file_path === "/musicas/teste/sem_letra.mp3")!;
    const fica = songs.find((s) => s.file_path === "/musicas/teste/sem_tags.mp3")!;
    backend._removeFileFromDisk(sumida.file_path);
    const p = await backend.transcricaoPendentes("");
    expect(p.musicas).toEqual([fica.id]);
    // com letra escrita, ela sai da lista — o fato mudou, e a porta responde
    // o fato de AGORA
    await backend.writeTags(fica.id, "Oh! Chuva", "Falamansa", "chove chuva", null);
    expect((await backend.transcricaoPendentes("")).musicas).toEqual([]);
  });

  it("`disponivel` é o mesmo fato que a contagem reporta", async () => {
    await backend.addFolder("/musicas/teste");
    expect((await backend.transcricaoPendentes("")).disponivel).toBe(false);
    expect((await backend.enrichCount("")).transcricao_disponivel).toBe(false);
    backend._estadoDoAcessorio("whisper-cli", "pronto");
    backend._estadoDoAcessorio("modelo-de-transcricao-grande", "pronto");
    expect((await backend.transcricaoPendentes("")).disponivel).toBe(true);
    expect((await backend.enrichCount("")).transcricao_disponivel).toBe(true);
  });

  it("o prefixo de pasta é o mesmo da varredura e da contagem", async () => {
    await backend.addFolder("/musicas/teste");
    const dentro = await backend.transcricaoPendentes("/musicas/teste");
    const fora = await backend.transcricaoPendentes("/lugar/nenhum");
    expect(dentro.musicas.length).toBeGreaterThan(0);
    expect(fora.musicas).toEqual([]);
    expect(fora.segundos_estimados).toBe(0);
  });
});

/*
  V10.9 — A TERCEIRA PORTA DA ETAPA 5: uma música só, na ficha do editor.

  O funil individual roda as etapas 1 a 4 e para ali. Com 3% de cobertura
  medida, "as quatro etapas não acharam nada" é o desfecho TÍPICO daquele
  clique — e a única coisa que resolveria aquela música ficava a duas telas de
  distância, numa fila que é a pasta inteira.

  O que este bloco guarda é a metade TypeScript do par da DECISIONS #88: a porta
  de uma música não pode ser uma SEGUNDA regra sobre o que a etapa 5 transcreve.
  A metade Rust está em `tests/enrich.rs`
  (`a_porta_de_uma_musica_diz_o_mesmo_que_a_porta_da_pasta_diria_dela`).
*/
describe("contrato mock × Rust — a porta da etapa 5 numa música só (V10.9)", () => {
  let backend: MockBackend;

  beforeEach(() => {
    localStorage.clear();
    backend = createMockBackend();
  });

  it("é a porta da pasta, num escopo de uma música", async () => {
    await backend.addFolder("/musicas/teste");
    const daPasta = await backend.transcricaoPendentes("");
    expect(daPasta.musicas.length).toBeGreaterThan(0);

    // cada id que a porta da pasta lista é uma fila de UM item na porta da
    // ficha, e a soma dos tempos é o tempo da pasta: uma conta só
    let soma = 0;
    for (const id of daPasta.musicas) {
      const uma = await backend.transcricaoPendentesDaMusica(id);
      expect(uma.musicas).toEqual([id]);
      expect(uma.estimativa_medida_nesta_maquina).toBe(
        daPasta.estimativa_medida_nesta_maquina,
      );
      expect(uma.disponivel).toBe(daPasta.disponivel);
      soma += uma.segundos_estimados;
    }
    expect(soma).toBe(daPasta.segundos_estimados);
  });

  /*
    Os portões valem inteiros — MENOS UM, e ele é o item inteiro da V10.11.

    Instrumental e arquivo que sumiu do disco continuam fora, aqui como na porta
    da pasta. A música que JÁ TEM LETRA passa: a DECISIONS #167 dizia o
    contrário, e o dono a reverteu com o caso do beta tester que abriu uma
    música cuja letra terminava em `[MÚSICA]` — letra de transcrição,
    imperfeita — e queria exatamente refazê-la.
  */
  it("os portões são os mesmos, menos o da letra — e a ficha não inventa nenhum", async () => {
    await backend.addFolder("/musicas/teste");
    const songs = await backend.listSongs();
    const semLetra = songs.find(
      (s) => s.file_path === "/musicas/teste/sem_letra.mp3",
    )!;
    const comLetra = songs.find((s) => s.has_lyrics)!;
    const sumida = songs.find(
      (s) => s.file_path === "/musicas/teste/sem_tags.mp3",
    )!;
    backend._removeFileFromDisk(sumida.file_path);

    expect((await backend.transcricaoPendentesDaMusica(semLetra.id)).musicas).toEqual(
      [semLetra.id],
    );
    const sumiu = await backend.transcricaoPendentesDaMusica(sumida.id);
    expect(sumiu.musicas).toEqual([]);
    expect(sumiu.segundos_estimados).toBe(0);

    // e a marca de instrumental tira a música da fila, como nas outras portas
    await backend.writeTags(semLetra.id, "Chorinho", "Regional", null, null, true);
    expect((await backend.transcricaoPendentesDaMusica(semLetra.id)).musicas).toEqual(
      [],
    );

    // o portão que esta porta NÃO tem (V10.11)
    expect((await backend.transcricaoPendentesDaMusica(comLetra.id)).musicas).toEqual(
      [comLetra.id],
    );
    // e a porta da PASTA continua pulando essa mesma música (DECISIONS #136)
    expect((await backend.transcricaoPendentes("")).musicas).not.toContain(
      comLetra.id,
    );
  });

  /*
    A SOMA SÓ FECHA SOBRE QUEM A PORTA DA PASTA LISTA — e é por isso que o teste
    de cima ("é a porta da pasta, num escopo de uma música") percorre a lista
    DELA. Somar a biblioteca inteira, música por música, daria mais que o tempo
    da pasta a partir da V10.11, e daria de propósito: quem tem letra entra numa
    porta e não na outra.
  */
  it("a fila da ficha transcreve, e a substituição continua pedindo consentimento", async () => {
    await backend.addFolder("/musicas/teste");
    backend._estadoDoAcessorio("whisper-cli", "pronto");
    backend._estadoDoAcessorio("modelo-de-transcricao-grande", "pronto");
    const songs = await backend.listSongs();
    const comLetra = songs.find((s) => s.has_lyrics)!;
    backend._ensinarTranscricao(comLetra.file_path, {
      letra: "a letra refeita ouvindo o áudio",
      refrao: null,
    });

    const { propostas } = await backend.transcreverMusicas(
      (await backend.transcricaoPendentesDaMusica(comLetra.id)).musicas,
      "scan-1",
    );
    expect(propostas).toHaveLength(1);
    expect(propostas[0].error).toBeNull();
    expect(propostas[0].lyrics).toBe("a letra refeita ouvindo o áudio");
    // o eco diz que já há letra: é ele que faz a revisão pedir a marcação
    expect(propostas[0].has_lyrics).toBe(true);

    // e sem a marcação o `apply` recusa — nada é sobrescrito sem clique (#79)
    const [res] = await backend.enrichApply([
      {
        song_id: comLetra.id,
        title: comLetra.title,
        artist: comLetra.artist,
        lyrics: "a letra refeita ouvindo o áudio",
        add_temas: null,
        current_title: comLetra.title,
        current_artist: comLetra.artist,
        fonte: null,
        substituir_letra: false,
        marcar_instrumental: false,
      },
    ]);
    expect(res.error).toContain("substituir a letra atual");
  });

  // Id que saiu do acervo entre o clique e a resposta não é erro: é uma música
  // sem nada a transcrever. Uma falha inventada por nós seria pior.
  it("id que não existe devolve fila vazia, e não erro", async () => {
    await backend.addFolder("/musicas/teste");
    const p = await backend.transcricaoPendentesDaMusica(999_999);
    expect(p.musicas).toEqual([]);
    expect(p.segundos_estimados).toBe(0);
  });

  it("`disponivel` é o mesmo fato que as outras portas reportam", async () => {
    await backend.addFolder("/musicas/teste");
    const songs = await backend.listSongs();
    const alvo = songs.find((s) => !s.has_lyrics)!;
    expect((await backend.transcricaoPendentesDaMusica(alvo.id)).disponivel).toBe(
      false,
    );
    backend._estadoDoAcessorio("whisper-cli", "pronto");
    backend._estadoDoAcessorio("modelo-de-transcricao-grande", "pronto");
    expect((await backend.transcricaoPendentesDaMusica(alvo.id)).disponivel).toBe(
      true,
    );
    expect((await backend.enrichCount("")).transcricao_disponivel).toBe(true);
  });
});

/*
  V10.8 — O DESFECHO QUE DIZ O QUE FOI FEITO.

  Sete arquivos de um acervo real recusavam toda gravação: a etiqueta ID3v2
  declarava terminar antes do primeiro quadro MPEG, e o lofty, que reexamina o
  formato pelo conteúdo ao gravar, não achava o áudio dentro do teto de bytes de
  lixo dele. O conserto (corrigir o campo de tamanho da etiqueta) acontece JUNTO
  com a gravação que a pessoa pediu, sem pergunta e sem clique a mais — e o
  desfecho conta que aconteceu.

  Este bloco é a metade TypeScript do par: a FRASE é fixada aqui como dado, e a
  mesma frase é fixada no Rust (`cada_familia_tem_a_sua_frase_e_ela_cabe_na_regua`
  em `src-tauri/src/writer.rs`). Mudar a frase de um lado quebra o teste daquele
  lado, e divergir passa a exigir apagar um teste em vez de acontecer por
  esquecimento (DECISIONS #88).
*/
describe("V10.8 — a etiqueta normalizada, e o desfecho que a conta", () => {
  let backend: MockBackend;

  beforeEach(() => {
    localStorage.clear();
    backend = createMockBackend();
  });

  /** A frase, letra por letra, como o Rust a escreve. */
  const FRASE_DO_RUST =
    "para conseguir gravar, o programa corrigiu uma medida errada por dentro da " +
    "etiqueta deste MP3 — a música em si não foi alterada, e o programa conferiu " +
    "isso depois de gravar";

  it("a frase do mock é a MESMA do writer.rs, letra por letra", () => {
    expect(AVISO_ETIQUETA_NORMALIZADA).toBe(FRASE_DO_RUST);
    // a régua da DECISIONS #100 vale para ela como para as frases de erro: ela é
    // a tela de quem não tem a quem perguntar
    expect(AVISO_ETIQUETA_NORMALIZADA.length).toBeLessThanOrEqual(210);
  });

  it("a gravação PASSA e o resultado traz a frase; a segunda é comum", async () => {
    await backend.addFolder("/musicas/teste");
    const songs = await backend.listSongs();
    const song = songs.find(
      (s) => s.file_path === "/musicas/teste/sem_letra.mp3",
    )!;
    backend._marcarEtiquetaParaNormalizar(song.file_path);

    const aplicacao = {
      song_id: song.id,
      title: "Nome Novo",
      artist: null,
      lyrics: null,
      add_temas: null,
      fonte: null,
      current_title: song.title,
      current_artist: song.artist,
    };
    const [primeira] = await backend.enrichApply([aplicacao]);
    // gravou — o conserto existe para isto
    expect(primeira.song).not.toBeNull();
    expect(primeira.error).toBeNull();
    expect(primeira.aviso).toBe(AVISO_ETIQUETA_NORMALIZADA);

    // a anomalia caiu do arquivo: a segunda gravação não tem nada a contar
    const [segunda] = await backend.enrichApply([
      { ...aplicacao, title: "Outro Nome", current_title: "Nome Novo" },
    ]);
    expect(segunda.song).not.toBeNull();
    expect(segunda.aviso).toBeNull();
  });

  it("a gravação comum não avisa nada, e a que FALHOU também não", async () => {
    await backend.addFolder("/musicas/teste");
    const songs = await backend.listSongs();
    const normal = songs.find(
      (s) => s.file_path === "/musicas/teste/sem_letra.mp3",
    )!;
    const sumida = songs.find(
      (s) => s.file_path === "/musicas/teste/sem_tags.mp3",
    )!;
    backend._removeFileFromDisk(sumida.file_path);

    const resultados = await backend.enrichApply([
      {
        song_id: normal.id,
        title: "Nome Novo",
        artist: null,
        lyrics: null,
        add_temas: null,
        fonte: null,
        current_title: normal.title,
        current_artist: normal.artist,
      },
      {
        song_id: sumida.id,
        title: "Não Vai",
        artist: null,
        lyrics: null,
        add_temas: null,
        fonte: null,
        current_title: sumida.title,
        current_artist: sumida.artist,
      },
    ]);
    expect(resultados[0].aviso).toBeNull();
    expect(resultados[1].song).toBeNull();
    expect(
      resultados[1].aviso,
      "aviso sem gravação não existe: ele descreve o que foi FEITO",
    ).toBeNull();
  });
});
