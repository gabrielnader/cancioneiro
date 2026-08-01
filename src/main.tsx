import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { isTauri } from "./lib/api";
import { applyTheme } from "./lib/theme";
import { installMockBackend } from "./lib/mockBackend";
import { useUiStore } from "./stores/uiStore";
import "./index.css";

// Fora do Tauri (dev no navegador / E2E Playwright), o IPC é mockado em
// memória com a mesma interface dos comandos Rust.
if (!isTauri()) {
  installMockBackend();
}

// V11 — aplica o tema ANTES do primeiro render, e não num useEffect do App:
// um efeito só roda depois do primeiro paint, e o app abriria sempre claro
// por um instante antes de escurecer. `useUiStore.getState()` já reflete o
// que está no localStorage neste ponto — a hidratação do `persist` é síncrona
// (storage padrão é o `localStorage`, sem `await` nenhum no meio).
applyTheme(useUiStore.getState().theme);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
