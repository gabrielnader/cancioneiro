import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SearchBar } from "./SearchBar";
import { setBackendForTests, type Backend } from "../lib/api";
import { useLibraryStore } from "../stores/libraryStore";

describe("SearchBar — botão limpar busca (V5 Q1)", () => {
  beforeEach(() => {
    setBackendForTests({
      search: vi.fn(async () => []),
    } as unknown as Backend);
    useLibraryStore.setState({ query: "", results: [] });
  });

  it("sem texto não mostra o botão de limpar", () => {
    render(<SearchBar />);
    expect(
      screen.queryByRole("button", { name: "Limpar busca" }),
    ).not.toBeInTheDocument();
  });

  it("com texto mostra o × com aria-label exato", () => {
    useLibraryStore.setState({ query: "coração" });
    render(<SearchBar />);
    expect(
      screen.getByRole("button", { name: "Limpar busca" }),
    ).toBeInTheDocument();
  });

  it("clicar no × limpa a query e devolve o foco ao campo", () => {
    useLibraryStore.setState({ query: "coração" });
    render(<SearchBar />);
    const input = screen.getByLabelText("Buscar por letra, título ou artista");

    fireEvent.click(screen.getByRole("button", { name: "Limpar busca" }));

    expect(useLibraryStore.getState().query).toBe("");
    expect(input).toHaveFocus();
    // botão some quando o campo esvazia
    expect(
      screen.queryByRole("button", { name: "Limpar busca" }),
    ).not.toBeInTheDocument();
  });

  it("Esc continua limpando a query (comportamento existente)", () => {
    useLibraryStore.setState({ query: "abc" });
    render(<SearchBar />);
    const input = screen.getByLabelText("Buscar por letra, título ou artista");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(useLibraryStore.getState().query).toBe("");
  });
});
