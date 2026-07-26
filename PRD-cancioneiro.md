# PRD — Cancioneiro (Player Offline com Busca por Letra)

## 1) Summary

Cancioneiro é um app desktop offline (Windows + macOS) para coordenadores de reuniões que precisam localizar músicas em acervos grandes (2.000+) lembrando apenas um trecho da letra, visualizar a letra antes de tocar, e reproduzir com playlist automática. A fonte da verdade é o próprio arquivo MP3: a letra vive embutida na tag ID3 (frame USLT), de modo que o arquivo carrega seus dados consigo ao ser copiado entre pessoas. O app é apenas uma casca de indexação, busca e reprodução — sem backend, sem contas, sem sincronização.

O V1 (MVP de hoje) é exclusivamente o player: aponta pastas locais, indexa título/artista/letra em SQLite FTS5, busca instantânea por trecho, exibe letra, toca e executa playlists. Inclui um script utilitário para embutir letra mocada em um MP3 de teste, permitindo teste real de ponta a ponta hoje em Windows e Mac.

- Assumption: o nome do produto é "Cancioneiro" (placeholder — trocável sem impacto técnico).
- Assumption: formato de áudio suportado no V1 é apenas MP3 (ID3v2.3/2.4). FLAC/M4A ficam para V2.
- Assumption: letra não sincronizada (USLT texto puro). Letra sincronizada (SYLT/LRC) fica para V2.
- Assumption: sem autenticação — app local, single-user por máquina (No auth).
- Assumption: idioma da UI é português brasileiro.
- Assumption: o app não modifica arquivos de áudio em nenhuma hipótese (somente leitura). Quem grava USLT é o script utilitário/ferramenta de curadoria.
- Assumption: interação de reprodução combina os dois modelos discutidos: duplo-clique toca (pedido do usuário) e há botão explícito "Tocar" + barra de espaço, para reduzir risco de reprodução acidental em reunião.
- Assumption: reindexação é manual (botão "Reindexar") + varredura automática na abertura do app. Watch de filesystem em tempo real fica para V2.

## 2) Tech Stack

Framework: Tauri 2 (Rust backend + WebView) — binários nativos Windows (.msi/.exe) e macOS (.dmg/.app)
Frontend: React 18 + TypeScript + Vite
Database: SQLite (bundled via rusqlite) com FTS5, tokenizer unicode61 `remove_diacritics 2` para busca sem acento
Auth: No auth
Styling: Tailwind CSS
Key libs:
- Rust: `lofty` (leitura de tags ID3/USLT), `rusqlite` (SQLite + FTS5), `walkdir` (varredura de pastas), `serde` (IPC)
- Frontend: `zustand` (estado global do player), `@tauri-apps/api` (invoke/IPC), elemento HTML5 `<audio>` para reprodução via asset protocol do Tauri (MP3 decodificado nativamente pelo WKWebView/WebView2 — sem engine de áudio em Rust)
- Script utilitário de mock: Python 3 + `mutagen` (grava USLT em MP3) — arquivo `tools/embed_lyrics.py`
Deployment: distribuição manual dos binários (GitHub Releases privado ou link direto). Sem auto-update no V1.
Testing: Vitest + Testing Library (frontend) e `cargo test` (Rust) — TDD obrigatório
Estratégia de testes:
- Testes unitários: normalização de busca, parser de query FTS, reducer/store do player, lógica de playlist (avanço, fim, remoção do item em reprodução), extração de USLT (Rust, com MP3s fixture)
- Testes de integração: comandos Tauri (scan → index → search) contra SQLite de teste em tempdir, com fixtures MP3 com e sem USLT
- Testes E2E: fluxos críticos via Playwright rodando o frontend em modo web com camada de IPC mockada (tauri-driver não suporta macOS; o E2E real em binário é smoke test manual documentado)
Cobertura mínima: 85% em services (Rust commands, indexer, search) e stores/hooks do frontend

## 3) User Roles

- Coordenador (único role): usa o app localmente. Aponta pastas, busca, visualiza letra, toca músicas, cria e executa playlists.

Permissions:
- Coordenador: acesso total às funções do app na própria máquina. Não há operações remotas nem multiusuário.

## 4) Data Model

Banco: arquivo `cancioneiro.db` no diretório de dados do app (`appDataDir`). Somente índice/estado local — a letra canônica vive no MP3; o banco é reconstruível a qualquer momento por reindexação.

