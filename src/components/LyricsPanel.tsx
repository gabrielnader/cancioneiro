import { useEffect, useState } from "react";
import { getBackend } from "../lib/api";
import { songFileName } from "../lib/folderTree";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlaylistStore } from "../stores/playlistStore";
import { FONT_SIZES_PX, useUiStore } from "../stores/uiStore";
import { ORIGEM_TRANSCRICAO } from "../lib/types";
import { EditSongForm } from "./EditSongForm";
import { TemaChips } from "./TemaChips";

/** Painel lateral direito (F3): letra da música selecionada. */
export function LyricsPanel() {
  const selectedSongId = useLibraryStore((s) => s.selectedSongId);
  const results = useLibraryStore((s) => s.results);
  const playlistItems = usePlaylistStore((s) => s.items);
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
      className="flex h-full w-[380px] shrink-0 flex-col border-l border-[#E5E7EB] bg-[#FFFFFF]"
      aria-label="Painel de letra"
    >
      {selected === null ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <p className="text-center text-[#9CA3AF]">
            Selecione uma música para ver a letra.
          </p>
        </div>
      ) : (
        <>
          <div className="flex items-start justify-between gap-2 border-b border-[#E5E7EB] p-4">
            <div className="min-w-0">
              <h2 className="truncate text-[18px] font-semibold text-[#111827]">
                {selected.title}
              </h2>
              {selected.artist && (
                <p className="truncate text-[14px] text-[#6B7280]">
                  {selected.artist}
                </p>
              )}
              {/*
                V6 — nome do arquivo por extenso. É aqui que a coordenadora
                confere "é mesmo o arquivo que eu conheço?": nada de truncar e
                selecionável para copiar. Some quando o título já É o nome do
                arquivo (música sem tags), para não repetir o mesmo texto.
              */}
              {nomeArquivo && (
                <p
                  data-testid="panel-filename"
                  className="mt-0.5 select-text break-words text-[12px] leading-4 text-[#9CA3AF]"
                >
                  {nomeArquivo}
                </p>
              )}
              {selected.temas && (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  <TemaChips temas={selected.temas} />
                </div>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {!editing && (
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  // aguarda a letra carregar para o formulário não abrir vazio
                  disabled={
                    !selected.available || (selected.has_lyrics && lyrics === null)
                  }
                  className="rounded px-2 py-1 text-[15px] font-medium text-[#0F766E] hover:bg-[#F0FDFA] disabled:cursor-not-allowed disabled:text-[#9CA3AF] disabled:hover:bg-transparent"
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
                className="rounded px-2 py-1 text-[15px] font-medium text-[#374151] hover:bg-[#F3F4F6]"
                aria-label="Tamanho da fonte da letra"
                title="Tamanho da fonte"
              >
                Aa
              </button>
            </div>
          </div>
          {editing ? (
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
          ) : (
            <div className="flex-1 overflow-y-auto p-4">
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
                      className="mb-3 border-l-2 border-[#E5E7EB] pl-2 text-[13px] leading-snug text-[#6B7280]"
                    >
                      Letra transcrita automaticamente do áudio — pode conter
                      erros.
                    </p>
                  )}
                  <p
                    data-testid="lyrics-body"
                    className="whitespace-pre-wrap text-[#111827]"
                    style={{ fontSize: FONT_SIZES_PX[fontLevel], lineHeight: 1.7 }}
                  >
                    {lyrics}
                  </p>
                </>
              ) : selected.has_lyrics ? null : (
                <div className="pt-4">
                  <p className="text-[#6B7280]">
                    Esta música ainda não tem letra registrada.
                  </p>
                  <p className="mt-2 text-[#9CA3AF]">
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
