// The project index's change journal: what the file system recorded under a folder since a saved
// mark, so a reopened index re-checks only those paths instead of stat'ing every file. macOS only,
// through FSEvents' event history (native/friedliver-fsevents.swift, bundled at
// bin/friedliver-fsevents). Elsewhere there is no journal and the index checks every file.
// ponytail: no Windows USN journal; reading it needs a volume handle (administrator), so Windows uses the full check.
import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';

/** Where the journal stood: the volume's journal UUID and an FSEvents event id. */
export interface JournalMark {
  kind: 'fsevents';
  uuid: string;
  id: string;
}

/** Folder-relative paths changed since a mark: files to re-check, and directories to rescan whole. */
export interface JournalChanges {
  files: string[];
  dirs: string[];
  /** Where to start next time: read before the history, so nothing between is missed. */
  next: JournalMark;
}

export interface Journal {
  /** The current mark, or undefined without a journal. */
  now(root: string): Promise<JournalMark | undefined>;
  /** What changed since `mark`, or null when that can't be known for sure (then check every file). */
  since(root: string, mark: JournalMark): Promise<JournalChanges | null>;
}

const F = {
  mustScanSubDirs: 0x1,
  userDropped: 0x2,
  kernelDropped: 0x4,
  idsWrapped: 0x8,
  rootChanged: 0x20,
  mount: 0x40,
  unmount: 0x80,
  isDir: 0x20000,
};
/** Any of these and the history has holes. */
const UNTRUSTED = F.userDropped | F.kernelDropped | F.idsWrapped | F.rootChanged | F.mount | F.unmount;

export const isMark = (m: unknown): m is JournalMark => {
  const o = m as JournalMark;
  return !!o && o.kind === 'fsevents' && typeof o.uuid === 'string' && /^[\w-]{1,64}$/.test(o.uuid) && typeof o.id === 'string' && /^\d{1,20}$/.test(o.id);
};

/**
 * The helper's output for `root` (a real path), as changes since `mark`; null when anything says the
 * history is incomplete: no END, another volume journal, dropped or wrapped events, the folder itself
 * to rescan, a mount under it.
 */
export function parseJournal(out: string, root: string, mark: JournalMark): JournalChanges | null {
  const records = out.split('\0');
  const uuid = records.find((r) => r.startsWith('uuid='))?.slice(5);
  const now = records.find((r) => r.startsWith('now='))?.slice(4);
  if (!records.includes('END') || uuid !== mark.uuid || !now || !/^\d+$/.test(now)) return null;
  const files = new Set<string>();
  const dirs = new Set<string>();
  for (const r of records) {
    const m = /^E([0-9a-f]+) (.+)$/s.exec(r);
    if (!m) continue;
    const flags = parseInt(m[1], 16);
    const p = m[2];
    if (p !== root && !p.startsWith(root + '/')) continue;
    if (flags & UNTRUSTED) return null;
    const rel = p.slice(root.length + 1);
    if (!rel) {
      if (flags & F.mustScanSubDirs) return null;
      continue;
    }
    if (flags & (F.mustScanSubDirs | F.isDir)) dirs.add(rel);
    else files.add(rel);
  }
  return { files: [...files], dirs: [...dirs], next: { kind: 'fsevents', uuid, id: now } };
}

function run(helper: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) =>
    execFile(helper, args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, timeout: 30_000 }, (err, out) => resolve(err ? null : out)),
  );
}

/** The FSEvents journal through the helper at `helper`. */
export function fseventsJournal(helper: string): Journal {
  return {
    async now(root) {
      const real = await realpath(root).catch(() => null);
      const out = real && (await run(helper, [real, 'now']));
      const uuid = out?.split('\0').find((r) => r.startsWith('uuid='))?.slice(5);
      const id = out?.split('\0').find((r) => r.startsWith('now='))?.slice(4);
      const mark = { kind: 'fsevents' as const, uuid: uuid ?? '', id: id ?? '' };
      return isMark(mark) ? mark : undefined;
    },
    async since(root, mark) {
      const real = await realpath(root).catch(() => null);
      const out = real && (await run(helper, [real, 'since', mark.id]));
      return out ? parseJournal(out, real, mark) : null;
    },
  };
}

/** The bundled helper on macOS, when this build has it (dev builds may not). */
export function journalHelper(extensionPath: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform !== 'darwin') return undefined;
  const file = path.join(extensionPath, 'bin', 'friedliver-fsevents');
  try {
    if (!statSync(file).isFile()) return undefined;
    accessSync(file, constants.X_OK);
    return file;
  } catch {
    return undefined;
  }
}
