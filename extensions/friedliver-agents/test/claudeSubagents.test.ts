// Subagents of a Claude Code session started outside FriedLiver, from a synthetic copy of the real layout:
// <session>.jsonl (background Agent calls, "Async agent launched" results, <task-notification> messages, API request logs)
// and <session>/subagents/agent-<id>.{jsonl,meta.json}.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeCwd, listClaudeSessions } from '../src/host/claudeSessions';
import { claudeColumn, claudeSubagents } from '../src/shared/view';

const S = '66666666-6666-4666-8666-666666666666';
const WS = '/work/hrms';
const NOW = Date.UTC(2026, 9, 17, 14, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const min = 60_000;
const j = (o: unknown) => `${JSON.stringify(o)}\n`;

const user = (at: number, content: unknown, extra: object = {}) => j({ type: 'user', isSidechain: false, timestamp: iso(at), message: { role: 'user', content }, ...extra });
const assistant = (at: number, id: string, content: unknown[]) => j({ type: 'assistant', isSidechain: false, timestamp: iso(at), message: { id, role: 'assistant', content } });
const agentCall = (at: number, id: string, description: string, background = true) =>
  assistant(at, `msg_${id}`, [{ type: 'tool_use', id, name: 'Agent', input: { description, prompt: '...', subagent_type: 'general-purpose', ...(background ? { run_in_background: true } : {}) } }]);
const launched = (at: number, id: string) => user(at, [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'Async agent launched successfully. agentId: x' }] }]);
const notice = (at: number, task: string, status: string, toolUseId?: string) =>
  user(
    at,
    `<task-notification>\n<task-id>${task}</task-id>\n${toolUseId ? `<tool-use-id>${toolUseId}</tool-use-id>\n` : ''}<status>${status}</status>\n<summary>Agent finished</summary>\n</task-notification>`,
    { origin: { kind: 'task-notification' }, promptSource: 'system' },
  );
/** An API request log line: the bulk of a real transcript's bytes. */
const blob = (kb: number) => j({ type: 'api-request-blob', body: 'x'.repeat(kb * 1024) });

/** One agent's own transcript. `steps` are tool calls; `end` closes it with the hand-back or a final reply. */
function agentLog(start: number, steps: string[], end?: 'handback' | 'text', resumeAt?: number): string {
  let t = start;
  let out = user(t, 'Do the work') + user(t, '<system-reminder>hand back when done</system-reminder>');
  steps.forEach((cmd, i) => {
    t += 10_000;
    out += assistant(t, `m${i}`, [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: cmd } }]);
    out += user(t + 1000, [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'ok' }]);
  });
  if (end === 'handback') {
    t += 10_000;
    out += assistant(t, 'mh', [{ type: 'tool_use', id: 'th', name: 'SubagentHandback', input: { message: 'report' } }]);
    out += user(t + 500, [{ type: 'tool_result', tool_use_id: 'th', content: [{ type: 'text', text: '{"success":true}' }] }]);
  } else if (end === 'text') {
    t += 10_000;
    out += assistant(t, 'mf', [{ type: 'text', text: 'All done.' }]);
  }
  if (resumeAt !== undefined) {
    out += user(resumeAt, 'The coordinator sent a message while you were working: keep going');
    out += assistant(resumeAt + 5000, 'mr', [{ type: 'tool_use', id: 'tr', name: 'Bash', input: { command: 'npx vitest run' } }]);
  }
  return out;
}

interface Agent {
  id: string;
  call: string;
  description: string;
  log: string;
  mtime: number;
  depth?: number;
}

