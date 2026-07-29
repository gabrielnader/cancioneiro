import type { FolderNode } from "./folderTree";
import { ORIGEM_TRANSCRICAO, type Modo } from "./types";

/**
 * O funil de curadoria dentro do app (PRD V8/F18 fase 1; PRD V9 fase 2).
 *
 * Este módulo só tem função pura: contagem, estimativa e — o que mais importa
 * neste produto — a COPY. São ~40 pessoas curando cada uma o seu acervo, em
 * máquinas que o dono do produto não pode olhar, sem ninguém para perguntar.
 * Por isso o texto mora em funções testadas, e não solto no meio do JSX.
 *
 * # A régua da V9
 *
 * O retorno de campo desta rodada foi *"achando as mensagens muito longas no
 * sistema"*. A copy tinha sido escrita para resolver "não há suporte" e passou
 * do ponto: **texto que ninguém lê não explica nada**. A régua aplicada aqui,
 * texto por texto:
 *
 * - a PRIMEIRA frase diz o que é;
 * - o resto só existe se responder a uma pergunta que a pessoa faria NAQUELE
 *   momento.
 *
 * O que saiu foi justificativa nossa — "escrever a letra ouvindo o áudio ainda
 * não é feito pelo aplicativo, por enquanto só pelas ferramentas de curadoria",
 * repetida em três desfechos, apontando para uma ferramenta de terminal que
 * essas pessoas não têm (DECISIONS #78). O que FICOU foi tudo que muda uma
 * decisão: quantas músicas foram conferidas, que a pasta não está completa, o
 * que a marcação faz, e onde a chave do Vagalume é guardada (DECISIONS #84).
 */

/** Endereço oficial da chave gratuita do Vagalume (mostrado, nunca aberto). */
export const VAGALUME_URL = "https://auth.vagalume.com.br/settings/api/";

/** Uma etapa do funil, como ela é explicada ANTES de a busca começar. */
export interface EtapaDoFunil {
  nome: string;
  explicacao: string;
}

/**
 * As etapas que ESTA máquina vai executar, na ordem em que rodam (PRD V9).
 *
 * A lista é montada a partir do que existe aqui, e não do que o produto sabe
 * fazer em tese. As duas etapas condicionais são tratadas de jeitos
 * diferentes, e a diferença é deliberada:
 *
 * - **o som some da lista** quando o acessório não está aqui. Ligá-lo custa um
 *   download de 5 MB, e a lista tem, logo abaixo, um bloco inteiro dedicado a
 *   explicá-lo — a etapa é descoberta lá, que é onde dá para fazer algo a
 *   respeito;
 * - **o Vagalume FICA na lista** e a explicação dele diz a condição. Ligá-lo
 *   custa colar uma chave num campo desta mesma tela, e esconder a etapa
 *   esconderia a única frase que diz para que aquele campo serve. Não há
 *   suporte a quem perguntar depois (DECISIONS #78).
 *
 * O que não é aceitável é o que a v0.9.0 fazia: PROMETER a etapa 4 ("site
 * brasileiro de letras.") em toda instalação. Ela não roda em nenhuma — o
 * segredo `VAGALUME_API_KEY` nunca existiu, então não há chave embutida em
 * build alguma —, e o texto que dizia como ligá-la tinha sido apagado.
 *
 * A ordem é conteúdo (PRD V9): primeiro "que música é esta?" (arquivo, som),
 * depois "qual é a letra dela?" (LRCLIB, Vagalume). O som vem antes das bases
 * de letra porque ele não devolve letra nenhuma — devolve identidade, que é
 * ENTRADA das outras etapas.
 */
