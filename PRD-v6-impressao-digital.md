# PRD V6 — Impressão digital acústica (F15)

## Por que

A transcrição (V5) resolve o repertório que não existe em base nenhuma, mas custa
**30 a 80 segundos por música** num Mac M2. Em 80 arquivos são ~1–2 horas; em
**10.000 arquivos são 100–200 horas** — inviável como primeiro recurso.

A impressão digital acústica calcula uma assinatura do áudio e a compara com uma
base pública. Custa **1 a 2 segundos por música** — cerca de 30× mais barato — e
identifica gravações comerciais com precisão alta. O acervo real do usuário tem
bastante material assim (Luiz Gonzaga, Caetano Veloso, Paulinho da Viola, Jackson
do Pandeiro, Os Tincoãs). O que ela **não** resolve é o repertório de nicho e as
gravações caseiras, que continuam sendo trabalho da transcrição.

O ganho não é só o título: identificada a música, o artista e o nome oficiais
alimentam a busca de letra que já existe, trazendo a **letra oficial** — melhor
que qualquer transcrição.

## O funil completo

Cada etapa recebe apenas o que a anterior não resolveu, e o resultado fica
gravado no MP3 — nenhum arquivo é processado duas vezes entre execuções.

| Etapa | Custo por música | Estado |
|---|---|---|
| 1. Tags + nome de arquivo + nome da pasta | instantâneo | pronto (V3) |
| 2. LRCLIB por título/artista + duração | ~0,5 s | pronto (V3) |
| 3. **Impressão digital (AcoustID)** | ~1–2 s | **esta spec** |
| 4. Transcrição (Whisper), só no que sobrou | 30–80 s | pronto (V5) |

## F15 — `curadoria.py identificar`

```bash
python3 tools/curadoria.py identificar ~/Musicas [opções]
  --chave CHAVE          chave da API do AcoustID (ou variável ACOUSTID_API_KEY)
  --com-letra            após identificar, busca a letra oficial no LRCLIB
  --csv arquivo.csv      registra o que foi aplicado, com confiança
  --sobrescrever-tags    permite substituir título/artista reais (destrutivo)
  --verboso              mostra pontuação e candidatos descartados
```

1. Calcular a impressão digital com `fpcalc` (Chromaprint), que devolve também a
   duração real do arquivo.
2. Consultar o AcoustID; a resposta traz gravações com pontuação de similaridade
   e metadados do MusicBrainz.
3. Escolher o melhor candidato: pontuação mínima **0,7** E duração compatível
   (±3 s = ALTA, ≤8 s = MÉDIA, >15 s desqualifica — as mesmas regras da V3).
4. Aplicar com as **mesmas travas de segurança da V5**:
   - tag real (não-placeholder) **nunca** é sobrescrita sem `--sobrescrever-tags`;
   - divergência entre a tag existente e o identificado vira linha `CONFLITO:` e
     não altera nada;
   - resultados com título/artista de placeholder são descartados;
   - o relatório e o CSV registram **o que foi aplicado**, com a confiança.
5. Com `--com-letra`, encadear a busca no LRCLIB usando o título/artista
   confirmados (reusa `buscar_lrclib`/`classificar`; a letra oficial entra sem
   marcador de transcrição).

Saída no padrão dos outros subcomandos:

```
[12/94] IDENTIFICADA: barco - Timoneiro.mp3 → Timoneiro / Paulinho da Viola (pontuação 0.94, mp3 232s, acoustid 231s) + letra
[13/94] SEM RESULTADO: barquinha - linda sereia.mp3
[14/94] CONFLITO: barco - Canoeiro.mp3 — tag atual "Canoeiro / Paulo Diniz" difere do identificado "Canoeiro / Leila Pinheiro" (não alterado)
Resumo: 94 arquivos | 31 identificadas | 12 letras oficiais | 48 sem resultado | 3 conflitos | 0 erros
```

## Requisitos técnicos

- **`fpcalc` (Chromaprint)** é dependência externa opcional: `brew install
  chromaprint` no macOS, pacote `chromaprint`/`libchromaprint-tools` no Linux,
  binário oficial no Windows. Ausente, o subcomando explica como instalar e sai
  com código 1 sem tocar em arquivo nenhum — como já faz o `transcrever` com o
  faster-whisper.
- **Chave de API do AcoustID**: gratuita, cadastro de um minuto. Sem chave, o
  subcomando explica onde obtê-la e sai. Nunca é gravada em disco pelo projeto.
- **Injeção de dependência**: `impressao_digital(caminho) -> (duracao, fingerprint)`
  e o `fetcher` HTTP entram por parâmetro, como o `fetcher` do LRCLIB e o
  `transcritor` da V5 — a suíte roda 100% offline, sem `fpcalc` e sem rede.
- **Cortesia de rede**: o AcoustID pede no máximo 3 consultas por segundo; pausa
  correspondente entre chamadas, e lotes de até 10 impressões por requisição
  quando a API permitir.
- Progresso `[12/94]` por arquivo; Ctrl-C encerra com `Resumo:` e CSV gravado.

## F15.1 — Estimativa antes de rodar

Acervos grandes não podem ser encarados às cegas. Um modo de amostragem mede em
poucos arquivos e projeta o total:

```bash
python3 tools/curadoria.py estimar ~/Musicas --amostra 10
```

Saída: quantos arquivos há, quantos estão incompletos, e a projeção de tempo por
etapa do funil no computador atual — por exemplo "identificar: ~4 min | transcrever
o restante: ~1h20 (modelo small) ou ~18 min (modelo tiny)". O curador decide com
número na mão em vez de descobrir depois de seis horas.

## Invioláveis (como em todo o projeto)

- **Nunca renomear nem mover arquivos.**
- Nunca alterar frames de áudio — só tags ID3.
- Nunca apagar dado existente sem opção explícita e destrutiva.
- O player não ganha código de impressão digital: isto é curadoria.

## Fora deste ciclo

- Enviar impressões digitais novas para a base do AcoustID (contribuição).
- Impressão digital dentro do player.
