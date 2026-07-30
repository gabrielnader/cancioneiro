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

## V8/F18 fase 1 — o funil dentro do app, e o que o QA achou nele

78. **A curadoria mudou de dono**: são ~40 pessoas curando cada uma o seu
    acervo, na própria máquina, e há acervos que o dono do produto não pode
    nem olhar. Isso não é detalhe de distribuição, é o que decide o projeto:
    o terminal precisa desaparecer por completo, e toda mensagem passa a ser
    a única explicação que alguém vai receber, porque não existe suporte a
    quem perguntar. O funil saiu do `tools/curadoria.py` e entrou em
    Configurações; o ✎ saiu da lateral, que é caminho do dia a dia.
79. **Letra que já existe não se apaga sozinha** (CRÍTICO do QA): uma música
    com tag "AudioTrack 03" e uma transcrição corrigida à mão entrava na
    varredura pelo nome placeholder, casava no LRCLIB pela duração e saía
    ALTA — e ALTA chega pré-marcada (decisão 49). Um clique destruía a
    transcrição e a marca de procedência. A proposta passa a carregar
    `has_lyrics` e `letra_origem`, a revisão avisa, e substituir letra é uma
    **segunda marcação, separada, desmarcada por padrão, que o "Marcar todas"
    não toca**. É isso que devolve segurança à pré-marcação de ALTA: ela
    aplica só nomes. O backend recusa a gravação sem consentimento explícito
    — o caminho normal nunca chega lá, e é justamente por isso que a recusa
    precisa existir. Porte tardio da decisão 55, que a linha de comando tinha
    desde sempre e o app nunca teve.
80. **Regra duplicada em duas linguagens diverge, e a divergência escolhe o
    pior momento para aparecer**: a contagem de candidatas em TypeScript
    afirmava espelhar a do Rust, não espelhava em três casos, e como ela
    desabilitava o botão, o único ponto de entrada do produto ficava cinza
    dizendo "não há nada para procurar" — a frase que a decisão 60 foi
    escrita para proibir — justamente nos acervos que mais precisavam:
    CD ripado com "Faixa 01…12"/"Artista Desconhecido", e pastas de
    instrumentais sem artista. A contagem virou comando (`enrich_count`)
    sobre a MESMA função da varredura. Contagem pendente ou falha nunca
    bloqueia o disparo.
81. **Quem clicou sabe o que quer**: o funil individual ignorava o que a
    pessoa tinha acabado de digitar (procurava por "Faixa 03" enquanto ela
    escrevera o nome certo) e, para música julgada completa, devolvia vazio
    sem tocar a rede — e a tela dizia "não achamos esta música nos sites de
    letra". Nada tinha sido procurado. O portão de completude saiu do
    individual, o título e o artista do formulário vão para a busca, e o
    vazio passa a significar uma coisa só. O curto-circuito de instrumental
    **fica**: ele não é filtro de completude, é integridade — instrumental
    casa com a versão cantada da mesma peça e gravaria a letra de outra
    gravação.
82. **Procedência é do dado, não do caminho**: letra do Vagalume aceita pelo
    editor era gravada sem `TXXX:LETRA_ORIGEM`, enquanto o lote e o
    `tools/curadoria.py` gravavam `vagalume` para a mesma letra — mesmo
    acervo, três caminhos, dois arquivos diferentes no disco. O editor passa
    a levar a procedência, e a **apaga assim que a pessoa edita a letra à
    mão**: a marca descreve o texto que está lá.
83. **"Sem conexão" não pode ser o nome de todo erro**: qualquer status HTTP
    que não fosse 404 virava "sem conexão" — 429, 500, e a chave do Vagalume
    digitada errada. A pessoa terminava com 95 linhas culpando a internet
    dela, que estava ótima, sem ninguém a quem perguntar. Mensagens
    distintas, e **chave recusada desliga a etapa 3 pelo resto da varredura**
    em vez de repetir a mesma acusação música após música.
84. **A chave do Vagalume É guardada em disco, e agora o texto diz isso**:
    quatro lugares no código juravam que não. Mandar 40 pessoas sem suporte
    redigitar uma chave de API a cada sessão é pior que o risco de uma chave
    gratuita de letras ficar nas preferências locais. O que mudou foi a
    verdade da copy: fica neste computador, não entra no banco de músicas,
    não é escrita nos MP3, não vai a lugar nenhum além do próprio Vagalume.
    **Documentação que mente sobre credencial é defeito, mesmo quando o
    comportamento é o certo.**
85. **Estimativa errada por ordem de grandeza é pior que estimativa
    ausente**, porque o PRD a promoveu a parte do fluxo: 2 s por música
    contra 6-8 s reais dizia "3 minutos" para uma busca de 11. O número
    passou a ser derivado no comentário, e a copy admite que internet lenta
    faz demorar bem mais — de novo a lição da decisão 72, agora numa
    estimativa em vez de numa duração.
86. **Nenhum texto pode afirmar completude que o programa não conhece**:
    "todas já têm título, artista e letra" era falso para instrumental, que
    fica fora de "incompleta" **por não ter letra**; a biblioteca vazia era
    descrita como completa; e o total vinha de `progress?.total ?? 0`, que
    transformava falha silenciosa da assinatura de progresso em "sua pasta
    está completa". Agora "não sabemos" é um estado, e não conta ninguém.
87. **Motivo de bloqueio é conteúdo, não `title=`**: botão desabilitado não
    recebe foco e `title` não é anunciado de forma confiável — num estado o
    motivo não existia em lugar nenhum. E a varredura de contraste, que a
    decisão 76 dizia varrer tudo, só rodava num dos quatro estados: só é
    verdade sobre a tela o que o teste visitou.
88. **Mock que discorda do backend certifica o contrato errado**: o mock
    trazia a regra antiga do instrumental, o portão do Vagalume invertido
    (consultando quando falta artista, e propondo nome novo — exatamente a
    falha "Lampejo × Roberto Carlos" da decisão 63) e comparação de
    obsolescência sem aparar espaço. O E2E passava exercitando chamadas que
    o backend real nunca faria. Predicado único no mock, portado do Rust —
    e o caso em que as três implementações discordavam, instrumental sem
    artista, não tinha teste em lugar nenhum e agora tem.
89. **Porte parcial é porte errado, e o pedaço que falta é sempre o que
    ninguém testou**: `unescape_html` tinha 13 entidades e nenhuma das que
    importam em português — `Cora&ccedil;&atilde;o` entrava literal na letra
    e no índice de busca; `is_placeholder` não tinha a regra de trecho nem a
    marca de ripador, então "04 Faixa 4 Artista Desconheci" passava por
    etiqueta real e a música sumia da curadoria para sempre. Ao completar o
    porte apareceu o oposto: o Rust marcava **"Pista" sozinha** como
    placeholder, e "Pista" é título real no repertório — o incidente do
    `_RUIDO_DE_ARQUIVO` reencenado num canto onde ninguém tinha olhado.
90. **Worktree compartilhado entre agentes paralelos precisa de commit cedo,
    não de disciplina**: um `git reset --hard` e um `git stash` apagaram o
    trabalho das duas frentes no meio da rodada, pela segunda vez no projeto.
    Regra nova: cada frente commita assim que sua suíte fecha, mesmo que a
    árvore inteira ainda não compile, e commits de salvaguarda são juntados
    antes de empurrar.
