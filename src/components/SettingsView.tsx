import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getBackend,
  type AcessorioInfo,
  type PendentesDaTranscricao,
} from "../lib/api";
import {
  ACESSORIO_CORROMPIDO,
  ACESSORIO_INDETERMINADO,
  ACESSORIO_INDISPONIVEL,
  ACESSORIO_PRONTO,
  ACESSORIO_SEM_BINARIO,
  ROTULO_COMECAR_TRANSCRICAO,
  ROTULO_DO_DISPARO,
  TRANSCRICAO_NO_FIM,
  downloadParaTranscrever,
  estadoDoAcessorio,
  estimativaTexto,
  etapasDoFunil,
  formatarTamanho,
  opcoesDePasta,
  rotuloBaixarAcessorio,
  textoDoAcessorioAusente,
  textoDoBlocoDeTranscricao,
  textoDoDownload,
  textoDoProgressoDaTranscricao,
  tituloDoAcessorio,
  type EstadoDaContagem,
} from "../lib/curadoria";
import { buildFolderTree, isUnderFolder } from "../lib/folderTree";
import { getAppVersion } from "../lib/updater";
import { useDownloadStore } from "../stores/downloadStore";
import { useEnrichStore } from "../stores/enrichStore";
import { useLibraryStore } from "../stores/libraryStore";
import { useToastStore } from "../stores/toastStore";
import { useUiStore } from "../stores/uiStore";
import { AddFolderButton } from "./AddFolderButton";
import { ConfirmDialog } from "./ConfirmDialog";

/**
 * Configurações (F1): pastas observadas, remover, reindexar. (V7/F16:
 * atualização. V8/F18: a curadoria do acervo, que saiu da árvore de pastas.)
 */
