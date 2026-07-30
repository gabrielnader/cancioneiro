import type {
  Folder,
  Playlist,
  PlaylistItem,
  ScanProgress,
  ScanResult,
  SearchResult,
  Song,
} from "./types";

/**
 * O outro lado de uma divergência (V9): o que o SOM diz que esta música é.
 *
 * `confianca` é a do RECONHECIMENTO acústico, não a da linha — a linha é
 * sempre "baixa", justamente para nunca chegar pré-marcada.
 */
export interface Conflito {
  titulo: string;
  artista: string;
  confianca: "alta" | "media";
}

/**
 * Proposta de enriquecimento em lote (F13 — PRD V5), espelhando o struct
 * Rust EnrichProposal (serde sem rename: chaves snake_case no JSON).
 */
export interface EnrichProposal {
  song_id: number;
  file_path: string;
  current_title: string;
  current_artist: string | null;
  proposed_title: string;
  proposed_artist: string | null;
  /** Letra achada no LRCLIB (vem na proposta — o apply não volta à rede). */
  lyrics: string | null;
  /**
   * A música JÁ TEM letra no arquivo. Com `lyrics` não-nulo isto significa
   * uma coisa só, e é a mais grave da tela: aplicar esta linha SUBSTITUIRIA
   * uma letra que já existe (CRÍTICO-1 do QA — uma transcrição corrigida à
   * mão foi destruída por um clique em "Aplicar selecionadas").
   */
  has_lyrics: boolean;
  /**
   * Procedência da letra ATUAL (o mesmo `TXXX:LETRA_ORIGEM` da Song):
   * "transcricao" = escrita ouvindo o áudio. Decide o texto do aviso — quem
   * cura precisa saber que tipo de trabalho o clique apagaria.
   */
  letra_origem: string | null;
  confidence: "alta" | "media" | "baixa";
  /**
   * De ONDE o dado veio, em pt-BR e pronto para exibir ("LRCLIB",
   * "lyrics.ovh", "nome do arquivo", "transcrição do áudio") — V8/F18. Quem
   * cura decide olhando a procedência: a
   * mesma confiança significa coisas diferentes vindo de um banco com duração
   * conferida ou de um palpite de nome de arquivo.
   */
  fonte: string;
  /**
   * O SOM discorda de uma etiqueta REAL do arquivo (V9). Preenchido, a linha
   * existe para INFORMAR: `proposed_*` repete o que já está lá, `confidence` é
   * sempre "baixa" e nenhuma etapa de letra chegou a rodar. A UI mostra os
   * DOIS lados e a pessoa decide — aceitar o som volta pelo `enrich_apply`
   * como qualquer outra edição, com `title`/`artist` vindos daqui.
   */
  conflito: Conflito | null;
  /**
   * Aceitar esta linha trocaria um título ou artista que uma PESSOA escreveu
   * (V9). Não é erro e não bloqueia nada — o `apply` não recusa: é informação
   * para a pré-marcação.
   *
   * É a DECISIONS #79 do lado das etiquetas. O LRCLIB devolve a grafia
   * oficial, "Ponto de Oxum" volta como "Ponto de Oxum (Ao Vivo)", a duração
   * bate, portanto ALTA, portanto pré-marcada — e um clique em "Aplicar
   * selecionadas" apagaria a curadoria de quem digitou aquilo à mão. Preencher
   * campo vazio, trocar "Faixa 03" e corrigir o título que o indexador copiou
   * do nome do arquivo (DECISIONS #91) NÃO disparam este campo: continuam
   * pré-marcáveis, que é para isso que a varredura existe.
   *
   * Ortogonal ao `conflito`: a linha de conflito não propõe troca nenhuma e
   * sai daqui com `false`.
   */
  substitui_nome_escrito: boolean;
  /**
   * V10 — a etapa 5 ouviu o áudio inteiro e não achou voz: esta música é
   * INSTRUMENTAL. É PROPOSTA, não gravação: a marca tira o arquivo da fila de
   * letra para sempre (vence até o `--forcar-tudo` do lado Python) e só o
   * editor a desfaz. Quem grava é o `apply`, com o `marcar_instrumental` que a
   * pessoa confirmou.
   */
  marcar_instrumental: boolean;
  /**
   * V10 — o trecho mais repetido da letra que a máquina escreveu.
   *
   * Só informação, e com um uso prático: quem vai conferir 47 letras escritas
   * por máquina precisa reconhecer a música de relance, SEM abrir cada uma. O
   * refrão nunca vira consulta nem nome proposto — a identificação por ele
   * ficou de fora por medição (DECISIONS #74 e #103).
   */
  refrao: string | null;
  /**
   * V10 — explicação de uma linha que a pessoa PODE aplicar, ao contrário do
   * `error`, que descreve uma linha que ela não pode.
   *
   * Nasceu do instrumental: "20 caracteres em 5m00s de áudio dão 0,07, abaixo
   * do mínimo de 0,30" é a única explicação que alguém vai receber para uma
   * marca definitiva. Pôr isso em `error` desabilitaria justamente a linha que
   * precisa de um clique.
   */
  aviso: string | null;
  /** Erro por música (ex.: "sem conexão") — a linha fica desabilitada. */
  error: string | null;
}

