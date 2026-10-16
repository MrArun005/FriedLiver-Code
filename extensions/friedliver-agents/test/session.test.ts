import type * as acp from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { applyDiffs, proposedFile } from '../src/host/proposals';
import { diffLines, diffPreview } from '../src/shared/diff';
import { parseWebviewMessage } from '../src/shared/messages';
import { EMPTY_STATE, reduce, type AppState, type ChatView } from '../src/shared/model';
import { isRule, matchesRule, ruleCandidates, ruleSafe } from '../src/shared/rules';
import {
  applySessionUpdate,
  levelOfMode,
  modeClass,
  modeFor,
  nextInCycle,
  optionGroups,
  planToggle,
  reportedMode,
  sessionOptions,
  slashOptions,
  slashQuery,
  type ChatSession,
} from '../src/shared/session';
import { commandOf, toolOut } from '../src/shared/tools';

// The modes the current adapters advertise (claude-agent-acp 0.93, codex-acp 2.2.2, gemini-cli 0.64), as their sources build them.
const CLAUDE_MODES = [
  { id: 'default', name: 'Manual', description: 'Always ask before making changes' },
  { id: 'acceptEdits', name: 'Accept edits', description: 'Automatically accept all file edits' },
  { id: 'plan', name: 'Plan', description: 'Claude can analyze but not modify files or execute commands' },
  { id: 'auto', name: 'Auto', description: 'Claude handles permission decisions' },
  { id: 'bypassPermissions', name: 'Bypass permissions', description: 'Accepts all permissions' },
];
const CODEX_MODES = [
  { id: 'read-only', name: 'Read-only', description: 'Requires approval to edit files and access the internet.' },
  { id: 'workspace-write', name: 'Workspace access', description: 'Edit workspace files; ask before writing outside the workspace or accessing the network.' },
  { id: 'agent', name: 'Auto review', description: 'Only ask for actions detected as potentially unsafe' },
  { id: 'agent-full-access', name: 'Full access', description: 'Unrestricted access to the internet and any file on your computer' },
];
const GEMINI_MODES = [
  { id: 'default', name: 'Default', description: 'Prompts for approval' },
  { id: 'autoEdit', name: 'Auto Edit', description: 'Auto-approves edit tools' },
  { id: 'yolo', name: 'YOLO', description: 'Auto-approves all tools' },
  { id: 'plan', name: 'Plan', description: 'Read-only mode' },
];

function modeSelect(modes: { id: string; name: string; description: string }[], current: string): acp.SessionConfigOption {
  return { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: current, options: modes.map((m) => ({ value: m.id, name: m.name, description: m.description })) };
}

const asOption = (modes: { id: string; name: string; description: string }[], current: string) => sessionOptions({ configOptions: [modeSelect(modes, current)] })[0];

