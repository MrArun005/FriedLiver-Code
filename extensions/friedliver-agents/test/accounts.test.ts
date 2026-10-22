import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { authStatusOf, signInMethods } from '@friedliver/main/agents/signIn';
import type * as acp from '@agentclientprotocol/sdk';
import { installedOrUnknown, preselectAgents, type AgentRoster } from '../src/shared/accounts';
import { agentMissing } from '../src/shared/view';
import type { Item } from '../src/shared/model';
import {
  CLI_ACCOUNTS,
  KEY_SETUPS,
  acpMethodFor,
  activeMethod,
  keySetup,
  mergeOffered,
  modelChoices,
  noteAccount,
  parseAccountsMessage,
  rosterOf,
  setupComplete,
  setupEnv,
  shownAgents,
  signInMethodsFor,
  validDefault,
  validKeyValue,
  type AccountRecord,
  type AccountsMessage,
  type KeyView,
} from '../src/shared/accounts';
import { parseWebviewMessage } from '../src/shared/messages';
import type { AgentKey } from '../src/shared/model';
import type { AgentDefaults, SessionOption } from '../src/shared/session';
import { mentionOptions } from '../src/shared/view';
import { cliLineFor } from '../src/host/signin';
import { disposeCores, makeCore, waitFor } from './helpers';

// The auth methods each adapter's `initialize` answers with, as their published packages build them.
const GEMINI = [
  { id: 'oauth-personal', name: 'Log in with Google', description: 'Log in with your Google account' },
  { id: 'gemini-api-key', name: 'Gemini API key', description: 'Use an API key with Gemini Developer API', _meta: { 'api-key': { provider: 'google' } } },
  { id: 'vertex-ai', name: 'Vertex AI', description: 'Use an API key with Vertex AI GenAI API' },
  { id: 'gateway', name: 'AI API Gateway', description: 'Use a custom AI API Gateway' },
] as acp.AuthMethod[];
const CODEX = [
  { id: 'api-key', name: 'API Key', description: 'Use an API key to authenticate' },
  { id: 'chat-gpt', name: 'ChatGPT', description: 'Use ChatGPT to authenticate' },
] as acp.AuthMethod[];
const CLAUDE = [
  { id: 'claude-ai-login', name: 'Claude Subscription', description: 'Use Claude subscription ', type: 'terminal', args: ['--cli', 'auth', 'login', '--claudeai'] },
  { id: 'console-login', name: 'Anthropic Console', description: 'Use Anthropic Console (API usage billing)', type: 'terminal', args: ['--cli', 'auth', 'login', '--console'] },
] as acp.AuthMethod[];

const record = (r: Partial<AccountRecord>): AccountRecord => ({ status: 'needs-sign-in', at: 1, ...r });