export function etapasDoFunil({ som, vagalume }: EtapasLigadas): EtapaDoFunil[] {
  const etapas: EtapaDoFunil[] = [
    {
      nome: "O que já está no arquivo",
      explicacao: "etiquetas e nome do arquivo, sem sair do computador.",
    },
  ];
  if (som) {
    etapas.push({
      nome: "Reconhecer pelo som",
      // "nada do acervo sai da máquina" é invariável do produto, e esta é a
      // única etapa que poderia parecer contrariá-lo: o que viaja é um resumo
      // acústico de alguns bytes, nunca o áudio.
      explicacao: "manda um resumo do áudio ao AcoustID; o áudio não sai daqui.",
    });
  }
  etapas.push(
    {
      nome: "LRCLIB",
      // "na internet" faz par com "sem sair do computador" da etapa 1: num app
      // que se vende como offline, saber quais etapas saem daqui é a pergunta.
      explicacao: "banco de letras aberto e gratuito, na internet.",
    },
    {
      nome: "Vagalume",
      explicacao: vagalume
        ? "site brasileiro de letras."
        : "site brasileiro de letras — só com a chave gratuita, mais abaixo.",
    },
  );
  return etapas;
}

/**
 * O parágrafo embaixo do campo da chave do Vagalume.
 *
 * `temChaveEmbutida` é o que ESTA build tem, não o que o PRD previu. Enquanto
 * a resposta for `false`, dizer "só é preciso preencher se a busca do Vagalume
 * parar de funcionar" afirma que ela funciona sem a chave — e não funciona.
 * Copy que mente sobre credencial é defeito mesmo quando o comportamento é o
 * certo (DECISIONS #84).
 */
export function textoDaChaveDoVagalume(temChaveEmbutida: boolean): string {
  return temChaveEmbutida
    ? "Só é preciso preencher se a busca do Vagalume parar de funcionar."
    : "Sem ela, a busca não consulta o Vagalume.";
}

/**
 * O que o app ainda NÃO faz.
 *
 * Antes ele negava duas coisas: reconhecer pela impressão digital e escrever a
 * letra ouvindo o áudio. A primeira passou a existir nesta versão — continuar
 * negando-a seria mentir sobre o próprio produto, e é por isso que este texto
 * foi CONFERIDO antes de ser encurtado, não só aparado.
 */
export const ETAPAS_FORA_DO_APP =
  "Escrever a letra ouvindo o áudio ainda não é feito aqui dentro.";

/**
 * A regra de quem é candidata NÃO mora aqui: ela é UMA, no backend
 * (`enrich_count`, a mesma função que a varredura usa). A cópia em TypeScript
 * que existia neste arquivo divergia em três casos e subcontava até zero,
 * desabilitando o único ponto de entrada do produto (QA ALTO-2).
 *
 * Como a contagem virou uma ida ao backend, ela tem três estados, e os três
 * são ditos na tela: nenhum deles pode virar "0" por omissão.
 */
export type ContagemCandidatas =
  | { estado: "contando" }
  | { estado: "pronta"; total: number }
  | { estado: "indisponivel" };

/** Quais etapas vão de fato rodar nesta máquina, nesta busca (V9). */
export interface EtapasLigadas {
  /** Etapa 2 — o acessório `fpcalc` está pronto E a etapa existe nesta build. */
  som: boolean;
  /** Etapa 4 — o Vagalume vai ser consultado. */
  vagalume: boolean;
}

// ---------------------------------------------------------------------------
// O custo de cada etapa, por música — DERIVADO, não chutado (DECISIONS #85)
// ---------------------------------------------------------------------------
//
// A estimativa era um número fixo de 7 s/música, e ele ACERTOU na medição de
// campo: 16 músicas em ~2 min (7,5 s/música) com as etapas 1 e 3 apenas. O que
// mudou na V9 é que "as etapas 1 e 3 apenas" deixou de ser o único cenário.

/**
 * Etapa 2 (som). O `fpcalc` lê só os primeiros ~120 s do áudio: ~0,3 s (PRD
 * V9). Mais UMA consulta ao AcoustID, com o piso de cortesia de 340 ms
 * (`fingerprint::PAUSA_ACOUSTID`) e a resposta do servidor (~0,3 a 1,5 s).
 * 0,3 + 0,34 + ~1,2 ≈ 1,9 → 2 s, arredondado para cima.
 */
const CUSTO_SOM = 2;

/**
 * Etapa 3 (LRCLIB). MEDIDO em campo: 16 músicas em ~2 min com as etapas 1 e 3,
 * ou seja 7,5 s/música. Bate com a derivação: sem nome conhecido o
 * `gerar_palpites` produz até 7 palpites, e no acervo real (cobertura ~3%) a
 * maioria gasta todos — ~4 consultas de ~1,5 s cada (300 ms de cortesia mais a
 * resposta).
 */
