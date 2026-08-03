import { useMemo, useState } from "react";
import { textoDoProgressoDaTranscricao } from "../lib/curadoria";
import { buildFolderTree, isUnderFolder, type FolderNode } from "../lib/folderTree";
import { useEnrichStore } from "../stores/enrichStore";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlaylistStore } from "../stores/playlistStore";
import { useUiStore } from "../stores/uiStore";
import { NewPlaylistDialog } from "./NewPlaylistDialog";

/** Sidebar esquerda 240px: navegação + playlists (F5). */
export function Sidebar() {
  const view = useUiStore((s) => s.view);
  const setView = useUiStore((s) => s.setView);
  const playlists = usePlaylistStore((s) => s.playlists);
  const activePlaylistId = usePlaylistStore((s) => s.activePlaylistId);
  const openPlaylist = usePlaylistStore((s) => s.openPlaylist);
  const closePlaylist = usePlaylistStore((s) => s.closePlaylist);
  const addToPlaylist = usePlaylistStore((s) => s.addToPlaylist);
  const renamePlaylist = usePlaylistStore((s) => s.renamePlaylist);
  const folders = useLibraryStore((s) => s.folders);
  const allSongs = useLibraryStore((s) => s.allSongs);
  const setFolderFilter = useLibraryStore((s) => s.setFolderFilter);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dragOverId, setDragOverId] = useState<number | null>(null);
  /** V13 — a playlist sendo renomeada, e o texto em edição. */
  const [renomeando, setRenomeando] = useState<number | null>(null);
  const [nomeNovo, setNomeNovo] = useState("");

  // Árvore de pastas do acervo (V4 — F11), derivada dos file_path.
  const folderTree = useMemo(
    () => buildFolderTree(allSongs, folders),
    [allSongs, folders],
  );

  function navClass(active: boolean) {
    return `block w-full rounded-md px-3 py-2 text-left text-[15px] ${
      active
        ? "bg-brand-soft font-medium text-brand"
        : "text-ink hover:bg-surface-hover"
    }`;
  }

  return (
    <nav className="flex h-full w-60 shrink-0 flex-col border-r border-border bg-surface p-3">
      <p className="px-3 pb-2 pt-1 text-[17px] font-semibold text-brand">
        Cancioneiro
      </p>
      <button
        type="button"
        className={navClass(view === "library")}
        onClick={() => {
          closePlaylist();
          setFolderFilter(null);
          setView("library");
        }}
      >
        Biblioteca
      </button>
      {folderTree.length > 0 && (
        <div className="max-h-64 shrink-0 overflow-y-auto">
          {folderTree.map((node) => (
            <FolderTreeItem key={node.path} node={node} level={0} />
          ))}
        </div>
      )}
      {/* V13 — o "+" fica ao lado do título da seção que ele preenche, e
          Configurações desceu para o pé: é ajuste, não navegação do dia a dia. */}
      <div className="mt-5 flex items-center justify-between gap-2 px-3">
        <p className="text-[12px] font-medium uppercase text-ink-tertiary">
          PLAYLISTS
        </p>
        <button
          type="button"
          aria-label="Nova playlist"
          title="Nova playlist"
          className="rounded p-0.5 text-[16px] leading-none text-brand hover:bg-brand-soft"
          onClick={() => setDialogOpen(true)}
        >
          +
        </button>
      </div>
      <div className="mt-1 flex-1 overflow-y-auto">
        {playlists.map((p) => (
          <div key={p.id} className="group flex items-center gap-1">
          {renomeando === p.id ? (
            /* V13 — renomear no lugar, sem caixa de diálogo: é uma palavra. */
            <input
              autoFocus
              aria-label={`Novo nome para ${p.name}`}
              className="w-full rounded-md border border-border bg-canvas px-3 py-2 text-[15px] text-ink"
              value={nomeNovo}
              onChange={(e) => setNomeNovo(e.target.value)}
              onBlur={() => setRenomeando(null)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setRenomeando(null);
                if (e.key !== "Enter") return;
                const nome = nomeNovo.trim();
                // nome vazio não grava: playlist sem nome some na lateral
                if (nome) void renamePlaylist(p.id, nome);
                setRenomeando(null);
              }}
            />
          ) : (
            <>
          <button
            type="button"
            className={`${navClass(view === "playlist" && activePlaylistId === p.id)} ${
              dragOverId === p.id ? "ring-2 ring-brand" : ""
            }`}
            onClick={() => {
              void openPlaylist(p.id);
              setView("playlist");
            }}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes("application/x-cancioneiro-song")) {
                e.preventDefault();
                setDragOverId(p.id);
              }
            }}
            onDragLeave={() => setDragOverId(null)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOverId(null);
              const songId = Number(
                e.dataTransfer.getData("application/x-cancioneiro-song"),
              );
              if (Number.isFinite(songId) && songId > 0) {
                void addToPlaylist(p.id, songId);
              }
            }}
          >
            <span className="flex items-center justify-between gap-2">
              <span className="truncate">{p.name}</span>
              <span className="shrink-0 text-[12px] text-disabled">
                {p.song_count}
              </span>
            </span>
          </button>
          {/* V13 — o ✎ é IRMÃO do botão, e não filho: clicável dentro de
              clicável é HTML inválido e confunde leitor de tela. */}
          <button
            type="button"
            aria-label={`Renomear playlist ${p.name}`}
            title="Renomear"
            className="shrink-0 rounded px-1 text-[12px] text-ink-tertiary hover:bg-surface-hover"
            onClick={() => {
              setNomeNovo(p.name);
              setRenomeando(p.id);
            }}
          >
            ✎
          </button>
            </>
          )}
          </div>
        ))}
      </div>
      <button
        type="button"
        className={`mt-2 ${navClass(view === "settings")}`}
        onClick={() => {
          closePlaylist();
          setView("settings");
        }}
      >
        Configurações
      </button>

      <EnrichBackgroundIndicator />

      <NewPlaylistDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </nav>
  );
}

