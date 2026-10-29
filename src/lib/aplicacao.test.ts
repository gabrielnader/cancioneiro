import { describe, expect, it } from "vitest";
import type { EnrichProposal } from "./api";
import { linhasQueSoPreenchem, montarAplicacoes } from "./aplicacao";
import { FONTE_TRANSCRICAO, type Song } from "./types";

function proposta(over: Partial<EnrichProposal> = {}): EnrichProposal {
  return {
    song_id: 1,
    file_path: "/acervo/a.mp3",
    current_title: "a",
    current_artist: null,
    proposed_title: "Asa Branca",
    proposed_artist: "Luiz Gonzaga",
    lyrics: null,
    has_lyrics: false,
    letra_origem: null,
    confidence: "baixa",
    fonte: "nome do arquivo",
    conflito: null,
    substitui_nome_escrito: false,
    marcar_instrumental: false,
    refrao: null,
    aviso: null,
    error: null,
    ...over,
  };
}

function cancao(over: Partial<Song> = {}): Song {
  return {
    id: 1,
    title: "Asa Branca",
    artist: "Luiz Gonzaga",
    file_path: "/acervo/a.mp3",
    has_lyrics: false,
    available: true,
    ...over,
  } as Song;
}

const NADA = { erros: {}, aplicadas: new Set<number>(), gravadas: {} };

function soPreenchem(ps: EnrichProposal[], o: Partial<typeof NADA> = {}) {
  const c = { ...NADA, ...o };
  return linhasQueSoPreenchem(ps, c.erros, c.aplicadas, c.gravadas);
}

// O conjunto gravado SEM perguntar (V15). É o lugar do produto em que um erro
// escreve num MP3 sem ninguém ter olhado — cada caso aqui é uma porta fechada.
describe("linhasQueSoPreenchem — o que é gravado sem perguntar", () => {
  it("o palpite de nome sobre nome que não foi escrito por gente: entra", () => {
    expect(soPreenchem([proposta()])).toEqual([0]);
  });

  it("letra em ALTA para música SEM letra: entra", () => {
    expect(
      soPreenchem([proposta({ lyrics: "la la", confidence: "alta", fonte: "LRCLIB" })]),
    ).toEqual([0]);
  });

  it("letra em ALTA para música que JÁ TEM letra: nunca (CRÍTICO-1)", () => {
    expect(
      soPreenchem([
        proposta({ lyrics: "la la", confidence: "alta", has_lyrics: true, letra_origem: "manual" }),
      ]),
    ).toEqual([]);
  });

  it("letra que uma gravação DESTA revisão já pôs: a segunda letra não entra sozinha", () => {
    // a música não tinha letra na varredura, mas a etapa 5 (ou outra linha) já
    // gravou uma: agora ela TEM, e trocar seria apagar
    expect(
      soPreenchem(
        [proposta({ lyrics: "outra", confidence: "alta" })],
        { gravadas: { 1: cancao({ has_lyrics: true, letra_origem: "transcricao" }) } },
      ),
    ).toEqual([]);
  });

  it("letra escrita pelo computador ouvindo o áudio: espera a pessoa, mesmo em ALTA", () => {
    expect(
      soPreenchem([proposta({ lyrics: "la la", confidence: "alta", fonte: FONTE_TRANSCRICAO })]),
    ).toEqual([]);
  });

  it("letra em MÉDIA ou BAIXA: espera a pessoa", () => {
    expect(
      soPreenchem([
        proposta({ lyrics: "la", confidence: "media", fonte: "lyrics.ovh" }),
        proposta({ song_id: 2, lyrics: "la", confidence: "baixa" }),
      ]),
    ).toEqual([]);
  });

  it("conflito, nome escrito por gente e marca de instrumental: nunca", () => {
    expect(
      soPreenchem([
        proposta({ conflito: { titulo: "X", artista: "Y", confianca: "alta" } }),
        proposta({ song_id: 2, substitui_nome_escrito: true, confidence: "alta" }),
        proposta({ song_id: 3, marcar_instrumental: true, confidence: "alta" }),
      ]),
    ).toEqual([]);
  });

  it("linha com erro, recusada antes ou já gravada: nunca", () => {
    expect(
      soPreenchem(
        [
          proposta({ error: "sem conexão" }),
          proposta({ song_id: 2 }),
          proposta({ song_id: 3 }),
        ],
        { erros: { 2: "a música mudou depois da busca" }, aplicadas: new Set([2]) },
      ),
    ).toEqual([]);
  });
});

