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

## V0.4 — Quick wins do teste real + busca por pasta (F12) + lote no app (F13)

45. **Tema pendente entra no salvamento**: texto digitado no campo de tema sem
    Enter é commitado ao salvar/blur (commitTemaInput) — era perda silenciosa
    de dado na UX real de toque.
46. **Pastas na FTS, não na Song**: coluna songs.pastas (subpastas entre a
    pasta importada e o arquivo) indexada na FTS para busca por nome de pasta;
    o struct Song NÃO expõe o campo (a UI já deriva a árvore dos file_path —
    decisão 43). Match só em pasta não gera snippet (snippet segue exclusivo
    da letra, índice 2 da FTS). Migração v1/v2→v3 zera file_mtime (-1) para o
    próximo scan repopular.
47. **Proposta do lote carrega a letra**: enrich_scan devolve a letra achada
    na própria proposta — aplicar não faz segunda rodada de rede. Erro de rede
    por música vira proposta com `error` (linha desabilitada na UI); o lote
    nunca aborta.
48. **Apply do lote nunca apaga nem aborta**: campos None releem o valor atual
    do banco e o regravam (letra/artista/temas preservados); reusa
    writer::write_tags (validação + reindexação únicas). Falha em uma música
    não derruba o lote — cada uma devolve EnrichApplyResult (song gravada ou
    error), e a UI sincroniza as que gravaram mesmo quando outras falham
    (achado do QA: abortar deixava disco e tela divergentes). Aplicar usa o
    lock compartilhado — N gravações seguram a busca por alguns segundos,
    aceito para lotes de dezenas de músicas (a varredura, que demora minutos,
    usa conexão dedicada).
49. **BAIXA marcável, nunca pré-marcada**: no teste real a maioria dos palpites
    de nome de arquivo estava certa, mas a decisão é humana — ALTA pré-marcada,
    MÉDIA/BAIXA desmarcadas, checkbox por linha + Marcar/Desmarcar todas.
50. **Revisão como overlay modal** (não uma View nova): estado em enrichStore
    com guarda de corrida (fechar durante a varredura descarta o resultado ao
    chegar); dupla varredura bloqueada; se a música tocando está entre as
    selecionadas, pausa antes de gravar (regra da decisão 40).

## V0.5 — Transcrição, e as travas que o QA exigiu

51. **Transcrição fica no script, não no player**: o instalador segue com ~5 MB
    e sem modelo embutido, não há whisper.cpp para compilar nas 4 plataformas do
    release, e o trabalho pesado fica na máquina de quem cura. Quem recebe o
    acervo pronto não precisa de nada disso — os dados viajam no MP3.
52. **Identificação pelo refrão**: o LRCLIB não pesquisa conteúdo de letra e
    buscador web genérico exigiria chave paga; como o título de uma canção quase
    sempre é a frase mais repetida, transcrever um trecho e consultar essa frase
    como título (confirmando pela duração) cobre o mesmo objetivo de graça.
53. **Palpite vindo do áudio não prova nada** (achado CRÍTICO do QA): ao
    contrário do `enriquecer`, cujo palpite nasce da própria tag — casar ali
    implica consistência —, o refrão vem do áudio e pode ser alucinação do
    motor. Daí quatro travas: lista de alucinações conhecidas descartadas antes
    da consulta; candidato precisa de 2 palavras, 8 caracteres e repetição real;
    tag real nunca sobrescrita em nenhuma confiança (`--sobrescrever-tags` é a
    exceção explícita); divergência vira `CONFLITO` sem gravar.
54. **A marca de origem descreve a letra ATUAL, não a história do arquivo**:
    qualquer gravação de letra sem origem informada limpa `TXXX:LETRA_ORIGEM`,
    nos dois stacks. No Rust, o writer compara a letra nova com a do arquivo —
    assim o repasse de letra inalterada (caminho do lote) preserva a marca
    legítima de graça.
55. **`--forcar` seletivo**: reprocessa só letra vinda de transcrição (trocar de
    modelo é o caso real); apagar letra oficial exige `--forcar-tudo`.
