// Re-open of the project index on a real repository after touching 10 files: time until the tree is
// ready (the saved tree loaded), until search is (the saved docs streamed in), and until it is
// verified (caught up from the journal or a full check),
// against a full build. Runs only with FL_INDEX_BENCH_REPO set (CI: .github/workflows/index-bench.yml
// clones microsoft/TypeScript); FL_INDEX_BENCH_JOURNAL is the built FSEvents helper on macOS.
// It edits files in that checkout: point it at a throwaway clone only.
import { appendFile, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fseventsJournal } from '../src/host/changeJournal';
import { docsFileOf, ProjectIndex, readIndexFile, saveIndexFile } from '../src/host/projectIndex';

const repo = process.env.FL_INDEX_BENCH_REPO;
const helper = process.env.FL_INDEX_BENCH_JOURNAL;
const journal = helper ? fseventsJournal(helper) : undefined;
const opts = { maxFiles: 1_000_000, maxBytes: 8 * 1024 ** 3 };

/** What the editor does on open: the saved tree loaded (ready), the docs streamed in (search ready) while the files are caught up (verified). Saves on the way out. */
async function open(file: string, saved: boolean) {
  const t = performance.now();
  const ix = new ProjectIndex(repo!, opts);
  if (saved) ix.load(await readIndexFile(file));
  const ready = performance.now() - t;
  let searchReady = 0;
  let verified = 0;
  const [, mode] = await Promise.all([
    saved ? ix.loadDocs(docsFileOf(file)).then(() => (searchReady = performance.now() - t)) : undefined,
    ix.catchUp(journal).then((m) => ((verified = performance.now() - t), m)),
  ]);
  if (!saved) searchReady = verified;
  const indexed = (await ix.list()).filter((r) => ix.has(r));
  const out = { mode, ready, searchReady, verified, counts: { ...ix.counts }, size: ix.size, root: ix.tree.root(), changed: ix.changes()?.total, indexed };
  ix.tree.snapshot();
  await saveIndexFile(file, ix);
  return out; // the index itself is dropped: three of TypeScript's at once do not fit a runner
}
// FSEvents writes its history with a short delay; a real reopen comes much later.
const settle = () => new Promise((r) => setTimeout(r, journal ? 3000 : 0));

describe.skipIf(!repo)('project index re-open bench', () => {
  it('answers at once on re-open and verifies only what changed', async () => {
    const store = path.join(await mkdtemp(path.join(os.tmpdir(), 'fl-bench-')), 'ix.json');
    const full = await open(store, false);

    // Any indexed files, spread over the tree.
    const picked = Array.from({ length: 20 }, (_, i) => full.indexed[Math.floor((i * full.indexed.length) / 20)]);
    expect(new Set(picked).size).toBe(20);
    for (const r of picked.slice(0, 10)) await appendFile(path.join(repo!, r), '\n// touched by the index bench\n');
    await settle();
    const edited = await open(store, true);

    // A branch switch that rewrites 10 files with the same content: stat changes, content does not.
    const now = new Date(Date.now() + 10_000);
    for (const r of picked.slice(10, 20)) await utimes(path.join(repo!, r), now, now);
    await settle();
    const touched = await open(store, true);

    const ms = (n: number) => `${n.toFixed(0)} ms`;
    const rows = [
      ['Full build', full],
      ['Re-open, 10 files edited', edited],
      ['Re-open, 10 files touched (same content)', touched],
    ] as const;
    const table = [
      `Project index on ${path.basename(repo!)} (${process.platform}): ${full.size.toLocaleString()} files, root ${full.root.slice(0, 12)}, journal ${journal ? 'FSEvents' : 'none'}`,
      '',
      '| Scenario | Tree ready | Search ready | Verified | How | Stats | Reads | Re-indexed |',
      '|---|---|---|---|---|---|---|---|',
      ...rows.map(([name, r]) => `| ${name} | ${name === 'Full build' ? '–' : ms(r.ready)} | ${ms(r.searchReady)} | ${ms(r.verified)} | ${r.mode} | ${r.counts.stat} | ${r.counts.read} | ${r.counts.reindex} |`),
      '',
      `Changed since the open (edited run): ${edited.changed}`,
    ].join('\n');
    console.log(table);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, table + '\n');
    if (process.env.FL_INDEX_BENCH_OUT) await writeFile(process.env.FL_INDEX_BENCH_OUT, table + '\n');

    expect([edited.counts.read, edited.counts.reindex]).toEqual([10, 10]);
    expect([touched.counts.read, touched.counts.reindex]).toEqual([10, 0]);
    expect(edited.changed).toBe(10);
    // Fixed costs (git status, the helper) outweigh a full build only on tiny folders.
    if (full.size > 10_000) expect(edited.verified).toBeLessThan(full.verified);
    if (journal) expect([edited.mode, touched.mode]).toEqual(['journal', 'journal']);
  }, 600_000);
});
