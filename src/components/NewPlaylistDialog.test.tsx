import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NewPlaylistDialog } from "./NewPlaylistDialog";
import { setBackendForTests, type Backend } from "../lib/api";
import {
  AA_TEXTO_NORMAL,
  TEXT_COLOR_RE,
  contrastRatio,
  corDoFundo,
  corDoTexto,
} from "../test/contrast";

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

  /*
    Achado de campo (V11) — nenhum teste deste diálogo conferia contraste. O
    diálogo já usa `bg-surface` (não é o achado desta rodada), mas os dois
    temas continuam sem guarda: repete a varredura genérica de EnrichReview
    (todo elemento com classe de cor, contra o fundo dela ou o do card).
  */
  describe("contraste texto/fundo, nos dois temas (achado de campo)", () => {
    function conferirContraste(tema: "claro" | "escuro") {
      render(<NewPlaylistDialog open onClose={() => {}} />);
      const dialog = screen.getByRole("dialog", { name: "Nova playlist" });
      const fundoDoDialog = corDoFundo("bg-surface", tema)!;
      const comCor = [...dialog.querySelectorAll<HTMLElement>("*")].filter(
        (el) =>
          TEXT_COLOR_RE.test(el.className) &&
          // WCAG 1.4.3 isenta componente INATIVO de contraste ("Criar" some
          // desabilitado até um nome ser digitado — não é texto a ler, é um
          // botão que ainda não vale).
          !(el instanceof HTMLButtonElement && el.disabled),
      );
      expect(comCor.length).toBeGreaterThan(0);
      for (const el of comCor) {
        const fundo = corDoFundo(el.className, tema) ?? fundoDoDialog;
        expect(
          contrastRatio(corDoTexto(el.className, tema), fundo),
          `"${el.textContent?.slice(0, 40)}" (${tema})`,
        ).toBeGreaterThanOrEqual(AA_TEXTO_NORMAL);
      }
    }

    it("passa em AA no tema claro", () => conferirContraste("claro"));
    it("passa em AA no tema escuro", () => conferirContraste("escuro"));

    it("com erro de nome vazio também passa em AA nos dois temas", () => {
      for (const tema of ["claro", "escuro"] as const) {
        const { unmount } = render(<NewPlaylistDialog open onClose={() => {}} />);
        const input = screen.getByPlaceholderText("Nome da playlist");
        fireEvent.change(input, { target: { value: "x" } });
        fireEvent.change(input, { target: { value: "" } });
        const erro = screen.getByText("Dê um nome à playlist.");
        expect(
          contrastRatio(corDoTexto(erro.className, tema), corDoFundo("bg-surface", tema)!),
          tema,
        ).toBeGreaterThanOrEqual(AA_TEXTO_NORMAL);
        unmount();
      }
    });
  });
});
