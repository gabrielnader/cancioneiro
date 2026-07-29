# PRD V9 — Os acessórios sob demanda e o funil completo (F18 fase 2)

Continuação direta da F18. A fase 1 tirou o terminal do caminho para tudo que
não precisa de acessório (tags/nome, LRCLIB, Vagalume). Esta fase fecha a
promessa: **nunca mais um terminal**.

## O que mudou desde o PRD V8

Três coisas vieram do uso real da v0.8.0/v0.8.1 e mudam o desenho.

### 1. O funil ganha um RETORNO (ideia do dono do produto)

O desenho anterior era uma fila de mão única, por custo crescente. Está
errado, e o erro é caro: a impressão digital descobre **título e artista**, e
as etapas de letra só falharam antes porque **não havia nome para procurar**.
Passar direto da impressão digital para a transcrição joga fora a única coisa
que a etapa acabou de conquistar.

O funil passa a ser:

| # | etapa | custo | o que faz |
|---|---|---|---|
| 1 | tags + nome do arquivo | instantâneo | palpite local |
| 2 | LRCLIB | ~0,5 s | letra, conferida pela DURAÇÃO |
| 3 | Vagalume | ~0,5 s | letra, casamento estrito de texto |
| 4 | impressão digital (AcoustID) | ~1 s | **título e artista** pelo som |
| 4b | **volta ao 2 e ao 3** | ~1 s | agora COM nome de verdade para procurar |
| 5 | transcrição (whisper.cpp) | minutos | letra ouvindo o áudio |

A volta (4b) só acontece quando a etapa 4 produziu nome **novo** — senão é
repetir a consulta que já falhou. E ela roda **antes** da transcrição, que é
a etapa mais cara do produto por três ordens de grandeza.

Vale nas duas telas: na varredura por pasta e no botão de uma música só.

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
| `fpcalc` (Chromaprint) | ~2 MB | ao ligar a etapa 4 |
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
- etapa 4 (impressão digital) usando `fpcalc` (~2 MB)
- o retorno 4b
- chave do Vagalume nossa
- passe de redução da copy

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
