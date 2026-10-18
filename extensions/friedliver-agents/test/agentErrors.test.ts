import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RequestError } from '@agentclientprotocol/sdk';
import { agentErrorMessage, describeAgentError } from '@friedliver/main/agents/agentConnection';
import { codexModelVisibility } from '../src/host/codexModels';
import { modelProblem } from '../src/host/core';
import { parseSaved } from '../src/host/persist';
import { applySessionUpdate, hiddenModels, sessionOptions, withoutModels, type ChatSession } from '../src/shared/session';
import { parseWebviewMessage } from '../src/shared/messages';
import { lastReply, type ChatView, type Item } from '../src/shared/model';
import { disposeCores, gitRepo, makeCore, waitFor } from './helpers';

afterEach(disposeCores);

// What the real adapters answered on this Mac (codex-acp 0.16, gemini-cli 0.64).
const codexRefusal = new RequestError(-32603, 'Internal error', {
  message: JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', message: "The 'some-model' model is not supported when using Codex with a ChatGPT account." } }),
  codex_error_info: 'other',
});
const geminiRefusal = new RequestError(-32603, 'Internal error', { details: 'Cannot enable privileged approval modes in an untrusted folder.' });

describe("an agent's error in its own words", () => {
  it('reads the reason out of data, never a bare "Internal error"', () => {
    expect(agentErrorMessage(codexRefusal)).toBe("The 'some-model' model is not supported when using Codex with a ChatGPT account.");
    expect(agentErrorMessage(geminiRefusal)).toBe('Cannot enable privileged approval modes in an untrusted folder.');
    expect(agentErrorMessage(new RequestError(-32602, 'Invalid params'))).toBe('Invalid params');
    expect(agentErrorMessage(new Error('plain'))).toBe('plain');
    expect(agentErrorMessage('text')).toBe('text');
  });

  it('logs the code, message and data', () => {
    expect(describeAgentError(geminiRefusal)).toBe('code -32603 "Internal error" data {"details":"Cannot enable privileged approval modes in an untrusted folder."}');
    expect(describeAgentError(new Error('x'))).toBe('"x"');
  });

  it('finds the model an account cannot use', () => {
    expect(modelProblem(agentErrorMessage(codexRefusal))).toEqual({ model: 'some-model', outdated: false });
    expect(modelProblem("The 'new-model' model requires a newer version of Codex. Please upgrade.")).toEqual({ model: 'new-model', outdated: true });
    expect(modelProblem('All good.')).toBeUndefined();
  });
});

describe('model pickers list only what the account can use', () => {
  const configModel = (values: string[], current = values[0]) => ({ id: 'model', name: 'Model', category: 'model', type: 'select' as const, currentValue: current, options: values.map((value) => ({ value, name: value })) });

  it("leaves out models missing from the agent's own available list, effort suffixes aside", () => {
    // codex-acp 2: the config option still has the configured model; `models` lists what the account may use.
    const setup = { configOptions: [configModel(['old-mini', 'luna', 'terra'])], models: { currentModelId: 'old-mini[medium]', availableModels: [{ modelId: 'luna[low]', name: 'Luna' }, { modelId: 'terra[high]', name: 'Terra' }] } };
    const options = sessionOptions(setup);
    const hidden = hiddenModels(setup, options);
    expect(hidden).toEqual(['old-mini']);
    expect(withoutModels(options, hidden).find((o) => o.id === 'model')!.choices.map((c) => c.value)).toEqual(['luna', 'terra']);
  });

  it("respects the agent's records: hidden ones go, and only listed ones stay when it lists any", () => {
    const setup = { configOptions: [configModel(['luna', 'reserve', 'stale'])] };
    expect(hiddenModels(setup, sessionOptions(setup), { listed: ['luna'], hidden: ['reserve'] }).sort()).toEqual(['reserve', 'stale']);
  });

  it('keeps an old adapter whose models the records do not know, and never hides every model', () => {
    const setup = { configOptions: [configModel(['a', 'b'])] };
    expect(hiddenModels(setup, sessionOptions(setup), { listed: ['x'], hidden: [] })).toEqual([]);
    expect(hiddenModels(setup, sessionOptions(setup), { listed: [], hidden: ['a', 'b'] })).toEqual([]);
  });

  it('keeps them out when the agent sends its options again', () => {
    const s: ChatSession = { options: [], commands: [], live: true, hiddenModels: ['old-mini'] };
    const next = applySessionUpdate(s, { sessionUpdate: 'config_option_update', configOptions: [configModel(['old-mini', 'luna'], 'luna')] });
    expect(next.options[0].choices.map((c) => c.value)).toEqual(['luna']);
  });

  it("reads Codex's model cache without writing it", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'fl-codex-'));
    expect(await codexModelVisibility(home)).toBeUndefined();
    await writeFile(path.join(home, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'luna', visibility: 'list' }, { slug: 'reserve', visibility: 'hide' }, { slug: 7 }] }));
    expect(await codexModelVisibility(home)).toEqual({ listed: ['luna'], hidden: ['reserve'] });
  });
});

