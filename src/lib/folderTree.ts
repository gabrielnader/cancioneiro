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

/** Nome exibido de uma pasta: última parte não-vazia do caminho. */
export function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
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
