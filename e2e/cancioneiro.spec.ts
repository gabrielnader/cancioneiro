import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

/**
 * E2E dos fluxos críticos (seção 8 do PRD) — frontend real + IPC mockado.
 * Áudio é REAL: o Chromium decodifica os MP3s de fixtures/ servidos pelo Vite.
 */

const LETRA_TRECHO = "noite sem estrela";

/** Coleta erros de console/página para o check "sem erros nos fluxos padrão". */
function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(String(err)));
  return errors;
}

async function resetApp(page: Page) {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
}

/**
 * V8/F18 — a varredura em lote mudou de endereço: saiu do ✎ da árvore de
 * pastas e passou a viver em Configurações → "Curadoria do acervo". Toda a
 * suíte passa por aqui, que é o caminho real da pessoa.
 */
async function dispararCuradoria(page: Page, pasta = "") {
  await page.getByRole("button", { name: "Configurações" }).click();
  await page.getByLabel("Pasta a curar").selectOption(pasta);
  await page.getByRole("button", { name: "Buscar dados desta pasta" }).click();
}

async function addMockFolder(page: Page) {
  await page.getByRole("button", { name: "Adicionar pasta" }).first().click();
  await expect(page.getByText("3 músicas indexadas.")).toBeVisible();
  await expect(page.getByText("Coração Sertanejo")).toBeVisible();
}

