import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getBackend, type AcessorioInfo } from "../lib/api";
import {
  ACESSORIO_CANCELADO,
  ACESSORIO_CORROMPIDO,
  ACESSORIO_INDETERMINADO,
  ACESSORIO_INDISPONIVEL,
  ACESSORIO_PRONTO,
  ACESSORIO_SEM_BINARIO,
  CONFERENCIA_PRECISA_DO_SOM,
  ETAPAS_FORA_DO_APP,
  MODOS,
  VAGALUME_URL,
  estimativaTexto,
  etapasDoFunil,
  formatarTamanho,
  opcoesDePasta,
  rotuloBaixarAcessorio,
  rotuloDoDisparo,
  textoDoAcessorioAusente,
  textoDoDownload,
  type ContagemCandidatas,
} from "../lib/curadoria";
import { buildFolderTree, isUnderFolder } from "../lib/folderTree";
import type { Modo } from "../lib/types";
import { getAppVersion } from "../lib/updater";
import { novoScanId, useEnrichStore } from "../stores/enrichStore";
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
        título, não na página inteira. Antes o `pr-36` estava no container:
        reservava de menos para o botão (144 px contra os 167 que ele ocupa)
        e de mais para o resto — a 1024 com o painel aberto, "Adicionar
        pasta" e "Reindexar tudo" perdiam 38 px de largura cada um por causa
        de um botão que está lá em cima.

        Hoje nada de Configurações fica na altura do botão; isso é sorte, não
        projeto — a seção de curadoria da F18 nasce exatamente aqui. O E2E
        mede esta view junto com as outras duas.
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
 * "Curadoria do acervo" (V8 — F18, Fase 1): escolher a pasta e disparar o
 * funil, de dentro do app.
 *
 * Mora AQUI, e não na lateral, de propósito: quem abre o Cancioneiro numa
 * reunião quer achar e tocar música, e não pode esbarrar num botão que dispara
 * minutos (ou horas) de processamento. Em troca, a seção nasce com a pasta que
 * estiver selecionada na lateral — o contexto que o ✎ dava de graça.
 *
 * Toda a copy desta seção parte de uma premissa dura: são ~40 pessoas curando
 * cada uma o próprio acervo, e NÃO HÁ SUPORTE. Nada aqui pode depender de
 * alguém explicar depois.
 */
