import type { AcessorioInfo, Contagem, EnrichProposal } from "./api";
import type { FolderNode } from "./folderTree";
import { FONTE_TRANSCRICAO, ORIGEM_TRANSCRICAO } from "./types";

/**
 * O funil de curadoria dentro do app (PRD V8/F18 fase 1; V9 fase 2; V10 fase 3).
 *
 * Este módulo só tem função pura: agrupamento, formatação e — o que mais
 * importa neste produto — a COPY. São ~40 pessoas curando cada uma o seu
 * acervo, em máquinas que o dono do produto não pode olhar, sem ninguém para
 * perguntar. Por isso o texto mora em funções testadas, e não solto no JSX.
 *
 * # A régua (DECISIONS #100)
 *
 * - a PRIMEIRA frase diz o que é;
 * - o resto só existe se responder a uma pergunta que a pessoa faria NAQUELE
 *   momento;
 * - desfechos em 2 frases e 210 caracteres;
 * - nada de jargão nosso.
 *
 * # O que a V10 tirou daqui, e por quê
 *
 * **O modelo de custo em TypeScript foi APAGADO.** Havia `segundosPorMusica`,
 * `CUSTO_SOM`, `CUSTO_LRCLIB` e `CUSTO_VAGALUME` — uma segunda conta, ao lado
 * da do Rust. É a DECISIONS #80, que neste projeto já aconteceu duas vezes
 * (`musicasACurar` e `SEGUNDOS_POR_MUSICA`): a cópia diverge, e a divergência
 * escolhe o pior momento para aparecer. A estimativa agora chega pronta em
 * `Contagem.segundos_estimados`; aqui ela só é formatada.
 *
 * **Os modos sumiram** (DECISIONS #102). Não há mais `Modo`, `MODOS`,
 * `rotuloDoDisparo(modo)` nem `motivoDaConferencia`: é uma varredura só, em
 * todas as músicas da pasta, e um botão só.
 *
 * **A chave do Vagalume sumiu** (DECISIONS #110). Não há mais `VAGALUME_URL`
 * nem `textoDaChaveDoVagalume`: a etapa 4 passou a ser o `lyrics.ovh`, que não
 * pede credencial, e com isso **nenhuma etapa do funil pede nada de quem usa**.
 * Era o último pedágio de configuração do produto, numa tela usada por ~40
 * pessoas leigas — e o texto que o explicava saiu junto, porque texto que não
 * descreve nada é o que ensina a ignorar o resto da tela.
 */

// ---------------------------------------------------------------------------
// Tempo — um formatador só, para não haver duas maneiras de dizer "3 horas"
// ---------------------------------------------------------------------------

/** "menos de 1 minuto" / "1 minuto" / "11 minutos" / "1 hora" / "3 horas". */
function tempoCurto(segundos: number): string {
  if (segundos < 60) return "menos de 1 minuto";
  const minutos = Math.round(segundos / 60);
  // V10.4 — o singular existia para "1 hora" e não para "1 minuto". A faixa
  // era inalcançável enquanto a banda de referência do download era de 1 MB/s
  // (nenhum acessório caía entre 60 e 89 s); com a referência honesta os
  // 190 MB do modelo pequeno caíam bem ali, e a tela diria "cerca de 1
  // minutos". O modelo pequeno saiu do catálogo na V10.5, mas o singular fica:
  // ele é do FORMATADOR, e o próximo acessório de tamanho médio o alcança de
  // novo sem ninguém lembrar disto aqui.
  if (minutos < 90) return minutos === 1 ? "1 minuto" : `${minutos} minutos`;
  const horas = Math.round(minutos / 60);
  return horas === 1 ? "1 hora" : `${horas} horas`;
}

/**
 * "menos de 1 minuto" / "por volta de 11 minutos" — a forma da ESTIMATIVA,
 * que é uma ordem de grandeza e nunca uma promessa (DECISIONS #85).
 */
function duracaoAproximada(segundos: number): string {
  const curto = tempoCurto(segundos);
  return segundos < 60 ? curto : `por volta de ${curto}`;
}

/**
 * "menos de 1 minuto" / "cerca de 3 horas".
 *
 * "cerca de menos de 1 minuto" é o tipo de frase que sai de formatador reusado
 * sem olhar — e num produto sem suporte cada frase estranha é uma dúvida que
 * ninguém vai poder tirar.
 */
function cercaDe(segundos: number): string {
  return segundos < 60 ? "menos de 1 minuto" : `cerca de ${tempoCurto(segundos)}`;
}

/** "falta menos de 1 minuto" / "faltam cerca de 2 horas". */
function tempoQueFalta(segundos: number): string {
  return segundos < 60
    ? "falta menos de 1 minuto"
    : `faltam cerca de ${tempoCurto(segundos)}`;
}

// ---------------------------------------------------------------------------
// As etapas do funil — a lista vem do backend (DECISIONS #101)
// ---------------------------------------------------------------------------

/** Uma etapa do funil, como ela é explicada ANTES de a busca começar. */
export interface EtapaDoFunil {
  nome: string;
  explicacao: string;
}

/**
 * A explicação de cada etapa, indexada pelo nome que o BACKEND manda.
 *
 * Quais etapas rodam é decisão do Rust (`Contagem.etapas`): ele sabe se o
 * acessório está pronto e se há chave. O que mora aqui é só a frase que a
 * pessoa lê — e ela existe porque "reconhecendo pelo som" não diz, sozinho, o
 * que sai do computador, que é a pergunta que alguém faz sobre um app que se
 * vende como offline.
 */
const EXPLICACAO_DA_ETAPA: Record<string, string> = {
  "lendo etiquetas e nome do arquivo": "sem sair do computador.",
  // "nada do acervo sai da máquina" é invariável do produto, e esta é a única
  // etapa que poderia parecer contrariá-lo: o que viaja é um resumo acústico
  // de alguns bytes, nunca o áudio.
  "reconhecendo pelo som":
    "manda um resumo do áudio ao AcoustID; o áudio não sai daqui.",
  // "na internet" faz par com "sem sair do computador" da etapa 1.
  "procurando no LRCLIB": "banco de letras aberto e gratuito, na internet.",
  // V10 — esta etapa não pede chave (é o que a trouxe para o produto), mas ela
  // também não devolve o nome da música: é a única do funil cujo casamento o
  // programa não tem como conferir. Isso vale uma frase AQUI, e não só na
  // linha da proposta — quem lê a lista está decidindo se manda buscar.
  "procurando no lyrics.ovh":
    "outro site de letras; ele não diz de que música é a letra.",
};

