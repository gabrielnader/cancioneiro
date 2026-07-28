# PRD V8 — Marca de instrumental (F17) e o funil dentro do app (F18)

Ambos nasceram do teste real no acervo de 94 arquivos, e ambos vêm de ideias
do dono do produto.

## F17 — Marca de instrumental

### Por que

Hoje uma música sem voz (`doce preludio`, `passeio pelo jardim`) é tratada como
pendência: aparece com o selo cinza **"Sem letra"**, entra em toda varredura de
letra, é transcrita, volta vazia, vira `ERRO: transcrição vazia` — e será
tentada de novo na execução seguinte, para sempre. Marcar uma vez resolve as
duas pontas: **informação** para quem olha a lista e **economia** para o
processamento.

### Como

- **Marca no próprio MP3**: `TXXX:INSTRUMENTAL = "1"`, na mesma filosofia dos
  temas e da procedência da letra — o dado viaja com o arquivo.
- **Automática**: quando a transcrição volta vazia com áudio legível, o arquivo
  é marcado como instrumental em vez de contar como erro. Áudio ilegível
  continua sendo erro — são coisas diferentes.
- **Manual**: alternável no editor do player ("Esta música é instrumental") e
  pelo `embed_lyrics.py --instrumental` / `--nao-instrumental`. A escolha
  humana manda: marcada à mão, nenhuma rotina desmarca sozinha.
- **Visual**: na lista, no lugar do selo cinza "Sem letra", aparece
  **"Instrumental"** — informação, não cobrança. Uma música instrumental que
  ainda assim tenha letra registrada (raro, mas possível) mostra a letra
  normalmente.
- **Economia**: todas as etapas de letra pulam o arquivo — `buscar-letra`,
  `identificar --com-letra`, `transcrever`, Vagalume e a varredura em lote do
  app. Cada subcomando ganha sua contagem `N instrumentais` no `Resumo:`.
- A **impressão digital continua rodando** nesses arquivos: instrumental sem
  letra ainda pode (e deve) ter título e artista corretos.

## F18 — O funil dentro do app

### Por que

O funil completo (tags/nome → LRCLIB → Vagalume → impressão digital →
transcrição) só existe na linha de comando. Quem cura o acervo nem sempre é
quem sabe abrir um terminal, e o objetivo declarado do produto é **um lugar só
para mexer em tudo**.

### Onde fica (decisão do dono do produto)

**Fora do caminho do dia a dia.** Quem abre o Cancioneiro numa reunião quer
achar e tocar música — não pode esbarrar num botão que dispara horas de
processamento. Então:

1. **Em Configurações**, uma seção própria de curadoria: escolher a pasta ou
   subpasta e disparar o funil.
2. **No editar de cada música**, a versão individual: rodar o funil só naquele
   arquivo, para o caso pontual.

### Como se comporta

- **Roda em segundo plano.** A pessoa continua usando o app normalmente —
  buscando, tocando, montando playlist. Vale a regra que a v0.4.1 já
  estabeleceu: varredura só lê; gravação é rápida e pontual.
- **Status sempre visível**, sem precisar caçar: progresso com contagem e
  barra ("25 de 95"), a etapa atual do funil e o arquivo do momento.
- **Interrompível**, e o que já foi feito está gravado nos MP3s — nada se perde
  ao parar no meio (mesma garantia do Ctrl-C no script).
- **Nada é aplicado sem revisão**, como já acontece no "Completar dados desta
  pasta": propostas com confiança, ALTA pré-marcada, conflito nunca aplicado
  sozinho.

### O problema difícil: as dependências pesadas

`fpcalc` (impressão digital) e o modelo do Whisper (transcrição) não cabem no
instalador de 5 MB, e compilá-los para as quatro plataformas do release é
justamente o que a V5 evitou. Caminhos possíveis, a decidir com medição e não
por gosto:

1. **Só as etapas leves no app** (tags/nome, LRCLIB, Vagalume) e as pesadas
   seguem no script. Entrega hoje, resolve a maior parte dos casos, mas deixa
   a transcrição — que é a que mais rende neste acervo — de fora.
2. **Baixar as dependências sob demanda**, na primeira vez que a pessoa pedir,
   com aviso claro de tamanho e tempo. Mantém o instalador pequeno e o app
   honesto sobre o que está fazendo.
3. **Embutir tudo**, com instalador de centenas de MB. Simples de usar, caro de
   distribuir e de manter em quatro plataformas.

A recomendação é começar pela 1 e medir; a 2 é a evolução natural se o uso
provar que vale.

## Invioláveis (inalterados)

- A **reprodução** nunca escreve; gravação só em ação explícita, e só tags ID3.
- **Nenhum arquivo é renomeado ou movido**, em nenhuma ferramenta.
- Tag real nunca é sobrescrita sem confirmação; divergência vira conflito.
- Nenhuma telemetria, nenhuma conta, nada do acervo sai da máquina.
