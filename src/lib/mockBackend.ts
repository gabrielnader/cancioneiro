import type {
  AcessorioDownload,
  AcessorioInfo,
  AcessorioProgresso,
  Backend,
  EnrichApply,
  EnrichApplyResult,
  EnrichProgress,
  EnrichProposal,
} from "./api";
import type { Modo } from "./types";
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
import { ORIGEM_TRANSCRICAO, ORIGEM_VAGALUME } from "./types";

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
   * Simula uma chave do Vagalume recusada pelo serviço (HTTP 401): a etapa 3
   * falha com `ERRO_CHAVE_RECUSADA` e, como no Rust, desliga-se pelo resto da
   * varredura — a primeira música avisa, as seguintes pulam em silêncio.
   */
  _vagalumeKeyRecusada: boolean;
  /** Popula a pasta /acervo com subpastas 1/ e 2/ para o E2E da árvore (V4 F11). */
  _seedFolderTree(): void;
  /**
   * O acessório desta "máquina" (V9). `estado` é o cache de verdade — ele
   * persiste, como o arquivo sob o perfil do usuário: baixou uma vez, o app
   * não pergunta de novo nem depois de reiniciar. O resto são botões de teste.
   */
  _acessorio: {
    /** false = não publicamos binário para esta plataforma → lista vazia. */
    publicado: boolean;
    estado: AcessorioInfo["estado"];
    /** Desfecho do próximo download; null = instala normalmente. */
    erro: "soma" | "rede" | null;
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
}

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
   * Cache do acessório (V9). Persistido junto do resto porque é isso que ele
   * é no produto: um arquivo sob o perfil do usuário, que sobrevive ao
   * reinício — "baixou uma vez, não pergunta de novo".
   */
  acessorioEstado: AcessorioInfo["estado"];
  /** O que o som responde, por arquivo. Permanente, como o próprio áudio. */
  somDiz: Record<string, SomDiz>;
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
    acessorioEstado: "ausente",
    somDiz: {},
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
const FONTE_ARQUIVO = "nome do arquivo";
/** Etapa 2 (V9): a identidade veio do SOM, não de etiqueta nem de base de letra. */
const FONTE_IMPRESSAO_DIGITAL = "reconhecimento pelo som";
const FONTE_LRCLIB = "LRCLIB";
const FONTE_VAGALUME = "Vagalume";
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
const ACESSORIO_FPCALC = {
  nome: "fpcalc" as const,
  para_que_serve: "reconhecer a música pelo som",
  arquivo: "fpcalc-linux-x86_64",
  tamanho_bytes: 5_538_312,
  origem:
    "https://github.com/gabrielnader/cancioneiro/releases/download/acessorios-v1/fpcalc-linux-x86_64",
};

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
 * Recusa do apply quando a gravação trocaria uma letra que já existe sem o
 * consentimento explícito da revisão (CRÍTICO-1). Texto idêntico ao do Rust:
 * ele aparece na linha, e é o único lugar onde a pessoa vai ler o que fazer.
 */
/**
 * Chave do Vagalume rejeitada pelo serviço — mesmo texto do
 * `vagalume::ERRO_CHAVE_RECUSADA`. É o único erro de rede que vale para a
 * varredura INTEIRA: os outros ("fora do ar", "espere um pouco") podem ter
 * sido soluço, e a música seguinte merece a tentativa.
 */
const ERRO_CHAVE_RECUSADA =
  "a chave do Vagalume foi recusada — confira se copiou a chave inteira";

const RECUSA_LETRA_EXISTENTE =
  'esta música já tem letra — marque "substituir a letra atual" para trocá-la';