/**
 * O que uma varredura em LOTE devolve — espelha `enrich::EnrichScanResult`.
 *
 * **Era um array puro de propostas até a v0.9.0**, e por isso não havia onde
 * dizer que a etapa do som tinha sido desligada no meio: quem mandou conferir
 * 150 músicas via UMA linha de erro e 149 linhas em branco, e lia o silêncio
 * como aprovação (QA A2). "Não sabemos" precisa ser um estado (DECISIONS #86),
 * e para isso precisa existir um campo.
 *
 * O `enrich_song_scan` (uma música só) NÃO mudou: lá não há "resto da
 * varredura" para desligar.
 */
export interface EnrichScanResult {
  propostas: EnrichProposal[];
  /**
   * Músicas que teriam sido perguntadas ao som e não foram, porque a etapa 2
   * se desligou antes de chegar nelas. **Zero é o caso normal** e não merece
   * texto na tela.
   */
  sem_perguntar_ao_som: number;
  /**
   * V10 — quem chegou ao FIM da varredura ainda sem letra, em ids. É
   * exatamente o que `transcreverMusicas` recebe: a regra de quem sobrou é UMA
   * e mora no backend (DECISIONS #80), e por isso a lista vem pronta em vez de
   * ser deduzida das propostas aqui. Música instrumental não entra.
   */
  sem_letra_no_fim: number[];
  /**
   * Segundos estimados para transcrever essas músicas nesta máquina. A conta é
   * TODA do Rust (DECISIONS #80 e #106): ele usa a razão medida quando já há
   * amostra que baste, e a de referência enquanto não há.
   */
  segundos_de_transcricao: number;
  /**
   * **O número acima é medição desta máquina, ou palpite de fábrica?**
   *
   * Existe para a tela poder dizer a verdade, e só para isso: com `true` a
   * pergunta do fim devolve o "neste computador" que o PRD escreveu; com
   * `false` ela mantém a ressalva de que pode levar mais. Sem este campo a
   * frase honesta seria sempre a pior das duas (DECISIONS #86).
   *
   * É um FATO sobre o número, e não o número: a razão não volta para o
   * TypeScript porque nada aqui se multiplica com ela (DECISIONS #80).
   */
  estimativa_medida_nesta_maquina: boolean;
}

/**
 * O que a etapa 5 (`transcrever_musicas`) devolve — as propostas vão para a
 * MESMA revisão da varredura, inclusive a de marcar instrumental.
 */
