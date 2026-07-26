# REPORT — Cancioneiro V1

Build autônomo completo a partir de `PRD-cancioneiro.md`, do zero ao binário, em
fases com TDD (testes escritos antes da implementação em cada fase) e revisão QA
cética por subagente ao fim de cada fase (lacunas corrigidas antes de avançar).

**Estado final: todas as suítes verdes.**

| Suíte | Resultado |
|---|---|
| pytest (`tools/` — F6 + fixtures) | **26 passed** |
| cargo test (backend Rust: db, indexer, search, integração) | **31 passed** (7 unit + 15 integração + 9 busca) |
| Vitest (stores, hooks, lib, componentes) | **122 passed**, cobertura acima do limiar de 85% |
| Playwright E2E (9 fluxos críticos) | **9 passed** |
| `npm run tauri build` | **OK** — binário release + `Cancioneiro_0.1.0_amd64.deb` (plataforma atual: Linux; janela verificada sob Xvfb — screenshots em `docs/screenshots/`) |

## Checklist da seção 8 do PRD, item a item

1. **Binário abre, indexa pasta com MP3 de teste e a música aparece — sem internet.**
   ✅ Parcial na plataforma-alvo: o container é Linux, então o binário release Linux
   foi executado sob Xvfb (janela abre, UI renderiza — screenshot capturado; app não
   faz nenhuma chamada de rede em runtime por construção: não há código de rede).
   A indexação real de pasta com os MP3s fixture é verificada por
   `src-tauri/tests/integration.rs::add_folder_indexes_three_fixtures_with_correct_paths`
   e o fluxo completo de UI por E2E (`e2e/cancioneiro.spec.ts`, "adicionar pasta indexa
   e lista as músicas"). Em Windows/macOS: seguir o smoke test do README (10 itens).
2. **Buscar trecho que existe só na letra retorna a música em < 100ms com destaque.**
   ✅ `tests/search.rs::lyrics_only_match_returns_that_song_first` (primeiro no rank),
   `search_over_2000_songs_under_100ms` (2.000 músicas sintéticas, medição real com
   `Instant`, < 100ms) e `lyrics_match_produces_highlighted_snippet`; na UI, E2E
   "buscar trecho que existe só na letra destaca o termo" verifica o `<mark>`.
3. **"coracao" → "coração".** ✅ Tokenizer `unicode61 remove_diacritics 2` +
   `tests/search.rs::search_without_diacritics_finds_accented_lyrics` (inclui
   "AMANHECER"→minúsculas) + E2E com o mesmo passo.
4. **Clique único mostra letra sem tocar; duplo-clique toca em < 500ms.**
   ✅ `SongList.test.tsx` ("clique único seleciona e NÃO inicia reprodução"),
   `LyricsPanel.test.tsx` (letra integral com `\n` preservado, comparação exata) e
   E2E "clique único mostra a letra e NÃO toca; duplo-clique toca" — o `expect` de
   `paused=false` usa timeout de **500ms** após o duplo-clique, com áudio real.
5. **Playlist toca em sequência e para ao final; ausente é pulado com aviso.**
   ✅ `playerStore.test.ts` (avanço automático, fim → ▶), E2E "criar, adicionar,
   tocar em sequência automática e parar no fim" (duas fixtures reais de 3s/2s,
   avanço automático real no Chromium) e "item ausente é pulado com toast"
   (mensagem exata do PRD). Backend: skip coberto em `playerAudioCore.test.ts`.
6. **Volume, painel, fonte e playlists persistem.** ✅ `uiStore.test.ts` e
   `playerStore.test.ts` (reidratação de nova instância do store a partir do
   localStorage) + E2E com `page.reload()` (volume 0.4, painel oculto, fonte 20px,
   playlist com itens). Playlists reais persistem em SQLite
   (`db.rs` + `tests/integration.rs`).
7. **Nenhum arquivo de áudio modificado (hash antes/depois).**
   ✅ `tests/integration.rs::backend_flows_never_modify_audio_files`: bytes E mtime
   dos 4 MP3s comparados antes/depois de indexar, reindexar, buscar, ler letra e
   todo o CRUD de playlist. Além disso, QA verificou por grep que não existe
   nenhuma escrita de arquivo de áudio no código do app (a única escrita é do
   `tools/embed_lyrics.py`, ferramenta de curadoria externa ao player).
8. **2.000 músicas: scroll e busca sem travamento.** ✅ Busca < 100ms no Rust
   (teste acima); lista virtualizada (@tanstack/react-virtual) — E2E "Escala:
   2.000 músicas" semeia 2.000 no mock, rola até o fim e verifica que o DOM tem
   < 120 linhas montadas; busca com debounce responde < 2s no E2E (folga para
   ambiente de CI; a medição estrita de 100ms é a do backend). FPS não é medido
   numericamente (limitação registrada abaixo).
