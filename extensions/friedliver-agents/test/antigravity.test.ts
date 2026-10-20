// Antigravity (Google's `agy`): FriedLiver's ACP adapter over agy's headless stream-json mode,
// and the agent's place in FriedLiver (spec, levels, mentions, Accounts). agy itself is the
// fixture test/fixtures/fake-agy.mjs: no network, no sign-in.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { build } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';
import { AGY_MODES, TALK_LIMITS, extraArgs, geminiFingerprint, needCall, parseModels, parseNeeds, seatbeltProfile, settingsModel, talkProfile, toolKind, turnArgs, workspaceConfig } from '@friedliver/main/agents/agy';
import { PLATFORM_REFUSAL, agyAgent, type AgyAdapterOptions } from '@friedliver/main/agents/agyAcp';
import { findProgram } from '@friedliver/main/agents/processes';
import { DEFAULT_AGENTS } from '@friedliver/main/agents/registry';
import { READ_ONLY_PROMPT_META } from '../src/host/core';
import { parseEditInput } from '../src/host/editorPrompt';
import { cliLineFor, installCommandFor } from '../src/host/signin';
import { CLI_ACCOUNTS, KEY_SETUPS } from '../src/shared/accounts';
import type { DiscussionItem } from '../src/shared/discuss';
import { parseMention } from '../src/shared/model';
import { modeFor, planToggle, readOnlyChoice, sessionOptions } from '../src/shared/session';
import { mentionOptions } from '../src/shared/view';
import { markFor } from '../src/webview/ui/marks';
import { DEMO_AGENT, disposeCores, gitRepo, makeCore, tmpDir, waitFor } from './helpers';

const FAKE_AGY = path.resolve(__dirname, 'fixtures/fake-agy.mjs');
const FAKE_BRIDGE = path.resolve(__dirname, 'fixtures/fake-bridge.mjs');
const manifest = JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')) as {
  capabilities: { untrustedWorkspaces: { supported: boolean } };
  contributes: { configuration: { properties: Record<string, { enum?: string[] }> } };
};

afterEach(disposeCores);

describe('agy turn arguments', () => {
  it('runs every turn headless, in stream-json both ways, with slash commands off', () => {
    const args = turnArgs({ mode: 'accept-edits', model: 'default', effort: 'default' });
    expect(args).toEqual(['--output-format', 'stream-json', '--input-format', 'stream-json', '--disable-slash-commands', '--mode', 'accept-edits', '--sandbox']);
    expect(args).not.toContain('-p');
  });

  it('only Full access skips permissions', () => {
    expect(turnArgs({ mode: 'accept-edits', model: 'default', effort: 'default' })).not.toContain('--dangerously-skip-permissions');
    expect(turnArgs({ mode: 'full', model: 'default', effort: 'default' })).toContain('--dangerously-skip-permissions');
  });

  it('passes the chosen model, effort and agy conversation', () => {
    const args = turnArgs({ mode: 'accept-edits', model: 'Gemini 3.1 Pro (High)', effort: 'high', conversationId: 'c-1' });
    expect(args.slice(-6)).toEqual(['--model', 'Gemini 3.1 Pro (High)', '--effort', 'high', '--conversation', 'c-1']);
  });

  it('drops the user’s extra flags that would change what agy may do, keeps the rest', () => {
    const user = ['--project', 'p1', '--dangerously-skip-permissions', '--mode', 'auto', '--model=x', '--add-dir', '/', '-p', 'hi', '--continue', '--log-file', '/tmp/a.log'];
    expect(extraArgs(user)).toEqual(['--project', 'p1', '--log-file', '/tmp/a.log']);
    expect(turnArgs({ mode: 'accept-edits', model: 'default', effort: 'default' }, user)).not.toContain('--dangerously-skip-permissions');
  });
});

describe('agy models', () => {
  it('reads one model per line under a header, labels as values', () => {
    const r = parseModels('Fetching available models...\nGemini 3.8 Flash (Medium)\nGemini 3.1 Pro (High)\n\n');
    expect(r.choices).toEqual([
      { value: 'Gemini 3.8 Flash (Medium)', name: 'Gemini 3.8 Flash (Medium)' },
      { value: 'Gemini 3.1 Pro (High)', name: 'Gemini 3.1 Pro (High)' },
    ]);
    expect(r.current).toBeUndefined();
  });

  it('reads "slug   Label" columns, bullets and a current marker', () => {
    const r = parseModels('Available models:\n  - gemini-3.8-flash-low    Gemini 3.8 Flash (Low)\n  > gemini-3.1-pro-high    Gemini 3.1 Pro (High)\n  - gemini-3.1-pro-high    duplicate\n');
    expect(r.choices.map((c) => c.value)).toEqual(['gemini-3.8-flash-low', 'gemini-3.1-pro-high']);
    expect(r.choices[1].name).toBe('Gemini 3.1 Pro (High)');
    expect(r.current).toBe('gemini-3.1-pro-high');
    expect(parseModels('Claude Opus 5.5 (Thinking) (current)\n').current).toBe('Claude Opus 5.5 (Thinking)');
  });

  it('takes agy’s settings.json model as the default only when agy lists it', () => {
    const choices = parseModels('Gemini 3.8 Flash (Medium)\nGemini 3.1 Pro (High)').choices;
    expect(settingsModel('{"model":"Gemini 3.1 Pro (High)"}', choices)).toBe('Gemini 3.1 Pro (High)');
    expect(settingsModel('{"model":{"name":"Gemini 3.8 Flash (Medium)"}}', choices)).toBe('Gemini 3.8 Flash (Medium)');
    expect(settingsModel('{"model":"gone"}', choices)).toBeUndefined();
    expect(settingsModel('not json', choices)).toBeUndefined();
    expect(settingsModel(undefined, choices)).toBeUndefined();
  });

  it('names tool kinds from agy’s tool names', () => {
    expect(['view_file', 'grep_search', 'write_to_file', 'replace_file_content', 'run_command', 'read_url_content'].map(toolKind)).toEqual(['read', 'search', 'edit', 'edit', 'execute', 'fetch']);
  });
});