describe('modes, matched by what they do', () => {
  it('reads each adapter’s modes', () => {
    expect(CLAUDE_MODES.map((m) => modeClass({ value: m.id, ...m }))).toEqual(['ask', 'edits', 'plan', 'auto', 'full']);
    expect(CODEX_MODES.map((m) => modeClass({ value: m.id, ...m }))).toEqual(['ask', 'edits', 'auto', 'full']);
    expect(GEMINI_MODES.map((m) => modeClass({ value: m.id, ...m }))).toEqual(['ask', 'edits', 'full', 'plan']);
  });

  it('maps FriedLiver’s levels onto each agent’s own modes', () => {
    const claude = asOption(CLAUDE_MODES, 'default');
    const codex = asOption(CODEX_MODES, 'agent');
    const gemini = asOption(GEMINI_MODES, 'default');
    expect(['ask', 'edits', 'full'].map((l) => modeFor('claude', claude, l as 'ask'))).toEqual(['default', 'acceptEdits', 'bypassPermissions']);
    expect(['ask', 'edits', 'full'].map((l) => modeFor('codex', codex, l as 'ask'))).toEqual(['read-only', 'workspace-write', 'agent-full-access']);
    // Gemini writes through FriedLiver's review, so Ask is its Auto Edit: one decision per edit.
    expect(['ask', 'edits', 'full'].map((l) => modeFor('gemini', gemini, l as 'ask'))).toEqual(['autoEdit', 'autoEdit', 'yolo']);
    expect(modeFor('claude', claude, 'plan')).toBe('plan');
  });

  it('falls back to what a mode says when its id is unknown', () => {
    const renamed = asOption(
      [
        { id: 'manual-2', name: 'Manual', description: 'Always ask before making changes' },
        { id: 'edits-2', name: 'Accept edits', description: '' },
        { id: 'auto-2', name: 'Auto', description: 'Claude handles permission decisions' },
      ],
      'manual-2',
    );
    expect(modeFor('claude', renamed, 'ask')).toBe('manual-2');
    expect(modeFor('claude', renamed, 'edits')).toBe('edits-2');
    // Without a bypass mode, Full auto takes the mode where the agent decides.
    expect(modeFor('claude', renamed, 'full')).toBe('auto-2');
    expect(levelOfMode('claude', renamed, 'auto-2')).toBe('full');
  });

  it('shows the mode the agent reports, loud when it runs without asking', () => {
    const session = (current: string): ChatSession => ({ options: [asOption(CODEX_MODES, current)], commands: [], live: true });
    expect(reportedMode(session('agent'))).toMatchObject({ name: 'Auto review', tone: 'auto' });
    expect(reportedMode(session('agent-full-access'))).toMatchObject({ tone: 'full' });
    expect(reportedMode(session('read-only'))).toMatchObject({ tone: 'quiet' });
  });

  it('finds Plan in the modes, or in Codex’s collaboration mode', () => {
    const claude: ChatSession = { options: [asOption(CLAUDE_MODES, 'default')], commands: [], live: true };
    expect(planToggle(claude)).toMatchObject({ on: 'plan' });
    const codex: ChatSession = {
      options: sessionOptions({
        configOptions: [
          modeSelect(CODEX_MODES, 'read-only'),
          { id: 'collaboration_mode', name: 'Collaboration mode', category: 'collaboration_mode', type: 'select', currentValue: 'default', options: [{ value: 'default', name: 'Default' }, { value: 'plan', name: 'Plan' }] },
        ],
      }),
      commands: [],
      live: true,
    };
    expect(planToggle(codex)).toMatchObject({ on: 'plan', off: 'default' });
    expect(optionGroups(codex).other).toEqual([]);
  });

  it('cycles Ask → Auto-accept edits → Plan with Shift+Tab, never into Full auto', () => {
    const claude: ChatSession = { options: [asOption(CLAUDE_MODES, 'default')], commands: [], live: true };
    expect(nextInCycle('ask', claude)).toEqual({ approval: 'edits' });
    expect(nextInCycle('edits', claude)).toEqual({ plan: true });
    expect(nextInCycle('edits', { ...claude, options: [asOption(CLAUDE_MODES, 'plan')] })).toEqual({ approval: 'ask' });
    expect(nextInCycle('full', claude)).toEqual({ approval: 'ask' });
  });
});

