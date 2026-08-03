# REPORT — Cancioneiro

## Estado em 0.12.0 — o que o produto é, e o que ele custou aprender

O Cancioneiro é um player de MP3 **offline** (Tauri 2 + Rust + React, SQLite com
FTS5) que existe para resolver um problema só: **achar uma música pelo pedaço de
letra que alguém lembra**, num acervo grande, sem internet e sem conta. A
reprodução nunca escreve; a rede só existe em pontos enumerados, e nenhum deles
é o player.

Da 0.6.0 até aqui o produto deixou de ser só um player. Ele absorveu a **máquina
de curadoria** que antes morava no terminal: descobrir que música é aquela,
achar a letra, e — quando não existe letra publicada — **escrevê-la ouvindo o
áudio**, tudo dentro do aplicativo, em Configurações, sem uma linha de comando.

### O contexto que decide todas as escolhas

São **~40 pessoas não-técnicas, cada uma curando o próprio acervo, na própria
máquina**, e há coleções que o dono do produto não pode nem ver. **Não existe
suporte a quem perguntar.**

Isso não é detalhe de distribuição — é o critério de projeto, e está atrás de
quase tudo que mudou nesta janela:

- **cada mensagem é a única explicação que alguém vai receber** — daí "sem
  conexão" ter deixado de ser o nome de todo erro (429, 500 e chave recusada
  eram tudo "sua internet"), e daí a copy inteira ter passado por um passe de
  redução com régua e teste, depois do relato em campo *"as mensagens estão
  muito longas"*;
- **modo é escolha, e escolha é pedágio** — os dois modos de varredura
  ("completar" e "conferir") sumiram em favor de um botão só;
- **defeito silencioso é permanente**, porque ninguém vai reportá-lo: a música
  que sai da fila de curadoria por engano sai *para sempre*;
- **estimativa errada por ordem de grandeza é pior que estimativa ausente**,
  porque o PRD a promoveu a parte do fluxo.

### O funil, como ficou

Ele deixou de ser uma fila ordenada por custo e virou **duas fases**, porque a
impressão digital não devolve letra: devolve *identidade*, que é entrada de
todas as outras etapas.

| fase | # | etapa | custo | prova do casamento |
|---|---|---|---|---|
| A — que música é esta? | 1 | etiquetas + nome do arquivo | instantâneo | nenhuma (palpite local) |
| A | 2 | impressão digital (AcoustID / `fpcalc`) | **2 s/música, medidos em campo** | acústica; teto de aceitação não afrouxável |
| B — qual é a letra? | 3 | LRCLIB | ~0,5 s | duração (±3 s) |
| B | 4 | `lyrics.ovh` | ~0,5 s | **nenhuma verificável por nós** — teto MÉDIA |
| B | 5 | transcrição local (whisper.cpp) | minutos por música | o próprio áudio |

`fpcalc`, `whisper-cli` e os modelos não vêm no instalador de 5 MB: são
**acessórios baixados sob demanda**, de um lançamento fixo (`acessorios-v1`),
com SHA-256 compilado no app e conferido **antes de executar**. A tela lista o
que *esta máquina* faz, não o que o produto sabe fazer.

### As suítes

| suíte | 0.6.0 (início da janela) | 0.12.0 |
|---|---|---|
| cargo test | 106 | **478** |
| pytest | 557 | **754** |
| vitest | 369 | **1286** |
| Playwright E2E | 22 | **54** |
| total | 1054 | **2572** |

`tsc` limpo, `cargo check` sem avisos, **0 warnings**. As decisões de projeto —
**185** hoje, contra 30 ao fim da V1 — estão em
[`DECISIONS.md`](./DECISIONS.md), cada uma com o motivo e, quando existe, o
número que a sustenta.

E a ressalva que esta janela ensinou a escrever junto com o número: **suíte
verde mede o que a suíte alcança.** Com 205 testes de Rust verdes o aplicativo
congelava inteiro ao varrer uma pasta; com quatro suítes verdes a chave de API
não chegava ao binário. Nenhum desses números prova o produto.

### As medições, com a condição em que foram feitas

Quase toda decisão desta janela foi puxada por um número, e vários deles
contradisseram a intuição que os precedia.

| medida | valor | condição |
|---|---|---|
| cobertura do LRCLIB | **~3%** | acervo real de 94 MP3s de repertório de nicho, Mac M2 |
| identificação por impressão digital | **16%** (15 de 94), 23 s no total | mesmos 94 arquivos |
| identificação pelo refrão | **0 e 1** identificações | duas execuções dos 94 (`tiny` e `small`) — e a única foi **errada e aplicada** |
| transcrição, encontrabilidade | **78%** | faster-whisper (CTranslate2, Python), medida original |
| transcrição, remedida | **37%** | `whisper.cpp` + `ggml-small-q5_1`, **os mesmos arquivos e trechos** |
| varredura com as etapas 1 e 3 | 16 músicas em **~2 min** (7 s/música) | uso em campo da v0.9.0 |
| etapa do som | **2 s/música** | campo; a estimativa dizia 0,3 s — **erro de 7×** |
| densidade que separa instrumental de letra | instrumentais 0,07 e 0,08 c/s; letras mais magras 1,22 / 2,81 / 3,10 | mesma execução; piso fixado em 0,30 |
| mock × backend | **17 divergências em 62 textos** | tabela de `is_placeholder` portada caso a caso |
| conferência de SHA-256 do modelo | **422 ms** para 512 MB → **2,3 µs** | release, SHA-NI, cache de páginas quente; memorizada por (caminho, mtime, tamanho) |

O **37%** é o número mais importante da janela, e ele é uma reprovação: os 78%
foram medidos com outro motor, e *a prova não viaja junto quando o código é
reusado*. O arnês de remedição (`src-tauri/tests/remedicao.rs`) roda o **mesmo**
`transcricao::transcrever` do produto e procura o trecho com o **mesmo** FTS5 —
reimplementar a medição em Python mediria outra coisa, que é exatamente o tipo
de "outra coisa" que produziu o número que estava sendo remedido.

### A família de defeito que este projeto encontrou cinco vezes

Não é coincidência, e é o que o relatório tem de mais útil para quem chega de
fora: **cinco vezes a especificação estava certa, o código estava certo, as
suítes estavam verdes, e o produto estava errado** — porque o pedaço que ligava
as duas pontas ninguém tinha escrito, ou porque nenhuma suíte alcançava o lugar
onde o defeito morava.

1. **O `vad_filter` que destruía 35% das transcrições** (0.6.0, já descrito
   abaixo): não era o modelo, era configuração — o VAD é detector de *fala* e
   descartava canto com instrumentação antes de o modelo ouvir.
2. **O aplicativo que congelava** (0.8.1): comando síncrono do Tauri roda na
   thread principal, que é a que desenha a janela. As varreduras, a indexação e
   a gravação em lote paravam a repintura inteira. Relatado em campo como *"não
   vi barra de progresso em lugar algum, só o cursor rodando"* — **a barra
   existia**, os eventos eram emitidos e o E2E os cobria, porque o E2E roda
   contra o mock no navegador, onde não há thread principal do Tauri para
   bloquear. Quatro suítes verdes, 205 testes de Rust, e nenhuma delas podia
   pegar isto.
3. **A chave que nunca chegava ao binário** (0.9.0): o código lia `option_env!`,
   que é variável de ambiente **em tempo de compilação**, e segredo de
   repositório não vira variável sozinho. **O passo do CI que punha o valor lá
   nunca foi escrito.** Toda build saía sem chave — o que desligava a etapa do
   som, o que marcava o acessório como indisponível, o que recusava o download:
   a entrega inteira nasceria inerte. Nenhuma suíte veria, porque todas injetam
   a chave nos testes.
4. **A tag sem o bump de versão** (0.9.0): o `latest.json` sai com a versão do
   `tauri.conf.json`, não com a tag. Taguear `v0.9.0` sobre um `0.8.1` esquecido
   publicaria um manifesto dizendo 0.8.1, o updater compararia `0.8.1 > 0.8.1`,
   daria falso, e a release ficaria **publicada e invisível** — ninguém
   atualizaria e ninguém perceberia, porque não há suporte a quem perguntar.
   Aconteceu, e só não saiu porque o QA pegou. **Lembrança não é mecanismo**: o
   fluxo passou a recusar a publicação quando a tag não bate com os três
   arquivos de versão.