/**
 * Rodapé da sidebar com a varredura que roda em segundo plano (F13): mostra a
 * contagem e a ETAPA do funil enquanto busca (V8/F18) e vira "Revisar N
 * propostas" quando termina sem o overlay na tela (o toast desta base não
 * carrega ação de clique). Clicar reabre o overlay.
 *
 * A varredura passou a ser disparada de Configurações, longe daqui — este
 * indicador é justamente o que garante que ela não some de vista por isso.
 */
function EnrichBackgroundIndicator() {
  const status = useEnrichStore((s) => s.status);
  const overlayOpen = useEnrichStore((s) => s.overlayOpen);
  const progress = useEnrichStore((s) => s.progress);
  const transcricaoProgress = useEnrichStore((s) => s.transcricaoProgress);
  const proposals = useEnrichStore((s) => s.proposals);
  const openOverlay = useEnrichStore((s) => s.openOverlay);

  if (status === "idle" || overlayOpen) return null;

  const contagem =
    status === "scanning"
      ? progress
        ? `Buscando dados… ${progress.done} de ${progress.total}`
        : "Buscando dados…"
      : // V10 — a etapa 5 leva HORAS em segundo plano: sem o indicador ela
        // desaparece de vista, e a pessoa não tem como voltar nem cancelar
        status === "transcribing"
        ? transcricaoProgress
          ? textoDoProgressoDaTranscricao(
              transcricaoProgress.done,
              transcricaoProgress.total,
            )
          : "Escrevendo as letras…"
        : proposals.length === 1
          ? "Revisar 1 proposta"
          : `Revisar ${proposals.length} propostas`;
  // backend antigo (ou evento inicial) pode vir sem etapa: a linha some
  const etapa =
    status === "scanning"
      ? (progress?.etapa ?? "")
      : status === "transcribing"
        ? (transcricaoProgress?.atual ?? "")
        : "";

  return (
    <button
      type="button"
      onClick={openOverlay}
      title="Abrir a revisão de dados"
      aria-label={etapa ? `${contagem} — ${etapa}` : contagem}
      className="mt-2 rounded-md bg-brand-soft px-3 py-2 text-left text-[13px] font-medium text-brand hover:bg-brand-soft-hover"
    >
      <span className="block truncate">{contagem}</span>
      {etapa && (
        // brand-strong sobre brand-soft = 7,27:1 no claro (e passa também no escuro)
        <span className="block truncate text-[12px] font-normal text-brand-strong">
          {etapa}
        </span>
      )}
    </button>
  );
}

