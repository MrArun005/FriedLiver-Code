// Token benchmark: scripted agent tasks replayed as tool-call traces, two ways. "Without" uses what
// an agent has without FriedLiver's index: grep (content mode, line numbers, 100 lines at most) and
// whole-file reads (line-numbered, 2,000 lines at most, like Claude Code's Read). "With" uses the
// index_* tools exactly as the tools server answers them (answerIndex). The tokens of every tool
// result are counted, with js-tiktoken's cl100k_base when it is installed (CI), else estimateTokens.
//
// It always runs on a copy of this extension's own sources (small, local). With FL_TOKEN_BENCH_REPO
// set (CI: .github/workflows/index-bench.yml clones microsoft/TypeScript v6.0.3) it also runs on that
// repo. It edits files in the repo it runs on: point it at a throwaway clone only.
import { cp, mkdtemp, readdir, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SeenFiles, symbolRange } from '../src/host/indexReads';
import { answerIndex, outline, ProjectIndex, projectPrimer, STAT_BATCH, type IndexCall, type IndexContext } from '../src/host/projectIndex';
import { compactOutput } from '@friedliver/main/agents/terminals';
import { handoffContext, rewoundHistory } from '../src/host/transcript';
import { longChat } from './fixtures/chats';
import { imageTokens, shotParams } from '../src/host/browserRules';
import { extractPage, PageMemory, renderPage, SNAPSHOT_LIMITS } from '../src/host/pageText';
import { estimateTokens } from '../src/shared/tokens';
import { fakeVisible, oldSnapshot, parseHtml } from './fakeDom';

type Counter = { name: string; count(text: string): number };

async function counter(): Promise<Counter> {
  try {
    const mod = (await import(/* @vite-ignore */ 'js-tiktoken' as string)) as { getEncoding(name: string): { encode(t: string): number[] } };
    const enc = mod.getEncoding('cl100k_base');
    return { name: 'cl100k_base (js-tiktoken)', count: (t) => enc.encode(t).length };
  } catch {
    return { name: 'estimate (estimateTokens, ~10% of cl100k)', count: estimateTokens };
  }
}

export interface Row {
  category: string;
  task: string;
  without: number;
  with: number;
  calls: [number, number];
}
export const rows: Row[] = [];
/** Wall time of the new work FriedLiver does, for the load-time table. */
const timings: { what: string; ms: number }[] = [];
const timed = async <T>(what: string, fn: () => T | Promise<T>): Promise<T> => {
  const t = performance.now();
  const out = await fn();
  timings.push({ what, ms: performance.now() - t });
  return out;
};
let tokens: Counter;

/** One arm of a task: every tool result it got, counted. */
class Arm {
  total = 0;
  calls = 0;
  log: string[] = [];
  take(tool: string, out: string): string {
    this.total += tokens.count(out);
    this.calls++;
    this.log.push(`=== ${tool} (${tokens.count(out)} tokens)\n${out}`);
    return out;
  }
}

/** What an agent sees without the index. */
class Raw {
  constructor(
    readonly root: string,
    readonly files: string[],
    readonly arm: Arm,
  ) {}

  async grep(pattern: RegExp): Promise<{ path: string; line: number }[]> {
    const hits: { path: string; line: number; text: string }[] = [];
    for (const rel of this.files) {
      if (hits.length >= 100) break;
      const text = await readFile(path.join(this.root, rel), 'utf8').catch(() => '');
      text.split('\n').forEach((l, i) => {
        if (hits.length < 100 && pattern.test(l)) hits.push({ path: rel, line: i + 1, text: l });
      });
    }
    this.arm.take('grep', hits.map((h) => `${h.path}:${h.line}:${h.text}`).join('\n'));
    return hits;
  }

  async read(rel: string): Promise<string> {
    const text = await readFile(path.join(this.root, rel), 'utf8');
    const lines = text.split('\n').slice(0, 2000);
    this.arm.take('read', lines.map((l, i) => `${String(i + 1).padStart(6)}\t${l.slice(0, 2000)}`).join('\n'));
    return text;
  }

  edit(rel: string): void {
    this.arm.take('edit', `The file ${rel} has been updated.`);
  }
}

/** What an agent sees with the index. */
class Indexed {
  constructor(
    readonly ix: ProjectIndex,
    readonly arm: Arm,
    readonly ctx: IndexContext,
  ) {}

