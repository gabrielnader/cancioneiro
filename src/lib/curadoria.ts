import { isUnderFolder, type FolderNode } from "./folderTree";
import type { Song } from "./types";

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
 * As músicas que o funil vai realmente consultar sob `folderPrefix`
 * ("" = biblioteca inteira). Espelha o filtro do `enrich_scan` do Rust e do
 * mock: indisponível fica de fora, instrumental fica de fora (V8/F17 — toda
 * etapa de letra pula o arquivo) e "completa" é ter letra E artista.
 */
export function musicasACurar(songs: Song[], folderPrefix: string): Song[] {
  return songs.filter((s) => {
    if (!s.available) return false;
    if (folderPrefix && !isUnderFolder(s.file_path, folderPrefix)) return false;
    if (s.instrumental === true) return false;
    return !(s.has_lyrics && s.artist !== null);
  });
}

/**
 * Segundos por música usados na estimativa: a pausa de cortesia do backend
 * (300 ms) mais a ida à rede. É uma ORDEM DE GRANDEZA — o texto diz "cerca
 * de" justamente por isso.
 */
const SEGUNDOS_POR_MUSICA = 2;

/**
 * O que aparece embaixo do seletor de pasta, antes de qualquer clique.
 * "O custo por pessoa importa mais" (PRD V8): saber quantas músicas e quanto
 * tempo deixa de ser conveniência e vira parte do fluxo.
 */
export function estimativaTexto(candidatas: number): string {
  if (candidatas <= 0) {
    return (
      "Nenhuma música desta pasta está sem título, artista ou letra —" +
      " não há nada para procurar."
    );
  }
  const segundos = candidatas * SEGUNDOS_POR_MUSICA;
  const tempo =
    segundos < 120
      ? "menos de 2 minutos"
      : `cerca de ${Math.round(segundos / 60)} minutos`;
  return candidatas === 1
    ? `1 música desta pasta está incompleta. A busca leva ${tempo}.`
    : `${candidatas} músicas desta pasta estão incompletas. A busca leva ${tempo}.`;
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
export function textoSemPropostas(total: number): string {
  if (total <= 0) {
    return (
      "Nenhuma música desta pasta estava incompleta — todas já têm título," +
      " artista e letra."
    );
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
  "Não achamos esta música nos sites de letra. Isso é comum e não quer dizer" +
  " que haja algo errado: a maior parte do repertório cantado em casa nunca" +
  " foi publicada na internet. Escrever a letra ouvindo o áudio ainda não é" +
  " feito pelo aplicativo — por enquanto, só pelas ferramentas de curadoria.";

/**
 * O aviso do fim da aplicação. O PRD é explícito: "o aviso diz o que mudou
 * ('47 músicas ganharam letra'), não uma tarefa a fazer" — curadoria feita
 * dentro do app já reindexa, então nada de pedir reindexação ou reinício.
 */
export function textoAplicado(
  ganharamLetra: number,
  nomeCorrigido: number,
  gravadas: number,
): string {
  const fecho = " A biblioteca já está atualizada.";
  const letra =
    ganharamLetra === 1
      ? "1 música ganhou letra"
      : `${ganharamLetra} músicas ganharam letra`;
  // no par, a segunda metade dispensa repetir "músicas"
  const nomeCurto =
    nomeCorrigido === 1
      ? "1 teve título ou artista corrigido"
      : `${nomeCorrigido} tiveram título ou artista corrigidos`;
  const nomeSozinho =
    nomeCorrigido === 1
      ? "1 música teve título ou artista corrigido"
      : `${nomeCorrigido} músicas tiveram título ou artista corrigidos`;

  if (ganharamLetra > 0 && nomeCorrigido > 0) {
    return `${letra} e ${nomeCurto}.${fecho}`;
  }
  if (ganharamLetra > 0) return `${letra}.${fecho}`;
  if (nomeCorrigido > 0) return `${nomeSozinho}.${fecho}`;
  // gravou e nada mudou (proposta idêntica ao que já estava no arquivo):
  // inventar "ganhou letra" aqui seria contar uma vitória que não houve
  return gravadas === 1
    ? "1 música foi gravada, sem mudança no conteúdo."
    : `${gravadas} músicas foram gravadas, sem mudança no conteúdo.`;
}