function build(): { home: string; proj: string; parent: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-ccsub-'));
  const proj = path.join(home, '.claude', 'projects', encodeCwd(WS));
  const subs = path.join(proj, S, 'subagents');
  fs.mkdirSync(subs, { recursive: true });
  const agents: Agent[] = [
    // Finished long ago: handed back, then its completion notice.
    { id: 'a1111', call: 'toolu_done', description: 'Audit leave module', log: agentLog(NOW - 300 * min, ['grep -r leave'], 'handback'), mtime: NOW - 300 * min + 20_500 },
    // Stopped by an app restart, resumed with SendMessage, writing right now: one entry, Working.
    { id: 'a2222', call: 'toolu_resumed', description: 'Integrate branches, rebuild UI', log: agentLog(NOW - 200 * min, ['git merge'], undefined, NOW - 20_000), mtime: NOW - 15_000 },
    // In the middle of a long tool call: quiet for 5 minutes, its last record a tool call's result.
    { id: 'a3333', call: 'toolu_quiet', description: 'Images gallery per agent tab', log: agentLog(NOW - 40 * min, ['npm test', 'npx tsc']), mtime: NOW - 5 * min },
    // Stopped by a restart and never resumed: a Problem.
    { id: 'a4444', call: 'toolu_stopped', description: 'Fix updater', log: agentLog(NOW - 100 * min, ['ls']), mtime: NOW - 95 * min },
    // Launched by another subagent: its call isn't in the parent transcript.
    { id: 'a5555', call: 'toolu_nested', description: 'Nested helper', log: agentLog(NOW - 2 * min, ['cat a.ts']), mtime: NOW - 10_000, depth: 2 },
  ];
  for (const a of agents) {
    const meta = path.join(subs, `agent-${a.id}.meta.json`);
    const log = path.join(subs, `agent-${a.id}.jsonl`);
    fs.writeFileSync(meta, JSON.stringify({ agentType: 'general-purpose', description: a.description, toolUseId: a.call, spawnDepth: a.depth ?? 1, requestShape: 'background', model: 'opus' }));
    fs.writeFileSync(log, a.log);
    fs.utimesSync(log, new Date(a.mtime), new Date(a.mtime));
  }
  // The parent: the early agent calls, then over 8 MB of request logs, as in a long-running session.
  let p = j({ type: 'ai-title', aiTitle: 'IDE identification question' });
  p += user(NOW - 301 * min, 'which IDE is this');
  p += agentCall(NOW - 300 * min, 'toolu_done', 'Audit leave module') + launched(NOW - 300 * min, 'toolu_done');
  p += agentCall(NOW - 200 * min, 'toolu_resumed', 'Integrate branches, rebuild UI') + launched(NOW - 200 * min, 'toolu_resumed');
  p += agentCall(NOW - 100 * min, 'toolu_stopped', 'Fix updater') + launched(NOW - 100 * min, 'toolu_stopped');
  p += notice(NOW - 289 * min, 'a1111', 'completed', 'toolu_done');
  p += notice(NOW - 90 * min, 'a4444', 'stopped');
  p += notice(NOW - 60 * min, 'a2222', 'stopped');
  // A foreground Task call with no transcript of its own: done by its result.
  p += assistant(NOW - 50 * min, 'msg_fg', [{ type: 'tool_use', id: 'toolu_fg', name: 'Task', input: { description: 'Quick review', prompt: '...' } }]);
  p += user(NOW - 49 * min, [{ type: 'tool_result', tool_use_id: 'toolu_fg', content: [{ type: 'text', text: 'Looks fine.' }] }]);
  for (let i = 0; i < 9; i++) p += blob(1024);
  p += agentCall(NOW - 40 * min, 'toolu_quiet', 'Images gallery per agent tab') + launched(NOW - 40 * min, 'toolu_quiet');
  const parent = path.join(proj, `${S}.jsonl`);
  fs.writeFileSync(parent, p);
  fs.utimesSync(parent, new Date(NOW - 3 * min), new Date(NOW - 3 * min));
  return { home, proj, parent };
}

const states = (s: Parameters<typeof claudeSubagents>[0], now = NOW) => Object.fromEntries(claudeSubagents(s, now).map((a) => [a.title, a.state]));

