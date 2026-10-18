// A Claude Code subagent's own transcript read for the Agent Manager's detail sheet: the brief, the steps with short
// args, notes, token use, files, the report, secrets taken out, a cut-off last line, the bounded window, and following
// the file as it grows (only what was appended). Synthetic files in the real layout and record shapes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeCwd, listClaudeSessions, parseSession } from '../src/host/claudeSessions';
import { MAX_READ, SubagentWatch, WINDOW, detailView, parseSubagentDetail } from '../src/host/subagentDetail';
import { parseWebviewMessage } from '../src/shared/messages';
import { redactSecrets } from '../src/shared/redact';
import { mergeEntries, parentLine, type SubagentEntry, type SubagentTool } from '../src/shared/subagentDetail';

const T0 = Date.UTC(2026, 9, 18, 18, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const j = (o: unknown) => `${JSON.stringify(o)}\n`;
const user = (at: number, content: unknown, extra: object = {}) => j({ type: 'user', isSidechain: true, agentId: 'a1', timestamp: iso(at), message: { role: 'user', content }, ...extra });
const usage = (input: number, output: number, read = 0, write = 0) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: write });
/** One block per line, as Claude Code streams a message. */
const assistant = (at: number, id: string, block: object, u = usage(2, 5, 100, 10)) =>
  j({ type: 'assistant', isSidechain: true, agentId: 'a1', timestamp: iso(at), message: { model: 'claude-opus-5-5', id, role: 'assistant', content: [block], usage: u } });
const use = (id: string, name: string, input: object) => ({ type: 'tool_use', id, name, input });
const result = (at: number, id: string, content: unknown, isError = false) => user(at, [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }]);
const blob = (kb: number) => j({ type: 'api-request-blob', agentId: 'a1', message: { role: 'system', content: [{ type: 'text', text: 'x'.repeat(kb * 1024) }] } });

const BRIEF = 'Fix the token waste findings.\n\n1. **browser console** has no limit\n2. Use `npm test`';

function transcript(): string {
  let t = T0;
  let out = user(t, BRIEF);
  out += user(t, '<system-reminder>hand back when done</system-reminder>', { isMeta: true });
  out += j({ type: 'attachment', agentId: 'a1', attachment: { type: 'hook_success' } });
  out += blob(4);
  out += assistant((t += 1000), 'm1', { type: 'thinking', thinking: '', signature: 'abc' }, usage(2, 2, 100, 10));
  out += assistant(t, 'm1', use('t1', 'Bash', { command: 'git status --short && export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789', description: 'Show status' }), usage(2, 40, 100, 10));
  out += result((t += 2500), 't1', 'M src/a.ts');
  out += assistant((t += 1000), 'm2', use('t2', 'Read', { file_path: '/work/app/src/a.ts' }));
  out += result((t += 100), 't2', [{ type: 'text', text: '1 export const a = 1;' }]);
  out += assistant((t += 1000), 'm3', use('t3', 'Edit', { file_path: '/work/app/src/a.ts', old_string: 'export const a = 1;', new_string: 'export const a = 2;' }));
  out += result((t += 100), 't3', 'The file /work/app/src/a.ts has been updated successfully.');
  out += assistant((t += 1000), 'm4', use('t4', 'Grep', { pattern: 'console\\.log', path: 'src' }));
  out += result((t += 100), 't4', 'No matches', true);
  out += assistant((t += 1000), 'm5', { type: 'text', text: 'The edit is in; running the tests next.' });
  out += assistant(t, 'm5', use('t5', 'Read', { file_path: '/work/app/.env' }));
  out += result(t + 100, 't5', 'API_KEY=sk-ant-abcdefghijklmnopqrstuvwx');
  return out;
}

const handback = (at: number) => assistant(at, 'mh', use('th', 'SubagentHandback', { message: '## Done\n\nFixed **2** of 3. password=hunter22' })) + result(at + 100, 'th', '{"success":true}');

