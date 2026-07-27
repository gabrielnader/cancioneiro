# DECISIONS.md — Decisões de implementação (onde o PRD é omisso)

Registro das decisões tomadas durante o desenvolvimento autônomo. Regra: sempre a
opção mais simples que passa nos Acceptance Checks do PRD.

## Fase 0 — Scaffold e fixtures

1. **React 18 vs 19**: o scaffold oficial do `create-tauri-app` gera React 19; o PRD
   especifica React 18. Fizemos downgrade para React 18.3 (PRD é a fonte da verdade).
2. **Tailwind CSS v4** (plugin `@tailwindcss/vite`): o PRD pede "Tailwind CSS" sem
   versão. v4 é a versão atual e dispensa `tailwind.config.js`/PostCSS — opção mais
   simples. Cores do PRD usadas como valores arbitrários (`bg-[#0F766E]`) ou tokens.
3. **Encoder MP3 das fixtures**: o PRD proíbe baixar áudio; MP3 não pode ser gerado
   por stdlib. `tools/make_fixtures.py` gera WAV (stdlib `wave`) e codifica com o
   binário `lame` (presente no sistema; documentado no README como pré-requisito de
   desenvolvimento). Alternativa rejeitada: embutir bytes MP3 no repositório (menos
   reprodutível/auditável).
4. **Persistência de preferências de UI** (volume, painel de letra, nível de fonte):
   `localStorage` do WebView — opção mais simples; o PRD só exige que persistam entre
   sessões. Playlists e biblioteca ficam no SQLite, como manda o Data Model.
5. **Ambiente de desenvolvimento Linux**: o alvo do produto é Windows/macOS, mas o
   desenvolvimento/CI roda em Linux (container). Instaladas as libs de sistema do
   Tauri (webkit2gtk-4.1 etc.). `npm run tauri dev`/`build` verificados em Linux;
   builds Win/Mac documentados no README.
6. **Validação "não é MP3" no `embed_lyrics.py`**: baseada em conteúdo, não em
   extensão — tenta carregar com `mutagen.mp3.MP3()`; qualquer falha (arquivo
   inexistente, .txt, bytes aleatórios) produz a mensagem exata
   `ERRO: arquivo inválido ou não encontrado: {path}` com exit 1.
7. **Substituição de USLT**: `tags.delall("USLT")` antes de `tags.add(...)`;
   TIT2/TPE1 via `setall`. Salvo sempre como ID3v2.4 (`v2_version=4`).
8. **Letra da fixture `com_letra.mp3`**: constante `LETRA_COM_LETRA` exportável em
   `make_fixtures.py`, sem newline final (a spec é ambígua quanto ao \n terminal;
   os testes fixam essa escolha).
9. **`corrompido.mp3` determinístico**: `random.Random(42)`, 4096 bytes — testes
   verificam reprodutibilidade byte a byte.
10. **`--check` em MP3 sem tags**: imprime placeholders ("(sem título)",
    "(nenhuma letra embutida)") em vez de falhar — o arquivo em si é válido.
11. **`sem_tags.mp3`**: `ID3.delete()` defensivo após o encode (o lame pode gravar
    frames residuais); teste garante `ID3NoHeaderError`.

## Fase 1 — correções pós-QA

