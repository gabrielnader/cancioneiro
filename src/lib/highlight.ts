/**
 * Marcadores de destaque emitidos pelo comando `search` do backend
 * (área de uso privado do Unicode — ver src-tauri/src/search.rs).
 */
export const HIGHLIGHT_START = "\uE000";
export const HIGHLIGHT_END = "\uE001";

export interface SnippetSegment {
  text: string;
  highlighted: boolean;
}

/** Converte o snippet com marcadores em segmentos para renderização segura. */
export function parseSnippet(snippet: string): SnippetSegment[] {
  const segments: SnippetSegment[] = [];
  let rest = snippet;

  while (rest.length > 0) {
    const start = rest.indexOf(HIGHLIGHT_START);
    if (start === -1) {
      segments.push({ text: rest, highlighted: false });
      break;
    }
    if (start > 0) {
      segments.push({ text: rest.slice(0, start), highlighted: false });
    }
    const afterStart = rest.slice(start + 1);
    const end = afterStart.indexOf(HIGHLIGHT_END);
    if (end === -1) {
      segments.push({ text: afterStart, highlighted: true });
      break;
    }
    segments.push({ text: afterStart.slice(0, end), highlighted: true });
    rest = afterStart.slice(end + 1);
  }

  return segments;
}
