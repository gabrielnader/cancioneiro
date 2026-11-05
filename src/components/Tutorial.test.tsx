import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { PASSOS, Tutorial, deveAbrirSozinho } from "./Tutorial";
import { useLibraryStore } from "../stores/libraryStore";
import { useUiStore } from "../stores/uiStore";
import { useGuiaStore } from "../lib/guias";

describe("Primeiro uso guiado (V16.6/V16.7)", () => {
  beforeEach(() => {
    useUiStore.setState({ tutorialAberto: true, tutorialVisto: false });
    useLibraryStore.setState({ folders: [] });
  });

  it("abre sozinho só no primeiro uso de verdade", () => {
    expect(deveAbrirSozinho(false, true, 0)).toBe(true);
    expect(deveAbrirSozinho(true, true, 0)).toBe(false); // já visto ou pulado
    expect(deveAbrirSozinho(false, true, 2)).toBe(false); // quem já usa o app
    expect(deveAbrirSozinho(false, false, 0)).toBe(false); // biblioteca ainda carregando
  });

  it("anda pelos três passos e termina chamando o guia na tela", () => {
    render(<Tutorial />);
    expect(screen.getByRole("dialog", { name: "Bem-vindo ao Cancioneiro" })).toBeInTheDocument();
    expect(screen.getByText("Passo 1 de 3")).toBeInTheDocument();
    for (let i = 1; i < PASSOS.length; i++) {
      fireEvent.click(screen.getByRole("button", { name: "Próximo" }));
      expect(screen.getByRole("heading", { name: PASSOS[i] })).toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: "Pular o tutorial" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Me mostre na tela" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(useUiStore.getState().tutorialVisto).toBe(true);
    expect(useGuiaStore.getState().ativo).toBe("primeiros-passos");
    useGuiaStore.getState().parar();
  });

  it("“Agora não” fecha sem chamar o guia", () => {
    render(<Tutorial />);
    fireEvent.click(screen.getByRole("button", { name: "Próximo" }));
    fireEvent.click(screen.getByRole("button", { name: "Próximo" }));
    fireEvent.click(screen.getByRole("button", { name: "Agora não" }));
    expect(useUiStore.getState().tutorialVisto).toBe(true);
    expect(useGuiaStore.getState().ativo).toBeNull();
  });

  it("Voltar volta um passo", () => {
    render(<Tutorial />);
    fireEvent.click(screen.getByRole("button", { name: "Próximo" }));
    fireEvent.click(screen.getByRole("button", { name: "Voltar" }));
    expect(screen.getByText("Passo 1 de 3")).toBeInTheDocument();
  });

  it("o passo da pasta oferece escolher a pasta, ou confirma a que já existe", () => {
    render(<Tutorial />);
    fireEvent.click(screen.getByRole("button", { name: "Próximo" }));
    expect(screen.getByRole("button", { name: "Adicionar pasta" })).toBeInTheDocument();
    expect(screen.getByText(/não apaga nada/)).toBeInTheDocument();
  });

  it("com pasta já adicionada, o passo só confirma", () => {
    useLibraryStore.setState({ folders: [{ id: 1, path: "/m", missing: false } as never] });
    render(<Tutorial />);
    fireEvent.click(screen.getByRole("button", { name: "Próximo" }));
    expect(screen.getByText(/Sua pasta já está no app/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Adicionar pasta" })).not.toBeInTheDocument();
  });

  it("Pular e Esc fecham e não voltam a abrir sozinhos", () => {
    const { unmount } = render(<Tutorial />);
    fireEvent.click(screen.getByRole("button", { name: "Pular o tutorial" }));
    expect(useUiStore.getState().tutorialVisto).toBe(true);
    unmount();
    useUiStore.setState({ tutorialAberto: true, tutorialVisto: false });
    render(<Tutorial />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useUiStore.getState().tutorialAberto).toBe(false);
    expect(useUiStore.getState().tutorialVisto).toBe(true);
  });

  it("reaberto (por Configurações), começa do primeiro passo", () => {
    const { rerender } = render(<Tutorial />);
    fireEvent.click(screen.getByRole("button", { name: "Próximo" }));
    fireEvent.click(screen.getByRole("button", { name: "Próximo" }));
    useUiStore.getState().fecharTutorial();
    rerender(<Tutorial />);
    useUiStore.getState().abrirTutorial();
    rerender(<Tutorial />);
    expect(screen.getByText("Passo 1 de 3")).toBeInTheDocument();
  });
});