  async call(call: IndexCall): Promise<string> {
    return this.arm.take(call.tool, await answerIndex([this.ix], call, false, this.ctx));
  }

  edit(rel: string): void {
    this.arm.take('edit', `The file ${rel} has been updated.`);
  }
}

async function buildIndex(root: string): Promise<ProjectIndex> {
  const ix = new ProjectIndex(root, { maxFiles: 1_000_000, maxBytes: 8 * 1024 ** 3 });
  const files = await ix.list();
  for (let i = 0; i < files.length; i += STAT_BATCH) await ix.updateBatch(files.slice(i, i + STAT_BATCH));
  return ix;
}

/** Where a definition is, from the index (the ground truth both arms end up at). */
function locate(ix: ProjectIndex, symbol: string): string {
  const hits = ix.symbols(symbol, 50).filter((h) => h.sym.name === symbol);
  if (!hits.length) throw new Error(`No definition of ${symbol} in the bench repo`);
  return hits[0].rel;
}

/** A small, real edit inside a definition: a line after its first, the same in both arms. */
async function editInside(root: string, rel: string, symbol: string, tag: string): Promise<void> {
  const abs = path.join(root, rel);
  const text = await readFile(abs, 'utf8');
  const lines = text.split('\n');
  const syms = outline(rel, text);
  const sym = syms.find((s) => s.name === symbol)!;
  const at = symbolRange(rel, lines, syms, sym).end - 1;
  lines.splice(at, 0, `  // ${tag}: changed by the token bench`);
  await writeFile(abs, lines.join('\n'));
}

export interface CodeTasks {
  label: string;
  /** Task 1: find where this is defined and change it. */
  find: string;
  /** Task 2: these three definitions changed; then update the tests found by this query / grep. */
  edited: [string, string, string];
  testQuery: string;
  testGrep: RegExp;
  /** Task 3: explain the module defining this, reading these two of its definitions. */
  module: string;
  moduleSymbols: [string, string];
}

