# PRD V4 — Curadoria dentro do player + navegação por pastas

## Summary

Um lugar só para tudo: o coordenador seleciona a música no próprio Cancioneiro
e edita título, artista, temas e letra — com botão que busca a letra na
internet (LRCLIB) usando título+artista+duração. Ao salvar, as tags são
gravadas **no MP3** e a música é reindexada na hora. A sidebar ganha a
**árvore de pastas** do acervo, e clicar numa subpasta filtra a biblioteca.

### Revisão de princípios (registrar em DECISIONS)

- "O player nunca escreve" vira **"a reprodução nunca escreve"**: gravação só
  acontece na ação explícita "Salvar no arquivo" do modo de edição, e grava
  **apenas tags ID3** — nunca o áudio, nunca o nome do arquivo (renomear é
  proibido em todo o produto).
- "100% offline" continua para todos os fluxos, exceto o clique explícito em
  "Buscar letra na internet", que falha graciosamente sem rede.

## F10 — Edição de metadados no app

User flow:
1. Clique único seleciona a música; no painel de letra, botão **"Editar"**
   (text #0F766E, ao lado do "Aa").
2. O painel vira formulário: campos **Título** e **Artista** (inputs),
   **Temas** (chips com "×" para remover + input "Adicionar tema" com Enter),
   **Letra** (textarea monoespaçada não, mesma fonte, altura flexível).
3. Botão **"Buscar letra na internet"** (outline #0F766E): usa
   título+artista digitados (não salvos ainda) + duração do arquivo; ao achar
   com confiança suficiente, preenche a textarea (sobrescreve o rascunho com
   confirmação se a textarea não estiver vazia: "Substituir a letra atual pelo
   resultado da busca?"). Sem resultado: aviso "Letra não encontrada para este
   título e artista." (warning). Sem rede: "Sem conexão — a busca de letra
   precisa de internet." (warning).
4. **"Salvar no arquivo"** (primário #0F766E): grava TIT2/TPE1/USLT/TXXX:TEMAS
   no MP3 via backend, reindexa o arquivo, atualiza biblioteca/painel e mostra
   toast "Alterações salvas em {nome do arquivo}." (success).
   **"Cancelar"** (text #374151) descarta e volta ao modo leitura.
5. Se a música em edição estiver tocando, o app **pausa antes de gravar**
   (arquivo pode estar em uso no Windows) e mantém pausado após salvar.

Regras/erros:
- Título vazio no salvar: borda #B91C1C + "Dê um título à música." — não salva.
- Letra vazia é permitida (remove o USLT); temas vazios removem o TXXX.
- Arquivo sumiu do disco: toast de erro padrão de arquivo não encontrado;
  edição desabilitada para músicas indisponíveis.
- Falha de escrita (permissão/lock): toast "Não foi possível salvar em {nome}."
  (error) e o formulário permanece aberto com os dados digitados.

Backend (Rust):
- `write_tags(song_id, title, artist, lyrics, temas)` — grava via lofty
  (ID3v2.4; USLT lang "por"; TXXX desc TEMAS com normalização igual à do
  Python: minúsculas, dedup e ordem sem acento), **nunca renomeia**, e
  reindexa o arquivo (upsert) devolvendo a Song atualizada.
- `fetch_lyrics_online(title, artist, duration_seconds)` — busca no LRCLIB
  (search + score por similaridade textual e duração, regras da V3; GET com
  timeout 10s, User-Agent "Cancioneiro/0.4") e devolve
  `{ lyrics, matched_title, matched_artist, confidence: "alta"|"media" }`
  ou null quando nada confiável. Único ponto de rede do app.

Acceptance Checks:
- ✓ Round-trip: write_tags grava e o indexer relê título/artista/letra/temas
  idênticos (acentos e \n preservados); arquivo NÃO é renomeado; áudio
  (frames MPEG) não muda de duração.
- ✓ Salvar com título vazio é bloqueado com a mensagem exata.
- ✓ Letra vazia remove USLT; temas vazios removem TXXX:TEMAS.
- ✓ Após salvar, buscar por trecho da letra nova encontra a música (FTS
  atualizado) sem reiniciar o app.
- ✓ fetch_lyrics_online com stub: resultado com duração divergente >15s é
  descartado; sem rede → erro tratado (frontend mostra o aviso exato).
- ✓ Música tocando é pausada antes do write.
- ✓ Fluxos de reprodução/busca/playlist continuam sem modificar arquivos
  (teste de hash da seção 8 permanece, excluindo apenas o fluxo de salvar).

## F11 — Navegação por pastas na sidebar

- Seção "Biblioteca" da sidebar expande em árvore: cada pasta registrada é a
  raiz; subpastas (derivadas dos file_path das músicas — sem mudança de
  schema) aparecem aninhadas, apenas as que contêm MP3s (direta ou
  indiretamente). Contador de músicas por pasta.
- Clique numa pasta: filtra a lista central para as músicas daquela subárvore
  (prefixo de caminho), com chip removível no topo:
  `📁 {nome da subpasta} ×`. Busca digitada refina DENTRO do filtro ativo.
- Clique em "Biblioteca" (ou no ×) limpa o filtro.
- Estado do filtro não persiste entre sessões (V4).

Acceptance Checks:
- ✓ Acervo com subpastas "1" e "2" mostra as duas na árvore com contadores.
- ✓ Clicar em "1" lista só as músicas de 1/ (e subpastas de 1/).
- ✓ Buscar com filtro ativo retorna só matches dentro da subárvore.
- ✓ × remove o filtro e restaura a biblioteca completa.
- ✓ Pastas sem MP3 não aparecem; árvore atualiza após reindexar.

## Out of scope (V4)

- Edição em massa pela UI (continua no CLI/CSV da V2.2/V3).
- Renomear/mover arquivos ou pastas pelo app — nunca.
- Buscar título/artista pela internet no app (a V3 CLI cobre a carga inicial).
- Persistir o filtro de pasta entre sessões.
