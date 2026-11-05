import { useEffect, useState } from "react";
import { getBackend } from "../lib/api";
import { folderName, pastaDaMusica, songFileName, textoDaPasta } from "../lib/folderTree";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlaylistStore } from "../stores/playlistStore";
import { FONT_SIZES_PX, useUiStore } from "../stores/uiStore";
import { ORIGEM_TRANSCRICAO, type Song } from "../lib/types";
import { ConsertarArquivo } from "./ConsertarArquivo";
import { EditSongForm } from "./EditSongForm";
import { TemaChips } from "./TemaChips";

/** Painel lateral direito (F3): letra da música selecionada. */
export function LyricsPanel() {
  const selectedSongId = useLibraryStore((s) => s.selectedSongId);
  const results = useLibraryStore((s) => s.results);
  const playlistItems = usePlaylistStore((s) => s.items);
  const folders = useLibraryStore((s) => s.folders);
  const setFolderFilter = useLibraryStore((s) => s.setFolderFilter);
  const fontLevel = useUiStore((s) => s.fontLevel);
  const cycleFontLevel = useUiStore((s) => s.cycleFontLevel);

  const selected =
    results.find((r) => r.song.id === selectedSongId)?.song ??
    playlistItems.find((i) => i.song.id === selectedSongId)?.song ??
    null;

  // V6 — nome do arquivo (null quando o título já É o nome do arquivo).
  const nomeArquivo = selected ? songFileName(selected) : null;

  const [lyrics, setLyrics] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  // Incrementa após salvar para re-buscar a letra exibida (V4 F10).
  const [lyricsRefresh, setLyricsRefresh] = useState(0);

  // Trocar a seleção descarta um modo de edição aberto.
  useEffect(() => {
    setEditing(false);
  }, [selectedSongId]);

  useEffect(() => {
    let cancelled = false;
    if (selectedSongId === null || !selected?.has_lyrics) {
      setLyrics(null);
      return;
    }
    getBackend()
      .getLyrics(selectedSongId)
      .then((l) => {
        if (!cancelled) setLyrics(l);
      })
      .catch(() => {
        if (!cancelled) setLyrics(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedSongId, selected?.has_lyrics, lyricsRefresh]);

  return (
    <aside
      // V15 — em tela estreita os detalhes passam POR CIMA da lista, presos à
      // direita: lado a lado, 380px de painel deixavam a lista sem largura
      className="flex h-full w-[380px] shrink-0 flex-col border-l border-border bg-surface max-lg:absolute max-lg:inset-y-0 max-lg:right-0 max-lg:z-30 max-lg:max-w-[calc(100%-2rem)] max-lg:shadow-2xl"
      aria-label="Painel de letra"
      data-guia="detalhes"
    >
      {selected === null ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <p className="text-center text-disabled">
            Selecione uma música para ver a letra.
          </p>
        </div>
      ) : (
        <>
          <div className="flex items-start justify-between gap-2 border-b border-border p-4">
            <div className="min-w-0">
              <h2 className="truncate text-[18px] font-semibold text-ink">
                {selected.title}
              </h2>
              {selected.artist && (
                <p className="truncate text-[14px] text-ink-tertiary">
                  {selected.artist}
                </p>
              )}
              {/*
                V6 — nome do arquivo por extenso. É aqui que a coordenadora
                confere "é mesmo o arquivo que eu conheço?": nada de truncar e
                selecionável para copiar. Some quando o título já É o nome do
                arquivo (música sem tags), para não repetir o mesmo texto.
              */}
              {/*
                V15.10 — a pasta, por extenso, e clicável: mostra as outras
                músicas dela (o mesmo filtro da árvore da lateral). Quem se
                organiza por pasta chega à "vizinhança" da música sem procurar.
              */}
              {selected && pastaDaMusica(selected, folders) && (() => {
                const pasta = pastaDaMusica(selected, folders)!;
                const texto = pasta.partes.length > 0 ? textoDaPasta(pasta.partes) : folderName(pasta.caminho).normalize("NFC");
                return (
                  <button
                    type="button"
                    data-testid="panel-folder"
                    onClick={() => setFolderFilter(pasta.caminho)}
                    title="Ver as músicas desta pasta"
                    className="mt-1 flex max-w-full items-start gap-1 rounded text-left text-[13px] leading-5 text-brand underline-offset-2 hover:underline"
                  >
                    <svg aria-hidden="true" className="mt-[3px] shrink-0" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></svg>
                    <span className="break-words">
                      <span className="sr-only">Pasta: </span>
                      {texto}
                    </span>
                  </button>
                );
              })()}
              {nomeArquivo && (
                <p
                  data-testid="panel-filename"
                  // mesmo cinza da linha da lista (AA 4.5:1 em 12px, ver SongRow)
                  className="mt-0.5 select-text break-words text-[12px] leading-4 text-ink-quaternary"
                >
                  {nomeArquivo}
                </p>
              )}
              {/*
                V10.11 — os chips DOBRAM aqui (`expansivel`), e este é o
                container mais estreito em que eles aparecem: 240 px, do que
                sobra do painel de 380 px depois do `p-4`, do `gap-2` e dos
                botões "Editar"/"Aa". É essa largura que decide quantos aparecem
                antes do "+N" (ver `LIMITE_DE_TEMAS_VISIVEIS`).

                Expandir cabe porque o painel ROLA: a lista aberta empurra o
                conteúdo para baixo e nada é encoberto — ao contrário da linha
                da lista, cuja altura é calculada pela virtualização.
              */}
              {selected.temas && (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  <TemaChips
                    // a lista volta dobrada ao trocar de música: a pergunta
                    // "quais são os temas desta aqui?" é feita de novo a cada
                    // ficha, e um estado herdado responderia a da anterior
                    key={selected.id}
                    temas={selected.temas}
                    expansivel
                  />
                </div>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {!editing && (
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  data-guia="editar"
                  // aguarda a letra carregar para o formulário não abrir vazio
                  disabled={
                    !selected.available || (selected.has_lyrics && lyrics === null)
                  }
                  className="rounded px-2 py-1 text-[15px] font-medium text-brand hover:bg-brand-soft disabled:cursor-not-allowed disabled:text-disabled disabled:hover:bg-transparent"
                  title={
                    selected.available
                      ? "Editar título, artista, temas e letra"
                      : "Música indisponível: arquivo não encontrado"
                  }
                >
                  Editar
                </button>
              )}
              <button
                type="button"
                onClick={cycleFontLevel}
                className="rounded px-2 py-1 text-[15px] font-medium text-ink-secondary hover:bg-surface-hover"
                aria-label="Tamanho da fonte da letra"
                data-guia="aa"
                title="Tamanho da fonte"
              >
                Aa
              </button>
            </div>
          </div>
          {editing ? (
            <div data-guia="formulario-de-edicao" className="flex min-h-0 flex-1 flex-col">
            <EditSongForm
              key={selected.id}
              song={selected}
              initialLyrics={lyrics ?? ""}
              onCancel={() => setEditing(false)}
              onSaved={() => {
                setEditing(false);
                setLyricsRefresh((n) => n + 1);
              }}
            />
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto p-4">
              {selected.available && <ConsertarArquivo key={`c${selected.id}`} song={selected} />}
              {selected.available && <MinhasAnotacoes key={selected.id} song={selected} />}
              {selected.has_lyrics && lyrics ? (
                <>
                  {/*
                    V5/F14 — a letra saiu de transcrição automática do áudio.
                    Ressalva discreta (cinza, corpo pequeno), acima do texto:
                    quem lê precisa saber ANTES de projetar ou cantar, mas isto
                    não é um erro nem um alerta. O backend limpa a marca quando
                    a letra é trocada (DECISIONS #54), então o aviso vale
                    sempre pelo texto que está na tela.
                  */}
                  {selected.letra_origem === ORIGEM_TRANSCRICAO && (
                    <p
                      data-testid="lyrics-origem"
                      className="mb-3 border-l-2 border-border pl-2 text-[13px] leading-snug text-ink-tertiary"
                    >
                      Letra transcrita automaticamente do áudio — pode conter
                      erros.
                    </p>
                  )}
                  <p
                    data-testid="lyrics-body"
                    className="whitespace-pre-wrap text-ink"
                    style={{ fontSize: FONT_SIZES_PX[fontLevel], lineHeight: 1.7 }}
                  >
                    {lyrics}
                  </p>
                </>
              ) : selected.has_lyrics ? null : selected.instrumental ? (
                /*
                  V8/F17 — instrumental sem letra é informação, não cobrança:
                  o convite a "adicionar a letra" seria pedir o que a música
                  não tem. (Instrumental COM letra cai no ramo de cima e
                  mostra a letra normalmente.)
                */
                <div className="pt-4">
                  <p className="text-ink-tertiary">Música instrumental — sem letra.</p>
                </div>
              ) : (
                <div className="pt-4">
                  <p className="text-ink-tertiary">
                    Esta música ainda não tem letra registrada.
                  </p>
                  <p className="mt-2 text-disabled">
                    Use a ferramenta de curadoria para adicionar a letra ao arquivo.
                  </p>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </aside>
  );
}

/**
 * V16.2 — "Minhas anotações": o que a PESSOA escreveu sobre a música (o tom,
 * quando cantar, quem puxa). Fica acima da letra, porque é o que se procura
 * antes de cantar; entra na busca; e o pacote de letras do grupo nunca a toca.
 * Gravada no próprio MP3 (TXXX:ANOTACOES), como o resto: viaja com o arquivo.
 */
function MinhasAnotacoes({ song }: { song: Song }) {
  const [editando, setEditando] = useState(false);
  const [texto, setTexto] = useState(song.anotacoes ?? "");
  const [gravando, setGravando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function salvar() {
    setGravando(true);
    setErro(null);
    try {
      const atualizada = await getBackend().salvarAnotacoes(song.id, texto);
      useLibraryStore.getState().updateSong(atualizada);
      usePlaylistStore.getState().updateSongInItems(atualizada);
      setEditando(false);
    } catch (e) {
      setErro(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setGravando(false);
    }
  }

  if (editando) {
    return (
      <div className="mb-4 flex flex-col gap-2" data-testid="anotacoes-editor" data-guia="editor-de-anotacao">
        <label className="flex flex-col gap-1">
          <span className="text-[14px] font-semibold text-ink-secondary">Minhas anotações</span>
          <textarea
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
            rows={3}
            autoFocus
            className="rounded-lg border-2 border-border-strong bg-surface p-2 text-[16px] text-ink"
          />
        </label>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={gravando}
            onClick={() => void salvar()}
            className="rounded-lg bg-brand-fill px-3 py-1.5 text-[15px] font-semibold text-white hover:bg-brand-fill-hover disabled:opacity-60"
          >
            {gravando ? "Salvando…" : "Salvar"}
          </button>
          <button
            type="button"
            disabled={gravando}
            onClick={() => {
              setTexto(song.anotacoes ?? "");
              setErro(null);
              setEditando(false);
            }}
            className="rounded-lg px-3 py-1.5 text-[15px] font-semibold text-ink-secondary hover:bg-surface-hover"
          >
            Cancelar
          </button>
        </div>
        {erro && (
          <p role="alert" className="text-[14px] text-danger">
            Não deu para salvar: {erro}
          </p>
        )}
      </div>
    );
  }

  if (!song.anotacoes) {
    return (
      <button
        type="button"
        onClick={() => setEditando(true)}
        data-guia="escrever-anotacao"
        className="mb-3 rounded px-1 text-[14px] font-medium text-brand hover:bg-brand-soft"
      >
        + Escrever uma anotação
      </button>
    );
  }

  return (
    <div data-testid="anotacoes" className="mb-4 rounded-lg bg-surface-hover px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[14px] font-semibold text-ink-secondary">Minhas anotações</span>
        <button
          type="button"
          onClick={() => {
            setTexto(song.anotacoes ?? "");
            setEditando(true);
          }}
          aria-label="Editar a anotação"
          data-guia="escrever-anotacao"
          className="rounded px-2 text-[14px] font-medium text-brand hover:bg-brand-soft"
        >
          Editar
        </button>
      </div>
      <p className="mt-1 whitespace-pre-wrap text-[16px] text-ink">{song.anotacoes}</p>
    </div>
  );
}
