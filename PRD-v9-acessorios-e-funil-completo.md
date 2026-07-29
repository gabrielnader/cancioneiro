# PRD V9 — Os acessórios sob demanda e o funil completo (F18 fase 2)

Continuação direta da F18. A fase 1 tirou o terminal do caminho para tudo que
não precisa de acessório (tags/nome, LRCLIB, Vagalume). Esta fase fecha a
promessa: **nunca mais um terminal**.

## O que mudou desde o PRD V8

Três coisas vieram do uso real da v0.8.0/v0.8.1 e mudam o desenho.

### 1. O funil deixa de ser uma fila e vira DUAS FASES

O desenho anterior era uma fila única ordenada por custo crescente, com a
impressão digital no meio das fontes de letra. Isso é um erro de categoria: a
impressão digital **não devolve letra nenhuma**. Ela devolve **identidade** —
que é *entrada* de todas as outras etapas.

São duas fases:

**Fase A — que música é esta?**

| # | etapa | custo | o que faz |
|---|---|---|---|
| 1 | tags + nome do arquivo | instantâneo | palpite local |
| 2 | impressão digital (AcoustID) | ~0,3 s | título e artista pelo SOM |

**Fase B — qual é a letra dela?**

| # | etapa | custo | o que faz |
|---|---|---|---|
| 3 | LRCLIB | ~0,5 s | letra, conferida pela DURAÇÃO |
| 4 | Vagalume | ~0,5 s | letra, casamento estrito de texto |
| 5 | transcrição (whisper.cpp) | minutos | letra ouvindo o áudio |

Quando a fase A produz nome confiável, a fase B parte DELE. Senão, parte da
cascata de palpites locais, como sempre.

**Isto também sai mais barato**, e não só mais correto: sem nome conhecido, o
`gerar_palpites` produz até 7 palpites e cada um é uma consulta ao LRCLIB com
pausa de cortesia. Com o nome verdadeiro, é **uma**. Trocamos décimos de
segundo de CPU local (o `fpcalc` lê só os primeiros ~120 s do áudio) por até
seis idas à rede evitadas.

Uma versão anterior deste PRD previa um RETORNO (voltar às etapas de letra
depois da impressão digital). A ordem por fases resolve o mesmo problema sem
o ciclo, e some com ele.

**O risco que a mudança cria.** Com o AcoustID na frente, um erro dele
contamina tudo o que vem depois: com título/artista errados, o LRCLIB acha a
letra da música errada e devolve **ALTA**, porque a duração vai bater — as
duas fontes casam por duração e erram juntas, de forma consistente. Letra
errada com aparência de certa. É a família do "Ponto de Ogum" dentro de
"Ponto de Oxum" (decisão 63), com um multiplicador. Portanto: **a régua de
aceitação do AcoustID não é afrouxável**, e nome recusado por ela não vaza
para a fase B.

Vale nas duas telas: na varredura por pasta e no botão de uma música só.

### 1b. Etiqueta ERRADA é um modo de falha distinto de etiqueta faltando

Caso real: arquivo etiquetado "Te ver feliz, te ver contente" / "Caetano
Veloso" que é, na verdade, "Viver Feliz" do Nilson Chaves. Nada ali é
placeholder, então o funil considera a música **completa** e ela nunca mais
entra em varredura: o erro é invisível para sempre. E quem não conhece o
repertório — as outras 39 pessoas — nunca vai desconfiar; a música só não
aparece quando procuram.

Duas populações, que o PRD vinha tratando como uma:

- **nunca publicada** (gravação de casa, de sessão): base nenhuma tem, só a
  transcrição resolve;
- **publicada e mal etiquetada**: todas as bases têm — nós é que procuramos
  pelo nome errado.

A etapa 2 é a única capaz de resolver a segunda, porque ignora as etiquetas e
pergunta ao som. Por isso existe um **modo de conferência**: uma varredura em
que o filtro de completude não se aplica e a fase A roda em todo mundo. É
trabalho distinto de "completar o que falta", com custo distinto, disparado de
propósito — não é o padrão.

Divergência entre o som e uma etiqueta REAL é **conflito**: mostra os dois
lados, não pré-marca nada, nunca corrige sozinha.

### 2. A chave do Vagalume passa a ser NOSSA

Pedir chave de API a quem não sabe o que é terminal era um pedágio absurdo, e
o campo por pessoa existia só porque a alternativa não tinha sido pensada.

- A chave entra no binário **em tempo de build**, a partir de um segredo do
  repositório (`VAGALUME_API_KEY`). Não fica no código-fonte.
- O campo de chave pessoal **continua existindo** e tem precedência: é a saída
  se a nossa for bloqueada algum dia.
- Build sem o segredo (desenvolvimento, fork) simplesmente não tem chave
  embutida — a etapa 3 é pulada em silêncio, como já é hoje.

