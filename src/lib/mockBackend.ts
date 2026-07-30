import type {
  AcessorioDownload,
  AcessorioInfo,
  AcessorioProgresso,
  Backend,
  Contagem,
  EnrichApply,
  EnrichApplyResult,
  EnrichProgress,
  EnrichProposal,
  EnrichScanResult,
  TranscricaoProgresso,
  TranscricaoResultado,
} from "./api";
import { isUnderFolder } from "./folderTree";
import { HIGHLIGHT_END, HIGHLIGHT_START } from "./highlight";
import type {
  Folder,
  Playlist,
  PlaylistItem,
  ScanProgress,
  ScanResult,
  SearchResult,
  Song,
} from "./types";
import {
  FONTE_TRANSCRICAO,
  ORIGEM_LYRICS_OVH,
  ORIGEM_TRANSCRICAO,
} from "./types";

/**
 * Backend em memória com a mesma semântica do backend Rust (src-tauri),
 * usado quando o app roda fora do Tauri: dev no navegador e E2E Playwright.
 *
 * Estado persistido em localStorage ("cancioneiro-mock-db") para que os
 * testes E2E de persistência (reload da página = "restart" do app) passem.
 */
export interface MockBackend extends Backend {
  /** Popula N músicas sintéticas ("Música 1"..N) para testes de volume. */
  _seedSongs(count: number): void;
  /** Simula a deleção do arquivo no disco (fileExists → false; scan remove do índice). */
  _removeFileFromDisk(filePath: string): void;
  /**
   * Simula o que a curadoria (`tools/curadoria.py transcrever`) deixa no MP3:
   * TXXX:LETRA_ORIGEM = "transcricao". Compõe com qualquer seed — é assim que
   * testes e E2E produzem uma música com letra transcrita.
   */
  _markAsTranscribed(filePath: string): void;
  /**
   * Simula o que a curadoria deixa no MP3 de uma música sem voz:
   * TXXX:INSTRUMENTAL = "1" (V8/F17). Compõe com qualquer seed — é assim que
   * testes e E2E produzem uma música instrumental.
   */
  _markAsInstrumental(filePath: string): void;
  /**
   * Título vazio no banco — o estado que só a indexação de um MP3 sem TIT2
   * produz (o `writeTags` o recusa, e é bom que recuse). Existe para provar que
   * o ECO da etapa 5 não devolve string vazia: o `apply` grava o título como
   * veio, e vazio APAGARIA a etiqueta.
   */
  _forcarTituloVazio(filePath: string): void;
  /** Zera o estado em memória e a persistência. */
  _reset(): void;
  /** Valor devolvido pelo próximo pickFolder(). */
  _nextPickedFolder: string;
  /**
   * Simula falta de rede: o funil NUNCA rejeita — cada proposta vem com
   * error "sem conexão" e a linha fica desabilitada (V5, DECISIONS #47 —
   * mesma semântica do backend real).
   */
  _offline: boolean;
  /**
   * Atraso artificial POR MÚSICA na varredura F13 (0 = instantâneo). Só o E2E
   * usa: sem ele a varredura mockada termina no mesmo tick e não dá para ver a
   * barra de progresso nem o modo "segundo plano".
   */
  _enrichDelayMs: number;
  /**
   * Simula o `lyrics.ovh` fora do ar (V10). A falha é erro DESTA MÚSICA e a
   * etapa continua sendo tentada nas seguintes — o serviço cai com frequência,
   * e desligar a etapa no primeiro soluço era o defeito do QA A2 no `fpcalc`.
   */
  _lyricsOvhForaDoAr: boolean;
  /** Popula a pasta /acervo com subpastas 1/ e 2/ para o E2E da árvore (V4 F11). */
  _seedFolderTree(): void;
  /**
   * O acessório do SOM desta "máquina" (V9). `estado` é o cache de verdade —
   * ele persiste, como o arquivo sob o perfil do usuário: baixou uma vez, o
   * app não pergunta de novo nem depois de reiniciar. O resto são botões de
   * teste, e eles valem para QUALQUER download (atraso, erro, pedaços).
   *
   * V10 — o catálogo passou a ter três acessórios, e o estado de cada um vive
   * em `_estadoDoAcessorio`. Este atalho continua existindo porque o `fpcalc`
   * é citado por dezenas de testes e pelo E2E.
   */
  _acessorio: {
    /** false = não publicamos binário para esta plataforma → lista vazia. */
    publicado: boolean;
    estado: AcessorioInfo["estado"];
    /**
     * Desfecho do próximo download; null = instala normalmente. Além da soma
     * que não confere e da rede que caiu, as quatro falhas de ESCRITA que o
     * backend passou a nomear em pt-BR (QA M4).
     */
    erro: "soma" | "rede" | keyof typeof ERROS_DE_GRAVACAO | null;
    /** Atraso por pedaço (0 = instantâneo). Só o E2E precisa ver a barra. */
    atrasoMs: number;
    /** Em quantos pedaços o download é emitido. */
    pedacos: number;
    /** false = servidor sem Content-Length → `total: null` nos eventos. */
    anunciaTotal: boolean;
  };
  /**
   * Ensina ao "som" o que ele responde para um arquivo (V9): é o AcoustID do
   * mock. Sem isto o reconhecimento não devolve nada — que é o desfecho da
   * maioria das gravações reais.
   */
  _ensinarSom(
    filePath: string,
    diz: { titulo: string; artista: string; confianca: "alta" | "media" },
  ): void;
  /**
   * Ensina uma FALHA do `fpcalc` para um arquivo (QA A2). A mensagem decide o
   * alcance, como no Rust: `ERRO_FPCALC` é defeito deste arquivo e a fila
   * segue; `ERRO_FPCALC_NAO_EXECUTA` é veredito sobre a máquina e desliga a
   * etapa 2 pelo resto da varredura — a partir daí cada candidata que teria
   * sido perguntada entra em `sem_perguntar_ao_som`.
   */
  _ensinarFalhaDoSom(filePath: string, mensagem: string): void;
  /**
   * O estado do cache de UM acessório (V10). É o que `_acessorio.estado` faz
   * pelo `fpcalc`, para os outros dois — sem isso não há como montar a máquina
   * que tem o transcritor e não tem o modelo, que é justamente o estado em que
   * `transcricao_disponivel` precisa continuar `false`.
   */
  _estadoDoAcessorio(nome: string, estado: AcessorioInfo["estado"]): void;
  /**
   * Ensina ao "whisper" o que ele devolve para um arquivo (V10) — é o motor da
   * etapa 5 do mock. Sem isto a transcrição volta vazia, que é o desfecho de
   * instrumental.
   */
  _ensinarTranscricao(filePath: string, saida: SaidaDaTranscricao): void;
}

/**
 * O que o motor da etapa 5 devolve para um arquivo, no mock. São os três
 * desfechos do `transcricao::Desfecho` que chegam à tela:
 *
 * - `letra` + `refrao`: transcreveu;
 * - `instrumental`: ouviu o áudio inteiro e não achou voz — o texto é o MOTIVO
 *   medido, que vira o `aviso` da proposta;
 * - `erro`: falhou nesta música.
 */
export type SaidaDaTranscricao =
  | { letra: string; refrao: string | null }
  | { instrumental: string }
  | { erro: string };

const STORAGE_KEY = "cancioneiro-mock-db";

interface SongRecord extends Song {
  lyrics: string | null;
}

interface PlaylistRecord {
  id: number;
  name: string;
}

interface PlaylistItemRecord {
  id: number;
  playlist_id: number;
  position: number;
  song_id: number;
}

/** O que o "som" responde sobre um arquivo (o AcoustID do mock). */
interface SomDiz {
  titulo: string;
  artista: string;
  confianca: "alta" | "media";
}

interface DbState {
  folders: Folder[];
  songs: SongRecord[];
  playlists: PlaylistRecord[];
  playlistItems: PlaylistItemRecord[];
  deletedFiles: string[];
  nextFolderId: number;
  nextSongId: number;
  nextPlaylistId: number;
  nextItemId: number;
  /**
   * Cache dos acessórios (V9; V10 passou a ser um por NOME). Persistido junto
   * do resto porque é isso que ele é no produto: arquivos sob o perfil do
   * usuário, que sobrevivem ao reinício — "baixou uma vez, não pergunta de
   * novo".
   */
  acessoriosEstado: Record<string, AcessorioInfo["estado"]>;
  /** O que a etapa 5 devolve por arquivo. Permanente, como o próprio áudio. */
  transcricoes: Record<string, SaidaDaTranscricao>;
  /**
   * QA A1 — o que esta máquina já mediu transcrevendo: segundos de áudio
   * ouvidos e segundos de relógio gastos. Persistido, como a tabela de medição
   * do Rust: a autocorreção da estimativa não pode recomeçar do zero a cada
   * abertura do aplicativo.
   */
  medicaoDaTranscricao?: { audio: number; relogio: number } | null;
  /** O que o som responde, por arquivo. Permanente, como o próprio áudio. */
  somDiz: Record<string, SomDiz>;
  /**
   * Falha do `fpcalc` por arquivo (QA A2). A mensagem é a MESMA do Rust, e
   * qual delas é decide o alcance: `ERRO_FPCALC` é defeito deste arquivo e o
   * funil segue; `ERRO_FPCALC_NAO_EXECUTA` é veredito sobre a MÁQUINA e
   * desliga a etapa pelo resto da varredura.
   */
  somFalha: Record<string, string>;
}

function freshState(): DbState {
  return {
    folders: [],
    songs: [],
    playlists: [],
    playlistItems: [],
    deletedFiles: [],
    nextFolderId: 1,
    nextSongId: 1,
    nextPlaylistId: 1,
    nextItemId: 1,
    acessoriosEstado: {},
    transcricoes: {},
    medicaoDaTranscricao: null,
    somDiz: {},
    somFalha: {},
  };
}

function loadState(): DbState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return freshState();
    const parsed = JSON.parse(raw) as Partial<DbState>;
    return { ...freshState(), ...parsed };
  } catch {
    return freshState();
  }
}

/** Letra EXATA da fixture com_letra.mp3 (mesma do backend Rust de testes). */
const FIXTURE_LYRICS =
  "Quando o sol amanhecer\nMeu coração vai cantar\nA esperança vai nascer\nE a alegria vai chegar\n\nNão há noite sem estrela\nNão há dor que não se cura";

const FIXTURE_BASENAMES = ["com_letra.mp3", "sem_letra.mp3", "sem_tags.mp3"];