test.describe("Fluxo crítico: indexar → buscar → ver letra → tocar", () => {
  test("adicionar pasta indexa e lista as músicas — sem erros no console", async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await resetApp(page);
    await expect(page.getByText("Sua biblioteca está vazia")).toBeVisible();
    await addMockFolder(page);
    await expect(page.getByText("Instrumental Sem Letra")).toBeVisible();
    await expect(page.getByText("sem_tags")).toBeVisible();
    // badge para músicas sem letra
    expect(await page.getByText("Sem letra", { exact: true }).count()).toBe(2);
    // seção 8 do PRD: sem erros no console nos fluxos padrão
    expect(errors).toEqual([]);
  });

  // V6 — as coordenadoras se organizam por nome de arquivo há anos: ele entra
  // como SOMA (segunda linha da lista, linha inteira no painel), nunca no lugar
  // do título.
  test("nome do arquivo aparece na linha e no painel, sem repetir o título", async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await resetApp(page);
    await addMockFolder(page);

    const linha = page
      .getByRole("option")
      .filter({ hasText: "Coração Sertanejo" })
      .first();
    const nome = linha.getByTestId("song-filename");
    await expect(nome).toHaveText("com_letra.mp3");
    // nome inteiro disponível na dica, para quando o nome for longo e truncar
    await expect(nome).toHaveAttribute("title", "com_letra.mp3");
    // o título continua sendo a informação principal da linha
    await expect(linha.getByText("Coração Sertanejo")).toBeVisible();

    // painel de detalhes: nome do arquivo por extenso, junto do título
    // (clicar na própria linha do nome seleciona — o alvo de clique não mudou)
    await nome.click();
    const panel = page.getByLabel("Painel de letra");
    await expect(panel.getByTestId("panel-filename")).toHaveText("com_letra.mp3");

    // música sem tags: o título JÁ é o nome do arquivo — nada é impresso duas vezes
    const semTags = page.getByRole("option").filter({ hasText: "sem_tags" }).first();
    await expect(semTags.getByTestId("song-filename")).toHaveCount(0);
    await semTags.getByText("sem_tags", { exact: true }).click();
    await expect(panel.getByTestId("panel-filename")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  // Desde a V6 a altura da linha VARIA (nome do arquivo, snippet). O
  // virtualizador só remede a lista quando a contagem ou a chave dos itens
  // muda: trocar de lista mantendo a MESMA quantidade já desenhou as linhas
  // novas nas fatias das antigas — texto estourando a própria fatia e
  // sobrepondo a linha seguinte.
  test("trocar a lista mantendo a mesma quantidade não deixa a linha na fatia da lista anterior", async ({
    page,
  }) => {
    await resetApp(page);
    await addMockFolder(page);

    /** Cada linha tem de caber na fatia que a virtualização reservou. */
    async function fatiasComportam(): Promise<void> {
      const medidas = await page.evaluate(() =>
        [...document.querySelectorAll('[role="option"]')].map((linha) => {
          const fatia = linha.parentElement as HTMLElement;
          return {
            titulo: linha.textContent?.slice(0, 30) ?? "",
            fatia: fatia.getBoundingClientRect().height,
            linha: linha.getBoundingClientRect().height,
            topoFatia: fatia.getBoundingClientRect().top,
            baseLinha: linha.getBoundingClientRect().bottom,
          };
        }),
      );
      expect(medidas.length).toBeGreaterThan(0);
      for (const m of medidas) {
        expect(
          m.fatia,
          `"${m.titulo}": fatia de ${m.fatia}px para uma linha de ${m.linha}px`,
        ).toBeGreaterThanOrEqual(m.linha);
      }
      // e nenhuma linha invade a fatia da seguinte
      for (let i = 0; i < medidas.length - 1; i++) {
        expect(medidas[i].baseLinha).toBeLessThanOrEqual(
          medidas[i + 1].topoFatia + 0.5,
        );
      }
    }

    const search = page.getByPlaceholder("Buscar por letra, título ou artista…");

    // 1 resultado sem snippet (casa pelo título) → fatia mais baixa
    await search.fill("sertanejo");
    await expect(page.getByText("1 resultados")).toBeVisible();
    await expect(page.locator("mark")).toHaveCount(0);
    await fatiasComportam();

    // 1 resultado COM snippet (casa só pela letra) → a linha cresce, e a
    // contagem continua 1: é aqui que as medidas antigas eram reaproveitadas
    await search.fill(LETRA_TRECHO);
    await expect(page.getByText("1 resultados")).toBeVisible();
    await expect(page.locator("mark").first()).toBeVisible();
    await fatiasComportam();

    // biblioteca inteira de volta (linhas de alturas diferentes entre si)
    await search.fill("");
    await expect(page.getByRole("option")).toHaveCount(3);
    await fatiasComportam();
  });

  test("buscar trecho que existe só na letra destaca o termo; sem acento também encontra", async ({
    page,
  }) => {
    await resetApp(page);
    await addMockFolder(page);

    const search = page.getByPlaceholder("Buscar por letra, título ou artista…");
    await search.fill(LETRA_TRECHO);
    await expect(page.getByText("1 resultados")).toBeVisible();
    await expect(page.getByText("Coração Sertanejo")).toBeVisible();
    // snippet com highlight
    await expect(page.locator("mark").first()).toBeVisible();

    // sem acento
    await search.fill("coracao");
    await expect(page.getByText("Coração Sertanejo")).toBeVisible();

    // caracteres especiais não quebram
    await search.fill('"*-()');
    await expect(page.getByRole("listbox", { name: "Músicas" })).toBeVisible();

    // sem resultados: mensagens exatas
    await search.fill("xyzinexistente");
    await expect(
      page.getByText('Nenhuma música encontrada para "xyzinexistente".'),
    ).toBeVisible();
    await expect(
      page.getByText("Tente palavras diferentes do trecho que você lembra."),
    ).toBeVisible();

    // limpar restaura a biblioteca completa
    await search.fill("");
    await expect(page.getByText("Coração Sertanejo")).toBeVisible();
    await expect(page.getByText("Instrumental Sem Letra")).toBeVisible();

    // botão × limpa a busca e devolve o foco ao campo (V5 Q1)
    await search.fill("coracao");
    const limpar = page.getByRole("button", { name: "Limpar busca" });
    await expect(limpar).toBeVisible();
    await limpar.click();
    await expect(search).toHaveValue("");
    await expect(search).toBeFocused();
    await expect(limpar).toHaveCount(0);
    await expect(page.getByText("Instrumental Sem Letra")).toBeVisible();
  });

  // V8 — a outra metade do nome do arquivo: depois de VISÍVEL (V6), BUSCÁVEL.
  // "com_letra" só existe no nome do arquivo — as tags dizem "Coração
  // Sertanejo" / "Artista Teste" —, e um match assim não inventa snippet: o
  // trecho destacado continua sendo exclusividade da letra.
  test("buscar pelo nome do arquivo encontra a música, sem trecho destacado", async ({
    page,
  }) => {
    await resetApp(page);
    await addMockFolder(page);

    const search = page.getByPlaceholder("Buscar por letra, título ou artista…");
    await search.fill("com_letra");
    await expect(page.getByText("1 resultados")).toBeVisible();
    await expect(page.getByText("Coração Sertanejo")).toBeVisible();
    await expect(page.locator("mark")).toHaveCount(0);

    // a extensão não é conteúdo: digitar "mp3" não devolve o acervo inteiro
    await search.fill("mp3");
    await expect(
      page.getByText('Nenhuma música encontrada para "mp3".'),
    ).toBeVisible();
  });

  test("temas (V2): chips na lista, clique busca pelo tema e busca sem acento encontra", async ({
    page,
  }) => {
    await resetApp(page);
    await addMockFolder(page);

    // busca por tema sem acento ("agua" → tema "água")
    const search = page.getByPlaceholder("Buscar por letra, título ou artista…");
    await search.fill("agua");
    await expect(page.getByText("1 resultados")).toBeVisible();
    await expect(page.getByText("Coração Sertanejo")).toBeVisible();

    // chips visíveis na linha
    await search.fill("");
    const chip = page.getByRole("button", { name: "Tema: esperança" }).first();
    await expect(chip).toBeVisible();

    // clique no chip preenche a busca e filtra
    await chip.click();
    await expect(search).toHaveValue("esperança");
    await expect(page.getByText("1 resultados")).toBeVisible();
    await expect(page.getByText("Coração Sertanejo")).toBeVisible();

    // chips também no painel de letra
    await page.getByText("Coração Sertanejo").first().click();
    const panel = page.getByLabel("Painel de letra");
    await expect(panel.getByRole("button", { name: "Tema: água" })).toBeVisible();
  });

  test("clique único mostra a letra e NÃO toca; duplo-clique toca", async ({
    page,
  }) => {
    await resetApp(page);
    await addMockFolder(page);

    await page.getByText("Coração Sertanejo").first().click();
    const panel = page.getByLabel("Painel de letra");
    await expect(panel.getByText("Quando o sol amanhecer")).toBeVisible();
    await expect(panel.getByText("Não há noite sem estrela")).toBeVisible();

    // não está tocando
    const audio = page.getByTestId("player-audio");
    await expect(audio).toHaveJSProperty("paused", true);

    // música sem letra: mensagem exata
    await page.getByText("Instrumental Sem Letra").first().click();
    await expect(
      panel.getByText("Esta música ainda não tem letra registrada."),
    ).toBeVisible();

    // duplo-clique toca de verdade (áudio real no Chromium) em < 500ms
    await page.getByText("Coração Sertanejo").first().dblclick();
    await expect(audio).toHaveJSProperty("paused", false, { timeout: 500 });
    await expect
      .poll(async () => audio.evaluate((a: HTMLAudioElement) => a.currentTime), {
        timeout: 3000,
      })
      .toBeGreaterThan(0);

    // seek pela barra de progresso reposiciona o áudio (±1s do ponto clicado);
    // reinicia a faixa e pausa para o teste ser determinístico
    await page.getByText("Coração Sertanejo").first().dblclick();
    await expect(audio).toHaveJSProperty("paused", false);
    await expect
      .poll(async () => audio.evaluate((a: HTMLAudioElement) => a.duration))
      .toBeGreaterThan(2);
    await page.getByRole("button", { name: "Pausar" }).click();
    await expect(audio).toHaveJSProperty("paused", true);
    const bar = page.getByRole("slider", { name: "Progresso da música" });
    const box = (await bar.boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height / 2);
    const duration = await audio.evaluate((a: HTMLAudioElement) => a.duration);
    await expect
      .poll(async () => audio.evaluate((a: HTMLAudioElement) => a.currentTime))
      .toBeGreaterThan(duration * 0.5 - 1);
    const t = await audio.evaluate((a: HTMLAudioElement) => a.currentTime);
    expect(Math.abs(t - duration * 0.5)).toBeLessThan(1);
  });

  test("selecionar com clique único e iniciar pelo botão ▶ Tocar da barra", async ({
    page,
  }) => {
    await resetApp(page);
    await addMockFolder(page);

    const audio = page.getByTestId("player-audio");
    // sem seleção: botão desabilitado
    await expect(page.getByRole("button", { name: "Tocar", exact: true })).toBeDisabled();

    await page.getByText("Coração Sertanejo").first().click();
    await expect(audio).toHaveJSProperty("paused", true);

    await page.getByRole("button", { name: "Tocar", exact: true }).click();
    await expect(audio).toHaveJSProperty("paused", false);
    await expect(page.getByRole("button", { name: "Pausar" })).toBeVisible();
  });

  test("espaço alterna play/pause fora da busca; dentro da busca digita espaço", async ({
    page,
  }) => {
    await resetApp(page);
    await addMockFolder(page);

    await page.getByText("Coração Sertanejo").first().dblclick();
    const audio = page.getByTestId("player-audio");
    await expect(audio).toHaveJSProperty("paused", false);

    await page.locator("body").click(); // tira o foco do campo
    await page.keyboard.press("Space");
    await expect(audio).toHaveJSProperty("paused", true);

    // espaço dentro do campo de busca insere espaço e não retoma o play
    const search = page.getByPlaceholder("Buscar por letra, título ou artista…");
    await search.click();
    await search.pressSequentially("sol amanhecer");
    await expect(search).toHaveValue("sol amanhecer");
    await expect(audio).toHaveJSProperty("paused", true);

    // "/" foca a busca
    await page.locator("body").click();
    await page.keyboard.press("/");
    await expect(search).toBeFocused();
  });
});

test.describe("Cabeçalho: o botão flutuante de detalhes x o conteúdo das views", () => {
  // Relato de uso real: o botão "Ocultar/Mostrar detalhes" montava em cima do
  // campo de busca. Ele é FLUTUANTE (precisa existir em todas as views —
  // decisão 25), então cada view tem de reservar a faixa dele, e a única
  // garantia real é medir as caixas.
  //
  // A primeira versão deste teste media SÓ a LibraryView, SÓ a 1280 — e
  // passava enquanto a Playlist tinha o "Excluir playlist" 72 px por baixo do
  // botão a 1024. Um teste que cobre uma view de uma família de três dá
  // exatamente a confiança errada. Agora: as TRÊS views, nas duas pontas da
  // largura suportada, com o painel aberto e fechado, contra QUALQUER
  // elemento interativo da faixa do botão.
  //
  // As duas larguras: 1280 é a janela típica (o padrão do app é 1200) e 1024
  // é o `minWidth` do tauri.conf.json — o mais estreito que a janela do
  // produto chega a ser. Abaixo disso não é caso do produto (ver o teste
  // seguinte).
  const LARGURAS = [1280, 1024];

  // A faixa reservada (--faixa-detalhes, index.css) foi dimensionada para a
  // janela do produto, cujo piso é o `minWidth` do tauri.conf.json. Abaixo
  // dele, com o painel aberto, o botão flutuante chega a cobrir o campo de
  // busca inteiro — mas a janela não pode ficar tão estreita, e o modo web
  // (onde ela pode) é ferramenta de desenvolvimento, não o produto.
  //
  // Só que essa justificativa depende de um número que mora em OUTRO
  // arquivo. Se alguém baixar o minWidth, este teste passa a mentir em
  // silêncio — então ele confere o número.
  test("a largura mínima testada é mesmo o piso da janela do produto", () => {
    const conf = JSON.parse(
      readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf-8"),
    );
    const minWidth = conf.app.windows[0].minWidth;
    expect(
      minWidth,
      "o minWidth da janela mudou: refaça a conta de --faixa-detalhes e " +
        "ajuste LARGURAS — abaixo de 1024 o botão flutuante cobre a busca",
    ).toBe(Math.min(...LARGURAS));
  });

  /** Sobreposição em px entre duas caixas (0 quando não se tocam). */
  function sobreposicao(a: Box, b: Box) {
    return {
      x: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
      y: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
    };
  }

  type Box = { x: number; y: number; width: number; height: number };

  /**
   * Falha se qualquer elemento interativo do <main> encostar no botão.
   * Não é uma lista de elementos conhecidos de propósito: um controle novo
   * no cabeçalho de qualquer view tem de acordar este teste sozinho.
   */
  async function semSobreposicaoCom(page: Page, contexto: string) {
    const botao = page.getByTestId("toggle-detalhes");
    await expect(botao).toBeVisible();
    const t = (await botao.boundingBox())!;

    const alvos = await page.locator("main button, main input, main a").all();
    const colisoes: string[] = [];
    for (const alvo of alvos) {
      if ((await alvo.getAttribute("data-testid")) === "toggle-detalhes") continue;
      const b = await alvo.boundingBox();
      if (!b) continue;
      const o = sobreposicao(t, b);
      if (o.x > 0 && o.y > 0) {
        const nome =
          (await alvo.getAttribute("aria-label")) ??
          (await alvo.getAttribute("placeholder")) ??
          ((await alvo.textContent()) || "?").trim();
        colisoes.push(
          `"${nome}" coberto em ${Math.round(o.x)}x${Math.round(o.y)} px` +
            ` (elemento x=${Math.round(b.x)}..${Math.round(b.x + b.width)},` +
            ` botão x=${Math.round(t.x)}..${Math.round(t.x + t.width)})`,
        );
      }
    }
    expect(colisoes, `${contexto}: o botão flutuante cobre controles`).toEqual([]);
  }

  test("nenhuma das três views deixa o botão cobrir um controle, em 1280 e 1024", async ({
    page,
  }) => {
    await resetApp(page);
    await addMockFolder(page);
    // uma playlist de verdade: é o cabeçalho mais cheio das três views
    await page.getByRole("button", { name: "Nova playlist" }).click();
    await page.getByPlaceholder("Nome da playlist").fill("Encontro de sábado");
    await page.getByRole("button", { name: "Criar" }).click();

    const views: [string, () => Promise<void>][] = [
      [
        "Biblioteca",
        async () => {
          await page.getByRole("button", { name: "Biblioteca", exact: true }).click();
        },
      ],
      [
        "Playlist",
        async () => {
          await page.getByRole("button", { name: /Encontro de sábado/ }).first().click();
        },
      ],
      [
        "Configurações",
        async () => {
          await page.getByRole("button", { name: "Configurações" }).click();
        },
      ],
    ];

    for (const largura of LARGURAS) {
      await page.setViewportSize({ width: largura, height: 760 });
      for (const painel of ["aberto", "fechado"]) {
        for (const [nome, abrir] of views) {
          await abrir();
          await semSobreposicaoCom(page, `${nome} @ ${largura}px, painel ${painel}`);
        }
        if (painel === "aberto") {
          await page.getByTestId("toggle-detalhes").click();
        }
      }
      await page.getByTestId("toggle-detalhes").click(); // reabre para a próxima largura
    }
  });

  test("na Biblioteca o botão fica alinhado com o campo de busca, aberto ou fechado", async ({
    page,
  }) => {
    await resetApp(page);
    await addMockFolder(page);

    const busca = page.getByPlaceholder("Buscar por letra, título ou artista…");
    const botao = page.getByTestId("toggle-detalhes");

    for (const largura of LARGURAS) {
      await page.setViewportSize({ width: largura, height: 760 });
      for (const estado of ["aberto", "fechado"]) {
        const contexto = `[${largura}px, ${estado}]`;
        const b = (await busca.boundingBox())!;
        const t = (await botao.boundingBox())!;
        expect(t.x, `${contexto} botão invade o campo de busca`).toBeGreaterThanOrEqual(
          b.x + b.width,
        );
        // alinhados na mesma linha: topos coincidem e alturas batem
        expect(Math.abs(t.y - b.y), `${contexto} topos desalinhados`).toBeLessThanOrEqual(2);
        expect(
          Math.abs(t.height - b.height),
          `${contexto} alturas diferentes`,
        ).toBeLessThanOrEqual(2);
        // o campo continua utilizável: reservar a faixa não pode espremer a
        // busca a ponto de não caber nem uma palavra
        expect(b.width, `${contexto} campo de busca espremido`).toBeGreaterThanOrEqual(160);
        if (estado === "aberto") await botao.click();
      }
      await botao.click(); // reabre para a próxima largura
    }
  });
});

test.describe("Persistência entre sessões (reload)", () => {
  test("volume, painel de letra e nível de fonte persistem", async ({ page }) => {
    await resetApp(page);
    await addMockFolder(page);

    // volume
    await page.getByLabel("Volume").fill("0.4");
    // painel de letra: oculta
    await page.getByRole("button", { name: "Ocultar detalhes" }).click();
    await expect(page.getByLabel("Painel de letra")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Mostrar detalhes" }),
    ).toBeVisible();

    await page.reload();
    await expect(page.getByLabel("Volume")).toHaveValue("0.4");
    await expect(page.getByLabel("Painel de letra")).toHaveCount(0);

    // reexibe e cicla fonte 16 → 20
    await page.getByRole("button", { name: "Mostrar detalhes" }).click();
    await page.getByText("Coração Sertanejo").first().click();
    const body = page.getByTestId("lyrics-body");
    await expect(body).toHaveCSS("font-size", "16px");
    await page.getByRole("button", { name: "Tamanho da fonte da letra" }).click();
    await expect(body).toHaveCSS("font-size", "20px");

    await page.reload();
    await page.getByText("Coração Sertanejo").first().click();
    await expect(page.getByTestId("lyrics-body")).toHaveCSS("font-size", "20px");
  });
});

test.describe("Playlists (F5)", () => {
  async function createPlaylistWithSongs(page: Page, name: string) {
    await page.getByRole("button", { name: "Nova playlist" }).click();
    await page.getByPlaceholder("Nome da playlist").fill(name);
    await page.getByRole("button", { name: "Criar" }).click();
    // volta para a biblioteca para adicionar músicas
    await page.getByRole("button", { name: "Biblioteca", exact: true }).click();
    for (const title of ["Coração Sertanejo", "Instrumental Sem Letra"]) {
      const row = page.getByRole("option").filter({ hasText: title }).first();
      await row.hover();
      await row.getByLabel("Adicionar à playlist").click();
      // o menu é renderizado em portal (document.body)
      await page.getByRole("button", { name, exact: true }).click();
    }
    await page.getByRole("button", { name: new RegExp(name) }).first().click();
  }

  test("criar, adicionar, tocar em sequência automática e parar no fim", async ({
    page,
  }) => {
    test.setTimeout(45_000);
    const errors = trackErrors(page);
    await resetApp(page);
    await addMockFolder(page);
    await createPlaylistWithSongs(page, "Culto");

    await expect(
      page.getByRole("listbox", { name: "Playlist Culto" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "▶ Tocar playlist" }).click();
    const audio = page.getByTestId("player-audio");
    await expect(audio).toHaveJSProperty("paused", false);
    // primeira faixa (3s de duração real)
    await expect(
      page.getByRole("button", { name: "Pausar" }),
    ).toBeVisible();

    // avanço automático para a segunda (aguarda fim da primeira)
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const a = document.querySelector(
              "[data-testid=player-audio]",
            ) as HTMLAudioElement;
            return a.src;
          }),
        { timeout: 15_000 },
      )
      .toContain("sem_letra.mp3");
    await expect(audio).toHaveJSProperty("paused", false);

    // fim da última: para e o botão volta a ▶ (aria-label "Tocar")
    await expect(page.getByRole("button", { name: "Tocar", exact: true })).toBeVisible(
      { timeout: 15_000 },
    );
    await expect(audio).toHaveJSProperty("paused", true);
    // seção 8 do PRD: sem erros no console no fluxo de playlist
    expect(errors).toEqual([]);
  });

  test("playlist persiste (ordem) após reload; item ausente é pulado com toast", async ({
    page,
  }) => {
    test.setTimeout(45_000);
    await resetApp(page);
    await addMockFolder(page);
    await createPlaylistWithSongs(page, "Domingo");

    // persiste após "reiniciar o app"
    await page.reload();
    await page.getByRole("button", { name: /Domingo/ }).click();
    const list = page.getByRole("listbox", { name: "Playlist Domingo" });
    await expect(list.getByText("Coração Sertanejo")).toBeVisible();
    await expect(list.getByText("Instrumental Sem Letra")).toBeVisible();

    // simula sumiço do arquivo da primeira música
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__CANCIONEIRO_MOCK__._removeFileFromDisk(
        "/musicas/mock/com_letra.mp3",
      );
    });

    await page.getByRole("button", { name: "▶ Tocar playlist" }).click();
    await expect(
      page.getByText('Pulando "Coração Sertanejo": arquivo não encontrado.'),
    ).toBeVisible();
    // avançou para a segunda e está tocando
    const audio = page.getByTestId("player-audio");
    await expect(audio).toHaveJSProperty("paused", false);
    await expect
      .poll(async () => audio.evaluate((a: HTMLAudioElement) => a.src))
      .toContain("sem_letra.mp3");
  });

  test("tocar avulsa com arquivo ausente mostra o toast de erro exato", async ({
    page,
  }) => {
    await resetApp(page);
    await addMockFolder(page);
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__CANCIONEIRO_MOCK__._removeFileFromDisk(
        "/musicas/mock/com_letra.mp3",
      );
    });
    await page.getByText("Coração Sertanejo").first().dblclick();
    await expect(
      page.getByText(
        "Arquivo não encontrado: Coração Sertanejo. A música foi removida da biblioteca?",
      ),
    ).toBeVisible();
    const audio = page.getByTestId("player-audio");
    await expect(audio).toHaveJSProperty("paused", true);
  });
});