/** Runs the three code tasks on `root`, both arms, and records rows. Restores every file it edits. */
async function codeTasks(root: string, t: CodeTasks): Promise<void> {
  const ix = await buildIndex(root);
  await timed(`Project map for a first message (${t.label}, ${ix.size.toLocaleString('en-US')} files)`, () => projectPrimer([ix], `fix ${t.find} and update its tests`, 1500));
  const defFile = locate(ix, t.find);
  await timed(`index_read of one symbol (${t.label})`, () => answerIndex([ix], { tool: 'index_read', path: defFile, symbol: t.find }, false));
  await timed(`index_search with windows (${t.label})`, () => answerIndex([ix], { tool: 'index_search', query: t.testQuery }, false));
  const files = [...ix.paths()].sort();
  const originals = new Map<string, string>();
  const keep = async (rel: string) => {
    if (!originals.has(rel)) originals.set(rel, await readFile(path.join(root, rel), 'utf8'));
  };
  const restore = async () => {
    for (const [rel, text] of originals) {
      await writeFile(path.join(root, rel), text);
      await ix.update(rel);
    }
  };
  const run = async (task: string, without: (raw: Raw) => Promise<void>, withIx: (ixd: Indexed) => Promise<void>) => {
    const a = new Arm();
    await without(new Raw(root, files, a));
    await restore();
    const b = new Arm();
    await withIx(new Indexed(ix, b, { chatId: 'bench', seen: new SeenFiles() }));
    await restore();
    rows.push({ category: `Code (${t.label})`, task, without: a.total, with: b.total, calls: [a.calls, b.calls] });
    if (process.env.FL_TOKEN_BENCH_TRACE) await appendFile(process.env.FL_TOKEN_BENCH_TRACE, `##### ${task}\n## without\n${a.log.join('\n')}\n## with\n${b.log.join('\n')}\n`);
  };

  const defRe = (s: string) => new RegExp(`(function|class|interface|type|const|let|def|fn|func)\\s+${s}\\b`);

  await run(
    `Find where ${t.find} is defined and change it`,
    async (raw) => {
      const [hit] = await raw.grep(defRe(t.find));
      await raw.read(hit.path);
      await keep(hit.path);
      await editInside(root, hit.path, t.find, 'find');
      raw.edit(hit.path);
    },
    async (ixd) => {
      const out = await ixd.call({ tool: 'index_symbols', name: t.find });
      const rel = out.split(':')[0];
      await ixd.call({ tool: 'index_read', path: rel, symbol: t.find });
      await keep(rel);
      await editInside(root, rel, t.find, 'find');
      ixd.edit(rel);
    },
  );

  const edited = t.edited.map((s) => ({ symbol: s, rel: locate(ix, s) }));
  const testFile = ix.search(t.testQuery, 20).find((h) => /test/i.test(h.rel))?.rel;
  if (!testFile) throw new Error(`No test file matches ${t.testQuery}`);
  const editAll = async () => {
    for (const e of edited) {
      await keep(e.rel);
      await editInside(root, e.rel, e.symbol, 'task2');
      await ix.update(e.rel);
    }
  };
  await run(
    'After 3 files changed, update the tests',
    async (raw) => {
      await editAll();
      // The agent knew the files before; now it reads them again to see what changed.
      for (const e of edited) await raw.read(e.rel);
      const hits = await raw.grep(t.testGrep);
      await raw.read(hits.find((h) => h.path === testFile)?.path ?? testFile);
      await keep(testFile);
      await writeFile(path.join(root, testFile), `${await readFile(path.join(root, testFile), 'utf8')}\n// bench test update\n`);
      raw.edit(testFile);
    },
    async (ixd) => {
      // It saw these files earlier in the chat (an observed read), before they changed.
      for (const e of edited) {
        const got = (await ix.readChecked(e.rel))!;
        ixd.ctx.seen.set('bench', path.join(root, e.rel), got.hash, got.text);
      }
      ix.tree.pin('bench');
      await editAll();
      await ixd.call({ tool: 'index_changes', since: 'last_turn' });
      for (const e of edited) await ixd.call({ tool: 'index_diff', path: e.rel });
      const found = await ixd.call({ tool: 'index_search', query: t.testQuery });
      // The window the search showed for the test file, then 60 lines around it.
      const block = found.split('\n\n').find((b) => b.startsWith(testFile));
      const line = Number(/\n(\d+)\t/.exec(block ?? '')?.[1] ?? 1);
      await ixd.call({ tool: 'index_read', path: testFile, lines: [Math.max(1, line - 20), line + 40] });
      await keep(testFile);
      await writeFile(path.join(root, testFile), `${await readFile(path.join(root, testFile), 'utf8')}\n// bench test update\n`);
      ixd.edit(testFile);
    },
  );

  const mod = locate(ix, t.module);
  const related = ix.related(mod)!.imports.find((r) => !r.endsWith('(external)') && ix.has(r));
  await run(
    `Explain the module that defines ${t.module}`,
    async (raw) => {
      await raw.read(mod);
      if (related) await raw.read(related);
    },
    async (ixd) => {
      await ixd.call({ tool: 'index_outline', path: mod });
      await ixd.call({ tool: 'index_related', path: mod });
      for (const s of t.moduleSymbols) await ixd.call({ tool: 'index_read', path: mod, symbol: s });
    },
  );
}

/** This extension's own sources: always available, small. */
const OWN: CodeTasks = {
  label: 'this extension',
  find: 'tokenize',
  edited: ['nodeHash', 'splitLines', 'estimateTokens'],
  testQuery: 'MerkleTree snapshot diff roots',
  testGrep: /MerkleTree/,
  module: 'MerkleTree',
  moduleSymbols: ['diff', 'snapshot'],
};

/** microsoft/TypeScript v6.0.3 (CI). */
const TYPESCRIPT: CodeTasks = {
  label: 'TypeScript v6.0.3',
  find: 'isIdentifierStart',
  edited: ['createScanner', 'resolveModuleName', 'parseCommandLine'],
  testQuery: 'parseCommandLine unittests',
  testGrep: /parseCommandLine/,
  module: 'nodeModuleNameResolver',
  moduleSymbols: ['nodeModuleNameResolver', 'resolveModuleName'],
};

const dirs: string[] = [];

afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  if (!rows.length) return;
  const fmt = (n: number) => n.toLocaleString('en-US');
  const pct = (r: { without: number; with: number }) => (r.without ? `${(100 * (1 - r.with / r.without)).toFixed(0)}%` : '–');
  const lines = [
    `Token bench: tokens of tool results, ${tokens.name}`,
    '',
    '| Category | Task | Without | With | Saved | Calls (without/with) |',
    '|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.category} | ${r.task} | ${fmt(r.without)} | ${fmt(r.with)} | ${fmt(r.without - r.with)} (${pct(r)}) | ${r.calls[0]}/${r.calls[1]} |`),
  ];
  const cats = [...new Set(rows.map((r) => r.category))];
  lines.push('', '| Category | Without | With | Saved |', '|---|---|---|---|');
  for (const c of cats) {
    const rs = rows.filter((r) => r.category === c);
    const sum = { without: rs.reduce((n, r) => n + r.without, 0), with: rs.reduce((n, r) => n + r.with, 0) };
    lines.push(`| ${c} | ${fmt(sum.without)} | ${fmt(sum.with)} | ${fmt(sum.without - sum.with)} (${pct(sum)}) |`);
  }
  const all = { without: rows.reduce((n, r) => n + r.without, 0), with: rows.reduce((n, r) => n + r.with, 0) };
  lines.push(`| **Total** | ${fmt(all.without)} | ${fmt(all.with)} | ${fmt(all.without - all.with)} (${pct(all)}) |`);
  if (timings.length) lines.push('', '| New work | Time |', '|---|---|', ...timings.map((t) => `| ${t.what} | ${t.ms.toFixed(1)} ms |`));
  const table = lines.join('\n');
  console.log(table);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${table}\n`);
  if (process.env.FL_TOKEN_BENCH_OUT) await writeFile(process.env.FL_TOKEN_BENCH_OUT, `${table}\n`);
});

describe('token bench: code', () => {
  it('uses fewer tokens with the index on this extension\'s own sources', async () => {
    tokens ??= await counter();
    const root = await mkdtemp(path.join(os.tmpdir(), 'fl-tokbench-'));
    dirs.push(root);
    const here = path.resolve(__dirname, '..');
    await cp(path.join(here, 'src'), path.join(root, 'src'), { recursive: true });
    await cp(path.join(here, 'test/merkle.test.ts'), path.join(root, 'test/merkle.test.ts'));
    await cp(path.join(here, 'test/projectIndex.test.ts'), path.join(root, 'test/projectIndex.test.ts'));
    const before = rows.length;
    await codeTasks(root, OWN);
    for (const r of rows.slice(before)) expect(r.with, r.task).toBeLessThan(r.without);
  }, 120_000);

  it.skipIf(!process.env.FL_TOKEN_BENCH_REPO)('uses fewer tokens with the index on a pinned real repo', async () => {
    tokens ??= await counter();
    const before = rows.length;
    await codeTasks(process.env.FL_TOKEN_BENCH_REPO!, TYPESCRIPT);
    for (const r of rows.slice(before)) expect(r.with, r.task).toBeLessThan(r.without);
  }, 900_000);
});

/** A parsed page both ways: what the old browser_snapshot returned, and the new one's data. */
function pageBoth(html: string, url: string) {
  const { document, title } = parseHtml(html);
  const old = oldSnapshot(document, title, url);
  return { old, data: extractPage(document as never, fakeVisible as never, { title, url, start: 0 }) };
}

describe('token bench: browser', () => {
  const row = (task: string, without: string, withText: string) => rows.push({ category: 'Browser', task, without: tokens.count(without), with: tokens.count(withText), calls: [1, 1] });

  it('reads pages, re-reads a changed one, and finds what to click with fewer tokens', async () => {
    tokens ??= await counter();
    const html = await readFile(path.join(__dirname, 'fixtures/pages/docs-webhooks.html'), 'utf8');
    const url = 'https://docs.example.com/guides/webhooks';
    const a = pageBoth(html, url);
    const before = rows.length;
    // The whole main content (the largest budget), not the default cut.
    row('Read a docs page (fixture)', a.old, renderPage(a.data, { budget: SNAPSHOT_LIMITS.maxBudget }));
    const mem = new PageMemory();
    mem.answer('bench', a.data, {});
    const b = pageBoth(html.replace('every 6 hours for up to 3 days', 'every 12 hours for up to 5 days'), url);
    row('Re-read it after one paragraph changed', b.old, mem.answer('bench', b.data, {}));
    row('Find the button to click', a.old, renderPage(a.data, { elements: true }));
    for (const r of rows.slice(before)) expect(r.with, r.task).toBeLessThan(r.without);
  });

  it.skipIf(!process.env.FL_TOKEN_BENCH_PAGES)('reads pinned real pages (web.archive.org snapshots) with fewer tokens', async () => {
    tokens ??= await counter();
    const dir = process.env.FL_TOKEN_BENCH_PAGES!;
    for (const f of (await readdir(dir)).filter((n) => n.endsWith('.html')).sort()) {
      const html = await readFile(path.join(dir, f), 'utf8');
      const { old, data } = await timed(`Page text for ${f} (parse + extract, in Node; the browser skips the parse)`, () => pageBoth(html, 'https://example.invalid/'));
      row(`Read ${f.replace(/\.html$/, '')} (archived page)`, old, renderPage(data, { budget: SNAPSHOT_LIMITS.maxBudget }));
    }
  });
});

describe('token bench: screenshots', () => {
  it('costs fewer image tokens (Claude: w×h/750 after its own fit) at the default size and cropped to an element', () => {
    // A 1280×800 viewport on a 2× screen: the old capture was a full-resolution PNG, 2560×1600.
    const view = { width: 1280, height: 800, dpr: 2 };
    const old = imageTokens(2560, 1600);
    const whole = shotParams(view, {}).size;
    const button = shotParams(view, { rect: { x: 600, y: 400, width: 120, height: 36 } }).size;
    const panel = shotParams(view, { rect: { x: 200, y: 150, width: 640, height: 360 } }).size;
    const before = rows.length;
    rows.push({ category: 'Screenshots (formula)', task: 'Screenshot of the page (1280×800 at 2×)', without: old, with: imageTokens(whole.width, whole.height), calls: [1, 1] });
    rows.push({ category: 'Screenshots (formula)', task: 'Screenshot to check one button', without: old, with: imageTokens(button.width, button.height), calls: [1, 1] });
    rows.push({ category: 'Screenshots (formula)', task: 'Screenshot to check one panel', without: old, with: imageTokens(panel.width, panel.height), calls: [1, 1] });
    for (const r of rows.slice(before)) expect(r.with, r.task).toBeLessThan(r.without);
  });
});

describe('token bench: command output', () => {
  it('compacts long, colored and repetitive output', async () => {
    tokens ??= await counter();
    const esc = '\x1b[';
    const verbose = Array.from({ length: 1500 }, (_, i) => `${esc}32m ✓${esc}39m src/module${i % 40}.test.ts > suite ${i % 40} > case ${i} ${esc}2m(${i % 7}ms)${esc}22m`).join('\n') +
      `\n\n Test Files  40 passed (40)\n      Tests  1500 passed (1500)\n   Duration  12.3s\n`;
    const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧'];
    const build = Array.from({ length: 300 }, (_, i) => `${spinner[i % 8]} Compiling ${i}/300 modules\r`).join('') + '\n' +
      Array.from({ length: 60 }, () => `${esc}33mwarning${esc}0m: 'url.parse()' is deprecated; use the WHATWG URL API`).join('\n') + '\nBuild finished in 8.2s\n';
    const failure = ['FAIL src/parse.test.ts > parses dates', 'TypeError: Cannot read properties of undefined (reading \'getTime\')',
      '    at parseDate (/app/src/parse.ts:41:17)',
      ...Array.from({ length: 25 }, (_, i) => `    at Object.<anonymous> (/app/node_modules/vitest/dist/chunk-${i}.js:${100 + i}:${i})`),
      '    at runTest (/app/src/test-utils.ts:12:3)',
      ...Array.from({ length: 8 }, (_, i) => `    at process.processTicksAndRejections (node:internal/process/task_queues:${95 + i}:5)`),
    ].join('\n').repeat(6);
    const before = rows.length;
    for (const [task, raw] of [['A test run, 1,500 passing lines', verbose], ['A build with a spinner and repeated warnings', build], ['Six failures with deep stack traces', failure]] as const) {
      rows.push({ category: 'Command output', task, without: tokens.count(raw), with: tokens.count(compactOutput(raw, undefined, '/storage/output/term-1.txt').text), calls: [1, 1] });
    }
    for (const r of rows.slice(before)) expect(r.with, r.task).toBeLessThan(r.without);
  });
});

describe('token bench: hand-off', () => {
  it('hands a long chat over as a compact summary instead of its transcript', async () => {
    tokens ??= await counter();
    const c = longChat();
    // Before: the transcript (up to 24,000 characters), as hand-offs carried it, plus the same plan/commands/files sections.
    rows.push({ category: 'Hand-off', task: 'Hand a 40-turn chat to another agent', without: tokens.count(rewoundHistory(c, c.items)), with: tokens.count(handoffContext(c, { 'src/limiter.ts': '1a2b3c4d' })), calls: [1, 1] });
    expect(rows.at(-1)!.with).toBeLessThan(rows.at(-1)!.without);
  });
});
