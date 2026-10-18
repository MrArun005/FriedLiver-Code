// One approval card for every request: the verb and target, the risk, the three scopes and what
// locks them (the UI never offers what policy forbids), the note that says exactly what gets
// remembered, the primary button's words, Tab, and press-and-hold.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allowMessage, approvalOf, nextScope, primaryLabel, scopeNote, type Approvable } from '../src/shared/approval';
import { HOLD_MS, Hold } from '../src/shared/hold';
import { parseWebviewMessage } from '../src/shared/messages';
import type { ChatView, Item } from '../src/shared/model';

const chat = { agent: 'claude', label: 'Claude', cwd: '/Users/arun/code/shop' } as Pick<ChatView, 'agent' | 'label' | 'cwd'>;
const OPTIONS = [
  { optionId: 'yes', name: 'Yes', kind: 'allow_once' },
  { optionId: 'session', name: "Yes, and don't ask again for this session", kind: 'allow_always' },
  { optionId: 'auto', name: 'Yes, and auto-accept edits', kind: 'allow_always' },
  { optionId: 'no', name: 'No', kind: 'reject_once' },
];
const run = (line: string, options = OPTIONS): Approvable => ({ kind: 'permission', requestId: 'p', title: line, toolKind: 'execute', options, detail: { command: { line, cwd: chat.cwd } } });
const edit = (path: string, always: Item extends never ? never : { kind: 'folder'; folder: string; access: 'write' }[] = []): Approvable => ({
  kind: 'permission',
  requestId: 'e',
  title: `Edit ${path}`,
  toolKind: 'edit',
  options: OPTIONS,
  detail: { files: [{ path, added: 3, removed: 1, isNew: false, full: true, lines: [], more: 0 }], ...(always.length ? { always } : {}) },
});
const bridge = (over: Partial<Extract<Item, { kind: 'bridge' }>>): Approvable => ({ kind: 'bridge', requestId: 'b', tool: 'ask_agent', target: { agent: 'gemini' }, text: 'Is there a CSV helper?', state: 'awaiting', ...over });

