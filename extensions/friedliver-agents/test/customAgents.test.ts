import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_AGENTS, OPENCODE_PERMISSIONS } from '@friedliver/main/agents/registry';
import { levelOfMode, modeFor, optionGroups, type SessionOption } from '../src/shared/session';
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
      { id: 'qwen', command: 'qwen', args: ['--acp'] },
      { id: 'Bad-Id', command: 'x' },
      { id: 'claude', command: 'x' },
      { id: 'gpt', command: 'x' },
      { id: 'copilot', command: 'x' },
      { id: 'opencode', command: 'x' },
      { id: 'kimi', command: 'again' },
      { id: 'nocmd' },
      { id: 'badargs', command: 'x', args: ['ok', 3] },
      { id: 'badenv', command: 'x', env: { 'NOT OK': 'v' } },
      { id: 'twoline', command: 'x\ny' },
      'not an object',
    ]);
    expect(agents.map((a) => a.key)).toEqual(['custom:kimi', 'custom:qwen']);
    expect(agents[0]).toMatchObject({ name: 'Kimi', command: 'kimi', args: ['acp'], env: { KIMI_HOME: '/tmp/k' }, install: KIMI.install, signIn: KIMI.signIn });
    expect(agents[1].name).toBe('qwen');
    expect(problems).toHaveLength(11);
    expect(problems.filter((p) => p.includes('is taken'))).toHaveLength(5);
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

describe('OpenCode preset', () => {
  it('runs `opencode acp`, installs without sudo, and makes every action but reading ask FriedLiver', () => {
    expect(DEFAULT_AGENTS.opencode).toMatchObject({ command: 'opencode', args: ['acp'] });
    expect(installCommandFor('opencode')).toBe(process.platform === 'win32' ? 'npm install -g opencode-ai' : 'curl -fsSL https://opencode.ai/install | bash');
    const config = JSON.parse(DEFAULT_AGENTS.opencode.env!.OPENCODE_CONFIG_CONTENT);
    expect(config.permission).toEqual(OPENCODE_PERMISSIONS);
    expect(Object.keys(config.permission)[0]).toBe('*');
    expect(config.permission['*']).toBe('ask');
    expect(config.permission.read['*.env']).toBe('deny');
  });

  it('signs in with `opencode auth login` or a Zen key; free Zen models need neither', () => {
    expect(CLI_ACCOUNTS.opencode.signIn?.command).toBe('opencode auth login');
    expect(KEY_SETUPS.opencode.map((s) => s.fields.map((f) => f.env))).toEqual([['OPENCODE_API_KEY']]);
    expect(MARKS.opencode.svg).toContain('M180 60H60V240H180V60ZM240 300H0V0H240V300Z');
    expect(parseMention('@opencode go')?.agent).toBe('opencode');
  });

  it('keeps every approval level in its Build agent; Plan is its plan agent', () => {
    // As OpenCode 1.19.4 reported them over ACP.
    const mode: SessionOption = { id: 'mode', name: 'Mode', category: 'mode', type: 'select', via: 'option', current: 'build', choices: [
      { value: 'build', name: 'build', description: 'The default agent. Executes tools based on configured permissions.' },
      { value: 'plan', name: 'plan', description: 'Plan mode. Disallows all edit tools.' },
    ] };
    for (const level of ['ask', 'edits', 'full'] as const) expect(modeFor('opencode', mode, level)).toBe('build');
    expect(modeFor('opencode', mode, 'plan')).toBe('plan');
  });
});

describe('Copilot’s own approve-everything switches', () => {
  // As Copilot CLI 1.0.103 reported them over ACP before sign-in.
  const M = (m: string) => `https://agentclientprotocol.com/protocol/session-modes#${m}`;
  const mode: SessionOption = { id: 'mode', name: 'Mode', category: 'mode', type: 'select', via: 'option', current: M('agent'), choices: [
    { value: M('agent'), name: 'Agent', description: 'Default agent mode for conversational interactions' },
    { value: M('plan'), name: 'Plan', description: 'Plan mode for creating and executing multi-step plans' },
    { value: M('autopilot'), name: 'Autopilot', description: 'Autonomous mode that enables allow-all and runs until task completion without user interaction (experimental)' },
  ] };
  const allowAll: SessionOption = { id: 'allow_all', name: 'allow_all', category: 'permissions', type: 'select', via: 'option', current: 'off', choices: [{ value: 'on', name: 'On' }, { value: 'off', name: 'Off' }] };

  it('never puts Copilot in Autopilot for a level, and picking it by hand counts as Full auto', () => {
    for (const level of ['ask', 'edits', 'full'] as const) expect(modeFor('copilot', mode, level)).toBe(M('agent'));
    expect(modeFor('copilot', mode, 'plan')).toBe(M('plan'));
    expect(levelOfMode('copilot', mode, M('autopilot'))).toBe('full');
  });

  it('never offers its allow_all option', () => {
    expect(optionGroups({ options: [mode, allowAll] } as never).other).toEqual([]);
  });
});

describe('GitHub Copilot CLI preset', () => {
  it('runs the official ACP server and installs without sudo', () => {
    expect(DEFAULT_AGENTS.copilot).toMatchObject({ command: 'copilot', args: ['--acp'] });
    expect(installCommandFor('copilot')).toBe(process.platform === 'win32' ? 'winget install GitHub.Copilot' : 'npm install -g @github/copilot');
  });

  it('signs in with its own CLI or a GitHub token, and only through github.com', () => {
    // The command its own ACP authMethods name (copilot-login: `copilot login`).
    expect(CLI_ACCOUNTS.copilot.signIn?.command).toBe('copilot login');
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