91. **Título que o indexador inventou não é etiqueta**: `indexer.rs` copia o
    nome do arquivo para o `title` quando o MP3 não tem TIT2, e o funil lia
    isso como etiqueta REAL e a preferia ao palpite limpo — a proposta saía
    igual ao que já estava lá e o no-op a derrubava. A etapa que se chama
    "nome do arquivo" não entregava nada justamente para quem não tem tag
    nenhuma, que é a metade pior etiquetada de um acervo de verdade; e um
    "Falamansa - Oh! Chuva.mp3" sem tags chegava a propor o texto inteiro
    como título E "Falamansa" como artista, duplicando o artista dentro do
    título. Achado ao investigar por que o mock e o Rust discordavam: **os
    dois lados de uma divergência merecem suspeita, e desta vez quem estava
    errado era o backend.** Fica de fora desta rodada a versão mais funda do
    mesmo defeito — título assim, com artista real e letra, ainda é julgado
    "completo" e some da curadoria —, porque mexer nisso muda a contagem de
    candidatas e o gasto de rede de toda varredura: é trabalho da fase 2.
92. **Comando síncrono do Tauri roda na thread principal, e a thread
    principal desenha a janela**: as varreduras, a indexação e a gravação em
    lote congelavam o app inteiro enquanto rodavam — sem repintura, sem
    interação, com o cursor de "ocupado" do sistema. Relatado em campo como
    "não vi barra de progresso em lugar algum". A barra existia, os eventos
    estavam sendo emitidos e o E2E os cobria: **o E2E roda contra o mock no
    navegador, onde não existe thread principal do Tauri para bloquear**.
    Quatro suítes verdes, 205 testes no Rust, e nenhuma delas podia pegar
    isto — é defeito que só existe dentro do binário. A regra ficou escrita
    no `commands.rs`: comando que faz rede, percorre disco ou escreve arquivo
    é `#[tauri::command(async)]`. E a lição maior, que já tinha aparecido com
    o `vad_filter` e com o botão de detalhes: **suíte verde mede o que a
    suíte alcança — e nenhuma delas alcançava o app de verdade.**

## V9/F18 fase 2 — os acessórios sob demanda e o funil em duas fases

93. **O funil não é uma fila por custo: são DUAS FASES.** A impressão digital
    estava ordenada no meio das fontes de letra, e isso era erro de
    categoria — ela não devolve letra nenhuma, devolve **identidade**, que é
    *entrada* de todas as outras. Fase A (que música é esta): etiquetas/nome
    e som. Fase B (qual é a letra): LRCLIB, Vagalume, transcrição. Também sai
    mais barato: sem nome conhecido são até 7 consultas ao LRCLIB, uma por
    palpite; com o nome verdadeiro é **uma**. A ideia de um RETORNO (voltar às
    etapas de letra depois do som), que chegou a entrar no PRD, some — a ordem
    por fases resolve o mesmo problema sem o ciclo.
94. **Inverter a ordem criou um risco novo, e ele está escrito**: o AcoustID e
    o LRCLIB conferem pela MESMA evidência — duração. Quando o primeiro erra,
    o segundo **confirma** o erro e devolve ALTA. Não são duas contas
    independentes; é a mesma conta feita duas vezes. Por isso a régua de
    aceitação do AcoustID não é afrouxável, nome recusado por ela não vaza
    para a fase B, e letra achada por nome vindo do som tem **teto MÉDIA** —
    MÉDIA não chega pré-marcada. Não temos taxa de falso positivo do AcoustID
    neste repertório (16% é acerto, não é o mesmo número): **isso só se
    reverte com medição, não com argumento.**
95. **Etiqueta ERRADA é modo de falha distinto de etiqueta faltando.** Caso
    real: "Te ver feliz, te ver contente" / "Caetano Veloso" que é "Viver
    Feliz" do Nilson Chaves. Nada ali é placeholder, então a música era
    julgada completa e o erro ficava invisível **para sempre** — e quem não
    conhece o repertório nunca desconfia; a música só não aparece quando
    procuram. Duas populações que o projeto tratava como uma: nunca publicada
    (só a transcrição resolve) e publicada mal etiquetada (todas as bases
    têm; nós é que procurávamos pelo nome errado). Daí o **modo de
    conferência**, que é trabalho distinto, com custo distinto, disparado de
    propósito — e o **conflito**, que mostra os dois lados e nunca corrige
    sozinho.
96. **Baixar e executar binário exige provar as três coisas separadamente**:
    que baixou, que é o arquivo certo, e que **executa**. Hash confere as duas
    primeiras e não diz nada sobre a terceira — o macOS recusa executável sem
    assinatura, com regra mais estrita no Apple Silicon. Daí um fluxo de
    fumaça que baixa, confere e **roda** o acessório sobre um MP3 real em
    macOS Apple Silicon, macOS Intel, Windows e Linux. Mesma família da
    decisão 92: defeito que só existe dentro do binário, no sistema
    operacional real, onde nenhuma das quatro suítes alcança.
97. **O arquivo só entra no cache depois de conferido**, e a guarda que apaga
    o temporário roda em qualquer saída que não seja sucesso, inclusive
    pânico. Um quarto estado, `Indisponivel`, foi acrescentado ao trio
    ausente/pronto/corrompido: baixar 5 MB para então dizer "o arquivo não
    confere" é **acusação falsa** quando o problema é que este build não tem
    chave para usá-lo. É a família das decisões 84 e 86 — não afirmar o que
    não se sabe — aplicada a um estado de máquina.
98. **`option_env!` lê variável de ambiente de compilação, e segredo de
    repositório não vira variável sozinho.** O PRD dizia que a chave entrava
    no binário em tempo de build; o código lia o lugar certo; **o passo do
    fluxo que põe o valor lá nunca foi escrito**. Toda build do CI saía sem
    chave — o que desligava a etapa do som, o que marcava o acessório como
    indisponível, o que recusava o download: a entrega inteira nasceria
    inerte. Nenhuma suíte veria, porque todas injetam a chave nos testes.
    **Especificação e implementação podem estar certas e o produto errado, se
    ninguém escreveu o pedaço que liga as duas.**
99. **A tag agora tem de bater com a versão do aplicativo, e o CI recusa
    quando não bate.** O `latest.json` sai com a versão do `tauri.conf.json`,
    não com a tag: taguear v0.9.0 esquecendo o bump publicaria um manifesto
    dizendo 0.8.1, o updater compararia `0.8.1 > 0.8.1`, daria falso, e a
    release ficaria **publicada e invisível** — ninguém atualizaria e ninguém
    perceberia, porque não há suporte a quem perguntar. Aconteceu nesta
    rodada e só não saiu porque o QA pegou. **Lembrança não é mecanismo.**
100. **Texto que ninguém lê não explica nada.** A copy foi escrita para
    resolver "não existe suporte" e passou do ponto — relatado em campo como
    "as mensagens estão muito longas". Régua nova, com teste: a primeira
    frase diz o que é; o resto só existe se responder a uma pergunta que a
    pessoa faria naquele momento; os desfechos cabem em 2 frases e 210
    caracteres; e jargão nosso ("ferramentas de curadoria") não aparece. Duas
    salvaguardas aprendidas no próprio passe: **conferir antes de encurtar**
    (uma frase dizia que o app não reconhece música pelo som, e isso deixou
    de ser verdade nesta versão) e **encurtar não é jogar fora** — os fatos
    sobre onde a chave fica ficaram todos (decisão 84).