export interface TranscricaoResultado {
  propostas: EnrichProposal[];
  /**
   * Segundos de relógio por segundo de ÁUDIO medidos NESTA execução, quando
   * houve o que medir.
   *
   * **Puramente informativo — não guarde e não recalcule** (QA A1). A v0.10.0
   * pedia ao frontend que guardasse este número e o mandasse de volta, e o
   * frontend o descartava: a promessa da DECISIONS #106 ficou desligada sem
   * ninguém notar, porque não havia consumidor. Quem guarda agora é o backend,
   * no banco, ao fim da fila — não há nada a devolver.
   */
  razao_medida: number | null;
  /**
   * A razão que passa a valer nas próximas estimativas: a acumulada desta
   * máquina, ou a de referência enquanto a amostra é curta. Informativa pelo
   * mesmo motivo — quem decide o que a tela DIZ é o booleano
   * `estimativa_medida_nesta_maquina` da varredura, não este número.
   */
  razao_desta_maquina: number;
}

/**
 * Progresso da etapa 5 (evento Tauri `transcricao:progresso`).
 *
 * `porcento_da_musica` existe porque UMA música leva minutos: uma barra que só
 * anda entre arquivos fica parada tempo demais para parecer viva, e a v0.8.1
 * já ensinou o preço de deixar a pessoa olhando para uma tela sem sinal de
 * vida (DECISIONS #92).
 */
export interface TranscricaoProgresso {
  done: number;
  total: number;
  /** Nome-base do arquivo em transcrição (vazio no evento inicial). */
  atual: string;
  porcento_da_musica: number;
  /**
   * Quanto falta da FILA inteira, pela velocidade MEDIDA. `null` enquanto
   * nenhuma música terminou: antes disso não há o que medir, e número
   * inventado é pior que número nenhum (DECISIONS #85 e #86).
   */
  segundos_restantes: number | null;
  /** Mesma disciplina do `scan_id` do funil: evento alheio é descartado. */
  scan_id: string;
}

/**
 * O tamanho do trabalho que a varredura vai dar — o que `enrich_count`
 * devolve desde a V10 (era um número).
 *
 * **A conta mora toda no Rust.** Havia um modelo de custo em TypeScript aqui
 * (`SEGUNDOS_POR_MUSICA` e a contagem de candidatas), e ele divergiu duas
 * vezes: uma zerou a contagem e deixou o único ponto de entrada do produto
 * cinza (DECISIONS #80), a outra errou a etapa do som por 7x (DECISIONS #102).
 * O frontend recebe o número pronto e só o formata.
 */
export interface Contagem {
  /** Músicas que a varredura vai OLHAR — todas as disponíveis da pasta. */
  total: number;
  /** Destas, quantas não têm letra: as únicas que passam pelas etapas 3 e 4. */
  sem_letra: number;
  /** Segundos estimados da varredura inteira, com as etapas desta máquina. */
  segundos_estimados: number;
  /** As etapas que VÃO rodar, em pt-BR e na ordem do funil (DECISIONS #101). */
  etapas: string[];
  /**
   * A etapa 5 pode ser oferecida nesta máquina (transcritor E modelo prontos)?
   * É o que decide se a pergunta do fim oferece o trabalho ou o download —
   * combinar dois estados de acessório é regra, e regra duplicada diverge.
   */
  transcricao_disponivel: boolean;
}

/**
 * Progresso da varredura do "Completar dados" (F13): o backend emite o evento
 * Tauri `enrich:progress` a cada música (chaves snake_case, como o serde do
 * struct Rust). O PRIMEIRO evento chega com done=0, antes de o trabalho
 * começar — é o que troca o spinner indeterminado pela barra determinada.
 */
export interface EnrichProgress {
  done: number;
  total: number;
  /** Nome-base do arquivo em processamento (sem diretório). */
  atual: string;
  /**
   * Etapa do funil em curso, em pt-BR e pronta para exibir (V8/F18) — o PRD
   * exige "a etapa atual do funil" junto da contagem. Pode vir vazia (backend
   * antigo): a UI simplesmente não mostra a linha.
   */
  etapa: string;
  /**
   * Varredura que emitiu o evento. A UI IGNORA evento de scan_id diferente do
   * atual: uma varredura cancelada continua respondendo por alguns segundos e
   * estragava a barra da varredura seguinte (M4).
   */
  scan_id: string;
}

/**
 * Aplicação aceita pelo usuário (F13). `null` em artist/lyrics/add_temas =
 * "não mexer" — o lote nunca apaga dados existentes.
 */
