import { describe, expect, it } from "vitest";
import { buildFolderTree } from "./folderTree";
import {
  ACESSORIO_CANCELADO,
  ACESSORIO_CORROMPIDO,
  ACESSORIO_INDETERMINADO,
  ACESSORIO_INDISPONIVEL,
  ACESSORIO_PRONTO,
  ACESSORIO_SEM_BINARIO,
  AVISO_NOME_ESCRITO,
  CONFERENCIA_PRECISA_DO_SOM,
  ETAPAS_FORA_DO_APP,
  LABEL_SOM_DIZ,
  LABEL_SUBSTITUIR_LETRA,
  LABEL_SUA_ETIQUETA_DIZ,
  MODOS,
  SEM_RESULTADO_INDIVIDUAL,
  SEM_RESULTADO_INSTRUMENTAL,
  VAGALUME_URL,
  avisoLetraExistente,
  confiancaDoSom,
  estimativaTexto,
  etapasDoFunil,
  formatarTamanho,
  opcoesDePasta,
  rotuloAceitarSom,
  rotuloBaixarAcessorio,
  rotuloDoDisparo,
  segundosPorMusica,
  textoAplicado,
  textoDoCabecalho,
  textoDoDownload,
  textoDoAcessorioAusente,
  textoSemPropostas,
  type ContagemCandidatas,
  type EtapasLigadas,
} from "./curadoria";
import type { Folder, Song } from "./types";

/** Contagem já respondida pelo backend (`enrich_count`). */
const pronta = (total: number): ContagemCandidatas => ({ estado: "pronta", total });

/** Etapas de uma instalação NOVA: sem o acessório, com o Vagalume (chave nossa). */
const SEM_SOM: EtapasLigadas = { som: false, vagalume: true };
/** Etapas de quem já baixou o acessório. */
const COM_SOM: EtapasLigadas = { som: true, vagalume: true };