test.describe("V4", () => {
  test("editar metadados no app: salvar grava, toast exato e a busca encontra o novo título", async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await resetApp(page);
    await addMockFolder(page);

    // clique único seleciona; painel mostra o botão Editar
    await page.getByText("sem_tags", { exact: true }).first().click();
    const panel = page.getByLabel("Painel de letra");
    await panel.getByRole("button", { name: "Editar" }).click();

    await panel.getByLabel("Título").fill("Canção Editada");
    await panel.getByLabel("Artista").fill("Artista Editado");
    const temaInput = panel.getByPlaceholder("Adicionar tema");
    await temaInput.fill("fé");
    await temaInput.press("Enter");
    await expect(
      panel.getByRole("button", { name: "Remover tema fé" }),
    ).toBeVisible();

    await panel.getByRole("button", { name: "Salvar no arquivo" }).click();
    // toast exato com o basename do arquivo
    await expect(
      page.getByText("Alterações salvas em sem_tags.mp3."),
    ).toBeVisible();

    // sai do modo edição e o painel mostra o novo título/artista
    await expect(panel.getByLabel("Título")).toHaveCount(0);
    await expect(panel.getByText("Canção Editada")).toBeVisible();
    await expect(panel.getByText("Artista Editado")).toBeVisible();

    // reindexado: buscar pelo novo título encontra
    const search = page.getByPlaceholder("Buscar por letra, título ou artista…");
    await search.fill("Canção Editada");
    await expect(page.getByText("1 resultados")).toBeVisible();
    await expect(
      page.getByRole("option").filter({ hasText: "Canção Editada" }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  });

  // V8/F18 — o "Buscar letra na internet" da V4 virou "Buscar dados na
  // internet": o funil inteiro nesta música, com o resultado na própria ficha.
  test("funil de uma música só no editor: resultado inline, usar preenche, sem conexão avisa", async ({
    page,
  }) => {
    await resetApp(page);
    await addMockFolder(page);

    await page.getByText("Instrumental Sem Letra").first().click();
    const panel = page.getByLabel("Painel de letra");
    await panel.getByRole("button", { name: "Editar" }).click();
    // o botão antigo não existe mais: uma porta só para "buscar na internet"
    await expect(
      panel.getByRole("button", { name: "Buscar letra na internet" }),
    ).toHaveCount(0);

    await panel.getByRole("button", { name: "Buscar dados na internet" }).click();
    // procedência e confiança à vista, e nada preenchido sem mandar
    await expect(panel.getByText("via LRCLIB")).toBeVisible();
    await expect(panel.getByText("MÉDIA", { exact: true })).toBeVisible();
    await expect(panel.getByLabel("Letra", { exact: true })).toHaveValue("");

    await panel.getByRole("button", { name: "Usar estes dados" }).click();
    await expect(panel.getByLabel("Letra", { exact: true })).toHaveValue(
      /Quando o sol amanhecer/,
    );
    // e continua sendo o "Salvar no arquivo" quem grava
    await panel.getByRole("button", { name: "Salvar no arquivo" }).click();
    await expect(page.getByText("Alterações salvas em sem_letra.mp3.")).toBeVisible();

    // sem conexão: o aviso fica na ficha, não some como um toast
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__CANCIONEIRO_MOCK__._offline = true;
    });
    await panel.getByRole("button", { name: "Editar" }).click();
    await panel.getByRole("button", { name: "Buscar dados na internet" }).click();
    await expect(panel.getByText("sem conexão")).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Usar estes dados" }),
    ).toHaveCount(0);
  });

  // ~3% de cobertura no acervo real: "não achamos" é o desfecho mais comum.
  test("uma música sem nada a propor recebe o aviso honesto, não um erro", async ({
    page,
  }) => {
    await resetApp(page);
    await addMockFolder(page);

    // título já igual ao palpite do nome do arquivo, sem artista e sem letra
    await page.getByText("sem_tags", { exact: true }).first().click();
    const panel = page.getByLabel("Painel de letra");
    await panel.getByRole("button", { name: "Editar" }).click();
    await panel.getByLabel("Título").fill("sem tags");
    await panel.getByRole("button", { name: "Salvar no arquivo" }).click();
    await expect(page.getByText("Alterações salvas em sem_tags.mp3.")).toBeVisible();

    await panel.getByRole("button", { name: "Editar" }).click();
    await panel.getByRole("button", { name: "Buscar dados na internet" }).click();
    // ALTO-3b: o texto fala de "nada novo" — a busca ACONTECEU, e é só isso
    // que o `null` do backend passou a significar
    await expect(
      panel.getByText(/não achamos nada novo para esta música/),
    ).toBeVisible();
    // não lê como fracasso nem como "esta música está completa"
    await expect(panel.getByText(/Isso é comum/)).toBeVisible();
    // V9 — "nos sites de letra" saiu porque deixou de ser verdade (a etapa do
    // som não é site de letra), e a frase que mandava a pessoa para as
    // ferramentas de fora saiu no passe de redução
  });

  test("árvore de pastas: subpastas com contadores, clique filtra, chip remove o filtro", async ({
    page,
  }) => {
    await resetApp(page);
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__CANCIONEIRO_MOCK__._seedFolderTree();
    });
    await page.reload();

    // árvore: raiz "acervo" e subpastas "1" e "2" com contadores
    const root = page.getByRole("button", { name: "Pasta acervo" });
    await expect(root).toBeVisible();
    await expect(root).toContainText("2");
    const pasta1 = page.getByRole("button", { name: "Pasta 1", exact: true });
    const pasta2 = page.getByRole("button", { name: "Pasta 2", exact: true });
    await expect(pasta1).toContainText("1");
    await expect(pasta2).toContainText("1");

    // clicar em "1" filtra a lista para a subárvore de 1/
    await pasta1.click();
    const list = page.getByRole("listbox", { name: "Músicas" });
    await expect(list.getByText("Faixa Um")).toBeVisible();
    await expect(list.getByText("Faixa Dois")).toHaveCount(0);

    // chip removível no topo
    const chip = page.getByRole("button", { name: "Remover filtro de pasta" });
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("📁 1");

    // busca digitada refina DENTRO do filtro
    const search = page.getByPlaceholder("Buscar por letra, título ou artista…");
    await search.fill("faixa");
    await expect(page.getByText("1 resultados")).toBeVisible();
    await search.fill("");

    // × limpa o filtro e restaura a biblioteca completa
    await chip.click();
    await expect(chip).toHaveCount(0);
    await expect(list.getByText("Faixa Um")).toBeVisible();
    await expect(list.getByText("Faixa Dois")).toBeVisible();

    // pasta RAIZ não filtra nem cria chip — equivale a Biblioteca (V5 Q2)
    await pasta2.click();
    await expect(chip).toBeVisible();
    await root.click();
    await expect(chip).toHaveCount(0);
    await expect(list.getByText("Faixa Um")).toBeVisible();
    await expect(list.getByText("Faixa Dois")).toBeVisible();
  });

  test("BUG v0.4: tema digitado SEM Enter é salvo ao clicar em Salvar e a busca encontra", async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await resetApp(page);
    await addMockFolder(page);

    await page.getByText("sem_tags", { exact: true }).first().click();
    const panel = page.getByLabel("Painel de letra");
    await panel.getByRole("button", { name: "Editar" }).click();

    // digita o tema e clica DIRETO em Salvar, sem Enter
    await panel.getByPlaceholder("Adicionar tema").fill("peregrinação");
    await panel.getByRole("button", { name: "Salvar no arquivo" }).click();
    await expect(
      page.getByText("Alterações salvas em sem_tags.mp3."),
    ).toBeVisible();

    // o tema virou chip na ficha da música
    await expect(
      panel.getByRole("button", { name: "Tema: peregrinação" }),
    ).toBeVisible();

    // buscar pelo tema encontra a música
    const search = page.getByPlaceholder("Buscar por letra, título ou artista…");
    await search.fill("peregrinação");
    await expect(page.getByText("1 resultados")).toBeVisible();
    await expect(
      page.getByRole("option").filter({ hasText: "sem_tags" }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("filtro de pasta ativo: tema salvo em música de OUTRA pasta só aparece na busca ao limpar o filtro (×)", async ({
    page,
  }) => {
    await resetApp(page);
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__CANCIONEIRO_MOCK__._seedFolderTree();
    });
    await page.reload();

    // seleciona a música da pasta 2/ e SÓ DEPOIS filtra pela pasta 1/
    await page.getByText("Faixa Dois").first().click();
    await page.getByRole("button", { name: "Pasta 1", exact: true }).click();
    const panel = page.getByLabel("Painel de letra");
    // a seleção sobrevive ao filtro: o painel continua na Faixa Dois
    await expect(panel.getByText("Faixa Dois")).toBeVisible();

    // salva um tema (sem Enter) na música da OUTRA pasta
    await panel.getByRole("button", { name: "Editar" }).click();
    await panel.getByPlaceholder("Adicionar tema").fill("advento");
    await panel.getByRole("button", { name: "Salvar no arquivo" }).click();
    await expect(page.getByText("Alterações salvas em b.mp3.")).toBeVisible();

    // com o filtro da pasta 1/ ativo, a busca pelo tema NÃO mostra a música;
    // a UI deixa claro o porquê: o chip 📁 1 segue visível sobre o empty state
    const search = page.getByPlaceholder("Buscar por letra, título ou artista…");
    await search.fill("advento");
    await expect(
      page.getByText('Nenhuma música encontrada para "advento".'),
    ).toBeVisible();
    const chip = page.getByRole("button", { name: "Remover filtro de pasta" });
    await expect(chip).toContainText("📁 1");

    // limpar o filtro no × do chip revela a música na busca pelo tema
    await chip.click();
    await expect(page.getByText("1 resultados")).toBeVisible();
    await expect(
      page.getByRole("option").filter({ hasText: "Faixa Dois" }),
    ).toBeVisible();
  });
});

