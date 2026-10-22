import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CustomSecrets, parseCustomAgents, testAgentConnection, withEntry, withoutEntry } from '../src/host/customAgents';
import { parseAccountsMessage, shownAgents } from '../src/shared/accounts';
import { AGENT_EXAMPLE, EMPTY_DRAFT, draftToEntry, entryToDraft, idFromName, joinArgs, looksSecret, parseDraft, splitArgs, validateDraft, type AgentDraft } from '../src/shared/agentForm';
import { parseWebviewMessage } from '../src/shared/messages';
import { setCustomAgents } from '../src/shared/model';
import { GLYPHS, markFor } from '../src/webview/ui/marks';
import { DEMO_AGENT } from './helpers';

const draft = (over: Partial<AgentDraft> = {}): AgentDraft => ({ ...EMPTY_DRAFT, id: 'qwen', name: 'Qwen Code', command: 'qwen', args: '--acp', ...over });

afterEach(() => setCustomAgents([]));

describe('the Add an agent form', () => {
  it('accepts a plain ACP program and says what is wrong with the rest', () => {
    expect(validateDraft(draft(), [])).toEqual({});
    expect(validateDraft(draft({ id: 'Qwen' }), []).id).toMatch(/lower-case/);
    expect(validateDraft(draft({ id: 'claude' }), []).id).toMatch(/built-in/);
    expect(validateDraft(draft({ id: 'gpt' }), []).id).toMatch(/built-in/);
    expect(validateDraft(draft({ id: 'opencode' }), []).id).toMatch(/built-in/);
    expect(validateDraft(draft(), ['qwen']).id).toMatch(/already/);
    for (const bad of ['qwen; rm -rf ~', 'qwen && x', '$(evil)', '`x`', 'a|b', '-rf', '"qwen"', '']) expect(validateDraft(draft({ command: bad }), []).command, bad).toBeDefined();
    for (const ok of ['qwen', '/opt/homebrew/bin/qwen', 'C:\\Program Files\\Qwen\\qwen.exe', 'qwen-code']) expect(validateDraft(draft({ command: ok }), []).command, ok).toBeUndefined();
    expect(validateDraft(draft({ args: '--acp "unclosed' }), []).args).toBeDefined();
    expect(validateDraft(draft({ env: [{ name: '1BAD', value: 'x', secret: false }] }), []).env).toBeDefined();
    expect(validateDraft(draft({ env: [{ name: 'A', value: 'x', secret: false }, { name: 'A', value: 'y', secret: false }] }), []).env).toMatch(/twice/);
    expect(validateDraft(draft({ env: [{ name: 'A', value: '', secret: false }] }), []).env).toMatch(/no value/);
    expect(validateDraft(draft({ env: [{ name: 'A_KEY', value: '', secret: true, saved: true }] }), []).env).toBeUndefined();
    expect(validateDraft(draft({ install: 'curl -fsSL https://x.dev/install | bash' }), []).install).toBeUndefined();
    expect(validateDraft(draft({ install: 'curl x; rm -rf ~' }), []).install).toBeDefined();
  });

  it('splits arguments like the examples show', () => {
    expect(splitArgs('--acp --effort=high')).toEqual(['--acp', '--effort=high']);
    expect(splitArgs('acp "--dir=/a b"')).toEqual(['acp', '--dir=/a b']);
    expect(splitArgs('"x')).toBeNull();
    expect(joinArgs(['acp', '/a b'])).toBe('acp "/a b"');
    expect(idFromName('Qwen Code 2')).toBe('qwencode2');
  });

  it('keeps what looks like a key out of settings', () => {
    expect(looksSecret('OPENAI_API_KEY', 'x')).toBe(true);
    expect(looksSecret('GH_TOKEN', 'x')).toBe(true);
    expect(looksSecret('FOO', 'sk-proj-abc123')).toBe(true);
    expect(looksSecret('FOO', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7')).toBe(true);
    expect(looksSecret('QWEN_HOME', '/Users/me/.qwen')).toBe(false);
    const { entry, secrets, keep } = draftToEntry(
      draft({ glyph: 'terminal', env: [{ name: 'QWEN_HOME', value: '/q', secret: false }, { name: 'DASHSCOPE_API_KEY', value: 'sk-1', secret: false }, { name: 'OLD_TOKEN', value: '', secret: true, saved: true }] }),
    );
    expect(entry).toEqual({ id: 'qwen', name: 'Qwen Code', command: 'qwen', args: ['--acp'], env: { QWEN_HOME: '/q' }, glyph: 'terminal' });
    expect(JSON.stringify(entry)).not.toContain('sk-1');
    expect(secrets).toEqual({ DASHSCOPE_API_KEY: 'sk-1' });
    expect(keep).toEqual(['OLD_TOKEN']);
    // Back into the form: secret values never leave SecretStorage.
    const [c] = parseCustomAgents([entry]).agents;
    expect(entryToDraft(c, ['DASHSCOPE_API_KEY']).env).toEqual([
      { name: 'QWEN_HOME', value: '/q', secret: false },
      { name: 'DASHSCOPE_API_KEY', value: '', secret: true, saved: true },
    ]);
    expect(c.glyph).toBe('terminal');
  });

  it('writes the user setting in place, keeping entries it can’t read', () => {
    const list = [{ id: 'a', command: 'a' }, 'junk', { id: 'b', command: 'b' }];
    expect(withEntry(list, { id: 'b', command: 'b2' }, 'b')).toEqual([{ id: 'a', command: 'a' }, 'junk', { id: 'b', command: 'b2' }]);
    expect(withEntry(list, { id: 'c', command: 'c' })).toHaveLength(4);
    expect(withEntry(undefined, { id: 'c', command: 'c' })).toEqual([{ id: 'c', command: 'c' }]);
    expect(withoutEntry(list, 'a')).toEqual(['junk', { id: 'b', command: 'b' }]);
  });

  it('keeps secrets per agent in SecretStorage and in memory', async () => {
    const store = new Map<string, string>();
    const fake = { get: async (k: string) => store.get(k), store: async (k: string, v: string) => void store.set(k, v), delete: async (k: string) => void store.delete(k) };
    const s = new CustomSecrets(fake);
    await s.set('qwen', { DASHSCOPE_API_KEY: 'sk-1' });
    expect([...store.keys()]).toEqual(['friedliver.customAgent.qwen.env']);
    const again = new CustomSecrets(fake);
    await again.load(['qwen', 'none']);
    expect(again.env('qwen')).toEqual({ DASHSCOPE_API_KEY: 'sk-1' });
    expect(again.names('none')).toEqual([]);
    await again.remove('qwen');
    expect(store.size).toBe(0);
  });

  it('checks what the page sends before the host acts', () => {
    const shown = shownAgents(false);
    expect(parseAccountsMessage({ type: 'saveAgent', draft: draft() }, shown)).toEqual({ type: 'saveAgent', draft: draft() });
    expect(parseAccountsMessage({ type: 'testAgent', draft: draft(), editing: 'qwen' }, shown)).toMatchObject({ type: 'testAgent', editing: 'qwen' });
    expect(parseAccountsMessage({ type: 'saveAgent', draft: { ...draft(), glyph: 'skull' } }, shown)).toBeNull();
    expect(parseAccountsMessage({ type: 'saveAgent', draft: { ...draft(), env: [{ name: 'A' }] } }, shown)).toBeNull();
    expect(parseAccountsMessage({ type: 'saveAgent', draft: draft(), editing: '../x' }, shown)).toBeNull();
    expect(parseAccountsMessage({ type: 'removeAgent', agent: 'claude' }, shown)).toBeNull();
    expect(parseAccountsMessage({ type: 'removeAgent', agent: 'custom:qwen' }, shown)).toBeNull();
    setCustomAgents([{ key: 'custom:qwen', id: 'qwen', name: 'Qwen' }]);
    expect(parseAccountsMessage({ type: 'removeAgent', agent: 'custom:qwen' }, shown)).toEqual({ type: 'removeAgent', agent: 'custom:qwen' });
    expect(parseDraft(null)).toBeNull();
    expect(parseWebviewMessage({ type: 'addAgent' })).toEqual({ type: 'addAgent' });
  });

  it('wears the mark it was given', () => {
    setCustomAgents([{ key: 'custom:qwen', id: 'qwen', name: 'Qwen', glyph: 'spark' }]);
    expect(markFor('custom:qwen')).toBe(GLYPHS.spark);
    expect(markFor('custom:other')).toBe(GLYPHS.agent);
  });

  it('shows the example the docs show', () => {
    expect(AGENT_EXAMPLE).toEqual({ id: 'qwen', name: 'Qwen Code', command: 'qwen', args: ['--acp'] });
    const docs = readFileSync(path.resolve(__dirname, '../../../docs/ACCOUNTS.md'), 'utf8');
    expect(docs).toContain('"friedliver.agents.custom"');
    expect(docs).toContain('"id": "opencode", "name": "OpenCode", "command": "opencode", "args": ["acp"]');
  });
});

describe('Test connection', () => {
  it('starts the agent once in an empty folder and reports what it offers', async () => {
    const r = await testAgentConnection({ id: 'custom:fake', label: 'Fake', command: process.execPath, args: [DEMO_AGENT], installCommand: '', loginHint: '' }, 'test');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.needsSignIn).toBe(false);
    expect(r.modelCount).toBeGreaterThan(0);
    expect(r.models.length).toBeLessThanOrEqual(12);
  });

  it('says plainly when the program is missing', async () => {
    const r = await testAgentConnection({ id: 'custom:nope', label: 'Nope', command: 'friedliver-no-such-agent', args: [], installCommand: 'npm install -g nope', loginHint: '' }, 'test');
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.error).toMatch(/isn't installed|not found|ENOENT/i);
  });
});

describe('Add an agent and New chat from anywhere: contributions', () => {
  const contributes = JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')).contributes;
  const cmd = (id: string) => contributes.commands.find((c: { command: string }) => c.command === id);

  it('has FriedLiver: Add Agent… in the palette', () => {
    expect(cmd('friedliver.addAgent')).toMatchObject({ title: 'Add Agent…', category: 'FriedLiver' });
    expect(contributes.menus.commandPalette.find((m: { command: string }) => m.command === 'friedliver.addAgent')).toBeUndefined();
    expect(cmd('friedliver.newChat').title).toBe('New Chat with…');
  });

  it('puts New chat and Browser on every editor tab’s title bar, before Split Editor', () => {
    const items = contributes.menus['editor/title'].filter((m: { command: string }) => m.command === 'friedliver.newChatFromTitle' || m.command === 'friedliver.openBrowser');
    expect(items).toEqual([
      { command: 'friedliver.newChatFromTitle', group: 'navigation@90' },
      { command: 'friedliver.openBrowser', when: "activeEditor != 'workbench.editor.browser'", group: 'navigation@91' },
    ]);
    expect(cmd('friedliver.newChatFromTitle')).toMatchObject({ title: 'New Chat', icon: '$(comment)' });
    expect(cmd('friedliver.openBrowser')).toMatchObject({ title: 'Open Browser', icon: '$(globe)' });
    // Icons the FriedLiver product icon theme draws.
    const icons = JSON.parse(readFileSync(path.resolve(__dirname, '../../friedliver-theme/icons/friedliver-icons.json'), 'utf8')).iconDefinitions;
    expect(Object.keys(icons)).toEqual(expect.arrayContaining(['comment', 'globe', 'add']));
  });

  it('opens New chat anywhere with ⌃⌘N / Ctrl+Alt+N, without taking Reject from a review', () => {
    const anywhere = contributes.keybindings.filter((k: { command: string; key: string }) => k.command === 'friedliver.newChat' && k.key === 'ctrl+alt+n');
    expect(anywhere).toEqual([{ command: 'friedliver.newChat', key: 'ctrl+alt+n', mac: 'ctrl+cmd+n', when: '!friedliver.reviewActive || isMac' }]);
    const reject = contributes.keybindings.find((k: { command: string }) => k.command === 'friedliver.review.reject');
    expect(reject).toMatchObject({ key: 'ctrl+alt+n', mac: 'cmd+alt+n', when: 'friedliver.reviewActive' });
    // Cmd/Ctrl+N stays New chat inside chats.
    expect(contributes.keybindings.find((k: { command: string; key: string }) => k.command === 'friedliver.newChat' && k.key === 'ctrl+n')).toBeDefined();
  });
});
