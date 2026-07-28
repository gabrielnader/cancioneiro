import { useEffect, useMemo, useState } from "react";
import { getBackend } from "../lib/api";
import {
  ETAPAS_DENTRO_DO_APP,
  ETAPAS_FORA_DO_APP,
  VAGALUME_URL,
  estimativaTexto,
  musicasACurar,
  opcoesDePasta,
} from "../lib/curadoria";
import { buildFolderTree } from "../lib/folderTree";
import { getAppVersion } from "../lib/updater";
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

  const candidatas = useMemo(
    () => musicasACurar(allSongs, pasta).length,
    [allSongs, pasta],
  );

  const bloqueado = varrendo || encerrando || candidatas === 0;
  const motivo = varrendo
    ? "Uma busca de dados já está em andamento"
    : encerrando
      ? "Terminando de encerrar a busca anterior — aguarde alguns segundos"
      : candidatas === 0
        ? "Não há música incompleta nesta pasta"
        : "Procurar título, artista e letra das músicas incompletas desta pasta";

  return (
    <section className="mt-8 max-w-2xl" aria-labelledby="curadoria-titulo">
      <h2
        id="curadoria-titulo"
        className="text-[15px] font-medium text-[#111827]"
      >
        Curadoria do acervo
      </h2>

      <p className="mt-2 text-[14px] leading-relaxed text-[#374151]">
        Procura na internet o que falta nas músicas de uma pasta — título,
        artista e letra — e mostra tudo para você conferir.{" "}
        <strong className="font-medium">
          Nada é gravado sem você conferir
        </strong>{" "}
        e marcar o que quer aplicar.
      </p>

      <p className="mt-2 text-[14px] text-[#374151]">A busca tem três etapas:</p>
      <ol className="mt-1 list-decimal space-y-0.5 pl-6 text-[14px] text-[#374151]">
        {ETAPAS_DENTRO_DO_APP.map((etapa) => (
          <li key={etapa.nome}>
            <span className="font-medium">{etapa.nome}</span> — {etapa.explicacao}
          </li>
        ))}
      </ol>

      <p className="mt-2 text-[13px] leading-relaxed text-[#5B6472]">
        {ETAPAS_FORA_DO_APP}
      </p>
      <p className="mt-1 text-[13px] leading-relaxed text-[#5B6472]">
        A busca pode levar minutos e roda em segundo plano: você continua
        procurando e tocando música enquanto ela acontece, e pode interromper
        quando quiser — o que já foi gravado permanece.
      </p>

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

      <p className="mt-2 text-[13px] text-[#5B6472]">{estimativaTexto(candidatas)}</p>

      <div className="mt-3">
        <button
          type="button"
          disabled={bloqueado}
          title={motivo}
          onClick={() => void startScan(pasta)}
          className="rounded-md bg-[#0F766E] px-4 py-2 text-[15px] font-medium text-white hover:bg-[#115E59] disabled:cursor-not-allowed disabled:bg-[#9CA3AF]"
        >
          Buscar dados desta pasta
        </button>
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
          // atrás de bolinhas só atrapalharia conferir a colagem. Ela nunca é
          // impressa em log nem sai daqui a não ser na consulta ao Vagalume.
          type="text"
          spellCheck={false}
          autoComplete="off"
          value={vagalumeApiKey}
          onChange={(e) => setVagalumeApiKey(e.target.value)}
          className="w-full rounded-md border border-[#D1D5DB] bg-white px-3 py-2 text-[15px] text-[#111827] outline-none focus:border-[#0F766E]"
        />
        <p className="mt-1 text-[13px] leading-relaxed text-[#5B6472]">
          O Vagalume é um site brasileiro de letras. A chave é gratuita e sua:
          crie a sua em{" "}
          <span className="select-text break-all text-[#0F766E]">
            {VAGALUME_URL}
          </span>{" "}
          e cole aqui. Sem a chave, a busca simplesmente pula essa etapa.
        </p>
      </div>
    </section>
  );
}
