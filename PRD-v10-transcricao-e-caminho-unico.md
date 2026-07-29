# PRD V10 — A transcrição e o caminho único (F18, fim)

Última versão do plano. A v0.9.0 entregou a máquina de acessórios e a etapa do
som. Esta fecha as duas pontas que sobraram: **a etapa que resolve** (escrever
a letra ouvindo o áudio) e **o caminho único** — porque o produto acumulou
modos, e modo é escolha, e escolha é pedágio para quem não tem a quem
perguntar.

## O que o uso real ensinou (v0.9.0 em campo)

Três medições do dono do produto, todas mudando o desenho.

### 1. "Nem li as sugestões em baixa — não deu vontade de ler mesmo"

Comportamento observado numa revisão de 53 músicas. Não é preferência: é o que
40 pessoas vão fazer. E significa que **o valor da etapa 1 não está chegando**
— não porque o palpite é ruim (`Falamansa - Oh! Chuva.mp3` acerta quase
sempre), mas porque ninguém lê 72 linhas iguais.

Esconder as linhas de baixa confiança foi considerado e **recusado**: nada é
gravado sem revisão, então esconder é *perder* a correção. E com ~3% de
cobertura dos sites de letra, arrumar nome a partir do arquivo é a principal
coisa que o app consegue fazer por este repertório.

O corte útil **não é por confiança — é por risco**:

| categoria | risco | tratamento |
|---|---|---|
| preenche campo VAZIO | nenhum: não havia nada a perder | grupo dobrado, **marcado por padrão**, com a frase dizendo o que fará |
| troca nome ESCRITO por gente | destrói curadoria | linha própria, nunca pré-marcada (já é assim) |
| conflito som × etiqueta | idem, com identificação não medida | linha própria, no topo |
| trouxe letra | o que a pessoa mais quer ver | logo abaixo dos conflitos |

"Baixa confiança" junta o mais seguro com o mais perigoso, e por isso parece
ruído. **Confiança baixa não quer dizer "provavelmente errado"; quer dizer
"sem prova externa"** — ninguém confirmou pela duração.

A revisão passa a ser **ordenada por prioridade**, não por pasta: conflitos →
letras encontradas → trocas de nome escrito → o grupo dobrado dos
preenchimentos.

### 2. Os modos somem

Medido: a etapa do som custa **2 s por música** (o dono mediu; a estimativa
dizia 0,3 s — erro de 7×, e a estimativa da tela precisa usar o número medido).

Com 2 s, separar "completar o que falta" de "conferir se está certo" custa,
num acervo de 150 músicas com 80 incompletas, **2 minutos e meio a mais**.
Isso não paga fazer uma pessoa que não sabe o que é terminal escolher entre
dois nomes que ela não entende. Pior: **a conferência é a única coisa que acha
etiqueta errada** (o caso "Caetano Veloso" que era Nilson Chaves), e recurso
que depende de o usuário adivinhar que existe é recurso que não existe.

Um botão só, que faz tudo, em todas as músicas da pasta.

### 3. A transcrição pergunta no fim, não vira modo

Ela é cara de verdade — minutos por música, horas por acervo. Mas a pergunta
não vai para o começo, onde é jargão. Vai para o **fim**, quando o app já sabe
o que faltou:

> Sobraram 47 músicas sem letra. Escrever a letra ouvindo o áudio leva cerca
> de 3 horas neste computador. Começar agora?

Pergunta feita quando pode ser respondida com informação.

### 4. Conflito: destacar o que difere, e dizer o que a confiança significa

Caso real da v0.9.0:

> Sua etiqueta diz: Meninos — Renato Teixeira & Xangai
> O som diz: Meninos — Xangai & Quinteto da Paraíba — confiança alta

A tela repete o título nas duas linhas e obriga a comparar dois textos com o
olho. **Destaque o que difere.**

E "confiança alta" está enganando: ela é sobre **qual gravação é esta**, não
sobre a etiqueta estar errada. O AcoustID identifica a gravação e busca o
crédito no MusicBrainz, onde a MESMA gravação aparece em vários lançamentos
com créditos diferentes. Aceitar pode trocar uma etiqueta certa por outra
igualmente defensável. O texto tem de dizer isso em uma frase.

### 5. `Various Artists` não é artista

Não está na lista de etiquetas-lixo, **nem no Rust nem no Python**. É dos
rótulos mais comuns em CD ripado e coletânea. Hoje passa por artista real: a
música é dada como completa, some da curadoria, e ainda vira conflito contra o
artista verdadeiro. Acrescentar `various artists`, `varios`, `vários
intérpretes`, `v.a.`, `va`, `compilation`, `coletanea` — nas duas pilhas.

## A transcrição

Acessórios novos no mesmo lançamento `acessorios-v1` (acrescentar arquivo não
muda hash de quem já baixou):

| acessório | tamanho |
|---|---|
| `whisper-cli` (whisper.cpp, por plataforma) | ~1-30 MB |
| modelo `small` quantizado (q5_1) | ~180 MB |

**Construído por nós no CI**, não rehospedado: o whisper.cpp não publica
binário confiável para as quatro plataformas. O modelo é rehospedado.

### A remedição é obrigatória, e é condição de entrega

Os **78%** (trechos lembrados que viraram encontráveis) foram medidos com
**faster-whisper** — CTranslate2, Python. O `whisper.cpp` com modelo
quantizado é **outro motor**. *A prova não viaja junto quando o código é
reusado* (decisão 72).

**A etapa 5 só é aceita depois de remedir nos MESMOS arquivos**, e o número
medido entra no relatório. Se cair muito, o modelo não-quantizado volta à
mesa. Publicar sem remedir seria repetir, com 180 MB e horas de CPU, o erro
que este projeto já cometeu três vezes.

### Regras herdadas que valem aqui

- Download só com aceite explícito, com tamanho **e tempo** — a dispensa do
  tempo valia para 5 MB, não vale para 180 MB.
- Roda em segundo plano, cancelável, sem travar busca nem reprodução; comando
  `(async)` (decisão 92).
- SHA-256 conferido antes de executar (decisão 96), e o fluxo de fumaça passa
  a cobrir também o `whisper-cli`.
- **Os canos precisam ser drenados** — o `whisper-cli` despeja progresso em
  stderr muito acima do buffer de 64 KiB. O defeito foi consertado na v0.9.0
  (QA A4) justamente por isto; não reintroduza.
- Transcrição é letra de MÁQUINA: grava `TXXX:LETRA_ORIGEM=transcricao`, e a
  tela avisa que pode conter erros (V5/F14, já existe).
- Instrumental não é transcrito. Letra existente não é substituída sem
  consentimento (decisão 79).
- Estimativa **por máquina**: uma varredura de 150 músicas pode levar horas
  numa máquina modesta, e isso vai na tela ANTES.

## Invioláveis (inalterados)

- A **reprodução** nunca escreve; gravação só em ação explícita, e só tags ID3.
- **Nenhum arquivo é renomeado ou movido**, em nenhuma ferramenta.
- Nenhuma telemetria, nenhuma conta, nada do acervo sai da máquina — a
  transcrição roda **local**, que é o que torna aceitável transcrever acervos
  que o dono do produto não pode ver.