const CUSTO_LRCLIB = 7;

/**
 * Etapa 4 (Vagalume). UMA consulta: 300 ms de cortesia (`PAUSA_CORTESIA`) mais
 * a resposta (~1,2 s) ≈ 1,5 s, arredondado para cima. Ela não roda para todo
 * mundo (exige título E artista reais), então este é um teto, não uma média —
 * e teto é o lado certo de errar numa estimativa.
 */
const CUSTO_VAGALUME = 2;

/**
 * Segundos por música, dado o trabalho e as etapas ligadas.
 *
 * O que NÃO é descontado, de propósito: o PRD observa que a etapa 2 barateia a
 * etapa 3 (com o nome verdadeiro, o LRCLIB recebe 1 palpite em vez de até 7).
 * É verdade, mas só quando o AcoustID reconhece a gravação — minoria neste
 * repertório —, e o desconto empurraria a previsão para BAIXO do tempo real.
 * Estimativa que promete menos do que leva é exatamente o defeito da
 * DECISIONS #85; estimativa folgada, não.
 */
export function segundosPorMusica(modo: Modo, etapas: EtapasLigadas): number {
  // A conferência é UM trabalho: perguntar ao som. As etapas de letra são o
  // outro, e não rodam aqui (enrich.rs para depois da etapa 2).
  if (modo === "conferencia") return CUSTO_SOM;
  return (
    (etapas.som ? CUSTO_SOM : 0) +
    CUSTO_LRCLIB +
    (etapas.vagalume ? CUSTO_VAGALUME : 0)
  );
}

/** "menos de 1 minuto" / "por volta de 11 minutos" / "por volta de 2 horas". */
function duracaoAproximada(segundos: number): string {
  if (segundos < 60) return "menos de 1 minuto";
  const minutos = Math.round(segundos / 60);
  if (minutos < 90) return `por volta de ${minutos} minutos`;
  const horas = Math.round(minutos / 60);
  return horas === 1 ? "por volta de 1 hora" : `por volta de ${horas} horas`;
}

/**
 * A regra de completude, dita em pt-BR. "Todas já têm título, artista e letra"
 * era falso: a música marcada como INSTRUMENTAL sai da conta exatamente por
 * não ter letra a ter (V8/F17). Quem lê precisa reconhecer o próprio acervo na
 * frase — senão a única explicação disponível está errada.
 */
// A ordem das palavras é deliberada: "título e artista, e letra — ou a marca"
// diz que a alternativa substitui a LETRA, e não o conjunto. "Todas já têm
// título, artista e letra" seguido de uma ressalva solta era justamente o que
// o QA reprovou, e há teste proibindo essa formulação.
//
// BAIXO-4: o passe de redução tirou o travessão e o "que dispensa a letra", e
// a frase virou uma lista ambígua de três itens ("letra ou a marca de
// instrumental"). O que a marca dispensa é a LETRA, e é essa a informação que
// faz alguém reconhecer o próprio acervo na frase.
const REGRA_COMPLETA =
  "todas já têm título e artista, e letra — ou a marca de instrumental," +
  " que dispensa a letra.";

/** O trabalho a estimar: quantas músicas, em que modo, com que etapas. */
export interface Estimativa {
  contagem: ContagemCandidatas;
  /**
   * Quantas músicas há na pasta, ponto — fato local e barato. Existe para
   * separar "está tudo completo" de "não há nada aqui": a contagem sozinha
   * devolve 0 nos dois casos, e afirmar completude de uma pasta vazia é a
   * mentira que o QA pegou rodando o app sem nenhuma pasta adicionada.
   */
  musicasNaPasta: number;
  modo: Modo;
  etapas: EtapasLigadas;
}

/**
 * O que aparece embaixo do seletor de pasta, antes de qualquer clique.
 * "O custo por pessoa importa mais" (PRD V8): saber quantas músicas e quanto
 * tempo deixa de ser conveniência e vira parte do fluxo.
 */