101. **A tela lista o que ESTA máquina faz, não o que o produto sabe fazer.**
    Sem o acessório baixado, a etapa do som não aparece no funil: listá-la
    seria prometer trabalho que não vai acontecer. O princípio vale para
    todas as etapas — inclusive as que dependem de chave embutida no build —,
    e aplicá-lo a uma só foi o defeito que o QA apontou.

## V10/F18 fase 3 — a etapa que resolve, e o caminho único

102. **Modo é escolha, e escolha é pedágio para quem não tem a quem
    perguntar.** `Modo::{Completar,Conferencia}` sumiu: uma varredura só, em
    TODAS as músicas da pasta. Com os 2 s por música medidos em campo (a
    estimativa antiga dizia 0,3 s — erro de 7×), separar os dois trabalhos
    custava 2 minutos e meio num acervo de 150 músicas, e cobrava por eles que
    alguém que não sabe o que é terminal escolhesse entre dois nomes que não
    entende. Pior: a conferência era **a única coisa que achava etiqueta
    errada** (decisão 95), e recurso que depende de o usuário adivinhar que
    existe é recurso que não existe. O portão de completude não foi apagado —
    ele MUDOU DE LUGAR: saiu da porta de entrada (por isso a música que parece
    completa chega à etapa 2 e o som a desmente) e virou o guarda das etapas 3
    e 4, que continuam rodando só em quem não tem letra. Efeito colateral que
    vale registrar: **o lote perdeu a rota que destruía transcrição corrigida
    à mão** (a repro da decisão 79), porque ele não busca mais letra para quem
    já tem. A trava do consentimento fica de pé, porque a porta de UMA música
    continua rodando o funil inteiro (decisão 81).
103. **A etapa 5 escreve letra, e só letra — e isso é garantia de construção,
    não regra a lembrar.** A identificação pelo refrão (F14.1) ficou fora do
    aplicativo pelo mesmo motivo que já a mantinha fora do `fingerprint.rs`:
    em duas passadas completas do acervo real ela rendeu 0 e 1 identificação,
    e a única foi **errada e aplicada** (decisão 74). A consequência é melhor
    que a regra que se pediu: sem nome vindo daqui, "transcrição nunca
    sobrescreve etiqueta real" não precisa de mecanismo nenhum — o tipo de
    retorno não tem onde pôr um nome, e não existe CONFLITO possível. O refrão
    continua sendo extraído, com todas as travas do candidato (2 palavras, 8
    caracteres, repetição real, sem alucinação, sem placeholder), mas para uma
    coisa só: mostrar UMA linha a quem vai conferir 47 letras escritas por
    máquina. **Recurso que erra metade do que produz não entra num produto sem
    suporte; a parte dele que só informa, entra.**
