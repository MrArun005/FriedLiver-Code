// Re-open time of the project index on a real repository, after touching 10 files, against a full
// build. Runs only with FL_INDEX_BENCH_REPO set (CI: .github/workflows/index-bench.yml clones
// microsoft/TypeScript). It edits files in that checkout: point it at a throwaway clone only.
import { appendFile, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProjectIndex, STAT_BATCH } from '../src/host/projectIndex';

const repo = process.env.FL_INDEX_BENCH_REPO;

async function open(saved: unknown): Promise<{ ix: ProjectIndex; ms: number }> {
  const t = performance.now();
  const ix = new ProjectIndex(repo!, { maxFiles: 1_000_000, maxBytes: 8 * 1024 ** 3 });
  await ix.load(saved);
  const files = await ix.list();
  ix.prune(new Set(files));
  for (let i = 0; i < files.length; i += STAT_BATCH) await ix.updateBatch(files.slice(i, i + STAT_BATCH));
  return { ix, ms: performance.now() - t };
}

describe.skipIf(!repo)('project index re-open bench', () => {
  it('re-opens after touching 10 files much faster than a full build', async () => {
    const full = await open(undefined);
    full.ix.tree.snapshot();
    const json = JSON.stringify(full.ix);
    const saved = JSON.parse(json);

    // Any indexed files, spread over the tree.
    const indexed = (await full.ix.list()).filter((r) => full.ix.has(r));
    const ts = Array.from({ length: 20 }, (_, i) => indexed[Math.floor((i * indexed.length) / 20)]);
    expect(new Set(ts).size).toBe(20);
    for (const r of ts.slice(0, 10)) await appendFile(path.join(repo!, r), '\n// touched by the index bench\n');
    const edited = await open(saved);

    // A branch switch that rewrites 10 files with the same content: stat changes, content does not.
    const now = new Date(Date.now() + 10_000);
    for (const r of ts.slice(10, 20)) await utimes(path.join(repo!, r), now, now);
    edited.ix.tree.snapshot();
    const touched = await open(JSON.parse(JSON.stringify(edited.ix)));

    const rows = [
      ['Full build', full.ms, full.ix.counts],
      ['Re-open, 10 files edited', edited.ms, edited.ix.counts],
      ['Re-open, 10 files touched (same content)', touched.ms, touched.ix.counts],
    ] as const;
    const table = [
      `Project index on ${path.basename(repo!)}: ${full.ix.size.toLocaleString()} files, saved index ${(json.length / 1024 ** 2).toFixed(1)} MB, root ${full.ix.tree.root().slice(0, 12)}`,
      '',
      '| Scenario | Time | Stats | Reads | Re-indexed |',
      '|---|---|---|---|---|',
      ...rows.map(([name, ms, c]) => `| ${name} | ${ms.toFixed(0)} ms | ${c.stat} | ${c.read} | ${c.reindex} |`),
      '',
      `Changed since the open (edited run): ${edited.ix.changes()?.total}`,
    ].join('\n');
    console.log(table);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, table + '\n');
    if (process.env.FL_INDEX_BENCH_OUT) await writeFile(process.env.FL_INDEX_BENCH_OUT, table + '\n');

    expect([edited.ix.counts.read, edited.ix.counts.reindex]).toEqual([10, 10]);
    expect([touched.ix.counts.read, touched.ix.counts.reindex]).toEqual([10, 0]);
    expect(edited.ix.changes()?.total).toBe(10);
    expect(edited.ms).toBeLessThan(full.ms);
  }, 600_000);
});