describe('sign-in status', () => {
  it('maps what the agent reports about its identity to a status', () => {
    expect(noteAccount(undefined, { identity: { kind: 'account', label: 'Claude Max', email: 'me@example.com' } }).status).toBe('signed-in');
    expect(noteAccount(record({ status: 'signed-in' }), { identity: { kind: 'none', label: 'Not logged in' } }).status).toBe('needs-sign-in');
    expect(noteAccount(undefined, { identity: { kind: 'api_key', label: 'OpenAI API key' } }).status).toBe('signed-in');
  });

  it("drops an identity a newer check contradicts, and keeps one it doesn't", () => {
    const account = record({ status: 'signed-in', identity: { kind: 'account', label: 'ChatGPT Plus', email: 'me@example.com' } });
    expect(noteAccount(account, { status: 'needs-sign-in' }).identity).toBeUndefined();
    expect(noteAccount(account, { status: 'signed-in' }).identity?.email).toBe('me@example.com');
    const none = record({ identity: { kind: 'none', label: 'Not logged in' } });
    expect(noteAccount(none, { status: 'signed-in' }).identity).toBeUndefined();
  });

  it('forgets methods and versions once the agent is gone, and a stale update hint', () => {
    const r = noteAccount(record({ status: 'signed-in', version: '0.1.0', update: 'Update it', methods: signInMethods(CODEX) }), { status: 'not-installed', message: 'not found' });
    expect(r).toMatchObject({ status: 'not-installed', message: 'not found' });
    expect(r.methods).toBeUndefined();
    expect(r.version).toBeUndefined();
    const updated = noteAccount(record({ status: 'signed-in', version: '0.1.0', update: 'Update it' }), { status: 'signed-in', version: '0.99.0' });
    expect(updated.update).toBeUndefined();
    expect(noteAccount(record({ status: 'error', message: 'boom' }), { status: 'signed-in' }).message).toBeUndefined();
  });

  it('reads an agent’s _auth/status_update, checked and cut short', () => {
    expect(authStatusOf({ authStatus: { kind: 'account', label: 'Claude Max', account: { email: 'me@example.com', plan: 'max', organization: 'Acme' } } })).toEqual({
      kind: 'account',
      label: 'Claude Max',
      email: 'me@example.com',
      plan: 'max',
      organization: 'Acme',
    });
    expect(authStatusOf({ authStatus: { kind: 'api_key', label: 'Anthropic API key', detail: 'ANTHROPIC_API_KEY' } })).toEqual({ kind: 'api_key', label: 'Anthropic API key', detail: 'ANTHROPIC_API_KEY' });
    expect(authStatusOf({ authStatus: { kind: 'root', label: 'x' } })).toBeUndefined();
    expect(authStatusOf({ authStatus: 'account' })).toBeUndefined();
    expect(authStatusOf(null)).toBeUndefined();
    const odd = authStatusOf({ authStatus: { kind: 'account', label: 'x'.repeat(500), account: { email: 'a\nb@example.com' } } });
    expect(odd?.label).toHaveLength(80);
    expect(odd?.email).toBeUndefined();
  });

  it('says which way of signing in is in use', () => {
    const keys = (active: boolean): KeyView[] => [{ id: 'apiKey', name: 'Gemini API key', description: '', fields: [], active }];
    expect(activeMethod({ agent: 'claude', keys: [], record: record({ status: 'signed-in', identity: { kind: 'account', label: 'Claude Max', email: 'me@example.com' } }) })).toBe('Claude Max · me@example.com');
    expect(activeMethod({ agent: 'gemini', keys: keys(true), record: record({ status: 'signed-in' }) })).toBe('Gemini API key, saved in FriedLiver');
    expect(activeMethod({ agent: 'gemini', keys: keys(false), envKey: 'GEMINI_API_KEY' })).toBe('GEMINI_API_KEY from the editor’s environment');
    expect(activeMethod({ agent: 'gemini', keys: keys(false), record: record({ status: 'signed-in', via: 'Log in with Google' }) })).toBe('Signed in with Log in with Google');
    expect(activeMethod({ agent: 'codex', keys: [], record: record({ status: 'signed-in' }) })).toContain('Codex’s own login');
    expect(activeMethod({ agent: 'codex', keys: [], record: record({ status: 'needs-sign-in' }) })).toBeUndefined();
  });
});

describe('sign-in methods per agent', () => {
  it('Gemini: Google in the browser; Gemini API key and Vertex AI as key setups with its own ACP methods; no gateway', () => {
    const offered = signInMethods(GEMINI);
    expect(signInMethodsFor(offered).map((m) => [m.id, m.kind])).toEqual([['oauth-personal', 'browser']]);
    expect(KEY_SETUPS.gemini.map((s) => s.id)).toEqual(['apiKey', 'vertex']);
    expect(acpMethodFor(keySetup('gemini', 'apiKey')!, offered)).toBe('gemini-api-key');
    expect(acpMethodFor(keySetup('gemini', 'vertex')!, offered)).toBe('vertex-ai');
    expect(KEY_SETUPS.gemini[0].fields.map((f) => f.env)).toEqual(['GEMINI_API_KEY']);
  });

  it('Codex: ChatGPT in the browser, and an OpenAI key through its api-key method', () => {
    const offered = signInMethods(CODEX);
    expect(signInMethodsFor(offered).map((m) => m.id)).toEqual(['chat-gpt']);
    expect(acpMethodFor(keySetup('codex', 'apiKey')!, offered)).toBe('api-key');
    expect(KEY_SETUPS.codex[0].fields[0].env).toBe('OPENAI_API_KEY');
  });

  it("Claude: its two terminal logins, and a key it reads itself (no ACP method for it)", () => {
    const offered = signInMethods(CLAUDE);
    expect(signInMethodsFor(offered).map((m) => [m.id, m.kind])).toEqual([
      ['claude-ai-login', 'terminal'],
      ['console-login', 'terminal'],
    ]);
    expect(acpMethodFor(keySetup('claude', 'apiKey')!, offered)).toBeUndefined();
    expect(keySetup('claude', 'vertex')).toBeUndefined();
    expect(keySetup('demo', 'apiKey')).toBeUndefined();
  });

  it('offers nothing before a check', () => {
    expect(signInMethodsFor(undefined)).toEqual([]);
  });

  it("each vendor's own CLI lines are plain enough to type into a terminal", () => {
    for (const cli of Object.values(CLI_ACCOUNTS)) {
      if (cli.signIn) expect(cliLineFor(cli.signIn.command)).toBe(cli.signIn.command);
      expect(cliLineFor(cli.signOut.command)).toBe(cli.signOut.command);
    }
    expect(CLI_ACCOUNTS.gemini.signIn).toBeUndefined(); // Google login is Antigravity's
    expect(cliLineFor('codex logout; rm -rf ~')).toBeNull();
    expect(cliLineFor('codex logout\n')).toBeNull();
  });
});