function CuradoriaSection() {
  const allSongs = useLibraryStore((s) => s.allSongs);
  const folders = useLibraryStore((s) => s.folders);
  const folderFilter = useLibraryStore((s) => s.folderFilter);
  const vagalumeApiKey = useUiStore((s) => s.vagalumeApiKey);
  const setVagalumeApiKey = useUiStore((s) => s.setVagalumeApiKey);
  const startScan = useEnrichStore((s) => s.startScan);
  const openOverlay = useEnrichStore((s) => s.openOverlay);
  const status = useEnrichStore((s) => s.status);
  const progress = useEnrichStore((s) => s.progress);
  const propostas = useEnrichStore((s) => s.proposals.length);
  // depois do "Cancelar" o invoke ainda leva alguns segundos para responder:
  // liberar o disparo aí faria a segunda varredura correr por cima (M4)
  const encerrando = useEnrichStore((s) => s.scanInFlight && s.status !== "scanning");
  const varrendo = status === "scanning";

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
   * Quantas músicas há na pasta, ponto — fato local e barato. Não é a regra
   * do funil (essa é do backend): serve só para separar "está tudo completo"
   * de "não há nada aqui", que a contagem sozinha devolve como o mesmo zero.
   */
  const musicasNaPasta = useMemo(
    () =>
      allSongs.filter((s) => !pasta || isUnderFolder(s.file_path, pasta)).length,
    [allSongs, pasta],
  );

  /**
   * O acessório do som (V9). O estado dele decide TRÊS coisas nesta tela: se a
   * etapa 2 é listada no funil, se a conferência é possível, e quanto tempo a
   * estimativa promete. Uma consulta só, no topo da seção.
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
      return atual.map((a) => (a.nome === info.nome ? info : a));
    });
  }, []);

  const fpcalc = acessorios?.find((a) => a.nome === "fpcalc") ?? null;
  /** A etapa 2 vai rodar? Só com o acessório conferido e pronto. */
  const som = fpcalc?.estado === "pronto";
  /** As etapas que ESTA máquina vai executar — não as que o produto sabe. */
  const etapas = useMemo(() => etapasDoFunil(som), [som]);

  /**
   * O TRABALHO escolhido (V9). O padrão é o barato, sempre; e se o acessório
   * sumir com a conferência já escolhida, a tela volta sozinha para o padrão
   * em vez de oferecer um disparo que o backend não teria como executar.
   */
  const [modoEscolhido, setModoEscolhido] = useState<Modo>("completar");
  const modo: Modo = som ? modoEscolhido : "completar";

  /**
   * A contagem de candidatas vem do backend (`enrich_count`), pela MESMA
   * função que a varredura usa. Ela é assíncrona: recomeça a cada troca de
   * pasta, de MODO (a conferência olha outra população) e a cada mudança do
   * acervo, e enquanto não chega a tela diz que está contando — nunca "0".
   */
  const [contagem, setContagem] = useState<ContagemCandidatas>({
    estado: "contando",
  });
  useEffect(() => {
    let atual = true;
    setContagem({ estado: "contando" });
    getBackend()
      .enrichCount(pasta, modo)
      .then((total) => {
        if (atual) setContagem({ estado: "pronta", total });
      })
      .catch(() => {
        // contagem é conveniência; a busca não depende dela para rodar
        if (atual) setContagem({ estado: "indisponivel" });
      });
    return () => {
      atual = false;
    };
  }, [pasta, modo, allSongs]);

  /**
   * O disparo só é bloqueado por fatos SABIDOS: uma busca em andamento, uma
   * busca encerrando, uma pasta sem música ou uma contagem que voltou zero.
   * Contagem pendente ou indisponível NUNCA bloqueia — desabilitar o único
   * ponto de entrada do produto por não saber ainda é o defeito que o QA
   * reprovou, agora sem a desculpa da regra duplicada.
   */
  const pastaVazia = musicasNaPasta === 0;
  const nadaACurar = contagem.estado === "pronta" && contagem.total === 0;
  const bloqueado = varrendo || encerrando || pastaVazia || nadaACurar;
  // MÉDIO-14 — o motivo é TEXTO na tela, não `title=`: botão desabilitado não
  // recebe foco, e `title` não é anunciado de forma confiável por leitor de
  // tela. Fica ligado ao botão por aria-describedby.
  const motivo = varrendo
    ? "Uma busca de dados já está em andamento — espere ela terminar."
    : encerrando
      ? "Terminando de encerrar a busca anterior — aguarde alguns segundos."
      : pastaVazia
        ? "Não há música nesta pasta para procurar."
        : nadaACurar
          ? modo === "conferencia"
            ? // a conferência olha TODAS as músicas: chegar a zero aqui é não
              // haver nenhuma disponível, e não "está tudo completo". Frase
              // diferente da estimativa de propósito — a mesma sentença duas
              // vezes seguidas na tela é ruído, não reforço.
              "Não há o que conferir nesta pasta."
            : "Nenhuma música desta pasta precisa de busca agora."
          : null;

  return (
    <section className="mt-8 max-w-2xl" aria-labelledby="curadoria-titulo">
      <h2
        id="curadoria-titulo"
        className="text-[15px] font-medium text-[#111827]"
      >
        Curadoria do acervo
      </h2>

      {/*
        Passe de redução da V9: a frase dizia "mostra tudo para você conferir"
        e emendava "nada é gravado sem você conferir" — a mesma informação duas
        vezes, na mesma frase.
      */}
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
            <span className="font-medium">{etapa.nome}</span> — {etapa.explicacao}
          </li>
        ))}
      </ol>

      <p className="mt-2 text-[13px] leading-relaxed text-[#5B6472]">
        {ETAPAS_FORA_DO_APP} Roda em segundo plano: dá para continuar ouvindo
        música, e interromper quando quiser.
      </p>

      <AcessorioDoSom info={fpcalc} lista={acessorios} aoAtualizar={aoAtualizar} />

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
              {"  ".repeat(o.nivel)}
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {/*
        V9 — os dois trabalhos, lado a lado e nomeados. Rádio, e não um botão
        extra: eles são mutuamente exclusivos, o padrão precisa estar visível
        como padrão, e a diferença de CUSTO fica na explicação de cada um em
        vez de virar um parágrafo de aviso.
      */}
      <fieldset className="mt-4">
        <legend className="mb-1 text-[13px] font-medium text-[#374151]">
          O que fazer
        </legend>
        {MODOS.map((opcao) => {
          const bloqueado = opcao.modo === "conferencia" && !som;
          return (
            <label
              key={opcao.modo}
              className="flex items-start gap-2 py-0.5 text-[14px] text-[#374151]"
            >
              <input
                type="radio"
                name="curadoria-modo"
                value={opcao.modo}
                checked={modo === opcao.modo}
                disabled={bloqueado}
                aria-describedby={bloqueado ? "curadoria-modo-motivo" : undefined}
                onChange={() => setModoEscolhido(opcao.modo)}
                className="mt-1 h-4 w-4 shrink-0 accent-[#0F766E]"
              />
              <span>
                <span className="font-medium">{opcao.rotulo}</span> —{" "}
                {opcao.explicacao}
              </span>
            </label>
          );
        })}
        {/* motivo do bloqueio é CONTEÚDO, não `title=` (DECISIONS #87) */}
        {!som && (
          <p id="curadoria-modo-motivo" className="mt-0.5 pl-6 text-[13px] text-[#5B6472]">
            {CONFERENCIA_PRECISA_DO_SOM}
          </p>
        )}
      </fieldset>

      <p className="mt-2 text-[13px] text-[#5B6472]">
        {estimativaTexto({
          contagem,
          musicasNaPasta,
          modo,
          // A chave do Vagalume passou a ser NOSSA, embutida em tempo de build
          // (PRD V9): a etapa 4 roda em toda instalação distribuída, e o
          // frontend não tem como perguntar se esta build tem a chave. Contá-la
          // sempre é o lado certo de errar — estimativa que promete MENOS do
          // que leva é o defeito da DECISIONS #85.
          etapas: { som, vagalume: true },
        })}
      </p>

      <div className="mt-3">
        <button
          type="button"
          disabled={bloqueado}
          aria-describedby={motivo ? "curadoria-motivo" : undefined}
          onClick={() => void startScan(pasta, modo)}
          className="rounded-md bg-[#0F766E] px-4 py-2 text-[15px] font-medium text-white hover:bg-[#115E59] disabled:cursor-not-allowed disabled:bg-[#9CA3AF]"
        >
          {rotuloDoDisparo(modo)}
        </button>
        {motivo && (
          <p id="curadoria-motivo" className="mt-1 text-[13px] text-[#5B6472]">
            {motivo}
          </p>
        )}
      </div>

      {/*
        A varredura roda em segundo plano e o disparo agora acontece AQUI:
        voltar a Configurações tem de mostrar em que pé ela está, sem depender
        de a pessoa achar o indicador da lateral.
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

      <div className="mt-5 max-w-md">
        <label
          htmlFor="curadoria-vagalume"
          className="mb-1 block text-[13px] font-medium text-[#374151]"
        >
          Chave do Vagalume (opcional)
        </label>
        <input
          id="curadoria-vagalume"
          // Campo de TEXTO, não de senha: é a chave de um serviço gratuito da
          // própria pessoa, num app sem conta e sem telemetria — esconder
          // atrás de bolinhas só atrapalharia conferir a colagem. Ela fica
          // guardada em disco (localStorage das preferências), o que o texto
          // abaixo diz; não é impressa em log e não sai daqui a não ser como
          // parâmetro da consulta ao Vagalume.
          type="text"
          spellCheck={false}
          autoComplete="off"
          value={vagalumeApiKey}
          onChange={(e) => setVagalumeApiKey(e.target.value)}
          className="w-full rounded-md border border-[#D1D5DB] bg-white px-3 py-2 text-[15px] text-[#111827] outline-none focus:border-[#0F766E]"
        />
        {/*
          V9 — a chave passou a ser NOSSA, embutida em tempo de build. O campo
          fica (tem precedência, e é a saída se a nossa for bloqueada), mas
          deixou de ser pedágio: pedir chave de API a quem não abre terminal
          era um pedágio absurdo. O texto NÃO afirma que esta build tem a nossa
          chave — uma build sem o segredo (fork, desenvolvimento) não tem, e
          afirmar seria mentir sobre credencial (DECISIONS #84).
        */}
        <p className="mt-1 text-[13px] leading-relaxed text-[#5B6472]">
          Só é preciso preencher se a busca do Vagalume parar de funcionar. A
          chave é gratuita: crie a sua em{" "}
          <span className="select-text break-all text-[#0F766E]">
            {VAGALUME_URL}
          </span>{" "}
          e cole aqui.
        </p>
        {/*
          MÉDIO-10 — a chave é gravada em disco, junto das outras preferências,
          e quatro lugares do projeto diziam que não. O passe de redução da V9
          encurtou este parágrafo mas não tirou NADA dele: cada fato aqui é
          sobre uma credencial de outra pessoa guardada por nós, e é a única
          explicação que ela vai receber.
        */}
        <p className="mt-1 text-[13px] leading-relaxed text-[#5B6472]">
          Ela fica guardada neste computador, nas preferências do aplicativo.
          Não entra no banco de músicas, não é escrita nos MP3 e não vai a
          lugar nenhum além do próprio Vagalume.
        </p>
      </div>
    </section>
  );
}

