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

### Instrumental (V8/F17 — músicas sem voz)

Uma música sem voz não tem letra a procurar. Sem dizer isso ao acervo, ela é
tratada como pendência para sempre: entra em toda varredura de letra, é
transcrita, volta vazia, vira erro — e é tentada de novo na execução seguinte.
Marcar uma vez resolve as duas pontas, **informação** e **economia** (spec:
`PRD-v8-instrumental-e-funil-no-app.md`). A marca é o frame
`TXXX:INSTRUMENTAL = "1"`, gravada no próprio MP3, como os temas e a procedência
da letra — o dado viaja com o arquivo.

```bash
python3 tools/embed_lyrics.py musica.mp3 --instrumental       # marca
python3 tools/embed_lyrics.py musica.mp3 --nao-instrumental   # desmarca
python3 tools/embed_lyrics.py --check musica.mp3              # confere (linha Instrumental:)
```

- **Automática**: no `curadoria.py transcrever`, quando a transcrição volta
  **vazia com áudio legível**, o arquivo é marcado como instrumental em vez de
  contar como erro — sai a linha `INSTRUMENTAL: … (transcrição vazia com áudio
  legível — marcado como instrumental)` e o `Resumo:` ganha o balde
  `N instrumentais`. **Áudio ilegível continua erro**: são coisas diferentes.
- **A escolha humana manda**: nenhuma rotina desmarca sozinha, nem com
  `--forcar` ou `--forcar-tudo` (essas flags falam de *letra* a refazer, não de
  rediscutir se a música tem voz). Para reprocessar um arquivo marcado, desmarque
  antes com `--nao-instrumental`.
- **Economia**: todas as etapas de **letra** pulam o arquivo — `buscar-letra`
  (inclusive a perna do Vagalume), `identificar --com-letra` e `transcrever` —,
  cada uma com sua contagem `N instrumentais` no `Resumo:`. A **impressão
  digital** (`identificar`) **continua rodando**: instrumental sem letra ainda
  pode e deve ter título e artista corretos.
- **No relatório**, a coluna `letra` mostra `INSTRUMENTAL` no lugar do `NÃO` —
  informação, não cobrança. Um instrumental que ainda assim tenha letra
  registrada (raro, mas possível) mostra a letra normalmente (`SIM`,
  `SIM (transcrição)`…) e **mantém** a marca.

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

### Transcrição local do áudio (V5)

