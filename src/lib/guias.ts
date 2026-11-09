import { create } from "zustand";
import { useEnrichStore } from "../stores/enrichStore";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlaylistStore } from "../stores/playlistStore";
import { useUiStore } from "../stores/uiStore";

/**
 * V16.7 — "Como faço?": guias que mostram o caminho NA TELA DE VERDADE. Pedido
 * do dono do produto pensando em quem tem 70 anos: o tutorial que se vê uma vez
 * é esquecido; a ajuda tem de estar sempre à mão e ensinar fazendo.
 *
 * Cada passo aponta um elemento marcado com `data-guia="…"` e diz o que fazer.
 * O passo avança:
 * - `clique`: quando a pessoa clica no elemento apontado;
 * - `quando`: quando a condição fica verdadeira (escreveu na busca, a música
 *   começou a tocar, a lista foi criada…);
 * - `botao`: quando a pessoa clica em "Entendi" (só explicação).
 * `pularSe` pula o passo que não é preciso (os detalhes já estão abertos…).
 */

export type GuiaId =
  | "achar"
  | "tocar"
  | "letra-maior"
  | "criar-lista"
  | "por-na-lista"
  | "anotacao"
  | "corrigir"
  | "completar"
  | "ver-letra"
  | "mudar-ordem"
  | "tocar-lista"
  | "tirar-da-lista"
  | "pasta"
  | "tema"
  | "escrever-letras"
  | "conferir"
  | "instrumental"
  | "adicionar-pasta"
  | "musicas-novas"
  | "consertar-arquivo"
  | "atualizar"
  | "tela-escura"
  | "primeiros-passos";

/** O retrato do começo do guia, para as condições compararem. */
export interface Inicio {
  listas: number;
  musicasNasListas: number;
  zoom: number;
}

export interface Passo {
  alvo: string;
  texto: string;
  avanca: "clique" | "botao" | "quando";
  quando?: (inicio: Inicio) => boolean;
  pularSe?: () => boolean;
  /** roda ao chegar no passo (ex.: sair de Configurações) */
  antes?: () => void;
  /**
   * V16.10 — o que dizer quando o lugar apontado não aparece na tela (não há
   * nada esperando conferência, nenhum arquivo para consertar…). Sem isto, o
   * balão ficaria no meio da tela pedindo um clique impossível.
   */
  semAlvo?: string;
}

export interface Guia {
  pergunta: string;
  passos: Passo[];
  /** frase de quando o guia não tem como começar (sem músicas, sem listas) */
  impedimento?: () => string | null;
  fim: string;
}

/**
 * O elemento com aquela marca que está na tela: o primeiro dentro da janela,
 * ou — se nenhum estiver à vista (a página de Organizar é comprida) — o
 * primeiro que existe, e o guia rola a tela até ele.
 */
export function elementoDoGuia(alvo: string): HTMLElement | null {
  const todos = document.querySelectorAll<HTMLElement>(`[data-guia="${alvo}"]`);
  let fora: HTMLElement | null = null;
  for (const el of todos) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.bottom > 0 && r.top < window.innerHeight) return el;
    fora ??= el;
  }
  return fora;
}

export const visivel = (alvo: string) => elementoDoGuia(alvo) !== null;

/** Volta para "Todas as músicas" — de Configurações ou de dentro de uma lista,
 *  onde as músicas que o guia aponta não estão. */
const naBiblioteca = () => {
  const ui = useUiStore.getState();
  if (ui.view !== "library") {
    usePlaylistStore.getState().closePlaylist();
    ui.setView("library");
  }
};

/** Sem pasta, não há o que achar nem tocar: os primeiros passos vão direto ao "Como faço?". */
const semPasta = () => useLibraryStore.getState().folders.length === 0;

const semMusicas = () =>
  useLibraryStore.getState().folders.length === 0
    ? "Ainda não há músicas no app. Primeiro, em “Organizar minhas músicas”, adicione a pasta onde elas estão."
    : null;