describe('scopes against policy', () => {
  it('a routine command offers all three; This chat is the agent’s own session option, Always its rules', () => {
    const a = approvalOf(run('npm test'), chat);
    expect(a).toMatchObject({ verb: 'Run', target: 'npm test', mono: true, where: 'in ~/code/shop', hold: false, locked: {} });
    expect(a.risk.tone).toBe('routine');
    expect(allowMessage(a, 'once')).toEqual({ type: 'permission', requestId: 'p', optionId: 'yes' });
    expect(allowMessage(a, 'chat')).toEqual({ type: 'permission', requestId: 'p', optionId: 'session' });
    expect(allowMessage(a, 'always')).toEqual({ type: 'allowAlways', requestId: 'p', grant: { kind: 'exact', command: 'npm test' } });
    // A mode change is never a scope: it stays one of the agent's other answers.
    expect(a.others.map((o) => o.label)).toEqual(['Yes, and auto-accept edits']);
  });

  it('a careful command locks This chat and Always, holds, and drops every other way to say yes', () => {
    const a = approvalOf(run('git push --force origin main'), chat);
    expect(a.hold).toBe(true);
    expect(a.locked.chat).toMatch(/one at a time/);
    expect(a.locked.always).toMatch(/one at a time/);
    expect(a.grants).toEqual([]);
    expect(allowMessage(a, 'chat')).toBeUndefined();
    expect(allowMessage(a, 'always')).toBeUndefined();
    expect(a.others).toEqual([]);
    expect(nextScope(a, 'once')).toBe('once');
    expect(primaryLabel(a, 'once')).toBe('Hold to allow');
    expect(a.risk.safer).toBe('git push --force-with-lease origin main');
  });

  it('counts the commits a force push would drop when the host found them', () => {
    const item = run('git push --force origin main') as Extract<Item, { kind: 'permission' }>;
    item.detail!.dropped = { ref: 'origin/main', commits: [{ hash: 'a41c', subject: 'fix', author: 'Priya' }, { hash: '9be0', subject: 'chore', author: 'Rahul' }], more: 1 };
    expect(approvalOf(item, chat).risk.consequences[0]).toBe('Replaces 3 commits on origin/main that are not in your branch');
  });

  it('a chained command can’t be remembered, and says why', () => {
    const a = approvalOf(run('npm test && npm run build'), chat);
    expect(a.locked.always).toBe('Chained or redirected commands always ask.');
    expect(a.locked.chat).toBeUndefined();
    expect(nextScope(a, 'once')).toBe('chat');
    expect(nextScope(a, 'chat')).toBe('once');
  });

  it('an agent with no session option has no This chat', () => {
    const a = approvalOf(run('npm test', [OPTIONS[0], OPTIONS[3]]), chat);
    expect(a.locked.chat).toBe('Claude offers no rule for this chat here.');
    expect(nextScope(a, 'once')).toBe('always');
    expect(nextScope(a, 'always')).toBe('once');
  });

  it('a secrets file is careful and once only; a dot-file is once only without the hold', () => {
    const env = approvalOf(edit('/Users/arun/code/shop/.env.local'), chat);
    expect(env).toMatchObject({ verb: 'Edit', target: '.env.local', hold: true });
    expect(env.risk.label).toBe('Secrets file');
    expect(env.locked.always).toBe('.env*, .git/ and ~/.ssh always ask, every time.');
    const ci = approvalOf(edit('/Users/arun/code/shop/.github/workflows/ci.yml'), chat);
    expect(ci.hold).toBe(false);
    expect(ci.locked.chat).toMatch(/always ask/);
    expect(allowMessage(ci, 'chat')).toBeUndefined();
  });

  it('an ordinary edit offers the folders the host offered', () => {
    const a = approvalOf(edit('/Users/arun/code/shop/src/format.ts', [{ kind: 'folder', folder: '/Users/arun/code/shop/src', access: 'write' }]), chat);
    expect(a).toMatchObject({ verb: 'Edit', target: 'src/format.ts', hold: false, locked: {} });
    expect(allowMessage(a, 'always')).toEqual({ type: 'allowAlways', requestId: 'e', grant: { kind: 'folder', folder: '/Users/arun/code/shop/src', access: 'write' } });
  });

  it('a plan is approved once; no plain yes means nothing to remember', () => {
    const plan: Approvable = { kind: 'permission', requestId: 'x', title: 'Ready to code?', toolKind: 'switch_mode', options: OPTIONS, detail: { plan: '1. do it' } };
    const a = approvalOf(plan, chat);
    expect(a).toMatchObject({ verb: 'Approve', target: 'the plan', yes: 'Approve' });
    expect(a.locked).toEqual({ chat: 'Plans are approved one at a time.', always: 'Plans are approved one at a time.' });
    const noYes = approvalOf(run('npm test', [OPTIONS[2], OPTIONS[3]]), chat);
    expect(noYes.allow.once).toBeUndefined();
    expect(noYes.locked.always).toBeTruthy();
  });

  it('a review is accepted once; a FriedLiver command has no This chat; outside the workspace, no Always', () => {
    const r = approvalOf({ kind: 'review', reviewId: 'r', path: '/Users/arun/code/shop/src/a.ts', added: 2, removed: 1, isNew: false, state: 'pending' }, chat);
    expect(r).toMatchObject({ verb: 'Edit', target: 'src/a.ts', where: '+2 −1', yes: 'Accept' });
    expect(primaryLabel(r, 'once')).toBe('Accept');
    expect(Object.keys(r.locked).sort()).toEqual(['always', 'chat']);
    const c = approvalOf({ kind: 'command', commandId: 'c', commandLine: 'npm test', cwd: chat.cwd, outside: false, state: 'awaiting', output: '' }, chat);
    expect(c.locked.chat).toBeTruthy();
    expect(allowMessage(c, 'always', 1)).toEqual({ type: 'allowAlways', commandId: 'c', grant: { kind: 'exact', command: 'npm test' } });
    const out = approvalOf({ kind: 'command', commandId: 'o', commandLine: 'ls', cwd: '/tmp', outside: true, state: 'awaiting', output: '' }, chat);
    expect(out.locked.always).toBe('Commands outside the workspace always ask.');
    expect(out.risk.tone).toBe('review');
  });

  it('agent-to-agent and browser requests map to allow / allowChat / allowAlways; a purchase click is once only', () => {
    const ask = approvalOf(bridge({ always: 'in every chat' }), chat);
    expect(ask).toMatchObject({ verb: 'Ask', target: 'Gemini', mono: false });
    expect([allowMessage(ask, 'once'), allowMessage(ask, 'chat'), allowMessage(ask, 'always')]).toEqual([
      { type: 'bridge', requestId: 'b', answer: 'allow' },
      { type: 'bridge', requestId: 'b', answer: 'allowChat' },
      { type: 'bridge', requestId: 'b', answer: 'allowAlways' },
    ]);
    const unknownSite = approvalOf(bridge({ tool: 'browser_click', target: { browser: true }, text: 'a.next' }), chat);
    expect(unknownSite.locked.always).toMatch(/unknown/);
    const buy = approvalOf(bridge({ tool: 'browser_click', target: { browser: true }, text: 'button#place-order', always: 'https://staging.shop.dev' }), chat);
    expect(buy).toMatchObject({ verb: 'Click', target: 'button#place-order', where: 'on staging.shop.dev', hold: true });
    expect(allowMessage(buy, 'chat')).toBeUndefined();
    expect(allowMessage(buy, 'always')).toBeUndefined();
  });

  it('every message a scope sends is one the host accepts', () => {
    for (const item of [run('npm test'), edit('/Users/arun/code/shop/src/a.ts', [{ kind: 'folder', folder: '/Users/arun/code/shop/src', access: 'write' }]), bridge({ always: 'in every chat' })]) {
      const a = approvalOf(item, chat);
      for (const s of ['once', 'chat', 'always'] as const) {
        const m = allowMessage(a, s);
        if (m) expect(parseWebviewMessage(JSON.parse(JSON.stringify(m)))).toEqual(m);
      }
    }
  });
});

