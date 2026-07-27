# PRD V3 — Enriquecimento automático do acervo (curadoria sem planilha)

## Summary

O coordenador aponta a pasta do acervo e a curadoria identifica cada música
sozinha — combinando tags existentes, o **nome do arquivo** e a **duração do
áudio** com a busca do LRCLIB — e propõe título, artista e letra. Os **temas
vêm da estrutura de pastas** (o acervo já é organizado por tema em subpastas).
O humano só **valida**: interativamente no terminal, por CSV, ou aceita
automaticamente o que tiver confiança ALTA. O player continua intocado
(offline, somente leitura); todo o enriquecimento é da CLI de curadoria.

## F9 — `curadoria.py enriquecer PASTA`

### Identificação (por arquivo MP3)

1. **Palpites** de (título, artista), na ordem:
   - tags existentes (TIT2/TPE1), quando presentes;
   - nome do arquivo, limpo (remove extensão, número de faixa inicial tipo
     `08 `/`08 - `/`(08)`, conteúdo entre colchetes/parênteses tipo
     `(ao vivo)`, `[official]`, underscores→espaço, espaços colapsados) e
     dividido em ` - `: tenta `Artista - Título` E `Título - Artista`;
   - nome do arquivo inteiro como título (sem artista) como último palpite.
2. **Busca** no LRCLIB (`GET https://lrclib.net/api/search?q={palpite}`,
   User-Agent `Cancioneiro/0.3`, timeout 10s) — cada resultado tem
   `trackName`, `artistName`, `duration` (segundos) e `plainLyrics`.
3. **Score** de cada resultado contra o palpite:
   - similaridade textual (difflib, strings normalizadas: minúsculas, sem
     acento, sem pontuação) de título e artista;
   - **duração**: diferença entre a duração do MP3 (mutagen `.info.length`)
     e a do resultado. `≤3s` reforça muito; `≤8s` reforça; `>15s` desclassifica.
4. **Confiança**:
   - **ALTA**: duração ≤3s de diferença E similaridade ≥ 0.6; ou
     similaridade ≥ 0.85 com duração ≤ 8s.
   - **MÉDIA**: melhor resultado com similaridade ≥ 0.5 e duração ≤ 15s.
   - **BAIXA**: resto (inclusive sem resultado) — nada é proposto além do
     palpite de nome de arquivo.
5. Arquivos que **já têm** título+artista+letra são pulados (a menos que
   `--forcar`).

### Temas das pastas

- Cada subpasta no caminho relativo do MP3 (abaixo da PASTA raiz) vira um
  tema, normalizado pelas regras da V2 (minúsculas, sem duplicatas).
  Ex.: `PASTA/cura/aniversário/X.mp3` → temas `cura` e `aniversário`.
- MP3 direto na raiz não ganha tema de pasta.
- Temas de pasta **somam** aos existentes no arquivo (nunca substituem).
- Ativado por padrão no `enriquecer`; desativável com `--sem-temas-de-pastas`.
  Também disponível isolado: `curadoria.py temas-de-pastas PASTA [--aplicar]`
  (sem `--aplicar`, só mostra o que faria).

### Validação e aplicação (modos)

- **Padrão (proposta em CSV)**: `enriquecer PASTA --csv proposta.csv` gera um
  CSV com: `arquivo, titulo_atual, artista_atual, titulo_proposto,
  artista_proposto, confianca (ALTA/MÉDIA/BAIXA), duracao_mp3,
  duracao_encontrada, letra (SIM/NÃO), temas_propostos, lrclib_id, aceitar` —
  `aceitar` pré-preenchido com `SIM` para ALTA, vazio para o resto. O usuário
  revisa e roda `curadoria.py aplicar-proposta PASTA --csv proposta.csv`, que
  aplica só as linhas `aceitar=SIM` (título/artista/temas; letra re-buscada
  por `GET /api/get/{lrclib_id}` na hora de aplicar).
- **Interativo**: `enriquecer PASTA --interativo` mostra por arquivo a
  proposta (com confiança e durações) e pergunta
  `[Enter] aceitar  [p] pular  [t] só temas  [q] sair` — aplica na hora.
- **Automático**: `enriquecer PASTA --auto` aplica na hora somente as ALTA
  (título/artista/letra/temas); demais viram relatório no stdout (e no CSV,
  se `--csv` for passado junto).

### Regras e erros

- Rede: erros por arquivo (`ERRO DE REDE: {arquivo}`) nunca abortam o lote;
  pausa de 0,3s entre buscas (cortesia com a API).
- Resumo final EXATO:
  `Resumo: {alta} confiança alta | {media} média | {baixa} baixa | {aplicados} aplicados | {erros} erros de rede`
- Nunca sobrescreve letra existente não-vazia (a menos que `--forcar`).
- `--dry-run` disponível em `aplicar-proposta` (bytes intactos).
- Fetch injetável (`fetcher=`) — testes 100% offline com stubs.

### Acceptance Checks

- ✓ MP3 sem tags com nome `Falamansa - Oh! Chuva.mp3` e duração compatível →
  proposta ALTA com título "Oh! Chuva", artista "Falamansa" e letra.
- ✓ Nome `08 Na dança das Folhas.mp3` → número de faixa removido do palpite.
- ✓ Resultado com duração divergente >15s é desclassificado mesmo com texto
  parecido (homônimos/versões erradas).
- ✓ `PASTA/cura/x.mp3` ganha tema `cura`; raiz não ganha tema; temas somam
  aos existentes.
- ✓ `--auto` aplica só ALTA; MÉDIA/BAIXA intactas.
- ✓ CSV de proposta → `aplicar-proposta` aplica só `aceitar=SIM`.
- ✓ Letra existente nunca é sobrescrita sem `--forcar`.
- ✓ Falha de rede num arquivo não aborta os demais; resumo exato.
- ✓ Nenhum teste faz requisição real de rede.

## Out of scope (V3)

- Transcrição de áudio (Whisper) para músicas não identificáveis — V3.1 se o
  teste real mostrar necessidade.
- Fingerprinting acústico (AcoustID/Chromaprint) — exigiria binário externo
  (fpcalc) e chave de API; a duração + busca textual cobre o caso típico.
- Qualquer mudança no player.
