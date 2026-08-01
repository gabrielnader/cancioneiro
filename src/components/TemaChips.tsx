import { useState } from "react";
import { useLibraryStore } from "../stores/libraryStore";
import { useUiStore } from "../stores/uiStore";

/**
 * **QUANTOS TEMAS APARECEM ANTES DE DOBRAR — e de onde sai o número.**
 *
 * V10.11. Os dois beta testers pediram um limite de 10 temas por música. O dono
 * recusou o limite: tema é o vocabulário da própria pessoa, e um teto rígido
 * bateria em alguém no pior momento, sem ninguém a quem perguntar. O problema é
 * de LAYOUT, e é no layout que ele se resolve.
 *
 * O número foi MEDIDO, no Chromium, com o painel no tamanho real que ele tem —
 * a mesma régua com que o `--faixa-detalhes` do `index.css` foi calculado:
 *
 * ```
 *   380 px  o painel de letra (`w-[380px]`, LyricsPanel)
 *  −  32 px o `p-4` dos dois lados
 *  −   8 px o `gap-2` entre a coluna de texto e os botões
 *  − 100 px os botões "Editar" e "Aa"
 *  = 240 px  a coluna de texto — o container MAIS ESTREITO em que um chip aparece
 * ```
 *
 * Chip de tema em 12px, medido sobre o vocabulário que este acervo usa: 28 px o
 * mais curto ("fé"), 107 px o mais longo ("ação de graças"), **mediana 68 px**.
 * Com o `gap-1.5` de 6 px, cabem `240 ÷ 74 = 3,2` chips medianos numa linha.
 *
 * Daí o **3**: é quantos chips de largura mediana cabem numa LINHA do container
 * mais estreito. Somado o "+N" (34 px), o bloco dobrado ocupa no máximo DUAS
 * linhas — conferido nas quatro composições possíveis de vocabulário (só
 * curtos, só longos, todos medianos e misto).
 *
 * O mesmo número vale na ficha de edição, que é mais larga (348 px, sem os
 * botões ao lado) mas divide a linha com o campo "Adicionar tema": dois
 * containers, uma régua só — duas seriam duas telas dobrando em pontos
 * diferentes pela mesma lista (DECISIONS #80 aplicada a layout).
 */
export const LIMITE_DE_TEMAS_VISIVEIS = 3;

/** O que o botão diz quando a lista já está aberta. */
export const ROTULO_DE_DOBRAR_TEMAS = "mostrar menos";

/**
 * A lista partida em "o que aparece" e "quantos ficaram atrás do +N".
 *
 * **Dobrar UM chip só não economiza nada**, e por isso a régua tem folga de um:
 * o "+1" tem quase a largura de um chip mediano, não tira uma linha da tela e
 * cobra um clique por nada. Quase toda música deste acervo tem de um a quatro
 * temas — para elas, nada muda.
 */
export function dobrarTemas<T>(
  temas: T[],
  expandido: boolean,
): { visiveis: T[]; escondidos: number } {
  if (expandido || temas.length <= LIMITE_DE_TEMAS_VISIVEIS + 1) {
    return { visiveis: temas, escondidos: 0 };
  }
  return {
    visiveis: temas.slice(0, LIMITE_DE_TEMAS_VISIVEIS),
    escondidos: temas.length - LIMITE_DE_TEMAS_VISIVEIS,
  };
}

/** O rótulo do que está dobrado. Curto de propósito: ele divide a linha. */
export function rotuloDeMaisTemas(escondidos: number): string {
  return `+${escondidos}`;
}

/** A dica do "+N" onde ele ABRE a lista (a ficha da música). */
export function dicaDeMaisTemasNaFicha(escondidos: number): string {
  return `Mostrar os outros ${escondidos} temas`;
}

/**
 * A dica do "+N" onde ele NÃO abre (a linha da lista) — e ela diz onde ver o
 * resto, porque uma marca que só informa que há mais sem dizer onde é um beco.
 */
export function dicaDeMaisTemasNaLista(escondidos: number): string {
  return `Mais ${escondidos} temas — abra a música para ver todos.`;
}