104. **A lista negra de alucinação tem dois níveis, e é o `_MIN_LACO` outra
    vez.** As frases inconfundíveis ("legendas pela comunidade", "inscreva-se
    no canal") APAGAM a linha: nenhuma canção as contém, e deixá-las dentro da
    letra faz o arquivo "ter letra" e sumir da fila para sempre (decisão 70).
    As frases exatas e curtas ("Obrigado", "Fim", "Tchau") **não apagam nada**
    — são verso legítimo em canto devocional —, só deixam de contar como
    conteúdo: se a transcrição inteira for isso, ela vale vazia e a música é
    marcada instrumental em vez de receber lixo como letra. Um nível só, para
    qualquer dos lados, seria mutilar letra de verdade ou gravar legenda de
    vídeo dentro do MP3 de alguém.
105. **`Various Artists` não é artista, e a lista é curta de propósito.** O
    rótulo que todo CD ripado põe no lugar do artista não estava em pilha
    nenhuma: passava por artista REAL, a música era dada como completa, sumia
    da curadoria para sempre e ainda virava CONFLITO contra o artista
    verdadeiro. O que limita a lista é a lição da decisão 89: ao completar o
    lixo de ripador, o Rust passou a marcar "Pista" sozinha como placeholder,
    e "Pista" é título real. Só entram rótulos que NENHUMA canção usa como
    nome — "Vai", "Vamos", "Valsa", "Variações", "Compilado" e "Artista" ficam
    de fora, com teste fixando cada um. E **"VA" só conta escrito sem
    acento**: "Vá" é o verbo, a normalização tira o acento, e as duas
    chegariam à mesma chave — placeholder é tratado como campo VAZIO
    (decisão 65), então condenar "Vá" apagaria o título de alguém.
106. **Estimativa declarada e estimativa medida são coisas diferentes, e a
    tela precisa saber qual está mostrando.** Para 180 MB a dispensa do tempo
    acabou: o download anuncia `segundos_estimados` a partir de uma banda de
    REFERÊNCIA (1 MB/s, deliberadamente conservadora) e, assim que há amostra
    suficiente, troca para `segundos_restantes` medido nesta conexão — nulo
    enquanto a amostra é curta, porque "faltam 0 segundos" durante dez minutos
    é pior que nenhum número (decisões 85 e 86). O mesmo vale para a
    transcrição: `RAZAO_DE_REFERENCIA` começa em 1,0 (um minuto de máquina por
    minuto de música) porque **os 0,25 do `tools/curadoria.py` são a proporção
    publicada de OUTRO motor** — reusá-los seria a decisão 72 aplicada a uma
    estimativa. A primeira transcrição desta máquina devolve a razão real, e é
    ela que passa a valer. Toda a conta mora no Rust, e não em TypeScript,
    porque a cópia em TS já divergiu uma vez e foi o botão do produto que
    ficou cinza (decisão 80).
107. **Não se depende do formato de entrada de um binário de terceiro.** O
    `whisper-cli` lê WAV 16 kHz mono, e só decodifica outros formatos quando
    compilado com ffmpeg — opção de Linux, que brigaria com o
    `BUILD_SHARED_LIBS=OFF` que faz do acessório UM arquivo conferível por UM
    SHA-256. Entregar-lhe um MP3 e torcer seria a decisão 96 de novo: hash
    prova que baixou o arquivo certo, não que ele faz o que a gente precisa —
    e a etapa 5 nasceria morta nas 40 máquinas, descoberta por quem não tem a
    quem perguntar. O aplicativo passa a **decodificar em Rust puro**
    (`symphonia`, só a feature `mp3`: nenhuma biblioteca de sistema, nenhum
    compilador C, o mesmo código nas quatro plataformas — um binding C
    precisaria de toolchain por plataforma) e a entregar o WAV que o motor sabe
    ler. O temporário nunca é criado ao lado do MP3, e a guarda de `Drop` o
    apaga em qualquer saída, inclusive pânico: a regra "nenhum arquivo é
    renomeado ou movido" ganhou o irmão que nunca havia sido escrito — **nada
    é CRIADO dentro do acervo**.
108. **A decodificação fechou o buraco que criou a decisão 72.** Contar
    amostras dá duração MEDIDA do áudio, e ela passa a ser o topo da ordem de
    autoridade: acima do número que o motor anuncia no stderr (que agora só
    corrobora) e muito acima do cabeçalho do MP3. É a resposta direta ao
    incidente: sem cabeçalho Xing, 300 segundos reais foram lidos como 2365, e
    uma música CANTADA foi marcada instrumental para sempre — com a contagem
    de amostras, 355 caracteres em 300 s dão 1,18 c/s (letra) em vez de 0,15
    c/s (instrumental). A regra da F17 não mudou; ela passou a receber o número
    certo. **`Adiada` ficou inalcançável pelo caminho real e NÃO foi
    removida**: se alguém amanhã acrescentar uma porta que chegue à decisão sem
    prova de duração, o produto adia em vez de marcar instrumental por engano.
    O custo de manter é um `if`; o custo de remover seria descobrir o
    contrário dentro do arquivo de alguém.
109. **A fonte de letra SEM CHAVE vem antes da fonte com chave — e Genius e
    Musixmatch foram recusadas por nome.** O `lyrics.ovh` entrou como etapa 4
    porque não pede credencial nenhuma. Pôr uma fonte sem chave DEPOIS de uma
    com chave é o mesmo que não tê-la: a etapa com chave é a que quase ninguém
    alcança, e quem cura são ~40 pessoas que não sabem o que é uma chave de
    API.
    **Isto não promete cobertura**, e nenhum texto pode sugerir que promete: o
    LRCLIB cobriu ~3% do acervo real e esta fonte não muda essa ordem de
    grandeza — ela entra para eliminar a EXIGÊNCIA DE CHAVE. Quem resolve este
    repertório é a transcrição.
    As duas fontes recusadas, com nome e motivo, para ninguém reabrir a
    discussão em seis meses lendo o mesmo blog: **Genius** não devolve letra
    pela API (licenciamento — só metadados e a URL da página), e o plano
    gratuito da **Musixmatch** devolve um trecho truncado de ~30% da letra.
    Num app cujo propósito é achar música por um pedaço lembrado, indexar 30%
    é pior que não indexar: a busca falha e a pessoa conclui que a música não
    está lá.
    **A fraqueza do `lyrics.ovh` está escrita onde ela mora**: ele não devolve
    título nem artista, então não há segundo lado a conferir — nem o
    `type: "exact"` do Vagalume, nem nomes para a régua estrita comparar. Se o
    serviço fizer casamento aproximado por dentro, ele pode devolver a letra de
    "Ponto de Ogum" para um pedido de "Ponto de Oxum" **e o programa não tem
    como perceber**. É a única etapa do funil cujo casamento não é verificável
    por nós. O que compensa é pouco, e de propósito: só se consulta com título
    E artista REAIS, título COMPOSTO ("Adventício - Lampejo") é recusado
    (sem resposta verificável não se adivinha qual metade é o título), o teto é
    MÉDIA — então a linha nunca chega pré-marcada — e a proposta não troca nome
    nenhum. **A prova, aqui, é o olho de quem revisa.**
110. **O Vagalume foi REMOVIDO, não desligado — porque código nunca exercitado
    contra a realidade é pior que código ausente.** A API está descontinuada e
    sem suporte oficial, o dono do produto nunca conseguiu a chave, e o módulo
    **nunca rodou contra o serviço real**: dezenas de testes verdes com o
    `fetch` injetado e zero contato com o serviço. É a MESMA forma de confiança
    falsa da decisão 92 (quatro suítes verdes, aplicativo congelando) e da 98
    (a especificação certa, o código certo, e o passo que ligava os dois nunca
    escrito). Suíte verde mede o que a suíte alcança.
    "Não remova, só deixe de ser o caminho padrão" foi recusado como reflexo de
    custo afundado. **Existir custa mais que zero**: um campo de chave de API
    numa tela para 40 pessoas leigas, um parágrafo explicando o campo, um
    destino na lista de pontos de rede enumerados, e atrito em toda
    refatoração — o mock e o Rust tiveram de ser realinhados sobre o gating do
    Vagalume duas vezes na mesma semana. E não se perde nada: está no histórico
    do git.
    O ganho de produto é maior que a subtração: **nenhuma etapa do funil exige
    credencial do usuário.** Sobrou a chave do AcoustID, que é NOSSA e vem
    compilada (modelo por-aplicativo deles). A tela de configuração perde o
    campo e o texto que o explicava. Há teste que falha se alguém acrescentar
    um parâmetro de credencial a qualquer comando do funil.
    **O que ficou, e é o que importava**: a disciplina do casamento estrito
    mudou de casa (`casamento_estrito.rs`) em vez de sair com o módulo. Régua
    de palavra por palavra, segmentos do traço, as 120 entidades HTML, a lista
    de "ainda não temos a letra" — tudo isso nasceu no Vagalume mas não é dele:
    **fonte de letra sem duração é uma CATEGORIA**, e o `lyrics.ovh` está nela.
    Os seis testes da régua vieram inteiros; só os do transporte saíram.
    **E a leitura da procedência antiga fica.** O `tools/curadoria.py` grava
    `TXXX:LETRA_ORIGEM=vagalume`, e arquivos do acervo real já a carregam:
    nada mais a escreve, e nada a apaga. "Nunca apagar dado existente" vale
    para INTERPRETAR dado existente também — um valor que o programa não
    produz mais não é lixo a limpar.
    **O `tools/curadoria.py` fica como está**, e o cálculo é outro: ele é
    ferramenta de terminal do dono do produto, não vai para as 40 máquinas, a
    chave vem de variável de ambiente e não de tela, e — o argumento decisivo —
    **ele é o oráculo do porte**. Metade dos comentários do Rust cita o Python
    como a referência contra a qual a régua foi conferida caso a caso; apagar o
    original transformaria cada um desses comentários numa afirmação que
    ninguém pode mais verificar.

## V10 — correções do QA que reprovou a v0.10.0

111. **A "duração PROVADA" era o cabeçalho do MP3 disfarçado, e a #108 está
    corrigida** (CRÍTICO do QA). Aquela decisão comemorou o fechamento da #72
    dizendo que a contagem de amostras é medição do áudio e passa ao topo da
    ordem de autoridade. A contagem é medição — do pedaço que o decodificador
    resolveu entregar. O `symphonia` liga `gapless` por padrão, e com ele o
    `Track::num_frames`, que vem do contador de quadros do **Xing/Info**, vira
    o fim do fluxo: tudo além dele é aparado até sobrar nada. Ou seja, o número
    promovido ao topo derivava exatamente daquele que a #72 proíbe confiar.
    O arquivo que expõe isso não é exótico: é o que `cat a.mp3 b.mp3 > set.mp3`
    produz, e todo player toca inteiro. Medido nas fixtures deste repositório,
    dez cópias emendadas (30,3 s de áudio) com o contador da primeira dizendo
    116 quadros: **3,00 s**. Contador adulterado para 78: **2,04 s**. Contador
    corrigido para 1160: **30,30 s**. Ponta a ponta os dois desfechos eram
    PERMANENTES — `Instrumental` com o motivo "o áudio foi lido até o fim"
    (falso; a marca vence até o `--forcar-tudo`) ou um toco de letra que faz
    `etapas_de_letra_valem_a_pena` nunca mais deixar a música entrar em
    varredura. E o `fpcalc` da etapa 2 decodifica até o EOF: o mesmo arquivo já
    tinha duas "durações provadas" discordando por uma ordem de grandeza, sem
    nada as confrontando — quando corroboração é justamente o que a #72 diz ser
    a única proteção.
    Três mudanças, e nenhuma é margem de segurança:
    **(a) `gapless` desligado** — perde-se o corte de silêncio de codificação,
    uns 12 ms nas pontas, e ganha-se ouvir o arquivo inteiro;
    **(b) o cabeçalho virou PISO** — decodificar MUITO menos do que o arquivo
    declara (menos de 90%) marca a leitura como incompleta; decodificar MAIS
    não acusa nada, porque quem estava errado era o cabeçalho. É corroboração
    usada só na direção em que ela é sólida;
    **(c) o número que o motor anuncia corrobora do mesmo jeito** — se o
    `whisper-cli` diz ter aberto muito menos áudio do que escrevemos no WAV,
    ele não ouviu a música inteira. Só nessa direção: um número maior é padding
    interno dele.
    **E o `if` da #108 existe agora.** Aquela decisão disse que `Adiada` tinha
    ficado inalcançável e que "o custo de manter é um `if`". `Duracao` passou a
    carregar dois fatos — quantos segundos, e se o áudio foi lido até o fim —
    porque **medir e ler até o fim são coisas diferentes, e um número sozinho
    não sabe dizer se é o áudio inteiro ou o começo dele**. `Desfecho::
    Instrumental` só sai com `duracao.provada()`; sem isso o produto ADIA. Há
    teste varrendo a combinação inteira de textos × durações, e não os casos de
    que o autor lembrou (#76).
112. **A razão medida volta pelo BACKEND, e não pelo frontend** (ALTO do QA).
    A #106 prometia em letra: "a primeira transcrição desta máquina devolve a
    razão real, e é ela que passa a valer". Nunca passava — o número era
    calculado, serializado, tipado e testado, o `enrichStore` o descartava, e
    **nenhum consumidor existia no repositório inteiro**. A frase "leva cerca de
    3 horas neste computador" saía de uma constante declarada de 1,0, num
    produto cujo `whisper-cli` de macOS agora sai sem Metal e sem Accelerate — o
    defeito da #85 (prometer menos do que leva), aqui permanente, porque o único
    mecanismo de autocorreção previsto estava desligado.
    O contrato que se cogitou — "o frontend guarda e reenvia" — foi recusado.
    A #106 já dizia que a conta inteira mora no Rust porque a cópia em TS
    divergiu uma vez e foi o botão do produto que ficou cinza (#80); pedir ao
    frontend que seja o cofre do número que o backend usa é a mesma forma de
    acoplamento, com um modo de falha silencioso — foi exatamente ele que
    produziu este achado. **Um contrato que depende de o chamador lembrar já
    falhou uma vez aqui.** Agora `transcricao_scan` grava a medição em
    `medicoes_da_maquina` e `enrich_scan` a lê: o número entra e sai sem
    atravessar processo nenhum.
    Duas escolhas dentro disso. **Somatórios, não a razão pronta**: guardando
    áudio e relógio acumulados, cada transcrição pesa o que ela vale, e uma
    música de 30 s no fim do dia não manda na estimativa de um acervo de 150.
    E **piso de 300 s de áudio** antes de a medida valer, que é a regra do
    `segundos_restantes` do download (#106) aplicada aqui: número medido sobre
    amostra minúscula é pior que número declarado, porque parece mais
    verdadeiro. `razao_desta_maquina` sai no resultado para a tela poder dizer
    QUAL das duas está mostrando — informação, não dever de guarda.
113. **A etapa 5 parou de propor nome, e o comentário que jurava isso virou
    verdade** (ALTO do QA). A #103 diz que "sem nome vindo daqui" é garantia de
    CONSTRUÇÃO. O tipo de retorno realmente não tem onde pôr um nome — mas
    `proposta_da_transcricao` partia de `proposta_baixa`, que é a proposta da
    ETAPA 1, e a linha saía propondo o palpite do nome do arquivo sob o rótulo
    da transcrição. Medido no Rust real: `AudioTrack 03` / None virava
    `Oh! Chuva` / `Falamansa`. O teste que afirmava o contrário passava porque
    usava música com etiqueta REAL, em que o palpite empata com a etiqueta — e
    a música TÍPICA desta etapa é justamente a outra.
    Escolhemos tirar o nome em vez de corrigir os textos, e por medição, não por
    pureza: **esse palpite já foi entregue**. A varredura roda a etapa 1 em
    TODAS as músicas da pasta (#102) e é dela que sai `sem_letra_no_fim`, então
    toda música que chega à etapa 5 já ganhou a sua linha de "preencher o
    branco", com o rótulo que a anuncia, na mesma revisão. Repetir aqui não é
    valor novo: é a MESMA conta sobre o MESMO nome de arquivo, cobrando uma
    segunda leitura de quem já vai conferir 47 letras de máquina. O que sai no
    lugar é o ECO do que está no arquivo — nunca vazio, porque o `apply` grava
    `ap.title` como veio e um título vazio apagaria a etiqueta de alguém.
    A lição, que é maior que o caso: **garantia de construção que depende de
    quem chama não é garantia de construção**, e teste que só visita o caso
    fácil certifica o contrário do que o código faz (#76 outra vez).
114. **EOF e falha de leitura são coisas diferentes** (ALTO do QA). O laço da
    decodificação tinha `Err(_) => break`, com um comentário verdadeiro sobre
    fluxo truncado no fim — que é comum em acervo de gravação de casa, e que o
    `symphonia` já entrega como fim normal. O que aquele `break` engolia era
    **falha de I/O**: HD externo que dorme, pen drive arrancado,
    compartilhamento de rede que cai, setor ruim — normais em 40 máquinas
    alheias. Resultado medido: 30,56 s de áudio viravam 8,05 s, sem erro e sem
    aviso, e daí saíam duração parcial promovida a prova, letra parcial gravada
    como completa e o arquivo fora da fila para sempre. Agora é `ERRO_AUDIO`,
    que é erro de UMA música: a fila segue e o arquivo continua na fila.
    O teste exigiu um encaixe: não dá para fazer um `File` de verdade falhar no
    meio dentro de uma suíte, então a decodificação passou a ter um corpo que
    recebe a fonte de bytes. **Encaixe que existe só para o teste vale o preço
    quando o modo de falha é o mais comum do parque e nenhuma suíte o
    alcançava** — é a lição da #92 escrita antes do incidente, e não depois.
115. **A pergunta do fim só conta o que a etapa 5 consegue transcrever**
    (MÉDIO do QA). Entrava em `sem_letra_no_fim` toda candidata sem letra,
    inclusive aquela cujo arquivo sumiu do disco: a frase "sobraram 47
    músicas… cerca de 3 horas" superestimava, inflava o tempo, e depois a etapa
    5 gastava uma vaga da fila para produzir a única coisa possível com um
    arquivo ausente — uma linha de erro. O predicado virou
    `a_etapa_5_tem_o_que_fazer`, que espelha os portões que a própria etapa 5
    aplica (uma regra, um lugar — #80).
    **Erro de REDE continua contando, e é de propósito**: a etapa 5 não usa
    rede. A música que ficou sem letra porque o LRCLIB não respondeu é
    exatamente a que a transcrição resolve, e tirá-la da conta esconderia o
    trabalho que o produto sabe fazer.
116. **Disco cheio é veredito sobre a máquina, e o cabeçalho do WAV não dá a
    volta** (BAIXOS do QA, os dois com a mesma forma).
    `ERRO_TEMPORARIO` — a pasta de trabalho que não aceita escrita, que na
    prática é disco cheio — passou a desligar a etapa pelo resto da fila, como
    o binário que não sobe já fazia (#83 e a A2 da v0.9.0). Sem isso eram 47
    linhas idênticas culpando 47 músicas inocentes. O que desliga guarda a
    MENSAGEM e não um booleano: disco cheio acusando "o programa não conseguiu
    ser executado" mandaria quarenta pessoas sem suporte procurar defeito no
    lugar errado.
    **Conferir espaço ANTES foi considerado e recusado**: o std do Rust não lê
    espaço livre, seria dependência nova ou syscall por plataforma — e o número
    corre atrás do próprio uso, porque outro programa pode encher o disco entre
    a conferência e a escrita. A tentativa de escrever É a conferência honesta;
    o que faltava era não repeti-la 47 vezes.
    E o cabeçalho do WAV, cujos dois tamanhos são `u32`, recusa acima de ~37
    horas de áudio num arquivo (`Wav::MAX_AMOSTRAS`) em vez de estourar. Em
    `release` a soma daria a volta em silêncio e o motor receberia um WAV
    anunciando dois segundos: **é o defeito 111 outra vez, por outra porta.**
    37 horas num MP3 é raro e não é impossível — `cat` de acervo inteiro é
    exatamente como estes arquivos nascem.
117. **Documentação podre é dívida, e neste projeto ela é dívida grande**
    (BAIXO do QA). O cabeçalho do `lyrics_ovh.rs` afirmava que "o Vagalume
    **não foi removido**" — contra a #110 e contra o código —, chamava a
    transcrição de "etapa 6", e dizia "um dos cinco destinos" onde
    `destino_de` tem três. O `lyrics_fetch.rs` ainda falava em "dois destinos…
    Vagalume". E o doc do `enrich_folder_scan` descrevia um parâmetro
    `chave_vagalume` que o comando não tem mais.
    Num projeto que trata comentário como oráculo — metade dos comentários do
    Rust cita o Python como a referência conferida caso a caso — isto não é
    higiene. É a #84 aplicada à documentação: **texto que mente é defeito,
    mesmo quando o comportamento é o certo**, porque o próximo a mexer aqui
    decide com base nele. As menções que sobraram estão no passado de
    propósito: a régua estrita nasceu no Vagalume e a história explica por que
    ela é rígida.

118. **A régua de placeholder vale por SLOT, e generalizar de artista para os
    dois campos apagava título** (emenda à #105, achado do agente de frontend
    medido ponta a ponta). A #105 argumentou "só entram rótulos que NENHUMA
    canção usa como nome" pensando no campo do ARTISTA, que é onde o ripador
    escreve "Various Artists" — e escreveu a regra dentro do `is_placeholder`,
    que roda nos dois campos.
    Consequência: uma música intitulada **`Diversos`** (ou `Vários`,
    `Coletânea`) passava a valer VAZIO. O palpite do nome do arquivo entrava por
    cima; `substitui_nome_escrito` saía `false`, então a linha não recebia o
    aviso de "isto troca um nome escrito" nem ficava fora da pré-marcação; e ela
    caía no grupo dos preenchimentos — **dobrado, fechado e pré-marcado**, sob a
    frase "N músicas SEM TÍTULO OU ARTISTA vão receber o nome que está no
    arquivo". Para essa música a frase é FALSA: ela tem título, e a pessoa o vê
    na biblioteca todo dia. Um clique em "Aplicar selecionadas" levava embora um
    título que a revisão nunca mostrou — e é exatamente a condição "a frase
    descreve exatamente o que o clique faz" que sustenta a pré-marcação daquele
    grupo.
    O conserto **não é uma segunda função**, é um parâmetro obrigatório:
    `is_placeholder(Campo::{Titulo,Artista}, texto)`. Um predicado que não
    pergunta o campo é um predicado que generaliza sozinho na próxima vez, e
    manter um atalho sem slot seria deixar a armadilha montada. O compilador
    passa a perguntar em cada uma das dez chamadas — inclusive nas do
    `fingerprint::discorda`, onde a diferença é visível: "Various Artists" no
    crédito não contradiz artista nenhum, mas "Diversos" no TÍTULO é um título
    e o som dizendo outra coisa **é** conflito.
    E a lição da #89 foi conferida nos dois sentidos antes de fechar: `Various
    Artists`, `V.A.`, `VA` e `Diversos` continuam valendo vazio no ARTISTA (é o
    caso que a #105 existe para resolver), "Vá" com acento sobrevive nos dois
    campos, "VA" sem acento cai só no artista, e nenhum nome legítimo de uma
    palavra — "Vai", "Vamos", "Valsa", "Variações", "Compilado", "Artista",
    "Pista" — passou a cair em outra regra.
    **O `tools/curadoria.py` tem o MESMO defeito** (`_eh_rotulo_de_coletanea`
    dentro do `eh_placeholder`, sem slot) e ficou de fora desta rodada por
    escopo. Ele é ferramenta de terminal do dono do produto e não vai para as 40
    máquinas, mas o dano é o mesmo dentro do arquivo dele: **fica anotado como
    dívida com dono, não como diferença deliberada.**
119. **A tela precisa saber se a estimativa é medição ou palpite de fábrica.**
    A #112 fechou o laço da razão medida por dentro e concluiu que "não há nada
    a devolver". Faltava uma peça, e ela não é a conta — é um FATO sobre o
    número. A pergunta do fim é desenhada a partir da varredura, não do retorno
    da etapa 5, então a tela não tinha como saber qual dos dois números estava
    mostrando, e teve de trocar "leva cerca de 3 horas **neste computador**"
    por "leva cerca de 3 horas — pode levar mais nesta máquina": honesto e pior.
    `EnrichScanResult.estimativa_medida_nesta_maquina` (booleano) devolve o
    "neste computador" quando ele é verdade e mantém a ressalva quando é chute.
    Booleano, e não a razão: a razão convidaria o TypeScript a multiplicar, que
    é a divergência da #80 esperando para acontecer. É a #86 — nenhum texto
    pode afirmar o que o programa não conhece — aplicada a uma estimativa: o
    programa conhece a diferença, e agora ele a conta.

## V10.1 — o arquivo que não podia ser gravado (teste em campo da v0.10.0)

120. **`ParsingMode` não tinha nada a ver com o defeito, e a medição é que
    disse isso.** Um MP3 do acervo real recusava toda gravação com
    `ID3v2: Invalid frame language found: [0, 0, 0] (expected 3 ascii
    characters)` — e como toda tentativa falha igual, aquela música saía da
    curadoria **para sempre**, em silêncio.
    A suspeita natural era a leitura, e ela estava errada. Medido nos três
    modos, sobre um MP3 montado no teste com o campo zerado (`Strict`,
    `BestAttempt`, `Relaxed`): **a leitura passa nos três, devolve o idioma
    `[0,0,0]` intacto nos três, e a REGRAVAÇÃO falha nos três, com a mesma
    frase.** A validação mora em `LanguageFrame::create_bytes`, que só roda na
    escrita, e ali não existe modo tolerante: o `?` derruba a gravação do
    arquivo inteiro. Afrouxar a leitura não consertaria nada — e o modo que
    tolera mais (`Relaxed`) DESCARTA quadros, que é exatamente o que este
    produto não pode fazer.
    O conserto é a saída, e ele não inventa nada: `und` é o código que o
    próprio ISO-639-2 — o vocabulário que o ID3 usa neste campo — reserva para
    "idioma indeterminado". Consertar preserva o conteúdo do quadro (um `COMM`
    com a anotação de alguém, um `USLT` com a letra inteira); descartar não
    preserva nada. Idioma VÁLIDO não é tocado: normalizar o acervo para `und`
    apagaria a informação que alguém gravou de propósito.
    **Quem estava quebrado, no caso do campo, era um `COMM`** — e não o `USLT`,
    que o `write_tags` já removia e regravava antes de salvar. Ou seja: o
    defeito só existia nos quadros ALHEIOS, os que a decisão 41 promete
    preservar. A promessa estava certa e era ela que travava o arquivo.
    **Um caso não tem conserto, e ele recusa em vez de apagar.** Se dois
    quadros do mesmo tipo ficam com a MESMA chave depois do conserto (idioma +
    descrição — é assim que o lofty distingue um `COMM` de outro), guardar os
    dois é impossível: medido, `Id3v2Tag::insert` devolve o substituído e o
    texto some. Aí o produto **recusa a gravação**, em pt-BR, sem tocar no
    arquivo. Recusar é ruim — a música continua sem poder ser curada —, mas
    apagar a anotação de alguém em silêncio é pior, e é a regra inviolável.
    Fica registrado o que está **fora do nosso alcance**: quando dois quadros
    já chegam com a mesma chave, o próprio leitor do lofty funde os dois antes
    de nos entregar a tag (`read.rs` insere quadro a quadro com o mesmo
    `insert`). Essa perda acontece em toda leitura, inclusive na do indexador.
121. **A mensagem da gravação era inglês cru de biblioteca, e é a mesma família
    do M4 da v0.9.0.** Aquele achado — erro de io em inglês vazando para a tela
    — foi corrigido só no caminho do download; o caminho de GRAVAÇÃO tinha o
    mesmo buraco, e era ele que aparecia em campo. Agora `frase_de_io` e
    `frase_de_lofty` traduzem: disco cheio, sem permissão, MP3 ilegível,
    etiquetas fora do padrão. **O caminho do arquivo fica sempre**, fora da
    frase: é a única forma de a pessoa saber de qual música se trata quando a
    falha acontece no meio de um lote de 47.
    Duas escolhas dentro disso. **O desfecho padrão é uma frase nossa, nunca o
    repasse do texto original** — `ErrorKind` do lofty é `#[non_exhaustive]`, a
    lista vai envelhecer sozinha, e é o `_ =>` que garante que envelhecer não
    devolve inglês para a tela; há teste que compara a frase com o
    `to_string()` do erro e falha se forem iguais. E **a falha DEPOIS da
    gravação tem frase própria**: a reindexação que não roda deixa a lista
    desatualizada, não o arquivo por gravar, e dizer "não foi possível salvar"
    ali faria a pessoa refazer um trabalho que já está no disco — é a #86
    aplicada a uma mensagem de erro.
    Sem teste de integração para falta de permissão, e de propósito: tirar o
    bit de escrita da pasta não impede nada quando a suíte roda como root (é o
    caso no contêiner e no CI), e um teste que passa ou falha conforme quem o
    rodou é a "falha fantasma" que a #77 saiu para acabar. A tradução tem teste
    unitário por caso.

## V10.2 — o segundo modelo, que existe para ser medido

122. **O `medium` entrou porque a qualidade do `small` REPROVOU, e ele é
    preferência — não é uma caixinha de escolha.** Medida no acervo real, a
    encontrabilidade do `ggml-small-q5_1.bin` deu **37%**, contra os **78%** que
    o faster-whisper tinha entregado. Foi o risco que o PRD V10 registrou
    acontecendo em campo: *a prova não viaja junto quando o código é reusado*
    (#72). E o modo de falha não é grafia — o que se remedia com dicionário —,
    é **o modelo classificando trecho CANTADO como música e não o
    transcrevendo**: as saídas vieram salpicadas de `[música]`, `[Música]`,
    `[MÚSICA DE FUNDO]`, `[cantarolando]`, e numa das faixas quatro estrofes
    inteiras sumiram. Onde ele emite a marca, a letra não existe — e uma letra
    com buraco *tem letra*, some da fila para sempre (#70) e não é encontrável
    pelo pedaço que a pessoa lembra, que é o produto inteiro. Não é falta de
    idioma: o `--language pt` está sendo passado, e há teste varrendo a linha de
    comando.
    **Preferência, e não escolha**: se o grande estiver pronto, é ele que roda;
    senão o pequeno; senão a etapa não existe. Não há tela de seleção de modelo,
    e não vai haver — escolha é pedágio para quem não tem a quem perguntar
    (#102), e "qual modelo de reconhecimento de fala você prefere" é a pior
    versão possível desse pedágio. Os dois aparecem em Configurações porque a
    tela lista o CATÁLOGO (#101), e isso basta: **nada no frontend mudou.**
    A ordem é DECLARADA (`transcricao::MODELOS`), e não deduzida do tamanho do
    arquivo. Hoje o preferido é também o maior, mas "maior" é proxy de
    qualidade: um modelo melhor e menor (destilado, podado) entraria na frente
    sem esta lista precisar de exceção, e ordenar por bytes o poria no fim. Há
    guarda pinando que **todo acessório de DADO do catálogo está na ordem de
    preferência** — sem ela alguém publica um modelo, a pessoa baixa 1,5 GB, e a
    transcrição nunca o usa porque a preferência não sabe que ele existe.
    **O grande CORROMPIDO cai para o pequeno em vez de desligar a etapa.** Num
    download de 1,5 GB o arquivo truncado não é hipótese, e a máquina que já tem
    o outro modelo pronto não pode ficar sem transcrição por causa disso.
    `Corrompido`, `Ausente` e `Indisponivel` valem o mesmo aqui: os três querem
    dizer "não dá para usar ESTE".
    **Isto é temporário e está escrito onde alguém vai ler**: no bloco do
    `CATALOGO`, no de `transcricao::MODELOS` e no cabeçalho do
    `tests/remedicao.rs`, que é o arnês que decide. Assim que a remedição rodar
    nos MESMOS arquivos com os dois modelos, **um dos dois sai do catálogo**.
    Dois modelos não são o desenho final; são uma medição em curso.
    E a tela diz o que cada um é em uma frase, na régua da #100 — sem "modelo",
    sem "quantizado", sem tamanho (o tamanho já está no cartão, em MB):
    o pequeno é *"entender o que é cantado — este é o rápido, e às vezes deixa
    trechos de fora"*; o grande é *"entender melhor o que é cantado — é bem mais
    lento, e o aplicativo usa este quando ele está aqui"*. A segunda metade da
    frase do grande responde à única pergunta que alguém faz ao ver dois cartões
    parecidos: *preciso dos dois? qual roda?*
123. **A medição de tempo é POR MODELO, e invalidar quando o modelo muda seria
    mais código para um resultado pior.** A #112 pôs a razão medida no banco sob
    a chave `transcricao`, quando havia um modelo só. Com dois, e sendo o grande
    ~3x mais lento, uma medição feita com o pequeno passaria a subestimar por um
    fator: a tela diria "cerca de 3 horas neste computador" para um trabalho de
    nove, que é a #85 (prometer menos do que leva) de volta — e permanente, como
    ela já foi uma vez.
    As duas saídas foram comparadas, e a escolha não é de gosto:
    **(a) invalidar a medição quando o modelo muda PRECISA guardar exatamente o
    mesmo fato que a chave por modelo guarda** — "qual modelo produziu isto" —
    para poder perceber que mudou. Ou seja, ela paga o mesmo preço em dado, e
    depois joga o dado fora. É estritamente mais código para menos memória.
    **(b) a queda do grande para o pequeno é um caminho DESENHADO** (ver #122),
    não uma exceção: a máquina vai oscilar entre os dois — download que
    corrompe, arquivo que o antivírus leva, disco que enche. Cada oscilação
    zeraria uma medição boa e devolveria a estimativa ao número de fábrica,
    justamente na máquina que mais depende dela.
    **(c) o piso de 300 s de áudio** (#112) faz a invalidação doer duas vezes:
    depois de cada troca a amostra volta a ser curta demais para valer, e a tela
    volta à ressalva "pode levar mais nesta máquina" mesmo tendo medido a
    máquina a noite inteira. Com chave por modelo, cada modelo mantém o seu
    banco de horas.
    **(d) o custo é pequeno porque a #112 já tinha feito a parte cara**:
    `db::somar_medicao` e `db::razao_medida` sempre receberam a chave por
    parâmetro. O que faltava era montar a chave certa e passá-la — nenhuma
    tabela nova, nenhuma migração de schema.
    A chave carrega o **ARQUIVO** (`transcricao:ggml-small-q5_1.bin`), e não o
    nome do acessório: se um dia o mesmo nome apontar para outro arquivo, a
    medição do arquivo velho não pode ser lida como se fosse dele. É a #72
    escrita numa chave de banco.
    **A razão DECLARADA também é por modelo**, e pelo mesmo motivo: 1,0 para o
    pequeno, 3,0 para o grande. O 3,0 é um palpite multiplicado por um palpite —
    "~3x mais lento" sobre um número de fábrica —, e é o pior número do produto;
    ele existe para durar cinco minutos de áudio nesta máquina e sumir. Erra
    para CIMA de propósito (#85).
    **E a medição da v0.10.0 não é perdida: ela era do pequeno.** Naquela versão
    o catálogo tinha um modelo, então a linha `transcricao` do banco diz, sem
    adivinhação, quanto o `ggml-small-q5_1.bin` levou naquela máquina. Ela é
    reetiquetada na abertura do banco — não é migração de schema (a tabela não
    mudou), é uma linha de dado passando a se identificar. Descartá-la custaria
    duas ou três canções de estimativa errada por nada, e "nunca apagar dado
    existente" vale também para o dado que o próprio programa produziu (#110).
    Há teste pinando o nome do arquivo contra o catálogo: um erro de digitação
    ali não quebraria nada visível — a linha viraria uma chave que ninguém lê, e
    a estimativa voltaria ao número de fábrica em silêncio.
124. **"A estimativa é medição?" virou um FATO, e deixou de ser uma comparação
    de floats.** A #119 respondia isso com `razao != RAZAO_DE_REFERENCIA`.
    Aquilo já mentia num caso — a máquina que medisse exatamente 1,0 seria
    anunciada como "de fábrica" —, e com dois modelos passaria a mentir por
    construção, porque há duas constantes de referência e a comparação
    escolheria a errada. Agora quem responde é
    `razao_medida_desta_maquina() -> Option<f64>`: existe medição, ou não
    existe. `estimativa_medida_nesta_maquina` continua sendo o booleano que
    cruza para a tela, e continua sendo um booleano e não a razão, pelo motivo
    da #119 (a razão convidaria o TypeScript a multiplicar).
    **Duas dívidas ficam anotadas, com dono, em vez de resolvidas em silêncio:**
    **(a) conferir a soma custa ler o arquivo inteiro, e agora o arquivo tem
    1,5 GB.** `enrich_count` roda a cada troca de pasta na tela de curadoria e
    confere o modelo; com o pequeno eram 190 MB, com o grande são 1,5 GB.
    Medido nesta máquina (com SHA-NI) dá ~1,3 s; numa máquina modesta sem
    SHA-NI, e com o arquivo vindo de disco mecânico, a conta chega à dezena de
    segundos — por troca de pasta. O comando é `(async)` e não congela a janela
    (#92), mas a contagem fica "pensando" por tempo demais. **A dupla
    conferência que esta rodada teria introduzido foi removida** (o
    `acessorios_prontos` chegou a conferir o modelo escolhido duas vezes na
    mesma chamada); o custo que sobra é o de UMA leitura, e ele é anterior a
    esta mudança — só ficou oito vezes maior. As saídas conhecidas (memorizar a
    soma por mtime+tamanho, ou recusar por tamanho antes de somar) mexem na
    garantia da #96 — "o que se confere é o que se executa" — ou tornam o
    `tamanho_bytes` do catálogo load-bearing, onde hoje um erro nele não
    desliga nada. Nenhuma das duas se decide dentro de uma tarefa sobre
    qualidade de transcrição.
    **(b) o tipo do frontend não conhece o nome novo.** `src/lib/api.ts` declara
    `nome: "fpcalc" | "whisper-cli" | "modelo-de-transcricao"`, e o mock lista
    três acessórios. Nada quebra — a lista vem do backend em tempo de execução,
    e a tela desenha um cartão por item —, mas o tipo passou a descrever menos
    do que o backend devolve, e o mock deixou de espelhá-lo. É a #117
    (documentação que mente é defeito) na forma de um tipo. O `src/**` estava
    fora do escopo desta rodada de propósito, e isto é o que sobrou para lá.

## V10.3 — a conferência que não precisava acontecer de novo

125. **A conferência do acessório é memorizada por `(caminho, mtime,
    tamanho)`, em memória, pela vida do processo.** É a dívida (a) da #124
    paga: `estado` lê o arquivo INTEIRO, e a tela de curadoria pergunta o
    estado a cada troca de pasta (`enrich_count` → `etapas_ligadas` →
    `transcricao::acessorios_prontos`). Com o pequeno eram 190 MB por clique;
    com o grande são 1,5 GB. **Medido**, com SHA-NI e em release: 422 ms para
    512 MB, ~1,2 s extrapolado para o `ggml-medium.bin` — e isso com o arquivo
    quente no cache de páginas, que é o melhor caso. Na máquina modesta sem
    SHA-NI, com o arquivo vindo de disco mecânico, é a dezena de segundos que a
    #124 previu. Depois: **2,3 µs**, e o disco não é tocado. O comando é
    `(async)` e nunca congelou a janela (#92), mas a contagem e a estimativa
    ficavam "pensando" por segundos para reconfirmar um fato que não mudou —
    e o dono do produto vai baixar 1,5 GB para comparar dois modelos, onde uma
    lentidão que não é do modelo estragaria a comparação.
    **A garantia da #96 continua de pé**: nada é executado sem ter sido
    conferido — a primeira conferência de cada arquivo, em cada sessão,
    acontece de verdade, e reabrir o aplicativo reconfere tudo. `mtime` ou
    `tamanho` diferentes invalidam a entrada, e **instalar por cima ESQUECE o
    caminho** (o arquivo que morava ali era outro; depender da granularidade do
    relógio do disco para uma troca que nós mesmos fizemos é depender do que
    não precisa).
    **O que se memoriza é a SOMA de um arquivo identificado, não o veredito
    "pronto" de um acessório.** A comparação com o `sha256` do catálogo
    acontece em toda pergunta, então conteúdo trocado volta a ser julgado e
    corrompido continua sendo pego. Há teste CONTANDO as leituras de disco:
    "não releu o arquivo" é afirmação sobre o disco, e afirmação sobre o disco
    se conta, não se deduz lendo o código.
    **A janela que sobra não é nova.** Arquivo trocado no meio da sessão com o
    mtime preservado à mão é a MESMA TOCTOU que o QA da v0.9.0 examinou e
    aceitou, escrita no `commands::fontes_do_funil`: a soma já era conferida
    uma vez por varredura, e a execução acontecia dezenas de vezes ao longo de
    minutos. Isto muda a FREQUÊNCIA de uma conferência que já não era por
    execução.
    **A saída descartada foi responder por presença+tamanho** e deixar a soma
    só para antes de executar: ela tornaria o `tamanho_bytes` do catálogo
    load-bearing, e hoje um erro nele mente na estimativa (#85) sem desligar
    nada. Cache em disco também não: conferir o cache é o trabalho que ele
    existiria para evitar.