Entity: Folder
- id: integer — primary, autoincrement
- path: string — unique, caminho absoluto da pasta observada
- created_at: datetime — default now
- last_scanned_at: datetime — nullable

Entity: Song
- id: integer — primary, autoincrement
- file_path: string — unique, caminho absoluto do MP3
- folder_id: integer — FK → Folder.id, on delete cascade
- title: string — de ID3 TIT2; fallback: nome do arquivo sem extensão
- artist: string — de ID3 TPE1; nullable
- album: string — de ID3 TALB; nullable
- duration_seconds: integer — nullable (extraído por lofty)
- has_lyrics: boolean — default false (true se USLT não-vazio)
- lyrics: string — texto do USLT; nullable
- file_mtime: integer — mtime do arquivo (epoch), usado para reindexação incremental
- file_size: integer — bytes, usado junto com mtime para detectar mudança
- indexed_at: datetime — default now

Entity: SongFts (tabela virtual FTS5)
- content: espelho de Song (title, artist, lyrics) via triggers de sincronização
- tokenizer: `unicode61 remove_diacritics 2` — busca ignora acentos e caixa

Entity: Playlist
- id: integer — primary, autoincrement
- name: string — not null
- created_at: datetime — default now
- updated_at: datetime — default now

Entity: PlaylistItem
- id: integer — primary, autoincrement
- playlist_id: integer — FK → Playlist.id, on delete cascade
- song_id: integer — FK → Song.id, on delete cascade
- position: integer — not null, ordem de reprodução (0-based)

Relationships:
- Folder has many Song
- Playlist has many PlaylistItem (ordered by position)
- PlaylistItem belongs to Song

Indexes: Song.file_path unique; Song.folder_id; PlaylistItem(playlist_id, position); SongFts para busca full-text

Regras de integridade:
- Música cujo arquivo sumiu no rescan: registro removido de Song; PlaylistItems correspondentes removidos em cascata (playlist "encolhe" e um aviso é exibido — ver Feature 6).
- Rescan incremental: arquivo com mesmo path + mtime + size não é relido (skip).

## 5) Core Features

Feature: F1 — Gerenciar Pastas de Música
- User Flow:
  1. No primeiro uso, o usuário vê tela vazia com CTA para adicionar pasta.
  2. Clica "Adicionar pasta", seleciona uma pasta no diálogo nativo do SO.
  3. O app varre a pasta recursivamente, indexa os MP3 e mostra progresso.
  4. Ao concluir, a biblioteca exibe as músicas. O usuário pode adicionar mais pastas ou remover pastas em Configurações.
  5. A cada abertura do app, um rescan incremental roda em background.