export interface EnrichApply {
  song_id: number;
  title: string;
  artist: string | null;
  lyrics: string | null;
  add_temas: string | null;
  /**
   * Título/artista que a VARREDURA viu (ecoados da proposta). O backend recusa
   * a gravação se a música mudou desde então — senão uma proposta velha
   * reverteria em silêncio a edição feita à mão durante a varredura (A5).
   */
  current_title: string;
  current_artist: string | null;
  /**
   * Eco do `fonte` da proposta (V8/F18): é ele que decide a procedência
   * gravada em `TXXX:LETRA_ORIGEM`. Letra do `lyrics.ovh` e letra da etapa 5
   * ficam marcadas como tais; qualquer outra fonte LIMPA a marca — letra
   * oficial nunca é transcrição (DECISIONS #54). Ausente, o backend não grava
   * procedência nenhuma: nunca grava a errada.
   */
  fonte: string | null;
  /**
   * Consentimento EXPLÍCITO para gravar `lyrics` por cima de uma letra que já
   * existe no arquivo. Ausente/false: o backend recusa a gravação com
   * `esta música já tem letra — marque "substituir a letra atual" para
   * trocá-la`, em vez de apagar em silêncio (CRÍTICO-1).
   *
   * A UI só o manda quando a segunda marcação da linha — separada da
   * marcação de aplicar, e sempre desmarcada por padrão — está marcada.
   */
  substituir_letra?: boolean;
  /**
   * V10 — marca esta música como INSTRUMENTAL (eco do
   * `EnrichProposal.marcar_instrumental`, confirmado por quem revisou). Só
   * MARCA: desmarcar continua sendo exclusividade do editor, porque a marca é
   * escolha humana e nenhuma rotina a desfaz sozinha (DECISIONS #71).
   */
  marcar_instrumental?: boolean;
}

/**
 * Resultado POR MÚSICA do enrich_apply (chaves snake_case, como no serde do
 * struct Rust): o lote nunca aborta no meio — cada aplicação grava ou falha
 * individualmente.
 */
export interface EnrichApplyResult {
  song_id: number;
  /** Não-nulo = gravada e reindexada. */
  song: Song | null;
  /** Não-nulo = falhou nesta música (ex.: "arquivo não encontrado: …"). */
  error: string | null;
}

// ---------------------------------------------------------------------------
// Acessórios (PRD V9 — F18 fase 2): binários que não cabem no instalador
// ---------------------------------------------------------------------------

/**
 * Um acessório como a tela precisa vê-lo: tudo que a regra 1 do PRD V9 manda
 * dizer ANTES de baixar ("o que vai baixar, quanto ocupa"), mais o estado.
 */
