// Re-open of the project index on a real repository after touching 10 files: time until it answers
// (the saved index loaded) and until it is verified (caught up from the journal or a full check),
// against a full build. Runs only with FL_INDEX_BENCH_REPO set (CI: .github/workflows/index-bench.yml
// clones microsoft/TypeScript); FL_INDEX_BENCH_JOURNAL is the built FSEvents helper on macOS.
// It edits files in that checkout: point it at a throwaway clone only.
import { appendFile, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fseventsJournal } from '../src/host/changeJournal';
import { ProjectIndex, readIndexFile, saveIndexFile } from '../src/host/projectIndex';

const repo = process.env.FL_INDEX_BENCH_REPO;
const helper = process.env.FL_INDEX_BENCH_JOURNAL;
const journal = helper ? fseventsJournal(helper) : undefined;
const opts = { maxFiles: 1_000_000, maxBytes: 8 * 1024 ** 3 };

/** What the editor does on open: the saved file read and loaded (ready), then caught up (verified). */
async function open(file: string | undefined) {
  const t = performance.now();
  const ix = new ProjectIndex(repo!, opts);
  if (file) await ix.load(await readIndexFile(file));
  const ready = performance.now() - t;
  const mode = await ix.catchUp(journal);
  return { ix, mode, ready, verified: performance.now() - t };
}
// FSEvents writes its history with a short delay; a real reopen comes much later.
const settle = () => new Promise((r) => setTimeout(r, journal ? 3000 : 0));

describe.skipIf(!repo)('project index re-open bench', () => {
  it('answers at once on re-open and verifies only what changed', async () => {
    const store = path.join(await mkdtemp(path.join(os.tmpdir(), 'fl-bench-')), 'ix.json');
    const full = await open(undefined);
    full.ix.tree.snapshot();
    await saveIndexFile(store, full.ix);

    // Any indexed files, spread over the tree.
    const indexed = (await full.ix.list()).filter((r) => full.ix.has(r));
    const picked = Array.from({ length: 20 }, (_, i) => indexed[Math.floor((i * indexed.length) / 20)]);
    expect(new Set(picked).size).toBe(20);
    for (const r of picked.slice(0, 10)) await appendFile(path.join(repo!, r), '\n// touched by the index bench\n');
    await settle();
    const edited = await open(store);
    const changed = edited.ix.changes()?.total;
    edited.ix.tree.snapshot();
    await saveIndexFile(store, edited.ix);

    // A branch switch that rewrites 10 files with the same content: stat changes, content does not.
    const now = new Date(Date.now() + 10_000);
    for (const r of picked.slice(10, 20)) await utimes(path.join(repo!, r), now, now);
    await settle();
    const touched = await open(store);

    const ms = (n: number) => `${n.toFixed(0)} ms`;
    const rows = [
      ['Full build', full],
      ['Re-open, 10 files edited', edited],
      ['Re-open, 10 files touched (same content)', touched],
    ] as const;
    const table = [
      `Project index on ${path.basename(repo!)} (${process.platform}): ${full.ix.size.toLocaleString()} files, root ${full.ix.tree.root().slice(0, 12)}, journal ${journal ? 'FSEvents' : 'none'}`,
      '',
      '| Scenario | Ready (answers) | Verified | How | Stats | Reads | Re-indexed |',
      '|---|---|---|---|---|---|---|',
      ...rows.map(([name, r]) => `| ${name} | ${name === 'Full build' ? '–' : ms(r.ready)} | ${ms(r.verified)} | ${r.mode} | ${r.ix.counts.stat} | ${r.ix.counts.read} | ${r.ix.counts.reindex} |`),
      '',
      `Changed since the open (edited run): ${changed}`,
    ].join('\n');
    console.log(table);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, table + '\n');
    if (process.env.FL_INDEX_BENCH_OUT) await writeFile(process.env.FL_INDEX_BENCH_OUT, table + '\n');

    expect([edited.ix.counts.read, edited.ix.counts.reindex]).toEqual([10, 10]);
    expect([touched.ix.counts.read, touched.ix.counts.reindex]).toEqual([10, 0]);
    expect(changed).toBe(10);
    // Fixed costs (git status, the helper) outweigh a full build only on tiny folders.
    if (full.ix.size > 10_000) expect(edited.verified).toBeLessThan(full.verified);
    if (journal) expect([edited.mode, touched.mode]).toEqual(['journal', 'journal']);
  }, 600_000);
});
