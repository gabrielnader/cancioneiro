/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";

const host = process.env.TAURI_DEV_HOST;

/**
 * Serve os MP3s de fixtures/ em /fixtures/* no dev server e no preview —
 * usado pelo backend mockado (modo web / E2E Playwright) para tocar áudio.
 */
function serveFixtures(): Plugin {
  const fixturesDir = path.resolve(__dirname, "fixtures");
  const handler = (
    middlewares: import("vite").Connect.Server,
  ) => {
    middlewares.use("/fixtures", (req, res, next) => {
      const name = path.basename((req.url ?? "").split("?")[0]);
      const file = path.join(fixturesDir, name);
      if (!name.endsWith(".mp3") || !existsSync(file)) {
        next();
        return;
      }
      res.setHeader("Content-Type", "audio/mpeg");
      createReadStream(file).pipe(res);
    });
  };
  return {
    name: "cancioneiro-serve-fixtures",
    configureServer(server) {
      handler(server.middlewares);
    },
    configurePreviewServer(server) {
      handler(server.middlewares);
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss(), serveFixtures()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8" as const,
      include: ["src/stores/**", "src/hooks/**", "src/lib/**"],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 85,
        statements: 85,
      },
    },
  },
}));
