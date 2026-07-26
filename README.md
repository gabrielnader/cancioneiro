# Cancioneiro

Player desktop **offline** (Windows + macOS) para localizar músicas em acervos grandes
lembrando apenas um trecho da letra, visualizar a letra antes de tocar e reproduzir com
playlist automática. A letra vive **embutida no próprio MP3** (frame ID3 `USLT`) — o
arquivo carrega seus dados consigo. Sem backend, sem contas, sem rede.

Stack: Tauri 2 (Rust) · React 18 + TypeScript + Vite · Tailwind CSS · SQLite FTS5
(`unicode61 remove_diacritics 2`) · zustand. Especificação completa em
[`PRD-cancioneiro.md`](./PRD-cancioneiro.md); decisões de implementação em
[`DECISIONS.md`](./DECISIONS.md).

## Pré-requisitos de desenvolvimento

- **Node.js 20+** e npm
- **Rust** (toolchain estável, via [rustup](https://rustup.rs))
- **Python 3.10+** com `mutagen` (`pip install mutagen`) — ferramentas de curadoria/teste
- `lame` no PATH — só para regenerar as fixtures de teste (`tools/make_fixtures.py`)
- Dependências do Tauri por SO: veja [tauri.app/start/prerequisites](https://tauri.app/start/prerequisites/)
  - Windows: Microsoft C++ Build Tools + WebView2 (já incluso no Windows 10/11)
  - macOS: Xcode Command Line Tools (`xcode-select --install`)

```bash
npm install
```

## Rodar em desenvolvimento

```bash
npm run tauri dev          # app nativo (janela Tauri)
npm run dev                # só o frontend no navegador, com IPC mockado em memória
```

## Build dos binários

Na plataforma correspondente (o Tauri não faz cross-compile entre SOs):

```bash
# Windows (PowerShell) → src-tauri/target/release/bundle/msi/*.msi e nsis/*.exe
npm run tauri build

# macOS → src-tauri/target/release/bundle/dmg/*.dmg e macos/Cancioneiro.app
npm run tauri build
```

O V1 não assina/notariza os binários. No macOS, na primeira abertura use
botão direito → "Abrir" para aceitar o aviso de desenvolvedor não identificado;
no Windows, "Mais informações" → "Executar assim mesmo" no SmartScreen.

## Preparar um MP3 de teste com letra embutida (`tools/embed_lyrics.py`)

O player **nunca escreve** nos arquivos de áudio — quem grava a letra é este script:

```bash
# grava a letra a partir de um arquivo texto (e opcionalmente título/artista)
python3 tools/embed_lyrics.py caminho/musica.mp3 caminho/letra.txt --title "Nome" --artist "Artista"

# ou letra inline
python3 tools/embed_lyrics.py caminho/musica.mp3 --lyrics "Primeira linha\nSegunda linha"

# conferir o round-trip (imprime título, artista e a letra embutida)
python3 tools/embed_lyrics.py --check caminho/musica.mp3
```

O frame gravado é `USLT` (UTF-8, lang `por`, ID3v2.4); rodar duas vezes substitui
(não duplica). As fixtures de teste em `fixtures/` são geradas por
`python3 tools/make_fixtures.py` (tons senoidais curtos + um arquivo corrompido).

## Testes

```bash
npm run test:all     # pytest (ferramentas Python) + cargo test (backend) + vitest --coverage (frontend)
npm run test:e2e     # Playwright: frontend em modo web com IPC mockado (ver nota abaixo)
```

**O que é E2E real vs. mockado:** os testes Playwright rodam o frontend inteiro no
Chromium com a camada de IPC substituída por um mock em memória
(`src/lib/mockBackend.ts`) — o `tauri-driver` não suporta macOS. São reais: toda a UI
React, os stores, os atalhos de teclado, a persistência (localStorage) e o **áudio**
(o Chromium decodifica os MP3s de `fixtures/` de verdade, incluindo o avanço
automático de playlist ao fim de cada faixa). São mockados: os comandos Rust
(indexação, FTS5, CRUD) — que têm sua própria suíte de integração real em
`src-tauri/tests/` (incluindo o round-trip Python→Rust e o teste de que nenhum
fluxo modifica os MP3s). O E2E do binário nativo é o smoke test manual abaixo.

Se o Chromium baixado pelo Playwright não estiver disponível, aponte para um
executável local: `PLAYWRIGHT_CHROMIUM_PATH=/caminho/chromium npm run test:e2e`.

## Smoke test manual (10 itens — espelha a seção 8 do PRD)

Prepare: `python3 tools/make_fixtures.py` e copie `fixtures/com_letra.mp3`,
`fixtures/sem_letra.mp3` e `fixtures/sem_tags.mp3` para uma pasta de teste
(ex.: `~/Musicas-Teste`). Desligue a rede para validar o funcionamento offline.

1. **Indexação**: abra o app, clique "Adicionar pasta" e escolha a pasta de teste.
   Deve aparecer o toast "3 músicas indexadas." e a biblioteca listar as 3 músicas
   ("Coração Sertanejo", "Instrumental Sem Letra", "sem_tags" — as duas últimas com
   badge "Sem letra").
2. **Busca por letra**: digite `noite sem estrela` — só "Coração Sertanejo" deve
   aparecer, com o trecho da letra e o termo destacado em amarelo.
3. **Busca sem acento**: digite `coracao` — encontra "Coração Sertanejo". Digite
   `"*-` — não pode aparecer erro; limpar o campo restaura a lista completa em
   ordem alfabética.
4. **Letra sem tocar**: clique **uma vez** em "Coração Sertanejo" — o painel direito
   mostra a letra completa com as quebras de linha; nada toca. Clique em "sem_tags" —
   painel mostra "Esta música ainda não tem letra registrada.".
5. **Reprodução**: dê **duplo-clique** em "Coração Sertanejo" — toca imediatamente
   (< 0,5s). Espaço pausa/retoma (com o foco fora da busca); digite espaço dentro da
   busca e confirme que a música não pausa. Clique no meio da barra de progresso —
   o áudio salta para o ponto. Ao terminar, a reprodução para sozinha.
6. **Playlist**: crie a playlist "Culto" (botão "Nova playlist"), adicione
   "Coração Sertanejo" e "Instrumental Sem Letra" pelo "+" que aparece ao passar o
   mouse. Abra a playlist e clique "▶ Tocar playlist": a primeira toca (~3s) e a
   segunda **começa sozinha**; ao fim da segunda a reprodução para e o botão volta a ▶.
   Arraste um item para trocar a ordem.
7. **Persistência**: mude o volume, oculte o painel de letra ("Ocultar letra"),
   aumente a fonte da letra ("Aa") e feche o app. Reabra: volume, painel oculto,
   nível de fonte, a playlist "Culto" e sua ordem devem estar como você deixou.
8. **Arquivo ausente**: feche o app, apague `sem_letra.mp3` da pasta de teste e
   reabra. Toque a playlist "Culto": a faixa ausente é pulada com o aviso
   "Pulando \"Instrumental Sem Letra\": arquivo não encontrado." (ou, se já
   reindexou na abertura, ela some da playlist). Duplo-clique direto num arquivo
   apagado mostra "Arquivo não encontrado: …".
9. **Integridade dos arquivos**: calcule o hash dos MP3s antes e depois de todos os
   passos acima (`certutil -hashfile musica.mp3 SHA256` no Windows;
   `shasum -a 256 musica.mp3` no macOS) — os hashes devem ser idênticos.
10. **Sem rede e sem erros**: tudo acima deve funcionar com a rede desligada; abra o
    console do WebView (build de dev) e confirme que não há erros nos fluxos padrão.

## Estrutura

```
src/                 frontend React (components, stores zustand, hooks, lib)
src-tauri/src/       backend Rust: db.rs (SQLite+FTS5), indexer.rs (lofty/walkdir),
                     search.rs (sanitização+snippet), commands.rs (IPC), error.rs
src-tauri/tests/     integração: indexer, busca, round-trip USLT, hash de arquivos
tools/               embed_lyrics.py (curadoria) e make_fixtures.py (fixtures)
tests/python/        pytest das ferramentas Python
e2e/                 Playwright (modo web + IPC mockado)
fixtures/            MP3s de teste gerados (não são áudio real baixado)
```