describe("montarAplicacoes — uma gravação por música, com as regras de sempre", () => {
  const ninguemConsentiu = { gravadas: {}, applyErrors: {}, consentiu: () => false };

  it("aceitar um conflito grava o que o SOM disse, e nunca letra", () => {
    const [a] = montarAplicacoes(
      [
        proposta({
          current_title: "Faixa 3",
          proposed_title: "Faixa 3",
          conflito: { titulo: "Trem das Onze", artista: "Adoniran Barbosa", confianca: "alta" },
          lyrics: "la",
        }),
      ],
      [0],
      ninguemConsentiu,
    );
    expect(a.title).toBe("Trem das Onze");
    expect(a.artist).toBe("Adoniran Barbosa");
    expect(a.lyrics).toBeNull();
  });

  it("trocar letra existente SEM consentimento: a letra que existe fica intacta", () => {
    const [a] = montarAplicacoes(
      [proposta({ lyrics: "nova", has_lyrics: true })],
      [0],
      ninguemConsentiu,
    );
    expect(a.lyrics).toBeNull();
    expect(a.substituir_letra).toBeUndefined();
  });

  it("com consentimento daquela música: a letra vai, marcada como substituição", () => {
    const [a] = montarAplicacoes([proposta({ lyrics: "nova", has_lyrics: true })], [0], {
      ...ninguemConsentiu,
      consentiu: (id) => id === 1,
    });
    expect(a.lyrics).toBe("nova");
    expect(a.substituir_letra).toBe(true);
  });

  it("duas linhas da mesma música viram UMA gravação: nome da primeira, letra da que a trouxe", () => {
    const aplicacoes = montarAplicacoes(
      [
        proposta({ proposed_title: "Asa Branca", fonte: "nome do arquivo" }),
        proposta({
          proposed_title: "a",
          proposed_artist: null,
          lyrics: "quando olhei a terra ardendo",
          fonte: "transcricao",
        }),
      ],
      [0, 1],
      ninguemConsentiu,
    );
    expect(aplicacoes).toHaveLength(1);
    expect(aplicacoes[0].title).toBe("Asa Branca");
    expect(aplicacoes[0].lyrics).toBe("quando olhei a terra ardendo");
    // a procedência é a da linha da LETRA: é ela que vira TXXX:LETRA_ORIGEM
    expect(aplicacoes[0].fonte).toBe("transcricao");
  });

  it("o eco é o do ARQUIVO agora, depois de uma gravação desta revisão (V10.6)", () => {
    const [a] = montarAplicacoes([proposta({ current_title: "a" })], [0], {
      ...ninguemConsentiu,
      gravadas: { 1: cancao({ title: "Já Gravado", artist: "Alguém" }) },
    });
    expect(a.current_title).toBe("Já Gravado");
    expect(a.current_artist).toBe("Alguém");
  });

  it("a marca de instrumental só viaja como true — nunca false (#71)", () => {
    const [com, sem] = montarAplicacoes(
      [proposta({ marcar_instrumental: true }), proposta({ song_id: 2 })],
      [0, 1],
      ninguemConsentiu,
    );
    expect(com.marcar_instrumental).toBe(true);
    expect("marcar_instrumental" in sem).toBe(false);
  });
});
