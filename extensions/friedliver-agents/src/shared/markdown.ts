// Just enough Markdown for agent replies, parsed to data and rendered as
// elements (never innerHTML), so agent text can't inject markup. Agents write
// plain text too: a summary with one item per line, "✓" lists indented under
// "1." items, "FILES:" labels, ASCII tables. Single newlines stay line breaks,
// as in chat apps, so that kind of reply keeps its shape.

/** A file a reply names, with the line (and column) after it: `src/a.ts:12:3`. */
export interface PathRef {
  path: string;
  line?: number;
  col?: number;
}

export type Inline =
  | { t: 'text'; v: string }
  /** `ref`: the code is a file path. */
  | { t: 'code'; v: string; ref?: PathRef }
  | { t: 'strong'; v: string }
  | { t: 'em'; v: string }
  | { t: 'link'; v: string; href: string }
  | { t: 'path'; v: string; ref: PathRef }
  | { t: 'br' };

export interface ListItem {
  inline: Inline[];
  /** The symbol the line started with (✓, ✗, •, →…), kept on screen. */
  mark?: string;
  tone?: 'ok' | 'bad';
  /** Lists indented under this item. */
  lists?: ListBlock[];
}

export type ListBlock = { t: 'ul' | 'ol'; items: ListItem[]; start?: number };

export type Align = 'left' | 'center' | 'right' | null;

export type Block =
  | { t: 'p'; inline: Inline[] }
  | { t: 'h'; level: 1 | 2 | 3; inline: Inline[] }
  /** A short line such as "TEST RESULTS:" or "Next Steps:", drawn as a small heading. */
  | { t: 'label'; inline: Inline[] }
  | ListBlock
  | { t: 'pre'; lang: string; code: string }
  | { t: 'table'; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  /** Text laid out with spaces or box lines (ASCII tables, aligned columns): monospace, never reflowed. */
  | { t: 'mono'; text: string };

export function parseMarkdown(text: string): Block[] {
  return parseDoc(text).blocks;
}

/** A parsed reply, kept so the next, longer version of it parses only its tail. */
export interface MarkdownDoc {
  /** The text with \r\n line ends made \n. */
  text: string;
  blocks: Block[];
  /** Where each block's first line starts in `text`. */
  starts: number[];
}

/** Blocks that a line after the next block's start may still join: a bullet, a box line, a table row. */
const JOINABLE = new Set<Block['t']>(['ul', 'ol', 'mono', 'table']);

/**
 * parseMarkdown, reusing `prev` when `text` only adds to the text it parsed:
 * a streamed reply grows a few words at a time, and parsing all of it again
 * for every chunk made long replies slower and slower. A later line can
 * only extend the last block, or join the one before it (a list, table or
 * box lines it continues, a paragraph it interrupted but turns out to be
 * part of), so the blocks before those are final: they are kept, as the same
 * objects, and parsing starts again there. The result is always what
 * parseMarkdown(text) gives.
 */
export function parseDoc(text: string, prev?: MarkdownDoc): MarkdownDoc {
  const norm = text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text;
  if (prev && norm === prev.text) return prev;
  if (prev && prev.blocks.length > 0 && norm.startsWith(prev.text)) {
    let last = prev.blocks.length - 1;
    const before = prev.blocks[last - 1];
    // The last line may still join the block before: a list, table or box lines it continues, or the
    // paragraph it interrupted ("FILES:" growing into "FILES: a.ts", a ``` growing into ```js x).
    if (before && (JOINABLE.has(before.t) || (before.t === 'p' && prev.blocks[last].t !== 'p'))) last--;
    const doc = { text: norm, blocks: prev.blocks.slice(0, last), starts: prev.starts.slice(0, last) };
    parseFrom(doc, prev.starts[last]);
    return doc;
  }
  const doc = { text: norm, blocks: [], starts: [] };
  parseFrom(doc, 0);
  return doc;
}

const FENCE = /^\s*```\s*([\w+#.-]*)\s*$/;
const FENCE_END = /^\s*```\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^(\s*)(?:([-*+])|(\d{1,9})[.)])\s+(.*)$/;
/** Lines that start with one of these and a space are list items too; the symbol stays. */
const SYMBOL = /^(\s*)([✓✔✅✗✘❌•→▸‣◦])️?\s+(.*)$/;
const TONE: Record<string, 'ok' | 'bad'> = { '✓': 'ok', '✔': 'ok', '✅': 'ok', '✗': 'bad', '✘': 'bad', '❌': 'bad' };
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const BOX = /[─-╿]/;
const BORDER = /^\s*[+|][-=+:| ]*[-=]{3,}[-=+:| ]*$/;
const ROW = /^\s*[|│┃║]/;