test.describe("V5 — Completar dados em lote (F13)", () => {
  test("varrer a biblioteca propõe dados; aplicar a selecionada atualiza a música", async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await resetApp(page);
    await addMockFolder(page);
    // com_letra completa fica de fora: sem_letra (MÉDIA) e sem_tags (BAIXA)
    expect(await page.getByText("Sem letra", { exact: true }).count()).toBe(2);

    // "Toda a biblioteca" = prefixo vazio
    await dispararCuradoria(page);

    const dialog = page.getByRole("dialog", { name: "Completar dados" });
    await expect(
      dialog.getByText("2 propostas — 0 alta, 1 média, 1 baixa"),
    ).toBeVisible();
    await expect(dialog.getByText("MÉDIA", { exact: true })).toBeVisible();
    await expect(dialog.getByText("BAIXA", { exact: true })).toBeVisible();
    await expect(dialog.getByText("letra encontrada")).toBeVisible();

    // nada pré-marcado (nenhuma ALTA): aplicar começa desabilitado
    const aplicar0 = dialog.getByRole("button", {
      name: "Aplicar selecionadas (0)",
    });
    await expect(aplicar0).toBeDisabled();

    // o humano decide: marca a MÉDIA (letra encontrada para a instrumental)
    await dialog
      .getByRole("checkbox", { name: "Aplicar proposta: Instrumental Sem Letra" })
      .check();
    await dialog
      .getByRole("button", { name: "Aplicar selecionadas (1)" })
      .click();

    // PRD V8: o aviso final diz o que MUDOU, nunca uma tarefa a fazer
    await expect(
      page.getByText("1 música ganhou letra. A biblioteca já está atualizada."),
    ).toBeVisible();
    // e NÃO existe popup nenhum pedindo reindexação ou reinício: a curadoria
    // feita dentro do app já reindexou
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // de volta à biblioteca, a música ganhou letra: só a sem_tags tem o badge
    await page.getByRole("button", { name: "Biblioteca", exact: true }).click();
    expect(await page.getByText("Sem letra", { exact: true }).count()).toBe(1);

    // a letra aplicada abre no painel de detalhes
    await page.getByText("Instrumental Sem Letra").first().click();
    await expect(
      page.getByLabel("Painel de letra").getByText(LETRA_TRECHO),
    ).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("progresso determinado, segundo plano e reabrir pelo indicador", async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await resetApp(page);
    await addMockFolder(page);
    // varredura lenta o bastante para a barra e o segundo plano existirem
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__CANCIONEIRO_MOCK__._enrichDelayMs = 1500;
    });

    await dispararCuradoria(page);

    const dialog = page.getByRole("dialog", { name: "Completar dados" });
    // barra determinada com "n de total" (2 músicas incompletas)
    await expect(dialog.getByText("Buscando dados… 0 de 2")).toBeVisible();
    await expect(dialog.getByRole("progressbar")).toHaveAttribute(
      "aria-valuemax",
      "2",
    );
    // com uma varredura rodando, disparar outra fica bloqueado
    await expect(
      page.getByRole("button", { name: "Buscar dados desta pasta" }),
    ).toBeDisabled();

    // some da frente sem cancelar: o app continua usável
    await dialog
      .getByRole("button", { name: "Deixar rodando em segundo plano" })
      .click();
    await expect(dialog).toHaveCount(0);
    const indicador = page.getByRole("button", { name: /Buscando dados/ });
    await expect(indicador).toBeVisible();
    // o indicador da lateral traz contagem E etapa do funil (V8/F18)
    await expect(indicador).toContainText(/de 2/);
    await expect(indicador).toContainText(/procurando no LRCLIB|preparando/);

    // a pessoa volta ao dia a dia enquanto a busca roda
    await page.getByRole("button", { name: "Biblioteca", exact: true }).click();

    // busca (atalho global) responde durante a varredura em segundo plano
    await page.keyboard.press("/");
    const search = page.getByPlaceholder("Buscar por letra, título ou artista…");
    await expect(search).toBeFocused();
    await search.fill(LETRA_TRECHO);
    await expect(page.getByText("1 resultados")).toBeVisible();
    await search.fill("");

    // ao terminar, o toast avisa e o indicador vira o convite à revisão
    await expect(
      page.getByText("Dados encontrados para 2 músicas — abra a revisão para conferir."),
    ).toBeVisible({ timeout: 15000 });
    await page.getByRole("button", { name: "Revisar 2 propostas" }).click();
    await expect(
      dialog.getByText("2 propostas — 0 alta, 1 média, 1 baixa"),
    ).toBeVisible();
    expect(errors).toEqual([]);
  });

  // M4: "Cancelar" só soltava a guarda de corrida — a varredura zumbi seguia
  // emitindo e a barra da varredura SEGUINTE começava com os números dela.
  test("Cancelar encerra a varredura de verdade e a seguinte começa limpa", async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await resetApp(page);
    await addMockFolder(page);
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__CANCIONEIRO_MOCK__._enrichDelayMs = 1500;
    });

    await page.getByRole("button", { name: "Configurações" }).click();
    const abrir = page.getByRole("button", { name: "Buscar dados desta pasta" });
    await abrir.click();
    const dialog = page.getByRole("dialog", { name: "Completar dados" });
    await expect(dialog.getByText("Buscando dados… 0 de 2")).toBeVisible();

    await dialog.getByRole("button", { name: "Cancelar" }).click();
    await expect(dialog).toHaveCount(0);
    // nem overlay nem indicador de segundo plano: a varredura acabou
    await expect(page.getByRole("button", { name: /Buscando dados/ })).toHaveCount(0);
    // o invoke ainda está respondendo: começar outra agora sobreporia as duas
    await expect(abrir).toBeDisabled();
    // MÉDIO-14: o motivo é TEXTO na tela (botão desabilitado não recebe foco,
    // e `title` não é anunciado de forma confiável)
    await expect(
      page.getByText(
        "Terminando de encerrar a busca anterior — aguarde alguns segundos.",
      ),
    ).toBeVisible();

    // quando o invoke enfim responde, o botão volta e a varredura recomeça do zero
    await expect(abrir).toBeEnabled({ timeout: 15000 });
    await abrir.click();
    await expect(dialog.getByText("Buscando dados… 0 de 2")).toBeVisible();
    await expect(dialog.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "0",
    );
    expect(errors).toEqual([]);
  });
});

