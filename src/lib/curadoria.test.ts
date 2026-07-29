import { describe, expect, it } from "vitest";
import { buildFolderTree } from "./folderTree";
import {
  ETAPAS_DENTRO_DO_APP,
  ETAPAS_FORA_DO_APP,
  LABEL_SUBSTITUIR_LETRA,
  SEM_RESULTADO_INDIVIDUAL,
  SEM_RESULTADO_INSTRUMENTAL,
  VAGALUME_URL,
  avisoLetraExistente,
  estimativaTexto,
  opcoesDePasta,
  textoAplicado,
  textoSemPropostas,
  type ContagemCandidatas,
} from "./curadoria";
import type { Folder, Song } from "./types";

/** Contagem já respondida pelo backend (`enrich_count`). */
const pronta = (total: number): ContagemCandidatas => ({ estado: "pronta", total });

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

describe("estimativaTexto — o que a pessoa lê ANTES de disparar", () => {
  // MÉDIO-11: `resetApp` sem pasta nenhuma imprimia "nenhuma música desta
  // pasta está sem título, artista ou letra" — descrevia ZERO músicas como
  // completas. Sem música não há completude a afirmar: há uma pasta a somar.
  it("pasta sem música nenhuma: não afirma completude — diz o que fazer em seguida", () => {
    const texto = estimativaTexto(pronta(0), 0);
    expect(texto).toContain("Não há nenhuma música nesta pasta");
    expect(texto).toContain("Adicione uma pasta de música");
    expect(texto).not.toContain("já têm");
  });

  // ALTO-2: a contagem virou uma chamada ao backend. Enquanto ela não volta,
  // a tela não pode inventar "0" — nem travar o disparo por isso.
  it("contagem ainda em curso: estado intermediário honesto, sem número", () => {
    expect(estimativaTexto({ estado: "contando" }, 12)).toBe(
      "Contando quantas músicas desta pasta precisam de busca…",
    );
  });

  it("contagem que não veio: admite, sem transformar isso em impedimento", () => {
    const texto = estimativaTexto({ estado: "indisponivel" }, 12);
    expect(texto).toContain("Não foi possível contar");
    // a busca continua possível: o total aparece quando ela começar
    expect(texto).toContain("A busca funciona mesmo assim");
  });

  // DECISIONS #60 e MÉDIO-11: "todas já têm título, artista e letra" é FALSO
  // para instrumental — que fica de fora justamente por não ter letra.
  it("nada a procurar: diz a regra de verdade, incluindo a marca de instrumental", () => {
    const texto = estimativaTexto(pronta(0), 12);
    expect(texto).toContain("Nada a procurar nesta pasta");
    expect(texto).toContain("instrumental");
    expect(texto).not.toContain("está sem título, artista ou letra");
  });

  it("uma candidata: singular", () => {
    expect(estimativaTexto(pronta(1), 12)).toBe(
      "1 música desta pasta está incompleta. A busca leva menos de 1 minuto," +
        " e bem mais se a internet estiver lenta ou fora do ar.",
    );
  });

  // MÉDIO-9: 2 s/música dava "3 minutos" para 95 músicas contra ~10 min reais.
  // Margem de segurança não protege contra erro de ordem de grandeza.
  it("95 candidatas: por volta de 11 minutos, não 3", () => {
    const texto = estimativaTexto(pronta(95), 200);
    expect(texto).toContain("95 músicas desta pasta estão incompletas");
    expect(texto).toContain("por volta de 11 minutos");
    expect(texto).toContain("bem mais se a internet estiver lenta");
  });

  it("acervo grande: o texto passa a horas em vez de imprimir 116 minutos", () => {
    expect(estimativaTexto(pronta(1000), 2000)).toContain("por volta de 2 horas");
  });

  // A estimativa é uma ORDEM DE GRANDEZA: prometer precisão em cima de uma
  // rede que ninguém controla é a promessa que o QA reprovou.
  it("nunca promete precisão", () => {
    for (const n of [1, 12, 95, 1000]) {
      expect(estimativaTexto(pronta(n), 2000)).not.toContain("exat");
    }
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
    const texto = textoSemPropostas(0);
    expect(texto).toContain("Nenhuma música desta pasta entrou na busca");
    expect(texto).toContain("instrumental");
    expect(texto).not.toContain("todas já têm título, artista e letra");
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

  // MÉDIO-11 — `scannedTotal` vinha de `progress?.total ?? 0`, e o `catch` da
  // assinatura de progresso é silencioso: uma varredura que conferiu 95
  // músicas reportava "0" e a tela dizia que a pasta estava completa. Falha
  // silenciosa com cara de sucesso. `null` = não sabemos quantas.
  it("sem saber quantas foram conferidas: não inventa número nem completude", () => {
    const texto = textoSemPropostas(null);
    expect(texto).toContain("A busca terminou e não trouxe nenhuma proposta");
    expect(texto).toContain("não quer dizer que a pasta esteja completa");
    expect(texto).not.toContain("Nenhuma música desta pasta entrou na busca");
    expect(texto).not.toMatch(/\d+ músicas incompletas/);
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

  // ALTO-3b: `null` do funil individual passou a significar UMA coisa —
  // procuramos e não veio nada NOVO. Antes ele também saía sem rede nenhuma
  // (música completa, instrumental), e o texto afirmava a busca que não houve.
  it("o texto do caso pontual fala de 'nada novo', não de música inexistente", () => {
    expect(SEM_RESULTADO_INDIVIDUAL).toContain("nada novo");
  });

  // A música marcada como instrumental para na etapa 1: nenhuma etapa de
  // LETRA roda para ela. Dizer "não achamos nos sites de letra" seria contar
  // uma busca que não aconteceu.
  it("instrumental tem o seu próprio desfecho: os sites de letra não foram consultados", () => {
    expect(SEM_RESULTADO_INSTRUMENTAL).toContain("instrumental");
    expect(SEM_RESULTADO_INSTRUMENTAL).toContain("não procurou letra");
    expect(SEM_RESULTADO_INSTRUMENTAL).toContain("o título e o artista");
  });
});

// CRÍTICO-1: a linha da revisão precisa DIZER que existe letra ali antes de
// alguém marcar a substituição — e dizer de que tipo ela é.
describe("avisoLetraExistente — o que seria substituído", () => {
  it("letra qualquer: avisa que existe e que, sem marcar, só nomes são aplicados", () => {
    const texto = avisoLetraExistente(null);
    expect(texto).toContain("Esta música já tem letra");
    expect(texto).toContain("só o título e o artista");
  });

  it("letra transcrita: usa o vocabulário do projeto e lembra da correção à mão", () => {
    const texto = avisoLetraExistente("transcricao");
    expect(texto).toContain("escrita ouvindo o áudio");
    expect(texto).toContain("corrigida à mão");
  });

  it("o rótulo da marcação é o mesmo que o backend cita ao recusar", () => {
    expect(LABEL_SUBSTITUIR_LETRA).toBe("Substituir a letra atual");
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