export function SettingsView() {
  const folders = useLibraryStore((s) => s.folders);
  const removeFolder = useLibraryStore((s) => s.removeFolder);
  const rescan = useLibraryStore((s) => s.rescan);
  const setScanning = useLibraryStore((s) => s.setScanning);
  const scanning = useLibraryStore((s) => s.scanning);
  const push = useToastStore((s) => s.push);
  const [confirmingFolderId, setConfirmingFolderId] = useState<number | null>(null);
  const checkUpdatesOnStart = useUiStore((s) => s.checkUpdatesOnStart);
  const setCheckUpdatesOnStart = useUiStore((s) => s.setCheckUpdatesOnStart);
  const [appVersion, setAppVersion] = useState<string | null>(null);

  // Versão vinda do próprio app (nunca uma string no código) — null no modo
  // web, onde a linha simplesmente não aparece.
  useEffect(() => {
    let alive = true;
    void getAppVersion().then((v) => {
      if (alive) setAppVersion(v);
    });
    return () => {
      alive = false;
    };
  }, []);

  async function handleRescan() {
    const unlisten = await getBackend().onScanProgress((p) =>
      setScanning({ done: p.done, total: p.total }),
    );
    try {
      const result = await rescan();
      push(`${result.total} músicas indexadas.`, "success");
    } catch (e) {
      push(String(e), "error");
    } finally {
      setScanning(null);
      unlisten();
    }
  }

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto bg-[#F9FAFB] p-6">
      {/*
        A faixa do botão flutuante (App.tsx) é reservada SÓ na linha do
        título, não na página inteira (DECISIONS #76).
      */}
      <h1 className="pr-[var(--faixa-detalhes)] text-[22px] font-semibold text-[#111827]">
        Configurações
      </h1>

      <section className="mt-6">
        <h2 className="text-[15px] font-medium text-[#111827]">
          Pastas de música
        </h2>
        {folders.length === 0 ? (
          <p className="mt-2 text-[#6B7280]">Nenhuma pasta adicionada.</p>
        ) : (
          <ul className="mt-2 divide-y divide-[#E5E7EB] rounded-md border border-[#E5E7EB] bg-white">
            {folders.map((f) => (
              <li
                key={f.id}
                className="flex items-center justify-between gap-4 px-4 py-2.5"
              >
                <span className="min-w-0 truncate text-[#111827]">{f.path}</span>
                <button
                  type="button"
                  className="shrink-0 rounded px-2 py-1 text-[14px] font-medium text-[#B91C1C] hover:bg-[#FEE2E2]"
                  onClick={() => setConfirmingFolderId(f.id)}
                >
                  Remover
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4 flex gap-3">
          <AddFolderButton variant="outline" />
          <button
            type="button"
            disabled={scanning !== null}
            className="rounded-md border border-[#0F766E] bg-transparent px-4 py-2 text-[15px] font-medium text-[#0F766E] hover:bg-[#F0FDFA] disabled:opacity-50"
            onClick={() => void handleRescan()}
          >
            Reindexar tudo
          </button>
        </div>
        {scanning && (
          <div className="mt-4 max-w-md">
            <p className="mb-1 text-[13px] text-[#6B7280]">
              Indexando… {scanning.done} de {scanning.total} arquivos
            </p>
            <div className="h-1.5 w-full overflow-hidden rounded bg-[#E5E7EB]">
              <div
                className="h-full bg-[#0F766E] transition-[width]"
                style={{
                  width:
                    scanning.total > 0
                      ? `${(scanning.done / scanning.total) * 100}%`
                      : "0%",
                }}
              />
            </div>
          </div>
        )}
      </section>

      <CuradoriaSection />

      <section className="mt-8">
        <h2 className="text-[15px] font-medium text-[#111827]">Atualizações</h2>
        <label className="mt-2 flex max-w-md items-start gap-3">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 accent-[#0F766E]"
            checked={checkUpdatesOnStart}
            onChange={(e) => setCheckUpdatesOnStart(e.target.checked)}
          />
          <span>
            <span className="text-[#111827]">
              Verificar atualizações ao abrir
            </span>
            <span className="mt-0.5 block text-[13px] text-[#6B7280]">
              Consulta apenas se existe uma versão nova. Nada do seu acervo sai
              do computador. Desligado, o Cancioneiro não acessa a internet ao
              abrir.
            </span>
          </span>
        </label>
        {appVersion && (
          <p className="mt-4 text-[13px] text-[#6B7280]">
            Versão instalada: {appVersion}
          </p>
        )}
      </section>

      <ConfirmDialog
        open={confirmingFolderId !== null}
        title="Remover esta pasta da biblioteca? Os arquivos não serão apagados do disco."
        confirmLabel="Remover"
        onCancel={() => setConfirmingFolderId(null)}
        onConfirm={() => {
          if (confirmingFolderId !== null) {
            void removeFolder(confirmingFolderId);
          }
          setConfirmingFolderId(null);
        }}
      />
    </div>
  );
}

/**
 * "Curadoria do acervo" (V8 — F18 fase 1; V9 fase 2; V10 fase 3): escolher a
 * pasta e disparar o funil, de dentro do app.
 *
 * Mora AQUI, e não na lateral, de propósito: quem abre o Cancioneiro numa
 * reunião quer achar e tocar música, e não pode esbarrar num botão que dispara
 * minutos (ou horas) de processamento. Em troca, a seção nasce com a pasta que
 * estiver selecionada na lateral — o contexto que o ✎ dava de graça.
 *
 * **V10 — um botão só** (DECISIONS #102). Os dois modos sumiram: modo é
 * escolha, e escolha é pedágio para quem não tem a quem perguntar.
 *
 * Toda a copy desta seção parte de uma premissa dura: são ~40 pessoas curando
 * cada uma o próprio acervo, e NÃO HÁ SUPORTE.
 */
function CuradoriaSection() {
  const allSongs = useLibraryStore((s) => s.allSongs);
  const folders = useLibraryStore((s) => s.folders);
  const folderFilter = useLibraryStore((s) => s.folderFilter);
  const startScan = useEnrichStore((s) => s.startScan);
  const startTranscricao = useEnrichStore((s) => s.startTranscricao);
  const openOverlay = useEnrichStore((s) => s.openOverlay);
  const status = useEnrichStore((s) => s.status);
  const progress = useEnrichStore((s) => s.progress);
  const transcricaoProgress = useEnrichStore((s) => s.transcricaoProgress);
  const propostas = useEnrichStore((s) => s.proposals.length);
  // depois do "Cancelar" o invoke ainda leva alguns segundos para responder:
  // liberar o disparo aí faria a segunda varredura correr por cima (M4)
  const encerrando = useEnrichStore(
    (s) => s.scanInFlight && s.status !== "scanning" && s.status !== "transcribing",
  );
  const varrendo = status === "scanning";
  const transcrevendo = status === "transcribing";

  const opcoes = useMemo(
    () => opcoesDePasta(buildFolderTree(allSongs, folders)),
    [allSongs, folders],
  );

  // Começa na pasta da lateral (PRD): quem estava olhando "Barco" e vem curar
  // não procura "Barco" de novo. Inicializador preguiçoso porque a seção é
  // remontada a cada visita a Configurações — é aí que a leitura acontece.
  const [escolhida, setEscolhida] = useState(() => folderFilter ?? "");
  // a pasta pode ter sumido do acervo desde então: cai na biblioteca inteira
  const pasta = opcoes.some((o) => o.path === escolhida) ? escolhida : "";

  /**
   * Quantas músicas há na pasta, ponto — fato local e barato. Não é a regra do
   * funil (essa é do backend): serve só para separar "não há nada aqui" do
   * resto, que a contagem sozinha devolve como o mesmo zero.
   */
  const musicasNaPasta = useMemo(
    () =>
      allSongs.filter((s) => !pasta || isUnderFolder(s.file_path, pasta)).length,
    [allSongs, pasta],
  );

  /**
   * Os acessórios desta máquina (V9; V10 são três).
   *
   * `undefined` = ainda perguntando; `null` = não deu para conferir (que NÃO é
   * "não existe" nem "está pronto" — DECISIONS #86); `[]` = não publicamos
   * binário para este computador.
   */
  const [acessorios, setAcessorios] = useState<AcessorioInfo[] | null | undefined>(
    undefined,
  );
  const recarregarAcessorios = useCallback(() => {
    getBackend()
      .acessoriosEstado()
      .then(setAcessorios)
      .catch(() => setAcessorios(null));
  }, []);
  useEffect(recarregarAcessorios, [recarregarAcessorios]);

  /** Substitui um acessório pelo estado que o próprio download devolveu. */
  const aoAtualizar = useCallback((info: AcessorioInfo) => {
    setAcessorios((atual) => {
      if (!atual || !atual.some((a) => a.nome === info.nome)) return [info];
      // devolver o MESMO array quando nada muda evita uma recontagem por
      // igualdade de referência (o efeito da contagem depende de `acessorios`)
      if (atual.some((a) => a.nome === info.nome && a === info)) return atual;
      return atual.map((a) => (a.nome === info.nome ? info : a));
    });
  }, []);

  /**
   * V10.4 — o desfecho dos downloads vem da STORE, e não de um callback do
   * cartão.
   *
   * O download sobrevive à navegação desde esta versão (ver `downloadStore`),
   * então ele pode terminar com esta tela fechada: quem volta relê a lista do
   * backend e está certo. O que este efeito cobre é o outro caso — o download
   * que termina com a tela ABERTA —, e ele lê a store em vez de um callback
   * porque quem termina o download já não é este componente.
   */
  const resultadosDoDownload = useDownloadStore((s) => s.resultados);
  useEffect(() => {
    for (const info of Object.values(resultadosDoDownload)) aoAtualizar(info);
  }, [resultadosDoDownload, aoAtualizar]);

  /**
   * A contagem vem do backend (`enrich_count`), pela MESMA função que a
   * varredura usa — e desde a V10 ela traz também a ESTIMATIVA e a lista de
   * etapas. Recomeça a cada troca de pasta, a cada mudança do acervo e a cada
   * acessório instalado (a etapa 2 entra na conta). Enquanto não chega, a tela
   * diz que está contando.
   *
   * Ela não leva credencial nenhuma: nenhuma etapa do funil pede (DECISIONS
   * #110).
   */
  const [contagem, setContagem] = useState<EstadoDaContagem>({
    estado: "contando",
  });
  /** A pasta cujo número está na tela — para saber se ele ainda descreve algo. */
  const pastaContada = useRef<string | null>(null);
  useEffect(() => {
    let atual = true;
    // "Contando…" quando o número que está na tela não descreve mais nada: a
    // primeira contagem, ou uma troca de PASTA (o número da pasta anterior
    // descreveria outra coisa). Numa recontagem por acessório recém-instalado
    // o número continua valendo até a resposta chegar: piscar a lista de
    // etapas para vazia e voltar é ruído, e ruído numa tela sem suporte é
    // dúvida.
    const trocouDePasta = pastaContada.current !== pasta;
    setContagem((prev) =>
      prev.estado === "pronta" && !trocouDePasta ? prev : { estado: "contando" },
    );
    getBackend()
      .enrichCount(pasta)
      .then((c) => {
        if (!atual) return;
        pastaContada.current = pasta;
        setContagem({ estado: "pronta", contagem: c });
      })
      .catch(() => {
        // contagem é conveniência; a busca não depende dela para rodar
        if (atual) setContagem({ estado: "indisponivel" });
      });
    return () => {
      atual = false;
    };
  }, [pasta, allSongs, acessorios]);

  /**
   * **V10.6 — a etapa 5, permanentemente.**
   *
   * "Quais músicas estão sem letra" é fato da BIBLIOTECA, e estava amarrado ao
   * resultado de uma varredura: a oferta só existia dentro da caixa de revisão,
   * e qualquer fechamento (aplicar, Esc, segundo plano) jogava a lista fora —
   * recuperá-la custava a varredura inteira. O relato de campo que trouxe isto:
   * *"agora tenho que começar de novo pra chegar na parte de transcrição de
   * novo"*.
   *
   * `undefined` = a pergunta ainda não voltou; `null` = ela falhou. Nenhum dos
   * dois vira zero, e nenhum vira promessa (DECISIONS #86): sem resposta, o
   * bloco não desenha nada.
   *
   * Reperguntada nas MESMAS condições da contagem — troca de pasta, mudança do
   * acervo (aplicar uma letra tira a música da lista) e acessório instalado.
   */
  const [pendentes, setPendentes] = useState<
    PendentesDaTranscricao | null | undefined
  >(undefined);
  useEffect(() => {
    let atual = true;
    getBackend()
      .transcricaoPendentes(pasta)
      .then((p) => {
        if (atual) setPendentes(p);
      })
      .catch(() => {
        // "não sabemos" é um estado: o bloco desaparece em vez de afirmar zero
        if (atual) setPendentes(null);
      });
    return () => {
      atual = false;
    };
  }, [pasta, allSongs, acessorios]);

  /**
   * As etapas que ESTA máquina vai executar — a lista vem do backend
   * (DECISIONS #101), e a tela só acrescenta a frase que explica cada uma.
   */
  const etapas = useMemo(
    () =>
      etapasDoFunil(
        contagem.estado === "pronta" ? contagem.contagem.etapas : [],
      ),
    [contagem],
  );

  /**
   * O disparo só é bloqueado por fatos SABIDOS: um trabalho em andamento, uma
   * busca encerrando, uma pasta sem música ou uma contagem que voltou zero.
   * Contagem pendente ou indisponível NUNCA bloqueia — desabilitar o único
   * ponto de entrada do produto por não saber ainda é o defeito que o QA
   * reprovou (DECISIONS #80).
   */
  const pastaVazia = musicasNaPasta === 0;
  const nadaACurar =
    contagem.estado === "pronta" && contagem.contagem.total === 0;
  const bloqueado =
    varrendo || transcrevendo || encerrando || pastaVazia || nadaACurar;
  // MÉDIO-14 — o motivo é TEXTO na tela, não `title=`: botão desabilitado não
  // recebe foco, e `title` não é anunciado de forma confiável por leitor de
  // tela. Fica ligado ao botão por aria-describedby.
  const motivo = varrendo
    ? "Uma busca de dados já está em andamento — espere ela terminar."
    : transcrevendo
      ? "As letras estão sendo escritas — espere elas terminarem."
      : encerrando
        ? "Terminando de encerrar a busca anterior — aguarde alguns segundos."
        : pastaVazia
          ? "Não há música nesta pasta para procurar."
          : nadaACurar
            ? "Não há música disponível nesta pasta para procurar."
            : null;

  return (
    <section className="mt-8 max-w-2xl" aria-labelledby="curadoria-titulo">
      <h2
        id="curadoria-titulo"
        className="text-[15px] font-medium text-[#111827]"
      >
        Curadoria do acervo
      </h2>

      <p className="mt-2 text-[14px] leading-relaxed text-[#374151]">
        Procura o que falta nas músicas de uma pasta — título, artista e letra.{" "}
        <strong className="font-medium">
          Nada é gravado sem você conferir
        </strong>{" "}
        e marcar o que quer aplicar.
      </p>

      <ol className="mt-2 list-decimal space-y-0.5 pl-6 text-[14px] text-[#374151]">
        {etapas.map((etapa) => (
          <li key={etapa.nome}>
            <span className="font-medium">{etapa.nome}</span>
            {etapa.explicacao && <> — {etapa.explicacao}</>}
          </li>
        ))}
      </ol>

      {/*
        V10 — a etapa 5 NÃO entra na lista numerada: ela não é uma etapa da
        varredura. Custa minutos por música, e a pergunta é feita no fim,
        quando o app já sabe quantas sobraram sem letra.
      */}
      <p className="mt-2 text-[13px] leading-relaxed text-[#5B6472]">
        {TRANSCRICAO_NO_FIM} Roda em segundo plano: dá para continuar ouvindo
        música, e interromper quando quiser.
      </p>

      <Acessorios lista={acessorios} />

      <div className="mt-4 max-w-md">
        <label
          htmlFor="curadoria-pasta"
          className="mb-1 block text-[13px] font-medium text-[#374151]"
        >
          Pasta a curar
        </label>
        <select
          id="curadoria-pasta"
          value={pasta}
          onChange={(e) => setEscolhida(e.target.value)}
          className="w-full rounded-md border border-[#D1D5DB] bg-white px-3 py-2 text-[15px] text-[#111827] outline-none focus:border-[#0F766E]"
        >
          {opcoes.map((o) => (
            <option key={o.path || "__tudo__"} value={o.path}>
              {/* recuo com espaço inquebrável: <option> não aceita layout */}
              {"  ".repeat(o.nivel)}
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <p className="mt-2 text-[13px] text-[#5B6472]">
        {estimativaTexto({ contagem, musicasNaPasta })}
      </p>

      <div className="mt-3">
        <button
          type="button"
          disabled={bloqueado}
          aria-describedby={motivo ? "curadoria-motivo" : undefined}
          onClick={() =>
            void startScan(pasta, {
              // quem sabe se a etapa 5 existe nesta máquina é a CONTAGEM:
              // combinar dois estados de acessório é regra, e regra duplicada
              // em duas linguagens diverge (DECISIONS #80)
              disponivel:
                contagem.estado === "pronta" &&
                contagem.contagem.transcricao_disponivel,
              // e o que falta baixar, quando falta — com tamanho e tempo
              download: downloadParaTranscrever(acessorios),
            })
          }
          className="rounded-md bg-[#0F766E] px-4 py-2 text-[15px] font-medium text-white hover:bg-[#115E59] disabled:cursor-not-allowed disabled:bg-[#9CA3AF]"
        >
          {ROTULO_DO_DISPARO}
        </button>
        {motivo && (
          <p id="curadoria-motivo" className="mt-1 text-[13px] text-[#5B6472]">
            {motivo}
          </p>
        )}
      </div>

      {/*
        O trabalho roda em segundo plano e o disparo acontece AQUI: voltar a
        Configurações tem de mostrar em que pé ele está, sem depender de a
        pessoa achar o indicador da lateral.
      */}
      {varrendo && (
        <div className="mt-4 rounded-md bg-[#F0FDFA] px-4 py-3">
          <p className="text-[14px] font-medium text-[#115E59]">
            {progress
              ? `Buscando dados… ${progress.done} de ${progress.total}`
              : "Buscando dados…"}
          </p>
          {progress?.etapa && (
            <p className="mt-0.5 text-[13px] text-[#115E59]">{progress.etapa}</p>
          )}
          <button
            type="button"
            onClick={openOverlay}
            className="mt-2 rounded-md border border-[#0F766E] px-3 py-1.5 text-[14px] font-medium text-[#0F766E] hover:bg-[#CCFBF1]"
          >
            Acompanhar a busca
          </button>
        </div>
      )}
      {/* V10 — a etapa 5 leva HORAS: ela precisa do mesmo caminho de volta */}
      {transcrevendo && (
        <div className="mt-4 rounded-md bg-[#F0FDFA] px-4 py-3">
          <p className="text-[14px] font-medium text-[#115E59]">
            {transcricaoProgress
              ? textoDoProgressoDaTranscricao(
                  transcricaoProgress.done,
                  transcricaoProgress.total,
                )
              : "Escrevendo as letras…"}
          </p>
          <button
            type="button"
            onClick={openOverlay}
            className="mt-2 rounded-md border border-[#0F766E] px-3 py-1.5 text-[14px] font-medium text-[#0F766E] hover:bg-[#CCFBF1]"
          >
            Acompanhar a escrita
          </button>
        </div>
      )}
      {status === "review" && (
        <div className="mt-4 rounded-md bg-[#F0FDFA] px-4 py-3">
          <p className="text-[14px] font-medium text-[#115E59]">
            {propostas === 1
              ? "1 proposta esperando a sua conferência."
              : `${propostas} propostas esperando a sua conferência.`}
          </p>
          <button
            type="button"
            onClick={openOverlay}
            className="mt-2 rounded-md border border-[#0F766E] px-3 py-1.5 text-[14px] font-medium text-[#0F766E] hover:bg-[#CCFBF1]"
          >
            Abrir a revisão
          </button>
        </div>
      )}

      {/*
        V10.6 — A SEGUNDA PORTA DA ETAPA 5, e ela é permanente.

        A pergunta do fim da varredura continua existindo: ela é o momento
        natural, feita quando pode ser respondida com informação. O que muda é
        que ela deixou de ser a ÚNICA porta — e era isso que fazia "aplicar as 28
        propostas" e "transcrever as que sobraram" competirem, com a varredura
        inteira como preço de escolher a ordem errada.

        Mora no fim da seção de curadoria, embaixo do MESMO seletor de pasta: a
        seção não pode inventar um segundo vocabulário de pastas, e o texto diz
        de qual escopo o número fala.
      */}
      {pendentes != null && (
        <div className="mt-6 border-t border-[#E5E7EB] pt-4">
          <h3 className="text-[14px] font-medium text-[#111827]">
            Escrever a letra ouvindo o áudio
          </h3>
          <p className="mt-1 text-[14px] leading-relaxed text-[#374151]">
            {textoDoBlocoDeTranscricao({
              quantas: pendentes.musicas.length,
              segundos: pendentes.segundos_estimados,
              medidaNestaMaquina: pendentes.estimativa_medida_nesta_maquina,
              disponivel: pendentes.disponivel,
              // o que falta baixar sai da MESMA leitura dos acessórios que a
              // pergunta do fim usa
              download: downloadParaTranscrever(acessorios),
              todaABiblioteca: pasta === "",
            })}
          </p>
          {pendentes.disponivel && pendentes.musicas.length > 0 && (
            <button
              type="button"
              // duas filas ao mesmo tempo disputariam a CPU e embaralhariam as
              // duas barras (a disciplina do M4): a store recusaria, e um botão
              // que não faz nada é pior que um botão desabilitado com motivo
              disabled={bloqueado}
              aria-describedby={motivo ? "curadoria-motivo" : undefined}
              onClick={() => void startTranscricao(pendentes.musicas)}
              className="mt-2 rounded-md bg-[#0F766E] px-4 py-2 text-[15px] font-medium text-white hover:bg-[#115E59] disabled:cursor-not-allowed disabled:bg-[#9CA3AF]"
            >
              {ROTULO_COMECAR_TRANSCRICAO}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * Os acessórios que este computador pode baixar (PRD V9; V10 são três).
 *
 * As quatro regras do PRD estão aqui, e todas nasceram do mesmo fato: são ~40
 * pessoas sem suporte, e um download que dá errado sem explicação é um recurso
 * que morre calado.
 *
 * 1. **Nada baixa sozinho**: só existe download depois de um clique em cima de
 *    um texto que diz o que é, quanto ocupa, quanto TEMPO leva e de onde vem.
 * 2. **Progresso e cancelamento**, não uma tela parada (DECISIONS #92) — e,
 *    desde a V10.4, progresso que SOBREVIVE a sair desta tela: o download é do
 *    aplicativo, não do componente (ver `downloadStore`).
 * 3. **Baixou uma vez, não pergunta de novo**: no estado "pronto" não há botão.
 * 4. **Falha honesta**: a frase de erro vem PRONTA do backend e é mostrada como
 *    veio. Reescrevê-la aqui criaria uma segunda versão da verdade sobre uma
 *    verificação de segurança (a soma SHA-256).
 */
function Acessorios({
  lista,
}: {
  /** `undefined` = perguntando; `null` = não deu para conferir; `[]` = não há. */
  lista: AcessorioInfo[] | null | undefined;
}) {
  return (
    <div className="mt-4 space-y-3">
      {/* enquanto a pergunta não volta nada é afirmado: nem que existe, nem
          que não existe, nem que está pronto (DECISIONS #86) */}
      {lista === null && (
        <p className="text-[13px] text-[#5B6472]">{ACESSORIO_INDETERMINADO}</p>
      )}
      {lista?.length === 0 && (
        <p className="text-[13px] text-[#5B6472]">{ACESSORIO_SEM_BINARIO}</p>
      )}
      {(lista ?? []).map((info) => (
        <CartaoDoAcessorio key={info.nome} info={info} lista={lista} />
      ))}
    </div>
  );
}

/**
 * O total do download em que dá para CONFIAR — `null` quando não há um.
 *
 * `Content-Length` que mente para menos existe de verdade (proxy que
 * recomprime, CDN mal configurado), e um total já ultrapassado não é um total:
 * é um número velho. Grampear em 100% seria a outra mentira. "Não sabemos" é
 * um estado (DECISIONS #86), e daqui ele vale para a barra E para o texto.
 *
 * Zero entra na mesma regra: `0 / 0` vira `NaN`, e `width: NaN%` é uma barra
 * que o navegador ignora em silêncio.
 */
function totalConfiavel(p: { baixados: number; total: number | null }): number | null {
  if (p.total === null || p.total <= 0 || p.total < p.baixados) return null;
  return p.total;
}

function CartaoDoAcessorio({
  info,
  lista,
}: {
  info: AcessorioInfo;
  lista: AcessorioInfo[] | null | undefined;
}) {
  /**
   * V10.4 — TUDO sobre o download vem da store, e nada dele nasce aqui.
   *
   * O `useState` que morava neste componente era o defeito D1 inteiro: a tela
   * de Configurações é desmontada ao trocar de view, e com ela iam embora o
   * progresso, a assinatura do evento e o lugar onde o desfecho apareceria —
   * enquanto o download continuava vivo no backend, invisível. Voltar
   * mostrava o botão "Baixar" de novo, e clicar nele punha dois downloads
   * escrevendo o mesmo `.parcial`.
   */
  const baixando = useDownloadStore((s) => s.emCurso[info.nome] ?? null);
  /** Desfecho do último download (cancelamento ou a frase do backend). */
  const mensagem = useDownloadStore((s) => s.mensagens[info.nome] ?? null);
  const baixar = useDownloadStore((s) => s.baixar);
  const parar = useDownloadStore((s) => s.parar);

  // A leitura do estado mora num lugar só: um acessório que sumiu da lista não
  // é o mesmo que um acessório ausente, e um estado que esta versão não
  // conhece não pode virar "pronto" por otimismo (DECISIONS #86).
  const estado = estadoDoAcessorio(lista, info.nome);
  const podeBaixar = estado === "ausente" || estado === "corrompido";
  const tituloId = `acessorio-${info.nome}`;

  return (
    <section
      aria-labelledby={tituloId}
      className="rounded-md border border-[#E5E7EB] bg-[#FFFFFF] p-4"
    >
      {/* o "para que serve" vem PRONTO do backend, em pt-BR: quem cura não
          sabe (e não precisa saber) o que é "impressão digital acústica" */}
      <h3 id={tituloId} className="text-[14px] font-medium text-[#111827]">
        {tituloDoAcessorio(info)}
      </h3>

      {estado === "indisponivel" && (
        <p className="mt-1 text-[13px] text-[#5B6472]">{ACESSORIO_INDISPONIVEL}</p>
      )}

      {estado === "pronto" && (
        <p className="mt-1 text-[13px] text-[#115E59]">{ACESSORIO_PRONTO}</p>
      )}

      {estado === "corrompido" && (
        <p className="mt-1 text-[13px] text-[#854D0E]">{ACESSORIO_CORROMPIDO}</p>
      )}

      {podeBaixar && (
        <>
          <p className="mt-1 text-[13px] leading-relaxed text-[#374151]">
            {textoDoAcessorioAusente(info)}
          </p>
          {/* a origem à vista: é o que permite a alguém conferir de onde veio */}
          <p className="mt-1 text-[13px] leading-relaxed text-[#5B6472]">
            Vem de{" "}
            <span className="select-text break-all text-[#0F766E]">
              {info.origem}
            </span>
          </p>
          {baixando === null && (
            <button
              type="button"
              onClick={() => void baixar(info.nome)}
              className="mt-2 rounded-md border border-[#0F766E] px-3 py-1.5 text-[14px] font-medium text-[#0F766E] hover:bg-[#F0FDFA]"
            >
              {rotuloBaixarAcessorio(info, estado === "corrompido")}
            </button>
          )}
        </>
      )}

      {baixando !== null && (
        <div className="mt-2">
          <p className="text-[13px] text-[#374151]">
            {textoDoDownload(
              baixando.baixados,
              totalConfiavel(baixando),
              baixando.segundosRestantes,
            )}
          </p>
          {/*
            Barra determinada SÓ com um total em que dá para confiar — ver
            `totalConfiavel`. Sem isso, um `Content-Length` mentindo para menos
            fazia a largura passar de 100% e o `aria-valuenow` ficar MAIOR que
            o `aria-valuemax`, o que é um progressbar inválido (BAIXO-3).
          */}
          {totalConfiavel(baixando) !== null && (
            <div
              role="progressbar"
              aria-label="Progresso do download"
              aria-valuemin={0}
              aria-valuemax={baixando.total!}
              aria-valuenow={baixando.baixados}
              aria-valuetext={`${formatarTamanho(baixando.baixados)} de ${formatarTamanho(baixando.total!)}`}
              className="mt-1 h-1.5 w-full overflow-hidden rounded bg-[#E5E7EB]"
            >
              <div
                className="h-full bg-[#0F766E] transition-[width]"
                style={{ width: `${(baixando.baixados / baixando.total!) * 100}%` }}
              />
            </div>
          )}
          <button
            type="button"
            onClick={() => parar(info.nome)}
            className="mt-2 rounded-md px-3 py-1.5 text-[14px] font-medium text-[#374151] hover:bg-[#F3F4F6]"
          >
            Parar
          </button>
        </div>
      )}

      {mensagem !== null && baixando === null && (
        <p className="mt-2 text-[13px] leading-relaxed text-[#854D0E]">
          {mensagem}
        </p>
      )}
    </section>
  );
}
