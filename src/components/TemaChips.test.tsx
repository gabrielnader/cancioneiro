import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  LIMITE_DE_TEMAS_VISIVEIS,
  ROTULO_DE_DOBRAR_TEMAS,
  TemaChips,
  dicaDeMaisTemasNaFicha,
  dicaDeMaisTemasNaLista,
  dobrarTemas,
  rotuloDeMaisTemas,
} from "./TemaChips";
import { useLibraryStore } from "../stores/libraryStore";
import { useUiStore } from "../stores/uiStore";

/*
  ---------------------------------------------------------------------------
  V10.11 — TEMA É O VOCABULÁRIO DA PESSOA, E NÃO CABE NUM LIMITE.

  Os dois beta testers sugeriram limitar a 10 temas por música. O dono recusou o
  limite: um teto rígido bate em alguém no pior momento, sem ninguém a quem
  perguntar, e o que ele protegeria é o LAYOUT — que é onde o problema mora e
  onde ele se resolve.

  O que estes testes guardam é a régua do dobramento: quantos chips aparecem
  antes do "+N", por que esse número, e o que o "+N" faz em cada tela.
  ---------------------------------------------------------------------------
*/

/** Uma lista de N temas plausíveis, para não testar sobre "tema1, tema2…". */
function temas(n: number): string[] {
  const vocabulario = [
    "água", "esperança", "fé", "peregrinação", "advento", "louvor", "comunhão",
    "paz", "misericórdia", "cura", "natal", "páscoa", "quaresma", "entrada",
    "ofertório", "perdão", "espírito santo", "nossa senhora", "alegria", "luz",
  ];
  return Array.from({ length: n }, (_, i) =>
    i < vocabulario.length ? vocabulario[i] : `tema ${i + 1}`,
  );
}

describe("dobrarTemas — a régua, e o número que ela usa", () => {
  /*
    O NÚMERO NÃO É MÁGICO, E ESTE TESTE É ONDE ELE ESTÁ ESCRITO.

    Medido no Chromium (a mesma régua do `--faixa-detalhes` do index.css), com
    o painel de letra no seu tamanho real — `w-[380px]`:

      380 (painel) − 32 (p-4 dos dois lados) − 8 (gap) − 100 ("Editar" + "Aa")
      = 240 px para a coluna de texto, que é o container MAIS ESTREITO em que
        um chip de tema aparece.

    Chip de tema medido nessa fonte, em 12px: 28 px o mais curto do vocabulário
    ("fé"), 107 px o mais longo ("ação de graças"), MEDIANA 68 px. Com o gap de
    6 px, cabem 240 ÷ 74 = 3,24 chips medianos numa linha.

    Daí o 3: é quantos chips de largura mediana cabem numa LINHA do container
    mais estreito. Com o "+N" (34 px) o bloco dobrado ocupa no máximo duas
    linhas — medido nas quatro composições de vocabulário (só curtos, só longos,
    mediano e misto), e é isso que o teste abaixo afirma em número.
  */
  it("mostra 3 antes de dobrar, e o 3 sai da largura do painel", () => {
    expect(LIMITE_DE_TEMAS_VISIVEIS).toBe(3);
  });

  /*
    DOBRAR UM CHIP SÓ NÃO ECONOMIZA NADA.

    O "+1" tem quase a largura de um chip mediano: esconder um atrás dele não
    tira uma linha da tela, e cobra um clique por nada. A quarta música do
    acervo com 4 temas veria um botão que não resolve problema nenhum — e é
    justamente a faixa em que quase todas as músicas caem.
  */
  it("até 4 temas nada é dobrado: o quarto chip cabe melhor que um '+1'", () => {
    for (const n of [0, 1, 2, 3, 4]) {
      const { visiveis, escondidos } = dobrarTemas(temas(n), false);
      expect(visiveis).toHaveLength(n);
      expect(escondidos).toBe(0);
    }
  });

  it("do quinto em diante mostra os 3 primeiros e conta o resto", () => {
    const { visiveis, escondidos } = dobrarTemas(temas(5), false);
    expect(visiveis).toEqual(["água", "esperança", "fé"]);
    expect(escondidos).toBe(2);
  });

  it("40 temas não quebram a régua: 3 na tela e 37 atrás do botão", () => {
    const { visiveis, escondidos } = dobrarTemas(temas(40), false);
    expect(visiveis).toHaveLength(3);
    expect(escondidos).toBe(37);
    expect(rotuloDeMaisTemas(escondidos)).toBe("+37");
  });

  it("expandido mostra a lista inteira, sem nada escondido", () => {
    const { visiveis, escondidos } = dobrarTemas(temas(40), true);
    expect(visiveis).toHaveLength(40);
    expect(escondidos).toBe(0);
  });

  // A ordem é a do arquivo, e não uma reordenação nossa: o que aparece são os
  // PRIMEIROS temas como a pessoa os escreveu.
  it("os visíveis são os primeiros, na ordem em que estão", () => {
    const lista = temas(10);
    expect(dobrarTemas(lista, false).visiveis).toEqual(lista.slice(0, 3));
  });
});

