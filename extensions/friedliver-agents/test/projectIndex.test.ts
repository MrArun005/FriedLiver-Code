import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { handle, TOOLS } from '../src/bridge/mcp';
import { parseCall } from '../src/bridge/protocol';
import type { Journal } from '../src/host/changeJournal';
import { answerIndex, globToRegex, imports, INDEX_DEFAULTS, INDEX_LIMITS, isSecret, outline, partialIndex, ProjectIndex, docsFileOf, readIndexFile, saveIndexFile, tokenize } from '../src/host/projectIndex';

/** Windows has no POSIX mode bits (stat says 0o666 whatever was asked), so file modes are checked elsewhere only. */
const POSIX_MODES = process.platform !== 'win32';

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
    expect(out).toContain('1\texport function refreshToken');
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
    expect(await answerIndex([ix], { tool: 'index_outline', path: 'src/b.ts' }, false)).toContain('1: export function b()');
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
    // A corrupt index: rev-parse still says "in a work tree", check-ignore dies with 128. Real git, so on every OS.
    await writeFile(path.join(root, '.git', 'index'), 'not an index');
    const logged: string[] = [];
    const ix = new ProjectIndex(root, { maxFiles: 100, maxBytes: 1e8, log: (m) => logged.push(m) });
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
    const rels = ['link.ts', '.env', 'gone.ts', 'ok.ts'];
    const hash = 'a'.repeat(64);
    const store = await mkdtemp(path.join(os.tmpdir(), 'fl-store-'));
    dirs.push(store);
    const file = path.join(store, 'ix.json');
    await writeFile(file, JSON.stringify({ v: 3, leaves: rels.map((r) => [r, 1, '0', hash]) }));
    await writeFile(docsFileOf(file), rels.map((rel) => JSON.stringify({ rel, hash, len: 1, tokens: [['outsidesecret', 1]], symbols: [], imports: [] })).join('\n'));
    const ix = new ProjectIndex(root, { maxFiles: 10, maxBytes: 1e8 });
    ix.load(await readIndexFile(file));
    // Loading checks names only (it must be instant): the secret goes now.
    expect(ix.tree.get('.env')).toBeUndefined();
    // Before the files are checked, a search never returns what the symlink points at: every read re-checks.
    await ix.loadDocs(docsFileOf(file));
    expect(await answerIndex([ix], { tool: 'index_search', query: 'outsidesecret' }, 'verifying')).not.toContain('link.ts');
    await ix.catchUp();
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
    const copy = await reopen(root, await saveOf(ix));
    expect(copy.search('quokka', 5)[0].rel).toBe('a.ts');
    await rm(path.join(root, 'a.ts'));
    await ix.update('a.ts');
    expect(ix.size).toBe(0);
  });

  it('reads a file once when several ask for it at the same time', async () => {
    const root = await project({ 'a.ts': 'one' });
    const ix = new ProjectIndex(root, { maxFiles: 10, maxBytes: 1e8 });
    await Promise.all([ix.update('a.ts'), ix.update('a.ts'), ix.updateMany(['a.ts']), ix.updateBatch(['a.ts'])]);
    expect([ix.counts.read, ix.size]).toEqual([1, 1]);
  });

  it('stops at the file cap', async () => {
    const root = await project(Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`f${i}.ts`, 'word'])));
    const ix = await build(root, { maxFiles: 3 });
    expect(ix.size).toBe(3);
    expect(ix.capped).toBe('files');
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
    expect(parseCall('index_changes', {})).toEqual({ tool: 'index_changes' });
    expect(parseCall('index_changes', { since: 'a1B2c3d4' })).toEqual({ tool: 'index_changes', since: 'a1B2c3d4' });
    for (const since of ['abc', '../x', 'g'.repeat(12), 'a'.repeat(65), 7]) expect(parseCall('index_changes', { since }), String(since)).toBeNull();
    expect(TOOLS.find((t) => t.name === 'index_changes')?.annotations).toEqual({ readOnlyHint: true });
  });
});

/** What the editor does on open: the saved index back, then every listed file through update(). */
async function reopen(root: string, file: string | undefined, opts: Partial<ConstructorParameters<typeof ProjectIndex>[1]> = {}, journal?: Journal): Promise<ProjectIndex> {
  const ix = new ProjectIndex(root, { maxFiles: 100_000, maxBytes: 1e9, ...opts });
  if (file) ix.load(await readIndexFile(file));
  ix.counts.stat = ix.counts.read = ix.counts.reindex = 0;
  // As the editor does: the saved docs stream in while the files are checked.
  await Promise.all([file ? ix.loadDocs(docsFileOf(file)) : undefined, ix.catchUp(journal)]);
  return ix;
}

