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

## V10.4 — os três defeitos do download de 1,5 GB (teste em campo da v0.10.1)

126. **Sair da tela não é cancelar, e o que morria era a TELA — não o
    download.** Relato de campo: *"coloquei pra baixar o modelo novo e sai da
    pagina. o download parou e tive que começar de novo."* 1,5 GB perdidos por
    trocar de aba, contra a regra 2 do PRD V9 ("segundo plano, com progresso
    visível e cancelamento").
    **Medido antes de escolher o conserto**, porque as duas hipóteses pediam
    trabalhos muito diferentes: o `acessorio_baixar` é
    `#[tauri::command(async)]` e roda numa thread do backend — ele não sabe que
    alguém navegou, e continua até o fim. O que morria era tudo o que a pessoa
    podia VER dele: o `useState` do progresso, a assinatura de
    `acessorio:progresso` e o lugar onde o desfecho apareceria viviam dentro de
    `CartaoDoAcessorio`, e o `App.tsx` DESMONTA a tela de Configurações ao
    trocar de view. Ou seja: o download não parava, ficava invisível — o que na
    prática é pior, porque a volta mostrava o botão "Baixar" de novo.
    **E era esse botão que armava o defeito seguinte.** Clicar nele disparava
    um SEGUNDO `acessorio_baixar` do mesmo acessório, e os dois escrevem o
    MESMO `.parcial`: o primeiro a terminar troca o arquivo de nome (ou o
    apaga, se a soma não bater) por baixo do outro, que então não acha mais o
    que conferir. É a família do `scan_id` (QA M4) num caminho novo.
    O download passou a morar numa **store** (`src/stores/downloadStore.ts`),
    como a varredura e a transcrição, e pelo mesmo motivo: o trabalho é do
    APLICATIVO, não da tela. Com isso, quatro coisas passaram a valer — o
    progresso reaparece quando a pessoa volta; **a frase de erro ESPERA** por
    ela (uma falha acontecida com a tela fechada não pode simplesmente não
    estar lá); a store recusa o segundo download do mesmo acessório antes de
    qualquer `await`; e a assinatura do evento é UMA para o aplicativo, criada
    no primeiro download e solta no último — antes era uma por clique, e sair
    da tela no meio fazia o `finally` que a soltava nunca rodar.
    **A trava contra o download duplicado está nas DUAS pontas, e a que vale é
    a do backend** (`Db::download_begin`, por ARQUIVO — é o `.parcial` que
    colide, não o nome do acessório). A da store existe para a recusa não virar
    frase vermelha; a do Rust existe porque a v0.10.1 acabou de provar o custo
    de uma garantia que só existe no frontend. Ela é um guard que solta no
    `Drop`, para nenhum caminho de saída — erro, cancelamento, pânico — deixar
    um acessório travado para sempre.
    **O estado da assinatura mora no estado da store, e não numa variável de
    módulo.** Variável de módulo sobrevive ao `setState` do estado inicial, e o
    teste seguinte herda uma assinatura que já não existe — o tipo de teste que
    passa ou falha conforme a ordem em que rodou (#77).
127. **"Não foi possível salvar nesse computador" era a frase de QUANDO NÃO SE
    SABE, e ela engolia pelo menos quatro causas diferentes.** O segundo relato
    de campo: a barra chegou a ~85% e travou com essa frase; o download
    seguinte funcionou em menos de 3 minutos. Disco cheio, que é o que a frase
    sugere, ficou improvável na hora.
    O que se descobriu lendo o caminho: a frase NÃO era a de disco cheio (essa
    diz "não há espaço em disco"); era `ERRO_GRAVACAO`, o `_ =>` do tradutor de
    io. E o ponto mais provável de ela sair num download de 1,5 GB era a
    releitura da QA M3 — `sha256_do_arquivo(&parcial)` subia por um
    `map_err(|_| ERRO_GRAVACAO)` que jogava a causa fora. Um `.parcial` que
    SUMIU (antivírus em quarentena, pasta sincronizada com a nuvem, ou o
    segundo download da #126 renomeando o arquivo por baixo) aparecia na tela
    como falha de gravação, mandando a pessoa conferir espaço em disco numa
    máquina onde disco nunca foi o problema. É o M4 da v0.9.0 se repetindo.
    Quatro mudanças, e nenhuma inventa distinção que o sistema não dê:
    **(a)** a releitura passa pelo mesmo tradutor das escritas, com um passo
    próprio (`Passo::Conferencia`), e `sha256_do_arquivo` devolve o `io::Error`
    cru em vez de achatá-lo em `AppError`;
    **(b)** arquivo NÃO ENCONTRADO ganhou frase própria — gravar funcionou, e
    alguém levou o que foi gravado; a ação é pausar antivírus e nuvem, não
    liberar disco;
    **(c)** disco cheio passou a ser reconhecido pelo `ErrorKind`
    (`StorageFull`, `QuotaExceeded`) e não só pela tabela de códigos, que cobria
    `ENOSPC` e dois do Windows e deixava de fora os outros que o próprio Rust já
    classifica;
    **(d)** a frase genérica passou a dizer o que fazer **e a carregar o CÓDIGO
    do sistema** — um número, nunca o texto em inglês que a #121 proíbe, na
    mesma disciplina do caminho do arquivo que já viaja fora da frase. Ela
    existe porque **este produto não tem suporte nem telemetria**: sem o número,
    o próximo relato volta a ser "não foi possível gravar" e a investigação
    recomeça do zero, que é exatamente o que aconteceu aqui.
    **O que NÃO foi determinado, e fica escrito:** por que a barra parou aos
    85%. O mecanismo do parcial que some explica a FRASE, mas ele falharia no
    fim do download (na conferência), não no meio; um `write_all` que falha aos
    85% com um código que não é `ENOSPC` nem permissão continua sendo
    hipótese — antivírus segurando o arquivo é a mais provável. Sem o código do
    sistema não há como escolher entre elas, e é por isso que a mudança (d)
    existe. O que se pode afirmar é que o download seguinte funcionou porque a
    #126 tirou o segundo download concorrente de cena.
    **O que não se fez: dar nome único ao `.parcial` por download.** Resolveria
    a colisão sem trava, mas um processo que morre passaria a deixar 1,5 GB de
    lixo com nome que ninguém reusa — hoje o parcial de nome fixo é truncado
    pelo download seguinte. A colisão é problema de concorrência, e se resolve
    onde a concorrência é decidida.
128. **Numa estimativa de DOWNLOAD, o lado seguro não é o da #85 — e a razão é
    que este número é um portão, não um relatório.** A tela anunciou **26
    minutos** para o modelo grande; ele baixou em **menos de 3** (acima de
    8 MB/s). Erro de quase 10x, e a #85 diria que errar para cima é o lado
    seguro. Ela continua certa onde nasceu, e errada aqui, por três diferenças:
    **(a) o número governa uma decisão que ainda não foi tomada.** A estimativa
    da varredura aparece para quem já decidiu varrer, e prometer menos do que
    leva deixa a pessoa presa esperando. Esta aparece ANTES do clique, e a
    única coisa que ela decide é começar ou não. Uma estimativa inflada não
    protege ninguém: ela impede o download, e a etapa 5 deixa de existir naquela
    máquina, para sempre e sem ninguém saber. Num recurso opcional de um produto
    sem suporte, esse é o pior desfecho possível — pior que qualquer espera.
    **(b) errar para cima aqui não custa nada a quem começou.** O download roda
    em segundo plano (PRD V9, regra 2, e agora de verdade — #126), então
    terminar antes do previsto não prende ninguém na tela.
    **(c) o número se corrige sozinho em segundos.** Assim que os bytes andam,
    quem fala é o `segundos_restantes`, que é MEDIDO. A referência governa a
    decisão de começar, e mais nada.
    **A referência subiu de 1 para 3 MB/s, e não para os 8,5 medidos**: 8,5 é a
    conexão de UMA pessoa, e prometer a conexão de uma pessoa a quarenta é
    trocar um chute por outro. 3 MB/s continua sendo folga — só que de ~3x, e
    não de ~10x. Para 1,5 GB dá ~8 min (café), e não 26 (outro dia); e mantém a
    régua que o teste antigo já protegia, de os 190 MB do modelo pequeno não
    saírem como "menos de 1 minuto".
    **E o número passou a se MEDIR, que é a #112 aplicada ao download.** O
    produto já media a velocidade a cada pedaço para pintar a barra e jogava a
    medição fora ao terminar. Agora ela é somada em `medicoes_de_banda`
    (somatórios, como a #112: um download de 1,5 GB pesa o que vale, e um de
    8 MB não manda na estimativa do próximo) e volta na estimativa seguinte.
    Três escolhas dentro disso. **Tabela nova, e não uma chave a mais em
    `medicoes_da_maquina`**: lá as colunas se chamam `audio_segundos` e
    `relogio_segundos`, e guardar bytes numa coluna chamada "áudio" é a #117
    escrita em DDL. Sem migração — `CREATE TABLE IF NOT EXISTS` roda em toda
    abertura. **O piso é na ESCRITA, e não na leitura como na #112**: lá as
    amostras curtas somam até virar uma boa; aqui um arquivo pequeno cronometra
    o aperto de mão, não a conexão, e somá-las enviesaria para baixo
    permanentemente. **E a medição para no último byte**, antes do `sync_all` e
    da releitura de 1,5 GB para conferir a soma: contar tempo de disco como
    tempo de rede faria a máquina se medir como mais lenta do que é — o erro
    que esta rodada veio consertar.
    **O que sobra, e fica dito:** o primeiro download grande de cada máquina
    ainda usa o número de fábrica, porque os acessórios pequenos (2-5 MB) ficam
    abaixo do piso. Por isso a referência honesta é o conserto load-bearing, e a
    medição é o que impede o número de ficar errado para sempre.
    **A tela diz de ONDE veio o número**, com um booleano e não com a banda —
    mandar a banda convidaria o TypeScript a refazer a conta (#80/#124).
    Declarado, o texto carrega a ressalva de internet lenta (a mitigação que a
    #85 pediu para a varredura); medido, ele diz "neste computador" e larga a
    ressalva. E o singular de "1 minuto" passou a existir: ele só valia para "1
    hora", e a faixa de 60 a 89 s era inalcançável com a banda antiga — com a
    nova, os 190 MB do modelo pequeno caem exatamente ali, e a tela diria
    "cerca de 1 minutos".

## V10.5 — a medição decidiu, e o modelo pequeno saiu

129. **O `ggml-medium.bin` ficou; o `ggml-small-q5_1.bin` saiu do catálogo. A
    convivência dos dois durou uma rodada, que é o que a #122 declarou.**
    Medido no acervo real, com a letra conferida **ouvindo a gravação** — e não
    a letra publicada na internet —, em **83 trechos** do tipo que uma pessoa
    lembraria, de **3 músicas**:

    | música | trechos | pequeno | grande |
    |---|---|---|---|
    | Cadê o Gato | 26 | 30% | **53%** |
    | Girias do Norte | 17 | 29% | **52%** |
    | Último dos Moicanos | 40 | 32% | **42%** |
    | **total** | **83** | **31%** | **48%** |

    O grande recuperou 17 trechos e perdeu 3. E o que mais importa, porque é o
    modo de falha que a #122 descreveu: **as marcas `[música]`,
    `[MÚSICA DE FUNDO]` e `[cantarolando]` desapareceram**. Elas eram o modelo
    desistindo de transcrever trecho cantado, e eram a causa de estrofes
    inteiras sumirem.
    **Duas ressalvas andam com o número, e sem elas ele engana.**
    **(a) A amostra é o material mais DIFÍCIL do acervo.** Saiu, sem querer,
    uma pasta de humor: narrativa falada-cantada, dialeto regional e uma música
    construída sobre palavras inventadas ("alavantuí, chã-de-dama anarrariê").
    É razoável *esperar* mais que 48% no repertório cantado comum — mas isso é
    **expectativa, não medição**, e não se afirma como medida. Quem quiser o
    número do repertório comum roda o `tests/remedicao.rs` sobre ele.
    **(b) O problema estrutural diminuiu, NÃO acabou.** Das quatro estrofes que
    o pequeno engoliu no "Último dos Moicanos", **só uma voltou**. Continuam
    fora "Tinha jurado à minha mãe", "Comprei um sítio", "A tal viúva do
    bandido" e "Voltei à vila". A transcrição ainda perde pedaços de áudio
    cantado, e isso está escrito nos três lugares onde alguém vai ler: o bloco
    do `acessorios::CATALOGO`, o de `transcricao::MODELOS` e o cabeçalho do
    `tests/remedicao.rs`.
    **A lista de preferência continua sendo uma lista, com um item.** Ela não
    virou constante porque é ali que a guarda mora: *todo acessório de DADO do
    catálogo está na ordem de preferência* — e agora também o contrário, *nada
    na lista fora do catálogo*. Com uma entrada só a guarda vale mais, não
    menos: o próximo modelo publicado entra no catálogo (a tela lista o
    catálogo), alguém baixa 1,5 GB, e sem a lista a transcrição nunca o usa.
    **Três testes mudaram de PROPÓSITO, e cada um diz isso no próprio
    comentário** — a preferência entre dois modelos, a comparação das duas
    razões declaradas, e a queda do grande corrompido para o pequeno. O último
    é o que mais muda: **sem segundo modelo não há para onde cair**, e o
    desenho passa a dizer isso em vez de disfarçar — modelo inutilizável
    desliga a etapa 5 (`None`), que é o que a tela mostra e o que o botão
    "baixar de novo" conserta. Um arquivo de 1,5 GB truncado não pode virar um
    transcritor rodando com dado quebrado.
    **A razão declarada de 1,0 sumiu junto com o modelo.** Ela era a do
    `small`; uma razão declarada é a de UM motor, e a de um motor que saiu do
    produto não descreve mais coisa nenhuma. Ficou só o 3,0 do `medium`, que é
    palpite sobre palpite e existe para ser substituído pela medição desta
    máquina.
130. **Os 190 MB órfãos no cache de quem já baixou o modelo pequeno ficam onde
    estão. O aplicativo não apaga arquivo por conta própria — nem dentro da
    própria pasta de cache.**
    A alternativa era varrer a pasta e remover o que o catálogo não conhece
    mais. Ela foi recusada por três motivos que se somam, e nenhum deles é
    "dá trabalho".
    **(a) O ganho é espaço, e só espaço.** O arquivo órfão não é lido por
    ninguém: o `acessorios::estado` só pergunta pelo que está no catálogo, e o
    `transcricao::MODELOS` só conhece o `ggml-medium.bin`. Ele não deixa a
    etapa 5 mais lenta, não confunde a tela e não pode ser executado (é dado,
    e nunca recebeu o bit de execução). São 190 MB parados num disco que
    acabou de receber 1,5 GB de bom grado.
    **(b) O custo do erro é assimétrico e irreversível.** Uma varredura que
    apaga "o que o catálogo não conhece" é um código que decide sozinho
    destruir arquivo na máquina de alguém, sem suporte para socorrer quem for
    atingido por um caso que não previmos — pasta de cache compartilhada,
    caminho reaproveitado, symlink, um download em curso de uma versão antiga
    do aplicativo rodando ao lado. O produto inteiro é construído sobre "nada
    é apagado, nada é sobrescrito sem dizer" (#71, #79, CRÍTICO-1). Abrir a
    exceção "menos na nossa pasta" é abrir a exceção.
    **(c) Faz o produto tomar uma iniciativa que ninguém pediu.** Quem quiser
    os 190 MB de volta apaga o arquivo — o dono do produto ensina cada pessoa
    pessoalmente, e "pode apagar o arquivo antigo da pasta X" é uma frase que
    ele pode dizer. O que ele não pode é desfazer uma remoção automática.
    **O que se fez em vez disso**: o bloco do `CATALOGO` registra que o arquivo
    órfão existe e que o aplicativo não mexe nele, para o próximo a ler o
    código não achar que foi esquecimento.
131. **A medição de tempo do modelo pequeno também fica — e nem é apagada nem
    reetiquetada.** A linha `transcricao:ggml-small-q5_1.bin` de
    `medicoes_da_maquina` vira lixo inofensivo: ninguém a lê, porque a chave
    carrega o ARQUIVO e o arquivo saiu da lista de modelos (#112 + a chave por
    arquivo).
    **Reetiquetá-la para o `ggml-medium.bin` seria afirmar que uma medição
    feita com um motor vale para outro** — exatamente o erro que o PRD V10
    registrou (#72) —, e com consequência concreta: erro de fator ~3, **para
    menos**, na única frase que diz quanto tempo o trabalho leva. Apagá-la
    seria o mesmo tipo de iniciativa da #130, sobre dado que o programa
    produziu.
    **A reetiquetagem da v0.10.0 continua rodando**, e agora com o propósito
    invertido: ela não existe mais para a linha VALER, e sim para a linha ser
    IDENTIFICÁVEL. Uma chave `transcricao` nua seria a próxima candidata a ser
    "aproveitada" por engano; com o nome do arquivo colado nela, ninguém a
    confunde com a medição do modelo atual. Há teste pinando que
    `ARQUIVO_DO_MODELO_UNICO` **não** é um arquivo do catálogo — a guarda é o
    contrário exato da que existia na V10.2.
132. **O tamanho na tela passou de MB para GB, e é por legibilidade, não por
    estética.** Com o pequeno fora, o único arquivo de dado tem 1.533.763.059
    bytes, e o formatador dizia **"1462,7 MB"**: quatro dígitos antes da
    vírgula deixam de dizer se é muito ou pouco, que é o único trabalho desse
    número (régua da #100 — a frase tem de ser legível na hora de decidir).
    O GB é **binário**, como o MB e o kB que já estavam ali: duas bases no
    mesmo formatador dariam dois tamanhos para o mesmo arquivo, e o "181,3 MB"
    que a tela mostrou por três versões era binário.
    **O "1462,7 MB" já estava na tela desde a v0.10.1**, no cartão do modelo
    grande — ninguém tinha olhado porque o cartão que a pergunta do fim
    oferecia era o do pequeno. Tirar o pequeno foi o que trouxe esse número
    para a frente.
    Os textos que mudaram de número, e nenhum de forma:
    *cartão do modelo em Configurações* — "É preciso baixar um arquivo de
    **1462,7 MB**, uma vez só." → "…de **1,4 GB**, uma vez só." (o tempo já era
    "cerca de 9 minutos", e continua);
    *botão do mesmo cartão* — "Baixar (**1462,7 MB**)" → "Baixar (**1,4 GB**)";
    *pergunta do fim da varredura* — "…baixe **182,8 MB** em Configurações —
    cerca de 1 minuto." → "…baixe **1,4 GB** em Configurações — cerca de 9
    minutos." (ela somava o programa mais o modelo PEQUENO; agora soma o
    programa mais o único que existe);
    e *o cartão inteiro do modelo pequeno* — título, "É preciso baixar um
    arquivo de 181,3 MB… cerca de 1 minuto" e o botão "Baixar (181,3 MB)" —
    **saiu da tela**, porque a tela lista o catálogo (#101).
    Os 9 minutos são a banda de referência de 3 MB/s da #128 aplicada a 1,5 GB
    — o mesmo "~8 min (café)" que ela previu, arredondado pela tela. A ressalva
    de internet lenta continua enquanto o número for declarado.
133. **O mock perdeu o cartão do modelo pequeno junto com o Rust.** Catálogo do
    mock MAIOR que o do backend é a mesma família das quatro divergências da
    #88, ao contrário: a tela ficaria preparada para um cartão que o aplicativo
    real não tem, e o E2E — que roda contra o mock — certificaria esse cartão.
    O `AcessorioInfo["nome"]` do `api.ts` perdeu `"modelo-de-transcricao"` pelo
    mesmo motivo.
    **O nome de contrato do que ficou continua sendo
    `"modelo-de-transcricao-grande"`**, com o `-grande` herdado de quando eram
    dois. Ele nunca aparece na tela (o que a pessoa lê é o `para_que_serve` do
    backend), e renomear identidade de contrato para melhorar a leitura de quem
    escreve o código é o tipo de troca que quebra o `acessorio_baixar` de quem
    não tem a quem perguntar.
    **A frase do cartão mudou, e essa mudou de conteúdo.** Ela era *"entender
    melhor o que é cantado — é bem mais lento, e o aplicativo usa este quando
    ele está aqui"*, e a segunda metade respondia à pergunta de quem via dois
    cartões parecidos: *preciso dos dois? qual roda?*. Essa pergunta deixou de
    existir, e uma tela que a responde está falando de um arquivo que não está
    lá. A que sobra, diante de um cartão só e de 1,4 GB, é *o que eu perco se
    não baixar?* — daí *"entender o que é cantado — sem ele o aplicativo não
    escreve letra nenhuma"*.

## V10.6 — a transcrição deixou de morar dentro de uma tela temporária

134. **"Quais músicas estão sem letra" é fato PERMANENTE da biblioteca, e
    estava amarrado ao resultado de uma varredura. O erro de projeto era esse,
    e é ele que esta rodada conserta.**
    Relato de campo, verbatim, depois de rodar "Buscar dados desta pasta" na
    biblioteca inteira e receber 1 conflito + 27 propostas de nome com dois
    botões — "Aplicar selecionadas (28)" e "Começar agora": *"Achei que eu
    poderia clicar em aplicar e depois trabalhar nas transcrições, mas não
    aconteceu… Simplesmente fechou a caixa e aplicou essas 28… Mas agora tenho
    que começar de novo pra chegar na parte de transcrição de novo… Acho que a
    experiencia pro usuario fica confusa assim."*
    O sintoma era que as duas ações COMPETIAM: a oferta de transcrição vivia
    dentro da caixa de revisão, aplicar fechava a caixa, e dava para aplicar OU
    transcrever, com a ordem importando de um jeito que ninguém adivinha. **O
    que se perdia não era um clique: era a varredura inteira** — minutos num
    acervo grande, e o mesmo estrago para qualquer fechamento (o botão, o Esc,
    mandar para segundo plano).
    A causa mais funda é que resultado de varredura é EFÊMERO, e a lista das
    músicas sem letra não é resultado de varredura: o banco sempre soube
    respondê-la. Três correções, e a terceira é a que torna as outras duas
    baratas.
135. **Aplicar não fecha a caixa, e cada linha passa a carregar o seu
    desfecho.**
    A caixa continua aberta depois do apply: o aviso do desfecho é o mesmo, as
    linhas gravadas ficam na tela com o selo `GRAVADA` e a frase "Gravada no
    arquivo.", e a oferta de transcrição continua ali. Fechar é só do "Fechar" e
    do Esc — e o Esc durante a varredura ou a transcrição continua sendo
    "mandar para segundo plano", como era.
    **O `retainFailures` virou `registrarAplicacao`, e a troca é de propósito.**
    Aquele mantinha na revisão SÓ as linhas que falharam, e isso só fazia
    sentido enquanto aplicar fechava a caixa: as gravadas saíam da lista porque
    a lista ia embora de qualquer jeito. Agora a lista inteira fica, e o que a
    A5 garantia continua garantido — a linha recusada fica com o motivo do
    backend —, com uma melhora: ela fica AO LADO das que gravaram, e antes quem
    visse só as recusadas não tinha como saber que o resto foi.
    **A garantia de não aplicar duas vezes a mesma linha mora em quatro lugares
    que se somam**, e nenhum deles é "o usuário não vai clicar": a linha gravada
    entra em `aplicadas` (por POSIÇÃO, não por música — a mesma música pode ter
    duas linhas e gravar uma não grava a outra), a caixa fica desabilitada e
    desmarcada, o `handleApply` filtra `!aplicadas.has(i)` antes de montar o
    lote, e "Marcar todas" e a pré-marcação a ignoram.
    **E o eco do `apply` passou a ser o do ARQUIVO, não o do instante da
    varredura.** É o que a caixa aberta obrigou a consertar: aplicar o nome e
    depois a letra da MESMA música é o caso TÍPICO (a música que sobra sem letra
    é justamente a que tem uma proposta de nome pendente), e a segunda gravação
    seria recusada com "a música mudou depois da busca" (A5) — e ela mudou, sim:
    mudamos nós, um clique antes. O `apply` devolve a `Song` gravada; ela vira o
    eco das outras linhas daquela música, com `has_lyrics` e `letra_origem`
    junto, que é o que decide o aviso de substituição de letra.
    **As gravadas ganharam GRUPO PRÓPRIO, no fim da lista**, e isso não é
    arrumação: a frase do grupo dobrado diz "27 músicas sem título ou artista
    vão receber o nome que está no arquivo", e sobre uma linha já gravada isso é
    mentira. Com o grupo próprio a contagem de cada grupo volta a medir o que
    FALTA, e o cabeçalho volta a contar decisões em aberto. Ele nasce FECHADO,
    como o dobrado: 28 linhas "Gravada no arquivo." empurrariam a oferta de
    transcrição para fora da tela, que é exatamente o defeito que esta versão
    veio consertar.
    **A linha gravada NÃO recebe opacidade.** O apagado é da linha com ERRO,
    cuja informação é a frase vermelha; a gravada é o registro do que a pessoa
    acabou de fazer, e é o que ela vai reler para conferir — opacidade sobre o
    cinza secundário derrubaria o contraste abaixo de AA (#69). O que sai dela
    são os avisos que PEDEM ação ("confira antes de aplicar", "Aplicar marca a
    música como instrumental", "confira antes de marcar"): não há mais o que
    conferir antes de quê.
136. **A porta permanente: `transcricao_pendentes(folder_prefix)`, e a
    `Contagem` NÃO ganhou a lista.**
    O contrato:
    ```
    transcricao_pendentes(folderPrefix: String) -> PendentesDaTranscricao {
      musicas: Vec<i64>,                        // os ids que transcrever_musicas recebe
      segundos_estimados: u64,
      estimativa_medida_nesta_maquina: bool,
      disponivel: bool,
    }
    ```
    São os MESMOS três campos que `EnrichScanResult` já devolvia
    (`sem_letra_no_fim`, `segundos_de_transcricao`,
    `estimativa_medida_nesta_maquina`) mais o `disponivel` que a `Contagem` já
    reportava, de propósito: **a tela lê a oferta de um jeito só, venha ela da
    pergunta do fim ou de Configurações**, e o `startTranscricao` recebe a fila
    por parâmetro em vez de ganhar um segundo caminho — mesma store, mesma
    barra, mesmo cancelamento, mesma revisão no fim. Um segundo caminho seria um
    segundo lugar onde os três divergem (a lição do M4).
    **Pendurar os ids na `Contagem` foi recusado.** Ela descreve o custo da
    VARREDURA, e a tela a pede a cada troca de pasta — poria milhares de ids na
    resposta do caminho quente que a #125 acabou de desafogar. São duas
    perguntas ("quanto vai custar varrer" e "o que a etapa 5 tem para fazer"), e
    cada uma tem a sua porta. O `is_file` por candidata (o portão da QA M3) fica
    na porta nova, e não na contagem.
    **A regra é `a_etapa_5_tem_o_que_fazer`, a mesma da pergunta do fim** —
    instrumental não é transcrito, música com letra não entra, arquivo que sumiu
    do disco não é trabalho. Reescrevê-la aqui como "não tem letra" seria a #80
    pela terceira vez, e com consequência concreta: a tela prometeria trabalho
    sobre arquivos que já não existem, e a fila devolveria linhas de erro para
    quem confiou no número. Há teste, nos dois lados do par da #88, comparando
    as duas portas campo a campo.
    **A estimativa também saiu de UMA função** (`estimativa_da_transcricao`):
    ela devolve `(segundos, medida_nesta_maquina)`, e é ela que as duas portas
    chamam. Duas contas dariam dois tempos para a mesma biblioteca na mesma
    tela, e ninguém saberia qual acreditar.
    **O que DIFERE entre as duas portas é o MOMENTO, não a regra, e isso está
    escrito nos dois lados.** A pergunta do fim desconta quem acabou de ganhar
    uma proposta de letra naquela varredura: cobrar minutos de CPU por uma letra
    que está ali na lista esperando um clique seria cobrar caro por algo que o
    clique resolve. A porta permanente não tem varredura a descontar — responde
    o fato de AGORA, que é o que uma tela permanente pode afirmar. Aplicada a
    proposta, o fato muda e as duas voltam a dizer a mesma coisa.
    **O bloco fica no fim da seção "Curadoria do acervo", sob o MESMO seletor de
    pasta**, e o texto diz de qual escopo o número fala ("da biblioteca" /
    "desta pasta"): a seção não pode inventar um segundo vocabulário de pastas,
    e um número sem escopo é a pergunta que ninguém vai poder tirar com ninguém.
    Ele é reperguntado nas mesmas condições da contagem — troca de pasta,
    mudança do acervo, acessório instalado —, então aplicar uma letra faz o
    número cair sozinho. Resposta que não voltou ou que falhou **não vira zero
    nem promessa** (#86): o bloco não desenha nada.
    **A segunda frase é literalmente a mesma da pergunta do fim**
    (`fraseDoTempoDaTranscricao`), com a ressalva de procedência do número
    inclusive. Só a abertura muda, porque "sobraram" só é verdade logo depois de
    uma varredura. **Zero é RESPOSTA** — "Nenhuma música da biblioteca está sem
    letra." —, e vence a indisponibilidade: oferecer 1,4 GB de download para
    transcrever nada seria pedir um trabalho que não existe.
    **E sem os acessórios o texto aponta para CIMA, não para "Configurações"**:
    já estamos nela, e os blocos de download estão a poucos pixels acima.
    Repetir o TEMPO que eles já dizem seria o ruído que a #100 proíbe; o TAMANHO
    fica, porque é ele que responde à pergunta daquele segundo — *por que não
    posso, e o que faço?*.
    O `TRANSCRICAO_NO_FIM` mudou junto: ele dizia que a etapa 5 "é oferecida no
    fim", e passou a dizer "no fim da busca — e aqui embaixo, a qualquer
    momento". Texto que mente sobre o próprio produto é defeito, e este é o
    mesmo texto que a V10 já corrigiu uma vez pelo mesmo motivo.
137. **O aviso de fechar com a oferta pendente é INFORMATIVO, e não uma
    confirmação — e essa escolha depende da #136 estar completa.**
    A alternativa era um "tem certeza?" bloqueante. Ela foi recusada porque,
    **com a porta permanente, a lista já não se perde**: a caixa cobraria uma
    decisão por um prejuízo que deixou de existir, e pop-up que se aprende a
    fechar sem ler é pop-up que não avisa mais nada — é o mesmo argumento que
    fez a pergunta do fim não voltar depois do "Agora não".
    O que ficou é uma frase, na régua da #100, dizendo PARA ONDE a oferta foi:
    *"Ainda há 27 músicas sem letra. Escrever a letra ouvindo o áudio continua
    em Configurações, quando você quiser."* Ela não fala em perder nem em
    descartar: fechar é ação legítima, e a varredura foi só leitura.
    O tom é `warning`, e não um quarto tom de toast: é um aviso, do mesmo peso
    do da etapa 2 que parou no meio. Vocabulário visual novo para uma frase é
    custo sem pergunta nova a responder.
    A condição é EXATAMENTE a que desenha a oferta (revisão, gente sobrando,
    etapa 5 possível nesta máquina, pergunta não dispensada). Avisar sobre uma
    oferta que a pessoa não viu, ou que ela já respondeu, é ruído — e ruído numa
    tela sem suporte é dúvida. Cancelar uma varredura ou uma transcrição em
    curso não passa por aqui: não há oferta ainda, e a frase falaria de uma
    lista que nem terminou de ser montada.
138. **O que NÃO se fez, e fica escrito.**
    **(a) A oferta dentro da revisão não é reperguntada ao backend depois do
    apply**, e o número dela continua exato por construção: `sem_letra_no_fim`
    exclui, no Rust, toda música para a qual a varredura ACHOU letra, então
    nenhuma linha aplicável pode dar letra a quem está nessa lista. Reperguntar
    seria pior: a porta permanente responde o fato de AGORA, e a oferta pularia
    de 20 para 25 ao aplicar — um número mudando por um motivo que a pessoa não
    tem como ver.
    **(b) O bloco permanente não é uma seção nova de Configurações.** Ele mora
    dentro de "Curadoria do acervo" porque reusa o seletor de pasta e a leitura
    dos acessórios que já estão ali; uma seção própria duplicaria os dois, e a
    #80 é sobre exatamente isso.
    **(c) `Contagem.sem_letra` NÃO foi reusado como o número do bloco.** Ele
    conta `etapas_de_letra_valem_a_pena`, sem o `is_file` da QA M3: seria um
    número parecido, e diferente do que a fila vai fazer.
    **(d) A `razao_desta_maquina` continua sem consumidor no frontend.** A #112
    a deixou informativa de propósito, e a porta nova não mudou isso: quem diz à
    tela o que ela pode afirmar continua sendo o booleano.

## V10.7 — as duas mensagens que diziam o contrário do que aconteceu (teste em campo da v0.10.3)

139. **O cabeçalho anunciou "7 músicas não puderam ser CONSULTADAS" sobre 7
    músicas que foram consultadas com sucesso.**
    Relato de campo: o dono rodou a varredura, mandou gravar as letras, e 7
    músicas falharam. Cada linha trazia o motivo da GRAVAÇÃO, e o cabeçalho do
    grupo dizia *"7 músicas não puderam ser consultadas — o motivo está em cada
    linha"*. As sete tinham proposta e selo MÉDIA na tela: a consulta funcionou
    perfeitamente, e foi a gravação que caiu.
    A causa era um grupo só (`"erros"`) para dois desfechos: o `grupoDaProposta`
    devolvia `"erros"` tanto para o erro que vem da VARREDURA (`p.error`) quanto
    para o que vem do `applyErrors`, e o título daquele grupo tinha de escolher
    uma das duas verdades. Escolheu a errada para o caso que apareceu em campo —
    e num produto sem suporte o cabeçalho é a explicação inteira.
    **O que separa os dois não é a origem do erro: é o que sobra para a pessoa
    fazer.** Falha de CONSULTA quer dizer que o programa não descobriu nada
    sobre a música, e não há o que aplicar. Falha de GRAVAÇÃO quer dizer que o
    programa descobriu, a pessoa mandou gravar, e o arquivo recusou — a sugestão
    continua ali, e o que falhou foi escrever. São `"nao-consultadas"` e
    `"nao-gravadas"`, com título próprio cada um:
    *"1 música não pôde ser gravada no arquivo — o motivo está na linha dela"*.
    O "no arquivo" é o par exato do grupo das gravadas ("1 música gravada no
    arquivo"): são as duas metades do mesmo clique, e o mesmo vocabulário nas
    duas é o que deixa a tela legível de relance. **O motivo continua por
    LINHA** porque ele é por arquivo — sete músicas podem falhar por sete razões
    diferentes, e um motivo só no cabeçalho seria um palpite sobre seis delas.
140. **`nao-gravadas` vem ANTES de `nao-consultadas`, e as duas continuam
    depois do grupo dobrado.**
    O alto da lista é para o que um clique distraído estraga (a #79 e a régua da
    V10), e em nenhuma das duas há clique a dar. O que as ordena entre si é a
    urgência do que a pessoa faz em seguida:
    - `nao-gravadas` é consequência DIRETA do clique que ela acabou de dar. É a
      informação nova da tela naquele segundo, e é a única cujo motivo aponta
      para algo do computador dela — arquivo aberto em outro programa, disco
      cheio, pasta sincronizada com a nuvem —, que ela pode conferir e refazer a
      busca depois;
    - `nao-consultadas` é registro: repetir o clique não muda nada, porque não
      há proposta nenhuma naquela linha. O que pode mudar é a internet, mais
      tarde. Ela existe para a música não sumir em silêncio (#47), e fica no
      penúltimo lugar — antes só das gravadas, que são as únicas sem nada a
      decidir (#135).
141. **A ordem passou a SER o tipo, porque a omissão não quebrava teste
    nenhum.**
    `GrupoDaRevisao` era uma união escrita à mão e `ORDEM_DOS_GRUPOS` uma lista
    à parte — e `agruparPorRisco` monta a tela percorrendo a LISTA. Um grupo no
    tipo e fora da lista não aparece: ele e as linhas dele desaparecem, sem erro
    de compilação e sem teste vermelho. Era a divergência por omissão da #88 com
    outra roupa, dentro de um arquivo só.
    Agora o tipo sai da lista (`(typeof ORDEM_DOS_GRUPOS)[number]`), e esquecer
    de listar um grupo novo deixou de ser possível. Duas guardas se somam a
    isso: o `default` do `tituloDoGrupo` atribui o grupo a um `never` — sem
    `noImplicitReturns` no `tsconfig`, um `case` que falte devolvia `undefined`
    em silêncio, e agora não compila —, e uma tabela de testes com `satisfies
    Record<GrupoDaRevisao, …>` prova que **todo grupo do tipo é alcançável a
    partir de uma proposta de verdade**, além de que dois grupos nunca dizem a
    mesma coisa no singular nem no plural.
142. **A frase da gravação mandava conferir o cabo do HD por um problema que
    não é do cabo.**
    O `frase_de_lofty` mandava OITO variantes de erro do lofty para o mesmo
    `ERRO_ARQUIVO_ILEGIVEL`: *"não foi possível ler este MP3 até o fim, e por
    isso nada foi gravado — o arquivo pode estar danificado, ou o disco onde ele
    está pode ter sido desconectado"*. As oito são falhas de PARSE: acontecem
    DEPOIS de o arquivo ter sido aberto e lido com sucesso. **Disco desconectado
    e leitura interrompida produzem `std::io::Error`**, que já tinha caminho
    próprio (`ErrorKind::Io(io) => frase_de_io(io)`) — então a única coisa que a
    frase garantia era mandar a pessoa mexer no que estava certo. Num parque de
    máquinas que ninguém pode olhar, essa é a pior mensagem possível: ela custa
    o tempo de quem desliga e religa um HD que nunca esteve em questão.
    O diagnóstico de campo confirmou o quadro: os arquivos são MPEG legítimos,
    não estão danificados, e o disco estava conectado.
    A frase antiga **não existe mais**. No lugar dela, três:
    - **estrutura do arquivo** (`UnknownFormat`, `FileDecoding`, `SizeMismatch`,
      `TooMuchData`, `FakeTag`) — *"o programa não entendeu como este MP3 está
      montado por dentro, e nada foi alterado no arquivo — não há como gravar
      etiquetas nele, e não há nada que você possa fazer por aqui"*;
    - **texto de etiqueta** (`StringFromUtf8`, `StrFromUtf8`, `TextDecode`) —
      *"o texto de uma etiqueta deste MP3 está escrito de um jeito que o
      programa não conseguiu ler, e nada foi alterado no arquivo — o problema é
      só nesse texto, e não há nada que você possa fazer por aqui"*;
    - **o arquivo que saiu de baixo do programa** (`io::ErrorKind::NotFound`,
      que herdou a frase do disco por ser o único lugar onde ela responde algo) —
      *"o arquivo não está mais onde estava, e nada foi gravado — se ele fica num
      HD externo ou num pen drive, confira se o aparelho continua ligado e
      conectado"*.
    Três coisas estão em cada frase de propósito: **o que aconteceu**, que
    **nada foi alterado no arquivo** — é a resposta ao medo de quem lê ("perdi a
    música?") e é verdade porque as duas famílias falham antes de o arquivo ser
    tocado — e **o que fazer**. Onde não há o que fazer, a frase diz isso: "não
    há nada que você possa fazer por aqui" é informação, e um "tente de novo"
    ali seria uma ação inútil pedida a quem não tem a quem perguntar.
143. **As três de TEXTO não são "arquivo danificado", e chamá-las disso é
    acusação falsa.**
    `StringFromUtf8`, `StrFromUtf8` e `TextDecode` são bytes de texto de
    etiqueta que não correspondem à codificação declarada no próprio quadro: um
    comentário gravado em Latin-1 e anunciado como UTF-8, um título de um
    programa antigo, um UTF-16 sem a marca de ordem dos bytes. **O áudio não
    está envolvido e o arquivo pode estar perfeito.** Dizer "pode estar
    danificado" é a #97 aplicada a um arquivo em vez de a um acessório — e a
    frase nova diz o contrário, que o problema é só naquele texto.
    A separação também **não afirma a causa** que ainda está sendo medida. A
    hipótese mais provável da família da estrutura — um arquivo que nunca foi
    MPEG, com nome de `.mp3`, que TOCA no aplicativo porque quem decodifica o
    áudio é o WebView e só a gravação de etiqueta exige fluxo MPEG — é
    justamente a que não se escreve na tela sem medição: quem separa isso
    arquivo por arquivo é o `tools/diagnosticar_mp3.py`.
    Fica registrada uma ressalva medida na fonte do lofty 0.22.4: `TooMuchData`
    também pode sair da ESCRITA, se a etiqueta a gravar passar de 256 MB (o teto
    do campo synchsafe) ou se um quadro de imagem alheio passar do limite de
    alocação. Nenhum dos dois é alcançável neste acervo — a etiqueta que
    gravamos tem uma letra de música dentro —, e se um dia for, a frase continua
    não acusando nada que a pessoa tenha feito.
    **Guardas para a próxima fusão.** Um teste percorre as dez frases do módulo
    e exige que sejam TODAS distintas: duas famílias com a mesma frase são uma
    família só na tela, que é exatamente como as oito variantes viraram uma. Um
    segundo teste exige que nenhuma frase de parse contenha "disco",
    "desconect", "cabo", "pen drive" ou "conectad", e que todas digam que o
    arquivo ficou intacto. E a tabela de tradução deixou de visitar duas
    variantes: ela cita as doze, uma por uma — tabela que só visita o caso fácil
    certifica o contrário do que o código faz (#113).
144. **O que NÃO se fez, e fica escrito.**
    **(a) A linha que falhou ao gravar continua sem "tentar de novo".** Ela
    segue desabilitada, como toda linha com erro desde a A5. Reabrir o clique
    exigiria decidir o que fazer com o eco do arquivo (a #135 mostrou que a
    segunda gravação da mesma música é recusada com "a música mudou depois da
    busca" quando o eco é o da varredura), e o motivo da recusa é quase sempre
    de fora do aplicativo — arquivo em uso, pasta sincronizada, arquivo que não
    é MPEG. O caminho honesto continua sendo: resolver o que a linha diz e
    repetir a busca. Por isso o título do grupo não promete um clique que não
    existe.
    **(b) Não se inventou frase para a causa específica da sobra entre a
    etiqueta declarada e o primeiro quadro MPEG** (8 dos 53 arquivos da pasta do
    relato, com a etiqueta declarando 4.096 bytes e o quadro 1.251 bytes
    adiante). A medição não terminou, e a mensagem que a nomeia vem com ela. Os
    dois consertos desta seção valem independentemente do resultado.
    **(c) O frontend NÃO ganhou uma tabela espelhada das frases do writer.** As
    do `acessorios.rs` estão espelhadas no `mockBackend` (`ERROS_DE_GRAVACAO`)
    porque a tela de Configurações as MOSTRA e o E2E precisa delas; as do
    `writer.rs` chegam à linha da revisão como texto opaco vindo do `apply`, e o
    mock não tem um leitor de MP3 para as produzir. Espelhá-las criaria uma
    segunda versão da verdade sem um segundo produtor — o oposto do que a #88
    pede. O E2E cobre o GRUPO com a falha de gravação que o mock sabe produzir
    (o arquivo que sai do lugar entre a varredura e o clique).
    **(d) O `tools/diagnosticar_mp3.py` não teve a lógica tocada** — só os dois
    trechos de documentação que citavam a frase antiga como se ela ainda
    existisse. Texto que mente sobre o próprio produto é defeito mesmo quando
    quem lê é o próximo programador.

## V10.8 — o arquivo que recusava toda gravação, e o conserto que vem junto com o clique

145. **A causa foi medida, e não deduzida: uma SOBRA entre o fim declarado da
    etiqueta e o primeiro quadro MPEG.**
    Sete arquivos de um acervo real recusavam TODA gravação de etiqueta —
    aquelas músicas saíam da curadoria para sempre, porque toda tentativa
    falhava igual e em silêncio. A #144(b) registrou a suspeita e disse que a
    mensagem que a nomeia viria com a medição. Ela veio.
    Os arquivos têm uma região de bytes entre o **fim DECLARADO da etiqueta
    ID3v2** e o **primeiro quadro MPEG**. No arquivo medido: a etiqueta
    declarando terminar no byte 4.096 e o primeiro quadro em 5.347 — **1.251
    bytes** que não são etiqueta declarada, não são cabeçalho de codificador e
    não são áudio (81% zeros com bytes aleatórios por cima).
    O que a medição contra o lofty 0.22.4 mostrou, e o que cada número decide:
    - a **LEITURA passa**. `MpegFile::read_from` procura o sync de MPEG sem teto
      nenhum (`find_next_frame`), acha o quadro 1.251 bytes adiante e devolve a
      etiqueta inteira. É por isso que estes arquivos TOCAM, aparecem na lista
      com título e artista, e nada avisa que há algo errado neles;
    - a **GRAVAÇÃO falha com `UnknownFormat`**. Ao gravar, o lofty reexamina o
      formato pelo CONTEÚDO (`Probe::guess_file_type` dentro de `write_id3v2`),
      e ali a busca do sync tem teto: `ParseOptions::DEFAULT_MAX_JUNK_BYTES`,
      que é **1.024**. 1.251 > 1.024, o sync não é encontrado, e o formato fica
      "desconhecido";
    - **o tamanho da etiqueta nunca foi o problema.** Um arquivo de controle com
      a MESMA etiqueta de 4.096 bytes e sem a sobra grava normalmente, e uma
      sobra menor que 1.024 também grava. É a relação com o teto que decide;
    - na falha, **nada é escrito**: o arquivo fica byte a byte igual, porque a
      recusa acontece antes de o lofty tocar nele;
    - as duas rotas de gravação (`TaggedFile` e `Id3v2Tag` direto) falham igual;
    - **o conserto**: corrigir o campo de tamanho do cabeçalho ID3v2 para
      alcançar o primeiro quadro (4086 → 5337, **dois bytes**, nas posições 8 e
      9). Nenhum byte é removido, nenhum byte é movido: a região passa a ser
      enchimento DECLARADO dentro da etiqueta, que é o que todo editor de
      etiqueta escreve depois dos quadros. Depois disso o lofty lê **e grava**;
    - **o áudio sobrevive idêntico** — conferido pelo SHA-256 dos bytes de áudio
      antes e depois (16.508 bytes, o mesmo resumo nos dois).
146. **O conserto acontece junto com a gravação que a pessoa pediu, sem linha
    separada e sem clique a mais.**
    Ela já decidiu: mandou gravar esta letra neste arquivo. Corrigir o número da
    etiqueta é o MEIO de fazer o que ela pediu, não uma segunda decisão — e
    perguntar *"seu arquivo tem uma anomalia estrutural, posso corrigir 2
    bytes?"* é pergunta técnica para quem não tem como respondê-la: exatamente o
    pedágio que a #102 existe para eliminar. Uma tela nova, um botão "consertar
    arquivos" ou uma caixa de confirmação seriam três formas diferentes de
    transferir para 40 pessoas sem suporte uma decisão que é nossa.
147. **O gatilho é a FALHA, e nunca a suspeita — e isso é o que torna o falso
    positivo inalcançável.**
    O conserto só é tentado DEPOIS de a gravação normal falhar com
    `UnknownFormat`. Nenhuma varredura procura anomalia, e num arquivo que grava
    bem nem o campo de tamanho é lido.
    A razão é medida, e é humilhante: **o nosso próprio detector acusou um
    arquivo PERFEITO.** Num MP3 feito com LAME o primeiro quadro de áudio
    carrega o cabeçalho Xing/Info (enchimento `0x55` + a assinatura "LAME"), e
    um detector que procura o primeiro `FF Fx` depois da etiqueta pode achar o
    SEGUNDO quadro e chamar o miolo do primeiro de "sobra" — está documentado na
    função `sobra_e_inocente` do `tools/diagnosticar_mp3.py`, que existe porque
    ferramenta de diagnóstico que grita lobo é pior que nenhuma.
    Com o gatilho sendo a falha real, esse falso positivo não tem por onde
    entrar. É o mesmo raciocínio da #120: **medir antes de mexer**, e mexer só
    onde a medição aponta.
148. **As duas garantias, que não são promessas.**
    **(a) O áudio é CONFERIDO, não prometido.** Antes de mexer, os bytes
    originais vão para a MEMÓRIA e o SHA-256 dos bytes de áudio (do primeiro
    quadro MPEG até o fim do arquivo) é calculado. Depois de gravar, o resumo é
    conferido. Se mudou um byte — ou se o arquivo não puder mais ser lido —, os
    bytes originais são regravados e a gravação vira recusa em pt-BR
    (`ERRO_AUDIO_MUDARIA`). **Nunca sai daqui um arquivo alterado.**
    Memória, e não arquivo temporário: **nada é criado dentro da pasta do
    acervo**, que é promessa do produto. Música tem alguns MB e a cópia cabe.
    A restauração tem teste próprio, e ele é unitário de propósito: provocá-la
    pelo caminho de fora exigiria um arquivo que faz o lofty estragar o áudio, e
    ninguém sabe construir um. O teste dá à conferência um resumo que NÃO bate e
    exige o arquivo de volta, byte a byte — e ele fica vermelho quando a
    restauração é removida (conferido).
    **(b) O desfecho DIZ o que foi feito.** Sem pedágio antes e sem segredo
    depois: um conserto silencioso no arquivo de alguém é a mesma falta de
    respeito que uma pergunta impossível, com o sinal trocado. A frase, na régua
    da #100 (172 caracteres, uma frase):
    *"para conseguir gravar, o programa corrigiu uma medida errada por dentro da
    etiqueta deste MP3 — a música em si não foi alterada, e o programa conferiu
    isso depois de gravar"*.
    Ela diz **o que aconteceu**, **responde ao medo de quem lê** ("perdi a
    música?") e **não promete — conta o que foi conferido**. Atravessa o contrato
    inteiro: `writer::Gravacao { song, aviso }` → `EnrichApplyResult::aviso` →
    `mockBackend` → `enrichStore::avisosDaGravacao` → a linha da revisão.
    O `aviso` **não é o `error`**, e a distinção é a #139 outra vez com outra
    roupa: no `applyErrors` ele desabilitaria e apagaria justamente a linha que
    gravou, e o cabeçalho do grupo diria que ela "não pôde ser gravada no
    arquivo" — o contrário do que aconteceu. Na tela ele fica DEPOIS do "Gravada
    no arquivo." (a primeira coisa a ler é que deu certo) e em **cinza
    secundário, não âmbar**: âmbar é ressalva a conferir antes de clicar, e aqui
    não há nada a decidir. E ele aparece **uma vez só** — a anomalia cai do
    arquivo na primeira gravação, e repetir o aviso sobre um arquivo já são
    ensinaria a ignorá-lo.
149. **Onde o conserto se RECUSA a agir, e por quê.**
    O gatilho `UnknownFormat` é compartilhado com outras causas, e um conserto
    cego ali estragaria arquivo. Cada recusa abaixo devolve a frase de sempre
    (`ERRO_ESTRUTURA_DO_MP3`) e não escreve nada:
    - **a sobra que carrega OUTRA ETIQUETA** (`ID3`, `3DI`, `APETAGEX`, `TAG` —
      a mesma lista do `MARCAS_DA_SOBRA` do diagnóstico, menos as marcas de
      codificador, que nunca chegam aqui). Absorver a sobra faz o lofty
      reescrever aquela região, e se o que estava ali era a etiqueta APE de
      alguém o conserto apagaria dado existente para poder gravar. Recusar é
      ruim; apagar é a regra que não se quebra. A diferença entre enchimento e
      dado é justamente a assinatura;
    - **a etiqueta com RODAPÉ** (sinalizador `0x10`): o rodapé desloca o fim do
      bloco em 10 bytes, e errar essa conta é a única forma de o conserto mirar
      no lugar errado. Nenhum arquivo do relato tem rodapé, e recusar custa uma
      gravação que já estava recusada;
    - **campo de tamanho não synchsafe, tamanho maior que o arquivo, e ausência
      de sobra**: nos três o número não descreve o arquivo, e mexer nele seria
      chutar;
    - **o `.mp3` que nunca foi MPEG** — a outra causa conhecida de
      `UnknownFormat` (#143), que não tem conserto nenhum: não há primeiro
      quadro para alcançar.
    E o **primeiro quadro é achado por dois quadros, não por um**: sync válido,
    versão/camada/bitrate/amostragem válidos, e o quadro seguinte caindo
    exatamente no comprimento calculado, com a mesma versão, camada e taxa (a
    mesma conferência do `cmp_header` do lofty). Um `FF Fx` solto aparece dentro
    de qualquer bloco de bytes, e mirar nele seria declarar áudio como etiqueta.
150. **O que a fixture prova, e por que os números dela são intocáveis.**
    `fixtures/sobra_antes_do_audio.mp3` é montada pelo `tools/make_fixtures.py` a
    partir de um MP3 de verdade (o mesmo tom do `sem_tags.mp3`, gerado pelo
    lame), com a estrutura medida em campo: etiqueta declarando terminar em
    4.096, primeiro quadro em 5.347, 1.251 bytes de sobra, 82% zeros. Só o CAMPO
    DE TAMANHO mente — o áudio é áudio de verdade e os quadros da etiqueta são
    quadros de verdade.
    **O primeiro teste é o que prova que ela reproduz o defeito**: a leitura
    passa e devolve o título, e a gravação falha com `UnknownFormat` sem tocar no
    arquivo. Sem essa prova, todo o resto da seção poderia passar por qualquer
    outro motivo — que é o erro do teste de fumaça que "passava" sem passar o
    modelo, e custou uma versão inteira.
    Daí duas travas explícitas, uma em cada suíte: **a sobra tem de continuar
    maior que 1.024** (abaixo do teto de lixo do lofty o arquivo passa a gravar
    sozinho e o teste do conserto vira um teste de nada) e **a região não pode
    conter nenhum `0xFF`** (um sync por sorte da semente faria a biblioteca achar
    um quadro DENTRO da sobra, e a fixture pararia de reproduzir a recusa — o
    teste passaria a medir a semente). A região do arquivo medido também não
    tinha nenhum.
151. **O que a sobra sofre está medido e escrito, não escondido.**
    Depois do conserto a região está DENTRO do bloco declarado — e o bloco
    declarado é o que a biblioteca reescreve em toda gravação de etiqueta, em
    qualquer arquivo. Então **a sobra não sobrevive à gravação**. Medido na
    fixture: 21.855 bytes antes, 17.554 depois; a etiqueta de 4.096 e a sobra de
    1.251 dão lugar à etiqueta nova de 1.046 (com o enchimento de 1.024 que o
    lofty escreve por padrão), e o áudio é **o mesmo byte a byte, os mesmos
    16.508**. Encolher assim é o que acontece com QUALQUER etiqueta grande que se
    regrave, com sobra ou sem ela.
    Isto está num teste com nome próprio para não poder mudar em silêncio. O que
    a regra inviolável protege é **dado**: quadro de etiqueta, áudio, anotação de
    alguém. Enchimento não declarado não é dado — e a única forma de ele ser dado
    é carregar assinatura de etiqueta, que é exatamente o caso em que o conserto
    se recusa a agir (#149).
152. **O que NÃO se fez, e fica escrito.**
    **(a) Nenhuma varredura, nenhum relatório, nenhum "consertar meus
    arquivos".** O conserto existe só dentro da gravação que alguém pediu. Uma
    varredura de anomalias precisaria de um detector que sabemos falível (#147) e
    de uma tela que pergunta o que ninguém pode responder.
    **(b) O EDITOR do player não conta o conserto.** O comando `write_tags`
    continua devolvendo a `Song`, e o `aviso` chega só pelo caminho do
    `enrich_apply` — que é o do relato de campo, onde as sete falhas apareceram.
    Levá-lo ao editor exigiria mudar o tipo de retorno de `writeTags` no
    frontend, consumido em mais de cem lugares, e a troca não caberia nesta
    versão sem risco desproporcional. **A GARANTIA do áudio conferido vale igual
    nos dois caminhos**, porque ela mora no `writer` e não em quem o chama: o
    editor nunca deixa um arquivo alterado. O que falta ali é a frase, e isso é
    dívida registrada, não decisão de esconder.
    **(c) A linha que falhou continua sem "tentar de novo"** — a #144(a) vale
    inteira, e agora com uma razão a menos: a causa mais comum de recusa
    permanente naquele acervo deixou de existir.
    **(d) As frases de ERRO do `writer.rs` continuam não espelhadas no mock**
    (#144c). A única frase espelhada é o AVISO, e só porque no mock existe um
    PRODUTOR dela — ele decide, por arquivo ensinado
    (`_marcarEtiquetaParaNormalizar`), que aquela gravação normalizou a etiqueta.
    Sem isso o E2E não teria como ver na tela o desfecho que esta versão promete.
    As duas cópias são fixadas como DADO nos dois lados (um teste no Rust, um no
    `mockBackend.contrato.test.ts`), que é a convenção da #88 para o que não dá
    para chamar de um processo só: mudar a frase quebra o teste de cada lado, e
    divergir passa a exigir apagar um teste em vez de acontecer por esquecimento.
    **(e) O `tools/diagnosticar_mp3.py` não teve a lógica tocada** — só a
    documentação, que passou a dizer que a sobra tem conserto no produto e quais
    duas sobras continuam sem. Texto que mente sobre o próprio produto é defeito
    mesmo quando quem lê é o próximo programador (#144d).

## V10.9 — a etapa 5 na porta de UMA música, e a lista de falhas que sumia ao fechar

153. **A etapa 5 passou a ser oferecida na ficha de UMA música, e o gatilho é a
    busca ter terminado sem trazer letra.**
    O botão "Buscar dados na internet" do editor roda as etapas 1 a 4
    (`enrich_song_scan`, `Origem::UmaMusica` — o funil de rede inteiro, inclusive
    para música que já tem letra, #81). A etapa 5 não entrava: ela custa minutos
    e vive em comando próprio, oferecida no fim da varredura e, desde a V10.6, no
    bloco permanente de Configurações.
    O buraco: a pessoa abre uma música, clica em buscar, as quatro etapas não
    acham nada — que é o caso **típico** neste repertório, com 3% de cobertura
    medida — e a única coisa que resolveria aquela música não é oferecida ali.
    Ela tinha de sair, ir a Configurações, e lá a fila é a pasta inteira.
    **É o mesmo erro de projeto que a V10.6 consertou na outra porta**: a etapa 5
    morava onde a VARREDURA termina, e não onde a PESSOA está. E aqui ela é mais
    usável do que em qualquer outra porta — uma música são minutos, não horas.
154. **Quando a oferta aparece, e por que não é "sempre".**
    Ela aparece **depois da busca**, e **não** quando a busca trouxe letra.
    **(a) Nunca antes do clique.** Naquele segundo a pergunta é se a internet tem
    esta música, e ela custa segundos contra os minutos da etapa 5. Oferecer as
    duas ao mesmo tempo é a escolha às cegas que a V8 recusou quando havia dois
    botões dizendo "buscar na internet" — e aqui a escolha errada custa minutos
    de CPU por algo que uma consulta resolveria. Um bloco permanente na ficha
    seria, ainda, uma terceira porta permanente dentro de um formulário; a régua
    da #100 diz que o resto da tela só existe se responder a uma pergunta que a
    pessoa faria NAQUELE momento.
    **(b) Achou letra, não oferece.** É a mesma razão pela qual a pergunta do fim
    desconta quem acabou de ganhar proposta de letra na varredura (#136): cobrar
    minutos de CPU por uma letra que está ali na tela, esperando um clique, é
    cobrar caro por algo que o clique resolve.
    **(c) A busca que FALHOU por falta de internet oferece.** A etapa 5 não usa
    rede, e a música que ficou sem letra porque o LRCLIB não respondeu é
    exatamente a que a transcrição resolve — está escrito nesses termos no
    `a_etapa_5_tem_o_que_fazer`. Proposta que só corrige o nome também oferece:
    nome corrigido não põe letra nenhuma no arquivo.
    **(d) O funil consultar quem já tem letra (#81) não contradiz nada disto.**
    Aquilo é sobre a CONSULTA — quem apertou o botão quer uma segunda opinião. O
    que a etapa 5 transcreve continua sendo decidido pelo backend, e música com
    letra volta com a fila vazia.
    **A única condição LOCAL é a caixa "esta música é instrumental"**, e ela não
    duplica regra do backend: descreve o FORMULÁRIO, que é mais atual que o banco.
    Quem acabou de declarar que não há voz no áudio não pode receber uma oferta de
    escrever a letra ouvindo o áudio — é a mesma razão pela qual o
    `SEM_RESULTADO_INSTRUMENTAL` existe. Pelo mesmo motivo a oferta some quando o
    campo de letra tem texto: a primeira frase dela diz "esta música continua sem
    letra", e a tela em volta a desmentiria.
155. **A porta nova é a mesma porta, num escopo menor —
    `transcricao_pendentes_da_musica(song_id)`.**
    Devolve o **mesmo** `PendentesDaTranscricao` das outras duas, aplica os
    **mesmos** portões (`a_etapa_5_tem_o_que_fazer`) e usa a **mesma** conta
    (`transcricao::estimativa_da_transcricao`). No Rust as três portas passaram a
    dividir um miolo (`pendentes_entre`); no mock, o mesmo (`pendentesEntre`).
    Três cópias dariam três tempos para a MESMA música, um por tela, e ninguém
    saberia qual acreditar (#80). Há teste nos dois lados do par da #88 somando o
    tempo de cada música e exigindo que dê o tempo da pasta.
    **Id que não existe devolve fila VAZIA, e não erro**: a ficha pode estar
    aberta sobre uma música que saiu do acervo entre o clique e a resposta, e uma
    falha inventada por nós é pior que o silêncio.
    **A escolha do modelo saiu de uma função** (`modelo_para_a_estimativa`) pelo
    mesmo motivo: as portas viraram três, e três cópias divergiriam num tempo
    anunciado.
    **Nenhum segundo caminho na tela.** `startTranscricao(musicas?)` recebe a fila
    por parâmetro desde a V10.6, e uma lista de um item era tudo o que faltava —
    mesma barra, mesmo cancelamento, mesma revisão no fim. A lista vem da PORTA, e
    não de um `[song.id]` montado no componente: montar o id na tela seria a tela
    decidindo o que a etapa 5 transcreve.
156. **A frase, e a procedência do número.**
    Com os acessórios prontos: *"Esta música continua sem letra. Escrever a letra
    ouvindo o áudio leva cerca de 4 minutos — pode levar mais nesta máquina."* —
    e "neste computador" no lugar da ressalva quando
    `estimativa_medida_nesta_maquina` autoriza (#86 e #112).
    **A segunda frase é literalmente a mesma das outras duas portas**
    (`fraseDoTempoDaTranscricao`), com a ressalva inclusive. Só a abertura muda, e
    ela muda porque as três descrevem escopos diferentes: "sobraram" só é verdade
    logo depois de uma varredura, "47 músicas da biblioteca" só numa tela
    permanente, e aqui a pessoa está olhando UMA ficha.
    **Não há caso de zero**, ao contrário do bloco permanente: sem fila, a ficha
    não desenha nada. Um "esta música já tem letra" dentro de um formulário que
    MOSTRA a letra seria responder uma pergunta que ninguém fez.
157. **Sem os acessórios, a saída é a da PERGUNTA DO FIM, e não a do bloco
    permanente — e a diferença é onde a pessoa está.**
    *"Esta música continua sem letra. Para escrever a letra ouvindo o áudio, baixe
    1,4 GB em Configurações — cerca de 9 minutos."*
    O bloco permanente aponta para CIMA porque já está em Configurações, com os
    cartões a poucos pixels acima (#136); o editor não está lá, e para ele a saída
    é o nome do lugar. A segunda frase saiu de uma função só
    (`fraseDoDownloadDaTranscricao`, extraída da `textoDaTranscricaoIndisponivel`)
    pela mesma razão da frase do tempo: duas cópias são duas telas que amanhã
    anunciam tamanhos diferentes para o mesmo download.
    O tamanho vem da MESMA leitura de acessórios que as outras portas usam
    (`downloadParaTranscrever`), e ela só é feita quando `disponivel` é falso —
    numa máquina pronta ela não responderia nada que a frase use. Sem a lista, não
    se inventa número: fica *"ligue o recurso em Configurações"* (#86). Sem
    `disponivel`, também **não há botão**: um botão que não faria nada é pior que
    a frase que diz o que fazer.
158. **O conserto que vem junto com a porta nova: o campo de letra vazio deixou
    de poder apagar a letra que a transcrição acabou de gravar.**
    A oferta manda a fila para a MESMA revisão, e é lá que a letra é gravada. Só
    que a ficha continua aberta ATRÁS da revisão, com o campo de letra vazio — e
    "Salvar no arquivo" com o campo vazio REMOVE o frame USLT (`writer.rs`). Um
    clique de hábito destruiria o trabalho de minutos que o programa acabou de
    fazer. O caminho já existia (bastava deixar o editor aberto e curar pela
    tela de Configurações), mas esta versão o põe a um clique de distância.
    O campo é preenchido **só quando está vazio**. Nada digitado é sobrescrito: a
    pessoa pode ter corrigido o título e começado a escrever a letra à mão antes
    de mandar transcrever, e trocar um estrago por outro não é conserto. Vazio é
    exatamente o caso em que não há o que perder — e o único em que o arquivo pode
    ter ganhado letra sem ela.
    **Fechar o editor ao disparar a transcrição foi recusado**: descartaria em
    silêncio a correção de nome que ela pode ter acabado de digitar.
159. **O motivo do bloqueio dos botões da ficha passou a dizer QUAL trabalho está
    rodando.**
    O `loteRodando` do editor sempre foi `scanning || scanInFlight`, e a etapa 5
    também segura o `scanInFlight` — então os dois botões já paravam durante a
    transcrição, com uma frase na tela dizendo *"A busca desta pasta está
    rodando"*, que naquele momento era falsa. Texto que mente sobre o próprio
    produto é defeito (#100), e este ficou alcançável em um clique: é exatamente
    onde fica quem manda transcrever daqui e volta da revisão. Agora a frase da
    etapa 5 é *"As letras estão sendo escritas — espere elas terminarem para o
    computador não fazer dois trabalhos pesados ao mesmo tempo."*
160. **Fechar a revisão com linhas que FALHARAM AO GRAVAR passou a avisar.**
    Relato de campo, verbatim, sobre uma revisão em que músicas recusaram a
    gravação: *"não sei quais são as duas outras músicas… pq fechei a tela em
    seguida"*.
    É a MESMA família do defeito que a V10.6 consertou — a lista de que a pessoa
    precisa para agir depois evapora ao fechar a caixa — e é **pior que a oferta
    de transcrição**: para a oferta existe uma porta permanente em Configurações,
    e para as falhas não existe nenhuma.
    A frase, na régua da #100: *"2 músicas não puderam ser gravadas no arquivo.
    Esta lista não fica guardada: para vê-la de novo, repita a busca desta
    pasta."*
    Ela abre com o **mesmo vocabulário do cabeçalho do grupo** que descreve
    (`tituloDoGrupo("nao-gravadas")`, #139): quem acabou de ler aquela frase na
    tela tem de reconhecê-la no aviso, ou vai contar duas coisas diferentes. A
    segunda frase diz o que a da oferta não precisa dizer — que a lista **não**
    fica guardada. Prometer que ela volta seria mentira; calar seria repetir o
    defeito com um toast por cima. E o caminho que ela oferece é o único honesto
    (#144a): a linha que falhou continua sem "tentar de novo", porque o motivo é
    quase sempre de fora do aplicativo.
    **Informativo, tom `warning`, e não uma confirmação** — o mesmo desenho da
    #137, e não um quarto tom de toast.
    O gatilho é o `applyErrors`, e não o `p.error`: falha de CONSULTA não é
    notícia nova ali (não havia proposta, e repetir o clique não muda nada —
    #140), enquanto a falha de GRAVAÇÃO é consequência direta do clique que a
    pessoa acabou de dar.
161. **Dois avisos numa tela só, não — e quem vence é a falha de gravação.**
    As duas condições valem juntas no caso mais comum de todos: a varredura
    trouxe propostas, a pessoa aplicou, algumas recusaram, e ainda sobraram
    músicas sem letra. **Empilhar dois toasts é ensinar a fechar toast sem ler**,
    que é o mesmo argumento pelo qual a #137 recusou a confirmação bloqueante.
    Juntar as duas frases numa só estouraria a régua da #100 e misturaria dois
    assuntos que a pessoa resolve em lugares diferentes.
    A falha vence por um critério só: **ela é a única informação que some de
    verdade**. A oferta de transcrição continua inteira no bloco permanente de
    Configurações (V10.6); a lista das que não gravaram não continua em lugar
    nenhum.
162. **O que NÃO se fez, e fica escrito.**
    **(a) Nenhuma porta permanente para as falhas de gravação.** Guardar a lista
    entre sessões é outra decisão — precisaria decidir onde ela mora, quando
    envelhece e o que fazer com o arquivo que mudou desde então. O escopo desta
    rodada é avisar que ela sai da tela.
    **(b) A linha que falhou continua sem "tentar de novo"** — a #144(a) e a
    #152(c) valem inteiras.
    **(c) A ficha não ganhou bloco permanente da etapa 5**, e o motivo está na
    #154(a): antes do clique não há pergunta a responder ali.
    **(d) A oferta da ficha não é reperguntada ao backend depois de nada.** Ela é
    a resposta de UM instante — o do fim daquela busca —, e a ficha não é uma tela
    permanente. Quem quer o fato de agora tem o bloco de Configurações.
    **(e) O `aviso` da gravação continua sem chegar ao editor** (#152b): esta
    rodada não mexeu no retorno do `writeTags`.

## V10.10 — o botão que não cobra o funil antes, e o "sem conexão" que mentia

163. **A ficha de UMA música ganhou um botão que dispara a etapa 5 direto, e o
    custo está escrito nele.**
    Pedido do dono do produto, verbatim: *"No caso específico de mexer música
    por música quero um botão separado pra fazer transcrição. Pra não precisar
    rodar todo o fluxo pra depois só poder transcrever. Mas só nessa tela de
    música individual."*
    A V10.9 (#153) pôs a etapa 5 na ficha pendurada no desfecho da busca: ela só
    aparecia **depois** de "Buscar dados na internet" e só quando as quatro
    etapas não achavam letra. A premissa da #154(a) era que, naquele segundo, a
    pergunta é se a internet tem esta música. **O uso desmentiu a premissa**: com
    3% de cobertura medida, quem abre uma ficha deste acervo em geral JÁ SABE que
    a internet não tem — e o preço de estar errado era o funil inteiro, segundos
    de rede e uma leitura de impressão digital, antes de poder transcrever.
    **A escolha às cegas que a V8 recusou continua recusada, e é por isso que o
    tempo está no RÓTULO.** Aquilo eram dois botões dizendo "buscar na internet",
    indistinguíveis para quem não sabe o que é LRCLIB. Aqui os dois dizem coisas
    diferentes e cada um traz o próprio custo: *"Buscar dados na internet"*
    (segundos, e a dica lista as etapas) e *"Escrever a letra ouvindo o áudio
    (cerca de 4 minutos — pode levar mais nesta máquina)"*. O custo no rótulo é o
    que transforma a escolha em informada, e é o mesmo motivo pelo qual o tamanho
    vai no botão do download (`rotuloBaixarAcessorio`): é a última coisa lida
    antes do clique.
    **A procedência do número é a das outras portas** (#86 e #112): só medição
    desta máquina autoriza *"(cerca de 4 minutos neste computador)"*. O tempo e a
    ressalva saíram de UMA função (`tempoDaTranscricao`, extraída da
    `fraseDoTempoDaTranscricao`) — duas maneiras de dizer o mesmo número são duas
    telas que amanhã divergem sobre a mesma medição (#80 aplicada a texto), e
    aqui as duas cabem na MESMA tela, porque a pergunta do fim de uma varredura
    e a ficha convivem.
    **Nenhum segundo caminho**: `transcricao_pendentes_da_musica(song_id)` e
    `startTranscricao(pendentes.musicas)`, como na V10.9 — mesma barra, mesmo
    cancelamento, mesma revisão, e a fila continua vindo da PORTA e não de um
    `[song.id]` montado na tela (#155). Nada mudou no Rust para este conserto.
164. **A convivência dos dois botões, resolvida: não há dois.** O "Começar
    agora" da ficha SAIU, e o bloco da oferta ficou só com a metade que não cabe
    num botão.
    Depois de uma busca sem letra, a V10.9 desenhava *"Esta música continua sem
    letra. Escrever a letra ouvindo o áudio leva cerca de 4 minutos…"* com um
    botão "Começar agora". Com o botão permanente na barra de ações, isso seriam
    **dois botões para a mesma ação na mesma tela** — a duplicação que a V8
    removeu. As três alternativas foram pesadas:
    **(a) esconder o botão direto enquanto a oferta estiver na tela** — a
    affordance mudaria de lugar bem no momento em que a pessoa vai usá-la;
    **(b) manter a frase da oferta sem o botão** — ela repetiria, em prosa, o que
    o rótulo do botão já diz três centímetros abaixo, e a régua da #100 é
    explícita: o resto da tela só existe se responder uma pergunta daquele
    momento;
    **(c) a oferta com acessórios prontos deixa de existir** — o que ficou.
    O que se perde é a abertura *"Esta música continua sem letra."*, e ela não
    faz falta: quem acabou de ler o `SEM_RESULTADO_INDIVIDUAL` ("procuramos e não
    achamos nada novo para esta música") está olhando um campo de letra vazio com
    o botão logo abaixo.
    **O bloco sobrevive para quem NÃO pode transcrever nesta máquina**, e só. Ele
    não é um clique daqui — é um download de 1,4 GB, em outra tela —, então não
    cabe num botão, e a #157 já decidiu que sem `disponivel` **não há botão**: um
    botão que não faria nada é pior que a frase que diz o que fazer. A frase é a
    mesma, letra por letra (`fraseDoDownloadDaTranscricao`), e o
    `textoDaOfertaDestaMusica` encolheu para ela: passou a receber só o
    `DownloadPendente`. Com isso os dois desenhos são **mutuamente exclusivos por
    construção** — onde há botão não há bloco, e vice-versa.
165. **O botão é PERMANENTE; a frase continua saindo só depois da busca. A
    assimetria é de propósito.**
    A #154(a) recusou um bloco permanente da etapa 5 na ficha, e a #162(c)
    registrou isso. Esta rodada não desfaz o argumento: **um botão não é um
    parágrafo**. Ele ocupa uma linha na barra que já existe, ao lado do outro
    botão de trabalho, e é lido como o que é — a segunda coisa que se pode mandar
    o programa fazer por aquele arquivo. Um parágrafo permanente dentro de um
    formulário cheio de campos continua sendo o que a #100 proíbe.
    A regra que separa os dois: **o botão é uma AÇÃO que esta máquina executa; a
    frase manda a pessoa para outra tela**, e faz sentido no segundo em que a
    busca acaba de deixar a música sem saída. Por isso a frase espera a busca, e
    o botão não.
166. **O que o botão descreve é o ARQUIVO e o FORMULÁRIO — nunca o resultado de
    uma busca.** Ele não some quando a busca traz letra.
    A #154(b) tinha essa regra ("achou letra, não oferece"), e ela existia porque
    a oferta INTEIRA era um desfecho da busca. Agora o botão é permanente, e um
    botão que desaparece porque uma sugestão apareceu na tela é um botão que a
    pessoa vai procurar e não achar. **Proposta não é fato**: nada foi gravado, e
    a música continua sem letra até alguém clicar em "Usar estes dados". O medo
    da #154(b) — cobrar minutos de CPU por algo que um clique resolve — está
    respondido pelo custo estar no rótulo: quem lê "cerca de 4 minutos" ao lado
    de uma letra encontrada decide com o preço à vista.
    **Some, sim, quando a letra ENTRA no campo** — aí a música deixou de estar
    sem letra, e é essa a mudança que importa. As duas condições LOCAIS
    (`podeTranscreverEstaMusica`) são as mesmas da V10.9 e não duplicam regra do
    backend: descrevem o FORMULÁRIO, que é mais atual que o banco. Quem acabou de
    marcar "esta música é instrumental" não pode receber uma oferta de escrever a
    letra ouvindo o áudio, e é a mesma razão do `SEM_RESULTADO_INSTRUMENTAL`.
167. **Música que JÁ TEM LETRA não ganha o botão — e quem decide isso continua
    sendo o backend.**
    A porta devolve fila VAZIA para ela (`a_etapa_5_tem_o_que_fazer`), e a ficha
    não desenha nada. Não se abriu exceção, e o motivo não é economia:
    **(a) a etapa 5 produziria uma SUBSTITUIÇÃO**, que o `apply` só grava com
    consentimento explícito (#79). São minutos de CPU para chegar a uma caixa de
    marcação que a pessoa não tinha como prever ao clicar — o oposto exato de "o
    botão diz o seu custo";
    **(b) o #81 é sobre a CONSULTA.** "Quem clicou quer tudo que o produto sabe
    fazer por aquele arquivo" foi decidido sobre segundos de rede pedindo uma
    segunda opinião. Minutos de CPU produzindo uma letra de máquina, contra uma
    letra que pode ter sido corrigida à mão, é outra conversa — e a #71 diz que
    trabalho humano não é refeito por rotina nenhuma;
    **(c) o formulário MOSTRA a letra**, editável, ali mesmo. Quem quer refazê-la
    tem o campo; quem quer a transcrição sobre um arquivo já cheio tem o caminho
    de sempre, que é decidir isso conscientemente e não por um botão a um clique
    de distância;
    **(d) reescrever o portão na tela seria a #80 pela enésima vez.** A regra de
    quem a etapa 5 transcreve mora numa função só, no Rust, e as três portas a
    consultam. Um `[song.id]` montado no componente seria a tela decidindo o que
    a etapa 5 transcreve (#155), e a fila chegaria ao `transcricao_scan` para
    voltar como linha de erro ("já tem letra").
168. **"Sem conexão" mentia por omissão, e a frase passou a ser dita só com
    evidência.**
    Relato de campo: o dono clicou em "Buscar dados na internet" numa música e
    recebeu **"sem conexão"** em vermelho, com a internet funcionando
    perfeitamente — ele tinha acabado de baixar 1,4 GB no mesmo aplicativo.
    A causa: em `commands::funil_fetcher`, o ramo de **transporte** (DNS que não
    resolveu, os 10 s esgotados, conexão recusada) devolvia `"sem conexão"` para
    qualquer servidor mudo. Isso não é "sua internet caiu": é "este servidor não
    respondeu". A rodada da V9 já tinha separado o caso em que o servidor
    **responde** com erro (`mensagem_de_status`, com frase distinta para 429, 500
    e chave recusada); ficou de fora exatamente o caso em que ele **não
    responde** — e é o mais comum de todos.
    **A diferença é conferível, e é isso que a torna afirmável.** O funil fala
    com até TRÊS hosts (AcoustID, LRCLIB, lyrics.ovh), de provedores diferentes.
    Se outro respondeu na mesma varredura, a acusação contra a internet da pessoa
    é comprovadamente falsa.
    Cada destino passou a falar de si, como no `mensagem_de_status`:
    *"o reconhecimento pelo som não respondeu"*, *"o site de letras não
    respondeu"*, *"o site de letras sem cadastro não respondeu"*. São constantes
    dos próprios módulos (`fingerprint`, `lyrics_fetch`, `lyrics_ovh`), ao lado
    das que já existiam, e continuam sendo TEXTO FIXO sem interpolação — é assim
    que a garantia de a chave nunca vazar numa mensagem se sustenta.
    **A evidência de rede caída: duas fontes DIFERENTES mudas, e nenhuma
    respondendo** (`EstadoDaVarredura::rede_parece_caida`). Uma só não basta, e é
    esse o conserto — ver a #169. Duas bastam porque são hosts independentes: os
    dois calados ao mesmo tempo, com nada mais passando, é a melhor evidência que
    este programa consegue ter sem inventar um teste de rede próprio, que seria
    um quarto endereço num produto cujo invariável é que nada do acervo sai da
    máquina. **Responder é chegar uma resposta HTTP, inclusive uma de erro**: 429,
    500 e chave recusada são servidores vivos, e servidor vivo prova que a
    internet desta máquina funciona.
    Com evidência, a frase é *"a internet parece estar fora do ar: nenhum site
    respondeu"*. **A segunda metade é a evidência, e está no texto de propósito**:
    é o que permite a quem lê discordar do programa. Quem está com a internet boa
    e lê "nenhum site respondeu" sabe procurar do lado de fora — um bloqueio do
    antivírus, um portal de wi-fi — em vez de reiniciar o roteador à toa. O
    "parece" fica porque a certeza não existe.
    **Quem troca a frase é a varredura, não a etapa**: uma etapa só sabe do
    próprio host. O `funil_fetcher` produz o "não respondeu"; o
    `EstadoDaVarredura::frase_do_erro` o promove a "a internet parece estar fora
    do ar" quando a evidência já está formada. Há teste no `commands` conferindo
    que **toda** frase que o `mensagem_de_transporte` produz é reconhecida pelo
    `enrich::conta_como_servidor_mudo` — uma quarta fonte que entre num lado e
    não no outro não quebraria nada visível, só deixaria de contar como
    evidência, e o modo de falha silencioso é o que o teste torna barulhento.
169. **O que dói mais: o funil ABORTAVA. Agora o aborto depende de evidência de
    rede caída, e não de um erro qualquer.**
    Em `enrich.rs`, logo depois da etapa 2, `if erro.is_some() { return ... }`,
    com o comentário *"Rede caída derruba TODAS as fontes: insistir só gastaria o
    tempo de quem está esperando."* **O argumento vale se a rede caiu.** Para um
    servidor só sem responder ele não vale: o LRCLIB provavelmente responderia. No
    caso relatado, as etapas 3 e 4 muito provavelmente nunca foram consultadas, e
    a tela disse "sem conexão" — que a pessoa leu como "a internet não tem a
    letra desta música". **Duas etapas puladas em silêncio.**
    E não era só rede: **o `fpcalc` falha em três de cada quatro arquivos do
    acervo real** (é a medição da QA A2, com o binário de verdade nas fixtures do
    projeto). Faixa curta, gravação silenciosa, MP3 danificado — tudo isso caía no
    mesmo `erro.is_some()` e cancelava as duas etapas de LETRA, que são as que
    resolvem a música. Uma falha de acessório local não diz nada sobre o LRCLIB.
    **A intenção original está preservada**: `if estado.rede_parece_caida()`
    continua devolvendo cedo, e agora sem depender do erro desta música — uma
    varredura que já provou que a rede caiu não gasta mais consulta nenhuma,
    mesmo numa música que ainda não falhou em nada. **A evidência custa as
    consultas de UMA música**: dois hosts mudos na primeira, e nada da segunda em
    diante. A pausa de cortesia continua antes de cada consulta que acontece.
    **A linha da música pulada sai COM MOTIVO, sempre.** Proposta sem erro e sem
    mudança é descartada como no-op, e a música sumiria da revisão em silêncio —
    exatamente o que a #47 existe para impedir. Ela recebe a frase da rede caída,
    que é o motivo verdadeiro: não foi consultada porque nada estava respondendo.
    **Os vereditos continuam desligando o que já desligavam**: `ERRO_CHAVE_RECUSADA`
    e `ERRO_FPCALC_NAO_EXECUTA` são afirmações sobre a VARREDURA e continuam
    desligando a etapa 2 (com a contagem das músicas que ficaram sem ser
    perguntadas, QA A2). O que mudou é que eles não abortam mais as etapas 3 e 4.
170. **O erro virou DOIS, e a linha diz o da última etapa que tentou.**
    Enquanto um erro qualquer abortava o funil, um `erro` só bastava: nada rodava
    depois dele. Com as etapas seguindo, um só faria duas coisas erradas e
    silenciosas — o `sem_letra_do_lrclib` pularia a etapa 4 por causa de uma falha
    do SOM, e o `if let (None, Some(b), Some(conf))` jogaria fora uma letra que o
    LRCLIB acabou de trazer porque a etapa 2 falhou antes. São
    `erro_do_som` e `erro_da_letra`, e a linha recebe `erro_da_letra.or(erro_do_som)`.
    **A da letra vence porque é a que explica o desfecho que a pessoa está
    olhando**: ela mandou buscar atrás de uma letra, e é a última etapa que
    tentou trazê-la que diz por que não veio. Sem nenhuma delas sobra a do som,
    que explica o NOME e continua sendo notícia. Achando letra, não há erro na
    linha — a música ganhou o que foi buscar.
    **O `sem_letra_do_lrclib` virou `confianca.is_none()`**, sem o erro: "o
    LRCLIB não trouxe letra", e nada mais. O comentário da etapa 4 já dizia, na
    direção contrária, que a queda de um serviço não cancela o outro; a
    condição fazia exatamente isso.
171. **O que NÃO se fez, e fica escrito.**
    **(a) O botão direto não entrou na varredura nem em Configurações.** O pedido
    é explícito ("só nessa tela de música individual"), e as outras duas portas
    não têm o problema: a de Configurações é permanente e a do fim da varredura
    já acontece depois do trabalho.
    **(b) A ficha continua sem reperguntar a porta depois de nada** (#162d). A
    resposta descreve o ARQUIVO, e o que muda no formulário é conferido na hora de
    desenhar. Abrir a ficha de novo faz a pergunta de novo.
    **(c) O "sem conexão" do `acessorio_fetcher` (download) ficou como está.** Ele
    fala com UM host, e não há segunda fonte para comparar: a evidência que o
    funil tem não existe ali. Trocar a frase por "o servidor de downloads não
    respondeu" seria uma melhora, e é uma rodada própria — o texto daquela tela
    tem cartão, botão e barra de progresso conversando entre si.
    **(d) A etapa 2 não passou a ser tentada de novo depois de um host mudo.**
    Insistir no mesmo host é a única coisa que a evidência já diz não valer a
    pena, e transformaria uma varredura de 150 músicas em 150 novos tempos
    esgotados de 10 s.
    **(e) Não se inventou um teste de rede próprio** (um "ping" a um quarto
    endereço) para decidir se a internet caiu. Seria um destino a mais na lista
    fechada do `funil_fetcher`, para responder uma pergunta que as três fontes já
    respondem entre si.

## V10.11 — os três pedidos dos beta testers (teste em campo da v0.10.4/v0.10.6)

172. **Tema é o vocabulário da própria pessoa. O limite foi RECUSADO, e o
    problema é de layout.**
    Os dois beta testers, os primeiros humanos a usar o produto fora do dono,
    sugeriram limitar a **10 temas por música**. O que eles estavam vendo era
    real: uma música com vinte temas empurra a linha da lista e o cabeçalho da
    ficha para fora do que dá para ler.
    **O dono recusou o limite**, e o motivo entra aqui porque ele vale para
    todo teto que este produto for tentado a criar: **tema é o vocabulário de
    quem cura o acervo**, e são quarenta pessoas curando cada uma o seu. Não
    sabemos como cada uma organiza a cabeça dela — a que separa por tempo
    litúrgico, a que separa por instrumento, a que separa por quem cantou.
    Um teto rígido não chega quando alguém está calmo e sobrando: ele chega no
    décimo primeiro tema, no meio de uma sessão de catalogação, **e não há a
    quem perguntar por que o programa parou de aceitar**. A mensagem que ele
    exibiria seria a única explicação que aquela pessoa receberia na vida, e
    ela diria "não" a uma coisa que não faz mal a ninguém.
    O que dói é a TELA, e é a tela que se conserta. Nenhum tema deixa de ser
    aceito, nenhum deixa de ser gravado, nenhum deixa de ser buscável.
173. **Aparecem 3 chips antes do "+N", e o 3 foi MEDIDO — não escolhido.**
    A régua é a do `--faixa-detalhes` do `index.css`: medir no Chromium, com o
    componente no tamanho real que ele tem na tela.
    O container mais estreito em que um chip de tema aparece é a coluna de
    texto do painel de letra:
    ```
      380 px  o painel (`w-[380px]`, LyricsPanel)
     −  32 px o `p-4` dos dois lados
     −   8 px o `gap-2` até os botões
     − 100 px os botões "Editar" e "Aa"
     = 240 px
    ```
    Chip em 12px, medido sobre o vocabulário que este acervo usa: **28 px** o
    mais curto ("fé"), **107 px** o mais longo ("ação de graças"), **mediana
    68 px**. Com o `gap-1.5` de 6 px, `240 ÷ 74 = 3,2`.
    **Daí o 3: é quantos chips de largura mediana cabem numa LINHA do
    container mais estreito.** Somado o "+N" (34 px), o bloco dobrado ocupa no
    máximo DUAS linhas — conferido nas quatro composições possíveis de
    vocabulário (só curtos, só longos, todos medianos, misto). Com 4 o
    vocabulário mediano ainda cabe em duas linhas, mas o só-longos vai a três;
    com 3 nenhuma composição passa de duas.
    **A régua é UMA para as três telas** — a linha da lista, o cabeçalho da
    ficha e o formulário de edição —, embora o formulário seja mais largo
    (348 px, sem botões ao lado, mas dividindo a linha com o campo "Adicionar
    tema"). Duas réguas seriam duas telas dobrando em pontos diferentes pela
    mesma lista, e quem contasse os chips de uma na outra acharia que perdeu
    tema. É a #80 aplicada a layout.
    **Dobrar UM chip só não economiza nada, e por isso a régua tem folga de
    um: nada é dobrado até 4 temas.** O "+1" tem quase a largura de um chip
    mediano — não tira uma linha da tela e cobra um clique por nada. Quase toda
    música deste acervo tem de um a quatro temas, e para elas **nada muda**.
    O número está fixado em teste com o cálculo escrito ao lado: mudá-lo passa
    a exigir refazer a medição, em vez de acontecer por gosto.
174. **Na ficha o "+N" ABRE; na linha da lista ele INFORMA. A assimetria é a
    virtualização, e não uma inconsistência.**
    A altura da linha da lista é **calculada, não medida**
    (`SongList.rowHeight`, `estimateSize`): expandir chips ali empurraria o
    conteúdo por cima da linha de baixo. Um "+N" que expande onde não pode
    expandir seria um botão que estraga a tela de quem o aperta.
    O que ele faz lá é o que dá para fazer com honestidade: dizer quantos
    faltam **e onde vê-los** — *"Mais 9 temas — abra a música para ver
    todos."*. Marca que só informa que há mais, sem dizer onde, é um beco.
    Na ficha e no formulário ele é botão: *"+9"*, com o nome acessível
    *"Mostrar os outros 9 temas"*; aberto, aparece **"mostrar menos"** ao lado.
    O que abriu fecha no mesmo lugar — quem clicou no "+9" procura ali o
    caminho de volta —, e é palavra e não um "−", porque o sinal sozinho não
    diz o que ele encolhe.
    O "+N" é **cinza**, e não o verde-água dos chips: ele não é um tema, e
    pintá-lo como os outros faria alguém procurar uma música com o tema "+9" —
    ou, no formulário, tentar removê-lo.
175. **O chip que a pessoa acabou de criar NÃO nasce escondido.**
    Com a lista dobrada, o tema novo entra no fim — atrás do "+N". Quem digita
    e não vê nada acontecer conclui que não funcionou e digita de novo, e num
    produto sem suporte essa conclusão não tem quem a desminta.
    Confirmar um tema abre a lista, e é o **único** gesto que a abre sozinho:
    o resto é clique explícito. Trocar de música fecha de novo — a pergunta
    "quais são os temas desta aqui?" é feita a cada ficha, e um estado herdado
    responderia a da anterior.
    O dobramento é de TELA, e nunca de dado: `handleSave` grava a lista
    inteira, aberta ou fechada, e há teste dizendo isso.
176. **Enter no campo de tema confirma o chip E GRAVA A FICHA INTEIRA, numa
    gravação só.**
    Relato dos beta testers: *a pessoa digita um tema e sai usando o
    aplicativo, sem clicar em "Salvar no arquivo" — e perde o que digitou.* O
    campo parece um lugar onde as coisas ficam guardadas, e não fica: até aqui
    Enter só transformava o texto em chip, e chip é estado de formulário.
    **A alternativa "Enter salva só o tema" foi discutida e RECUSADA pelo
    dono**, e o motivo entra aqui porque é uma régua e não um caso: **meia tela
    salvando sozinha é pior que nenhuma**. A pessoa corrige o título, digita um
    tema, aperta Enter e fecha — sairia com o tema gravado e o título perdido,
    e nada na tela teria dito que só metade foi. Salvar tudo mantém a ficha
    coerente com o arquivo, e continua sendo **uma tecla explícita**, não
    gravação invisível.
    **É o MESMO `handleSave` do botão, chamado inteiro** — e não uma cópia
    dele. Quatro coisas vêm de graça por isso, e cada uma seria um defeito se
    tivesse de ser reescrita: o tema pendente é confirmado ANTES de a gravação
    ser montada (o chip entra nela, e não o estado de antes do Enter); a música
    em edição é PAUSADA antes de o arquivo ser tocado (no Windows ele pode
    estar em uso — regra da V4); a recusa do arquivo mostra o MESMO toast de
    erro de sempre, com a ficha aberta e nada perdido; e o título vazio recusa
    a gravação com a mesma mensagem, sem perder o tema digitado. Um segundo
    caminho seria um segundo lugar onde essas quatro divergem (#80).
    **`busy` trava o Enter como trava o botão**: uma gravação em curso já está
    fazendo o que ele pediria.
177. **Enter com o campo de tema VAZIO salva do mesmo jeito.**
    Não há chip a confirmar, e a tentação é não fazer nada. Ela foi recusada:
    **uma regra com exceção invisível é a regra que ninguém aprende.** "Enter
    aqui grava a ficha" cabe na cabeça; "Enter grava a ficha, mas só se você
    tiver digitado alguma coisa" é o que faz alguém apertar, não ver nada
    acontecer e não ter a quem perguntar por quê.
    E o que acontece é exatamente o que o botão ao lado faz — **o botão também
    não pergunta se algo mudou**. A gravação continua sendo a mesma do produto
    inteiro: o áudio é conferido e nada de dado existente é apagado (#148a).
178. **A frase do Enter aparece no segundo em que a pergunta existe, e some
    depois.**
    *"Enter confirma este tema e salva a ficha inteira no arquivo."* — 60
    caracteres, abaixo da régua da #100, e ela diz as DUAS coisas que
    acontecem, na ordem em que acontecem.
    Ela é desenhada **só enquanto há texto no campo de tema**, que é quando a
    pergunta "e agora, o que faço com isto?" existe. Uma linha permanente
    debaixo do campo seria a prosa que ninguém lê depois da segunda vez — o que
    a #100 proíbe.
    Um `title=` foi considerado e não bastou: **Enter que GRAVA NO ARQUIVO é
    surpreendente demais para depender de um mouse parado em cima do campo.**
    O deslocamento que a linha causa é absorvido pelo campo de letra (`flex-1`)
    — os botões não se mexem, e ninguém erra o clique por causa dela.
179. **O botão de transcrever aparece TAMBÉM na música que já tem letra. A
    #167 está revertida, e o caso concreto é o argumento.**
    Relato de campo: um beta tester abriu uma música cuja letra terminava em
    **`[MÚSICA]`** — a marca que a #122 e a #129 documentam como o modelo
    desistindo de transcrever trecho cantado. Era letra de transcrição,
    imperfeita, com estrofe faltando, e ele queria exatamente **refazê-la**. O
    botão não estava lá.
    **O caso em que a pessoa mais quer transcrever de novo é justamente aquele
    em que já existe letra ruim** — e era o único em que o produto escondia o
    botão. A #167 tinha três argumentos, e o uso respondeu os três:
    **(a)** *"produziria uma SUBSTITUIÇÃO, e são minutos de CPU para chegar a
    uma caixa de marcação que a pessoa não tinha como prever ao clicar"* — ela
    tem como prever: o custo está no RÓTULO desde a V10.10 ("cerca de 4
    minutos"), e agora a dica diz, antes do clique, o que acontece com a letra
    atual. O que a #167 descreveu era um botão mudo; este não é.
    **(b)** *"o #81 é sobre a CONSULTA; minutos de CPU contra uma letra
    corrigida à mão é outra conversa"* — é outra conversa, e quem a tem é quem
    está olhando o arquivo. Refazer **não virou rotina**: nenhuma varredura
    chega aqui (ver #181), e o clique é um, por música, com o preço à vista.
    **(c)** *"o formulário MOSTRA a letra, editável, ali mesmo"* — mostra, e é
    ali que o beta tester leu o `[MÚSICA]`. O campo resolve um erro de
    digitação; ele não devolve a estrofe que a máquina engoliu.
    **O que NÃO mudou é o que protege a letra**: o resultado vai para a MESMA
    revisão, a linha diz *"Já tem letra. Sem marcar abaixo, aplica só título e
    artista."*, e a caixa **"Substituir a letra atual"** chega desmarcada
    (#79). Sem o clique nela, o `apply` grava só os nomes — e o aviso do
    desfecho diz "1 música foi gravada, sem mudança no conteúdo". **Nada é
    sobrescrito sem clique**, e há teste no Rust, no mock e no E2E dizendo isso.
180. **O rótulo diz "de novo", e a dica diz que a letra atual é PROPOSTA para
    substituição — não apagada.**
    São os dois textos lidos antes do clique, e cada um responde uma pergunta
    diferente.
    O RÓTULO responde *o que este botão faz, e quanto custa*:
    *"Escrever a letra **de novo**, ouvindo o áudio (cerca de 4 minutos — pode
    levar mais nesta máquina)"*. O "de novo" é o que separa este clique do
    outro: quem lê "escrever a letra" com uma letra na tela para para entender
    o que o programa acha que está acontecendo. O tempo e a ressalva de
    procedência continuam vindo da mesma função das outras portas
    (`tempoDaTranscricao`, #163).
    A DICA responde *vou perder o que está aqui?*, que é o medo daquele
    segundo: *"Escreve a letra ouvindo o áudio desta música, sem usar a
    internet. **A letra que está aqui não é apagada: a nova entra como proposta
    de substituição, e você decide antes de gravar.**"* Sem letra, ela continua
    sendo a de sempre — *"…Nada é gravado sem você conferir."* —, porque
    inventar uma ressalva para um caso que não existe é ruído.
    Isso **não substitui** o consentimento da revisão; ele existe e continua
    inteiro. O que a dica resolve é que o consentimento só aparece MINUTOS
    depois, tarde demais para tranquilizar quem está com o dedo no botão.
    **A frase não foi para um parágrafo na ficha.** Um bloco permanente dentro
    de um formulário é o que a #154(a) recusou e a #165 confirmou, e a régua
    continua a mesma: o botão é uma ação, o parágrafo é prosa.
    **Quem decide se o botão EXISTE deixou de ser o campo de letra**, e passou
    a ser só a caixa "esta música é instrumental" (que descreve o FORMULÁRIO, e
    é mais atual que o banco — #166). O campo de letra agora decide o que o
    botão DIZ. A #166 dizia "some quando a letra entra no campo"; ela morre com
    a #167, e pelo mesmo motivo.
181. **A porta de UMA música ganhou portão próprio. As de LOTE não mudaram —
    e é isso que a #136 continua garantindo.**
    `a_etapa_5_tem_o_que_fazer` (lote) e
    `a_etapa_5_tem_o_que_fazer_nesta_musica` (ficha) diferem em **uma linha
    só**: música com letra passa na segunda. Instrumental continua fora das
    duas (a marca é escolha humana afirmando que não há voz no áudio, e
    transcrever contra ela é gastar minutos para desmentir quem ouviu — #71), e
    arquivo que sumiu do disco continua fora das duas (não é trabalho, é linha
    de erro — QA M3).
    **São duas regras porque são duas perguntas**: "o que vale a pena varrer" e
    "o que dá para fazer por ESTE arquivo". Não é a #80 sendo quebrada — é o
    contrário: cada uma mora numa função só, no Rust, e o `pendentes_entre`
    recebe o portão por PARÂMETRO, para a escolha ficar visível na chamada de
    cada porta. Um booleano `mesmo_com_letra` na assinatura diria o mesmo de um
    jeito que não se lê onde a decisão é tomada.
    **A tela não reescreveu portão nenhum**: a fila continua vindo da PORTA, e
    não de um `[song.id]` montado no componente (#155).
    A pergunta do fim da varredura e o bloco permanente de Configurações
    continuam pulando quem tem letra, com teste próprio para cada um: lá
    **ninguém pediu por aquela música em particular**, e transcrever em lote o
    que já tem letra seria a rotina refazendo trabalho humano que a #71 proíbe.
182. **A trava de "já tem letra" saiu do `transcricao_scan`, e a frase dela
    deixou de existir nos dois lados.**
    Ela recusava a fila com *"esta música já tem letra — apague a letra atual
    no editor se quiser escrevê-la de novo ouvindo o áudio"*, e existia
    enquanto **ninguém podia pedir isto legitimamente**. Com o botão da ficha,
    alguém pode — e ela passaria a gastar o clique de quem leu "cerca de 4
    minutos" no rótulo para devolver um "não" e uma instrução (apagar a letra à
    mão antes) que é exatamente o pedágio que a #102 existe para eliminar.
    **O que ela protegia continua no `apply`, que é onde o consentimento sempre
    morou de verdade** (#79). A trava era economia de CPU, não garantia de
    dado — e a economia não se perdeu: **ela virou o preço no rótulo**.
    A frase saiu do `enrich.rs` e do `mockBackend.ts` juntos (o par da #88):
    texto sem produtor é texto que mente sobre o produto na próxima leitura, e
    a #144(d)/#152(e) já registraram isso duas vezes.
    **Três testes mudaram de PROPÓSITO**, e cada um diz isso no próprio
    comentário: o que guardava as duas recusas do `transcricao_scan` guarda só
    a do instrumental; o que exigia fila vazia para música com letra na porta
    da ficha exige a fila COM ela; e o do mock que dizia "não transcreve quem
    já tem letra nem quem já é instrumental" passou a dizer "não transcreve
    quem já é instrumental, **e transcreve** quem já tem letra".
183. **O que NÃO se fez, e fica escrito.**
    **(a) O bloco de download da ficha continua exigindo o campo de letra
    vazio**, e não é exceção esquecida: a primeira frase dele é *"Esta música
    continua sem letra."*, e com o textarea cheio logo acima ela seria
    desmentida pela tela em volta — o defeito que a #100 chama de texto que
    mente sobre o próprio produto. Quem tem letra e não tem os 1,4 GB continua
    com o bloco permanente de Configurações (V10.6), que é a tela onde o
    download é um clique. Inventar uma segunda frase para um caso que só existe
    em máquina sem os acessórios seria vocabulário novo para uma pergunta já
    respondida.
    **(b) A ficha continua sem reperguntar a porta** (#162d, #171b). A resposta
    descreve o ARQUIVO, e o que muda no formulário é conferido na hora de
    desenhar. Depois de aplicar a letra refeita, o botão continua na tela — e
    agora isso está certo: ele vale para quem tem letra.
    **(c) O "+N" da linha da lista não virou botão**, e a razão é a #174. Fazer
    a linha crescer exigiria medir a altura em vez de calculá-la, e a lista é
    virtualizada para 2.000 músicas.
    **(d) Não se mexeu no que já estava dobrado por truncamento.** O chip
    continua com `max-w-32` (`max-w-40` no formulário) e reticências: tema
    longo demais para um chip é outro problema, e o `title` já o mostra
    inteiro.
    **(e) O `aviso` da gravação continua sem chegar ao editor** (#152b, #162e):
    esta rodada não mexeu no retorno do `writeTags`. O Enter herda o editor
    inteiro, inclusive essa dívida.
    **(f) Nenhum atalho novo foi criado.** Enter no campo de TEMA grava; Enter
    nos campos de título e artista continua não fazendo nada, e não passou a
    fazer. O relato foi sobre o campo de tema, que é o único cujo conteúdo
    parecia guardado e não estava — nos outros dois o que está digitado está à
    vista, e ninguém sai da tela achando que salvou.
