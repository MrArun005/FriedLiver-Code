// Claude Code's permission asks in the companion: the unlisted hook tool only an external session may call,
// the card's words, the hook group in ~/.claude/settings.json (ours only, nothing else touched), and the
// transcript watch that tells an ask was answered.
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { handle } from '../src/bridge/mcp';
import { PERMISSION_HOOK_TOOL, parseCall } from '../src/bridge/protocol';
import { HOOK_EVENT, hookAsk, hookEntry, isOurHook, registerHook, unregisterHook, watchAnswered } from '../src/host/claudeHook';
import { SERVER_NAME } from '../src/host/externalBrowser';

const tmp = () => mkdtemp(path.join(os.tmpdir(), 'flh-'));
const ARGS = { tool: 'Bash', input: '{"command":"npm test"}', cwd: '/w/repo', transcript: '/home/u/.claude/projects/x/s.jsonl' };
const call = (id: number) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: PERMISSION_HOOK_TOOL, arguments: ARGS } });

describe('the hook tool', () => {
  it('is never listed, and only an external session may call it', () => {
    const list = handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, true) as { reply: { result: { tools: { name: string }[] } } };
    expect(list.reply.result.tools.map((t) => t.name)).not.toContain(PERMISSION_HOOK_TOOL);
    expect(handle(call(2), true)).toEqual({ call: PERMISSION_HOOK_TOOL, args: ARGS, id: 2 });
    expect(handle(call(3), false)).toMatchObject({ reply: { result: { isError: true } } });
  });

  it('takes the four strings and nothing odd', () => {
    expect(parseCall(PERMISSION_HOOK_TOOL, ARGS)).toEqual({ tool: PERMISSION_HOOK_TOOL, toolName: 'Bash', input: ARGS.input, cwd: ARGS.cwd, transcript: ARGS.transcript });
    expect(parseCall(PERMISSION_HOOK_TOOL, { ...ARGS, tool: 'Bash\nrm' })).toBeNull();
    expect(parseCall(PERMISSION_HOOK_TOOL, { ...ARGS, input: {} })).toBeNull();
    expect(parseCall(PERMISSION_HOOK_TOOL, { ...ARGS, transcript: undefined })).toBeNull();
  });
});

