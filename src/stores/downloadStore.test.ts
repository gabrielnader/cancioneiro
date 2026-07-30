import { beforeEach, describe, expect, it, vi } from "vitest";
import { setBackendForTests, type AcessorioInfo, type AcessorioProgresso, type Backend } from "../lib/api";
import { ACESSORIO_CANCELADO } from "../lib/curadoria";
import { estadoInicialDosDownloads, useDownloadStore } from "./downloadStore";

/**
 * V10.4 — o download mora AQUI, e não na tela (defeito de campo D1).
 *
 * O relato: *"coloquei pra baixar o modelo novo e sai da pagina. o download
 * parou e tive que começar de novo"* — 1,5 GB perdidos por trocar de aba, sem
 * aviso nenhum. O estado do download vivia em `CartaoDoAcessorio`, e a tela de
 * Configurações é DESMONTADA quando a pessoa sai dela (`App.tsx` troca o
 * componente pela view nova): a assinatura de progresso ia junto, o desfecho
 * não tinha onde chegar, e a volta mostrava o botão "Baixar" como se nada
 * estivesse acontecendo — convidando ao segundo download que a v0.10.1
 * transformou em erro de gravação.
 *
 * O invoke em si nunca morreu: `acessorio_baixar` é `(async)` e continua no
 * backend. O que morria era tudo o que a pessoa podia VER dele.
 */

const MODELO = "modelo-de-transcricao-grande";

function info(estado: AcessorioInfo["estado"]): AcessorioInfo {
  return {
    nome: MODELO,
    para_que_serve: "entender melhor o que é cantado",
    arquivo: "ggml-medium.bin",
    tamanho_bytes: 1_533_763_059,
    segundos_estimados: 512,
    tempo_medido_nesta_maquina: false,
    executavel: false,
    estado,
    origem: "https://exemplo.invalido/ggml-medium.bin",
  };
}

let acessorioBaixar: ReturnType<typeof vi.fn>;
let acessorioCancelar: ReturnType<typeof vi.fn>;
let onAcessorioProgresso: ReturnType<typeof vi.fn>;
let soltarAssinatura: ReturnType<typeof vi.fn>;
/** Os ouvintes vivos — é assim que se PROVA que a assinatura foi solta. */
let ouvintes: ((p: AcessorioProgresso) => void)[];

function emitir(p: Partial<AcessorioProgresso> & { download_id: string }): void {
  const evento: AcessorioProgresso = {
    nome: MODELO,
    baixados: 0,
    total: null,
    segundos_restantes: null,
    ...p,
  };
  ouvintes.forEach((cb) => cb(evento));
}

/**
 * Deixa a store terminar o que começou. Entre o clique e o `acessorioBaixar`
 * há a assinatura do progresso, que é `await` — um `Promise.resolve()` só não
 * chega lá.
 */
