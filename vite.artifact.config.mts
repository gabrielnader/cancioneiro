// Config temporária: bundle de arquivo único para a demo em Artifact
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "./",
  build: {
    outDir: "dist-artifact",
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
