// Antigravity (Google's `agy`): FriedLiver's ACP adapter over agy's headless stream-json mode,
// and the agent's place in FriedLiver (spec, levels, mentions, Accounts). agy itself is the
// fixture test/fixtures/fake-agy.mjs: no network, no sign-in.
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { build } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';
import { AGY_MODES, extraArgs, parseModels, settingsModel, toolKind, turnArgs } from '@friedliver/main/agents/agy';
import { agyAgent } from '@friedliver/main/agents/agyAcp';
import { findProgram } from '@friedliver/main/agents/processes';
import { DEFAULT_AGENTS } from '@friedliver/main/agents/registry';
import { parseEditInput } from '../src/host/editorPrompt';
import { cliLineFor, installCommandFor } from '../src/host/signin';
import { CLI_ACCOUNTS, KEY_SETUPS } from '../src/shared/accounts';
import { parseMention } from '../src/shared/model';
import { modeFor, readOnlyChoice, sessionOptions } from '../src/shared/session';
import { mentionOptions } from '../src/shared/view';
import { markFor } from '../src/webview/ui/marks';
import { DEMO_AGENT, disposeCores, gitRepo, makeCore, tmpDir, waitFor } from './helpers';

const FAKE_AGY = path.resolve(__dirname, 'fixtures/fake-agy.mjs');

afterEach(disposeCores);