/**
 * Item recursivo da árvore de pastas (V4 — F11): clique numa SUBPASTA filtra a
 * biblioteca. A pasta RAIZ (level 0, pasta registrada) equivale a "Biblioteca":
 * clicar nela LIMPA o filtro — sem chip 📁 (V5 Q2, o × na raiz assustava).
 *
 * V8/F18 — o ✎ que disparava a varredura em lote SAIU daqui. A lateral é para
 * navegar, e um botão que começa horas de processamento no meio da navegação
 * diária é convite a clique acidental. A varredura mudou de endereço: agora
 * mora em Configurações → "Curadoria do acervo", já apontando para a pasta que
 * estiver selecionada aqui — o contexto que o ✎ dava de graça.
 *
 * V12 (relato de campo, acervo de ~8.000 músicas) — pasta com subpasta abre e
 * fecha como no explorador de arquivos do sistema, e nasce FECHADA: com o
 * acervo inteiro a árvore virava uma parede de linhas. A setinha abre/fecha; o
 * NOME continua só filtrando (não rouba a ação que já existia). A pasta que
 * contém a seleção atual abre sozinha (`contemSelecao` abaixo) — sem isso, filtrar
 * uma subpasta bem funda e depois reabrir a lateral faria a pessoa se perder
 * numa árvore toda fechada. Nós FECHADOS não renderizam os filhos: com a
 * árvore nascendo fechada, o número de nós na tela não cresce com o tamanho
 * do acervo (só com a profundidade do caminho aberto) — dispensa virtualização
 * aqui (ver DECISIONS).
 */
function FolderTreeItem({ node, level }: { node: FolderNode; level: number }) {
  const folderFilter = useLibraryStore((s) => s.folderFilter);
  const setFolderFilter = useLibraryStore((s) => s.setFolderFilter);
  const setView = useUiStore((s) => s.setView);
  const closePlaylist = usePlaylistStore((s) => s.closePlaylist);
  const openFolders = useUiStore((s) => s.openFolders);
  const toggleFolder = useUiStore((s) => s.toggleFolder);
  const isRoot = level === 0;
  const active = !isRoot && folderFilter === node.path;
  const hasChildren = node.children.length > 0;
  // a seleção atual está DENTRO desta pasta (ela mesma ou uma subpasta dela)
  const contemSelecao =
    folderFilter !== null &&
    (folderFilter === node.path || isUnderFolder(folderFilter, node.path));
  const aberta = hasChildren && (openFolders.includes(node.path) || contemSelecao);

  return (
    <>
      <div className="flex w-full min-w-0 items-center gap-0.5 pr-2">
        {hasChildren ? (
          <button
            type="button"
            aria-label={`${aberta ? "Fechar" : "Abrir"} pasta ${node.name}`}
            aria-expanded={aberta}
            onClick={() => toggleFolder(node.path)}
            className="shrink-0 rounded p-0.5 text-ink-tertiary hover:bg-surface-hover"
            style={{ marginLeft: 8 + level * 14 }}
          >
            <span
              aria-hidden="true"
              className={`inline-block text-[10px] transition-transform ${aberta ? "rotate-90" : ""}`}
            >
              ▶
            </span>
          </button>
        ) : (
          // espaço reservado do tamanho da setinha: sem isso o nome de uma
          // pasta-folha desalinharia com o das pastas que têm seta
          <span className="w-[22px] shrink-0" style={{ marginLeft: 8 + level * 14 }} />
        )}
        <button
          type="button"
          aria-label={`Pasta ${node.name}`}
          title={node.path}
          className={`flex w-full min-w-0 items-center justify-between gap-2 rounded-md py-1 pl-1 text-left text-[14px] ${
            active
              ? "bg-brand-soft font-medium text-brand"
              : "text-ink-secondary hover:bg-surface-hover"
          }`}
          onClick={() => {
            closePlaylist();
            setFolderFilter(isRoot ? null : node.path);
            setView("library");
          }}
        >
          <span className="truncate">{node.name}</span>
          <span className="shrink-0 text-[12px] text-disabled">{node.count}</span>
        </button>
      </div>
      {aberta &&
        node.children.map((child) => (
          <FolderTreeItem key={child.path} node={child} level={level + 1} />
        ))}
    </>
  );
}
