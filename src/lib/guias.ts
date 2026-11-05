import { create } from "zustand";
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
}

export interface Guia {
  pergunta: string;
  passos: Passo[];
  /** frase de quando o guia não tem como começar (sem músicas, sem listas) */
  impedimento?: () => string | null;
  fim: string;
}

/** O primeiro elemento VISÍVEL com aquela marca. */
export function elementoDoGuia(alvo: string): HTMLElement | null {
  const todos = document.querySelectorAll<HTMLElement>(`[data-guia="${alvo}"]`);
  for (const el of todos) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight) return el;
  }
  return null;
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
    impedimento: () =>
      semMusicas() ??
      (usePlaylistStore.getState().playlists.length === 0
        ? "Você ainda não tem nenhuma lista. Primeiro crie uma: em “Como faço?”, escolha “Como eu crio uma lista de músicas?”."
        : null),
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
    pergunta: "Como eu completo as letras que faltam?",
    passos: [
      {
        alvo: "organizar",
        texto: "Clique em “Organizar minhas músicas”.",
        avanca: "clique",
        pularSe: () => useUiStore.getState().view === "settings",
      },
      {
        alvo: "completar",
        texto:
          "Quando quiser, clique neste botão. O app procura nome, cantor e letra na internet e depois mostra tudo para você conferir. Nada é gravado sem você aprovar.",
        avanca: "botao",
      },
    ],
    impedimento: semMusicas,
    fim: "Pronto! Pode levar um tempo; dá para continuar ouvindo música enquanto isso.",
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
export const PERGUNTAS: GuiaId[] = [
  "achar",
  "tocar",
  "letra-maior",
  "criar-lista",
  "por-na-lista",
  "anotacao",
  "corrigir",
  "completar",
];

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
