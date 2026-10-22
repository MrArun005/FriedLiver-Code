import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ImageStore, identity, removeTemp, sweepOld, trustedRoot } from '../src/host/imageStore';

/** A real PNG, w × h, filled with one grey so different seeds hash differently. */
function png(w: number, h: number, seed = 0): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)) >>> 0, 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const rows = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(w, seed & 255)])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

let base: string;
let store: string;
let temp: string;
let user: string;
let clock: number;
const DAY = 86_400_000;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fl-store-')));
  store = path.join(base, 'storage', 'images');
  temp = path.join(base, 'agent-temp');
  user = path.join(base, 'workspace');
  fs.mkdirSync(temp, { recursive: true });
  fs.mkdirSync(user, { recursive: true });
  clock = 1_000 * DAY;
});
afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

const write = (dir: string, name: string, bytes: Buffer) => {
  const f = path.join(dir, name);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, bytes);
  return f;
};
const roots = () => [temp, user];
const make = async () => {
  const s = new ImageStore(store, { tempRoots: async () => [temp], now: () => clock });
  await s.load();
  return s;
};

describe('removeTemp: deletes only inside the allowlist', () => {
  it('removes an allowlisted image that is still the file it was', async () => {
    const f = write(temp, 'a/shot.png', png(4, 4));
    const id = await identity(f);
    expect(await removeTemp(f, [temp], id!)).toBe(true);
    expect(fs.existsSync(f)).toBe(false);
  });

  it('never removes a user file outside the allowlist', async () => {
    const f = write(user, 'design.png', png(4, 4));
    expect(await removeTemp(f, [temp], (await identity(f))!)).toBe(false);
    expect(fs.existsSync(f)).toBe(true);
  });

  it('refuses .. traversal out of an allowlisted folder', async () => {
    const f = write(user, 'design.png', png(4, 4));
    const sneaky = `${temp}/../workspace/design.png`;
    expect(await removeTemp(sneaky, [temp], (await identity(f))!)).toBe(false);
    expect(fs.existsSync(f)).toBe(true);
  });

  it('refuses a sibling folder that only shares the prefix', async () => {
    const f = write(`${temp}-evil`, 'x.png', png(4, 4));
    expect(await removeTemp(f, [temp], (await identity(f))!)).toBe(false);
    expect(fs.existsSync(f)).toBe(true);
  });

  it('refuses a symlinked file, and leaves its target alone', async () => {
    const target = write(user, 'design.png', png(4, 4));
    const link = path.join(temp, 'link.png');
    fs.symlinkSync(target, link);
    expect(await identity(link)).toBeNull();
    expect(await removeTemp(link, [temp], (await identity(target))!)).toBe(false);
    expect(fs.existsSync(target) && fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it('refuses a folder symlink inside the allowlist that leads outside', async () => {
    const target = write(user, 'secret/design.png', png(4, 4));
    fs.symlinkSync(path.join(user, 'secret'), path.join(temp, 'dir'));
    const via = path.join(temp, 'dir', 'design.png');
    expect(await removeTemp(via, [temp], (await identity(target))!)).toBe(false);
    expect(fs.existsSync(target)).toBe(true);
  });

  it('refuses a file swapped in after the check (TOCTOU): identity must still match', async () => {
    const f = write(temp, 'shot.png', png(4, 4));
    const before = (await identity(f))!;
    fs.rmSync(f);
    write(temp, 'shot.png', png(4, 4, 9));
    expect(await removeTemp(f, [temp], before)).toBe(false);
    expect(fs.existsSync(f)).toBe(true);
  });

  it('refuses non-images and folders', async () => {
    const f = write(temp, 'notes.txt', Buffer.from('hi'));
    expect(await removeTemp(f, [temp], { dev: 0, ino: 0, size: 2, mtimeMs: 0 })).toBe(false);
    expect(await identity(f)).toBeNull();
    expect(await identity(temp)).toBeNull();
    expect(fs.existsSync(f)).toBe(true);
  });

  it('refuses a NUL in the name and a relative path', async () => {
    const f = write(temp, 'shot.png', png(4, 4));
    const id = (await identity(f))!;
    expect(await removeTemp(`${f}\0.png`, [temp], id)).toBe(false);
    expect(await removeTemp('shot.png', [temp], id)).toBe(false);
    expect(fs.existsSync(f)).toBe(true);
  });
});

// POSIX only: ownership by uid and group/world-writable bits don't exist on Windows (no process.getuid).
describe.skipIf(process.platform === 'win32')('trusted roots: a root another user could control is dropped', () => {
  const uid = process.getuid?.() ?? -1;

  it('accepts a folder of this user that only it can write to', async () => {
    expect(await trustedRoot(temp, uid)).toBe(temp);
  });

  it('refuses a root that is a symlink (a pre-created /tmp/claude-<uid> -> your home)', async () => {
    const victim = write(user, 'notes.png', png(4, 4));
    const fake = path.join(base, 'claude-fake');
    fs.symlinkSync(user, fake);
    expect(await trustedRoot(fake, uid)).toBeNull();
    expect(await removeTemp(path.join(fake, 'notes.png'), [fake], (await identity(victim))!, uid)).toBe(false);
    expect(fs.existsSync(victim)).toBe(true);
  });

  it('refuses a root owned by another user', async () => {
    const f = write(temp, 'shot.png', png(4, 4));
    expect(await trustedRoot(temp, uid + 1)).toBeNull();
    expect(await removeTemp(f, [temp], (await identity(f))!, uid + 1)).toBe(false);
    expect(fs.existsSync(f)).toBe(true);
  });

  it('refuses a group- or world-writable root', async () => {
    const f = write(temp, 'shot.png', png(4, 4));
    for (const mode of [0o777, 0o775, 0o1777]) {
      fs.chmodSync(temp, mode);
      expect(await trustedRoot(temp, uid)).toBeNull();
      expect(await removeTemp(f, [temp], (await identity(f))!, uid)).toBe(false);
    }
    fs.chmodSync(temp, 0o700);
    expect(fs.existsSync(f)).toBe(true);
  });

  it('refuses a root under a folder others may write to without the sticky bit', async () => {
    const open = path.join(base, 'open');
    const inner = path.join(open, 'claude-x');
    fs.mkdirSync(inner, { recursive: true });
    const f = write(inner, 'shot.png', png(4, 4));
    fs.chmodSync(open, 0o777);
    expect(await trustedRoot(inner, uid)).toBeNull();
    expect(await removeTemp(f, [inner], (await identity(f))!, uid)).toBe(false);
    fs.chmodSync(open, 0o1777); // sticky, like /tmp: others can't rename our folder
    expect(await trustedRoot(inner, uid)).toBe(inner);
    fs.chmodSync(open, 0o755);
  });

  it('refuses a symlink inside a trusted root that points outside', async () => {
    const victim = write(user, 'design.png', png(4, 4));
    fs.symlinkSync(user, path.join(temp, 'out'));
    expect(await removeTemp(path.join(temp, 'out', 'design.png'), [temp], (await identity(victim))!, uid)).toBe(false);
    fs.symlinkSync(victim, path.join(temp, 'v.png'));
    expect(await removeTemp(path.join(temp, 'v.png'), [temp], (await identity(victim))!, uid)).toBe(false);
    expect(fs.existsSync(victim)).toBe(true);
  });

  it('refuses a missing or relative root', async () => {
    expect(await trustedRoot(path.join(base, 'nope'), uid)).toBeNull();
    expect(await trustedRoot('tmp', uid)).toBeNull();
  });
});

describe('ImageStore copies', () => {
  it('keeps one copy per content, with a preview for a big PNG, and survives the original going', async () => {
    const s = await make();
    const a = write(temp, 'a.png', png(800, 400, 1));
    const b = write(user, 'b.png', png(800, 400, 1));
    const ca = await s.ingest(a, roots());
    const cb = await s.ingest(b, roots());
    expect(ca && cb && ca.file === cb.file).toBe(true);
    expect(fs.readdirSync(store).filter((n) => n.endsWith('.png'))).toHaveLength(2); // the copy and its preview
    expect(ca!.preview && fs.existsSync(ca!.preview)).toBeTruthy();
    expect(s.used()).toBe(fs.statSync(ca!.file).size + fs.statSync(ca!.preview!).size);
    fs.rmSync(a);
    expect((await s.ingest(a, roots()))?.file).toBe(ca!.file);
  });

  it('copies a changed file again, and refuses a non-image and a file outside the roots', async () => {
    const s = await make();
    const a = write(temp, 'a.png', png(8, 8, 1));
    const first = await s.ingest(a, roots());
    fs.writeFileSync(a, png(8, 8, 2));
    fs.utimesSync(a, new Date(), new Date(Date.now() + 5000));
    const second = await s.ingest(a, roots());
    expect(second!.file).not.toBe(first!.file);
    expect(await s.ingest(write(temp, 'fake.png', Buffer.from('not a png')), roots())).toBeNull();
    expect(await s.ingest(write(base, 'elsewhere.png', png(4, 4)), roots())).toBeNull();
  });

  it('remembers copies, pins and hidden images across a restart', async () => {
    const s = await make();
    const a = write(temp, 'a.png', png(8, 8, 1));
    await s.ingest(a, roots());
    await s.pin({ key: 'c\0a', path: a }, true);
    await s.flush();
    const again = await make();
    expect(again.pinned()).toEqual(['c\0a']);
    expect(again.used()).toBe(s.used());
  });
});

describe('Done looking', () => {
  it('removes copies and temp originals, never user originals; pinned images stay', async () => {
    const s = await make();
    const tmp = write(temp, 'shot.png', png(8, 8, 1));
    const mine = write(user, 'logo.png', png(8, 8, 2));
    const kept = write(temp, 'kept.png', png(8, 8, 3));
    const gallery = [
      { key: 'c\0shot', path: tmp },
      { key: 'c\0logo', path: mine },
      { key: 'c\0kept', path: kept },
      { key: 'c\0data' },
    ];
    for (const g of gallery) if (g.path) await s.ingest(g.path, roots());
    await s.pin(gallery[2], true);
    await s.done(gallery, gallery);
    expect(s.hidden().sort()).toEqual(['c\0data', 'c\0logo', 'c\0shot']);
    const r = await s.commit(gallery);
    expect(r).toEqual({ copies: 2, originals: 1 });
    expect(fs.existsSync(tmp)).toBe(false);
    expect(fs.existsSync(mine)).toBe(true);
    expect(fs.existsSync(kept)).toBe(true);
    expect((await s.ingest(kept, roots()))?.file).toBeTruthy();
    expect(s.used()).toBe(fs.statSync((await s.ingest(kept, roots()))!.file).size);
  });

  it('keeps a copy another visible chat still shows (dedupe), and its temp original', async () => {
    const s = await make();
    const shot = write(temp, 'shot.png', png(8, 8, 1));
    const gallery = [
      { key: 'one\0shot', path: shot },
      { key: 'two\0shot', path: shot },
    ];
    await s.ingest(shot, roots());
    await s.done([gallery[0]], gallery);
    expect(await s.commit(gallery)).toEqual({ copies: 0, originals: 0 });
    expect(fs.existsSync(shot)).toBe(true);
    expect(s.used()).toBeGreaterThan(0);
  });

  it('undo brings everything back and deletes nothing', async () => {
    const s = await make();
    const shot = write(temp, 'shot.png', png(8, 8, 1));
    const gallery = [{ key: 'c\0shot', path: shot }];
    await s.ingest(shot, roots());
    await s.done(gallery, gallery);
    s.undo();
    expect(s.hidden()).toEqual([]);
    expect(await s.commit(gallery)).toEqual({ copies: 0, originals: 0 });
    expect(fs.existsSync(shot)).toBe(true);
  });

  it('a temp original replaced during the undo window is left alone', async () => {
    const s = await make();
    const shot = write(temp, 'shot.png', png(8, 8, 1));
    const gallery = [{ key: 'c\0shot', path: shot }];
    await s.done(gallery, gallery);
    fs.rmSync(shot);
    write(temp, 'shot.png', png(8, 8, 7));
    expect((await s.commit(gallery)).originals).toBe(0);
    expect(fs.existsSync(shot)).toBe(true);
  });

  it('a second Done commits the first', async () => {
    const s = await make();
    const a = write(temp, 'a.png', png(8, 8, 1));
    const b = write(temp, 'b.png', png(8, 8, 2));
    const gallery = [
      { key: 'c\0a', path: a },
      { key: 'd\0b', path: b },
    ];
    await s.done([gallery[0]], gallery);
    await s.done([gallery[1]], gallery);
    expect(fs.existsSync(a)).toBe(false);
    s.undo();
    expect(s.hidden()).toEqual(['c\0a']);
    expect(fs.existsSync(b)).toBe(true);
  });
});

describe('the safety net: cap and age', () => {
  it('evicts the oldest unpinned copies past the cap, and anything past the age; pinned stay', async () => {
    const s = await make();
    const files = [1, 2, 3, 4].map((n) => write(temp, `${n}.png`, png(64, 64, n)));
    for (const f of files) {
      await s.ingest(f, roots());
      clock += 1000;
    }
    const one = s.used() / 4;
    await s.pin({ key: 'c\0one', path: files[0] }, true);
    await s.enforce({ capBytes: Math.ceil(one * 2), maxAgeMs: 30 * DAY });
    expect(s.used()).toBe(one * 2);
    for (const f of files) fs.rmSync(f);
    const copies = () => Promise.all(files.map(async (f) => !!(await s.ingest(f, roots()))));
    // 1 is pinned, so it stays although it is the oldest; 2 and 3 go; 4 is the newest.
    expect(await copies()).toEqual([true, false, false, true]);

    clock += 31 * DAY;
    await s.enforce({ capBytes: 1e12, maxAgeMs: 30 * DAY });
    expect(await copies()).toEqual([true, false, false, false]);
  });

  it('sweepOld deletes old images only inside FriedLiver screenshot folders', async () => {
    const shots = path.join(base, 'storage', 'shots-abc123');
    const old = write(shots, 'screenshot-1.png', png(4, 4));
    const fresh = write(shots, 'screenshot-2.png', png(4, 4, 1));
    const other = write(path.join(base, 'storage', 'checkpoints'), 'x.png', png(4, 4));
    const past = new Date(Date.now() - 10 * DAY);
    fs.utimesSync(old, past, past);
    fs.utimesSync(other, past, past);
    fs.symlinkSync(path.join(user, 'design.png'), path.join(shots, 'link.png'));
    write(user, 'design.png', png(4, 4));
    fs.utimesSync(path.join(user, 'design.png'), past, past);
    expect(await sweepOld(path.join(base, 'storage'), 7 * DAY, new Set())).toBe(1);
    expect([fs.existsSync(old), fs.existsSync(fresh), fs.existsSync(other), fs.existsSync(path.join(user, 'design.png'))]).toEqual([false, true, true, true]);
    fs.utimesSync(fresh, past, past);
    expect(await sweepOld(path.join(base, 'storage'), 7 * DAY, new Set([fresh]))).toBe(0);
  });
});