/** Remove diacríticos (NFD) e baixa a caixa — espelha remove_diacritics do FTS5. */
function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/** Tokens alfanuméricos normalizados (split em não-alfanuméricos). */
function tokenize(text: string): string[] {
  return normalize(text)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Verifica se todos os tokens da query casam com a lista de palavras:
 * tokens intermediários casam palavra inteira; o último casa como prefixo
 * (comportamento de "busca enquanto digita" do FTS5 com `token*`).
 */
function matchesAll(words: string[], tokens: string[]): boolean {
  return tokens.every((token, i) => {
    const isLast = i === tokens.length - 1;
    return isLast
      ? words.some((w) => w.startsWith(token))
      : words.includes(token);
  });
}

/**
 * Normalização de temas do writer Rust/Python: trim, minúsculas, dedup e
 * ordem alfabética sem acento. Lista vazia → null (remove o TXXX:TEMAS).
 */
function normalizeTemas(raw: string | null): string | null {
  if (!raw) return null;
  const seen = new Set<string>();
  const list: string[] = [];
  for (const part of raw.split(";")) {
    const tema = part.trim().toLowerCase();
    if (!tema || seen.has(tema)) continue;
    seen.add(tema);
    list.push(tema);
  }
  if (list.length === 0) return null;
  list.sort((a, b) => normalize(a).localeCompare(normalize(b)));
  return list.join("; ");
}

function wordMatchesAnyToken(word: string, tokens: string[]): boolean {
  const norm = tokenize(word).join("");
  if (!norm) return false;
  return tokens.some((token, i) =>
    i === tokens.length - 1 ? norm.startsWith(token) : norm === token,
  );
}

/**
 * Trecho da letra (~12 palavras) em torno da primeira ocorrência de um token,
 * com cada palavra que casa envolta em HIGHLIGHT_START/HIGHLIGHT_END
 * (mesmos marcadores do comando `search` do Rust — ver src/lib/highlight.ts).
 */
function buildSnippet(lyrics: string, tokens: string[]): string | null {
  const words = lyrics.split(/\s+/).filter(Boolean);
  const firstIdx = words.findIndex((w) => wordMatchesAnyToken(w, tokens));
  if (firstIdx === -1) return null;

  const WINDOW = 12;
  const start = Math.max(0, firstIdx - Math.floor(WINDOW / 2) + 1);
  const end = Math.min(words.length, start + WINDOW);

  const parts = words.slice(start, end).map((w) =>
    wordMatchesAnyToken(w, tokens) ? `${HIGHLIGHT_START}${w}${HIGHLIGHT_END}` : w,
  );
  let snippet = parts.join(" ");
  if (start > 0) snippet = `…${snippet}`;
  if (end < words.length) snippet = `${snippet}…`;
  return snippet;
}

function toSong(record: SongRecord): Song {
  return {
    id: record.id,
    file_path: record.file_path,
    folder_id: record.folder_id,
    title: record.title,
    artist: record.artist,
    album: record.album,
    duration_seconds: record.duration_seconds,
    has_lyrics: record.has_lyrics,
    available: record.available,
    temas: record.temas ?? null,
    letra_origem: record.letra_origem ?? null,
    instrumental: record.instrumental === true,
  };
}

const SEED_ARTISTS = [
  "Artista do Sertão",
  "Banda da Estrada",
  "Dupla Coração",
  "Trio Nordestino",
  "Cantores da Lua",
];

const SEED_WORDS = [
  "saudade", "estrada", "viola", "lua", "sertão", "coração", "amor", "chuva",
  "flor", "campo", "rio", "noite", "sol", "vento", "canção", "esperança",
  "alegria", "festa", "beijo", "caminho", "cidade", "praia", "mar", "céu",
  "estrela", "sonho", "vida", "tempo", "distância", "abraço", "madrugada",
  "violão", "poeira", "boiada", "fogueira", "rancho", "janela", "retrato",
];

function seedLyrics(songIndex: number): string {
  const lines: string[] = [];
  for (let line = 0; line < 10; line++) {
    const words: string[] = [];
    for (let w = 0; w < 5; w++) {
      words.push(SEED_WORDS[(songIndex * 7 + line * 3 + w) % SEED_WORDS.length]);
    }
    lines.push(words.join(" "));
  }
  return lines.join("\n");
}

/** Nome-base do arquivo (sem diretório) — o que o progresso F13 exibe. */
function nomeArquivo(song: { file_path: string }): string {
  return song.file_path.split(/[\\/]/).pop() ?? "";
}

/**
 * Nome do arquivo que ENTRA NA BUSCA (V8) — espelha songs.arquivo do backend
 * (indexer::arquivo_para_busca): nome-base SEM a extensão, e vazio quando ele
 * é o próprio título (música sem tag), para o mesmo texto não pesar duas vezes
 * no índice. O snippet continua saindo só da letra, aqui como lá.
 */
function arquivoParaBusca(song: SongRecord): string {
  const stem = nomeArquivo(song).replace(/\.[^.]+$/, "");
  return normalize(stem) === normalize(song.title.trim()) ? "" : stem;
}

/**
 * Proposta que não pede decisão nenhuma: proposto idêntico ao atual e sem
 * letra para acrescentar. O teste real (acervo de 94 músicas) mostrou linhas
 * "atual → proposto" iguais, sem nada a decidir — o backend Rust as descarta
 * na origem e o mock espelha. Propostas COM letra ou COM erro continuam: a
 * letra é o ganho e a linha com erro precisa ficar visível (desabilitada).
 */
/**
 * Etapas do funil (V8/F18) como o backend as manda para a tela: pt-BR, prontas
 * para exibir. O evento inicial (done=0) sai com a etapa de preparo, antes de
 * qualquer consulta.
 */
const ETAPA_PREPARANDO = "preparando";
// Os nomes das etapas, com as palavras do Rust (`enrich::ETAPA_*`): eles saem
// CRUS na tela e entram na lista que a contagem devolve.
const ETAPA_NOME_ARQUIVO = "lendo etiquetas e nome do arquivo";
const ETAPA_IMPRESSAO_DIGITAL = "reconhecendo pelo som";
const ETAPA_LRCLIB = "procurando no LRCLIB";
const ETAPA_LYRICS_OVH = "procurando no lyrics.ovh";
const FONTE_ARQUIVO = "nome do arquivo";
/** Etapa 2 (V9): a identidade veio do SOM, não de etiqueta nem de base de letra. */
const FONTE_IMPRESSAO_DIGITAL = "reconhecimento pelo som";
const FONTE_LRCLIB = "LRCLIB";
/**
 * Etapa 4 (V10): o `lyrics.ovh`, a fonte de letra SEM CHAVE. Tomou o lugar do
 * Vagalume, que saiu do produto (DECISIONS #110) — API descontinuada, chave
 * que ninguém tem, e código que nunca rodou contra o serviço real.
 */
const FONTE_LYRICS_OVH = "lyrics.ovh";
/** Fonte das linhas que existem para INFORMAR a falha (enrich::FONTE_ERRO). */
const FONTE_ERRO = "erro";

/**
 * Teto de confiança da letra achada com um nome que veio do SOM
 * (`enrich::TETO_COM_IDENTIDADE_DO_SOM`): o AcoustID casou por duração e o
 * LRCLIB confirmou pela MESMA duração — é a mesma conta feita duas vezes, não
 * duas provas. ALTA aqui chegaria pré-marcada sem prova independente.
 */
const TETO_COM_IDENTIDADE_DO_SOM = "media" as const;

// ---------------------------------------------------------------------------
// Acessórios (V9) — o catálogo desta "máquina" e as frases do backend
// ---------------------------------------------------------------------------

/**
 * Uma entrada real do catálogo do Rust (`acessorios::CATALOGO`, linux-x86_64):
 * nome, arquivo, tamanho e origem batem com o que o app publica de verdade.
 */
const URL_BASE =
  "https://github.com/gabrielnader/cancioneiro/releases/download/acessorios-v1";

const ACESSORIO_FPCALC = {
  nome: "fpcalc" as const,
  para_que_serve: "reconhecer a música pelo som",
  arquivo: "fpcalc-linux-x86_64",
  tamanho_bytes: 5_538_312,
  executavel: true,
  origem: `${URL_BASE}/fpcalc-linux-x86_64`,
};

/**
 * Os dois acessórios da etapa 5 (V10), com os valores do `acessorios::CATALOGO`
 * do Rust (linux-x86_64). São DUAS entradas para uma etapa só, e a separação é
 * deliberada: 2 MB e 181 MB têm conversas diferentes com quem vai clicar, e um
 * pode estar pronto sem o outro.
 */
const ACESSORIO_WHISPER = {
  nome: "whisper-cli" as const,
  para_que_serve: "escrever a letra ouvindo o áudio",
  arquivo: "whisper-cli-linux-x86_64",
  // tamanho REAL do binário publicado, como as demais entradas: o mock
  // desenha o número que a pessoa vê, e arredondar aqui fixava no E2E um
  // tamanho que a tela nunca mostraria.
  tamanho_bytes: 1_635_784,
  executavel: true,
  origem: `${URL_BASE}/whisper-cli-linux-x86_64`,
};

const ACESSORIO_MODELO = {
  nome: "modelo-de-transcricao" as const,
  para_que_serve:
    "entender o que é cantado — este é o rápido, e às vezes deixa trechos" +
    " de fora",
  arquivo: "ggml-small-q5_1.bin",
  // DADO, não programa: o mesmo arquivo serve as quatro máquinas, e ele não
  // recebe o bit de execução.
  tamanho_bytes: 190_085_487,
  executavel: false,
  origem: `${URL_BASE}/ggml-small-q5_1.bin`,
};

/**
 * O segundo modelo (V10.2): maior, melhor e MUITO mais lento. Existe porque a
 * medição no acervo real reprovou o pequeno — 37% de encontrabilidade contra
 * os 78% do motor anterior, com estrofes inteiras engolidas como "[música]".
 *
 * Os dois convivem por UMA rodada, até o acervo real dizer qual fica. O mock
 * precisa dos dois porque a regra que importa — o backend PREFERE o grande
 * quando ele está pronto — só é exercitável com os dois no catálogo, e
 * catálogo do mock menor que o do Rust foi como as três divergências
 * anteriores começaram (decisão 88).
 */
const ACESSORIO_MODELO_GRANDE = {
  nome: "modelo-de-transcricao-grande" as const,
  para_que_serve:
    "entender melhor o que é cantado — é bem mais lento, e o aplicativo usa" +
    " este quando ele está aqui",
  arquivo: "ggml-medium.bin",
  tamanho_bytes: 1_533_763_059,
  executavel: false,
  origem: `${URL_BASE}/ggml-medium.bin`,
};

/** O catálogo desta "máquina", na ordem em que a tela o mostra. */
const CATALOGO = [
  ACESSORIO_FPCALC,
  ACESSORIO_WHISPER,
  ACESSORIO_MODELO,
  ACESSORIO_MODELO_GRANDE,
];

/**
 * Banda de REFERÊNCIA do download, em bytes por segundo — espelha
 * `acessorios::BANDA_REFERENCIA_BYTES_S`.
 *
 * V10.4 — era 1 MB/s, e esse número anunciou 26 minutos em campo para um
 * download que levou menos de 3. Ver o comentário longo no Rust: numa
 * estimativa de DOWNLOAD o lado seguro não é o da DECISIONS #85, porque o
 * número é o portão de entrada do recurso, e não o relatório de um trabalho
 * já começado.
 */
const BANDA_REFERENCIA_BYTES_S = 3_000_000;

// ---------------------------------------------------------------------------
// O custo da varredura e da transcrição — ESPELHO do Rust, não uma segunda conta
// ---------------------------------------------------------------------------
//
// Estes números moram no `enrich.rs` e no `transcricao.rs`; aqui eles são
// cópia, como todo o resto deste arquivo. O mock É o backend quando o app roda
// fora do Tauri, e mock que discorda do backend certifica o contrato errado
// (DECISIONS #88). O que a V10 apagou foi a conta que vivia na TELA — essa,
// sim, era uma segunda implementação da mesma regra (DECISIONS #80).

/** Etapa 2, por música: 2 s medidos em campo (`SEGUNDOS_ETAPA_SOM`). */
const SEGUNDOS_ETAPA_SOM = 2;
/** Etapa 3, por música SEM LETRA: 7 s medidos (`SEGUNDOS_ETAPA_LRCLIB`). */
const SEGUNDOS_ETAPA_LRCLIB = 7;
/** Etapa 4, por música SEM LETRA: 2 s (`SEGUNDOS_ETAPA_LYRICS_OVH`). */
const SEGUNDOS_ETAPA_LYRICS_OVH = 2;

/**
 * Segundos de CPU por segundo de ÁUDIO enquanto esta máquina não transcreveu
 * nada — `transcricao::RAZAO_DE_REFERENCIA`. Um minuto de máquina por minuto
 * de música: os 0,25 do `tools/curadoria.py` são de OUTRO motor, e reusá-los
 * seria a DECISIONS #72 aplicada a uma estimativa.
 */
const RAZAO_DE_REFERENCIA = 1.0;

/**
 * Áudio (em segundos) que precisa ter sido transcrito antes de a medição valer
 * — porte do `transcricao::AUDIO_MINIMO_PARA_MEDIR`. Uma música só não é
 * amostra: a primeira faixa é justamente a que paga o custo de o motor subir.
 */
const AUDIO_MINIMO_PARA_MEDIR = 300;

const DURACAO_MINIMA_ESTIMADA = 30;
const DURACAO_MAXIMA_ESTIMADA = 900;
const DURACAO_TIPICA = 240;

/** Porte de `transcricao::segundos_para_transcrever`. */
function segundosParaTranscrever(duracoes: number[], razao: number): number {
  const audio = duracoes.reduce((soma, d) => {
    if (d <= 0) return soma + DURACAO_TIPICA;
    return soma + Math.min(Math.max(d, DURACAO_MINIMA_ESTIMADA), DURACAO_MAXIMA_ESTIMADA);
  }, 0);
  return Math.ceil(audio * Math.max(razao, 0));
}

// As frases são as do Rust, LETRA POR LETRA: elas chegam prontas na tela e a
// UI as mostra como vieram. Mock que inventa a própria mensagem certifica um
// contrato que não existe (DECISIONS #88).
const ERRO_SOMA_NAO_CONFERE =
  "o arquivo baixado não confere com o esperado — foi descartado, e esta etapa fica desligada";
const ERRO_DOWNLOAD_INTERROMPIDO =
  "o download foi interrompido antes do fim — nada foi instalado";
const ERRO_ACESSORIO_INDISPONIVEL =
  "este acessório ainda não está disponível nesta versão do aplicativo";
const ERRO_ACESSORIO_DESCONHECIDO = "não há este acessório para este computador";

/**
 * As falhas de ESCRITA do download (QA M4 do backend), com as palavras do
 * `acessorios.rs`. Seis pontos do módulo subiam `io::Error` pelo `?` e a
 * pessoa lia a frase do sistema operacional, em inglês, direto na tela — e
 * são justamente as falhas PROVÁVEIS num parque de máquinas que ninguém pode
 * olhar. Exportadas para que os testes provem que a tela as mostra COMO
 * VIERAM: reescrevê-las aqui criaria uma segunda versão da verdade.
 */
export const ERROS_DE_GRAVACAO = {
  disco:
    "não há espaço em disco para este download — libere espaço e tente de novo",
  permissao:
    "o computador não deixou gravar na pasta do aplicativo — se houver antivírus ou pasta " +
    "sincronizada com a nuvem, pause e tente de novo",
  emUso:
    "o acessório está em uso por outro programa — feche o aplicativo, abra de novo e tente",
  // V10.4 — o arquivo que SOME no meio (antivírus em quarentena, pasta
  // sincronizada com a nuvem, um segundo download do mesmo acessório) deixou
  // de ser acusado de falha de gravação: gravar funcionou, e alguém levou o
  // que foi gravado.
  sumiu:
    "o arquivo do download sumiu antes de terminar — em geral é o antivírus ou uma pasta " +
    "sincronizada com a nuvem levando o arquivo; pause os dois e tente de novo",
  // A frase de quando NÃO se sabe a causa. No backend ela ainda ganha o
  // CÓDIGO do sistema entre parênteses — um número, nunca o texto em inglês
  // (DECISIONS #121) —, porque sem suporte e sem telemetria o número é a
  // única coisa que separa a próxima investigação de outro palpite.
  gravacao:
    "não foi possível gravar o download neste computador — tente de novo; se repetir, pause o " +
    "antivírus e a sincronização com a nuvem",
} as const;

/**
 * Recusa do apply quando a gravação trocaria uma letra que já existe sem o
 * consentimento explícito da revisão (CRÍTICO-1). Texto idêntico ao do Rust:
 * ele aparece na linha, e é o único lugar onde a pessoa vai ler o que fazer.
 */
/**
 * A RESSALVA da etapa 4 — texto do `lyrics_ovh::AVISO_SEM_CONFERENCIA`, letra
 * por letra.
 *
 * Esta fonte **não devolve o nome da música**: se o serviço fizer casamento
 * aproximado por dentro, ele pode entregar a letra de "Ponto de Ogum" para um
 * pedido de "Ponto de Oxum" e o programa não tem como perceber. É a única
 * etapa do funil cujo casamento não é verificável, e o que o programa SABE tem
 * de chegar à tela: o teto MÉDIA tira a pré-marcação, mas só protege quem
 * saiba POR QUÊ (a medição de campo foi "eu nem li as sugestões em baixa").
 *
 * Exportado para que os testes provem que a tela a mostra COMO VEIO.
 */
export const AVISO_SEM_CONFERENCIA =
  "este site não diz a que música a letra pertence, então não deu para" +
  " conferir se ela é desta — vale ler antes de aplicar";

/** `lyrics.ovh` fora do ar — erro DESTA música, nunca da varredura. */
const ERRO_LYRICS_OVH_FORA_DO_AR =
  "o lyrics.ovh não respondeu — a busca continua nas outras músicas";

/**
 * As duas falhas do `fpcalc`, com as palavras do Rust
 * (`fingerprint::ERRO_FPCALC` e `ERRO_FPCALC_NAO_EXECUTA`). Exportadas porque
 * os testes e o E2E precisam ensiná-las ao mock, e porque a DIFERENÇA entre
 * elas é o achado A2: a primeira é defeito de UM arquivo (faixa curta,
 * gravação silenciosa — três das quatro fixtures do projeto falham assim com
 * o `fpcalc` de verdade) e a segunda é veredito sobre a máquina.
 */
export const ERRO_FPCALC = "não foi possível ler o som deste arquivo";
export const ERRO_FPCALC_NAO_EXECUTA =
  "o programa que reconhece o som não conseguiu ser executado neste computador";

const RECUSA_LETRA_EXISTENTE =
  'esta música já tem letra — marque "substituir a letra atual" para trocá-la';

/**
 * As recusas da etapa 5, com as palavras do Rust
 * (`enrich::AVISO_INSTRUMENTAL_NAO_TRANSCREVE`, `AVISO_JA_TEM_LETRA` e
 * `transcricao::ERRO_SEM_MODELO`). Elas existem porque a etapa 5 NÃO desfaz
 * trabalho humano: marca de instrumental e letra existente são escolha de
 * gente, e horas de CPU contra elas seriam desrespeito, não zelo.
 */
const AVISO_INSTRUMENTAL_NAO_TRANSCREVE =
  "esta música está marcada como instrumental — não há letra a escrever";
const AVISO_JA_TEM_LETRA =
  "esta música já tem letra — apague a letra atual no editor se quiser" +
  " escrevê-la de novo ouvindo o áudio";
const ERRO_SEM_MODELO =
  "o programa que escreve a letra, ou o modelo dele, não está instalado";

// ---------------------------------------------------------------------------
// Placeholders — porte do `is_placeholder` do Rust (que por sua vez porta o
// `eh_placeholder` do tools/curadoria.py). Tag placeholder vale VAZIO em todo
// ponto: não é palpite, não libera consulta a site de letra e NÃO marca a
// música como completa. Foi por não olhar isto que a contagem do app dava zero num CD
// ripado inteiro de "Faixa 01…12 / Artista Desconhecido".
// ---------------------------------------------------------------------------

const PLACEHOLDERS_EXATOS = new Set([
  "artist", "no artist", "unknown artist", "artista desconhecido",
  "artista desconhecida", "unknown", "desconhecido", "desconhecida",
  "no title", "sem titulo", "untitled", "unknown title", "titulo desconhecido",
]);

/**
 * Expressões que, em QUALQUER posição, denunciam tag de ripador — nenhum
 * artista ou título real as contém, então a busca por trecho é segura.
 * "artista desconheci" sem o final cobre o truncamento de campo do ID3 visto
 * no acervo real ("04 Faixa 4 Artista Desconheci").
 *
 * Metade do porte que faltava aqui (DECISIONS #89): sem ela, aquela etiqueta
 * passava por REAL, a música ficava "completa" e sumia da curadoria para
 * sempre.
 */
const PLACEHOLDERS_TRECHO = [
  "artista desconheci",
  "artista desconhecida",
  "unknown artist",
  "no artist",
  "titulo desconheci",
  "unknown title",
];

/**
 * Palavras de maquinário: NÃO identificam a música, mas várias delas são
 * título de verdade quando aparecem sozinhas ("Pista", "Gravação", "Nome",
 * "Sem Nome" existem no repertório). Por isso esta lista sozinha NUNCA
 * condena um texto — ver `MARCA_DE_RIPADOR`.
 */
const RUIDO_DE_ARQUIVO = new Set([
  "audiotrack", "audio", "track", "faixa", "pista", "converted", "convertido",
  "copia", "copy", "mp3", "wav", "untitled", "new", "recording", "gravacao",
  "sem", "titulo", "nome",
]);

/**
 * Marca de ripador: só ELA habilita a regra do `RUIDO_DE_ARQUIVO`. Vale um
 * número solto ("04", "2010"), uma corrida com cara de horário/data
 * ("22-17-23") ou uma palavra que nenhuma canção usa como título.
 *
 * A exigência conserta a regressão inversa: sem ela, "Gravação", "Nome" e
 * "Sem Nome" viravam placeholder — ou seja, campo VAZIO — e o título REAL do
 * curador era sobrescrito em silêncio.
 */
const MARCA_DE_RIPADOR = new Set([
  "audiotrack", "converted", "convertido", "mp3", "wav", "untitled",
]);

/**
 * Chave normalizada: sem acento, minúscula, só alfanumérico e espaço — porte
 * do `lyrics_fetch::norm`. (Diferença conhecida e inofensiva neste
 * repertório: o Rust preserva alfanumérico Unicode e este descarta o que não
 * couber em a-z0-9 depois de tirar o acento.)
 */
function chaveDeTag(texto: string): string {
  return normalize(texto)
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Sequência não vazia de no máximo `max` dígitos ASCII. */
function soDigitos(s: string, max = Infinity): boolean {
  return s.length > 0 && s.length <= max && /^[0-9]+$/.test(s);
}

/**
 * `^\d{1,4}(?:[-:.]\d{1,2}){1,}$` — "22-17-23", "2010.05.03", "12:30".
 * Conferido sobre o texto ORIGINAL, porque a pontuação some no `chaveDeTag`.
 */
function caraDeHorario(palavra: string): boolean {
  const campos = palavra.split(/[-:.]/);
  if (campos.length < 2 || !soDigitos(campos[0], 4)) return false;
  return campos.slice(1).every((c) => soDigitos(c, 2));
}

/** True quando o texto traz prova de que saiu de uma máquina. */
function temMarcaDeRipador(partes: string[], bruto: string): boolean {
  if (partes.some((p) => soDigitos(p) || MARCA_DE_RIPADOR.has(p))) return true;
  return bruto.split(/\s+/).filter(Boolean).some(caraDeHorario);
}

/**
 * `^(?:\d+\s+)?(?:(?:audio\s?track|faixa|track)(?:\s?\d+)?|pista\s?\d+)$`
 * sobre a chave normalizada — "AudioTrack 02", "02 Faixa 3", "track",
 * "Pista 3"…
 *
 * "pista" SOZINHA fica de fora (e é a única das cinco que exige o número): é
 * palavra que existe como título de verdade no repertório, e tratá-la como
 * campo vazio apagaria o título de quem curou (DECISIONS #89).
 */
function placeholderFaixa(chave: string): boolean {
  // prefixo numérico opcional ("02 audiotrack 02")
  const corte = chave.indexOf(" ");
  const s =
    corte > 0 && soDigitos(chave.slice(0, corte))
      ? chave.slice(corte + 1)
      : chave;
  const PALAVRAS: Array<[string, boolean]> = [
    ["audio track", false],
    ["audiotrack", false],
    ["faixa", false],
    ["track", false],
    ["pista", true],
  ];
  for (const [kw, exigeNumero] of PALAVRAS) {
    if (!s.startsWith(kw)) continue;
    let resto = s.slice(kw.length);
    if (resto.startsWith(" ")) resto = resto.slice(1);
    if (soDigitos(resto) || (!exigeNumero && resto === "")) return true;
  }
  return false;
}

/**
 * Em qual CAMPO o texto está — porte do `enrich::Campo`.
 *
 * A régua de placeholder NÃO é a mesma nos dois, e descobrir isso custou um
 * achado de perda de dado (QA B2). O parâmetro é obrigatório de propósito:
 * **não existe pergunta de placeholder sem slot.** A #105 acrescentou os
 * rótulos de coletânea pensando no artista, escreveu a regra dentro de um
 * predicado que roda nos dois campos, e assim uma música intitulada "Diversos"
 * passou a valer VAZIO. Um predicado que não pergunta o campo generaliza
 * sozinho na próxima vez; no Rust quem cobra em cada chamada é o compilador, e
 * aqui é o `tsc`.
 */
export type Campo = "titulo" | "artista";

/**
 * Os rótulos de COLETÂNEA — porte do `ROTULOS_DE_COLETANEA` do Rust
 * (DECISIONS #105), e **só valem em `Campo::Artista`**.
 *
 * Faltavam inteiros aqui: o mock não tinha regra nenhuma para eles, então a
 * suíte e o E2E nunca exercitaram a decisão 105 no lado TypeScript — a mesma
 * família de defeito do QA A2, por OMISSÃO, que é a forma que não quebra teste
 * nenhum.
 *
 * O que limita a lista é a lição da DECISIONS #89: só entram rótulos que
 * NENHUMA canção usa como nome — e "nenhuma canção usa como nome" é falso no
 * campo do TÍTULO, onde "Diversos", "Vários" e "Coletânea" são títulos que
 * existem. Daí o slot.
 */
const ROTULOS_DE_COLETANEA = new Set([
  "various artists", "various artist", "various",
  "varios artistas", "varias artistas",
  "varios interpretes", "varias interpretes",
  "artistas variados", "artistas diversos", "interpretes diversos",
  "varios", "varias", "diversos",
  "v a", "compilation", "compilacao", "coletanea", "coletaneas",
]);

/**
 * A abreviação escrita SEM acento. "VA" é coletânea; "Vá" é o verbo, e a
 * normalização tira o acento — as duas chegariam à mesma chave. Duas letras
 * não dão margem a mais nada, então a única prova disponível é o acento do
 * texto ORIGINAL.
 */
const ROTULOS_DE_COLETANEA_SEM_ACENTO = new Set(["va"]);

/** True quando o texto original traz algum diacrítico (porte do `tem_acento`). */
function temAcento(texto: string): boolean {
  return normalize(texto) !== texto.toLowerCase();
}

/** True quando o texto é o rótulo de uma COLETÂNEA, e não um nome. */
function eRotuloDeColetanea(chave: string, bruto: string): boolean {
  if (ROTULOS_DE_COLETANEA.has(chave)) return true;
  return ROTULOS_DE_COLETANEA_SEM_ACENTO.has(chave) && !temAcento(bruto);
}

/**
 * Porte COMPLETO do `enrich::is_placeholder` (que por sua vez porta o
 * `eh_placeholder` do `tools/curadoria.py`). Exportado porque quatro regras
 * da V9 dependem dele e porque o contrato com o Rust é testado caso a caso
 * em `mockBackend.contrato.test.ts` (DECISIONS #88).
 */
export function isPlaceholder(campo: Campo, texto: string): boolean {
  const chave = chaveDeTag(texto);
  if (chave === "" || soDigitos(chave)) return true;
  if (PLACEHOLDERS_EXATOS.has(chave)) return true;
  // Rótulo de coletânea é nome de NINGUÉM, e por isso vale só onde se espera
  // gente. No título ele é um título — e tratá-lo como campo vazio apagava,
  // pré-marcado e sem aviso, o nome que a pessoa vê na biblioteca (QA B2).
  if (campo === "artista" && eRotuloDeColetanea(chave, texto)) return true;
  if (placeholderFaixa(chave)) return true;
  if (PLACEHOLDERS_TRECHO.some((m) => chave.includes(m))) return true;
  // Só números e palavras de maquinário E com marca de ripador junto: não
  // sobra nada que identifique a música. Uma palavra sozinha é TÍTULO,
  // sempre — "Convertido", "Gravação", "Nome", "Pista" viram lixo só
  // acompanhadas da marca da máquina.
  const partes = chave.split(" ").filter(Boolean);
  if (partes.length < 2 || !temMarcaDeRipador(partes, texto)) return false;
  return partes.every((p) => soDigitos(p) || RUIDO_DE_ARQUIVO.has(p));
}

/**
 * Este título foi ESCRITO por alguém, ou o indexador o inventou a partir do
 * nome do arquivo por falta de TIT2 (DECISIONS #91)?
 *
 * Porte do `enrich::titulo_e_o_nome_do_arquivo`, e a comparação é EXATA —
 * só as pontas são aparadas. O mock comparava normalizado, e a diferença
 * decide coisas de verdade: `Oh! Chuva.mp3` com TIT2 `Oh Chuva` é etiqueta de
 * gente (pode virar conflito, ganha o aviso de nome escrito) e virava
 * invenção do indexador (som podia sobrescrever, sem aviso nenhum).
 *
 * A resposta não é perfeita — um arquivo bem nomeado pode ter etiqueta
 * idêntica ao nome — e não precisa ser: nesse caso o palpite limpo dá o mesmo
 * valor e a proposta cai por no-op de qualquer jeito.
 */
export function tituloEhDoIndexador(titulo: string, nomeDoArquivo: string): boolean {
  const base = nomeDoArquivo.split(/[\\/]/).pop() ?? "";
  // `Path::file_stem`: tira a ÚLTIMA extensão, e só quando existe uma
  const stem = base.includes(".") ? base.replace(/\.[^.]*$/, "") : base;
  return titulo.trim() === stem.trim();
}

/**
 * A procedência que o `apply` grava para a letra que está sendo gravada —
 * porte do `origem_da_fonte` do Rust. Letra do `lyrics.ovh` e letra da etapa 5
 * ficam marcadas como tais; qualquer outra fonte LIMPA a marca, porque letra
 * oficial não é transcrição (DECISIONS #54 e #82).
 *
 * `"vagalume"` não aparece aqui de propósito: nada mais o ESCREVE (DECISIONS
 * #110). Ele continua sendo LIDO — arquivos do acervo real o carregam, e o
 * `writeTags` o grava quando quem chama o declara.
 */
function origemDaFonte(fonte: string | null | undefined): string | null {
  const f = (fonte ?? "").toLowerCase();
  if (f === FONTE_LYRICS_OVH) return ORIGEM_LYRICS_OVH;
  if (f === FONTE_TRANSCRICAO.toLowerCase()) return ORIGEM_TRANSCRICAO;
  return null;
}

/**
 * A tag como o funil a enxerga: placeholder vira string vazia. O SLOT viaja
 * junto porque a régua difere entre os dois (QA B2) — "Various Artists" é
 * campo vazio no artista e nome de música no título.
 */
function tagReal(campo: Campo, texto: string | null | undefined): string {
  const t = (texto ?? "").trim();
  return isPlaceholder(campo, t) ? "" : t;
}

/**
 * Dois campos valem o MESMO valor (porte do `mesmo_valor` do Rust): espaços
 * das pontas removidos, `null` e "" tratados como o mesmo ausente. Comparar
 * com `!==` cru recusava propostas boas dizendo "a música mudou".
 */
function mesmoValor(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? "").trim() === (b ?? "").trim();
}

/**
 * O "LRCLIB" do mock: um catálogo minúsculo e determinístico, com as músicas
 * das fixtures. Quem tem tag real FORA do catálogo é exatamente o caso que a
 * etapa do lyrics.ovh existe para atender — é assim que o mock ganha um
 * caminho para ela sem contrariar a regra real (título E artista de
 * verdade, porque essa fonte não devolve nome para conferir).
 */
const LRCLIB_CATALOGO: Record<
  string,
  { titulo: string; artista: string; alta: boolean }
> = {
  // a única ALTA: a duração confere (é a fixture com_letra)
  "coracao sertanejo": {
    titulo: "Coração Sertanejo",
    artista: "Artista Teste",
    alta: true,
  },
  "instrumental sem letra": {
    titulo: "Instrumental Sem Letra",
    artista: "Banda Fixture",
    alta: false,
  },
};

/**
 * Etapa do funil em que uma proposta com esta procedência foi resolvida —
 * mesmas strings do backend Rust (enrich::ETAPA_*), que é quem a UI mostra.
 *
 * O Rust emite um evento ao ENTRAR em cada etapa e outro ao concluir a música;
 * o mock coalesce isso num evento por música, com a etapa que a resolveu: sem
 * latência de rede os eventos sairiam todos no mesmo tique e a tela só mostraria
 * o último.
 */
function etapaDaFonte(fonte: string): string {
  if (fonte === FONTE_IMPRESSAO_DIGITAL) return ETAPA_IMPRESSAO_DIGITAL;
  if (fonte === FONTE_LRCLIB) return ETAPA_LRCLIB;
  if (fonte === FONTE_LYRICS_OVH) return ETAPA_LYRICS_OVH;
  return ETAPA_NOME_ARQUIVO;
}

/**
 * Valor EFETIVO de um campo (`enrich::campo_efetivo`): espaços aparados e
 * placeholder tratado como VAZIO, dos DOIS lados da comparação. Sem isso,
 * "AudioTrack 17" contra o palpite "Faixa" passava por mudança.
 */
function campoEfetivo(campo: Campo, texto: string | null | undefined): string {
  return tagReal(campo, texto ?? "");
}

function propostaNoOp(p: EnrichProposal): boolean {
  return (
    p.error === null &&
    // a linha de conflito existe JUSTAMENTE porque nada muda: nela o proposto
    // repete o atual, e é a divergência que precisa ser vista (V9)
    p.conflito === null &&
    p.lyrics === null &&
    campoEfetivo("titulo", p.proposed_title) ===
      campoEfetivo("titulo", p.current_title) &&
    campoEfetivo("artista", p.proposed_artist) ===
      campoEfetivo("artista", p.current_artist)
  );
}

/**
 * Acima disto, duas grafias são o MESMO nome ("Milionário & José Rico" x
 * "Milionário y José Rico"). Calibrado no acervo real de 94 arquivos, onde
 * 6 dos 8 conflitos eram a mesma música escrita de outro jeito — e calibrado
 * contra o `difflib`, que é a métrica que `similaridadeDeNomes` porta.
 *
 * Espelha `fingerprint::LIMIAR_MESMA_GRAFIA` — o valor mora lá, aqui é cópia.
 */
const LIMIAR_MESMA_GRAFIA = 0.85;

/**
 * Comprimento mínimo para o teste de contenção não absolver coincidência
 * ("Sol" dentro de "Sol Nascente" são músicas diferentes). Espelha
 * `fingerprint::MIN_CONTENCAO`.
 */
const MIN_CONTENCAO = 5;

// ---------------------------------------------------------------------------
// A similaridade: porte do difflib.SequenceMatcher.ratio() do Python
// ---------------------------------------------------------------------------
//
// Espelha `lyrics_fetch::similarity`. Até o QA A1 os dois lados usavam
// coeficiente de Dice sobre bigramas, e o 0,85 que decide grafia foi
// calibrado contra o `difflib` do `tools/curadoria.py` — número de uma
// métrica aplicado a outra. Medido em 49 pares do repertório: o Dice dava 8
// falsos conflitos contra 1 do difflib, porque uma troca de UM caractere
// destrói DOIS bigramas e nome de artista brasileiro é curto ("Luiz"/"Luis").
// E conflito faz o funil VOLTAR antes das etapas de letra: com o Dice, baixar
// o acessório piorava a música.

/**
 * O `find_longest_match` do difflib, restrito a `a[alo..ahi]` e `b[blo..bhi]`:
 * devolve `[início em a, início em b, tamanho]`. Empate fica com o bloco que
 * começa mais cedo em `a` e depois mais cedo em `b` — o desempate muda a
 * recursão, e portanto o total.
 */
function maiorBloco(
  a: string[],
  b: string[],
  b2j: Map<string, number[]>,
  alo: number,
  ahi: number,
  blo: number,
  bhi: number,
): [number, number, number] {
  let [besti, bestj, bestsize] = [alo, blo, 0];
  // j2len[j] = tamanho do bloco que termina em a[i-1]/b[j]
  let j2len = new Map<number, number>();
  for (let i = alo; i < ahi; i++) {
    const novo = new Map<number, number>();
    for (const j of b2j.get(a[i]) ?? []) {
      if (j < blo) continue;
      if (j >= bhi) break;
      const k = (j2len.get(j - 1) ?? 0) + 1;
      novo.set(j, k);
      if (k > bestsize) [besti, bestj, bestsize] = [i + 1 - k, j + 1 - k, k];
    }
    j2len = novo;
  }
  // Estende o bloco pelas pontas: no difflib isto reabsorve os caracteres
  // "populares" purgados do b2j. Sem `isjunk` (é sempre None aqui) é só isto.
  while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
    [besti, bestj, bestsize] = [besti - 1, bestj - 1, bestsize + 1];
  }
  while (
    besti + bestsize < ahi &&
    bestj + bestsize < bhi &&
    a[besti + bestsize] === b[bestj + bestsize]
  ) {
    bestsize++;
  }
  return [besti, bestj, bestsize];
}

