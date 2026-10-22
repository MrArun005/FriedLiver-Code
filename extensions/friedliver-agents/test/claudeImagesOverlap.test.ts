// The running app logged `Claude Code sessions: The value of "size" is out of range ... Received -1967420`: two
// refreshes scanned a growing transcript for images at once, both read from the same offset, and both moved it on,
// past the end of the file. Every later read then failed. Slow file reads here make the two scans overlap every time.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { encodeCwd, listClaudeImages } from '../src/host/claudeSessions';

/** A POSIX fixture path as the code resolves it: itself on macOS/Linux, on the current drive on Windows. */
const R = (p: string) => path.resolve(p);

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const slow = <T>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 30));
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      const fh = await real.open(...args);
      const read = fh.read.bind(fh) as (...a: unknown[]) => Promise<unknown>;
      return Object.assign(fh, { read: async (...a: unknown[]) => slow(await read(...a)) });
    },
  };
});

const A = '11111111-1111-4111-8111-111111111111';
const readOf = (id: string, file: string) => `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: file } }] } })}\n`;

describe('images of a growing transcript', () => {
  it('keeps its place when two scans overlap', async () => {
    const ws = '/work/race';
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-ccimg-'));
    const proj = path.join(home, '.claude', 'projects', encodeCwd(ws));
    fs.mkdirSync(path.join(proj, A, 'subagents'), { recursive: true });
    const file = path.join(proj, `${A}.jsonl`);
    fs.writeFileSync(file, readOf('r1', 'one.png'));
    const read = () => listClaudeImages({ home, folders: [ws] });
    await read();
    fs.appendFileSync(file, `{"type":"x","pad":"${'y'.repeat(100_000)}"}\n`);
    await Promise.all([read(), read()]);
    fs.appendFileSync(file, readOf('r2', 'two.png'));
    expect((await read())[0].images.map((i) => i.path)).toEqual([R('/work/race/one.png'), R('/work/race/two.png')]);
  });
});
