import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConsertarArquivo, textoDoConserto } from "./ConsertarArquivo";
import { setBackendForTests, type Backend } from "../lib/api";
import type { SituacaoDoArquivo, Song } from "../lib/types";

const SONG: Song = {
  id: 7,
  file_path: "/m/Cores - Manto azul.mp3",
  folder_id: 1,
  title: "Song 11",
  artist: "Unknown",
  album: null,
  duration_seconds: 200,
  has_lyrics: false,
  available: true,
  temas: null,
};

function backend(inicial: SituacaoDoArquivo, extra: Partial<Backend> = {}) {
  let atual = inicial;
  const b = {
    situacaoDoArquivo: vi.fn(async () => atual),
    consertarArquivo: vi.fn(async () => {
      atual = { conteudo: "mp3", recodifica: false, original_guardado: true };
      return { ...SONG, title: "Manto Azul" };
    }),
    voltarAoSomOriginal: vi.fn(async () => {
      atual = inicial;
      return SONG;
    }),
    ...extra,
  };
  setBackendForTests(b as unknown as Backend);
  return b;
}

describe("ConsertarArquivo (V16.4)", () => {
  it("MP3 de verdade sem original guardado: não mostra nada", async () => {
    const b = backend({ conteudo: "mp3", recodifica: false, original_guardado: false });
    const { container } = render(<ConsertarArquivo song={SONG} />);
    await waitFor(() => expect(b.situacaoDoArquivo).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("backend sem a função: não quebra o painel", async () => {
    setBackendForTests({} as unknown as Backend);
    const { container } = render(<ConsertarArquivo song={SONG} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });

  it("WAV com nome de MP3: explica, pede confirmação e só então conserta", async () => {
    const b = backend({ conteudo: "mp3_em_wav", recodifica: false, original_guardado: false });
    render(<ConsertarArquivo song={SONG} />);
    expect(await screen.findByText("Este arquivo não aceita gravação")).toBeInTheDocument();
    expect(screen.getByText(/por dentro é um WAV/)).toBeInTheDocument();
    expect(screen.getByText(/sem mudar nada nele/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Consertar o arquivo" }));
    expect(b.consertarArquivo).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Sim, consertar" }));
    await waitFor(() => expect(b.consertarArquivo).toHaveBeenCalledWith(7));
    expect(await screen.findByRole("button", { name: "Voltar ao som original" })).toBeInTheDocument();
  });

  it("M4A: avisa que o som muda um pouco", async () => {
    backend({ conteudo: "mp4", recodifica: true, original_guardado: false });
    render(<ConsertarArquivo song={SONG} />);
    expect(await screen.findByText(/por dentro é um M4A/)).toBeInTheDocument();
    expect(screen.getByText(/A diferença é muito pequena/)).toBeInTheDocument();
  });

  it("Voltar ao som original avisa o que se perde e pede confirmação", async () => {
    const b = backend({ conteudo: "mp3", recodifica: false, original_guardado: true });
    render(<ConsertarArquivo song={SONG} />);
    fireEvent.click(await screen.findByRole("button", { name: "Voltar ao som original" }));
    expect(screen.getByText(/se perde/)).toBeInTheDocument();
    expect(b.voltarAoSomOriginal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Sim, voltar" }));
    await waitFor(() => expect(b.voltarAoSomOriginal).toHaveBeenCalledWith(7));
  });

  it("falha do conserto aparece com a frase do app", async () => {
    backend(
      { conteudo: "wav", recodifica: true, original_guardado: false },
      {
        consertarArquivo: vi.fn(async () => {
          throw new Error("esta música está tocando. Pare a música e tente de novo");
        }),
      },
    );
    render(<ConsertarArquivo song={SONG} />);
    fireEvent.click(await screen.findByRole("button", { name: "Consertar o arquivo" }));
    fireEvent.click(screen.getByRole("button", { name: "Sim, consertar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("está tocando");
  });

  it("o texto do conserto diz a verdade sobre o som", () => {
    expect(textoDoConserto({ conteudo: "mp3_em_wav", recodifica: false, original_guardado: false })).toMatch(
      /sem mudar nada/,
    );
    expect(textoDoConserto({ conteudo: "wav", recodifica: true, original_guardado: false })).toMatch(
      /transforma o som/,
    );
  });
});

import { textoDosArquivosParaConsertar } from "./SettingsView";

describe("cartão dos arquivos para consertar (V16.4)", () => {
  it("singular e plural", () => {
    expect(textoDosArquivosParaConsertar(1)).toMatch(/^1 música tem nome de MP3/);
    expect(textoDosArquivosParaConsertar(3)).toMatch(/^3 músicas têm nome de MP3/);
  });
});