/**
 * Casamentos totais entre `a` e `b`, pelo algoritmo do
 * `get_matching_blocks()`: acha o maior bloco comum e recorre à ESQUERDA e à
 * DIREITA dele, nunca cruzado — é o que faz o difflib não ser um casamento de
 * conjuntos.
 */
function casamentos(a: string[], b: string[]): number {
  const b2j = new Map<string, number[]>();
  b.forEach((c, j) => {
    const js = b2j.get(c);
    if (js) js.push(j);
    else b2j.set(c, [j]);
  });
  // o `autojunk` do difflib descarta os caracteres populares demais, e só a
  // partir de 200 elementos — nomes nunca chegam lá, mas o porte inclui a
  // regra para não divergir no dia em que alguém comparar textos longos
  if (b.length >= 200) {
    const teto = Math.floor(b.length / 100) + 1;
    for (const [c, js] of [...b2j]) if (js.length > teto) b2j.delete(c);
  }

  let total = 0;
  const fila: Array<[number, number, number, number]> = [[0, a.length, 0, b.length]];
  while (fila.length > 0) {
    const [alo, ahi, blo, bhi] = fila.pop()!;
    const [i, j, k] = maiorBloco(a, b, b2j, alo, ahi, blo, bhi);
    if (k === 0) continue;
    total += k;
    if (alo < i && blo < j) fila.push([alo, i, blo, j]);
    if (i + k < ahi && j + k < bhi) fila.push([i + k, ahi, j + k, bhi]);
  }
  return total;
}

