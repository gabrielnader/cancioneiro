import { useEffect, useRef, useState } from "react";
import { audioController } from "../hooks/playerAudioCore";
import { getBackend, type EnrichProposal } from "../lib/api";
import {
  EXPLICACAO_DA_CONFIANCA_DO_SOM,
  LABEL_SOM_DIZ,
  LABEL_SUA_ETIQUETA_DIZ,
  SEM_RESULTADO_INDIVIDUAL,
  SEM_RESULTADO_INSTRUMENTAL,
  confiancaDoSom,
  downloadParaTranscrever,
  rotuloDeTranscreverEstaMusica,
  textoDaOfertaDestaMusica,
  type DownloadPendente,
} from "../lib/curadoria";
import { FONTE_LYRICS_OVH, ORIGEM_LYRICS_OVH, type Song } from "../lib/types";
import { novoScanId, useEnrichStore } from "../stores/enrichStore";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlayerStore } from "../stores/playerStore";
import { usePlaylistStore } from "../stores/playlistStore";
import { useToastStore } from "../stores/toastStore";

function basename(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath;
}

/** "Título — Artista", ou só o título quando não há artista. */
function nomeCompleto(titulo: string, artista: string | null): string {
  return artista ? `${titulo} — ${artista}` : titulo;
}

/** Rótulo de confiança, igual ao da revisão em lote (mesma linguagem). */
const BADGE_CONFIANCA: Record<EnrichProposal["confidence"], string> = {
  alta: "ALTA",
  media: "MÉDIA",
  baixa: "BAIXA",
};

const CLASSE_CONFIANCA: Record<EnrichProposal["confidence"], string> = {
  alta: "bg-[#DCFCE7] text-[#166534]",
  media: "bg-[#FEF9C3] text-[#854D0E]",
  baixa: "bg-[#F3F4F6] text-[#5B6472]",
};

/**
 * O que a busca do funil desta música devolveu. É estado da FICHA, não do
 * disco: nada aqui foi gravado — quem grava continua sendo "Salvar no
 * arquivo".
 */
type ResultadoBusca =
  | { tipo: "proposta"; proposta: EnrichProposal }
  | { tipo: "vazio" }
  | { tipo: "falha"; mensagem: string };

/**
 * V10.9 — a oferta da etapa 5 para ESTA música, como o backend a respondeu.
 *
 * `musicas` é a fila que `startTranscricao` recebe — um item —, e ela vem da
 * PORTA, e não de um `[song.id]` montado aqui: quem aplica os portões da etapa 5
 * (música com letra, instrumental, arquivo fora do disco) é o Rust, e montar o
 * id na tela seria a tela decidindo o que a etapa 5 transcreve (DECISIONS #80).
 *
 * V10.10 — e a pergunta passou a ser feita ao ABRIR a ficha, e não no fim de uma
 * busca: é ela que decide se existe o botão direto.
 */
interface OfertaDaEtapa5 {
  musicas: number[];
  segundos: number;
  medidaNestaMaquina: boolean;
  disponivel: boolean;
  /** O que falta baixar, quando falta e quando se sabe o tamanho. */
  download: DownloadPendente | null;
}

interface EditSongFormProps {
  song: Song;
  /** Letra atual (já carregada pelo painel); "" quando não há. */
  initialLyrics: string;
  /** Cancelar: descarta e volta ao modo leitura. */
  onCancel: () => void;
  /** Salvou com sucesso: sair da edição e re-exibir a letra. */
  onSaved: () => void;
}

/**
 * Formulário de edição de metadados no painel de letra (V4 — F10).
 * Grava tags via write_tags; "Buscar letra na internet" é o único ponto de
 * rede do app e falha graciosamente sem conexão.
 */