**Assumido conscientemente**: chave dentro de programa distribuído não é
segredo — qualquer pessoa a extrai do binário. Aceito porque o estrago é
recuperável (chave nova numa atualização, em uma hora) e o ganho é 40 pessoas
que nunca veem uma tela de configuração.

### 3. As mensagens estão longas demais

Relatado no uso real: *"achando as mensagens muito longas no sistema"*. A copy
foi escrita para resolver "não há suporte para perguntar" e passou do ponto —
**texto que ninguém lê não explica nada**. Passe de redução em toda a copy da
curadoria, com uma régua: a primeira frase diz o que é; o resto só existe se
responder a uma pergunta que a pessoa realmente faria naquele momento.

## De onde vêm os binários

Nem `fpcalc` nem o transcritor cabem num instalador de 5 MB. Eles são baixados
na primeira vez que fazem falta.

**Publicados por nós, num lançamento à parte e ESTÁVEL** (`acessorios-v1`), não
a cada versão do app: o app fixa a tag, a URL e a soma SHA-256 de cada
arquivo. Rehospedar em vez de apontar para a origem nos dá três coisas que
importam quando não existe suporte: URL que não muda, hash sob nosso controle,
e uma origem só para explicar na tela.

| acessório | tamanho | quando |
|---|---|---|
| `fpcalc` (Chromaprint) | 3-5 MB | ao ligar a etapa 2 |
| `whisper-cli` (whisper.cpp) | ~1-30 MB | ao ligar a etapa 5 |
| modelo `small` quantizado (q5_1) | ~180 MB | ao ligar a etapa 5 |

`small` porque foi o que se mediu: 78% dos trechos lembrados viraram
encontráveis. O `tiny` não chegou perto.

**Alerta de método, e este projeto já foi mordido por ele**: os 78% foram
medidos com **faster-whisper** (CTranslate2, Python). O `whisper.cpp` com
modelo quantizado é outro motor — *a prova não viaja junto quando o código é
reusado*. **A entrega da etapa 5 só é aceita depois de remedir nos MESMOS
arquivos**, e o número medido entra no relatório. Se cair muito, o modelo
não-quantizado volta à mesa.

### Regras do download

1. **Nada baixa sozinho.** A tela diz antes o que vai baixar, quanto ocupa e
   quanto tempo estima; só continua se a pessoa aceitar.
2. **Segundo plano**, sem travar busca nem reprodução, com progresso visível e
   cancelamento. (A v0.8.1 já ensinou o custo de bloquear a thread principal.)
3. **Cache no perfil do usuário.** Baixou uma vez, as próximas começam direto.
4. **Verificação obrigatória antes de executar**: SHA-256 conferido contra o
   valor compilado no app. Hash diferente = arquivo descartado e etapa
   desligada, com mensagem que se explica. Sem isso, um download comprometido
   vira execução de código arbitrário em 40 máquinas.
5. **Retomada e falha honesta**: internet que cai no meio não deixa binário
   pela metade em uso — o arquivo só entra no cache depois de conferido.

### Pontos de rede, atualizados

A regra "rede só em pontos explícitos e enumerados" continua. A lista passa a
ser: LRCLIB, Vagalume, AcoustID, GitHub (atualização do app **e** acessórios).
Nenhum acervo sai da máquina em nenhum deles — a impressão digital envia um
resumo acústico, não o áudio.

## Ordem de entrega

**v0.9.0 — a máquina de acessórios, provada no barato**
- infraestrutura de download verificado, cache, progresso, cancelamento
- etapa 2 (impressão digital) usando `fpcalc` (3-5 MB), antes das etapas de letra
- o modo de conferência (achar etiqueta errada) e as linhas de conflito
- chave do Vagalume nossa
- passe de redução da copy
- a estimativa passa a depender de QUAIS etapas estão ligadas (medido em campo:
  16 músicas em ~2 min com as etapas 1 e 3 apenas — 7 s/música, que era a
  previsão; a etapa 2 e a 4 mudam essa conta)

Provar a máquina nova com 2 MB antes de confiar nela com 180 MB é o ponto: o
risco desta fase está no downloader, não no `fpcalc`.

**v0.10.0 — a etapa que resolve**
- etapa 5 (transcrição) sobre a mesma máquina
- remedição obrigatória dos 78%
- estimativa de tempo por máquina (uma varredura de 150 músicas pode levar
  horas numa máquina modesta — isso precisa estar na tela ANTES)

## Invioláveis (inalterados)

- A **reprodução** nunca escreve; gravação só em ação explícita, e só tags ID3.
- **Nenhum arquivo é renomeado ou movido**, em nenhuma ferramenta.
- Tag real nunca é sobrescrita sem confirmação.
- Letra existente nunca é substituída sem consentimento explícito (decisão 79).
- Nenhuma telemetria, nenhuma conta, nada do acervo sai da máquina.
- Comando que faz rede, percorre disco ou escreve arquivo é `(async)`
  (decisão 92).
