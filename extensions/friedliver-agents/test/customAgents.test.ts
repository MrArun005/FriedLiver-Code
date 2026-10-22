import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_AGENTS } from '@friedliver/main/agents/registry';
import { allowedSignInUrl } from '@friedliver/main/agents/signIn';
import { parseCustomAgents, publicCustomAgents } from '../src/host/customAgents';
import { userSetting } from '../src/host/settings';
import { installCommandFor } from '../src/host/signin';
import { CLI_ACCOUNTS, KEY_SETUPS, parseAccountsMessage, rosterOf, shownAgents } from '../src/shared/accounts';
import { resolveMention } from '../src/shared/discussMentions';
import { agentFace, allAgentKeys, isAgentKey, isStoredAgentKey, parseMention, setCustomAgents } from '../src/shared/model';
import { mentionedAgent, mentionOptions } from '../src/shared/view';
import { markFor, MARKS } from '../src/webview/ui/marks';
import { DEMO_AGENT, disposeCores, gitRepo, makeCore } from './helpers';

const KIMI = { id: 'kimi', name: 'Kimi', command: 'kimi', args: ['acp'], env: { KIMI_HOME: '/tmp/k' }, install: 'uv tool install kimi-cli', signIn: 'Run kimi and type /login.' };

afterEach(async () => {
  setCustomAgents([]);
  await disposeCores();
});

describe('friedliver.agents.custom', () => {
  it('reads well-formed entries and says why the others are left out', () => {
    const { agents, problems } = parseCustomAgents([
      KIMI,
      { id: 'opencode', command: 'opencode', args: ['acp'] },
      { id: 'Bad-Id', command: 'x' },
      { id: 'claude', command: 'x' },
      { id: 'gpt', command: 'x' },
      { id: 'copilot', command: 'x' },
      { id: 'kimi', command: 'again' },
      { id: 'nocmd' },
      { id: 'badargs', command: 'x', args: ['ok', 3] },
      { id: 'badenv', command: 'x', env: { 'NOT OK': 'v' } },
      { id: 'twoline', command: 'x\ny' },
      'not an object',
    ]);
    expect(agents.map((a) => a.key)).toEqual(['custom:kimi', 'custom:opencode']);
    expect(agents[0]).toMatchObject({ name: 'Kimi', command: 'kimi', args: ['acp'], env: { KIMI_HOME: '/tmp/k' }, install: KIMI.install, signIn: KIMI.signIn });
    expect(agents[1].name).toBe('opencode');
    expect(problems).toHaveLength(10);
    expect(problems.filter((p) => p.includes('is taken'))).toHaveLength(4);
    expect(parseCustomAgents(undefined)).toEqual({ agents: [], problems: [] });
    expect(parseCustomAgents({}).problems).toEqual(['friedliver.agents.custom must be a list.']);
  });

  it('is never taken from a workspace', () => {
    const fromRepo = userSetting({ defaultValue: [], workspaceValue: [{ id: 'evil', command: 'curl' }] });
    expect(fromRepo).toEqual({ value: [], ignored: true });
    expect(parseCustomAgents(fromRepo.value).agents).toEqual([]);
  });

  it('gives webviews names and hints only, never the command, args or env', () => {
    const [pub] = publicCustomAgents(parseCustomAgents([KIMI]).agents);
    expect(pub).toEqual({ key: 'custom:kimi', id: 'kimi', name: 'Kimi', install: KIMI.install, signIn: KIMI.signIn });
    setCustomAgents(publicCustomAgents(parseCustomAgents([KIMI]).agents));
    const roster = rosterOf(false, {});
    expect(roster.agents).toContain('custom:kimi');
    expect(JSON.stringify(roster)).not.toMatch(/KIMI_HOME|"command"|"acp"/);
  });

  it('shows up like a built-in agent: pickers, @id, /discuss, faces', () => {
    expect(isAgentKey('custom:kimi')).toBe(false);
    setCustomAgents(publicCustomAgents(parseCustomAgents([KIMI]).agents));
    expect(isAgentKey('custom:kimi')).toBe(true);
    expect(allAgentKeys().at(-1)).toBe('custom:kimi');
    expect(shownAgents(false)).toContain('custom:kimi');
    expect(agentFace('custom:kimi')).toEqual({ letter: 'K', name: 'Kimi' });
    expect(parseMention('@kimi review this')).toEqual({ agent: 'custom:kimi', text: 'review this' });
    expect(mentionedAgent('@kimi')).toBe('custom:kimi');
    expect(mentionOptions('ki').map((o) => o.agent)).toEqual(['custom:kimi']);
    expect(resolveMention('kimi', {})).toEqual({ ok: { agent: 'custom:kimi' } });
    // No logo of its own: the neutral glyph.
    expect(markFor('custom:kimi')).toBe(MARKS.agent);
  });

  it('keeps a removed agent’s saved chats, but nothing may ask for it', () => {
    setCustomAgents([]);
    expect(isAgentKey('custom:kimi')).toBe(false);
    expect(isStoredAgentKey('custom:kimi')).toBe(true);
    expect(isStoredAgentKey('custom:Not-Valid')).toBe(false);
    expect(agentFace('custom:kimi').name).toBe('kimi');
    expect(parseAccountsMessage({ type: 'check', agent: 'custom:kimi' }, shownAgents(false))).toBeNull();
  });

  it('offers only its own install line on Accounts, plain characters only', () => {
    setCustomAgents(publicCustomAgents(parseCustomAgents([KIMI]).agents));
    const shown = shownAgents(false);
    expect(installCommandFor('custom:kimi')).toBe('uv tool install kimi-cli');
    expect(parseAccountsMessage({ type: 'terminal', agent: 'custom:kimi', what: 'install' }, shown)).toEqual({ type: 'terminal', agent: 'custom:kimi', what: 'install' });
    expect(parseAccountsMessage({ type: 'terminal', agent: 'custom:kimi', what: 'signIn' }, shown)).toBeNull();
    expect(parseAccountsMessage({ type: 'setKey', agent: 'custom:kimi', setup: 'apiKey' }, shown)).toBeNull();
    setCustomAgents(publicCustomAgents(parseCustomAgents([{ ...KIMI, install: 'curl x; rm -rf ~' }]).agents));
    expect(installCommandFor('custom:kimi')).toBeNull();
  });

  it('starts the program from the user’s settings and talks ACP to it like any agent', async () => {
    const [fake] = parseCustomAgents([{ id: 'fake', name: 'Fake', command: process.execPath, args: [DEMO_AGENT], env: { FAKE_MARK: '1' } }]).agents;
    setCustomAgents(publicCustomAgents([fake]));
    const core = makeCore(await gitRepo(), { customAgent: (key) => (key === fake.key ? fake : undefined) });
    expect(core.spec(fake.key)).toMatchObject({ id: 'custom:fake', label: 'Fake', command: process.execPath, args: [DEMO_AGENT], env: { FAKE_MARK: '1' } });
    const chat = await core.createChat(fake.key);
    expect(chat.label).toBe('Fake');
    await core.send(chat.id, 'hello');
    expect(core.chat(chat.id)!.items.some((i) => i.kind === 'agent' && i.text.length > 0)).toBe(true);
    setCustomAgents([]);
    expect(() => makeCore('/nowhere').spec('custom:gone')).toThrow(/no longer in friedliver.agents.custom/);
  });
});

