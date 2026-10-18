import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCall } from '../src/bridge/protocol';
import { symbolRange } from '../src/host/indexReads';
import { answerIndex, outline, ProjectIndex } from '../src/host/projectIndex';
import { estimateTokens } from '../src/shared/tokens';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fl-reads-'));
  dirs.push(root);
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), text);
  }
  return root;
}

async function build(root: string): Promise<ProjectIndex> {
  const ix = new ProjectIndex(root, { maxFiles: 1000, maxBytes: 50 * 1024 * 1024 });
  for (const f of await ix.list()) await ix.update(f);
  return ix;
}

const filler = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `  const ${tag}${i} = ${i}; // filler line ${i}`).join('\n');
const BIG = [
  "import { x } from './x';",
  '',
  '/** Adds two numbers. */',
  'export function add(a: number, b: number): number {',
  filler(5, 'a'),
  '  return a + b;',
  '}',
  '',
  'export class Box {',
  '  private items: string[] = [];',
  '  put(item: string): void {',
  "    const s = `{${item}`; // a brace in a string",
  '    this.items.push(s);',
  '  }',
  '',
  '  take(): string | undefined {',
  filler(3, 't'),
  '    return this.items.pop();',
  '  }',
  '}',
  '',
  'export type Call =',
  "  | { tool: 'a'; n: number }",
  "  | { tool: 'b' };",
  '',
  'export function long() {',
  filler(300, 'l'),
  '}',
  '',
].join('\n');

describe('symbolRange', () => {
  const lines = BIG.split('\n');
  const syms = outline('big.ts', BIG);
  const range = (name: string) => {
    const s = syms.find((x) => x.name === name)!;
    const r = symbolRange('big.ts', lines, syms, s);
    return lines.slice(r.start - 1, r.end);
  };

  it('takes a function with its doc comment, a method, a class and a multi-line type', () => {
    expect(range('add')[0]).toBe('/** Adds two numbers. */');
    expect(range('add').at(-1)).toBe('}');
    expect(range('add').length).toBe(9);
    expect(range('put')).toEqual(lines.slice(14, 18));
    expect(range('Box')[0]).toBe('export class Box {');
    expect(range('Box').at(-1)).toBe('}');
    expect(range('Call')).toEqual(["export type Call =", "  | { tool: 'a'; n: number }", "  | { tool: 'b' };"]);
  });

  it('follows indentation in Python', () => {
    const py = 'class A:\n    def f(self):\n        return 1\n\n    def g(self):\n        if x:\n            return 2\n        return 3\n\ndef top():\n    pass\n';
    const pl = py.split('\n');
    const ps = outline('a.py', py);
    const r = symbolRange('a.py', pl, ps, ps.find((s) => s.name === 'g')!);
    expect(pl.slice(r.start - 1, r.end)).toEqual(['    def g(self):', '        if x:', '            return 2', '        return 3']);
    const a = symbolRange('a.py', pl, ps, ps[0]);
    expect(a.end).toBe(8);
  });
});