describe('Claude Code subagents', () => {
  it('lists every agent of a long session with its real state, background ones included', async () => {
    const { home } = build();
    const [s] = await listClaudeSessions({ home, folders: [WS], now: NOW });
    expect(s.id).toBe(S);
    expect(s.title).toBe('IDE identification question');
    expect(states(s)).toEqual({
      'Audit leave module': 'done',
      'Integrate branches, rebuild UI': 'working',
      'Images gallery per agent tab': 'working',
      'Fix updater': 'failed',
      'Nested helper': 'working',
      'Quick review': 'done',
    });
    // A working agent keeps the session working even when the parent transcript is quiet.
    expect(claudeColumn(s, NOW)).toBe('working');
    const quiet = claudeSubagents(s, NOW).find((a) => a.title === 'Images gallery per agent tab')!;
    expect(quiet).toMatchObject({ tools: 2, last: 'Bash · npx tsc', about: 'general-purpose · opus', startedAt: NOW - 40 * min });
    const done = claudeSubagents(s, NOW).find((a) => a.title === 'Audit leave module')!;
    expect(done.ms).toBe(10_000 + 10_000 + 500);
  });

  it('never calls a silent agent Done: after 30 minutes without completion evidence it is Quiet', async () => {
    const { home } = build();
    const [s] = await listClaudeSessions({ home, folders: [WS], now: NOW });
    expect(states(s, NOW + 2 * min)['Integrate branches, rebuild UI']).toBe('working');
    const later = claudeSubagents(s, NOW + 27 * min);
    expect(later.find((a) => a.title === 'Images gallery per agent tab')).toMatchObject({ state: 'quiet', note: 'No activity for 32m' });
    // Real completion evidence still reads Done, a stop still a Problem.
    expect(later.find((a) => a.title === 'Audit leave module')?.state).toBe('done');
    expect(later.find((a) => a.title === 'Fix updater')?.state).toBe('failed');
  });

  it('reads an unsettled agent with no transcript as Quiet once its session stops, not Done', () => {
    const s = { id: S, cwd: WS, title: 't', lastActivity: NOW, messages: 1, subagents: [{ id: 'b', title: 'Background, old Claude Code' }] };
    expect(claudeSubagents(s, NOW + 60_000)[0].state).toBe('working');
    expect(claudeSubagents(s, NOW + 5 * min)[0]).toMatchObject({ state: 'quiet', note: 'No activity for 5m' });
  });

  it('reads only what was appended, and picks up a new agent and a finished one', async () => {
    const { home, proj, parent } = build();
    await listClaudeSessions({ home, folders: [WS], now: NOW });
    // Rewrite a byte range already read: an incremental reader never sees it.
    const fd = fs.openSync(parent, 'r+');
    const head = Buffer.from(j({ type: 'ai-title', aiTitle: 'IDE identification question' }));
    fs.writeSync(fd, Buffer.from(head.toString().replace('IDE identification question', 'XXX identification question')), 0, head.length, 0);
    fs.closeSync(fd);
    fs.appendFileSync(parent, agentCall(NOW, 'toolu_new', 'Debug outside-session agents') + launched(NOW, 'toolu_new') + notice(NOW + 1000, 'a3333', 'completed', 'toolu_quiet'));
    const subs = path.join(proj, S, 'subagents');
    fs.appendFileSync(path.join(subs, 'agent-a3333.jsonl'), user(NOW - 4 * min, [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]));
    const [s] = await listClaudeSessions({ home, folders: [WS], now: NOW + 2000 });
    expect(s.title).toBe('IDE identification question');
    const st = states(s, NOW + 2000);
    expect(st['Images gallery per agent tab']).toBe('done');
    expect(st['Debug outside-session agents']).toBe('working');
  });

  it('keeps a session with subagents even when its talk alone looks trivial', async () => {
    const { home, parent } = build();
    // Only a greeting and an agent's notice: no tool use left in the parent.
    fs.writeFileSync(parent, user(NOW - min, 'hi') + notice(NOW - min, 'a2222', 'completed'));
    const list = await listClaudeSessions({ home, folders: [WS], now: NOW });
    expect(list.map((s) => s.id)).toEqual([S]);
    expect(list[0].subagents.length).toBe(5);
  });
});