describe('the note says exactly what gets remembered', () => {
  it('nothing for Once', () => {
    expect(scopeNote(approvalOf(run('npm test'), chat), run('npm test'), chat, 'once')).toBeUndefined();
  });

  it('a command rule: the rule, the folder, every chat', () => {
    const item = run('npm test -- --run');
    const a = approvalOf(item, chat);
    expect(scopeNote(a, item, chat, 'always', 0)).toBe('`npm test -- --run` in `~/code/shop`, every chat and agent. Undo in Manage Permissions.');
    expect(scopeNote(a, item, chat, 'always', 1)).toBe('`npm test *` in `~/code/shop`, every chat and agent. Undo in Manage Permissions.');
    expect(scopeNote(a, item, chat, 'chat')).toBe("Claude won't ask again for this until the chat ends: its own “don't ask again for this session”.");
  });

  it('a folder, a site and an agent tool', () => {
    const e = edit('/Users/arun/code/shop/src/a.ts', [{ kind: 'folder', folder: '/Users/arun/code/shop/src', access: 'write' }]);
    expect(scopeNote(approvalOf(e, chat), e, chat, 'always')).toBe('Changing files in `~/code/shop/src` and below, every chat. Undo in Manage Permissions.');
    const open = bridge({ tool: 'browser_open', target: { browser: true }, text: 'https://staging.shop.dev/checkout', always: 'https://staging.shop.dev' });
    expect(scopeNote(approvalOf(open, chat), open, chat, 'always')).toBe('`https://staging.shop.dev` in the browser, for every agent, in every chat. Undo in Manage Permissions.');
    expect(scopeNote(approvalOf(open, chat), open, chat, 'chat')).toMatch(/any site in the browser, without asking, until this chat ends/);
    const ask = bridge({ always: 'in every chat' });
    expect(scopeNote(approvalOf(ask, chat), ask, chat, 'always')).toBe('Any agent may ask another agent without asking, in every chat. Undo in Manage Permissions.');
  });

  it('none for a locked scope', () => {
    const item = run('rm -rf build');
    expect(scopeNote(approvalOf(item, chat), item, chat, 'always')).toBeUndefined();
  });

  it('the primary button repeats the scope', () => {
    const a = approvalOf(run('npm test'), chat);
    expect(['once', 'chat', 'always'].map((s) => primaryLabel(a, s as 'once'))).toEqual(['Allow once', 'Allow for this chat', 'Always allow']);
  });
});

describe('press and hold', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('allows only after the full hold; letting go sooner does nothing', () => {
    const done = vi.fn();
    const h = new Hold(done);
    h.start();
    vi.advanceTimersByTime(HOLD_MS - 1);
    h.release();
    vi.advanceTimersByTime(HOLD_MS);
    expect(done).not.toHaveBeenCalled();
    h.start();
    vi.advanceTimersByTime(HOLD_MS);
    expect(done).toHaveBeenCalledTimes(1);
    expect(h.holding).toBe(false);
  });

  it('a held key’s repeats don’t restart or shorten the count', () => {
    const done = vi.fn();
    const h = new Hold(done);
    expect(h.start()).toBe(true);
    vi.advanceTimersByTime(300);
    expect(h.start()).toBe(false);
    vi.advanceTimersByTime(299);
    expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(done).toHaveBeenCalledTimes(1);
  });
});
