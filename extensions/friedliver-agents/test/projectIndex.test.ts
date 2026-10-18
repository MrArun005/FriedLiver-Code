import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { handle } from '../src/bridge/mcp';
import { parseCall } from '../src/bridge/protocol';
import { answerIndex, globToRegex, imports, INDEX_LIMITS, isSecret, outline, ProjectIndex, readIndexFile, saveIndexFile, STAT_BATCH, tokenize } from '../src/host/projectIndex';

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

  it('applies the full build\'s filters to watcher updates too', async () => {
    const root = await project({ '.gitignore': 'logs/\n*.gen.ts\n', 'ok.ts': 'fine' }, true);
    const ix = await build(root);
    const later: Record<string, string> = {
      'logs/a.ts': 'leakword',
      'b.gen.ts': 'leakword',
      '.hidden/c.ts': 'leakword',
      '.npmrc': 'leakword',
      'deploy/prod.tfvars': 'leakword',
      'terraform.tfstate.backup': 'leakword',
      'credentials.json': 'leakword',
      'service-account-prod.json': 'leakword',
      'secrets.yaml': 'leakword',
      'app.keystore': 'leakword',
      'new.ts': 'leakword',
    };
    for (const [rel, text] of Object.entries(later)) {
      await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
      await writeFile(path.join(root, rel), text);
    }
    await ix.updateMany(Object.keys(later));
    expect(ix.search('leakword', 50).map((h) => h.rel)).toEqual(['new.ts']);
    for (const s of ['.netrc', '.pypirc', '.git-credentials', 'x.jks']) expect(isSecret(s), s).toBe(true);
  });

  it('fails closed when git check-ignore errors inside a repo', async () => {
    const root = await project({ 'ok.ts': 'fine' }, true);
    const fake = path.join(root, '..', `fake-git-${path.basename(root)}`);
    await writeFile(fake, '#!/bin/sh\nif [ "$1" = rev-parse ]; then echo true; exit 0; fi\nexit 128\n', { mode: 0o755 });
    dirs.push(fake);
    const logged: string[] = [];
    const ix = new ProjectIndex(root, { maxFiles: 100, maxBytes: 1e8, git: fake, log: (m) => logged.push(m) });
    await writeFile(path.join(root, 'new.ts'), 'leakword');
    await ix.updateMany(['new.ts']);
    expect(ix.has('new.ts')).toBe(false);
    expect(logged.join()).toContain('128');
  });

  it('uses name rules only in a folder outside git, and skips submodules and symlinked dirs in one', async () => {
    const plain = await project({ 'a.ts': 'word', '.env': 'word' });
    const ix = new ProjectIndex(plain, { maxFiles: 100, maxBytes: 1e8 });
    await ix.updateMany(['a.ts', '.env']);
    expect([ix.has('a.ts'), ix.has('.env')]).toEqual([true, false]);

    const repo = await project({ 'ok.ts': 'word', 'sub/.git': 'gitdir: elsewhere', 'sub/x.ts': 'word' }, true);
    await symlink(path.join(repo, 'sub'), path.join(repo, 'linked'));
    const rx = new ProjectIndex(repo, { maxFiles: 100, maxBytes: 1e8 });
    await rx.updateMany(['ok.ts', 'sub/x.ts', 'linked/x.ts']);
    expect([rx.has('ok.ts'), rx.has('sub/x.ts'), rx.has('linked/x.ts')]).toEqual([true, false, false]);
  });

  it('returns no content from a file swapped for a symlink after indexing', async () => {
    const outside = await project({ 'leak.ts': 'needle outsidesecret' });
    const root = await project({ 'a.ts': 'needle inside' });
    const ix = await build(root);
    await rm(path.join(root, 'a.ts'));
    await symlink(path.join(outside, 'leak.ts'), path.join(root, 'a.ts'));
    const out = await answerIndex([ix], { tool: 'index_search', query: 'needle' }, false);
    expect(out).not.toContain('outsidesecret');
    expect(ix.has('a.ts')).toBe(false);
  });

  it('drops saved entries that point outside the folder or at secrets', async () => {
    const outside = await project({ 'leak.ts': 'outsidesecret' });
    const root = await project({ 'ok.ts': 'fine' });
    await symlink(path.join(outside, 'leak.ts'), path.join(root, 'link.ts'));
    const doc = (rel: string) => ({ rel, mtimeNs: '0', size: 1, hash: 'a'.repeat(64), len: 1, tokens: [['outsidesecret', 1]], symbols: [], imports: [] });
    const ix = new ProjectIndex(root, { maxFiles: 10, maxBytes: 1e8 });
    await ix.load({ v: 2, docs: [doc('link.ts'), doc('.env'), doc('gone.ts'), doc('ok.ts')] });
    expect(['link.ts', '.env', 'gone.ts'].map((r) => ix.has(r))).toEqual([false, false, false]);
    expect(ix.has('ok.ts')).toBe(true);
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
    await copy.load(JSON.parse(JSON.stringify(ix)));
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

/** What the editor does on open: the saved index back, then every listed file through update(). */
async function reopen(root: string, saved: unknown, opts: Partial<ConstructorParameters<typeof ProjectIndex>[1]> = {}): Promise<ProjectIndex> {
  const ix = new ProjectIndex(root, { maxFiles: 100_000, maxBytes: 1e9, ...opts });
  await ix.load(saved);
  ix.counts.stat = ix.counts.read = ix.counts.reindex = 0;
  const files = await ix.list();
  ix.prune(new Set(files));
  for (let i = 0; i < files.length; i += STAT_BATCH) await ix.updateBatch(files.slice(i, i + STAT_BATCH));
  return ix;
}
const saveOf = (ix: ProjectIndex) => {
  ix.tree.snapshot();
  return JSON.parse(JSON.stringify(ix));
};

describe('the Merkle tree over the index', () => {
  it('holds exactly the indexed files: every exclusion of the full build applies', async () => {
    const outside = await project({ 'leak.ts': 'x' });
    const root = await project(
      {
        '.gitignore': 'ignored/\n',
        'ignored/a.ts': 'x',
        'gen/b.ts': 'x',
        '.env': 'x',
        'keys/id_rsa': 'x',
        'node_modules/x/index.js': 'x',
        '.hidden/c.ts': 'x',
        'bin.dat': 'x\0\0',
        'big.ts': 'x'.repeat(INDEX_LIMITS.fileBytes + 1),
        'ok.ts': 'x',
        'src/ok2.ts': 'y',
      },
      true,
    );
    await symlink(path.join(outside, 'leak.ts'), path.join(root, 'link.ts'));
    await symlink(outside, path.join(root, 'linkdir'));
    const ix = await build(root, { exclude: ['gen'] });
    await ix.updateMany(['linkdir/leak.ts', 'link.ts', '.env', 'ignored/a.ts']);
    expect(ix.tree.size).toBe(ix.size);
    expect(['.gitignore', 'ok.ts', 'src/ok2.ts'].every((r) => ix.tree.get(r))).toBe(true);
    expect(ix.tree.size).toBe(3);
    expect(ix.tree.get('src/ok2.ts')).toBe(createHash('sha256').update('y').digest('hex'));
  });

  it('on reopen reads only changed files and re-indexes only changed content', async () => {
    const files = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`d${i % 4}/f${i}.ts`, `export const v${i} = ${i};\n`]));
    const root = await project(files);
    const first = await build(root);
    const saved = saveOf(first);
    const before = first.tree.root();

    await writeFile(path.join(root, 'd0/f0.ts'), 'export const changed = 1;\n');
    await writeFile(path.join(root, 'd1/f1.ts'), 'export const changed = 2;\n');
    const later = new Date(Date.now() + 5000);
    await utimes(path.join(root, 'd2/f2.ts'), later, later); // a checkout that rewrote it unchanged
    await writeFile(path.join(root, 'd3/new.ts'), 'export const fresh = 1;\n');
    await rm(path.join(root, 'd3/f3.ts'));

    const ix = await reopen(root, saved);
    // Every listed file once (the floor without a file-system journal), and again right before each read.
    expect(ix.counts.stat).toBe(40 + 4);
    expect(ix.counts.read).toBe(4); // two edits, the touched file, the new one
    expect(ix.counts.reindex).toBe(3); // the touched file's content matched: not re-tokenized
    expect(ix.tree.base).toBe(before);
    expect(ix.changes()!.changes).toEqual([
      { path: 'd0/f0.ts', change: 'M' },
      { path: 'd1/f1.ts', change: 'M' },
      { path: 'd3/f3.ts', change: 'D' },
      { path: 'd3/new.ts', change: 'A' },
    ]);
    expect(ix.search('fresh', 5)[0].rel).toBe('d3/new.ts');

    // Nothing changed: nothing read.
    const again = await reopen(root, saveOf(ix));
    expect([again.counts.read, again.counts.reindex]).toEqual([0, 0]);
    expect(again.changes()!.total).toBe(0);
  });

  it('tracks a rename through watcher updates and recomputes the root lazily', async () => {
    const root = await project({ 'a/x.ts': 'one', 'b/y.ts': 'two' });
    const ix = await build(root);
    const before = ix.tree.snapshot();
    await mkdir(path.join(root, 'c'));
    await writeFile(path.join(root, 'c/x.ts'), 'one');
    await rm(path.join(root, 'a'), { recursive: true });
    await ix.updateMany(['a/x.ts', 'c/x.ts']);
    expect(ix.changes(before.slice(0, 12))!.changes).toEqual([
      { path: 'a/x.ts', change: 'D' },
      { path: 'c/x.ts', change: 'A' },
    ]);
    expect(ix.tree.root()).not.toBe(before);
  });

  it('starts over from a corrupt, foreign or old saved file, and saves it private', async () => {
    const root = await project({ 'a.ts': 'one', 'b.ts': 'two' });
    const store = await mkdtemp(path.join(os.tmpdir(), 'fl-store-'));
    dirs.push(store);
    const file = path.join(store, 'index', 'ix.json');
    const ix = await build(root);
    ix.tree.snapshot();
    await saveIndexFile(file, ix);
    expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await reopen(root, await readIndexFile(file))).counts.read).toBe(0);

    for (const bad of ['{not json', JSON.stringify({ v: 1, docs: [] }), JSON.stringify({ v: 2, docs: 'x', merkle: 7 })]) {
      await writeFile(file, bad);
      const re = await reopen(root, await readIndexFile(file));
      expect(re.counts.read).toBe(2); // a full build
      expect(re.size).toBe(2);
      expect(re.changes()).toBeNull(); // no earlier root to compare with
    }
    // A forged node in an otherwise good file: the history goes, the docs stay.
    const good = JSON.parse(JSON.stringify(ix));
    good.merkle.nodes[0][1][0][1] = 'f'.repeat(64);
    await writeFile(file, JSON.stringify(good));
    const re = await reopen(root, await readIndexFile(file));
    expect([re.counts.read, re.changes()]).toEqual([0, null]);
  });

  it('answers index_changes', async () => {
    const root = await project({ 'a.ts': 'one', 'b.ts': 'two' });
    const ix = await reopen(root, saveOf(await build(root)));
    expect(await answerIndex([ix], { tool: 'index_changes' }, false)).toMatch(/^Project hash [0-9a-f]{12}, the same as when the project was opened\./);
    await writeFile(path.join(root, 'a.ts'), 'changed');
    await ix.update('a.ts');
    const out = await answerIndex([ix], { tool: 'index_changes' }, false);
    expect(out).toContain('1 file changed since');
    expect(out).toContain('M a.ts');
    expect(await answerIndex([ix], { tool: 'index_changes', since: 'deadbeefdead' }, false)).toContain('No kept project hash starts with deadbeefdead');
    const fresh = await build(root);
    expect(await answerIndex([fresh], { tool: 'index_changes' }, false)).toContain('No earlier project hash');
  });

  it('reopens a synthetic 20k-file tree reading only the touched files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fl-index-big-'));
    dirs.push(root);
    const N = 20_000;
    const rels = Array.from({ length: N }, (_, i) => `p${i % 20}/q${Math.floor(i / 20) % 50}/f${i}.ts`);
    for (const d of new Set(rels.map((r) => path.dirname(r)))) await mkdir(path.join(root, d), { recursive: true });
    for (let i = 0; i < N; i += 500) await Promise.all(rels.slice(i, i + 500).map((r, j) => writeFile(path.join(root, r), `export const v${i + j} = ${i + j};\n`)));

    let t = performance.now();
    const full = await reopen(root, undefined);
    const fullMs = performance.now() - t;
    expect(full.size).toBe(N);
    const saved = saveOf(full);
    for (const r of rels.slice(0, 10)) await writeFile(path.join(root, r), 'export const touched = 1;\n');
    t = performance.now();
    const re = await reopen(root, saved);
    const reMs = performance.now() - t;
    expect([re.counts.read, re.counts.reindex]).toEqual([10, 10]);
    re.tree.visits = 0;
    expect(re.changes()!.total).toBe(10);
    expect(re.tree.visits).toBeLessThanOrEqual(21); // root + the changed directories, not all 1,021
    console.log(`20k files: full build ${fullMs.toFixed(0)} ms, reopen after 10 edits ${reMs.toFixed(0)} ms (${re.counts.stat} stats, ${re.counts.read} reads)`);
  }, 120_000);
});