describe('keys and Vertex AI', () => {
  const vertex = keySetup('gemini', 'vertex')!;

  it('takes a project and location, or an express-mode key, and turns Vertex AI on', () => {
    expect(setupComplete(vertex, { GOOGLE_CLOUD_PROJECT: 'p' })).toBe(false);
    expect(setupEnv(vertex, { GOOGLE_CLOUD_PROJECT: 'p' })).toEqual({});
    expect(setupEnv(vertex, { GOOGLE_CLOUD_PROJECT: 'my-project', GOOGLE_CLOUD_LOCATION: 'us-central1' })).toEqual({
      GOOGLE_CLOUD_PROJECT: 'my-project',
      GOOGLE_CLOUD_LOCATION: 'us-central1',
      GOOGLE_GENAI_USE_VERTEXAI: 'true',
    });
    expect(setupEnv(vertex, { GOOGLE_API_KEY: 'k' })).toEqual({ GOOGLE_API_KEY: 'k', GOOGLE_GENAI_USE_VERTEXAI: 'true' });
  });

  it('keeps one-line values, and plain words for what is shown again', () => {
    const [project, , key] = vertex.fields;
    expect(validKeyValue(key, 'AIza-secret_value')).toBeUndefined();
    expect(validKeyValue(key, 'a\nb')).toBeDefined();
    expect(validKeyValue(key, 'a\u0007b')).toBeDefined();
    expect(validKeyValue(project, 'my-project')).toBeUndefined();
    expect(validKeyValue(project, '<img src=x>')).toBeDefined();
    expect(validKeyValue(project, '')).toBeUndefined();
  });
});