/** Primeira letra maiúscula, sem tocar no resto (nomes próprios inclusive). */
function comMaiuscula(texto: string): string {
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

/**
 * As etapas que ESTA máquina vai executar, na ordem em que rodam.
 *
 * A lista chega pronta do backend e NÃO é reordenada nem filtrada aqui: a
 * ordem é conteúdo (primeiro "que música é esta?", depois "qual é a letra
 * dela?"), e a decisão de listar ou não uma etapa é a DECISIONS #101 — a tela
 * lista o que esta máquina faz, não o que o produto sabe fazer.
 *
 * Etapa que esta versão não conhece (backend mais novo) aparece com o nome
 * cru e sem explicação: esconder a etapa seria mentir sobre o que vai rodar, e
 * inventar a explicação seria pior.
 */
export function etapasDoFunil(nomes: readonly string[]): EtapaDoFunil[] {
  return nomes.map((nome) => ({
    nome: comMaiuscula(nome),
    explicacao: EXPLICACAO_DA_ETAPA[nome] ?? "",
  }));
}

/**
 * A etapa 5 existe, e é perguntada no FIM.
 *
 * Substitui o `ETAPAS_FORA_DO_APP` da V9, que dizia "escrever a letra ouvindo
 * o áudio ainda não é feito aqui dentro" — deixou de ser verdade nesta versão,
 * e texto que mente sobre o próprio produto é defeito (DECISIONS #100, a
 * salvaguarda de CONFERIR antes de encurtar).
 *
 * Ela não entra na lista numerada de propósito: não é uma etapa da varredura.
 * Custa minutos por música, e a pergunta do fim só pode ser feita quando o app
 * já sabe quantas sobraram.
 *
 * **V10.6 — e a pergunta do fim deixou de ser a ÚNICA porta.** Ela continua
 * sendo o momento natural, mas o bloco permanente de Configurações responde a
 * mesma coisa a qualquer hora — porque "quais músicas estão sem letra" é fato
 * da biblioteca, não resultado de varredura. Este texto tem de dizer as duas,
 * ou volta a mentir sobre o próprio produto.
 */
export const TRANSCRICAO_NO_FIM =
  "Escrever a letra ouvindo o áudio é oferecido no fim da busca — e aqui" +
  " embaixo, a qualquer momento.";

// ---------------------------------------------------------------------------
// A contagem e a estimativa — números do backend, formatados aqui
// ---------------------------------------------------------------------------

/**
 * A contagem é uma ida ao backend, e ela tem três estados. Os três são ditos
 * na tela: nenhum deles pode virar "0" por omissão (DECISIONS #86).
 */
export type EstadoDaContagem =
  | { estado: "contando" }
  | { estado: "pronta"; contagem: Contagem }
  | { estado: "indisponivel" };

/** O trabalho a anunciar: o que o backend contou, e o que há na pasta. */
export interface Estimativa {
  contagem: EstadoDaContagem;
  /**
   * Quantas músicas há na pasta, ponto — fato local e barato. Existe para
   * separar "não há nada aqui" de "há músicas, mas nenhuma disponível": a
   * contagem sozinha devolve 0 nos dois casos, e descrever uma pasta vazia
   * como qualquer outra coisa é a mentira que o QA pegou rodando o app sem
   * nenhuma pasta adicionada.
   */
  musicasNaPasta: number;
}

/**
 * O que aparece embaixo do seletor de pasta, antes de qualquer clique.
 * "O custo por pessoa importa mais" (PRD V8): saber quantas músicas e quanto
 * tempo deixa de ser conveniência e vira parte do fluxo.
 */
export function estimativaTexto({ contagem, musicasNaPasta }: Estimativa): string {
  if (musicasNaPasta <= 0) {
    return "Não há nenhuma música nesta pasta. Adicione uma pasta ou escolha outra na lista acima.";
  }
  if (contagem.estado === "contando") {
    return "Contando as músicas desta pasta…";
  }
  if (contagem.estado === "indisponivel") {
    return (
      "Não foi possível contar as músicas desta pasta. A busca funciona mesmo" +
      " assim: o total aparece quando ela começar."
    );
  }
  const { total, segundos_estimados } = contagem.contagem;
  if (total <= 0) {
    // V10 — com o caminho único, zero aqui NÃO significa "está tudo completo":
    // a varredura olha todas as músicas disponíveis da pasta. Sobrou um caso
    // só, e ele é sobre disponibilidade, não sobre completude.
    return "Nenhuma música desta pasta está disponível para a busca.";
  }
  const quantas = total === 1 ? "1 música nesta pasta" : `${total} músicas nesta pasta`;
  // A mitigação da DECISIONS #85 são estas duas metades: "BEM mais" (a
  // estimativa erra por fator, não por margem) e a rede FORA DO AR, que é
  // justamente o caso em que a busca demora um múltiplo do previsto.
  return (
    `${quantas}. A busca leva ${duracaoAproximada(segundos_estimados)}, e bem` +
    " mais se a internet estiver lenta ou fora do ar."
  );
}

/** O botão. Um só — não há mais o que escolher (DECISIONS #102). */
export const ROTULO_DO_DISPARO = "Buscar dados desta pasta";

/** Uma linha do seletor de pasta da seção de curadoria. */
export interface OpcaoDePasta {
  /** Prefixo passado à varredura ("" = biblioteca inteira). */
  path: string;
  label: string;
  /** Profundidade na árvore — vira recuo visual na lista. */
  nivel: number;
}

/**
 * Achata a árvore da lateral no seletor de Configurações, começando por
 * "Toda a biblioteca". É a mesma árvore que a pessoa já conhece: a seção de
 * curadoria não pode inventar um segundo vocabulário de pastas.
 */
export function opcoesDePasta(tree: FolderNode[]): OpcaoDePasta[] {
  const opcoes: OpcaoDePasta[] = [
    { path: "", label: "Toda a biblioteca", nivel: 0 },
  ];
  function descer(nodes: FolderNode[], nivel: number): void {
    for (const node of nodes) {
      opcoes.push({ path: node.path, label: node.name, nivel });
      descer(node.children, nivel + 1);
    }
  }
  descer(tree, 0);
  return opcoes;
}

// ---------------------------------------------------------------------------
// Os desfechos da varredura
// ---------------------------------------------------------------------------

/**
 * A segunda frase de todo desfecho vazio: nem fracasso, nem pasta completa.
 * Responde à pergunta que a pessoa faz naquele segundo ("então está pronto?"),
 * e responder errado é o defeito da DECISIONS #60.
 */
const NAO_E_FRACASSO =
  "Isso é comum e não significa pasta completa: a maior parte do repertório" +
  " cantado em casa nunca foi publicada.";

/** A primeira frase do desfecho com a etapa 2 desligada: o fato, com o número. */
function pararamNoMeio(quantas: number): string {
  const musicas =
    quantas === 1
      ? "1 música não chegou a ser perguntada"
      : `${quantas} músicas não chegaram a ser perguntadas`;
  return `O reconhecimento pelo som parou no meio: ${musicas}.`;
}

/**
 * Fim de varredura sem NENHUMA proposta (DECISIONS #60).
 *
 * Com ~3% de cobertura no acervo real, este é o desfecho MAIS COMUM — não uma
 * exceção. Ele precisa contar o que foi feito e negar a completude.
 */
export function textoSemPropostas(
  total: number | null,
  /**
   * Quantas músicas a etapa 2 deixou de perguntar ao som depois de se desligar
   * (QA A2). Vem no RETORNO da varredura, não do progresso — por isso não
   * desaparece quando a assinatura de progresso falha.
   */
  semPerguntarAoSom = 0,
): string {
  // Vem ANTES de tudo porque é o fato DOMINANTE: dizer "conferimos 40 músicas
  // e não achamos nada" quando 37 nunca foram perguntadas é falso duas vezes.
  if (semPerguntarAoSom > 0) {
    return `${pararamNoMeio(semPerguntarAoSom)} Nas outras não achamos nada — repita a busca quando ele voltar a funcionar.`;
  }
  // `null` = a varredura terminou mas o acompanhamento do progresso não chegou
  // (a assinatura é best-effort e o catch é silencioso). Antes isso virava
  // `0`, e o texto do zero afirmava completude (QA MÉDIO-11).
  if (total === null) {
    return `A busca terminou sem nenhuma proposta. ${NAO_E_FRACASSO}`;
  }
  if (total <= 0) {
    return `Nenhuma música desta pasta entrou na busca. ${NAO_E_FRACASSO}`;
  }
  const conferidas =
    total === 1
      ? "Conferimos a única música desta pasta e não achamos nada."
      : `Conferimos as ${total} músicas desta pasta e não achamos nada.`;
  return `${conferidas} ${NAO_E_FRACASSO}`;
}

/**
 * O aviso que acompanha um desfecho COM propostas. `null` quando não há nada a
 * dizer — e zero é o caso normal de toda varredura que correu bem: um
 * "0 músicas ficaram sem ser perguntadas" em cada desfecho é o ruído que ensina
 * a pessoa a ignorar o aviso justamente quando ele importar.
 *
 * O "o que fazer em seguida" NÃO chuta a causa: o número não distingue o
 * acessório que não roda nesta máquina do AcoustID que recusou o aplicativo, e
 * mandar procurar antivírus quando o problema é do servidor alheio é pior que
 * não mandar nada.
 */
export function avisoSemPerguntarAoSom(quantas: number): string | null {
  if (quantas <= 0) return null;
  return `${pararamNoMeio(quantas)} Repita a busca quando ele voltar a funcionar.`;
}

/**
 * O mesmo desfecho, para UMA música (o caso pontual do editor). "Não achamos"
 * não pode soar como fracasso da pessoa nem como "não há nada a fazer aqui".
 */
export const SEM_RESULTADO_INDIVIDUAL =
  "Procuramos e não achamos nada novo para esta música. Isso é comum: a maior" +
  " parte do repertório cantado em casa nunca foi publicada.";

/**
 * O mesmo desfecho para uma música marcada como INSTRUMENTAL. Nenhuma etapa de
 * LETRA roda para música sem voz (V8/F17): repetir "não achamos nos sites de
 * letra" contaria uma busca que não aconteceu.
 */
export const SEM_RESULTADO_INSTRUMENTAL =
  "Esta música está marcada como instrumental: procuramos só título e artista," +
  " e não achamos nada novo. Para procurar letra, desmarque “Esta música é" +
  " instrumental”.";

// ---------------------------------------------------------------------------
// V10 — a revisão ordenada por RISCO
// ---------------------------------------------------------------------------
//
// Medição de campo, numa revisão de 53 músicas: *"eu nem li as sugestões em
// baixa… não deu vontade de ler mesmo"*. Não é preferência, é comportamento —
// e é o que as 40 pessoas vão fazer.
//
// O corte por CONFIANÇA junta o mais seguro (preencher um campo vazio) com o
// mais perigoso (trocar um nome que alguém escreveu), e é por isso que a lista
// parece ruído. **Confiança baixa não quer dizer "provavelmente errado"; quer
// dizer "sem prova externa".**
//
// Esconder as linhas foi considerado e RECUSADO: nada é gravado sem revisão,
// então esconder é *perder* a correção — e com ~3% de cobertura dos sites de
// letra, arrumar nome pelo arquivo é a principal coisa que o app faz por este
// repertório.

/**
 * A ordem de cima para baixo, do mais arriscado ao mais inócuo — e ela **é** a
 * lista dos grupos que existem (`GrupoDaRevisao` sai daqui).
 *
 * Ser a mesma coisa é de propósito, e é a V10.7 fechando um buraco de omissão:
 * `agruparPorRisco` percorre esta lista para montar a tela, então um grupo que
 * esteja no tipo e não aqui não aparece — ele e as linhas dele DESAPARECEM, sem
 * quebrar teste nenhum. Derivando o tipo da ordem, esquecer de listar um grupo
 * novo deixou de ser possível.
 *
 * É a ordem do PRD V10, com os acréscimos que ele não tinha como prever:
 *
 * - **sem-voz** ficou entre as letras e as trocas de nome. Não cabia em
 *   "letras encontradas" (não há letra) nem no grupo dobrado (a marca tira o
 *   arquivo da fila para sempre, e dobrada+pré-marcada ela seria gravada sem
 *   ninguém ver);
 * - **os dois grupos de falha** vêm perto do fim. Linha com falha não é
 *   proposta e não pode cair no grupo dobrado, que é pré-marcado — mas também
 *   não pode sumir: ela é a única informação de que aquela música foi tentada
 *   (DECISIONS #47);
 * - **gravadas** fecha a lista (V10.6). Aplicar deixou de fechar a caixa, então
 *   as linhas gravadas continuam na tela — e elas são as ÚNICAS sem nada a
 *   decidir. Ficam no fim por isso, e num grupo próprio por dois motivos
 *   práticos: a frase do grupo dobrado diz "vão receber", que passa a ser
 *   mentira sobre uma linha já gravada, e a contagem de cada grupo volta a
 *   medir o que falta em vez do que já foi.
 *
 * # V10.7 — por que `nao-gravadas` vem ANTES de `nao-consultadas`
 *
 * As duas são falhas, e nenhuma delas é uma decisão a tomar; o que as ordena é
 * o que a pessoa faz em seguida.
 *
 * - **`nao-gravadas`** é consequência direta do clique que ela ACABOU de dar. É
 *   informação nova, que ela está procurando na tela naquele segundo — e é a
 *   única cujo motivo aponta para algo do computador dela (arquivo aberto em
 *   outro programa, disco cheio, pasta sincronizada), que ela pode conferir e
 *   refazer a busca depois. Fica em cima das duas por isso.
 * - **`nao-consultadas`** é só registro: o programa não descobriu nada sobre
 *   aquela música, não há proposta, e repetir o clique não muda nada — o que
 *   pode mudar é a internet, mais tarde. Ela existe para a música não sumir em
 *   silêncio (DECISIONS #47), e é o penúltimo lugar da lista.
 *
 * As duas continuam DEPOIS do grupo dobrado: o alto da lista é para o que um
 * clique distraído estraga, e nestas duas não há clique nenhum.
 */
export const ORDEM_DOS_GRUPOS = [
  "conflitos",
  "letras",
  "sem-voz",
  "nomes-escritos",
  "preenchimentos",
  "nao-gravadas",
  "nao-consultadas",
  "gravadas",
] as const;

/** Um grupo da revisão. A lista — e a ordem — é a `ORDEM_DOS_GRUPOS`. */
export type GrupoDaRevisao = (typeof ORDEM_DOS_GRUPOS)[number];

/**
 * Em que grupo esta linha entra. `erro` é o erro EFETIVO da linha — o da
 * proposta ou o que o apply devolveu —, resolvido por quem chama: o backend
 * pode ter recusado uma linha que a varredura tinha aprovado.
 *
 * A confiança não entra nesta decisão em momento nenhum. Ela continua na linha
 * como informação (a mesma ALTA vinda do LRCLIB e de um palpite de nome de
 * arquivo não se decidem igual), mas não organiza mais nada.
 *
 * **V10.7 — as duas falhas deixaram de ser uma só.** Elas caíam juntas em
 * `"erros"`, e o cabeçalho daquele grupo dizia "não puderam ser consultadas".
 * Relato de campo: 7 músicas com proposta e selo MÉDIA — consultadas com
 * sucesso, portanto — falharam ao GRAVAR, e a tela afirmou o oposto do que
 * aconteceu, para quem não tem a quem perguntar. O que separa os dois grupos é
 * o que sobra para a pessoa fazer:
 *
 * - **consulta**: o programa não descobriu nada sobre a música. Não há proposta
 *   e não há o que aplicar;
 * - **gravação**: o programa descobriu, a pessoa mandou gravar, e o arquivo
 *   recusou. A sugestão continua ali, e o que falhou foi escrever.
 */
export function grupoDaProposta(
  p: EnrichProposal,
  erro: string | null,
  /**
   * V10.6 — esta linha JÁ FOI GRAVADA nesta revisão. Vence tudo: não há mais
   * nada a decidir nela, e é isso que a pessoa precisa ler.
   */
  gravada = false,
): GrupoDaRevisao {
  if (gravada) return "gravadas";
  /*
    A ORDEM destes dois testes é a do `rowError` de quem chama, e não um
    detalhe: quando a mesma música tem uma linha que a varredura não conseguiu
    consultar e outra que falhou ao gravar, o `applyErrors` (que é por MÚSICA)
    alcança as duas. A linha sem proposta continua sendo "não consultada" —
    dizer que ela não pôde ser GRAVADA seria prometer que havia algo para
    gravar.
  */
  if (p.error !== null) return "nao-consultadas";
  if (erro !== null) return "nao-gravadas";
  if (p.conflito !== null) return "conflitos";
  if (p.lyrics !== null) return "letras";
  if (p.marcar_instrumental) return "sem-voz";
  if (p.substitui_nome_escrito) return "nomes-escritos";
  return "preenchimentos";
}

/** Um grupo com as suas linhas, na ordem em que a varredura as devolveu. */
export interface GrupoRevisado {
  grupo: GrupoDaRevisao;
  propostas: EnrichProposal[];
}

/** Agrupa por risco, preservando a ordem original dentro de cada grupo. */
export function agruparPorRisco(
  propostas: readonly EnrichProposal[],
  erroDe: (p: EnrichProposal) => string | null,
  /**
   * A linha da POSIÇÃO `i` já foi gravada nesta revisão (V10.6)? Por posição, e
   * não por música: a mesma música pode ter duas linhas, e gravar uma não grava
   * a outra.
   */
  gravadaEm: (i: number) => boolean = () => false,
): GrupoRevisado[] {
  const porGrupo = new Map<GrupoDaRevisao, EnrichProposal[]>();
  for (const [i, p] of propostas.entries()) {
    const grupo = grupoDaProposta(p, erroDe(p), gravadaEm(i));
    const lista = porGrupo.get(grupo);
    if (lista) lista.push(p);
    else porGrupo.set(grupo, [p]);
  }
  return ORDEM_DOS_GRUPOS.flatMap((grupo) => {
    const lista = porGrupo.get(grupo);
    return lista ? [{ grupo, propostas: lista }] : [];
  });
}

/**
 * O cabeçalho de cada grupo. Ele diz O QUE são aquelas linhas — nunca a
 * confiança delas, que é justamente o vocabulário que fez ninguém ler.
 */
export function tituloDoGrupo(grupo: GrupoDaRevisao, n: number): string {
  const um = n === 1;
  switch (grupo) {
    case "conflitos":
      return um
        ? "1 música em que o som discorda da etiqueta"
        : `${n} músicas em que o som discorda da etiqueta`;
    case "letras":
      return um ? "1 letra encontrada" : `${n} letras encontradas`;
    case "sem-voz":
      return um ? "1 música sem voz no áudio" : `${n} músicas sem voz no áudio`;
    case "nomes-escritos":
      return um
        ? "1 troca de nome que já estava escrito"
        : `${n} trocas de nome que já estava escrito`;
    case "preenchimentos":
      // este grupo tem frase própria — ver `textoDoGrupoDobrado`
      return um
        ? "1 música sem título ou artista"
        : `${n} músicas sem título ou artista`;
    case "nao-gravadas":
      /*
        V10.7 — este cabeçalho dizia "não puderam ser CONSULTADAS", e era
        mentira: a consulta funcionou (a linha tem proposta e selo de
        confiança), a pessoa mandou gravar, e o arquivo recusou.

        "no arquivo" é o par exato do grupo das gravadas ("1 música gravada no
        arquivo"): são as duas metades do mesmo clique, e usar o mesmo
        vocabulário nas duas é o que deixa a tela legível de relance. O motivo
        fica em cada linha porque ele é por ARQUIVO — sete músicas podem falhar
        por sete razões diferentes, e um motivo só no cabeçalho seria um palpite
        sobre seis delas.
      */
      return um
        ? "1 música não pôde ser gravada no arquivo — o motivo está na linha dela"
        : `${n} músicas não puderam ser gravadas no arquivo — o motivo está em cada linha`;
    case "nao-consultadas":
      return um
        ? "1 música não pôde ser consultada — o motivo está na linha dela"
        : `${n} músicas não puderam ser consultadas — o motivo está em cada linha`;
    case "gravadas":
      // V10.6 — o que já foi para o disco nesta revisão. Diz o FATO, e não uma
      // tarefa: não há nada a fazer com estas linhas.
      return um ? "1 música gravada no arquivo" : `${n} músicas gravadas no arquivo`;
    default: {
      /*
        Grupo novo sem título é um cabeçalho VAZIO na tela — e, antes desta
        linha, `undefined` silencioso: sem `noImplicitReturns`, o TypeScript não
        acusava o `case` que faltava, e nenhum teste olhava um grupo que ninguém
        tinha lembrado de acrescentar. Aqui ele passa a não compilar.
      */
      const naoTratado: never = grupo;
      return naoTratado;
    }
  }
}

/** A fonte que a etapa 1 usa, e que o grupo dobrado promete pelo nome. */
const FONTE_ARQUIVO = "nome do arquivo";

/**
 * A frase do grupo dobrado — e ela **É a conferência**.
 *
 * Dobrado ≠ escondido: o grupo continua visível, abrível e desmarcável. O que
 * a dobra troca é 72 linhas iguais por uma frase que diz o número e o que o
 * clique fará, que é exatamente o que 72 linhas iguais deixaram de comunicar.
 *
 * A promessa é conferida contra as fontes: nem todo preenchimento vem do nome
 * do arquivo (o som também preenche campo vazio), e prometer "o nome que está
 * no arquivo" para linhas que vêm do reconhecimento acústico descreveria
 * errado o que o clique faz.
 */
export function textoDoGrupoDobrado(propostas: readonly EnrichProposal[]): string {
  const n = propostas.length;
  const todasDoArquivo = propostas.every((p) => p.fonte === FONTE_ARQUIVO);
  const oQueRecebem = todasDoArquivo
    ? "o nome que está no arquivo"
    : "o nome que a busca achou";
  return n === 1
    ? `1 música sem título ou artista vai receber ${oQueRecebem}`
    : `${n} músicas sem título ou artista vão receber ${oQueRecebem}`;
}

// ---------------------------------------------------------------------------
// Conflito: o som contra a etiqueta
// ---------------------------------------------------------------------------
//
// O vocabulário da revisão é "atual → proposto", e conflito não é isso: nada
// foi proposto. A linha existe para INFORMAR que duas fontes discordam, e as
// duas precisam ser nomeadas por quem as disse.

/** O lado do arquivo, na linha de conflito. */
export const LABEL_SUA_ETIQUETA_DIZ = "Sua etiqueta diz";
/** O lado do reconhecimento acústico, na linha de conflito. */
export const LABEL_SOM_DIZ = "O som diz";

/** Rótulo acessível da marcação: aceitar é escolha POR LINHA, nunca em massa. */
export function rotuloAceitarSom(tituloAtual: string): string {
  return `Aceitar o que o som diz: ${tituloAtual}`;
}

/** Dois campos de nome valem o mesmo texto (espaços das pontas à parte). */
function mesmoNome(a: string | null, b: string | null): boolean {
  return (a ?? "").trim() === (b ?? "").trim();
}

/**
 * O nome que ESTA linha vai gravar, ou `null` quando ela não muda nome nenhum.
 *
 * Sai inteiro — título E artista — mesmo quando só um dos dois mudou: é o par
 * completo que vai para o arquivo, e anunciar só a metade que mudou faria o
 * rótulo descrever uma gravação parcial que não existe.
 */
function nomeQueEstaLinhaGrava(p: {
  current_title: string;
  current_artist: string | null;
  proposed_title: string;
  proposed_artist: string | null;
}): string | null {
  const igual =
    mesmoNome(p.current_title, p.proposed_title) &&
    mesmoNome(p.current_artist, p.proposed_artist);
  if (igual) return null;
  const titulo = p.proposed_title.trim();
  const artista = (p.proposed_artist ?? "").trim();
  return artista ? `${titulo} — ${artista}` : titulo;
}

/**
 * O rótulo acessível da marcação de uma linha — o que ELA decide.
 *
 * A etapa 5 acrescenta propostas a uma revisão que já está aberta, e a música
 * que sobrou sem letra é justamente a que costuma ter uma proposta de NOME
 * pendente. Então a mesma música aparece em duas linhas, e duas caixas com o
 * rótulo "Aplicar proposta: sem_tags" são indistinguíveis para quem navega por
 * teclado ou ouve a tela — e ambíguas até para quem vê, porque cada uma decide
 * uma coisa diferente.
 *
 * **QA A2 — o rótulo que enumera precisa enumerar tudo.** A etapa 5 do Rust
 * parte da mesma `proposta_baixa` da etapa 1, então a linha "sem voz" grava
 * título e artista junto com a marca. "Marcar como instrumental: AudioTrack
 * 03" soa como a descrição completa do clique e não era: quem chega pela
 * lista de campos de formulário do leitor de tela decidia sobre metade do
 * efeito — e a metade escondida é a que reescreve a etiqueta do arquivo.
 *
 * "Aplicar proposta" fica como está de propósito: ela não promete uma lista de
 * efeitos, então não omite nenhum, e o "atual → proposto" está no mesmo item
 * de lista, ao alcance de quem ouve. Enumerar nas 72 linhas do grupo dobrado
 * triplicaria o rótulo de cada uma sem responder nada.
 *
 * E o texto é DERIVADO da proposta: se a etapa 5 parar de propor nome, o
 * rótulo volta sozinho a dizer só o que sobrou.
 */
export function rotuloDaMarcacao(p: {
  current_title: string;
  current_artist: string | null;
  proposed_title: string;
  proposed_artist: string | null;
  conflito: unknown | null;
  marcar_instrumental: boolean;
  lyrics: string | null;
  fonte: string;
}): string {
  // Conflito não propõe nada: aceitar grava o que o SOM disse, e a linha já
  // nomeia os dois lados campo a campo.
  if (p.conflito) return rotuloAceitarSom(p.current_title);
  const acoes: string[] = [];
  if (p.marcar_instrumental) acoes.push("Marcar como instrumental");
  if (p.lyrics !== null && ehLetraDeMaquina(p.fonte)) {
    acoes.push("Aplicar a letra escrita ouvindo o áudio");
  }
  if (acoes.length === 0) return `Aplicar proposta: ${p.current_title}`;
  const nome = nomeQueEstaLinhaGrava(p);
  if (nome !== null) acoes.push(`gravar o nome ${nome}`);
  return `${acoes.join(" e ")}: ${p.current_title}`;
}

/**
 * A confiança da linha de conflito, dizendo SOBRE O QUE ela fala.
 *
 * "confiança alta" sozinha enganava, e o caso é real (v0.9.0): a pessoa lia
 * "confiança alta" ao lado de um artista diferente e entendia "a sua etiqueta
 * está errada com alta confiança". Não é isso — a confiança é do
 * RECONHECIMENTO DA GRAVAÇÃO.
 */
export function confiancaDoSom(confianca: "alta" | "media"): string {
  return confianca === "alta"
    ? "gravação reconhecida com confiança alta"
    : "gravação reconhecida com confiança média";
}

/**
 * A frase que desfaz o engano, uma vez por grupo (e não por linha: repetida em
 * cada conflito ela vira ruído e deixa de ser lida).
 *
 * O AcoustID identifica a GRAVAÇÃO e busca o crédito no MusicBrainz, onde a
 * MESMA gravação aparece em vários lançamentos com créditos diferentes.
 * Aceitar pode trocar uma etiqueta certa por outra igualmente defensável.
 */
export const EXPLICACAO_DA_CONFIANCA_DO_SOM =
  "A confiança é sobre qual gravação é esta, não sobre a sua etiqueta estar" +
  " errada: a mesma gravação sai com crédito diferente em cada lançamento.";

/** Um campo que os dois lados dizem igual — mostrado uma vez só. */
export interface CampoIgual {
  campo: "título" | "artista";
  valor: string;
}

/** Um campo em que os dois lados discordam. */
export interface CampoDiferente {
  campo: "título" | "artista";
  etiqueta: string;
  som: string;
}

export interface ComparacaoDeConflito {
  iguais: CampoIgual[];
  diferem: CampoDiferente[];
}

/**
 * Separa o que os dois lados dizem IGUAL do que eles dizem diferente.
 *
 * O caso real da v0.9.0 imprimia o título duas vezes:
 *
 * > Sua etiqueta diz: Meninos — Renato Teixeira & Xangai
 * > O som diz: Meninos — Xangai & Quinteto da Paraíba
 *
 * e obrigava a comparar dois textos com o olho para achar a única diferença.
 * O que é igual sai da comparação e aparece uma vez; o que difere fica lado a
 * lado, sozinho.
 *
 * A comparação é por texto aparado, sem tolerância de grafia: aceitar o som
 * GRAVA o texto dele, e uma diferença de caixa ou acento é uma gravação
 * diferente. Aqui, mostrar de menos seria esconder o que o clique fará.
 */
export function compararConflito(
  etiqueta: { titulo: string; artista: string | null },
  som: { titulo: string; artista: string },
): ComparacaoDeConflito {
  const iguais: CampoIgual[] = [];
  const diferem: CampoDiferente[] = [];
  const campos: Array<[CampoIgual["campo"], string, string]> = [
    ["título", etiqueta.titulo ?? "", som.titulo ?? ""],
    ["artista", etiqueta.artista ?? "", som.artista ?? ""],
  ];
  for (const [campo, a, b] of campos) {
    const [ea, eb] = [a.trim(), b.trim()];
    if (ea === eb) iguais.push({ campo, valor: ea });
    else diferem.push({ campo, etiqueta: ea, som: eb });
  }
  return { iguais, diferem };
}

/** Um pedaço de texto, com a marca de "só este lado diz isto". */
export interface PedacoDoTexto {
  texto: string;
  difere: boolean;
}

/** Chave de comparação de palavra: sem acento, minúscula, só alfanumérico. */
function chaveDaPalavra(palavra: string): string {
  return palavra
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/**
 * Marca, palavra por palavra, o que só ESTE lado diz.
 *
 * Dentro do campo que difere, a palavra que os dois lados repetem não é a
 * informação — "Xangai" aparece nos dois créditos do caso real, e é justamente
 * ela que faz os dois textos parecerem iguais de relance. Destacar o
 * exclusivo é o que transforma "compare estes dois textos" em "olhe aqui".
 *
 * Palavra sem letra nem número (o "&", a vírgula) nunca é destacada: ela é
 * pontuação, não crédito.
 */
export function destacarDiferenca(texto: string, contra: string): PedacoDoTexto[] {
  const doOutroLado = new Set(
    contra
      .split(/\s+/)
      .map(chaveDaPalavra)
      .filter((k) => k !== ""),
  );
  return texto
    .split(/\s+/)
    .filter((p) => p !== "")
    .map((palavra) => {
      const chave = chaveDaPalavra(palavra);
      return { texto: palavra, difere: chave !== "" && !doOutroLado.has(chave) };
    });
}

/**
 * O cabeçalho da revisão.
 *
 * Ele contava por CONFIANÇA ("12 propostas — 3 alta, 2 média, 7 baixa"), e
 * essa é exatamente a leitura que a V10 abandonou: era o cabeçalho ensinando a
 * ignorar as sete de baixa. Quem diz o que é cada coisa agora é o título de
 * cada grupo; aqui fica só o tamanho do trabalho.
 *
 * Conta OFERTAS: linha com erro não é proposta (QA MÉDIO-12).
 */
export function textoDoCabecalho(propostas: number): string {
  if (propostas <= 0) return "Nenhuma proposta para aplicar.";
  return propostas === 1
    ? "1 proposta para conferir"
    : `${propostas} propostas para conferir`;
}

// ---------------------------------------------------------------------------
// V10 — a etapa 5, perguntada no FIM
// ---------------------------------------------------------------------------
//
// Não é modo, não é caixa marcada antes. A pergunta é feita quando pode ser
// respondida com informação: terminada a varredura, com o número de músicas
// que sobraram sem letra e o tempo que isso leva NESTA máquina.

/**
 * A pergunta do fim. As duas frases do PRD, e nada mais — a interrogação está
 * no botão, que é onde ela pode ser respondida.
 *
 * **QA A1 — a frase dizia "neste computador" para um número de fábrica.**
 * A DECISIONS #106 separa as duas grandezas por nome: `RAZAO_DE_REFERENCIA` é
 * um palpite (1,0, escolhido justamente por não haver medição), e a razão
 * MEDIDA é o que a primeira transcrição desta máquina produz. A tela não tinha
 * como saber qual dos dois estava mostrando, e afirmava sempre o segundo.
 *
 * Agora o backend diz — `estimativa_medida_nesta_maquina`, um BOOLEANO e não a
 * razão, para não convidar o TypeScript a multiplicar (DECISIONS #80 e #112).
 * Com ele a frase é honesta nos dois estados, que é a DECISIONS #86 aplicada a
 * uma estimativa:
 *
 * - **medida**: "leva cerca de 3 horas neste computador" — a frase do PRD, e
 *   agora ela é verdade;
 * - **de fábrica**: "— pode levar mais nesta máquina". Não fica só neutra
 *   porque o erro tem sinal conhecido: o `whisper-cli` do macOS sai do CI como
 *   binário universal, sem Metal e sem Accelerate, então o palpite é OTIMISTA.
 *   Prometer menos do que leva é a DECISIONS #85; o contrário faz alguém
 *   esperar o triplo do anunciado e fechar o programa achando que travou.
 *
 * O padrão é a versão conservadora: quem esquecer de passar o fato recebe a
 * frase que não afirma nada de errado.
 */
export function textoDaOfertaDeTranscricao(
  quantas: number,
  segundos: number,
  medidaNestaMaquina = false,
): string {
  const sobraram =
    quantas === 1
      ? "Sobrou 1 música sem letra"
      : `Sobraram ${quantas} músicas sem letra`;
  return `${sobraram}. ${fraseDoTempoDaTranscricao(segundos, medidaNestaMaquina)}`;
}

/**
 * **A frase que oferece o trabalho, e diz quanto ele custa.** Uma só, para as
 * duas portas da etapa 5 (V10.6): a pergunta do fim da varredura e o bloco
 * permanente de Configurações.
 *
 * Ela mora aqui em vez de estar escrita duas vezes porque é a frase que carrega
 * a ressalva da procedência do número — e uma cópia dela é uma cópia que
 * amanhã diz "neste computador" numa tela e não na outra, sobre a MESMA
 * medição. É a DECISIONS #80 aplicada a texto.
 *
 * O que MUDA entre as duas portas é só quem abre o parágrafo: "sobraram" só é
 * verdade logo depois de uma varredura, e numa tela permanente nada acabou de
 * acontecer.
 */
function fraseDoTempoDaTranscricao(
  segundos: number,
  medidaNestaMaquina: boolean,
): string {
  return `Escrever a letra ouvindo o áudio leva ${tempoDaTranscricao(
    segundos,
    medidaNestaMaquina,
  )}.`;
}

/**
 * **O tempo da etapa 5 com a PROCEDÊNCIA do número** — "cerca de 4 minutos
 * neste computador" ou "cerca de 4 minutos — pode levar mais nesta máquina".
 *
 * Saiu de dentro da `fraseDoTempoDaTranscricao` na V10.10, quando o botão
 * direto da ficha passou a precisar do MESMO tempo com a MESMA ressalva dentro
 * de um rótulo, que não é uma frase. Escrever a ressalva duas vezes seria a
 * DECISIONS #80 aplicada a texto — e aqui as duas versões caberiam na mesma
 * tela, porque a pergunta do fim de uma varredura e a ficha de uma música
 * convivem.
 *
 * A regra do "neste computador" é a das outras portas, e é a única coisa que o
 * booleano decide (DECISIONS #86 e #112): só medição desta máquina autoriza a
 * afirmação. Sem ela o erro tem sinal conhecido — o palpite de fábrica é
 * OTIMISTA —, e a ressalva existe para ninguém esperar o triplo do anunciado e
 * achar que o programa travou.
 */
function tempoDaTranscricao(segundos: number, medidaNestaMaquina: boolean): string {
  const tempo = segundos < 60 ? "menos de 1 minuto" : cercaDe(segundos);
  return medidaNestaMaquina
    ? `${tempo} neste computador`
    : `${tempo} — pode levar mais nesta máquina`;
}

/** O botão da pergunta do fim. */
export const ROTULO_COMECAR_TRANSCRICAO = "Começar agora";

/** O download que falta para a etapa 5 existir nesta máquina. */
export interface DownloadPendente {
  bytes: number;
  segundos: number;
}

/**
 * O caminho de quem não tem os acessórios da etapa 5: o download, **com
 * tamanho e tempo**. Para 180 MB a dispensa do tempo que valeu para 5 MB não
 * vale mais (DECISIONS #106).
 *
 * Sem saber o tamanho (a consulta aos acessórios não voltou), não inventa
 * número nenhum: "não sabemos" é um estado (DECISIONS #86).
 */
export function textoDaTranscricaoIndisponivel(
  quantas: number,
  download: DownloadPendente | null,
): string {
  const sobraram =
    quantas === 1
      ? "Sobrou 1 música sem letra"
      : `Sobraram ${quantas} músicas sem letra`;
  return `${sobraram}. ${fraseDoDownloadDaTranscricao(download)}`;
}

/**
 * **A frase de quem não tem os acessórios, para as portas que NÃO estão em
 * Configurações.** Uma só, pelo mesmo motivo da `fraseDoTempoDaTranscricao`
 * (DECISIONS #80 aplicada a texto): duas cópias são duas telas que amanhã
 * anunciam tamanhos diferentes para o mesmo download.
 *
 * O bloco permanente de Configurações NÃO usa esta frase, e é de propósito: lá
 * a saída aponta para CIMA, porque os cartões de download estão a poucos pixels
 * acima e mandar a pessoa para a tela em que ela já está seria um beco (V10.6).
 * A pergunta do fim da varredura e a ficha de uma música (V10.9) estão nas duas
 * outras telas, e para elas a saída é o nome do lugar.
 *
 * Sem saber o tamanho (a consulta aos acessórios não voltou), não inventa
 * número nenhum: "não sabemos" é um estado (DECISIONS #86).
 */
function fraseDoDownloadDaTranscricao(download: DownloadPendente | null): string {
  if (download === null) {
    return "Para escrever a letra ouvindo o áudio, ligue o recurso em Configurações.";
  }
  return (
    "Para escrever a letra ouvindo o áudio, baixe" +
    ` ${formatarTamanho(download.bytes)} em Configurações —` +
    ` ${cercaDe(download.segundos)}.`
  );
}

// ---------------------------------------------------------------------------
// V10.6 — a etapa 5 em Configurações, permanentemente
// ---------------------------------------------------------------------------
//
// Relato de campo, verbatim: *"Achei que eu poderia clicar em aplicar e depois
// trabalhar nas transcrições, mas não aconteceu… Simplesmente fechou a caixa e
// aplicou essas 28… Mas agora tenho que começar de novo pra chegar na parte de
// transcrição de novo."*
//
// O que se perdia não era um clique: era a varredura inteira — minutos, numa
// biblioteca grande. E a causa era de projeto: a oferta vivia DENTRO da caixa
// de revisão, e resultado de varredura é efêmero. Mas **"quais músicas estão
// sem letra" não é resultado de varredura — é fato permanente da biblioteca**,
// que o backend responde a qualquer momento (`transcricaoPendentes`).

/** O que o bloco permanente precisa saber para se descrever. */
export interface BlocoDeTranscricao {
  /** Quantas músicas do escopo estão sem letra (a lista vem em ids). */
  quantas: number;
  /** Segundos estimados de transcrição, como o backend os contou. */
  segundos: number;
  /** O número acima é medição desta máquina, ou palpite de fábrica? */
  medidaNestaMaquina: boolean;
  /** A etapa 5 pode rodar nesta máquina (transcritor E modelo prontos)? */
  disponivel: boolean;
  /** O que falta baixar, quando falta e quando se sabe o tamanho. */
  download: DownloadPendente | null;
  /**
   * O escopo é a biblioteca inteira, ou a pasta escolhida?
   *
   * Isto está no texto porque o seletor de pasta fica logo acima do bloco: um
   * "27 músicas estão sem letra" sem dizer de onde é a pergunta que a pessoa
   * não vai poder tirar com ninguém.
   */
  todaABiblioteca: boolean;
}

/**
 * O bloco permanente da etapa 5, em Configurações.
 *
 * A informação é a MESMA da pergunta do fim, e a segunda frase é literalmente a
 * mesma (`fraseDoTempoDaTranscricao`). O que muda é a abertura: "sobraram" só é
 * verdade logo depois de uma varredura.
 *
 * Zero é RESPOSTA, e não a ausência do bloco: quem abre esta tela para saber
 * quantas faltam precisa ler que não falta nenhuma. E zero vence a
 * indisponibilidade — oferecer 1,4 GB de download para transcrever nada seria
 * pedir um trabalho que não existe.
 */
export function textoDoBlocoDeTranscricao({
  quantas,
  segundos,
  medidaNestaMaquina,
  disponivel,
  download,
  todaABiblioteca,
}: BlocoDeTranscricao): string {
  const onde = todaABiblioteca ? "da biblioteca" : "desta pasta";
  if (quantas <= 0) {
    return `Nenhuma música ${onde} está sem letra.`;
  }
  const quantasFrase =
    quantas === 1
      ? `1 música ${onde} está sem letra`
      : `${quantas} músicas ${onde} estão sem letra`;
  if (!disponivel) {
    /*
      Aqui a saída NÃO é "vá em Configurações": já estamos nela, e os blocos de
      download estão a poucos pixels acima. Repetir o TEMPO que eles já dizem
      seria o ruído que a régua da #100 proíbe; o tamanho fica porque é ele que
      responde à pergunta daquele segundo — "por que não posso, e o que faço?".
      Sem saber o tamanho, não se inventa número nenhum (DECISIONS #86).
    */
    const oQue =
      download === null
        ? "de um download oferecido acima"
        : `de um download de ${formatarTamanho(download.bytes)}, oferecido acima`;
    return `${quantasFrase}. Escrever a letra ouvindo o áudio precisa ${oQue}.`;
  }
  return `${quantasFrase}. ${fraseDoTempoDaTranscricao(segundos, medidaNestaMaquina)}`;
}

// ---------------------------------------------------------------------------
// V10.9 — a etapa 5 na porta de UMA música
// ---------------------------------------------------------------------------
//
// O funil de UMA música (`enrich_song_scan`) roda as etapas 1 a 4 e para ali. A
// etapa 5 não entrava porque ela custa minutos e vive em comando próprio — e o
// resultado era o beco que 3% de cobertura torna TÍPICO: a pessoa abre a
// música, manda buscar, as quatro etapas não acham nada, e a única coisa que
// resolveria AQUELA música não é oferecida ali. Para chegar nela era preciso
// sair da ficha, ir a Configurações, e lá a fila é a pasta inteira.
//
// É o mesmo erro de projeto que a V10.6 consertou na outra porta — a etapa 5
// morando onde a VARREDURA termina, e não onde a PESSOA está —, e aqui ela é
// mais usável do que em qualquer outra porta: uma música são MINUTOS, não
// horas.
//
// **V10.10 — e a oferta deixou de depender da busca.** A V10.9 a pendurou no
// desfecho do funil ("as quatro etapas não acharam letra"), e o dono do produto
// mediu o custo disso no uso: quem já SABE que a música não está na internet
// pagava a varredura inteira — segundos de rede e uma leitura de impressão
// digital — para só então poder transcrever. Ficou um botão direto, com o custo
// no rótulo, e a oferta antiga perdeu o botão dela para não haver dois botões
// para a mesma ação (a lição da V8).

/**
 * **V10.10 — O BOTÃO DIRETO DA ETAPA 5, na ficha de uma música.**
 *
 * Pedido do dono do produto, verbatim: *"No caso específico de mexer música por
 * música quero um botão separado pra fazer transcrição. Pra não precisar rodar
 * todo o fluxo pra depois só poder transcrever."*
 *
 * Até a V10.9 a etapa 5 só era oferecida na ficha DEPOIS de "Buscar dados na
 * internet", e só quando as quatro etapas não achavam letra. Quem já sabe que a
 * música não está na internet — o caso comum neste acervo, com 3% de cobertura
 * medida — pagava segundos de rede e uma leitura de impressão digital para
 * então poder transcrever.
 *
 * **O tempo mora no RÓTULO, e é o que torna a escolha informada.** A V8 removeu
 * dois botões que diziam "buscar na internet" porque a diferença entre eles era
 * invisível, e a escolha errada era silenciosamente pior. Aqui os dois botões
 * dizem coisas diferentes e cada um traz o próprio custo: um fala de internet e
 * custa segundos, este fala de ouvir o áudio e traz os minutos escritos nele. É
 * o mesmo motivo pelo qual o tamanho vai no botão do download
 * (`rotuloBaixarAcessorio`): é a última coisa lida antes do clique.
 *
 * O tempo e a ressalva são os das outras duas portas, letra por letra
 * (`tempoDaTranscricao`).
 *
 * **V10.11 — e o verbo muda quando JÁ HÁ letra: "escrever de novo".**
 *
 * O botão passou a aparecer também para a música que tem letra (DECISIONS #167
 * revertida), e o caso que trouxe isso foi o de um beta tester diante de uma
 * letra que terminava em `[MÚSICA]` — vinda de transcrição, imperfeita. "de
 * novo" é o que ele estava fazendo, e é a palavra que separa este clique do
 * outro: quem lê "escrever a letra" com uma letra na tela para para entender o
 * que o botão acha que está acontecendo.
 *
 * O que a letra atual SOFRE não cabe no rótulo sem estourá-lo, e está na dica
 * (`dicaDeTranscreverEstaMusica`), que é o outro texto lido antes do clique.
 */
export function rotuloDeTranscreverEstaMusica(
  segundos: number,
  medidaNestaMaquina: boolean,
  jaTemLetra = false,
): string {
  const acao = jaTemLetra
    ? "Escrever a letra de novo, ouvindo o áudio"
    : "Escrever a letra ouvindo o áudio";
  return `${acao} (${tempoDaTranscricao(segundos, medidaNestaMaquina)})`;
}

/**
 * **O que a ficha diz a quem NÃO pode transcrever nesta máquina.**
 *
 * Era, na V10.9, o texto da oferta inteira — com dois desfechos, e um botão
 * "Começar agora" no primeiro deles. A V10.10 lhe tirou essa metade: com o
 * botão direto na ficha, oferecer o mesmo clique de novo depois de uma busca
 * seriam dois botões para a mesma ação, que é exatamente o que a V8 removeu.
 *
 * **O que não cabe num botão é a saída de quem não tem os acessórios**, porque
 * ela não é um clique daqui: é um download de 1,4 GB, em outra tela. Por isso
 * este texto sobrou, e só ele.
 *
 * A saída aponta para CONFIGURAÇÕES, com tamanho e tempo — é o padrão da
 * pergunta do fim (`fraseDoDownloadDaTranscricao`), e não o do bloco
 * permanente, que aponta para cima porque já está lá (V10.6). A abertura é a
 * desta porta: quem lê está olhando UMA ficha, logo depois de ler que a busca
 * não trouxe letra.
 *
 * Sem saber o tamanho, não se inventa número nenhum (DECISIONS #86).
 */
export function textoDaOfertaDestaMusica(download: DownloadPendente | null): string {
  return `Esta música continua sem letra. ${fraseDoDownloadDaTranscricao(download)}`;
}

/**
 * **A dica do botão da etapa 5 — e o que ela responde muda quando já HÁ letra.**
 *
 * V10.11. A DECISIONS #167 escondia o botão de quem já tem letra, e o dono a
 * reverteu com um caso concreto: um beta tester abriu uma música cuja letra
 * terminava em `[MÚSICA]` — letra vinda de transcrição, imperfeita — e queria
 * exatamente refazê-la. **O caso em que a pessoa mais quer transcrever de novo
 * é justamente aquele em que já existe letra ruim.**
 *
 * Com o botão de volta ali, a pergunta daquele segundo deixa de ser "quanto
 * custa?" (isso o rótulo já diz) e passa a ser **"vou perder a letra que está
 * aqui?"**. A resposta é não, e ela precisa estar escrita antes do clique: o
 * consentimento de substituição (DECISIONS #79) existe e continua valendo, mas
 * ele só aparece minutos depois, na revisão — tarde demais para tranquilizar
 * quem está com o dedo no botão.
 */
export function dicaDeTranscreverEstaMusica(jaTemLetra: boolean): string {
  const comum =
    "Escreve a letra ouvindo o áudio desta música, sem usar a internet.";
  return jaTemLetra
    ? `${comum} A letra que está aqui não é apagada: a nova entra como proposta` +
        " de substituição, e você decide antes de gravar."
    : `${comum} Nada é gravado sem você conferir.`;
}

// ---------------------------------------------------------------------------
// V10.11 — o Enter no campo de tema
// ---------------------------------------------------------------------------

/**
 * **O que a tecla Enter faz no campo de tema, dito no segundo em que a pessoa
 * pode perguntar.**
 *
 * Relato dos beta testers: digitar um tema e sair usando o aplicativo sem
 * clicar em "Salvar no arquivo" perdia o que foi digitado. A decisão do dono é
 * que Enter confirma o chip **e grava a ficha inteira**, numa gravação só — a
 * alternativa "Enter salva só o tema" foi recusada porque meia tela salvando
 * sozinha é pior que nenhuma.
 *
 * Gravar no arquivo é surpreendente demais para não estar escrito, e a frase
 * diz as DUAS coisas que acontecem, na ordem em que acontecem. Ela aparece só
 * enquanto há texto no campo, que é quando a pergunta existe (a régua da
 * DECISIONS #100).
 */
export const DICA_DO_ENTER_NO_TEMA =
  "Enter confirma este tema e salva a ficha inteira no arquivo.";

/**
 * O aviso de quem fecha a revisão com a oferta de transcrição na tela. `null`
 * quando não há oferta pendente — e zero é o caso normal.
 *
 * **É informativo, e não uma confirmação bloqueante.** Com o bloco permanente
 * em Configurações a lista já não se perde: uma caixa pedindo "tem certeza?"
 * cobraria uma decisão por um prejuízo que deixou de existir, e pop-up que se
 * aprende a fechar sem ler é pop-up que não avisa mais nada. O que ficou é a
 * frase que diz PARA ONDE a oferta foi.
 *
 * Ela não acusa quem fechou: fechar é ação legítima, e a varredura foi só
 * leitura.
 */
export function avisoDeTranscricaoPendente(quantas: number): string | null {
  if (quantas <= 0) return null;
  const ainda =
    quantas === 1
      ? "Ainda há 1 música sem letra"
      : `Ainda há ${quantas} músicas sem letra`;
  return (
    `${ainda}. Escrever a letra ouvindo o áudio continua em Configurações,` +
    " quando você quiser."
  );
}

/**
 * **O aviso de quem fecha a revisão com linhas que FALHARAM AO GRAVAR na
 * tela.** `null` quando nenhuma falhou — e esse é o caso normal.
 *
 * Relato de campo, verbatim, sobre uma revisão em que sete músicas recusaram a
 * gravação: *"não sei quais são as duas outras músicas… pq fechei a tela em
 * seguida"*. É a MESMA família do defeito que a V10.6 consertou — a lista de que
 * a pessoa precisa para agir depois evapora ao fechar a caixa —, e é **pior que
 * a oferta de transcrição**: para a oferta existe uma porta permanente em
 * Configurações, e para as falhas não existe nenhuma.
 *
 * Por isso a segunda frase diz o que a da oferta não precisa dizer: que a lista
 * NÃO fica guardada. Prometer que ela volta seria mentira, e calar seria repetir
 * o defeito com um toast por cima.
 *
 * **O caminho que ela oferece é o único honesto** (DECISIONS #144a): a linha que
 * falhou continua sem "tentar de novo", porque o motivo da recusa é quase sempre
 * de fora do aplicativo — arquivo aberto em outro programa, disco cheio, pasta
 * sincronizada com a nuvem. Resolver o que a linha diz e repetir a busca é o que
 * existe, e é o que a frase manda fazer.
 *
 * O texto abre com o MESMO vocabulário do cabeçalho do grupo que ele descreve
 * (`tituloDoGrupo("nao-gravadas")`). Quem acabou de ler "2 músicas não puderam
 * ser gravadas no arquivo" na tela tem de reconhecer a mesma frase no aviso, ou
 * vai contar duas coisas diferentes — é a DECISIONS #139 pelo avesso.
 */
export function avisoDeFalhasDeGravacao(quantas: number): string | null {
  if (quantas <= 0) return null;
  const naoGravadas =
    quantas === 1
      ? "1 música não pôde ser gravada no arquivo"
      : `${quantas} músicas não puderam ser gravadas no arquivo`;
  return (
    `${naoGravadas}. Esta lista não fica guardada: para vê-la de novo, repita` +
    " a busca desta pasta."
  );
}

/**
 * A linha que JÁ FOI GRAVADA nesta revisão (V10.6).
 *
 * Aplicar deixou de fechar a caixa — era o fechamento que jogava fora a lista
 * das músicas sem letra —, então as linhas gravadas continuam na tela e a tela
 * precisa dizer o que aconteceu com elas. Sem isto a mesma lista voltaria a
 * oferecer o clique que acabou de acontecer, e o `apply` recusaria a segunda
 * tentativa com "a música mudou depois da busca": um erro inventado por nós,
 * para quem não tem a quem perguntar.
 *
 * Não fala em erro e não pede ação: não há nada a fazer com ela.
 */
export const ROTULO_DA_LINHA_GRAVADA = "Gravada no arquivo.";

/**
 * O selo da linha gravada, no lugar da confiança.
 *
 * A confiança descrevia um palpite a decidir, e não há mais nada a decidir
 * naquela linha: deixá-la ali faria a linha parecer pendente.
 */
export const SELO_DA_LINHA_GRAVADA = "GRAVADA";

/**
 * Os acessórios que a etapa 5 exige — os dois, e os dois prontos.
 *
 * V10.5 — o modelo é o `modelo-de-transcricao-grande`, o único que restou no
 * catálogo. Um nome errado aqui não quebra nada visível: o modelo some da
 * conta, e a pergunta do fim oferece 2 MB para um download de 1,4 GB.
 */
const ACESSORIOS_DA_TRANSCRICAO = [
  "whisper-cli",
  "modelo-de-transcricao-grande",
];

/**
 * Quanto falta baixar para a etapa 5 existir. `null` quando não há nada a
 * baixar, quando a lista não veio, ou quando o que falta está
 * **indisponível nesta versão** — baixar 183 MB para então descobrir que este
 * build não usa o acessório é a acusação falsa da DECISIONS #97.
 */
export function downloadParaTranscrever(
  lista: readonly AcessorioInfo[] | null | undefined,
): DownloadPendente | null {
  if (!lista) return null;
  const pendentes = lista.filter(
    (a) => ACESSORIOS_DA_TRANSCRICAO.includes(a.nome) && a.estado !== "pronto",
  );
  if (pendentes.length === 0) return null;
  if (pendentes.some((a) => a.estado === "indisponivel")) return null;
  return {
    bytes: pendentes.reduce((s, a) => s + a.tamanho_bytes, 0),
    segundos: pendentes.reduce((s, a) => s + a.segundos_estimados, 0),
  };
}

/**
 * O progresso da fila. Uma música leva MINUTOS, então este número anda devagar
 * — o que se mexe dentro de uma música é o `porcento_da_musica`, na barra.
 */
export function textoDoProgressoDaTranscricao(done: number, total: number): string {
  return `Escrevendo as letras… ${done} de ${total}`;
}

/**
 * O tempo que falta da fila inteira. `null` até a primeira música terminar:
 * antes disso não há o que medir, e a tela diz QUANDO o número vai aparecer em
 * vez de ficar em branco (esta janela fica aberta por horas).
 */
export function textoDoTempoDaTranscricao(segundos: number | null): string {
  if (segundos === null) {
    return "O tempo que falta aparece quando a primeira música terminar.";
  }
  return `${comMaiuscula(tempoQueFalta(segundos))}.`;
}

// ---------------------------------------------------------------------------
// V10 — os três campos novos da proposta
// ---------------------------------------------------------------------------

/**
 * A linha que marcaria a música como instrumental.
 *
 * A pessoa precisa entender que a música **para de ser cobrada por letra**:
 * essa é a consequência que ela vai sentir, e é ela que justifica um clique
 * numa marca que só o editor desfaz (DECISIONS #71).
 */
export const AVISO_MARCAR_INSTRUMENTAL =
  "Nenhuma voz no áudio inteiro. Aplicar marca a música como instrumental, e" +
  " ela deixa de aparecer como sem letra.";

/**
 * O refrão, na linha. Existe para reconhecer a música **sem abrir a letra** —
 * quem vai conferir 47 letras escritas por máquina precisa disso de relance.
 */
export function rotuloDoRefrao(refrao: string): string {
  return `Trecho mais repetido: “${refrao}”`;
}

/**
 * Letra de transcrição é letra de MÁQUINA, e a revisão diz isso ANTES de a
 * pessoa marcar. (O painel de letra tem o aviso equivalente desde a V5/F14,
 * para depois de gravada.)
 */
export const AVISO_LETRA_DE_MAQUINA =
  "Letra escrita pela máquina ouvindo o áudio — confira antes de aplicar.";

/** Esta linha traz letra escrita pela máquina? */
export function ehLetraDeMaquina(fonte: string): boolean {
  return fonte === FONTE_TRANSCRICAO;
}

// ---------------------------------------------------------------------------
// CRÍTICO-1 e V9 — os avisos por linha
// ---------------------------------------------------------------------------

/** Rótulo da segunda marcação da revisão — o mesmo texto que o backend cita. */
export const LABEL_SUBSTITUIR_LETRA = "Substituir a letra atual";

/**
 * O aviso da linha cuja proposta passaria por cima de uma letra que JÁ EXISTE
 * no arquivo (CRÍTICO-1).
 *
 * Duas coisas precisam estar escritas: que existe letra ali, e o que acontece
 * se ninguém marcar nada (aplica só os nomes — que é o valor real dessas
 * linhas). O "abaixo" aponta a marcação que fica na linha logo embaixo deste
 * texto, numa lista que pode ter dezenas de caixas parecidas.
 */
export function avisoLetraExistente(letraOrigem: string | null): string {
  const oQueTem =
    letraOrigem === ORIGEM_TRANSCRICAO
      ? "Já tem letra, escrita ouvindo o áudio e talvez corrigida à mão."
      : "Já tem letra.";
  return `${oQueTem} Sem marcar abaixo, aplica só título e artista.`;
}

/**
 * O aviso da linha que trocaria um título ou artista ESCRITO POR GENTE (V9).
 *
 * É a DECISIONS #79 do lado das etiquetas: o LRCLIB devolve a grafia oficial,
 * "Ponto de Oxum" volta como "Ponto de Oxum (Ao Vivo)", a duração bate,
 * portanto ALTA — e um clique em "Aplicar selecionadas" leva embora o que
 * alguém digitou à mão.
 */
export const AVISO_NOME_ESCRITO =
  "Isto troca um título ou artista que já existe — confira antes de marcar.";

// ---------------------------------------------------------------------------
// Acessórios — nada baixa sozinho
// ---------------------------------------------------------------------------

/**
 * "Quanto ocupa", em pt-BR. Uma casa decimal e vírgula: é um número para
 * decidir se vale a pena, não para conferir byte a byte.
 *
 * **V10.5 — passou a ter GB.** Com o modelo pequeno fora do catálogo, o único
 * arquivo de dado tem 1,5 bilhão de bytes, e a tela dizia "1462,7 MB": quatro
 * dígitos antes da vírgula deixam de dizer se é muito ou pouco, que é
 * exatamente o trabalho deste número. "1,4 GB" é a mesma informação legível.
 *
 * O GB é BINÁRIO, como o MB e o kB daqui. Duas bases no mesmo formatador
 * dariam dois tamanhos para o mesmo arquivo, e o 181,3 MB que a tela já mostra
 * há três versões é binário.
 */
export function formatarTamanho(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1000) return `${(mb / 1024).toFixed(1).replace(".", ",")} GB`;
  if (mb >= 1) return `${mb.toFixed(1).replace(".", ",")} MB`;
  return `${Math.round(bytes / 1024)} kB`;
}

/** O mínimo que a tela precisa saber de um acessório para falar dele. */
export interface AcessorioParaTexto {
  /** Frase pronta vinda do backend ("reconhecer a música pelo som"). */
  para_que_serve: string;
  tamanho_bytes: number;
  /** Tempo do download, como o backend o calculou (V10; V10.4). */
  segundos_estimados: number;
  /** O tempo acima é medição desta máquina, ou o número de fábrica? */
  tempo_medido_nesta_maquina: boolean;
  /** Programa que o app executa, ou dado que ele só lê? */
  executavel: boolean;
}

/**
 * O título do bloco: o "para que serve" do backend, com maiúscula.
 *
 * Ele é TÍTULO, e não um pedaço de frase, desde que o catálogo passou a ter
 * três acessórios: o do modelo é "entender o que é cantado — é o que o
 * transcritor consulta", e embutir isso num "Para X, é preciso baixar…"
 * produzia uma frase com dois travessões e nenhum sentido.
 */
export function tituloDoAcessorio(a: AcessorioParaTexto): string {
  return comMaiuscula(a.para_que_serve);
}

/**
 * Regra 1 do PRD V9, mais o tempo da V10: a tela diz ANTES o que vai baixar,
 * quanto ocupa e quanto tempo leva.
 *
 * "Uma vez só" responde à pergunta seguinte, que é a regra 3: baixou uma vez,
 * o app não pergunta de novo.
 *
 * **V10.4 — a frase diz DE ONDE VEM O TEMPO.** A v0.10.1 anunciou 26 minutos
 * para um download de 3, e a pessoa quase não baixou. O número de referência
 * subiu, mas número declarado continua sendo declarado: enquanto ele for de
 * fábrica, a frase carrega a ressalva de internet lenta — a mesma mitigação
 * que a DECISIONS #85 exigiu da estimativa da varredura. Medido nesta máquina,
 * a ressalva sai e o texto diz por quê: quem já baixou 1,5 GB aqui não precisa
 * ser avisado de que a própria conexão pode ser lenta.
 */
export function textoDoAcessorioAusente(a: AcessorioParaTexto): string {
  const oQue = a.executavel ? "um programa" : "um arquivo";
  const tempo = a.tempo_medido_nesta_maquina
    ? `${cercaDe(a.segundos_estimados)} neste computador`
    : `${cercaDe(a.segundos_estimados)} — mais se a sua internet estiver lenta`;
  return (
    `É preciso baixar ${oQue} de ${formatarTamanho(a.tamanho_bytes)}, uma vez` +
    ` só. O download leva ${tempo}.`
  );
}

/** O tamanho vai no BOTÃO: é a última coisa lida antes do clique. */
export function rotuloBaixarAcessorio(
  a: Pick<AcessorioParaTexto, "tamanho_bytes">,
  deNovo: boolean,
): string {
  const tamanho = formatarTamanho(a.tamanho_bytes);
  return deNovo ? `Baixar de novo (${tamanho})` : `Baixar (${tamanho})`;
}

/**
 * Progresso do download. `total: null` = o servidor não anunciou o tamanho — e
 * "não sabemos" é um estado (DECISIONS #86).
 *
 * `segundosRestantes` é a velocidade MEDIDA desta conexão, e é `null` enquanto
 * a amostra é curta: num download de 180 MB, um "faltam 0 segundos" que dura
 * dez minutos é pior que nenhum número (DECISIONS #106).
 */
export function textoDoDownload(
  baixados: number,
  total: number | null,
  segundosRestantes: number | null,
): string {
  const feito = formatarTamanho(baixados);
  const base =
    total === null
      ? `Baixando… ${feito}`
      : `Baixando… ${feito} de ${formatarTamanho(total)}`;
  return segundosRestantes === null
    ? base
    : `${base} — ${tempoQueFalta(segundosRestantes)}`;
}

/**
 * O acessório, como a COPY precisa vê-lo — sete maneiras de tê-lo ou não, e
 * cada uma pede uma frase diferente.
 *
 * "Não sabemos" (`perguntando`, `indeterminado`) é estado próprio: virar "não
 * existe" mandaria a pessoa desistir de um recurso que ela tem, e virar
 * "pronto" prometeria uma etapa que não vai rodar (DECISIONS #86).
 */
export type EstadoDoAcessorio =
  | "perguntando"
  | "indeterminado"
  | "sem-binario"
  | "indisponivel"
  | "ausente"
  | "corrompido"
  | "pronto";

/**
 * Lê o que `acessorios_estado` devolveu, para UM acessório. Ponto único dessa
 * leitura — na V9 ela decidia quatro coisas na mesma tela, e elas voltavam a
 * discordar entre si quando cada uma lia o array por conta própria.
 *
 * `undefined` = a pergunta ainda não voltou; `null` = ela falhou; `[]` = não
 * publicamos binário para este computador.
 */
export function estadoDoAcessorio(
  lista: readonly { nome: string; estado: string }[] | null | undefined,
  nome: string,
): EstadoDoAcessorio {
  if (lista === undefined) return "perguntando";
  if (lista === null) return "indeterminado";
  const achado = lista.find((a) => a.nome === nome);
  // lista sem este acessório é o mesmo fato de lista vazia: ele não existe
  // nesta máquina
  if (!achado) return "sem-binario";
  switch (achado.estado) {
    case "pronto":
    case "ausente":
    case "corrompido":
    case "indisponivel":
      return achado.estado;
    default:
      // estado que esta versão do app não conhece (backend mais novo): "não
      // sabemos" é a única resposta honesta — nunca "pronto"
      return "indeterminado";
  }
}

/**
 * O estado do acessório não pôde ser conferido (o comando falhou). "Não
 * sabemos" é um estado próprio (DECISIONS #86).
 */
export const ACESSORIO_INDETERMINADO =
  "Não foi possível conferir este recurso agora.";

/** `acessorios_estado` não trouxe este acessório: não há binário para esta máquina. */
export const ACESSORIO_SEM_BINARIO =
  "Não publicamos este recurso para este computador.";

/** `estado: "indisponivel"`: o acessório não tem uso nesta build. */
export const ACESSORIO_INDISPONIVEL =
  "Este recurso não funciona nesta versão do aplicativo.";

/**
 * `estado: "pronto"`: nada a fazer, e nenhum pedido de ação.
 *
 * A frase deixou de falar do som na V10: são três acessórios, e cada um já tem
 * o seu "para que serve" como título logo acima desta linha.
 */
export const ACESSORIO_PRONTO = "Pronto. Não é preciso baixar de novo.";

/**
 * `estado: "corrompido"`: o arquivo do cache não bate com a soma compilada.
 * Sem drama e sem acusação: o arquivo foi descartado e a saída é baixar de
 * novo — que é o que a pessoa pode fazer a respeito.
 */
export const ACESSORIO_CORROMPIDO =
  "O arquivo que está aqui não confere e foi descartado. Baixe de novo.";

/**
 * Desfecho de quem clicou em "Parar". Cancelar e falhar terminam os dois com o
 * acessório ausente, e a tela precisa dizer QUAL dos dois aconteceu — por isso
 * o backend devolve `cancelado` como campo, e por isso este texto não fala em
 * erro nenhum.
 */
export const ACESSORIO_CANCELADO = "Download cancelado. Nada foi instalado.";

// ---------------------------------------------------------------------------
// O desfecho da aplicação
// ---------------------------------------------------------------------------

/**
 * O aviso do fim da aplicação. O PRD é explícito: "o aviso diz o que mudou
 * ('47 músicas ganharam letra'), não uma tarefa a fazer" — curadoria feita
 * dentro do app já reindexa, então nada de pedir reindexação ou reinício.
 */
export interface ResumoAplicacao {
  /** Não tinha letra e passou a ter. */
  ganharamLetra: number;
  /** JÁ TINHA letra e ela foi trocada — com o consentimento explícito. */
  letraSubstituida: number;
  /** V10 — a etapa 5 não achou voz e a pessoa confirmou a marca. */
  marcadasInstrumental: number;
  /** Só título/artista mudaram. */
  nomeCorrigido: number;
  /** Total efetivamente gravado (para o caso em que nada mudou). */
  gravadas: number;
}

export function textoAplicado({
  ganharamLetra,
  letraSubstituida,
  marcadasInstrumental,
  nomeCorrigido,
  gravadas,
}: ResumoAplicacao): string {
  const fecho = " A biblioteca já está atualizada.";
  /** Cada grupo em duas formas: a primeira da frase leva "músicas". */
  const grupos: Array<{ n: number; longo: string; curto: string }> = [
    // A substituição de letra vem PRIMEIRO de propósito: é a única mudança
    // deste aviso que apaga um texto que alguém pode ter escrito à mão.
    {
      n: letraSubstituida,
      longo:
        letraSubstituida === 1
          ? "1 música teve a letra substituída"
          : `${letraSubstituida} músicas tiveram a letra substituída`,
      curto:
        letraSubstituida === 1
          ? "1 teve a letra substituída"
          : `${letraSubstituida} tiveram a letra substituída`,
    },
    // V10 — a marca de instrumental vem em segundo pelo mesmo critério: ela
    // tira a música da fila de letra para sempre, e é a única mudança deste
    // aviso que NÃO aparece na lista depois (a música some da curadoria).
    {
      n: marcadasInstrumental,
      longo:
        marcadasInstrumental === 1
          ? "1 música foi marcada como instrumental"
          : `${marcadasInstrumental} músicas foram marcadas como instrumental`,
      curto:
        marcadasInstrumental === 1
          ? "1 foi marcada como instrumental"
          : `${marcadasInstrumental} foram marcadas como instrumental`,
    },
    {
      n: ganharamLetra,
      longo:
        ganharamLetra === 1
          ? "1 música ganhou letra"
          : `${ganharamLetra} músicas ganharam letra`,
      curto:
        ganharamLetra === 1 ? "1 ganhou letra" : `${ganharamLetra} ganharam letra`,
    },
    {
      n: nomeCorrigido,
      longo:
        nomeCorrigido === 1
          ? "1 música teve título ou artista corrigido"
          : `${nomeCorrigido} músicas tiveram título ou artista corrigidos`,
      curto:
        nomeCorrigido === 1
          ? "1 teve título ou artista corrigido"
          : `${nomeCorrigido} tiveram título ou artista corrigidos`,
    },
  ].filter((g) => g.n > 0);

  if (grupos.length === 0) {
    // gravou e nada mudou (proposta idêntica ao que já estava no arquivo):
    // inventar "ganhou letra" aqui seria contar uma vitória que não houve
    return gravadas === 1
      ? "1 música foi gravada, sem mudança no conteúdo."
      : `${gravadas} músicas foram gravadas, sem mudança no conteúdo.`;
  }

  // "A", "A e B", "A, B e C" — só a primeira parte repete "músicas"
  const partes = grupos.map((g, i) => (i === 0 ? g.longo : g.curto));
  const frase =
    partes.length === 1
      ? partes[0]
      : `${partes.slice(0, -1).join(", ")} e ${partes[partes.length - 1]}`;
  return `${frase}.${fecho}`;
}
