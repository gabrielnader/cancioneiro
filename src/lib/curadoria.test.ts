import { describe, expect, it } from "vitest";
import type { AcessorioInfo, Contagem, EnrichProposal } from "./api";
import { buildFolderTree } from "./folderTree";
import {
  ACESSORIO_CANCELADO,
  ACESSORIO_CORROMPIDO,
  ACESSORIO_INDETERMINADO,
  ACESSORIO_INDISPONIVEL,
  ACESSORIO_PRONTO,
  ACESSORIO_SEM_BINARIO,
  AVISO_LETRA_DE_MAQUINA,
  AVISO_MARCAR_INSTRUMENTAL,
  AVISO_NOME_ESCRITO,
  EXPLICACAO_DA_CONFIANCA_DO_SOM,
  LABEL_SOM_DIZ,
  LABEL_SUBSTITUIR_LETRA,
  LABEL_SUA_ETIQUETA_DIZ,
  ORDEM_DOS_GRUPOS,
  ROTULO_COMECAR_TRANSCRICAO,
  ROTULO_DA_LINHA_GRAVADA,
  ROTULO_DO_DISPARO,
  SELO_DA_LINHA_GRAVADA,
  SEM_RESULTADO_INDIVIDUAL,
  SEM_RESULTADO_INSTRUMENTAL,
  TRANSCRICAO_NO_FIM,
  agruparPorRisco,
  avisoDeTranscricaoPendente,
  avisoLetraExistente,
  avisoSemPerguntarAoSom,
  compararConflito,
  confiancaDoSom,
  destacarDiferenca,
  downloadParaTranscrever,
  estadoDoAcessorio,
  estimativaTexto,
  etapasDoFunil,
  formatarTamanho,
  grupoDaProposta,
  opcoesDePasta,
  rotuloAceitarSom,
  rotuloBaixarAcessorio,
  rotuloDaMarcacao,
  rotuloDoRefrao,
  textoAplicado,
  textoDaOfertaDeTranscricao,
  textoDaTranscricaoIndisponivel,
  textoDoAcessorioAusente,
  textoDoBlocoDeTranscricao,
  textoDoCabecalho,
  textoDoDownload,
  textoDoGrupoDobrado,
  textoDoProgressoDaTranscricao,
  textoDoTempoDaTranscricao,
  textoSemPropostas,
  tituloDoAcessorio,
  tituloDoGrupo,
  type EstadoDaContagem,
  type EstadoDoAcessorio,
} from "./curadoria";
import { FONTE_TRANSCRICAO, type Folder, type Song } from "./types";

// ---------------------------------------------------------------------------
// Ajudantes
// ---------------------------------------------------------------------------

/** As etapas que o backend lista numa máquina completa (`Contagem.etapas`). */
const ETAPAS_COMPLETAS = [
  "lendo etiquetas e nome do arquivo",
  "reconhecendo pelo som",
  "procurando no LRCLIB",
  "procurando no lyrics.ovh",
];
/**
 * Instalação nova, sem o acessório do som. A etapa 4 continua na lista: ela
 * não pede credencial nenhuma, então existe em toda máquina com internet
 * (V10, DECISIONS #110).
 */
const ETAPAS_BASICAS = [
  "lendo etiquetas e nome do arquivo",
  "procurando no LRCLIB",
  "procurando no lyrics.ovh",
];

function contagem(over: Partial<Contagem> = {}): Contagem {
  return {
    total: 150,
    sem_letra: 80,
    segundos_estimados: 1020,
    etapas: ETAPAS_COMPLETAS,
    transcricao_disponivel: false,
    ...over,
  };
}

/** Contagem já respondida pelo backend (`enrich_count`). */
const pronta = (over: Partial<Contagem> = {}): EstadoDaContagem => ({
  estado: "pronta",
  contagem: contagem(over),
});

/** Atalho da estimativa: o único caminho que existe (V10). */
function estimativa(
  estado: EstadoDaContagem,
  musicasNaPasta: number,
): string {
  return estimativaTexto({ contagem: estado, musicasNaPasta });
}

function song(id: number, filePath: string, over: Partial<Song> = {}): Song {
  return {
    id,
    file_path: filePath,
    folder_id: 1,
    title: `Canção ${id}`,
    artist: "Artista",
    album: null,
    duration_seconds: 100,
    has_lyrics: true,
    available: true,
    ...over,
  };
}

function proposta(over: Partial<EnrichProposal> = {}): EnrichProposal {
  return {
    song_id: 1,
    file_path: "/acervo/a.mp3",
    current_title: "a",
    current_artist: null,
    proposed_title: "Asa Branca",
    proposed_artist: "Luiz Gonzaga",
    lyrics: null,
    has_lyrics: false,
    letra_origem: null,
    confidence: "baixa",
    fonte: "nome do arquivo",
    conflito: null,
    substitui_nome_escrito: false,
    marcar_instrumental: false,
    refrao: null,
    aviso: null,
    error: null,
    ...over,
  };
}

