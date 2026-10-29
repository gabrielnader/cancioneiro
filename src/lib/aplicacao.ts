/**
 * Como uma decisão da revisão vira gravação no arquivo (V15).
 *
 * Isto morava dentro da tela de revisão, no `handleApply`. Saiu porque a V15
 * passou a ter DOIS caminhos de gravação — o automático (o que só preenche,
 * logo que a busca termina) e o clique em "Usar o novo" — e dois caminhos com
 * cópias diferentes da mesma regra é como a DECISIONS #80 acontece. Agora os
 * dois chamam as mesmas funções, e as regras que custaram rodadas inteiras de
 * QA continuam valendo para os dois:
 *
 * - **uma gravação por música**, mesmo com duas linhas dela decididas juntas
 *   (o `apply` confere o eco contra o disco, e a segunda seria recusada — QA A5);
 * - **o eco é o do ARQUIVO agora**, e não o do instante da varredura (V10.6);
 * - **trocar uma letra que existe exige consentimento próprio** (CRÍTICO-1);
 * - **a marca de instrumental só viaja como `true`**, nunca `false` (#71).
 */
import type { EnrichApply, EnrichProposal } from "./api";
import { ehLetraDeMaquina, grupoDaProposta, LABEL_SUBSTITUIR_LETRA } from "./curadoria";
import type { Song } from "./types";

/** O que o ARQUIVO tem agora para a música de uma proposta. */
export interface EstadoAtual {
  current_title: string;
  current_artist: string | null;
  has_lyrics: boolean;
  letra_origem: string | null;
}

/**
 * O estado atual: o que uma gravação desta revisão devolveu, ou — se a música
 * ainda não foi gravada — o eco que a proposta trouxe da varredura.
 */
export function estadoAtualDa(
  p: EnrichProposal,
  gravadas: Readonly<Record<number, Song>>,
): EstadoAtual {
  const g = gravadas[p.song_id];
  if (g === undefined) {
    return {
      current_title: p.current_title,
      current_artist: p.current_artist,
      has_lyrics: p.has_lyrics,
      letra_origem: p.letra_origem,
    };
  }
  return {
    current_title: g.title,
    current_artist: g.artist,
    has_lyrics: g.has_lyrics,
    letra_origem: g.letra_origem ?? null,
  };
}

/**
 * A recusa do backend quando falta consentimento cita, textualmente, o rótulo
 * da marcação. É por esse texto que se reconhece o caso: o banco pode estar
 * atrasado em relação ao arquivo (alguém escreveu a letra à mão DURANTE a
 * varredura), e aí quem sabe da verdade é o backend, não a proposta.
 */
export function erroPedeConsentimento(erro: string | null): boolean {
  if (erro === null) return false;
  return erro.toLowerCase().includes(LABEL_SUBSTITUIR_LETRA.toLowerCase());
}

/** Esta linha gravaria letra NOVA por cima de uma letra que já existe? */
export function substituiriaLetra(
  p: Pick<EnrichProposal, "lyrics">,
  atual: { has_lyrics: boolean },
  erro: string | null,
): boolean {
  if (p.lyrics === null) return false;
  return atual.has_lyrics || erroPedeConsentimento(erro);
}

/**
 * As linhas que podem ser gravadas SEM perguntar: as que só preenchem o que
 * está vazio (V15 — "Aplicar sozinho o que só preenche").
 *
 * É exatamente o conjunto que a revisão em lista já trazia pré-marcado por
 * "não ter nada a perder" (V10): o grupo dos preenchimentos e a letra achada
 * em ALTA. Com uma condição a mais, que lá era resolvida por outra caixa: a
 * letra só entra se a música NÃO tiver letra — trocar letra existente nunca é
 * automático (CRÍTICO-1).
 *
 * Nunca entram: conflito (duas fontes discordando), nome escrito por gente
 * (V9), marca de instrumental (#71), linha com erro ou já gravada — e a letra
 * escrita pelo computador ouvindo o áudio, que tem palavras erradas e por isso
 * é mostrada antes, com o aviso de letra de máquina (V5/F14).
 */
export function linhasQueSoPreenchem(
  proposals: readonly EnrichProposal[],
  applyErrors: Readonly<Record<number, string>>,
  aplicadas: ReadonlySet<number>,
  gravadas: Readonly<Record<number, Song>>,
): number[] {
  return proposals.flatMap((p, i) => {
    if (p.error !== null || applyErrors[p.song_id] !== undefined) return [];
    if (aplicadas.has(i)) return [];
    const grupo = grupoDaProposta(p, null);
    if (grupo === "preenchimentos") return [i];
    if (grupo === "letras" && p.confidence === "alta" && !ehLetraDeMaquina(p.fonte)) {
      const atual = estadoAtualDa(p, gravadas);
      return substituiriaLetra(p, atual, null) ? [] : [i];
    }
    return [];
  });
}

