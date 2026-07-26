import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NewPlaylistDialog } from "./NewPlaylistDialog";
import { setBackendForTests, type Backend } from "../lib/api";

describe("NewPlaylistDialog (F5)", () => {
  beforeEach(() => {
    setBackendForTests({
      createPlaylist: vi.fn(async () => 1),
      listPlaylists: vi.fn(async () => []),
      getPlaylistItems: vi.fn(async () => []),
    } as unknown as Backend);
  });

  it("mostra título, placeholder e botões com as copies do PRD", () => {
    render(<NewPlaylistDialog open onClose={() => {}} />);
    expect(screen.getByText("Nova playlist")).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("Nome da playlist"),
    ).toBeInTheDocument();
    expect(screen.getByText("Cancelar")).toBeInTheDocument();
    expect(screen.getByText("Criar")).toBeInTheDocument();
  });

  it("nome vazio: botão Criar desabilitado e mensagem exata ao tocar no campo", () => {
    render(<NewPlaylistDialog open onClose={() => {}} />);
    const createButton = screen.getByText("Criar");
    expect(createButton).toBeDisabled();

    const input = screen.getByPlaceholderText("Nome da playlist");
    fireEvent.change(input, { target: { value: "x" } });
    fireEvent.change(input, { target: { value: "" } });
    expect(screen.getByText("Dê um nome à playlist.")).toBeInTheDocument();
    expect(createButton).toBeDisabled();
  });

  it("com nome preenchido cria e fecha", async () => {
    const onClose = vi.fn();
    render(<NewPlaylistDialog open onClose={onClose} />);
    fireEvent.change(screen.getByPlaceholderText("Nome da playlist"), {
      target: { value: "Reunião de domingo" },
    });
    fireEvent.click(screen.getByText("Criar"));
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