5. **O teste de fumaça que "passava" sem passar o modelo** (0.10.0): sem `-m`, o
   `whisper-cli` procura um `models/ggml-base.en.bin` inexistente e sai com erro
   **antes de olhar o áudio**. Os três sistemas "falharam" no WAV e o passo do
   MP3 "passou", os dois pelo mesmo motivo — e a pergunta que o teste existe
   para responder nunca chegou a ser feita. Chegou a reportar "MP3 aceito"
   quando o binário nem tinha aberto o arquivo. **Teste que erra por fora do que
   mede não mede nada: verde e vermelho igualmente sem significado.**

A resposta de processo foi um **fluxo de fumaça que baixa, confere e roda** cada
acessório sobre um MP3 real em macOS, Windows e Linux — porque hash prova que
baixou o arquivo certo, não que ele executa.

### O mock que certifica o contrato errado — quatro vezes

Os E2E rodam o frontend no Chromium com o IPC mockado. Isso é deliberado e está
documentado desde a V1, mas cobra um preço: **um mock que discorda do backend
faz o E2E certificar o contrato errado**, e passar. Aconteceu quatro vezes nesta
janela, e as quatro são diferentes entre si.

1. **Regra velha** (0.8.0): o mock trazia a regra antiga do instrumental, o
   portão do Vagalume **invertido** (consultando quando falta artista, e
   propondo nome novo — exatamente a falha "Lampejo × Roberto Carlos") e
   comparação de obsolescência sem aparar espaço. O E2E passava exercitando
   chamadas que o backend real nunca faria. O caso em que as três implementações
   discordavam — instrumental sem artista — **não tinha teste em lugar nenhum**.
2. **O backend errado** (0.8.0): investigando outra discordância, quem estava
   certo era o mock. É o item 3 da lista acima.
3. **Deriva medida** (0.9.0): o `isPlaceholder` do mock era a versão anterior ao
   porte completo e já sustentava quatro regras novas. Rust × mock:
   **17 divergências em 62 textos**. Faltavam as duas metades que o porte mandou
   existir e sobrava a regressão que ele mandou tirar ("Pista" sozinha).
4. **Por omissão** (0.10.1): quando o segundo modelo entrou no catálogo,
   `src/lib/api.ts` continuou declarando três nomes de acessório e o mock
   continuou listando três. **Nada quebrava** — a lista vem do backend em tempo
   de execução e a tela desenha um cartão por item —, mas o tipo passou a
   descrever *menos* do que o backend devolve. É a divergência mais difícil de
   ver, porque não há um caso errado: há um caso ausente.

A resposta foi um `mockBackend.contrato.test.ts` que fixa, caso a caso, a tabela
que o Rust produz — e a metade comportamental, que prova que cada regra **chega**
ao ponto do funil que depende dela.

### O que continua em aberto, e é honesto dizer

1. **Windows nunca foi usado por uma pessoa.** Toda medição de campo desta
   janela veio do Mac M2 do dono do produto; o único Windows que o projeto tocou
   é runner de CI (build do instalador e fumaça dos acessórios). O `.msi`/`.exe`
   sai do `release.yml` e ninguém o instalou.
2. **O aplicativo não é assinado**, e a primeira coisa que cada pessoa faz é
   abrir o **Terminal** para rodar `xattr -cr /Applications/Cancioneiro.app`
   (macOS) ou clicar em "Executar assim mesmo" no SmartScreen (Windows). Isto
   **contradiz diretamente** a promessa que organizou as versões 0.8 a 0.10 —
   *nunca mais um terminal* — e a contradição está na primeira página do guia de
   instalação. Resolver custa Apple Developer ID + notarização e certificado de
   code signing; não foi feito.
3. **A transcrição engole estrofes.** O `ggml-small-q5_1` classifica trecho
   *cantado* como música e devolve `[música]`, `[Música]`, `[MÚSICA DE FUNDO]`,
   `[cantarolando]` no lugar do verso — numa faixa, quatro estrofes inteiras
   sumiram. Não é falta de idioma (`--language pt` está sendo passado, com teste
   varrendo a linha de comando). E uma letra com buraco **tem letra**: some da
   fila para sempre e não é encontrável pelo pedaço que a pessoa lembra, que é o
   produto inteiro. O `ggml-medium.bin` entrou por causa disso, **como medição
   em curso e não como desenho**: dois modelos no catálogo é estado temporário,
   declarado em três lugares, e assim que o arnês rodar com os dois nos mesmos
   arquivos **um dos dois sai**.
4. **O `lyrics.ovh` é a única fonte do funil cujo casamento não é verificável.**
   Ele não devolve título nem artista, então não há segundo lado a conferir. Se
   fizer casamento aproximado por dentro, pode devolver a letra de "Ponto de
   Ogum" para um pedido de "Ponto de Oxum" **e o programa não tem como
   perceber**. O que compensa é pouco e de propósito: só se consulta com título
   e artista reais, título composto é recusado, o teto é MÉDIA (logo, nunca
   pré-marcada) e a proposta não troca nome nenhum. **A prova, aqui, é o olho de
   quem revisa.**
5. **O macOS perdeu aceleração por hardware.** O `whisper-cli` saiu universal
   (um arquivo, dois processadores) porque o runner Intel do CI ficava
   eternamente na fila — três execuções nunca começaram. Metal e Accelerate não
   compilam para x86_64 no mesmo binário: a transcrição é mais lenta no Apple
   Silicon do que precisaria ser. Escolha consciente — binário lento é melhor
   que binário que não roda em metade das máquinas.
6. **Dívidas anotadas com dono, não resolvidas em silêncio**: o
   `tools/curadoria.py` carrega o mesmo defeito de `is_placeholder` sem *slot*
   que o Rust corrigiu (uma música chamada "Diversos" valeria vazio), e ficou de
   fora por escopo — ele é ferramenta de terminal do dono do produto e não vai
   para as 40 máquinas, mas o dano é o mesmo dentro do arquivo dele.

---

> **Atualização V14 (0.12.0):** montar playlist deixou de exigir sair da
> playlist. Veio de um beta tester ("abre uma tela vazia") e o dono acrescentou
> como ELE usa: playlists são sequências para tocar numa ocasião — logo a ordem
> importa, e acrescentar é atividade contínua, não só do primeiro dia.
>
> Por isso o painel fica no topo **sempre**, e não só na tela vazia, e cada
> música clicada vai para o FIM, na ordem dos cliques. A busca é própria do
> painel: se fosse a da biblioteca, montar playlist bagunçaria o que a pessoa
> estava procurando na outra tela.
>
> Três formas de acrescentar, porque são três situações: **buscar** (lembrei
> desta música), **por tema** (quero tudo de São João) e **arrastar** — que já
> existia desde a V5 e ninguém descobria; a tela vazia passou a ensinar.
>
> O "por tema" é o que só este produto pode fazer, porque só ele guarda tema
> dentro do MP3. Duas consultas novas, com duas decisões que o teste forçou: o
> tema casa **exato** ("Natal" não arrasta "Natalino" — lote errado é trabalho
> manual de desfazer), e a lista agrupa **ignorando maiúsculas**, porque num
> acervo curado à mão "Natal" e "natal" convivem e apareceriam como dois temas.
> A segunda só apareceu porque o teste da primeira mostrou a contagem quebrada.

---