/** Escolher uma música e abrir os detalhes: o começo de anotar e de corrigir. */
const abrirOsDetalhes: Passo[] = [
  {
    alvo: "linha",
    texto: "Clique no nome de uma música.",
    avanca: "quando",
    quando: () => useLibraryStore.getState().selectedSongId !== null,
    pularSe: () => useLibraryStore.getState().selectedSongId !== null,
    antes: naBiblioteca,
  },
  {
    alvo: "mostrar-detalhes",
    texto: "Clique aqui para abrir os detalhes da música.",
    avanca: "clique",
    pularSe: () => visivel("detalhes"),
  },
];

/** Sem nenhuma lista, os guias de lista mandam criar uma primeiro. */
const semListas = () =>
  semMusicas() ??
  (usePlaylistStore.getState().playlists.length === 0
    ? "Você ainda não tem nenhuma lista. Primeiro crie uma: em “Como faço?”, escolha “Como eu crio uma lista de músicas?”."
    : null);

const naLista = () => useUiStore.getState().view === "playlist";

/** Abrir uma lista (em janela estreita, a gaveta das listas antes). */
const abrirUmaLista: Passo[] = [
  {
    alvo: "listas-e-pastas",
    texto: "Clique aqui para abrir as suas listas.",
    avanca: "clique",
    pularSe: () => naLista() || visivel("lista-na-lateral"),
  },
  {
    alvo: "lista-na-lateral",
    texto: "Clique no nome de uma lista para abri-la.",
    avanca: "quando",
    quando: naLista,
    pularSe: naLista,
  },
];

/** Ir para "Organizar minhas músicas" (Configurações). */
const irParaOrganizar: Passo = {
  alvo: "organizar",
  texto: "Clique em “Organizar minhas músicas”, no alto da tela.",
  avanca: "clique",
  pularSe: () => useUiStore.getState().view === "settings",
};

const conferenciaAberta = () => useEnrichStore.getState().overlayOpen;

const passosDeAchar: Passo[] = [
  {
    alvo: "busca",
    texto: "Clique aqui e escreva um pedaço da letra, o nome da música ou quem canta. Uma palavra já basta.",
    avanca: "quando",
    quando: () => useLibraryStore.getState().query.trim().length >= 2,
    antes: naBiblioteca,
    pularSe: semPasta,
  },
  {
    alvo: "lista-de-musicas",
    texto: "Aqui aparecem as músicas encontradas. Para ver todas de novo, é só apagar o que você escreveu.",
    avanca: "botao",
    pularSe: semPasta,
  },
];

const passosDeTocar: Passo[] = [
  {
    alvo: "tocar",
    texto: "Clique no botão verde para tocar a música.",
    avanca: "clique",
    antes: naBiblioteca,
    pularSe: semPasta,
  },
  {
    alvo: "player",
    texto: "Aqui embaixo você pausa, volta, passa para a próxima música e muda o volume.",
    avanca: "botao",
    pularSe: semPasta,
  },
];