describe('card words', () => {
  it('says what Claude Code asks, with the command or path in full', () => {
    expect(hookAsk('Bash', '{"command":"npm test","description":"Run tests"}')).toEqual({ question: 'Run a command?', detail: 'npm test' });
    expect(hookAsk('PowerShell', '{"command":"Get-ChildItem"}')).toEqual({ question: 'Run a command?', detail: 'Get-ChildItem' });
    expect(hookAsk('Edit', '{"file_path":"/Users/me/w/a.ts","old_string":"x","new_string":"y"}')).toEqual({ question: 'Edit a file?', detail: '~/w/a.ts' });
    expect(hookAsk('Write', '{"file_path":"/w/b.ts","content":"…"}')).toEqual({ question: 'Write a file?', detail: '/w/b.ts' });
    expect(hookAsk('WebFetch', '{"url":"https://example.com","prompt":"p"}')).toEqual({ question: 'Fetch a web page?', detail: 'https://example.com' });
    expect(hookAsk('Grep', '{"pattern":"TODO","path":"/w"}')).toEqual({ question: 'Search files?', detail: 'TODO\n/w' });
  });

  it('names an MCP tool and its server, and shows the arguments', () => {
    expect(hookAsk('mcp__github__create_issue', '{"title":"t"}')).toEqual({ question: 'Use create_issue (github)?', detail: '{\n "title": "t"\n}' });
    expect(hookAsk('Mystery', '')).toEqual({ question: 'Use Mystery?' });
  });

  it('leaves plans, mode switches and questions to Claude Code alone', () => {
    for (const tool of ['AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode']) expect(hookAsk(tool, '{}')).toBeUndefined();
  });

  it('spells out hidden and direction characters, and clips a long detail', () => {
    expect(hookAsk('Bash', JSON.stringify({ command: 'echo safe‮;rm -rf ~' }))?.detail).toBe('echo safe⟨U+202E⟩;rm -rf ~');
    const long = hookAsk('Bash', JSON.stringify({ command: 'x'.repeat(5000) }))!.detail!;
    expect(long.length).toBe(4000);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('the hook in Claude Code\'s settings', () => {
  it('adds one group calling the hook tool on friedliver-browser, keeping everything else', async () => {
    const file = path.join(await tmp(), '.claude', 'settings.json');
    expect(await registerHook(file)).toBe('added');
    expect(await registerHook(file)).toBe('unchanged');
    const written = JSON.parse(await readFile(file, 'utf8'));
    expect(written).toEqual({ hooks: { [HOOK_EVENT]: [hookEntry()] } });
    expect(written.hooks[HOOK_EVENT][0].hooks[0]).toMatchObject({ type: 'mcp_tool', server: SERVER_NAME, tool: PERMISSION_HOOK_TOOL });

    const theirs = { matcher: 'Bash', hooks: [{ type: 'command', command: 'audit.sh' }] };
    await writeFile(file, JSON.stringify({ model: 'opus', hooks: { [HOOK_EVENT]: [theirs, { ...hookEntry(), matcher: 'old' }], Stop: [theirs] } }));
    expect(await registerHook(file)).toBe('updated');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ model: 'opus', hooks: { [HOOK_EVENT]: [theirs, hookEntry()], Stop: [theirs] } });

    expect(await unregisterHook(file)).toBe(true);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ model: 'opus', hooks: { [HOOK_EVENT]: [theirs], Stop: [theirs] } });
    expect(await unregisterHook(file)).toBe(false);
  });

  it('removes the lists it emptied, and never writes a file without its hook', async () => {
    const dir = await tmp();
    const file = path.join(dir, 'settings.json');
    expect(await unregisterHook(file)).toBe(false);
    await writeFile(file, JSON.stringify({ model: 'opus' }));
    await registerHook(file);
    await unregisterHook(file);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ model: 'opus' });
  });

  it('leaves a file it can\'t read safely alone, and tells only its own group', async () => {
    const file = path.join(await tmp(), 'settings.json');
    await writeFile(file, JSON.stringify({ hooks: { [HOOK_EVENT]: 'nope' } }));
    await expect(registerHook(file)).rejects.toThrow(/not a list/);
    await writeFile(file, '{ not json');
    await expect(registerHook(file)).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe('{ not json');
    expect(isOurHook({ hooks: [{ type: 'mcp_tool', server: SERVER_NAME, tool: 'other' }] })).toBe(false);
    expect(isOurHook({ hooks: [] })).toBe(false);
    expect(isOurHook(hookEntry())).toBe(true);
  });
});

describe('the transcript watch', () => {
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
  };

  it('tells once a tool result is written after the ask, and nothing before', async () => {
    const home = await tmp();
    const file = path.join(home, '.claude', 'projects', 'p', 's.jsonl');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{"type":"user","message":{"content":[{"type":"tool_result"}]}}\n');
    let answered = 0;
    const stop = watchAnswered(file, home, () => answered++, 10);
    expect(stop).toBeDefined();
    await appendFile(file, '{"type":"progress"}\n');
    await new Promise((r) => setTimeout(r, 100));
    expect(answered).toBe(0);
    await appendFile(file, '{"type":"user","message":{"content":[{"type":"tool_result","is_error":true}]}}\n');
    await until(() => answered > 0);
    expect(answered).toBe(1);
    stop!();
  });

  it('watches only a Claude Code transcript under ~/.claude/projects', async () => {
    const home = await tmp();
    expect(watchAnswered(path.join(home, 'elsewhere.jsonl'), home, () => {})).toBeUndefined();
    expect(watchAnswered(path.join(home, '.claude', 'projects', '..', 'settings.jsonl'), home, () => {})).toBeUndefined();
    expect(watchAnswered(path.join(home, '.claude', 'projects', 'p', 's.json'), home, () => {})).toBeUndefined();
    expect(watchAnswered('relative/s.jsonl', home, () => {})).toBeUndefined();
  });
});