export function estimativaTexto({
  contagem,
  musicasNaPasta,
  modo,
  etapas,
}: Estimativa): string {
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
  if (contagem.total <= 0) {
    return modo === "conferencia"
      ? "Nenhuma música desta pasta pode ser conferida."
      : `Nada a procurar nesta pasta: ${REGRA_COMPLETA}`;
  }
  const tempo = duracaoAproximada(
    contagem.total * segundosPorMusica(modo, etapas),
  );
  // BAIXO-4 — a mitigação da DECISIONS #85 são estas duas metades, e o passe
  // de redução levou as duas: "BEM mais" (a estimativa erra por fator, não por
  // margem) e a rede FORA DO AR, que é justamente o caso em que a busca
  // demora um múltiplo do previsto. "mais se a internet estiver lenta" soa
  // como uns minutos a mais.
  const fecho = `, e bem mais se a internet estiver lenta ou fora do ar.`;
  if (modo === "conferencia") {
    const quantas =
      contagem.total === 1 ? "1 música nesta pasta" : `${contagem.total} músicas nesta pasta`;
    // o custo do modo caro está na frase que anuncia o custo, não num aviso
    // à parte: ler o áudio de TODAS é o que o torna outro trabalho
    return `${quantas}. A conferência lê o áudio de todas: ${tempo}${fecho}`;
  }
  const quantas =
    contagem.total === 1
      ? "1 música incompleta nesta pasta"
      : `${contagem.total} músicas incompletas nesta pasta`;
  return `${quantas}. A busca leva ${tempo}${fecho}`;
}

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
// Os dois trabalhos (PRD V9) — completar o que falta x conferir a etiqueta
// ---------------------------------------------------------------------------

/**
 * Os dois modos, na ordem em que aparecem. O padrão é o primeiro, e isso não
 * muda: a conferência lê o áudio de TODAS as músicas e é disparada de
 * propósito.
 *
 * O caso que a criou é real: um arquivo etiquetado "Te ver feliz, te ver
 * contente" / "Caetano Veloso" que é "Viver Feliz", do Nilson Chaves. Nada ali
 * é placeholder, então o funil considera a música completa e o erro fica
 * invisível para sempre.
 */
export const MODOS: Array<{ modo: Modo; rotulo: string; explicacao: string }> = [
  {
    modo: "completar",
    rotulo: "Completar o que falta",
    explicacao: "procura título, artista e letra das músicas incompletas.",
  },
  {
    modo: "conferencia",
    rotulo: "Conferir se a etiqueta está certa",
    explicacao: "lê o áudio de todas as músicas e pergunta ao som que música é.",
  },
];

/**
 * O acessório do som, como a COPY precisa vê-lo — cinco maneiras de não ter a
 * etapa 2, e cada uma pede uma frase diferente.
 *
 * "Não sabemos" (`perguntando`, `indeterminado`) é estado próprio: virar
 * "não existe" mandaria a pessoa desistir de um recurso que ela tem, e virar
 * "pronto" prometeria uma etapa que não vai rodar (DECISIONS #86).
 */
export type EstadoDoSom =
  | "perguntando"
  | "indeterminado"
  | "sem-binario"
  | "indisponivel"
  | "ausente"
  | "corrompido"
  | "pronto";

/**
 * Lê o que `acessorios_estado` devolveu. Ponto ÚNICO dessa leitura: ela decide
 * se a etapa 2 é listada, se a conferência é possível, quanto tempo a
 * estimativa promete e o que o motivo do bloqueio diz — e essas quatro
 * respostas precisam vir do mesmo lugar, ou voltam a discordar entre si.
 *
 * `undefined` = a pergunta ainda não voltou; `null` = ela falhou; `[]` = não
 * publicamos binário para este computador.
 */
export function estadoDoSom(
  lista: readonly { nome: string; estado: string }[] | null | undefined,
): EstadoDoSom {
  if (lista === undefined) return "perguntando";
  if (lista === null) return "indeterminado";
  const fpcalc = lista.find((a) => a.nome === "fpcalc");
  // lista sem o fpcalc é o mesmo fato de lista vazia, do ponto de vista de
  // quem quer conferir etiqueta: o som não existe nesta máquina
  if (!fpcalc) return "sem-binario";
  switch (fpcalc.estado) {
    case "pronto":
    case "ausente":
    case "corrompido":
    case "indisponivel":
      return fpcalc.estado;
    default:
      // estado que esta versão do app não conhece (backend mais novo):
      // "não sabemos" é a única resposta honesta — nunca "pronto"
      return "indeterminado";
  }
}

