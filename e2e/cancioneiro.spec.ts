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
    // exact: o botão "Completar dados da biblioteca" (F13) também contém o texto
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

  test("buscar letra na internet: não achou, achou (preenche a textarea) e sem conexão", async ({
    page,
  }) => {
    await resetApp(page);
    await addMockFolder(page);

    await page.getByText("Instrumental Sem Letra").first().click();
    const panel = page.getByLabel("Painel de letra");
    await panel.getByRole("button", { name: "Editar" }).click();

    // título original não casa com o mock → aviso exato de não encontrada
    await panel.getByRole("button", { name: "Buscar letra na internet" }).click();
    await expect(
      page.getByText("Letra não encontrada para este título e artista."),
    ).toBeVisible();

    // usa o título DIGITADO (não salvo): "Coração Sertanejo" casa com o mock
    await panel.getByLabel("Título").fill("Coração Sertanejo");
    await panel.getByRole("button", { name: "Buscar letra na internet" }).click();
    await expect(panel.getByLabel("Letra", { exact: true })).toHaveValue(
      /Quando o sol amanhecer/,
    );

    // sem conexão: o mock rejeita e o app avisa com a copy exata
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__CANCIONEIRO_MOCK__._offline = true;
    });
    await panel.getByRole("button", { name: "Buscar letra na internet" }).click();
    await expect(
      page.getByText("Sem conexão — a busca de letra precisa de internet."),
    ).toBeVisible();
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

    // raiz da árvore = biblioteca inteira (prefixo "")
    await page
      .getByRole("button", { name: "Completar dados da biblioteca" })
      .click();

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

    await expect(page.getByText("1 música atualizada.")).toBeVisible();
    await expect(dialog).toHaveCount(0);
    // a música ganhou letra: só a sem_tags continua com o badge
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

    await page
      .getByRole("button", { name: "Completar dados da biblioteca" })
      .click();

    const dialog = page.getByRole("dialog", { name: "Completar dados" });
    // barra determinada com "n de total" (2 músicas incompletas)
    await expect(dialog.getByText("Buscando dados… 0 de 2")).toBeVisible();
    await expect(dialog.getByRole("progressbar")).toHaveAttribute(
      "aria-valuemax",
      "2",
    );
    // com uma varredura rodando, disparar outra fica bloqueado
    await expect(
      page.getByRole("button", { name: "Completar dados da biblioteca" }),
    ).toBeDisabled();

    // some da frente sem cancelar: o app continua usável
    await dialog
      .getByRole("button", { name: "Deixar rodando em segundo plano" })
      .click();
    await expect(dialog).toHaveCount(0);
    const indicador = page.getByRole("button", { name: /Buscando dados/ });
    await expect(indicador).toBeVisible();

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

    const abrir = page.getByRole("button", {
      name: "Completar dados da biblioteca",
    });
    await abrir.click();
    const dialog = page.getByRole("dialog", { name: "Completar dados" });
    await expect(dialog.getByText("Buscando dados… 0 de 2")).toBeVisible();

    await dialog.getByRole("button", { name: "Cancelar" }).click();
    await expect(dialog).toHaveCount(0);
    // nem overlay nem indicador de segundo plano: a varredura acabou
    await expect(page.getByRole("button", { name: /Buscando dados/ })).toHaveCount(0);
    // o invoke ainda está respondendo: começar outra agora sobreporia as duas
    await expect(abrir).toBeDisabled();
    await expect(abrir).toHaveAttribute(
      "title",
      "Terminando de encerrar a busca anterior — aguarde alguns segundos",
    );

    // quando o invoke enfim responde, o ✎ volta e a nova varredura começa do zero
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