test.describe("V5 — Aviso de transcrição automática (F14)", () => {
  const AVISO = "Letra transcrita automaticamente do áudio — pode conter erros.";

  test("aviso aparece na letra transcrita e some ao salvar uma letra revisada", async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await resetApp(page);
    await addMockFolder(page);

    // a curadoria marcou o arquivo como transcrito (TXXX:LETRA_ORIGEM)
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__CANCIONEIRO_MOCK__._markAsTranscribed(
        "/musicas/mock/com_letra.mp3",
      );
    });
    await page.reload();

    const panel = page.getByLabel("Painel de letra");
    await page.getByText("Coração Sertanejo").first().click();
    await expect(panel.getByTestId("lyrics-body")).toBeVisible();
    await expect(panel.getByTestId("lyrics-origem")).toHaveText(AVISO);

    // música oficial (sem marca) não carrega ressalva alguma
    await page.getByText("Instrumental Sem Letra").first().click();
    await expect(panel.getByTestId("lyrics-origem")).toHaveCount(0);

    // revisar a letra à mão derruba o aviso na hora, sem reiniciar o app
    await page.getByText("Coração Sertanejo").first().click();
    await expect(panel.getByTestId("lyrics-origem")).toBeVisible();
    await panel.getByRole("button", { name: "Editar" }).click();
    await panel
      .getByRole("textbox", { name: "Letra", exact: true })
      .fill("Letra conferida à mão");
    await panel.getByRole("button", { name: "Salvar no arquivo" }).click();
    await expect(
      page.getByText("Alterações salvas em com_letra.mp3."),
    ).toBeVisible();

    await expect(panel.getByTestId("lyrics-body")).toHaveText(
      "Letra conferida à mão",
    );
    await expect(panel.getByTestId("lyrics-origem")).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});