/** A journal that reports what the test says changed. */
const fakeJournal = (changes: { files?: string[]; dirs?: string[] } | null, next = '900'): Journal & { asked: number } => ({
  asked: 0,
  async now() {
    return { kind: 'fsevents', uuid: 'U', id: next };
  },
  async since() {
    this.asked++;
    return changes && { files: changes.files ?? [], dirs: changes.dirs ?? [], next: { kind: 'fsevents', uuid: 'U', id: next } };
  },
});
/** Saves as the editor does (a tree file and a docs file); returns the tree file. */
const saveOf = async (ix: ProjectIndex): Promise<string> => {
  ix.tree.snapshot();
  const store = await mkdtemp(path.join(os.tmpdir(), 'fl-store-'));
  dirs.push(store);
  const file = path.join(store, 'index', 'ix.json');
  await saveIndexFile(file, ix);
  return file;
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
    const root = await project({ ...files, 'd0/logo.bin': 'PNG\0\0' });
    const first = await build(root);
    const saved = await saveOf(first);
    const before = first.tree.root();

    await writeFile(path.join(root, 'd0/f0.ts'), 'export const changed = 1;\n');
    await writeFile(path.join(root, 'd1/f1.ts'), 'export const changed = 2;\n');
    const later = new Date(Date.now() + 5000);
    await utimes(path.join(root, 'd2/f2.ts'), later, later); // a checkout that rewrote it unchanged
    await writeFile(path.join(root, 'd3/new.ts'), 'export const fresh = 1;\n');
    await rm(path.join(root, 'd3/f3.ts'));

    const ix = await reopen(root, saved);
    // Every listed file once (the floor without a file-system journal), and again right before each read.
    expect(ix.counts.stat).toBe(41 + 4);
    expect(ix.counts.read).toBe(4); // two edits, the touched file, the new one: not the unchanged binary
    expect(ix.counts.reindex).toBe(3); // the touched file's content matched: not re-tokenized
    expect(ix.tree.base).toBe(before);
    expect(ix.changes()!.changes).toEqual([
      { path: 'd0/f0.ts', change: 'M' },
      { path: 'd1/f1.ts', change: 'M' },
      { path: 'd3/f3.ts', change: 'D' },
      { path: 'd3/new.ts', change: 'A' },
    ]);
    expect(ix.search('fresh', 5)[0].rel).toBe('d3/new.ts');
    // The saved doc of an edited file is never used, whichever finished first: loading or checking.
    expect(ix.search('v0', 5).map((h) => h.rel)).not.toContain('d0/f0.ts');

    // Nothing changed: nothing read.
    const again = await reopen(root, await saveOf(ix));
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
    if (POSIX_MODES) expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    if (POSIX_MODES) for (const f of [file, docsFileOf(file)]) expect((await stat(f)).mode & 0o777).toBe(0o600);
    expect((await reopen(root, file)).counts.read).toBe(0);
    const tree = await readFile(file, 'utf8');
    const docs = await readFile(docsFileOf(file), 'utf8');

    for (const bad of ['{not json', JSON.stringify({ v: 2, docs: [] }), JSON.stringify({ v: 3, leaves: 'x', merkle: 7 })]) {
      await writeFile(file, bad);
      const re = await reopen(root, file);
      expect(re.counts.read).toBe(2); // a full build
      expect(re.size).toBe(2);
      expect(re.changes()).toBeNull(); // no earlier root to compare with
    }
    // A forged node in an otherwise good tree: the history goes, the rest stays.
    const forged = JSON.parse(tree);
    forged.merkle.nodes[0][1][0][1] = 'f'.repeat(64);
    await writeFile(file, JSON.stringify(forged));
    let re = await reopen(root, file);
    expect([re.counts.read, re.changes()]).toEqual([0, null]);
    // Docs corrupt or missing: the tree stays, those files are read again.
    await writeFile(file, tree);
    await writeFile(docsFileOf(file), docs.split('\n')[0] + '\n{broken');
    re = await reopen(root, file);
    expect([re.counts.read, re.size, re.changes()!.total]).toEqual([1, 2, 0]);
    await rm(docsFileOf(file));
    re = await reopen(root, file);
    expect([re.counts.read, re.size]).toEqual([2, 2]);
    expect(re.search('two', 5)[0].rel).toBe('b.ts');
  });

  it('answers index_changes', async () => {
    const root = await project({ 'a.ts': 'one', 'b.ts': 'two' });
    const ix = await reopen(root, await saveOf(await build(root)));
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
    const saved = await saveOf(full);
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

describe('opening: ready at once, then caught up from the journal', () => {
  const files40 = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`d${i % 4}/f${i}.ts`, `export const v${i} = ${i};\n`]));
  const savedWith = async (ix: ProjectIndex, id = '100') => {
    ix.mark = { kind: 'fsevents', uuid: 'U', id };
    return saveOf(ix);
  };

  it('serves the saved index before any file is checked', async () => {
    const root = await project(files40);
    const first = await build(root);
    const saved = await saveOf(first);
    const ix = new ProjectIndex(root, { maxFiles: 1000, maxBytes: 1e8 });
    ix.load(await readIndexFile(saved));
    // The tree first: its root, status and index_changes, with no file touched.
    expect(ix.counts.stat).toBe(0);
    expect(ix.size).toBe(40);
    expect(ix.tree.root()).toBe(first.tree.root());
    expect(ix.changes()!.total).toBe(0);
    expect(ix.loading).toBe(true);
    // Then the docs stream in, still without touching the files.
    await ix.loadDocs(docsFileOf(saved));
    expect([ix.counts.stat, ix.loading]).toEqual([0, false]);
    expect(ix.search('v7', 5)[0].rel).toBe('d3/f7.ts');
    expect(await answerIndex([ix], { tool: 'index_search', query: 'v7' }, 'verifying')).toContain('checking files changed since the last session');
  });

  it('applies changed name rules (files.exclude) to the saved tree on load', async () => {
    const root = await project({ 'gen/a.ts': 'one', 'src/b.ts': 'two' });
    const saved = await saveOf(await build(root));
    const same = new ProjectIndex(root, { maxFiles: 10, maxBytes: 1e8 });
    same.load(await readIndexFile(saved));
    expect(same.size).toBe(2);
    const excluded = new ProjectIndex(root, { maxFiles: 10, maxBytes: 1e8, exclude: ['gen'] });
    excluded.load(await readIndexFile(saved));
    expect([excluded.size, excluded.tree.get('gen/a.ts')]).toEqual([1, undefined]);
  });

  it('re-checks only the journal\'s paths, rescans its directories, and moves the mark', async () => {
    const root = await project(files40);
    const saved = await savedWith(await build(root));
    await writeFile(path.join(root, 'd0/f0.ts'), 'export const edited = 1;\n');
    await writeFile(path.join(root, 'd1/new.ts'), 'export const added = 1;\n');
    await rm(path.join(root, 'd2/f2.ts'));
    await rename(path.join(root, 'd3'), path.join(root, 'moved'));
    const journal = fakeJournal({ files: ['d0/f0.ts', 'd1/new.ts', 'd2/f2.ts'], dirs: ['d3', 'moved'] });
    const ix = await reopen(root, saved, {}, journal);
    expect(journal.asked).toBe(1);
    expect(ix.counts.stat).toBeLessThan(40); // not every file: 3 paths + the 10 moved files, each checked again before a read
    expect(ix.counts.read).toBe(2 + 10);
    expect(ix.changes()!.changes.filter((c) => !c.path.startsWith('d3/') && !c.path.startsWith('moved/'))).toEqual([
      { path: 'd0/f0.ts', change: 'M' },
      { path: 'd1/new.ts', change: 'A' },
      { path: 'd2/f2.ts', change: 'D' },
    ]);
    expect(ix.has('d3/f3.ts')).toBe(false);
    expect(ix.has('moved/f3.ts')).toBe(true);
    expect(ix.mark).toEqual({ kind: 'fsevents', uuid: 'U', id: '900' });
    // The result matches a full build.
    const full = await build(root);
    expect(ix.tree.root()).toBe(full.tree.root());
  });

  it('checks every file without a saved mark, or when the journal cannot vouch for the history', async () => {
    const root = await project(files40);
    const unmarked = await saveOf(await build(root));
    const a = await reopen(root, unmarked, {}, fakeJournal({ files: [] }));
    expect(a.counts.stat).toBe(40);
    expect(a.mark?.id).toBe('900'); // taken before the check, so the next open can use the journal
    const b = await reopen(root, await savedWith(await build(root)), {}, fakeJournal(null));
    expect(b.counts.stat).toBe(40);
    const c = await reopen(root, await savedWith(await build(root))); // no journal at all (Linux, Windows)
    expect(c.counts.stat).toBe(40);
  });

  it('rescans for a .gitignore that changed, and uses git status and the HEAD diff as an extra hint', async () => {
    const root = await project({ 'src/b.ts': 'two', 'src/c.ts': 'three' }, true);
    const g = (...args: string[]) => execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', ...args], { cwd: root });
    g('add', '.');
    g('commit', '-qm', 'one');
    // Untracked: a .gitignore can hide it (git keeps listing tracked files whatever .gitignore says).
    await mkdir(path.join(root, 'logs'));
    await writeFile(path.join(root, 'logs/a.ts'), 'one');
    const first = await build(root);
    expect(first.has('logs/a.ts')).toBe(true);
    await first.catchUp(); // records HEAD
    const saved = await savedWith(first);

    await writeFile(path.join(root, '.gitignore'), 'logs/\n');
    await writeFile(path.join(root, 'src/b.ts'), 'edited, committed');
    g('commit', '-qam', 'two');
    await writeFile(path.join(root, 'src/c.ts'), 'edited, not committed');
    await writeFile(path.join(root, 'src/untracked.ts'), 'new');
    // The journal saw only the .gitignore: git's hint brings the rest.
    const ix = await reopen(root, saved, {}, fakeJournal({ files: ['.gitignore'] }));
    expect(ix.has('logs/a.ts')).toBe(false);
    expect(ix.search('edited', 5).map((h) => h.rel).sort()).toEqual(['src/b.ts', 'src/c.ts']);
    expect(ix.has('src/untracked.ts')).toBe(true);
    expect(ix.counts.stat).toBeLessThan(20);
    expect((await ix.gitHint()).paths).toEqual(expect.arrayContaining(['src/c.ts', 'src/untracked.ts', '.gitignore']));
  });

  it('applies git\'s hint even when the journal reports nothing', async () => {
    const root = await project({ 'a.ts': 'one', 'b.ts': 'two' }, true);
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', 'x'], { cwd: root });
    const saved = await savedWith(await build(root));
    await writeFile(path.join(root, 'a.ts'), 'hinted');
    const ix = await reopen(root, saved, {}, fakeJournal({}));
    expect(ix.search('hinted', 5)[0]?.rel).toBe('a.ts');
    expect(ix.counts.stat).toBe(2); // a.ts, and again before its read; b.ts untouched
  });

  it('reads git paths relative to a workspace folder inside the repository', async () => {
    const root = await project({ 'sub/a.ts': 'one', 'other/b.ts': 'two' }, true);
    execFileSync('git', ['add', '.'], { cwd: root });
    await writeFile(path.join(root, 'sub/a.ts'), 'changed');
    await writeFile(path.join(root, 'other/b.ts'), 'changed');
    const ix = new ProjectIndex(path.join(root, 'sub'), { maxFiles: 10, maxBytes: 1e8 });
    expect((await ix.gitHint()).paths).toEqual(['a.ts']);
  });
});