/**
 * Monta UMA gravação por música para as linhas escolhidas.
 *
 * `consentiu(songId)` responde se a pessoa autorizou trocar a letra existente
 * DAQUELA música. Sem consentimento, a linha grava o resto (nome) e manda
 * `lyrics: null` — a letra que existe fica intacta.
 *
 * A ordem das linhas é a ordem de RISCO, então a primeira que propõe nome é a
 * que manda no nome; a letra vem de quem a traz, com a procedência DELA (é o
 * `fonte` que decide o `TXXX:LETRA_ORIGEM`).
 */
export function montarAplicacoes(
  proposals: readonly EnrichProposal[],
  linhas: readonly number[],
  contexto: {
    gravadas: Readonly<Record<number, Song>>;
    applyErrors: Readonly<Record<number, string>>;
    consentiu: (songId: number) => boolean;
  },
): EnrichApply[] {
  const porMusica = new Map<number, EnrichApply>();
  for (const i of linhas) {
    const p = proposals[i];
    if (!p) continue;
    const atual = estadoAtualDa(p, contexto.gravadas);
    const trocaLetra = substituiriaLetra(p, atual, contexto.applyErrors[p.song_id] ?? null);
    const consentida = contexto.consentiu(p.song_id);
    const letra = trocaLetra && !consentida ? null : (p.lyrics ?? null);
    // V9 — aceitar um conflito é aceitar o que o SOM disse: `proposed_*`
    // repete a etiqueta atual nessas linhas (elas não propõem nada), então
    // gravar dali seria gravar o que já está lá.
    const daLinha: EnrichApply = {
      song_id: p.song_id,
      title: p.conflito ? p.conflito.titulo : p.proposed_title,
      artist: p.conflito ? p.conflito.artista : (p.proposed_artist ?? null),
      lyrics: p.conflito ? null : letra,
      add_temas: null,
      // V10.6 — o eco é o do ARQUIVO agora: uma gravação desta mesma revisão
      // pode ter mudado o nome
      current_title: atual.current_title,
      current_artist: atual.current_artist,
      fonte: p.fonte || null,
      ...(trocaLetra && consentida ? { substituir_letra: true } : {}),
      // a marca só viaja como `true`: desmarcar é exclusividade do editor (#71)
      ...(p.marcar_instrumental ? { marcar_instrumental: true } : {}),
    };
    const anterior = porMusica.get(p.song_id);
    if (!anterior) {
      porMusica.set(p.song_id, daLinha);
      continue;
    }
    const nomeNovo =
      anterior.title !== anterior.current_title ||
      (anterior.artist ?? null) !== (anterior.current_artist ?? null);
    porMusica.set(p.song_id, {
      ...anterior,
      title: nomeNovo ? anterior.title : daLinha.title,
      artist: nomeNovo ? anterior.artist : daLinha.artist,
      lyrics: anterior.lyrics ?? daLinha.lyrics,
      fonte: anterior.lyrics !== null ? anterior.fonte : daLinha.fonte,
      ...(anterior.substituir_letra || daLinha.substituir_letra
        ? { substituir_letra: true }
        : {}),
      ...(anterior.marcar_instrumental || daLinha.marcar_instrumental
        ? { marcar_instrumental: true }
        : {}),
    });
  }
  return [...porMusica.values()];
}

/** O que uma gravação mudou, para o aviso "o que aconteceu" (PRD V8). */
export interface ContagemDeMudancas {
  ganharamLetra: number;
  letraSubstituida: number;
  marcadasInstrumental: number;
  nomeCorrigido: number;
}

/**
 * Conta pelo que FOI ENVIADO, e não pela proposta: a linha sem consentimento
 * não mandou letra, e dizer que ela "ganhou letra" contaria uma mudança que não
 * houve. Os grupos são disjuntos, senão as contas somariam mais que o total.
 */
export function contarMudancas(
  enviadas: readonly EnrichApply[],
  gravouSongId: (songId: number) => boolean,
  tinhaLetraAntes: (songId: number) => boolean,
): ContagemDeMudancas {
  const c = { ganharamLetra: 0, letraSubstituida: 0, marcadasInstrumental: 0, nomeCorrigido: 0 };
  for (const a of enviadas) {
    if (!gravouSongId(a.song_id)) continue;
    if (a.lyrics !== null) {
      if (tinhaLetraAntes(a.song_id)) c.letraSubstituida++;
      else c.ganharamLetra++;
    } else if (a.marcar_instrumental === true) {
      c.marcadasInstrumental++;
    } else if (
      a.title !== a.current_title ||
      (a.artist ?? null) !== (a.current_artist ?? null)
    ) {
      c.nomeCorrigido++;
    }
  }
  return c;
}
