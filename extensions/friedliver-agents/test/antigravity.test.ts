// Antigravity (Google's `agy`): FriedLiver's ACP adapter over agy's headless stream-json mode,
// and the agent's place in FriedLiver (spec, levels, mentions, Accounts). agy itself is the
// fixture test/fixtures/fake-agy.mjs: no network, no sign-in.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { build } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';
import { AGY_MODES, extraArgs, parseModels, seatbeltProfile, settingsModel, toolKind, turnArgs, workspaceConfig } from '@friedliver/main/agents/agy';
import { PLATFORM_REFUSAL, agyAgent, type AgyAdapterOptions } from '@friedliver/main/agents/agyAcp';
import { findProgram } from '@friedliver/main/agents/processes';
import { DEFAULT_AGENTS } from '@friedliver/main/agents/registry';
import { parseEditInput } from '../src/host/editorPrompt';
import { cliLineFor, installCommandFor } from '../src/host/signin';
import { CLI_ACCOUNTS, KEY_SETUPS } from '../src/shared/accounts';
import { parseMention } from '../src/shared/model';
import { modeFor, planToggle, readOnlyChoice, sessionOptions } from '../src/shared/session';
import { mentionOptions } from '../src/shared/view';
import { markFor } from '../src/webview/ui/marks';
import { DEMO_AGENT, disposeCores, gitRepo, makeCore, tmpDir, waitFor } from './helpers';

const FAKE_AGY = path.resolve(__dirname, 'fixtures/fake-agy.mjs');
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
  const mode = sessionOptions({ configOptions: [{ id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'manual', options: AGY_MODES }] as acp.SessionConfigOption[] }).find((o) => o.category === 'mode');

  it('Manual is a mode that runs nothing, Edit automatically accepts edits, Auto is full access', () => {
    expect(modeFor('antigravity', mode, 'ask')).toBe('manual');
    expect(modeFor('antigravity', mode, 'edits')).toBe('accept-edits');
    expect(modeFor('antigravity', mode, 'full')).toBe('full');
  });

  it('offers no read-only or plan mode: agy enforces neither, so FriedLiver claims neither', () => {
    expect(readOnlyChoice(mode ? [mode] : [])).toBeUndefined();
    expect(planToggle({ options: mode ? [mode] : [], commands: [], live: true })).toBeUndefined();
    expect(modeFor('antigravity', mode, 'plan')).toBeUndefined();
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
});

/** The adapter in this process, talking to the fake agy; every update it sends is kept. */
function adapter(env: Record<string, string> = {}, over: Partial<AgyAdapterOptions> = {}) {
  const log = path.join(tmpDir('fl-agy-log-'), 'calls.jsonl');
  writeFileSync(log, '');
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
  return { agent: conn.agent, updates, calls, said, close: () => (conn.close(), served.close()) };
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
  it('starts a session with agy’s models and version, in Manual, which runs nothing', async () => {
    const a = adapter();
    const init = await a.agent.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    expect(init.agentInfo).toMatchObject({ name: 'agy', version: '1.4.3' });
    expect(init.agentCapabilities?.loadSession).toBe(false);
    const project = await gitRepo();
    const s = await a.agent.request(acp.methods.agent.session.new, { cwd: project, mcpServers: [] });
    const options = sessionOptions(s);
    expect(options.find((o) => o.category === 'mode')?.current).toBe('manual');
    expect(options.find((o) => o.category === 'model')?.choices.map((c) => c.value)).toEqual(['default', 'Gemini 3.8 Flash (Medium)', 'Gemini 3.1 Pro (High)', 'Claude Sonnet 5.5 (Thinking)']);
    expect(options.find((o) => o.category === 'thought_level')?.choices.map((c) => c.value)).toEqual(['default', 'low', 'medium', 'high', 'xhigh', 'max']);
    // Manual: no agy process at all, and a reason that says what to pick.
    await expect(a.agent.request(acp.methods.agent.session.prompt, { sessionId: s.sessionId, prompt: prompt('hello') })).rejects.toMatchObject({ data: { details: expect.stringMatching(/can’t ask.*Edit automatically/) } });
    expect(a.calls()).toEqual([]);
    a.close();
  });

  it('runs edits in the project with the chosen model and effort, shows tool steps, and continues the conversation', async () => {
    const a = adapter();
    const project = await gitRepo();
    const { sessionId } = await a.agent.request(acp.methods.agent.session.new, { cwd: project, mcpServers: [] });
    await expect(a.agent.request(acp.methods.agent.session.setConfigOption, { sessionId, configId: 'mode', value: 'read-only' })).rejects.toThrow(/Unknown mode/);
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

  it('never runs read only: no read-only chat (Inline Edit), no /discuss, and not the Inline Edit agent setting', async () => {
    const core = makeCore(await gitRepo());
    await expect(core.createChat('antigravity', { readOnly: true })).rejects.toThrow(/Antigravity can’t work read only/);
    const chat = await core.createChat('claude');
    await expect(core.discuss(chat.id, ['antigravity'], 'tabs or spaces?')).rejects.toThrow(/Antigravity can’t work read only/);
    const starter = await core.createChat('antigravity');
    await expect(core.discuss(starter.id, ['claude'], 'tabs or spaces?')).rejects.toThrow(/Antigravity can’t work read only/);
    expect(manifest.contributes.configuration.properties['friedliver.inlineEdit.agent'].enum).not.toContain('antigravity');
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

  it.skipIf(process.platform !== 'darwin')(
    'end to end: a chat with Antigravity runs nothing in Manual, and answers through the built adapter in Edit automatically',
    async () => {
      const bin = tmpDir('fl-agy-bin-');
      const agy = path.join(bin, 'agy');
      writeFileSync(agy, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_AGY}" "$@"\n`);
      chmodSync(agy, 0o755);
      const script = path.join(tmpDir('fl-agy-dist-'), 'agy-acp.js');
      await build({ entryPoints: [path.resolve(__dirname, '../../../agent-core/main/agents/agyAcpMain.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node20', outfile: script, logLevel: 'silent' });
      const log = path.join(bin, 'calls.jsonl');
      writeFileSync(log, '');
      process.env.FAKE_AGY_LOG = log;
      try {
        const dir = await gitRepo();
        const core = makeCore(dir, { agyAdapterScript: script, agentCommand: (id) => (id === 'antigravity' ? { command: agy, args: [] } : { command: '', args: [] }) });
        const chat = await core.createChat('antigravity');
        await core.send(chat.id, 'hello there');
        let view = core.chat(chat.id)!;
        expect(view.session?.options.find((o) => o.category === 'mode')?.current).toBe('manual');
        expect(view.session?.agent).toMatchObject({ name: 'agy', version: '1.4.3' });
        expect(view.items.at(-1)).toMatchObject({ kind: 'notice', tone: 'error' });
        expect(readFileSync(log, 'utf8')).not.toContain('--input-format');

        await core.setApproval(chat.id, 'edits');
        await core.send(chat.id, 'hello again');
        view = core.chat(chat.id)!;
        expect(view.items.flatMap((i) => (i.kind === 'agent' ? [i.text] : [])).join('')).toBe('You said: hello again');
        const turn = readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l) as { argv: string[]; cwd: string })
          .find((c) => c.argv.includes('--input-format'))!;
        expect(turn.cwd).toBe(dir);
        expect(turn.argv).toEqual(expect.arrayContaining(['--mode', 'accept-edits', '--sandbox']));
      } finally {
        delete process.env.FAKE_AGY_LOG;
      }
    },
    30_000,
  );
});
