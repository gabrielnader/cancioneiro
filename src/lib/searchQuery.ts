/**
 * Espelha a regra do sanitizador FTS do backend (src-tauri/src/search.rs):
 * uma busca só é busca de verdade se tiver ao menos um token alfanumérico.
 * Query só de operadores/pontuação é tratada como campo vazio — a UI não
 * deve mostrar contador de resultados nem estado "nenhum resultado".
 */
export function hasSearchTokens(query: string): boolean {
  return /[\p{L}\p{N}]/u.test(query);
}