describe('models per agent', () => {
  const model = (choices: string[], current = choices[0]): SessionOption => ({
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    current,
    choices: choices.map((value) => ({ value, name: value })),
    via: 'option',
  });
  const effort: SessionOption = { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', current: 'medium', choices: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }], via: 'option' };
  const mode: SessionOption = { id: 'mode', name: 'Mode', category: 'mode', type: 'select', current: 'default', choices: [{ value: 'default', name: 'Ask' }], via: 'mode' };
  const fast: SessionOption = { id: 'fast', name: 'Fast', category: 'model_config', type: 'boolean', current: false, choices: [], via: 'option' };

  it('caches what a session offered: fresh options replace their category, others stay, modes never', () => {
    const prev: AgentDefaults = { options: [model(['a', 'b']), effort, fast], chosen: { model: 'b' }, approval: 'edits' };
    const next = mergeOffered(prev, [mode, model(['b', 'c'])]);
    expect(next.options.map((o) => o.category)).toEqual(['thought_level', 'model_config', 'model']);
    expect(modelChoices(next).model?.choices.map((c) => c.value)).toEqual(['b', 'c']);
    expect(next.chosen).toEqual({ model: 'b' });
    expect(next.approval).toBe('edits');
    expect(mergeOffered(undefined, [model(['x'])])).toEqual({ options: [model(['x'])], chosen: {} });
  });

  it('sets a default only to a value the agent offered', () => {
    const d: AgentDefaults = { options: [model(['a', 'b']), effort], chosen: {} };
    expect(validDefault(d, 'model', 'b')).toBe(true);
    expect(validDefault(d, 'model', 'z')).toBe(false);
    expect(validDefault(d, 'thought_level', 'low')).toBe(true);
    expect(validDefault(d, 'thought_level', 'max')).toBe(false);
    expect(validDefault(undefined, 'model', 'a')).toBe(false);
    expect(modelChoices(d)).toMatchObject({ model: { id: 'model' }, effort: { id: 'effort' }, chosen: {} });
  });
});

describe('Demo visibility', () => {
  it('hides Demo from pickers unless turned on', () => {
    expect(shownAgents(false)).toEqual(['claude', 'codex', 'gemini', 'antigravity', 'copilot', 'opencode']);
    expect(shownAgents(true)).toEqual(['claude', 'codex', 'gemini', 'antigravity', 'copilot', 'opencode', 'demo']);
  });

  it('gives pickers the shown agents and their last known sign-in', () => {
    const records: Partial<Record<AgentKey, AccountRecord>> = { gemini: record({ status: 'needs-sign-in' }), demo: record({ status: 'signed-in' }) };
    expect(rosterOf(false, records)).toEqual({ agents: ['claude', 'codex', 'gemini', 'antigravity', 'copilot', 'opencode'], signIn: { gemini: 'needs-sign-in' } });
    expect(rosterOf(true, records).signIn).toEqual({ gemini: 'needs-sign-in', demo: 'signed-in' });
  });

  it('leaves Demo out of the @ picker when hidden', () => {
    expect(mentionOptions('d', shownAgents(false))).toEqual([]);
    expect(mentionOptions('d', shownAgents(true)).map((o) => o.agent)).toEqual(['demo']);
    expect(mentionOptions('').map((o) => o.agent)).toContain('demo');
  });
});

describe('messages from the Agents & Accounts page', () => {
  const shown = shownAgents(false);
  const ok = (raw: unknown, as: AccountsMessage | null = raw as AccountsMessage) => expect(parseAccountsMessage(raw, shown)).toEqual(as);

  it('takes well-formed messages about a shown agent', () => {
    ok({ type: 'ready' });
    ok({ type: 'check', agent: 'gemini' });
    ok({ type: 'signIn', agent: 'gemini', methodId: 'oauth-personal' });
    ok({ type: 'setKey', agent: 'gemini', setup: 'vertex' });
    ok({ type: 'clearKey', agent: 'codex' });
    ok({ type: 'signOut', agent: 'claude' });
    ok({ type: 'terminal', agent: 'codex', what: 'signOut' });
    ok({ type: 'copy', agent: 'claude', what: 'install' });
    ok({ type: 'setDefault', agent: 'claude', key: 'thought_level', value: 'high' });
    // Extra fields are dropped, never passed on.
    ok({ type: 'check', agent: 'codex', command: 'rm -rf /' }, { type: 'check', agent: 'codex' });
    // Where links open: one of the two values only.
    ok({ type: 'setLinks', mode: 'external' });
    ok({ type: 'setLinks', mode: 'builtin' });
    ok({ type: 'setLinks', mode: 'firefox' }, null);
  });

  it('refuses agents outside the fixed list, and Demo while hidden', () => {
    ok({ type: 'check', agent: 'evil' }, null);
    ok({ type: 'check', agent: 'demo' }, null);
    expect(parseAccountsMessage({ type: 'check', agent: 'demo' }, shownAgents(true))).toEqual({ type: 'check', agent: 'demo' });
    ok({ type: 'check' }, null);
  });

  it('refuses odd method ids, setups, lines and defaults', () => {
    ok({ type: 'signIn', agent: 'gemini', methodId: '../../x y' }, null);
    ok({ type: 'signIn', agent: 'gemini', methodId: 'x'.repeat(200) }, null);
    ok({ type: 'signIn', agent: 'gemini' }, null);
    ok({ type: 'setKey', agent: 'claude', setup: 'vertex' }, null);
    ok({ type: 'setKey', agent: 'gemini', setup: 'apiKey', value: 'sk-secret' }, { type: 'setKey', agent: 'gemini', setup: 'apiKey' });
    ok({ type: 'terminal', agent: 'codex', what: 'codex logout && curl x' }, null);
    ok({ type: 'terminal', agent: 'codex', command: 'codex logout' }, null);
    ok({ type: 'setDefault', agent: 'claude', key: 'mode', value: 'bypassPermissions' }, null);
    ok({ type: 'setDefault', agent: 'claude', key: 'model', value: '' }, null);
    ok({ type: 'nope', agent: 'claude' }, null);
    ok('check', null);
    ok(null, null);
  });

  it("only lets the chat open the page or a notice's sign-in card for a real agent", () => {
    expect(parseWebviewMessage({ type: 'openAccounts' })).toEqual({ type: 'openAccounts' });
    expect(parseWebviewMessage({ type: 'openAccounts', agent: 'gemini' })).toEqual({ type: 'openAccounts', agent: 'gemini' });
    expect(parseWebviewMessage({ type: 'openAccounts', agent: 'x' })).toBeNull();
    expect(parseWebviewMessage({ type: 'notice', chatId: 'c1', action: { label: 'Sign in to Gemini', do: 'accounts', agent: 'gemini' } })).toEqual({
      type: 'notice',
      chatId: 'c1',
      action: { label: 'Sign in to Gemini', do: 'accounts', agent: 'gemini' },
    });
    expect(parseWebviewMessage({ type: 'notice', chatId: 'c1', action: { label: 'x', do: 'accounts', agent: 'x' } })).toBeNull();
  });
});

describe('the core with an agent that needs sign-in (the Demo agent standing in)', () => {
  afterEach(disposeCores);

  it('checks, signs in through ACP, learns the account, caches models, and signs out', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fl-acct-'));
    const seen: { agent: AgentKey; patch: Partial<AccountRecord> }[] = [];
    const store = new Map<AgentKey, AgentDefaults>();
    const core = makeCore(dir, {
      // The extra environment a saved setup gives: here, it makes the stand-in ask for a sign-in.
      credentialEnv: (id): Record<string, string> => (id === 'gemini' ? { FAKE_AGENT_AUTH: '1' } : {}),
      accountSeen: (agent, patch) => seen.push({ agent, patch }),
      defaults: { get: (a) => store.get(a), set: (a, v) => store.set(a, v) },
    });
    expect(core.spec('gemini').env).toMatchObject({ FAKE_AGENT_AUTH: '1' });

    const before = await core.checkAccount('gemini');
    expect(before).toMatchObject({ status: 'needs-sign-in', logout: true, version: '0.0.0' });
    expect(before.methods.map((m) => m.id)).toEqual(['fake-login']);
    expect(store.get('gemini')).toBeUndefined();

    await core.signInWithBrowser('gemini', 'fake-login', new Promise(() => {}));
    await waitFor(() => seen.some((s) => s.patch.identity?.email === 'you@example.com'));
    expect(seen.find((s) => s.patch.identity)?.agent).toBe('gemini');

    const after = await core.checkAccount('gemini');
    expect(after.status).toBe('signed-in');
    expect(after.methods.map((m) => m.id)).toEqual(['fake-login']);
    const models = modelChoices(store.get('gemini'));
    expect(models.model?.choices.map((c) => c.value)).toEqual(['demo-smart', 'demo-small']);
    expect(models.effort?.current).toBe('medium');
    expect(store.get('gemini')?.options.some((o) => o.category === 'mode')).toBe(false);

    expect(core.setDefaultChoice('gemini', 'model', 'demo-small')).toBe(true);
    expect(core.setDefaultChoice('gemini', 'model', 'not-offered')).toBe(false);
    expect(core.setDefaultChoice('gemini', 'mode', 'bypassPermissions')).toBe(false);
    expect(store.get('gemini')?.chosen).toEqual({ model: 'demo-small' });

    await core.signOut('gemini');
    expect((await core.checkAccount('gemini')).status).toBe('needs-sign-in');
  });

  it('a chat that needs a sign-in offers "Sign in to Gemini" and records it', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fl-acct-'));
    const seen: Partial<AccountRecord>[] = [];
    const core = makeCore(dir, {
      credentialEnv: (id): Record<string, string> => (id === 'gemini' ? { FAKE_AGENT_AUTH: '1' } : {}),
      accountSeen: (agent, patch) => agent === 'gemini' && seen.push(patch),
    });
    const chat = await core.createChat('gemini');
    await core.send(chat.id, 'hello', []).catch(() => {});
    await waitFor(() => core.chat(chat.id)!.items.some((i) => i.kind === 'notice' && i.tone === 'error'));
    const notice = core.chat(chat.id)!.items.find((i) => i.kind === 'notice' && i.tone === 'error');
    expect(notice?.kind === 'notice' && notice.actions?.[0]).toEqual({ label: 'Sign in to Gemini', do: 'accounts', agent: 'gemini' });
    expect(seen.some((p) => p.status === 'needs-sign-in' && p.methods?.[0]?.id === 'fake-login')).toBe(true);
  });

  it('a session that starts says the agent is signed in', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fl-acct-'));
    const seen: { agent: AgentKey; patch: Partial<AccountRecord> }[] = [];
    const core = makeCore(dir, { accountSeen: (agent, patch) => seen.push({ agent, patch }) });
    const chat = await core.createChat('codex');
    await core.send(chat.id, 'hello', []);
    await waitFor(() => seen.some((s) => s.agent === 'codex' && s.patch.status === 'signed-in'));
  });
});

