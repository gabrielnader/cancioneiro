import { useEffect, useMemo, useState } from "react";
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
  const larguraLateral = useUiStore((s) => s.larguraLateral);
  const setLarguraLateral = useUiStore((s) => s.setLarguraLateral);
  const alturaArvore = useUiStore((s) => s.alturaArvore);
  const setAlturaArvore = useUiStore((s) => s.setAlturaArvore);
  /** V15 — em tela estreita a lateral é uma gaveta (ver `uiStore`). */
  const gavetaAberta = useUiStore((s) => s.gavetaAberta);
  const setGavetaAberta = useUiStore((s) => s.setGavetaAberta);
  /** Navegar pela gaveta fecha a gaveta: ela estava cobrindo o que se abriu. */
  const fecharGaveta = () => setGavetaAberta(false);

  // Árvore de pastas do acervo (V4 — F11), derivada dos file_path.
  const folderTree = useMemo(
    () => buildFolderTree(allSongs, folders),
    [allSongs, folders],
  );

  /*
    V14.2 — a abertura automática virou EMPURRÃO, e não trava.

    Quando o filtro de pasta muda, as ancestrais entram na lista de abertas
    uma vez. Daí em diante a setinha manda: fechar fecha e continua fechado.
    Antes isso era calculado a cada render, e a pasta com a seleção não podia
    ser fechada de jeito nenhum.
  */
  const folderFilterAtual = useLibraryStore((s) => s.folderFilter);
  useEffect(() => {
    if (!folderFilterAtual) return;
    const ancestrais: string[] = [];
    const visita = (nos: FolderNode[]) => {
      for (const n of nos) {
        if (
          n.children.length > 0 &&
          (folderFilterAtual === n.path || isUnderFolder(folderFilterAtual, n.path))
        ) {
          ancestrais.push(n.path);
          visita(n.children);
        }
      }
    };
    visita(folderTree);
    const faltando = ancestrais.filter((p) => !useUiStore.getState().openFolders.includes(p));
    for (const p of faltando) useUiStore.getState().toggleFolder(p);
  }, [folderFilterAtual, folderTree]);

  function navClass(active: boolean) {
    return `block min-h-12 w-full rounded-xl px-3 py-2.5 text-left text-[17px] ${
      active
        ? "bg-brand-soft font-medium text-brand"
        : "text-ink hover:bg-surface-hover"
    }`;
  }

  return (
    <>
    {/* V15 — o fundo escuro da gaveta: clicar fora fecha, como em todo app */}
    {gavetaAberta && (
      <div
        aria-hidden="true"
        className="absolute inset-0 z-30 bg-black/40 lg:hidden"
        onClick={fecharGaveta}
      />
    )}
    <nav
      aria-label="Listas e pastas"
      // V15 — tela larga: coluna fixa ao lado da lista. Tela estreita (zoom
      // alto, notebook pequeno): some, e volta como gaveta por cima da lista
      // pelo botão "Listas e pastas" do topo
      className={`relative flex h-full shrink-0 flex-col border-r border-border bg-surface p-3 max-lg:overflow-y-auto baixa:overflow-y-auto ${
        gavetaAberta
          ? "max-lg:absolute max-lg:inset-y-0 max-lg:left-0 max-lg:z-40 max-lg:max-w-[calc(100%-3rem)] max-lg:shadow-2xl"
          : "max-lg:hidden"
      }`}
      style={{ width: larguraLateral }}
    >
      {/* V14.1 — a alça de largura. Nomes de playlist são longos ("Chamada -
          Mistérios da...") e a coluna fixa de 240px cortava quase todos. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Ajustar largura do menu"
        title="Arraste para ajustar a largura"
        className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-brand-soft max-lg:hidden"
        onMouseDown={(e) => {
          e.preventDefault();
          const inicioX = e.clientX;
          const inicial = larguraLateral;
          const mover = (ev: MouseEvent) =>
            setLarguraLateral(inicial + (ev.clientX - inicioX));
          const soltar = () => {
            window.removeEventListener("mousemove", mover);
            window.removeEventListener("mouseup", soltar);
          };
          window.addEventListener("mousemove", mover);
          window.addEventListener("mouseup", soltar);
        }}
      />
      {/* o nome e a versão subiram para a barra do topo (V15) */}
      <button
        type="button"
        onClick={fecharGaveta}
        className="mb-2 hidden min-h-12 items-center justify-center gap-2 rounded-xl border-2 border-border-strong text-[16px] font-semibold text-ink hover:bg-surface-hover max-lg:flex"
      >
        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
        Fechar
      </button>
      <button
        type="button"
        className={navClass(view === "library" && folderFilterAtual === null)}
        onClick={() => {
          closePlaylist();
          setFolderFilter(null);
          setView("library");
          fecharGaveta();
        }}
      >
        <span className="flex items-center justify-between gap-2">
          <span>Todas as músicas</span>
          <span className="shrink-0 text-[14px] font-normal text-ink-tertiary">
            {allSongs.length.toLocaleString("pt-BR")}
          </span>
        </span>
      </button>
      {folderTree.length > 0 && (
        <>
          {/* em tela estreita ou baixa a árvore perde a altura fixa e a
              lateral inteira rola: com 450px de tela, uma árvore de 256px
              escondia as listas sem caminho até elas */}
          <div
            className="shrink-0 overflow-y-auto max-lg:!h-auto baixa:!h-auto"
            style={{ height: alturaArvore }}
          >
            {folderTree.map((node) => (
              <FolderTreeItem key={node.path} node={node} level={0} />
            ))}
          </div>
          {/* V14.2 — alça horizontal: com 7.894 músicas a árvore precisa de
              muito mais espaço que a lista de playlists, e com poucas pastas é
              o contrário. Quem sabe a proporção certa é quem está olhando. */}
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label="Ajustar altura da árvore de pastas"
            title="Arraste para ajustar a altura"
            className="my-1 h-1.5 shrink-0 cursor-row-resize rounded hover:bg-brand-soft max-lg:hidden baixa:hidden"
            onMouseDown={(e) => {
              e.preventDefault();
              const inicioY = e.clientY;
              const inicial = alturaArvore;
              const mover = (ev: MouseEvent) =>
                setAlturaArvore(inicial + (ev.clientY - inicioY));
              const soltar = () => {
                window.removeEventListener("mousemove", mover);
                window.removeEventListener("mouseup", soltar);
              };
              window.addEventListener("mousemove", mover);
              window.addEventListener("mouseup", soltar);
            }}
          />
        </>
      )}
      {/* V13 — o "+" fica ao lado do título da seção que ele preenche.
          V15 — e ganhou palavra: um "+" sozinho é ícone a adivinhar. */}
      <div className="mt-4 flex items-center justify-between gap-2 px-1">
        <p className="whitespace-nowrap px-2 text-[15px] font-semibold text-ink-secondary">
          Minhas listas
        </p>
        <button
          type="button"
          className="flex min-h-11 items-center gap-1 whitespace-nowrap rounded-xl border-2 border-dashed border-border-strong px-3 text-[15px] font-semibold text-brand hover:bg-brand-soft"
          onClick={() => setDialogOpen(true)}
        >
          <span aria-hidden="true" className="text-[18px] leading-none">+</span>
          Nova lista
        </button>
      </div>
      <div className="mt-1 flex-1 overflow-y-auto max-lg:flex-none max-lg:overflow-visible baixa:flex-none baixa:overflow-visible">
        {playlists.map((p) => (
          <div key={p.id} className="group flex items-center gap-1">
          {renomeando === p.id ? (
            /* V13 — renomear no lugar, sem caixa de diálogo: é uma palavra. */
            <input
              autoFocus
              aria-label={`Novo nome para ${p.name}`}
              className="min-h-12 w-full rounded-xl border-2 border-brand bg-canvas px-3 py-2 text-[17px] text-ink"
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
              fecharGaveta();
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
              <span className="shrink-0 text-[14px] text-ink-tertiary">
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
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-[16px] text-ink-tertiary hover:bg-surface-hover"
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
      {/* "Configurações" saiu daqui: virou "Organizar minhas músicas", no
          topo, à vista o tempo todo (V15) */}
      <EnrichBackgroundIndicator />

      <NewPlaylistDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </nav>
    </>
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
      className="mt-2 rounded-xl bg-brand-soft px-3 py-2.5 text-left text-[15px] font-medium text-brand hover:bg-brand-soft-hover"
    >
      <span className="block truncate">{contagem}</span>
      {etapa && (
        // brand-strong sobre brand-soft = 7,27:1 no claro (e passa também no escuro)
        <span className="block truncate text-[14px] font-normal text-brand-strong">
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
  const setGavetaAberta = useUiStore((s) => s.setGavetaAberta);
  const isRoot = level === 0;
  const active = !isRoot && folderFilter === node.path;
  const hasChildren = node.children.length > 0;
  /*
    V14.2 — quem manda no aberto/fechado é SÓ a lista de abertas.

    Antes havia um `|| contemSelecao`: a pasta que continha o filtro era
    forçada aberta, e clicar na setinha para fechar não tinha efeito nenhum.
    Relato de campo: "consigo abrir as pastas na setinha, mas pra fechar fica
    travando" — não era lentidão, era briga.

    A abertura automática continua existindo, mas virou um EMPURRÃO (o efeito
    no `Sidebar`, quando o filtro muda) em vez de uma trava permanente: ela
    põe as ancestrais na lista, e daí em diante a pessoa manda.
  */
  const aberta = hasChildren && openFolders.includes(node.path);

  return (
    <>
      <div className="flex w-full min-w-0 items-center gap-0.5 pr-2">
        {hasChildren ? (
          <button
            type="button"
            aria-label={`${aberta ? "Fechar" : "Abrir"} pasta ${node.name}`}
            aria-expanded={aberta}
            onClick={() => toggleFolder(node.path)}
            className="flex h-10 w-9 shrink-0 items-center justify-center rounded-lg text-ink-tertiary hover:bg-surface-hover"
            style={{ marginLeft: 2 + level * 16 }}
          >
            <span
              aria-hidden="true"
              className={`inline-block text-[12px] transition-transform ${aberta ? "rotate-90" : ""}`}
            >
              ▶
            </span>
          </button>
        ) : (
          // espaço reservado do tamanho da setinha: sem isso o nome de uma
          // pasta-folha desalinharia com o das pastas que têm seta
          <span className="w-9 shrink-0" style={{ marginLeft: 2 + level * 16 }} />
        )}
        <button
          type="button"
          aria-label={`Pasta ${node.name}`}
          title={node.path}
          className={`flex min-h-10 w-full min-w-0 items-center justify-between gap-2 rounded-lg py-1.5 pl-1 text-left text-[16px] ${
            active
              ? "bg-brand-soft font-medium text-brand"
              : "text-ink-secondary hover:bg-surface-hover"
          }`}
          onClick={() => {
            closePlaylist();
            setFolderFilter(isRoot ? null : node.path);
            setView("library");
            setGavetaAberta(false);
          }}
        >
          <span className="truncate">{node.name}</span>
          <span className="shrink-0 text-[14px] text-ink-tertiary">{node.count}</span>
        </button>
      </div>
      {aberta &&
        node.children.map((child) => (
          <FolderTreeItem key={child.path} node={child} level={level + 1} />
        ))}
    </>
  );
}
