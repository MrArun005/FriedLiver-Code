import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeCwd, listClaudeSessions, parseSession } from '../src/host/claudeSessions';
import type { ClaudeSession } from '../src/shared/messages';
import { claudeColumn, claudeSubagents, filterClaudeSessions } from '../src/shared/view';

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
      { id: 'toolu_A', title: 'Write the exporter', end: 'done' },
      { id: 'toolu_B', title: 'Review the exporter' },
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

  it('puts a session in Working while it changed in the last two minutes, its open subagents with it', () => {
    const s: ClaudeSession = { id: A, cwd: '/w', title: 'Payroll export', lastActivity: 1_000_000, messages: 3, subagents: [{ id: 't1', title: 'x' }, { id: 't2', title: 'y', end: 'done' }] };
    expect(claudeColumn(s, 1_000_000 + 119_000)).toBe('working');
    expect(claudeSubagents(s, 1_000_000 + 119_000).map((a) => a.state)).toEqual(['working', 'done']);
    expect(claudeColumn(s, 1_000_000 + 121_000)).toBe('done');
    expect(claudeSubagents(s, 1_000_000 + 121_000).map((a) => a.state)).toEqual(['done', 'done']);
    expect(filterClaudeSessions([s], 'payroll claude')).toEqual([s]);
    expect(filterClaudeSessions([s], 'codex')).toEqual([]);
  });

  const parse = (f: string) => parseSession(fs.readFileSync(path.join(FIX, f), 'utf8'));

  it('marks greeting-only sessions without tool use as trivial, never ones with tools', () => {
    expect(parse('greeting.jsonl').trivial).toBe(true);
    expect(parse('short-with-tools.jsonl').trivial).toBe(false);
    expect(parse('titled.jsonl').trivial).toBe(false);
    expect(parse('untitled.jsonl').trivial).toBe(false);
  });

  it('titles from the first real prompt, skipping greetings, slash and shell commands', () => {
    expect(parse('shell-first.jsonl').title).toBe('Why does the payslip PDF cut off the last row?');
    expect(parse('only-commands.jsonl').title).toBe('');
  });

  it('hides trivial sessions, archives ones idle for a week, and shows all on request', async () => {
    const ws = '/work/my app';
    const h = home(ws);
    const proj = path.join(h, '.claude', 'projects', encodeCwd(ws));
    const G = '44444444-4444-4444-8444-444444444444';
    const C = '55555555-5555-4555-8555-555555555555';
    fs.copyFileSync(path.join(FIX, 'greeting.jsonl'), path.join(proj, `${G}.jsonl`));
    fs.copyFileSync(path.join(FIX, 'only-commands.jsonl'), path.join(proj, `${C}.jsonl`));
    const day = 86_400_000;
    const now = Date.UTC(2026, 9, 17);
    fs.utimesSync(path.join(proj, `${A}.jsonl`), new Date(now - day), new Date(now - day));
    fs.utimesSync(path.join(proj, `${B}.jsonl`), new Date(now - 8 * day), new Date(now - 8 * day));
    fs.utimesSync(path.join(proj, `${C}.jsonl`), new Date(now - 2 * day), new Date(now - 2 * day));
    const list = await listClaudeSessions({ home: h, folders: [ws], now });
    expect(list.map((s) => [s.id, !!s.archived])).toEqual([[A, false], [C, false], [B, true]]);
    expect(list.find((s) => s.id === C)?.title).toBe('my app · 2026-10-15');
    const all = await listClaudeSessions({ home: h, folders: [ws], now, showAll: true });
    expect(all.map((s) => s.id)).toContain(G);
    expect(all.some((s) => s.archived)).toBe(false);
  });
});
