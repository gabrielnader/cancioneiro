# PRD V5 (rascunho) — Backlog do teste real no Mac (27/07/2026)

Ideias do coordenador durante o teste com acervo real, priorizadas. Quick wins
(Q) entram na v0.4.0; maiores viram specs próprias quando chegarem à frente.

## Q1 — Botão limpar busca (ideia 3)
Botão "×" dentro do campo de busca quando há texto (além do Esc). aria-label
"Limpar busca".

## Q2 — Pasta raiz sem filtro/chip (ideia 4)
Clicar na pasta raiz da árvore = mesma coisa que "Biblioteca" (sem filtro e sem
chip). Chip `📁 {nome} ×` só para subpastas. Motivação: o × na raiz sugere
"remover a pasta", o que assusta.

## Q3 — Ordem da linha: título, artista, depois "+" (ideia 5)
Na linha da música: título → artista → temas/badge → botão "+" no fim.

## Q4 — Toggle do painel: "detalhes" (ideia 6)
"Ocultar letra"/"Mostrar letra" viram "Ocultar detalhes"/"Mostrar detalhes" —
o painel agora exibe título, artista, temas, letra e edição (ficha completa).
Atualizar testes de copy.

## Q5 — Loading no "Buscar letra na internet" (ideia 7)
Estado visual durante o fetch: botão desabilitado com texto "Buscando…";
restaura ao terminar (sucesso, não-achou ou erro).

## F12 — Busca por nome de pasta (ideia 8)
As subpastas do arquivo (relativas à pasta registrada) entram no índice de
busca (nova coluna FTS `pastas`, migração user_version=3, rescan repõe).
Buscar "barco" encontra músicas da pasta barco/ mesmo sem tag/letra/título com
a palavra. Sem snippet de letra para match só em pasta. Chips/relevância:
título > temas/pasta > letra (rank FTS padrão aceitável na V5).

## F13 — Enriquecer em lote pelo app (ideia 1)
Botão (em Configurações ou na pasta da árvore) "Completar dados desta pasta":
roda a identificação da V3 (nome+duração vs LRCLIB) sobre as músicas
incompletas da pasta, mostra a lista de propostas com confiança e checkboxes
(ALTA pré-marcada), aplica as aceitas. Requer: comando Rust de busca em lote
(reusa lyrics_fetch) + UI de revisão. Não sobrescreve dados existentes (regra
da V3.1); nunca renomeia.

## F14 — Transcrição de áudio (ideia 2) — DECISÃO PENDENTE
Fallback para músicas não encontradas: transcrever trecho do áudio (Whisper
local, ex. faster-whisper/whisper.cpp) e usar o texto para (a) identificar
título/artista buscando o trecho e (b) na falta de fonte melhor, oferecer a
transcrição como letra (marcada como "transcrição automática"). Custos: modelo
local (download ~100MB+), tempo de CPU. GATE: resultado do experimento
`enriquecer --verboso` no acervo real — se o LRCLIB cobrir pouco do repertório
típico, F14 sobe de prioridade; caso contrário fica em espera.

## Fora deste ciclo
- Renomear/mover arquivos: continua proibido.
- Player permanece offline exceto ações explícitas de busca de letra.