describe("TemaChips — o '+N' na linha da lista e na ficha", () => {
  beforeEach(() => {
    useLibraryStore.setState({ query: "" });
    useUiStore.setState({ view: "settings" });
  });

  it("com poucos temas nada muda: os chips são todos botões de busca", () => {
    render(<TemaChips temas="água; esperança" />);
    expect(screen.getAllByTestId("tema-chip")).toHaveLength(2);
    expect(screen.queryByText(/^\+\d+$/)).not.toBeInTheDocument();
  });

  /*
    NA LINHA DA LISTA O "+N" NÃO EXPANDE, E O MOTIVO É A VIRTUALIZAÇÃO.

    A altura da linha é calculada, não medida (`SongList.rowHeight`): expandir
    ali empurraria os chips por cima da linha de baixo. O "+N" da lista informa
    e diz onde ver o resto — a ficha, que é onde a expansão cabe.
  */
  it("na lista o '+N' é marca, não botão, e diz onde ver o resto", () => {
    render(<TemaChips temas={temas(12).join("; ")} />);
    expect(screen.getAllByTestId("tema-chip")).toHaveLength(3);
    const mais = screen.getByTestId("tema-mais");
    expect(mais.textContent).toBe("+9");
    expect(mais.tagName).toBe("SPAN");
    expect(mais).toHaveAttribute("title", dicaDeMaisTemasNaLista(9));
    expect(dicaDeMaisTemasNaLista(9)).toBe(
      "Mais 9 temas — abra a música para ver todos.",
    );
  });

  it("na ficha o '+N' é botão, expande e volta a dobrar", () => {
    render(<TemaChips temas={temas(12).join("; ")} expansivel />);
    const mais = screen.getByRole("button", { name: dicaDeMaisTemasNaFicha(9) });
    expect(mais.textContent).toBe("+9");
    expect(screen.getAllByTestId("tema-chip")).toHaveLength(3);

    fireEvent.click(mais);
    expect(screen.getAllByTestId("tema-chip")).toHaveLength(12);

    const menos = screen.getByRole("button", { name: ROTULO_DE_DOBRAR_TEMAS });
    expect(menos.textContent).toBe(ROTULO_DE_DOBRAR_TEMAS);
    fireEvent.click(menos);
    expect(screen.getAllByTestId("tema-chip")).toHaveLength(3);
  });

  // O botão que dobra e o que desdobra são a MESMA affordance: quem clicou para
  // abrir tem de achar o que fecha no mesmo lugar.
  it("as duas frases do botão dizem o que ele faz", () => {
    expect(dicaDeMaisTemasNaFicha(37)).toBe("Mostrar os outros 37 temas");
    expect(ROTULO_DE_DOBRAR_TEMAS).toBe("mostrar menos");
  });

  /*
    EXPANDIDO, O CHIP CONTINUA SENDO O CHIP: clicar num tema revelado busca por
    ele como os três que já estavam lá. O dobramento é de LAYOUT, e não um
    segundo modo de leitura.
  */
  it("o chip revelado busca pelo tema, como os outros", () => {
    render(<TemaChips temas={temas(12).join("; ")} expansivel />);
    fireEvent.click(screen.getByRole("button", { name: dicaDeMaisTemasNaFicha(9) }));
    fireEvent.click(screen.getByRole("button", { name: "Tema: natal" }));
    expect(useLibraryStore.getState().query).toBe("natal");
    expect(useUiStore.getState().view).toBe("library");
  });

  // Tema repetido na etiqueta não pode sumir da contagem nem duplicar chave de
  // React: o `TemaChips` já normalizava a lista, e o dobramento conta o que
  // sobrou dessa normalização.
  it("o '+N' conta os temas que sobraram, não os que estavam na etiqueta", () => {
    render(<TemaChips temas={`  ; ${temas(6).join(";  ")} ;;  `} />);
    expect(screen.getByTestId("tema-mais").textContent).toBe("+3");
  });
});