describe('FriedLiver levels on agy’s modes', () => {
  const mode = sessionOptions({ configOptions: [{ id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'read-only', options: AGY_MODES }] as acp.SessionConfigOption[] }).find((o) => o.category === 'mode');

  it('Manual is talk only, Plan is talk only planning, Edit automatically accepts edits, Auto is full access', () => {
    expect(modeFor('antigravity', mode, 'ask')).toBe('read-only');
    expect(modeFor('antigravity', mode, 'plan')).toBe('plan');
    expect(modeFor('antigravity', mode, 'edits')).toBe('accept-edits');
    expect(modeFor('antigravity', mode, 'full')).toBe('full');
  });

  it('read-only chats and /discuss pick talk only; the Plan toggle is talk only too', () => {
    expect(readOnlyChoice(mode ? [mode] : [])).toMatchObject({ value: 'read-only' });
    expect(planToggle({ options: mode ? [mode] : [], commands: [], live: true })).toMatchObject({ on: 'plan' });
    expect(['read-only', 'plan'].map((m) => turnArgs({ mode: m as 'plan', model: 'default', effort: 'default' }))).toEqual([
      expect.not.arrayContaining(['--dangerously-skip-permissions', 'accept-edits']),
      expect.arrayContaining(['--mode', 'plan', '--sandbox']),
    ]);
  });
});

describe('what talk-only agy may ask FriedLiver to read', () => {
  const fenced = (need: unknown, fence = '~~~') => `Thinking.\n${fence}need\n${JSON.stringify({ need })}\n${fence}`;

  it('reads, searches and outlines, with line ranges, and the text without the block', () => {
    const r = parseNeeds(fenced([{ read: 'src/a.ts', lines: '1-120' }, { search: ' refresh token ' }, { outline: './src/b.ts' }, { read: 'docs/x.md' }], '```'));
    expect(r).toEqual({
      text: 'Thinking.',
      needs: [
        { kind: 'read', path: 'src/a.ts', lines: [1, 120] },
        { kind: 'search', query: 'refresh token' },
        { kind: 'outline', path: 'src/b.ts' },
        { kind: 'read', path: 'docs/x.md' },
      ],
      refused: [],
    });
    expect(parseNeeds('No block here.')).toEqual({ text: 'No block here.', needs: [], refused: [] });
  });

  it('refuses paths outside the project: absolute, home, drive letters, .. anywhere it escapes', () => {
    for (const p of ['/etc/passwd', '~/.ssh/id_rsa', 'C:\\Windows\\win.ini', '../secrets.txt', 'src/../../x', '..\\..\\x', '', 'a\u0000b']) {
      const r = parseNeeds(fenced([{ read: p }]));
      expect(r.needs, p).toEqual([]);
      expect(r.refused, p).toHaveLength(1);
    }
    expect(parseNeeds(fenced([{ read: 'src/../lib/a.ts' }])).needs).toEqual([{ kind: 'read', path: 'lib/a.ts' }]);
  });

  it('refuses files that may hold secrets, as the project index does', () => {
    for (const p of ['.env', 'config/.env.local', 'keys/server.pem', 'id_ed25519', '.npmrc', 'infra/prod.tfvars', 'deploy/service-account-x.json', '.git/config', '.ssh/known_hosts', 'home/.aws/credentials']) {
      expect(parseNeeds(fenced([{ outline: p }])).refused, p).toEqual([expect.stringContaining('secrets')]);
    }
  });

  it('caps requests per round and line spans, and refuses malformed ones', () => {
    const many = parseNeeds(fenced(Array.from({ length: 8 }, (_, i) => ({ read: `f${i}.ts` }))));
    expect(many.needs).toHaveLength(TALK_LIMITS.needs);
    expect(many.refused).toEqual([`more than ${TALK_LIMITS.needs} requests`]);
    expect(parseNeeds(fenced([{ read: 'a.ts', lines: '10-9000' }])).needs).toEqual([{ kind: 'read', path: 'a.ts', lines: [10, 10 + TALK_LIMITS.lines - 1] }]);
    expect(parseNeeds(fenced([{ read: 'a.ts', lines: 'all' }])).refused).toHaveLength(1);
    expect(parseNeeds(fenced([{ search: '' }, 42, null])).refused).toHaveLength(3);
    expect(parseNeeds('x\n~~~need\nnot json\n~~~').refused).toEqual(['the need block isn’t JSON']);
  });

  it('becomes FriedLiver’s own read-only index calls', () => {
    expect(needCall({ kind: 'read', path: 'a.ts', lines: [1, 5] })).toEqual({ name: 'index_read', args: { path: 'a.ts', lines: [1, 5] }, title: 'Read a.ts 1-5' });
    expect(needCall({ kind: 'search', query: 'q' }).name).toBe('index_search');
    expect(needCall({ kind: 'outline', path: 'a.ts' }).name).toBe('index_outline');
  });
});