export function EditSongForm({
  song,
  initialLyrics,
  onCancel,
  onSaved,
}: EditSongFormProps) {
  const push = useToastStore((s) => s.push);
  const [title, setTitle] = useState(song.title);
  const [artist, setArtist] = useState(song.artist ?? "");
  const [temas, setTemas] = useState<string[]>(() =>
    (song.temas ?? "")
      .split(";")
      .map((t) => t.trim())
      .filter(Boolean),
  );
  const [temaInput, setTemaInput] = useState("");
  // V8/F17 — a marca de instrumental é escolha humana e viaja no MP3
  // (TXXX:INSTRUMENTAL). O editor é o único lugar do app que a desfaz, mas
  // só quando alguém MEXE no controle: `write_tags` recebe `undefined`
  // ("não mexer") enquanto ninguém tocou nele.
  //
  // Por que não basta mandar o estado do checkbox: a Song vem do banco, e o
  // banco pode estar atrasado em relação ao MP3 — a curadoria marcou o
  // arquivo com o app aberto, ou antes da varredura de inicialização. Aí o
  // controle nasce desmarcado sem que ninguém tenha desmarcado nada, e
  // salvar uma correção de título apagaria do arquivo uma marca feita à mão.
  // "Marcada à mão, nenhuma rotina desmarca sozinha" (PRD V8/F17).
  const [instrumental, setInstrumental] = useState(song.instrumental === true);
  const [instrumentalTocado, setInstrumentalTocado] = useState(false);
  const [lyrics, setLyrics] = useState(initialLyrics);
  const [titleError, setTitleError] = useState(false);
  const [busy, setBusy] = useState(false);
  // busy próprio da busca (V5 Q5): não trava Salvar/Cancelar
  const [fetchBusy, setFetchBusy] = useState(false);
  // V8/F18 — resultado do funil desta música, mostrado na própria ficha
  const [resultado, setResultado] = useState<ResultadoBusca | null>(null);
  /**
   * ALTO-4 — procedência da letra que está no formulário AGORA, quando ela
   * veio de uma proposta que a declara (hoje, só o Vagalume). Ela viaja no
   * `writeTags` e vira o `TXXX:LETRA_ORIGEM`: sem isso, a letra aceita do
   * Vagalume era gravada indistinguível de uma do LRCLIB, e o mesmo acervo
   * virava duas pilhas — a CLI marcando "vagalume", o app não marcando nada.
   *
   * A marca descreve o TEXTO que está lá: mexer na letra à mão a derruba.
   */
  const [letraOrigemPendente, setLetraOrigemPendente] = useState<string | null>(
    null,
  );
  /**
   * A oferta da etapa 5 desta música, como a PORTA a respondeu ao abrir a ficha.
   * `null` = não há nada a desenhar, e é o estado de tudo o que não é uma
   * resposta: enquanto a pergunta não voltou, quando o backend disse que não há
   * o que transcrever, e quando a pergunta falhou ("não sabemos" é um estado —
   * DECISIONS #86).
   */
  const [oferta, setOferta] = useState<OfertaDaEtapa5 | null>(null);
  /**
   * V10.10 — a busca terminou SEM trazer letra.
   *
   * Só existe para o caso em que esta máquina NÃO pode transcrever: aí não há
   * botão (um botão que não faria nada é pior que a frase que diz o que fazer —
   * DECISIONS #157), e o que sobra é a frase que manda a pessoa a Configurações.
   * Ela aparece depois da busca, e não o tempo todo, porque é a resposta ao beco
   * que a busca acabou de produzir: parágrafo permanente dentro de um formulário
   * é o que a DECISIONS #154(a) recusou.
   */
  const [buscaSemLetra, setBuscaSemLetra] = useState(false);
  /** Busca individual em curso — a chave do cancelamento (B1). */
  const buscaAtual = useRef<string | null>(null);
  /**
   * MÉDIO-15 — a varredura em lote e o funil individual têm cada um a SUA
   * pausa de cortesia; rodando juntos, dobram a taxa de consultas ao LRCLIB e
   * ao Vagalume, que é exatamente o que a cortesia compartilhada existe para
   * evitar. Enquanto o lote roda (inclusive encerrando), a busca daqui espera.
   */
  const loteRodando = useEnrichStore(
    (s) => s.status === "scanning" || s.scanInFlight,
  );
  /**
   * V10.9 — qual trabalho está rodando, para o motivo do bloqueio não mentir.
   * O `loteRodando` acima já era verdadeiro durante a etapa 5 (ela também segura
   * o `scanInFlight`), e a frase falava só de busca.
   */
  const transcrevendoLote = useEnrichStore((s) => s.status === "transcribing");
  /**
   * V10.9 — a etapa 5, disparada com a fila desta música. É o MESMO
   * `startTranscricao` das outras duas portas: ele recebe a fila por parâmetro
   * desde a V10.6, e uma lista de um item é tudo o que faltava.
   */
  const startTranscricao = useEnrichStore((s) => s.startTranscricao);

  /*
    V10.9 — O CONSERTO QUE VEM JUNTO COM A PORTA NOVA.

    A oferta manda a fila de um item para a MESMA revisão das outras portas, e é
    lá que a letra é conferida e GRAVADA. Só que a ficha continua aberta atrás da
    revisão, com o campo de letra vazio — e "Salvar no arquivo" com o campo vazio
    APAGA a letra do arquivo (`None` remove o frame USLT, `writer.rs`). Seria o
    produto destruindo, num clique de hábito, o trabalho de minutos que ele
    acabou de fazer.

    O campo é preenchido SÓ quando está vazio. Nada que a pessoa tenha digitado é
    sobrescrito: ela pode ter corrigido o título e começado a escrever a letra à
    mão antes de mandar transcrever, e trocar um estrago por outro não é
    conserto. Vazio é exatamente o caso em que não há o que perder — e é o único
    em que o arquivo pode ter ganhado letra sem ela.

    O gatilho é o `initialLyrics` MUDAR: quem o refaz é o painel, relendo a letra
    do arquivo quando `has_lyrics` vira verdadeiro (o `apply` da revisão
    atualiza a `Song` na `libraryStore`).
  */
  useEffect(() => {
    if (!initialLyrics.trim()) return;
    // `lyrics` entra pelo atualizador funcional, e não como dependência: como
    // dependência o efeito correria a cada tecla digitada, e a única coisa que
    // deve dispará-lo é a letra do ARQUIVO chegar.
    setLyrics((atual) => (atual.trim() ? atual : initialLyrics));
  }, [initialLyrics]);

  /**
   * Confirma o texto pendente do input de tema como chip e devolve a lista
   * resultante — handleSave precisa dela na hora (setState é assíncrono).
   * BUG v0.4: tema digitado sem Enter era perdido ao salvar.
   */
  function commitTemaInput(): string[] {
    const tema = temaInput.trim();
    setTemaInput("");
    if (!tema || temas.some((t) => t.toLowerCase() === tema.toLowerCase())) {
      return temas;
    }
    const next = [...temas, tema];
    setTemas(next);
    return next;
  }

  /**
   * V8/F18 — o funil inteiro nesta música (o "caso pontual" do PRD).
   *
   * Substituiu o "Buscar letra na internet" da V4, que consultava só o LRCLIB
   * e só sabia trazer letra. Dois botões dizendo "buscar na internet", com a
   * diferença invisível para quem não sabe o que é LRCLIB, seriam uma escolha
   * às cegas — e a escolha errada é silenciosamente pior. Este botão faz tudo
   * o que o antigo fazia e mais: passa pelas três etapas, diz de onde veio o
   * dado e também corrige título e artista.
   *
   * A busca NÃO grava e NÃO preenche nada sozinha: o resultado aparece na
   * ficha, com procedência e confiança, e só entra no formulário se a pessoa
   * mandar (mesma regra do lote — nada é aplicado sem revisão).
   */
  async function handleBuscarDados() {
    const scanId = novoScanId();
    buscaAtual.current = scanId;
    setFetchBusy(true);
    setResultado(null);
    // a busca começou: o desfecho anterior não vale mais. A OFERTA da etapa 5
    // não é mexida aqui — ela descreve o arquivo, e não esta busca.
    setBuscaSemLetra(false);
    try {
      const proposta = await getBackend().enrichSongScan(
        song.id,
        scanId,
        // ALTO-3a — o que a pessoa DIGITOU vence a etiqueta do banco. Antes,
        // quem corrigia "Faixa 03" para "Asa Branca" e clicava buscar via o
        // backend procurar "Faixa 03": a correção não era usada e nada na
        // tela dizia isso. Sem suporte a quem perguntar, o desfecho lido era
        // "a internet não tem a minha música".
        title.trim(),
        artist.trim() ? artist.trim() : null,
      );
      // cancelada no meio: a resposta que chegar depois não é mais notícia
      if (buscaAtual.current !== scanId) return;
      setResultado(proposta ? { tipo: "proposta", proposta } : { tipo: "vazio" });
      setBuscaSemLetra(proposta?.lyrics == null);
    } catch {
      if (buscaAtual.current !== scanId) return;
      // o resultado é inline: um toast some sozinho e esta é a única
      // explicação que a pessoa vai receber — não há suporte para perguntar
      setResultado({
        tipo: "falha",
        mensagem: "Sem conexão — a busca de dados precisa de internet.",
      });
      /*
        E a saída da etapa 5 vale AQUI TAMBÉM, de propósito: ela não usa rede. A
        música que ficou sem letra porque o LRCLIB não respondeu é exatamente a
        que a transcrição resolve — é o que o `a_etapa_5_tem_o_que_fazer` do
        Rust diz, com estas palavras.
      */
      setBuscaSemLetra(true);
    } finally {
      if (buscaAtual.current === scanId) {
        buscaAtual.current = null;
        setFetchBusy(false);
      }
    }
  }

  /**
   * **A ETAPA 5, OFERECIDA ONDE A PESSOA ESTÁ — e sem cobrar o funil antes.**
   *
   * O funil da ficha roda as etapas 1 a 4 e para ali. Com 3% de cobertura
   * medida, "não achamos nada" é o desfecho TÍPICO daquele clique, e até a
   * V10.9 a etapa 5 só era oferecida DEPOIS dele. Pedido do dono do produto,
   * verbatim: *"No caso específico de mexer música por música quero um botão
   * separado pra fazer transcrição. Pra não precisar rodar todo o fluxo pra
   * depois só poder transcrever."*
   *
   * **A pergunta é feita ao ABRIR a ficha**, e é barata: uma consulta ao banco e
   * a estimativa: nada de rede, nada de ler áudio. É ela que decide se existe o
   * botão — quem responde "o que a etapa 5 tem a fazer por esta música" é o
   * backend, com os MESMOS portões das outras duas portas (música com letra,
   * instrumental, arquivo que sumiu do disco voltam com a fila vazia).
   *
   * **Uma vez por ficha**, e não a cada busca (DECISIONS #162d): a resposta
   * descreve o ARQUIVO, e o que muda no formulário — a caixa de instrumental, a
   * letra digitada — é conferido na hora de desenhar, porque o formulário é mais
   * atual que o banco.
   */
  useEffect(() => {
    // a ficha pode ser trocada (ou fechada) antes de a resposta chegar: a
    // guarda impede a resposta atrasada de desenhar oferta de outra música
    let valida = true;
    void (async () => {
      try {
        const p = await getBackend().transcricaoPendentesDaMusica(song.id);
        if (!valida || p.musicas.length === 0) return;
        /*
          Sem os acessórios, a frase precisa do TAMANHO do download — para 1,4 GB
          a dispensa do número não vale mais (DECISIONS #106). A leitura só
          acontece nesse caso: numa máquina pronta ela não responderia nada que a
          frase use.
        */
        const download = p.disponivel ? null : await downloadPendenteDaEtapa5();
        if (!valida) return;
        setOferta({
          musicas: p.musicas,
          segundos: p.segundos_estimados,
          medidaNestaMaquina: p.estimativa_medida_nesta_maquina,
          disponivel: p.disponivel,
          download,
        });
      } catch {
        // "não sabemos" é um estado (DECISIONS #86): sem resposta, a ficha não
        // desenha nada — nem promete, nem afirma zero.
      }
    })();
    return () => {
      valida = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song.id]);

  /** O que falta baixar, pela MESMA leitura que as outras duas portas usam. */
  async function downloadPendenteDaEtapa5(): Promise<DownloadPendente | null> {
    try {
      return downloadParaTranscrever(await getBackend().acessoriosEstado());
    } catch {
      // idem: sem a lista, não se inventa tamanho nenhum
      return null;
    }
  }

  /**
   * B1 — desistir da busca. O invoke pode continuar respondendo por alguns
   * segundos (o backend para na próxima consulta); a guarda do `buscaAtual`
   * garante que a resposta atrasada não apareça na ficha.
   */
  function cancelarBusca() {
    const scanId = buscaAtual.current;
    buscaAtual.current = null;
    setFetchBusy(false);
    if (!scanId) return;
    try {
      void getBackend()
        .enrichCancelScan(scanId)
        .catch(() => {
          // backend antigo/sem o comando: a guarda acima já basta
        });
    } catch {
      // fakes de teste sem enrichCancelScan: idem
    }
  }

  /**
   * V9 — aceitar o que o SOM disse, quando ele contradiz a etiqueta. Só
   * nomes: o funil PARA no conflito, sem procurar letra nenhuma sob um nome
   * que o som acabou de contradizer. Como em toda a ficha, nada vai para o
   * disco aqui — quem grava é o "Salvar no arquivo".
   */
  function aceitarOSom(p: EnrichProposal) {
    if (!p.conflito) return;
    setTitle(p.conflito.titulo);
    setArtist(p.conflito.artista);
    setResultado(null);
  }

  /** Traz a proposta para o formulário (ainda sem tocar no arquivo). */
  function usarProposta(p: EnrichProposal) {
    // Trocar a letra e corrigir o nome são duas decisões diferentes: recusar
    // a troca não pode jogar fora a correção de título/artista que veio
    // junto (é a mesma regra da revisão em lote — CRÍTICO-1).
    const trocarLetra =
      p.lyrics !== null &&
      (!lyrics.trim() ||
        // copy mantida da V4: é a pergunta que as pessoas já conhecem
        window.confirm("Substituir a letra atual pelo resultado da busca?"));

    if (p.proposed_title.trim()) setTitle(p.proposed_title);
    if (p.proposed_artist?.trim()) setArtist(p.proposed_artist);
    if (trocarLetra && p.lyrics !== null) {
      setLyrics(p.lyrics);
      // ALTO-4: a fonte que DECLARA procedência é o lyrics.ovh (V10 — o
      // Vagalume saiu, DECISIONS #110); qualquer outra limpa a marca, porque
      // letra oficial nunca é transcrição (DECISIONS #54)
      setLetraOrigemPendente(
        p.fonte === FONTE_LYRICS_OVH ? ORIGEM_LYRICS_OVH : null,
      );
    }
    setResultado(null);
  }

  async function handleSave() {
    // tema digitado e não confirmado com Enter conta como se tivesse dado
    // Enter (BUG v0.4) — inclusive quando o título inválido aborta o save.
    const finalTemas = commitTemaInput();

    if (!title.trim()) {
      setTitleError(true);
      return;
    }
    setTitleError(false);

    // Se a música em edição está tocando, pausa ANTES de gravar (o arquivo
    // pode estar em uso no Windows) e mantém pausado depois (PRD V4).
    // audioController.pause age direto no elemento — sem esperar re-render,
    // fechando a janela de corrida entre o pause e o write no disco.
    const player = usePlayerStore.getState();
    if (player.current?.id === song.id && player.isPlaying) {
      player.setPlaying(false);
      audioController.pause();
    }

    setBusy(true);
    try {
      const saved = await getBackend().writeTags(
        song.id,
        title.trim(),
        artist.trim() ? artist.trim() : null,
        lyrics.trim() ? lyrics : null,
        finalTemas.length > 0 ? finalTemas.join("; ") : null,
        // três estados (V8/F17): undefined = "não mexer na marca"
        instrumentalTocado ? instrumental : undefined,
        // ALTO-4 — procedência da letra que está sendo gravada: "vagalume"
        // quando ela veio de lá e ninguém a editou depois; null limpa a marca
        letraOrigemPendente,
      );
      useLibraryStore.getState().updateSong(saved);
      usePlaylistStore.getState().updateSongInItems(saved);
      usePlayerStore.getState().updateSongRefs(saved);
      push(`Alterações salvas em ${basename(song.file_path)}.`, "success");
      onSaved();
    } catch {
      push(`Não foi possível salvar em ${basename(song.file_path)}.`, "error");
    } finally {
      setBusy(false);
    }
  }

  /**
   * **O que o FORMULÁRIO diz sobre a etapa 5 desta música.**
   *
   * Não duplica regra do backend — quem decide o que a etapa 5 transcreve
   * continua sendo a porta (`transcricaoPendentesDaMusica`, com os portões de
   * música com letra, instrumental e arquivo fora do disco). Isto descreve o
   * que está na TELA agora, que é mais atual que o banco:
   *
   * - quem acabou de marcar "esta música é instrumental" declarou que não há voz
   *   no áudio, e oferecer escrever a letra ouvindo o áudio contradiria o que ela
   *   acabou de dizer (é a mesma razão do `SEM_RESULTADO_INSTRUMENTAL`);
   * - com letra no campo, a música não está mais sem letra — e a frase da saída
   *   sem acessórios, que abre com "esta música continua sem letra", seria
   *   desmentida pelo textarea logo acima dela.
   */
  const podeTranscreverEstaMusica = !instrumental && !lyrics.trim();

  const inputClass = (error: boolean) =>
    `w-full rounded-md border bg-white px-3 py-2 text-[15px] text-[#111827] outline-none ${
      error
        ? "border-[#B91C1C]"
        : "border-[#D1D5DB] focus:border-[#0F766E]"
    }`;

  return (
    <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
      <div>
        <label
          htmlFor="edit-titulo"
          className="mb-1 block text-[13px] font-medium text-[#374151]"
        >
          Título
        </label>
        <input
          id="edit-titulo"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className={inputClass(titleError)}
        />
        {titleError && (
          <p className="mt-1 text-[13px] text-[#B91C1C]">
            Dê um título à música.
          </p>
        )}
      </div>

      <div>
        <label
          htmlFor="edit-artista"
          className="mb-1 block text-[13px] font-medium text-[#374151]"
        >
          Artista
        </label>
        <input
          id="edit-artista"
          type="text"
          value={artist}
          onChange={(e) => setArtist(e.target.value)}
          className={inputClass(false)}
        />
      </div>

      <div>
        <p className="mb-1 text-[13px] font-medium text-[#374151]">Temas</p>
        <div className="flex flex-wrap items-center gap-1.5">
          {temas.map((tema) => (
            <span
              key={tema}
              className="inline-flex max-w-40 items-center gap-1 rounded-full bg-[#F0FDFA] px-2 py-0.5 text-[12px] text-[#0F766E]"
            >
              <span className="truncate">{tema}</span>
              <button
                type="button"
                aria-label={`Remover tema ${tema}`}
                className="shrink-0 rounded-full px-0.5 hover:bg-[#ccfbf1]"
                onClick={() => setTemas(temas.filter((t) => t !== tema))}
              >
                ×
              </button>
            </span>
          ))}
          <input
            type="text"
            value={temaInput}
            placeholder="Adicionar tema"
            aria-label="Adicionar tema"
            onChange={(e) => setTemaInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitTemaInput();
              }
            }}
            // sair do campo confirma o tema pendente como chip (BUG v0.4)
            onBlur={commitTemaInput}
            className="min-w-28 flex-1 rounded-md border border-[#D1D5DB] bg-white px-2 py-1 text-[13px] text-[#111827] outline-none placeholder:text-[#9CA3AF] focus:border-[#0F766E]"
          />
        </div>
      </div>

      {/*
        V8/F17 — fica junto da letra porque é dela que a pessoa está falando:
        "não tem letra porque não tem voz". Marcar aqui tira a música das
        varreduras de letra e troca o selo "Sem letra" por "Instrumental".
      */}
      <div>
        <label
          htmlFor="edit-instrumental"
          className="flex items-center gap-2 text-[14px] text-[#374151]"
        >
          <input
            id="edit-instrumental"
            type="checkbox"
            checked={instrumental}
            onChange={(e) => {
              setInstrumental(e.target.checked);
              setInstrumentalTocado(true);
            }}
            className="h-4 w-4 accent-[#0F766E]"
          />
          Esta música é instrumental
        </label>
      </div>

      <div className="flex min-h-32 flex-1 flex-col">
        <label
          htmlFor="edit-letra"
          className="mb-1 block text-[13px] font-medium text-[#374151]"
        >
          Letra
        </label>
        <textarea
          id="edit-letra"
          value={lyrics}
          onChange={(e) => {
            setLyrics(e.target.value);
            // a marca descreve o texto que está aqui: se a pessoa mexeu, ela
            // não vale mais (ALTO-4)
            setLetraOrigemPendente(null);
          }}
          className="w-full flex-1 resize-none rounded-md border border-[#D1D5DB] bg-white px-3 py-2 text-[15px] leading-relaxed text-[#111827] outline-none focus:border-[#0F766E]"
        />
      </div>

      {/*
        V8/F18 — o resultado do funil desta música, na própria ficha. Fica
        acima dos botões, entre a letra e a ação: é o que a pessoa precisa ler
        antes de decidir. Nada daqui foi para o disco.
      */}
      {resultado && (
        <div
          role="status"
          className="shrink-0 rounded-md border border-[#E5E7EB] bg-[#F9FAFB] p-3"
        >
          {resultado.tipo === "vazio" ? (
            // ALTO-3b — `null` passou a significar UMA coisa: procuramos e
            // não veio nada novo. Para a música marcada como instrumental,
            // porém, nenhuma etapa de LETRA rodou — dizer "não achamos nos
            // sites de letra" contaria uma busca que não aconteceu.
            <p className="text-[13px] leading-relaxed text-[#374151]">
              {instrumental ? SEM_RESULTADO_INSTRUMENTAL : SEM_RESULTADO_INDIVIDUAL}
            </p>
          ) : resultado.tipo === "falha" ? (
            <p className="text-[13px] text-[#B91C1C]">{resultado.mensagem}</p>
          ) : resultado.proposta.error !== null ? (
            <p className="text-[13px] text-[#B91C1C]">{resultado.proposta.error}</p>
          ) : resultado.proposta.conflito ? (
            /*
              V9 — o som contradiz a etiqueta. Aqui NÃO cabe "Título: X" com um
              botão "Usar estes dados": a proposta repete o que já está no
              arquivo, e a informação inteira é a DIVERGÊNCIA. Os dois lados
              aparecem nomeados por quem os disse, e aceitar é uma escolha.
            */
            <>
              <p className="flex flex-wrap items-center gap-2 text-[13px] text-[#5B6472]">
                <span className="rounded bg-[#FEF3C7] px-1.5 py-0.5 text-[11px] font-semibold text-[#854D0E]">
                  CONFLITO
                </span>
                <span>{confiancaDoSom(resultado.proposta.conflito.confianca)}</span>
              </p>
              <dl className="mt-2 space-y-0.5 text-[13px]">
                <div className="flex gap-2">
                  <dt className="shrink-0 text-[#5B6472]">
                    {LABEL_SUA_ETIQUETA_DIZ}:
                  </dt>
                  <dd className="min-w-0 break-words text-[#111827]">
                    {nomeCompleto(
                      resultado.proposta.current_title,
                      resultado.proposta.current_artist,
                    )}
                  </dd>
                </div>
                <div className="flex gap-2">
                  <dt className="shrink-0 text-[#5B6472]">{LABEL_SOM_DIZ}:</dt>
                  <dd className="min-w-0 break-words font-medium text-[#111827]">
                    {nomeCompleto(
                      resultado.proposta.conflito.titulo,
                      resultado.proposta.conflito.artista,
                    )}
                  </dd>
                </div>
              </dl>
              {/*
                V10 — "confiança alta" enganava aqui pelo mesmo motivo que na
                revisão em lote: ela é do RECONHECIMENTO DA GRAVAÇÃO, e não da
                etiqueta estar errada. A frase mora num lugar só, e aparece nos
                dois lugares em que a confiança é mostrada.
              */}
              <p className="mt-2 text-[13px] leading-relaxed text-[#5B6472]">
                {EXPLICACAO_DA_CONFIANCA_DO_SOM}
              </p>
              <p className="mt-2 text-[13px] text-[#5B6472]">
                Nada foi gravado ainda.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => aceitarOSom(resultado.proposta)}
                  className="rounded-md bg-[#0F766E] px-3 py-1.5 text-[14px] font-medium text-white hover:bg-[#115E59]"
                >
                  Usar o que o som diz
                </button>
                <button
                  type="button"
                  onClick={() => setResultado(null)}
                  className="rounded-md border border-[#D1D5DB] px-3 py-1.5 text-[14px] font-medium text-[#374151] hover:bg-[#F3F4F6]"
                >
                  Descartar
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="flex flex-wrap items-center gap-2 text-[13px] text-[#5B6472]">
                <span
                  className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${
                    CLASSE_CONFIANCA[resultado.proposta.confidence]
                  }`}
                >
                  {BADGE_CONFIANCA[resultado.proposta.confidence]}
                </span>
                <span>via {resultado.proposta.fonte}</span>
                {resultado.proposta.lyrics !== null && (
                  <span className="text-[#0F766E]">letra encontrada</span>
                )}
              </p>
              <dl className="mt-2 space-y-0.5 text-[13px]">
                <div className="flex gap-2">
                  <dt className="shrink-0 text-[#5B6472]">Título:</dt>
                  <dd className="min-w-0 break-words text-[#111827]">
                    {resultado.proposta.proposed_title}
                  </dd>
                </div>
                {resultado.proposta.proposed_artist && (
                  <div className="flex gap-2">
                    <dt className="shrink-0 text-[#5B6472]">Artista:</dt>
                    <dd className="min-w-0 break-words text-[#111827]">
                      {resultado.proposta.proposed_artist}
                    </dd>
                  </div>
                )}
              </dl>
              {/* passe de redução V9: a instrução que vinha depois ("use os
                  dados, confira, e só então salve") está nos botões logo
                  abaixo — repeti-la em prosa era o parágrafo que ninguém lê */}
              <p className="mt-2 text-[13px] text-[#5B6472]">
                Nada foi gravado ainda.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => usarProposta(resultado.proposta)}
                  className="rounded-md bg-[#0F766E] px-3 py-1.5 text-[14px] font-medium text-white hover:bg-[#115E59]"
                >
                  Usar estes dados
                </button>
                <button
                  type="button"
                  onClick={() => setResultado(null)}
                  className="rounded-md px-3 py-1.5 text-[14px] font-medium text-[#374151] hover:bg-[#F3F4F6]"
                >
                  Descartar
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/*
        V10.10 — A SAÍDA DE QUEM NÃO PODE TRANSCREVER NESTA MÁQUINA.

        É a metade que sobrou da oferta da V10.9. A outra metade — a frase com o
        tempo e o botão "Começar agora" — virou o botão permanente lá embaixo, e
        manter as duas seriam DOIS botões para a mesma ação, na mesma tela: a
        duplicação que a V8 removeu quando havia dois "buscar na internet".

        Esta fica porque não é um clique daqui: é um download de 1,4 GB, em outra
        tela. E fica DEPOIS da busca porque é a resposta ao beco que ela acabou
        de produzir — um parágrafo permanente dentro de um formulário é o que a
        DECISIONS #154(a) recusou.

        As duas condições LOCAIS repetidas aqui não duplicam regra do backend —
        elas descrevem o FORMULÁRIO, que é mais atual que o banco. Com a caixa de
        instrumental marcada ou com letra no campo, a frase "esta música continua
        sem letra" seria desmentida pela tela em volta dela: é a primeira coisa
        que a pessoa lê, e ela estaria errada.
      */}
      {oferta && !oferta.disponivel && buscaSemLetra && podeTranscreverEstaMusica && (
        <div
          role="status"
          className="shrink-0 rounded-md bg-[#F0FDFA] px-4 py-3"
        >
          <p className="text-[14px] leading-relaxed text-[#115E59]">
            {textoDaOfertaDestaMusica(oferta.download)}
          </p>
        </div>
      )}

      {/*
        MÉDIO-15 — o motivo do bloqueio é TEXTO na tela, não `title=`: botão
        desabilitado não recebe foco e `title` não é anunciado de forma
        confiável. Sem ele, quem clicasse veria um botão cinza e nada mais.

        V10.9 — e o motivo passou a dizer QUAL trabalho está rodando. Os dois
        botões desta ficha param enquanto a etapa 5 escreve as letras (é o mesmo
        `scanInFlight`), e até aqui a única frase na tela falava de uma busca —
        que naquele momento não estava acontecendo. Texto que mente sobre o
        próprio produto é defeito, e este ficou alcançável em um clique: quem
        manda transcrever daqui e volta da revisão está exatamente nesse estado.
      */}
      {loteRodando && (
        <p id="editor-busca-bloqueada" className="shrink-0 text-[13px] text-[#5B6472]">
          {transcrevendoLote
            ? "As letras estão sendo escritas — espere elas terminarem para o computador não fazer dois trabalhos pesados ao mesmo tempo."
            : "A busca desta pasta está rodando — espere ela terminar para não consultar os sites de letra duas vezes ao mesmo tempo."}
        </p>
      )}
      {fetchBusy && (
        // B1 — a busca pode demorar (cada consulta espera até 10 s antes de
        // desistir). Dizer isso é o que separa "está trabalhando" de "travou".
        <p className="shrink-0 text-[13px] text-[#5B6472]">
          Procurando nos sites de letra… pode demorar se os sites de letra
          estiverem lentos. Dá para cancelar e continuar editando.
        </p>
      )}

      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={fetchBusy || loteRodando}
          aria-describedby={loteRodando ? "editor-busca-bloqueada" : undefined}
          /*
            V10 — a dica nomeia as etapas que REALMENTE rodam, na ordem em que
            rodam. Ela prometia o Vagalume, que saiu do produto (DECISIONS
            #110), e calava as duas que entraram: o reconhecimento pelo som e o
            lyrics.ovh. Quem lê isto está decidindo se manda buscar, e a lista
            é a informação.

            A etapa do som depende do acessório estar baixado nesta máquina —
            quem sabe disso é o backend (DECISIONS #101), e quem mostra o
            estado é a tela de Configurações. Aqui a lista é do que o botão
            tenta, e nenhuma etapa promete resultado.
          */
          title="Procura título, artista e letra desta música: primeiro no próprio arquivo, depois pelo som da gravação, no LRCLIB e no lyrics.ovh"
          onClick={() => void handleBuscarDados()}
          className="rounded-md border border-[#0F766E] px-3 py-1.5 text-[14px] font-medium text-[#0F766E] hover:bg-[#F0FDFA] disabled:opacity-60"
        >
          {fetchBusy ? "Buscando…" : "Buscar dados na internet"}
        </button>
        {fetchBusy && (
          <button
            type="button"
            onClick={cancelarBusca}
            className="rounded-md px-3 py-1.5 text-[14px] font-medium text-[#374151] hover:bg-[#F3F4F6]"
          >
            Cancelar busca
          </button>
        )}
        {/*
          V10.10 — O BOTÃO DIRETO DA ETAPA 5.

          Ele fica AO LADO de "Buscar dados na internet", e não dentro de um
          bloco de oferta, porque é o que ele é: a segunda coisa que se pode
          mandar o programa fazer por este arquivo. A escolha entre os dois não é
          às cegas — a que a V8 recusou —, porque cada rótulo traz o próprio
          custo: um fala de internet e leva segundos, este traz os minutos
          escritos nele.

          É contorno e não preenchido de propósito: nesta barra o botão cheio é
          "Salvar no arquivo", que é o único que ESCREVE. Transcrever não grava
          nada — abre a mesma revisão das outras portas.

          Sem `disponivel` não há botão: um botão que não faria nada é pior que a
          frase que diz o que fazer (DECISIONS #157), e a frase está no bloco
          acima.
        */}
        {oferta && oferta.disponivel && podeTranscreverEstaMusica && (
          <button
            type="button"
            /*
              A MESMA máquina das outras portas, com uma fila de um item: mesma
              barra, mesmo cancelamento, mesma revisão no fim. Um segundo caminho
              seria um segundo lugar onde os três divergem (a lição do M4, e o
              motivo de a V10.6 ter reusado este). A lista vem da PORTA, e não de
              um `[song.id]` montado aqui.
            */
            disabled={loteRodando}
            aria-describedby={loteRodando ? "editor-busca-bloqueada" : undefined}
            title="Escreve a letra ouvindo o áudio desta música, sem usar a internet. Nada é gravado sem você conferir."
            onClick={() => void startTranscricao(oferta.musicas)}
            className="rounded-md border border-[#0F766E] px-3 py-1.5 text-[14px] font-medium text-[#0F766E] hover:bg-[#F0FDFA] disabled:opacity-60"
          >
            {rotuloDeTranscreverEstaMusica(
              oferta.segundos,
              oferta.medidaNestaMaquina,
            )}
          </button>
        )}
        <span className="ml-auto flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 text-[14px] font-medium text-[#374151] hover:bg-[#F3F4F6] disabled:opacity-60"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleSave()}
            className="rounded-md bg-[#0F766E] px-3 py-1.5 text-[14px] font-medium text-white hover:bg-[#115E59] disabled:opacity-60"
          >
            Salvar no arquivo
          </button>
        </span>
      </div>
    </div>
  );
}