/**
 * Por que a conferência não está disponível — texto na tela, e não `title=`
 * (DECISIONS #87). `null` quando ela ESTÁ disponível.
 *
 * O motivo DERIVA do estado do acessório. Antes era uma string fixa, mostrada
 * sempre que faltava o som, e em três dos cinco estados ela mandava "baixar o
 * acessório abaixo" enquanto o bloco logo abaixo dizia que não havia nada para
 * baixar e não desenhava botão nenhum. A tela se contradizia a três
 * centímetros de distância, para quem não tem a quem perguntar.
 *
 * A régua: só manda baixar onde EXISTE botão de baixar; nos outros casos diz
 * o fato, na mesma língua do bloco do acessório, e não pede nada.
 */
export function motivoDaConferencia(estado: EstadoDoSom): string | null {
  switch (estado) {
    case "pronto":
      return null;
    case "perguntando":
      return "Conferindo se este computador reconhece música pelo som…";
    case "indeterminado":
      return "Precisa do reconhecimento pelo som, e não deu para conferir se ele está aqui.";
    case "sem-binario":
      return "Precisa do reconhecimento pelo som, que não publicamos para este computador.";
    case "indisponivel":
      return "Precisa do reconhecimento pelo som, que não funciona nesta versão do aplicativo.";
    case "ausente":
      return "Precisa do reconhecimento pelo som — baixe o acessório abaixo.";
    case "corrompido":
      return "Precisa do reconhecimento pelo som — baixe o acessório abaixo de novo.";
  }
}

/** O botão diz qual dos dois trabalhos vai começar. */
export function rotuloDoDisparo(modo: Modo): string {
  return modo === "conferencia" ? "Conferir esta pasta" : "Buscar dados desta pasta";
}

/**
 * Fim de varredura sem NENHUMA proposta (DECISIONS #60).
 *
 * Com ~3% de cobertura no acervo real, este é o desfecho MAIS COMUM — não uma
 * exceção. Ele precisa contar o que foi feito e negar a completude, e é só
 * isso: a terceira frase, que apontava para as ferramentas de fora, saiu no
 * passe de redução (ninguém aqui abre terminal).
 */
export function textoSemPropostas(
  total: number | null,
  modo: Modo,
  /**
   * Quantas músicas a etapa 2 deixou de perguntar ao som depois de se
   * desligar (QA A2). Vem no RETORNO da varredura, não do progresso — por
   * isso ela não desaparece quando a assinatura de progresso falha.
   */
  semPerguntarAoSom = 0,
): string {
  // Vem ANTES de tudo porque é o fato DOMINANTE: dizer "conferimos 40 músicas
  // e o som não contradisse nenhuma etiqueta" quando 37 nunca foram
  // perguntadas é falso duas vezes — não conferimos 40, e o silêncio das 37
  // não é concordância. É a DECISIONS #86 acontecendo por omissão de escopo.
  if (semPerguntarAoSom > 0) {
    return modo === "conferencia"
      ? `${pararamNoMeio(semPerguntarAoSom)} Nas outras, o som não contradisse nenhuma etiqueta — repita quando ele voltar a funcionar.`
      : `${pararamNoMeio(semPerguntarAoSom)} Nas outras não achamos nada — repita a busca quando ele voltar a funcionar.`;
  }
  if (modo === "conferencia") return semDivergencias(total);
  // `null` = a varredura terminou mas o acompanhamento do progresso não
  // chegou (a assinatura é best-effort e o catch é silencioso). Antes isso
  // virava `0`, e o texto do zero afirmava completude — falha silenciosa com
  // cara de sucesso. Sem o número, o texto simplesmente não conta ninguém.
  if (total === null) {
    return `A busca terminou sem nenhuma proposta. ${NAO_E_FRACASSO}`;
  }
  if (total <= 0) {
    return `Nenhuma música desta pasta entrou na busca: ${REGRA_COMPLETA}`;
  }
  const conferidas =
    total === 1
      ? "Conferimos a única música incompleta desta pasta e não achamos nada."
      : `Conferimos as ${total} músicas incompletas desta pasta e não achamos nenhuma.`;
  return `${conferidas} ${NAO_E_FRACASSO}`;
}

