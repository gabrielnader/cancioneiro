# PRD V5 — Transcrição local de áudio (F14)

## Por que

O experimento no acervo real (94 MP3s de repertório de nicho: adventícios,
Barquinha, gravações caseiras) mediu **~3% de cobertura no LRCLIB**: 13 músicas
com letra, 81 sem. A busca por trecho de letra é o coração do produto — sem
letra, o acervo é uma lista de nomes de arquivo. Nenhuma base pública vai ter
esse repertório: a letra precisa sair do próprio áudio.

Decisão de escopo (usuário, rodada v0.5): **a transcrição roda no script de
curadoria** (`tools/curadoria.py`), não dentro do player. Motivos: o instalador
continua com ~5 MB e sem modelo embutido; não há compilação de whisper.cpp nas
4 plataformas do release; o trabalho pesado fica na máquina de quem cura o
acervo. Quem recebe o acervo pronto não precisa de nada disso — os dados viajam
dentro do MP3. Se provar valor, uma versão futura leva o mesmo motor para o app.

## F14.1 — Identificação pelo refrão (transcrever um trecho para descobrir a música)

> **DESLIGADA POR PADRÃO desde a V8.1.** Não é regressão, é medição — leia
> [Por que a F14.1 saiu do caminho padrão](#por-que-a-f141-saiu-do-caminho-padrão-v81)
> antes de religá-la. Para usar, `--identificar-por-refrao` (ou
> `--so-identificar`, que a implica).

Ideia do usuário, adaptada ao que é possível sem chave de API: o LRCLIB não
pesquisa pelo conteúdo da letra, só por título/artista/álbum. Mas **o título de
uma canção é, na esmagadora maioria dos casos, a frase mais repetida dela** — o
refrão. Então:

1. Transcrever apenas um **trecho** do áudio (padrão: 90 s a partir de 20 s,
   para pular introduções instrumentais).
2. Extrair candidatos a título: as linhas curtas mais repetidas do trecho
   (normalizadas: minúsculas, sem acento, sem pontuação), mais a primeira linha
   cantada.
3. Consultar o LRCLIB com cada candidato como `track_name` (reusando
   `buscar_lrclib`/`classificar` que já existem), confirmando pela **duração**
   com as mesmas regras da V3 (±3s = ALTA, ≤8s = MÉDIA, >15s desqualifica).
4. Se casar: usar **título, artista e letra oficiais** do LRCLIB — melhor que a
   transcrição em qualidade — e não gastar CPU transcrevendo o resto.
5. Se não casar: seguir para F14.2.

Vantagem: resolve simultaneamente o problema de identificação (títulos como
"Faixa 5", "AudioTrack 17") e o de letra, sem custo nem chave de API.

## Por que a F14.1 saiu do caminho padrão (V8.1)

**Isto não é regressão. É medição.** Quem for religar a etapa por padrão,
leia os números antes.

Duas passadas completas no acervo real (94 arquivos, o mesmo dos dois lados):

| modelo | identificações | conflitos | custo |
|---|---|---|---|
| `tiny`  | **0** | 3 | 1 transcrição de trecho (90 s) por arquivo |
| `small` | **1** | 5 | 1 transcrição de trecho (90 s) por arquivo |

E a **única** identificação das duas passadas estava **errada** — e foi
**aplicada**:

```
[32/94] IDENTIFICADA: Barco/Barco - Barco Valente - Flavia Venceslau.mp3 → Não aguento mais / Raça Negra (MÉDIA, refrão "não aguento", mp3 233s, lrclib 218s)
```

O refrão era a frase genérica "não aguento", que naturalmente aparece na letra
de uma música chamada "Não aguento mais" — então a prova da V6.1 ("o refrão tem
de estar na letra devolvida", decisão 64) **passou de graça** enquanto o
casamento continuava errado, e 15 s de diferença de duração foram aceitos como
MÉDIA. Os outros palpites do lote ("Lampejo" → Roberto Carlos, "Velho barqueiro"
→ uma banda punk espanhola, "canção dos herdeiros" → Pato Fu) só não entraram
nos arquivos porque aqueles MP3s **tinham tag real** e viraram `CONFLITO`. Um
arquivo sem tag — que é justamente o caso que a F14.1 existe para resolver —
recebe o dado errado calado.

Balanço: **zero acertos medidos, um erro gravado, e uma transcrição de trecho
de 90 s por arquivo cobrada antes da passada completa em todo o acervo.**

Por isso, desde a V8.1:

- **a F14.1 só roda se pedirem**: `--identificar-por-refrao`
  (`--so-identificar` continua valendo sozinha e a implica — sem isso ela
  pediria "só a etapa que não roda" e o lote não faria nada);
- **quando ligada, a trava é mais dura** (o palpite vem do áudio, e a duração é
  a única prova objetiva que existe):
  - sem duração no resultado do LRCLIB **não há identificação** — não há o que
    confirmar;
  - o teto de diferença de duração cai de 15 s (V3) para **8 s**; o único erro
    medido estava exatamente em 15 s, e `ALTA` já vive dentro de ±3 s;
  - **`MÉDIA` exige refrão distintivo**: 4 palavras e 20 caracteres. "não
    aguento" (2/11) e "me apresento" (2/12) acham qualquer coisa no LRCLIB;
    "na beira do mar sagrado" (5/23) não. O corte fica acima das frases que
    produziram o erro e abaixo do teto de 6 palavras que o extrator já impõe ao
    refrão, então a faixa útil de 4 a 6 palavras continua servindo.

Aplicadas ao acervo real, as travas eliminam a única identificação (a errada) e
não custam nenhuma das outras — porque não havia nenhuma outra.

O caminho barato de identificação continua sendo a **impressão digital
acústica** (`identificar`, V6): ~1–2 s por música e prova objetiva de verdade.

## F14.2 — Transcrição completa como letra

Quando a identificação falha (o caso esperado para a maior parte deste acervo),
transcrever a música inteira e gravar o texto como letra no `USLT`.

- Marcação de origem: `TXXX:LETRA_ORIGEM = "transcricao"`. A letra em si fica
  **limpa** (sem cabeçalho poluindo a busca por trecho); o relatório mostra
  `SIM (transcrição)`. Exibir esse selo no player fica para a rodada seguinte.
  A marca descreve a letra **atual**: qualquer gravação de letra nova sem
  informar origem (busca oficial, planilha, edição no player) a limpa.
- Transcrição **nunca sobrescreve letra existente**: `--forcar` reprocessa
  somente as letras que vieram de transcrição (rodar de novo com um modelo
  maior) e `--forcar-tudo` — destrutivo — inclui as oficiais.
- Título/artista **não** são inventados a partir da transcrição: sem casamento
  no LRCLIB, os campos existentes ficam como estão (regra da V3.1).

### Transcrição quase vazia é o mesmo caso da vazia (V8.1, F17)

A F17 (`PRD-v8-instrumental-e-funil-no-app.md`) marca instrumental quando a
transcrição volta **vazia** com áudio legível. Com o modelo `tiny` as duas
faixas instrumentais do acervo real voltavam vazias e eram marcadas certo. Com
o `small` elas voltaram como **ruído**:

```
[46/94] TRANSCRITA: Barco/Instrumental - doce preludio.mp3 (13 caracteres, 2m55s de áudio em 1m17s)
[90/94] TRANSCRITA: Barco/instrumental - passeio pelo jardim.mp3 (29 caracteres, 6m20s de áudio em 4m56s)
```

13 caracteres para 175 s de áudio não é letra: é o motor ouvindo quase nada. E
gravar isso é pior do que não gravar nada — polui o índice de busca **e** faz o
arquivo "ter letra", de modo que toda etapa seguinte passa a pulá-lo, para
sempre, e a F17 nunca mais tem a chance de marcá-lo. O `tiny` acertava por
acidente; o `small` derrotava a F17 justamente por ouvir melhor.

Regra: transcrição **sem conteúdo** tem o mesmo desfecho da vazia — marca
instrumental, não grava letra. "Sem conteúdo" é medido por **densidade**
(caracteres por segundo de áudio), calibrada nos números do acervo real de 94
arquivos com o modelo `small`:

| o que é | caracteres / segundos | densidade |
|---|---|---|
| instrumental (ruído) | 13 / 175 s | 0,074 c/s |
| instrumental (ruído) | 29 / 380 s | 0,076 c/s |
| letra legítima mais rala | 355 / 290 s | 1,22 c/s |
| letra legítima | 481 / 171 s | 2,81 c/s |
| letra legítima | 484 / 156 s | 3,10 c/s |

Entre 0,076 e 1,22 há um fator de **16** sem nada no meio. O piso fica em
**0,30 c/s** — praticamente a média geométrica das duas bordas: **3,9× acima**
do pior instrumental e **4,1× abaixo** da letra legítima mais rala.

A folga é simétrica de propósito, mas os dois erros **não** são: deixar ruído
passar custa uma linha feia no índice, enquanto marcar uma música de verdade
como instrumental a tira da fila de letra **para sempre** (a marca vence até
`--forcar-tudo`, por decisão da F17). É por isso que o piso não sobe: 4× de
folga abaixo da letra mais rala **já medida** é o que separa a regra de
qualquer coisa vista no acervo real. Quem tiver repertório ainda mais rarefeito
ajusta com `--densidade-minima`; `0` desliga a regra e devolve o comportamento
antigo (só a vazia marca).

Dois detalhes que a implementação tem de respeitar:

- **a densidade é medida no texto CRU**, antes do limpador de laços. O limpador
  colapsa linha repetida em série, e neste repertório (ponto, coco, ciranda)
  uma faixa de 15 minutos pode ser um refrão repetido cinquenta vezes: medir
  depois dele transformaria letra legítima em "instrumental";
- **sem duração conhecida não há densidade a medir** — só o texto vazio marca.

E a linha de saída **diz a regra**, para o curador conferir por que aquele
arquivo saiu da fila:

```
INSTRUMENTAL: doce preludio.mp3 (13 caracteres em 2m55s de áudio = 0,07 caractere por segundo, abaixo do mínimo de 0,30 — marcado como instrumental)
```

### V8.2 — a duração precisa ser PROVADA (achado CRÍTICO do QA)

A regra de densidade divide por uma duração, e a duração declarada no MP3
**não é uma medição**. Sem cabeçalho Xing/Info — arquivo remontado, cortado,
editado à mão ou com uma entrada de bitrate baixo, tudo rotina num acervo
montado à mão — o leitor de tags *estima* a duração assumindo que o arquivo
inteiro tem o bitrate do **primeiro quadro**. Medido: **300 s reais lidos como
2.260,3 s** (7,5×). A consequência, reproduzida ponta a ponta:

```
INSTRUMENTAL: ponto_de_ogum.mp3 (631 caracteres em 37m40s de áudio = 0,28 caractere por segundo, abaixo do mínimo de 0,30 — marcado como instrumental)
# na execução seguinte:
INSTRUMENTAL: ponto_de_ogum.mp3 (já marcado como instrumental — nada a transcrever)
```

Uma música **cantada**, com 631 caracteres de letra legítima (2,1 c/s reais),
perde a letra **para sempre**: a marca vence até o `--forcar-tudo` e o único
desfazer é um comando de terminal, no produto cujo requisito declarado é que o
terminal desapareça. A folga de 4× do piso é irrelevante contra um erro de
**uma ordem de grandeza**.

Regra nova: **nenhuma música é marcada como instrumental por causa de uma
duração que ninguém confirmou.** A duração usada na densidade vem, nesta ordem:

1. **o transcritor** — ele decodificou o áudio e sabe quanto ouviu
   (`info.duration` do faster-whisper). Verdade de campo, e de graça;
2. **a medição quadro a quadro do MP3** — a duração de um MP3 é a soma da
   duração de cada quadro MPEG, e cada quadro a declara no próprio cabeçalho
   de 4 bytes. Offline, sem dependência nenhuma, alguns milissegundos por
   arquivo;
3. **o cabeçalho**, e só quando a medição concorda com ele (então nenhum
   arquivo saudável muda de número por causa desta regra).

Sem nenhuma das duas primeiras, e com o cabeçalho sozinho acusando "ralo", o
arquivo **não é marcado**: sai como `ADIADA`, com balde próprio no `Resumo:`, e
**nada é gravado** — nem a marca, nem o ruído como letra. Errar para o lado de
marcar destrói dado de alguém que não tem a quem recorrer; errar para o lado de
adiar custa uma nova passada. Texto **vazio** não depende de duração nenhuma e
continua marcando como sempre.

Quando a duração usada contradiz o cabeçalho, a linha **diz as duas**:

```
TRANSCRITA: ponto_de_ogum.mp3 (631 caracteres, 5m00s de áudio em 4m12s) [duração medida no fluxo do MP3; o cabeçalho do MP3 diz 37m40s]
ADIADA: outra.mp3 — 8 caracteres seriam pouco para a duração deste áudio, mas a duração NÃO pôde ser confirmada: o cabeçalho do MP3 diz 39m25s e o fluxo do arquivo não pôde ser medido. Nada foi gravado. Se a música realmente não tem voz, marque como instrumental no editor do player, ou com embed_lyrics.py ARQUIVO --instrumental
```

A mesma prova vale onde quer que a duração seja usada como **evidência
objetiva**: a confirmação de casamento da F14.1 e do `enriquecer` (sem duração
provada, o resultado do LRCLIB não ganha o bônus de duração) e a projeção do
`estimar`.

## Interface

```bash
python3 tools/curadoria.py transcrever ~/Musicas [opções]
  --modelo {tiny,base,small,medium}   padrão: small (equilíbrio no acervo real)
  --idioma pt                         padrão: pt
  --identificar-por-refrao            liga a F14.1, DESLIGADA por padrão
  --trecho SEGUNDOS                   padrão: 90 (trecho de identificação)
  --so-identificar                    só F14.1 (implica --identificar-por-refrao)
  --so-transcrever                    pula F14.1; transcreve direto (é o padrão)
  --forcar                            refaz só as letras vindas de transcrição
  --forcar-tudo                       refaz qualquer letra (apaga letra oficial)
  --sobrescrever-tags                 DESTRUTIVO: ALTA pode trocar tag real
  --densidade-minima C_POR_S          padrão: 0,30 caractere por segundo de
                                      áudio; abaixo disso a transcrição é ruído
                                      e o arquivo vira instrumental (0 desliga)
  --csv arquivo.csv                   registra o que foi feito, para conferência
  --verboso                           mostra o trecho transcrito e os candidatos
```

`--identificar-por-refrao` e `--so-transcrever` se contradizem e a combinação é
recusada; `--so-identificar` e `--so-transcrever` continuam mutuamente
exclusivas.

Com a F14.1 desligada por padrão, duas flags passaram a **não fazer nada** — e
não faziam nada em silêncio (achado do QA). Elas recebem tratamentos
diferentes, de propósito:

- `--sobrescrever-tags` sem a identificação ligada é **recusado**. É uma
  autorização destrutiva: quem a digita acredita ter permitido trocar
  título/artista reais, e ignorá-la calado deixa a pessoa com uma crença falsa
  sobre o que o comando pode fazer com o acervo dela;
- `--trecho` sem a identificação ligada **avisa** e segue. Ele não autoriza nem
  destrói nada, e recusar quebraria linha de comando antiga que ainda faz a
  coisa certa.

Saída por música, no padrão dos outros subcomandos (a linha `IDENTIFICADA`
mostra o que foi **aplicado** no arquivo, com a confiança do casamento; a linha
`INSTRUMENTAL` mostra a **regra** que tirou o arquivo da fila de letra):

```
IDENTIFICADA: barquinha - Faixa 5.mp3 → Me Apresento / Barquinha (ALTA, refrão "me apresento", mp3 214s, lrclib 216s)
TRANSCRITA: barco - segura o remo.mp3 (1.842 caracteres, 4m12s de áudio em 38s)
INSTRUMENTAL: barco - doce preludio.mp3 (transcrição vazia com áudio legível — marcado como instrumental)
INSTRUMENTAL: barco - passeio pelo jardim.mp3 (29 caracteres em 6m20s de áudio = 0,08 caractere por segundo, abaixo do mínimo de 0,30 — marcado como instrumental)
CONFLITO: barco - remo.mp3 — tag atual "Segura o Remo / Mestre Irineu" difere do identificado "Música / Outro" (não alterado)
NÃO IDENTIFICADA: barco - Timoneiro.mp3
PULADO: barco - Timoneiro.mp3 (já tem letra)
ERRO: arquivo.mp3 — áudio ilegível
Resumo: 94 arquivos | 6 identificadas | 71 transcritas | 0 não identificadas | 13 puladas | 0 conflitos | 4 erros | 2 instrumentais | 0 adiadas
```

**Segurança do lote** (roda horas, sem ninguém olhando, e o candidato vem do
áudio — casar no LRCLIB não prova nada): título/artista **reais** nunca são
sobrescritos, em nenhuma confiança, salvo `--sobrescrever-tags` (só ALTA);
identificação que contradiz a tag existente não grava nada e vira `CONFLITO`;
alucinações típicas do motor ("Música", "Legendas pela comunidade Amara.org")
e frases de uma palavra são descartadas antes de qualquer consulta.

## Requisitos técnicos

- **Motor**: `faster-whisper` (CTranslate2), CPU, dependência **opcional**. Sem
  ela instalada, o subcomando explica em uma linha como instalar e sai com
  código 1 — os demais subcomandos continuam funcionando normalmente.
- **Modelo**: baixado uma vez pela biblioteca, em cache no perfil do usuário.
  O download é o único acesso à rede além do LRCLIB, acontece na primeira
  execução e é anunciado ("baixando modelo… ~500 MB, só desta vez").
- **Injeção de dependência**: a transcrição entra por um parâmetro
  `transcritor` (mesmo padrão do `fetcher` do LRCLIB), para a suíte rodar
  100% offline e sem modelo.
- **Progresso**: uma linha por arquivo com contador `[12/94]`, porque a
  operação leva horas em acervos grandes.
- **Interrupção segura**: Ctrl-C encerra sem corromper o arquivo em andamento
  (gravação de tag só acontece após a transcrição completa daquele arquivo, e
  é atômica: cópia temporária na mesma pasta + troca de lugar). O `Resumo:`
  sempre sai, dizendo onde parou, e o `--csv` é gravado com o que já foi feito
  — horas de trabalho não podem sumir com um Ctrl-C.

## Invioláveis (valem como em todo o projeto)

- **Nunca renomear nem mover arquivos.**
- Nunca alterar os frames de áudio — só tags ID3.
- Nunca apagar dado existente (letra, título, artista, temas).
- O player continua sem qualquer código de transcrição e sem rede fora das
  ações explícitas já existentes.

## Fora deste ciclo

- Transcrição dentro do player (reavaliar depois do teste real deste ciclo).
- Selo visual de "transcrição automática" na interface do player.
- Busca da letra completa por trecho em buscador web (exigiria chave de API
  paga; a identificação pelo refrão cobre o mesmo objetivo sem custo).
