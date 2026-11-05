import { useEffect, useState } from "react";
import { GUIAS, PERGUNTAS, useGuiaStore } from "../lib/guias";
import { useUiStore } from "../stores/uiStore";

/**
 * V16.7 — o botão "Como faço?" do alto da tela, sempre visível e com palavra,
 * e a lista de perguntas do jeito que a pessoa pensa. Cada pergunta vira um
 * guia que mostra o caminho na tela de verdade.
 */
export function ComoFaco() {
  const [aberto, setAberto] = useState(false);
  const iniciar = useGuiaStore((s) => s.iniciar);

  useEffect(() => {
    if (!aberto) return;
    const tecla = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAberto(false);
    };
    window.addEventListener("keydown", tecla);
    return () => window.removeEventListener("keydown", tecla);
  }, [aberto]);

  return (
    <>
      <button
        type="button"
        data-guia="como-faco"
        onClick={() => setAberto(true)}
        className="flex min-h-12 shrink-0 items-center gap-2 rounded-xl border-2 border-warning bg-warning-soft px-3 text-[16px] font-semibold text-ink hover:bg-warning-accent"
      >
        <span
          aria-hidden="true"
          className="flex h-6 w-6 items-center justify-center rounded-full bg-warning max-lg:hidden text-[15px] font-bold text-surface"
        >
          ?
        </span>
        Como faço?
      </button>

      {aberto && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="como-faco-titulo"
            className="flex max-h-full w-full max-w-xl flex-col gap-4 overflow-y-auto rounded-2xl bg-surface p-6 shadow-xl max-sm:p-4"
          >
            <h2 id="como-faco-titulo" className="text-[24px] font-bold text-ink">
              Como faço?
            </h2>
            <p className="text-[17px] text-ink-secondary">
              Escolha o que você quer fazer. Eu mostro o caminho na tela, passo a passo.
            </p>
            <ul className="flex flex-col gap-2">
              {PERGUNTAS.map((id) => (
                <li key={id}>
                  <button
                    type="button"
                    onClick={() => {
                      setAberto(false);
                      iniciar(id);
                    }}
                    className="flex min-h-14 w-full items-center justify-between gap-3 rounded-xl border-2 border-border bg-surface px-4 text-left text-[18px] font-semibold text-ink hover:border-brand hover:bg-brand-soft"
                  >
                    {GUIAS[id].pergunta}
                    <span aria-hidden="true" className="text-[22px] text-brand">
                      ›
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => {
                  setAberto(false);
                  useUiStore.getState().abrirTutorial();
                }}
                className="rounded px-2 py-1 text-[16px] font-medium text-brand hover:bg-brand-soft"
              >
                Ver o tutorial do começo
              </button>
              <button
                type="button"
                autoFocus
                onClick={() => setAberto(false)}
                className="min-h-12 rounded-xl border-2 border-border-strong px-5 text-[17px] font-semibold text-ink hover:bg-surface-hover"
              >
                Fechar
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
