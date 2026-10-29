import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useUiStore } from "../stores/uiStore";
import { TopBar } from "./TopBar";

describe("TopBar (V15) — o topo da tela", () => {
  beforeEach(() => {
    useUiStore.setState({ view: "library", zoomLevel: 0, lyricsPanelVisible: true, gavetaAberta: false });
    document.documentElement.style.zoom = "";
  });

  it("os três tamanhos de letra são botões com nome, e só um está ligado", () => {
    render(<TopBar />);
    const grupo = screen.getByRole("group", { name: "Tamanho da letra" });
    const normal = screen.getByRole("button", { name: "Letra normal" });
    const grande = screen.getByRole("button", { name: "Letra grande" });
    const muitoGrande = screen.getByRole("button", { name: "Letra muito grande" });
    for (const b of [normal, grande, muitoGrande]) expect(grupo.contains(b)).toBe(true);
    expect(normal).toHaveAttribute("aria-pressed", "true");
    expect(grande).toHaveAttribute("aria-pressed", "false");
  });

  it("escolher um tamanho guarda a escolha e aumenta a tela inteira", async () => {
    render(<TopBar />);
    fireEvent.click(screen.getByRole("button", { name: "Letra muito grande" }));
    expect(useUiStore.getState().zoomLevel).toBe(2);
    expect(screen.getByRole("button", { name: "Letra muito grande" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // fora do Tauri o zoom é o de CSS (no app é o da própria janela)
    await Promise.resolve();
    expect(document.documentElement.style.zoom).toBe("1.3");
    fireEvent.click(screen.getByRole("button", { name: "Letra normal" }));
    await Promise.resolve();
    expect(document.documentElement.style.zoom).toBe("");
  });

  it("'Organizar minhas músicas' leva à curadoria — a porta que saiu da lateral", () => {
    render(<TopBar />);
    fireEvent.click(screen.getByRole("button", { name: /Organizar/ }));
    expect(useUiStore.getState().view).toBe("settings");
  });

  it("organizando, o topo oferece a volta com o nome escrito, e some o que é de ouvir", () => {
    useUiStore.setState({ view: "settings" });
    render(<TopBar />);
    expect(screen.queryByRole("button", { name: /Organizar/ })).toBeNull();
    expect(screen.queryByTestId("toggle-detalhes")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Voltar/ }));
    expect(useUiStore.getState().view).toBe("library");
  });

  it("o botão de detalhes diz o que vai fazer, e alterna o painel", () => {
    render(<TopBar />);
    const botao = screen.getByTestId("toggle-detalhes");
    expect(botao).toHaveTextContent("Ocultar detalhes");
    fireEvent.click(botao);
    expect(useUiStore.getState().lyricsPanelVisible).toBe(false);
    expect(botao).toHaveTextContent("Mostrar detalhes");
  });

  it("'Listas e pastas' abre a gaveta da lateral (tela estreita)", () => {
    render(<TopBar />);
    fireEvent.click(screen.getByRole("button", { name: "Listas e pastas" }));
    expect(useUiStore.getState().gavetaAberta).toBe(true);
  });
});
