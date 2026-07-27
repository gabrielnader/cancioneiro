# Cancioneiro

Player desktop **offline** (Windows + macOS) para localizar músicas em acervos grandes
lembrando apenas um trecho da letra, visualizar a letra antes de tocar e reproduzir com
playlist automática. A letra vive **embutida no próprio MP3** (frame ID3 `USLT`) — o
arquivo carrega seus dados consigo. Sem backend, sem contas, sem telemetria — e sem
rede, exceto quando você clica explicitamente para buscar dados de uma música.

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

## Instalar (e o aviso de app não identificado)

Baixe o instalador da sua plataforma em
[Releases](https://github.com/gabrielnader/cancioneiro/releases):
`.dmg` **aarch64** para Mac com Apple Silicon (M1/M2/M3), `.dmg` **x64** para Mac
Intel, `.msi` ou `.exe` para Windows, `.deb`/`.rpm`/`.AppImage` para Linux.
Para atualizar, instale por cima da versão anterior (no macOS, arraste para
Aplicativos e confirme "Substituir") — playlists, pastas e preferências são
preservadas, e os dados das músicas vivem nos próprios MP3s.

Para enviar a quem vai só usar o player (linguagem simples, passo a passo, sem
jargão): [`docs/GUIA-DE-INSTALACAO.md`](./docs/GUIA-DE-INSTALACAO.md).

Os binários **não são assinados nem notarizados**, então os sistemas avisam:

- **macOS** — a mensagem costuma ser *"Cancioneiro está danificado e não pode ser
  aberto"*. O arquivo **não** está corrompido: é a quarentena que o macOS aplica a
  apps baixados de desenvolvedor não identificado. Remova a marca de quarentena uma
  vez por versão instalada:

  ```bash
  xattr -cr /Applications/Cancioneiro.app
  ```

  Depois abra normalmente. (O clássico botão direito → "Abrir" resolve só o aviso
  mais brando de "desenvolvedor não identificado", não o de "danificado".)
- **Windows** — no SmartScreen: "Mais informações" → "Executar assim mesmo".

Para distribuir a usuários leigos, a saída definitiva é assinar os binários
(Apple Developer ID + notarização; certificado de code signing no Windows) — sem
isso, esse passo manual é inevitável.

## Curadoria dentro do player (V4/V5)

Desde a V4 dá para organizar o acervo sem sair do app — os scripts abaixo continuam
valendo para quem prefere linha de comando ou edição em planilha, mas não são mais
obrigatórios:

- **Editar uma música**: selecione a faixa e use "Editar" no painel de detalhes para
  corrigir título, artista, letra e temas, gravando direto no MP3.
- **Buscar letra na internet**: botão no formulário de edição (consulta o LRCLIB por
  título + artista + duração). É uma ação explícita — sem ela o app não acessa a rede.
- **Completar dados desta pasta** (V5/F13): o botão ✎ na árvore de pastas varre as
  músicas incompletas daquela pasta (ou da biblioteca inteira, na raiz), propõe
  título/artista/letra com nível de confiança (ALTA/MÉDIA/BAIXA) e aplica só o que
  você marcar. As de confiança alta já vêm marcadas.
- **Navegar e buscar por pasta**: a árvore lateral reflete as subpastas do acervo, e o
  nome da pasta também entra na busca — digitar `barco` acha as músicas da pasta
  "Barco" mesmo sem tag alguma.

**Regra invariável**: a *reprodução* nunca escreve. Gravação acontece somente quando
você clica em salvar/aplicar, e grava apenas tags ID3 — o áudio nunca é alterado e
**nenhum arquivo é renomeado ou movido**, em nenhuma ferramenta do projeto.

## Preparar um MP3 de teste com letra embutida (`tools/embed_lyrics.py`)

Gravação de letra por linha de comando (útil para lotes e fixtures de teste):

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

### Temas (V2 — tags temáticas para busca)

Marque cada música com temas livres ("água", "cura", "ceia"…), gravados no próprio
MP3 (frame `TXXX:TEMAS`) — o app busca por eles na mesma caixa de busca e mostra
chips clicáveis na lista e no painel de letra (spec: `PRD-v2-temas.md`):

```bash
python3 tools/embed_lyrics.py musica.mp3 --temas "água, cura"     # define a lista
python3 tools/embed_lyrics.py musica.mp3 --add-tema "esperança"   # acrescenta
python3 tools/embed_lyrics.py musica.mp3 --remove-tema "cura"     # remove um
python3 tools/embed_lyrics.py musica.mp3 --temas ""               # remove todos
python3 tools/embed_lyrics.py --check musica.mp3                  # confere (linha Temas:)
```

Os temas são normalizados ao gravar (minúsculas, sem duplicatas, ordem alfabética)
e a busca ignora acentos ("agua" encontra "água").

## Organizar o acervo inteiro (`tools/curadoria.py`)

Para curadoria em massa — do acervo bagunçado ao acervo pesquisável:

```bash
# 1) Diagnóstico: o que falta em cada MP3 (letra, temas, título/artista)
python3 tools/curadoria.py relatorio ~/Musicas --csv plano.csv

# 2) Busca automática de letra no LRCLIB (só para quem tem título+artista;
#    primeiro veja o que seria encontrado, depois aplique)
python3 tools/curadoria.py buscar-letra ~/Musicas
python3 tools/curadoria.py buscar-letra ~/Musicas --aplicar

# 3) Edição em massa: abra plano.csv no Excel/LibreOffice, preencha título,
#    artista, temas e/ou o caminho de um .txt com a letra em cada linha, e:
python3 tools/curadoria.py aplicar ~/Musicas --csv plano.csv --dry-run   # confere
python3 tools/curadoria.py aplicar ~/Musicas --csv plano.csv             # grava
```

Campos vazios no CSV nunca apagam nada — só o que você preencher é gravado.
A busca no LRCLIB acontece sob demanda; fora dela **o app é 100% offline**.
Depois da curadoria, abra o Cancioneiro e clique "Reindexar tudo".

### Identificação automática e temas por pasta (V3)

Para acervos onde as tags são inexistentes ou lixo ("Faixa 8", "no artist"), o
`enriquecer` deduz título/artista do **nome do arquivo** e confirma no LRCLIB
comparando a **duração** da faixa (±3s = confiança alta):

```bash
python3 tools/curadoria.py enriquecer ~/Musicas --interativo   # confirma uma a uma
python3 tools/curadoria.py enriquecer ~/Musicas --auto         # aplica só as de confiança alta
python3 tools/curadoria.py enriquecer ~/Musicas --csv restantes.csv --verboso
python3 tools/curadoria.py temas-de-pastas ~/Musicas --aplicar # nome da pasta vira tema
```

Propostas de confiança baixa nunca sobrescrevem tags reais, e valores de
preenchimento automático ("AudioTrack 02", "Artista desconhecido") são tratados como
campo vazio dos dois lados da comparação. Nenhum arquivo é renomeado.

> No acervo real de teste (94 arquivos de repertório de nicho), o LRCLIB cobriu
> cerca de 3% — por isso a v0.5 traz transcrição local de áudio para o restante.

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
7. **Persistência**: mude o volume, oculte o painel de letra ("Ocultar detalhes"),
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
                     search.rs (sanitização+snippet), writer.rs (grava tags ID3),
                     lyrics_fetch.rs + enrich.rs (LRCLIB: letra avulsa e lote),
                     commands.rs (IPC), error.rs
src-tauri/tests/     integração: indexer, busca, round-trip USLT, hash de arquivos,
                     escrita de tags e enriquecimento em lote
tools/               embed_lyrics.py e curadoria.py (curadoria por linha de comando),
                     make_fixtures.py (fixtures)
tests/python/        pytest das ferramentas Python
e2e/                 Playwright (modo web + IPC mockado)
fixtures/            MP3s de teste gerados (não são áudio real baixado)
```
