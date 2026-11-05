import { useEffect, useState } from "react";
import { GUIAS, elementoDoGuia, useGuiaStore } from "../lib/guias";

interface Retangulo {
  top: number;
  left: number;
  width: number;
  height: number;
}

const FOLGA = 6; // o círculo de luz fica um pouco maior que o botão
const LARGURA_DO_BALAO = 420;

function medir(alvo: string): Retangulo | null {
  const el = elementoDoGuia(alvo);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  // dentro da tela: o player encosta no pé da janela, e o contorno sumiria
  const top = Math.max(2, r.top - FOLGA);
  const left = Math.max(2, r.left - FOLGA);
  const bottom = Math.min(window.innerHeight - 2, r.bottom + FOLGA);
  const right = Math.min(window.innerWidth - 2, r.right + FOLGA);
  return { top, left, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/** Onde o balão fica: embaixo do alvo se couber, senão em cima, senão no pé da tela. */
export function posicaoDoBalao(
  r: Retangulo | null,
  tela: { largura: number; altura: number },
  alturaDoBalao = 220,
): { top: number; left: number } {
  const largura = Math.min(LARGURA_DO_BALAO, tela.largura - 32);
  if (!r) return { top: Math.max(16, (tela.altura - alturaDoBalao) / 2), left: (tela.largura - largura) / 2 };
  const left = Math.min(Math.max(16, r.left + r.width / 2 - largura / 2), tela.largura - largura - 16);
  if (r.top + r.height + 16 + alturaDoBalao <= tela.altura) return { top: r.top + r.height + 16, left };
  if (r.top - 16 - alturaDoBalao >= 0) return { top: r.top - 16 - alturaDoBalao, left };
  return { top: Math.max(16, tela.altura - alturaDoBalao - 16), left };
}

const BOTAO = "min-h-12 rounded-xl px-5 text-[17px] font-semibold";

/**
 * V16.7 — a camada do "Como faço?": escurece a tela, acende o botão de verdade
 * e diz o que fazer. Só o lugar aceso recebe clique — o resto da tela fica
 * escuro e parado, para a pessoa não se perder no meio.
 */
export function Guia() {
  const { ativo, passo, inicio, estado, impedimento, avancar, parar } = useGuiaStore();
  const [r, setR] = useState<Retangulo | null>(null);
  const [tela, setTela] = useState({ largura: window.innerWidth, altura: window.innerHeight });

  const guia = ativo ? GUIAS[ativo] : null;
  const atual = guia && estado === "andando" ? guia.passos[passo] : null;

  // acompanha o alvo: ele aparece depois de um clique, muda de lugar quando a
  // tela rola ou a janela muda de tamanho
  useEffect(() => {
    if (!atual) return;
    const medirAgora = () => {
      setR(medir(atual.alvo));
      setTela({ largura: window.innerWidth, altura: window.innerHeight });
    };
    medirAgora();
    const id = window.setInterval(medirAgora, 150);
    return () => window.clearInterval(id);
  }, [atual]);

  // avanço por condição (escreveu na busca, a lista foi criada…)
  useEffect(() => {
    if (!atual || atual.avanca !== "quando" || !atual.quando) return;
    const cond = atual.quando;
    const id = window.setInterval(() => {
      if (cond(inicio)) avancar();
    }, 250);
    return () => window.clearInterval(id);
  }, [atual, inicio, avancar]);

  // avanço por clique no lugar aceso — depois que o próprio botão fez o dele
  useEffect(() => {
    if (!atual || atual.avanca !== "clique") return;
    const alvo = atual.alvo;
    const aoClicar = (e: MouseEvent) => {
      const el = elementoDoGuia(alvo);
      if (el && e.target instanceof Node && el.contains(e.target)) window.setTimeout(avancar, 60);
    };
    document.addEventListener("click", aoClicar, true);
    return () => document.removeEventListener("click", aoClicar, true);
  }, [atual, avancar]);

  useEffect(() => {
    if (!ativo) return;
    const tecla = (e: KeyboardEvent) => {
      if (e.key === "Escape") parar();
    };
    window.addEventListener("keydown", tecla);
    return () => window.removeEventListener("keydown", tecla);
  }, [ativo, parar]);

  if (!guia) return null;

  // fim ou impedimento: um cartão no meio da tela
  if (estado !== "andando") {
    return (
      <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/55 p-4">
        <section
          role="dialog"
          aria-modal="true"
          aria-label={guia.pergunta}
          className="flex w-full max-w-md flex-col gap-4 rounded-2xl bg-surface p-6 shadow-xl"
        >
          <p className="text-[21px] font-bold text-ink">{estado === "fim" ? "Pronto!" : "Antes, um passo"}</p>
          <p className="text-[19px] leading-relaxed text-ink-secondary">
            {estado === "fim" ? guia.fim.replace(/^Pronto!\s*/, "") : impedimento}
          </p>
          <div className="flex justify-end">
            <button
              type="button"
              autoFocus
              onClick={parar}
              className={`${BOTAO} bg-brand-fill text-white hover:bg-brand-fill-hover`}
            >
              Fechar
            </button>
          </div>
        </section>
      </div>
    );
  }

  if (!atual) return null;
  const pos = posicaoDoBalao(r, tela);
  const escuro = "fixed z-[70] bg-black/55";

  return (
    <>
      {r ? (
        <>
          {/* quatro faixas escuras em volta do lugar aceso: bloqueiam o clique
              no resto da tela e deixam o lugar aceso livre */}
          <div className={escuro} style={{ top: 0, left: 0, right: 0, height: Math.max(0, r.top) }} />
          <div className={escuro} style={{ top: r.top + r.height, left: 0, right: 0, bottom: 0 }} />
          <div className={escuro} style={{ top: r.top, left: 0, width: Math.max(0, r.left), height: r.height }} />
          <div className={escuro} style={{ top: r.top, left: r.left + r.width, right: 0, height: r.height }} />
          <div
            aria-hidden="true"
            data-testid="guia-luz"
            className="pointer-events-none fixed z-[71] animate-pulse rounded-xl ring-4 ring-destaque"
            style={{ top: r.top, left: r.left, width: r.width, height: r.height }}
          />
        </>
      ) : (
        <div className={`${escuro} inset-0`} />
      )}
      <section
        role="dialog"
        aria-label={guia.pergunta}
        className="fixed z-[72] flex flex-col gap-3 rounded-2xl border-2 border-destaque bg-surface p-5 shadow-2xl"
        style={{ top: pos.top, left: pos.left, width: Math.min(LARGURA_DO_BALAO, tela.largura - 32) }}
      >
        <p className="text-[15px] font-semibold text-ink-tertiary">{guia.pergunta}</p>
        <p className="text-[20px] font-semibold leading-snug text-ink" aria-live="polite">
          {atual.texto}
        </p>
        <div className="flex flex-wrap justify-between gap-2">
          <button
            type="button"
            onClick={parar}
            className={`${BOTAO} border-2 border-border-strong text-ink-secondary hover:bg-surface-hover`}
          >
            Sair do passo a passo
          </button>
          {atual.avanca === "botao" && (
            <button
              type="button"
              autoFocus
              onClick={avancar}
              className={`${BOTAO} bg-brand-fill text-white hover:bg-brand-fill-hover`}
            >
              Entendi
            </button>
          )}
        </div>
      </section>
    </>
  );
}