export const GUIAS: Record<GuiaId, Guia> = {
  achar: {
    pergunta: "Como eu acho uma música?",
    passos: passosDeAchar,
    impedimento: semMusicas,
    fim: "Pronto! Sempre que quiser achar uma música, é só escrever no campo lá do alto.",
  },
  tocar: {
    pergunta: "Como eu toco uma música?",
    passos: [
      ...passosDeTocar,
      {
        alvo: "mostrar-detalhes",
        texto: "Clique aqui para ver a letra.",
        avanca: "clique",
        pularSe: () => visivel("detalhes"),
      },
      { alvo: "detalhes", texto: "A letra da música aparece aqui.", avanca: "botao" },
    ],
    impedimento: semMusicas,
    fim: "Pronto! Para tocar outra, é só clicar no botão verde dela.",
  },
  "letra-maior": {
    pergunta: "Como eu deixo a letra maior?",
    passos: [
      {
        alvo: "tamanho-da-letra",
        texto: "Clique num destes “A”. Quanto maior o A, maior fica tudo na tela.",
        avanca: "quando",
        quando: (inicio) => useUiStore.getState().zoomLevel !== inicio.zoom,
      },
      {
        alvo: "tamanho-da-letra",
        texto: "Viu? Para voltar ao normal, clique no A menor, o primeiro.",
        avanca: "botao",
      },
    ],
    fim: "Pronto! O app guarda o tamanho que você escolheu.",
  },
  "criar-lista": {
    pergunta: "Como eu crio uma lista de músicas?",
    passos: [
      {
        alvo: "listas-e-pastas",
        texto: "Clique aqui para abrir as suas listas.",
        avanca: "clique",
        pularSe: () => visivel("nova-lista"),
        antes: naBiblioteca,
      },
      { alvo: "nova-lista", texto: "Clique em “Nova lista”.", avanca: "clique" },
      {
        alvo: "dialogo-nova-lista",
        texto: "Escreva o nome da lista, por exemplo “Sessão de sábado”, e clique em “Criar”.",
        avanca: "quando",
        quando: (inicio) => usePlaylistStore.getState().playlists.length > inicio.listas,
      },
    ],
    fim: "Pronto! A lista nova está do lado esquerdo. Para pôr músicas nela, use “Pôr numa lista” ao lado de cada música.",
  },
  "por-na-lista": {
    pergunta: "Como eu ponho uma música numa lista?",
    passos: [
      {
        alvo: "por-na-lista",
        texto: "Clique em “Pôr numa lista” ao lado da música que você quer.",
        avanca: "clique",
        antes: naBiblioteca,
      },
      {
        alvo: "menu-de-listas",
        texto: "Agora escolha em qual lista ela vai.",
        avanca: "clique",
      },
    ],
    impedimento: semListas,
    fim: "Pronto! A música foi para a lista. Para ver a lista, clique no nome dela, do lado esquerdo.",
  },
  anotacao: {
    pergunta: "Como eu escrevo uma anotação?",
    passos: [
      ...abrirOsDetalhes,
      {
        alvo: "escrever-anotacao",
        texto: "Clique aqui para escrever uma anotação: o tom, quando cantar, quem puxa a música…",
        avanca: "clique",
      },
      {
        alvo: "editor-de-anotacao",
        texto: "Escreva o que quiser e clique em “Salvar”.",
        avanca: "quando",
        quando: () => !visivel("editor-de-anotacao"),
      },
    ],
    impedimento: semMusicas,
    fim: "Pronto! A anotação fica guardada na própria música, e a busca também a encontra.",
  },
  corrigir: {
    pergunta: "Como eu corrijo o nome ou a letra de uma música?",
    passos: [
      ...abrirOsDetalhes,
      { alvo: "editar", texto: "Clique em “Editar”.", avanca: "clique" },
      {
        alvo: "formulario-de-edicao",
        texto: "Corrija o nome, quem canta ou a letra, e clique em “Salvar no arquivo”. Nada muda até você salvar.",
        avanca: "quando",
        quando: () => !visivel("formulario-de-edicao"),
      },
    ],
    impedimento: semMusicas,
    fim: "Pronto! Se mudou de ideia no meio, “Cancelar” desfaz tudo.",
  },
  completar: {
    pergunta: "Como eu completo nome, cantor e letra das músicas?",
    passos: [
      irParaOrganizar,
      {
        alvo: "pasta-e-tempo",
        texto:
          "Primeiro escolha o que vai ser completado: “Toda a biblioteca” ou só uma pasta. Logo embaixo, o app diz quanto tempo vai levar.",
        avanca: "botao",
      },
      {
        alvo: "completar",
        texto:
          "Dica: na primeira vez, escolha uma pasta pequena, para ver como funciona. Depois, clique em “Completar agora”. Dá para continuar ouvindo música enquanto o app trabalha.",
        avanca: "botao",
      },
    ],
    impedimento: semMusicas,
    fim: "Pronto! O que estiver vazio é preenchido sozinho. O que trocaria algo já escrito espera você conferir, num cartão amarelo aqui mesmo, em “Organizar minhas músicas”.",
  },
  "escrever-letras": {
    pergunta: "Como eu escrevo as letras ouvindo a música?",
    passos: [
      irParaOrganizar,
      {
        alvo: "cartao-ouvir",
        texto:
          "Isto é para as músicas que nenhum site conhece, como as gravações do grupo: o computador ouve a música e escreve a letra. Demora, e o tempo aparece aqui.",
        avanca: "botao",
      },
      {
        alvo: "pasta-e-tempo",
        texto: "A pasta escolhida aqui vale também para escrever as letras: escolha uma pasta ou “Toda a biblioteca”.",
        avanca: "botao",
      },
      {
        alvo: "baixar-programa",
        texto:
          "Na primeira vez, é preciso baixar o programa que ouve as músicas. Clique em “Baixar” aqui e no “Baixar” de “Entender o que é cantado”, logo abaixo. Isso acontece uma vez só.",
        avanca: "botao",
        pularSe: () => visivel("comecar-transcricao") || !visivel("baixar-programa"),
      },
      {
        alvo: "comecar-transcricao",
        texto:
          "Quando quiser, clique em “Começar agora”. Dá para continuar usando o computador. No fim, você confere cada letra antes de ela ir para a música.",
        avanca: "botao",
        pularSe: () => !visivel("comecar-transcricao"),
      },
    ],
    impedimento: semMusicas,
    fim: "Pronto! Se precisar parar no meio, as letras já escritas ficam guardadas, esperando você conferir.",
  },
  conferir: {
    pergunta: "Como eu confiro as sugestões?",
    passos: [
      { ...irParaOrganizar, pularSe: () => conferenciaAberta() || useUiStore.getState().view === "settings" },
      {
        alvo: "conferir",
        texto: "Clique aqui para conferir.",
        avanca: "clique",
        pularSe: conferenciaAberta,
        semAlvo:
          "Agora não há nada esperando você conferir. Quando houver, aparece um cartão amarelo aqui, em “Organizar minhas músicas”, com o botão “Conferir agora”.",
      },
      {
        alvo: "comparacao",
        texto: "À esquerda está a música como é hoje; à direita, como ela ficaria.",
        avanca: "botao",
      },
      {
        alvo: "ouvir-sugestao",
        texto: "Na dúvida, clique em “Ouvir esta música” para conferir de ouvido.",
        avanca: "botao",
      },
      {
        alvo: "decisao",
        texto:
          "“Usar o novo” grava a sugestão na música. “Manter como está” deixa como estava. “Decidir depois” pula esta e mostra a próxima.",
        avanca: "botao",
      },
    ],
    impedimento: semMusicas,
    fim: "Pronto! Pode parar quando quiser: o que ficar para depois continua esperando.",
  },
  instrumental: {
    pergunta: "Como eu marco uma música como instrumental (sem letra)?",
    passos: [
      ...abrirOsDetalhes,
      { alvo: "editar", texto: "Clique em “Editar”.", avanca: "clique" },
      {
        alvo: "formulario-de-edicao",
        texto:
          "Lá embaixo, marque “Esta música é instrumental” e clique em “Salvar no arquivo”. Assim o app para de procurar letra para ela.",
        avanca: "quando",
        quando: () => !visivel("formulario-de-edicao"),
      },
    ],
    impedimento: semMusicas,
    fim: "Pronto! Para desfazer, é só desmarcar a mesma caixa.",
  },
  tema: {
    pergunta: "Como eu acho as músicas de um tema?",
    passos: [
      {
        alvo: "tema-chip",
        texto: "Clique num tema, como este. Os temas são as palavrinhas verdes ao lado do nome das músicas.",
        avanca: "clique",
        antes: naBiblioteca,
      },
      {
        alvo: "lista-de-musicas",
        texto: "Agora aparecem as músicas desse tema. Para ver todas de novo, apague o que está escrito na busca.",
        avanca: "botao",
      },
    ],
    impedimento: () =>
      semMusicas() ??
      (useLibraryStore.getState().allSongs.some((m) => m.temas)
        ? null
        : "Nenhuma música tem tema ainda. Os temas aparecem quando a letra é completada, ou quando você os escreve em “Editar”."),
    fim: "Pronto! Também dá para escrever o tema direto na busca.",
  },
  "adicionar-pasta": {
    pergunta: "Como eu ponho outra pasta de músicas no app?",
    passos: [
      irParaOrganizar,
      {
        alvo: "adicionar-pasta",
        texto: "Clique em “Adicionar pasta” e escolha a pasta no computador. O app só lê as músicas: não muda nada nelas.",
        avanca: "clique",
      },
    ],
    fim: "Pronto! As músicas da pasta nova aparecem em “Todas as músicas”, e a pasta, do lado esquerdo.",
  },
  "musicas-novas": {
    pergunta: "Copiei músicas novas para a pasta. Como elas aparecem?",
    passos: [
      irParaOrganizar,
      {
        alvo: "procurar-novas",
        texto: "Clique em “Procurar músicas novas”. O app também procura sozinho toda vez que é aberto.",
        avanca: "clique",
      },
    ],
    impedimento: semMusicas,
    fim: "Pronto! As músicas novas já aparecem em “Todas as músicas”.",
  },
  "consertar-arquivo": {
    pergunta: "Uma música diz que “não aceita gravação”. E agora?",
    passos: [
      irParaOrganizar,
      {
        alvo: "consertar",
        texto:
          "Aqui aparecem os arquivos que têm nome de MP3, mas por dentro são de outro tipo. “Consertar” transforma cada um num MP3 de verdade; o original fica guardado e dá para voltar atrás.",
        avanca: "botao",
        semAlvo:
          "Agora nenhum arquivo precisa de conserto. Se uma música mostrar o aviso “Este arquivo não aceita gravação”, abra os detalhes dela e clique em “Consertar o arquivo”.",
      },
    ],
    fim: "Pronto! Também dá para consertar uma música só: nos detalhes dela, clique em “Consertar o arquivo”.",
  },
  atualizar: {
    pergunta: "Como eu atualizo o app?",
    passos: [
      irParaOrganizar,
      {
        alvo: "verificar-atualizacoes",
        texto:
          "Clique em “Verificar atualizações”. Se houver versão nova, aparece “Reiniciar agora”: clique nele, e o app abre de novo, já atualizado.",
        avanca: "botao",
        semAlvo: "O app procura atualização sozinho quando é aberto, e avisa quando há uma nova: é só clicar em “Reiniciar agora”.",
      },
    ],
    fim: "Pronto! O app também procura atualização sozinho quando é aberto, e avisa quando há uma nova.",
  },
  "tela-escura": {
    pergunta: "Como eu deixo a tela clara ou escura?",
    passos: [
      irParaOrganizar,
      { alvo: "tema-da-tela", texto: "Escolha “Claro”, “Escuro” ou “Igual ao computador”.", avanca: "clique" },
    ],
    fim: "Pronto! O app guarda a sua escolha.",
  },
  "ver-letra": {
    pergunta: "Como eu vejo a letra de uma música?",
    passos: [
      ...abrirOsDetalhes,
      {
        alvo: "detalhes",
        texto: "A letra aparece aqui, do lado direito. Se for comprida, role para baixo com o mouse.",
        avanca: "botao",
      },
      {
        alvo: "aa",
        texto: "Para deixar só a letra maior, clique em “Aa”. Cada clique muda o tamanho.",
        avanca: "botao",
      },
    ],
    impedimento: semMusicas,
    fim: "Pronto! A letra da música que está tocando também aparece aí.",
  },
  "mudar-ordem": {
    pergunta: "Como eu mudo a ordem das músicas numa lista?",
    passos: [
      ...abrirUmaLista,
      {
        alvo: "ordem",
        texto:
          "Use as setas: ↑ sobe a música um lugar, e ↓ desce um lugar. Também dá para arrastar a música com o mouse e soltar no lugar novo.",
        avanca: "botao",
      },
    ],
    impedimento: semListas,
    fim: "Pronto! A ordem fica guardada, e a lista toca nessa ordem.",
  },
  "tocar-lista": {
    pergunta: "Como eu toco uma lista inteira?",
    passos: [
      ...abrirUmaLista,
      { alvo: "tocar-lista", texto: "Clique aqui para tocar a lista do começo ao fim.", avanca: "clique" },
    ],
    impedimento: semListas,
    fim: "Pronto! Quando uma música acaba, a próxima da lista começa sozinha.",
  },
  "tirar-da-lista": {
    pergunta: "Como eu tiro uma música de uma lista?",
    passos: [
      ...abrirUmaLista,
      {
        alvo: "tirar",
        texto:
          "Clique em “Tirar” ao lado da música. Ela sai só da lista: o arquivo continua no computador e na biblioteca.",
        avanca: "botao",
      },
    ],
    impedimento: semListas,
    fim: "Pronto! Se tirar por engano, é só pôr de novo com “Pôr numa lista”.",
  },
  pasta: {
    pergunta: "Como eu vejo só as músicas de uma pasta?",
    passos: [
      {
        alvo: "listas-e-pastas",
        texto: "Clique aqui para abrir as suas pastas.",
        avanca: "clique",
        pularSe: () => visivel("pasta"),
        antes: naBiblioteca,
      },
      { alvo: "pasta", texto: "Clique no nome de uma pasta.", avanca: "clique" },
      {
        alvo: "lista-de-musicas",
        texto: "Agora só aparecem as músicas dessa pasta. Para ver todas de novo, clique em “Todas as músicas”.",
        avanca: "botao",
      },
    ],
    impedimento: semMusicas,
    fim: "Pronto! As pastas do app são as mesmas do seu computador.",
  },
  "primeiros-passos": {
    pergunta: "Primeiros passos",
    passos: [
      ...passosDeAchar,
      ...passosDeTocar,
      {
        alvo: "como-faco",
        texto: "Esqueceu como faz alguma coisa? Clique em “Como faço?” a qualquer hora, que eu te mostro de novo.",
        avanca: "botao",
      },
    ],
    fim: "Pronto! Boa música.",
  },
};