/**
 * Similaridade textual em [0, 1] entre as chaves normalizadas: o
 * `difflib.SequenceMatcher.ratio()`, 2·M/T sobre os caracteres casados.
 * Porte do `lyrics_fetch::similarity` — exportado para o teste de contrato,
 * onde os NÚMEROS são conferidos, e não só o veredito: uma régua diferente
 * que hoje cai do mesmo lado do limiar volta a divergir na próxima calibração.
 */
export function similaridadeDeNomes(bruto1: string, bruto2: string): number {
  const a = chaveDeTag(bruto1);
  const b = chaveDeTag(bruto2);
  // Divergência deliberada do Python, igual à do Rust: lá dois vazios dão 1,0
  // (2·M/T com T = 0). Aqui valem 0,0 — a resposta decide IDENTIDADE, e dois
  // campos vazios não são a mesma música, são dois nadas.
  if (a === b) return a === "" ? 0 : 1;
  const [ca, cb] = [[...a], [...b]];
  return (2 * casamentos(ca, cb)) / (ca.length + cb.length);
}

/**
 * O som CONTRADIZ esta etiqueta? Porte do `fingerprint::discorda`.
 *
 * Campo vazio ou placeholder não contradiz nada — só espera ser preenchido.
 * Variação de grafia também não: são a mesma coisa quando as chaves são muito
 * parecidas OU quando uma CONTÉM a outra ("Lampejo" dentro de "Adventício -
 * Lampejo"). Diferença de verdade continua conflito.
 *
 * As duas peças abaixo nasceram na V9 e faltavam aqui, cada uma errando para
 * um lado: sem o piso de contenção o mock ABSOLVIA "Sol" dentro de "Sol
 * Nascente" (conflito real engolido), e sem a tolerância de grafia ele
 * CONDENAVA "Milionário & José Rico" contra "Milionário y José Rico" (alarme
 * falso — e 6 dos 8 conflitos do acervo real eram exatamente isso).
 *
 * Exportado para o teste de contrato com o Rust (DECISIONS #88).
 */
export function discordaDoSom(
  campo: Campo,
  atual: string,
  identificado: string,
): boolean {
  // Campo vazio não contradiz nada — só espera ser preenchido. É aqui que o
  // slot muda um veredito: "Various Artists" no crédito é vazio e o som
  // PREENCHE; "Diversos" no título é um título, e o som o CONTRADIZ (QA B2).
  if (isPlaceholder(campo, atual) || isPlaceholder(campo, identificado)) {
    return false;
  }
  const a = chaveDeTag(atual);
  const b = chaveDeTag(identificado);
  if (a === b) return false;
  // par ordenado em CARACTERES, como o `sorted((a, b), key=len)` do Python e
  // o `curta_e_longa` do Rust (QA B7)
  const [curta, longa] = [...a].length <= [...b].length ? [a, b] : [b, a];
  if ([...curta].length >= MIN_CONTENCAO && longa.includes(curta)) return false;
  return similaridadeDeNomes(a, b) < LIMIAR_MESMA_GRAFIA;
}

/**
 * O que uma varredura aprende sobre SI MESMA enquanto roda — porte do
 * `enrich::EstadoDaVarredura`.
 *
 * Um veredito é uma afirmação sobre a VARREDURA ("esta chave está recusada",
 * "este acessório não roda nesta máquina"), nunca sobre um arquivo. Erro de um
 * arquivo não entra aqui: ele vira a linha de erro daquela música e a fila
 * segue (QA A2).
 */
interface EstadoDaVarredura {
  /** O acessório do som não roda nesta máquina: etapa 2 desligada pelo resto. */
  somDesligado: boolean;
  /**
   * Quantas músicas passaram sem que o som fosse perguntado por causa do
   * desligamento acima. Sem este número, a pessoa vê uma linha vermelha, as
   * outras 149 sem nada, e conclui que o resto foi conferido.
   */
  semPerguntarAoSom: number;
}

function novoEstadoDaVarredura(): EstadoDaVarredura {
  return { somDesligado: false, semPerguntarAoSom: 0 };
}

