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

E, pela mesma razão, **o ✎ sai da árvore de pastas**. Ele nasceu na V5/F13
como único caminho para a varredura em lote, mas a lateral é para **navegar**:
um botão que dispara horas de processamento no meio da navegação diária é
convite a clique acidental — o mesmo problema que tirou os chips de tema de
perto do título. Com a curadoria tendo endereço próprio, ele vira redundante.

**Ordem obrigatória**: a remoção acontece **no mesmo lançamento** que traz a
seção em Configurações, nunca antes. Tirar primeiro deixaria uma versão em que
a varredura em lote não existe em lugar nenhum.

Para não perder o contexto que o ✎ dava de graça, a seção em Configurações
**começa com a pasta que estiver selecionada na lateral** — quem estava
olhando "Barco" e vai curar não precisa procurar "Barco" de novo.

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

### Quem cura: 40 pessoas, não uma (decisão do dono do produto)

Premissa corrigida no meio do projeto. O desenho anterior supunha **um**
curador preparando acervos para os outros usarem. A realidade: são cerca de
**40 pessoas, cada uma com seu próprio acervo**, e algumas coleções o dono do
produto **não pode nem ver** — saber de antemão qual música alguém vai tocar
numa sessão estragaria justamente o que aquele momento tem de bonito.

Consequências, todas obrigatórias:

- **A curadoria é de cada um.** Não existe curadoria centralizada para
  distribuir depois; cada pessoa cura o próprio acervo, na própria máquina.
- **O terminal precisa desaparecer por completo.** Não é conforto: é
  requisito. São pessoas que não sabem o que é um terminal, e não haverá
  ninguém por perto para ajudar — o dono do produto sequer pode olhar o acervo
  delas.
- **Privacidade deixa de ser princípio abstrato e vira requisito de uso.**
  Nada de telemetria, nada de acervo saindo da máquina, e as mensagens de erro
  precisam se explicar sozinhas: não há suporte possível olhando os arquivos.
- **O custo por pessoa importa mais.** Quarenta máquinas transcrevendo, várias
  possivelmente modestas. A estimativa antes de rodar (F15.1) deixa de ser
  conveniência e passa a ser parte do fluxo.

### As dependências pesadas: baixar sob demanda (caminho 2)

`fpcalc` (impressão digital) e o motor de transcrição não cabem num instalador
de 5 MB, e embutir os dois para as quatro plataformas é o que a V5 evitou. Dos
três caminhos considerados, o dono do produto escolheu o **2**: instalador
pequeno, e o que for preciso é baixado na primeira vez que a pessoa pede.

Como fica:

1. A pessoa manda varrer uma pasta. O app diz, **antes**, o que vai precisar
   baixar, quanto ocupa e quanto tempo estima — e só continua se ela aceitar.
2. O download roda **em segundo plano**, sem travar busca nem reprodução, com
   progresso visível e possibilidade de cancelar.
3. Baixado uma vez, fica em cache no perfil do usuário. As varreduras seguintes
   começam direto.

**Nada de Python na máquina do usuário final.** O motor de transcrição precisa
ser um executável autocontido por plataforma (whisper.cpp), publicado como
artefato da release e baixado como acessório — não a biblioteca Python que o
`curadoria.py` usa hoje. O mesmo vale para o `fpcalc`.

**Integridade é obrigatória**: baixar e executar um binário exige verificação.
O projeto já assina os pacotes de atualização (V7); os acessórios seguem o
mesmo caminho — soma de verificação publicada na release e conferida antes de
executar. Sem isso, um download comprometido viraria execução de código
arbitrário na máquina de 40 pessoas.

### Reindexação: automática, sem pedir nada

Curadoria feita **dentro** do app já reindexa o arquivo na hora — é assim que
a edição individual funciona desde a V4 (`write_tags` regrava a tag e
reindexa). Portanto **não haverá popup pedindo para reindexar nem para
reiniciar**: ao fim da varredura a biblioteca já está atualizada, e o aviso
diz o que mudou ("47 músicas ganharam letra"), não uma tarefa a fazer.

Pedir reindexação manual é resquício da época em que a curadoria acontecia
fora do app. Enquanto o script existir, o botão "Reindexar tudo" continua em
Configurações para quem mexeu nos arquivos por fora.

### Ordem de entrega

1. **Fase 1 — o que não precisa de acessório**: tags/nome de arquivo, LRCLIB e
   Vagalume, mais a estimativa, o progresso em segundo plano e a tela de
   revisão. Já tira o terminal de boa parte do caminho.
2. **Fase 2 — os acessórios sob demanda**: `fpcalc` e o transcritor, com
   download verificado, cache e cancelamento. É o que fecha a promessa de
   "nunca mais um terminal".

## Invioláveis (inalterados)

- A **reprodução** nunca escreve; gravação só em ação explícita, e só tags ID3.
- **Nenhum arquivo é renomeado ou movido**, em nenhuma ferramenta.
- Tag real nunca é sobrescrita sem confirmação; divergência vira conflito.
- Nenhuma telemetria, nenhuma conta, nada do acervo sai da máquina.
