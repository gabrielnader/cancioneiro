# Cancioneiro — o que testar, e como avisar

Obrigado por testar. Você está entre as primeiras pessoas a usar isto, e o mais
valioso que você tem a dar não é elogio: é **o momento em que você não entendeu o
que estava na tela**, ou em que o programa fez algo que você não esperava.

Este guia é curto de propósito. Instalação e uso normal estão no
**GUIA-DE-INSTALACAO.md** — leia aquele primeiro e volte aqui.

---

## Por que o Windows é o mais importante

Sendo direto: **o Cancioneiro nunca foi aberto num Windows por uma pessoa.** Ele
compila, o instalador é gerado e as peças passam em teste automático — nada além
disso. Você é a primeira pessoa de verdade.

Isso significa que **qualquer coisa esquisita que você vir provavelmente é defeito
nosso, não erro seu.** Não tente contornar em silêncio: é justamente o contorno que
a gente precisa saber.

---

## As cinco coisas que mais precisamos saber

### 1. O programa abre?

A tela azul do Windows ("O Windows protegeu o seu computador") é esperada — o
caminho está no guia de instalação. O que **não** é esperado: o antivírus apagar o
arquivo, o instalador falhar no meio, ou o programa abrir e fechar sozinho.

### 2. Ele acha suas músicas?

Aponte para a pasta onde elas estão e veja se a contagem bate. Se seu acervo estiver
num HD externo ou pen drive, teste **com o disco desconectado também** — o programa
deve avisar em vez de sumir com as músicas.

### 3. Dá para usar enquanto ele trabalha?

Rode **Configurações → Buscar dados desta pasta** e, enquanto a barra anda,
**tente usar o programa**: procure uma música, toque outra, troque de pasta.

Se ele travar, congelar, ou o cursor virar a bolinha de "ocupado", **isso é
defeito** e é o mais importante que você pode encontrar. Já aconteceu uma vez no Mac
e a gente só descobriu porque alguém tentou.

### 4. Você entendeu a tela de revisão?

No fim da busca aparece a lista do que o programa quer gravar. Ela é o coração do
produto e a parte que mais nos preocupa.

Perguntas que valem ouro:

- Você entendeu **o que ia acontecer** antes de clicar em "Aplicar selecionadas"?
- Teve alguma linha que você **não soube decidir**?
- Teve algum texto **longo demais**, que você pulou sem ler? (Diga qual. A gente já
  encurtou uma vez e vai encurtar de novo.)
- O grupo fechado, já marcado, com as sugestões seguras: você **percebeu que ele
  estava marcado**?
- Depois de clicar em "Aplicar selecionadas", a caixa **continua aberta** e as linhas
  gravadas ficam marcadas como **Gravada**. Isso ficou claro, ou você achou que tinha
  dado errado por a caixa não ter fechado? (Isto é novo nesta versão e nasceu de um
  relato — aplicar fechava tudo e jogava fora o trabalho da busca.)

### 5. Alguma música ficou pior?

Esta é a que mais importa. O programa **nunca deve** piorar um arquivo seu.

Se depois de aplicar algo você notar que uma música perdeu o título certo, ganhou o
artista errado, ou ficou com uma letra que não é dela — **avise na hora e diga qual
música**. Nada é apagado sem passar pela sua conferência, mas é exatamente por isso
que a gente precisa saber se passou.

---

## Como avisar

Não precisa formatar nada bonito. O que ajuda de verdade:

1. **O que você estava fazendo** (em uma frase).
2. **O que você esperava** que acontecesse.
3. **O que aconteceu.**
4. **Uma foto da tela**, se tiver mensagem escrita nela. A mensagem exata importa
   mais que a descrição dela.

Se o programa tiver mostrado um erro, copie o texto **inteiro**, inclusive a parte
que parece código. Frase de erro pela metade já nos fez perder tempo procurando a
coisa errada.

---

## O que já sabemos que está imperfeito

Para você não gastar tempo relatando o que a gente já conhece:

- **A letra escrita ouvindo o áudio erra bastante**, e às vezes pula trechos inteiros
  da música. Estamos medindo isso agora e testando um modelo maior. Se você usar,
  diga se a letra ficou **boa o bastante para achar a música** — não se ela ficou
  igual à oficial.
- **No Mac**, a cada atualização o sistema pode pedir permissão de novo. É por o
  programa não ter assinatura digital.
- **A busca em sites de letra acha pouco** — cerca de 3% num acervo real. Não é
  defeito: é que boa parte desse repertório nunca foi publicada na internet.

---

## O que NÃO acontece, e se acontecer é grave

Estas são promessas do produto. Se alguma se quebrar, é o relato mais urgente
possível:

- **Nenhum arquivo de música é renomeado, movido ou apagado.** Nunca. Em nenhuma
  tela, por nenhum botão.
- **Tocar uma música nunca modifica o arquivo.** Só gravar de propósito modifica.
- **Nada do seu acervo sai do seu computador.** As buscas na internet mandam só
  título e artista; o reconhecimento pelo som manda um resumo numérico, nunca o
  áudio; e escrever a letra ouvindo o áudio roda inteiramente na sua máquina.
- **Nada é gravado sem você conferir e clicar.**
- **Não existe cadastro, senha nem coleta de dados.**