interface Bullet {
  indent: number;
  t: 'ul' | 'ol';
  num?: number;
  mark?: string;
  text: string;
}

function indentOf(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === ' ') n++;
    else if (ch === '\t') n += 4;
    else break;
  }
  return n;
}

function bulletOf(line: string): Bullet | undefined {
  const b = line.match(BULLET);
  if (b) return { indent: indentOf(b[1]), t: b[3] ? 'ol' : 'ul', ...(b[3] ? { num: Number(b[3]) } : {}), text: b[4] };
  const s = line.match(SYMBOL);
  if (s) return { indent: indentOf(s[1]), t: 'ul', mark: s[2], text: s[3] };
  return undefined;
}

const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'into', 'of', 'on', 'or', 'the', 'to', 'vs', 'via', 'with', '&', '+', '/', '-', '–']);

/** "FEATURES IMPLEMENTED & VERIFIED:", "Test Results:", "FILES:": a short label line in capitals or Title Case. */
export function isLabel(line: string): boolean {
  if (indentOf(line) > 3) return false;
  const t = line.trim();
  if (t.length < 3 || t.length > 64 || !t.endsWith(':') || t.endsWith('::') || t.includes('://') || !/^[A-Za-z0-9]/.test(t)) return false;
  const body = t.slice(0, -1).trim();
  const words = body.split(/\s+/);
  if (!/[A-Za-z]{2}/.test(body) || words.length > 8 || /[`*_[\]]/.test(body)) return false;
  if (body === body.toUpperCase()) return true;
  return /^[A-Z0-9]/.test(words[0]) && words.every((w) => /^[A-Z0-9(]/.test(w) || SMALL_WORDS.has(w.toLowerCase()));
}

/** Parses `doc.text` from `from`, a line start where no block is open, after `doc.blocks`. */
function parseFrom(doc: MarkdownDoc, from: number): void {
  const { blocks, starts } = doc;
  const lines = doc.text.slice(from).split('\n');
  let at = from;
  const offsets = lines.map((l) => {
    const o = at;
    at += l.length + 1;
    return o;
  });
  let para: string[] = [];
  let paraAt: number[] = [];
  const push = (block: Block, start: number) => {
    blocks.push(block);
    starts.push(start);
  };
  const flush = () => {
    if (para.length) paragraph(para, paraAt, push);
    para = [];
    paraAt = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(FENCE);
    if (fence) {
      flush();
      const start = offsets[i];
      const code: string[] = [];
      while (++i < lines.length && !FENCE_END.test(lines[i])) code.push(lines[i]);
      push({ t: 'pre', lang: fence[1], code: code.join('\n') }, start);
      continue;
    }
    const heading = line.match(HEADING);
    if (heading) {
      flush();
      push({ t: 'h', level: Math.min(heading[1].length, 3) as 1 | 2 | 3, inline: parseInline(heading[2]) }, offsets[i]);
      continue;
    }
    if (bulletOf(line)) {
      flush();
      const end = listEnd(lines, i);
      push(buildList(lines.slice(i, end)), offsets[i]);
      i = end - 1;
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('|') && lines[i + 1].includes('-')) {
      flush();
      let end = i + 2;
      while (end < lines.length && lines[end].includes('|') && lines[end].trim() && !FENCE.test(lines[end])) end++;
      push(table(lines[i], lines[i + 1], lines.slice(i + 2, end)), offsets[i]);
      i = end - 1;
      continue;
    }
    if (isLabel(line)) {
      flush();
      push({ t: 'label', inline: parseInline(line.trim().slice(0, -1).trimEnd()) }, offsets[i]);
      continue;
    }
    para.push(line);
    paraAt.push(offsets[i]);
  }
  flush();
}

/**
 * Where the list starting at `lines[i]` ends: its items at any depth, lines
 * indented under an item, and blank lines before another item. A fence, a
 * line that isn't indented, or an item of the other kind at the top ends it.
 */
function listEnd(lines: string[], i: number): number {
  const top = bulletOf(lines[i])!;
  const other = (b: Bullet) => b.indent <= top.indent && b.t !== top.t;
  let j = i + 1;
  while (j < lines.length) {
    const line = lines[j];
    if (FENCE.test(line)) break;
    const b = bulletOf(line);
    if (b) {
      if (other(b)) break;
      j++;
      continue;
    }
    if (!line.trim()) {
      let k = j + 1;
      while (k < lines.length && !lines[k].trim()) k++;
      const next = k < lines.length ? bulletOf(lines[k]) : undefined;
      if (!next || other(next)) break;
      j = k;
      continue;
    }
    if (indentOf(line) > top.indent && lines[j - 1].trim()) {
      j++;
      continue;
    }
    break;
  }
  return j;
}

function item(b: Bullet): ListItem {
  return { inline: parseInline(b.text), ...(b.mark ? { mark: b.mark } : {}), ...(b.mark && TONE[b.mark] ? { tone: TONE[b.mark] } : {}) };
}

const newList = (b: Bullet): ListBlock => ({ t: b.t, items: [], ...(b.t === 'ol' && b.num !== undefined && b.num !== 1 ? { start: b.num } : {}) });

/** A list from its lines (see listEnd), nested by indentation. */
function buildList(lines: string[]): ListBlock {
  const first = bulletOf(lines[0])!;
  const root = newList(first);
  const stack: { indent: number; list: ListBlock }[] = [{ indent: first.indent, list: root }];
  for (const line of lines) {
    if (!line.trim()) continue;
    const b = bulletOf(line);
    if (!b) {
      // A line indented under an item continues it, on a line of its own.
      const deepest = stack.at(-1)!.list.items.at(-1);
      if (deepest) deepest.inline.push({ t: 'br' }, ...parseInline(line.trim()));
      continue;
    }
    while (stack.length > 1 && b.indent < stack.at(-1)!.indent) stack.pop();
    const top = stack.at(-1)!;
    if (b.indent > top.indent && top.list.items.length) {
      const parent = top.list.items.at(-1)!;
      const lists = (parent.lists ??= []);
      const reuse = lists.at(-1);
      const list = reuse && reuse.t === b.t ? reuse : newList(b);
      if (list !== reuse) lists.push(list);
      stack.push({ indent: b.indent, list });
      list.items.push(item(b));
    } else if (b.t !== top.list.t && stack.length > 1) {
      // The other kind of list at the same depth: a new list under the same item.
      const parent = stack.at(-2)!.list.items.at(-1)!;
      const list = newList(b);
      parent.lists!.push(list);
      stack[stack.length - 1] = { indent: b.indent, list };
      list.items.push(item(b));
    } else top.list.items.push(item(b));
  }
  return root;
}

function cells(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

function table(head: string, sep: string, rows: string[]): Block {
  const names = cells(head);
  const align = cells(sep).map((c): Align => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null));
  const width = names.length;
  const fit = (cs: string[]) => Array.from({ length: width }, (_, n) => parseInline(cs[n] ?? ''));
  return { t: 'table', align: Array.from({ length: width }, (_, n) => align[n] ?? null), head: fit(names), rows: rows.map((r) => fit(cells(r))) };
}

const isBox = (line: string) => BOX.test(line) || BORDER.test(line);

/** Columns inside a run of two or more spaces between words. */
function gaps(line: string): Set<number> {
  const out = new Set<number>();
  for (const m of line.trimEnd().matchAll(/(?<=\S) {2,}(?=\S)/g)) for (let c = m.index; c < m.index + m[0].length; c++) out.add(c);
  return out;
}

/** Lines laid out in columns: each has a gap of spaces (or a tab) between words, and a gap column they share. */
function aligned(lines: string[]): boolean {
  if (lines.length < 2) return false;
  if (lines.every((l) => /\S\t+\S/.test(l))) return true;
  let common: Set<number> | undefined;
  for (const l of lines) {
    const g = gaps(l);
    if (!g.size) return false;
    common = common ? new Set([...common].filter((c) => g.has(c))) : g;
    if (!common.size) return false;
  }
  return true;
}

/**
 * A paragraph's lines as blocks: runs of box lines (`+---+`, `│`, `─`) and the
 * table rows between them, and text in aligned columns, stay monospace; the
 * rest is text with its line breaks.
 */
function paragraph(lines: string[], at: number[], push: (b: Block, start: number) => void): void {
  const kind = lines.map((l) => (isBox(l) ? 'box' : ROW.test(l) ? 'row' : 'text'));
  // A run of rows is a table only with a box line in it.
  for (let i = 0; i < lines.length; ) {
    if (kind[i] === 'text') {
      i++;
      continue;
    }
    let e = i;
    while (e < lines.length && kind[e] !== 'text') e++;
    if (!kind.slice(i, e).includes('box')) for (let k = i; k < e; k++) kind[k] = 'text';
    i = e;
  }
  for (let i = 0; i < lines.length; ) {
    let e = i + 1;
    const mono = kind[i] !== 'text';
    while (e < lines.length && (kind[e] !== 'text') === mono) e++;
    const run = lines.slice(i, e);
    if (mono || aligned(run)) push({ t: 'mono', text: run.map((l) => l.trimEnd()).join('\n') }, at[i]);
    else push({ t: 'p', inline: parseInline(run.map((l) => l.trim()).join('\n')) }, at[i]);
    i = e;
  }
}

const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|(?<![\w*])\*[^*\s][^*\n]*\*(?![\w*])|(?<!\w)_[^_\s][^_\n]*_(?!\w)|\[[^\]\n]+\]\([^)\s]+\))/g;

const EXT = 'py|pyi|ipynb|ts|tsx|mts|cts|js|jsx|mjs|cjs|json|jsonc|md|mdx|sql|sh|bash|zsh|go|rs|java|kt|kts|swift|c|h|cc|cpp|hpp|cs|rb|php|css|scss|less|html|htm|vue|svelte|yml|yaml|toml|ini|cfg|conf|txt|lock|xml|csv|tsv|log|env|gradle|dart|lua|ex|exs|erl|hs|ml|scala|clj|proto|graphql|tf|patch|diff|svg';
/** A file path: absolute, `~/`, `./`, a relative one with a folder, or a bare file name with a code extension; then `:line` and `:col`. */
const PATH = new RegExp(
  String.raw`(?<![\w./\\:@~$%#-])` +
    String.raw`((?:~|\.{1,2})?\/(?:[\w.@+-]+\/)*[\w.@+-]+|[A-Za-z]:\\(?:[\w.@+-]+\\)*[\w.@+-]+|(?:[\w@+-][\w.@+-]*\/)+[\w.@+-]*[\w@+-]|[\w@+-][\w.@+-]*\.(?:${EXT}))` +
    String.raw`(?::(\d{1,7})(?::(\d{1,5}))?)?(?![\w/\\])`,
  'gi',
);

/** `m` as a path reference, or undefined when it reads as something else ("and/or", "Node.js", a date). */
function pathRef(raw: string, line?: string, col?: string): { ref: PathRef; text: string } | undefined {
  let path = raw;
  while (path.endsWith('.') && path.length > 1 && !/(^|[\\/])\.{1,2}$/.test(path)) path = path.slice(0, -1);
  if (!/[A-Za-z]/.test(path)) return undefined;
  const parts = path.split(/[\\/]/).filter(Boolean);
  const last = parts.at(-1) ?? '';
  const hasExt = new RegExp(String.raw`\.(?:${EXT})$`, 'i').test(last) || /\.[A-Za-z][\w]{0,7}$/.test(last);
  const anchored = /^(?:~|\.{1,2})?[\\/]/.test(path) || /^[A-Za-z]:\\/.test(path);
  if (anchored ? parts.length < 2 && !hasExt : parts.length === 1 ? !new RegExp(String.raw`\.(?:${EXT})$`, 'i').test(last) : parts.length < 3 && !hasExt) return undefined;
  if (parts.length === 1 && /^[A-Z][a-z]+\.js$/.test(last)) return undefined;
  const ref: PathRef = { path, ...(line ? { line: Number(line) } : {}), ...(line && col ? { col: Number(col) } : {}) };
  return { ref, text: path + (line ? `:${line}${col ? `:${col}` : ''}` : '') };
}

/** The whole of `text` as a path reference, for code spans like `src/format.ts:12`. */
export function wholePath(text: string): PathRef | undefined {
  PATH.lastIndex = 0;
  const m = PATH.exec(text);
  PATH.lastIndex = 0;
  if (!m || m.index !== 0 || m[0].length !== text.length) return undefined;
  const p = pathRef(m[1], m[2], m[3]);
  return p && p.text === text ? p.ref : undefined;
}

/** Plain text with the file paths in it picked out. */
function withPaths(text: string, out: Inline[]): void {
  let at = 0;
  for (const m of text.matchAll(PATH)) {
    const p = pathRef(m[1], m[2], m[3]);
    if (!p) continue;
    if (m.index > at) out.push({ t: 'text', v: text.slice(at, m.index) });
    out.push({ t: 'path', v: p.text, ref: p.ref });
    at = m.index + p.text.length;
  }
  if (at < text.length) out.push({ t: 'text', v: text.slice(at) });
}

function inlineLine(text: string, out: Inline[]): void {
  for (const token of text.split(INLINE)) {
    if (!token) continue;
    if (token.length > 1 && token.startsWith('`') && token.endsWith('`')) {
      const v = token.slice(1, -1);
      const ref = wholePath(v);
      out.push(ref ? { t: 'code', v, ref } : { t: 'code', v });
    } else if (token.length > 4 && token.startsWith('**') && token.endsWith('**')) out.push({ t: 'strong', v: token.slice(2, -2) });
    else if (token.length > 2 && /^([*_]).*\1$/s.test(token)) out.push({ t: 'em', v: token.slice(1, -1) });
    else {
      const link = token.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
      // Only web links become links; anything else (javascript:, file:, command:) stays text.
      if (link && /^https:\/\//i.test(link[2])) out.push({ t: 'link', v: link[1], href: link[2] });
      else if (link) out.push({ t: 'text', v: link[1] });
      else withPaths(token, out);
    }
  }
}

/** Inline markup; a newline is a line break. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  text.split('\n').forEach((line, n) => {
    if (n) out.push({ t: 'br' });
    inlineLine(line, out);
  });
  return out;
}

/** Lines a reply takes, for collapsing a long one. */
export function lineCount(text: string): number {
  let n = 1;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) n++;
  return n;
}
