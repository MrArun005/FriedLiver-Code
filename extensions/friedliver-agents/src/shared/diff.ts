// Small line diffs for the transcript: what an agent's edit changes, at a glance.
// The diff editor shows the whole file; these only need to be right and cheap.

export interface DiffLine {
  op: ' ' | '+' | '-';
  text: string;
}

/** Lines a preview shows; the rest is counted. */
export const PREVIEW_LINES = 40;
/** Past this many cells (old lines × new lines) the diff doesn't align lines, it lists old then new. */
const MAX_CELLS = 250_000;
/** Characters of one line in a preview. */
const MAX_LINE = 400;

export function splitLines(text: string | null | undefined): string[] {
  if (!text) return [];
  return text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
}

/** A line diff: the longest common subsequence, with common lines first. */
export function diffLines(before: string | null | undefined, after: string | null | undefined): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  // Common start and end need no table.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const head: DiffLine[] = a.slice(0, start).map((text) => ({ op: ' ', text }));
  const tail: DiffLine[] = a.slice(endA).map((text) => ({ op: ' ', text }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length * midB.length > MAX_CELLS) {
    return [...head, ...midA.map((text) => ({ op: '-' as const, text })), ...midB.map((text) => ({ op: '+' as const, text })), ...tail];
  }
  const n = midA.length;
  const m = midB.length;
  // lcs[i][j]: common lines of midA[i..] and midB[j..], one flat array.
  const lcs = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * (m + 1) + j] = midA[i] === midB[j] ? lcs[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(lcs[(i + 1) * (m + 1) + j], lcs[i * (m + 1) + j + 1]);
    }
  }
  const mid: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (midA[i] === midB[j]) {
      mid.push({ op: ' ', text: midA[i] });
      i++;
      j++;
    } else if (lcs[(i + 1) * (m + 1) + j] >= lcs[i * (m + 1) + j + 1]) {
      mid.push({ op: '-', text: midA[i++] });
    } else {
      mid.push({ op: '+', text: midB[j++] });
    }
  }
  while (i < n) mid.push({ op: '-', text: midA[i++] });
  while (j < m) mid.push({ op: '+', text: midB[j++] });
  return [...head, ...mid, ...tail];
}

export interface DiffPreview {
  added: number;
  removed: number;
  /** Changed lines with up to two lines of context, "…" between distant changes; capped. */
  lines: DiffLine[];
  /** Lines left out of `lines`. */
  more: number;
}

export function diffPreview(before: string | null | undefined, after: string | null | undefined, max = PREVIEW_LINES): DiffPreview {
  const all = diffLines(before, after);
  let added = 0;
  let removed = 0;
  const keep = new Set<number>();
  all.forEach((l, n) => {
    if (l.op === ' ') return;
    if (l.op === '+') added++;
    else removed++;
    for (let k = Math.max(0, n - 2); k <= Math.min(all.length - 1, n + 2); k++) keep.add(k);
  });
  const lines: DiffLine[] = [];
  let last = -1;
  let shown = 0;
  let more = 0;
  for (const n of [...keep].sort((x, y) => x - y)) {
    if (shown >= max) {
      if (all[n].op !== ' ') more++;
      continue;
    }
    if (last >= 0 && n > last + 1) lines.push({ op: ' ', text: '…' });
    const l = all[n];
    lines.push(l.text.length > MAX_LINE ? { op: l.op, text: `${l.text.slice(0, MAX_LINE)}…` } : l);
    shown++;
    last = n;
  }
  return { added, removed, lines, more };
}