56. **Gravação de tag atômica**: cópia temporária na mesma pasta, gravação nela,
    troca de lugar. `ID3.save()` do mutagen redimensiona no lugar, e escrever
    letra em 81 arquivos que não tinham nenhuma é justamente o caso de
    crescimento — crash ou disco cheio truncaria o MP3.
57. **Relatório e CSV registram o aplicado, não o sugerido**, com coluna de
    confiança: um arquivo de conferência que mostra o que *não* foi feito é pior
    que não ter arquivo.
58. **Proposta do lote é validada contra o banco na hora de aplicar**: a
    varredura em segundo plano convida a editar a música no meio do caminho, e
    aplicar a proposta antiga apagaria a edição. A proposta ecoa o estado que
    viu; divergiu, não grava e explica.
59. **Cancelar cancela**: `enrich:progress` carrega `scan_id` e existe comando de
    cancelamento com flag por varredura viva. Sem isso o backend seguia
    consultando por minutos e os eventos da varredura zumbi bagunçavam a barra
    da seguinte.
60. **"Nada a ajustar" é mentira perigosa em acervo real**: com ~3% de cobertura
    o coordenador leria isso como "pasta completa". O aviso diz quantas foram
    conferidas, que não estão na internet, e aponta a transcrição.

## V6 (especificada, não implementada)

61. **Funil de identificação por custo crescente**: tags/nome de arquivo →
    LRCLIB → impressão digital acústica (~1-2 s) → transcrição (~30-80 s). Cada
    etapa recebe só o que a anterior não resolveu; a 30x de diferença entre as
    duas últimas é o que decide se um acervo de 10 mil arquivos é viável.
    Spec em `PRD-v6-impressao-digital.md`.

## V6.1 — Vagalume, nome do arquivo e o que o acervo real ensinou

62. **VAD nunca sobre canto**: `vad_filter` é detector de FALA; sobre música
    com instrumentação descarta quase tudo antes de o modelo ouvir (35% do
    acervo real voltou vazio, com músicas inteiras em 51 caracteres).
    Desligado, mais `condition_on_previous_text=False` contra os laços.
63. **Cada fonte tem a rigidez que suas provas sustentam.** A tolerância de
    grafia do `_discorda` existe porque a DURAÇÃO confirma o casamento no
    LRCLIB/AcoustID. Reusá-la no Vagalume, que não tem duração, gravou a letra
    de "Ponto de Ogum" numa música "Ponto de Oxum". O Vagalume tem comparação
    própria e estrita (mesmas palavras, mesma ordem, sem contenção) e só aceita
    resposta `type: "exact"` — `aprox` é a API dizendo que achou outra.
64. **Palpite do áudio precisa de prova objetiva**: o refrão transcrito só
    identifica a música se ele estiver na letra devolvida. Título parecido com
    duração próxima casou "Lampejo" com Roberto Carlos.
65. **Palavra comum sozinha nunca é tag-lixo**: a regra de ruído exige mais de
    uma palavra E marca de ripador. Sem isso, "Pista", "Gravação" e "Sem Nome"
    viravam campo vazio e eram sobrescritos em silêncio — campo vazio não gera
    conflito, e é aí que o dado morre.
