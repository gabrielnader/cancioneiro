import { useEffect, useState } from "react";
import { versaoDoApp } from "../lib/versao";
import { ROTULOS_DE_ZOOM, type NivelDeZoom } from "../lib/zoom";
import { usePlaylistStore } from "../stores/playlistStore";
import { useUiStore } from "../stores/uiStore";

/** O "A" de cada nível, em três tamanhos: o botão mostra o que faz. */
const TAMANHO_DO_A: Record<NivelDeZoom, string> = {
  0: "text-[15px]",
  1: "text-[19px]",
  2: "text-[23px]",
};

/**
 * Barra do topo (V15): o nome e a versão, o tamanho da letra, os detalhes e a
 * porta entre OUVIR e ORGANIZAR.
 *
 * Existe porque a tela juntava as duas coisas. A maioria das ~40 pessoas só
 * procura e toca; curadoria, transcrição e pastas eram uma parede de opções
 * no caminho de quem só queria ouvir. Agora são duas telas, e esta barra é o
 * único lugar onde se troca de uma para a outra — com o nome escrito, e não
 * um ícone de engrenagem que precisa ser adivinhado.
 *
 * O "Tamanho da letra" mora AQUI, sempre à vista, e não em Configurações: quem
 * mais precisa dele é justamente quem não enxerga o menu para achá-lo.
 */
export function TopBar() {
  const view = useUiStore((s) => s.view);
  const setView = useUiStore((s) => s.setView);
  const zoomLevel = useUiStore((s) => s.zoomLevel);
  const setZoomLevel = useUiStore((s) => s.setZoomLevel);
  const lyricsPanelVisible = useUiStore((s) => s.lyricsPanelVisible);
  const toggleLyricsPanel = useUiStore((s) => s.toggleLyricsPanel);
  const setGavetaAberta = useUiStore((s) => s.setGavetaAberta);
  const closePlaylist = usePlaylistStore((s) => s.closePlaylist);
  const organizando = view === "settings";

  /** A versão ao lado do nome: é o que a pessoa lê quando relata algo. */
  const [versao, setVersao] = useState("");
  useEffect(() => {
    void versaoDoApp().then(setVersao).catch(() => setVersao(""));
  }, []);

  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-border bg-surface px-5 py-2.5 max-lg:gap-2 max-lg:px-3 baixa:py-1.5">
      {organizando ? (
        <button
          type="button"
          onClick={() => setView("library")}
          className="flex min-h-12 shrink-0 items-center gap-2 rounded-xl bg-brand-fill px-4 text-[16px] font-semibold text-white hover:bg-brand-fill-hover"
        >
          <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
          <span>
            Voltar<span className="max-lg:hidden"> para ouvir</span>
          </span>
        </button>
      ) : (
        // só em tela estreita: a lateral virou gaveta, e este é o caminho até ela
        <button
          type="button"
          onClick={() => setGavetaAberta(true)}
          className="hidden min-h-12 shrink-0 items-center gap-2 rounded-xl border-2 border-border-strong px-3 text-[16px] font-semibold text-ink hover:bg-surface-hover max-lg:flex"
        >
          <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M4 6h16M4 12h16M4 18h10" /></svg>
          Listas e pastas
        </button>
      )}

      <p className="flex min-w-0 flex-1 items-baseline gap-2 truncate">
        {/* em tela muito estreita o nome sai: os botões ao lado são o que
            se usa, e um "Ca…" cortado não informa nada */}
        <span className={`text-[21px] font-bold text-brand ${organizando ? "truncate" : "max-md:hidden"}`}>
          {organizando ? "Organizar minhas músicas" : "Cancioneiro"}
        </span>
        {versao && !organizando && (
          <span className="text-[13px] text-ink-tertiary max-lg:hidden">versão {versao}</span>
        )}
      </p>

      <div className="flex shrink-0 items-center gap-2">
        <span className="text-[15px] text-ink-secondary max-xl:hidden">Tamanho da letra</span>
        <div
          role="group"
          aria-label="Tamanho da letra"
          className="flex overflow-hidden rounded-xl border-2 border-border-strong"
        >
          {([0, 1, 2] as NivelDeZoom[]).map((nivel) => (
            <button
              key={nivel}
              type="button"
              aria-label={ROTULOS_DE_ZOOM[nivel]}
              title={ROTULOS_DE_ZOOM[nivel]}
              aria-pressed={zoomLevel === nivel}
              onClick={() => setZoomLevel(nivel)}
              className={`flex min-h-11 min-w-12 items-center justify-center font-bold ${TAMANHO_DO_A[nivel]} ${
                zoomLevel === nivel
                  ? "bg-brand-fill text-white"
                  : "bg-surface text-ink hover:bg-surface-hover"
              }`}
            >
              A
            </button>
          ))}
        </div>
      </div>

      {!organizando && (
        <>
          <button
            type="button"
            data-testid="toggle-detalhes"
            onClick={toggleLyricsPanel}
            aria-pressed={lyricsPanelVisible}
            className="min-h-12 shrink-0 rounded-xl border-2 border-border-strong px-3 text-[16px] font-semibold text-ink hover:bg-surface-hover"
          >
            {/* o painel virou ficha completa (título, artista, temas, letra,
                edição) — a copy fala em "detalhes" (V5 Q4) */}
            {lyricsPanelVisible ? "Ocultar detalhes" : "Mostrar detalhes"}
          </button>
          <button
            type="button"
            onClick={() => {
              closePlaylist();
              setGavetaAberta(false);
              setView("settings");
            }}
            className="flex min-h-12 shrink-0 items-center gap-2 rounded-xl border-2 border-brand px-4 text-[16px] font-semibold text-brand hover:bg-brand-soft"
          >
            <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
            <span>
              Organizar<span className="max-lg:hidden"> minhas músicas</span>
            </span>
          </button>
        </>
      )}
    </header>
  );
}
