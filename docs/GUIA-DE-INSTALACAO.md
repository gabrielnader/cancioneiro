# Cancioneiro — guia de instalação e primeiros passos

O Cancioneiro é um programa para o computador que acha uma música pelo **trecho da
letra** que você lembra. Ele funciona sem internet e não pede cadastro nem senha.

Este guia tem duas partes. **Leia só a parte do seu computador**: Mac ou Windows.
Depois siga "Primeiros passos". Se algo der errado, o final do guia resolve.

Todos os arquivos ficam nesta página, sempre na versão mais recente:
**https://github.com/gabrielnader/cancioneiro/releases**

Nessa página, os arquivos ficam numa lista chamada **Assets**. O número no meio do
nome (por exemplo `0.4.0`) muda a cada versão nova — o que importa é o **final** do
nome do arquivo, indicado abaixo.

---

## Parte 1 — No Mac

### 1.1 Descubra qual é o seu Mac (leva 20 segundos)

Existem dois tipos de Mac, e cada um usa um arquivo diferente. Para saber o seu:

1. Clique no símbolo da **maçã**, no canto superior esquerdo da tela.
2. Clique em **Sobre este Mac**.
3. Olhe a janelinha que abrir:
   - Se aparecer **Chip: Apple M1** (ou M2, M3, M4...) → seu Mac é **Apple Silicon**.
   - Se aparecer **Processador: ... Intel ...** → seu Mac é **Intel**.
4. Feche a janelinha.

### 1.2 Baixe o arquivo certo

Na página de downloads, clique no arquivo que termina assim:

| Seu Mac | Arquivo a baixar |
| --- | --- |
| Apple Silicon (M1, M2, M3, M4) | termina em **`_aarch64.dmg`** |
| Intel | termina em **`_x64.dmg`** |

Um arquivo `.dmg` é só uma "caixinha" com o programa dentro. Ele vai para a pasta
**Downloads**.

### 1.3 Instale

1. Dê **dois cliques** no arquivo que você baixou. Abre uma janela com o ícone do
   **Cancioneiro** de um lado e uma pasta chamada **Aplicativos** do outro.
2. **Arraste** o ícone do Cancioneiro para cima da pasta **Aplicativos** e solte.
3. Pronto, está instalado. Pode fechar essa janela.

### 1.4 O aviso "Cancioneiro está danificado" — o arquivo NÃO está quebrado

Ao abrir o programa pela primeira vez, o Mac provavelmente vai mostrar:

```
"Cancioneiro" está danificado e não pode ser aberto.
Você deve movê-lo para o Lixo.
```

**Não mova nada para o Lixo.** O arquivo está inteiro: essa mensagem aparece porque o
macOS cola uma etiqueta invisível de segurança em todo programa baixado fora da App
Store, e a etiqueta é o que precisa ser retirada. Fazemos isso uma única vez, com um
comando que você **copia e cola**.

Clique em **OK** para fechar o aviso e siga:

1. Segure a tecla **⌘ (Command)** e aperte a **barra de espaço**. Abre uma caixa de
   busca no meio da tela.
2. Escreva **Terminal** e aperte **Enter**. Abre uma janela com fundo claro ou escuro
   e um texto pequeno — é um lugar onde se escrevem comandos, e é só isso que vamos
   fazer nele.
3. Copie a linha abaixo inteira e cole na janela do Terminal (colar é **⌘ + V**):

   ```
   xattr -cr /Applications/Cancioneiro.app
   ```

   (No Mac a pasta aparece com o nome "Aplicativos", mas dentro do comando ela se
   escreve `/Applications` mesmo. Está certo assim.)
4. Aperte **Enter**.
5. **Não vai acontecer nada visível** — e é exatamente assim que se sabe que deu
   certo. O Terminal só pula para uma linha nova, em branco.
6. Feche o Terminal (**⌘ + Q**) e abra o Cancioneiro normalmente, pelo Launchpad ou
   pela pasta Aplicativos. Dessa vez ele abre.

**Truque mais seguro do que digitar:** em vez de escrever o caminho, escreva no
Terminal `xattr -cr ` (com um espaço no final), abra a pasta **Aplicativos** no
Finder e **arraste o ícone do Cancioneiro para dentro da janela do Terminal**. O
caminho aparece escrito sozinho, sem risco de erro de digitação. Aí é só apertar
**Enter**.

**Dúvidas comuns neste passo:**

- **Vai pedir minha senha?** Não. Esse comando não pede senha. Se aparecer um pedido
  de senha, alguma coisa foi digitada diferente: feche o Terminal e comece o passo 1.4
  de novo.
- **Apareceu `No such file or directory`.** Quer dizer "não encontrei o programa".
  Provavelmente o Cancioneiro ainda não foi arrastado para a pasta Aplicativos —
  volte ao passo 1.3.
- **Tentei clicar com o botão direito → "Abrir".** Isso resolve um aviso mais leve,
  de "desenvolvedor não identificado", mas **não** resolve o de "danificado". O
  comando acima é o caminho.