export interface AcessorioInfo {
  /**
   * Identidade estável, e o que `acessorioBaixar` recebe. Eram um só até a
   * v0.9.0; a V10 acrescenta o transcritor e o modelo que ele consulta, e a
   * V10.2 um segundo modelo — maior e melhor — que o backend PREFERE quando
   * está baixado. Os dois convivem por uma rodada só, até a medição no acervo
   * real dizer qual fica; um dos dois será removido.
   *
   * A tela não escolhe: ela desenha um cartão por item do catálogo, e quem
   * decide qual modelo roda é o backend. Este tipo existe só para o
   * `acessorioBaixar` não receber um nome inventado — quando ele descrever
   * MENOS do que o backend devolve, é divergência nascendo (decisão 88).
   */
  nome:
    | "fpcalc"
    | "whisper-cli"
    | "modelo-de-transcricao"
    | "modelo-de-transcricao-grande";
  /**
   * Para que serve, em pt-BR e PRONTO PARA EXIBIR. Vem do backend de propósito:
   * quem cura não sabe o que é "impressão digital acústica", e a frase que
   * explica isso não pode ficar duplicada em duas linguagens.
   */
  para_que_serve: string;
  /** Nome do arquivo, igual no lançamento e no cache. */
  arquivo: string;
  tamanho_bytes: number;
  /**
   * Quanto o download deve levar, em segundos. A dispensa do tempo valia para
   * 5 MB; para 1,5 GB não vale — oferecer o download sem dizer se ele leva
   * três minutos ou três horas não é oferecer escolha nenhuma.
   *
   * V10.4 — o número sai da banda MEDIDA nesta máquina quando ela existe, e da
   * referência declarada enquanto não existe. Qual das duas está aqui é o
   * `tempo_medido_nesta_maquina` abaixo, e a copy diz "cerca de" nos dois
   * casos: nem medição é promessa.
   */
  segundos_estimados: number;
  /**
   * O `segundos_estimados` é MEDIÇÃO desta máquina, ou o número de fábrica?
   *
   * Vem como FATO, e não como a banda em bytes/s, pela razão da DECISIONS #124:
   * mandar o número convidaria o TypeScript a refazer a conta, e conta
   * duplicada em duas linguagens diverge (DECISIONS #80). Ele decide UMA
   * coisa: se a frase do download mantém a ressalva de internet lenta.
   */
  tempo_medido_nesta_maquina: boolean;
  /**
   * É um PROGRAMA que o aplicativo executa (`true`) ou um DADO que ele só lê
   * (`false`)? O modelo são 180 MB que ninguém executa, e "um programa de 2 MB
   * e um arquivo de 181 MB" é outra conversa que "dois programas".
   */
  executavel: boolean;
  /**
   * - "ausente": estado normal de quem ainda não baixou;
   * - "pronto": conferido pelo SHA-256 — só aqui a etapa do som existe;
   * - "corrompido": está no cache e a soma não bate (oferece baixar de novo);
   * - "indisponivel": não tem uso nesta build — NÃO oferecer download.
   */
  estado: "ausente" | "pronto" | "corrompido" | "indisponivel";
  /** De onde ele vem — a "origem só para explicar na tela" do PRD V9. */
  origem: string;
}

/**
 * Desfecho de `acessorioBaixar`. `cancelado` é um CAMPO, e não algo a deduzir:
 * cancelar e falhar terminam os dois com o acessório ausente, e a tela precisa
 * saber qual dos dois aconteceu sem adivinhar.
 */
export interface AcessorioDownload {
  cancelado: boolean;
  acessorio: AcessorioInfo;
}

/** Progresso do download (evento Tauri `acessorio:progresso`). */
export interface AcessorioProgresso {
  nome: string;
  baixados: number;
  /**
   * `null` quando o servidor não anunciou o tamanho. NÃO é 0: "não sabemos" é
   * um estado, e o zero viraria uma barra parada em 0% (DECISIONS #86).
   */
  total: number | null;
  /**
   * Quanto ainda falta, em segundos, pela velocidade MEDIDA desta conexão
   * (V10). `null` enquanto a amostra é curta demais para render número
   * honesto: num download de 180 MB, um "faltam 0 segundos" que dura dez
   * minutos é pior que nenhum número (DECISIONS #86 e #106).
   */
  segundos_restantes: number | null;
  /**
   * Download que emitiu o evento. A UI DESCARTA o que não for o seu — mesma
   * disciplina do `scan_id` do funil, e pelo mesmo motivo (M4).
   */
  download_id: string;
}

/**
 * Camada de acesso ao backend. Em produção fala com os comandos Tauri via
 * invoke; fora do Tauri (dev no navegador / E2E Playwright) usa o backend
 * mockado em memória (./mockBackend), mantendo a mesma interface.
 */
