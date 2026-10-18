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

/**
 * A unified diff (hunks with `context` lines around each change) by Myers' O((N+M)·D) algorithm, so
 * a few edits in a big file cost little. Null when more than `maxEdits` lines changed: a rewrite,
 * which is cheaper to read whole.
 */
export function unifiedDiff(before: string, after: string, context = 3, maxEdits = 2000): { text: string; added: number; removed: number } | null {
  const a = splitLines(before);
  const b = splitLines(after);
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, maxEdits);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let done = n === 0 && m === 0;
  for (let d = 0; d <= max && !done; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) x++, y++;
      v[off + k] = x;
      if (x >= n && y >= m) {
        done = true;
        break;
      }
    }
  }
  if (!done) return null;
  // Walk back through the trace: ops in order, ' ' / '-' / '+'.
  const ops: DiffLine[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const t = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && t[off + k - 1] < t[off + k + 1]) ? k + 1 : k - 1;
    const px = d === 0 ? 0 : t[off + prevK];
    const py = px - prevK;
    while (x > px && y > py) ops.push({ op: ' ', text: a[--x] }), y--;
    if (d > 0) ops.push(x === px ? { op: '+', text: b[--y] } : { op: '-', text: a[--x] });
  }
  ops.reverse();
  let added = 0;
  let removed = 0;
  const out: string[] = [];
  // Old and new line numbers (0-based) before each op.
  const pos: [number, number][] = [];
  let ai = 0;
  let bi = 0;
  for (const o of ops) {
    pos.push([ai, bi]);
    if (o.op !== '+') ai++;
    if (o.op !== '-') bi++;
  }
  for (let i = 0; i < ops.length; ) {
    if (ops[i].op === ' ') {
      i++;
      continue;
    }
    // A hunk: from `context` before this change to `context` after the last change within reach.
    const start = Math.max(0, i - context);
    let end = i;
    for (let j = i; j < ops.length && j <= end + 2 * context; j++) if (ops[j].op !== ' ') end = j;
    const stop = Math.min(ops.length, end + context + 1);
    const slice = ops.slice(start, stop);
    const oldLen = slice.filter((o) => o.op !== '+').length;
    const newLen = slice.filter((o) => o.op !== '-').length;
    const [oa, ob] = pos[start];
    out.push(`@@ -${oldLen ? oa + 1 : oa},${oldLen} +${newLen ? ob + 1 : ob},${newLen} @@`);
    for (const o of slice) {
      if (o.op === '+') added++;
      if (o.op === '-') removed++;
      out.push(o.op + o.text);
    }
    i = stop;
  }
  return { text: out.join('\n'), added, removed };
}
