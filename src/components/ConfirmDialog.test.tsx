import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  AA_TEXTO_NORMAL,
  TEXT_COLOR_RE,
  contrastRatio,
  corDoFundo,
  corDoTexto,
} from "../test/contrast";

/**
 * Achado de campo (V11) — este diálogo (usado por SettingsView e PlaylistView
 * em ações destrutivas) não tinha teste próprio nenhum. Ele já usa `bg-surface`
 * (não é o achado desta rodada — era o EnrichReview), mas segue sem contraste
 * conferido nos dois temas.
 */
describe("ConfirmDialog (F1/F5)", () => {
  it("fechado (open=false) não renderiza nada", () => {
    render(
      <ConfirmDialog
        open={false}
        title="Remover playlist?"
        confirmLabel="Remover"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("mostra o título como rótulo do diálogo e o botão de confirmação com o rótulo pedido", () => {
    render(
      <ConfirmDialog
        open
        title="Remover playlist?"
        confirmLabel="Remover"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByRole("dialog", { name: "Remover playlist?" })).toBeInTheDocument();
    expect(screen.getByText("Remover")).toBeInTheDocument();
  });

  it("Cancelar e Confirmar chamam os callbacks certos", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Remover playlist?"
        confirmLabel="Remover"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByText("Cancelar"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Remover"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  describe("contraste texto/fundo, nos dois temas (achado de campo)", () => {
    function conferirContraste(tema: "claro" | "escuro") {
      render(
        <ConfirmDialog
          open
          title="Remover playlist?"
          confirmLabel="Remover"
          onConfirm={() => {}}
          onCancel={() => {}}
        />,
      );
      const dialog = screen.getByRole("dialog", { name: "Remover playlist?" });
      const fundoDoDialog = corDoFundo("bg-surface", tema)!;
      const comCor = [...dialog.querySelectorAll<HTMLElement>("*")].filter((el) =>
        TEXT_COLOR_RE.test(el.className),
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
  });
});
