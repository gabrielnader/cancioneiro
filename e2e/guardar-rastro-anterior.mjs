/**
 * Salva o rastro da execução ANTERIOR antes que o Playwright o apague.
 *
 * O `playwright.config.ts` já pede `trace: "retain-on-failure"`, então toda
 * falha deixa um rastro completo em `test-results/` — a única coisa capaz de
 * explicar um teste que falha uma vez e não falha de novo. Só que o Playwright
 * **limpa esse diretório no início de cada execução**, e reexecutar é o
 * primeiro impulso de quem vê uma falha isolada.
 *
 * Foi exatamente o que aconteceu: um E2E falhou uma vez em seis execuções, a
 * prova estava no disco, e a segunda execução — disparada para saber se
 * reproduzia — apagou a prova antes de alguém olhar. A resposta veio como
 * "1 em 6, sem mecanismo", quando podia ter vindo como a linha exata que
 * falhou.
 *
 * Este passo roda antes do `playwright test` e move o que houver para
 * `test-results-anterior/`. Não custa nada quando a execução passou (o
 * diretório vem quase vazio) e salva a investigação quando não passou.
 *
 * A regra que ele encarna é a mesma do produto: **lembrança não é mecanismo.**
 * Não adianta saber que não se deve reexecutar antes de olhar; o arnês tem de
 * sobreviver a alguém reexecutando.
 */
import { existsSync, rmSync, renameSync, readdirSync } from "node:fs";

const ATUAL = "test-results";
const ANTERIOR = "test-results-anterior";

if (existsSync(ATUAL)) {
  // só vale guardar o que tem conteúdo de falha: uma execução limpa deixa
  // apenas o `.last-run.json`, e arquivá-lo esconderia o rastro de VERDADE
  // que estivesse guardado da vez anterior
  const conteudo = readdirSync(ATUAL).filter((n) => n !== ".last-run.json");
  if (conteudo.length > 0) {
    if (existsSync(ANTERIOR)) rmSync(ANTERIOR, { recursive: true, force: true });
    renameSync(ATUAL, ANTERIOR);
    console.log(
      `[e2e] rastro da execução anterior guardado em ${ANTERIOR}/ ` +
        `(${conteudo.length} item(ns)) — o Playwright ia apagá-lo agora`,
    );
  }
}