Quando o acervo é de nicho e o LRCLIB não tem quase nada, a letra sai do próprio
áudio: o `transcrever` roda o [faster-whisper](https://github.com/SYSTRAN/faster-whisper)
**na sua máquina** (CPU, sem chave de API, sem enviar áudio a lugar nenhum).
Primeiro ele transcreve só um trecho (90 s a partir dos 20 s), extrai o refrão —
a frase mais repetida costuma ser o título — e tenta identificar a música no
LRCLIB pelo refrão + duração; se identificar, usa a letra **oficial**. Se não,
transcreve a música inteira e grava o texto no `USLT`, marcado como
`TXXX:LETRA_ORIGEM = "transcricao"` (o relatório mostra `SIM (transcrição)`).

É dependência **opcional** — sem ela os outros subcomandos seguem normais:

```bash
pip3 install faster-whisper
python3 tools/curadoria.py transcrever ~/Musicas --csv feito.csv
```

```bash
  --modelo {tiny,base,small,medium}  padrão: small
  --idioma pt                        padrão: pt
  --trecho SEGUNDOS                  trecho de identificação (padrão: 90)
  --so-identificar                   nunca transcreve a música inteira
  --so-transcrever                   pula a identificação
  --forcar                           refaz só as letras que vieram de transcrição
  --forcar-tudo                      refaz qualquer letra (apaga letra oficial!)
  --sobrescrever-tags                deixa a identificação ALTA trocar tag real
  --csv arquivo.csv                  registra o que foi feito, para conferência
  --verboso                          mostra o trecho transcrito e os candidatos
```

Na **primeira execução** a biblioteca baixa o modelo (~500 MB para o `small`),
uma única vez, para o cache do seu perfil — é o único acesso à rede além do
LRCLIB, e o script avisa antes. Depois disso a operação é **longa**: contando na
CPU, alguns minutos por música, ou seja **horas** num acervo de 90 arquivos (por
isso cada linha traz o contador `[12/94]`). Pode interromper com Ctrl-C a
qualquer momento: o arquivo em andamento fica íntegro, o resumo é impresso e o
`--csv` é gravado com tudo o que já foi feito.

Regras de segurança deste subcomando (o palpite vem do **áudio**, então casar no
LRCLIB não prova nada — e um lote de horas roda sem ninguém olhando):

- **Título e artista reais nunca são sobrescritos**, nem quando a confiança é
  ALTA: só campo vazio ou de preenchimento automático ("Faixa 5", "no artist") é
  preenchido. Quem quiser o contrário pede explicitamente `--sobrescrever-tags`.
- Quando a identificação **contradiz** a tag que já está no arquivo, nada é
  gravado e sai uma linha `CONFLITO: … (não alterado)`, contada no `Resumo:` e
  registrada no CSV — para você conferir depois, música por música.
- Alucinações conhecidas do motor em trecho instrumental ("Música", "Legendas
  pela comunidade Amara.org", "Obrigado por assistir") e frases de uma palavra
  só nunca viram consulta ao LRCLIB.
- **Letra existente nunca é substituída** sem pedido explícito: `--forcar`
  reprocessa apenas o que a própria transcrição escreveu (o caso real: rodar de
  novo com um modelo maior) e `--forcar-tudo` — destrutivo — inclui as letras
  oficiais.
- Como em todo o projeto: nada de renomear ou mover arquivo, e o áudio nunca é
  alterado (a gravação de tags é atômica: escreve numa cópia temporária na mesma
  pasta e a troca de lugar, então nem uma queda de energia trunca o MP3).

### Impressão digital acústica (V6)

Transcrever custa 30 a 80 segundos por música; em 10.000 arquivos são 100 a 200
horas. A impressão digital acústica calcula uma assinatura do áudio e a compara
com uma base pública (AcoustID/MusicBrainz) em **1 a 2 segundos** — cerca de 30×
mais barato — e acerta em cheio nas gravações comerciais. Por isso o
`identificar` entra **antes** do `transcrever` no funil, que fica assim:

| Etapa | Custo por música | Comando |
|---|---|---|
| 1. Tags + nome de arquivo + nome da pasta | instantâneo | `enriquecer` |
| 2. LRCLIB por título/artista + duração | ~0,5 s | `enriquecer`, `buscar-letra` |
| 3. **Impressão digital (AcoustID)** | ~1–2 s | **`identificar`** |
| 4. Transcrição local, só no que sobrou | 30–80 s | `transcrever` |

(A V6.1 encaixou o Vagalume entre as etapas 3 e 4 como segunda fonte de letra —
veja [Vagalume: a segunda fonte de letra](#vagalume-a-segunda-fonte-de-letra-v61)
mais abaixo.)

Duas dependências, ambas fáceis e ambas **opcionais** (sem elas, todos os outros
subcomandos seguem normais — só o `identificar` avisa e sai):

1. **`fpcalc`**, do Chromaprint, que calcula a assinatura:

   ```bash
   brew install chromaprint                        # macOS
   sudo apt install libchromaprint-tools           # Debian/Ubuntu
   # Windows: baixe o binário oficial em https://acoustid.org/chromaprint
   #          e ponha a pasta do fpcalc.exe no PATH
   ```

2. **Chave da API do AcoustID**, gratuita e com cadastro de um minuto em
   [acoustid.org/new-application](https://acoustid.org/new-application). O
   projeto **nunca grava a chave em disco**: passe em `--chave` ou deixe na
   variável de ambiente.

```bash
export ACOUSTID_API_KEY="sua-chave"
python3 tools/curadoria.py identificar ~/Musicas --com-letra --csv feito.csv
```

```bash
  --chave CHAVE          chave da API (ou a variável ACOUSTID_API_KEY)
  --com-letra            depois de identificar, busca a letra oficial no LRCLIB
  --csv arquivo.csv      registra o que foi aplicado, com a confiança
  --sobrescrever-tags    deixa a identificação ALTA trocar tag real (destrutivo)
  --verboso              mostra a pontuação e os candidatos descartados
```

Só entra o candidato com **pontuação ≥ 0,7 E duração compatível** (±3s = ALTA,
até 15s = MÉDIA, acima disso desqualifica — as mesmas regras da V3). Cada linha
traz o contador `[12/94]`, e Ctrl-C encerra com o `Resumo:` e o `--csv` gravado,
dizendo onde parou:

```
[12/94] IDENTIFICADA: barco - Timoneiro.mp3 → Timoneiro / Paulinho da Viola (ALTA, pontuação 0.94, mp3 232s, acoustid 231s) + letra
[13/94] SEM RESULTADO: barquinha - linda sereia.mp3
[14/94] CONFLITO: barco - Canoeiro.mp3 — tag atual "Canoeiro / Paulo Diniz" difere do identificado "Canoeiro / Leila Pinheiro" (não alterado)
Resumo: 94 arquivos | 31 identificadas | 12 letras oficiais | 48 sem resultado | 3 conflitos | 0 erros
```

Valem aqui **as mesmas travas** que o `transcrever` aprendeu na marra — o palpite
também vem do áudio, então casar não prova nada: título e artista reais nunca são
sobrescritos (só campo vazio ou de preenchimento automático), divergência vira
`CONFLITO` sem gravar nada, resultado com título/artista de placeholder é
descartado, letra existente nunca é substituída, a gravação de tags é atômica e
nenhum arquivo é renomeado ou movido. Com `--com-letra` a letra que entra é a
**oficial** do LRCLIB — não recebe o selo `SIM (transcrição)` do relatório.

#### Quanto tempo isto vai levar? (`estimar`)

Acervo grande não se encara às cegas. O `estimar` conta os arquivos, mede uma
amostra nesta máquina e projeta cada etapa do funil:

```bash
python3 tools/curadoria.py estimar ~/Musicas --amostra 10
```

```
Acervo: 94 arquivos | 63 incompletos | 71 sem letra
Amostra: 10 arquivos (média de 3m52s por música)
Projeção: identificar: ~4 min | transcrever o restante: ~1h20 (modelo small) ou ~18 min (modelo tiny)
```

Ele não grava nada e **não baixa nada** — nem o modelo do Whisper. Quando um
número não pôde ser medido aqui (sem `fpcalc`, ou sem o modelo baixado), a saída
diz com todas as letras que aquela etapa saiu de média/proporção publicada, e
não de medição. São estimativas: o tempo real varia com o processador, a rede,
a duração das músicas e quanto o `identificar` resolver antes.

### Vagalume: a segunda fonte de letra (V6.1)

O LRCLIB é uma base internacional, e no acervo real de teste — 94 arquivos de
repertório brasileiro de nicho (Barquinha, adventícios, forró, MPB de raiz) —
ele cobriu **cerca de 3%**. O [Vagalume](https://www.vagalume.com.br) é base
comunitária **brasileira** e cobre justamente esse buraco. Por isso ele entra
como **segunda fonte de letra**, sempre depois do LRCLIB e sempre antes da
transcrição — que custa 30 a 80 segundos por música:

| Etapa | Custo por música | Comando |
|---|---|---|
| 1. Tags + nome de arquivo + nome da pasta | instantâneo | `enriquecer` |
| 2. LRCLIB por título/artista + duração | ~0,5 s | `enriquecer`, `buscar-letra` |
| 3. Impressão digital (AcoustID) | ~1–2 s | `identificar` |
| 4. **Vagalume, só no que o LRCLIB não tinha** | ~0,5 s | **`buscar-letra`, `identificar --com-letra`** |
| 5. Transcrição local, só no que sobrou | 30–80 s | `transcrever` |

A chave da API é **gratuita** e sai em um minuto em
[auth.vagalume.com.br/settings/api](https://auth.vagalume.com.br/settings/api/).
Como a do AcoustID, o projeto **nunca grava a chave em disco**: passe em
`--chave-vagalume` ou deixe na variável de ambiente.

```bash
export VAGALUME_API_KEY="sua-chave"
python3 tools/curadoria.py buscar-letra ~/Musicas --aplicar
python3 tools/curadoria.py identificar ~/Musicas --com-letra --csv feito.csv
```

```
ENCONTRADA: barco - Timoneiro.mp3 (1832 caracteres)
ENCONTRADA (Vagalume): barquinha - linda sereia.mp3 (964 caracteres)
NÃO ENCONTRADA: adventicio - lampejo.mp3
Resumo: 2 encontradas | 1 não encontradas | 0 erros de rede | 1 pelo Vagalume
```

`1 pelo Vagalume` é um **recorte** das encontradas, não um balde à parte: as
encontradas são as do LRCLIB mais as do Vagalume. **Sem a chave**, sai uma linha
dizendo que o Vagalume foi pulado e como habilitá-lo, e o comando roda
exatamente como rodava antes — nada mais muda.

**A ressalva honesta:** o Vagalume **não pode ser confirmado pela duração.** A
API não tem esse campo, então a trava que sustenta todo o resto do funil (±3s =
ALTA, acima de 15s desqualifica) simplesmente não existe aqui. A única prova
disponível é textual, e por isso ela é exigida dos **dois** lados: o artista **e**
o título devolvidos precisam bater com o que foi pedido, pelas mesmas regras do
resto do projeto (variação de grafia passa — "Milionário y José Rico" x
"Milionário & José Rico" —, música diferente não). Sem artista para conferir,
**nem se consulta**: foi um casamento sem prova que um dia pareou "Lampejo" com
uma faixa do Roberto Carlos. Resultado com título/artista de preenchimento
automático e recado de "ainda não temos a letra" são descartados antes de tudo.

Pela mesma razão a letra do Vagalume fica **marcada**: ela é oficial — não leva
o selo de transcrição, e o relatório **não** diz `SIM (transcrição)` para ela —,
mas grava `TXXX:LETRA_ORIGEM = "vagalume"` e o relatório mostra `SIM (Vagalume)`,
para você saber depois qual letra veio da fonte que não deu para confirmar. A do
LRCLIB continua sem marca nenhuma, como sempre foi.

E valem as travas de sempre: **letra existente nunca é substituída** (arquivo com
letra não é nem consultado), título e artista reais nunca são tocados por este
caminho, a gravação de tags é atômica e nenhum arquivo é renomeado ou movido.

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
