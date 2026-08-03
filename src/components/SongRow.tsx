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
      className={`group relative flex min-h-9 cursor-default select-none flex-col justify-center px-4 py-1.5 ${
        selected || isCurrent ? "bg-brand-soft" : "hover:bg-surface-hover"
      }`}
    >
      <div className="flex items-center gap-2">
        {isPlaying && (
          <span
            aria-hidden="true"
            className="text-brand motion-safe:animate-pulse"
          >
            ♪
          </span>
        )}
        {/* Ordem da linha (V5 Q3): título → artista → badge → temas → "+" */}
        <span className={`min-w-0 truncate text-[15px] font-medium ${titleColor}`}>
          {song.title}
        </span>
        {song.artist && (
          <span className="max-w-40 truncate text-[13px] text-ink-tertiary">
            {song.artist}
          </span>
        )}
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
          <span className="shrink-0 rounded border border-border-strong px-1.5 py-0.5 text-[12px] text-ink-quaternary">
            Instrumental
          </span>
        ) : (
          !song.has_lyrics && (
            <span className="shrink-0 rounded bg-surface-hover px-1.5 py-0.5 text-[12px] text-ink-tertiary">
              Sem letra
            </span>
          )
        )}
        {/*
          Temas e "+" moram JUNTOS à direita, separados do bloco de texto por
          um respiro fixo (pl-6). Motivo vindo do uso real: com título curto,
          o chip caía quase em cima de onde a pessoa clica para selecionar a
          música — e um clique errado no chip não é inofensivo, ele TROCA a
          busca inteira e derruba a lista onde ela estava. Assim a metade
          esquerda da linha vira área segura de seleção e a direita concentra
          as ações, que é a convenção que o "+" já estabelecia.
        */}
        <span className="ml-auto flex min-w-0 shrink items-center gap-3 pl-6">
          {song.temas && (
            <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
              <TemaChips temas={song.temas} />
            </span>
          )}
          <span className="flex shrink-0 items-center">
          {playlists.length > 0 && (
            <button
              ref={plusRef}
              type="button"
              aria-label="Adicionar à playlist"
              title="Adicionar à playlist"
              className={`h-6 w-6 rounded text-ink-secondary hover:bg-border group-hover:block ${
                // além do hover (PRD), fica visível na linha selecionada —
                // sem isso não há como adicionar via toque ou teclado
                selected || menuPos ? "block" : "hidden"
              }`}
              onClick={(e) => {
                e.stopPropagation();
                if (menuPos) {
                  setMenuPos(null);
                } else {
                  const rect = plusRef.current!.getBoundingClientRect();
                  // Cabe embaixo? Senão abre para cima, e em último caso rola.
                  const margem = 12;
                  const abaixo = window.innerHeight - rect.bottom - margem;
                  const acima = rect.top - margem;
                  const paraCima = abaixo < 200 && acima > abaixo;
                  const altura = Math.max(120, Math.min(320, paraCima ? acima : abaixo));
                  setMenuPos({
                    top: paraCima ? Math.max(margem, rect.top - altura - 4) : rect.bottom + 4,
                    left: rect.right - 224,
                    altura,
                  });
                }
              }}
            >
              +
            </button>
          )}
          </span>
        </span>
      </div>
      {nomeArquivo && (
        <p
          data-testid="song-filename"
          title={nomeArquivo}
          // `ink-quaternary` e não `ink-tertiary`: em 12px o texto precisa
          // passar em AA (4.5:1) nos TRÊS fundos da linha — branco (5.98:1),
          // selecionado (5.74:1) e hover (5.44:1) — e nos três equivalentes do
          // tema escuro (ver index.css). Ainda muito mais claro que o título
          // (`ink`, 17.74:1 no claro): o olho cai nele primeiro.
          className="truncate text-[12px] leading-4 text-ink-quaternary"
        >
          {nomeArquivo}
        </p>
      )}
      {snippet && (
        <p className="mt-0.5 truncate text-[13px] text-ink-tertiary">
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
              className="fixed z-50 w-56 overflow-y-auto rounded border border-border bg-surface py-1 shadow-lg"
              style={{
                top: menuPos.top,
                left: Math.max(8, menuPos.left),
                maxHeight: menuPos.altura,
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <p className="sticky top-0 bg-surface px-3 py-1 text-[12px] uppercase text-ink-tertiary">
                Adicionar à playlist
              </p>
              {playlists.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="block w-full px-3 py-1.5 text-left text-ink-secondary hover:bg-surface-hover"
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
