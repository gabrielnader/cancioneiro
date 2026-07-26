import { defineConfig, devices } from "@playwright/test";

/**
 * E2E dos fluxos críticos (seção 8 do PRD), com o frontend em modo web e a
 * camada de IPC mockada (src/lib/mockBackend.ts) — o tauri-driver não cobre
 * macOS. O que é real aqui: toda a UI React, os stores, o elemento <audio>
 * do Chromium tocando os MP3s de fixtures/ e a persistência via localStorage.
 * O que é mockado: os comandos Tauri (indexação/FTS5 reais são cobertos por
 * `cargo test`). O E2E do binário nativo é o smoke test manual do README.
 */
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
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? undefined,
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