describe('a subagent transcript, parsed for its detail', () => {
  it('keeps the brief, the steps with short args, notes, files and model', () => {
    const s = parseSubagentDetail(transcript());
    const v = detailView(s, { sessionId: 'S', id: 'toolu_1', agentType: 'general-purpose' }, 0);
    expect(v.prompt).toBe(BRIEF);
    expect(v.model).toBe('claude-opus-5-5');
    expect(v.agentType).toBe('general-purpose');
    expect(v.startedAt).toBe(T0);
    const tools = v.entries.filter((e): e is SubagentTool => e.kind === 'tool');
    expect(tools.map((e) => [e.tool, e.toolKind, e.status])).toEqual([
      ['Bash', 'execute', 'completed'],
      ['Read', 'read', 'completed'],
      ['Edit', 'edit', 'completed'],
      ['Grep', 'search', 'failed'],
      ['Read', 'read', 'completed'],
    ]);
    expect(tools[0].about).toBe('Show status');
    expect(tools[0].ms).toBe(2500);
    expect(tools[1].title).toBe('Read /work/app/src/a.ts');
    expect(tools[3].title).toBe('grep console\\.log src');
    const diff = tools[2].out?.[0];
    expect(diff?.t === 'diff' && [diff.added, diff.removed]).toEqual([1, 1]);
    // The edit's "updated successfully" adds nothing to its diff.
    expect(tools[2].out).toHaveLength(1);
    expect(v.entries.filter((e) => e.kind === 'note').map((e) => (e as { text: string }).text)).toEqual(['The edit is in; running the tests next.']);
    expect(v.files).toEqual([
      { path: '/work/app/src/a.ts', edits: 1, reads: 1 },
      { path: '/work/app/.env', edits: 0, reads: 1 },
    ]);
    // Still working: no report yet.
    expect(v.report).toBeUndefined();
  });

  it('counts each streamed message once in the token use', () => {
    const v = detailView(parseSubagentDetail(transcript()), { sessionId: 'S', id: 'x' }, 0);
    // m1 streams twice (output 2, then 40): counted as 40. m2..m5: 4 messages of usage(2, 5, 100, 10), m5 twice.
    expect(v.usage).toEqual({ input: 2 + 4 * 2, output: 40 + 4 * 5, cacheRead: 5 * 100, cacheWrite: 5 * 10 });
  });

  it('takes secrets out of commands, outputs and the report, and hides a secrets file’s contents', () => {
    const s = parseSubagentDetail(transcript() + handback(T0 + 60_000));
    const v = detailView(s, { sessionId: 'S', id: 'x' }, 0);
    const all = JSON.stringify(v);
    expect(all).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(all).not.toContain('sk-ant-abcdefghijklmnopqrstuvwx');
    expect(all).not.toContain('hunter22');
    const env = v.entries.find((e) => e.kind === 'tool' && e.locations[0] === '/work/app/.env') as SubagentTool;
    expect(env.out).toEqual([{ t: 'text', text: '(not shown: a file that holds secrets)' }]);
    expect(v.report).toContain('## Done');
  });

  it('shows no contents of a secrets file: edits, writes, reads, or a command that reads one', () => {
    let text = user(T0, BRIEF);
    text += assistant(T0 + 1, 'e1', use('e1', 'Edit', { file_path: '/w/.env', old_string: 'TOKEN=old-value-1', new_string: 'TOKEN=new-value-2' }));
    text += result(T0 + 2, 'e1', 'The file /w/.env has been updated successfully.');
    text += assistant(T0 + 3, 'e2', use('e2', 'Write', { file_path: '/w/certs/server.pem', content: 'MIIBsecretbody' }));
    text += assistant(T0 + 4, 'e3', use('e3', 'MultiEdit', { file_path: '/w/id_rsa', edits: [{ old_string: 'a', new_string: 'b' }] }));
    text += assistant(T0 + 5, 'e4', use('e4', 'Read', { file_path: '/w/.env.local' }));
    text += result(T0 + 6, 'e4', 'DB_URL=plainvalue');
    text += assistant(T0 + 7, 'e5', use('e5', 'Bash', { command: 'cat .env | head -5' }));
    text += result(T0 + 8, 'e5', 'SESSION=plainvalue');
    text += assistant(T0 + 9, 'e6', use('e6', 'Bash', { command: 'grep -r KEY ~/.ssh/config' }));
    text += result(T0 + 10, 'e6', 'IdentityFile plainvalue');
    const v = detailView(parseSubagentDetail(text), { sessionId: 'S', id: 'x' }, 0);
    const all = JSON.stringify(v);
    for (const leak of ['old-value-1', 'new-value-2', 'MIIBsecretbody', 'plainvalue']) expect(all).not.toContain(leak);
    const tools = v.entries as SubagentTool[];
    for (const t of tools) expect(t.out).toEqual([{ t: 'text', text: '(not shown: a file that holds secrets)' }]);
    // The command itself still shows.
    expect(tools[4].cmd?.line).toBe('cat .env | head -5');
    expect(tools[0].input).toBeUndefined();
  });

  it('redacts before it cuts: a secret where an output’s shown tail begins doesn’t leak its end', () => {
    const token = `sk-ant-${'Q7'.repeat(30)}`;
    // The kept tail (2 KB) starts 20 characters into the token.
    const output = `${'x'.repeat(5000)}\n${token}\n${'y'.repeat(2048 - token.length + 19)}`;
    const text = user(T0, BRIEF) + assistant(T0 + 1, 'm1', use('b1', 'Bash', { command: 'npm run env-dump' })) + result(T0 + 2, 'b1', output);
    const v = detailView(parseSubagentDetail(text), { sessionId: 'S', id: 'x' }, 0);
    expect(JSON.stringify(v)).not.toContain('Q7Q7');
  });

  it('reports its hand-back, or its last words once it stops calling tools', () => {
    expect(detailView(parseSubagentDetail(transcript() + handback(T0 + 60_000)), { sessionId: 'S', id: 'x' }, 0).report).toMatch(/^## Done/);
    const quiet = transcript() + assistant(T0 + 70_000, 'mz', { type: 'text', text: 'All three fixed.' });
    expect(detailView(parseSubagentDetail(quiet), { sessionId: 'S', id: 'x' }, 0).report).toBe('All three fixed.');
  });

  it('drops the report when its caller sends it more work', () => {
    const resumed = transcript() + handback(T0 + 60_000) + user(T0 + 90_000, 'Also fix item 4');
    const v = detailView(parseSubagentDetail(resumed), { sessionId: 'S', id: 'x' }, 0);
    expect(v.report).toBeUndefined();
    expect(v.prompt).toBe(BRIEF);
    expect(v.entries.at(-1)).toMatchObject({ kind: 'note', text: 'Also fix item 4', caller: true });
  });

  it('skips a cut-off last line and reads it once it is whole', () => {
    const text = transcript();
    const extra = assistant(T0 + 80_000, 'm9', use('t9', 'Bash', { command: 'npm test' }));
    const s = parseSubagentDetail(text + extra.slice(0, 40));
    expect(s.entries.filter((e) => e.kind === 'tool')).toHaveLength(5);
    expect(parseSubagentDetail(text + extra).entries.filter((e) => e.kind === 'tool')).toHaveLength(6);
  });

  it('keeps only the newest entries of a long run', () => {
    let text = user(T0, BRIEF);
    for (let i = 0; i < 1000; i++) text += assistant(T0 + i, `m${i}`, use(`t${i}`, 'Bash', { command: `echo ${i}` })) + result(T0 + i, `t${i}`, `${i}`);
    const v = detailView(parseSubagentDetail(text), { sessionId: 'S', id: 'x' }, 0);
    expect(v.entries).toHaveLength(WINDOW);
    expect(v.total).toBe(1000);
    expect(v.first).toBe(1000 - WINDOW + 1);
    expect((v.entries.at(-1) as SubagentTool).title).toBe('echo 999');
  });
});

describe('redactSecrets', () => {
  it.each([
    ['curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz" x', 'Bearer [redacted]'],
    ['export ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwx', 'ANTHROPIC_API_KEY=[redacted]'],
    ['git clone https://arun:s3cretpass@github.com/x/y', 'https://arun:[redacted]@github.com'],
    ['psql --password Admin@123456', '--password [redacted]'],
    ['{"client_secret": "s3cr3t-value"}','"client_secret": "[redacted]"'],
    ['AKIAIOSFODNN7EXAMPLE', '[redacted]'],
    ['token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', '[redacted]'],
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----', '[redacted private key]'],
  ])('%s', (input, shows) => {
    expect(redactSecrets(input)).toContain(shows);
  });

  it('finishes fast on long identifier-like input with no value (no catastrophic backtracking)', () => {
    // 'a.' and 'a-' put a word boundary every other character: the unbounded pattern took ~12 s on these.
    for (const input of ['a.'.repeat(50_000), 'a-'.repeat(50_000), 'a_'.repeat(50_000),`password${'a_'.repeat(50_000)}`, `${'x'.repeat(100_000)}token`, `--password${'-'.repeat(100_000)}`, `key${'.'.repeat(100_000)}=`, 'eyJa.'.repeat(20_000), 'a://b:'.repeat(20_000), '-----BEGIN RSA PRIVATE KEY-----'.repeat(3000), 'password: '.repeat(10_000)]) {
      // The best of three: one run can catch a GC pause or a busy CI worker; backtracking is slow every time.
      const ms = Math.min(
        ...[0, 1, 2].map(() => {
          const t = performance.now();
          redactSecrets(input);
          return performance.now() - t;
        }),
      );
      expect(ms, input.slice(0, 20)).toBeLessThan(50);
    }
  });

  it('redacts a secret whole however long it is, and one far into a long text', () => {
    const long = (n: number) => 'Zq9'.repeat(n).slice(0, n);
    const url = redactSecrets(`git clone https://arun:${long(600)}@github.com/x/y`);
    expect(url).toContain('https://arun:[redacted]@github.com');
    expect(url).not.toContain('Zq9');
    for (const text of [`api_key=${long(2000)}`, `deploy --token ${long(2000)}`, `export GITHUB_TOKEN="${long(2000)}"`]) expect(redactSecrets(text)).not.toContain('Zq9');
    // A PEM block (and an assignment) where a 64 KB piece boundary used to fall.
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${'MIIEowZq9\n'.repeat(20)}-----END RSA PRIVATE KEY-----`;
    const far = `${'x'.repeat(65_530)}\n${pem}\n${'y'.repeat(70_000)}\npassword = "${long(300)}"`;
    const out = redactSecrets(far);
    expect(out).not.toContain('Zq9');
    expect(out).toContain('[redacted private key]');
  });

  it('leaves code that only names a secret', () => {
    for (const code of ['password: string;', 'const token = getToken();', 'if (apiKey) return;', 'secretPattern', 'tokens: 1200']) expect(redactSecrets(code)).toBe(code);
  });
});

describe('watchSubagent from a webview', () => {
  it('takes two ids or none, nothing else', () => {
    expect(parseWebviewMessage({ type: 'watchSubagent', sessionId: 'S1', id: 'toolu_1' })).toEqual({ type: 'watchSubagent', sessionId: 'S1', id: 'toolu_1' });
    expect(parseWebviewMessage({ type: 'watchSubagent' })).toEqual({ type: 'watchSubagent' });
    expect(parseWebviewMessage({ type: 'watchSubagent', sessionId: 'S1' })).toBeNull();
    expect(parseWebviewMessage({ type: 'watchSubagent', sessionId: '../x', id: 'a/b' })).toBeNull();
  });
});

describe('mergeEntries', () => {
  const tool = (seq: number, status = 'completed'): SubagentEntry => ({ kind: 'tool', id: `t${seq}`, seq, rev: seq, title: `echo ${seq}`, status, locations: [] });
  it('replaces changed entries, adds new ones, drops those before the window and keeps unchanged ones as they were', () => {
    const prev = [tool(1), tool(2), tool(3, 'in_progress')];
    const next = mergeEntries(prev, { entries: [tool(3), tool(4)], reset: false, first: 2 });
    expect(next.map((e) => e.seq)).toEqual([2, 3, 4]);
    expect(next[0]).toBe(prev[1]);
    expect((next[1] as SubagentTool).status).toBe('completed');
    expect(mergeEntries(prev, { entries: [tool(9)], reset: true, first: 9 }).map((e) => e.seq)).toEqual([9]);
    expect(mergeEntries(prev, { entries: [], reset: false, first: 1 })).toBe(prev);
  });
});

describe('the parent line', () => {
  it('names the parent as a field, the title whole', () => {
    expect(parentLine({ session: { title: 'IDE identification question' } })).toEqual({ label: 'Parent session', title: 'IDE identification question' });
    expect(parentLine({ chat: { title: 'Review the payments module' } })).toEqual({ label: 'Parent chat', title: 'Review the payments module' });
    expect(parentLine({})).toBeUndefined();
  });

  it('is the session’s own title (Claude Code’s latest ai-title), never cut at the front', () => {
    const text = j({ type: 'user', timestamp: iso(T0), cwd: '/w', message: { role: 'user', content: 'which IDE is this?' } }) + j({ type: 'ai-title', aiTitle: 'IDE identification question' });
    expect(parseSession(text).title).toBe('IDE identification question');
  });
});

// ---- Following the file as it grows ----

const S = '77777777-7777-4777-8777-777777777777';
const WS = '/work/app';
let home = '';
afterEach(() => {
  if (home) fs.rmSync(home, { recursive: true, force: true });
  home = '';
});

async function setup(log: string): Promise<string> {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-sadetail-'));
  const proj = path.join(home, '.claude', 'projects', encodeCwd(WS));
  const subs = path.join(proj, S, 'subagents');
  fs.mkdirSync(subs, { recursive: true });
  const call = j({ type: 'assistant', cwd: WS, timestamp: iso(T0), message: { id: 'p1', role: 'assistant', content: [use('toolu_x', 'Agent', { description: 'Fix token waste findings', prompt: BRIEF, run_in_background: true })] } });
  fs.writeFileSync(path.join(proj, `${S}.jsonl`), j({ type: 'user', cwd: WS, timestamp: iso(T0), message: { role: 'user', content: 'which IDE is this?' } }) + call);
  fs.writeFileSync(path.join(subs, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Fix token waste findings', toolUseId: 'toolu_x' }));
  const file = path.join(subs, 'agent-a1.jsonl');
  fs.writeFileSync(file, log);
  await listClaudeSessions({ home, folders: [WS], now: T0 + 60_000 });
  return file;
}

describe('SubagentWatch', () => {
  it('sends everything first, then only what changed, and nothing when the file did not grow', async () => {
    const file = await setup(transcript());
    const w = new SubagentWatch(S, 'toolu_x');
    const first = await w.read();
    expect(first?.reset).toBe(true);
    expect(first?.entries).toHaveLength(6);
    expect(first?.agentType).toBe('general-purpose');
    expect(await w.read()).toBeNull();
    // Half a line: nothing new to show yet.
    const call = assistant(T0 + 80_000, 'm9', use('t9', 'Bash', { command: 'npm test' }));
    fs.appendFileSync(file, call.slice(0, 30));
    expect((await w.read())?.entries ?? []).toHaveLength(0);
    fs.appendFileSync(file, call.slice(30));
    const grown = await w.read();
    expect(grown?.reset).toBe(false);
    expect(grown?.entries.map((e) => e.id)).toEqual(['t9']);
    fs.appendFileSync(file, result(T0 + 82_000, 't9', 'ok'));
    const done = await w.read();
    expect(done?.entries).toMatchObject([{ id: 't9', status: 'completed', ms: 2000 }]);
    w.stop();
  });

  it('finds only a listed session’s subagent, by its call or agent id', async () => {
    await setup(transcript());
    expect(await new SubagentWatch(S, 'a1').read()).not.toBeNull();
    expect(await new SubagentWatch(S, 'nope').read()).toBeNull();
    expect(await new SubagentWatch('88888888-8888-4888-8888-888888888888', 'toolu_x').read()).toBeNull();
    expect(await new SubagentWatch(S, '../../x').read()).toBeNull();
  });

  it('reads a multi-MB transcript in bounded memory, and a huge one from its end with the brief from its head', async () => {
    let log = user(T0, BRIEF);
    for (let i = 0; i < 4000; i++) log += blob(1) + assistant(T0 + i, `m${i}`, use(`t${i}`, 'Bash', { command: `npm test -- ${i}` })) + result(T0 + i + 50, `t${i}`, 'x'.repeat(1000));
    expect(log.length).toBeGreaterThan(8 * 1024 * 1024);
    await setup(log);
    const started = performance.now();
    const v = await new SubagentWatch(S, 'toolu_x').read();
    const ms = performance.now() - started;
    expect(v?.entries).toHaveLength(WINDOW);
    expect(v?.total).toBe(4000);
    expect(v?.prompt).toBe(BRIEF);
    expect(JSON.stringify(v).length).toBeLessThan(2 * 1024 * 1024);
    expect(ms).toBeLessThan(5000);
    expect(v?.partial).toBeUndefined();
    expect(MAX_READ).toBeGreaterThan(log.length);
    // Past its read limit: only the end is read; the brief comes from the first line.
    const tailOnly = await new SubagentWatch(S, 'toolu_x', 1024 * 1024).read();
    expect(tailOnly?.partial).toBe(true);
    expect(tailOnly?.prompt).toBe(BRIEF);
    expect(tailOnly!.total).toBeLessThan(800);
  }, 30_000);
});