describe('index_read', () => {
  it('returns one symbol, a line range, or a small file whole; a big file gives an outline only', async () => {
    const root = await project({ 'src/big.ts': BIG, 'src/small.ts': 'export const one = 1;\nexport const two = 2;\n' });
    const ix = await build(root);
    const sym = await answerIndex([ix], { tool: 'index_read', path: 'src/big.ts', symbol: 'take' }, false);
    expect(sym).toContain('return this.items.pop();');
    expect(sym).not.toContain('this.items.push');
    expect(sym).toMatch(/^src\/big\.ts · \d+ lines/);
    expect(sym).toMatch(/\n\d+\t  take\(\): string \| undefined \{/);

    expect(await answerIndex([ix], { tool: 'index_read', path: 'src/big.ts', symbol: 'Box.take' }, false)).toContain('return this.items.pop();');

    const range = await answerIndex([ix], { tool: 'index_read', path: 'src/big.ts', lines: [4, 6] }, false);
    expect(range.split('\n').slice(1)).toEqual(['4\texport function add(a: number, b: number): number {', '5\t  const a0 = 0; // filler line 0', '6\t  const a1 = 1; // filler line 1']);

    const whole = await answerIndex([ix], { tool: 'index_read', path: 'src/small.ts' }, false);
    expect(whole).toContain('1\texport const one = 1;\n2\texport const two = 2;');

    const big = await answerIndex([ix], { tool: 'index_read', path: 'src/big.ts' }, false);
    expect(big).not.toContain('filler line');
    expect(big).toContain('export function add(a: number, b: number): number');
    expect(big).toMatch(/symbol|lines/);

    expect(await answerIndex([ix], { tool: 'index_read', path: 'src/big.ts', symbol: 'nope' }, false)).toMatch(/No definition named "nope" in src\/big\.ts/);
    // A long body is cut with where to go on from.
    const long = await answerIndex([ix], { tool: 'index_read', path: 'src/big.ts', symbol: 'long' }, false);
    expect(long).toMatch(/cut at line \d+; pass lines: \[\d+, \d+\] for more/);
  });

  it('never reads secrets, ignored, excluded or symlinked files', async () => {
    const root = await project({ '.env': 'TOKEN=secret', 'gen/a.ts': 'secret', 'src/a.ts': 'ok' });
    await symlink('/etc/hosts', path.join(root, 'src/link.ts'));
    const ix = new ProjectIndex(root, { maxFiles: 1000, maxBytes: 1e8, exclude: ['gen'] });
    for (const f of await ix.list()) await ix.update(f);
    for (const p of ['.env', 'gen/a.ts', 'src/link.ts', 'nope.ts']) {
      const out = await answerIndex([ix], { tool: 'index_read', path: p }, false);
      expect(out, p).toContain('is not in the index');
      expect(out).not.toContain('secret');
    }
    expect(parseCall('index_read', { path: '../x' })).toBeNull();
    expect(parseCall('index_read', { path: 'a.ts', lines: [5, 2] })).toBeNull();
    expect(parseCall('index_read', { path: 'a.ts', symbol: 'x', lines: [1, 2] })).toBeNull();
    expect(parseCall('index_read', { path: 'a.ts', lines: [1, 2] })).toEqual({ tool: 'index_read', path: 'a.ts', lines: [1, 2] });
  });
});

describe('compact outline', () => {
  it('lists signatures with line numbers, nothing else', async () => {
    const root = await project({ 'src/big.ts': BIG });
    const ix = await build(root);
    const out = await answerIndex([ix], { tool: 'index_outline', path: 'src/big.ts' }, false);
    expect(out).toContain('4: export function add(a: number, b: number): number');
    expect(out).toContain('15:   put(item: string): void');
    expect(out).not.toContain('(line ');
    expect(out).not.toContain('filler');
  });
});

describe('index_search windows', () => {
  it('returns ranked ±3-line windows, merged and deduped, within a token budget', async () => {
    const body = (tag: string) => [...Array.from({ length: 20 }, (_, i) => `// ${tag} pad ${i}`), 'export function refreshToken(t: string) {', '  return rotate(t);', '}', ...Array.from({ length: 20 }, (_, i) => `// ${tag} tail ${i}`)].join('\n');
    const root = await project({
      'src/auth.ts': body('auth'),
      'src/copy.ts': body('auth').replace(/auth/g, 'auth'),
      ...Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`src/m${i}.ts`, `// refresh token note ${i}\n${'x\n'.repeat(50)}`])),
    });
    const ix = await build(root);
    const out = await answerIndex([ix], { tool: 'index_search', query: 'refreshToken', budget: 200 }, false);
    expect(out).toMatch(/^src\/(auth|copy)\.ts/);
    expect(out).toContain('21\texport function refreshToken(t: string) {');
    expect(out).toContain('18\t// auth pad 17');
    expect(out).not.toContain('// auth pad 16');
    // The same window in a second file is named, not repeated.
    expect(out.match(/export function refreshToken/g)!.length).toBe(1);
    expect(out).toMatch(/same lines as src\/(auth|copy)\.ts/);
    expect(estimateTokens(out)).toBeLessThanOrEqual(200);
    expect(out).toMatch(/More matches: /);
    expect(parseCall('index_search', { query: 'x', budget: 50 })).toBeNull();
    expect(parseCall('index_search', { query: 'x', budget: 500 })).toEqual({ tool: 'index_search', query: 'x', budget: 500 });
  });
});
