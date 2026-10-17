import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { handle } from '../src/bridge/mcp';
import { parseCall } from '../src/bridge/protocol';
import { answerIndex, globToRegex, imports, INDEX_LIMITS, isSecret, outline, ProjectIndex, tokenize } from '../src/host/projectIndex';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function project(files: Record<string, string>, git = false): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fl-index-'));
  dirs.push(root);
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), text);
  }
  if (git) execFileSync('git', ['init', '-q'], { cwd: root });
  return root;
}

async function build(root: string, opts: Partial<ConstructorParameters<typeof ProjectIndex>[1]> = {}): Promise<ProjectIndex> {
  const ix = new ProjectIndex(root, { maxFiles: 1000, maxBytes: 50 * 1024 * 1024, ...opts });
  for (const f of await ix.list()) await ix.update(f);
  return ix;
}

describe('tokenizer and ranking', () => {
  it('splits identifiers into their parts', () => {
    expect(tokenize('getUserName parse_HTTPResponse x')).toEqual(['getusername', 'get', 'user', 'name', 'parse_httpresponse', 'parse', 'http', 'response']);
  });

  it('ranks the file that defines and uses a term above one that mentions it once', async () => {
    const root = await project({
      'src/auth/refresh.ts': 'export function refreshToken(token: string) {\n  return rotateRefreshToken(token);\n}\nconst refreshTokenTtl = 3600;\n',
      'src/other.ts': 'import { x } from "./x";\n// see refresh docs\nexport const unrelated = 1;\n',
      'src/x.ts': 'export const x = 1;\n',
    });
    const ix = await build(root);
    const hits = ix.search('refreshToken', 10);
    expect(hits[0].rel).toBe('src/auth/refresh.ts');
    expect(hits[0].symbols.map((s) => s.name)).toContain('refreshToken');
    const out = await answerIndex([ix], { tool: 'index_search', query: 'refreshToken' }, false);
    expect(out).toMatch(/^src\/auth\/refresh\.ts/);
    expect(out).toContain('1: export function refreshToken');
    expect(out).not.toContain(root);
  });

  it('outlines and finds imports for common languages', () => {
    expect(outline('a.py', 'class Foo:\n    def bar(self):\n        pass\n').map((s) => `${s.kind} ${s.name}`)).toEqual(['class Foo', 'def bar']);
    expect(outline('a.go', 'func (s *S) Run() {}\ntype Thing struct{}\n').map((s) => s.name)).toEqual(['Run', 'Thing']);
    expect(imports('a.ts', "import a from './a';\nconst b = require('../b');\nexport * from \"c\";")).toEqual(['./a', 'c', '../b']);
    expect(imports('a.py', 'from .models import X\nimport os.path\n')).toEqual(['.models', 'os.path']);
  });

  it('answers symbols, outline and related with workspace-relative paths', async () => {
    const root = await project({ 'src/a.ts': "import { b } from './b';\nexport class Alpha {}\n", 'src/b.ts': 'export function b() {}\n' });
    const ix = await build(root);
    expect(await answerIndex([ix], { tool: 'index_symbols', name: 'alpha' }, false)).toBe('src/a.ts:2  class Alpha');
    expect(await answerIndex([ix], { tool: 'index_outline', path: 'src/b.ts' }, false)).toContain('function b  (line 1)');
    const related = await answerIndex([ix], { tool: 'index_related', path: 'src/b.ts' }, false);
    expect(related).toContain('Imported by:\n  src/a.ts');
    expect(await answerIndex([ix], { tool: 'index_related', path: 'src/a.ts' }, false)).toContain('Imports:\n  src/b.ts');
  });
});

