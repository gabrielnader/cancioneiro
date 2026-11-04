import { useEffect, useState } from "react";
import { useLibraryStore } from "../stores/libraryStore";
import { useUiStore } from "../stores/uiStore";
import { AddFolderButton } from "./AddFolderButton";

/**
 * V16.6 — "Primeiro uso guiado". Cinco passos curtos, um por vez, com letra
 * grande e as mesmas palavras que a pessoa vai ver na tela. Abre sozinho na
 * primeira abertura (biblioteca sem pasta) e, depois, pelo botão "Ver o
 * tutorial de novo" de Configurações.
 *
 * Os desenhos são RÉPLICAS dos elementos de verdade (o campo de busca, o botão
 * verde de tocar, o botão de organizar) — mostrar a coisa é mais claro do que
 * descrevê-la para quem não tem a quem perguntar.
 */

/** Abre sozinho? Só no primeiro uso de verdade: nunca visto e sem pasta. */
export function deveAbrirSozinho(tutorialVisto: boolean, libraryLoaded: boolean, pastas: number): boolean {
  return !tutorialVisto && libraryLoaded && pastas === 0;
}

export const PASSOS = [
  "Bem-vindo",
  "A pasta das músicas",
  "Para achar uma música",
  "Para tocar",
  "Para organizar",
] as const;

function CampoDeBusca() {
  return (
    <div aria-hidden="true" className="rounded-xl border-2 border-border-strong bg-surface px-4 py-3">
      <div className="text-[14px] font-semibold text-ink-secondary">Procurar uma música</div>
      <div className="text-[18px] text-ink-tertiary">Um pedaço da letra, o nome ou quem canta</div>
    </div>
  );
}

function BotaoTocar() {
  return (
    <div aria-hidden="true" className="flex items-center gap-3 rounded-xl border-2 border-border bg-surface px-4 py-3">
      <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-brand-fill text-white">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
          <path d="M8 5.5v13a1 1 0 0 0 1.5.9l10-6.5a1 1 0 0 0 0-1.7l-10-6.5A1 1 0 0 0 8 5.5Z" />
        </svg>
      </span>
      <span className="text-[18px] text-ink">Asa Branca</span>
    </div>
  );
}

function BotaoOrganizar() {
  return (
    <div aria-hidden="true" className="inline-block rounded-xl border-2 border-brand px-4 py-2 text-[17px] font-semibold text-brand">
      Organizar minhas músicas
    </div>
  );
}

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
          <p className={texto}>São só cinco passos rápidos.</p>
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
    case 2:
      return (
        <>
          <CampoDeBusca />
          <p className={texto}>
            No alto da tela, escreva um pedaço da letra, o nome da música ou quem canta. Uma palavra já basta.
          </p>
        </>
      );
    case 3:
      return (
        <>
          <BotaoTocar />
          <p className={texto}>
            Clique no botão verde ao lado da música. A letra aparece nos detalhes, à direita. Embaixo ficam
            pausar, a próxima música e o volume.
          </p>
        </>
      );
    default:
      return (
        <>
          <BotaoOrganizar />
          <p className={texto}>
            No alto da tela, este botão leva para a organização: o app completa nome, cantor e letra das músicas,
            e você confere tudo antes de qualquer coisa ser gravada.
          </p>
          <p className={texto}>Para ver este tutorial de novo, é só ir lá também.</p>
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
        <div className="flex justify-between gap-3">
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
          <button
            type="button"
            autoFocus
            onClick={() => (ultimo ? fechar() : setPasso(passo + 1))}
            className="min-h-12 rounded-xl bg-brand-fill px-6 text-[17px] font-semibold text-white hover:bg-brand-fill-hover"
          >
            {ultimo ? "Começar a usar" : "Próximo"}
          </button>
        </div>
      </section>
    </div>
  );
}