describe('GitHub Copilot CLI preset', () => {
  it('runs the official ACP server and installs without sudo', () => {
    expect(DEFAULT_AGENTS.copilot).toMatchObject({ command: 'copilot', args: ['--acp'] });
    expect(installCommandFor('copilot')).toBe(process.platform === 'win32' ? 'winget install GitHub.Copilot' : 'npm install -g @github/copilot');
  });

  it('signs in with its own CLI or a GitHub token, and only through github.com', () => {
    expect(CLI_ACCOUNTS.copilot.signIn).toEqual({ command: 'copilot', then: expect.stringContaining('/login') });
    expect(CLI_ACCOUNTS.copilot.signOut.then).toContain('/logout');
    expect(KEY_SETUPS.copilot.map((s) => s.fields.map((f) => f.env))).toEqual([['GH_TOKEN']]);
    expect(allowedSignInUrl('copilot', 'https://github.com/login/device')).toBe(true);
    expect(allowedSignInUrl('copilot', 'https://accounts.google.com/o/oauth2')).toBe(false);
  });

  it('is a first-class agent: its logo, @copilot and @github', () => {
    expect(MARKS.copilot.logo).toEqual({ color: 'var(--logo-github)' });
    expect(markFor('copilot')).toBe(MARKS.copilot);
    expect(agentFace('copilot').name).toBe('Copilot');
    expect(parseMention('@copilot fix it')?.agent).toBe('copilot');
    expect(parseMention('@github fix it')?.agent).toBe('copilot');
    expect(shownAgents(false)).toContain('copilot');
  });
});
