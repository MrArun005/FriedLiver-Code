// Cheaper reads for agents over the project index: one definition's body instead of a whole
// file (symbolRange), outlines of signatures only, and search hits as small windows of lines
// within a token budget. Plain Node, no vscode; answerIndex (projectIndex.ts) uses these, and
// every path still goes through the index's own checks (ProjectIndex.read) first.
import { estimateTokens } from '../shared/tokens';
import type { Sym } from './projectIndex';

export const READ_LIMITS = {
  /** A file this small comes back whole from index_read without a symbol or lines. */
  smallLines: 150,
  smallChars: 6000,
  /** Lines one index_read returns at most. */
  maxLines: 300,
  /** index_search's token budget: default, least, most. */
  budget: 1500,
  minBudget: 100,
  maxBudget: 8000,
  /** Lines of context around a search hit. */
  window: 3,
  /** Windows one file gets in a search. */
  windowsPerFile: 3,
  /** Characters of one signature in an outline. */
  signature: 120,
};

const lead = (line: string) => line.replace(/\t/g, '  ').length - line.replace(/\t/g, '  ').trimStart().length;
const isComment = (t: string) => /^(\/\*|\*|\/\/|#|@|"""|''')/.test(t);
/** A line that carries on the statement above it rather than starting a new one. */
const CONTINUES = /^[|&.?:)\]},+\-*/=<>]/;