9. **Sem erros no console/log nos fluxos padrão.** ✅ Assertado diretamente no E2E:
   os fluxos de indexação/busca/biblioteca e de playlist sequencial coletam
   `console.error` + `pageerror` do Chromium e exigem lista vazia
   (`e2e/cancioneiro.spec.ts`, helper `trackErrors`). Warnings benignos de
   `act(...)` existem em 1 teste de componente (não afetam produção).

### Cobertura de testes (exigências da seção 8)

- **Comandos Tauri críticos com integração (fluxo feliz + erros documentados)** ✅
  add_folder/scan (pasta inexistente, corrompido, pasta sumida, arquivo removido,
  skip incremental), search (caracteres especiais, vazia), get_lyrics (id inválido),
  playlist CRUD (nome vazio, reorder inválido, cascades) — `src-tauri/tests/` + unit.
- **Cobertura ≥ 85%** ✅
  - Rust (cargo-llvm-cov, % linhas): `search.rs` **97,8%**, `indexer.rs` **89,5%**,
    `db.rs` (inclui playlists) **87,0%** — os "services" nomeados pelo PRD.
    (`commands.rs` é delegação 1:1 para os services e requer contexto Tauri para
    instanciar; `lib.rs`/`main.rs` são bootstrap — fora do escopo "services".)
  - Frontend (v8, escopo stores/hooks/lib como pede o PRD): **97,6% linhas /
    91,9% branches / 91,8% funções**, thresholds de 85% aplicados no config
    (`api.ts` = cola de IPC e `types.ts` = só tipos, excluídos e justificados em
    DECISIONS.md #28).
- **E2E dos fluxos críticos** ✅ 9 cenários: indexar → buscar → letra → tocar →
  playlist sequencial → arquivo ausente (avulso e em playlist) → persistência →
  2.000 músicas. Real vs. mockado documentado no README (seção Testes).
- **Round-trip Python → Rust** ✅
  `tests/integration.rs::roundtrip_uslt_from_python_script_is_read_exactly`
  (texto idêntico, acentos e `\n\n` preservados, sobre fixture gravada pelo script).
- **Zero testes falhando antes do build** ✅ `npm run test:all` verde antes do
  `tauri build`.
- **TDD** ✅ em cada fase os testes foram escritos primeiro (red) e a implementação
  veio depois; QA de fase auditou check a check.

## Decisões registradas

30 decisões em [`DECISIONS.md`](./DECISIONS.md). As mais relevantes:
- Pastas sobrepostas são rejeitadas (evita perda de playlists via cascade) — #13.
- Coluna `songs.available` adicionada ao Data Model (exigência do estado de erro
  de F1) — #12.
- Scan usa conexão SQLite dedicada (WAL) para não travar busca durante indexação — #15.
- Fila do player rastreia o "próximo" por identidade quando a música atual é
  removida da playlist (sobrevive a remoções/reordenações compostas) — #22.
- E2E: IPC mockado, áudio e UI reais; racional e fronteira documentados — #27.
- Ordenação alfabética pt-BR via collation própria ("Água" < "banana") — #21.

## Limitações conhecidas

1. **Binários Windows/macOS não foram gerados aqui** — o ambiente é Linux e o
   Tauri não cruza SOs. O README documenta o build em cada plataforma; o `.deb`
   e o binário Linux comprovam o pipeline `tauri build` funcionando de ponta a ponta.
2. **E2E nativo é manual**: `tauri-driver` não suporta macOS (premissa do PRD);
   o smoke test de 10 itens do README cobre o binário real.
3. **FPS do scroll não é medido numericamente** — a virtualização é verificada
   estruturalmente (DOM < 120 linhas com 2.000 músicas).
4. **`search` limita a 200 resultados** por relevância (campo vazio devolve tudo);
   o contador reflete o que está listado — PRD omisso, registrado em DECISIONS #19.
5. **`commands.rs` (cola Tauri) sem cobertura direta** — delegação 1:1 testada
   através dos services; instanciar `State`/`AppHandle` fora do runtime Tauri não
   é suportado.
6. **Watch de filesystem, repeat/shuffle, letra sincronizada etc.** — fora do
   escopo V1 por definição do PRD (seção 7); nada disso foi adicionado.
7. Warnings benignos: `act(...)` em 1 teste de componente; `libEGL` sob Xvfb
   (artefato do ambiente headless, não do app).

## Como rodar agora

```bash
# 1) instalar dependências (uma vez)
npm install                     # Node 20+; Rust via rustup; python3 + pip install mutagen

# 2) suíte completa (pytest + cargo + vitest com cobertura)
npm run test:all

# 3) E2E Playwright (frontend web + IPC mockado, áudio real)
npm run test:e2e                # se necessário: PLAYWRIGHT_CHROMIUM_PATH=/caminho/chromium

# 4) rodar o app (janela nativa)
npm run tauri dev

# 5) binário release da plataforma atual
npm run tauri build             # artefatos em src-tauri/target/release/bundle/
```

Smoke test manual (10 itens, espelhando a seção 8): seção
**"Smoke test manual"** do [`README.md`](./README.md) — prepare a pasta de teste com
`python3 tools/make_fixtures.py` e valide com a rede desligada.