/**
 * V8/F18 — o funil dentro do app, Fase 1. A varredura em lote saiu do ✎ da
 * árvore de pastas e virou uma seção própria em Configurações, fora do caminho
 * do dia a dia. Estes testes cobrem o caminho inteiro de quem cura: escolher a
 * pasta, entender o que vai acontecer, disparar, acompanhar e conferir.
 */
test.describe("V8 — O funil dentro do app (F18)", () => {
  test("o ✎ saiu da lateral e a curadoria mora em Configurações, já na pasta selecionada", async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await resetApp(page);
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__CANCIONEIRO_MOCK__._seedFolderTree();
    });
    await page.reload();
    await expect(page.getByRole("button", { name: "Pasta acervo" })).toBeVisible();

    // a lateral voltou a ser só navegação
    await expect(
      page.getByRole("button", { name: /Completar dados/ }),
    ).toHaveCount(0);

    // quem estava olhando a subpasta "1" não precisa procurá-la de novo
    await page.getByRole("button", { name: "Pasta 1" }).click();
    await page.getByRole("button", { name: "Configurações" }).click();
    await expect(page.getByLabel("Pasta a curar")).toHaveValue("/acervo/1");

    // e o que vai acontecer está explicado ANTES de qualquer clique
    const secao = page.getByRole("region", { name: "Curadoria do acervo" });
    await expect(secao.getByText(/Nada é gravado sem você conferir/)).toBeVisible();
    await expect(secao.getByText(/LRCLIB/).first()).toBeVisible();
    // V9 — o texto que negava DUAS etapas pesadas nega uma só: o
    // reconhecimento pelo som passou a existir dentro do app
    await expect(
      secao.getByText(/Escrever a letra ouvindo o áudio ainda não é feito aqui/),
    ).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("a chave do Vagalume liga a terceira etapa, persiste e aparece na procedência", async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await resetApp(page);
    await addMockFolder(page);

    // QA ALTO-5: o Vagalume só é consultado quando existem título E artista
    // REAIS para conferir (enrich.rs) — ele não tem duração, e a igualdade de
    // palavras dos dois lados é a única prova que existe. Então a música que
    // vai chegar lá é uma de tags boas que o LRCLIB não conhece, e não a
    // sem_tags (que antes exercitava uma chamada que o backend nunca faria).
    const panel = page.getByLabel("Painel de letra");
    await page.getByText("sem_tags", { exact: true }).first().click();
    await panel.getByRole("button", { name: "Editar" }).click();
    await panel.getByLabel("Título").fill("Ponto de Oxum");
    await panel.getByLabel("Artista").fill("Grupo Fixture");
    await panel.getByRole("button", { name: "Salvar no arquivo" }).click();
    await expect(page.getByText("Alterações salvas em sem_tags.mp3.")).toBeVisible();

    await page.getByRole("button", { name: "Configurações" }).click();
    const campo = page.getByLabel("Chave do Vagalume (opcional)");
    // o endereço para pegar a chave gratuita está ali, escrito
    await expect(
      page.getByText("https://auth.vagalume.com.br/settings/api/"),
    ).toBeVisible();
    await campo.fill("chave-de-teste");

    // preferência como as outras: sobrevive ao reinício do app — e a tela diz
    // que ela fica guardada nesta máquina (QA MÉDIO-10)
    await expect(
      page.getByText(/Ela fica guardada neste computador/),
    ).toBeVisible();
    await page.reload();
    await page.getByRole("button", { name: "Configurações" }).click();
    await expect(page.getByLabel("Chave do Vagalume (opcional)")).toHaveValue(
      "chave-de-teste",
    );

    // com a chave, a música que o LRCLIB não resolveu passa pelo Vagalume
    await page.getByRole("button", { name: "Buscar dados desta pasta" }).click();
    const dialog = page.getByRole("dialog", { name: "Completar dados" });
    await expect(dialog.getByText("via Vagalume")).toBeVisible();
    await expect(dialog.getByText("via LRCLIB")).toBeVisible();
    // e esse caminho NUNCA propõe nome novo (DECISIONS #63): a letra é a
    // mudança inteira
    await expect(dialog.getByText("Ponto de Oxum — Grupo Fixture")).toHaveCount(2);
    await expect(
      dialog.getByText("2 propostas — 0 alta, 2 média, 0 baixa"),
    ).toBeVisible();
    expect(errors).toEqual([]);
  });

  // QA ALTO-5 — sem artista real, nem com chave o Vagalume entra: identificar
  // quem não tem etiqueta é trabalho da impressão digital (fase 2), e chutar
  // pelo nome do arquivo é como se grava "Ponto de Ogum" dentro de "Ponto de
  // Oxum" (DECISIONS #63).
  test("sem etiqueta de artista, a chave do Vagalume não muda nada", async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await resetApp(page);
    await addMockFolder(page);

    await page.getByRole("button", { name: "Configurações" }).click();
    await page.getByLabel("Chave do Vagalume (opcional)").fill("chave-de-teste");
    await page.getByRole("button", { name: "Buscar dados desta pasta" }).click();

    const dialog = page.getByRole("dialog", { name: "Completar dados" });
    await expect(
      dialog.getByText("2 propostas — 0 alta, 1 média, 1 baixa"),
    ).toBeVisible();
    await expect(dialog.getByText("via Vagalume")).toHaveCount(0);
    await expect(dialog.getByText("via nome do arquivo")).toBeVisible();
    expect(errors).toEqual([]);
  });

  // ~3% de cobertura no acervo real: este é o desfecho MAIS COMUM.
  test("nada encontrado não lê como fracasso nem como 'sua pasta está completa'", async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await resetApp(page);
    await addMockFolder(page);

    // deixa a instrumental completa e a sem_tags sem nada a propor
    await page.getByText("Instrumental Sem Letra").first().click();
    const panel = page.getByLabel("Painel de letra");
    await panel.getByRole("button", { name: "Editar" }).click();
    await panel.getByLabel("Letra", { exact: true }).fill("Letra já conferida");
    await panel.getByRole("button", { name: "Salvar no arquivo" }).click();
    await expect(page.getByText("Alterações salvas em sem_letra.mp3.")).toBeVisible();

    await page.getByText("sem_tags", { exact: true }).first().click();
    await panel.getByRole("button", { name: "Editar" }).click();
    await panel.getByLabel("Título").fill("sem tags");
    await panel.getByRole("button", { name: "Salvar no arquivo" }).click();
    await expect(page.getByText("Alterações salvas em sem_tags.mp3.")).toBeVisible();

    await dispararCuradoria(page);
    const dialog = page.getByRole("dialog", { name: "Completar dados" });
    // .last(): a mesma frase também vai para a região viva (sr-only) que
    // anuncia o fim da busca — o parágrafo visível é o segundo
    const aviso = dialog
      .getByText(/Conferimos a única música incompleta desta pasta/)
      .last();
    await expect(aviso).toBeVisible();
    // o passe de redução da V9 cortou a terceira frase (a que mandava a pessoa
    // para uma ferramenta de terminal que ela não tem), e manteve a que
    // responde à pergunta do momento: "então está pronto?" (DECISIONS #60)
    await expect(aviso).toContainText("não significa pasta completa");
    expect(errors).toEqual([]);
  });

  // QA MÉDIO-11 — sem nenhuma pasta adicionada, a tela afirmava "nenhuma
  // música desta pasta está sem título, artista ou letra": descrevia ZERO
  // músicas como completas. Sem música não há completude a declarar — há uma
  // pasta a somar, e é isso que o texto tem de dizer.
  test("biblioteca vazia: o disparo fica bloqueado dizendo o que fazer, sem fingir completude", async ({
    page,
  }) => {
    await resetApp(page);
    await page.getByRole("button", { name: "Configurações" }).click();
    const secao = page.getByRole("region", { name: "Curadoria do acervo" });
    await expect(secao.getByText(/Não há nenhuma música nesta pasta/)).toBeVisible();
    await expect(secao.getByText(/Adicione uma pasta/)).toBeVisible();
    // MÉDIO-14: o motivo do bloqueio é texto na tela, não `title=`
    await expect(
      secao.getByText("Não há música nesta pasta para procurar."),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Buscar dados desta pasta" }),
    ).toBeDisabled();
  });

  // QA CRÍTICO-1 — o caminho inteiro do defeito mais grave: a varredura acha
  // letra para uma música que JÁ TEM letra (uma transcrição corrigida à mão),
  // a linha chega pré-marcada por ser ALTA, e um clique em "Aplicar
  // selecionadas" destruía o trabalho. Agora a linha avisa, a substituição é
  // uma segunda marcação, e sem ela só título e artista são aplicados.
  test("proposta que substituiria uma letra: avisa, pede consentimento e preserva a letra", async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await resetApp(page);
    await addMockFolder(page);

    // a curadoria transcreveu a letra desta música, e alguém a corrigiu; a
    // etiqueta de título é lixo de ripador, então ela volta a ser candidata
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__CANCIONEIRO_MOCK__._markAsTranscribed(
        "/musicas/mock/com_letra.mp3",
      );
    });
    const panel = page.getByLabel("Painel de letra");
    await page.getByText("Coração Sertanejo").first().click();
    await panel.getByRole("button", { name: "Editar" }).click();
    await panel.getByLabel("Letra", { exact: true }).fill("Letra conferida à mão");
    // sem etiqueta de artista ela volta a ser candidata da varredura — é
    // assim que uma música COM letra reaparece na revisão
    await panel.getByLabel("Artista").fill("");
    await panel.getByRole("button", { name: "Salvar no arquivo" }).click();
    await expect(page.getByText("Alterações salvas em com_letra.mp3.")).toBeVisible();
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__CANCIONEIRO_MOCK__._markAsTranscribed(
        "/musicas/mock/com_letra.mp3",
      );
    });
    await page.reload();

    await dispararCuradoria(page);
    const dialog = page.getByRole("dialog", { name: "Completar dados" });

    // a linha DIZ que existe letra ali, e de que tipo ela é
    await expect(
      dialog.getByText(/Já tem letra, escrita ouvindo o áudio/),
    ).toBeVisible();
    // a substituição é uma segunda marcação, desmarcada por padrão
    const substituir = dialog.getByRole("checkbox", {
      name: /Substituir a letra atual/,
    });
    await expect(substituir).not.toBeChecked();
    // "Marcar todas" nunca marca a substituição
    await dialog
      .getByRole("button", { name: "Marcar todas", exact: true })
      .click();
    await expect(substituir).not.toBeChecked();

    await dialog.getByRole("button", { name: /Aplicar selecionadas/ }).click();
    await expect(page.getByText(/A biblioteca já está atualizada/)).toBeVisible();

    // a letra escrita à mão continua no arquivo
    await page.getByRole("button", { name: "Biblioteca", exact: true }).click();
    await page.getByText("Coração Sertanejo").first().click();
    await expect(
      page.getByLabel("Painel de letra").getByTestId("lyrics-body"),
    ).toHaveText("Letra conferida à mão");
    expect(errors).toEqual([]);
  });
});


