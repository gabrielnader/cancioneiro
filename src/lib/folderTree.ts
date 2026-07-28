import type { Folder, SearchResult, Song } from "./types";

/**
 * Árvore de pastas da sidebar (V4 — F11): cada pasta registrada é uma raiz e
 * as subpastas são derivadas dos file_path das músicas (sem mudança de
 * schema) — só aparecem as que contêm MP3 direta ou indiretamente.
 */
export interface FolderNode {
  /** Última parte do caminho (nome exibido). */
  name: string;
  /** Caminho completo da pasta (prefixo usado no filtro). */
  path: string;
  /** Músicas na subárvore inteira (inclui subpastas). */
  count: number;
  children: FolderNode[];
}

/** Separador usado pelo caminho (Windows "\" ou POSIX "/"). */
function sepOf(path: string): string {
  return path.includes("/") ? "/" : "\\";
}

/**
 * True se filePath está DENTRO de folderPath (prefixo de pasta exato:
 * "/m/1" não casa "/m/10/a.mp3").
 */
export function isUnderFolder(filePath: string, folderPath: string): boolean {
  return (
    filePath.startsWith(`${folderPath}/`) ||
    filePath.startsWith(`${folderPath}\\`)
  );
}

/** Filtra os resultados exibidos pelo filtro de pasta ativo (null = sem filtro). */
export function filterResultsByFolder(
  results: SearchResult[],
  folderFilter: string | null,
): SearchResult[] {
  if (!folderFilter) return results;
  return results.filter((r) => isUnderFolder(r.song.file_path, folderFilter));
}

/** Última parte não-vazia do caminho (aceita "/" e "\"). */
function lastSegment(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** Nome exibido de uma pasta: última parte não-vazia do caminho. */
export function folderName(path: string): string {
  return lastSegment(path);
}

/**
 * Nome do arquivo (basename COM extensão), sem a pasta — a pasta já aparece na
 * árvore lateral (DECISIONS #43).
 */
export function fileName(path: string): string {
  return lastSegment(path);
}

/**
 * Comparação de redundância: ignora caixa, espaços em volta e a FORMA de
 * composição Unicode (não ignora acento).
 *
 * O macOS entrega o file_path em NFD ("c" + acento combinante) e a tag ID3
 * chega em NFC ("ç"): sem normalizar, "Coração.mp3" com o título "Coração"
 * escaparia da regra e a mesma palavra sairia impressa duas vezes. NFC não
 * remove acento nenhum — "Coracao.mp3" sob o título "Coração" continua sendo
 * uma diferença de verdade, e continua aparecendo.
 */
function mesmoTexto(a: string, b: string): boolean {
  return normalizado(a) === normalizado(b);
}

function normalizado(s: string): string {
  return s.normalize("NFC").trim().toLocaleLowerCase();
}

/**
 * Nome do arquivo a EXIBIR junto do título (V6), ou null quando ele não
 * acrescenta nada.
 *
 * As coordenadoras se organizam por nome de arquivo há anos, e a identificação
 * automática às vezes erra o título: ver o arquivo é continuidade e rede de
 * segurança ao mesmo tempo. Mas quando a música não tem tags o indexador cai
 * no próprio nome do arquivo como título — aí imprimir os dois é imprimir a
 * mesma coisa duas vezes. Redundante = título igual ao nome do arquivo com ou
 * sem a extensão. Acento NÃO é redundância ("Coracao.mp3" com título "Coração"
 * é exatamente a diferença que a pessoa procura na tela).
 */
export function songFileName(song: Song): string | null {
  const name = fileName(song.file_path);
  const stem = name.replace(/\.[^.]+$/, "");
  if (mesmoTexto(song.title, name) || mesmoTexto(song.title, stem)) return null;
  return name;
}

/** Monta a árvore: uma raiz por pasta registrada, subpastas com contadores. */
export function buildFolderTree(songs: Song[], folders: Folder[]): FolderNode[] {
  return folders.map((folder) => {
    const root: FolderNode = {
      name: folderName(folder.path),
      path: folder.path,
      count: 0,
      children: [],
    };
    const sep = sepOf(folder.path);

    for (const song of songs) {
      if (!isUnderFolder(song.file_path, folder.path)) continue;
      root.count++;
      // diretórios intermediários entre a raiz e o arquivo
      const rel = song.file_path.slice(folder.path.length + 1);
      const dirs = rel.split(/[\\/]/).slice(0, -1);
      let node = root;
      for (const dir of dirs) {
        let child = node.children.find((c) => c.name === dir);
        if (!child) {
          child = {
            name: dir,
            path: `${node.path}${sep}${dir}`,
            count: 0,
            children: [],
          };
          node.children.push(child);
          node.children.sort((a, b) =>
            a.name.localeCompare(b.name, undefined, { numeric: true }),
          );
        }
        child.count++;
        node = child;
      }
    }
    return root;
  });
}