/** As perguntas da lista do "Como faço?", na ordem da tela. */
export const GRUPOS_DE_PERGUNTAS: { titulo: string; perguntas: GuiaId[] }[] = [
  { titulo: "Ouvir", perguntas: ["achar", "tocar", "ver-letra", "letra-maior", "pasta", "tema"] },
  { titulo: "Listas de músicas", perguntas: ["criar-lista", "por-na-lista", "mudar-ordem", "tocar-lista", "tirar-da-lista"] },
  {
    titulo: "Nome, cantor e letra",
    perguntas: ["completar", "escrever-letras", "conferir", "corrigir", "instrumental", "anotacao"],
  },
  { titulo: "Pastas e o app", perguntas: ["adicionar-pasta", "musicas-novas", "consertar-arquivo", "atualizar", "tela-escura"] },
];

/** Todas as perguntas do "Como faço?", na ordem da tela. */
export const PERGUNTAS: GuiaId[] = GRUPOS_DE_PERGUNTAS.flatMap((g) => g.perguntas);

interface GuiaState {
  ativo: GuiaId | null;
  passo: number;
  inicio: Inicio;
  /** "fim" mostra a frase de conclusão; "impedido" a de impedimento */
  estado: "andando" | "fim" | "impedido";
  impedimento: string | null;
  iniciar: (id: GuiaId) => void;
  avancar: () => void;
  parar: () => void;
}

