import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { isTauri } from "./lib/api";
import { installMockBackend } from "./lib/mockBackend";
import "./index.css";

// Fora do Tauri (dev no navegador / E2E Playwright), o IPC é mockado em
// memória com a mesma interface dos comandos Rust.
if (!isTauri()) {
  installMockBackend();
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
