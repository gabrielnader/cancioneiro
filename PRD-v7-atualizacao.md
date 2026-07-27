# PRD V7 — Atualização automática (F16)

## Por que

O público final são pessoas com pouca familiaridade com computador. Hoje, cada
versão nova exige que **cada uma delas** baixe o instalador, instale por cima e,
no Mac, rode um comando no Terminal. Na prática isso significa que elas ficam
paradas na versão que alguém instalou uma vez — correções de segurança de dados
(como as desta rodada) nunca chegam a quem mais precisa delas.

Decisão do usuário (dono do produto): **verificar ao abrir o app e atualizar
sozinho**; sem rede ou sem versão nova, não acontece nada e ninguém é
incomodado. Sem botão.

## Revisão de princípio (registrar em DECISIONS)

O PRD original diz "nenhuma chamada de rede em runtime". A V4 já abriu a exceção
das ações explícitas (buscar letra, completar dados). A V7 abre a segunda, e
desta vez **não** é acionada por clique: uma consulta HTTPS ao GitHub Releases na
abertura. Consequências assumidas:

- A checagem envia apenas o que qualquer download HTTP envia (IP e versão atual
  na URL). **Nenhum dado do acervo, nenhum identificador de usuário, nenhuma
  telemetria** — isso continua inviolável.
- Tudo o mais segue offline: busca, letra, reprodução e indexação nunca tocam a
  rede.
- Como a decisão é do dono do produto e não do usuário final, o app oferece
  **desligar a verificação** em Configurações (padrão: ligada). Quem opera numa
  rede isolada precisa poder desligar.

## F16 — comportamento

1. Na abertura, depois que a janela aparece (nunca bloqueando a inicialização),
   o app consulta o manifesto de atualização publicado junto da release.
2. **Sem internet, DNS falhando, GitHub fora do ar, manifesto inválido ou
   nenhuma versão nova**: nada acontece. Nenhum aviso, nenhum erro, nenhum
   registro visível. O app abre normalmente. Este é o caminho mais comum e
   precisa ser absolutamente silencioso.
3. **Com versão nova**: baixa em segundo plano, sem atrapalhar o uso; ao
   terminar, mostra um aviso discreto e não-modal — "Atualização instalada.
   Reinicie o Cancioneiro para usar a versão nova." — com ação "Reiniciar
   agora". **Nunca reiniciar sozinho**: a coordenadora pode estar com uma música
   tocando numa reunião.
4. Falha no meio do download: silêncio também. Tenta de novo na próxima abertura.
5. Em Configurações: interruptor "Verificar atualizações ao abrir" (padrão
   ligado) e a versão instalada visível.

## Requisitos técnicos

- `tauri-plugin-updater`, manifesto `latest.json` publicado na própria release
  pelo `tauri-action` (`includeUpdaterJson: true`).
- **Assinatura do pacote de atualização** (minisign do Tauri, independente da
  assinatura da Apple/Microsoft): chave pública em `tauri.conf.json`, privada em
  segredo do repositório (`TAURI_SIGNING_PRIVATE_KEY`). Sem assinatura válida o
  updater recusa o pacote — é isso que impede alguém de servir uma atualização
  falsa.
- A verificação roda **depois** da janela abrir e nunca segura a inicialização,
  o scan ou a busca.
- Sem rede, o plugin falha rápido; qualquer erro é engolido (log de dev apenas).

## Efeito colateral bem-vindo no macOS

O aviso de "app danificado" vem da etiqueta de quarentena que o **navegador**
aplica ao baixar. Um pacote baixado pelo próprio app atualizado não recebe essa
etiqueta, então quem atualizar por aqui **não precisa repetir o comando do
Terminal** — ele passa a ser exigido só na primeira instalação. Não substitui a
assinatura, mas reduz o problema a uma vez na vida.

Ressalvas honestas: no macOS a substituição do app pode pedir a senha do
computador; no Windows o instalador pode exibir o SmartScreen de novo. Enquanto
os binários não forem assinados, esses avisos continuam possíveis.

## Invioláveis (inalterados)

- Nenhuma telemetria, nenhuma conta, nenhum dado do acervo sai da máquina.
- A reprodução nunca escreve; nenhum arquivo é renomeado ou movido.
- Reprodução, busca, letra e indexação continuam 100% offline.