describe('a window with no folder', () => {
  const day = 86_400_000;
  /** Sessions in two projects, as the Claude Code extension writes them; `cwd` is on every record. */
  function projects(): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-ccall-'));
    const add = (cwd: string, id: string, age: number, body: string) => {
      const dir = path.join(home, '.claude', 'projects', encodeCwd(cwd));
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${id}.jsonl`);
      fs.writeFileSync(file, body.split('\n').filter(Boolean).map((l) => JSON.stringify({ ...JSON.parse(l), cwd })).join('\n') + '\n');
      fs.utimesSync(file, new Date(NOW - age), new Date(NOW - age));
    };
    const work = (title: string) => j({ type: 'ai-title', aiTitle: title }) + user(NOW - day, 'Fix the payslip rounding for arrears') + assistant(NOW - day, 'm1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }]);
    add('/Users/a/HRMS', '70000000-0000-4000-8000-000000000001', 2 * min, work('Payroll rounding'));
    add('/Users/a/code/FriedLiver-Code', '70000000-0000-4000-8000-000000000002', 1 * min, work('Map layout'));
    add('/Users/a/HRMS', '70000000-0000-4000-8000-000000000003', 3 * min, work('Leave carry-over'));
    add('/Users/a/HRMS', '70000000-0000-4000-8000-000000000004', 9 * day, work('Old one'));
    add('/Users/a/HRMS', '70000000-0000-4000-8000-000000000005', 1 * min, user(NOW, 'hi'));
    // A transcript whose recorded folder isn't the one its project folder names: it can't be resumed from here.
    const odd = path.join(home, '.claude', 'projects', '-Users-a-Other');
    fs.mkdirSync(odd, { recursive: true });
    fs.writeFileSync(path.join(odd, '70000000-0000-4000-8000-000000000006.jsonl'), JSON.stringify({ type: 'ai-title', aiTitle: 'Odd', cwd: '/Users/a/HRMS' }) + '\n' + work('Odd'));
    return home;
  }

  it('lists recent sessions from every project, grouped by project, newest project first', async () => {
    const list = await listClaudeSessions({ home: projects(), folders: [], now: NOW });
    expect(list.map((s) => [s.project, s.title, s.cwd])).toEqual([
      ['FriedLiver-Code', 'Map layout', '/Users/a/code/FriedLiver-Code'],
      ['HRMS', 'Payroll rounding', '/Users/a/HRMS'],
      ['HRMS', 'Leave carry-over', '/Users/a/HRMS'],
    ]);
  });

  it('keeps older and trivial ones with showAll', async () => {
    const list = await listClaudeSessions({ home: projects(), folders: [], now: NOW, showAll: true });
    expect(list.map((s) => s.title)).toEqual(expect.arrayContaining(['Old one', 'HRMS · 2026-10-17']));
    expect(list).toHaveLength(5);
  });

  /** A headless run, as the security-review hook writes them: every record says entrypoint sdk-py. */
  const headless = (home: string, cwd: string, id: string, age: number) => {
    const dir = path.join(home, '.claude', 'projects', encodeCwd(cwd));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.jsonl`);
    const rec = { cwd, entrypoint: 'sdk-py', userType: 'external', isSidechain: false };
    fs.writeFileSync(
      file,
      [
        { type: 'user', message: { role: 'user', content: 'Review this change for security vulnerabilities.' }, promptSource: 'sdk', timestamp: iso(NOW - age) },
        { type: 'assistant', message: { id: 'm', role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Read', input: { file_path: 'a.ts' } }] }, timestamp: iso(NOW - age) },
      ]
        .map((o) => JSON.stringify({ ...o, ...rec }))
        .join('\n') + '\n',
    );
    fs.utimesSync(file, new Date(NOW - age), new Date(NOW - age));
  };
  const hex = (n: number) => `80000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

  it('hides headless runs (SDK entrypoints other than FriedLiver’s own) unless showAll', async () => {
    const home = projects();
    headless(home, '/Users/a/code/wt-v5', hex(1), 10_000);
    const ids = async (showAll: boolean) => (await listClaudeSessions({ home, folders: [], now: NOW, showAll })).map((s) => s.id);
    expect(await ids(false)).not.toContain(hex(1));
    expect(await ids(true)).toContain(hex(1));
    // In a folder window too.
    expect((await listClaudeSessions({ home, folders: ['/Users/a/code/wt-v5'], now: NOW })).map((s) => s.id)).toEqual([]);
  });

  it('lists up to 100 sessions, counting only the ones it shows', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-cccap-'));
    for (let i = 0; i < 60; i++) headless(home, '/Users/a/code/wt-v5', hex(1000 + i), i * 1000);
    const dir = path.join(home, '.claude', 'projects', encodeCwd('/Users/a/HRMS'));
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 110; i++) {
      const file = path.join(dir, `${hex(i)}.jsonl`);
      fs.writeFileSync(file, [user(NOW, 'Fix the payslip rounding for arrears'), assistant(NOW, 'm', [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'ls' } }])].map((l) => JSON.stringify({ ...JSON.parse(l), cwd: '/Users/a/HRMS', entrypoint: 'claude-vscode' })).join('\n') + '\n');
      fs.utimesSync(file, new Date(NOW - 60_000 - i * 1000), new Date(NOW - 60_000 - i * 1000));
    }
    const list = await listClaudeSessions({ home, folders: [], now: NOW });
    expect(list).toHaveLength(100);
    expect(list.every((s) => s.project === 'HRMS')).toBe(true);
  });

  it('names no project for a window that has folders', async () => {
    const { home } = build();
    const [s] = await listClaudeSessions({ home, folders: [WS], now: NOW });
    expect(s.project).toBeUndefined();
  });
});
