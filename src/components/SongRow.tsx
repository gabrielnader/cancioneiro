import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { songFileName } from "../lib/folderTree";
import { parseSnippet } from "../lib/highlight";
import type { Song } from "../lib/types";
import { usePlayerStore } from "../stores/playerStore";
import { usePlaylistStore } from "../stores/playlistStore";
import { TemaChips } from "./TemaChips";

interface SongRowProps {
  song: Song;
  snippet: string | null;
  selected: boolean;
  onSelect: () => void;
  onPlay: () => void;
}

/** Linha de música (biblioteca/busca): clique seleciona, duplo-clique toca. */
export function SongRow({ song, snippet, selected, onSelect, onPlay }: SongRowProps) {
  const isCurrent = usePlayerStore((s) => s.current?.id === song.id);
  const isPlaying = usePlayerStore((s) => s.isPlaying && s.current?.id === song.id);
  const playlists = usePlaylistStore((s) => s.playlists);
  const addToPlaylist = usePlaylistStore((s) => s.addToPlaylist);
  // Menu em portal: as linhas virtualizadas usam transform (stacking context
  // próprio), então um dropdown inline ficaria por baixo da linha seguinte.
  const [menuPos, setMenuPos] = useState<{
    top: number;
    left: number;
    /** V13.2 — altura máxima: sem ela o menu passava da tela e as últimas
        playlists ficavam inalcançáveis (relato de campo, 13 playlists). */
    altura: number;
  } | null>(null);
  const plusRef = useRef<HTMLButtonElement>(null);

  // V6 — o nome do arquivo é como as coordenadoras já se organizam; entra como
  // segunda linha (soma, não troca): não disputa espaço com badge/temas/"+".
  const nomeArquivo = songFileName(song);

  const titleColor = !song.available
    ? "text-disabled"
    : isCurrent
      ? "text-brand"
      : "text-ink";

  /** Abre (ou fecha) o menu de listas embaixo — ou em cima — do botão. */
  function alternarMenu() {
    if (menuPos) {
      setMenuPos(null);
      return;
    }
    const rect = plusRef.current!.getBoundingClientRect();
    // Cabe embaixo? Senão abre para cima, e em último caso rola.
    const margem = 12;
    const abaixo = window.innerHeight - rect.bottom - margem;
    const acima = rect.top - margem;
    const paraCima = abaixo < 200 && acima > abaixo;
    const altura = Math.max(120, Math.min(320, paraCima ? acima : abaixo));
    setMenuPos({
      top: paraCima ? Math.max(margem, rect.top - altura - 4) : rect.bottom + 4,
      left: rect.right - 256,
      altura,
    });
  }

  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(
          "application/x-cancioneiro-song",
          String(song.id),
        );
      }}
      onClick={onSelect}
      onDoubleClick={() => {
        if (song.available) onPlay();
      }}
      className={`group relative flex h-full cursor-default select-none items-center gap-4 border-b border-border px-6 py-2.5 max-lg:gap-3 max-lg:px-4 ${
        selected || isCurrent ? "bg-brand-soft" : "hover:bg-surface-hover"
      }`}
    >
      {/*
        V15 — um botão de tocar em cada linha. Antes era duplo-clique, e
        duplo-clique é o gesto que mais falha em mão menos firme: sai um clique
        só, ou dois clique devagar, e "não acontece nada". O duplo-clique
        continua valendo para quem já o usa.
      */}
      <button
        type="button"
        aria-label={isPlaying ? `Pausar ${song.title}` : `Tocar ${song.title}`}
        disabled={!song.available}
        onClick={(e) => {
          e.stopPropagation();
          onSelect();
          if (isCurrent) usePlayerStore.getState().togglePlayPause();
          else onPlay();
        }}
        onDoubleClick={(e) => e.stopPropagation()}
        className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-brand-fill text-white hover:bg-brand-fill-hover disabled:bg-disabled"
      >
        {isPlaying ? (
          <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
        ) : (
          <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.9l10-6.5a1 1 0 0 0 0-1.7l-10-6.5A1 1 0 0 0 8 5.5Z" /></svg>
        )}
      </button>

      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          {/* Ordem da linha (V5 Q3): título → artista → badge → temas → "+" */}
          <span className={`min-w-0 truncate text-[17px] font-semibold leading-6 ${titleColor}`}>
            {song.title}
          </span>
          {/*
            V8/F17 — música sem voz não é pendência. No lugar do selo cinza
            preenchido "Sem letra" (que a varredura de letra ia recobrar para
            sempre) vem "Instrumental": contorno leve, sem preenchimento, porque
            é INFORMAÇÃO e não tarefa. Instrumental COM letra registrada é caso
            previsto pelo PRD e continua mostrando o selo — a letra aparece
            normalmente no painel. `ink-quaternary` é o cinza já auditado da
            linha: passa em AA (4.5:1) nos três fundos — branco, selecionado e
            hover (e no escuro também, ver index.css).
          */}
          {song.instrumental ? (
            <span className="shrink-0 rounded border border-border-strong px-1.5 text-[13px] leading-5 text-ink-quaternary">
              Instrumental
            </span>
          ) : (
            !song.has_lyrics && (
              <span className="shrink-0 rounded bg-surface-hover px-1.5 text-[13px] leading-5 text-ink-tertiary">
                Sem letra
              </span>
            )
          )}
        </div>
        {song.artist && (
          <p className="truncate text-[16px] leading-6 text-ink-secondary">
            {song.artist}
          </p>
        )}
        {nomeArquivo && (
          <p
            data-testid="song-filename"
            title={nomeArquivo}
            // `ink-quaternary` e não `ink-tertiary`: o texto precisa passar em
            // AA (4.5:1) nos TRÊS fundos da linha — branco, selecionado e
            // hover — e nos três equivalentes do tema escuro (ver index.css).
            className="truncate text-[14px] leading-5 text-ink-quaternary"
          >
            {nomeArquivo}
          </p>
        )}
        {snippet && (
          <p className="truncate text-[15px] leading-6 text-ink-secondary">
            {/* V15 — diz ONDE achou: sem isso, uma música que não tem a
                palavra no nome parece resultado errado */}
            <span className="text-ink-tertiary">Na letra: </span>
            {parseSnippet(snippet).map((seg, i) =>
              seg.highlighted ? (
                <mark key={i} className="rounded-sm bg-mark px-0.5 text-mark-ink">
                  {seg.text}
                </mark>
              ) : (
                <span key={i}>{seg.text}</span>
              ),
            )}
          </p>
        )}
      </div>

      {/*
        Temas e o botão de lista moram JUNTOS à direita, longe do botão de
        tocar. Motivo vindo do uso real: com título curto, o chip caía quase em
        cima de onde a pessoa clica — e um clique errado no chip não é
        inofensivo, ele TROCA a busca inteira.
      */}
      <span className="flex min-w-0 shrink items-center gap-3 pl-2">
        {song.temas && (
          <span className="flex min-w-0 items-center gap-1.5 overflow-hidden max-lg:hidden">
            <TemaChips temas={song.temas} />
          </span>
        )}
        {playlists.length > 0 && (
          // V15 — sempre visível, e com palavra: antes era um "+" que só
          // aparecia com o mouse em cima, e quem não sabia que ele existia
          // nunca o encontrava
          <button
            ref={plusRef}
            type="button"
            data-testid="por-na-lista"
            aria-expanded={menuPos !== null}
            className="flex min-h-11 shrink-0 items-center gap-1 rounded-xl border-2 border-border-strong bg-surface px-3 text-[15px] font-semibold text-ink hover:bg-surface-hover"
            onClick={(e) => {
              e.stopPropagation();
              alternarMenu();
            }}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <span aria-hidden="true" className="text-[18px] leading-none">+</span>
            {/* tela estreita: "Lista", que ainda diz o que é; larga: a frase */}
            <span className="max-xl:hidden">Pôr numa lista</span>
            <span className="xl:hidden">Lista</span>
          </button>
        )}
      </span>

      {menuPos &&
        createPortal(
          <>
            <div
              className="fixed inset-0 z-40"
              onClick={(e) => {
                e.stopPropagation();
                setMenuPos(null);
              }}
            />
            <div
              className="fixed z-50 w-64 overflow-y-auto rounded-xl border border-border bg-surface py-1 shadow-lg"
              style={{
                top: menuPos.top,
                left: Math.max(8, menuPos.left),
                maxHeight: menuPos.altura,
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <p className="sticky top-0 bg-surface px-4 py-2 text-[14px] font-semibold text-ink-tertiary">
                Pôr em qual lista?
              </p>
              {playlists.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="block min-h-11 w-full px-4 py-2 text-left text-[16px] text-ink hover:bg-surface-hover"
                  onClick={() => {
                    setMenuPos(null);
                    void addToPlaylist(p.id, song.id);
                  }}
                >
                  {p.name}
                </button>
              ))}
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}