12. **Coluna `songs.available`**: não consta do Data Model do PRD, mas é exigida
    pelo estado de erro de F1 ("músicas ficam marcadas indisponíveis... não são
    deletadas" quando a pasta some). Adicionada como INTEGER default 1.
13. **Pastas sobrepostas rejeitadas**: `add_folder` canonicaliza o caminho e
    rejeita pasta que contenha (ou esteja contida em) pasta já registrada, com o
    erro "pasta sobreposta a uma pasta já adicionada: {path}". Motivo: file_path
    é UNIQUE — com pastas sobrepostas, remover uma delas apagaria músicas (e
    itens de playlist, em cascata) ainda cobertas pela outra. O PRD é omisso;
    esta é a opção mais simples que evita perda de dados.
14. **mtime em milissegundos** (não segundos): evita perder edição feita no
    mesmo segundo da indexação com o mesmo tamanho de arquivo.
15. **Scan não bloqueia o app**: comandos `scan`/`add_folder` usam conexão
    SQLite dedicada (WAL + busy_timeout 5s) quando o banco é file-backed, para
    busca/listagem continuarem respondendo durante a varredura ("rescan em
    background" do PRD). `scan_all` pré-conta os arquivos para o progresso ser
    global ("n de total"), sem reiniciar a cada pasta.

## Fases 2–5 — decisões de frontend/busca

16. **Query FTS sempre literal**: cada token vira frase entre aspas; o último token
    é prefixo (`"cora"*`) para busca enquanto digita. Operadores FTS do usuário
    viram separadores/texto — nunca erro de sintaxe.
17. **Marcadores de highlight**: o snippet usa U+E000/U+E001 (área privada do
    Unicode) como delimitadores — não colidem com texto real de letra; o frontend
    converte em `<mark>`.
18. **Snippet só quando o match foi na letra**: espelha o PRD ("quando o match foi
    na letra"); match apenas em título/artista não exibe trecho.
19. **`search` com LIMIT 200**: o PRD não define limite; 200 resultados ordenados
    por relevância cobrem o caso de uso (o usuário refina a busca). Campo
    vazio/só-especiais NÃO passa pelo LIMIT — devolve a biblioteca completa.
20. **Contador "{n} resultados"**: exibido apenas quando a query tem ao menos um
    token alfanumérico (`hasSearchTokens`), espelhando o sanitizador — query só de
    operadores é tratada como campo vazio também na UI.
21. **Ordenação alfabética pt-BR**: collation SQLite customizada ("ptbr") que
    ignora caixa e acentos ("Água" antes de "banana"); o COLLATE NOCASE padrão
    ordenaria acentuados depois de "z".
22. **Fila do player vs. remoção durante reprodução**: quando a música atual sai
    da playlist, o player continua tocando ("detached") e rastreia o PRÓXIMO item
    pela identidade (id), sobrevivendo a remoções e reordenações subsequentes.
23. **Menu "Adicionar à playlist" em portal**: as linhas virtualizadas usam
    `transform` (stacking context próprio); um dropdown inline ficaria por baixo da
    linha seguinte. O menu renderiza em `document.body`.
24. **Duplo-clique na mesma música reinicia do zero** (`playRequestId`): o PRD é
    omisso; é o comportamento padrão de players.
25. **Botão "Ocultar/Mostrar letra"**: flutuante no canto superior direito da
    coluna central — precisa existir também quando o painel está oculto.
26. **`reorder_playlist` transacional e validado**: rejeita conjuntos de itens que
    não cobrem exatamente a playlist (evita positions duplicadas).

## Fase 6 — E2E e empacotamento

27. **E2E real vs. mockado**: Playwright roda o frontend no Chromium com IPC
    mockado (`mockBackend.ts`, persistido em localStorage para simular restart).
    REAL: UI completa, stores, atalhos, persistência e áudio (MP3s de fixtures
    decodificados de verdade, incluindo avanço automático de playlist). MOCKADO:
    comandos Rust — cobertos por `cargo test` (integração real com SQLite+lofty,
    round-trip Python→Rust e teste de imutabilidade dos MP3s). Motivo: o
    tauri-driver não suporta macOS (PRD, seção 2).
28. **Cobertura frontend**: medida em stores/hooks/lib (como pede o PRD);
    `api.ts` (cola fina de IPC) e `types.ts` (só tipos) excluídos — o lado real do
    IPC é coberto por cargo test + E2E.
29. **Servidor de fixtures no Vite**: middleware próprio servindo `fixtures/*.mp3`
    com suporte a Range (sem Content-Length/Range o Chromium não faz seek).
30. **Toast dura 5s e é clicável para fechar**: PRD omisso quanto à duração.
31. **Botão "+" visível também na linha selecionada**: o PRD define o "+" como
    hover-only ("aparece ao passar o mouse"), o que o torna inacessível por
    toque e teclado. Mantido o hover e adicionada a visibilidade quando a linha
    está selecionada — acomodação de acessibilidade, não feature nova.

## V2.1 — Temas (PRD-v2-temas.md)

32. **Frame TXXX:TEMAS**: temas ficam no próprio MP3 (mesma filosofia da letra),
    num frame TXXX desc="TEMAS", UTF-8, valor "tema1; tema2". Normalização na
    gravação: trim, colapso de espaços, minúsculas, dedup e ordenação sem
    acento/caixa (NFD + casefold). O exemplo literal do PRD ("esperança; água")
    cede à regra de normalização → valor real "água; esperança".
33. **Migração de banco v1→v2** (`PRAGMA user_version`): nova coluna
    songs.temas, FTS recriada com a coluna extra e repovoada; file_mtime zerado
    (-1) força o próximo rescan a reler os arquivos e popular temas. Playlists
    intactas (testado).
34. **Busca por tema**: mesma caixa de busca (coluna temas no FTS5, mesmo
    tokenizer sem acentos); match só em tema não gera snippet de letra. Chip de
    tema clicável (linha e painel) preenche a busca com o tema.
35. **Operação só-de-temas no CLI ignora --title/--artist** (que na V1 sempre
    acompanharam gravação de letra); adds aplicam antes de removes quando
    combinados. Ambiguidade da spec resolvida pela opção mais simples.

## V2.2 — Curadoria em massa (tools/curadoria.py) e release

36. **CSV como formato de edição em massa**: o coordenador organiza o acervo em
    planilha (Excel/LibreOffice; UTF-8 com BOM). Campos vazios nunca apagam —
    só o que for preenchido é gravado. `--dry-run` validado por hash byte a byte.
37. **LRCLIB apenas na curadoria**: `buscar-letra` consulta a API pública do
    LRCLIB sob demanda, com fetcher injetável (testes 100% offline). O player
    permanece sem qualquer código de rede.
38. **Relatório com arquivo ilegível**: tabela mostra "(ilegível)"; no CSV o
    título sai vazio, para o round-trip relatorio→aplicar não gravar o texto
    "(ilegível)" como TIT2.
39. **Distribuição via GitHub Actions**: o ambiente de desenvolvimento é Linux;
    binários Windows/macOS nascem no workflow release.yml (tauri-action) a cada
    tag v*, publicados em GitHub Releases. CI (ci.yml) roda a suíte completa
    a cada push.

## V4 — Curadoria no player + navegação por pastas

40. **Princípio revisado**: "o player nunca escreve" vira "a REPRODUÇÃO nunca
    escreve" — gravação só na ação explícita "Salvar no arquivo" do modo de
    edição, e apenas tags ID3 (nunca o áudio, nunca o nome do arquivo — renomear
    é proibido em todo o produto). "100% offline" vale para tudo exceto o clique
    explícito em "Buscar letra na internet" (falha graciosa sem rede).
41. **USLT/TXXX escritos via frames Id3v2 diretos** (não a Tag genérica do
    lofty): a conversão genérica gravaria USLT com lang "XXX"; o PRD exige
    "por" (compat mutagen). Frames alheios (capa etc.) são preservados.
42. **Editar desabilitado enquanto a letra carrega**: evita a corrida de abrir
    o formulário com a textarea vazia e o salvar apagar a letra.
43. **Árvore de pastas derivada dos file_path** (sem mudança de schema);
    filtro aplicado na exibição (client-side) — busca digitada refina dentro
    do filtro; navegação por teclado respeita o filtro.
44. **Enriquecer (V3.1) pós-teste real**: consulta limpa + track_name/artist_name
    com fallback q= (hífens/pontuação zeravam o full-text do LRCLIB); em BAIXA,
    Enter pula e aceitar exige 'a'; BAIXA nunca sobrescreve tags existentes.