- **Instalei uma versão nova depois.** A etiqueta volta a cada download novo: repita
  o passo 1.4 uma vez por versão instalada.

---

## Parte 2 — No Windows

### 2.1 Baixe o arquivo

Na página de downloads, clique no arquivo que termina em **`_x64-setup.exe`**. Ele vai
para a pasta **Downloads**.

### 2.2 Instale, passando pelo aviso azul

1. Dê **dois cliques** no arquivo baixado.
2. Vai aparecer uma tela azul: **"O Windows protegeu o seu computador"**. Ela aparece
   porque o programa é novo e ainda não é conhecido pela Microsoft — não é vírus.
3. Clique em **Mais informações** (o texto pequeno logo abaixo da mensagem).
4. Aparece um botão novo: clique em **Executar assim mesmo**.
5. Siga o instalador clicando em **Avançar** até o fim.
6. O Cancioneiro passa a aparecer no menu **Iniciar**. Pode digitar "Cancioneiro" na
   busca do Windows para abrir.

---

## Primeiros passos (vale para Mac e Windows)

A tela do programa é dividida assim:

```
┌───────────┬───────────────────────────────┬──────────────┐
│ Biblioteca│  [ caixa de busca          ]  │              │
│ Pastas    │                               │   LETRA da   │
│           │  lista das músicas            │   música     │
│ PLAYLISTS │  achadas                      │   escolhida  │
│           │                               │              │
├───────────┴───────────────────────────────┴──────────────┤
│  ⏮   ▶   ⏭      barra de tempo            volume 🔊      │
└──────────────────────────────────────────────────────────┘
```

**1. Mostre onde estão as músicas (só na primeira vez).**
Na primeira abertura aparece **"Sua biblioteca está vazia"**. Clique no botão
**Adicionar pasta**, escolha a pasta onde ficam suas músicas e confirme. O programa
mostra **"Indexando… X de Y arquivos"** e, ao terminar, um aviso verde:
**"N músicas indexadas."** Pastas dentro da pasta escolhida também entram.

**2. Procure pelo trecho da letra.**
Digite na caixa de cima, onde está escrito *"Buscar por letra, título ou artista…"*.
A lista já vai filtrando enquanto você digita, e o trecho encontrado aparece embaixo
do nome da música com o **pedaço da letra marcado em amarelo**. Acentos não importam:
digitar `coracao` acha "coração".

**3. Um clique mostra a letra. Dois cliques tocam.**
- **Um clique** na música: a letra completa aparece no painel da direita. Nada toca.
- **Dois cliques** na música: começa a tocar.
- A **barra de espaço** pausa e volta a tocar (desde que você não esteja digitando na
  caixa de busca).
- Clicando no meio da barra de tempo, lá embaixo, a música pula para aquele ponto.

**4. Deixe a letra do tamanho que você enxerga bem.**
No painel da direita, o botão **Aa** aumenta a letra (três tamanhos, em ciclo). O
botão **Ocultar detalhes** / **Mostrar detalhes**, no canto superior direito, esconde
ou traz de volta esse painel. O programa lembra a sua escolha na próxima vez.

**5. Monte uma lista para a reunião (opcional).**
1. Clique em **Nova playlist**, na coluna da esquerda, dê um nome e clique em
   **Criar**.
2. Volte para **Biblioteca**, ache a música e clique no **+** que aparece no fim da
   linha quando o mouse passa por cima (o **+** só existe depois que há pelo menos uma
   playlist criada). Escolha a playlist.
3. Abra a playlist na coluna da esquerda e clique em **▶ Tocar playlist**: quando uma
   música acaba, a seguinte começa sozinha.

---

## O programa se atualiza sozinho

Você não precisa baixar nada de novo. Ao abrir, o Cancioneiro confere se saiu uma
versão nova; se saiu, baixa em segundo plano e avisa quando estiver pronta, com um
botão **Reiniciar agora**. Enquanto isso você continua usando normalmente.

Se não houver internet, ou não houver versão nova, ele não faz nada e não avisa nada.
Dá para desligar essa conferência em **Configurações**.

No Mac, depois de cada atualização pode voltar a aparecer um aviso do sistema pedindo
permissão. É chato e é esperado — o programa ainda não tem assinatura digital, e para
o macOS cada versão nova é um programa diferente. Clique em permitir.

---

## Completando as músicas

Muita música chega com o nome errado, sem artista ou sem letra — e sem letra não dá
para achá-la por um trecho. O Cancioneiro procura esses dados sozinho.

**Como rodar:** clique em **Configurações**, na coluna da esquerda, escolha a pasta e
clique em **Buscar dados desta pasta**. Antes de começar ele diz quantas músicas vai
olhar e quanto tempo deve levar. Roda em segundo plano — dá para continuar ouvindo
música enquanto isso, e dá para interromper quando quiser.

Ele procura em quatro lugares, do mais barato para o mais caro: o que já está no
próprio arquivo, o **som da gravação** (que reconhece a música mesmo com a etiqueta
errada), e dois sites de letra.

