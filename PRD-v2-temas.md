# PRD V2.1 — Temas (tags temáticas embutidas no MP3)

## Summary

O coordenador marca cada música com **temas** livres ("água", "cura", "esperança",
"ceia"…) que descrevem situações de uso. Os temas vivem **dentro do MP3**, num frame
ID3 `TXXX` com descrição `TEMAS` — mesmo princípio da letra (USLT): o arquivo carrega
seus dados consigo ao ser copiado. O player continua **somente leitura**: quem grava
temas é a ferramenta de curadoria CLI (`tools/embed_lyrics.py`). A busca do app passa
a encontrar músicas também pelos temas, com o mesmo campo de busca (sem sintaxe nova).

Princípios herdados da V1 (invioláveis): player nunca escreve em arquivos de áudio;
100% offline; sem backend; UI pt-BR; banco reconstruível por reindexação.

## Formato de armazenamento

- Frame: `TXXX` (User defined text), `desc="TEMAS"`, encoding UTF-8, ID3v2.4.
- Valor: temas separados por `; ` (ponto-e-vírgula + espaço). Ex.: `água; cura`.
- Normalização na gravação: trim, colapso de espaços internos, minúsculas,
  deduplicação (comparação sem acento/caixa), ordem alfabética.
- Regravar substitui o frame inteiro (nunca duplica).

## F7 — Curadoria de temas (CLI)

User flow:
1. `python3 tools/embed_lyrics.py musica.mp3 --temas "água, cura"` — define a lista
   inteira (separador vírgula OU ponto-e-vírgula no input).
2. `--add-tema "esperança"` (repetível) — acrescenta sem apagar os existentes.
3. `--remove-tema "cura"` (repetível) — remove um tema existente.
4. `--temas ""` — remove o frame TEMAS por completo.
5. `--check` passa a imprimir a linha `Temas: água; cura` (ou `Temas: (nenhum)`).
6. Pode ser usado junto com letra/título/artista OU sozinho (só temas, sem exigir
   letra).

Erros:
- `--add-tema`/`--remove-tema` junto com `--temas` → `ERRO: use --temas OU --add-tema/--remove-tema, não ambos` (exit 1).
- `--remove-tema` de tema inexistente → aviso `AVISO: tema não encontrado: {tema}`
  (não é erro; exit 0; demais operações aplicam).
- Arquivo inválido/inexistente → mesma mensagem da V1, exit 1.

Saída de sucesso (quando só temas mudam): `OK: temas gravados em {arquivo} ({n} temas)`.
Quando letra e temas são gravados juntos, imprime as duas linhas OK (letra primeiro).

Acceptance Checks:
- ✓ `--temas "Água, cura, Água"` grava frame TXXX:TEMAS com valor `água; cura`
  (normalizado, dedup, ordenado).
- ✓ Rodar `--temas` duas vezes substitui (1 único frame TXXX:TEMAS).
- ✓ `--add-tema` preserva os existentes; `--remove-tema` remove só o pedido.
- ✓ `--temas ""` remove o frame.
- ✓ `--check` exibe os temas gravados.
- ✓ Gravar temas NÃO altera USLT/TIT2/TPE1 existentes.

## F8 — Indexação e busca por tema (app)

- Indexer lê `TXXX:TEMAS`; `Song.temas` (string `água; cura`) e coluna FTS `temas`
  (tokenizer herdado `unicode61 remove_diacritics 2` → "agua" encontra "água").
- Migração: `PRAGMA user_version = 2`; banco v1 é migrado (nova coluna + FTS
  recriada) e um rescan completo repovoa — sem perda de playlists.
- Busca: o MESMO campo busca em título, artista, letra E temas (sem sintaxe nova).
  Match apenas em tema não gera snippet de letra.
- UI:
  - Chips de tema na linha da música (depois do título; text #0F766E,
    background #F0FDFA, 12px, raio cheio). Máximo visual: os que couberem —
    truncar com "+n" quando não couber é dispensável no V2.1 (lista compacta).
  - Painel de letra: linha de chips sob o cabeçalho (mesmo estilo).
  - Tocar num chip preenche o campo de busca com o tema (novo termo, substituindo
    o atual) — atalho de filtro.
- Acceptance Checks:
  - ✓ MP3 com TXXX:TEMAS `água; cura` indexa Song.temas exato.
  - ✓ Buscar `agua` (sem acento) retorna a música com tema `água`.
  - ✓ Buscar tema não retorna falso snippet de letra.
  - ✓ Round-trip: temas gravados pelo script Python são lidos idênticos pelo
    indexer Rust.
  - ✓ Clique no chip de tema executa a busca por aquele tema.
  - ✓ Banco v1 existente migra sem erro e sem perder playlists.
  - ✓ Rescan incremental continua skip por mtime+size (temas não forçam releitura).

## Fixtures

- `com_letra.mp3` ganha `TXXX:TEMAS = "esperança; água"` no gerador
  (`tools/make_fixtures.py`) — cobre diacríticos nos dois lados.
- Demais fixtures permanecem sem temas.

## Out of scope (V2.1)

- Interface gráfica de curadoria; busca automática de letra (LRCLIB/Vagalume);
  transcrição Whisper; edição em massa — V2.x futuras.
- Filtro combinado por múltiplos temas com operadores (AND/OR explícitos).
- Autocomplete/lista global de temas na UI do player.
