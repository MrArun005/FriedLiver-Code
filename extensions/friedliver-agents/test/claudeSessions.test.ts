import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeCwd, listClaudeSessions, parseSession, sessionWorking } from '../src/host/claudeSessions';

const FIX = path.join(__dirname, 'fixtures/claude-sessions');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

/** A fake home with the fixtures as one workspace's Claude Code sessions. */
function home(ws: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-cc-'));
  const proj = path.join(dir, '.claude', 'projects', encodeCwd(ws));
  fs.mkdirSync(proj, { recursive: true });
  fs.copyFileSync(path.join(FIX, 'titled.jsonl'), path.join(proj, `${A}.jsonl`));
  fs.copyFileSync(path.join(FIX, 'untitled.jsonl'), path.join(proj, `${B}.jsonl`));
  fs.writeFileSync(path.join(proj, 'not-a-session.jsonl'), '{}\n');
  fs.mkdirSync(path.join(proj, A, 'subagents'), { recursive: true });
  fs.utimesSync(path.join(proj, `${A}.jsonl`), new Date(2000), new Date(2000));
  fs.utimesSync(path.join(proj, `${B}.jsonl`), new Date(1000), new Date(1000));
  return dir;
}

describe('Claude Code sessions', () => {
  it('encodes a folder the way Claude Code names its project folder', () => {
    expect(encodeCwd('/Users/arunmallikarjun/HRMS')).toBe('-Users-arunmallikarjun-HRMS');
    expect(encodeCwd('/a/b.c_d e')).toBe('-a-b-c-d-e');
  });

  it('reads title, messages and subagents from a transcript', () => {
    const s = parseSession(fs.readFileSync(path.join(FIX, 'titled.jsonl'), 'utf8'));
    expect(s.title).toBe('Payroll export');
    // One real prompt and two assistant messages; meta, tool results and sidechain lines don't count.
    expect(s.messages).toBe(3);
    expect(s.subagents).toEqual([
      { id: 'toolu_A', title: 'Write the exporter', done: true },
      { id: 'toolu_B', title: 'Review the exporter', done: false },
    ]);
  });

  it('falls back to the first prompt, clipped, for a title', () => {
    const s = parseSession(fs.readFileSync(path.join(FIX, 'untitled.jsonl'), 'utf8'));
    expect(s.title.startsWith('Fix the flaky login test')).toBe(true);
    expect(s.title.length).toBeLessThanOrEqual(80);
  });

  it('lists a folder’s sessions, newest first, skipping ones FriedLiver owns', async () => {
    const ws = '/work/my app';
    const h = home(ws);
    const all = await listClaudeSessions({ home: h, folders: [ws] });
    expect(all.map((s) => s.id)).toEqual([A, B]);
    expect(all[0]).toMatchObject({ cwd: ws, title: 'Payroll export', lastActivity: 2000, messages: 3 });
    expect((await listClaudeSessions({ home: h, folders: [ws], skip: new Set([A]) })).map((s) => s.id)).toEqual([B]);
    expect((await listClaudeSessions({ home: h, folders: [ws], limit: 1 })).map((s) => s.id)).toEqual([A]);
  });

  it('finds nothing for a folder without sessions, or one that escapes the projects folder', async () => {
    const h = home('/work/app');
    expect(await listClaudeSessions({ home: h, folders: ['/elsewhere'] })).toEqual([]);
    expect(await listClaudeSessions({ home: h, folders: ['..'] })).toEqual([]);
  });

  it('ignores a session file that is a link to somewhere else', async () => {
    const ws = '/work/app';
    const h = home(ws);
    const proj = path.join(h, '.claude', 'projects', encodeCwd(ws));
    const C = '33333333-3333-4333-8333-333333333333';
    try {
      fs.symlinkSync(path.join(FIX, 'titled.jsonl'), path.join(proj, `${C}.jsonl`));
    } catch {
      return;
    }
    expect((await listClaudeSessions({ home: h, folders: [ws] })).map((s) => s.id)).not.toContain(C);
  });

  it('counts a session as working when it changed in the last two minutes', () => {
    expect(sessionWorking(1_000_000, 1_000_000 + 119_000)).toBe(true);
    expect(sessionWorking(1_000_000, 1_000_000 + 121_000)).toBe(false);
  });
});