interface TemaChipsProps {
  /** Valor cru do campo temas ("água; cura") ou null/undefined. */
  temas: string | null | undefined;
  /**
   * O "+N" abre a lista aqui?
   *
   * **Na ficha, sim.** Na LINHA DA LISTA, não — e o motivo é a virtualização: a
   * altura da linha é CALCULADA e não medida (`SongList.rowHeight`), então
   * chips a mais empurrariam o conteúdo por cima da linha seguinte. Lá o "+N" é
   * uma marca que diz quantos faltam e onde vê-los.
   */
  expansivel?: boolean;
}

/**
 * Chips de tema (V2 — F8): tocar num chip preenche a busca com o tema,
 * voltando para a Biblioteca se necessário.
 *
 * V10.11 — a lista é DOBRADA a partir do quinto tema (ver
 * `LIMITE_DE_TEMAS_VISIVEIS`): quem cataloga com 20 ou 40 temas continua
 * podendo, e a tela continua legível.
 */
export function TemaChips({ temas, expansivel = false }: TemaChipsProps) {
  const setQuery = useLibraryStore((s) => s.setQuery);
  const setView = useUiStore((s) => s.setView);
  // O estado é do COMPONENTE, e não da música: abrir a lista de uma música não
  // é uma preferência a lembrar, é um gesto de leitura daquele segundo. Trocar
  // de música remonta o painel e a lista volta dobrada, que é o certo — a
  // pergunta "quais são os temas desta aqui?" é feita de novo a cada ficha.
  const [expandido, setExpandido] = useState(false);

  if (!temas) return null;
  const list = temas
    .split(";")
    .map((t) => t.trim())
    .filter(Boolean);
  if (list.length === 0) return null;

  const { visiveis, escondidos } = dobrarTemas(list, expandido);

  return (
    <>
      {visiveis.map((tema) => (
        <button
          key={tema}
          type="button"
          data-testid="tema-chip"
          aria-label={`Tema: ${tema}`}
          title={`Buscar pelo tema "${tema}"`}
          className="max-w-32 shrink-0 truncate rounded-full bg-brand-soft px-2 py-0.5 text-[12px] text-brand hover:bg-brand-soft-hover"
          onClick={(e) => {
            e.stopPropagation();
            setQuery(tema);
            setView("library");
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          {tema}
        </button>
      ))}
      {escondidos > 0 &&
        (expansivel ? (
          <button
            type="button"
            data-testid="tema-mais"
            aria-label={dicaDeMaisTemasNaFicha(escondidos)}
            title={dicaDeMaisTemasNaFicha(escondidos)}
            // cinza e não verde-água: o "+N" não é um tema, e pintá-lo como os
            // chips faria a pessoa procurar uma música com o tema "+9"
            className="shrink-0 rounded-full bg-surface-hover px-2 py-0.5 text-[12px] text-ink-quaternary hover:bg-border"
            onClick={(e) => {
              e.stopPropagation();
              setExpandido(true);
            }}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            {rotuloDeMaisTemas(escondidos)}
          </button>
        ) : (
          <span
            data-testid="tema-mais"
            title={dicaDeMaisTemasNaLista(escondidos)}
            className="shrink-0 rounded-full bg-surface-hover px-2 py-0.5 text-[12px] text-ink-quaternary"
          >
            {rotuloDeMaisTemas(escondidos)}
          </span>
        ))}
      {expansivel && expandido && (
        /*
          O que abriu tem de fechar no MESMO lugar: quem clicou no "+9" procura
          ali o caminho de volta. O rótulo é palavra, e não um "−", porque o
          sinal sozinho não diz o que ele encolhe.
        */
        <button
          type="button"
          data-testid="tema-menos"
          className="shrink-0 rounded-full px-2 py-0.5 text-[12px] text-ink-quaternary underline hover:bg-surface-hover"
          onClick={(e) => {
            e.stopPropagation();
            setExpandido(false);
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          {ROTULO_DE_DOBRAR_TEMAS}
        </button>
      )}
    </>
  );
}