/** Atalho: a estimativa do modo de sempre. */
function completar(
  contagem: ContagemCandidatas,
  musicasNaPasta: number,
  etapas: EtapasLigadas = SEM_SOM,
): string {
  return estimativaTexto({ contagem, musicasNaPasta, modo: "completar", etapas });
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

// ---------------------------------------------------------------------------
// A régua desta rodada (PRD V9, item 3 — "achando as mensagens muito longas"):
// a PRIMEIRA frase diz o que é; o resto só existe se responder a uma pergunta
// que a pessoa faria naquele momento. Texto que ninguém lê não explica nada.
// ---------------------------------------------------------------------------

/** Quantas frases um texto tem (aproximação por pontuação final). */
function frases(texto: string): number {
  return texto.split(/[.!?](?:\s|$)/).filter((f) => f.trim() !== "").length;
}

describe("o passe de redução da copy (PRD V9, item 3)", () => {
  // Os textos abaixo são os que o campo apontou como longos demais. O teto não
  // é estético: são as mensagens que aparecem no fim de uma busca de minutos,
  // quando a pessoa quer saber o que aconteceu — não ler um parágrafo.
  const TETO_CARACTERES = 210;
  const TETO_FRASES = 2;

  const desfechos: Array<[string, string]> = [
    ["textoSemPropostas(81)", textoSemPropostas(81, "completar")],
    ["textoSemPropostas(null)", textoSemPropostas(null, "completar")],
    ["SEM_RESULTADO_INDIVIDUAL", SEM_RESULTADO_INDIVIDUAL],
    ["SEM_RESULTADO_INSTRUMENTAL", SEM_RESULTADO_INSTRUMENTAL],
    ["estimativa de 95", completar(pronta(95), 200)],
    ["aviso de letra existente", avisoLetraExistente("transcricao")],
  ];

  for (const [nome, texto] of desfechos) {
    it(`${nome}: cabe em duas frases e ${TETO_CARACTERES} caracteres`, () => {
      expect(texto.length, texto).toBeLessThanOrEqual(TETO_CARACTERES);
      expect(frases(texto), texto).toBeLessThanOrEqual(TETO_FRASES);
    });
  }

  // O que sai é a JUSTIFICATIVA nossa ("ainda não é feito pelo aplicativo —
  // por enquanto, só pelas ferramentas de curadoria"), repetida em três
  // desfechos. Quem cura não abre terminal (DECISIONS #78): mandá-lo para uma
  // ferramenta que ele não tem não é o passo seguinte de ninguém.
  it("os desfechos não mandam mais ninguém para as ferramentas de fora", () => {
    for (const [nome, texto] of desfechos) {
      expect(texto.toLowerCase(), nome).not.toContain("ferramentas de curadoria");
    }
  });
});

describe("estimativaTexto — o que a pessoa lê ANTES de disparar", () => {
  // MÉDIO-11: `resetApp` sem pasta nenhuma imprimia "nenhuma música desta
  // pasta está sem título, artista ou letra" — descrevia ZERO músicas como
  // completas. Sem música não há completude a afirmar: há uma pasta a somar.
  it("pasta sem música nenhuma: não afirma completude — diz o que fazer em seguida", () => {
    const texto = completar(pronta(0), 0);
    expect(texto).toContain("Não há nenhuma música nesta pasta");
    expect(texto).toContain("Adicione uma pasta");
    expect(texto).not.toContain("já têm");
  });

  // ALTO-2: a contagem virou uma chamada ao backend. Enquanto ela não volta,
  // a tela não pode inventar "0" — nem travar o disparo por isso.
  it("contagem ainda em curso: estado intermediário honesto, sem número", () => {
    expect(completar({ estado: "contando" }, 12)).toBe(
      "Contando as músicas desta pasta…",
    );
  });

  it("contagem que não veio: admite, sem transformar isso em impedimento", () => {
    const texto = completar({ estado: "indisponivel" }, 12);
    expect(texto).toContain("Não foi possível contar");
    // a busca continua possível: o total aparece quando ela começar
    expect(texto).toContain("A busca funciona mesmo assim");
  });

  // DECISIONS #60 e MÉDIO-11: "todas já têm título, artista e letra" é FALSO
  // para instrumental — que fica de fora justamente por não ter letra.
  it("nada a procurar: diz a regra de verdade, incluindo a marca de instrumental", () => {
    const texto = completar(pronta(0), 12);
    expect(texto).toContain("Nada a procurar nesta pasta");
    expect(texto).toContain("instrumental");
    expect(texto).not.toContain("está sem título, artista ou letra");
  });

  it("uma candidata: singular", () => {
    expect(completar(pronta(1), 12)).toBe(
      "1 música incompleta nesta pasta. A busca leva menos de 1 minuto, mais se" +
        " a internet estiver lenta.",
    );
  });

  // MÉDIO-9: 2 s/música dava "3 minutos" para 95 músicas contra ~10 min reais.
  // Margem de segurança não protege contra erro de ordem de grandeza.
  it("95 candidatas sem o acessório: 9 s por música (LRCLIB + Vagalume)", () => {
    const texto = completar(pronta(95), 200);
    expect(texto).toContain("95 músicas incompletas nesta pasta");
    // 95 × 9 s = 855 s ≈ 14 min
    expect(texto).toContain("por volta de 14 minutos");
    expect(texto).toContain("mais se a internet estiver lenta");
  });

  // V9 — a estimativa deixou de ser um número fixo: ela depende de QUAIS
  // etapas vão rodar nesta máquina. O acessório do som acrescenta uma leitura
  // de áudio e uma consulta ao AcoustID por música.
  it("o acessório do som ligado muda a conta", () => {
    const semSom = completar(pronta(95), 200, SEM_SOM);
    const comSom = completar(pronta(95), 200, COM_SOM);
    expect(semSom).not.toBe(comSom);
    // 95 × 11 s = 1045 s ≈ 17 min
    expect(comSom).toContain("por volta de 17 minutos");
  });

  it("sem chave do Vagalume a etapa 4 não pesa na conta", () => {
    const texto = completar(pronta(95), 200, { som: false, vagalume: false });
    // 95 × 7 s = 665 s ≈ 11 min — o número medido em campo (etapas 1 e 3)
    expect(texto).toContain("por volta de 11 minutos");
  });

  // O número de campo: 16 músicas em ~2 min com as etapas 1 e 3 apenas.
  // A conta tem de reproduzi-lo, ou não é derivação, é chute (DECISIONS #85).
  it("reproduz a medição de campo: 16 músicas, etapas 1 e 3, ~2 minutos", () => {
    const segundos = 16 * segundosPorMusica("completar", { som: false, vagalume: false });
    expect(segundos).toBeGreaterThanOrEqual(100);
    expect(segundos).toBeLessThanOrEqual(140);
  });

  it("acervo grande: o texto passa a horas em vez de imprimir 150 minutos", () => {
    expect(completar(pronta(1000), 2000)).toContain("por volta de 3 horas");
  });

  // A estimativa é uma ORDEM DE GRANDEZA: prometer precisão em cima de uma
  // rede que ninguém controla é a promessa que o QA reprovou.
  it("nunca promete precisão", () => {
    for (const n of [1, 12, 95, 1000]) {
      expect(completar(pronta(n), 2000)).not.toContain("exat");
    }
  });
});

describe("o modo de conferência (V9) — outro trabalho, outro custo", () => {
  const conferir = (contagem: ContagemCandidatas, musicasNaPasta: number) =>
    estimativaTexto({
      contagem,
      musicasNaPasta,
      modo: "conferencia",
      etapas: COM_SOM,
    });

  it("são dois trabalhos, nomeados e explicados — e o padrão é completar", () => {
    expect(MODOS.map((m) => m.modo)).toEqual(["completar", "conferencia"]);
    expect(MODOS[0].rotulo).toContain("Completar");
    expect(MODOS[1].rotulo.toLowerCase()).toContain("etiqueta");
    // o custo do modo caro está na própria explicação, não num parágrafo
    expect(MODOS[1].explicacao).toContain("todas");
  });

  it("cada explicação de modo cabe numa linha", () => {
    for (const m of MODOS) {
      expect(m.explicacao.length, m.explicacao).toBeLessThanOrEqual(90);
    }
  });

  it("o botão diz qual dos dois trabalhos vai começar", () => {
    expect(rotuloDoDisparo("completar")).toBe("Buscar dados desta pasta");
    expect(rotuloDoDisparo("conferencia")).toBe("Conferir esta pasta");
  });

  // A conferência lê o áudio de TODAS as músicas: o custo é por música do
  // acervo, não por música incompleta, e a estimativa precisa dizer isso.
  it("a estimativa conta TODAS as músicas e diz que o áudio é lido", () => {
    const texto = conferir(pronta(150), 150);
    expect(texto).toContain("150 músicas");
    expect(texto).toContain("áudio");
    // 150 × 2 s = 300 s ≈ 5 min
    expect(texto).toContain("por volta de 5 minutos");
    // não é "incompleta": nesta varredura a música completa também entra
    expect(texto).not.toContain("incompleta");
  });

  it("a conferência só roda as etapas 1 e 2 — as de letra são o outro trabalho", () => {
    expect(segundosPorMusica("conferencia", COM_SOM)).toBeLessThan(
      segundosPorMusica("completar", COM_SOM),
    );
  });

  it("sem o acessório, a conferência é impossível e a tela diz por quê", () => {
    expect(CONFERENCIA_PRECISA_DO_SOM.toLowerCase()).toContain("som");
    expect(CONFERENCIA_PRECISA_DO_SOM.length).toBeLessThanOrEqual(90);
  });

  // DECISIONS #86 — nenhum texto pode afirmar o que o programa não sabe. O
  // AcoustID não reconhece toda gravação: silêncio dele NÃO é etiqueta certa.
  it("conferência sem divergência não promete que as etiquetas estão certas", () => {
    const texto = textoSemPropostas(95, "conferencia");
    expect(texto).toContain("95");
    expect(texto).not.toMatch(/incompleta/);
    expect(texto.toLowerCase()).toContain("não reconhece toda gravação");
    expect(texto.toLowerCase()).not.toContain("todas as etiquetas estão certas");
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
  // MÉDIO-11: "todas já têm título, artista e letra" é falso para
  // instrumental, que sai da conta EXATAMENTE por não ter letra.
  it("nenhuma candidata: não promete letra para quem não tem letra a ter", () => {
    const texto = textoSemPropostas(0, "completar");
    expect(texto).toContain("Nenhuma música desta pasta entrou na busca");
    expect(texto).toContain("instrumental");
    expect(texto).not.toContain("todas já têm título, artista e letra");
  });

  it("com candidatas conferidas: conta o que houve e nega a completude", () => {
    const texto = textoSemPropostas(81, "completar");
    expect(texto).toContain("Conferimos as 81 músicas incompletas desta pasta");
    expect(texto).toContain("não achamos nenhuma");
    // não é fracasso e não é "acervo completo" (DECISIONS #60)
    expect(texto).toContain("não significa pasta completa");
  });

  // MÉDIO-11 — `scannedTotal` vinha de `progress?.total ?? 0`, e o `catch` da
  // assinatura de progresso é silencioso: uma varredura que conferiu 95
  // músicas reportava "0" e a tela dizia que a pasta estava completa. Falha
  // silenciosa com cara de sucesso. `null` = não sabemos quantas.
  it("sem saber quantas foram conferidas: não inventa número nem completude", () => {
    const texto = textoSemPropostas(null, "completar");
    expect(texto).toContain("A busca terminou sem nenhuma proposta");
    expect(texto).toContain("não significa pasta completa");
    expect(texto).not.toContain("Nenhuma música desta pasta entrou na busca");
    expect(texto).not.toMatch(/\d+ músicas incompletas/);
  });

  it("uma candidata só: singular", () => {
    expect(textoSemPropostas(1, "completar")).toContain(
      "Conferimos a única música incompleta desta pasta",
    );
  });

  it("o caso pontual do editor recebe o mesmo cuidado", () => {
    expect(SEM_RESULTADO_INDIVIDUAL).toContain("Isso é comum");
    // não pode soar como "esta música está completa"
    expect(SEM_RESULTADO_INDIVIDUAL).not.toContain("completa");
  });

  // ALTO-3b: `null` do funil individual passou a significar UMA coisa —
  // procuramos e não veio nada NOVO. Antes ele também saía sem rede nenhuma
  // (música completa, instrumental), e o texto afirmava a busca que não houve.
  it("o texto do caso pontual fala de 'nada novo', não de música inexistente", () => {
    expect(SEM_RESULTADO_INDIVIDUAL).toContain("nada novo");
  });

  // A música marcada como instrumental para na etapa 1: nenhuma etapa de
  // LETRA roda para ela. Dizer "não achamos nos sites de letra" seria contar
  // uma busca que não aconteceu.
  it("instrumental tem o seu próprio desfecho, e o caminho de volta", () => {
    expect(SEM_RESULTADO_INSTRUMENTAL).toContain("instrumental");
    expect(SEM_RESULTADO_INSTRUMENTAL).toContain("título e artista");
    expect(SEM_RESULTADO_INSTRUMENTAL).toContain("desmarque");
  });
});

// CRÍTICO-1: a linha da revisão precisa DIZER que existe letra ali antes de
// alguém marcar a substituição — e dizer de que tipo ela é.
describe("avisoLetraExistente — o que seria substituído", () => {
  it("letra qualquer: avisa que existe e que, sem marcar, só nomes são aplicados", () => {
    const texto = avisoLetraExistente(null);
    expect(texto).toContain("Já tem letra");
    expect(texto).toContain("só título e artista");
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

// V9 — o LRCLIB devolve a grafia oficial ("Ponto de Oxum" → "Ponto de Oxum
// (Ao Vivo)"), com a duração batendo, portanto ALTA, portanto pré-marcada.
// Um clique levava embora o que alguém digitou à mão.
describe("aviso de troca de nome escrito por gente", () => {
  it("diz o que a linha faria, em uma frase", () => {
    expect(AVISO_NOME_ESCRITO.toLowerCase()).toContain("já existe");
    expect(AVISO_NOME_ESCRITO.length).toBeLessThanOrEqual(90);
    expect(frases(AVISO_NOME_ESCRITO)).toBe(1);
  });
});

// V9 — o vocabulário da revisão fala em "atual" e "proposto". Conflito não é
// isso: é "sua etiqueta diz X, o som diz Y", e nada foi proposto.
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

  it("a confiança mostrada é a do reconhecimento, escrita por extenso", () => {
    expect(confiancaDoSom("alta")).toBe("confiança alta");
    expect(confiancaDoSom("media")).toBe("confiança média");
  });

  // O cabeçalho contava só por confiança, e a linha de conflito tem
  // `confidence: "baixa"` sempre — somá-la ali diria "1 baixa" sobre uma
  // linha que não é palpite fraco nenhum: é uma divergência.
  it("o cabeçalho conta as divergências à parte das propostas", () => {
    expect(textoDoCabecalho({ alta: 1, media: 1, baixa: 1, conflitos: 0 })).toBe(
      "3 propostas — 1 alta, 1 média, 1 baixa",
    );
    expect(textoDoCabecalho({ alta: 1, media: 0, baixa: 0, conflitos: 0 })).toBe(
      "1 proposta — 1 alta, 0 média, 0 baixa",
    );
    expect(textoDoCabecalho({ alta: 0, media: 0, baixa: 0, conflitos: 0 })).toBe(
      "Nenhuma proposta para aplicar.",
    );
  });

  it("só divergências (o desfecho típico da conferência)", () => {
    expect(textoDoCabecalho({ alta: 0, media: 0, baixa: 0, conflitos: 2 })).toBe(
      "2 músicas em que o som discorda da etiqueta",
    );
    expect(textoDoCabecalho({ alta: 0, media: 0, baixa: 0, conflitos: 1 })).toBe(
      "1 música em que o som discorda da etiqueta",
    );
  });

  it("as duas coisas juntas: cada uma com o seu número", () => {
    expect(textoDoCabecalho({ alta: 1, media: 1, baixa: 0, conflitos: 2 })).toBe(
      "2 propostas — 1 alta, 1 média, 0 baixa; e 2 em que o som discorda da" +
        " etiqueta",
    );
  });
});

describe("textoAplicado — o aviso final diz o que MUDOU, nunca uma tarefa", () => {
  it("só letras: a frase do PRD", () => {
    expect(
      textoAplicado({
        ganharamLetra: 47,
        letraSubstituida: 0,
        nomeCorrigido: 0,
        gravadas: 47,
      }),
    ).toBe("47 músicas ganharam letra. A biblioteca já está atualizada.");
  });

  it("letras e correções de nome", () => {
    expect(
      textoAplicado({
        ganharamLetra: 12,
        letraSubstituida: 0,
        nomeCorrigido: 3,
        gravadas: 15,
      }),
    ).toBe(
      "12 músicas ganharam letra e 3 tiveram título ou artista corrigidos." +
        " A biblioteca já está atualizada.",
    );
  });

  it("só correções de nome", () => {
    expect(
      textoAplicado({
        ganharamLetra: 0,
        letraSubstituida: 0,
        nomeCorrigido: 1,
        gravadas: 1,
      }),
    ).toBe(
      "1 música teve título ou artista corrigido. A biblioteca já está atualizada.",
    );
  });

  it("singular da letra", () => {
    expect(
      textoAplicado({
        ganharamLetra: 1,
        letraSubstituida: 0,
        nomeCorrigido: 0,
        gravadas: 1,
      }),
    ).toBe("1 música ganhou letra. A biblioteca já está atualizada.");
  });

  // MÉDIO-13: letra gravada por cima de letra existente era reportada como
  // "teve título ou artista corrigido" — a metade destrutiva ficava invisível
  // até depois do fato. Ela vem PRIMEIRO por ser a única irreversível.
  it("letra substituída é contada, dita e vem na frente", () => {
    expect(
      textoAplicado({
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

  it("uma letra substituída, sozinha: singular", () => {
    expect(
      textoAplicado({
        ganharamLetra: 0,
        letraSubstituida: 1,
        nomeCorrigido: 0,
        gravadas: 1,
      }),
    ).toBe("1 música teve a letra substituída. A biblioteca já está atualizada.");
  });

  it("gravou sem mudar conteúdo: não inventa ganho que não houve", () => {
    expect(
      textoAplicado({
        ganharamLetra: 0,
        letraSubstituida: 0,
        nomeCorrigido: 0,
        gravadas: 2,
      }),
    ).toBe("2 músicas foram gravadas, sem mudança no conteúdo.");
  });

  // PRD V8: "não haverá popup pedindo para reindexar nem para reiniciar"
  it("nunca pede reindexação nem reinício", () => {
    for (const t of [
      textoAplicado({ ganharamLetra: 47, letraSubstituida: 0, nomeCorrigido: 0, gravadas: 47 }),
      textoAplicado({ ganharamLetra: 12, letraSubstituida: 2, nomeCorrigido: 3, gravadas: 17 }),
      textoAplicado({ ganharamLetra: 0, letraSubstituida: 0, nomeCorrigido: 1, gravadas: 1 }),
      textoAplicado({ ganharamLetra: 0, letraSubstituida: 0, nomeCorrigido: 0, gravadas: 2 }),
    ]) {
      expect(t.toLowerCase()).not.toContain("reindex");
      expect(t.toLowerCase()).not.toContain("reinici");
    }
  });
});

describe("o que a seção de curadoria promete", () => {
  it("sem o acessório, a etapa do som NÃO é listada — ela não vai rodar", () => {
    expect(etapasDoFunil(false).map((e) => e.nome)).toEqual([
      "O que já está no arquivo",
      "LRCLIB",
      "Vagalume",
    ]);
  });

  // V9 — a fase A ("que música é esta?") vem ANTES das fontes de letra: a
  // impressão digital não devolve letra, devolve identidade, que é entrada
  // das outras etapas.
  it("com o acessório, o som entra em segundo — antes das bases de letra", () => {
    expect(etapasDoFunil(true).map((e) => e.nome)).toEqual([
      "O que já está no arquivo",
      "Reconhecer pelo som",
      "LRCLIB",
      "Vagalume",
    ]);
  });

  // Nada do acervo sai da máquina — nem na etapa que "manda o áudio":
  // o que viaja é um resumo acústico. É invariável do produto e a única
  // explicação que essas pessoas vão receber.
  it("a etapa do som diz o que sai do computador", () => {
    const som = etapasDoFunil(true)[1];
    expect(som.explicacao).toContain("resumo");
    expect(som.explicacao.toLowerCase()).not.toContain("envia o áudio");
  });

  it("cada explicação de etapa cabe numa linha", () => {
    for (const e of etapasDoFunil(true)) {
      expect(e.explicacao.length, e.explicacao).toBeLessThanOrEqual(80);
    }
  });

  // O texto antigo negava DUAS coisas: reconhecer pelo som e escrever a letra
  // ouvindo o áudio. A primeira passou a existir — continuar negando-a seria
  // mentir sobre o próprio produto.
  it("o que ainda não é feito aqui não inclui mais o reconhecimento pelo som", () => {
    expect(ETAPAS_FORA_DO_APP).toContain("ainda não");
    expect(ETAPAS_FORA_DO_APP.toLowerCase()).not.toContain("reconhecer");
    expect(ETAPAS_FORA_DO_APP).toContain("ouvindo o áudio");
    expect(ETAPAS_FORA_DO_APP.length).toBeLessThanOrEqual(90);
  });

  it("o endereço da chave gratuita do Vagalume é o oficial", () => {
    expect(VAGALUME_URL).toBe("https://auth.vagalume.com.br/settings/api/");
  });
});

// ---------------------------------------------------------------------------
// Acessórios (V9) — nada baixa sozinho, e a tela diz o que vai baixar
// ---------------------------------------------------------------------------

describe("formatarTamanho — o 'quanto ocupa' que a pessoa lê antes de decidir", () => {
  it("megabytes com uma casa e vírgula decimal (pt-BR)", () => {
    expect(formatarTamanho(3_418_112)).toBe("3,3 MB");
    expect(formatarTamanho(5_538_312)).toBe("5,3 MB");
  });

  it("abaixo de 1 MB fala em kB, sem casa decimal", () => {
    expect(formatarTamanho(65_536)).toBe("64 kB");
    expect(formatarTamanho(0)).toBe("0 kB");
  });
});

describe("a copy dos acessórios", () => {
  const fpcalc = {
    nome: "fpcalc",
    para_que_serve: "reconhecer a música pelo som",
    arquivo: "fpcalc-linux-x86_64",
    tamanho_bytes: 5_538_312,
    estado: "ausente" as const,
    origem: "https://github.com/exemplo/releases/download/acessorios-v1/fpcalc",
  };

  // Regra 1 do PRD V9: a tela diz ANTES o que vai baixar e quanto ocupa.
  it("antes de baixar: para que serve e quanto ocupa, na mesma frase", () => {
    const texto = textoDoAcessorioAusente(fpcalc);
    expect(texto).toContain("reconhecer a música pelo som");
    expect(texto).toContain("5,3 MB");
    expect(texto.length).toBeLessThanOrEqual(140);
  });

  // Regra 3: baixou uma vez, não pergunta de novo.
  it("o rótulo do botão carrega o tamanho, e o de repetição diz que é de novo", () => {
    expect(rotuloBaixarAcessorio(fpcalc, false)).toBe("Baixar (5,3 MB)");
    expect(rotuloBaixarAcessorio(fpcalc, true)).toBe("Baixar de novo (5,3 MB)");
  });

  // `total: null` = o servidor não anunciou o tamanho. NÃO é 0: uma barra de
  // 0% de um arquivo vazio é a falha silenciosa da DECISIONS #86.
  it("o progresso vive sem o total, em vez de inventar 0", () => {
    expect(textoDoDownload(1_048_576, 5_538_312)).toBe("Baixando… 1,0 MB de 5,3 MB");
    expect(textoDoDownload(1_048_576, null)).toBe("Baixando… 1,0 MB");
  });

  // O estado do acessório é uma ida ao backend, e ela pode falhar. "Não
  // sabemos" não pode virar "não existe" nem "está pronto" (DECISIONS #86).
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

  // "corrompido precisa de tratamento próprio e sem drama": o arquivo não
  // confere, foi descartado, e a saída é baixar de novo.
  it("corrompido: sem drama e com a saída na mesma frase", () => {
    expect(ACESSORIO_CORROMPIDO.toLowerCase()).toContain("não confere");
    expect(ACESSORIO_CORROMPIDO.toLowerCase()).toContain("de novo");
    expect(frases(ACESSORIO_CORROMPIDO)).toBeLessThanOrEqual(2);
  });

  it("pronto: uma frase, e nenhum pedido de ação", () => {
    expect(frases(ACESSORIO_PRONTO)).toBe(1);
    expect(ACESSORIO_PRONTO.toLowerCase()).toContain("som");
  });

  // Cancelar e falhar terminam os dois com o acessório ausente: a tela
  // precisa saber qual dos dois aconteceu sem adivinhar.
  it("cancelado é dito como cancelado, não como falha", () => {
    expect(ACESSORIO_CANCELADO.toLowerCase()).toContain("cancelad");
    expect(ACESSORIO_CANCELADO.toLowerCase()).not.toContain("erro");
    expect(frases(ACESSORIO_CANCELADO)).toBeLessThanOrEqual(2);
  });
});