describe('agy turn arguments', () => {
  it('runs every turn headless, in stream-json both ways, with slash commands off', () => {
    const args = turnArgs({ mode: 'accept-edits', model: 'default', effort: 'default' });
    expect(args).toEqual(['--output-format', 'stream-json', '--input-format', 'stream-json', '--disable-slash-commands', '--mode', 'accept-edits', '--sandbox']);
    expect(args).not.toContain('-p');
  });

  it('maps each level to agy’s own flags; only Full access skips permissions', () => {
    expect(turnArgs({ mode: 'read-only', model: 'default', effort: 'default' })).toEqual(expect.arrayContaining(['--mode', 'plan', '--sandbox']));
    expect(turnArgs({ mode: 'plan', model: 'default', effort: 'default' })).toEqual(expect.arrayContaining(['--mode', 'plan', '--sandbox']));
    for (const mode of ['read-only', 'plan', 'accept-edits'] as const) expect(turnArgs({ mode, model: 'default', effort: 'default' })).not.toContain('--dangerously-skip-permissions');
    expect(turnArgs({ mode: 'full', model: 'default', effort: 'default' })).toContain('--dangerously-skip-permissions');
  });

  it('passes the chosen model, effort and agy conversation', () => {
    const args = turnArgs({ mode: 'plan', model: 'Gemini 3.1 Pro (High)', effort: 'high', conversationId: 'c-1' });
    expect(args.slice(-6)).toEqual(['--model', 'Gemini 3.1 Pro (High)', '--effort', 'high', '--conversation', 'c-1']);
  });

  it('drops the user’s extra flags that would change what agy may do, keeps the rest', () => {
    const user = ['--project', 'p1', '--dangerously-skip-permissions', '--mode', 'auto', '--model=x', '--add-dir', '/', '-p', 'hi', '--continue', '--log-file', '/tmp/a.log'];
    expect(extraArgs(user)).toEqual(['--project', 'p1', '--log-file', '/tmp/a.log']);
    expect(turnArgs({ mode: 'read-only', model: 'default', effort: 'default' }, user)).not.toContain('--dangerously-skip-permissions');
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

  it('Manual is read only, Edit automatically accepts edits, Auto is full access, Plan is plan', () => {
    expect(modeFor('antigravity', mode, 'ask')).toBe('read-only');
    expect(modeFor('antigravity', mode, 'edits')).toBe('accept-edits');
    expect(modeFor('antigravity', mode, 'full')).toBe('full');
    expect(modeFor('antigravity', mode, 'plan')).toBe('plan');
  });

  it('a read-only chat (Discuss, Inline Edit) picks the read-only mode', () => {
    expect(readOnlyChoice(mode ? [mode] : [])).toMatchObject({ value: 'read-only' });
  });
});

/** The adapter in this process, talking to the fake agy; every update it sends is kept. */
function adapter(env: Record<string, string> = {}) {
  const log = path.join(tmpDir('fl-agy-log-'), 'calls.jsonl');
  const updates: acp.SessionNotification[] = [];
  // Over NDJSON byte streams, as on stdio (agent-core may load its own copy of the SDK).
  const toAgent = new TransformStream<Uint8Array, Uint8Array>();
  const toClient = new TransformStream<Uint8Array, Uint8Array>();
  const served = agyAgent({ command: process.execPath, baseArgs: [FAKE_AGY], env: { ...process.env, FAKE_AGY_LOG: log, ...env } }).connect(acp.ndJsonStream(toClient.writable, toAgent.readable));
  const conn = acp
    .client({ name: 'test' })
    .onNotification(acp.methods.client.session.update, ({ params }) => void updates.push(params))
    .connect(acp.ndJsonStream(toAgent.writable, toClient.readable));
  const calls = (): { argv: string[]; cwd: string }[] =>
    readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { argv: string[]; cwd: string })
      .filter((c) => c.argv[0] !== 'models' && c.argv[0] !== '--version');
  const said = () => updates.flatMap((u) => (u.update.sessionUpdate === 'agent_message_chunk' && u.update.content.type === 'text' ? [u.update.content.text] : [])).join('');
  return { agent: conn.agent, updates, calls, said, close: () => (conn.close(), served.close()) };
}

const prompt = (text: string): acp.ContentBlock[] => [{ type: 'text', text }];

describe('the agy ACP adapter (fake agy)', () => {
  it('starts a session with agy’s models, its version, and Manual’s read-only mode', async () => {
    const a = adapter();
    const init = await a.agent.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    expect(init.agentInfo).toMatchObject({ name: 'agy', version: '1.4.3' });
    expect(init.agentCapabilities?.loadSession).toBe(false);
    const project = await gitRepo();
    const s = await a.agent.request(acp.methods.agent.session.new, { cwd: project, mcpServers: [] });
    const options = sessionOptions(s);
    expect(options.find((o) => o.category === 'mode')?.current).toBe('read-only');
    const model = options.find((o) => o.category === 'model');
    expect(model?.choices.map((c) => c.value)).toEqual(['default', 'Gemini 3.8 Flash (Medium)', 'Gemini 3.1 Pro (High)', 'Claude Sonnet 5.5 (Thinking)']);
    expect(options.find((o) => o.category === 'thought_level')?.choices.map((c) => c.value)).toEqual(['default', 'low', 'medium', 'high', 'xhigh', 'max']);
    a.close();
  });

  it('read only: agy works in an empty folder, never the project, with plan mode and its sandbox', async () => {
    const a = adapter();
    const project = await gitRepo();
    const { sessionId } = await a.agent.request(acp.methods.agent.session.new, { cwd: project, mcpServers: [] });
    const r = await a.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: prompt('hello') });
    expect(r.stopReason).toBe('end_turn');
    expect(a.said()).toBe('You said: hello');
    await a.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: prompt('more') });
    const [call, next] = a.calls();
    expect(path.basename(call.cwd)).toMatch(/^friedliver-agy-/);
    expect(path.relative(project, call.cwd).startsWith('..')).toBe(true);
    expect(call.argv).toEqual(expect.arrayContaining(['--mode', 'plan', '--sandbox']));
    expect(call.argv).not.toContain('hello');
    // The same empty folder and conversation for the session's next turn.
    expect(next.cwd).toBe(call.cwd);
    expect(next.argv.slice(-2)).toEqual(['--conversation', 'conv-1']);
    a.close();
  });

  it('runs edits in the project with the chosen model and effort, shows tool steps, and continues the conversation', async () => {
    const a = adapter();
    const project = await gitRepo();
    const { sessionId } = await a.agent.request(acp.methods.agent.session.new, { cwd: project, mcpServers: [] });
    await a.agent.request(acp.methods.agent.session.setConfigOption, { sessionId, configId: 'mode', value: 'accept-edits' });
    await a.agent.request(acp.methods.agent.session.setConfigOption, { sessionId, configId: 'model', value: 'Gemini 3.1 Pro (High)' });
    await a.agent.request(acp.methods.agent.session.setConfigOption, { sessionId, configId: 'effort', value: 'high' });
    await expect(a.agent.request(acp.methods.agent.session.setConfigOption, { sessionId, configId: 'model', value: 'not-a-model' })).rejects.toThrow(/Unknown model/);
    await a.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: prompt('edit') });
    await a.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: prompt('again') });
    const [first, second] = a.calls();
    expect(first.cwd).toBe(project);
    expect(first.argv).toEqual(expect.arrayContaining(['--mode', 'accept-edits', '--model', 'Gemini 3.1 Pro (High)', '--effort', 'high']));
    expect(first.argv).not.toContain('--conversation');
    expect(second.argv.slice(-2)).toEqual(['--conversation', 'conv-1']);
    const tool = a.updates.map((u) => u.update).filter((u) => u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update');
    expect(tool[0]).toMatchObject({ sessionUpdate: 'tool_call', title: 'write_to_file', kind: 'edit', status: 'in_progress', locations: [{ path: path.join(project, 'notes.md') }] });
    expect(tool[1]).toMatchObject({ sessionUpdate: 'tool_call_update', status: 'completed' });
    a.close();
  });

  it('says what agy said went wrong', async () => {
    const a = adapter();
    const { sessionId } = await a.agent.request(acp.methods.agent.session.new, { cwd: await gitRepo(), mcpServers: [] });
    await expect(a.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: prompt('fail') })).rejects.toMatchObject({ data: { details: 'boom: the model refused' } });
    a.close();
  });

  it('Stop ends agy’s turn', async () => {
    const a = adapter();
    const { sessionId } = await a.agent.request(acp.methods.agent.session.new, { cwd: await gitRepo(), mcpServers: [] });
    const turn = a.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: prompt('slow') });
    await waitFor(() => a.updates.length > 0 || a.calls().length > 0);
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

  it.skipIf(process.platform === 'win32')(
    'end to end: a Manual chat with Antigravity answers through the built adapter, read only',
    async () => {
      const bin = tmpDir('fl-agy-bin-');
      const agy = path.join(bin, 'agy');
      writeFileSync(agy, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_AGY}" "$@"\n`);
      chmodSync(agy, 0o755);
      const script = path.join(tmpDir('fl-agy-dist-'), 'agy-acp.js');
      await build({ entryPoints: [path.resolve(__dirname, '../../../agent-core/main/agents/agyAcpMain.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node20', outfile: script, logLevel: 'silent' });
      const log = path.join(bin, 'calls.jsonl');
      process.env.FAKE_AGY_LOG = log;
      try {
        const dir = await gitRepo();
        const core = makeCore(dir, { agyAdapterScript: script, agentCommand: (id) => (id === 'antigravity' ? { command: agy, args: [] } : { command: '', args: [] }) });
        const chat = await core.createChat('antigravity');
        await core.send(chat.id, 'hello there');
        const view = core.chat(chat.id)!;
        expect(view.items.flatMap((i) => (i.kind === 'agent' ? [i.text] : [])).join('')).toBe('You said: hello there');
        expect(view.session?.options.find((o) => o.category === 'mode')?.current).toBe('read-only');
        expect(view.session?.agent).toMatchObject({ name: 'agy', version: '1.4.3' });
        const turn = readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l) as { argv: string[]; cwd: string })
          .find((c) => c.argv.includes('--input-format'))!;
        expect(path.basename(turn.cwd)).toMatch(/^friedliver-agy-/);
        expect(path.relative(dir, turn.cwd).startsWith('..')).toBe(true);
        expect(turn.argv).toEqual(expect.arrayContaining(['--mode', 'plan', '--sandbox']));
      } finally {
        delete process.env.FAKE_AGY_LOG;
      }
    },
    30_000,
  );
});
