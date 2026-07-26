import { expect, test, type Page } from "@playwright/test";

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

test.describe("Persistência entre sessões (reload)", () => {
  test("volume, painel de letra e nível de fonte persistem", async ({ page }) => {
    await resetApp(page);
    await addMockFolder(page);

    // volume
    await page.getByLabel("Volume").fill("0.4");
    // painel de letra: oculta
    await page.getByRole("button", { name: "Ocultar letra" }).click();
    await expect(page.getByLabel("Painel de letra")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Mostrar letra" }),
    ).toBeVisible();

    await page.reload();
    await expect(page.getByLabel("Volume")).toHaveValue("0.4");
    await expect(page.getByLabel("Painel de letra")).toHaveCount(0);

    // reexibe e cicla fonte 16 → 20
    await page.getByRole("button", { name: "Mostrar letra" }).click();
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
    await page.getByRole("button", { name: "Biblioteca" }).click();
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