const notices = (chat: ChatView | undefined) => (chat?.items ?? []).filter((i): i is Extract<Item, { kind: 'notice' }> => i.kind === 'notice');

describe('mode changes the agent refuses', () => {
  let before: string | undefined;
  beforeEach(() => {
    before = process.env.FAKE_AGENT_REFUSE_MODES;
    process.env.FAKE_AGENT_REFUSE_MODES = 'acceptEdits,bypassPermissions';
  });
  afterEach(() => {
    if (before === undefined) delete process.env.FAKE_AGENT_REFUSE_MODES;
    else process.env.FAKE_AGENT_REFUSE_MODES = before;
  });

  it("are logged, but a mode FriedLiver sets itself (a consulted chat in Auto) shows no error, and the chat's level holds", async () => {
    const log: string[] = [];
    const core = makeCore(await gitRepo(), { log: (l) => log.push(l) });
    const a = await core.createChat('demo');
    await core.send(a.id, 'hi');
    // A consultation in Auto: FriedLiver puts its agent in Full access when the session starts.
    const c = await core.createChat('demo', { approval: 'full', origin: { kind: 'consult', chatId: a.id, by: 'agent' } });
    await core.send(c.id, 'hello');
    expect(lastReply(core.chat(c.id)!)).toBe('You said: hello');
    expect(notices(core.chat(c.id))).toEqual([]);
    expect(core.chat(c.id)!.approval).toBe('full');
    expect(log.join('\n')).toContain('session/set_config_option failed: code -32603 "Internal error" data {"details":"Cannot enable privileged approval modes in an untrusted folder."}');
    expect(log.join('\n')).toMatch(/refused Mode = bypassPermissions .*set by FriedLiver.*untrusted folder/);
  });

  it("a level the user picks: shows the agent's reason and goes back to the old level", async () => {
    const core = makeCore(await gitRepo(), { ui: { showReview: () => {}, closeReview: () => {}, confirmFullAuto: async () => true } });
    const a = await core.createChat('demo');
    await core.send(a.id, 'hi');
    await core.setApproval(a.id, 'edits');
    expect(core.chat(a.id)!.approval ?? 'ask').toBe('ask');
    const [n] = notices(core.chat(a.id));
    expect(n).toMatchObject({ tone: 'error' });
    expect(n.text).toContain("didn't change Mode to Accept edits: Cannot enable privileged approval modes in an untrusted folder.");
    expect(n.text).not.toContain('Internal error');

    // The mode picker: same, and the mode stays as it was.
    await core.setOption(a.id, 'mode', 'bypassPermissions');
    expect(core.chat(a.id)!.approval ?? 'ask').toBe('ask');
    expect(core.chat(a.id)!.session!.options.find((o) => o.id === 'mode')!.current).toBe('default');
    expect(notices(core.chat(a.id))).toHaveLength(2);

    // One it takes still works.
    await core.setOption(a.id, 'mode', 'plan');
    expect(core.chat(a.id)!.session!.options.find((o) => o.id === 'mode')!.current).toBe('plan');
    expect(notices(core.chat(a.id))).toHaveLength(2);
  });
});