describe('workspace agy config (defence in depth, fail closed)', () => {
  const rel = (repo: string, sub: string) => workspaceConfig(sub, repo).map((f) => path.relative(repo, f).split(path.sep).join('/')).sort();

  it('allows only text: rules and workflows as markdown, GEMINI.md, and agy’s own artifacts', async () => {
    const repo = await gitRepo();
    const sub = path.join(repo, 'pkg');
    mkdirSync(sub);
    expect(rel(repo, sub)).toEqual([]);
    mkdirSync(path.join(repo, '.agents', 'rules', 'team'), { recursive: true });
    writeFileSync(path.join(repo, '.agents', 'rules', 'team', 'style.md'), 'Use tabs.');
    mkdirSync(path.join(repo, '.agents', 'workflows'));
    writeFileSync(path.join(repo, '.agents', 'workflows', 'release.MD'), '1. Tag.');
    mkdirSync(path.join(repo, '.gemini', 'antigravity', 'artifacts'), { recursive: true });
    writeFileSync(path.join(repo, '.gemini', 'antigravity', 'artifacts', 'plan.md'), '# Plan');
    writeFileSync(path.join(repo, 'GEMINI.md'), 'Be brief.');
    writeFileSync(path.join(repo, 'AGENTS.md'), 'Be brief.');
    expect(rel(repo, sub)).toEqual([]);
  });

  it('refuses everything else, in the folder or a parent up to the repository: hooks, MCP, skills, plugins, settings, scripts, unknown files', async () => {
    const repo = await gitRepo();
    const sub = path.join(repo, 'pkg');
    mkdirSync(path.join(sub, '_agent', 'plugins', 'x'), { recursive: true });
    writeFileSync(path.join(sub, '_agent', 'plugins', 'x', 'plugin.json'), '{}');
    mkdirSync(path.join(repo, '.agents', 'rules'), { recursive: true });
    writeFileSync(path.join(repo, '.agents', 'hooks.json'), '{}');
    writeFileSync(path.join(repo, '.agents', 'mcp_config.json'), '{"mcpServers":{}}');
    writeFileSync(path.join(repo, '.agents', 'rules', 'run.sh'), 'rm -rf ~');
    writeFileSync(path.join(repo, '.agents', 'skills.json'), '{}');
    mkdirSync(path.join(repo, '.gemini'));
    writeFileSync(path.join(repo, '.gemini', 'settings.json'), '{}');
    expect(rel(repo, sub)).toEqual([
      '.agents/hooks.json',
      '.agents/mcp_config.json',
      '.agents/rules/run.sh',
      '.agents/skills.json',
      '.gemini/settings.json',
      'pkg/_agent/plugins/x/plugin.json',
    ]);
  });

  it('matches folder names in any case, refuses symlinks and a config file in place of a folder', async () => {
    const repo = await gitRepo();
    mkdirSync(path.join(repo, '.AGENTS', 'Rules'), { recursive: true });
    writeFileSync(path.join(repo, '.AGENTS', 'Rules', 'ok.md'), 'fine');
    writeFileSync(path.join(repo, '.AGENTS', 'Hooks.json'), '{}');
    writeFileSync(path.join(repo, '_Agents'), 'not a folder');
    const found = rel(repo, repo);
    expect(found).toEqual(['.AGENTS/Hooks.json', '_Agents']);
    if (process.platform !== 'win32') {
      const other = await gitRepo();
      mkdirSync(path.join(other, '.agent', 'rules'), { recursive: true });
      symlinkSync('/etc/hosts', path.join(other, '.agent', 'rules', 'hosts.md'));
      expect(rel(other, other)).toEqual(['.agent/rules/hosts.md']);
    }
  });

  it('never walks past the root git gave, nor up from a folder outside it (a planted .git changes nothing)', () => {
    const outer = tmpDir('fl-agy-outer-');
    mkdirSync(path.join(outer, '.agents'));
    writeFileSync(path.join(outer, '.agents', 'hooks.json'), '{}');
    const project = path.join(outer, 'project');
    mkdirSync(path.join(project, 'sub', '.git'), { recursive: true });
    expect(workspaceConfig(project, project)).toEqual([]);
    expect(workspaceConfig(path.join(project, 'sub'), project)).toEqual([]);
    // A root that isn't above the folder: the folder only.
    expect(workspaceConfig(project, path.join(outer, 'elsewhere'))).toEqual([]);
    expect(workspaceConfig(project, outer)).toEqual([path.join(outer, '.agents', 'hooks.json')]);
  });
});

describe.skipIf(process.platform !== 'darwin')('the macOS sandbox every agy process runs in', () => {
  /** Runs `sh -c` in the profile; the exit code and what it said. */
  const inSandbox = (home: string, cwd: string, script: string) => {
    const r = spawnSync('/usr/bin/sandbox-exec', ['-p', seatbeltProfile(home), '/bin/sh', '-c', script], { cwd, encoding: 'utf8' });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };

  it('agy and what it starts can’t read or write any workspace config folder, in any case, at any depth', async () => {
    const home = tmpDir('fl-agy-home-');
    const repo = await gitRepo();
    mkdirSync(path.join(repo, '.agents', 'rules'), { recursive: true });
    writeFileSync(path.join(repo, '.agents', 'rules', 'x.md'), 'hi');
    expect(inSandbox(home, repo, 'mkdir -p .gemini && echo x > .gemini/settings.json')).toMatchObject({ code: 1, out: expect.stringContaining('Operation not permitted') });
    expect(existsSync(path.join(repo, '.gemini', 'settings.json'))).toBe(false);
    expect(inSandbox(home, repo, 'mkdir -p pkg/_Agents && echo {} > pkg/_Agents/hooks.json').code).not.toBe(0);
    expect(inSandbox(home, repo, 'echo {} > .AGENTS/hooks.json').code).not.toBe(0);
    expect(inSandbox(home, repo, 'cat .agents/rules/x.md').out).toContain('Operation not permitted');
    expect(inSandbox(home, repo, 'echo ok > src.txt && cat src.txt')).toEqual({ code: 0, out: 'ok\n' });
  });

  it('keeps the user’s own ~/.gemini readable, and writable only where agy keeps state', () => {
    const home = tmpDir('fl-agy-home-');
    mkdirSync(path.join(home, '.gemini', 'antigravity-cli', 'log'), { recursive: true });
    mkdirSync(path.join(home, '.gemini', 'config'), { recursive: true });
    writeFileSync(path.join(home, '.gemini', 'antigravity-cli', 'settings.json'), '{"model":"x"}');
    const g = path.join(home, '.gemini');
    expect(inSandbox(home, home, `cat "${g}/antigravity-cli/settings.json"`).out).toBe('{"model":"x"}');
    expect(inSandbox(home, home, `echo log > "${g}/antigravity-cli/log/a.log"`).code).toBe(0);
    for (const target of ['antigravity-cli/settings.json', 'config/hooks.json', 'config/mcp_config.json', 'GEMINI.md']) {
      expect(inSandbox(home, home, `echo x > "${g}/${target}"`).code, target).not.toBe(0);
    }
    expect(readFileSync(path.join(g, 'antigravity-cli', 'settings.json'), 'utf8')).toBe('{"model":"x"}');
  });

  it('writes in ~/.gemini only to data folders: not the updater, builtins, MCP or plugin data, project list, nor a config folder inside data', () => {
    const home = tmpDir('fl-agy-home-');
    const g = path.join(home, '.gemini');
    for (const d of ['antigravity-cli/log', 'antigravity-cli/updater', 'antigravity-cli/builtin', 'antigravity-cli/mcp', 'antigravity-cli/plugin_data', 'config/projects']) mkdirSync(path.join(g, d), { recursive: true });
    expect(inSandbox(home, home, `echo x > "${g}/antigravity-cli/log/a.log"`).code).toBe(0);
    for (const target of ['antigravity-cli/updater/agy', 'antigravity-cli/builtin/skill.md', 'antigravity-cli/mcp/x.json', 'antigravity-cli/plugin_data/x', 'config/projects/p.json']) {
      expect(inSandbox(home, home, `echo x > "${g}/${target}"`).code, target).not.toBe(0);
    }
    expect(inSandbox(home, home, `mkdir -p "${g}/antigravity-cli/log/.agents" && echo {} > "${g}/antigravity-cli/log/.agents/hooks.json"`).code).not.toBe(0);
  });

  it('refuses config folder names a case-insensitive volume would fold: ".agentſ", "_Agents", any dot name with non-ASCII', async () => {
    const repo = await gitRepo();
    for (const name of ['.agentſ', '_Agents', '.gemınί', '.Gemini']) expect(inSandbox(tmpDir('fl-agy-home-'), repo, `mkdir "${name}"`).code, name).not.toBe(0);
    expect(inSandbox(tmpDir('fl-agy-home-'), repo, 'mkdir .notes && echo ok').code).toBe(0);
    mkdirSync(path.join(repo, '_café'));
    expect(workspaceConfig(repo, repo)).toEqual([path.join(repo, '_café')]);
  });

  it('lets nothing open apps, script them, or leave login items and shell start-up files', () => {
    const home = tmpDir('fl-agy-home-');
    for (const cmd of ['/usr/bin/osascript -e 1', '/usr/bin/open -h', '/bin/launchctl list']) expect(inSandbox(home, home, cmd).out, cmd).toContain('Operation not permitted');
    for (const f of ['.zshrc', '.bash_profile', '.profile', 'Library/LaunchAgents/x.plist']) {
      expect(inSandbox(home, home, `mkdir -p "$(dirname "${home}/${f}")"; echo x > "${home}/${f}"`).code, f).not.toBe(0);
      expect(existsSync(path.join(home, f)), f).toBe(false);
    }
  });
});