test.describe("V9 — o acessório do som, a conferência e o conflito (F18 fase 2)", () => {
  // O caminho inteiro da fase 2, pela porta que a pessoa usa: baixar o
  // acessório em Configurações, ligar o modo de conferência que ele
  // habilita, e resolver a divergência que só ele acha. É o caso real que
  // criou o modo — etiqueta certa na aparência, música errada no arquivo.
  test("baixar o acessório liga a conferência, que acha a etiqueta errada", async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await resetApp(page);
    await addMockFolder(page);

    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mock = (window as any).__CANCIONEIRO_MOCK__;
      // o download precisa durar o bastante para a barra existir na tela
      mock._acessorio.atrasoMs = 150;
      // o que o som responde sobre este arquivo: outra música, outro artista
      mock._ensinarSom("/musicas/mock/com_letra.mp3", {
        titulo: "Viver Feliz",
        artista: "Nilson Chaves",
        confianca: "alta",
      });
    });

    await page.getByRole("button", { name: "Configurações" }).click();
    const secao = page.getByRole("region", { name: "Curadoria do acervo" });
    const bloco = page.getByRole("region", { name: "Reconhecer música pelo som" });

    // a tela diz o que vai baixar, quanto ocupa e de onde vem — ANTES
    await expect(bloco.getByText(/é preciso baixar um arquivo de 5,3 MB/)).toBeVisible();
    await expect(bloco.getByText(/acessorios-v1/)).toBeVisible();
    // e a conferência ainda não é possível, com o motivo escrito na tela
    const conferir = page.getByRole("radio", { name: /Conferir se a etiqueta/ });
    await expect(conferir).toBeDisabled();
    await expect(
      secao.getByText("Precisa do reconhecimento pelo som — baixe o acessório abaixo."),
    ).toBeVisible();

    // nada baixou sozinho: só depois do clique
    await bloco.getByRole("button", { name: /^Baixar \(/ }).click();
    await expect(bloco.getByText(/^Baixando…/)).toBeVisible();
    await expect(
      bloco.getByText("Pronto — a busca já reconhece música pelo som."),
    ).toBeVisible();
    // baixou uma vez, não pergunta de novo
    await expect(bloco.getByRole("button", { name: /Baixar/ })).toHaveCount(0);

    // com o acessório, a etapa 2 entra no funil e a conferência é possível
    await expect(secao.getByText(/Reconhecer pelo som/)).toBeVisible();
    await conferir.click();
    await page.getByRole("button", { name: "Conferir esta pasta" }).click();

    const dialog = page.getByRole("dialog", { name: "Completar dados" });
    await expect(dialog.getByText("CONFLITO")).toBeVisible();
    await expect(dialog.getByText(/Sua etiqueta diz/)).toBeVisible();
    await expect(
      dialog.getByText("Coração Sertanejo — Artista Teste"),
    ).toBeVisible();
    await expect(dialog.getByText("Viver Feliz — Nilson Chaves")).toBeVisible();
    await expect(dialog.getByText("confiança alta")).toBeVisible();

    // aceitar o som é escolha POR LINHA: nem pré-marcada, nem em massa
    const aceitar = dialog.getByRole("checkbox", {
      name: /Aceitar o que o som diz/,
    });
    await expect(aceitar).not.toBeChecked();
    await dialog.getByRole("button", { name: "Marcar todas", exact: true }).click();
    await expect(aceitar).not.toBeChecked();
    await dialog.getByRole("button", { name: "Desmarcar todas" }).click();

    await aceitar.check();
    await dialog.getByRole("button", { name: "Aplicar selecionadas (1)" }).click();
    await expect(
      page.getByText(
        "1 música teve título ou artista corrigido. A biblioteca já está atualizada.",
      ),
    ).toBeVisible();

    // e a música passou a se chamar o que o som disse
    await page.getByRole("button", { name: "Biblioteca", exact: true }).click();
    await expect(page.getByText("Viver Feliz").first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  // Cancelar e falhar terminam os dois com o acessório ausente: a tela tem de
  // dizer QUAL dos dois aconteceu, sem adivinhação.
  test("o download é cancelável, e o cancelamento é dito como cancelamento", async ({
    page,
  }) => {
    await resetApp(page);
    await page.getByRole("button", { name: "Configurações" }).click();
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__CANCIONEIRO_MOCK__._acessorio.atrasoMs = 400;
    });
    const bloco = page.getByRole("region", { name: "Reconhecer música pelo som" });
    await bloco.getByRole("button", { name: /^Baixar \(/ }).click();
    await bloco.getByRole("button", { name: "Parar" }).click();

    await expect(bloco.getByText("Download cancelado. Nada foi instalado.")).toBeVisible();
    // continua oferecendo, sem tratar o cancelamento como falha
    await expect(bloco.getByRole("button", { name: /^Baixar \(/ })).toBeVisible();
  });

  // A soma SHA-256 é a verificação que impede um download comprometido de
  // virar execução de código. Quando ela falha, a frase do backend é a
  // explicação inteira — e ela aparece como veio.
  test("soma que não confere: a frase do backend, e nada instalado", async ({
    page,
  }) => {
    await resetApp(page);
    await page.getByRole("button", { name: "Configurações" }).click();
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__CANCIONEIRO_MOCK__._acessorio.erro = "soma";
    });
    const bloco = page.getByRole("region", { name: "Reconhecer música pelo som" });
    await bloco.getByRole("button", { name: /^Baixar \(/ }).click();

    await expect(
      bloco.getByText(/não confere com o esperado — foi descartado/),
    ).toBeVisible();
    await expect(bloco.getByRole("button", { name: /^Baixar \(/ })).toBeVisible();
    await expect(
      page.getByRole("radio", { name: /Conferir se a etiqueta/ }),
    ).toBeDisabled();
  });

  /**
   * QA A2 — a conferência que parou no meio.
   *
   * Uma falha do `fpcalc` desligava a etapa 2 pelo resto da varredura: a
   * pessoa via UMA linha vermelha, as outras sem nada, e concluía que o resto
   * tinha sido conferido. É o trabalho CARO, disparado de propósito, que ela
   * esperou minutos para ver terminar — e a tela não pode dá-lo por concluído.
   *
   * O E2E cobre o caminho inteiro porque o contrato mudou de forma
   * (`enrich_folder_scan` devolve um objeto, não a lista): se o store voltar a
   * tratar a resposta como array, a revisão nem abre.
   */
  test("conferência que para no meio: a tela diz quantas ficaram sem resposta", async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await resetApp(page);
    await addMockFolder(page);

    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mock = (window as any).__CANCIONEIRO_MOCK__;
      mock._acessorio.estado = "pronto";
      // o binário não SOBE nesta máquina: veredito, não defeito do arquivo
      mock._ensinarFalhaDoSom(
        "/musicas/mock/com_letra.mp3",
        "o programa que reconhece o som não conseguiu ser executado neste computador",
      );
    });

    await page.getByRole("button", { name: "Configurações" }).click();
    await page.getByRole("radio", { name: /Conferir se a etiqueta/ }).click();
    await page.getByRole("button", { name: "Conferir esta pasta" }).click();

    const dialog = page.getByRole("dialog", { name: "Completar dados" });
    // o motivo, com as palavras do backend, na linha da música que falhou
    await expect(
      dialog.getByText(/não conseguiu ser executado neste computador/),
    ).toBeVisible();
    // e o número — que é a razão de o campo novo existir. Duas das três
    // candidatas nunca chegaram a ser perguntadas.
    //
    // O aviso aparece DUAS vezes de propósito: na região viva (sr-only, para
    // quem ouve a tela) e como texto visível. O locator exclui a região viva
    // para provar que o texto está na tela, e não só no anúncio.
    const avisoVisivel = dialog
      .locator("p:not([role='status'])")
      .filter({ hasText: /2 músicas não chegaram a ser perguntadas/ });
    await expect(avisoVisivel).toBeVisible();
    await expect(avisoVisivel).toContainText(/continuam sem conferência/);
    // e quem ouve a tela recebe o mesmo desfecho, não um resumo otimista
    await expect(dialog.locator("p[role='status']")).toContainText(
      /2 músicas não chegaram a ser perguntadas/,
    );
    expect(errors).toEqual([]);
  });

  // O caminho normal não ganha aviso nenhum: zero é o caso comum, e um
  // "0 músicas ficaram sem resposta" em cada desfecho ensina a ignorar o
  // aviso justamente quando ele importar.
  test("conferência que roda inteira não menciona música nenhuma sem resposta", async ({
    page,
  }) => {
    await resetApp(page);
    await addMockFolder(page);
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mock = (window as any).__CANCIONEIRO_MOCK__;
      mock._acessorio.estado = "pronto";
      mock._ensinarSom("/musicas/mock/com_letra.mp3", {
        titulo: "Viver Feliz",
        artista: "Nilson Chaves",
        confianca: "alta",
      });
    });

    await page.getByRole("button", { name: "Configurações" }).click();
    await page.getByRole("radio", { name: /Conferir se a etiqueta/ }).click();
    await page.getByRole("button", { name: "Conferir esta pasta" }).click();

    const dialog = page.getByRole("dialog", { name: "Completar dados" });
    await expect(dialog.getByText("CONFLITO")).toBeVisible();
    await expect(dialog.getByText(/chegaram a ser perguntadas/)).toHaveCount(0);
    await expect(dialog.getByText(/chegou a ser perguntada/)).toHaveCount(0);
  });
});