> **Atualização V13 (0.11.1):** três pedidos pequenos, feitos direto e sem
> agente — a pedido do dono, que paga esta conta do próprio bolso e viu o custo
> subir demais para o tamanho das mudanças.
>
> Tocar da biblioteca passou a montar **fila** com a lista que está na tela (já
> filtrada por pasta e busca), para o botão de próxima funcionar fora de
> playlist. Renomear playlist ganhou comando no Rust, com a recusa de nome vazio
> **no banco** e não só na tela — playlist sem nome vira linha em branco na
> lateral, impossível de achar depois. E a lateral trocou "Nova playlist" por um
> **+** ao lado do título da seção, com Configurações descendo para o pé.
>
> **Duas coisas que a suíte pegou e que não eram teste velho.** A fila nova fez
> um clique numa música com arquivo ausente passar a tocar **outra**: o código
> decidia pular por "tem fila?", e pular sozinho é comportamento de PLAYLIST, não
> de lista. E eu havia posto o ✎ **dentro** do botão da playlist — clicável
> dentro de clicável, HTML inválido, que além de confundir leitor de tela fez o
> localizador do teste casar com dois elementos. Virou irmão.
>
> **V13.1 (0.11.2), no mesmo dia:** a fila da biblioteca fez a música seguinte
> emendar sozinha ao fim da faixa — e não era isso que se pediu. Emendar é
> comportamento de PLAYLIST, onde a pessoa montou uma sequência; na biblioteca
> ela pediu UMA música. O botão de próxima continua avançando nos dois casos. O
> que separa não é ter fila, é **quem pede**: a pessoa, ou o fim da faixa.

---

> **Atualização V13 (0.11.0):** a busca — a única coisa que este produto existe
> para fazer — passou a **somar** uma segunda leitura em vez de exigir a grafia
> exata. É a última mudança medida da janela, e a que mais mexe no propósito.
>
> **O problema, medido:** boa parte das letras do acervo foi escrita por máquina
> ouvindo o áudio, com erros. A busca exigia todas as palavras exatas — `dormir`
> não achava `dormi`, uma letra. Em 721 trechos de cinco palavras tirados de
> letras conferidas ouvindo, procurados nas transcrições das mesmas músicas, ela
> achava **30%**.
>
> **A armadilha que quase entrou.** A primeira versão tolerante pontuava palavras
> soltas e achava **79%** — número que parecia ótimo até o outro lado ser medido:
> **68 resultados por busca**, com a música certa em primeiro em 12% das vezes.
> Parede de resultado errado é tão inútil quanto tela vazia, e pior, porque
> parece que funcionou. O erro era de modelagem: o que alguém lembra é uma
> **sequência**, não um saco de palavras. Pontuando a sequência: **54%**, com 1,1
> resultado por busca.
>
> **E o que o dono achou antes de existir código.** Numa página de teste montada
> para ele experimentar, ele digitou `na minha casa se eu` — trecho real — e viu a
> busca de hoje achar e a nova não. Eu havia medido só o que a nova **ganha**,
> nunca o que ela **perde**: são **5 trechos em 721**. Pouco, e perder caso que já
> funciona não se negocia. A proposta virou **união**: tudo que a busca de hoje
> acha continua achando, e a tolerante acrescenta. **55%**, com risco de regressão
> zero por construção — não por medição.
>
> **Desempenho, o risco real.** A busca roda a cada tecla e o acervo tem 8.000
> músicas; percorrer 8.000 letras inteiras é inviável. O FTS5 escolhe candidatos
> (indexado, barato) e o Rust pontua só neles. Teto medido em release, 8.000
> músicas, pior busca do banco: 100→61 ms, **300→62 ms**, 1000→89 ms, 3000→159 ms,
> sem teto→358 ms. De 100 para 300 o custo não se mede, então 300 é alcance de
> graça; 3.000 encostaria no debounce de 150 ms.
>
> **Uma limitação que ficou escrita** em vez de escondida: erro na PRIMEIRA letra
> (`cantar`/`contar`) só é alcançado pelas outras palavras da consulta — o índice
> só procura prefixo, e palavra com o começo errado não vira candidata. Numa busca
> de uma palavra só, se perde.

---

> **Atualização V12 (0.10.9):** dois achados do dono usando a V11 num acervo de
> **~8.000 músicas** — a primeira vez que o produto foi visto em escala real.
>
> **A caixa de revisão ficava ilegível no escuro.** Uma linha: `bg-white` fixo no
> container do modal, enquanto o texto virava claro. O que importa aqui não é a
> linha, é **por que o guarda não pegou**: o teste que varre cor fixa procurava
> **hex**, e `bg-white` não é hex. Um guarda que cobre a forma errada do defeito
> dá a sensação de proteção sem a proteção. Ele passou a barrar também as classes
> do Tailwind, com duas exceções nomeadas e justificadas (a cortina `bg-black/40`,
> que funciona nos dois temas, e `text-white` sobre botão sólido).
>
> **A árvore de pastas com 8.000 músicas era impraticável** — tudo aberto ao mesmo
> tempo, num painel estreito. Virou acordeão: nasce fechada, a setinha abre, o
> clique no nome continua filtrando (não roubar a ação que já existia), e o estado
> persiste. Persiste **só o que foi aberto na mão**: a pasta que contém a seleção
> abre por derivação, e derivável não se guarda.
>
> **Duas lições de arnês nesta rodada, as duas minhas.** A primeira: o agente
> entregou o trabalho e **parou antes de as próprias suítes terminarem**, sem
> comitar — terminei a verificação por fora, mais barato que reacordá-lo. A
> segunda: ao caçar a falha, deixei **quatro execuções do Playwright rodando ao
> mesmo tempo**, disputando o mesmo `localStorage`; o placar foi de 2 falhas para
> 16 e eu quase diagnostiquei uma regressão que não existia. A execução limpa deu
> 2, e as duas eram do teste: a setinha nova (`aria-label="Abrir pasta acervo"`)
> fez o localizador por substring casar com dois botões. O rótulo do produto está
> certo — é o que um leitor de tela precisa ouvir —, então quem mudou foi o teste.

---

> **Atualização V11 (0.10.8):** tema claro/escuro, pedido pelos beta testers, e
> dois acertos de campo no editor.
>
> Todas as cores fixas do app viraram **tokens CSS**; o claro ficou idêntico ao de
> hoje e o escuro foi escrito à mão, não invertido — conferido contra AA em cada
> par texto/fundo que existe na tela. O seletor (Claro / Escuro / Automático,
> padrão automático) mora em Configurações → Aparência, e o tema é aplicado antes
> da primeira pintura, para não piscar claro ao abrir no escuro. Um teste varre
> `src/components/**` procurando cor fixa, para a regressão não voltar em
> silêncio.
>
> Os dois acertos vieram do dono usando a V10.11: **Enter no campo de tema
> gravava e FECHAVA o editor** ("acho que tem que manter"), e o dobramento em
> "+N", correto na linha da lista, atrapalhava no **editor**, onde a pessoa está
> justamente para ver e mexer em tudo. Enter agora grava e mantém a ficha aberta,
> com o campo limpo para o próximo tema; o botão "Salvar no arquivo" continua
> fechando, porque quem clica nele terminou. No editor, todos os temas aparecem.
>
> **Nota de custo, medida.** Esta rodada foi a primeira feita com a instrução
> explícita de gastar menos. O tema rodou em Sonnet e consumiu **411k tokens em
> 243 chamadas** — MAIS que os ~340k/168 da rodada anterior em Opus: modelo mais
> barato por token, mais idas e vindas. Já os dois acertos, com prompt enxuto e
> DECISIONS de 5 linhas, saíram por **136k**. O que corta custo é o tamanho do
> pedido e a cerimônia exigida, não a troca de modelo.

---