function acessorio(over: Partial<AcessorioInfo> = {}): AcessorioInfo {
  return {
    nome: "fpcalc",
    para_que_serve: "reconhecer a música pelo som",
    arquivo: "fpcalc-linux-x86_64",
    tamanho_bytes: 5_538_312,
    segundos_estimados: 6,
    tempo_medido_nesta_maquina: false,
    executavel: true,
    estado: "ausente",
    origem: "https://github.com/exemplo/releases/download/acessorios-v1/fpcalc",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// A régua da copy (DECISIONS #100): a PRIMEIRA frase diz o que é; o resto só
// existe se responder a uma pergunta que a pessoa faria naquele momento.
// ---------------------------------------------------------------------------

/** Quantas frases um texto tem (aproximação por pontuação final). */
function frases(texto: string): number {
  return texto.split(/[.!?](?:\s|$)/).filter((f) => f.trim() !== "").length;
}

describe("a régua da copy (DECISIONS #100)", () => {
  const TETO_CARACTERES = 210;
  const TETO_FRASES = 2;

  const desfechos: Array<[string, string]> = [
    ["textoSemPropostas(81)", textoSemPropostas(81)],
    ["textoSemPropostas(null)", textoSemPropostas(null)],
    ["SEM_RESULTADO_INDIVIDUAL", SEM_RESULTADO_INDIVIDUAL],
    ["SEM_RESULTADO_INSTRUMENTAL", SEM_RESULTADO_INSTRUMENTAL],
    ["estimativa de 150", estimativa(pronta(), 200)],
    ["aviso de letra existente", avisoLetraExistente("transcricao")],
    // V10 — os textos novos entram na MESMA régua. São eles que aparecem no
    // fim de uma varredura de minutos, que é o pior momento para um parágrafo.
    ["oferta de transcrição", textoDaOfertaDeTranscricao(47, 10_800)],
    [
      "transcrição indisponível",
      textoDaTranscricaoIndisponivel(47, { bytes: 183_000_000, segundos: 183 }),
    ],
    ["aviso de instrumental", AVISO_MARCAR_INSTRUMENTAL],
    ["aviso de letra de máquina", AVISO_LETRA_DE_MAQUINA],
    ["explicação da confiança do som", EXPLICACAO_DA_CONFIANCA_DO_SOM],
    ["transcrição no fim", TRANSCRICAO_NO_FIM],
    // V10.6 — a porta permanente da etapa 5 e o aviso de fechar a revisão
    // entram na MESMA régua: são textos de tela sem suporte, como os outros.
    [
      "bloco de transcrição",
      textoDoBlocoDeTranscricao({
        quantas: 47,
        segundos: 10_800,
        medidaNestaMaquina: false,
        disponivel: true,
        download: null,
        todaABiblioteca: true,
      }),
    ],
    [
      "bloco de transcrição sem os acessórios",
      textoDoBlocoDeTranscricao({
        quantas: 47,
        segundos: 10_800,
        medidaNestaMaquina: false,
        disponivel: false,
        download: { bytes: 1_533_763_059, segundos: 512 },
        todaABiblioteca: true,
      }),
    ],
    ["aviso de transcrição pendente", avisoDeTranscricaoPendente(27)!],
    ["linha gravada", ROTULO_DA_LINHA_GRAVADA],
  ];

  for (const [nome, texto] of desfechos) {
    it(`${nome}: cabe em duas frases e ${TETO_CARACTERES} caracteres`, () => {
      expect(texto.length, texto).toBeLessThanOrEqual(TETO_CARACTERES);
      expect(frases(texto), texto).toBeLessThanOrEqual(TETO_FRASES);
    });
  }

  it("os desfechos não mandam ninguém para as ferramentas de fora", () => {
    for (const [nome, texto] of desfechos) {
      expect(texto.toLowerCase(), nome).not.toContain("ferramentas de curadoria");
    }
  });
});

// ---------------------------------------------------------------------------
// V10 — o caminho único: um botão, e a conta vem pronta do backend
// ---------------------------------------------------------------------------

describe("o caminho único (DECISIONS #102)", () => {
  it("há UM disparo, e o rótulo não pergunta qual trabalho fazer", () => {
    expect(ROTULO_DO_DISPARO).toBe("Buscar dados desta pasta");
    expect(ROTULO_DO_DISPARO.toLowerCase()).not.toContain("conferir");
  });

  // O modelo de custo em TypeScript foi APAGADO: a estimativa vem em
  // `Contagem.segundos_estimados`. Manter uma segunda conta aqui é a
  // DECISIONS #80, que neste projeto já deixou o botão do produto cinza.
  it("a estimativa é o número do backend, formatado — não uma conta daqui", () => {
    // 1020 s = 17 minutos
    expect(estimativa(pronta({ segundos_estimados: 1020 }), 200)).toContain(
      "por volta de 17 minutos",
    );
    // trocar SÓ o número do backend muda a frase inteira
    expect(estimativa(pronta({ segundos_estimados: 30 }), 200)).toContain(
      "menos de 1 minuto",
    );
    expect(estimativa(pronta({ segundos_estimados: 10_800 }), 200)).toContain(
      "por volta de 3 horas",
    );
  });

  it("a etapa 5 é anunciada como pergunta do FIM, não como etapa da lista", () => {
    expect(TRANSCRICAO_NO_FIM).toContain("ouvindo o áudio");
    expect(TRANSCRICAO_NO_FIM.toLowerCase()).toContain("no fim");
    // e o texto não pode mais dizer que isso "não é feito aqui": passou a ser
    expect(TRANSCRICAO_NO_FIM.toLowerCase()).not.toContain("não é feito");
    // V10.6 — e ele não pode mais dizer que a pergunta do fim é a ÚNICA porta:
    // texto que mente sobre o próprio produto é defeito (DECISIONS #100)
    expect(TRANSCRICAO_NO_FIM.toLowerCase()).toContain("qualquer momento");
  });
});

describe("estimativaTexto — o que a pessoa lê ANTES de disparar", () => {
  it("pasta sem música nenhuma: não afirma completude — diz o que fazer em seguida", () => {
    const texto = estimativa(pronta({ total: 0 }), 0);
    expect(texto).toContain("Não há nenhuma música nesta pasta");
    expect(texto).toContain("Adicione uma pasta");
    expect(texto).not.toContain("já têm");
  });

  it("contagem ainda em curso: estado intermediário honesto, sem número", () => {
    expect(estimativa({ estado: "contando" }, 12)).toBe(
      "Contando as músicas desta pasta…",
    );
  });

  it("contagem que não veio: admite, sem transformar isso em impedimento", () => {
    const texto = estimativa({ estado: "indisponivel" }, 12);
    expect(texto).toContain("Não foi possível contar");
    expect(texto).toContain("A busca funciona mesmo assim");
  });

  // Com o caminho único não existe mais "nada a procurar porque está tudo
  // completo": a varredura olha TODAS as músicas disponíveis da pasta. Zero
  // aqui é outra coisa — nenhuma música disponível — e o texto diz isso.
  it("zero candidatas com músicas na pasta: não afirma completude nenhuma", () => {
    const texto = estimativa(pronta({ total: 0 }), 12);
    expect(texto).toContain("Nenhuma música desta pasta está disponível");
    expect(texto).not.toContain("já têm título");
  });

  it("uma música: singular", () => {
    expect(estimativa(pronta({ total: 1, segundos_estimados: 9 }), 12)).toBe(
      "1 música nesta pasta. A busca leva menos de 1 minuto, e bem mais se a" +
        " internet estiver lenta ou fora do ar.",
    );
  });

  it("acervo grande: o texto passa a horas em vez de imprimir 150 minutos", () => {
    expect(
      estimativa(pronta({ total: 1000, segundos_estimados: 11_000 }), 2000),
    ).toContain("por volta de 3 horas");
  });

  it("nunca promete precisão", () => {
    for (const n of [1, 12, 95, 1000]) {
      expect(estimativa(pronta({ total: n }), 2000)).not.toContain("exat");
    }
  });

  // DECISIONS #85: a mitigação é admitir que a ordem de grandeza depende de
  // uma rede que ninguém controla — "bem mais", e a rede FORA DO AR.
  it("admite 'bem mais' e a rede fora do ar", () => {
    const texto = estimativa(pronta(), 200);
    expect(texto).toContain("bem mais se a internet estiver lenta");
    expect(texto).toContain("fora do ar");
  });
});

describe("etapasDoFunil — a lista vem do backend (DECISIONS #101)", () => {
  it("a ordem e os nomes são os que o backend mandou, sem reordenar", () => {
    expect(etapasDoFunil(ETAPAS_COMPLETAS).map((e) => e.nome)).toEqual([
      "Lendo etiquetas e nome do arquivo",
      "Reconhecendo pelo som",
      "Procurando no LRCLIB",
      "Procurando no lyrics.ovh",
    ]);
  });

  // Sem o acessório o backend não manda a etapa do som, e a tela não a lista:
  // listá-la seria prometer trabalho que não vai acontecer.
  it("etapa que o backend não mandou não aparece", () => {
    const nomes = etapasDoFunil(ETAPAS_BASICAS).map((e) => e.nome);
    expect(nomes).toHaveLength(3);
    expect(nomes.join(" ").toLowerCase()).not.toContain("som");
    // ...e a etapa 4 continua lá: ela não depende de nada que a pessoa tenha
    // de providenciar (V10 — o último pedágio de configuração saiu do produto)
    expect(nomes).toContain("Procurando no lyrics.ovh");
  });

  // V10 — a fraqueza desta fonte precisa estar na LISTA, e não só na linha da
  // proposta: ela não devolve o nome da música, então é a única etapa cujo
  // casamento o programa não tem como conferir.
  it("a etapa 4 diz, na lista, que ela não confere a que música a letra pertence", () => {
    const ovh = etapasDoFunil(ETAPAS_COMPLETAS)[3];
    expect(ovh.explicacao.toLowerCase()).toContain("não diz");
    expect(ovh.explicacao.length).toBeLessThanOrEqual(80);
  });

  // Nada do acervo sai da máquina — nem na etapa que "manda o áudio": o que
  // viaja é um resumo acústico. É invariável do produto.
  it("a etapa do som diz o que sai do computador", () => {
    const som = etapasDoFunil(ETAPAS_COMPLETAS)[1];
    expect(som.explicacao).toContain("resumo");
    expect(som.explicacao.toLowerCase()).not.toContain("envia o áudio");
  });

  it("o contraste local x internet continua na lista", () => {
    const etapas = etapasDoFunil(ETAPAS_COMPLETAS);
    expect(etapas[0].explicacao).toContain("sem sair do computador");
    expect(etapas[2].explicacao).toContain("na internet");
  });

  it("cada explicação cabe numa linha", () => {
    for (const e of etapasDoFunil(ETAPAS_COMPLETAS)) {
      expect(e.explicacao.length, e.explicacao).toBeLessThanOrEqual(80);
    }
  });

  // Backend mais novo com uma etapa que esta versão não conhece: mostrar o
  // nome cru é melhor que esconder a etapa ou inventar explicação.
  it("etapa desconhecida aparece com o nome do backend e sem explicação", () => {
    const etapas = etapasDoFunil(["perguntando ao oráculo"]);
    expect(etapas).toEqual([
      { nome: "Perguntando ao oráculo", explicacao: "" },
    ]);
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
  it("nenhuma candidata: não promete o que não foi feito", () => {
    const texto = textoSemPropostas(0);
    expect(texto).toContain("Nenhuma música desta pasta entrou na busca");
  });

  it("com candidatas conferidas: conta o que houve e nega a completude", () => {
    const texto = textoSemPropostas(81);
    expect(texto).toContain("Conferimos as 81 músicas desta pasta");
    expect(texto).toContain("não achamos nada");
    expect(texto).toContain("não significa pasta completa");
  });

  // MÉDIO-11 — `scannedTotal` vinha de `progress?.total ?? 0`, e o `catch` da
  // assinatura é silencioso: 95 músicas conferidas reportavam "0" e a tela
  // dizia que a pasta estava completa. `null` = não sabemos quantas.
  it("sem saber quantas foram conferidas: não inventa número nem completude", () => {
    const texto = textoSemPropostas(null);
    expect(texto).toContain("A busca terminou sem nenhuma proposta");
    expect(texto).toContain("não significa pasta completa");
    expect(texto).not.toMatch(/\d+ músicas/);
  });

  it("uma candidata só: singular", () => {
    expect(textoSemPropostas(1)).toContain(
      "Conferimos a única música desta pasta",
    );
  });

  it("o caso pontual do editor recebe o mesmo cuidado", () => {
    expect(SEM_RESULTADO_INDIVIDUAL).toContain("Isso é comum");
    expect(SEM_RESULTADO_INDIVIDUAL).not.toContain("completa");
    expect(SEM_RESULTADO_INDIVIDUAL).toContain("nada novo");
  });

  it("instrumental tem o seu próprio desfecho, e o caminho de volta", () => {
    expect(SEM_RESULTADO_INSTRUMENTAL).toContain("instrumental");
    expect(SEM_RESULTADO_INSTRUMENTAL).toContain("título e artista");
    expect(SEM_RESULTADO_INSTRUMENTAL).toContain("desmarque");
  });
});

// ---------------------------------------------------------------------------
// QA A2 — as músicas que a etapa 2 deixou de perguntar
// ---------------------------------------------------------------------------

describe("avisoSemPerguntarAoSom (QA A2)", () => {
  it("zero não merece texto nenhum", () => {
    expect(avisoSemPerguntarAoSom(0)).toBeNull();
    expect(avisoSemPerguntarAoSom(-1)).toBeNull();
  });

  it("diz o NÚMERO, que é a razão de o campo existir", () => {
    expect(avisoSemPerguntarAoSom(37)).toContain("37");
    expect(avisoSemPerguntarAoSom(1)).toContain("1 música");
  });

  it("singular e plural concordam", () => {
    expect(avisoSemPerguntarAoSom(1)).toContain("não chegou a ser perguntada");
    expect(avisoSemPerguntarAoSom(2)).toContain("não chegaram a ser perguntadas");
  });

  it("diz o que fazer em seguida, sem chutar a causa", () => {
    const t = avisoSemPerguntarAoSom(37)!;
    expect(t.toLowerCase()).toContain("repita");
    expect(t.toLowerCase()).not.toContain("antivírus");
    expect(t.toLowerCase()).not.toContain("baixe");
  });

  it("cabe na régua: 2 frases, 210 caracteres", () => {
    for (const n of [1, 37, 1999]) {
      const t = avisoSemPerguntarAoSom(n)!;
      expect(t.length, t).toBeLessThanOrEqual(210);
      expect(frases(t), t).toBeLessThanOrEqual(2);
    }
  });
});

describe("textoSemPropostas com a etapa 2 desligada no meio (QA A2)", () => {
  it("para de afirmar que conferiu o que não perguntou", () => {
    const texto = textoSemPropostas(40, 37);
    expect(texto).toContain("37");
    expect(texto).not.toContain("Conferimos as 40");
    expect(texto.toLowerCase()).toContain("repita");
  });

  it("com zero, o desfecho é exatamente o de antes", () => {
    expect(textoSemPropostas(40, 0)).toBe(textoSemPropostas(40));
  });

  it("funciona mesmo sem o total do progresso", () => {
    expect(textoSemPropostas(null, 37)).toContain("37");
  });

  it("continua dentro da régua", () => {
    const t = textoSemPropostas(150, 149);
    expect(t.length, t).toBeLessThanOrEqual(210);
    expect(frases(t), t).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// V10 — a revisão ordenada por RISCO (o coração desta rodada)
// ---------------------------------------------------------------------------
//
// Medição de campo, com 53 músicas revisadas: "eu nem li as sugestões em
// baixa — não deu vontade de ler mesmo". O corte por CONFIANÇA junta o mais
// seguro (preencher um campo vazio) com o mais perigoso (trocar um nome que
// alguém escreveu), e por isso a lista inteira parece ruído.

describe("grupoDaProposta — o corte é por risco, não por confiança", () => {
  it("conflito vem primeiro, mesmo trazendo letra ou nome novo", () => {
    const p = proposta({
      conflito: { titulo: "Meninos", artista: "Xangai", confianca: "alta" },
      substitui_nome_escrito: true,
    });
    expect(grupoDaProposta(p, null)).toBe("conflitos");
  });

  it("letra encontrada é o que a pessoa mais quer ver", () => {
    expect(grupoDaProposta(proposta({ lyrics: "ai ai" }), null)).toBe("letras");
  });

  it("marcar instrumental é decisão própria, não 'letra encontrada'", () => {
    expect(grupoDaProposta(proposta({ marcar_instrumental: true }), null)).toBe(
      "sem-voz",
    );
  });

  it("troca de nome escrito por gente tem linha própria", () => {
    expect(
      grupoDaProposta(proposta({ substitui_nome_escrito: true }), null),
    ).toBe("nomes-escritos");
  });

  // O grupo dobrado: só preenche campo VAZIO. Não havia nada a perder.
  it("preencher campo vazio é o grupo dobrado", () => {
    expect(grupoDaProposta(proposta(), null)).toBe("preenchimentos");
  });

  // Uma linha com erro não é proposta: ela informa que a música foi tentada e
  // falhou. Se caísse no grupo dobrado, seria dobrada E pré-marcada.
  it("linha com erro nunca entra no grupo dobrado", () => {
    expect(grupoDaProposta(proposta({ error: "sem conexão" }), null)).toBe("erros");
    // erro devolvido pelo APPLY (não pela varredura) vale o mesmo
    expect(grupoDaProposta(proposta(), "a música mudou")).toBe("erros");
  });

  // A confiança continua existindo como INFORMAÇÃO na linha, mas não decide
  // grupo nenhum: baixa não quer dizer "provavelmente errado", quer dizer
  // "sem prova externa".
  it("a confiança não muda o grupo", () => {
    for (const c of ["alta", "media", "baixa"] as const) {
      expect(grupoDaProposta(proposta({ confidence: c }), null)).toBe(
        "preenchimentos",
      );
    }
  });
});

describe("agruparPorRisco — a ordem de cima para baixo", () => {
  it("a ordem é conflitos, letras, sem voz, nomes escritos, dobrado, erros, gravadas", () => {
    expect(ORDEM_DOS_GRUPOS).toEqual([
      "conflitos",
      "letras",
      "sem-voz",
      "nomes-escritos",
      "preenchimentos",
      "erros",
      // V10.6 — fecha a lista: é o único grupo sem nada a decidir
      "gravadas",
    ]);
  });

  /*
    V10.6 — a linha JÁ GRAVADA sai do grupo dela e vai para o fim, e isso não é
    arrumação: a frase do grupo dobrado diz "vão receber o nome que está no
    arquivo", e sobre uma linha já gravada isso é mentira. Com o grupo próprio, a
    contagem de cada grupo volta a medir o que FALTA.
  */
  it("gravada vence qualquer outro grupo, e o dobrado volta a contar só o que falta", () => {
    const propostas = [
      proposta({ song_id: 1 }),
      proposta({ song_id: 2 }),
      proposta({ song_id: 3, lyrics: "ai" }),
    ];
    const grupos = agruparPorRisco(
      propostas,
      () => null,
      (i) => i === 0,
    );
    expect(grupos.map((g) => g.grupo)).toEqual([
      "letras",
      "preenchimentos",
      "gravadas",
    ]);
    expect(grupos.find((g) => g.grupo === "preenchimentos")!.propostas).toHaveLength(
      1,
    );
    expect(textoDoGrupoDobrado(
      grupos.find((g) => g.grupo === "preenchimentos")!.propostas,
    )).toContain("1 música sem título ou artista vai receber");
    expect(tituloDoGrupo("gravadas", 1)).toBe("1 música gravada no arquivo");
    expect(tituloDoGrupo("gravadas", 28)).toBe("28 músicas gravadas no arquivo");
  });

  // Gravada vence até o ERRO: a linha que falhou e depois gravou tem um
  // desfecho só, e é o último.
  it("gravada vence o erro", () => {
    expect(
      grupoDaProposta(proposta({ error: "sem conexão" }), "falhou", true),
    ).toBe("gravadas");
  });

  it("agrupa preservando a ordem de risco e a ordem dentro de cada grupo", () => {
    const propostas = [
      proposta({ song_id: 1 }),
      proposta({ song_id: 2, lyrics: "ai" }),
      proposta({ song_id: 3, substitui_nome_escrito: true }),
      proposta({ song_id: 4, conflito: { titulo: "t", artista: "a", confianca: "alta" } }),
      proposta({ song_id: 5, lyrics: "oh" }),
      proposta({ song_id: 6, error: "sem conexão" }),
      proposta({ song_id: 7, marcar_instrumental: true }),
    ];
    expect(
      agruparPorRisco(propostas, () => null).map((g) => [
        g.grupo,
        g.propostas.map((p) => p.song_id),
      ]),
    ).toEqual([
      ["conflitos", [4]],
      ["letras", [2, 5]],
      ["sem-voz", [7]],
      ["nomes-escritos", [3]],
      ["preenchimentos", [1]],
      ["erros", [6]],
    ]);
  });

  it("grupo vazio não vira cabeçalho vazio", () => {
    expect(agruparPorRisco([proposta()], () => null).map((g) => g.grupo)).toEqual([
      "preenchimentos",
    ]);
  });
});

describe("os títulos dos grupos", () => {
  it("cada grupo diz o que é, com o número", () => {
    expect(tituloDoGrupo("conflitos", 3)).toBe(
      "3 músicas em que o som discorda da etiqueta",
    );
    expect(tituloDoGrupo("conflitos", 1)).toBe(
      "1 música em que o som discorda da etiqueta",
    );
    expect(tituloDoGrupo("letras", 12)).toBe("12 letras encontradas");
    expect(tituloDoGrupo("letras", 1)).toBe("1 letra encontrada");
    expect(tituloDoGrupo("sem-voz", 2)).toBe("2 músicas sem voz no áudio");
    expect(tituloDoGrupo("sem-voz", 1)).toBe("1 música sem voz no áudio");
    expect(tituloDoGrupo("nomes-escritos", 4)).toBe(
      "4 trocas de nome que já estava escrito",
    );
    expect(tituloDoGrupo("nomes-escritos", 1)).toBe(
      "1 troca de nome que já estava escrito",
    );
    expect(tituloDoGrupo("erros", 4)).toBe(
      "4 músicas não puderam ser consultadas — o motivo está em cada linha",
    );
    expect(tituloDoGrupo("erros", 1)).toBe(
      "1 música não pôde ser consultada — o motivo está na linha dela",
    );
  });

  it("nenhum título usa o vocabulário de confiança", () => {
    for (const grupo of ORDEM_DOS_GRUPOS) {
      const t = tituloDoGrupo(grupo, 3).toLowerCase();
      expect(t, t).not.toContain("confiança");
      expect(t, t).not.toContain("baixa");
    }
  });
});

// O grupo dobrado é a resposta ao "não deu vontade de ler": 72 linhas iguais
// viram UMA linha que diz o que o clique fará. Dobrado NÃO é escondido —
// continua visível, abrível e desmarcável.
describe("textoDoGrupoDobrado — a frase que É a conferência", () => {
  const doArquivo = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      proposta({ song_id: i + 1, fonte: "nome do arquivo" }),
    );

  it("diz quantas são e o que vai acontecer com elas", () => {
    expect(textoDoGrupoDobrado(doArquivo(72))).toBe(
      "72 músicas sem título ou artista vão receber o nome que está no arquivo",
    );
  });

  it("singular", () => {
    expect(textoDoGrupoDobrado(doArquivo(1))).toBe(
      "1 música sem título ou artista vai receber o nome que está no arquivo",
    );
  });

  // Nem todo preenchimento vem do nome do arquivo: o som também preenche
  // campo vazio. Prometer "o nome que está no arquivo" para 5 linhas que vêm
  // do reconhecimento acústico seria descrever errado o que o clique faz.
  it("com fontes misturadas, não promete o arquivo", () => {
    const misto = [
      ...doArquivo(3),
      proposta({ song_id: 9, fonte: "reconhecimento pelo som" }),
    ];
    expect(textoDoGrupoDobrado(misto)).toBe(
      "4 músicas sem título ou artista vão receber o nome que a busca achou",
    );
  });

  it("cabe numa linha", () => {
    expect(textoDoGrupoDobrado(doArquivo(999)).length).toBeLessThanOrEqual(100);
  });
});

// ---------------------------------------------------------------------------
// V10 — o conflito: destacar o que difere, e desfazer o engano do "alta"
// ---------------------------------------------------------------------------

describe("as duas vozes de uma linha de conflito", () => {
  it("os dois lados são nomeados por quem os disse", () => {
    expect(LABEL_SUA_ETIQUETA_DIZ).toBe("Sua etiqueta diz");
    expect(LABEL_SOM_DIZ).toBe("O som diz");
  });

  it("não usa o vocabulário de proposta: nada ali foi proposto", () => {
    for (const rotulo of [LABEL_SUA_ETIQUETA_DIZ, LABEL_SOM_DIZ]) {
      expect(rotulo.toLowerCase()).not.toContain("propost");
      expect(rotulo.toLowerCase()).not.toContain("atual");
    }
  });

  it("aceitar é uma escolha por linha, e o rótulo diz o que se aceita", () => {
    expect(rotuloAceitarSom("Te ver feliz")).toBe(
      "Aceitar o que o som diz: Te ver feliz",
    );
  });

  // V10 — a etapa 5 acrescenta linhas a uma revisão aberta, e a música que
  // sobrou sem letra é justamente a que costuma ter uma proposta de NOME
  // pendente: duas caixas com o mesmo rótulo seriam indistinguíveis para quem
  // ouve a tela, e ambíguas para quem vê.
  describe("rotuloDaMarcacao — o que ESTA linha decide", () => {
    const linha = (over: Partial<Parameters<typeof rotuloDaMarcacao>[0]> = {}) =>
      rotuloDaMarcacao({
        current_title: "sem_tags",
        current_artist: null,
        // por padrão a linha NÃO muda nome nenhum: proposto == atual
        proposed_title: "sem_tags",
        proposed_artist: null,
        conflito: null,
        marcar_instrumental: false,
        lyrics: null,
        fonte: "nome do arquivo",
        ...over,
      });

    it("linha comum continua sendo 'Aplicar proposta'", () => {
      expect(linha()).toBe("Aplicar proposta: sem_tags");
      // letra de base de dados também: ela não duplica música nenhuma
      expect(linha({ lyrics: "ai ai", fonte: "LRCLIB" })).toBe(
        "Aplicar proposta: sem_tags",
      );
    });

    it("a letra escrita pela máquina diz que é ela que está sendo aplicada", () => {
      expect(linha({ lyrics: "ai ai", fonte: FONTE_TRANSCRICAO })).toBe(
        "Aplicar a letra escrita ouvindo o áudio: sem_tags",
      );
    });

    it("a marca de instrumental diz o que a marca faz", () => {
      expect(linha({ marcar_instrumental: true, fonte: FONTE_TRANSCRICAO })).toBe(
        "Marcar como instrumental: sem_tags",
      );
    });

    it("o conflito continua com o rótulo dele", () => {
      expect(linha({ conflito: { titulo: "t" } })).toBe(
        "Aceitar o que o som diz: sem_tags",
      );
    });

    // QA A2 — o achado de acessibilidade. A etapa 5 do Rust parte da mesma
    // `proposta_baixa` da etapa 1, então a linha "sem voz" TAMBÉM grava título
    // e artista. Quem enxerga vê o "atual → proposto" ali do lado; quem navega
    // pela lista de campos de formulário do leitor de tela recebia só
    // "Marcar como instrumental" — metade do que o clique faz, e a metade que
    // reescreve a etiqueta do arquivo de alguém ficava de fora.
    describe("o rótulo anuncia tudo que a linha grava", () => {
      const comNome = {
        current_title: "AudioTrack 03",
        current_artist: null,
        proposed_title: "Oh! Chuva",
        proposed_artist: "Falamansa",
      };

      it("instrumental que também preenche nome diz as duas coisas", () => {
        expect(
          linha({ ...comNome, marcar_instrumental: true, fonte: FONTE_TRANSCRICAO }),
        ).toBe(
          "Marcar como instrumental e gravar o nome Oh! Chuva — Falamansa:" +
            " AudioTrack 03",
        );
      });

      it("a letra da máquina que também preenche nome diz as duas coisas", () => {
        expect(
          linha({ ...comNome, lyrics: "chove chuva", fonte: FONTE_TRANSCRICAO }),
        ).toBe(
          "Aplicar a letra escrita ouvindo o áudio e gravar o nome" +
            " Oh! Chuva — Falamansa: AudioTrack 03",
        );
      });

      it("só o artista mudando, o nome sai inteiro — é ele que vai ao arquivo", () => {
        expect(
          linha({
            current_title: "Meninos",
            current_artist: null,
            proposed_title: "Meninos",
            proposed_artist: "Xangai",
            marcar_instrumental: true,
            fonte: FONTE_TRANSCRICAO,
          }),
        ).toBe("Marcar como instrumental e gravar o nome Meninos — Xangai: Meninos");
      });

      // O rótulo é DERIVADO da proposta, não uma frase fixa: se a etapa 5
      // parar de propor nome (o backend está decidindo), ele volta sozinho a
      // dizer só o que sobrou.
      it("sem nome novo, o rótulo não inventa uma gravação que não acontece", () => {
        expect(
          linha({
            current_title: "Baião de Quatro Toques",
            current_artist: "Zé Dantas",
            proposed_title: "Baião de Quatro Toques",
            proposed_artist: "Zé Dantas",
            marcar_instrumental: true,
            fonte: FONTE_TRANSCRICAO,
          }),
        ).toBe("Marcar como instrumental: Baião de Quatro Toques");
      });

      // Espaço das pontas não é mudança: anunciar "gravar o nome" para uma
      // regravação idêntica seria ruído em toda linha da etapa 5.
      it("diferença só de espaço nas pontas não é nome novo", () => {
        expect(
          linha({
            current_title: "Asa Branca",
            current_artist: "  Luiz Gonzaga  ",
            proposed_title: " Asa Branca ",
            proposed_artist: "Luiz Gonzaga",
            marcar_instrumental: true,
            fonte: FONTE_TRANSCRICAO,
          }),
        ).toBe("Marcar como instrumental: Asa Branca");
      });

      // A linha comum NÃO ganha a enumeração: "Aplicar proposta" não promete
      // uma lista de efeitos, então não omite nenhum — e o "atual → proposto"
      // da linha está no mesmo item de lista, ao alcance do leitor de tela.
      // Enumerar aqui só faria o rótulo de 72 linhas iguais ficar três vezes
      // mais longo.
      it("a linha comum continua com o rótulo genérico", () => {
        expect(linha({ ...comNome })).toBe("Aplicar proposta: AudioTrack 03");
      });

      // O conflito não propõe: aceitar grava o que o SOM disse, e a linha já
      // nomeia os dois lados. O rótulo dela continua sendo o dela.
      it("o conflito não entra nesta conta", () => {
        expect(linha({ ...comNome, conflito: { titulo: "t" } })).toBe(
          "Aceitar o que o som diz: AudioTrack 03",
        );
      });
    });
  });

  // O caso real da v0.9.0: o título se repetia nas duas linhas e a pessoa
  // tinha de comparar dois textos com o olho.
  describe("compararConflito — o que é igual sai da comparação", () => {
    it("título igual nos dois lados aparece UMA vez", () => {
      const c = compararConflito(
        { titulo: "Meninos", artista: "Renato Teixeira & Xangai" },
        { titulo: "Meninos", artista: "Xangai & Quinteto da Paraíba" },
      );
      expect(c.iguais).toEqual([{ campo: "título", valor: "Meninos" }]);
      expect(c.diferem).toEqual([
        {
          campo: "artista",
          etiqueta: "Renato Teixeira & Xangai",
          som: "Xangai & Quinteto da Paraíba",
        },
      ]);
    });

    it("os dois campos diferentes: nada é factorado", () => {
      const c = compararConflito(
        { titulo: "Te ver feliz", artista: "Caetano Veloso" },
        { titulo: "Viver Feliz", artista: "Nilson Chaves" },
      );
      expect(c.iguais).toEqual([]);
      expect(c.diferem.map((d) => d.campo)).toEqual(["título", "artista"]);
    });

    it("etiqueta sem artista: o lado vazio é dito, não escondido", () => {
      const c = compararConflito(
        { titulo: "Meninos", artista: null },
        { titulo: "Meninos", artista: "Xangai" },
      );
      expect(c.diferem).toEqual([
        { campo: "artista", etiqueta: "", som: "Xangai" },
      ]);
    });

    it("espaço nas pontas não é diferença", () => {
      const c = compararConflito(
        { titulo: " Meninos ", artista: "Xangai" },
        { titulo: "Meninos", artista: "Quinteto" },
      );
      expect(c.iguais.map((i) => i.campo)).toEqual(["título"]);
    });
  });

  // Dentro do campo que difere, a palavra que os dois lados repetem não é a
  // informação: "Xangai" aparece nos dois, e é justamente o que confunde.
  describe("destacarDiferenca — a palavra que só um lado diz", () => {
    it("marca o que é exclusivo de cada lado", () => {
      expect(
        destacarDiferenca("Xangai & Quinteto da Paraíba", "Renato Teixeira & Xangai"),
      ).toEqual([
        { texto: "Xangai", difere: false },
        { texto: "&", difere: false },
        { texto: "Quinteto", difere: true },
        { texto: "da", difere: true },
        { texto: "Paraíba", difere: true },
      ]);
    });

    it("ignora acento e caixa: 'Coração' e 'coracao' são a mesma palavra", () => {
      expect(destacarDiferenca("Coração", "coracao").every((p) => !p.difere)).toBe(
        true,
      );
    });

    it("texto vazio não vira pedaço nenhum", () => {
      expect(destacarDiferenca("", "Xangai")).toEqual([]);
    });
  });

  // "confiança alta" enganava: ela é sobre QUAL GRAVAÇÃO é esta, não sobre a
  // etiqueta estar errada. O AcoustID identifica a gravação e o crédito vem do
  // MusicBrainz, onde a MESMA gravação sai com créditos diferentes por
  // lançamento — aceitar pode trocar uma etiqueta certa por outra defensável.
  it("a confiança diz sobre O QUE ela fala", () => {
    expect(confiancaDoSom("alta")).toBe("gravação reconhecida com confiança alta");
    expect(confiancaDoSom("media")).toBe("gravação reconhecida com confiança média");
  });

  it("uma frase explica que a confiança não é sobre a etiqueta", () => {
    const t = EXPLICACAO_DA_CONFIANCA_DO_SOM.toLowerCase();
    expect(t).toContain("gravação");
    expect(t).toContain("crédito");
    expect(t).not.toContain("erro da etiqueta");
  });

  it("o cabeçalho conta OFERTAS, sem quebrar por confiança", () => {
    expect(textoDoCabecalho(3)).toBe("3 propostas para conferir");
    expect(textoDoCabecalho(1)).toBe("1 proposta para conferir");
    expect(textoDoCabecalho(0)).toBe("Nenhuma proposta para aplicar.");
    expect(textoDoCabecalho(3)).not.toContain("baixa");
  });
});

// ---------------------------------------------------------------------------
// V10 — a etapa 5, perguntada no FIM
// ---------------------------------------------------------------------------

describe("a pergunta do fim (PRD V10)", () => {
  it("é a frase do PRD, com o número e o tempo", () => {
    expect(textoDaOfertaDeTranscricao(47, 10_800)).toBe(
      "Sobraram 47 músicas sem letra. Escrever a letra ouvindo o áudio leva" +
        " cerca de 3 horas — pode levar mais nesta máquina.",
    );
  });

  it("singular", () => {
    expect(textoDaOfertaDeTranscricao(1, 240)).toContain("Sobrou 1 música sem letra");
  });

  // "cerca de menos de 1 minuto" é o tipo de frase que sai de formatador
  // reusado sem olhar.
  it("tempo curto não vira 'cerca de menos de'", () => {
    const t = textoDaOfertaDeTranscricao(1, 30);
    expect(t).toContain("leva menos de 1 minuto");
    expect(t).not.toContain("cerca de menos");
  });

  /*
    QA A1, segunda metade — com a medição feita, o "neste computador" VOLTA.

    O backend fechou o laço por dentro (tabela própria somando áudio transcrito
    e relógio gasto, com piso de amostra antes de valer) e expõe um BOOLEANO, e
    não a razão: um número convidaria o TypeScript a multiplicar, que é a
    DECISIONS #80. Com `true` a frase pode afirmar o que o programa conhece;
    com `false` ela mantém a ressalva. É a DECISIONS #86 aplicada a uma
    estimativa: nenhum texto afirma o que o programa não sabe — e nenhum
    esconde o que ele sabe.
  */
  it("com a estimativa medida nesta máquina, a frase diz isso", () => {
    expect(textoDaOfertaDeTranscricao(47, 10_800, true)).toBe(
      "Sobraram 47 músicas sem letra. Escrever a letra ouvindo o áudio leva" +
        " cerca de 3 horas neste computador.",
    );
  });

  it("medida e curta: o 'cerca de' não volta pelo caminho de trás", () => {
    const t = textoDaOfertaDeTranscricao(1, 30, true);
    expect(t).toBe(
      "Sobrou 1 música sem letra. Escrever a letra ouvindo o áudio leva menos" +
        " de 1 minuto neste computador.",
    );
  });

  // O padrão é a frase conservadora: quem esquecer de passar o fato recebe a
  // versão que não afirma nada de errado.
  it("sem dizer nada, vale a ressalva", () => {
    expect(textoDaOfertaDeTranscricao(47, 10_800)).toBe(
      textoDaOfertaDeTranscricao(47, 10_800, false),
    );
  });

  /*
    QA A1 — o número é DECLARADO, e a frase dizia "neste computador".

    A DECISIONS #106 separa as duas coisas por nome: `RAZAO_DE_REFERENCIA` é um
    palpite de fábrica (1,0), e a razão MEDIDA é outra grandeza. Enquanto o que
    chega à tela é o palpite, "neste computador" afirma uma medição que não
    houve — e o erro tem sinal: o `whisper-cli` do macOS passou a sair sem
    Metal e sem Accelerate, então o palpite é OTIMISTA. Prometer menos do que
    leva é a DECISIONS #85, e prometer mais para quem vai esperar horas é o
    caminho de fechar o programa no meio achando que travou.
  */
  it("não afirma uma medição que não houve", () => {
    for (const segundos of [30, 240, 10_800]) {
      const t = textoDaOfertaDeTranscricao(47, segundos, false);
      expect(t, t).not.toContain("neste computador");
      // e a estimativa se declara como piso, não como promessa
      expect(t, t).toContain("pode levar mais nesta máquina");
    }
  });

  it("o botão diz que começa agora, e a pergunta não vira parágrafo", () => {
    expect(ROTULO_COMECAR_TRANSCRICAO).toBe("Começar agora");
  });

  // Para 180 MB a dispensa do tempo acabou (DECISIONS #106): o caminho de quem
  // não tem os acessórios é o download, COM tamanho e tempo.
  it("sem os acessórios, a saída é o download — com tamanho e tempo", () => {
    const t = textoDaTranscricaoIndisponivel(47, {
      bytes: 183_000_000,
      segundos: 183,
    });
    expect(t).toContain("Sobraram 47 músicas sem letra");
    expect(t).toContain("174,5 MB");
    expect(t).toContain("cerca de 3 minutos");
    expect(t).toContain("Configurações");
  });

  // Estado do acessório desconhecido: não inventa tamanho nem tempo.
  it("sem saber o tamanho, não inventa número", () => {
    const t = textoDaTranscricaoIndisponivel(47, null);
    expect(t).toContain("Sobraram 47 músicas sem letra");
    expect(t).toContain("Configurações");
    expect(t).not.toMatch(/\d+ MB/);
  });
});

describe("acompanhar horas de trabalho", () => {
  it("o progresso conta a fila, não só a música", () => {
    expect(textoDoProgressoDaTranscricao(3, 47)).toBe(
      "Escrevendo as letras… 3 de 47",
    );
  });

  // `segundos_restantes` é null até a primeira música terminar. Inventar um
  // número antes disso é a DECISIONS #85; deixar em branco é pior ainda numa
  // tela que vai ficar aberta por horas.
  it("sem medição, diz QUANDO o número vai aparecer", () => {
    const t = textoDoTempoDaTranscricao(null);
    expect(t).toContain("quando a primeira música terminar");
    expect(t).not.toMatch(/\d/);
  });

  it("com medição, diz quanto falta", () => {
    expect(textoDoTempoDaTranscricao(9800)).toBe("Faltam cerca de 3 horas.");
    expect(textoDoTempoDaTranscricao(600)).toBe("Faltam cerca de 10 minutos.");
    expect(textoDoTempoDaTranscricao(30)).toBe("Falta menos de 1 minuto.");
  });
});

describe("os três campos novos da proposta", () => {
  // A marca tira o arquivo da fila de letra para sempre, e só o editor a
  // desfaz: a linha tem de dizer o que o clique faz.
  it("instrumental: diz o que a marca significa para a pessoa", () => {
    expect(AVISO_MARCAR_INSTRUMENTAL.toLowerCase()).toContain("voz");
    expect(AVISO_MARCAR_INSTRUMENTAL.toLowerCase()).toContain("instrumental");
    expect(AVISO_MARCAR_INSTRUMENTAL.toLowerCase()).toContain("sem letra");
  });

  // O refrão existe para reconhecer a música SEM abrir a letra — quem vai
  // conferir 47 letras de máquina precisa disso na linha.
  it("refrão: aparece entre aspas, com rótulo curto", () => {
    expect(rotuloDoRefrao("na beira do mar sagrado")).toBe(
      "Trecho mais repetido: “na beira do mar sagrado”",
    );
  });

  it("letra de máquina: o aviso de conferir vem antes de aplicar", () => {
    expect(AVISO_LETRA_DE_MAQUINA.toLowerCase()).toContain("máquina");
    expect(AVISO_LETRA_DE_MAQUINA.toLowerCase()).toContain("confira");
    expect(FONTE_TRANSCRICAO).toBe("transcrição do áudio");
  });
});

// ---------------------------------------------------------------------------
// CRÍTICO-1 e V9 — os avisos que sobrevivem à V10
// ---------------------------------------------------------------------------

describe("avisoLetraExistente — o que seria substituído", () => {
  it("letra qualquer: avisa que existe e que, sem marcar, só nomes são aplicados", () => {
    const texto = avisoLetraExistente(null);
    expect(texto).toContain("Já tem letra");
    expect(texto).toContain("só título e artista");
    expect(texto).toContain("abaixo");
  });

  it("letra transcrita: usa o vocabulário do projeto e lembra da correção à mão", () => {
    const texto = avisoLetraExistente("transcricao");
    expect(texto).toContain("escrita ouvindo o áudio");
    expect(texto).toContain("à mão");
  });

  it("o rótulo da marcação é o mesmo que o backend cita ao recusar", () => {
    expect(LABEL_SUBSTITUIR_LETRA).toBe("Substituir a letra atual");
  });
});

describe("aviso de troca de nome escrito por gente", () => {
  it("diz o que a linha faria, em uma frase", () => {
    expect(AVISO_NOME_ESCRITO.toLowerCase()).toContain("já existe");
    expect(AVISO_NOME_ESCRITO.length).toBeLessThanOrEqual(90);
    expect(frases(AVISO_NOME_ESCRITO)).toBe(1);
  });
});

describe("textoAplicado — o aviso final diz o que MUDOU, nunca uma tarefa", () => {
  const resumo = (over: Partial<Parameters<typeof textoAplicado>[0]> = {}) =>
    textoAplicado({
      ganharamLetra: 0,
      letraSubstituida: 0,
      marcadasInstrumental: 0,
      nomeCorrigido: 0,
      gravadas: 0,
      ...over,
    });

  it("só letras: a frase do PRD", () => {
    expect(resumo({ ganharamLetra: 47, gravadas: 47 })).toBe(
      "47 músicas ganharam letra. A biblioteca já está atualizada.",
    );
  });

  it("letras e correções de nome", () => {
    expect(resumo({ ganharamLetra: 12, nomeCorrigido: 3, gravadas: 15 })).toBe(
      "12 músicas ganharam letra e 3 tiveram título ou artista corrigidos." +
        " A biblioteca já está atualizada.",
    );
  });

  it("só correções de nome", () => {
    expect(resumo({ nomeCorrigido: 1, gravadas: 1 })).toBe(
      "1 música teve título ou artista corrigido. A biblioteca já está atualizada.",
    );
  });

  it("singular da letra", () => {
    expect(resumo({ ganharamLetra: 1, gravadas: 1 })).toBe(
      "1 música ganhou letra. A biblioteca já está atualizada.",
    );
  });

  it("letra substituída é contada, dita e vem na frente", () => {
    expect(
      resumo({
        ganharamLetra: 12,
        letraSubstituida: 2,
        nomeCorrigido: 3,
        gravadas: 17,
      }),
    ).toBe(
      "2 músicas tiveram a letra substituída, 12 ganharam letra e 3 tiveram" +
        " título ou artista corrigidos. A biblioteca já está atualizada.",
    );
  });

  // V10 — a marca de instrumental muda o acervo tanto quanto uma letra nova, e
  // é a mudança que a lista NÃO mostra depois (a música some da fila).
  it("a marca de instrumental é contada e dita", () => {
    expect(resumo({ marcadasInstrumental: 5, gravadas: 5 })).toBe(
      "5 músicas foram marcadas como instrumental. A biblioteca já está atualizada.",
    );
    expect(resumo({ marcadasInstrumental: 1, gravadas: 1 })).toBe(
      "1 música foi marcada como instrumental. A biblioteca já está atualizada.",
    );
  });

  it("a marca vem logo depois da letra substituída, antes dos ganhos", () => {
    expect(
      resumo({ ganharamLetra: 2, letraSubstituida: 1, marcadasInstrumental: 3, gravadas: 6 }),
    ).toBe(
      "1 música teve a letra substituída, 3 foram marcadas como instrumental e" +
        " 2 ganharam letra. A biblioteca já está atualizada.",
    );
  });

  it("gravou sem mudar conteúdo: não inventa ganho que não houve", () => {
    expect(resumo({ gravadas: 2 })).toBe(
      "2 músicas foram gravadas, sem mudança no conteúdo.",
    );
  });

  it("nunca pede reindexação nem reinício", () => {
    for (const t of [
      resumo({ ganharamLetra: 47, gravadas: 47 }),
      resumo({ letraSubstituida: 2, nomeCorrigido: 3, gravadas: 5 }),
      resumo({ marcadasInstrumental: 1, gravadas: 1 }),
      resumo({ gravadas: 2 }),
    ]) {
      expect(t.toLowerCase()).not.toContain("reindex");
      expect(t.toLowerCase()).not.toContain("reinici");
    }
  });
});

// V10 — o campo da chave do Vagalume SAIU da tela (DECISIONS #110), e com ele
// `VAGALUME_URL` e `textoDaChaveDoVagalume`. A etapa 4 passou a ser o
// `lyrics.ovh`, que não pede chave: **nenhuma etapa do funil pede credencial de
// quem usa**, e esse era o último pedágio de configuração do produto — numa
// tela usada por 40 pessoas leigas, sem suporte a quem perguntar.
//
// Não é desligamento: o texto que explicava a chave não existe mais, porque
// texto que não descreve nada é o que ensina a ignorar o resto da tela.

describe("nenhuma etapa pede credencial (DECISIONS #110)", () => {
  it("a copy da curadoria não fala em chave, cadastro nem Vagalume", () => {
    const textos = [
      TRANSCRICAO_NO_FIM,
      ...etapasDoFunil(ETAPAS_COMPLETAS).flatMap((e) => [e.nome, e.explicacao]),
      estimativa(pronta(), 200),
    ];
    for (const t of textos) {
      expect(t.toLowerCase(), t).not.toContain("chave");
      expect(t.toLowerCase(), t).not.toContain("vagalume");
      expect(t.toLowerCase(), t).not.toContain("cadastro");
    }
  });
});

// ---------------------------------------------------------------------------
// Acessórios — nada baixa sozinho, e agora com TEMPO junto do tamanho
// ---------------------------------------------------------------------------

describe("formatarTamanho — o 'quanto ocupa' que a pessoa lê antes de decidir", () => {
  it("megabytes com uma casa e vírgula decimal (pt-BR)", () => {
    expect(formatarTamanho(3_418_112)).toBe("3,3 MB");
    expect(formatarTamanho(5_538_312)).toBe("5,3 MB");
    expect(formatarTamanho(181_000_000)).toBe("172,6 MB");
  });

  it("abaixo de 1 MB fala em kB, sem casa decimal", () => {
    expect(formatarTamanho(65_536)).toBe("64 kB");
    expect(formatarTamanho(0)).toBe("0 kB");
  });

  /**
   * V10.5 — com o modelo pequeno fora do catálogo, o único arquivo de dado tem
   * 1,5 bilhão de bytes, e "1462,7 MB" é um número que ninguém lê como
   * tamanho: quatro dígitos antes da vírgula deixam de dizer se é muito ou
   * pouco. A régua da #100 é a frase ser legível na hora de decidir.
   */
  it("quatro dígitos viram GB, com a mesma casa decimal", () => {
    // o modelo da etapa 5, e o modelo + o programa da pergunta do fim
    expect(formatarTamanho(1_533_763_059)).toBe("1,4 GB");
    expect(formatarTamanho(1_533_763_059 + 1_635_784)).toBe("1,4 GB");
    // a troca acontece ANTES do quarto dígito, e o GB é binário como o MB e o
    // kB daqui: duas bases no mesmo formatador dariam dois tamanhos para o
    // mesmo arquivo
    expect(formatarTamanho(999 * 1024 * 1024)).toBe("999,0 MB");
    expect(formatarTamanho(1000 * 1024 * 1024)).toBe("1,0 GB");
    expect(formatarTamanho(1024 * 1024 * 1024)).toBe("1,0 GB");
  });
});

describe("estadoDoAcessorio — a leitura do que o backend devolveu", () => {
  const lista = (nome: string, estado: string) => [{ nome, estado }];

  it("undefined = a pergunta ainda não voltou", () => {
    expect(estadoDoAcessorio(undefined, "fpcalc")).toBe("perguntando");
  });

  it("null = a pergunta falhou, que NÃO é 'não existe' nem 'pronto'", () => {
    expect(estadoDoAcessorio(null, "fpcalc")).toBe("indeterminado");
  });

  it("lista vazia = não publicamos binário para este computador", () => {
    expect(estadoDoAcessorio([], "fpcalc")).toBe("sem-binario");
  });

  it("lista sem o acessório pedido vale o mesmo que lista vazia", () => {
    expect(estadoDoAcessorio(lista("whisper-cli", "pronto"), "fpcalc")).toBe(
      "sem-binario",
    );
  });

  it("cada estado passa direto", () => {
    for (const e of ["pronto", "ausente", "corrompido", "indisponivel"]) {
      expect(
        estadoDoAcessorio(
          lista("modelo-de-transcricao-grande", e),
          "modelo-de-transcricao-grande",
        ),
      ).toBe(e);
    }
  });

  it("estado desconhecido não vira 'pronto' por otimismo", () => {
    expect(estadoDoAcessorio(lista("fpcalc", "coisa-nova"), "fpcalc")).toBe(
      "indeterminado",
    );
  });
});

describe("a copy dos acessórios", () => {
  // O `para_que_serve` vem pronto do backend e vira o TÍTULO do bloco: quem
  // cura não sabe o que é "impressão digital acústica", e a frase que explica
  // isso não pode ficar duplicada em duas linguagens.
  it("o título é o para-que-serve do backend, com maiúscula", () => {
    expect(tituloDoAcessorio(acessorio())).toBe("Reconhecer a música pelo som");
    expect(
      tituloDoAcessorio(
        acessorio({ para_que_serve: "escrever a letra ouvindo o áudio" }),
      ),
    ).toBe("Escrever a letra ouvindo o áudio");
  });

  // Regra 1 do PRD V9 + DECISIONS #106: tamanho E tempo, antes do clique.
  it("antes de baixar: quanto ocupa, quanto tempo leva, e que é uma vez só", () => {
    const texto = textoDoAcessorioAusente(acessorio());
    expect(texto).toContain("5,3 MB");
    expect(texto).toContain("uma vez só");
    expect(texto).toContain("menos de 1 minuto");
    expect(frases(texto)).toBeLessThanOrEqual(2);
  });

  // "um programa de 2 MB e um arquivo de 181 MB" é outra conversa que "dois
  // programas": o modelo é DADO, e ninguém o executa.
  it("programa e dado são ditos com palavras diferentes", () => {
    expect(textoDoAcessorioAusente(acessorio({ executavel: true }))).toContain(
      "um programa de",
    );
    expect(
      textoDoAcessorioAusente(
        acessorio({
          executavel: false,
          tamanho_bytes: 181_000_000,
          segundos_estimados: 181,
        }),
      ),
    ).toContain("um arquivo de");
  });

  it("o tempo do download de 180 MB é dito em minutos, não omitido", () => {
    const texto = textoDoAcessorioAusente(
      acessorio({ tamanho_bytes: 181_000_000, segundos_estimados: 181, executavel: false }),
    );
    expect(texto).toContain("172,6 MB");
    expect(texto).toContain("cerca de 3 minutos");
  });

  // -------------------------------------------------------------------------
  // V10.4 — a estimativa diz DE ONDE ELA VEM (defeito de campo D3)
  // -------------------------------------------------------------------------
  //
  // A tela anunciou 26 minutos para um download que levou menos de 3. O número
  // subiu (a banda de referência deixou de ser de 2010), mas o conserto do
  // número sozinho não basta: enquanto ele for DECLARADO, ele pode errar por
  // fator numa conexão ruim — e aí a frase tem de admitir isso, que é a
  // mitigação que a DECISIONS #85 já exigiu da estimativa da varredura ("bem
  // mais se a internet estiver lenta").
  //
  // Quando o número é MEDIDO nesta máquina, a ressalva sai e o texto diz por
  // quê. É a mesma escolha da #124 na pergunta do fim da transcrição: quem
  // decide o que a tela diz é um FATO sobre o número, não o número.

  /**
   * O singular de MINUTO existia só para a hora. A faixa entre 60 e 89 s era
   * inalcançável enquanto a banda de referência era de 1 MB/s — nenhum
   * acessório do catálogo caía ali —, e com a referência honesta os 190 MB do
   * modelo pequeno caem exatamente nela. "Cerca de 1 minutos" é a frase que
   * ensina a não ler o resto da tela.
   */
  it("um minuto é dito no singular, como uma hora sempre foi", () => {
    const um = textoDoAcessorioAusente(
      acessorio({ tamanho_bytes: 190_085_487, segundos_estimados: 64 }),
    );
    expect(um).toContain("cerca de 1 minuto —");
    expect(um).not.toContain("1 minutos");

    const varios = textoDoAcessorioAusente(
      acessorio({ tamanho_bytes: 190_085_487, segundos_estimados: 300 }),
    );
    expect(varios).toContain("cerca de 5 minutos");
  });

  it("estimativa de fábrica admite que a internet lenta muda a conta", () => {
    const texto = textoDoAcessorioAusente(
      acessorio({ tamanho_bytes: 1_533_763_059, segundos_estimados: 512 }),
    );
    expect(texto).toContain("cerca de 9 minutos");
    expect(texto).toContain("mais se a sua internet estiver lenta");
    expect(frases(texto)).toBeLessThanOrEqual(2);
  });

  it("estimativa medida nesta máquina diz isso, e larga a ressalva", () => {
    const texto = textoDoAcessorioAusente(
      acessorio({
        tamanho_bytes: 1_533_763_059,
        segundos_estimados: 175,
        tempo_medido_nesta_maquina: true,
      }),
    );
    expect(texto).toContain("cerca de 3 minutos");
    expect(texto).toContain("neste computador");
    expect(texto).not.toContain("internet estiver lenta");
    expect(frases(texto)).toBeLessThanOrEqual(2);
  });

  it("o rótulo do botão carrega o tamanho, e o de repetição diz que é de novo", () => {
    expect(rotuloBaixarAcessorio(acessorio(), false)).toBe("Baixar (5,3 MB)");
    expect(rotuloBaixarAcessorio(acessorio(), true)).toBe("Baixar de novo (5,3 MB)");
  });

  // `total: null` = o servidor não anunciou o tamanho. NÃO é 0 (DECISIONS #86).
  it("o progresso vive sem o total, em vez de inventar 0", () => {
    expect(textoDoDownload(1_048_576, 5_538_312, null)).toBe(
      "Baixando… 1,0 MB de 5,3 MB",
    );
    expect(textoDoDownload(1_048_576, null, null)).toBe("Baixando… 1,0 MB");
  });

  // A velocidade MEDIDA troca a estimativa declarada assim que existe amostra.
  it("com velocidade medida, o progresso diz quanto falta", () => {
    expect(textoDoDownload(1_048_576, 181_000_000, 120)).toBe(
      "Baixando… 1,0 MB de 172,6 MB — faltam cerca de 2 minutos",
    );
    expect(textoDoDownload(1_048_576, 181_000_000, 20)).toContain(
      "falta menos de 1 minuto",
    );
  });

  it("estado que não pôde ser conferido: admite, e não oferece download", () => {
    expect(ACESSORIO_INDETERMINADO.toLowerCase()).toContain("não foi possível");
    expect(ACESSORIO_INDETERMINADO.toLowerCase()).not.toContain("baixar");
    expect(frases(ACESSORIO_INDETERMINADO)).toBe(1);
  });

  it("lista vazia do backend: não oferece download que não serviria", () => {
    expect(ACESSORIO_SEM_BINARIO.toLowerCase()).toContain("computador");
    expect(ACESSORIO_SEM_BINARIO.toLowerCase()).not.toContain("baixar");
  });

  it("indisponível nesta versão: também não oferece download", () => {
    expect(ACESSORIO_INDISPONIVEL.toLowerCase()).toContain("versão");
    expect(ACESSORIO_INDISPONIVEL.toLowerCase()).not.toContain("baixar");
  });

  it("corrompido: sem drama e com a saída na mesma frase", () => {
    expect(ACESSORIO_CORROMPIDO.toLowerCase()).toContain("não confere");
    expect(ACESSORIO_CORROMPIDO.toLowerCase()).toContain("de novo");
    expect(frases(ACESSORIO_CORROMPIDO)).toBeLessThanOrEqual(2);
  });

  // Com três acessórios, o texto de "pronto" não pode falar do som: ele
  // aparece embaixo do título de cada um.
  it("pronto: uma frase, nenhum pedido de ação, e nada específico do som", () => {
    expect(frases(ACESSORIO_PRONTO)).toBeLessThanOrEqual(2);
    expect(ACESSORIO_PRONTO.toLowerCase()).not.toContain("som");
    expect(ACESSORIO_PRONTO.toLowerCase()).toContain("pronto");
  });

  it("cancelado é dito como cancelado, não como falha", () => {
    expect(ACESSORIO_CANCELADO.toLowerCase()).toContain("cancelad");
    expect(ACESSORIO_CANCELADO.toLowerCase()).not.toContain("erro");
    expect(frases(ACESSORIO_CANCELADO)).toBeLessThanOrEqual(2);
  });
});

describe("downloadParaTranscrever — o que falta para a etapa 5 existir", () => {
  const whisper = acessorio({
    nome: "whisper-cli",
    para_que_serve: "escrever a letra ouvindo o áudio",
    tamanho_bytes: 2_000_000,
    segundos_estimados: 2,
    estado: "ausente",
  });
  // V10.5 — o nome é o do modelo que ficou. Um acessório da etapa 5 que a
  // lista `ACESSORIOS_DA_TRANSCRICAO` não reconhece some da conta: a pergunta
  // do fim ofereceria 2 MB para um download de 1,4 GB.
  const modelo = acessorio({
    nome: "modelo-de-transcricao-grande",
    para_que_serve: "entender o que é cantado",
    tamanho_bytes: 181_000_000,
    segundos_estimados: 181,
    executavel: false,
    estado: "ausente",
  });

  it("soma os dois: são 2 MB de programa e 181 MB de dado", () => {
    expect(downloadParaTranscrever([acessorio(), whisper, modelo])).toEqual({
      bytes: 183_000_000,
      segundos: 183,
    });
  });

  it("o que já está pronto não é cobrado de novo", () => {
    expect(
      downloadParaTranscrever([whisper, { ...modelo, estado: "pronto" }]),
    ).toEqual({ bytes: 2_000_000, segundos: 2 });
  });

  it("nada pendente: não há download a oferecer", () => {
    expect(
      downloadParaTranscrever([
        { ...whisper, estado: "pronto" },
        { ...modelo, estado: "pronto" },
      ]),
    ).toBeNull();
  });

  // Lista que não veio, ou que não traz os acessórios da etapa 5: "não
  // sabemos" é um estado, e não um download de 0 MB (DECISIONS #86).
  it("sem lista, não inventa tamanho", () => {
    expect(downloadParaTranscrever(null)).toBeNull();
    expect(downloadParaTranscrever(undefined)).toBeNull();
    expect(downloadParaTranscrever([acessorio()])).toBeNull();
  });

  // Baixar 183 MB para descobrir que este build não usa o acessório é a
  // acusação falsa da DECISIONS #97.
  it("indisponível nesta versão não vira oferta de download", () => {
    expect(
      downloadParaTranscrever([
        { ...whisper, estado: "indisponivel" },
        { ...modelo, estado: "indisponivel" },
      ]),
    ).toBeNull();
  });
});

// O tipo exportado é conferido por uso: uma união que perder um estado quebra
// o `switch` de quem a lê.
const TODOS_OS_ESTADOS: EstadoDoAcessorio[] = [
  "perguntando",
  "indeterminado",
  "sem-binario",
  "indisponivel",
  "ausente",
  "corrompido",
  "pronto",
];

describe("EstadoDoAcessorio", () => {
  it("tem os sete estados, e 'não sabemos' são dois deles", () => {
    expect(new Set(TODOS_OS_ESTADOS).size).toBe(7);
    expect(TODOS_OS_ESTADOS).toContain("perguntando");
    expect(TODOS_OS_ESTADOS).toContain("indeterminado");
  });
});

// ---------------------------------------------------------------------------
// V10.6 — a etapa 5 tem DUAS portas, e a segunda é permanente
// ---------------------------------------------------------------------------
//
// Relato de campo: *"Achei que eu poderia clicar em aplicar e depois trabalhar
// nas transcrições, mas não aconteceu… Simplesmente fechou a caixa e aplicou
// essas 28… Mas agora tenho que começar de novo pra chegar na parte de
// transcrição de novo."*
//
// O que se perdia não era um clique: era a varredura inteira. E a causa era de
// projeto — "quais músicas estão sem letra" é fato PERMANENTE da biblioteca, e
// estava amarrado a uma tela temporária.

describe("o bloco permanente da transcrição (V10.6)", () => {
  const CHEIO = {
    quantas: 47,
    segundos: 10_800,
    medidaNestaMaquina: false,
    disponivel: true,
    download: null,
    todaABiblioteca: true,
  };

  it("a SEGUNDA frase é a MESMA da pergunta do fim, letra por letra", () => {
    // o número e o tempo são a mesma informação; muda só quem abre a frase,
    // porque "sobraram" só é verdade logo depois de uma varredura
    const doFim = textoDaOfertaDeTranscricao(47, 10_800, false);
    const daTela = textoDoBlocoDeTranscricao(CHEIO);
    const segunda = "Escrever a letra ouvindo o áudio leva cerca de 3 horas — pode levar mais nesta máquina.";
    expect(doFim).toContain(segunda);
    expect(daTela).toContain(segunda);
  });

  it("não diz 'sobraram': aqui nada acabou de acontecer", () => {
    expect(textoDoBlocoDeTranscricao(CHEIO).toLowerCase()).not.toContain("sobrar");
  });

  it("diz o ESCOPO, porque o seletor de pasta fica logo acima", () => {
    expect(textoDoBlocoDeTranscricao(CHEIO)).toContain(
      "47 músicas da biblioteca estão sem letra",
    );
    expect(
      textoDoBlocoDeTranscricao({ ...CHEIO, todaABiblioteca: false }),
    ).toContain("47 músicas desta pasta estão sem letra");
  });

  it("singular", () => {
    expect(textoDoBlocoDeTranscricao({ ...CHEIO, quantas: 1 })).toContain(
      "1 música da biblioteca está sem letra",
    );
    expect(
      textoDoBlocoDeTranscricao({ ...CHEIO, quantas: 1, todaABiblioteca: false }),
    ).toContain("1 música desta pasta está sem letra");
  });

  // Zero é RESPOSTA, e não a ausência do bloco: quem abre a tela para saber
  // quantas faltam precisa ler que não falta nenhuma.
  it("zero é uma resposta, e não oferece trabalho nenhum", () => {
    const t = textoDoBlocoDeTranscricao({ ...CHEIO, quantas: 0, segundos: 0 });
    expect(t).toBe("Nenhuma música da biblioteca está sem letra.");
    expect(
      textoDoBlocoDeTranscricao({
        ...CHEIO,
        quantas: 0,
        segundos: 0,
        todaABiblioteca: false,
      }),
    ).toBe("Nenhuma música desta pasta está sem letra.");
  });

  // A medição desta máquina vale nas duas portas: seria a mesma biblioteca com
  // dois tempos na mesma tela.
  it("com a estimativa medida, o 'neste computador' vale aqui também", () => {
    const t = textoDoBlocoDeTranscricao({ ...CHEIO, medidaNestaMaquina: true });
    expect(t).toContain("leva cerca de 3 horas neste computador.");
    expect(t).not.toContain("pode levar mais");
  });

  /*
    Sem os acessórios, a saída NÃO é "vá em Configurações": já estamos nela, e
    os blocos de download estão a poucos pixels acima. Repetir o tamanho e o
    tempo que eles já dizem seria o ruído que a régua da #100 proíbe — o que
    falta responder é "por que não posso, e o que faço".
  */
  it("indisponível aqui aponta para cima, e não para Configurações", () => {
    const t = textoDoBlocoDeTranscricao({
      ...CHEIO,
      disponivel: false,
      download: { bytes: 1_533_763_059, segundos: 512 },
    });
    expect(t).toContain("47 músicas da biblioteca estão sem letra.");
    expect(t).toContain("1,4 GB");
    expect(t.toLowerCase()).toContain("acima");
    expect(t).not.toContain("em Configurações");
  });

  it("indisponível sem saber o tamanho não inventa número (DECISIONS #86)", () => {
    const t = textoDoBlocoDeTranscricao({ ...CHEIO, disponivel: false });
    expect(t).toContain("47 músicas da biblioteca estão sem letra.");
    expect(t.toLowerCase()).toContain("acima");
    expect(t).not.toMatch(/\d+(,\d)? (kB|MB|GB)/);
  });

  // Zero vence a indisponibilidade: oferecer 1,4 GB de download para transcrever
  // nada é pedir um trabalho que não existe.
  it("zero não oferece download nenhum", () => {
    expect(
      textoDoBlocoDeTranscricao({
        ...CHEIO,
        quantas: 0,
        segundos: 0,
        disponivel: false,
        download: { bytes: 1_533_763_059, segundos: 512 },
      }),
    ).toBe("Nenhuma música da biblioteca está sem letra.");
  });
});

describe("fechar a revisão com transcrição pendente (V10.6)", () => {
  /*
    O aviso é INFORMATIVO, e de propósito: com a porta permanente em
    Configurações a lista já não se perde, então uma confirmação bloqueante
    seria um pop-up cobrando uma decisão por um prejuízo que deixou de existir —
    e pop-up que se aprende a fechar sem ler é pop-up que não avisa mais nada.
    O que ficou é a frase que diz PARA ONDE a oferta foi.
  */
  it("diz quantas faltam e onde a oferta continua", () => {
    expect(avisoDeTranscricaoPendente(27)).toBe(
      "Ainda há 27 músicas sem letra. Escrever a letra ouvindo o áudio continua" +
        " em Configurações, quando você quiser.",
    );
  });

  it("singular", () => {
    expect(avisoDeTranscricaoPendente(1)).toContain("Ainda há 1 música sem letra");
  });

  it("zero não avisa nada: não há oferta pendente", () => {
    expect(avisoDeTranscricaoPendente(0)).toBeNull();
  });

  // O aviso não pode acusar quem fechou: fechar é uma ação legítima, e a
  // varredura foi só leitura.
  it("não fala em perder nem em descartar", () => {
    const t = avisoDeTranscricaoPendente(27)!;
    expect(t.toLowerCase()).not.toContain("perd");
    expect(t.toLowerCase()).not.toContain("descart");
  });
});

describe("a linha já gravada (V10.6)", () => {
  /*
    Aplicar deixou de fechar a caixa, então as linhas gravadas continuam na
    tela — e a tela precisa dizer o que aconteceu com elas. Sem isto a mesma
    lista voltaria a oferecer o clique que acabou de acontecer, e o `apply`
    recusaria a segunda tentativa com "a música mudou depois da busca": um erro
    inventado por nós, para quem não tem a quem perguntar.
  */
  it("a linha diz que foi gravada, e o selo troca a confiança", () => {
    expect(ROTULO_DA_LINHA_GRAVADA).toBe("Gravada no arquivo.");
    expect(SELO_DA_LINHA_GRAVADA).toBe("GRAVADA");
  });

  it("não fala em erro nem pede ação nenhuma", () => {
    expect(ROTULO_DA_LINHA_GRAVADA.toLowerCase()).not.toContain("erro");
    expect(ROTULO_DA_LINHA_GRAVADA.toLowerCase()).not.toContain("confira");
  });
});