export function createMockBackend(): MockBackend {
  let state = loadState();
  const progressListeners = new Set<(p: ScanProgress) => void>();
  const enrichProgressListeners = new Set<(p: EnrichProgress) => void>();
  const acessorioProgressListeners = new Set<(p: AcessorioProgresso) => void>();
  const transcricaoProgressListeners = new Set<
    (p: TranscricaoProgresso) => void
  >();
  /** Varreduras que pediram cancelamento e ainda não pararam (M4). */
  const enrichCancelled = new Set<string>();
  /** Downloads de acessório que pediram cancelamento (mesma disciplina). */
  const downloadsCancelados = new Set<string>();

  /** O estado do cache de um acessório — "ausente" é o padrão de quem nunca baixou. */
  function estadoDe(nome: string): AcessorioInfo["estado"] {
    return state.acessoriosEstado[nome] ?? "ausente";
  }

  /** Um acessório do catálogo, como a tela precisa vê-lo. */
  function infoDoAcessorio(
    a: (typeof CATALOGO)[number] = ACESSORIO_FPCALC,
  ): AcessorioInfo {
    return {
      ...a,
      estado: estadoDe(a.nome),
      // DECISIONS #106 — número da banda de referência, arredondado para CIMA,
      // e a copy diz "cerca de".
      segundos_estimados: Math.ceil(a.tamanho_bytes / BANDA_REFERENCIA_BYTES_S),
      // V10.4 — o mock nunca mede: ele não baixa nada de verdade, e inventar
      // uma medição aqui faria a tela dizer "neste computador" sobre uma
      // conexão que não existe. O backend real mede (`db::banda_medida`).
      tempo_medido_nesta_maquina: false,
    };
  }

  /** A etapa 5 pode rodar? Exige o transcritor E o modelo, os dois prontos. */
  function transcricaoPronta(): boolean {
    return (
      backend._acessorio.publicado &&
      estadoDe(ACESSORIO_WHISPER.nome) === "pronto" &&
      estadoDe(ACESSORIO_MODELO.nome) === "pronto"
    );
  }

  function emitirProgressoDoAcessorio(p: AcessorioProgresso): void {
    acessorioProgressListeners.forEach((cb) => cb(p));
  }

  /**
   * Evento `transcricao:progresso` (V10). `porcento_da_musica` existe porque
   * UMA música leva minutos, e `segundos_restantes` é `null` até a primeira
   * terminar — antes disso não há o que medir (DECISIONS #85).
   */
  function emitirProgressoDaTranscricao(
    scanId: string,
    done: number,
    total: number,
    atual: string,
    porcento: number,
    segundosRestantes: number | null,
  ): void {
    const payload: TranscricaoProgresso = {
      done,
      total,
      atual,
      porcento_da_musica: porcento,
      segundos_restantes: segundosRestantes,
      scan_id: scanId,
    };
    transcricaoProgressListeners.forEach((cb) => cb(payload));
  }

  function save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // storage cheio/indisponível: segue apenas em memória
    }
  }

  function emitProgress(total: number): void {
    for (let done = 0; done <= total; done++) {
      const payload: ScanProgress = { done, total };
      progressListeners.forEach((cb) => cb(payload));
    }
  }

  function emitEnrichProgress(
    scanId: string,
    done: number,
    total: number,
    atual: string,
    etapa: string,
  ): void {
    // o evento carrega a varredura que o emitiu: a UI ignora o que vier de
    // uma varredura já cancelada (M4). `etapa` (V8/F18) é a etapa do funil em
    // curso, em pt-BR e pronta para exibir.
    const payload: EnrichProgress = { done, total, atual, etapa, scan_id: scanId };
    enrichProgressListeners.forEach((cb) => cb(payload));
  }

  function renumber(playlistId: number): void {
    state.playlistItems
      .filter((i) => i.playlist_id === playlistId)
      .sort((a, b) => a.position - b.position)
      .forEach((item, idx) => {
        item.position = idx;
      });
  }

  function removeSongs(predicate: (s: SongRecord) => boolean): number {
    const doomed = state.songs.filter(predicate);
    if (doomed.length === 0) return 0;
    const doomedIds = new Set(doomed.map((s) => s.id));
    state.songs = state.songs.filter((s) => !doomedIds.has(s.id));
    const touched = new Set(
      state.playlistItems
        .filter((i) => doomedIds.has(i.song_id))
        .map((i) => i.playlist_id),
    );
    state.playlistItems = state.playlistItems.filter((i) => !doomedIds.has(i.song_id));
    touched.forEach(renumber);
    return doomed.length;
  }

  /**
   * Candidata da varredura — o MESMO predicado que o `enrichCount` usa
   * (ALTO-2/ALTO-5). Porte do `candidata` do Rust:
   *
   * - indisponível fica de fora;
   * - completa = título E artista REAIS (placeholder vale vazio) mais letra;
   * - para o INSTRUMENTAL a letra sai da conta (V8/F17): sem voz não há letra
   *   a buscar em fonte nenhuma. Mas ele NÃO é excluído — "instrumental sem
   *   letra ainda pode (e deve) ter título e artista corretos" (PRD V8), e era
   *   justamente essa pasta que o app declarava completa com o botão cinza.
   */
  function candidataDoFunil(song: SongRecord, folderPrefix: string): boolean {
    if (!song.available) return false;
    // prefixo casa na FRONTEIRA de separador ("/m/1" não casa "/m/10/a.mp3"),
    // como isUnderFolder e o backend Rust
    if (folderPrefix && !isUnderFolder(song.file_path, folderPrefix)) return false;
    return true;
  }

  /**
   * As etapas 3 e 4 valem a pena para esta música? Porte do
   * `etapas_de_letra_valem_a_pena`: é o que RESTOU do portão de completude.
   *
   * Note o que ele NÃO olha mais: título e artista. Música sem letra passa
   * pelas etapas de letra mesmo com nomes prontos — é assim que ela ganha a
   * letra que lhe falta. E quem JÁ tem letra não passa, o que fecha de graça a
   * rota que destruía transcrição corrigida à mão (DECISIONS #79 e #102).
   */
  function etapasDeLetraValemAPena(song: SongRecord): boolean {
    return !song.has_lyrics && song.instrumental !== true;
  }

  /**
   * A etapa 5 teria o que fazer com esta música? Porte do
   * `a_etapa_5_tem_o_que_fazer`, que é o predicado da PERGUNTA DO FIM.
   *
   * Ele espelha os portões que a fila aplica antes de gastar minutos de CPU —
   * uma regra só, num lugar só (DECISIONS #80). QA M3: faltava o arquivo
   * EXISTIR. A música cujo MP3 sumiu do disco inflava o total e o tempo da
   * pergunta, e depois gastava uma vaga da fila para produzir uma linha de
   * erro, que é a única coisa que a etapa 5 consegue fazer com um arquivo que
   * não está lá.
   *
   * Erro de REDE não tira ninguém daqui, e é de propósito: a etapa 5 não usa
   * rede. A música que ficou sem letra porque o LRCLIB não respondeu é
   * exatamente a que a transcrição resolve.
   */
  function aEtapa5TemOQueFazer(song: SongRecord): boolean {
    return (
      etapasDeLetraValemAPena(song) && !state.deletedFiles.includes(song.file_path)
    );
  }

  /**
   * A razão que vale AGORA nesta máquina — porte do
   * `transcricao::razao_desta_maquina`: a medida, se já houver amostra que
   * baste; a de referência, enquanto não houver.
   *
   * Existe como função, e não como duas leituras espalhadas, porque a escolha
   * entre número medido e número declarado é exatamente o tipo de regra que
   * diverge quando está escrita em dois lugares (DECISIONS #80).
   */
  function razaoDestaMaquina(): number {
    const m = state.medicaoDaTranscricao;
    if (!m || m.audio < AUDIO_MINIMO_PARA_MEDIR) return RAZAO_DE_REFERENCIA;
    const razao = m.relogio / m.audio;
    return razao > 0 ? razao : RAZAO_DE_REFERENCIA;
  }

  /** A etapa 2 existe nesta máquina? Só com o acessório conferido e pronto. */
  function somAtivo(): boolean {
    return backend._acessorio.publicado && estadoDe(ACESSORIO_FPCALC.nome) === "pronto";
  }

  /**
   * O funil inteiro para UMA música (V8/F18, atualizado na V10): o que já
   * está no arquivo → o som da gravação → LRCLIB → lyrics.ovh. Nenhuma etapa
   * pede credencial de quem usa. É o mesmo
   * caminho para o lote e para o caso pontual do editor — duas implementações
   * divergiriam, e é justamente a procedência que a pessoa usa para decidir.
   *
   * `digitado` são o título/artista VIVOS do editor, quando existem: quem
   * clicou já corrigiu a etiqueta errada, e procurar pela etiqueta velha era
   * um beco sem saída com cara de "a internet não tem a minha música".
   */
  function propostaDoFunil(
    song: SongRecord,
    digitado?: { title?: string | null; artist?: string | null },
    /** Estado da VARREDURA (não da música): vereditos e a conta do A2. */
    estado: EstadoDaVarredura = novoEstadoDaVarredura(),
    /**
     * De onde veio o pedido (porte do `enrich::Origem`). Na VARREDURA as
     * etapas de letra só rodam para quem não tem letra; na porta de UMA
     * música o funil inteiro roda sempre, porque quem clicou sabe o que quer
     * (DECISIONS #81).
     */
    origem: "varredura" | "uma-musica" = "uma-musica",
  ): EnrichProposal {
    const proposta = passarPeloFunil(song, digitado, estado, origem);
    // Num lugar SÓ, na saída — como no Rust: o funil tem vários pontos de
    // retorno, e marcar em cada um é o tipo de coisa que fica correta hoje e
    // silenciosamente errada na próxima etapa nova. O modo de falhar aqui é
    // pré-marcar a troca de um nome curado (V9).
    proposta.substitui_nome_escrito = substituiNomeEscrito(song, digitado, proposta);
    return proposta;
  }

  /**
   * Esta proposta trocaria um título ou artista ESCRITO POR GENTE? (V9)
   *
   * Compara por valor EFETIVO dos dois lados: " Oxum " não é outro nome que
   * "Oxum", placeholder de ripador vale vazio, e o título que o INDEXADOR
   * copiou do nome do arquivo não é etiqueta de ninguém (DECISIONS #91).
   * Proposta vazia num campo também não conta: o apply preserva o valor atual
   * nesse caso, e avisar de uma substituição que não vai acontecer é ruído.
   */
  function substituiNomeEscrito(
    song: SongRecord,
    digitado: { title?: string | null; artist?: string | null } | undefined,
    p: EnrichProposal,
  ): boolean {
    const trocaria = (
      campo: Campo,
      escrito: string,
      proposto: string | null,
    ): boolean => {
      const a = campoEfetivo(campo, escrito);
      const b = campoEfetivo(campo, proposto);
      return a !== "" && b !== "" && a !== b;
    };
    return (
      trocaria("titulo", tituloEscrito(song, digitado?.title), p.proposed_title) ||
      trocaria(
        "artista",
        tagReal("artista", digitado?.artist ?? song.artist),
        p.proposed_artist,
      )
    );
  }

  /**
   * O título que uma PESSOA escreveu: a etiqueta real, menos a invenção do
   * indexador (que copia o nome do arquivo quando o MP3 não tem TIT2).
   */
  function tituloEscrito(
    song: SongRecord,
    digitado?: string | null,
  ): string {
    if (tituloEhDoIndexador(song.title, nomeArquivo(song))) return "";
    return tagReal("titulo", digitado ?? song.title);
  }

  /**
   * A PROPOSTA BAIXA — porte do `enrich::proposta_baixa` do Rust.
   *
   * Palpite da etapa 1: tag REAL vence o nome do arquivo (nunca apaga), e a
   * tag placeholder vale VAZIO, então o palpite entra no lugar dela.
   *
   * Mora aqui fora, e não dentro do `passarPeloFunil`, porque o Rust também a
   * tem em um lugar só: a etapa 5 parte DELA (`proposta_da_transcricao` chama
   * `proposta_baixa`). Enquanto era uma função aninhada, a etapa 5 do mock
   * montava a proposta à mão e devolvia `proposed_* = atual`, sempre — um
   * contrato que o backend não cumpre, e o terceiro do mesmo tipo (QA A2).
   */
  function propostaBaixa(
    song: SongRecord,
    digitado: { title?: string | null; artist?: string | null } | undefined,
    error: string | null,
  ): EnrichProposal {
    const artistaTag = tagReal("artista", digitado?.artist ?? song.artist);
    const bruto = nomeArquivo(song).replace(/\.[^.]+$/, "");
    const stem = bruto.replace(/_/g, " ").replace(/\s+/g, " ").trim();
    const divisor = stem.indexOf(" - ");
    const [guessArtist, guessTitle] =
      divisor > 0
        ? [stem.slice(0, divisor).trim(), stem.slice(divisor + 3).trim()]
        : [null, stem];
    // Um título que é o PRÓPRIO nome do arquivo não é etiqueta de ninguém:
    // foi o indexador que o copiou do disco quando o MP3 não tinha TIT2
    // (mesma noção do arquivoParaBusca daqui de cima). Tratá-lo como tag
    // real faria a etapa 1 propor exatamente o que já está lá — e é só por
    // isso que uma música sem tag nenhuma tem o que receber aqui.
    const tituloDeTag = tituloEscrito(song, digitado?.title);
    return {
      song_id: song.id,
      file_path: song.file_path,
      current_title: song.title,
      current_artist: song.artist,
      // CRÍTICO-1: a revisão precisa saber que existe letra ali, e de que tipo
      has_lyrics: song.has_lyrics,
      letra_origem: song.letra_origem ?? null,
      proposed_title: tituloDeTag || guessTitle || song.title,
      proposed_artist: artistaTag || guessArtist,
      lyrics: null,
      confidence: "baixa",
      fonte: error !== null ? FONTE_ERRO : FONTE_ARQUIVO,
      conflito: null,
      // calculado num lugar só, na saída do funil (como no Rust)
      substitui_nome_escrito: false,
      // V10 — a varredura nunca marca instrumental nem extrai refrão: as
      // duas coisas saem da etapa 5, que é outro comando.
      marcar_instrumental: false,
      refrao: null,
      aviso: null,
      error,
    };
  }

  function passarPeloFunil(
    song: SongRecord,
    digitado: { title?: string | null; artist?: string | null } | undefined,
    estado: EstadoDaVarredura,
    origem: "varredura" | "uma-musica",
  ): EnrichProposal {
    const tituloTag = tagReal("titulo", digitado?.title ?? song.title);
    const artistaTag = tagReal("artista", digitado?.artist ?? song.artist);
    const base = {
      song_id: song.id,
      file_path: song.file_path,
      current_title: song.title,
      current_artist: song.artist,
      // CRÍTICO-1: a revisão precisa saber que existe letra ali, e de que tipo
      has_lyrics: song.has_lyrics,
      letra_origem: song.letra_origem ?? null,
    };

    /** Palpite da etapa 1: tag REAL vence o nome do arquivo (nunca apaga). */
    function propostaDoArquivo(error: string | null): EnrichProposal {
      return propostaBaixa(song, digitado, error);
    }

    // arquivo sumido do disco: reporta sem gastar "rede"
    if (state.deletedFiles.includes(song.file_path)) {
      return propostaDoArquivo(`arquivo não encontrado: ${song.file_path}`);
    }

    let erro: string | null = null;
    /** O que o som resolveu, já filtrado pelo conflito (V9). */
    let identidade: SomDiz | null = null;

    // --- etapa 2: IDENTIDADE pelo som (V9) --------------------------------
    //
    // Vem ANTES das bases de letra porque não devolve letra nenhuma: devolve
    // identidade, que é ENTRADA das outras etapas. Roda também para
    // instrumental — dá título e artista sem encostar em letra.
    // QA A2 — a etapa EXISTIA para esta música e não foi feita, porque um
    // veredito anterior a desligou. Contar é o que permite à tela dizer
    // quantas ficaram sem ser perguntadas, em vez de deixar a pessoa concluir
    // que o silêncio é aprovação. Mesma ordem do Rust: conta-se ANTES, e a
    // música que causou o desligamento não entra na conta (ela tem a linha de
    // erro, que é a informação).
    if (somAtivo() && estado.somDesligado) {
      estado.semPerguntarAoSom++;
    }
    if (somAtivo() && !estado.somDesligado) {
      const falha = state.somFalha[song.file_path];
      const diz = state.somFalha[song.file_path] ? undefined : state.somDiz[song.file_path];
      if (falha) {
        // Falha do `fpcalc` é erro DESTA música e o funil SEGUE (as etapas de
        // letra ainda rodam). Só o veredito sobre a máquina desliga a etapa,
        // exatamente como a etapa 4 só se desliga com a chave recusada — a
        // incoerência entre as duas era o achado A2.
        if (falha === ERRO_FPCALC_NAO_EXECUTA) estado.somDesligado = true;
        erro = falha;
      }
      if (diz) {
        if (
          discordaDoSom("titulo", tituloEscrito(song, digitado?.title), diz.titulo) ||
          discordaDoSom("artista", artistaTag, diz.artista)
        ) {
          // O som contradiz etiqueta REAL. A linha existe para INFORMAR, e o
          // funil PARA aqui: procurar letra sob um nome que o som acabou de
          // contradizer é o caminho mais curto para gravar a letra da música
          // errada (DECISIONS #63, com multiplicador).
          const p = propostaDoArquivo(null);
          p.fonte = FONTE_IMPRESSAO_DIGITAL;
          p.conflito = {
            titulo: diz.titulo,
            artista: diz.artista,
            confianca: diz.confianca,
          };
          return p;
        }
        // regra da V3.1: só preenche campo VAZIO — etiqueta real é preservada
        // em qualquer confiança (DECISIONS #53)
        identidade = {
          titulo: tituloEscrito(song, digitado?.title) || diz.titulo,
          artista: artistaTag || diz.artista,
          confianca: diz.confianca,
        };
      }
    }

    /** O que sobrou das etapas 1 e 2, quando nenhuma etapa de letra roda. */
    function propostaDaIdentidade(): EnrichProposal {
      const p = propostaDoArquivo(erro);
      // erro tem precedência: a linha de erro É a informação, e anunciar uma
      // identificação ao lado de "não deu" confundiria as duas coisas
      if (p.error !== null || identidade === null) return p;
      const mudou =
        campoEfetivo("titulo", identidade.titulo) !==
          campoEfetivo("titulo", p.current_title) ||
        campoEfetivo("artista", identidade.artista) !==
          campoEfetivo("artista", p.current_artist);
      if (mudou) {
        p.proposed_title = identidade.titulo;
        p.proposed_artist = identidade.artista || null;
        // aqui a confiança do som é segura: esta proposta aplica NOMES, em
        // campos que estavam vazios, sem tocar em letra nenhuma
        p.confidence = identidade.confianca;
        p.fonte = FONTE_IMPRESSAO_DIGITAL;
      }
      return p;
    }

    // V10 — o portão de completude MUDOU DE LUGAR (DECISIONS #102): ele saiu
    // da porta de entrada (por isso a música que parece completa chegou até
    // aqui e o som pôde desmenti-la) e virou o guarda das etapas de letra.
    // Procurar letra para quem já tem não faz sentido — e, de graça, isso
    // fecha a rota que destruía transcrição corrigida à mão (DECISIONS #79).
    if (origem === "varredura" && song.has_lyrics) return propostaDaIdentidade();

    // V8/F17 — as etapas de LETRA param aqui para música sem voz. NÃO é
    // filtro de completude (o instrumental é candidato e pode ganhar nome):
    // é integridade. Um instrumental com nomes certos casa com a versão
    // CANTADA no LRCLIB, sai ALTA e chega PRÉ-MARCADA (DECISIONS #49) — um
    // clique gravaria a letra de outra gravação no arquivo.
    if (song.instrumental === true) return propostaDaIdentidade();

    // sem rede: o backend real NUNCA rejeita — o erro vem POR MÚSICA
    // na proposta e a linha fica desabilitada (DECISIONS #47)
    if (backend._offline) {
      erro = "sem conexão";
      return propostaDaIdentidade();
    }

    // Com identidade vinda do som, as etapas de letra partem DELA: um palpite
    // verdadeiro em vez da cascata local de até sete (PRD V9 — também sai
    // mais barato). Os NOMES propostos continuam sendo os da identidade: a
    // autoridade sobre a identidade é a impressão digital.
    const tituloBusca = identidade ? identidade.titulo : tituloTag;
    const artistaBusca = identidade ? identidade.artista : artistaTag;

    // --- etapa 3: LRCLIB (título + duração conferida) ----------------------
    const hit = LRCLIB_CATALOGO[chaveDeTag(tituloBusca)];
    if (hit) {
      return {
        ...base,
        proposed_title: identidade ? identidade.titulo : hit.titulo,
        proposed_artist: identidade ? identidade.artista : hit.artista,
        lyrics: FIXTURE_LYRICS,
        // teto de MÉDIA quando o nome veio do som: a duração conferiu duas
        // vezes a MESMA coisa, não duas coisas independentes
        confidence: identidade
          ? TETO_COM_IDENTIDADE_DO_SOM
          : hit.alta
            ? "alta"
            : "media",
        fonte: FONTE_LRCLIB,
        conflito: null,
        substitui_nome_escrito: false,
        marcar_instrumental: false,
        refrao: null,
        aviso: null,
        error: null,
      };
    }

    // --- etapa 4: lyrics.ovh, SEM CHAVE ------------------------------------
    //
    // Ela tomou o lugar do Vagalume (DECISIONS #110) porque não pede chave: a
    // etapa com chave é a que quase ninguém alcança, e pôr a única fonte
    // utilizável atrás de um pedágio é o mesmo que não tê-la.
    //
    // A régua é a mesma, e estrita pelo mesmo motivo: esta fonte não tem
    // duração, e ainda por cima NÃO DEVOLVE NOME. Sem título E artista REAIS
    // para conferir, não se consulta — foi um casamento sem prova que gravou a
    // letra de "Ponto de Ogum" dentro de "Ponto de Oxum" (DECISIONS #63).
    if (tituloBusca && artistaBusca) {
      if (backend._lyricsOvhForaDoAr) {
        // erro DESTA música: o serviço cai com frequência, e desligar a etapa
        // no primeiro soluço deixaria as seguintes sem tentativa (QA A2)
        erro = ERRO_LYRICS_OVH_FORA_DO_AR;
        return propostaDaIdentidade();
      }
      return {
        ...base,
        // a etapa não propõe nome novo: os nomes são os do PEDIDO, e a letra é
        // a mudança inteira
        proposed_title: tituloBusca,
        proposed_artist: artistaBusca,
        lyrics: FIXTURE_LYRICS,
        // MÉDIA, nunca ALTA: sem duração não há confirmação independente, e
        // ALTA chegaria pré-marcada (DECISIONS #49)
        confidence: "media",
        fonte: FONTE_LYRICS_OVH,
        conflito: null,
        substitui_nome_escrito: false,
        marcar_instrumental: false,
        refrao: null,
        // A RESSALVA, em TODA proposta desta fonte: ela não diz a que música a
        // letra pertence, e é a única etapa cujo casamento não é verificável.
        aviso: AVISO_SEM_CONFERENCIA,
        error: null,
      };
    }

    // resto: só o que as etapas 1 e 2 acharam
    return propostaDaIdentidade();
  }

  /**
   * O desfecho da etapa 5 para UMA música, como proposta (porte do
   * `enrich::proposta_da_transcricao`).
   *
   * **A etapa 5 não propõe nome: ela ECOA o arquivo** (QA A2).
   *
   * O caminho até aqui teve duas voltas. O mock devolvia `proposed_* = atual`
   * chamando isso de "garantia de construção" e o Rust fazia o contrário —
   * `proposta_baixa`, o palpite do NOME DO ARQUIVO —, de modo que `AudioTrack
   * 03` / None saía `Oh! Chuva` / `Falamansa` sob o rótulo da transcrição. O
   * backend resolveu tirando o nome, por medição e não por pureza: **o palpite
   * já foi entregue**. A etapa 1 roda em TODAS as músicas da pasta (DECISIONS
   * #102) e `sem_letra_no_fim` sai da mesma varredura, então toda música que
   * chega aqui já tem a sua linha de "preencher o branco" na MESMA revisão.
   * Repetir seria cobrar uma segunda leitura de quem vai conferir 47 letras de
   * máquina.
   *
   * O eco NÃO pode ser vazio: o `apply` grava `ap.title` como veio, e título
   * vazio apagaria a etiqueta de alguém — por isso o palpite da etapa 1
   * sobrevive quando não há nada a ecoar.
   */
  function propostaDaTranscricao(song: SongRecord): EnrichProposal {
    // `error: null` porque o eco é o mesmo com ou sem desfecho; os ramos
    // abaixo trocam a `fonte` para `erro` junto com a mensagem, como no Rust.
    const palpite = propostaBaixa(song, undefined, null);
    const base: EnrichProposal = {
      ...palpite,
      // o palpite só sobrevive onde não há NADA a ecoar
      proposed_title: song.title.trim() ? song.title : palpite.proposed_title,
      proposed_artist: song.artist,
      fonte: FONTE_ERRO,
    };
    // A etapa 5 NÃO desfaz trabalho humano: marca de instrumental e letra
    // existente são escolha de gente (DECISIONS #71 e #79), e as horas de CPU
    // que estas duas travas economizam são reais.
    if (song.instrumental === true) {
      return { ...base, error: AVISO_INSTRUMENTAL_NAO_TRANSCREVE };
    }
    if (song.has_lyrics) return { ...base, error: AVISO_JA_TEM_LETRA };
    if (state.deletedFiles.includes(song.file_path)) {
      return { ...base, error: `arquivo não encontrado: ${song.file_path}` };
    }
    const saida = state.transcricoes[song.file_path];
    if (saida && "erro" in saida) return { ...base, error: saida.erro };
    if (saida && "letra" in saida) {
      return {
        ...base,
        lyrics: saida.letra,
        refrao: saida.refrao,
        // MÉDIA, nunca ALTA: ALTA chega pré-marcada (DECISIONS #49), e letra
        // escrita por máquina é justamente a que precisa de olho humano antes
        // de entrar no arquivo.
        confidence: "media",
        fonte: FONTE_TRANSCRICAO,
      };
    }
    // Sem nada ensinado, o motor ouviu o áudio inteiro e não achou voz: é o
    // desfecho de instrumental, e ele vem com o MOTIVO medido — é a única
    // explicação que alguém vai receber para uma marca definitiva.
    const motivo =
      saida && "instrumental" in saida
        ? saida.instrumental
        : "o áudio foi ouvido inteiro e não há voz nenhuma nele";
    return {
      ...base,
      marcar_instrumental: true,
      confidence: "media",
      fonte: FONTE_TRANSCRICAO,
      aviso: motivo,
    };
  }

  function songWords(song: SongRecord): string[] {
    return tokenize(
      `${song.title} ${song.artist ?? ""} ${song.lyrics ?? ""} ${song.temas ?? ""} ${arquivoParaBusca(song)}`,
    );
  }

  const backend: MockBackend = {
    _nextPickedFolder: "/musicas/mock",
    _offline: false,
    _enrichDelayMs: 0,
    _lyricsOvhForaDoAr: false,
    _acessorio: {
      publicado: true,
      erro: null,
      atrasoMs: 0,
      pedacos: 4,
      anunciaTotal: true,
      // `estado` é o CACHE, e o cache é persistido: baixou uma vez, o app não
      // pergunta de novo nem depois de reiniciar (regra 3 do PRD V9).
      get estado(): AcessorioInfo["estado"] {
        return estadoDe(ACESSORIO_FPCALC.nome);
      },
      set estado(v: AcessorioInfo["estado"]) {
        state.acessoriosEstado[ACESSORIO_FPCALC.nome] = v;
        save();
      },
    },

    async addFolder(path: string): Promise<ScanResult> {
      let folder = state.folders.find((f) => f.path === path);
      if (!folder) {
        folder = { id: state.nextFolderId++, path, last_scanned_at: null };
        state.folders.push(folder);
      }
      folder.last_scanned_at = new Date().toISOString();

      // pasta "vazia" simula pasta sem nenhum MP3 (PRD F1: ainda é registrada)
      if (path.includes("vazia")) {
        emitProgress(0);
        save();
        return { indexed: 0, skipped: 0, removed: 0, total: 0, missing_folders: [] };
      }

      const fixtures: Array<Omit<SongRecord, "id" | "folder_id">> = [
        {
          file_path: `${path}/com_letra.mp3`,
          title: "Coração Sertanejo",
          artist: "Artista Teste",
          album: null,
          duration_seconds: 3,
          has_lyrics: true,
          available: true,
          lyrics: FIXTURE_LYRICS,
          temas: "água; esperança",
        },
        {
          file_path: `${path}/sem_letra.mp3`,
          title: "Instrumental Sem Letra",
          artist: "Banda Fixture",
          album: null,
          duration_seconds: 2,
          has_lyrics: false,
          available: true,
          lyrics: null,
        },
        {
          file_path: `${path}/sem_tags.mp3`,
          title: "sem_tags",
          artist: null,
          album: null,
          duration_seconds: 2,
          has_lyrics: false,
          available: true,
          lyrics: null,
        },
      ];

      let indexed = 0;
      let skipped = 0;
      for (const fixture of fixtures) {
        const exists = state.songs.some((s) => s.file_path === fixture.file_path);
        if (exists) {
          skipped++;
          continue;
        }
        state.songs.push({ ...fixture, id: state.nextSongId++, folder_id: folder.id });
        indexed++;
      }

      const total = state.songs.filter((s) => s.folder_id === folder.id).length;
      emitProgress(total);
      save();
      return { indexed, skipped, removed: 0, total, missing_folders: [] };
    },

    async removeFolder(folderId: number): Promise<void> {
      state.folders = state.folders.filter((f) => f.id !== folderId);
      removeSongs((s) => s.folder_id === folderId);
      save();
    },

    async listFolders(): Promise<Folder[]> {
      return state.folders.map((f) => ({ ...f }));
    },

    async scan(): Promise<ScanResult> {
      const deleted = new Set(state.deletedFiles);
      const removed = removeSongs((s) => deleted.has(s.file_path));
      const total = state.songs.length;
      emitProgress(total);
      save();
      return { indexed: 0, skipped: total, removed, total, missing_folders: [] };
    },

    async listSongs(): Promise<Song[]> {
      return state.songs.map(toSong);
    },

    async search(query: string): Promise<SearchResult[]> {
      const tokens = tokenize(query);

      // query vazia / só caracteres especiais → biblioteca completa, alfabética
      if (tokens.length === 0) {
        return [...state.songs]
          .sort((a, b) => a.title.localeCompare(b.title))
          .map((song) => ({ song: toSong(song), snippet: null }));
      }

      const matched: Array<{ song: SongRecord; snippet: string | null; rank: number }> = [];
      for (const song of state.songs) {
        if (!matchesAll(songWords(song), tokens)) continue;

        const titleArtistWords = tokenize(`${song.title} ${song.artist ?? ""}`);
        const titleArtistOnly = matchesAll(titleArtistWords, tokens);
        const snippet =
          !titleArtistOnly && song.lyrics ? buildSnippet(song.lyrics, tokens) : null;

        // relevância aproximada do rank FTS5: match em título/artista primeiro
        const titleWords = tokenize(song.title);
        const rank = matchesAll(titleWords, tokens) || titleArtistOnly ? 0 : 1;
        matched.push({ song, snippet, rank });
      }

      matched.sort(
        (a, b) => a.rank - b.rank || a.song.title.localeCompare(b.song.title),
      );
      return matched.map((m) => ({ song: toSong(m.song), snippet: m.snippet }));
    },

    async getLyrics(songId: number): Promise<string | null> {
      const song = state.songs.find((s) => s.id === songId);
      if (!song) {
        throw new Error(`Música não encontrada: id ${songId}`);
      }
      return song.lyrics;
    },

    async fileExists(path: string): Promise<boolean> {
      return !state.deletedFiles.includes(path);
    },

    async createPlaylist(name: string): Promise<number> {
      if (!name.trim()) {
        throw new Error("O nome da playlist não pode ser vazio.");
      }
      const playlist: PlaylistRecord = { id: state.nextPlaylistId++, name };
      state.playlists.push(playlist);
      save();
      return playlist.id;
    },

    async deletePlaylist(playlistId: number): Promise<void> {
      state.playlists = state.playlists.filter((p) => p.id !== playlistId);
      state.playlistItems = state.playlistItems.filter(
        (i) => i.playlist_id !== playlistId,
      );
      save();
    },

    async listPlaylists(): Promise<Playlist[]> {
      return state.playlists.map((p) => ({
        id: p.id,
        name: p.name,
        song_count: state.playlistItems.filter((i) => i.playlist_id === p.id).length,
      }));
    },

    async getPlaylistItems(playlistId: number): Promise<PlaylistItem[]> {
      return state.playlistItems
        .filter((i) => i.playlist_id === playlistId)
        .sort((a, b) => a.position - b.position)
        .flatMap((item) => {
          const song = state.songs.find((s) => s.id === item.song_id);
          if (!song) return [];
          return [
            {
              id: item.id,
              playlist_id: item.playlist_id,
              position: item.position,
              song: toSong(song),
            },
          ];
        });
    },

    async addToPlaylist(playlistId: number, songId: number): Promise<number> {
      const playlist = state.playlists.find((p) => p.id === playlistId);
      if (!playlist) throw new Error(`Playlist não encontrada: id ${playlistId}`);
      const song = state.songs.find((s) => s.id === songId);
      if (!song) throw new Error(`Música não encontrada: id ${songId}`);

      const position = state.playlistItems.filter(
        (i) => i.playlist_id === playlistId,
      ).length;
      const item: PlaylistItemRecord = {
        id: state.nextItemId++,
        playlist_id: playlistId,
        position,
        song_id: songId,
      };
      state.playlistItems.push(item);
      save();
      return item.id;
    },

    async removePlaylistItem(itemId: number): Promise<void> {
      const item = state.playlistItems.find((i) => i.id === itemId);
      if (!item) return;
      state.playlistItems = state.playlistItems.filter((i) => i.id !== itemId);
      renumber(item.playlist_id);
      save();
    },

    async reorderPlaylist(playlistId: number, itemIds: number[]): Promise<void> {
      itemIds.forEach((itemId, idx) => {
        const item = state.playlistItems.find(
          (i) => i.id === itemId && i.playlist_id === playlistId,
        );
        if (item) item.position = idx;
      });
      renumber(playlistId);
      save();
    },

    async pickFolder(): Promise<string | null> {
      return backend._nextPickedFolder;
    },

    fileSrc(filePath: string): string {
      const basename = filePath.split(/[\\/]/).pop() ?? "";
      if (FIXTURE_BASENAMES.includes(basename)) {
        return `/fixtures/${basename}`;
      }
      // fallback tocável para músicas sintéticas/seed
      return "/fixtures/sem_letra.mp3";
    },

    async writeTags(
      songId: number,
      title: string,
      artist: string | null,
      lyrics: string | null,
      temas: string | null,
      instrumental?: boolean | null,
      letraOrigem?: string | null,
    ): Promise<Song> {
      const song = state.songs.find((s) => s.id === songId);
      if (!song) {
        throw new Error(`Música não encontrada: id ${songId}`);
      }
      if (!title.trim()) {
        throw new Error("título vazio");
      }
      if (state.deletedFiles.includes(song.file_path)) {
        throw new Error(`arquivo removido do disco: ${song.file_path}`);
      }
      // grava só as tags — NUNCA renomeia (file_path intocado)
      song.title = title.trim();
      song.artist = artist?.trim() ? artist.trim() : null;
      const letraAnterior = song.lyrics;
      song.lyrics = lyrics?.trim() ? lyrics : null;
      song.has_lyrics = song.lyrics !== null;
      // A marca de origem descreve a letra ATUAL (DECISIONS #54): trocar ou
      // apagar a letra a derruba; repassar a mesma letra (caminho do lote) a
      // preserva. Nunca inventa marca em arquivo que não tinha.
      if (song.lyrics !== letraAnterior) {
        // ALTO-4 — quem grava DECLARA a procedência da letra que está
        // gravando: `null` limpa a marca (comportamento de sempre) e
        // "vagalume" a registra. Sem isso, a letra que o editor aceitou do
        // Vagalume ficava indistinguível de uma do LRCLIB, e o mesmo acervo
        // virava duas pilhas.
        song.letra_origem = letraOrigem ?? null;
      }
      // A marca de instrumental descreve a MÚSICA, não a letra (V8/F17): só a
      // escolha explícita mexe nela. `undefined`/null = "não mexer", e por isso
      // trocar a letra — ou o lote gravando título/artista — não desmarca.
      if (instrumental === true || instrumental === false) {
        song.instrumental = instrumental;
      }
      song.temas = normalizeTemas(temas);
      save();
      return toSong(song);
    },

    async enrichFolderScan(
      folderPrefix: string,
      scanId: string,
    ): Promise<EnrichScanResult> {
      enrichCancelled.delete(scanId);
      // candidatas pré-contadas ANTES do trabalho (como o scan_all): o total
      // do progresso não muda no meio da varredura
      const candidatas = state.songs.filter((song) =>
        candidataDoFunil(song, folderPrefix),
      );

      const total = candidatas.length;
      const proposals: EnrichProposal[] = [];
      // vale para a varredura toda, como o `EstadoDaVarredura` do Rust
      const estado = novoEstadoDaVarredura();
      /**
       * V10 — quem sobrou sem letra, para a pergunta do fim. A lista é montada
       * música a música, e não deduzida das propostas: uma proposta pode ter
       * sido descartada por no-op e a música continuar sem letra.
       */
      const sobraram: Array<{ id: number; duracao: number }> = [];
      /** O objeto do QA A2 — a conta sai do estado, nunca de um zero fixo. */
      const fechar = (propostas: EnrichProposal[]): EnrichScanResult => ({
        propostas,
        sem_perguntar_ao_som: estado.semPerguntarAoSom,
        sem_letra_no_fim: sobraram.map((s) => s.id),
        segundos_de_transcricao: segundosParaTranscrever(
          sobraram.map((s) => s.duracao),
          razaoDestaMaquina(),
        ),
        // QA A1 — o FATO sobre o número, para a tela poder dizer a verdade.
        // No mock a medição só existe depois de uma fila de transcrição ter
        // rodado, que é exatamente quando ela passa a existir no Rust.
        estimativa_medida_nesta_maquina: razaoDestaMaquina() !== RAZAO_DE_REFERENCIA,
      });
      // primeiro evento com done=0 antes de começar: só o total na tela
      // (mesmo contrato do Rust — `atual` vazio nesse evento)
      emitEnrichProgress(scanId, 0, total, "", ETAPA_PREPARANDO);

      for (let i = 0; i < total; i++) {
        const song = candidatas[i];
        // no app real cada música é uma ida ao LRCLIB (segundos)
        if (backend._enrichDelayMs > 0) {
          await new Promise((r) => setTimeout(r, backend._enrichDelayMs));
        }
        // cancelada: para de emitir e resolve sem propostas (M4)
        if (enrichCancelled.has(scanId)) {
          enrichCancelled.delete(scanId);
          return fechar([]);
        }
        const proposta = propostaDoFunil(song, undefined, estado, "varredura");
        // Sobra para a etapa 5 quem continuaria SEM LETRA depois de aplicar
        // tudo o que esta varredura achou. Instrumental não entra (música sem
        // voz não é transcrita, V8/F17), e arquivo sumido também não (QA M3).
        if (aEtapa5TemOQueFazer(song) && proposta.lyrics === null) {
          sobraram.push({ id: song.id, duracao: song.duration_seconds ?? 0 });
        }
        proposals.push(proposta);
        // emitido DEPOIS de cada música, com o nome da que acabou de sair e a
        // etapa em que ela foi resolvida (mesmo ponto do on_progress do Rust)
        emitEnrichProgress(
          scanId,
          i + 1,
          total,
          nomeArquivo(song),
          etapaDaFonte(proposta.fonte),
        );
      }
      enrichCancelled.delete(scanId);
      // propostas sem nada a decidir não chegam à UI (mesmo corte do Rust)
      return fechar(proposals.filter((p) => !propostaNoOp(p)));
    },

    async enrichCount(folderPrefix: string): Promise<Contagem> {
      // MESMA função que a varredura usa (ALTO-2): é o ponto inteiro deste
      // comando existir — a contagem não pode discordar do que vai rodar.
      const candidatas = state.songs.filter((song) =>
        candidataDoFunil(song, folderPrefix),
      );
      const semLetra = candidatas.filter(etapasDeLetraValemAPena).length;
      const som = somAtivo();
      // V10 — a conta inteira mora no backend (DECISIONS #80): a etapa 2 roda
      // em TODAS, as etapas de letra só em quem não tem letra.
      const porMusica = som ? SEGUNDOS_ETAPA_SOM : 0;
      const porMusicaSemLetra = SEGUNDOS_ETAPA_LRCLIB + SEGUNDOS_ETAPA_LYRICS_OVH;
      // a lista de etapas é a das que VÃO rodar nesta máquina (DECISIONS #101).
      // A etapa 4 não tem interruptor: ela não pede chave, então existe em
      // toda máquina com internet (DECISIONS #110).
      const etapas = [ETAPA_NOME_ARQUIVO];
      if (som) etapas.push(ETAPA_IMPRESSAO_DIGITAL);
      etapas.push(ETAPA_LRCLIB, ETAPA_LYRICS_OVH);
      return {
        total: candidatas.length,
        sem_letra: semLetra,
        segundos_estimados: candidatas.length * porMusica + semLetra * porMusicaSemLetra,
        etapas,
        transcricao_disponivel: transcricaoPronta(),
      };
    },

    /**
     * A etapa 5 (V10). Comando à parte, e não uma etapa da varredura: são
     * MINUTOS por música, e a pergunta só pode ser feita no fim.
     *
     * Nada é gravado — o que sai são propostas para a MESMA revisão, inclusive
     * a de marcar instrumental.
     */
    async transcreverMusicas(
      songIds: number[],
      scanId: string,
    ): Promise<TranscricaoResultado> {
      if (!transcricaoPronta()) throw new Error(ERRO_SEM_MODELO);
      enrichCancelled.delete(scanId);
      const total = songIds.length;
      const propostas: EnrichProposal[] = [];
      let audioMedido = 0;
      let relogioMedido = 0;

      emitirProgressoDaTranscricao(scanId, 0, total, "", 0, null);
      for (let feitas = 0; feitas < total; feitas++) {
        // o cancelamento é consultado DENTRO da fila: aqui esperar a próxima
        // música seria esperar minutos por um clique
        if (enrichCancelled.has(scanId)) break;
        const song = state.songs.find((s) => s.id === songIds[feitas]);
        if (!song) continue; // saiu da biblioteca no meio: nada a fazer
        const nome = nomeArquivo(song);
        const restantes = (feitos: number): number | null =>
          feitos > 0
            ? Math.ceil((relogioMedido / feitos) * (total - feitos))
            : null;
        emitirProgressoDaTranscricao(
          scanId,
          feitas,
          total,
          nome,
          0,
          restantes(feitas),
        );
        // uma música leva MINUTOS: sem o progresso DENTRO dela, a barra fica
        // parada tempo demais para parecer viva (a lição da v0.8.1)
        for (const porcento of [25, 50, 75]) {
          if (backend._enrichDelayMs > 0) {
            await new Promise((r) => setTimeout(r, backend._enrichDelayMs));
          }
          emitirProgressoDaTranscricao(
            scanId,
            feitas,
            total,
            nome,
            porcento,
            restantes(feitas),
          );
        }
        const proposta = propostaDaTranscricao(song);
        if (proposta.lyrics !== null || proposta.marcar_instrumental) {
          // só conta como medição o que o motor de fato ouviu
          const duracao = song.duration_seconds ?? 0;
          audioMedido += duracao;
          relogioMedido += duracao * RAZAO_DE_REFERENCIA;
        }
        propostas.push(proposta);
        emitirProgressoDaTranscricao(
          scanId,
          feitas + 1,
          total,
          nome,
          100,
          restantes(feitas + 1),
        );
      }
      enrichCancelled.delete(scanId);
      // QA A1 — a medição VOLTA, e volta por DENTRO: quem a guarda é o
      // backend, e a próxima varredura a lê daqui. Nada é pedido ao frontend.
      if (audioMedido >= AUDIO_MINIMO_PARA_MEDIR) {
        state.medicaoDaTranscricao = {
          audio: (state.medicaoDaTranscricao?.audio ?? 0) + audioMedido,
          relogio: (state.medicaoDaTranscricao?.relogio ?? 0) + relogioMedido,
        };
        save();
      }
      return {
        propostas,
        // os dois são INFORMATIVOS: quem decide o que a tela diz é o booleano
        // da varredura, e nada aqui se multiplica em TypeScript (DECISIONS #80)
        razao_medida: audioMedido > 0 ? relogioMedido / audioMedido : null,
        razao_desta_maquina: razaoDestaMaquina(),
      };
    },

    async onTranscricaoProgresso(
      cb: (p: TranscricaoProgresso) => void,
    ): Promise<() => void> {
      transcricaoProgressListeners.add(cb);
      return () => {
        transcricaoProgressListeners.delete(cb);
      };
    },

    async enrichSongScan(
      songId: number,
      scanId: string | null = null,
      title: string | null = null,
      artist: string | null = null,
    ): Promise<EnrichProposal | null> {
      const song = state.songs.find((s) => s.id === songId);
      if (!song) return null;
      if (scanId) enrichCancelled.delete(scanId);
      // no app real esta é uma ida à rede que pode levar dezenas de segundos
      if (backend._enrichDelayMs > 0) {
        await new Promise((r) => setTimeout(r, backend._enrichDelayMs));
      }
      // B1 — a busca individual é cancelável: com a rede fora do ar ela
      // segurava o editor em "Buscando…" por mais de um minuto, sem saída
      if (scanId && enrichCancelled.has(scanId)) {
        enrichCancelled.delete(scanId);
        return null;
      }
      // O caso pontual é pedido À MÃO, música por música: aqui a marca de
      // instrumental e a completude NÃO excluem ninguém — quem clicou sabe o
      // que quer, e o filtro do lote existe para poupar rede em centenas de
      // arquivos, não para recusar um pedido explícito. (O curto-circuito de
      // letra para instrumental continua DENTRO do funil: é integridade.)
      const proposta = propostaDoFunil(
        song,
        { title, artist },
        undefined,
        "uma-musica",
      );
      // sem letra nova E sem nada a corrigir = procuramos e não veio nada novo
      return propostaNoOp(proposta) ? null : proposta;
    },

    async enrichCancelScan(scanId: string): Promise<void> {
      // marca e sai: a varredura para na próxima música (como o Rust, que
      // checa a flag entre as idas ao LRCLIB)
      enrichCancelled.add(scanId);
    },

    async onEnrichProgress(cb: (p: EnrichProgress) => void): Promise<() => void> {
      enrichProgressListeners.add(cb);
      return () => {
        enrichProgressListeners.delete(cb);
      };
    },

    async enrichApply(aplicacoes: EnrichApply[]): Promise<EnrichApplyResult[]> {
      // NUNCA aborta o lote: cada música grava ou falha individualmente e o
      // resultado volta por música (mesma semântica do backend Rust)
      const results: EnrichApplyResult[] = [];
      for (const ap of aplicacoes) {
        const song = state.songs.find((s) => s.id === ap.song_id);
        if (!song) {
          results.push({
            song_id: ap.song_id,
            song: null,
            error: `música não encontrada: ${ap.song_id}`,
          });
          continue;
        }
        if (state.deletedFiles.includes(song.file_path)) {
          results.push({
            song_id: ap.song_id,
            song: null,
            error: `arquivo não encontrado: ${song.file_path}`,
          });
          continue;
        }
        if (!ap.title.trim()) {
          results.push({ song_id: ap.song_id, song: null, error: "título vazio" });
          continue;
        }
        // A5: a varredura demora minutos; se a música mudou nesse meio-tempo
        // (edição à mão), a proposta está velha e reverteria o trabalho do
        // usuário em silêncio — recusa por música, o lote segue
        if (
          !mesmoValor(song.title, ap.current_title) ||
          !mesmoValor(song.artist, ap.current_artist)
        ) {
          results.push({
            song_id: ap.song_id,
            song: null,
            error:
              `a música mudou depois da busca ("${song.title}") —` +
              " refaça a busca de dados",
          });
          continue;
        }
        // o lote NUNCA apaga: null/vazio preserva o valor atual do arquivo;
        // NUNCA renomeia (file_path intocado)
        song.title = ap.title.trim();
        if (ap.artist?.trim()) {
          song.artist = ap.artist.trim();
        }
        // CRÍTICO-1 — nunca apagar vale também para a LETRA: gravar letra
        // nova por cima de uma que já existe exige o consentimento explícito
        // da revisão. Sem ele o backend recusa, e a linha mostra o que fazer.
        // Repassar a MESMA letra não é substituição (é o caminho do lote que
        // preserva a marca de origem).
        if (
          ap.lyrics?.trim() &&
          song.lyrics !== null &&
          song.lyrics !== ap.lyrics &&
          ap.substituir_letra !== true
        ) {
          results.push({
            song_id: ap.song_id,
            song: null,
            error: RECUSA_LETRA_EXISTENTE,
          });
          continue;
        }
        if (ap.lyrics?.trim()) {
          // Mesma regra do writer: letra diferente invalida a marca de origem
          // e, quando a gravação DECLARA a procedência (V8/F18), grava a nova.
          // Letra do Vagalume fica marcada como tal; qualquer outra fonte
          // limpa a marca — letra oficial nunca é transcrição.
          if (song.lyrics !== ap.lyrics) {
            song.letra_origem = origemDaFonte(ap.fonte);
          }
          song.lyrics = ap.lyrics;
          song.has_lyrics = true;
        }
        // V10 — a marca de instrumental é eco do que a pessoa CONFIRMOU na
        // revisão. Só MARCA: desmarcar continua sendo exclusividade do editor,
        // porque a marca é escolha humana (DECISIONS #71).
        if (ap.marcar_instrumental === true) {
          song.instrumental = true;
        }
        if (ap.add_temas?.trim()) {
          // temas SOMAM aos existentes (normalização deduplica e ordena)
          const joined = song.temas
            ? `${song.temas}; ${ap.add_temas}`
            : ap.add_temas;
          song.temas = normalizeTemas(joined);
        }
        results.push({ song_id: ap.song_id, song: toSong(song), error: null });
      }
      save();
      return results;
    },

    async onScanProgress(cb: (p: ScanProgress) => void): Promise<() => void> {
      progressListeners.add(cb);
      return () => {
        progressListeners.delete(cb);
      };
    },

    // -----------------------------------------------------------------------
    // Acessórios (V9): nada baixa sozinho, e o que não confere não é instalado
    // -----------------------------------------------------------------------

    async acessoriosEstado(): Promise<AcessorioInfo[]> {
      // lista VAZIA = não publicamos binário para esta plataforma. É outra
      // coisa que "ausente", e a tela não pode oferecer download.
      if (!backend._acessorio.publicado) return [];
      return CATALOGO.map((a) => infoDoAcessorio(a));
    },

    async acessorioBaixar(
      nome: string,
      downloadId: string,
    ): Promise<AcessorioDownload> {
      const acessorio = CATALOGO.find((a) => a.nome === nome);
      if (!backend._acessorio.publicado || !acessorio) {
        throw new Error(ERRO_ACESSORIO_DESCONHECIDO);
      }
      if (estadoDe(acessorio.nome) === "indisponivel") {
        // sem a chave do AcoustID compilada nesta build, o acessório não teria
        // o que fazer: MB baixados para nada é pior que não oferecer
        throw new Error(ERRO_ACESSORIO_INDISPONIVEL);
      }
      downloadsCancelados.delete(downloadId);
      const { pedacos, atrasoMs, anunciaTotal } = backend._acessorio;
      const tamanho = acessorio.tamanho_bytes;
      const total = anunciaTotal ? tamanho : null;
      const fatias = Math.max(1, pedacos);
      for (let i = 1; i <= fatias; i++) {
        if (atrasoMs > 0) {
          await new Promise((r) => setTimeout(r, atrasoMs));
        }
        // cancelamento verificado DENTRO do download, não só entre arquivos:
        // eram 5 MB e passaram a ser 180
        if (downloadsCancelados.has(downloadId)) {
          downloadsCancelados.delete(downloadId);
          return { cancelado: true, acessorio: infoDoAcessorio(acessorio) };
        }
        const baixados = Math.round((tamanho * i) / fatias);
        emitirProgressoDoAcessorio({
          nome: acessorio.nome,
          baixados,
          total,
          // V10 — velocidade MEDIDA, e `null` enquanto a amostra é curta
          // demais para render número honesto (DECISIONS #106): no primeiro
          // pedaço a velocidade aparente é absurda, e um "faltam 0 segundos"
          // que dura dez minutos é pior que nenhum número.
          segundos_restantes:
            total === null || i <= 1
              ? null
              : Math.ceil((total - baixados) / BANDA_REFERENCIA_BYTES_S),
          download_id: downloadId,
        });
      }
      // O cache só recebe arquivo CONFERIDO: falha nenhuma deixa binário pela
      // metade em uso — o estado continua exatamente como estava.
      if (backend._acessorio.erro === "soma") {
        throw new Error(ERRO_SOMA_NAO_CONFERE);
      }
      if (backend._acessorio.erro === "rede") {
        throw new Error(ERRO_DOWNLOAD_INTERROMPIDO);
      }
      // As falhas de escrita chegam com a frase do backend, e cada uma termina
      // dizendo o que fazer — porque não há a quem perguntar.
      const falhaDeGravacao = backend._acessorio.erro;
      if (falhaDeGravacao && falhaDeGravacao in ERROS_DE_GRAVACAO) {
        throw new Error(
          ERROS_DE_GRAVACAO[falhaDeGravacao as keyof typeof ERROS_DE_GRAVACAO],
        );
      }
      state.acessoriosEstado[acessorio.nome] = "pronto";
      save();
      return { cancelado: false, acessorio: infoDoAcessorio(acessorio) };
    },

    async acessorioCancelar(downloadId: string): Promise<void> {
      // id desconhecido é no-op silencioso, igual ao cancelamento de varredura
      downloadsCancelados.add(downloadId);
    },

    async onAcessorioProgresso(
      cb: (p: AcessorioProgresso) => void,
    ): Promise<() => void> {
      acessorioProgressListeners.add(cb);
      return () => {
        acessorioProgressListeners.delete(cb);
      };
    },

    _seedSongs(count: number): void {
      let folder = state.folders.find((f) => f.path === "/musicas/seed");
      if (!folder) {
        folder = {
          id: state.nextFolderId++,
          path: "/musicas/seed",
          last_scanned_at: new Date().toISOString(),
        };
        state.folders.push(folder);
      }
      for (let i = 1; i <= count; i++) {
        state.songs.push({
          id: state.nextSongId++,
          file_path: `/musicas/seed/musica_${i}.mp3`,
          folder_id: folder.id,
          title: `Música ${i}`,
          artist: SEED_ARTISTS[(i - 1) % SEED_ARTISTS.length],
          album: null,
          duration_seconds: 120 + (i % 120),
          has_lyrics: true,
          available: true,
          lyrics: seedLyrics(i),
        });
      }
      save();
    },

    _seedFolderTree(): void {
      let folder = state.folders.find((f) => f.path === "/acervo");
      if (!folder) {
        folder = {
          id: state.nextFolderId++,
          path: "/acervo",
          last_scanned_at: new Date().toISOString(),
        };
        state.folders.push(folder);
      }
      const seeds = [
        { file_path: "/acervo/1/a.mp3", title: "Faixa Um" },
        { file_path: "/acervo/2/b.mp3", title: "Faixa Dois" },
      ];
      for (const seed of seeds) {
        if (state.songs.some((s) => s.file_path === seed.file_path)) continue;
        state.songs.push({
          id: state.nextSongId++,
          file_path: seed.file_path,
          folder_id: folder.id,
          title: seed.title,
          artist: null,
          album: null,
          duration_seconds: 2,
          has_lyrics: false,
          available: true,
          lyrics: null,
        });
      }
      save();
    },

    _markAsTranscribed(filePath: string): void {
      const song = state.songs.find((s) => s.file_path === filePath);
      if (!song) return;
      song.letra_origem = ORIGEM_TRANSCRICAO;
      save();
    },

    _ensinarSom(filePath: string, diz: SomDiz): void {
      state.somDiz[filePath] = diz;
      save();
    },

    _ensinarFalhaDoSom(filePath: string, mensagem: string): void {
      state.somFalha[filePath] = mensagem;
      save();
    },

    _estadoDoAcessorio(nome: string, estado: AcessorioInfo["estado"]): void {
      state.acessoriosEstado[nome] = estado;
      save();
    },

    _ensinarTranscricao(filePath: string, saida: SaidaDaTranscricao): void {
      state.transcricoes[filePath] = saida;
      save();
    },

    _forcarTituloVazio(filePath: string): void {
      const song = state.songs.find((s) => s.file_path === filePath);
      if (!song) return;
      song.title = "";
      save();
    },

    _markAsInstrumental(filePath: string): void {
      const song = state.songs.find((s) => s.file_path === filePath);
      if (!song) return;
      song.instrumental = true;
      save();
    },

    _removeFileFromDisk(filePath: string): void {
      if (!state.deletedFiles.includes(filePath)) {
        state.deletedFiles.push(filePath);
      }
      save();
    },

    _reset(): void {
      state = freshState();
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        // ignora storage indisponível
      }
    },
  };

  return backend;
}

/** Instala o mock na global lida por getBackend() (src/lib/api.ts). */
export function installMockBackend(): MockBackend {
  const backend = createMockBackend();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__CANCIONEIRO_MOCK__ = backend;
  return backend;
}