> **Atualização V10.11 (0.10.7):** a primeira versão feita a partir de relato de
> **beta testers de verdade** — dois, no Windows, os primeiros humanos a usar o
> produto fora do dono. O Windows funcionou: era o maior risco em aberto da
> janela inteira, e nenhuma suíte podia respondê-lo.
>
> **Limite de 10 temas: recusado.** Os testadores pediram; o dono disse não. Tema
> é o vocabulário da própria pessoa, e limite rígido bate em alguém no pior
> momento sem ninguém para explicar. O problema era de layout e ficou no layout:
> **3 chips antes do "+N"**, número que saiu de medição e não de gosto — 240 px de
> coluna útil no painel mais estreito, dividido pela mediana de 74 px dos temas do
> acervo real. Com folga de um: até 4 temas nada dobra, porque o "+1" tem quase a
> largura de um chip e cobraria um clique por nada.
>
> **Enter no campo de tema salva a ficha inteira.** O relato: a pessoa digita um
> tema e sai usando o app, e perde o que digitou. A alternativa óbvia — "Enter
> salva só o tema" — foi recusada: meia tela salvando sozinha é pior que nenhuma
> (corrige o título, digita um tema, aperta Enter, fecha: tema salvo, título
> perdido). Enter chama o mesmo `handleSave` do botão, inteiro.
>
> **O botão de transcrever voltou a aparecer em música que já tem letra**,
> revertendo a #167 com um caso concreto de campo: um testador abriu uma música
> cuja letra terminava em `[MÚSICA]` — letra de transcrição, imperfeita — e queria
> refazê-la. **O caso em que mais se quer transcrever de novo é justamente aquele
> em que já existe letra ruim.** A proteção nunca esteve em esconder o botão: está
> no `apply`, que recusa substituir letra sem consentimento (#79).

---

> **Atualização V10.10 (0.10.6):** pedida como "alguns pequenos ajustes", e um
> deles destampou o defeito mais consequente da janela.
>
> **O que se pediu.** Um botão que transcreve UMA música direto, sem antes pagar
> o funil de rede inteiro — porque neste acervo o funil quase nunca acha, e
> pagar segundos de rede para só então poder transcrever é pedágio. E dois
> consertos na mensagem de erro, propostos a partir de um relato: o dono clicou
> em "Buscar dados na internet" e recebeu **"sem conexão"** em vermelho, com a
> internet dele funcionando — ele tinha acabado de baixar 1,4 GB no mesmo app.
>
> **O que se achou.** "sem conexão" era o ramo de TRANSPORTE (DNS mudo, tempo
> esgotado, conexão recusada), que não é "sua internet caiu" e sim "este
> servidor não respondeu". A rodada da V9 já separara o caso em que o servidor
> **responde** com erro; ficara de fora o caso em que ele **não responde**. Mas
> a frase era o menor dos problemas: logo depois da etapa 2 havia um
> `if erro.is_some() { return }` que **abortava as etapas de letra**, e ele não
> distinguia origem nenhuma. **A falha do `fpcalc` — um programa LOCAL, que não
> diz nada sobre a internet — cancelava a consulta ao LRCLIB.** O `fpcalc` falha
> em faixa curta, gravação caseira silenciosa e arquivo de estrutura estranha,
> que é o perfil exato deste acervo; nas fixtures do projeto, medido, ele falha
> em **três de quatro** arquivos.
>
> Ou seja: música cuja impressão digital falhava saía da varredura **sem nunca
> ter sido perguntada às bases de letra**, e a linha vermelha acusava a internet
> de quem estava olhando. Desde a v0.9.0, atrás de uma frase que mandava a
> pessoa conferir o roteador.
>
> **O conserto.** O aborto passou a exigir **evidência**: duas fontes
> independentes mudas e nenhuma tendo respondido. Resposta HTTP de erro conta
> como "respondeu" — servidor vivo prova internet viva. E a frase diz de quem é
> o silêncio: *"o reconhecimento pelo som não respondeu"*, *"o site de letras
> não respondeu"*, e só com evidência *"a internet parece estar fora do ar:
> nenhum site respondeu"* — com a evidência dentro da frase, para a pessoa poder
> discordar dela.
>
> **A busca tolerante, medida dos DOIS lados.** A rodada anterior mediu o que
> ela ganha (30% → 54%) e nunca o que ela perde. O dono achou o buraco com um
> exemplo, na página de teste, antes de existir uma linha de código:
> `na minha casa se eu` — a busca de hoje acha, a nova não, porque a transcrição
> destruiu esse verso e a de hoje se safa por exigir as palavras em qualquer
> lugar em vez de na ordem. Medido: **5 trechos em 721 (0,7%)** se perderiam.
> Pouco — e perder caso que já funciona não se negocia. A proposta virou
> **somar** as duas em vez de trocar: **55%**, sem perder nenhum, com risco de
> regressão zero por construção e não por medição. Continua **fora** desta
> versão.

---

> **Atualização V10.9 (0.10.5):** a etapa 5 passou a existir **onde a pessoa
> está**, e não só onde a varredura termina.
>
> O buraco veio de uma pergunta do dono do produto — *"se eu buscar letra em uma
> música específica ele passa pelo processo inteiro só pra essa música hoje?"*. A
> resposta era: as etapas 1 a 4 sim, a 5 não. Então quem abria uma música, clicava
> em "Buscar dados" e não achava nada — **o caso típico**, com 3% de cobertura
> medida — ficava sem a única coisa que resolveria aquele arquivo, e tinha de sair
> para Configurações, onde a fila é a pasta inteira. É o mesmo erro de projeto que
> a V10.6 consertou na outra porta, e aqui a etapa 5 é mais usável do que em
> qualquer lugar: uma música são **minutos**, não horas.
>
> As três portas dividem um miolo só (`pendentes_entre`), e a oferta da ficha
> manda a fila de um item pelo `startTranscricao` que já existia — mesma barra,
> mesmo cancelamento, mesma revisão. Um segundo caminho seria um segundo lugar
> onde os três divergem.
>
> **O conserto que veio junto vale mais que a porta.** A ficha da música fica
> aberta **atrás** da revisão, com o campo de letra vazio — e "Salvar no arquivo"
> com o campo vazio **remove o USLT**. Seria o produto destruindo, num clique de
> hábito, o trabalho de minutos que ele acabou de fazer. O campo passou a ser
> preenchido quando está vazio, e só então: nada digitado é sobrescrito. Nenhuma
> suíte apontava para isso; ele apareceu porque alguém foi olhar o que a porta
> nova encostava.
>
> Junto, o aviso ao fechar a revisão com falhas de gravação na tela — que nasceu
> de uma frase literal do campo: *"não sei quais são as duas outras músicas, pq
> fechei a tela em seguida"*. A lista das músicas que não puderam ser gravadas é
> o que a pessoa precisa para agir, e evaporava.
>
> **A medição da busca, feita nesta rodada e ainda NÃO aplicada.** 721 trechos de
> cinco palavras tirados das letras conferidas ouvindo, procurados dentro das
> transcrições de máquina:
>
> | busca | acha | é o 1º | traz errada | resultados |
> |---|---|---|---|---|
> | a de hoje (tudo exato) | 30% | 30% | — | — |
> | tolerante por palavras soltas, 60% | 79% | 12% | 88% | **68** |
> | tolerante por **sequência**, 60% | **54%** | 52% | 20% | **1,1** |
> | tolerante por sequência, 80% | 43% | 43% | 0% | 0,4 |
>
> Os 79% são a armadilha: 68 resultados por busca e a música certa em primeiro em
> 12% das vezes — parede de resultado errado é tão inútil quanto tela vazia, e
> pior, porque parece que funcionou. O erro estava na modelagem, não no número:
> pontuar **saco de palavras** quando o que alguém lembra é uma **sequência**.
> Pontuando a sequência, 30% → 54% com 1,1 resultado.
>
> Fica com três ressalvas: os distratores são sintéticos (150 documentos
> embaralhando o vocabulário das três letras); o teto não é 100%, porque boa parte
> do que falta são versos que a transcrição perdeu inteiros; e a amostra é o
> material mais difícil do acervo. **A mudança não entrou nesta versão de
> propósito** — a busca é a função central do produto, e mexer nela na mesma
> versão que vai para os beta testers é risco que não se justifica.

>
> **Uma instabilidade de teste, registrada com nome e contagem.** O E2E
> `BUG v0.4: tema digitado SEM Enter é salvo ao clicar em Salvar` falhou **1 vez
> em 8 execuções completas** da suíte. Sozinho passa em 6 s. Duas hipóteses
> foram levantadas e **as duas caíram**: disputa de CPU (reproduzi a carga que
> existia na execução que falhou — cargo e vitest em laço — e a suíte passou em
> 2,2 min, a mesma duração da que quebrou) e resposta assíncrona fora de ordem
> na ficha da música (a guarda de corrida existe). Nenhum mecanismo identificado.
>
> A parte mais útil deste registro é o erro que **não** foi capturado. O
> `playwright.config.ts` já pedia `trace: "retain-on-failure"`, então o rastro
> completo daquela falha existiu no disco — e a execução seguinte, disparada
> para saber se reproduzia, o apagou antes de alguém olhar (o Playwright limpa
> `test-results/` ao começar). A resposta virou "1 em 8, sem mecanismo" quando
> podia ter sido a linha exata. Virou mecanismo: `pretest:e2e` arquiva o rastro
> anterior antes de cada execução. Lembrança não é mecanismo — de novo.
>
> Junto disso, duas falhas de instrumentação minhas no mesmo dia, pela mesma
> causa: um vigia de lançamento que reportou "20 min sem publicar" quando batia
> numa API que o proxy recusa (o lançamento estava publicado havia 19 minutos),
> e um `grep -c` cujo código de saída 1 para zero ocorrências foi lido como
> falha da verificação. **Ferramenta que confunde "não consegui olhar" com "não
> aconteceu" é o mesmo defeito que o produto tinha na mensagem que culpava o
> disco sem ter olhado para disco nenhum.**
---

> **Atualização V10.7/V10.8 (0.10.4):** a versão que vai para os beta testers, e
> ela saiu de **um relato de campo de sete linhas vermelhas**. Rodada a varredura,
> aplicadas as letras, sete músicas recusaram a gravação — e a tela disse duas
> coisas erradas ao mesmo tempo.
>
> **A primeira: o cabeçalho.** "7 músicas não puderam ser **consultadas**" — mas a
> consulta funcionara, elas tinham proposta e selo MÉDIA. Um grupo servia a dois
> desfechos e o título tinha de escolher uma das duas verdades; escolheu a errada
> justamente para o caso que apareceu em campo. Agora são dois grupos, e o da
> gravação usa o vocabulário do grupo das gravadas: são as duas metades do mesmo
> clique.
>
> **A segunda: a frase culpava o disco.** Oito variantes de erro do lofty caíam em
> "o arquivo pode estar danificado, ou o disco onde ele está pode ter sido
> desconectado". As oito são falhas de **parse**, com o arquivo já lido com
> sucesso — disco desconectado é `io::Error` e tem caminho próprio. A mensagem
> mandava a pessoa mexer no cabo do HD por um problema que não era do cabo, o que
> num produto sem suporte é o pior tipo de instrução: ela faz mexer no que está
> certo. Três frases no lugar de uma, e a parte do HD ficou só onde conferir o
> aparelho responde algo.
>
> **E a causa real, que a mensagem escondia.** Diagnóstico feito de fora, com um
> script de leitura rodado no acervo do dono e depois reproduzido contra o lofty
> 0.22 num projeto isolado: os arquivos têm uma região entre o **fim declarado da
> etiqueta ID3v2** e o **primeiro quadro MPEG** — 1.251 bytes, 81% zeros. O
> mecanismo exato está na fonte do lofty: `check_mpeg_or_aac` só procura o sync
> dentro de `DEFAULT_MAX_JUNK_BYTES` = **1.024**. Daí o modelo passar a
> **prever**: dos arquivos com sobra naquela pasta, os de 178, 220, 492 e 671
> bytes gravam; os de 1.154 e 1.251 falham. A leitura funcionava só por causa da
> extensão `.mp3` no nome — tirei a extensão e ela falhou também.
>
> **O conserto corrige o número, não o arquivo.** Dois a quatro bytes no campo de
> tamanho; nenhum byte removido, nenhum movido. O gatilho é a **falha**, nunca a
> suspeita: arquivo que grava normalmente não tem um byte examinado, o que torna
> o falso positivo inalcançável — e isso importa porque o meu próprio script de
> diagnóstico acusou de anomalia um arquivo **perfeito** (num MP3 do lame o
> primeiro quadro carrega o cabeçalho Xing/Info, e o detector ingênuo acha o
> segundo quadro). O áudio é **conferido, não prometido**: resumo SHA-256 antes,
> conferência depois, e se mudar um byte o arquivo volta ao que era e a gravação
> vira recusa. E o desfecho **diz** o que foi feito — sem pedágio antes, sem
> segredo depois.
>
> A decisão de fazer o conserto junto com a gravação, sem linha separada e sem
> clique a mais, é do dono do produto e contrariou a recomendação de quem
> escreveu isto. Ele estava certo: a pessoa já decidiu "grave esta letra neste
> arquivo", e perguntar "seu arquivo tem uma anomalia estrutural, posso corrigir
> 2 bytes?" é pergunta técnica para quem não tem como responder — o pedágio que a
> decisão 102 saiu para eliminar.
>
> **Uma dívida que virou fantasma, e sumiu.** Uma falha de teste vinha sendo
> tratada como teste instável e consumiu 22 execuções sem reproduzir. O agente
> desta rodada viu **duas** falhas juntas na linha de base, e duas ao mesmo tempo
> aponta recurso compartilhado, não relógio: o disco estava cheio, e os testes de
> `enrich.rs` copiam fixtures para um diretório temporário. Não era teste
> instável. Era espaço em disco naquele instante.

---

> **Atualização V10.6 (0.10.3):** a versão que vai para os beta testers, e ela
> existe por causa de **um relato de campo de uma frase**: rodada a varredura na
> biblioteca inteira, o dono clicou em "Aplicar selecionadas (28)" esperando
> transcrever em seguida — e a caixa fechou, levando a oferta de transcrição com
> ela. *"Agora tenho que começar de novo pra chegar na parte de transcrição de
> novo."* Minutos de varredura, jogados fora por um clique que parecia seguro.
>
> **O defeito era de projeto, e o meu.** Eu pendurei a oferta da etapa 5 no
> *resultado* da varredura, e resultado de varredura é efêmero. Mas "quais
> músicas estão sem letra" não é resultado de varredura — é **fato permanente da
> biblioteca**, e o banco sempre soube responder. Três correções, e a terceira é
> a que resolve de verdade: (1) aplicar não fecha mais a caixa — as linhas
> gravadas ficam na tela com selo **GRAVADA**, num grupo próprio no fim; (2)
> fechar com a oferta na tela **avisa** onde ela continua, informativo e não uma
> confirmação, porque com a terceira correção a lista deixou de se perder; (3)
> `transcricao_pendentes` responde quantas e quais a qualquer momento, e
> Configurações ganhou o bloco permanente.
>
> O conserto que a caixa aberta **obrigou**: o eco do `apply` passou a ser o do
> arquivo. Aplicar o nome e depois a letra da mesma música é o caso *típico*, e a
> segunda gravação seria recusada com "a música mudou depois da busca" — e mudou
> mesmo: mudamos nós, um clique antes. Duas linhas da mesma música no mesmo lote
> viram **uma** gravação, com o nome da linha de maior risco e a letra da linha
> que a traz, com a procedência dela.
>
> Uma afirmação do relatório da rodada foi conferida e **não se sustentou**: a
> condição do aviso ao fechar não é idêntica à que desenha a oferta — a tela
> também a desenha sem os acessórios instalados, e ali não avisa. O
> *comportamento* está certo (a revisão é aberta de dentro de Configurações, e
> fechá-la já devolve a pessoa à tela dos cartões de acessório), então o que se
> corrigiu foi o comentário. Invariante falso escrito no código é armadilha para
> quem ler depois.

---

> **Atualização V10.5 (0.10.2):** **a medição decidiu, e um modelo saiu do
> catálogo.** Contra a letra conferida **ouvindo a gravação** — não a publicada
> na internet —, em 83 trechos do tipo que uma pessoa lembraria, de 3 músicas do
> acervo real:
>
> | música | trechos | pequeno | grande |
> |---|---|---|---|
> | Cadê o Gato | 26 | 30% | 53% |
> | Girias do Norte | 17 | 29% | 52% |
> | Último dos Moicanos | 40 | 32% | 42% |
> | **total** | **83** | **31%** | **48%** |
>
> O `ggml-small-q5_1.bin` saiu: 190 MB a menos para baixar não compensam metade
> da encontrabilidade, e dois modelos no catálogo eram um pedágio de escolha
> disfarçado de opção. **Duas ressalvas ficam registradas junto do número**, e
> elas importam mais que ele: a amostra é o material **mais difícil possível**
> (pasta de humor, sotaque regional, palavras inventadas — "alavantuí,
> chã-de-dama anarrariê"), e das quatro estrofes que o modelo pequeno **pulava
> inteiras**, o grande recuperou **uma**. 48% não é "a letra sai certa": é "dá
> para achar a música".
>
> Na mesma rodada, os **três defeitos do download de 1,5 GB** que o teste em
> campo trouxe como três sintomas — parou, travou, funcionou na terceira — e que
> eram **um** defeito só: o download seguia rodando invisível depois de sair da
> tela, e o botão que reaparecia armava uma segunda gravação concorrente no
> mesmo `.parcial`. O diagnóstico que eu dei primeiro (mensagem de disco cheio)
> estava errado, e foi o agente que me corrigiu.

---

> **Atualização V10.1 (0.10.1):** rodada de **teste em campo** e de preparação
> para uma medição, não de recurso novo.
> **A remedição reprovou o modelo pequeno**: 37% de encontrabilidade contra os
> 78% do faster-whisper, nos MESMOS arquivos e trechos. O `ggml-medium.bin`
> (1,5 GB) entra como **segundo** acessório de modelo e a transcrição usa o
> preferido que estiver pronto — grande, senão pequeno, senão a etapa não
> existe. **Não há caixinha de seleção, e não vai haver**: "qual modelo de
> reconhecimento de fala você prefere" é a pior versão possível do pedágio que a
> decisão 102 saiu para eliminar. Os dois aparecem em Configurações porque a
> tela lista o catálogo.
> **Um MP3 do acervo real recusava toda gravação** com `Invalid frame language
> found: [0,0,0]` — e como toda tentativa falhava igual, a música saía da
> curadoria para sempre, em silêncio. A suspeita natural (modo de leitura do
> ID3) estava errada, e foi a medição que disse: nos três modos a **leitura
> passa** e a **regravação falha**. O quadro quebrado era um `COMM` alheio, dos
> que a decisão 41 promete preservar — a promessa estava certa e era ela que
> travava o arquivo. Conserto: `und`, o código que o próprio ISO-639-2 reserva
> para "idioma indeterminado". Quando dois quadros ficariam com a mesma chave
> depois do conserto, o produto **recusa a gravação** em vez de apagar a
> anotação de alguém.
> **Os erros de gravação passaram a falar português** — era a mesma família do
> M4 da v0.9.0, corrigida só no caminho do download; o caminho da gravação tinha
> o mesmo buraco, e era ele que aparecia em campo.
> **E a soma do modelo deixou de ser refeita a cada troca de pasta**: 422 ms
> medidos para 512 MB (SHA-NI, cache quente, release), ~1,2 s extrapolados para
> 1,5 GB, **2,3 µs** depois de memorizada por (caminho, mtime, tamanho). A
> garantia continua de pé — a primeira conferência de cada arquivo em cada
> sessão acontece de verdade, e a comparação com o catálogo acontece em toda
> pergunta. Há teste **contando** as leituras de disco: "não releu o arquivo" é
> afirmação sobre o disco, e afirmação sobre o disco se conta, não se deduz
> lendo o código.
>
> **O erro de processo desta rodada foi meu, e o comentário avisava.** Para
> acrescentar o modelo grande rodei o fluxo do transcritor, que reconstrói os
> três `whisper-cli` junto. O do Windows **não é reprodutível** (o MSVC carimba
> data e caminho no executável): ele voltou com soma diferente sem nada dele ter
> mudado, o catálogo passou a esperar um hash que o lançamento não serve mais, e
> no Windows a transcrição nasceria morta. **Aviso em comentário não é trava** —
> agora existe um fluxo que publica só o modelo, sem tocar em binário, e que
> recusa publicar por cima de um arquivo existente.

> **Atualização V10 (0.10.0):** a etapa que resolve, e o **caminho único**
> (`PRD-v10-transcricao-e-caminho-unico.md`).
> **A etapa 5** escreve a letra ouvindo o áudio, com `whisper-cli` +
> modelo quantizado baixados como acessórios. A pergunta não vai para o começo,
> onde é jargão: vai para o **fim**, quando o app já sabe o que faltou — *"sobraram
> 47 músicas sem letra; escrever a letra ouvindo o áudio leva cerca de 3 horas
> neste computador"*.
> **Os modos sumiram.** Uma varredura só, em todas as músicas da pasta. Com os
> 2 s/música medidos (contra 0,3 s estimados), separar "completar" de "conferir"
> custava 2 min e meio num acervo de 150 — e cobrava por eles que alguém que não
> sabe o que é terminal escolhesse entre dois nomes que não entende. Pior: a
> conferência era **a única coisa que achava etiqueta errada**, e recurso que
> depende de o usuário adivinhar que existe é recurso que não existe. O portão
> de completude não foi apagado, **mudou de lugar**: saiu da porta de entrada e
> virou o guarda das etapas 3 e 4.
> **A revisão passou a ser ordenada por RISCO, não por confiança** — conflitos →
> letras encontradas → trocas de nome escrito → o grupo dobrado dos
> preenchimentos. "Baixa confiança" juntava o mais seguro com o mais perigoso, e
> por isso parecia ruído: **confiança baixa não quer dizer "provavelmente
> errado", quer dizer "sem prova externa"**. Veio de um comportamento observado —
> *"nem li as sugestões em baixa, não deu vontade de ler mesmo"*, numa revisão de
> 53 músicas.
> **O Vagalume foi REMOVIDO, não desligado.** A API está descontinuada, o dono do
> produto nunca conseguiu a chave, e o módulo **nunca rodou contra o serviço
> real**: dezenas de testes verdes com o `fetch` injetado e zero contato. É a
> mesma confiança falsa do item 2 e do item 3 acima. "Só deixe de ser o padrão"
> foi recusado como reflexo de custo afundado — **existir custa mais que zero**:
> um campo de chave de API numa tela para 40 leigos, um parágrafo explicando o
> campo, um destino na lista de rede, e atrito em toda refatoração. Entrou no
> lugar o `lyrics.ovh`, **sem chave** — e fonte sem chave vem *antes* de fonte
> com chave, senão é o mesmo que não tê-la. Ganho de produto: **nenhuma etapa do
> funil exige credencial do usuário.** O que ficou foi a disciplina: a régua de
> casamento estrito mudou de casa em vez de sair junto, porque **fonte de letra
> sem duração é uma CATEGORIA**, não um fornecedor.
> **E o app passou a decodificar o MP3 em Rust puro** (`symphonia`, feature
> `mp3`) para entregar ao motor o WAV 16 kHz que ele sabe ler — em vez de
> entregar um MP3 e torcer. Não se depende do formato de entrada de um binário
> de terceiro: hash prova que baixou o arquivo certo, não que ele faz o que a
> gente precisa. O temporário nunca é criado ao lado do MP3, e a regra "nenhum
> arquivo é renomeado ou movido" ganhou o irmão que nunca havia sido escrito:
> **nada é CRIADO dentro do acervo.**
>
> **A duração que mentia voltou, por outra porta — e este é o achado da
> rodada.** A decisão 108 comemorou o fim do incidente dos 2365 s dizendo que
> contar amostras do decodificador é medição do áudio. É — **do pedaço que o
> decodificador resolveu entregar**. O `symphonia` liga `gapless` por padrão, e
> com ele o `num_frames`, que vem do contador do **Xing/Info**, vira o fim do
> fluxo. Ou seja: o número promovido ao topo da ordem de autoridade derivava
> exatamente daquele que a decisão 72 proíbe confiar. Medido nas fixtures deste
> repositório, dez cópias emendadas (**30,3 s** de áudio) com o contador da
> primeira dizendo 116 quadros: **3,00 s**. Contador adulterado para 78:
> **2,04 s**. Corrigido para 1160: **30,30 s**. O arquivo que expõe isso não é
> exótico — é o que `cat a.mp3 b.mp3 > set.mp3` produz, e todo player toca
> inteiro. Os dois desfechos eram **permanentes**. Conserto: `gapless` desligado,
> o cabeçalho virou **piso** (decodificar muito menos que o declarado marca a
> leitura como incompleta; decodificar mais não acusa nada, porque quem estava
> errado era o cabeçalho) e o número que o motor anuncia corrobora só nessa
> direção. **É corroboração usada só no sentido em que ela é sólida.**
> O mesmo QA achou um `Err(_) => break` no laço da decodificação com um
> comentário verdadeiro sobre fluxo truncado — que engolia **falha de I/O**: HD
> externo que dorme, pen drive arrancado, compartilhamento que cai. Medido:
> **30,56 s de áudio viravam 8,05 s**, sem erro e sem aviso. Em 40 máquinas
> alheias esse é o modo de falha mais comum do parque, e nenhuma suíte o
> alcançava.

> **Atualização V9 (0.9.0):** a máquina de acessórios, provada no barato
> (`PRD-v9-acessorios-e-funil-completo.md`).
> **O funil virou duas fases**, porque a impressão digital estava ordenada no
> meio das fontes de letra e isso era erro de categoria — ela não devolve letra,
> devolve **identidade**. Também sai mais barato: sem nome conhecido são até 7
> consultas ao LRCLIB, uma por palpite; com o nome verdadeiro é **uma**.
> **E a inversão criou um risco novo, que está escrito**: o AcoustID e o LRCLIB
> conferem pela MESMA evidência — duração. Quando o primeiro erra, o segundo
> **confirma** o erro e devolve ALTA. Não são duas contas independentes; é a
> mesma conta feita duas vezes. Daí a régua de aceitação do AcoustID não ser
> afrouxável, nome recusado por ela não vazar para a fase B, e letra achada por
> nome vindo do som ter **teto MÉDIA**. Não temos taxa de falso positivo do
> AcoustID neste repertório — os 16% são acerto, não é o mesmo número — e **isso
> só se reverte com medição, não com argumento.**
> **Etiqueta ERRADA virou modo de falha próprio.** Caso real: "Te ver feliz, te
> ver contente / Caetano Veloso" que é "Viver Feliz" do Nilson Chaves. Nada ali é
> placeholder, então a música era julgada completa e o erro ficava invisível
> **para sempre** — e quem não conhece o repertório nunca desconfia; a música só
> não aparece quando procuram. Duas populações que o projeto tratava como uma:
> nunca publicada (só a transcrição resolve) e publicada mal etiquetada (todas as
> bases têm; nós é que procurávamos pelo nome errado).
> **Baixar e executar binário exige provar três coisas separadamente**: que
> baixou, que é o arquivo certo, e que **executa**. Hash cobre as duas primeiras
> e não diz nada sobre a terceira — o macOS recusa executável sem assinatura, com
> regra mais estrita no Apple Silicon. Daí o fluxo de fumaça que baixa, confere e
> **roda** o acessório sobre um MP3 real em cada sistema.
> Provar a máquina nova com 3–5 MB de `fpcalc` antes de confiar nela com 180 MB
> de modelo era o ponto da versão: **o risco desta fase estava no downloader, não
> no `fpcalc`.**
>
> **O QA reprovou a 0.9.0 por dois fatos fora do código de produto** — a chave
> que não chegava ao binário e a tag sem o bump, ambos descritos acima. Ambos
> teriam publicado uma versão que existe e não funciona, e nenhuma suíte os
> alcançava. **Especificação e implementação podem estar certas e o produto
> errado, se ninguém escreveu o pedaço que liga as duas.**

> **Atualização V8 (0.8.0 / 0.8.1):** a premissa do produto mudou no meio do
> projeto (`PRD-v8-instrumental-e-funil-no-app.md`), e com ela quase tudo.
> **A curadoria mudou de dono**: não é um curador preparando acervos para os
> outros — são ~40 pessoas curando cada uma o seu, e acervos que o dono do
> produto não pode nem olhar. O funil saiu do `tools/curadoria.py` e entrou em
> **Configurações**; o ✎ saiu da árvore de pastas no mesmo lançamento (nunca
> antes, ou haveria uma versão sem varredura em lugar nenhum), porque a lateral é
> para navegar e um botão que dispara horas de processamento no meio da navegação
> é convite a clique acidental.
> **A F17 (marca de instrumental)**, entregue na 0.7.0, resolveu a pendência
> eterna: música sem voz entrava em toda varredura, transcrevia vazio, virava
> erro e era tentada de novo para sempre. A marca vai no próprio MP3
> (`TXXX:INSTRUMENTAL`), e a **escolha humana vence a rotina** — nem `--forcar`
> nem `--forcar-tudo` desmarcam.
>
> **Cinco defeitos desta janela que valem mais que os recursos:**
> 1. **Letra que já existe não se apaga sozinha** (CRÍTICO): uma música com tag
>    "AudioTrack 03" e uma transcrição corrigida à mão casava no LRCLIB pela
>    duração e saía ALTA — e ALTA chega pré-marcada. Um clique destruía a
>    transcrição e a procedência. Substituir letra virou **segunda marcação,
>    separada, desmarcada por padrão, que o "Marcar todas" não toca**. Porte
>    tardio de uma trava que a linha de comando tinha desde sempre e o app nunca
>    teve.
> 2. **O botão do produto ficava cinza**: a contagem de candidatas em TypeScript
>    afirmava espelhar a do Rust e não espelhava em três casos — e como ela
>    desabilitava o botão, o único ponto de entrada do produto dizia "não há nada
>    para procurar" justamente nos acervos que mais precisavam (CD ripado com
>    "Faixa 01…12", pastas de instrumentais sem artista). A contagem virou
>    comando sobre a MESMA função da varredura. **Regra duplicada em duas
>    linguagens diverge, e a divergência escolhe o pior momento para aparecer.**
> 3. **Título que o indexador inventou não é etiqueta**: o `indexer.rs` copia o
>    nome do arquivo para o `title` quando falta TIT2, e o funil lia isso como
>    etiqueta REAL — a etapa que se chama "nome do arquivo" não entregava nada
>    justamente para quem não tem tag nenhuma. Achado ao investigar por que o
>    mock e o Rust discordavam: **os dois lados de uma divergência merecem
>    suspeita, e desta vez quem estava errado era o backend.**
> 4. **Porte parcial é porte errado, e o pedaço que falta é sempre o que ninguém
>    testou**: `unescape_html` tinha 13 entidades e nenhuma das que importam em
>    português — `Cora&ccedil;&atilde;o` entrava literal na letra e no índice. Ao
>    completar o porte apareceu o oposto: o Rust passou a marcar **"Pista"
>    sozinha** como placeholder, e "Pista" é título real no repertório.
> 5. **A duração que mentia** (0.7.0, CRÍTICO): sem cabeçalho Xing o mutagen
>    estima pelo primeiro quadro — **300 s reais viraram 2365 s**, e uma música
>    cantada foi marcada instrumental para sempre, num produto cujo único desfazer
>    era um comando de terminal. **Margem de segurança não protege contra erro de
>    ordem de grandeza; só corroboração protege.** (E voltou na V10, por outra
>    porta — ver acima.)
>
> **A 0.8.1 existe por causa de um único defeito**, e ele é o mais instrutivo do
> projeto: o app congelava porque comando síncrono do Tauri roda na thread
> principal. A regra ficou escrita no `commands.rs` — comando que faz rede,
> percorre disco ou escreve arquivo é `#[tauri::command(async)]`.

> **Atualização V7 (0.7.0):** rodada curta, três coisas, todas vindas do acervo
> real.
> **Marca de instrumental (F17)**, **busca por nome de arquivo** (coluna nova no
> fim da FTS — no FIM porque o trecho destacado sai por POSIÇÃO, e inserir no
> meio faria a busca citar o campo errado em silêncio) e o conserto da duração.
> **Dois defeitos que só o modelo `small` revelou**, depois que ele substituiu o
> `tiny`: transcrição quase vazia era gravada como letra e matava a F17 — com o
> `tiny` as instrumentais voltavam vazias e a marca funcionava; o `small` devolve
> ruído, **13 caracteres para 2m55s, 29 para 6m20s**. Isso ia para o índice de
> busca e, pior, o arquivo passava a "ter letra", então todas as etapas seguintes
> o pulavam para sempre. O critério virou densidade, calibrado nos números reais
> (instrumentais 0,07 e 0,08 c/s; letras legítimas mais magras 1,22, 2,81 e 3,10;
> piso em 0,30, quase no meio geométrico do vão). **A margem é simétrica de
> propósito, mas os erros não são**: falso positivo tira uma música real da fila
> para sempre.
> E a **identificação pelo refrão saiu do caminho padrão**, com o número que a
> condenou: duas execuções de 94 arquivos deram 0 e 1 identificações, e a única
> estava **errada e foi aplicada** ("Barco Valente" virou "Não aguento mais /
> Raça Negra", porque o refrão transcrito foi a frase genérica "não aguento",
> que obviamente está na letra de uma música com esse nome). **A prova que
> criamos passa de graça em frase genérica.** Ela nunca entrou no aplicativo —
> e a consequência é melhor que a regra que se pediria: sem nome vindo daí,
> "transcrição nunca sobrescreve etiqueta real" não precisa de mecanismo nenhum.
> **Recurso que erra metade do que produz não entra num produto sem suporte; a
> parte dele que só informa, entra** — o refrão continua sendo extraído para
> mostrar uma linha a quem vai conferir 47 letras escritas por máquina.

> **Atualização V6.1 (0.6.0):** rodada guiada inteiramente por medição no
> acervo real do usuário, não por especulação.
> **Vagalume** entra como segunda fonte de letra depois do LRCLIB — comunitária
> e brasileira, cobre o repertório regional que o LRCLIB não tem.
> **Nome do arquivo visível** na lista e no painel: as coordenadoras se
> organizam por nome de arquivo há anos, então é soma, não troca — e serve de
> rede de segurança quando a identificação automática erra o título.
> Suítes na 0.6.0: **557 pytest + 106 cargo + 369 vitest + 22 E2E**, `tsc` e
> `cargo check` sem avisos.
>
> **Três defeitos que só o acervo real revelou**, e que resumem o que este
> projeto aprendeu:
> 1. `vad_filter=True` na transcrição destruía 35% dos arquivos em silêncio —
>    o VAD é detector de *fala* e, sobre canto com instrumentação, descartava o
>    áudio antes de o modelo ouvir. Não era o modelo: era configuração errada.
>    Corrigido, a transcrição saltou de 42 para 71 arquivos, e de 33 vazios
>    para 2 (justamente os instrumentais).
> 2. Identificação pelo refrão casava com confiança e errado ("Lampejo" virou
>    "Vou Chegar Mais Cedo em Casa / Roberto Carlos"). Título parecido com
>    duração próxima não prova nada; a prova passou a ser objetiva — **o refrão
>    ouvido tem de estar na letra devolvida**.
> 3. O Vagalume gravou a letra de "Ponto de Ogum" numa música "Ponto de Oxum",
>    rotulada como oficial. A causa raiz foi transferência indevida de
>    contexto: a tolerância de grafia fora afrouxada para o LRCLIB, **onde a
>    duração confirma o casamento**, e foi reusada numa fonte que não tem
>    duração. Cada fonte passou a ter a rigidez que suas próprias provas
>    sustentam.
>
> A conclusão que atravessa as três: **um palpite automático vale o que vale a
> prova que o confirma** — e a prova não viaja junto quando o código é reusado.

> **Atualização V5/V6/V7 (0.5.0):** três frentes fechadas depois do teste em
> acervo real.
> **V5 — Transcrição local** (`PRD-v5-transcricao.md`): `curadoria.py
> transcrever` tira a letra do próprio áudio (faster-whisper, dependência
> opcional) e, antes disso, tenta **identificar a música pelo refrão** — a
> frase mais repetida do trecho costuma ser o título, e confirmada pela duração
> no LRCLIB traz título, artista e letra oficiais sem transcrever o resto. O
> player exibe uma ressalva discreta em letra transcrita, que some quando
> alguém revisa o texto.
> **V6 — Impressão digital acústica** (`PRD-v6-impressao-digital.md`):
> `identificar` (Chromaprint/AcoustID) custa 1–2 s por música contra 30–80 s da
> transcrição, e é o que torna viável um acervo de 10 mil arquivos. Fecha o
> funil por custo crescente: tags/nome → LRCLIB → impressão digital →
> transcrição, cada etapa recebendo só o que a anterior não resolveu.
> `estimar` projeta o tempo de cada etapa antes de encarar horas de máquina.
> **V7 — Atualização automática** (`PRD-v7-atualizacao.md`): o app verifica ao
> abrir, baixa em segundo plano e avisa; instalar e reiniciar só a pedido, e
> todo caminho de falha é silencioso. Revisa o princípio "nenhuma rede em
> runtime" — sem telemetria, sem conta, sem nada do acervo saindo da máquina.
> Suítes na 0.5.0: **403 pytest + 106 cargo + 341 vitest + 20 E2E — todas
> verdes**, `tsc` e `cargo check` sem avisos.
>
> **A lição desta rodada, registrada nas decisões 51-61:** um palpite derivado
> do áudio não prova nada. O `enriquecer` era seguro porque o palpite nascia da
> própria tag; o refrão vem do áudio, e o QA cético reproduziu o estrago —
> alucinação do motor ("música", "obrigado por assistir") casando a duração por
> acaso e gravando título, artista e letra errados sobre tags boas. Daí as
> travas que hoje valem para toda identificação automática: lista de
> alucinações descartada antes da consulta, candidato precisa de substância,
> **tag real nunca sobrescrita em nenhuma confiança**, e divergência entre tag
> e identificação vira `CONFLITO` sem gravar nada.

> **Atualização V4/V5 (0.4.0):** o teste em acervo real (94 MP3s de repertório de
> nicho, Mac M2) guiou duas rodadas de evolução.
> **V4 — Curadoria no player** (`PRD-v4-curadoria-no-player.md`): edição de
> título/artista/letra/temas gravando direto no MP3, "Buscar letra na internet"
> (LRCLIB) e **árvore de subpastas** na lateral. O princípio "o player nunca
> escreve" foi revisado para **"a reprodução nunca escreve"** — gravação só em
> ação explícita, só tags ID3, nunca o áudio e **nunca o nome do arquivo**.
> **V3 — Enriquecimento** (`tools/curadoria.py enriquecer`/`temas-de-pastas`):
> identifica a música pelo nome do arquivo confirmando no LRCLIB pela duração
> (±3s = alta), trata valores de ripador ("Faixa 8", "no artist") como campo
> vazio dos dois lados, e transforma nome de pasta em tema.
> **v0.4** (`PRD-v5-backlog.md`): **busca por nome de pasta** (F12 — coluna
> `pastas` na FTS, migração de schema v1/v2→v3 atômica) e **"Completar dados
> desta pasta"** (F13 — identificação em lote dentro do app, com revisão por
> checkbox, ALTA pré-marcada, aplicação que nunca apaga nem aborta no meio),
> além de ajustes de UX vindos do uso real (tema pendente entrava perdido ao
> salvar, botão × na busca, ordem da linha, estado de carregamento).
> Suítes na 0.4.0: **237 pytest + 78 cargo + 252 vitest + 17 E2E — todas verdes.**
> QA cético independente reprovou a primeira volta da v0.4 (varredura da pasta
> "1" alcançava a pasta "10"; lote abortado dessincronizava tela e disco;
> atalhos globais vazavam sob o modal) — os três defeitos foram corrigidos com
> teste de regressão antes da release.
>
> **Descoberta que define a v0.5:** no acervo real o LRCLIB cobriu ~3% do
> repertório (música de nicho não existe nas bases públicas). Por isso a próxima
> versão traz **transcrição local de áudio** (Whisper) como fonte de letra e de
> identificação para o restante do acervo.

> **Atualização V2 (0.2.0):** após a entrega V1 abaixo, o projeto ganhou:
> **V2.1 — Temas** (tags temáticas embutidas no MP3 via TXXX:TEMAS, busca sem
> acento e chips clicáveis; spec em `PRD-v2-temas.md`), **V2.2 — Curadoria em
> massa** (`tools/curadoria.py`: relatório do acervo + CSV, edição em massa via
> planilha e busca de letra no LRCLIB — só na curadoria; o player segue 100%
> offline), **ícone próprio**, e **CI/CD no GitHub Actions** (`ci.yml` roda a
> suíte a cada push; `release.yml` publica instaladores Windows/macOS/Linux em
> GitHub Releases a cada tag `v*`). Correções relevantes pós-V1 descobertas em
> teste real: botão "▶ Tocar" inicia a música selecionada (F4, fluxo 2) e botão
> "+" visível na linha selecionada (acessibilidade touch/teclado).
> Suítes na V2.2: **88 pytest + 35 cargo + 133 vitest + 11 E2E — todas verdes.**
> Cada fase da V2 passou por QA cético independente com veredito APROVADO.

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