/**
 * O acessório que liga o reconhecimento pelo som (PRD V9).
 *
 * As quatro regras do PRD estão aqui, e todas nasceram do mesmo fato: são ~40
 * pessoas sem suporte, e um download que dá errado sem explicação é um recurso
 * que morre calado.
 *
 * 1. **Nada baixa sozinho**: só existe download depois de um clique em cima de
 *    um texto que diz o que é, quanto ocupa e de onde vem.
 * 2. **Progresso e cancelamento**, não uma tela parada — a v0.8.1 já ensinou o
 *    custo disso (DECISIONS #92).
 * 3. **Baixou uma vez, não pergunta de novo**: no estado "pronto" não há botão.
 * 4. **Falha honesta**: a frase de erro vem PRONTA do backend e é mostrada como
 *    veio. Reescrevê-la aqui criaria uma segunda versão da verdade sobre uma
 *    verificação de segurança (a soma SHA-256) para quem não tem a quem
 *    perguntar.
 */
function AcessorioDoSom({
  info,
  lista,
  aoAtualizar,
}: {
  info: AcessorioInfo | null;
  /** `undefined` = perguntando; `null` = não deu para conferir; `[]` = não há. */
  lista: AcessorioInfo[] | null | undefined;
  aoAtualizar: (info: AcessorioInfo) => void;
}) {
  const [baixando, setBaixando] = useState<{
    baixados: number;
    total: number | null;
  } | null>(null);
  /** Desfecho do último download (cancelamento ou a frase do backend). */
  const [mensagem, setMensagem] = useState<string | null>(null);
  /** Download vivo: os eventos de qualquer outro são DESCARTADOS (M4). */
  const downloadAtual = useRef<string | null>(null);

  async function baixar() {
    if (!info) return;
    const id = novoScanId();
    downloadAtual.current = id;
    setMensagem(null);
    // o total só aparece quando o servidor o anunciar: começar em 0 de 0
    // desenharia uma barra cheia de um arquivo vazio (DECISIONS #86)
    setBaixando({ baixados: 0, total: null });
    let unlisten: (() => void) | null = null;
    try {
      unlisten = await getBackend().onAcessorioProgresso((p) => {
        if (p.download_id !== downloadAtual.current) return;
        setBaixando({ baixados: p.baixados, total: p.total });
      });
    } catch {
      // sem canal de progresso o download continua: só não há barra
    }
    try {
      const desfecho = await getBackend().acessorioBaixar(info.nome, id);
      // `cancelado` é campo, não dedução: cancelar e falhar terminam os dois
      // com o acessório ausente, e a tela precisa dizer qual dos dois foi
      if (desfecho.cancelado) setMensagem(ACESSORIO_CANCELADO);
      aoAtualizar(desfecho.acessorio);
    } catch (e) {
      // a frase já vem em pt-BR e explicando o que aconteceu com o arquivo
      setMensagem(String(e).replace(/^Error:\s*/, ""));
    } finally {
      unlisten?.();
      downloadAtual.current = null;
      setBaixando(null);
    }
  }

  function parar() {
    const id = downloadAtual.current;
    if (id) void getBackend().acessorioCancelar(id);
  }

  const estado = info?.estado;
  const podeBaixar = estado === "ausente" || estado === "corrompido";

  return (
    <section
      aria-labelledby="acessorio-som-titulo"
      className="mt-4 rounded-md border border-[#E5E7EB] bg-[#FFFFFF] p-4"
    >
      <h3
        id="acessorio-som-titulo"
        className="text-[14px] font-medium text-[#111827]"
      >
        Reconhecer música pelo som
      </h3>

      {/* enquanto a pergunta não volta nada é afirmado: nem que existe, nem
          que não existe, nem que está pronto */}
      {lista === null && (
        <p className="mt-1 text-[13px] text-[#5B6472]">{ACESSORIO_INDETERMINADO}</p>
      )}

      {lista?.length === 0 && (
        <p className="mt-1 text-[13px] text-[#5B6472]">{ACESSORIO_SEM_BINARIO}</p>
      )}

      {estado === "indisponivel" && (
        <p className="mt-1 text-[13px] text-[#5B6472]">{ACESSORIO_INDISPONIVEL}</p>
      )}

      {estado === "pronto" && (
        <p className="mt-1 text-[13px] text-[#115E59]">{ACESSORIO_PRONTO}</p>
      )}

      {estado === "corrompido" && (
        <p className="mt-1 text-[13px] text-[#854D0E]">{ACESSORIO_CORROMPIDO}</p>
      )}

      {info && podeBaixar && (
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
              onClick={() => void baixar()}
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
            {textoDoDownload(baixando.baixados, baixando.total)}
          </p>
          {/* barra determinada SÓ quando o servidor anunciou o tamanho */}
          {baixando.total !== null && (
            <div
              role="progressbar"
              aria-label="Progresso do download"
              aria-valuemin={0}
              aria-valuemax={baixando.total}
              aria-valuenow={baixando.baixados}
              aria-valuetext={`${formatarTamanho(baixando.baixados)} de ${formatarTamanho(baixando.total)}`}
              className="mt-1 h-1.5 w-full overflow-hidden rounded bg-[#E5E7EB]"
            >
              <div
                className="h-full bg-[#0F766E] transition-[width]"
                style={{ width: `${(baixando.baixados / baixando.total) * 100}%` }}
              />
            </div>
          )}
          <button
            type="button"
            onClick={parar}
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
