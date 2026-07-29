import type { FolderNode } from "./folderTree";
import { ORIGEM_TRANSCRICAO } from "./types";

/**
 * O funil de curadoria dentro do app (PRD V8 — F18, Fase 1).
 *
 * Este módulo só tem função pura: contagem de candidatas, estimativa e — o que
 * mais importa neste produto — a COPY. São ~40 pessoas curando cada uma o seu
 * acervo, em máquinas que o dono do produto não pode olhar, sem ninguém para
 * perguntar. Toda mensagem daqui precisa se explicar sozinha e dizer o que
 * fazer em seguida; por isso o texto mora em funções testadas, e não solto no
 * meio do JSX.
 */

/** Endereço oficial da chave gratuita do Vagalume (mostrado, nunca aberto). */
export const VAGALUME_URL = "https://auth.vagalume.com.br/settings/api/";

/** Uma etapa do funil, como ela é explicada ANTES de a busca começar. */
export interface EtapaDoFunil {
  nome: string;
  explicacao: string;
}

/**
 * As três etapas que a Fase 1 executa dentro do app, na ordem de custo
 * crescente (DECISIONS #61). A ordem é conteúdo: quem lê precisa entender que
 * a rede só é usada depois que o que já está no arquivo não bastou.
 */
export const ETAPAS_DENTRO_DO_APP: EtapaDoFunil[] = [
  {
    nome: "O que já está no arquivo",
    explicacao: "as tags e o nome do arquivo, sem sair do computador.",
  },
  {
    nome: "LRCLIB",
    explicacao: "um banco de letras aberto e gratuito, na internet.",
  },
  {
    nome: "Vagalume",
    explicacao:
      "outro site de letras, só se você preencher a chave gratuita mais abaixo.",
  },
];

/**
 * O que a Fase 1 NÃO faz. Prometer as etapas pesadas seria mentir para quem
 * não tem a quem perguntar — e é justamente quem mais precisaria delas, já
 * que a cobertura dos sites de letra no acervo real é de ~3%.
 */
export const ETAPAS_FORA_DO_APP =
  "Reconhecer a música pelo som e escrever a letra ouvindo o áudio ainda não" +
  " são feitos aqui dentro: continuam só nas ferramentas de curadoria, fora" +
  " do aplicativo.";

/**
 * Quantas músicas o funil vai consultar nesta pasta.
 *
 * A regra de quem é candidata NÃO mora mais aqui: ela é UMA, no backend
 * (`enrich_count`, a mesma função que a varredura usa). A cópia em TypeScript
 * que existia neste arquivo divergia em três casos — instrumental sem artista,
 * título placeholder ("Faixa 03"), artista placeholder ("Artista Desconhecido")
 * — e subcontava até zero, desabilitando o único ponto de entrada do produto e
 * afirmando que a pasta estava completa ANTES de qualquer varredura. Regra
 * duplicada foi a causa; a correção é não duplicar.
 *
 * Como a contagem virou uma ida ao backend, ela tem três estados, e os três
 * são ditos na tela: nenhum deles pode virar "0" por omissão.
 */
export type ContagemCandidatas =
  | { estado: "contando" }
  | { estado: "pronta"; total: number }
  | { estado: "indisponivel" };

/**
 * Segundos por música na estimativa. NÃO é chute — é derivado do que o
 * backend faz por arquivo:
 *
 * - LRCLIB: `gerar_palpites` produz de 1 a ~8 palpites e a busca só para cedo
 *   quando algum deles rende ALTA. No acervo real (cobertura ~3%) a esmagadora
 *   maioria NÃO rende nada, ou seja, gasta todos os palpites: ~4 consultas na
 *   média das músicas incompletas, que são justamente as de tag ruim.
 * - cada consulta carrega a pausa de cortesia de 300 ms (`PAUSA_CORTESIA`)
 *   mais a resposta do servidor (~0,3 s a 1,5 s) ≈ 1,5 s.
 * - com título e artista reais ainda entra 1 consulta ao Vagalume.
 *
 * 4 × 1,5 s ≈ 6 s, mais a folga do Vagalume ≈ 7 s. O valor anterior (2 s)
 * errava por 3-4× no caminho normal e dizia "3 minutos" para uma busca de
 * ~10 minutos. E o pior caso nem é este: cada consulta tem timeout de 10 s no
 * ureq, então rede fora do ar leva UMA música a 40-80 s. Nenhuma margem de
 * segurança cobre erro de ordem de grandeza — por isso o texto abaixo diz "por
 * volta de" e avisa, com todas as letras, que internet lenta muda tudo.
 */
const SEGUNDOS_POR_MUSICA = 7;

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
const REGRA_COMPLETA =
  "todas já têm título e artista, e letra — ou a marca de instrumental," +
  " que dispensa a letra.";

/**
 * O que aparece embaixo do seletor de pasta, antes de qualquer clique.
 * "O custo por pessoa importa mais" (PRD V8): saber quantas músicas e quanto
 * tempo deixa de ser conveniência e vira parte do fluxo.
 *
 * `musicasNaPasta` é um fato local e barato (a pasta tem arquivo?), e existe
 * para separar "está tudo completo" de "não há nada aqui" — a contagem sozinha
 * devolve 0 nos dois casos, e afirmar completude de uma pasta vazia é a mentira
 * que o QA pegou rodando o app sem nenhuma pasta adicionada.
 */