describe('the fingerprint of the user’s own agy config', () => {
  it('changes with settings, MCP servers or hooks, not with agy’s data or other apps’ files in ~/.gemini', () => {
    const home = tmpDir('fl-agy-home-');
    const g = path.join(home, '.gemini');
    mkdirSync(path.join(g, 'antigravity-cli', 'log'), { recursive: true });
    mkdirSync(path.join(g, 'config'), { recursive: true });
    mkdirSync(path.join(g, 'antigravity-browser-profile'), { recursive: true });
    writeFileSync(path.join(g, 'antigravity-cli', 'settings.json'), '{}');
    const first = geminiFingerprint(home);
    writeFileSync(path.join(g, 'antigravity-cli', 'log', 'a.log'), 'x');
    writeFileSync(path.join(g, 'antigravity-browser-profile', 'Cookies'), 'x');
    expect(geminiFingerprint(home)).toBe(first);
    writeFileSync(path.join(g, 'config', 'hooks.json'), '{}');
    expect(geminiFingerprint(home)).not.toBe(first);
    const second = geminiFingerprint(home);
    writeFileSync(path.join(g, 'antigravity-cli', 'settings.json'), '{"toolPermission":"always-proceed"}');
    expect(geminiFingerprint(home)).not.toBe(second);
  });
});

describe.skipIf(process.platform !== 'darwin')('the talk-only sandbox (deny by default)', () => {
  it('lets only agy run, read only its own folder (not the project), and write nowhere else', async () => {
    const home = tmpDir('fl-agy-home-');
    const scratch = tmpDir('fl-agy-talk-');
    const repo = await gitRepo();
    writeFileSync(path.join(scratch, 'note.txt'), 'mine');
    // /bin/cat stands in for agy: the one program the profile lets start.
    const profile = talkProfile({ agy: '/bin/cat', scratch, home });
    const run = (file: string, args: string[]) => spawnSync('/usr/bin/sandbox-exec', ['-p', profile, file, ...args], { cwd: scratch, encoding: 'utf8' });
    expect(run('/bin/cat', [path.join(scratch, 'note.txt')]).stdout).toBe('mine');
    expect(run('/bin/cat', [path.join(repo, 'README.md')]).stderr).toContain('Operation not permitted');
    expect(run('/bin/sh', ['-c', 'echo hi']).status).not.toBe(0);
    expect(run('/usr/bin/touch', [path.join(scratch, 'x')]).status).not.toBe(0);
  });
});

/** What the talk-only sandbox must also let the fake agy (Node and a script) read: Node's install and the fixtures. */
const NODE_READ = [path.dirname(path.dirname(realpathSync(process.execPath))), path.dirname(FAKE_AGY), ...['/opt/homebrew', '/usr/local'].filter((d) => existsSync(d))];

/** FriedLiver's tools server for a session, faked: it logs each index call. */
function bridge(): { server: acp.McpServerStdio; calls: () => { name: string; args: Record<string, unknown> }[] } {
  const log = path.join(tmpDir('fl-agy-bridge-'), 'calls.jsonl');
  writeFileSync(log, '');
  return {
    server: { name: 'friedliver', command: process.execPath, args: [FAKE_BRIDGE], env: [{ name: 'FAKE_BRIDGE_LOG', value: log }] },
    calls: () =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { name: string; args: Record<string, unknown> }),
  };
}

/** The adapter in this process, talking to the fake agy; every update it sends is kept. */
function adapter(env: Record<string, string> = {}, over: Partial<AgyAdapterOptions> = {}) {
  const logDir = tmpDir('fl-agy-log-');
  const log = path.join(logDir, 'calls.jsonl');
  writeFileSync(log, '');
  over = { talkRead: NODE_READ, talkWrite: [logDir], ...over };
  const updates: acp.SessionNotification[] = [];
  // Over NDJSON byte streams, as on stdio (agent-core may load its own copy of the SDK).
  const toAgent = new TransformStream<Uint8Array, Uint8Array>();
  const toClient = new TransformStream<Uint8Array, Uint8Array>();
  const served = agyAgent({ command: process.execPath, baseArgs: [FAKE_AGY], env: { ...process.env, FAKE_AGY_LOG: log, ...env }, ...over }).connect(acp.ndJsonStream(toClient.writable, toAgent.readable));
  const conn = acp
    .client({ name: 'test' })
    .onNotification(acp.methods.client.session.update, ({ params }) => void updates.push(params))
    .connect(acp.ndJsonStream(toAgent.writable, toClient.readable));
  const calls = (): { argv: string[]; cwd: string }[] =>
    readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { argv: string[]; cwd: string })
      .filter((c) => c.argv[0] !== 'models' && c.argv[0] !== '--version');
  const said = () => updates.flatMap((u) => (u.update.sessionUpdate === 'agent_message_chunk' && u.update.content.type === 'text' ? [u.update.content.text] : [])).join('');
  const thought = () => updates.flatMap((u) => (u.update.sessionUpdate === 'agent_thought_chunk' && u.update.content.type === 'text' ? [u.update.content.text] : [])).join('');
  const tools = () => updates.map((u) => u.update).filter((u) => u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update');
  return { agent: conn.agent, updates, calls, said, thought, tools, close: () => (conn.close(), served.close()) };
}