function piscar(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/** O `download_id` que a store gerou para o download vivo deste acessório. */
function idDoDownload(nome = MODELO): string {
  const atual = useDownloadStore.getState().emCurso[nome];
  if (!atual) throw new Error(`não há download vivo de ${nome}`);
  return atual.downloadId;
}

beforeEach(() => {
  ouvintes = [];
  soltarAssinatura = vi.fn();
  acessorioBaixar = vi.fn(async () => ({ cancelado: false, acessorio: info("pronto") }));
  acessorioCancelar = vi.fn(async () => {});
  onAcessorioProgresso = vi.fn(async (cb: (p: AcessorioProgresso) => void) => {
    ouvintes.push(cb);
    return () => {
      ouvintes = ouvintes.filter((o) => o !== cb);
      soltarAssinatura();
    };
  });
  setBackendForTests({
    acessorioBaixar,
    acessorioCancelar,
    onAcessorioProgresso,
  } as unknown as Backend);
  useDownloadStore.setState(estadoInicialDosDownloads());
});

describe("downloadStore — o download sobrevive à navegação (V10.4)", () => {
  it("o progresso fica na store, não no componente que pediu", async () => {
    let concluir!: () => void;
    acessorioBaixar.mockImplementation(
      () => new Promise((r) => (concluir = () => r({ cancelado: false, acessorio: info("pronto") }))),
    );

    const baixando = useDownloadStore.getState().baixar(MODELO);
    await piscar();
    emitir({
      download_id: idDoDownload(),
      baixados: 700_000_000,
      total: 1_533_763_059,
      segundos_restantes: 90,
    });

    expect(useDownloadStore.getState().emCurso[MODELO]).toMatchObject({
      baixados: 700_000_000,
      total: 1_533_763_059,
      segundosRestantes: 90,
    });

    concluir();
    await baixando;
    expect(useDownloadStore.getState().emCurso[MODELO]).toBeUndefined();
    // e o estado NOVO do acessório fica guardado: quem voltar a Configurações
    // precisa ver "pronto" mesmo tendo saído no meio
    expect(useDownloadStore.getState().resultados[MODELO]?.estado).toBe("pronto");
  });

  /**
   * O defeito que o D1 arma: a tela volta, o botão reaparece, a pessoa clica.
   * Dois `acessorio_baixar` do mesmo acessório escrevem o MESMO `.parcial`, e
   * o primeiro a terminar troca o arquivo de nome por baixo do segundo. O
   * backend também recusa (`ERRO_DOWNLOAD_JA_EM_ANDAMENTO`), mas a tela não
   * pode nem chegar lá — recusa do backend vira frase vermelha.
   */
  it("dois downloads do MESMO acessório nunca são disparados", async () => {
    acessorioBaixar.mockImplementation(() => new Promise(() => {}));
    void useDownloadStore.getState().baixar(MODELO);
    await piscar();
    void useDownloadStore.getState().baixar(MODELO);
    await piscar();
    expect(acessorioBaixar).toHaveBeenCalledTimes(1);
  });

  it("acessórios diferentes baixam ao mesmo tempo", async () => {
    acessorioBaixar.mockImplementation(() => new Promise(() => {}));
    void useDownloadStore.getState().baixar(MODELO);
    void useDownloadStore.getState().baixar("fpcalc");
    await piscar();
    expect(acessorioBaixar).toHaveBeenCalledTimes(2);
    expect(Object.keys(useDownloadStore.getState().emCurso).sort()).toEqual(
      ["fpcalc", MODELO].sort(),
    );
  });

  /**
   * A mesma disciplina do `scan_id` do funil (QA M4): o evento de um download
   * ANTIGO — o que a pessoa abandonou ao sair da tela, e que continua vivo no
   * backend — não pode pintar a barra do novo.
   */
  it("progresso de outro download_id é descartado", async () => {
    acessorioBaixar.mockImplementation(() => new Promise(() => {}));
    void useDownloadStore.getState().baixar(MODELO);
    await piscar();
    emitir({ download_id: "de-um-download-abandonado", baixados: 9_000, total: 1_533_763_059 });
    expect(useDownloadStore.getState().emCurso[MODELO]?.baixados).toBe(0);
  });

  it("progresso de OUTRO acessório não mexe neste", async () => {
    acessorioBaixar.mockImplementation(() => new Promise(() => {}));
    void useDownloadStore.getState().baixar(MODELO);
    await piscar();
    emitir({ nome: "fpcalc", download_id: idDoDownload(), baixados: 5_000 });
    expect(useDownloadStore.getState().emCurso[MODELO]?.baixados).toBe(0);
  });

  /**
   * A frase do desfecho ESPERA a pessoa voltar. Um download que falhou
   * enquanto ela estava na biblioteca não pode simplesmente não estar lá:
   * "voltei e não tinha nada" é como o defeito de campo foi descrito.
   */
  it("a falha fica guardada para quem voltar à tela depois", async () => {
    acessorioBaixar.mockRejectedValue(
      new Error("o arquivo do download sumiu antes de terminar"),
    );
    await useDownloadStore.getState().baixar(MODELO);
    expect(useDownloadStore.getState().mensagens[MODELO]).toBe(
      "o arquivo do download sumiu antes de terminar",
    );
  });

  it("cancelar é dito como cancelamento, e não como falha", async () => {
    acessorioBaixar.mockResolvedValue({ cancelado: true, acessorio: info("ausente") });
    await useDownloadStore.getState().baixar(MODELO);
    expect(useDownloadStore.getState().mensagens[MODELO]).toBe(ACESSORIO_CANCELADO);
  });

  it("parar cancela pelo download_id que está vivo", async () => {
    acessorioBaixar.mockImplementation(() => new Promise(() => {}));
    void useDownloadStore.getState().baixar(MODELO);
    await piscar();
    const id = idDoDownload();
    useDownloadStore.getState().parar(MODELO);
    expect(acessorioCancelar).toHaveBeenCalledWith(id);
  });

  it("parar um acessório que não está baixando é no-op", () => {
    useDownloadStore.getState().parar(MODELO);
    expect(acessorioCancelar).not.toHaveBeenCalled();
  });

  /**
   * UMA assinatura para todos os downloads, e ela é SOLTA quando o último
   * termina. A tela assinava a cada clique e soltava no `finally` do próprio
   * download; saindo da tela no meio, o `finally` nunca rodava e o ouvinte
   * ficava para sempre — mais um a cada visita a Configurações.
   */
  it("uma assinatura só, solta quando o último download termina", async () => {
    let concluirA!: () => void;
    let concluirB!: () => void;
    acessorioBaixar
      .mockImplementationOnce(
        () => new Promise((r) => (concluirA = () => r({ cancelado: false, acessorio: info("pronto") }))),
      )
      .mockImplementationOnce(
        () => new Promise((r) => (concluirB = () => r({ cancelado: false, acessorio: info("pronto") }))),
      );

    const a = useDownloadStore.getState().baixar(MODELO);
    const b = useDownloadStore.getState().baixar("fpcalc");
    await piscar();
    expect(onAcessorioProgresso).toHaveBeenCalledTimes(1);
    expect(ouvintes).toHaveLength(1);

    concluirA();
    await a;
    expect(soltarAssinatura).not.toHaveBeenCalled();

    concluirB();
    await b;
    expect(soltarAssinatura).toHaveBeenCalledTimes(1);
    expect(ouvintes).toHaveLength(0);
  });

  /**
   * Sem canal de progresso o download CONTINUA: só não há barra. A assinatura
   * é conveniência, e conveniência não cancela 1,5 GB (DECISIONS #86 — "não
   * sabemos" é um estado, não um motivo para desistir).
   */
  it("assinatura que falha não impede o download", async () => {
    onAcessorioProgresso.mockRejectedValue(new Error("sem canal de eventos"));
    await useDownloadStore.getState().baixar(MODELO);
    expect(acessorioBaixar).toHaveBeenCalledTimes(1);
    expect(useDownloadStore.getState().resultados[MODELO]?.estado).toBe("pronto");
  });
});