describe('Mac & Windows control on the page', () => {
  it('takes only known settings with a boolean, for any shown agents', () => {
    expect(parseAccountsMessage({ type: 'setSystem', key: 'enabled', value: false }, [])).toEqual({ type: 'setSystem', key: 'enabled', value: false });
    expect(parseAccountsMessage({ type: 'setSystem', key: 'system_clipboard_read', value: true }, [])).toEqual({ type: 'setSystem', key: 'system_clipboard_read', value: true });
    expect(parseAccountsMessage({ type: 'systemLog' }, [])).toEqual({ type: 'systemLog' });
    for (const bad of [
      { type: 'setSystem', key: 'enabled', value: 'true' },
      { type: 'setSystem', key: 'externalAutoApprove', value: true },
      { type: 'setSystem', key: '__proto__', value: true },
      { type: 'setSystem', value: true },
    ]) {
      expect(parseAccountsMessage(bad, [])).toBeNull();
    }
  });
});

describe('preselected agents for a new task', () => {
  const roster = (signIn: AgentRoster['signIn'], agents: AgentKey[] = ['claude', 'codex', 'gemini', 'demo']): AgentRoster => ({ agents, signIn });

  it('leaves out an agent the Accounts page found not installed', () => {
    expect(preselectAgents(roster({ claude: 'not-installed', codex: 'signed-in' }), ['claude'])).toEqual(['codex']);
    expect(preselectAgents(roster({ claude: 'not-installed', codex: 'signed-in' }), ['claude', 'gemini'])).toEqual(['gemini']);
    expect(preselectAgents(roster({ claude: 'not-installed', codex: 'not-installed', gemini: 'not-installed' }), ['claude'])).toEqual(['demo']);
    // Never checked: it may be there, so a saved choice stays.
    expect(preselectAgents(roster({}), ['claude'])).toEqual(['claude']);
    expect(preselectAgents(roster({ claude: 'needs-sign-in' }), ['claude'])).toEqual(['claude']);
    // Demo hidden: nothing else installed falls back to the first agent shown.
    expect(preselectAgents(roster({ claude: 'not-installed', codex: 'signed-in' }, ['claude', 'codex', 'gemini']), [])).toEqual(['codex']);
    expect(installedOrUnknown(roster({ gemini: 'not-installed' }), 'gemini')).toBe(false);
  });

  it('says a chat’s agent is not installed instead of starting', () => {
    const notice: Item = { kind: 'notice', tone: 'error', text: "Claude isn't installed", actions: [{ label: 'Install in terminal', do: 'install', agent: 'claude' }] };
    expect(agentMissing({ agent: 'claude', items: [], session: undefined }, 'not-installed')).toBe(true);
    expect(agentMissing({ agent: 'claude', items: [notice], session: undefined })).toBe(true);
    expect(agentMissing({ agent: 'claude', items: [notice, { kind: 'agent', text: 'hi' }], session: undefined })).toBe(false);
    expect(agentMissing({ agent: 'claude', items: [], session: undefined }, 'signed-in')).toBe(false);
    expect(agentMissing({ agent: 'demo', items: [notice], session: undefined }, 'not-installed')).toBe(false);
  });
});