describe('index defaults', () => {
  it('package.json offers the same defaults the host falls back to', () => {
    const props = JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')).contributes.configuration.properties;
    expect(props['friedliver.index.maxFiles'].default).toBe(INDEX_DEFAULTS.maxFiles);
    expect(props['friedliver.index.maxMemoryMB'].default).toBe(INDEX_DEFAULTS.maxMemoryMB);
    expect(INDEX_DEFAULTS.maxFiles).toBe(200_000);
    // A big repository stops early with a partial-index notice instead of taking ~1 GB of heap.
    expect(INDEX_DEFAULTS.maxMemoryMB).toBe(150);
  });
});

describe('partial index', () => {
  const files5 = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`f${i}.ts`, `export const word${i} = ${i};\n`]));

  it('says which limit stopped it and how many of the files it holds', async () => {
    const root = await project(files5);
    const byFiles = new ProjectIndex(root, { maxFiles: 3, maxBytes: 1e8 });
    await byFiles.syncAll();
    expect([byFiles.capped, byFiles.listed]).toEqual(['files', 5]);
    expect(partialIndex([byFiles])).toBe('Partial index: 3 of 5 files (file limit)');
    const byMemory = new ProjectIndex(root, { maxFiles: 100, maxBytes: 1 });
    await byMemory.syncAll();
    expect(byMemory.capped).toBe('memory');
    expect(partialIndex([byMemory])).toBe('Partial index: 0 of 5 files (memory limit)');
    const whole = new ProjectIndex(root, { maxFiles: 100, maxBytes: 1e8 });
    await whole.syncAll();
    expect([whole.capped, partialIndex([whole])]).toEqual([false, undefined]);
  });

  it('tells agents their answers come from part of the project', async () => {
    const root = await project(files5);
    const ix = new ProjectIndex(root, { maxFiles: 3, maxBytes: 1e8 });
    await ix.syncAll();
    expect(await answerIndex([ix], { tool: 'index_search', query: 'nothingmatches' }, false)).toContain('Partial index: 3 of 5 files (file limit)');
  });

  it('stays partial across a re-open, and fills in once the limit is raised, even with a journal', async () => {
    const root = await project(files5);
    const first = new ProjectIndex(root, { maxFiles: 3, maxBytes: 1e8 });
    await first.syncAll();
    first.mark = { kind: 'fsevents', uuid: 'U', id: '100' };
    const saved = await saveOf(first);
    const same = await reopen(root, saved, { maxFiles: 3 }, fakeJournal({ files: [] }));
    expect(partialIndex([same])).toBe('Partial index: 3 of 5 files (file limit)');
    const raised = await reopen(root, saved, { maxFiles: 100 }, fakeJournal({ files: [] }));
    expect([raised.size, raised.capped, partialIndex([raised])]).toEqual([5, false, undefined]);
  });
});
