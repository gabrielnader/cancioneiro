import { chromium, defineConfig, devices } from "@playwright/test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * E2E dos fluxos críticos (seção 8 do PRD), com o frontend em modo web e a
 * camada de IPC mockada (src/lib/mockBackend.ts) — o tauri-driver não cobre
 * macOS. O que é real aqui: toda a UI React, os stores, o elemento <audio>
 * do Chromium tocando os MP3s de fixtures/ e a persistência via localStorage.
 * O que é mockado: os comandos Tauri (indexação/FTS5 reais são cobertos por
 * `cargo test`). O E2E do binário nativo é o smoke test manual do README.
 */

// ---------------------------------------------------------------------------
// O Chromium: resolvido AQUI, nunca à mão
// ---------------------------------------------------------------------------
//
// O `@playwright/test` pinado espera um build específico do Chromium (hoje o
// 1234) e o container tem outro (o 1194). Sem `PLAYWRIGHT_CHROMIUM_PATH`
// exportado à mão, 38 dos 39 testes falhavam com "Executable doesn't exist" —
// e a última linha da saída era "1 passed". **Um número verde que não é
// verde**: exatamente o tipo de armadilha que faz uma equipe reportar uma
// suíte quebrada como aprovada (a lição da DECISIONS #92, agora no arnês).
//
// A regra vale para o arnês tanto quanto para o produto: ou a ferramenta se
// vira sozinha, ou ela falha dizendo o que fazer. Nunca meio-verde.

/** Onde procurar um Chromium quando o build pinado não estiver baixado. */
function candidatosDeChromium(): string[] {
  const candidatos: string[] = [];
  if (process.env.CHROME_PATH) candidatos.push(process.env.CHROME_PATH);
  // qualquer chromium-NNNN já baixado sob o cache do Playwright (o container
  // de CI traz um build diferente do pinado, com o mesmo layout de diretório)
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  try {
    for (const dir of readdirSync(cache)) {
      if (!dir.startsWith("chromium-")) continue;
      for (const sub of ["chrome-linux/chrome", "chrome-linux64/chrome"]) {
        candidatos.push(join(cache, dir, sub));
      }
    }
  } catch {
    // cache inexistente: segue para os caminhos do sistema
  }
  candidatos.push(
    join(cache, "chromium"),
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  );
  return candidatos;
}

/**
 * `undefined` = o Chromium pinado está no lugar, deixa o Playwright decidir.
 * Uma string = o substituto encontrado nesta máquina. E, quando não há nenhum,
 * um erro que diz as duas saídas possíveis — em vez de 38 falhas de "executável
 * não existe" que quem não conhece o projeto lê como defeito de produto.
 */
function resolverChromium(): string | undefined {
  const escolhido = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  if (escolhido) {
    if (existsSync(escolhido)) return escolhido;
    throw new Error(
      `PLAYWRIGHT_CHROMIUM_PATH aponta para "${escolhido}", que não existe.` +
        " Corrija a variável ou apague-a para o Playwright procurar sozinho.",
    );
  }
  // executablePath() devolve o caminho ESPERADO do build pinado, exista ele
  // ou não — por isso a conferência com existsSync, e não um try/catch
  let pinado = "";
  try {
    pinado = chromium.executablePath();
  } catch {
    // instalação sem registry: cai direto nos candidatos
  }
  if (pinado && existsSync(pinado)) return undefined;
  const achado = candidatosDeChromium().find((c) => existsSync(c));
  if (achado) {
    // dito em voz alta: a suíte está rodando em OUTRO Chromium, e uma falha
    // de renderização precisa poder ser atribuída a isso
    console.warn(
      `[e2e] Chromium pinado ausente (${pinado || "desconhecido"}).` +
        ` Usando ${achado}.`,
    );
    return achado;
  }
  throw new Error(
    "Nenhum Chromium utilizável foi encontrado.\n" +
      `O @playwright/test espera ${pinado || "um build que não está baixado"}.\n` +
      "Saídas:\n" +
      "  1. npx playwright install chromium\n" +
      "  2. PLAYWRIGHT_CHROMIUM_PATH=/caminho/para/chrome npm run test:e2e",
  );
}
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:1420",
    trace: "retain-on-failure",
    launchOptions: {
      // as fixtures tocam sem gesto de usuário
      args: ["--autoplay-policy=no-user-gesture-required"],
      // CI/container: usa o Chromium pré-instalado quando a versão pinada
      // pelo @playwright/test não estiver baixada (sem rede em runtime)
      executablePath: resolverChromium(),
    },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 760 } },
    },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:1420",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