export interface Backend {
  addFolder(path: string): Promise<ScanResult>;
  removeFolder(folderId: number): Promise<void>;
  listFolders(): Promise<Folder[]>;
  scan(): Promise<ScanResult>;
  listSongs(): Promise<Song[]>;
  search(query: string): Promise<SearchResult[]>;
  getLyrics(songId: number): Promise<string | null>;
  fileExists(path: string): Promise<boolean>;
  createPlaylist(name: string): Promise<number>;
  deletePlaylist(playlistId: number): Promise<void>;
  listPlaylists(): Promise<Playlist[]>;
  getPlaylistItems(playlistId: number): Promise<PlaylistItem[]>;
  addToPlaylist(playlistId: number, songId: number): Promise<number>;
  removePlaylistItem(itemId: number): Promise<void>;
  reorderPlaylist(playlistId: number, itemIds: number[]): Promise<void>;
  pickFolder(): Promise<string | null>;
  fileSrc(filePath: string): string;
  onScanProgress(cb: (p: ScanProgress) => void): Promise<() => void>;
  /**
   * Grava TIT2/TPE1/USLT/TXXX:TEMAS/TXXX:INSTRUMENTAL no MP3 e devolve a Song
   * reindexada (V4 F10).
   *
   * `instrumental` (V8/F17) tem TRÊS estados: `true` marca, `false` desmarca e
   * omitido/`null` significa "não mexer" — a marca é escolha humana e nenhuma
   * gravação de título/letra pode desfazê-la de lado.
   */
  writeTags(
    songId: number,
    title: string,
    artist: string | null,
    lyrics: string | null,
    temas: string | null,
    instrumental?: boolean | null,
    /**
     * Procedência da letra que está sendo gravada (V8/F18 — ALTO-4):
     * `null`/omitido limpa a marca quando a letra mudou (comportamento de
     * sempre) e "lyrics.ovh" a registra. Sem isto, a letra aceita pelo editor
     * ficava indistinguível de uma do LRCLIB — mesmo acervo, duas pilhas,
     * dois arquivos diferentes no disco.
     */
    letraOrigem?: string | null,
  ): Promise<Song>;
  /**
   * Roda o funil nas músicas incompletas sob folderPrefix ("" = biblioteca
   * inteira) — ponto de rede EXPLÍCITO, pode levar minutos (F13/F18).
   * `scanId` identifica esta varredura nos eventos de progresso e é a chave
   * do cancelamento (M4).
   *
   * V10 — sem credencial nenhuma no payload (DECISIONS #110).
   */
  enrichFolderScan(folderPrefix: string, scanId: string): Promise<EnrichScanResult>;
  /**
   * O tamanho do trabalho que a varredura de `folderPrefix` vai dar — o que a
   * seção de curadoria mostra ANTES de disparar (V8/F18).
   *
   * Vem do backend, e não de um filtro em TypeScript, porque é a MESMA função
   * que a varredura usa: a cópia que existia aqui divergia da regra do Rust em
   * três casos e chegava a zerar a contagem, desabilitando o disparo e
   * afirmando que a pasta estava completa antes de qualquer busca. Desde a V10
   * ela traz também a estimativa de TEMPO, pelo mesmo motivo.
   *
   * **Nenhum comando do funil pede credencial** (V10, DECISIONS #110): a etapa
   * 4 passou a ser o `lyrics.ovh`, que não pede chave, e o Vagalume saiu. Há
   * guarda no backend lendo o próprio fonte contra a volta de um parâmetro de
   * credencial — não reintroduza "por compatibilidade".
   */
  enrichCount(folderPrefix: string): Promise<Contagem>;
  /**
   * A etapa 5 (V10): escreve a letra ouvindo o áudio das músicas pedidas.
   *
   * `songIds` é exatamente o `sem_letra_no_fim` que a varredura devolveu.
   * Custa MINUTOS por música e horas por acervo, roda em segundo plano e é
   * cancelável pelo MESMO `enrichCancelScan(scanId)` da varredura. Nada é
   * gravado: o que volta são propostas para a mesma revisão.
   */
  transcreverMusicas(
    songIds: number[],
    scanId: string,
  ): Promise<TranscricaoResultado>;
  /** Assina `transcricao:progresso` — mesmo contrato dos outros progressos. */
  onTranscricaoProgresso(
    cb: (p: TranscricaoProgresso) => void,
  ): Promise<() => void>;
  /**
   * O mesmo funil, para UMA música só — o "caso pontual" do editor (V8/F18).
   * Não emite progresso (é uma música) e devolve `null` quando nenhuma etapa
   * achou nada. Nada é gravado: quem grava é o "Salvar no arquivo" do editor,
   * depois de a pessoa ver o que veio.
   */
  enrichSongScan(
    songId: number,
    /**
     * Identifica esta busca para o cancelamento (B1). Sem id ela era
     * incancelável: offline, sete palpites de 10 s cada deixavam o editor em
     * "Buscando…" por mais de um minuto, sem saída.
     */
    scanId?: string | null,
    /**
     * Título/artista VIVOS do formulário, quando quem clicou já corrigiu o
     * que estava errado. Substituem as etiquetas do banco na busca: sem isso,
     * a pessoa digitava "Asa Branca" em cima de "Faixa 03", clicava buscar, e
     * o backend procurava "Faixa 03" — a correção dela nunca era usada e nada
     * na tela dizia isso (ALTO-3a).
     */
    title?: string | null,
    artist?: string | null,
  ): Promise<EnrichProposal | null>;
  /**
   * Pede o cancelamento da varredura `scanId`: ela para na próxima música e
   * resolve sem propostas (M4 — "Cancelar" precisa cancelar de verdade).
   */
  enrichCancelScan(scanId: string): Promise<void>;
  /**
   * Progresso da varredura F13 (evento `enrich:progress`) — mesmo contrato do
   * onScanProgress: devolve a função de cancelar a assinatura.
   */
  onEnrichProgress(cb: (p: EnrichProgress) => void): Promise<() => void>;
  /**
   * Aplica as propostas aceitas (nunca renomeia, nunca apaga) — F13. Devolve
   * um resultado por música e NUNCA aborta o lote no meio: falhas viram
   * entradas com `error`, as demais gravam normalmente.
   */
  enrichApply(aplicacoes: EnrichApply[]): Promise<EnrichApplyResult[]>;
  /**
   * Os acessórios que existem para ESTE computador, com o estado de cada um
   * (V9). Lista VAZIA = não publicamos binário para esta plataforma — a tela
   * diz isso em vez de oferecer um download que não serviria.
   */
  acessoriosEstado(): Promise<AcessorioInfo[]>;
  /**
   * Baixa, confere o SHA-256 e instala. Nada baixa sozinho: este comando só
   * existe porque alguém clicou depois de ler o que ia baixar e quanto ocupa.
   *
   * `Ok` com `cancelado: true` = a pessoa parou. `Err` traz uma frase pronta
   * em pt-BR (soma que não confere, rede que caiu) — e, nos dois casos, nada
   * foi instalado.
   */
  acessorioBaixar(nome: string, downloadId: string): Promise<AcessorioDownload>;
  /** Para o download `downloadId`; id desconhecido é no-op silencioso. */
  acessorioCancelar(downloadId: string): Promise<void>;
  /** Assina `acessorio:progresso` — mesmo contrato dos outros progressos. */
  onAcessorioProgresso(
    cb: (p: AcessorioProgresso) => void,
  ): Promise<() => void>;
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function tauriBackend(): Backend {
  return {
    async addFolder(path) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<ScanResult>("add_folder", { path });
    },
    async removeFolder(folderId) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("remove_folder", { folderId });
    },
    async listFolders() {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<Folder[]>("list_folders");
    },
    async scan() {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<ScanResult>("scan");
    },
    async listSongs() {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<Song[]>("list_songs");
    },
    async search(query) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<SearchResult[]>("search", { query });
    },
    async getLyrics(songId) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<string | null>("get_lyrics", { songId });
    },
    async fileExists(path) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<boolean>("file_exists", { path });
    },
    async createPlaylist(name) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<number>("create_playlist", { name });
    },
    async deletePlaylist(playlistId) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("delete_playlist", { playlistId });
    },
    async listPlaylists() {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<Playlist[]>("list_playlists");
    },
    async getPlaylistItems(playlistId) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<PlaylistItem[]>("get_playlist_items", { playlistId });
    },
    async addToPlaylist(playlistId, songId) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<number>("add_to_playlist", { playlistId, songId });
    },
    async removePlaylistItem(itemId) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("remove_playlist_item", { itemId });
    },
    async reorderPlaylist(playlistId, itemIds) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("reorder_playlist", { playlistId, itemIds });
    },
    async pickFolder() {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const result = await open({ directory: true, multiple: false });
      return typeof result === "string" ? result : null;
    },
    fileSrc(filePath) {
      // convertFileSrc é síncrono e disponível quando rodando no Tauri
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const internals = (window as any).__TAURI_INTERNALS__;
      return internals.convertFileSrc(filePath) as string;
    },
    async onScanProgress(cb) {
      const { listen } = await import("@tauri-apps/api/event");
      return listen<ScanProgress>("scan:progress", (e) => cb(e.payload));
    },
    async writeTags(songId, title, artist, lyrics, temas, instrumental, letraOrigem) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<Song>("write_tags", {
        songId,
        title,
        artist,
        lyrics,
        temas,
        // undefined viraria "ausente" no JSON; o backend espera null explícito
        // para "não mexer" (Option<bool> = None).
        instrumental: instrumental ?? null,
        // null = "a letra mudou, limpe a marca" (comportamento de sempre);
        // "lyrics.ovh" = grave a procedência (ALTO-4).
        letraOrigem: letraOrigem ?? null,
      });
    },
    async enrichFolderScan(folderPrefix, scanId) {
      const { invoke } = await import("@tauri-apps/api/core");
      // V10 — o payload não leva credencial nenhuma (DECISIONS #110): nenhuma
      // etapa do funil pede chave, e o backend recusa quem tentar mandar.
      return invoke<EnrichScanResult>("enrich_folder_scan", {
        folderPrefix,
        scanId,
      });
    },
    async enrichCount(folderPrefix) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<Contagem>("enrich_count", { folderPrefix });
    },
    async transcreverMusicas(songIds, scanId) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<TranscricaoResultado>("transcrever_musicas", {
        songIds,
        scanId,
      });
    },
    async onTranscricaoProgresso(cb) {
      const { listen } = await import("@tauri-apps/api/event");
      return listen<TranscricaoProgresso>("transcricao:progresso", (e) =>
        cb(e.payload),
      );
    },
    async enrichSongScan(songId, scanId, title, artist) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<EnrichProposal | null>("enrich_song_scan", {
        songId,
        // com id, o "Cancelar busca" do editor para a rede de verdade (B1)
        scanId: scanId || null,
        // o que está DIGITADO vence a etiqueta do banco (ALTO-3a); vazio volta
        // a valer como "use o que está no arquivo"
        title: title?.trim() ? title.trim() : null,
        artist: artist?.trim() ? artist.trim() : null,
      });
    },
    async enrichCancelScan(scanId) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("enrich_cancel_scan", { scanId });
    },
    async onEnrichProgress(cb) {
      const { listen } = await import("@tauri-apps/api/event");
      return listen<EnrichProgress>("enrich:progress", (e) => cb(e.payload));
    },
    async enrichApply(aplicacoes) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<EnrichApplyResult[]>("enrich_apply", { aplicacoes });
    },
    async acessoriosEstado() {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<AcessorioInfo[]>("acessorios_estado");
    },
    async acessorioBaixar(nome, downloadId) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<AcessorioDownload>("acessorio_baixar", { nome, downloadId });
    },
    async acessorioCancelar(downloadId) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("acessorio_cancelar", { downloadId });
    },
    async onAcessorioProgresso(cb) {
      const { listen } = await import("@tauri-apps/api/event");
      return listen<AcessorioProgresso>("acessorio:progresso", (e) =>
        cb(e.payload),
      );
    },
  };
}

let backend: Backend | null = null;

export function getBackend(): Backend {
  if (backend) return backend;
  if (isTauri()) {
    backend = tauriBackend();
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const injected = (window as any).__CANCIONEIRO_MOCK__ as Backend | undefined;
    if (!injected) {
      throw new Error(
        "Fora do Tauri é preciso instalar o mock: import { installMockBackend } from './mockBackend'",
      );
    }
    backend = injected;
  }
  return backend;
}

/** Somente para testes: substitui o backend ativo. */
export function setBackendForTests(b: Backend | null): void {
  backend = b;
}