function retrato(): Inicio {
  const listas = usePlaylistStore.getState().playlists;
  return {
    listas: listas.length,
    musicasNasListas: listas.reduce((n, p) => n + p.song_count, 0),
    zoom: useUiStore.getState().zoomLevel,
  };
}

/** Do passo `de` em diante, o primeiro que não deve ser pulado (ou o fim). */
function proximoValido(guia: Guia, de: number): number {
  let i = de;
  while (i < guia.passos.length && guia.passos[i].pularSe?.()) i++;
  return i;
}

export const useGuiaStore = create<GuiaState>((set, get) => ({
  ativo: null,
  passo: 0,
  inicio: { listas: 0, musicasNasListas: 0, zoom: 0 },
  estado: "andando",
  impedimento: null,
  iniciar: (id) => {
    const guia = GUIAS[id];
    const impedimento = guia.impedimento?.() ?? null;
    if (impedimento) {
      set({ ativo: id, passo: 0, estado: "impedido", impedimento });
      return;
    }
    const passo = proximoValido(guia, 0);
    guia.passos[passo]?.antes?.();
    set({
      ativo: id,
      passo,
      inicio: retrato(),
      estado: passo >= guia.passos.length ? "fim" : "andando",
      impedimento: null,
    });
  },
  avancar: () => {
    const { ativo, passo } = get();
    if (!ativo) return;
    const guia = GUIAS[ativo];
    const seguinte = proximoValido(guia, passo + 1);
    if (seguinte >= guia.passos.length) {
      set({ estado: "fim" });
      return;
    }
    guia.passos[seguinte].antes?.();
    set({ passo: seguinte });
  },
  parar: () => set({ ativo: null, passo: 0, estado: "andando", impedimento: null }),
}));