// ---------------------------------------------------------------------------
// QA A2 — as músicas que a etapa 2 deixou de perguntar
// ---------------------------------------------------------------------------
//
// Uma falha do `fpcalc` desligava a etapa 2 pelo resto da varredura. A pessoa
// via UMA linha vermelha, as outras 149 sem nada, e concluía que o resto tinha
// sido conferido. O backend passou a contar quantas ficaram sem ser
// perguntadas (`EnrichScanResult.sem_perguntar_ao_som`); se a tela não disser
// o número, o defeito continua idêntico — silêncio lido como aprovação
// (DECISIONS #86).

/** A primeira frase dos dois desfechos: o fato, com o número. */
function pararamNoMeio(quantas: number): string {
  const musicas =
    quantas === 1
      ? "1 música não chegou a ser perguntada"
      : `${quantas} músicas não chegaram a ser perguntadas`;
  return `O reconhecimento pelo som parou no meio: ${musicas}.`;
}

/**
 * O aviso que acompanha um desfecho COM propostas. `null` quando não há nada
 * a dizer — e zero é o caso normal de toda varredura que correu bem: um
 * "0 músicas ficaram sem ser perguntadas" em cada desfecho é o ruído que
 * ensina a pessoa a ignorar o aviso justamente quando ele importar.
 *
 * O "o que fazer em seguida" NÃO chuta a causa. O número não distingue o
 * acessório que não roda nesta máquina do AcoustID que recusou o aplicativo,
 * e mandar procurar antivírus quando o problema é do servidor alheio é pior
 * que não mandar nada. O passo comum aos dois é repetir quando o som voltar —
 * e o motivo específico já está na linha de erro da música que o disparou.
 */
export function avisoSemPerguntarAoSom(quantas: number, modo: Modo): string | null {
  if (quantas <= 0) return null;
  return modo === "conferencia"
    ? // a conferência é o trabalho caro, disparado de propósito: ela não pode
      // passar por concluída com 37 de 40 músicas nunca perguntadas
      `${pararamNoMeio(quantas)} Elas continuam sem conferência — repita quando ele voltar a funcionar.`
    : `${pararamNoMeio(quantas)} Repita a busca quando ele voltar a funcionar.`;
}

/**
 * A segunda frase de todo desfecho vazio: nem fracasso, nem pasta completa.
 * É a única parte da copy antiga que sobreviveu inteira ao passe — porque
 * responde à pergunta que a pessoa faz naquele segundo ("então está pronto?"),
 * e responder errado é o defeito da DECISIONS #60.
 */
const NAO_E_FRACASSO =
  "Isso é comum e não significa pasta completa: a maior parte do repertório" +
  " cantado em casa nunca foi publicada.";

/**
 * O desfecho da CONFERÊNCIA sem divergência.
 *
 * Ele NÃO pode dizer "suas etiquetas estão certas": o AcoustID não reconhece
 * toda gravação, e a música que ele não reconheceu sai daqui exatamente igual
 * à que ele confirmou. Afirmar o que o programa não sabe é a DECISIONS #86,
 * e aqui ela custaria a confiança inteira no modo novo.
 */