test.describe("V8 — Marca de instrumental (F17)", () => {
  test("selo 'Instrumental' substitui 'Sem letra' e o editor marca à mão", async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await resetApp(page);
    await addMockFolder(page);

    // a curadoria marcou uma música sem voz (TXXX:INSTRUMENTAL)
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__CANCIONEIRO_MOCK__._markAsInstrumental(
        "/musicas/mock/sem_letra.mp3",
      );
    });
    await page.reload();

    const lista = page.getByRole("listbox");
    // das duas sem letra, a marcada troca a cobrança pela informação
    await expect(lista.getByText("Instrumental", { exact: true })).toHaveCount(1);
    await expect(lista.getByText("Sem letra", { exact: true })).toHaveCount(1);

    // painel: informação, não pedido de curadoria
    const panel = page.getByLabel("Painel de letra");
    await page.getByText("Instrumental Sem Letra").first().click();
    await expect(panel.getByText("Música instrumental — sem letra.")).toBeVisible();

    // e a marca manual, no editor, muda o selo da lista na hora
    await page.getByText("sem_tags").first().click();
    await panel.getByRole("button", { name: "Editar" }).click();
    await panel
      .getByRole("checkbox", { name: "Esta música é instrumental" })
      .check();
    await panel.getByRole("button", { name: "Salvar no arquivo" }).click();
    await expect(page.getByText("Alterações salvas em sem_tags.mp3.")).toBeVisible();

    await expect(lista.getByText("Instrumental", { exact: true })).toHaveCount(2);
    await expect(lista.getByText("Sem letra", { exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  // "Todas as etapas de letra pulam o arquivo — [...] e a varredura em lote
  // do app" (PRD V8/F17). Este é o caminho onde errar custa mais caro: uma
  // peça sem voz com título e artista certos casa com a versão CANTADA no
  // LRCLIB, sai com confiança ALTA — e ALTA chega PRÉ-MARCADA na tela de
  // revisão (DECISIONS #49). Um clique em "Aplicar" e a letra de outra
  // gravação entra no arquivo de quem não pediu nada.
  test("a varredura em lote não propõe letra para música instrumental", async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await resetApp(page);
    await addMockFolder(page);

    // sem a marca, esta música é a candidata MÉDIA "com letra encontrada"
    // (é assim que o teste da F13 a usa) — o contraste é o ponto do teste
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__CANCIONEIRO_MOCK__._markAsInstrumental(
        "/musicas/mock/sem_letra.mp3",
      );
    });
    await page.reload();

    await dispararCuradoria(page);

    const dialog = page.getByRole("dialog", { name: "Completar dados" });
    // sobra só a sem_tags: a instrumental não é candidata nem no total
    await expect(
      dialog.getByText("1 proposta — 0 alta, 0 média, 1 baixa"),
    ).toBeVisible();
    await expect(dialog.getByText("Instrumental Sem Letra")).toHaveCount(0);
    await expect(
      dialog.getByRole("checkbox", {
        name: "Aplicar proposta: Instrumental Sem Letra",
      }),
    ).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});

test.describe("V8 — instrumental sem etiqueta (QA ALTO-5)", () => {
  // O único caso em que as três implementações discordavam: uma pasta de
  // instrumentais marcados pela CLI, sem etiqueta de artista. O Rust os
  // entrega ("instrumental sem letra ainda pode — e deve — ter título e
  // artista corretos", PRD V8/F17); o app os excluía da contagem, dava zero e
  // desabilitava o botão dizendo que a pasta estava completa.
  test("instrumental sem artista entra na varredura — e não recebe proposta de letra", async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await resetApp(page);
    await addMockFolder(page);
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__CANCIONEIRO_MOCK__._markAsInstrumental(
        "/musicas/mock/sem_tags.mp3",
      );
    });
    await page.reload();

    // a contagem (que vem do backend) conta as duas, e o disparo continua vivo
    await page.getByRole("button", { name: "Configurações" }).click();
    await expect(
      page.getByText(/2 músicas incompletas nesta pasta/),
    ).toBeVisible();
    const disparo = page.getByRole("button", { name: "Buscar dados desta pasta" });
    await expect(disparo).toBeEnabled();
    await disparo.click();

    const dialog = page.getByRole("dialog", { name: "Completar dados" });
    await expect(
      dialog.getByText("2 propostas — 0 alta, 1 média, 1 baixa"),
    ).toBeVisible();
    // ela está na lista: o que ela pode ganhar é NOME
    await expect(
      dialog.getByRole("checkbox", { name: "Aplicar proposta: sem_tags" }),
    ).toBeVisible();
    // e nenhuma etapa de letra rodou para ela: só a outra traz letra
    await expect(dialog.getByText("letra encontrada")).toHaveCount(1);
    expect(errors).toEqual([]);
  });
});

test.describe("Escala: 2.000 músicas", () => {
  test("lista virtualizada rola e busca responde rápido", async ({ page }) => {
    await resetApp(page);
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__CANCIONEIRO_MOCK__._seedSongs(2000);
    });
    await page.reload();

    const list = page.getByRole("listbox", { name: "Músicas" });
    await expect(list).toBeVisible();
    // a segunda linha com o nome do arquivo (V6) também vale em escala
    await expect(page.getByTestId("song-filename").first()).toHaveText(
      /^musica_\d+\.mp3$/,
    );
    // rola até o fim sem travar (virtualização: DOM pequeno)
    await list.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    const renderedRows = await page.getByRole("option").count();
    expect(renderedRows).toBeLessThan(120);

    const search = page.getByPlaceholder("Buscar por letra, título ou artista…");
    const t0 = Date.now();
    await search.fill("Música 1999");
    await expect(page.getByText("1 resultados")).toBeVisible();
    // limite folgado para E2E (inclui debounce 150ms + render)
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