/** A line with its strings and comments blanked, roughly: enough to count brackets. */
const code = (line: string) =>
  line
    .replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""')
    .replace(/\/\*.*?\*\//g, '')
    .replace(/\/\/.*$/, '');

/**
 * The lines (1-based, inclusive) a definition spans: its doc comment or decorators, then its body,
 * by brackets (C-like languages), indentation (Python) or `end` (Ruby). Never past the next
 * definition at the same or an outer level, so a heuristic that misreads a line stays local.
 */
export function symbolRange(file: string, lines: string[], syms: Sym[], sym: Sym): { start: number; end: number } {
  const i0 = sym.line - 1;
  const ind = lead(lines[i0] ?? '');
  let bound = lines.length - 1;
  for (const s of syms) {
    if (s.line > sym.line && lead(lines[s.line - 1] ?? '') <= ind) {
      bound = s.line - 2;
      break;
    }
  }
  let end = bound;
  if (file.endsWith('.py')) {
    end = i0;
    for (let i = i0 + 1; i <= bound; i++) {
      if (!lines[i].trim()) continue;
      if (lead(lines[i]) <= ind) break;
      end = i;
    }
  } else if (file.endsWith('.rb')) {
    for (let i = i0 + 1; i <= bound; i++) {
      if (lead(lines[i]) === ind && lines[i].trim() === 'end') {
        end = i;
        break;
      }
    }
  } else {
    let depth = 0;
    let bracket = false;
    for (let i = i0; i <= bound; i++) {
      const c = code(lines[i]);
      for (const ch of c) {
        if (ch === '{' || ch === '(' || ch === '[') (depth++, (bracket = true));
        else if (ch === '}' || ch === ')' || ch === ']') depth--;
      }
      if (depth > 0) continue;
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      const nextStarts = j >= lines.length || j > bound || (lead(lines[j]) <= ind && !CONTINUES.test(lines[j].trim()));
      if ((bracket || c.trim().endsWith(';')) && nextStarts) {
        end = i;
        break;
      }
    }
  }
  // Blank and comment lines at the end belong to whatever comes next.
  while (end > i0 && (!lines[end].trim() || isComment(lines[end].trim()))) end--;
  let start = i0;
  while (start > 0 && i0 - start < 40 && lines[start - 1].trim() && isComment(lines[start - 1].trim())) start--;
  return { start: start + 1, end: end + 1 };
}

/** A definition's line as a signature: no body brace, no trailing `=`, at most READ_LIMITS.signature characters. */
export function signature(line: string): string {
  const s = line
    .trim()
    .replace(/\s*(=>\s*)?\{\s*$/, '')
    .replace(/\s*[=:]\s*$/, '');
  return s.length > READ_LIMITS.signature ? `${s.slice(0, READ_LIMITS.signature)}…` : s;
}

/** `12: export function f(a: string): number`, nested ones indented as in the file (at most 8). */
export const compactOutline = (lines: string[], syms: Sym[]): string =>
  syms.map((s) => `${s.line}: ${' '.repeat(Math.min(8, lead(lines[s.line - 1] ?? '')))}${signature(lines[s.line - 1] ?? s.name)}`).join('\n');

/** Lines `from`..`to` (1-based) as `n<TAB>text`, each cut at `max` characters. */
export const numbered = (lines: string[], from: number, to: number, max = 2000): string =>
  lines
    .slice(from - 1, to)
    .map((l, i) => `${from + i}\t${l.length > max ? `${l.slice(0, max)}…` : l}`)
    .join('\n');

/**
 * Which definition `want` names: `Outer.inner` for one inside another, else the exact name, else any
 * case. All matches, in file order.
 */
export function findSymbol(file: string, lines: string[], syms: Sym[], want: string): Sym[] {
  const dot = want.lastIndexOf('.');
  if (dot > 0) {
    const outer = findSymbol(file, lines, syms, want.slice(0, dot));
    const name = want.slice(dot + 1);
    return outer.flatMap((o) => {
      const r = symbolRange(file, lines, syms, o);
      return syms.filter((s) => s !== o && s.name === name && s.line > o.line && s.line <= r.end);
    });
  }
  const exact = syms.filter((s) => s.name === want);
  return exact.length ? exact : syms.filter((s) => s.name.toLowerCase() === want.toLowerCase());
}

/** Overlapping or touching windows of ±READ_LIMITS.window lines around `hits`, merged, in file order. */
export function windows(hits: number[], count: number): [number, number][] {
  const w = READ_LIMITS.window;
  const out: [number, number][] = [];
  for (const h of [...hits].sort((a, b) => a - b)) {
    const a = Math.max(1, h - w);
    const b = Math.min(count, h + w);
    const last = out.at(-1);
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** Text that fits a token budget: adds parts while they fit, says how many did not. */
export class Budget {
  used = 0;
  constructor(readonly limit: number) {}
  fits(text: string): boolean {
    return this.used + estimateTokens(text) + 1 <= this.limit;
  }
  take(text: string): void {
    this.used += estimateTokens(text) + 1;
  }
}

/** What each chat has been shown of each file: the content hash (a Merkle leaf) and that version's text, for index_diff. */
export class SeenFiles {
  static readonly MAX_CHATS = 32;
  static readonly MAX_FILES = 300;
  static readonly MAX_BYTES = 16 * 1024 * 1024;
  // ponytail: whole texts in memory, LRU per chat; keep only hashes and fetch old text from git if memory ever matters.
  private readonly chats = new Map<string, { files: Map<string, { hash: string; text: string }>; bytes: number }>();

  get(chatId: string, abs: string): { hash: string; text: string } | undefined {
    return this.chats.get(chatId)?.files.get(abs);
  }

  set(chatId: string, abs: string, hash: string, text: string): void {
    let c = this.chats.get(chatId);
    this.chats.delete(chatId);
    c ??= { files: new Map(), bytes: 0 };
    this.chats.set(chatId, c);
    if (this.chats.size > SeenFiles.MAX_CHATS) this.chats.delete(this.chats.keys().next().value!);
    const old = c.files.get(abs);
    if (old) (c.bytes -= old.text.length, c.files.delete(abs));
    c.files.set(abs, { hash, text });
    c.bytes += text.length;
    while (c.files.size > SeenFiles.MAX_FILES || c.bytes > SeenFiles.MAX_BYTES) {
      const [k, v] = c.files.entries().next().value!;
      c.files.delete(k);
      c.bytes -= v.text.length;
    }
  }

  forget(chatId: string): void {
    this.chats.delete(chatId);
  }
}
