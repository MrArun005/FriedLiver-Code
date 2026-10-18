import { describe, expect, it } from 'vitest';
import { MerkleTree, nodeHash, sha256 } from '../src/host/merkle';

const h = (s: string) => sha256(s);
const tree = (files: Record<string, string>) => {
  const t = new MerkleTree();
  for (const [rel, text] of Object.entries(files)) t.set(rel, h(text));
  return t;
};

describe('Merkle tree hashing', () => {
  it('is deterministic and independent of insertion order', () => {
    const files = { 'a.ts': '1', 'src/b.ts': '2', 'src/c/d.ts': '3', 'z.md': '4', 'src/c/e.ts': '5' };
    const one = tree(files).root();
    const reversed = tree(Object.fromEntries(Object.entries(files).reverse())).root();
    expect(one).toMatch(/^[0-9a-f]{64}$/);
    expect(reversed).toBe(one);
    expect(tree(files).root()).toBe(one);
  });

  it('changes the root for any content, name or place change, and back again', () => {
    const base = { 'a.ts': '1', 'src/b.ts': '2' };
    const root = tree(base).root();
    expect(tree({ ...base, 'a.ts': 'x' }).root()).not.toBe(root);
    expect(tree({ 'b.ts': '1', 'src/b.ts': '2' }).root()).not.toBe(root);
    expect(tree({ 'a.ts': '1', 'lib/b.ts': '2' }).root()).not.toBe(root);
    const t = tree(base);
    t.set('a.ts', h('x'));
    t.set('a.ts', h('1'));
    expect(t.root()).toBe(root);
  });

  it('builds a directory node from its sorted (name, child hash) pairs', () => {
    const t = tree({ 'src/b.ts': '2', 'src/a.ts': '1' });
    const src = nodeHash([
      ['a.ts', h('1'), false],
      ['b.ts', h('2'), false],
    ]);
    expect(t.root()).toBe(nodeHash([['src', src, true]]));
  });

  it('recomputes only the dirty path up to the root', () => {
    const t = tree({ 'a/1.ts': '1', 'b/2.ts': '2', 'c/d/3.ts': '3' });
    t.root();
    t.hashed = 0;
    t.set('c/d/3.ts', h('changed'));
    t.root();
    expect(t.hashed).toBe(3); // c/d, c, root
    t.root();
    expect(t.hashed).toBe(3); // clean: nothing recomputed
  });

  it('matches a fresh build after any mix of edits, deletes and root() calls', () => {
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    const t = new MerkleTree();
    const live = new Map<string, string>();
    for (let i = 0; i < 3000; i++) {
      const rel = `a${rnd(3)}/b${rnd(4)}/c${rnd(3)}/f${rnd(6)}.ts`;
      if (rnd(4) === 0) {
        t.delete(rel);
        live.delete(rel);
      } else {
        const hash = h(String(rnd(5)));
        t.set(rel, hash);
        live.set(rel, hash);
      }
      if (rnd(5) === 0) {
        const fresh = new MerkleTree();
        for (const [r, x] of live) fresh.set(r, x);
        expect(t.root()).toBe(fresh.root());
      }
    }
  });

  it('drops empty directories on delete', () => {
    const t = tree({ 'a.ts': '1' });
    const root = t.root();
    t.set('deep/er/x.ts', h('2'));
    t.delete('deep/er/x.ts');
    expect(t.root()).toBe(root);
    expect(t.size).toBe(1);
  });
});

describe('changes between roots', () => {
  it('reports adds, edits, deletes and renames', () => {
    const t = tree({ 'a.ts': '1', 'src/b.ts': '2', 'src/old/c.ts': '3', 'keep/k.ts': 'k' });
    const before = t.snapshot();
    t.set('a.ts', h('edited'));
    t.delete('src/old/c.ts');
    t.set('src/new/c.ts', h('3')); // a move
    t.set('added.ts', h('4'));
    t.delete('src/b.ts');
    t.set('src/b2.ts', h('2')); // a rename
    const d = t.diff(before)!;
    expect(d.changes).toEqual([
      { path: 'a.ts', change: 'M' },
      { path: 'added.ts', change: 'A' },
      { path: 'src/b.ts', change: 'D' },
      { path: 'src/b2.ts', change: 'A' },
      { path: 'src/new/c.ts', change: 'A' },
      { path: 'src/old/c.ts', change: 'D' },
    ]);
    expect(d.total).toBe(6);
    expect(t.diff(t.root())!.changes).toEqual([]);
  });

  it('descends only into changed subtrees', () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 20; i++) for (let j = 0; j < 20; j++) files[`d${i}/e${j}/f.ts`] = `${i}-${j}`;
    const t = tree(files);
    const before = t.snapshot();
    t.set('d7/e3/f.ts', h('changed'));
    t.visits = 0;
    expect(t.diff(before)!.changes).toEqual([{ path: 'd7/e3/f.ts', change: 'M' }]);
    expect(t.visits).toBe(3); // root, d7, d7/e3 of 421 directories
  });

  it('caps the list but counts every change, and knows only roots it kept', () => {
    const t = tree({});
    const before = t.snapshot();
    for (let i = 0; i < 30; i++) t.set(`f${i}.ts`, h(String(i)));
    const d = t.diff(before, 10)!;
    expect([d.changes.length, d.total]).toEqual([10, 30]);
    expect(t.diff('0'.repeat(64))).toBeNull();
  });

  it('keeps a bounded history and drops nodes no kept root reaches', () => {
    const t = tree({ 'a.ts': '0' });
    const first = t.snapshot();
    t.base = first;
    for (let i = 1; i <= 40; i++) {
      t.set('a.ts', h(String(i)));
      t.snapshot();
    }
    expect(t.history.length).toBeLessThanOrEqual(16);
    expect(t.diff(first)!.changes).toEqual([{ path: 'a.ts', change: 'M' }]); // the base stays
    expect(t.nodeCount).toBeLessThanOrEqual(17);
  });

  it('resolves a short id, and saves and loads its history, rejecting tampered nodes', () => {
    const t = tree({ 'a.ts': '1', 'src/b.ts': '2' });
    const before = t.snapshot();
    expect(t.resolve(before.slice(0, 12))).toBe(before);
    expect(t.resolve('ffffffffffff')).toBeUndefined();
    const saved = JSON.parse(JSON.stringify(t));
    const copy = tree({ 'a.ts': 'x', 'src/b.ts': '2' });
    expect(copy.load(saved)).toBe(true);
    expect(copy.diff(before)!.changes).toEqual([{ path: 'a.ts', change: 'M' }]);

    const bad = JSON.parse(JSON.stringify(t));
    bad.nodes[0][1][0][1] = h('forged');
    const other = new MerkleTree();
    expect(other.load(bad)).toBe(false);
    expect(other.history).toEqual([]);
    for (const junk of [null, 'x', { v: 9 }, { v: 1, history: ['zz'], nodes: [] }]) expect(new MerkleTree().load(junk)).toBe(false);
  });
});