describe('a model the account cannot use', () => {
  it('names the model and offers the ones the agent lists, when the turn fails (codex-acp 0.16)', async () => {
    const core = makeCore(await gitRepo());
    const a = await core.createChat('demo');
    await core.send(a.id, 'refuse-model');
    const n = notices(core.chat(a.id)).at(-1)!;
    expect(n.text).toBe("Demo can't use the model demo-smart with this account.");
    expect(n.detail).toContain('not supported when using Codex with a ChatGPT account');
    expect(n.actions).toEqual([{ label: 'Use Small', do: 'setOption', optionId: 'model', value: 'demo-small' }]);
    // The webview may send the action back.
    expect(parseWebviewMessage({ type: 'notice', chatId: a.id, action: n.actions![0] })).toMatchObject({ action: { do: 'setOption', optionId: 'model', value: 'demo-small' } });
    await core.setOption(a.id, 'model', 'demo-small');
    expect(core.chat(a.id)!.session!.options.find((o) => o.id === 'model')!.current).toBe('demo-small');
  });

  it('tells the chat that asked why the consulted one could not answer', async () => {
    const core = makeCore(await gitRepo());
    const a = await core.createChat('demo');
    await expect(core.consult(a.id, 'codex', 'refuse-model')).rejects.toThrow("couldn't answer. Codex can't use the model demo-smart with this account.");
    expect(notices(core.chat(a.id)).at(-1)).toMatchObject({ tone: 'error', text: expect.stringContaining("couldn't answer. Codex can't use the model demo-smart") });
  });

  it('also when the agent says it as its reply (codex-acp 2)', async () => {
    const core = makeCore(await gitRepo());
    const a = await core.createChat('demo');
    await core.send(a.id, 'say-refuse-model');
    expect(notices(core.chat(a.id)).at(-1)).toMatchObject({ tone: 'error', text: expect.stringContaining("can't use the model demo-smart") });
    // A later turn that answers normally adds nothing.
    await core.send(a.id, 'hello');
    expect(notices(core.chat(a.id))).toHaveLength(1);
  });
});

describe('agent-to-agent reuses the linked chat', () => {
  it('hands off to the same chat again, with where the task is now; New chat starts over', async () => {
    const core = makeCore(await gitRepo());
    const a = await core.createChat('demo');
    await core.send(a.id, 'first');
    const b = await core.handoff(a.id, 'claude');
    await core.send(b.id, 'go');
    await core.send(a.id, 'second');

    const again = await core.handoff(a.id, 'claude');
    expect(again.id).toBe(b.id);
    expect(core.snapshot.chats).toHaveLength(2);
    await core.send(b.id, 'continue');
    const said = lastReply(core.chat(b.id)!);
    expect(said).toContain('The task is back with you from Demo');
    expect(said).toContain('User: second');

    const fresh = await core.handoff(a.id, 'claude', true);
    expect(fresh.id).not.toBe(b.id);
    // The newest one is where the next hand-off goes.
    expect((await core.handoff(a.id, 'claude')).id).toBe(fresh.id);
  });

  it('asks in a new chat only when asked to, and the next question goes to the newest', async () => {
    const core = makeCore(await gitRepo());
    const a = await core.createChat('demo');
    await core.consult(a.id, 'gemini', 'one?');
    const first = core.snapshot.chats.find((c) => c.origin?.kind === 'consult')!;
    await core.consult(a.id, 'gemini', 'two?', 'user', [], true);
    const consults = core.snapshot.chats.filter((c) => c.origin?.kind === 'consult');
    expect(consults).toHaveLength(2);
    const second = consults.find((c) => c.id !== first.id)!;
    await core.consult(a.id, 'gemini', 'three?');
    expect(core.chat(second.id)!.turns).toBe(2);
    expect(core.chat(first.id)!.turns).toBe(1);
  });

  it('keeps the link across a reload, so the same chat is reused', async () => {
    const dir = await gitRepo();
    const first = makeCore(dir);
    const a = await first.createChat('demo');
    await first.consult(a.id, 'gemini', 'one?');
    const c = first.snapshot.chats.find((x) => x.origin?.kind === 'consult')!;
    const saved = JSON.parse(JSON.stringify(first.exportState()));
    await first.dispose();

    const second = makeCore(dir);
    second.restore(parseSaved(saved)!);
    await second.consult(a.id, 'gemini', 'two?');
    expect(second.snapshot.chats).toHaveLength(2);
    await waitFor(() => second.chat(c.id)!.turns === 2);
  });

  it('parses the webview asking for a fresh chat, and nothing else as fresh', () => {
    expect(parseWebviewMessage({ type: 'handoff', chatId: 'c1', agent: 'claude', fresh: true })).toEqual({ type: 'handoff', chatId: 'c1', agent: 'claude', fresh: true });
    expect(parseWebviewMessage({ type: 'handoff', chatId: 'c1', agent: 'claude', fresh: 'yes' })).toEqual({ type: 'handoff', chatId: 'c1', agent: 'claude' });
    expect(parseWebviewMessage({ type: 'consult', chatId: 'c1', agent: 'gemini', text: 'q', fresh: true })).toMatchObject({ fresh: true });
  });
});