// ---------------------------------------------------------------------------
// Placeholders — porte do `is_placeholder` do Rust (que por sua vez porta o
// `eh_placeholder` do tools/curadoria.py). Tag placeholder vale VAZIO em todo
// ponto: não é palpite, não abre o Vagalume e NÃO marca a música como
// completa. Foi por não olhar isto que a contagem do app dava zero num CD
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
 * Porte COMPLETO do `enrich::is_placeholder` (que por sua vez porta o
 * `eh_placeholder` do `tools/curadoria.py`). Exportado porque quatro regras
 * da V9 dependem dele e porque o contrato com o Rust é testado caso a caso
 * em `mockBackend.contrato.test.ts` (DECISIONS #88).
 */
export function isPlaceholder(texto: string): boolean {
  const chave = chaveDeTag(texto);
  if (chave === "" || soDigitos(chave)) return true;
  if (PLACEHOLDERS_EXATOS.has(chave)) return true;
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

/** A tag como o funil a enxerga: placeholder vira string vazia. */
function tagReal(texto: string | null | undefined): string {
  const t = (texto ?? "").trim();
  return isPlaceholder(t) ? "" : t;
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
 * etapa 3 existe para atender — é assim que o mock ganha um caminho de
 * Vagalume sem contrariar a regra real (título E artista de verdade).
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
  if (fonte === FONTE_IMPRESSAO_DIGITAL) return "reconhecendo pelo som";
  if (fonte === FONTE_LRCLIB) return "procurando no LRCLIB";
  if (fonte === FONTE_VAGALUME) return "procurando no Vagalume";
  return "lendo etiquetas e nome do arquivo";
}

/**
 * Valor EFETIVO de um campo (`enrich::campo_efetivo`): espaços aparados e
 * placeholder tratado como VAZIO, dos DOIS lados da comparação. Sem isso,
 * "AudioTrack 17" contra o palpite "Faixa" passava por mudança.
 */
function campoEfetivo(texto: string | null | undefined): string {
  return tagReal(texto ?? "");
}

function propostaNoOp(p: EnrichProposal): boolean {
  return (
    p.error === null &&
    // a linha de conflito existe JUSTAMENTE porque nada muda: nela o proposto
    // repete o atual, e é a divergência que precisa ser vista (V9)
    p.conflito === null &&
    p.lyrics === null &&
    campoEfetivo(p.proposed_title) === campoEfetivo(p.current_title) &&
    campoEfetivo(p.proposed_artist) === campoEfetivo(p.current_artist)
  );
}

/**
 * Acima disto, duas grafias são o MESMO nome ("Milionário & José Rico" x
 * "Milionário y José Rico"). Calibrado no acervo real de 94 arquivos, onde
 * 6 dos 8 conflitos eram a mesma música escrita de outro jeito.
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

/** Bigramas de caracteres COM multiplicidade (`lyrics_fetch::bigrams`). */
function bigramas(s: string): Map<string, number> {
  const mapa = new Map<string, number>();
  const chars = [...s];
  for (let i = 0; i + 1 < chars.length; i++) {
    const par = chars[i] + chars[i + 1];
    mapa.set(par, (mapa.get(par) ?? 0) + 1);
  }
  return mapa;
}

/**
 * Similaridade textual em [0, 1]: coeficiente de Dice sobre bigramas de
 * caracteres das chaves normalizadas. Porte do `lyrics_fetch::similarity`.
 */
function similaridade(bruto1: string, bruto2: string): number {
  const a = chaveDeTag(bruto1);
  const b = chaveDeTag(bruto2);
  if (a === b) return a === "" ? 0 : 1;
  const [ba, bb] = [bigramas(a), bigramas(b)];
  const soma = (m: Map<string, number>) => [...m.values()].reduce((x, y) => x + y, 0);
  const [na, nb] = [soma(ba), soma(bb)];
  if (na === 0 || nb === 0) return 0; // uma das chaves tem < 2 chars e diferem
  let inter = 0;
  for (const [par, n] of ba) inter += Math.min(n, bb.get(par) ?? 0);
  return (2 * inter) / (na + nb);
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
export function discordaDoSom(atual: string, identificado: string): boolean {
  if (isPlaceholder(atual) || isPlaceholder(identificado)) return false;
  const a = chaveDeTag(atual);
  const b = chaveDeTag(identificado);
  if (a === b) return false;
  const [curta, longa] = a.length <= b.length ? [a, b] : [b, a];
  if ([...curta].length >= MIN_CONTENCAO && longa.includes(curta)) return false;
  return similaridade(a, b) < LIMIAR_MESMA_GRAFIA;
}

export function createMockBackend(): MockBackend {
  let state = loadState();
  const progressListeners = new Set<(p: ScanProgress) => void>();
  const enrichProgressListeners = new Set<(p: EnrichProgress) => void>();
  const acessorioProgressListeners = new Set<(p: AcessorioProgresso) => void>();
  /** Varreduras que pediram cancelamento e ainda não pararam (M4). */
  const enrichCancelled = new Set<string>();
  /** Downloads de acessório que pediram cancelamento (mesma disciplina). */
  const downloadsCancelados = new Set<string>();

  /** O acessório desta máquina, como a tela precisa vê-lo. */
  function infoDoAcessorio(): AcessorioInfo {
    return { ...ACESSORIO_FPCALC, estado: state.acessorioEstado };
  }

  function emitirProgressoDoAcessorio(p: AcessorioProgresso): void {
    acessorioProgressListeners.forEach((cb) => cb(p));
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
  function candidataDoFunil(
    song: SongRecord,
    folderPrefix: string,
    modo: Modo,
  ): boolean {
    if (!song.available) return false;
    // prefixo casa na FRONTEIRA de separador ("/m/1" não casa "/m/10/a.mp3"),
    // como isUnderFolder e o backend Rust
    if (folderPrefix && !isUnderFolder(song.file_path, folderPrefix)) return false;
    // V9 — na conferência o filtro NÃO se aplica: o trabalho ali é perguntar
    // ao som se a etiqueta está certa, e a música que mais precisa dessa
    // pergunta é justamente a que PARECE completa e está errada. Um `if` no
    // mesmo lugar, não uma segunda função (a regra de quem é candidata é UMA).
    if (modo === "conferencia") return true;
    const nomesProntos = tagReal(song.title) !== "" && tagReal(song.artist) !== "";
    const completa = nomesProntos && (song.instrumental === true || song.has_lyrics);
    return !completa;
  }

  /** A etapa 2 existe nesta máquina? Só com o acessório conferido e pronto. */
  function somAtivo(): boolean {
    return backend._acessorio.publicado && state.acessorioEstado === "pronto";
  }

  /**
   * O funil inteiro para UMA música (V8/F18), na ordem de custo crescente:
   * o que já está no arquivo → LRCLIB → Vagalume (só com chave). É o mesmo
   * caminho para o lote e para o caso pontual do editor — duas implementações
   * divergiriam, e é justamente a procedência que a pessoa usa para decidir.
   *
   * `digitado` são o título/artista VIVOS do editor, quando existem: quem
   * clicou já corrigiu a etiqueta errada, e procurar pela etiqueta velha era
   * um beco sem saída com cara de "a internet não tem a minha música".
   */
  function propostaDoFunil(
    song: SongRecord,
    vagalumeKey: string | null,
    digitado?: { title?: string | null; artist?: string | null },
    /** Estado da VARREDURA (não da música): a chave já foi recusada? */
    estado: { chaveRecusada: boolean } = { chaveRecusada: false },
    modo: Modo = "completar",
  ): EnrichProposal {
    const proposta = passarPeloFunil(song, vagalumeKey, digitado, estado, modo);
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
    const trocaria = (escrito: string, proposto: string | null): boolean => {
      const a = campoEfetivo(escrito);
      const b = campoEfetivo(proposto);
      return a !== "" && b !== "" && a !== b;
    };
    return (
      trocaria(tituloEscrito(song, digitado?.title), p.proposed_title) ||
      trocaria(tagReal(digitado?.artist ?? song.artist), p.proposed_artist)
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
    return tagReal(digitado ?? song.title);
  }

  function passarPeloFunil(
    song: SongRecord,
    vagalumeKey: string | null,
    digitado: { title?: string | null; artist?: string | null } | undefined,
    estado: { chaveRecusada: boolean },
    modo: Modo,
  ): EnrichProposal {
    const tituloTag = tagReal(digitado?.title ?? song.title);
    const artistaTag = tagReal(digitado?.artist ?? song.artist);
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
        ...base,
        proposed_title: tituloDeTag || guessTitle || song.title,
        proposed_artist: artistaTag || guessArtist,
        lyrics: null,
        confidence: "baixa",
        fonte: error !== null ? FONTE_ERRO : FONTE_ARQUIVO,
        conflito: null,
        substitui_nome_escrito: false,
        error,
      };
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
    if (somAtivo()) {
      const diz = state.somDiz[song.file_path];
      if (diz) {
        if (
          discordaDoSom(tituloEscrito(song, digitado?.title), diz.titulo) ||
          discordaDoSom(artistaTag, diz.artista)
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
        campoEfetivo(identidade.titulo) !== campoEfetivo(p.current_title) ||
        campoEfetivo(identidade.artista) !== campoEfetivo(p.current_artist);
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

    // A conferência é UM trabalho — perguntar ao som —, e termina aqui.
    if (modo === "conferencia") return propostaDaIdentidade();

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
        error: null,
      };
    }

    // --- etapa 4: Vagalume, só com chave E com as DUAS tags reais ----------
    //
    // A regra é a do enrich.rs: o Vagalume não tem duração, e a igualdade de
    // palavras dos dois lados é a única prova que existe — ela precisa de um
    // pedido que já signifique alguma coisa. Palpite de nome de arquivo não é
    // isso. E o caminho NUNCA propõe nome novo: a letra é a mudança inteira
    // (DECISIONS #63 — "Ponto de Ogum" dentro de "Ponto de Oxum").
    if (vagalumeKey && tituloBusca && artistaBusca && !estado.chaveRecusada) {
      if (backend._vagalumeKeyRecusada) {
        // veredito sobre a varredura inteira: registra e desliga a etapa —
        // repetir o mesmo aviso em 95 linhas não informa ninguém, e insistir
        // seria bater num serviço que já disse não
        estado.chaveRecusada = true;
        erro = ERRO_CHAVE_RECUSADA;
        return propostaDaIdentidade();
      }
      return {
        ...base,
        proposed_title: tituloBusca,
        proposed_artist: artistaBusca,
        lyrics: FIXTURE_LYRICS,
        confidence: "media",
        fonte: FONTE_VAGALUME,
        conflito: null,
        substitui_nome_escrito: false,
        error: null,
      };
    }

    // resto: só o que as etapas 1 e 2 acharam
    return propostaDaIdentidade();
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
    _vagalumeKeyRecusada: false,
    _acessorio: {
      publicado: true,
      erro: null,
      atrasoMs: 0,
      pedacos: 4,
      anunciaTotal: true,
      // `estado` é o CACHE, e o cache é persistido: baixou uma vez, o app não
      // pergunta de novo nem depois de reiniciar (regra 3 do PRD V9).
      get estado(): AcessorioInfo["estado"] {
        return state.acessorioEstado;
      },
      set estado(v: AcessorioInfo["estado"]) {
        state.acessorioEstado = v;
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
      vagalumeKey: string | null = null,
      // ausente vale "completar", como o Modo::default do Rust: esquecer o
      // campo nunca dispara a varredura que lê o áudio de todas as músicas
      modo: Modo = "completar",
    ): Promise<EnrichProposal[]> {
      enrichCancelled.delete(scanId);
      // candidatas pré-contadas ANTES do trabalho (como o scan_all): o total
      // do progresso não muda no meio da varredura
      const candidatas = state.songs.filter((song) =>
        candidataDoFunil(song, folderPrefix, modo),
      );

      const total = candidatas.length;
      const proposals: EnrichProposal[] = [];
      // vale para a varredura toda, como o `chave_recusada` do Rust
      const estado = { chaveRecusada: false };
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
          return [];
        }
        const proposta = propostaDoFunil(
          song,
          vagalumeKey,
          undefined,
          estado,
          modo,
        );
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
      return proposals.filter((p) => !propostaNoOp(p));
    },

    async enrichCount(
      folderPrefix: string,
      modo: Modo = "completar",
    ): Promise<number> {
      // MESMA função que a varredura usa (ALTO-2): é o ponto inteiro deste
      // comando existir — a contagem não pode discordar do que vai rodar. E
      // isso vale por MODO: a conferência olha outra população.
      return state.songs.filter((song) =>
        candidataDoFunil(song, folderPrefix, modo),
      ).length;
    },

    async enrichSongScan(
      songId: number,
      vagalumeKey: string | null = null,
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
      const proposta = propostaDoFunil(song, vagalumeKey, { title, artist });
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
            song.letra_origem =
              ap.fonte?.toLowerCase() === "vagalume" ? ORIGEM_VAGALUME : null;
          }
          song.lyrics = ap.lyrics;
          song.has_lyrics = true;
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
      return [infoDoAcessorio()];
    },

    async acessorioBaixar(
      nome: string,
      downloadId: string,
    ): Promise<AcessorioDownload> {
      if (!backend._acessorio.publicado || nome !== ACESSORIO_FPCALC.nome) {
        throw new Error(ERRO_ACESSORIO_DESCONHECIDO);
      }
      if (state.acessorioEstado === "indisponivel") {
        // sem a chave do AcoustID compilada nesta build, o acessório não teria
        // o que fazer: 5 MB baixados para nada é pior que não oferecer
        throw new Error(ERRO_ACESSORIO_INDISPONIVEL);
      }
      downloadsCancelados.delete(downloadId);
      const { pedacos, atrasoMs, anunciaTotal } = backend._acessorio;
      const tamanho = ACESSORIO_FPCALC.tamanho_bytes;
      const total = anunciaTotal ? tamanho : null;
      for (let i = 1; i <= Math.max(1, pedacos); i++) {
        if (atrasoMs > 0) {
          await new Promise((r) => setTimeout(r, atrasoMs));
        }
        // cancelamento verificado DENTRO do download, não só entre arquivos:
        // são 5 MB hoje e 180 MB na versão seguinte
        if (downloadsCancelados.has(downloadId)) {
          downloadsCancelados.delete(downloadId);
          return { cancelado: true, acessorio: infoDoAcessorio() };
        }
        emitirProgressoDoAcessorio({
          nome: ACESSORIO_FPCALC.nome,
          baixados: Math.round((tamanho * i) / Math.max(1, pedacos)),
          total,
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
      state.acessorioEstado = "pronto";
      save();
      return { cancelado: false, acessorio: infoDoAcessorio() };
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