66. **Piso do limpador de repetição na ordem do defeito real** (200 caracteres):
    a maior repetição legítima medida no repertório tem 32 ("Adeus adeus adeus
    adeus adeus Bahia"); os laços do Whisper têm 402 a 600. Piso baixo demais
    mutila letra de verdade, dentro do arquivo do usuário, para sempre.
67. **Nome do arquivo é soma, não troca**: segunda linha na lista, secundária
    ao título, e por extenso no painel. As pessoas se organizam por nome de
    arquivo há anos, e ele é rede de segurança quando a identificação erra.
    Não é impresso quando o título JÁ é o nome (música sem tag), comparando sem
    caixa mas COM acento e normalizando NFC — "Coracao.mp3" sob "Coração"
    continua aparecendo, que é a diferença que alguém quer ver.
68. **Altura de linha variável exige chave estável**: com a segunda linha, as
    linhas deixaram de ter altura uniforme, e o virtual-core memoiza medidas
    sem observar `estimateSize`. `getItemKey` pelo id da música invalida o
    cache na hora certa — sem isso, trocar entre pastas de mesma contagem
    posicionava linhas com as alturas da pasta anterior.
69. **Contraste mínimo vale para texto secundário também**: a linha do nome
    nasceu com 2,54:1 e foi para 5,98:1. O produto é lido em tela de notebook,
    em sala mal iluminada, por quem está conduzindo uma reunião.

## V7 — Instrumental, busca por nome de arquivo e a duração que mente

70. **Marca de instrumental no próprio MP3** (`TXXX:INSTRUMENTAL`): música sem
    voz era pendência eterna — entrava em toda varredura, transcrevia vazio,
    virava erro, e era tentada de novo para sempre. Marca automática quando a
    transcrição volta vazia com áudio legível; áudio ilegível continua erro,
    são coisas diferentes. Fora da FTS: temas são indexados porque são
    vocabulário que alguém escreveu PARA achar a música; procedência e
    "é instrumental" não são conteúdo pesquisável.
71. **A escolha humana vence a rotina**: nem `--forcar` nem `--forcar-tudo`
    desmarcam instrumental (falam de letra a refazer, não de rediscutir se a
    música tem voz), o lote passa "não mexer" no parâmetro de três estados, e
    o editor só manda a marca quando a pessoa toca na caixa — sem isso, salvar
    um título com a visão do banco desatualizada apagava a marca em silêncio.
72. **Duração precisa ser PROVADA, não lida** (achado CRÍTICO do QA): sem
    cabeçalho Xing o mutagen estima pelo primeiro quadro — 300 s reais viraram
    2365 s, e uma música cantada foi marcada instrumental para sempre. Ordem de
    autoridade: quem transcreveu sabe quanto áudio existe; senão, medição
    quadro a quadro; senão, o cabeçalho, e só quando a medição confirma. Sem
    prova, duração é desconhecida — e transcrição rala sem duração provável
    vira `ADIADA`, sem gravar nada. **Margem de segurança não protege contra
    erro de ordem de grandeza; só corroboração protege.**
73. **Nome do arquivo é buscável, sem extensão e sem duplicar**: ninguém digita
    "mp3", e como todo arquivo indexado é .mp3 isso entregaria a biblioteca a
    um token. Nome igual ao título (música sem tag) não é indexado: o alcance
    seria o mesmo, mas o ranqueamento soma ocorrências entre colunas e
    empurraria a parte mal etiquetada para cima da bem etiquetada em toda
    busca. A coluna vai no FIM da FTS porque o trecho destacado sai por
    POSIÇÃO (índice 2 = letra) — inserir no meio faria a busca citar o campo
    errado em silêncio; há teste fixando a ordem.
74. **A identificação pelo refrão saiu do caminho padrão** (medido em duas
    execuções de 94 arquivos: 0 e 1 identificação, esta errada e aplicada, com
    3 e 5 conflitos). Refrão genérico passa de graça pela prova "está na
    letra": "não aguento" está mesmo na letra de "Não aguento mais". Ligada
    explicitamente, exige duração no resultado, teto de 8 s (o erro medido
    estava em 15 s) e refrão distintivo.
75. **Ação perigosa que virou inócua tem de recusar, não silenciar**:
    `--sobrescrever-tags` sem a identificação ligada é recusado — autorização
    destrutiva ignorada em silêncio é pior que erro.
76. **Uma medida única para a faixa do botão flutuante**: três telas com o
    mesmo número copiado à mão levaram a corrigir uma e piorar duas. O E2E
    mede as três telas em duas larguras e varre TODOS os controles do
    cabeçalho, em vez de uma lista conhecida — teste que só olha onde o autor
    lembrou dá confiança falsa.
77. **Suítes não disputam as fixtures**: o pytest regenera os MP3s de
    `fixtures/`, que o cargo lê e o dev server serve. Isso dava falha fantasma
    no Rust e recarregava a página no meio do E2E — falha diferente a cada
    rodada, que é o que ensina uma equipe a ignorar a suíte. Snapshot para o
    Rust, `fixtures/` fora do watcher do Vite.