const prompt = (text: string): acp.ContentBlock[] => [{ type: 'text', text }];

describe('where the adapter won’t start agy', () => {
  it('off macOS: no sandbox to hide workspace config, so no session, and no agy call', async () => {
    for (const platform of ['linux', 'win32'] as const) {
      const a = adapter({}, { platform });
      await expect(a.agent.request(acp.methods.agent.session.new, { cwd: await gitRepo(), mcpServers: [] })).rejects.toMatchObject({ data: { details: PLATFORM_REFUSAL } });
      expect(a.calls()).toEqual([]);
      a.close();
    }
  });

  it.skipIf(process.platform !== 'darwin')('in the home folder, or a repository at its root', async () => {
    const home = await gitRepo();
    const a = adapter({}, { home });
    await expect(a.agent.request(acp.methods.agent.session.new, { cwd: home, mcpServers: [] })).rejects.toMatchObject({ data: { details: expect.stringMatching(/home folder/) } });
    mkdirSync(path.join(home, 'project'));
    await expect(a.agent.request(acp.methods.agent.session.new, { cwd: path.join(home, 'project'), mcpServers: [] })).rejects.toMatchObject({ data: { details: expect.stringMatching(/home folder/) } });
    a.close();
  });
});

describe.skipIf(process.platform !== 'darwin')('the agy ACP adapter (fake agy, in the sandbox)', () => {
  it('starts a session with agy’s models and version, in talk only', async () => {
    const a = adapter();
    const init = await a.agent.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    expect(init.agentInfo).toMatchObject({ name: 'agy', version: '1.4.3' });
    expect(init.agentCapabilities?.loadSession).toBe(false);
    const project = await gitRepo();
    const s = await a.agent.request(acp.methods.agent.session.new, { cwd: project, mcpServers: [] });
    const options = sessionOptions(s);
    expect(options.find((o) => o.category === 'mode')?.current).toBe('read-only');
    expect(options.find((o) => o.category === 'model')?.choices.map((c) => c.value)).toEqual(['default', 'Gemini 3.8 Flash (Medium)', 'Gemini 3.1 Pro (High)', 'Claude Sonnet 5.5 (Thinking)']);
    expect(options.find((o) => o.category === 'thought_level')?.choices.map((c) => c.value)).toEqual(['default', 'low', 'medium', 'high', 'xhigh', 'max']);
    // Manual is talk only: agy in the session's own empty folder, never the project.
    await a.agent.request(acp.methods.agent.session.prompt, { sessionId: s.sessionId, prompt: prompt('hello') });
    expect(a.said()).toBe('You said: hello');
    const [call] = a.calls();
    expect(path.basename(call.cwd)).toMatch(/^friedliver-agy-talk-/);
    expect(path.relative(project, call.cwd).startsWith('..')).toBe(true);
    expect(call.argv).toContain('--sandbox');
    expect(call.argv).not.toContain('accept-edits');
    a.close();
  });

  it('talk only: agy can’t read the project, write outside its folder or run a shell, at the OS level', async () => {
    const a = adapter();
    const project = await gitRepo();
    const { sessionId } = await a.agent.request(acp.methods.agent.session.new, { cwd: project, mcpServers: [] });
    await a.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: prompt(`probe:${path.join(project, 'README.md')}`) });
    expect(JSON.parse(a.said())).toEqual({ readProject: 'EPERM', writeProject: 'EPERM', writeOwnFolder: 'ok', configOwnFolder: 'EPERM', configOwnFolderUnicode: 'EPERM', shell: 'EPERM' });
    expect(existsSync(path.join(project, 'README.md.x'))).toBe(false);
    a.close();
  });

  it('a prompt FriedLiver marks read only runs talk only, whatever the session’s mode', async () => {
    const a = adapter();
    const project = await gitRepo();
    const { sessionId } = await a.agent.request(acp.methods.agent.session.new, { cwd: project, mcpServers: [] });
    await a.agent.request(acp.methods.agent.session.setConfigOption, { sessionId, configId: 'mode', value: 'full' });
    await a.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: prompt(`probe:${path.join(project, 'README.md')}`), _meta: { friedliver: { readOnly: true } } });
    expect(JSON.parse(a.said())).toMatchObject({ readProject: 'EPERM', shell: 'EPERM' });
    const [call] = a.calls();
    expect(path.basename(call.cwd)).toMatch(/^friedliver-agy-talk-/);
    expect(call.argv).not.toContain('--dangerously-skip-permissions');
    a.close();
  });

  it('talk only: anything named like a config folder in its own folder is gone before each round', async () => {
    const a = adapter();
    const { sessionId } = await a.agent.request(acp.methods.agent.session.new, { cwd: await gitRepo(), mcpServers: [] });
    await a.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: prompt('one') });
    const scratch = a.calls()[0].cwd;
    mkdirSync(path.join(scratch, '_agents'));
    writeFileSync(path.join(scratch, '_agents', 'hooks.json'), '{}');
    writeFileSync(path.join(scratch, 'notes.txt'), 'kept');
    await a.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: prompt('two') });
    expect(a.calls()[1].cwd).toBe(scratch);
    expect(existsSync(path.join(scratch, '_agents'))).toBe(false);
    expect(existsSync(path.join(scratch, 'notes.txt'))).toBe(true);
    a.close();
  });

  it('a change to the user’s own agy config during a turn ends the session', async () => {
    const home = tmpDir('fl-agy-home-');
    mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
    const a = adapter({}, { home });
    const { sessionId } = await a.agent.request(acp.methods.agent.session.new, { cwd: await gitRepo(), mcpServers: [] });
    await a.agent.request(acp.methods.agent.session.setConfigOption, { sessionId, configId: 'mode', value: 'accept-edits' });
    const turn = a.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: prompt('pause') });
    await waitFor(() => a.calls().length > 0);
    writeFileSync(path.join(home, '.gemini', 'antigravity-cli', 'settings.json'), '{"toolPermission":"always-proceed"}');
    await expect(turn).rejects.toMatchObject({ data: { details: expect.stringMatching(/agy config in ~\/\.gemini changed.*session has ended/) } });
    await expect(a.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: prompt('next') })).rejects.toMatchObject({ data: { details: expect.stringMatching(/session has ended/) } });
    expect(a.calls()).toHaveLength(1);
    a.close();
  });

  it('talk only: FriedLiver gives excerpts, then reads what agy asks for through its index, refusing escapes and secrets', async () => {
    const a = adapter();
    const b = bridge();
    const project = await gitRepo();
    const { sessionId } = await a.agent.request(acp.methods.agent.session.new, { cwd: project, mcpServers: [b.server] });
    await a.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: prompt('ask-need') });
    expect(b.calls()).toEqual([
      { name: 'index_search', args: { query: 'ask-need', limit: 5, budget: 1500 } },
      { name: 'index_read', args: { path: 'src/a.ts', lines: [1, 2] } },
      { name: 'index_search', args: { query: 'jsonb', limit: 5, budget: 1500 } },
    ]);
    expect(a.thought()).toBe('Let me look.');
    expect(a.tools().filter((t) => t.sessionUpdate === 'tool_call').map((t) => t.sessionUpdate === 'tool_call' && [t.kind, t.title])).toEqual([
      ['read', 'Read src/a.ts 1-2'],
      ['search', 'Search the project: jsonb'],
    ]);
    const answer = a.said();
    expect(answer).toMatch(/^Got answers:\n## FriedLiver's answers/);
    expect(answer).toContain('index_read {"path":"src/a.ts","lines":[1,2]}');
    expect(answer).toContain('Refused: ../../etc/passwd: not inside the project.');
    expect(answer).toContain('Refused: config/.env: may hold secrets.');
    expect(answer).toContain('Refused: /etc/hosts: not inside the project.');
    expect(a.calls().map((c) => c.argv.at(-1))).toEqual(['--sandbox', 'conv-ask']);
    a.close();
  });

  it('talk only: at most TALK_LIMITS.rounds rounds of reads, then agy’s answer as it is', async () => {
    const a = adapter();
    const b = bridge();
    const { sessionId } = await a.agent.request(acp.methods.agent.session.new, { cwd: await gitRepo(), mcpServers: [b.server] });
    await a.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: prompt('always-need') });
    expect(a.calls()).toHaveLength(TALK_LIMITS.rounds + 1);
    expect(b.calls().filter((c) => c.name === 'index_read')).toHaveLength(TALK_LIMITS.rounds);
    expect(a.said()).toBe('Again.\n\n(FriedLiver’s reads for this turn are used up.)');
    a.close();
  });

  it('talk only: the turn’s read budget caps what FriedLiver passes on', async () => {
    const a = adapter();
    const b = bridge();
    const { sessionId } = await a.agent.request(acp.methods.agent.session.new, { cwd: await gitRepo(), mcpServers: [b.server] });
    await a.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: prompt('big-need') });
    const answers = a.tools().flatMap((t) => (t.sessionUpdate === 'tool_call_update' && t.content?.[0]?.type === 'content' && t.content[0].content.type === 'text' ? [t.content[0].content.text] : []));
    expect(answers.join('').length).toBeLessThanOrEqual(TALK_LIMITS.turnChars + 200);
    expect(answers.at(-1)).toMatch(/read budget for this turn is used up/);
    a.close();
  });

  it('talk only without FriedLiver’s tools (a read-only chat): agy is told FriedLiver can’t read here', async () => {
    const a = adapter();
    const { sessionId } = await a.agent.request(acp.methods.agent.session.new, { cwd: await gitRepo(), mcpServers: [] });
    await a.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: prompt('ask-need') });
    expect(a.said()).toContain('Couldn’t: This chat has no project index');
    a.close();
  });

  it('runs edits in the project with the chosen model and effort, shows tool steps, and continues the conversation', async () => {
    const a = adapter();
    const project = await gitRepo();
    const { sessionId } = await a.agent.request(acp.methods.agent.session.new, { cwd: project, mcpServers: [] });
    await expect(a.agent.request(acp.methods.agent.session.setConfigOption, { sessionId, configId: 'mode', value: 'manual' })).rejects.toThrow(/Unknown mode/);
    await a.agent.request(acp.methods.agent.session.setConfigOption, { sessionId, configId: 'mode', value: 'accept-edits' });
    await a.agent.request(acp.methods.agent.session.setConfigOption, { sessionId, configId: 'model', value: 'Gemini 3.1 Pro (High)' });
    await a.agent.request(acp.methods.agent.session.setConfigOption, { sessionId, configId: 'effort', value: 'high' });
    await expect(a.agent.request(acp.methods.agent.session.setConfigOption, { sessionId, configId: 'model', value: 'not-a-model' })).rejects.toThrow(/Unknown model/);
    await a.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: prompt('edit') });
    expect(a.said()).toBe('You said: edit');
    await a.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: prompt('again') });
    const [first, second] = a.calls();
    expect(first.cwd).toBe(project);
    expect(first.argv).toEqual(expect.arrayContaining(['--mode', 'accept-edits', '--sandbox', '--model', 'Gemini 3.1 Pro (High)', '--effort', 'high']));
    expect(first.argv).not.toContain('edit');
    expect(first.argv).not.toContain('--conversation');
    expect(second.argv.slice(-2)).toEqual(['--conversation', 'conv-1']);
    const tool = a.updates.map((u) => u.update).filter((u) => u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update');
    expect(tool[0]).toMatchObject({ sessionUpdate: 'tool_call', title: 'write_to_file', kind: 'edit', status: 'in_progress', locations: [{ path: path.join(project, 'notes.md') }] });
    expect(tool[1]).toMatchObject({ sessionUpdate: 'tool_call_update', status: 'completed' });
    a.close();
  });

  it('refuses to start agy in a folder whose agy config could run code, before every turn', async () => {
    const a = adapter();
    const project = await gitRepo();
    const { sessionId } = await a.agent.request(acp.methods.agent.session.new, { cwd: project, mcpServers: [] });
    await a.agent.request(acp.methods.agent.session.setConfigOption, { sessionId, configId: 'mode', value: 'full' });
    await a.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: prompt('first') });
    // The repository adds an MCP server between turns.
    mkdirSync(path.join(project, '.agents'));
    writeFileSync(path.join(project, '.agents', 'mcp_config.json'), '{"mcpServers":{"x":{"command":"evil"}}}');
    await expect(a.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: prompt('second') })).rejects.toMatchObject({ data: { details: expect.stringContaining(path.join('.agents', 'mcp_config.json')) } });
    expect(a.calls()).toHaveLength(1);
    a.close();
  });

  it('a write to .gemini/settings.json during a turn fails at the OS level, even in Full access', async () => {
    const a = adapter();
    const project = await gitRepo();
    const { sessionId } = await a.agent.request(acp.methods.agent.session.new, { cwd: project, mcpServers: [] });
    await a.agent.request(acp.methods.agent.session.setConfigOption, { sessionId, configId: 'mode', value: 'full' });
    await a.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: prompt('write-config') });
    expect(a.said()).toMatch(/^\[refused: EPERM\] /);
    expect(existsSync(path.join(project, '.gemini', 'settings.json'))).toBe(false);
    a.close();
  });

  it('config that appears during a turn from elsewhere ends the session: a clear reason, and no next turn runs', async () => {
    const a = adapter();
    const project = await gitRepo();
    const { sessionId } = await a.agent.request(acp.methods.agent.session.new, { cwd: project, mcpServers: [] });
    await a.agent.request(acp.methods.agent.session.setConfigOption, { sessionId, configId: 'mode', value: 'accept-edits' });
    const turn = a.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: prompt('pause') });
    await waitFor(() => a.calls().length > 0);
    // Another agent or a script in the same folder, not sandboxed.
    mkdirSync(path.join(project, '.agents'));
    writeFileSync(path.join(project, '.agents', 'hooks.json'), '{}');
    await expect(turn).rejects.toMatchObject({ data: { details: expect.stringMatching(/\.agents.hooks\.json.*session has ended/s) } });
    rmSync(path.join(project, '.agents'), { recursive: true });
    await expect(a.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: prompt('next') })).rejects.toMatchObject({ data: { details: expect.stringMatching(/session has ended/) } });
    expect(a.calls()).toHaveLength(1);
    a.close();
  });

  it('says what agy said went wrong', async () => {
    const a = adapter();
    const { sessionId } = await a.agent.request(acp.methods.agent.session.new, { cwd: await gitRepo(), mcpServers: [] });
    await a.agent.request(acp.methods.agent.session.setConfigOption, { sessionId, configId: 'mode', value: 'accept-edits' });
    await expect(a.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: prompt('fail') })).rejects.toMatchObject({ data: { details: 'boom: the model refused' } });
    a.close();
  });

  it('Stop ends agy’s turn', async () => {
    const a = adapter();
    const { sessionId } = await a.agent.request(acp.methods.agent.session.new, { cwd: await gitRepo(), mcpServers: [] });
    await a.agent.request(acp.methods.agent.session.setConfigOption, { sessionId, configId: 'mode', value: 'accept-edits' });
    const turn = a.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: prompt('slow') });
    await waitFor(() => a.calls().length > 0);
    await new Promise((r) => setTimeout(r, 200));
    await a.agent.notify(acp.methods.agent.session.cancel, { sessionId });
    expect((await turn).stopReason).toBe('cancelled');
    a.close();
  });

  it('signed out: a session asks for sign-in (ACP auth_required)', async () => {
    const a = adapter({ FAKE_AGY_SIGNED_OUT: '1' });
    await expect(a.agent.request(acp.methods.agent.session.new, { cwd: await gitRepo(), mcpServers: [] })).rejects.toMatchObject({ code: -32000 });
    a.close();
  });

  it('signed out during a turn: asks for sign-in at once, and never types the prompt into agy’s code prompt', async () => {
    const a = adapter({ FAKE_AGY_SIGNED_OUT: 'turn' });
    const { sessionId } = await a.agent.request(acp.methods.agent.session.new, { cwd: await gitRepo(), mcpServers: [] });
    await a.agent.request(acp.methods.agent.session.setConfigOption, { sessionId, configId: 'mode', value: 'accept-edits' });
    const started = Date.now();
    await expect(a.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: prompt('secret') })).rejects.toMatchObject({ code: -32000 });
    expect(Date.now() - started).toBeLessThan(10_000);
    a.close();
  });
});

