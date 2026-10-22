import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fseventsJournal, parseJournal, type JournalMark } from '../src/host/changeJournal';

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
const tmp = async (prefix: string) => {
  const d = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  dirs.push(d);
  return d;
};

const ROOT = '/r/proj';
const MARK: JournalMark = { kind: 'fsevents', uuid: 'U-1', id: '100' };
const out = (...records: string[]) => records.map((r) => r + '\0').join('');
const head = ['uuid=U-1', 'now=250'];

describe('reading the FSEvents journal', () => {
  it('splits file and directory events into folder-relative paths', () => {
    const r = parseJournal(out(...head, `E19500 ${ROOT}/a/x.ts`, `E28900 ${ROOT}/a`, `E1 ${ROOT}/deep/er`, `E11000 /r/other/y.ts`, `E11000 ${ROOT}x/z.ts`, 'END'), ROOT, MARK);
    expect(r).toEqual({ files: ['a/x.ts'], dirs: ['a', 'deep/er'], next: { kind: 'fsevents', uuid: 'U-1', id: '250' } });
  });

  it('gives up (null: check every file) when the history cannot be trusted', () => {
    const cases = {
      'no END: the helper timed out or died': out(...head, `E11000 ${ROOT}/a.ts`),
      'another journal (volume reformatted, database reset)': out('uuid=U-2', 'now=250', 'END'),
      'events dropped by the user side': out(...head, `E3 ${ROOT}/a`, 'END'),
      'events dropped by the kernel': out(...head, `E5 ${ROOT}/a`, 'END'),
      'event ids wrapped': out(...head, `E8 ${ROOT}`, 'END'),
      'the folder itself must be rescanned': out(...head, `E1 ${ROOT}`, 'END'),
      'a volume mounted or unmounted under it': out(...head, `E40 ${ROOT}/mnt`, 'END'),
      'no now': out('uuid=U-1', 'END'),
      'junk': 'garbage',
    };
    for (const [why, text] of Object.entries(cases)) expect(parseJournal(text, ROOT, MARK), why).toBeNull();
  });

  // The fake helper is a #!/bin/sh script, which Windows can't spawn; the FSEvents journal is macOS-only anyway.
  it.skipIf(process.platform === 'win32')('runs the helper and treats a failing or missing helper as no journal', async () => {
    const d = await tmp('fl-journal-');
    const fake = path.join(d, 'helper.sh');
    await writeFile(fake, `#!/bin/sh\nprintf 'uuid=U-1\\0now=300\\0E11000 %s/a.ts\\0END\\0' "$1"\n`, { mode: 0o755 });
    const j = fseventsJournal(fake);
    expect(await j.now(d)).toEqual({ kind: 'fsevents', uuid: 'U-1', id: '300' });
    expect(await j.since(d, MARK)).toEqual({ files: ['a.ts'], dirs: [], next: { kind: 'fsevents', uuid: 'U-1', id: '300' } });
    await writeFile(fake, '#!/bin/sh\nexit 4\n', { mode: 0o755 });
    expect([await j.now(d), await j.since(d, MARK)]).toEqual([undefined, null]);
    const missing = fseventsJournal(path.join(d, 'nope'));
    expect([await missing.now(d), await missing.since(d, MARK)]).toEqual([undefined, null]);
  });
});

// A built helper (native/build.sh), given by path: compiling here would slow the rest of the suite.
const helper = process.env.FL_FSEVENTS_HELPER;
describe.skipIf(process.platform !== 'darwin' || !helper || !existsSync(helper))('the real FSEvents helper (macOS)', () => {
  it('reports what changed since a mark, renames as directories, and nothing before it', async () => {
    const root = await tmp('fl-fse-root-');
    await mkdir(path.join(root, 'a'));
    await writeFile(path.join(root, 'a', 'x.ts'), '1');
    await writeFile(path.join(root, 'before.ts'), '1');
    const j = fseventsJournal(helper!);
    // Let the setup's events land before the mark.
    await new Promise((r) => setTimeout(r, 1500));
    const mark = (await j.now(root))!;
    expect(mark.id).toMatch(/^\d+$/);

    await writeFile(path.join(root, 'a', 'x.ts'), '2');
    await writeFile(path.join(root, 'new.ts'), 'n');
    await rename(path.join(root, 'a'), path.join(root, 'c'));
    await new Promise((r) => setTimeout(r, 1500));
    const r = (await j.since(root, mark))!;
    expect(r).not.toBeNull();
    expect(r.files).toContain('new.ts');
    expect(r.files).not.toContain('before.ts');
    expect(r.dirs).toEqual(expect.arrayContaining(['a', 'c']));
    expect(BigInt(r.next.id)).toBeGreaterThan(BigInt(mark.id));
    expect(await j.since(root, { ...mark, uuid: 'not-this-volume' })).toBeNull();
  }, 60_000);
});