describe('what is never indexed', () => {
  it('respects .gitignore and files.exclude, and drops secrets, binaries and big files', async () => {
    const root = await project(
      {
        '.gitignore': 'ignored/\n',
        'ignored/a.ts': 'secretword',
        'gen/b.ts': 'secretword',
        '.env': 'secretword',
        '.env.local': 'secretword',
        'certs/server.pem': 'secretword',
        'keys/id_rsa': 'secretword',
        'app.key': 'secretword',
        'node_modules/x/index.js': 'secretword',
        'bin.dat': 'secretword\0\0',
        'big.ts': `secretword ${'x'.repeat(INDEX_LIMITS.fileBytes)}`,
        'ok.ts': 'secretword',
      },
      true,
    );
    const ix = await build(root, { exclude: ['gen'] });
    expect(ix.search('secretword', 50).map((h) => h.rel)).toEqual(['ok.ts']);
    expect(isSecret('/x/.env.production')).toBe(true);
    expect(isSecret('environment.ts')).toBe(false);
    expect(globToRegex('**/*.min.js').test('a/b/c.min.js')).toBe(true);
    // Even when asked directly (a watcher event), a secret is not indexed.
    await ix.update('.env');
    expect(ix.has('.env')).toBe(false);
  });

  it('does not follow symlinks out of the folder', async () => {
    const outside = await project({ 'leak.ts': 'outsideonly' });
    const root = await project({ 'in.ts': 'inside' });
    await symlink(path.join(outside, 'leak.ts'), path.join(root, 'link.ts'));
    await symlink(outside, path.join(root, 'linkdir'));
    const ix = await build(root);
    await ix.update('linkdir/leak.ts');
    await ix.update('../' + path.basename(outside) + '/leak.ts');
    expect(ix.search('outsideonly', 10)).toEqual([]);
    expect(ix.has('in.ts')).toBe(true);
  });
});

describe('incremental updates and caps', () => {
  it('picks up changes and deletions, and survives a save and load', async () => {
    const root = await project({ 'a.ts': 'export const zebra = 1;\n' });
    const ix = await build(root);
    await writeFile(path.join(root, 'a.ts'), 'export const quokka = 2;\n// more\n');
    await ix.update('a.ts');
    expect(ix.search('zebra', 5)).toEqual([]);
    expect(ix.search('quokka', 5)[0].rel).toBe('a.ts');
    const copy = new ProjectIndex(root, { maxFiles: 10, maxBytes: 1e8 });
    copy.load(JSON.parse(JSON.stringify(ix)));
    expect(copy.search('quokka', 5)[0].rel).toBe('a.ts');
    await rm(path.join(root, 'a.ts'));
    await ix.update('a.ts');
    expect(ix.size).toBe(0);
  });

  it('stops at the file cap', async () => {
    const root = await project(Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`f${i}.ts`, 'word'])));
    const ix = await build(root, { maxFiles: 3 });
    expect(ix.size).toBe(3);
    expect(ix.capped).toBe(true);
  });

  it('caps tool output and results', async () => {
    const line = `needle ${'y'.repeat(500)}\n`;
    const root = await project(Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`f${i}.ts`, line.repeat(5)])));
    const ix = await build(root);
    const out = await answerIndex([ix], { tool: 'index_search', query: 'needle', limit: 50 }, false);
    expect(out.length).toBeLessThanOrEqual(INDEX_LIMITS.output + 100);
    for (const l of out.split('\n')) expect(l.length).toBeLessThanOrEqual(INDEX_LIMITS.line + 20);
  });
});

describe('the index_* tools on the tools server', () => {
  it('are listed read-only and reject paths outside the workspace', () => {
    expect(handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'index_search', arguments: { query: 'x' } } })).toEqual({ call: 'index_search', args: { query: 'x' }, id: 1 });
    for (const p of ['/etc/passwd', '../x', 'a/../../b', 'C:\\x', '']) expect(parseCall('index_outline', { path: p }), p).toBeNull();
    expect(parseCall('index_search', { query: 'x', limit: 51 })).toBeNull();
    expect(parseCall('index_related', { path: 'src/a.ts' })).toEqual({ tool: 'index_related', path: 'src/a.ts' });
  });
});
