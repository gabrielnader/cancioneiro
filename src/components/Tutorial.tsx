import { useEffect, useState } from "react";
import { useGuiaStore } from "../lib/guias";
import { useLibraryStore } from "../stores/libraryStore";
import { useUiStore } from "../stores/uiStore";
import { AddFolderButton } from "./AddFolderButton";

/**
 * V16.6/V16.7 — "Primeiro uso guiado". Três passos curtos na janela (boas-vindas,
 * a pasta das músicas com o botão de verdade, e o convite) e depois o guia NA
 * TELA DE VERDADE: achar uma música, tocar, e onde fica o "Como faço?" para
 * quando a pessoa esquecer. Abre sozinho na primeira abertura (biblioteca sem
 * pasta) e, depois, pelo "Ver o tutorial de novo" de Configurações ou pelo
 * "Como faço?".
 */

/** Abre sozinho? Só no primeiro uso de verdade: nunca visto e sem pasta. */
export function deveAbrirSozinho(tutorialVisto: boolean, libraryLoaded: boolean, pastas: number): boolean {
  return !tutorialVisto && libraryLoaded && pastas === 0;
}

export const PASSOS = ["Bem-vindo", "A pasta das músicas", "Agora, na tela de verdade"] as const;

function Pasta() {
  const pastas = useLibraryStore((s) => s.folders.length);
  if (pastas > 0) {
    return (
      <p className="rounded-xl bg-brand-soft px-4 py-3 text-[18px] font-semibold text-brand">
        ✓ {pastas === 1 ? "Sua pasta já está no app." : `Suas ${pastas} pastas já estão no app.`} Pode seguir.
      </p>
    );
  }
  return (
    <div>
      <AddFolderButton variant="primary" />
    </div>
  );
}

function Conteudo({ passo }: { passo: number }) {
  const texto = "text-[19px] leading-relaxed text-ink-secondary";
  switch (passo) {
    case 0:
      return (
        <>
          <p className={texto}>
            Aqui você ouve suas músicas, lê as letras e organiza tudo. Funciona sem internet.
          </p>
          <p className={texto}>Vou te mostrar o básico. É rápido.</p>
        </>
      );
    case 1:
      return (
        <>
          <p className={texto}>
            Escolha a pasta do computador onde ficam suas músicas. O app só lê os arquivos: não muda o nome, não
            muda de lugar e não apaga nada.
          </p>
          <Pasta />
        </>
      );
    default:
      return (
        <>
          <p className={texto}>
            Agora eu te mostro na tela de verdade como achar e tocar uma música. É só seguir o que aparecer no
            balão amarelo.
          </p>
          <p className={texto}>
            E se um dia esquecer, o botão <strong className="text-ink">“Como faço?”</strong>, no alto da tela,
            mostra de novo.
          </p>
        </>
      );
  }
}

export function Tutorial() {
  const aberto = useUiStore((s) => s.tutorialAberto);
  const fechar = useUiStore((s) => s.fecharTutorial);
  const [passo, setPasso] = useState(0);

  useEffect(() => {
    if (aberto) setPasso(0);
  }, [aberto]);

  useEffect(() => {
    if (!aberto) return;
    const tecla = (e: KeyboardEvent) => {
      if (e.key === "Escape") fechar();
    };
    window.addEventListener("keydown", tecla);
    return () => window.removeEventListener("keydown", tecla);
  }, [aberto, fechar]);

  if (!aberto) return null;
  const ultimo = passo === PASSOS.length - 1;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="tutorial-titulo"
        className="flex max-h-full w-full max-w-xl flex-col gap-5 overflow-y-auto rounded-2xl bg-surface p-7 shadow-xl max-sm:p-5"
      >
        <div className="flex items-center justify-between gap-3">
          <span className="text-[15px] font-semibold text-ink-tertiary">
            Passo {passo + 1} de {PASSOS.length}
          </span>
          {!ultimo && (
            <button
              type="button"
              onClick={fechar}
              className="rounded px-2 py-1 text-[15px] font-medium text-ink-secondary hover:bg-surface-hover"
            >
              Pular o tutorial
            </button>
          )}
        </div>
        <h2 id="tutorial-titulo" className="text-[26px] font-bold leading-tight text-ink">
          {passo === 0 ? "Bem-vindo ao Cancioneiro" : PASSOS[passo]}
        </h2>
        <div className="flex flex-col gap-4">
          <Conteudo passo={passo} />
        </div>
        <div aria-hidden="true" className="flex justify-center gap-2">
          {PASSOS.map((_, i) => (
            <span key={i} className={`h-2.5 w-2.5 rounded-full ${i === passo ? "bg-brand-fill" : "bg-border-strong"}`} />
          ))}
        </div>
        <div className="flex flex-wrap justify-between gap-3">
          {passo > 0 ? (
            <button
              type="button"
              onClick={() => setPasso(passo - 1)}
              className="min-h-12 rounded-xl border-2 border-border-strong px-5 text-[17px] font-semibold text-ink hover:bg-surface-hover"
            >
              Voltar
            </button>
          ) : (
            <span />
          )}
          <div className="flex flex-wrap justify-end gap-3">
            {ultimo && (
              <button
                type="button"
                onClick={fechar}
                className="min-h-12 rounded-xl px-4 text-[17px] font-semibold text-ink-secondary hover:bg-surface-hover"
              >
                Agora não
              </button>
            )}
            <button
              type="button"
              autoFocus
              onClick={() => {
                if (!ultimo) return setPasso(passo + 1);
                fechar();
                useGuiaStore.getState().iniciar("primeiros-passos");
              }}
              className="min-h-12 rounded-xl bg-brand-fill px-6 text-[17px] font-semibold text-white hover:bg-brand-fill-hover"
            >
              {ultimo ? "Me mostre na tela" : "Próximo"}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
