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

## Interface

```bash
python3 tools/curadoria.py transcrever ~/Musicas [opções]
  --modelo {tiny,base,small,medium}   padrão: small (equilíbrio no acervo real)
  --idioma pt                         padrão: pt
  --trecho SEGUNDOS                   padrão: 90 (trecho de identificação)
  --so-identificar                    só F14.1; nunca transcreve a música inteira
  --so-transcrever                    pula F14.1; transcreve direto
  --forcar                            refaz só as letras vindas de transcrição
  --forcar-tudo                       refaz qualquer letra (apaga letra oficial)
  --sobrescrever-tags                 DESTRUTIVO: ALTA pode trocar tag real
  --csv arquivo.csv                   registra o que foi feito, para conferência
  --verboso                           mostra o trecho transcrito e os candidatos
```

Saída por música, no padrão dos outros subcomandos (a linha `IDENTIFICADA`
mostra o que foi **aplicado** no arquivo, com a confiança do casamento):

```
IDENTIFICADA: barquinha - Faixa 5.mp3 → Me Apresento / Barquinha (ALTA, refrão "me apresento", mp3 214s, lrclib 216s)
TRANSCRITA: barco - segura o remo.mp3 (1.842 caracteres, 4m12s de áudio em 38s)
CONFLITO: barco - remo.mp3 — tag atual "Segura o Remo / Mestre Irineu" difere do identificado "Música / Outro" (não alterado)
NÃO IDENTIFICADA: barco - Timoneiro.mp3
PULADO: barco - Timoneiro.mp3 (já tem letra)
ERRO: arquivo.mp3 — áudio ilegível
Resumo: 94 arquivos | 6 identificadas | 71 transcritas | 0 não identificadas | 13 puladas | 0 conflitos | 4 erros
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