function semDivergencias(total: number | null): string {
  const ressalva =
    "O som não reconhece toda gravação: as que ele não reconheceu ficam sem" +
    " resposta.";
  if (total === null) {
    return `A conferência terminou sem nenhuma divergência. ${ressalva}`;
  }
  if (total <= 0) return "Nenhuma música desta pasta pôde ser conferida.";
  const conferidas =
    total === 1
      ? "Conferimos a única música desta pasta e o som não contradisse a etiqueta."
      : `Conferimos ${total} músicas e o som não contradisse nenhuma etiqueta.`;
  return `${conferidas} ${ressalva}`;
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
 * letra" contaria uma busca que não aconteceu. A segunda frase fica porque é
 * ação, não justificativa — é o caminho de volta.
 */
export const SEM_RESULTADO_INSTRUMENTAL =
  "Esta música está marcada como instrumental: procuramos só título e artista," +
  " e não achamos nada novo. Para procurar letra, desmarque “Esta música é" +
  " instrumental”.";

/** Rótulo da segunda marcação da revisão — o mesmo texto que o backend cita. */
export const LABEL_SUBSTITUIR_LETRA = "Substituir a letra atual";

/**
 * O aviso da linha de revisão cuja proposta passaria por cima de uma letra que
 * JÁ EXISTE no arquivo (CRÍTICO-1).
 *
 * Duas coisas precisam estar escritas: que existe letra ali, e o que acontece
 * se ninguém marcar nada (aplica só os nomes — que é o valor real dessas
 * linhas). O sujeito ("Esta música") saiu: a linha inteira já é sobre ela.
 *
 * BAIXO-4: o "abaixo" voltou. Ele aponta a marcação que fica na linha logo
 * embaixo deste texto, numa lista que pode ter dezenas de linhas com caixas
 * parecidas — "marcar" sem dizer onde não é instrução, é adivinhação.
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
 * portanto ALTA, portanto pré-marcada — e um clique em "Aplicar selecionadas"
 * leva embora o que alguém digitou à mão. Aqui não há consentimento separado
 * como na letra (a revisão já mostra os dois lados, então a troca não é
 * invisível): o que muda é só a pré-marcação.
 */
export const AVISO_NOME_ESCRITO =
  "Isto troca um título ou artista que já existe — confira antes de marcar.";

// ---------------------------------------------------------------------------
// Conflito: o som contra a etiqueta (V9)
// ---------------------------------------------------------------------------
//
// O vocabulário da revisão é "atual → proposto", e conflito não é isso: nada
// foi proposto. A linha existe para INFORMAR que duas fontes discordam, e as
// duas precisam ser nomeadas por quem as disse — senão a pessoa não tem como
// escolher. "Atual/proposto" sugeriria que o app já escolheu um lado.

/** O lado do arquivo, na linha de conflito. */
export const LABEL_SUA_ETIQUETA_DIZ = "Sua etiqueta diz";
/** O lado do reconhecimento acústico, na linha de conflito. */
export const LABEL_SOM_DIZ = "O som diz";

/** Rótulo acessível da marcação: aceitar é escolha POR LINHA, nunca em massa. */
export function rotuloAceitarSom(tituloAtual: string): string {
  return `Aceitar o que o som diz: ${tituloAtual}`;
}

/**
 * A confiança que aparece na linha de conflito é a do RECONHECIMENTO, não a
 * da linha (que é sempre "baixa", para nunca chegar pré-marcada). Sem ela a
 * pessoa não tem como pesar quanto crédito dar ao som.
 */
export function confiancaDoSom(confianca: "alta" | "media"): string {
  return confianca === "alta" ? "confiança alta" : "confiança média";
}

/**
 * O cabeçalho da revisão.
 *
 * As divergências são contadas À PARTE: a linha de conflito tem
 * `confidence: "baixa"` sempre, e somá-la ali diria "1 baixa" sobre algo que
 * não é palpite fraco nenhum. (MÉDIO-12 já tinha mostrado o estrago de contar
 * na confiança linhas que não são propostas.)
 */
export function textoDoCabecalho({
  alta,
  media,
  baixa,
  conflitos,
}: {
  alta: number;
  media: number;
  baixa: number;
  conflitos: number;
}): string {
  const propostas = alta + media + baixa;
  const contagem = `${alta} alta, ${media} média, ${baixa} baixa`;
  const quantasPropostas =
    propostas === 1 ? "1 proposta" : `${propostas} propostas`;
  const divergencias =
    conflitos === 1
      ? "1 música em que o som discorda da etiqueta"
      : `${conflitos} músicas em que o som discorda da etiqueta`;

  if (propostas === 0 && conflitos === 0) return "Nenhuma proposta para aplicar.";
  if (conflitos === 0) return `${quantasPropostas} — ${contagem}`;
  if (propostas === 0) return divergencias;
  return `${quantasPropostas} — ${contagem}; e ${conflitos} em que o som discorda da etiqueta`;
}

// ---------------------------------------------------------------------------
// Acessórios (PRD V9) — nada baixa sozinho
// ---------------------------------------------------------------------------

/**
 * "Quanto ocupa", em pt-BR. Uma casa decimal e vírgula: é um número para
 * decidir se vale a pena, não para conferir byte a byte.
 */
export function formatarTamanho(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1).replace(".", ",")} MB`;
  return `${Math.round(bytes / 1024)} kB`;
}

/** O mínimo que a tela precisa saber de um acessório para falar dele. */
export interface AcessorioParaTexto {
  /** Frase pronta vinda do backend ("reconhecer a música pelo som"). */
  para_que_serve: string;
  tamanho_bytes: number;
}

/**
 * Regra 1 do PRD V9: a tela diz ANTES o que vai baixar e quanto ocupa. O "para
 * que serve" vem do backend em pt-BR — a pessoa não sabe (e não precisa saber)
 * o que é "impressão digital acústica".
 *
 * "Uma vez só" responde à pergunta seguinte, que é a regra 3: baixou uma vez,
 * o app não pergunta de novo.
 */
export function textoDoAcessorioAusente(a: AcessorioParaTexto): string {
  return `Para ${a.para_que_serve}, é preciso baixar um arquivo de ${formatarTamanho(a.tamanho_bytes)}. Uma vez só.`;
}

/** O tamanho vai no BOTÃO: é a última coisa lida antes do clique. */
export function rotuloBaixarAcessorio(
  a: AcessorioParaTexto,
  deNovo: boolean,
): string {
  const tamanho = formatarTamanho(a.tamanho_bytes);
  return deNovo ? `Baixar de novo (${tamanho})` : `Baixar (${tamanho})`;
}

/**
 * Progresso do download. `total: null` = o servidor não anunciou o tamanho —
 * e "não sabemos" é um estado: um zero no lugar viraria uma barra parada em 0%
 * de um arquivo vazio (DECISIONS #86).
 */
export function textoDoDownload(baixados: number, total: number | null): string {
  const feito = formatarTamanho(baixados);
  return total === null
    ? `Baixando… ${feito}`
    : `Baixando… ${feito} de ${formatarTamanho(total)}`;
}

/**
 * O estado do acessório não pôde ser conferido (o comando falhou). "Não
 * sabemos" é um estado próprio: virar "não existe" mandaria a pessoa desistir
 * de um recurso que ela tem, e virar "pronto" prometeria uma etapa que não vai
 * rodar (DECISIONS #86).
 */
export const ACESSORIO_INDETERMINADO =
  "Não foi possível conferir este recurso agora.";

/** `acessorios_estado` devolveu []: não publicamos binário para esta máquina. */
export const ACESSORIO_SEM_BINARIO =
  "Não publicamos este recurso para este computador.";

/** `estado: "indisponivel"`: o acessório não tem uso nesta build. */
export const ACESSORIO_INDISPONIVEL =
  "Este recurso não funciona nesta versão do aplicativo.";

/** `estado: "pronto"`: nada a fazer, e nenhum pedido de ação. */
export const ACESSORIO_PRONTO = "Pronto — a busca já reconhece música pelo som.";

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
  /** Só título/artista mudaram. */
  nomeCorrigido: number;
  /** Total efetivamente gravado (para o caso em que nada mudou). */
  gravadas: number;
}

export function textoAplicado({
  ganharamLetra,
  letraSubstituida,
  nomeCorrigido,
  gravadas,
}: ResumoAplicacao): string {
  const fecho = " A biblioteca já está atualizada.";
  /** Cada grupo em duas formas: a primeira da frase leva "músicas". */
  const grupos: Array<{ n: number; longo: string; curto: string }> = [
    // A substituição de letra vem PRIMEIRO de propósito: é a única mudança
    // deste aviso que apaga um texto que alguém pode ter escrito à mão. Uma
    // linha destrutiva escondida no fim de uma soma não é um aviso.
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