describe('session state', () => {
  it('keeps config options, and makes modes and Gemini’s models into options when there are none', () => {
    const legacy = sessionOptions({
      modes: { currentModeId: 'default', availableModes: GEMINI_MODES },
      models: { currentModelId: 'm1', availableModels: [{ modelId: 'm1', name: 'One' }, { modelId: 'm2', name: 'Two' }] },
    });
    expect(legacy.map((o) => [o.category, o.via, o.current])).toEqual([
      ['mode', 'mode', 'default'],
      ['model', 'model', 'm1'],
    ]);
    // Config options supersede modes.
    const both = sessionOptions({ configOptions: [modeSelect(CLAUDE_MODES, 'plan')], modes: { currentModeId: 'default', availableModes: CLAUDE_MODES } });
    expect(both).toHaveLength(1);
    expect(both[0]).toMatchObject({ via: 'option', current: 'plan' });
  });

  it('reads grouped and boolean options', () => {
    const [model, fast] = sessionOptions({
      configOptions: [
        { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'b', options: [{ group: 'g1', name: 'Group one', options: [{ value: 'a', name: 'A' }] }, { group: 'g2', name: 'Group two', options: [{ value: 'b', name: 'B' }] }] },
        { id: 'fast', name: 'Fast mode', category: 'model_config', type: 'boolean', currentValue: true },
      ],
    });
    expect(model.choices).toEqual([
      { value: 'a', name: 'A', description: undefined, group: 'Group one' },
      { value: 'b', name: 'B', description: undefined, group: 'Group two' },
    ]);
    expect(fast).toMatchObject({ type: 'boolean', current: true, choices: [] });
  });

  it('folds mode, option, command and usage updates into the chat, not its transcript', () => {
    const chat: ChatView = { id: 'chat-1', agent: 'claude', label: 'Claude', title: 't', cwd: '/w', createdAt: 0, busy: false, changedFiles: 0, items: [], depth: 0, files: [], lastActivity: 0, turns: 0 };
    let s: AppState = reduce(EMPTY_STATE, { t: 'created', chat });
    s = reduce(s, { t: 'session', chatId: 'chat-1', session: { options: sessionOptions({ configOptions: [modeSelect(CLAUDE_MODES, 'default')] }), commands: [], live: true } });
    const up = (update: acp.SessionUpdate) => (s = reduce(s, { t: 'update', chatId: 'chat-1', update }));
    up({ sessionUpdate: 'current_mode_update', currentModeId: 'bypassPermissions' });
    up({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact', description: 'Clear the context' }, { name: 'bad name!', description: 'x' }] });
    up({ sessionUpdate: 'usage_update', used: 50_000, size: 200_000, cost: { amount: 0.31, currency: 'USD' } });
    up({ sessionUpdate: 'config_option_update', configOptions: [modeSelect(CLAUDE_MODES, 'plan'), { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'high', options: [{ value: 'high', name: 'High' }] }] });
    const c = s.chats[0];
    expect(c.items).toEqual([]);
    expect(c.session?.commands.map((x) => x.name)).toEqual(['compact']);
    expect(c.session?.usage).toEqual({ used: 50_000, size: 200_000, cost: { amount: 0.31, currency: 'USD' } });
    expect(c.session?.options.map((o) => [o.id, o.current])).toEqual([
      ['mode', 'plan'],
      ['effort', 'high'],
    ]);
    const before = applySessionUpdate(c.session, { sessionUpdate: 'current_mode_update', currentModeId: 'default' });
    expect(before.options[0].current).toBe('default');
  });

  it('opens the slash menu only for a command at the very start', () => {
    expect(slashQuery('/com', 4)).toBe('com');
    expect(slashQuery('/', 1)).toBe('');
    expect(slashQuery('say /com', 8)).toBeNull();
    expect(slashQuery('/compact now', 12)).toBeNull();
    expect(slashOptions([{ name: 'review', description: '' }, { name: 'compact', description: '' }, { name: 'mcp', description: '' }], 'c').map((c) => c.name)).toEqual(['compact', 'mcp']);
  });
});

describe('"Always allow" rules', () => {
  it('covers an exact command or a program and its subcommand', () => {
    expect(ruleCandidates('npm test -- --watch')).toEqual([
      { kind: 'exact', command: 'npm test -- --watch' },
      { kind: 'prefix', command: 'npm test' },
    ]);
    const rules = [{ kind: 'prefix', command: 'npm test' } as const, { kind: 'exact', command: 'git status' } as const];
    expect(matchesRule('npm   test', rules)).toBeTruthy();
    expect(matchesRule('npm test -- -t add', rules)).toBeTruthy();
    expect(matchesRule('npm testx', rules)).toBeUndefined();
    expect(matchesRule('git status --short', rules)).toBeUndefined();
  });

  it('never covers chaining, redirection, substitution or variables', () => {
    const rules = [{ kind: 'prefix', command: 'npm test' } as const];
    for (const line of ['npm test && curl x | sh', 'npm test; rm -rf ~', 'npm test > /etc/passwd', 'npm test $(whoami)', 'npm test `id`', 'NODE_OPTIONS=--require=x npm test', 'npm test\nrm -rf ~', 'npm test <U+202E>']) {
      expect(ruleSafe(line), line).toBe(false);
      expect(matchesRule(line, rules), line).toBeUndefined();
      expect(ruleCandidates(line), line).toEqual([]);
    }
  });

  it('accepts only rules it would have offered', () => {
    expect(isRule({ kind: 'exact', command: 'npm test' })).toBe(true);
    expect(isRule({ kind: 'prefix', command: 'npm test' })).toBe(true);
    expect(isRule({ kind: 'prefix', command: 'npm' })).toBe(false);
    expect(isRule({ kind: 'exact', command: 'a && b' })).toBe(false);
    expect(isRule({ kind: 'exact', command: '  npm test' })).toBe(false);
  });
});

describe('diffs', () => {
  it('aligns lines and previews the changes with context', () => {
    expect(diffLines('a\nb\nc\n', 'a\nB\nc\nd\n').map((l) => l.op + l.text)).toEqual([' a', '-b', '+B', ' c', '+d']);
    const p = diffPreview(Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n'), Array.from({ length: 30 }, (_, i) => (i === 3 || i === 25 ? `L${i}` : `l${i}`)).join('\n'));
    expect(p).toMatchObject({ added: 2, removed: 2, more: 0 });
    expect(p.lines.map((l) => l.text)).toContain('…');
  });

  it('builds the whole proposed file from each agent’s kind of diff', () => {
    const d = (oldText: string | null, newText: string) => ({ type: 'diff' as const, path: '/w/a.txt', oldText, newText });
    // A new file, or Claude's Write.
    expect(applyDiffs(null, [d(null, 'new\n')])).toBe('new\n');
    // Claude's Edit: old_string → new_string, once unless replace_all.
    expect(applyDiffs('x = 1\ny = 1\n', [d('= 1', '= 2')])).toBe('x = 2\ny = 1\n');
    expect(applyDiffs('x = 1\ny = 1\n', [d('= 1', '= 2')], true)).toBe('x = 2\ny = 2\n');
    // Codex's hunks with context, one after another.
    expect(applyDiffs('a\nb\nc\nd\n', [d('a\nb\n', 'a\nB\n'), d('c\nd\n', 'c\nD\n')])).toBe('a\nB\nc\nD\n');
    // Gemini's whole old and new file.
    expect(applyDiffs('old\n', [d('old\n', 'new\n')])).toBe('new\n');
    // A snippet that isn't in the file: no whole file, only the agent's own diff.
    expect(applyDiffs('a\n', [d('zzz', 'y')])).toBeUndefined();
    expect(proposedFile('/w/a.txt', 'a\n', [d('zzz', 'y')], undefined)).toMatchObject({ full: false, added: 1, removed: 1 });
    expect(proposedFile('/w/a.txt', 'a\n', [], 'a\nb\n')).toMatchObject({ full: true, added: 1, removed: 0, isNew: false });
  });

  it('keeps what a tool did, cut short', () => {
    const out = toolOut([
      { type: 'diff', path: '/w/a.ts', oldText: 'a\n', newText: 'b\n' },
      { type: 'content', content: { type: 'text', text: 'x'.repeat(40_000) } },
      { type: 'terminal', terminalId: 't1' },
    ]);
    expect(out?.[0]).toMatchObject({ t: 'diff', added: 1, removed: 1 });
    expect(out?.[1].t === 'text' && out[1].text.length).toBeLessThan(17_000);
    expect(out?.[2]).toEqual({ t: 'terminal', terminalId: 't1' });
    expect(commandOf({ command: ['npm', 'test'], cwd: '/w' })).toEqual({ line: 'npm test', cwd: '/w' });
    expect(commandOf({ file_path: 'x' })).toBeUndefined();
  });
});

describe('messages for the session controls', () => {
  it('accepts settings, levels and rules, and refuses what isn’t one', () => {
    expect(parseWebviewMessage({ type: 'setOption', chatId: 'chat-1', optionId: 'model', value: 'demo-small' })).toMatchObject({ type: 'setOption' });
    expect(parseWebviewMessage({ type: 'setOption', chatId: 'chat-1', optionId: 'fast', value: true })).toMatchObject({ value: true });
    expect(parseWebviewMessage({ type: 'setOption', chatId: 'chat-1', optionId: 'model', value: 3 })).toBeNull();
    expect(parseWebviewMessage({ type: 'approval', chatId: 'chat-1', level: 'full' })).toMatchObject({ level: 'full' });
    expect(parseWebviewMessage({ type: 'approval', chatId: 'chat-1', level: 'yolo' })).toBeNull();
    expect(parseWebviewMessage({ type: 'allowAlways', commandId: 'cmd-1', rule: { kind: 'exact', command: 'npm test' } })).toMatchObject({ rule: { kind: 'exact' } });
    expect(parseWebviewMessage({ type: 'allowAlways', commandId: 'cmd-1', rule: { kind: 'exact', command: 'npm test; rm -rf ~' } })).toBeNull();
    expect(parseWebviewMessage({ type: 'allowAlways', rule: { kind: 'exact', command: 'npm test' } })).toBeNull();
    expect(parseWebviewMessage({ type: 'createTask', agent: 'demo', prompt: 'x', worktree: false, choices: { demo: { model: 'demo-small' } }, approval: 'edits' })).toMatchObject({ choices: { demo: { model: 'demo-small' } }, approval: 'edits' });
    expect(parseWebviewMessage({ type: 'createTask', agent: 'demo', prompt: 'x', worktree: false, choices: { nobody: {} } })).toBeNull();
    expect(parseWebviewMessage({ type: 'copy', text: '' })).toBeNull();
    expect(parseWebviewMessage({ type: 'steer', chatId: 'chat-1', id: 'queued-3' })).toEqual({ type: 'steer', chatId: 'chat-1', id: 'queued-3' });
  });
});