**Nada é gravado sem você conferir.** No fim aparece uma lista para revisar, em ordem
de importância:

- **Discordâncias** vêm primeiro: o som diz que a música é uma e a etiqueta diz outra.
  A tela mostra os dois lados; você decide. Nenhuma vem marcada.
- **Letras encontradas**, com o nome do site de onde vieram.
- **Músicas sem voz**, que passam a não ser mais cobradas por letra.
- **Trocas de nome que já existia** — nunca vêm marcadas, porque trocariam algo que
  alguém escreveu à mão.
- Por último, um grupo fechado e **já marcado** com as sugestões seguras: músicas sem
  título ou sem artista que vão receber o nome que está no próprio arquivo. Só
  preenche o que está em branco. Dá para abrir e conferir, ou desmarcar tudo de uma
  vez.

Clique em **Aplicar selecionadas**. Os dados são gravados **dentro dos próprios
arquivos MP3** — se você levar as músicas para outro computador, a letra vai junto.

A caixa **não fecha** quando você aplica. As linhas gravadas ficam ali marcadas como
**Gravada**, e você continua trabalhando nas outras: dá para aplicar um punhado,
conferir, aplicar mais. Quando terminar, feche no botão **Fechar**.

### Escrever a letra ouvindo o áudio

Quando alguma música ficar sem letra, o programa oferece, no fim da busca, escrever a
letra **ouvindo o áudio**. Isso funciona sem internet e nada sai do seu computador.

**E você não precisa aceitar na hora.** Em **Configurações → Curadoria do acervo**,
no fim da seção, o programa diz sempre quantas músicas daquela pasta estão sem letra
e quanto tempo levaria — e o botão está ali a qualquer momento. Se você fechar a caixa
da busca, não perdeu nada: a lista não depende dela.

Duas coisas para saber antes:

- Na primeira vez ele precisa baixar um arquivo grande (a tela diz o tamanho e o
  tempo). É uma vez só na vida do computador.
- **É demorado** — minutos por música. A tela mostra o quanto falta, e dá para
  interromper.

A letra que sai daí é escrita por máquina e **pode ter erros**. Ela aparece marcada
como tal, e serve para você achar a música pelo trecho que lembra, não como letra
oficial. Se quiser corrigir, é só usar o **Editar** no painel da direita.

---

## Deu errado? Veja aqui

**"Cancioneiro está danificado e não pode ser aberto" (Mac).**
O arquivo não está quebrado. Faça o passo **1.4** deste guia. Precisa ser refeito
sempre que você instalar uma versão nova.

**Tela azul "O Windows protegeu o seu computador".**
Clique em **Mais informações** e depois em **Executar assim mesmo** (passo **2.2**).

**"Não encontrei minhas músicas."**
O programa só enxerga as pastas que você mostrou para ele. Clique em
**Configurações**, na coluna da esquerda, e veja se a pasta está na lista:
- Não está: clique em **Adicionar pasta** e escolha a pasta.
- Está, mas faltam músicas novas que você copiou depois: clique em
  **Reindexar tudo** e espere a barra terminar.

**"A busca não acha uma música que eu sei que existe."**
A busca procura dentro do que está gravado em cada arquivo. Se a música aparece na
lista com a etiqueta cinza **Sem letra**, é porque a letra ainda não foi gravada
naquele arquivo — então não há como achá-la por um trecho da letra ainda. Nesse caso:
- Procure pelo **nome da música**, pelo **artista** ou pelo **nome da pasta** onde ela
  está; isso funciona mesmo sem letra.
- Tente menos palavras (duas ou três bastam) e sem se preocupar com acentos.
- **Complete os dados você mesmo**: veja a parte "Completando as músicas" logo
  acima. É ela que acha título, artista e letra do que está faltando.

**"Sumiu uma música" / o nome dela ficou cinza.**
Nome em cinza quer dizer que o arquivo não está mais no lugar onde estava: foi
apagado, renomeado ou movido para outra pasta. O Cancioneiro nunca apaga, renomeia nem
move arquivos de música — a mudança aconteceu fora dele. Se o acervo estiver num HD
externo ou pen drive, conecte o disco: aparece um aviso amarelo dizendo
**"A pasta ... não foi encontrada. Verifique se o disco está conectado."**, com o
botão **Tentar de novo**. Se o arquivo realmente foi apagado, ele some da lista na
próxima abertura.

**A música não toca e aparece "Arquivo não encontrado".**
Mesmo caso acima: o arquivo saiu do lugar. Vá em **Configurações** e clique em
**Reindexar tudo** para a lista ficar igual ao que existe no disco.

**Instalei uma versão nova e algo estranhou.**
Instalar por cima da anterior é o certo — no Mac, arraste para Aplicativos e confirme
**Substituir**. Suas playlists, pastas e preferências continuam lá. No Mac, repita o
passo **1.4** depois de atualizar.

---

Ficou travado em algum passo? Anote o número do passo e a mensagem que apareceu na
tela, e mande para quem enviou este guia — com essas duas informações a solução é
rápida.