export function estimativaTexto(
  contagem: ContagemCandidatas,
  musicasNaPasta: number,
): string {
  if (musicasNaPasta <= 0) {
    return (
      "Não há nenhuma música nesta pasta. Adicione uma pasta de música aqui" +
      " em Configurações, ou escolha outra pasta na lista acima."
    );
  }
  if (contagem.estado === "contando") {
    return "Contando quantas músicas desta pasta precisam de busca…";
  }
  if (contagem.estado === "indisponivel") {
    return (
      "Não foi possível contar quantas músicas desta pasta precisam de busca." +
      " A busca funciona mesmo assim: o total aparece assim que ela começar."
    );
  }
  if (contagem.total <= 0) {
    return `Nada a procurar nesta pasta: ${REGRA_COMPLETA}`;
  }
  const tempo = duracaoAproximada(contagem.total * SEGUNDOS_POR_MUSICA);
  const quantas =
    contagem.total === 1
      ? "1 música desta pasta está incompleta"
      : `${contagem.total} músicas desta pasta estão incompletas`;
  return (
    `${quantas}. A busca leva ${tempo}, e bem mais se a internet estiver` +
    " lenta ou fora do ar."
  );
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

/**
 * Fim de varredura sem NENHUMA proposta (DECISIONS #60).
 *
 * Com ~3% de cobertura no acervo real, este é o desfecho MAIS COMUM — não uma
 * exceção. O texto precisa fazer três coisas ao mesmo tempo: contar o que foi
 * feito, negar que seja fracasso e negar que a pasta esteja completa. E dizer
 * qual seria o passo seguinte, admitindo que ele ainda não existe aqui.
 */
export function textoSemPropostas(total: number | null): string {
  // `null` = a varredura terminou mas o acompanhamento do progresso não
  // chegou (a assinatura é best-effort e o catch é silencioso). Antes isso
  // virava `0`, e o texto do zero afirmava completude — falha silenciosa com
  // cara de sucesso. Sem o número, o texto simplesmente não conta ninguém.
  if (total === null) {
    return (
      "A busca terminou e não trouxe nenhuma proposta." +
      " Isso é comum e não quer dizer que a pasta esteja completa: a maior" +
      " parte do repertório cantado em casa nunca foi publicada na internet." +
      " Escrever a letra ouvindo o áudio ainda não é feito pelo aplicativo —" +
      " por enquanto, só pelas ferramentas de curadoria."
    );
  }
  if (total <= 0) {
    return `Nenhuma música desta pasta entrou na busca: ${REGRA_COMPLETA}`;
  }
  const conferidas =
    total === 1
      ? "Conferimos a única música incompleta desta pasta e não a achamos" +
        " nos sites de letra."
      : `Conferimos as ${total} músicas incompletas desta pasta e não` +
        " achamos nenhuma delas nos sites de letra.";
  return (
    `${conferidas}` +
    " Isso é comum e não quer dizer que a pasta esteja completa: a maior" +
    " parte do repertório cantado em casa nunca foi publicada na internet." +
    " Escrever a letra ouvindo o áudio ainda não é feito pelo aplicativo —" +
    " por enquanto, só pelas ferramentas de curadoria."
  );
}

/**
 * O mesmo desfecho, para UMA música (o caso pontual do editor). Vale a mesma
 * regra do lote: "não achamos" não pode soar como fracasso da pessoa nem como
 * "não há nada a fazer aqui".
 */
export const SEM_RESULTADO_INDIVIDUAL =
  "Procuramos e não achamos nada novo para esta música nos sites de letra." +
  " Isso é comum e não quer dizer que haja algo errado: a maior parte do" +
  " repertório cantado em casa nunca foi publicada na internet. Escrever a" +
  " letra ouvindo o áudio ainda não é feito pelo aplicativo — por enquanto," +
  " só pelas ferramentas de curadoria.";

/**
 * O mesmo desfecho para uma música marcada como INSTRUMENTAL. Ela para na
 * etapa 1: nenhuma etapa de LETRA roda para música sem voz (V8/F17), nem no
 * lote nem aqui. Repetir "não achamos nos sites de letra" contaria uma busca
 * que não aconteceu — e é justamente esse tipo de frase que faz a pessoa
 * concluir "a internet não tem a minha música" e parar de procurar.
 */
export const SEM_RESULTADO_INSTRUMENTAL =
  "Esta música está marcada como instrumental, então a busca não procurou" +
  " letra para ela — só conferiu o título e o artista, e não achou nada novo." +
  " Para procurar letra, desmarque “Esta música é instrumental” e busque de" +
  " novo.";

/** Rótulo da segunda marcação da revisão — o mesmo texto que o backend cita. */
export const LABEL_SUBSTITUIR_LETRA = "Substituir a letra atual";

/**
 * O aviso da linha de revisão cuja proposta passaria por cima de uma letra
 * que JÁ EXISTE no arquivo (CRÍTICO-1).
 *
 * A linha dizia só "letra encontrada", chegava pré-marcada quando ALTA e um
 * clique em "Aplicar selecionadas" apagava uma transcrição corrigida à mão.
 * Duas coisas precisam estar escritas, visíveis: que existe letra ali, e o
 * que acontece se ninguém marcar nada (aplica só os nomes — que é o valor
 * real dessas linhas).
 */
export function avisoLetraExistente(letraOrigem: string | null): string {
  const oQueTem =
    letraOrigem === ORIGEM_TRANSCRICAO
      ? "Esta música já tem letra, escrita ouvindo o áudio — e ela pode ter" +
        " sido corrigida à mão depois."
      : "Esta música já tem letra.";
  return `${oQueTem} Sem marcar abaixo, esta linha aplica só o título e o artista.`;
}

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