- UI Copy & Colors:
  - Empty state título: "Sua biblioteca está vazia" (text #111827)
  - Empty state subtítulo: "Adicione uma pasta com suas músicas para começar." (text #6B7280)
  - Button: "Adicionar pasta" (text #FFFFFF, background #0F766E)
  - Progresso: "Indexando… {n} de {total} arquivos" (text #6B7280) com barra (fill #0F766E, track #E5E7EB)
  - Toast sucesso: "{n} músicas indexadas." (text #065F46 on background #D1FAE5)
  - Configurações → lista de pastas com botão "Remover" (text #B91C1C) por item
  - Button em Configurações: "Reindexar tudo" (text #0F766E, border #0F766E, background transparente)
- Error & Empty States:
  - Se a pasta não contém nenhum MP3: toast "Nenhum MP3 encontrado nesta pasta." (text #92400E on background #FEF3C7). A pasta ainda é registrada.
  - Se a pasta deixou de existir no rescan: banner "A pasta {path} não foi encontrada. Verifique se o disco está conectado." (text #92400E on background #FEF3C7) com Button "Remover pasta" (#B91C1C) e Button "Tentar de novo" (#0F766E). Músicas dessa pasta ficam marcadas indisponíveis (cinza #9CA3AF), não são deletadas do índice até o usuário remover a pasta.
  - Se um MP3 individual falhar na leitura de tags: indexar com fallback (título = nome do arquivo, sem letra) e registrar em log local; nunca abortar a varredura inteira.
  - Se remover pasta: dialog de confirmação "Remover esta pasta da biblioteca? Os arquivos não serão apagados do disco." Buttons: "Cancelar" (text #374151) e "Remover" (text #FFFFFF, background #B91C1C).
- Acceptance Checks:
  - ✓ Adicionar pasta com 3 MP3s fixture resulta em 3 registros em Song com file_path corretos.
  - ✓ MP3 fixture com USLT preenchido gera Song.has_lyrics = true e Song.lyrics igual ao texto embutido (comparação exata, preservando quebras de linha).
  - ✓ MP3 fixture sem tags gera Song.title = nome do arquivo sem extensão e has_lyrics = false.
  - ✓ Segundo rescan sem mudanças nos arquivos não altera indexed_at de nenhuma Song (verifica skip incremental por mtime+size).
  - ✓ Alterar mtime de 1 arquivo e reindexar atualiza somente essa Song.
  - ✓ Remover pasta apaga suas Songs e PlaylistItems em cascata.
  - ✓ Varredura de pasta com arquivo .mp3 corrompido completa sem erro fatal e indexa os demais.

Feature: F2 — Busca por Letra, Título ou Artista
- User Flow:
  1. O usuário digita no campo de busca no topo (foco automático ao abrir o app; atalho "/" ou Ctrl/Cmd+K foca a busca de qualquer lugar).
  2. Resultados aparecem enquanto digita (debounce 150ms), ordenados por relevância (rank FTS5), buscando em título, artista e letra simultaneamente.
  3. Cada resultado mostra título, artista, e — quando o match foi na letra — um trecho da letra com o termo destacado.
  4. Busca ignora acentos e maiúsculas ("coraçao" encontra "coração"; "AMANHECER" encontra "amanhecer").
  5. Campo vazio volta a exibir a biblioteca completa (ordem alfabética por título).
- UI Copy & Colors:
  - Placeholder do campo: "Buscar por letra, título ou artista…" (text #9CA3AF, campo background #FFFFFF, border #D1D5DB, border em foco #0F766E)
  - Trecho de letra no resultado: texto #6B7280, termo destacado com background #FDE68A e text #78350F
  - Badge no resultado sem letra: "Sem letra" (text #6B7280, background #F3F4F6)
  - Contador: "{n} resultados" (text #6B7280)
- Error & Empty States:
  - Se nenhum resultado: "Nenhuma música encontrada para \"{termo}\"." (text #6B7280) + dica "Tente palavras diferentes do trecho que você lembra." (text #9CA3AF).
  - Se o termo contém apenas caracteres especiais/operadores FTS (ex: `"`, `*`, `-`): sanitizar a query (tratar como texto literal) — nunca exibir erro de sintaxe SQL/FTS ao usuário.
  - Se a biblioteca está vazia: exibir o empty state da F1 no lugar de resultados.
- Acceptance Checks:
  - ✓ Buscar trecho existente apenas na letra de 1 fixture retorna exatamente essa música em primeiro.
  - ✓ Busca "coracao" retorna música cuja letra contém "coração" (teste de remove_diacritics).
  - ✓ Busca com aspas e asteriscos no input não lança erro e retorna resultados tratando o termo como literal.
  - ✓ Busca em biblioteca de 2.000 músicas fixture responde em < 100ms (teste de integração com seed sintético).
  - ✓ Resultado com match na letra exibe snippet contendo o termo destacado.
  - ✓ Limpar o campo restaura a lista completa em ordem alfabética.

Feature: F3 — Visualização de Letra (clique único)
- User Flow:
  1. Um clique em qualquer música (na busca, biblioteca ou playlist) a seleciona e abre/atualiza o painel lateral direito com a letra completa.
  2. O painel tem cabeçalho com título e artista, e corpo rolável com a letra preservando quebras de linha.
  3. Botão "Ocultar letra" / "Mostrar letra" alterna a visibilidade do painel; o estado (aberto/fechado) persiste entre sessões.
  4. Botão "Aa" cicla o tamanho da fonte da letra entre 3 níveis (16/20/24px); persiste entre sessões.
- UI Copy & Colors:
  - Painel: background #FFFFFF, border-left #E5E7EB
  - Cabeçalho do painel: título (text #111827, 18px semi-bold), artista (text #6B7280, 14px)
  - Toggle: "Ocultar letra" / "Mostrar letra" (text #0F766E)
  - Botão fonte: "Aa" (text #374151)
- Error & Empty States:
  - Se a música não tem letra (has_lyrics = false): painel mostra "Esta música ainda não tem letra registrada." (text #6B7280) e subtexto "Use a ferramenta de curadoria para adicionar a letra ao arquivo." (text #9CA3AF).
  - Se nenhuma música está selecionada: painel mostra "Selecione uma música para ver a letra." (text #9CA3AF).
- Acceptance Checks:
  - ✓ Clique único em música com letra exibe a letra integral no painel com quebras de linha preservadas.
  - ✓ Clique único NÃO inicia reprodução.
  - ✓ Clique em música sem letra exibe a mensagem de ausência de letra.
  - ✓ Estado do toggle (oculto/visível) e nível de fonte persistem após fechar e reabrir o app.

Feature: F4 — Reprodução (duplo-clique, botão e teclado)
- User Flow:
  1. Duplo-clique em uma música inicia a reprodução imediatamente.
  2. Alternativa: com a música selecionada, clicar no botão "▶ Tocar" na barra do player ou pressionar barra de espaço.
  3. Barra do player (fixa no rodapé) mostra: capa genérica, título/artista, tempo decorrido/total, barra de progresso clicável (seek), botões anterior/play-pause/próximo, e controle de volume com slider (persiste entre sessões).
  4. Espaço = play/pause global (quando o foco não está no campo de busca). Setas ←/→ = seek −5s/+5s.
  5. Ao tocar uma música a partir da lista de busca/biblioteca fora de playlist, ao terminar a reprodução para (não avança sozinho).
- UI Copy & Colors:
  - Barra do player: background #111827, textos #F9FAFB, tempo #9CA3AF
  - Botão play: ícone ▶ (icon #111827, círculo background #FFFFFF); pause: ícone ⏸ mesmo estilo
  - Progresso: fill #14B8A6, track #374151
  - Música em reprodução na lista: título em text #0F766E com ícone ♪ animado
- Error & Empty States:
  - Se o arquivo não existe mais no play: toast "Arquivo não encontrado: {nome}. A música foi removida da biblioteca?" (text #991B1B on background #FEE2E2); reprodução não inicia; item fica cinza #9CA3AF.
  - Se o WebView falhar ao decodificar o áudio: toast "Não foi possível reproduzir este arquivo." (text #991B1B on background #FEE2E2) e log local do erro.
  - Se espaço for pressionado sem música selecionada nem em reprodução: nenhuma ação, sem erro.
- Acceptance Checks:
  - ✓ Duplo-clique inicia reprodução da música clicada em < 500ms (fixture local).
  - ✓ Espaço alterna play/pause quando há música carregada e o foco não está no input de busca.
  - ✓ Digitar espaço dentro do campo de busca insere espaço no texto e não pausa a música.
  - ✓ Seek pela barra de progresso reposiciona o áudio (currentTime muda para o ponto clicado ±1s).
  - ✓ Volume ajustado persiste após reiniciar o app.
  - ✓ Tocar arquivo deletado do disco exibe o toast de arquivo não encontrado e não trava o app.

Feature: F5 — Playlists com Reprodução Automática
- User Flow:
  1. O usuário clica "Nova playlist", digita o nome e confirma.
  2. Adiciona músicas via botão "+" que aparece ao passar o mouse sobre qualquer música (menu "Adicionar à playlist → {nome}"), ou arrastando a música para a playlist na sidebar.
  3. Abre a playlist na sidebar; vê os itens em ordem, reordena por drag-and-drop, remove itens pelo "×".
  4. Clica "▶ Tocar playlist" (ou duplo-clique em um item): reprodução começa e avança automaticamente para a próxima ao fim de cada música, até o fim da lista.
  5. Ao terminar a última, a reprodução para (sem repeat no V1). Botões anterior/próximo navegam dentro da playlist.
- UI Copy & Colors:
  - Sidebar seção: "PLAYLISTS" (text #6B7280, 12px, uppercase)
  - Button: "Nova playlist" (text #0F766E)
  - Dialog: título "Nova playlist", input placeholder "Nome da playlist", Buttons "Cancelar" (text #374151) e "Criar" (text #FFFFFF, background #0F766E)
  - Button no header da playlist: "▶ Tocar playlist" (text #FFFFFF, background #0F766E)
  - Item em reprodução: background #F0FDFA, título #0F766E
  - Menu de contexto: "Adicionar à playlist", "Remover da playlist" (text #374151; hover background #F3F4F6)
- Error & Empty States:
  - Playlist vazia: "Esta playlist está vazia. Adicione músicas pela busca ou biblioteca." (text #6B7280).
  - Se criar playlist com nome vazio: input com border #B91C1C e mensagem "Dê um nome à playlist." (text #B91C1C); botão "Criar" desabilitado (background #9CA3AF).
  - Se um item da playlist aponta para arquivo indisponível durante a reprodução automática: exibir toast "Pulando \"{título}\": arquivo não encontrado." (text #92400E on background #FEF3C7) e avançar automaticamente para a próxima.
  - Deletar playlist: dialog "Excluir a playlist \"{nome}\"? As músicas não serão apagadas." Buttons "Cancelar" (#374151) e "Excluir" (text #FFFFFF, background #B91C1C).
- Acceptance Checks:
  - ✓ Criar playlist, adicionar 3 músicas e reordenar por drag persiste positions corretas (0,1,2) após reiniciar o app.
  - ✓ "Tocar playlist" com 2 fixtures curtas (< 5s) reproduz a primeira e avança automaticamente para a segunda ao terminar (teste E2E com fixtures de 2–3 segundos).
  - ✓ Ao fim da última música a reprodução para e o botão volta ao estado ▶.
  - ✓ Item com arquivo ausente é pulado com toast e a reprodução continua na próxima.
  - ✓ Remover da playlist a música em reprodução não interrompe o áudio atual; o "próximo" passa a ser o item seguinte da lista atualizada.
  - ✓ "Anterior" nos 3 primeiros segundos volta para a faixa anterior; após 3s, reinicia a faixa atual.

Feature: F6 — Utilitário de Mock/Curadoria Mínima (`tools/embed_lyrics.py`)
- User Flow (desenvolvedor, hoje):
  1. Roda `python tools/embed_lyrics.py caminho/musica.mp3 caminho/letra.txt` (ou `--lyrics "texto inline"`).
  2. O script grava/substitui o frame USLT (encoding UTF-8, lang "por") e opcionalmente `--title` e `--artist` (TIT2/TPE1).
  3. Roda `python tools/embed_lyrics.py --check caminho/musica.mp3` para imprimir as tags e a letra embutida, validando o round-trip.
  4. Aponta a pasta no app e testa busca/exibição/reprodução com dado real.
- UI Copy & Colors: CLI apenas. Saída de sucesso: `OK: letra gravada em {arquivo} ({n} caracteres)`. Saída de check: imprime title, artist e a letra completa.
- Error & Empty States:
  - Arquivo não é MP3 ou não existe: `ERRO: arquivo inválido ou não encontrado: {path}` e exit code 1.
  - Letra vazia: `ERRO: letra vazia — nada gravado` e exit code 1.
  - MP3 sem header ID3: criar tag ID3v2.4 do zero e gravar normalmente.
- Acceptance Checks:
  - ✓ Round-trip: gravar letra com o script e ler com o indexer Rust do app retorna o texto idêntico (incluindo acentos e quebras de linha) — teste de integração do repositório.
  - ✓ `--check` exibe a letra gravada.
  - ✓ Rodar duas vezes substitui (não duplica) o frame USLT.

## 6) UI/UX

Color Palette:
- Primary Teal: #0F766E — botões primários, links de ação, item ativo
- Teal Light: #F0FDFA — background de item em reprodução/seleção
- Accent Teal: #14B8A6 — barra de progresso do player
- Background: #F9FAFB — fundo principal da área de conteúdo
- Surface: #FFFFFF — cards, painel de letra, campo de busca
- Player Bar: #111827 — rodapé do player (dark)
- Text Dark: #111827 — texto primário
- Text Muted: #6B7280 — secundário; #9CA3AF — terciário/desabilitado
- Danger Red: #B91C1C — ações destrutivas; erros em #991B1B on #FEE2E2
- Warning: #92400E on #FEF3C7 — avisos não-bloqueantes
- Success: #065F46 on #D1FAE5 — confirmações
- Highlight de busca: #FDE68A background, #78350F text

Typography:
- Font: Inter (fallback system-ui)
- Base: 15px
- Título de música na lista: 15px medium
- H1/título de tela: 22px semi-bold
- Letra da música: 16/20/24px (3 níveis, line-height 1.7)
- Player bar: 14px

Layout notes:
- Desktop-only. Janela mínima 1024×640.
- Grid: sidebar esquerda 240px (Biblioteca, Playlists, Configurações) • coluna central fluida (busca + lista) • painel de letra direito 380px (colapsável) • player bar fixa 72px no rodapé.
- Lista de músicas virtualizada (react-window ou equivalente) para 2.000+ itens sem jank.
- Alvos de clique ≥ 36px de altura por linha; densidade compacta, é ferramenta de trabalho.
- Modo reunião implícito: painel de letra aberto + fonte nível 3 cobre o caso de leitura à distância; um "modo apresentação" dedicado fica para V2.

Accessibility:
- Navegação por teclado completa: ↑/↓ navegam a lista, Enter toca, "/" ou Ctrl/Cmd+K foca busca, Esc limpa busca, Espaço play/pause.
- ARIA: lista como listbox, itens com aria-selected; player com aria-labels ("Tocar", "Pausar", "Próxima", "Anterior", "Volume").
- Contraste WCAG AA em todos os pares de cor listados.
- Sem animações essenciais; respeitar prefers-reduced-motion no ícone ♪ animado.

## 7) Out of Scope (V1)

- Ferramenta de curadoria com interface (busca de letra em LRCLIB/Vagalume, transcrição Whisper, edição em massa) — V2; hoje só o script CLI de mock
- Gravação/edição de letra pelo próprio player (o player nunca escreve nos arquivos)
- Letra sincronizada (SYLT/LRC) com destaque linha a linha
- Formatos além de MP3 (FLAC, M4A, OGG, WAV)
- Tags de etapa/tema da reunião e filtros por tag
- Watch de filesystem em tempo real (indexação automática ao adicionar arquivo com o app aberto)
- Compartilhamento/sincronização de playlists ou catálogo entre pessoas; qualquer backend
- Auto-update do app; assinatura/notarização (V1 aceita o aviso de "app não identificado" com instrução documentada)
- Crossfade, equalizador, gapless, repeat/shuffle
- Modo apresentação (letra em tela cheia)
- Suporte a Linux

## 8) Success Criteria (Testable)

- ✓ Em uma máquina Windows e uma macOS, o binário abre, indexa uma pasta com o MP3 de teste (letra embutida via `tools/embed_lyrics.py`) e a música aparece na biblioteca — sem internet.
- ✓ Buscar um trecho que existe apenas na letra retorna a música correta em < 100ms com o trecho destacado.
- ✓ Busca sem acentos encontra letras acentuadas ("coracao" → "coração").
- ✓ Clique único mostra a letra completa no painel sem iniciar reprodução; duplo-clique toca em < 500ms.
- ✓ Playlist com 2+ músicas toca em sequência automaticamente e para ao final; item com arquivo ausente é pulado com aviso.
- ✓ Volume, visibilidade do painel de letra, tamanho da fonte e playlists persistem após fechar e reabrir o app.
- ✓ Nenhum arquivo de áudio é modificado pelo player (hash dos MP3s idêntico antes/depois de qualquer fluxo de uso).
- ✓ Biblioteca com 2.000 músicas sintéticas: scroll da lista e digitação na busca sem travamentos perceptíveis (frames > 30fps, busca < 100ms).
- ✓ Sem erros no console/log em todos os fluxos padrão.

Cobertura de testes:
- ✓ Todos os comandos Tauri críticos (add_folder, scan, search, get_lyrics, playlist CRUD) têm testes de integração cobrindo fluxo feliz e todos os erros documentados (pasta inexistente, MP3 corrompido, query com caracteres especiais, arquivo removido)
- ✓ Cobertura >= 85% em services Rust (indexer, search, playlist) e stores/hooks do frontend
- ✓ Testes E2E cobrem os fluxos críticos: adicionar pasta e indexar → buscar por trecho de letra → ver letra → tocar → criar playlist e reprodução automática sequencial → remoção de arquivo e recuperação graciosa
- ✓ Round-trip de letra (script Python grava USLT → indexer Rust lê texto idêntico) coberto por teste de integração no CI
- ✓ Nenhum teste falhando no pipeline de CI antes de gerar os binários
- ✓ Testes escritos antes da implementação (TDD): cada Acceptance Check da seção 5 tem teste correspondente