describe('Antigravity in FriedLiver', () => {
  it('runs FriedLiver’s adapter with the agy it found, and the user’s extra arguments', () => {
    const core = makeCore(tmpDir('fl-agy-'), {
      agyAdapterScript: '/ext/dist/agy-acp.js',
      agentCommand: (id) => (id === 'antigravity' ? { command: process.execPath, args: ['--project', 'p1'] } : { command: '', args: [] }),
    });
    const spec = core.spec('antigravity');
    expect(spec).toMatchObject({ label: 'Antigravity', command: process.execPath, args: ['/ext/dist/agy-acp.js'] });
    expect(spec.env).toMatchObject({ ELECTRON_RUN_AS_NODE: '1', FRIEDLIVER_AGY: process.execPath, FRIEDLIVER_AGY_ARGS: '["--project","p1"]' });
  });

  it('missing agy: Agents & Accounts says Not installed, with agy’s official installer', async () => {
    const core = makeCore(await gitRepo(), {
      agyAdapterScript: '/ext/dist/agy-acp.js',
      agentCommand: (id) => (id === 'antigravity' ? { command: 'fl-agy-that-is-not-installed', args: [] } : { command: process.execPath, args: [DEMO_AGENT] }),
    });
    expect(findProgram('fl-agy-that-is-not-installed')).toBeNull();
    expect(core.spec('antigravity')).toMatchObject({ command: 'fl-agy-that-is-not-installed', args: [] });
    const status = await core.checkAccount('antigravity');
    expect(status).toMatchObject({ status: 'not-installed', installCommand: DEFAULT_AGENTS.antigravity.installCommand });
    expect(status.message).toContain('fl-agy-that-is-not-installed');
  });

  it('a chat in a discussion (or read only) keeps its level: changes are refused, and each prompt says read only', async () => {
    const core = makeCore(await gitRepo());
    const chat = await core.createChat('claude');
    await core.send(chat.id, 'hello');
    const inner = core as unknown as { guardDiscussion(id: string, on: boolean): Promise<void>; mustStayReadOnly(id: string): boolean };
    const mode = () => core.chat(chat.id)?.session?.options.find((o) => o.category === 'mode')?.current;
    await inner.guardDiscussion(chat.id, true);
    const during = mode();
    await core.setApproval(chat.id, 'edits');
    await core.setOption(chat.id, 'mode', 'bypassPermissions');
    await core.setPlan(chat.id, false);
    expect(core.chat(chat.id)?.approval ?? 'ask').toBe('ask');
    expect(mode()).toBe(during);
    expect(core.chat(chat.id)!.items.at(-1)).toMatchObject({ kind: 'notice', text: expect.stringContaining('stays read only') });
    expect(inner.mustStayReadOnly(chat.id)).toBe(true);
    expect(READ_ONLY_PROMPT_META).toEqual({ friedliver: { readOnly: true } });
    await inner.guardDiscussion(chat.id, false);
    expect(inner.mustStayReadOnly(chat.id)).toBe(false);
    await core.setApproval(chat.id, 'edits');
    expect(core.chat(chat.id)?.approval).toBe('edits');
  });

  it('is offered for Inline Edit, which is read only (talk only for it)', () => {
    expect(manifest.contributes.configuration.properties['friedliver.inlineEdit.agent'].enum).toContain('antigravity');
  });

  it('never starts in a workspace VS Code doesn’t trust', () => {
    expect(manifest.capabilities.untrustedWorkspaces.supported).toBe(false);
  });

  it('the Install and sign-in lines are FriedLiver’s own, and only a pipe into bash or iex passes', () => {
    expect(installCommandFor('antigravity')).toBe(process.platform === 'win32' ? 'irm https://antigravity.google/cli/install.ps1 | iex' : 'curl -fsSL https://antigravity.google/cli/install.sh | bash');
    expect(cliLineFor(CLI_ACCOUNTS.antigravity.signIn.command)).toBe('agy');
    for (const bad of ['curl x | sh', 'curl x | bash; rm -rf ~', 'curl x | bash | bash', 'a && b', 'curl x |bash']) expect(cliLineFor(bad)).toBeNull();
    expect(KEY_SETUPS.antigravity).toEqual([]);
  });

  it('@agy and @antigravity reach it, in chats, Edit with Agent and the @ picker', () => {
    expect(parseMention('@agy review this')).toEqual({ agent: 'antigravity', text: 'review this' });
    expect(parseMention('@antigravity, is this right?')).toEqual({ agent: 'antigravity', text: 'is this right?' });
    expect(parseEditInput('@agy make it async')).toEqual({ agent: 'antigravity', instruction: 'make it async' });
    expect(mentionOptions('ag').map((o) => o.agent)).toContain('antigravity');
  });

  it('has its own neutral mark, not the robot face for unknown agents', () => {
    expect(markFor('antigravity')).not.toEqual(markFor('someone-else'));
  });

  /** A core whose Antigravity is the built adapter over the fake agy (test/fixtures/agy-acp-test-entry.ts). */
  async function agyCore(dir: string, over: Parameters<typeof makeCore>[1] = {}) {
    const script = path.join(tmpDir('fl-agy-dist-'), 'agy-acp.js');
    await build({
      entryPoints: [path.resolve(__dirname, 'fixtures/agy-acp-test-entry.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      outfile: script,
      logLevel: 'silent',
      alias: { '@friedliver/main': path.resolve(__dirname, '../../../agent-core/main') },
    });
    const logDir = tmpDir('fl-agy-log-');
    const log = path.join(logDir, 'calls.jsonl');
    writeFileSync(log, '');
    Object.assign(process.env, { FAKE_AGY_LOG: log, FAKE_AGY_SCRIPT: FAKE_AGY, FAKE_TALK_READ: JSON.stringify(NODE_READ), FAKE_TALK_WRITE: JSON.stringify([logDir]) });
    const core = makeCore(dir, { agyAdapterScript: script, agentCommand: (id) => (id === 'antigravity' ? { command: process.execPath, args: [] } : { command: process.execPath, args: [DEMO_AGENT] }), ...over });
    const calls = () =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { argv: string[]; cwd: string })
        .filter((c) => c.argv.includes('--input-format'));
    return { core, calls };
  }
  afterEach(() => {
    for (const k of ['FAKE_AGY_LOG', 'FAKE_AGY_SCRIPT', 'FAKE_TALK_READ', 'FAKE_TALK_WRITE']) delete process.env[k];
  });

  it.skipIf(process.platform !== 'darwin')(
    'end to end: Manual talks in its own folder; Edit automatically answers in the project',
    async () => {
      const dir = await gitRepo();
      const { core, calls } = await agyCore(dir);
      const chat = await core.createChat('antigravity');
      await core.send(chat.id, 'hello there');
      let view = core.chat(chat.id)!;
      expect(view.session?.options.find((o) => o.category === 'mode')?.current).toBe('read-only');
      expect(view.session?.agent).toMatchObject({ name: 'agy', version: '1.4.3' });
      expect(view.items.flatMap((i) => (i.kind === 'agent' ? [i.text] : [])).join('')).toBe('You said: hello there');
      expect(path.basename(calls()[0].cwd)).toMatch(/^friedliver-agy-talk-/);

      await core.setApproval(chat.id, 'edits');
      await core.send(chat.id, 'hello again');
      view = core.chat(chat.id)!;
      expect(view.items.flatMap((i) => (i.kind === 'agent' ? [i.text] : [])).join('')).toContain('You said: hello again');
      expect(calls()[1].cwd).toBe(dir);
      expect(calls()[1].argv).toEqual(expect.arrayContaining(['--mode', 'accept-edits', '--sandbox']));
    },
    30_000,
  );

  it.skipIf(process.platform !== 'darwin')(
    'end to end: /discuss with Antigravity runs its turns talk only, with a stance the card reads, from Start and Continue',
    async () => {
      const dir = await gitRepo();
      const { core, calls } = await agyCore(dir, { discussSettings: () => ({ maxRounds: 1 }) });
      const c = await core.createChat('claude');
      await core.discuss(c.id, ['antigravity'], 'Postgres or MySQL for the audit log?');
      const card = () => core.chat(c.id)!.items.filter((i): i is DiscussionItem => i.kind === 'discussion');
      expect(card()[0]).toMatchObject({ state: 'done', ended: 'rounds' });
      expect(card()[0].turns.map((t) => t.by)).toEqual(['claude', 'antigravity']);
      // The fake agy echoes the turn prompt, whose example stance block parses, as the Demo agent's does.
      expect(card()[0].turns[1].stance).toBeDefined();
      expect(calls().every((call) => path.basename(call.cwd).startsWith('friedliver-agy-talk-'))).toBe(true);
      await core.discussions.continue(card()[0].id);
      expect(card()[1]).toMatchObject({ state: 'done' });
      expect(card()[1].turns.filter((t) => t.by === 'antigravity')).toHaveLength(2);
      expect(calls().every((call) => path.basename(call.cwd).startsWith('friedliver-agy-talk-'))).toBe(true);
    },
    60_000,
  );
});
