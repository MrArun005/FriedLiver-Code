// The Decision Inbox: the queue's order and groups, what counts as the same request, the keys
// (the frozen target and its grace period included), and that every answer is a message the
// chat's own cards send, taking the core's own path.
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentCore } from '../src/host/core';
import { KEY_GRACE_MS } from '../src/shared/decisionTarget';
import {
  InboxSelection,
  answered,
  batchMessages,
  confirmKey,
  entryActions,
  identical,
  inbox,
  inboxKey,
  type InboxEntry,
} from '../src/shared/inbox';
import { parseWebviewMessage, type WebviewMessage } from '../src/shared/messages';
import { BRIDGE_TIMEOUT_MS, EMPTY_STATE, reduce, type AppState, type ChatView, type Item } from '../src/shared/model';
import { counts } from '../src/shared/view';
import { disposeCores, gitRepo, makeCore, waitFor } from './helpers';

afterEach(disposeCores);

const chat = (id: string, over: Partial<ChatView> = {}): ChatView => ({
  id,
  agent: 'claude',
  label: 'Claude',
  title: `Topic ${id}`,
  cwd: '/w',
  createdAt: 0,
  busy: true,
  changedFiles: 0,
  items: [],
  depth: 0,
  files: [],
  lastActivity: 0,
  turns: 0,
  ...over,
});

const OPTIONS = [
  { optionId: 'yes', name: 'Yes', kind: 'allow_once' },
  { optionId: 'always', name: "Yes, and don't ask again for npm commands", kind: 'allow_always' },
  { optionId: 'no', name: 'No', kind: 'reject_once' },
];
const run = (requestId: string, line: string, at: number, cwd?: string): Item => ({
  kind: 'permission',
  requestId,
  title: line,
  toolKind: 'execute',
  options: OPTIONS,
  detail: { command: { line, ...(cwd ? { cwd } : {}) } },
  at,
});
const cmd = (commandId: string, line: string, cwd: string, at: number, outside = false): Item => ({ kind: 'command', commandId, commandLine: line, cwd, outside, state: 'awaiting', output: '', at });
const site = (requestId: string, tool: 'browser_open' | 'browser_click', text: string, at: number, always?: string): Item => ({
  kind: 'bridge',
  requestId,
  tool,
  target: { browser: true },
  text,
  state: 'awaiting',
  at,
  ...(always ? { always } : {}),
});
const state = (...chats: ChatView[]): AppState => ({ ...EMPTY_STATE, chats });
const ids = (entries: InboxEntry[]) => entries.map((e) => e.id);

describe('the queue', () => {
  it('lists the oldest first, grouped by chat, the chat with the oldest request first', () => {
    const s = state(
      chat('a', { items: [run('a1', 'npm test', 30), run('a2', 'npm run lint', 10)] }),
      chat('b', { items: [cmd('b1', 'git status', '/w', 20), { kind: 'review', reviewId: 'b2', path: '/w/x.ts', added: 1, removed: 0, isNew: false, state: 'pending', at: 5 }] }),
    );
    const box = inbox(s);
    expect(box.groups.map((g) => g.chat.id)).toEqual(['b', 'a']);
    expect(box.groups.map((g) => ids(g.entries))).toEqual([['b2', 'b1'], ['a2', 'a1']]);
    expect(ids(box.entries)).toEqual(['b2', 'b1', 'a2', 'a1']);
    expect(box.entries.map((e) => e.kind)).toEqual(['review', 'command', 'command', 'command']);
  });

  it('keeps transcript order when items have no time (an older saved state)', () => {
    const p = (id: string): Item => ({ kind: 'permission', requestId: id, title: id, options: OPTIONS });
    expect(ids(inbox(state(chat('a', { items: [p('x'), p('y')] }), chat('b', { items: [p('z')] }))).entries)).toEqual(['x', 'y', 'z']);
  });

  it('leaves out answered requests, archived chats and read-only chats', () => {
    const answeredOne: Item = { ...run('done', 'ls', 1), answer: 'Yes' } as Item;
    const s = state(
      chat('a', { items: [answeredOne, run('open', 'ls', 2)] }),
      chat('arch', { archived: true, items: [run('arch1', 'ls', 0)] }),
      chat('ro', { readOnly: true, items: [run('ro1', 'ls', 0)] }),
    );
    expect(ids(inbox(s).entries)).toEqual(['open']);
  });

  it('counts the same as the header when no chat is read-only', () => {
    const s = state(chat('a', { items: [run('a1', 'ls', 1), site('a2', 'browser_open', 'https://x.test/', 2)] }), chat('b', { items: [cmd('b1', 'ls', '/w', 3)] }));
    expect(inbox(s).entries.length).toBe(counts(s).decisions);
    expect(inbox(EMPTY_STATE).entries).toEqual([]);
  });

  it('gives a request through the FriedLiver tools its ten-minute timeout', () => {
    const [entry] = inbox(state(chat('a', { items: [site('s', 'browser_open', 'https://x.test/', 1000)] }))).entries;
    expect(entry.timeoutAt).toBe(1000 + BRIDGE_TIMEOUT_MS);
    const [perm] = inbox(state(chat('a', { items: [run('p', 'ls', 1000)] }))).entries;
    expect(perm.timeoutAt).toBeUndefined();
  });

  it('stamps every waiting item with when it arrived', () => {
    let s = reduce(EMPTY_STATE, { t: 'created', chat: chat('a') });
    const bare: Item = { kind: 'permission', requestId: 'p', title: 'ls', options: OPTIONS };
    s = reduce(s, { t: 'items', chatId: 'a', items: [bare, { kind: 'agent', text: 'hi' }], at: 4242 });
    expect(s.chats[0].items[0]).toMatchObject({ requestId: 'p', at: 4242 });
    expect(s.chats[0].items[1]).not.toHaveProperty('at');
  });
});

describe('identical requests', () => {
  it('the same command text in the same folder, from any chat and either kind of request', () => {
    const s = state(chat('a', { items: [run('a1', 'npm test', 1, '/w'), run('a2', 'npm test', 3)] }), chat('b', { items: [cmd('b1', 'npm test', '/w', 2)] }));
    const box = inbox(s);
    expect(ids(identical(box.entries, box.entries[0]))).toEqual(['a1', 'a2', 'b1']);
  });

  it('never across a different folder, different arguments or differently spaced text', () => {
    const s = state(
      chat('a', { items: [run('a1', 'npm test', 1, '/w'), run('a2', 'npm test', 2, '/other'), run('a3', 'npm test -- --watch', 3, '/w'), run('a4', 'npm  test', 4, '/w')] }),
      chat('b', { cwd: '/elsewhere', items: [run('b1', 'npm test', 5)] }),
    );
    const box = inbox(s);
    for (const e of box.entries) expect(ids(identical(box.entries, e))).toEqual([e.id]);
  });

  it('the same browser action with the same text on the same site; never an unknown site', () => {
    const s = state(
      chat('a', {
        items: [
          site('o1', 'browser_open', 'https://shop.test/cart', 1),
          site('c1', 'browser_click', 'Pay now', 3, 'https://shop.test'),
          site('c3', 'browser_click', 'Pay now', 5),
        ],
      }),
      chat('b', {
        items: [
          site('o2', 'browser_open', 'https://shop.test/cart', 2),
          site('c2', 'browser_click', 'Pay now', 4, 'https://evil.test'),
          site('o3', 'browser_open', 'https://shop.test/cart?x', 6),
          site('c4', 'browser_click', 'Pay now', 7),
        ],
      }),
    );
    const box = inbox(s);
    const of = (id: string) => ids(identical(box.entries, box.entries.find((e) => e.id === id)!));
    expect(of('o1')).toEqual(['o1', 'o2']);
    expect(of('c1')).toEqual(['c1']);
    expect(of('c2')).toEqual(['c2']);
    expect(of('c3')).toEqual(['c3']);
    expect(of('o3')).toEqual(['o3']);
  });

  it('never batches edits, messages to agents or questions', () => {
    const edit: Item = { kind: 'permission', requestId: 'e', title: 'Edit a.ts', toolKind: 'edit', options: OPTIONS, detail: { files: [{ path: '/w/a.ts', added: 1, removed: 0, isNew: false, full: false, lines: [], more: 0 }] }, at: 1 };
    const ask: Item = { kind: 'bridge', requestId: 'q', tool: 'ask_agent', target: { agent: 'codex' }, text: 'same', state: 'awaiting', at: 2 };
    const s = state(chat('a', { items: [edit, ask] }), chat('b', { items: [{ ...edit, requestId: 'e2' } as Item, { ...ask, requestId: 'q2' } as Item] }));
    const box = inbox(s);
    for (const e of box.entries) expect(e.same).toBeUndefined();
  });

  it('answers each with its own one-time yes or no, never Always allow', () => {
    const other = [
      { optionId: 'ok-1', name: 'Allow', kind: 'allow_once' },
      { optionId: 'nope-1', name: 'Reject', kind: 'reject_once' },
    ];
    const s = state(chat('a', { items: [run('a1', 'npm test', 1, '/w'), { ...run('a2', 'npm test', 2, '/w'), options: other } as Item, cmd('c1', 'npm test', '/w', 3)] }));
    const box = inbox(s);
    const all = identical(box.entries, box.entries[0]);
    expect(batchMessages(all, 'allow')).toEqual([
      { type: 'permission', requestId: 'a1', optionId: 'yes' },
      { type: 'permission', requestId: 'a2', optionId: 'ok-1' },
      { type: 'command', commandId: 'c1', approve: true },
    ]);
    expect(batchMessages(all, 'deny')).toEqual([
      { type: 'permission', requestId: 'a1', optionId: 'no' },
      { type: 'permission', requestId: 'a2', optionId: 'nope-1' },
      { type: 'command', commandId: 'c1', approve: false },
    ]);
    expect([...batchMessages(all, 'allow'), ...batchMessages(all, 'deny')].some((m) => m.type === 'allowAlways' || (m.type === 'permission' && m.optionId === 'always'))).toBe(false);
  });
});

describe('the keys', () => {
  const s = state(
    chat('a', {
      items: [
        run('p', 'npm test', 1, '/w'),
        cmd('c', 'rm -rf build && make', '/w', 2),
        site('b', 'browser_click', 'Pay now', 3),
        { kind: 'question', requestId: 'q', message: 'Which store?', state: 'awaiting', at: 4, fields: [{ key: 'store', title: 'Store', type: 'choice', options: [{ value: 'json', title: 'JSON' }, { value: 'sqlite', title: 'SQLite (Recommended)' }] }] },
        { kind: 'review', reviewId: 'r', path: '/w/a.ts', added: 2, removed: 1, isNew: false, state: 'pending', at: 5 },
      ],
    }),
  );
  const box = inbox(s);
  const at = (id: string) => box.entries.find((e) => e.id === id)!;
  const key = (k: string, id: string, armed = true) => inboxKey({ key: k }, at(id), armed, box.entries);

  it('j and k move, Esc closes, o opens the chat', () => {
    expect(key('j', 'p')).toEqual({ do: 'move', by: 1 });
    expect(key('ArrowUp', 'p')).toEqual({ do: 'move', by: -1 });
    expect(key('Escape', 'p')).toEqual({ do: 'close' });
    expect(key('o', 'p')).toEqual({ do: 'open' });
    expect(inboxKey({ key: 'j' }, undefined, true)).toEqual({ do: 'move', by: 1 });
    expect(inboxKey({ key: 'a' }, undefined, true)).toBeNull();
  });

  it('1–9 pick the numbered answers, a allows once, d denies, Enter gives the primary', () => {
    expect(key('1', 'p')).toEqual({ do: 'send', messages: [{ type: 'permission', requestId: 'p', optionId: 'yes' }] });
    expect(key('3', 'p')).toEqual({ do: 'send', messages: [{ type: 'permission', requestId: 'p', optionId: 'no' }] });
    expect(key('4', 'p')).toBeNull();
    expect(key('a', 'p')).toEqual({ do: 'send', messages: [{ type: 'permission', requestId: 'p', optionId: 'yes' }] });
    expect(key('d', 'c')).toEqual({ do: 'send', messages: [{ type: 'command', commandId: 'c', approve: false }] });
    expect(key('Enter', 'c')).toEqual({ do: 'send', messages: [{ type: 'command', commandId: 'c', approve: true }] });
    expect(key('Enter', 'b')).toEqual({ do: 'send', messages: [{ type: 'bridge', requestId: 'b', answer: 'allow' }] });
    // A review's Enter opens its diff; a question's opens the chat. Claude's pick is 1, as on its card.
    expect(key('Enter', 'r')).toEqual({ do: 'send', messages: [{ type: 'review', reviewId: 'r', action: 'open' }] });
    expect(key('Enter', 'q')).toEqual({ do: 'open' });
    expect(key('1', 'q')).toEqual({ do: 'send', messages: [{ type: 'answerQuestion', requestId: 'q', action: 'accept', values: { store: 'sqlite' } }] });
    expect(key('d', 'q')).toEqual({ do: 'send', messages: [{ type: 'answerQuestion', requestId: 'q', action: 'decline' }] });
    expect(key('a', 'q')).toBeNull();
  });

  it('A always allows only where the request offers it and the rules permit', () => {
    expect(key('A', 'p')).toEqual({ do: 'send', messages: [{ type: 'allowAlways', requestId: 'p', grant: { kind: 'exact', command: 'npm test' } }] });
    // A chained command never gets a rule; a click on an unknown site offers none; reviews and questions none.
    expect(key('A', 'c')).toBeNull();
    expect(key('A', 'b')).toBeNull();
    expect(key('A', 'r')).toBeNull();
    expect(key('A', 'q')).toBeNull();
    const outside = inbox(state(chat('x', { items: [cmd('o', 'ls', '/tmp', 1, true)] }))).entries[0];
    expect(entryActions(outside).always).toBeUndefined();
    const offered = inbox(state(chat('x', { items: [site('s', 'browser_open', 'https://x.test/', 1, 'https://x.test')] }))).entries[0];
    expect(inboxKey({ key: 'A' }, offered, true)).toEqual({ do: 'send', messages: [{ type: 'bridge', requestId: 's', answer: 'allowAlways' }] });
  });

  it('answer keys do nothing in the grace period; moving and opening still work', () => {
    for (const k of ['1', 'a', 'A', 'd', 'Enter']) expect(key(k, 'p', false)).toEqual({ do: 'wait' });
    expect(key('j', 'p', false)).toEqual({ do: 'move', by: 1 });
    expect(key('o', 'p', false)).toEqual({ do: 'open' });
  });

  it('leaves keys with a modifier to the editor', () => {
    expect(inboxKey({ key: 'a', metaKey: true }, at('p'), true)).toBeNull();
    expect(inboxKey({ key: '1', ctrlKey: true }, at('p'), true)).toBeNull();
  });

  it('b asks to confirm only when there is more than one identical request; the confirmation has its own grace', () => {
    expect(key('b', 'p')).toBeNull();
    const two = inbox(state(chat('a', { items: [run('x', 'ls', 1)] }), chat('b', { items: [run('y', 'ls', 2)] })));
    expect(inboxKey({ key: 'b' }, two.entries[0], true, two.entries)).toEqual({ do: 'batch' });
    expect(inboxKey({ key: 'b' }, two.entries[0], false, two.entries)).toEqual({ do: 'wait' });
    expect(confirmKey({ key: 'Enter' }, true)).toBe('allow');
    expect(confirmKey({ key: 'a' }, true)).toBe('allow');
    expect(confirmKey({ key: 'd' }, true)).toBe('deny');
    expect(confirmKey({ key: 'Enter' }, false)).toBe('wait');
    expect(confirmKey({ key: 'Escape' }, false)).toBe('cancel');
    expect(confirmKey({ key: 'A' }, true)).toBeNull();
  });
});

describe('the selection', () => {
  const entriesOf = (...list: [string, number][]) => inbox(state(chat('a', { items: list.map(([id, t]) => run(id, 'ls', t)) }))).entries;

  it('starts on the oldest, and an arrival never takes it', () => {
    const sel = new InboxSelection();
    const before = entriesOf(['a', 1], ['b', 2]);
    expect(sel.selected(before, 0)?.id).toBe('a');
    const after = entriesOf(['new', 0], ['a', 1], ['b', 2]);
    expect(after[0].id).toBe('new');
    expect(sel.selected(after, 5000)?.id).toBe('a');
    expect(sel.armed(after, 5000)).toBe(true);
  });

  it('moves with j/k, stopping at the ends, each move with a fresh grace period', () => {
    const sel = new InboxSelection();
    const list = entriesOf(['a', 1], ['b', 2], ['c', 3]);
    sel.selected(list, 0);
    sel.move(-1, list, 1000);
    expect(sel.selected(list, 1000)?.id).toBe('a');
    sel.move(1, list, 2000);
    expect(sel.selected(list, 2000)?.id).toBe('b');
    expect(sel.armed(list, 2000 + KEY_GRACE_MS - 1)).toBe(false);
    expect(sel.armed(list, 2000 + KEY_GRACE_MS)).toBe(true);
    sel.move(1, list, 3000);
    sel.move(1, list, 4000);
    expect(sel.selected(list, 4000)?.id).toBe('c');
  });

  it('goes to the oldest still waiting once the selected one is answered, after a grace period', () => {
    const sel = new InboxSelection();
    const list = entriesOf(['a', 1], ['b', 2], ['c', 3]);
    sel.choose('b', list, 0);
    const left = entriesOf(['a', 1], ['c', 3]);
    expect(sel.selected(left, 5000)?.id).toBe('a');
    expect(sel.armed(left, 5000)).toBe(false);
    expect(sel.armed(left, 5000 + KEY_GRACE_MS)).toBe(true);
  });
});

describe('answers take the chat cards’ paths', () => {
  /** What the host does with each of these messages (extension.ts handle): the core's own methods. */
  const route = async (core: AgentCore, m: WebviewMessage) => {
    const parsed = parseWebviewMessage(JSON.parse(JSON.stringify(m)));
    expect(parsed).toEqual(m);
    if (m.type === 'permission') core.answerPermission(m.requestId, m.optionId);
    else if (m.type === 'command') core.decideCommand(m.commandId, m.approve);
    else if (m.type === 'bridge') core.answerBridge(m.requestId, m.answer);
    else if (m.type === 'answerQuestion') core.answerQuestion(m.requestId, m.action, m.values);
    else if (m.type === 'allowAlways') await core.allowAlways(m.requestId !== undefined ? { requestId: m.requestId } : { commandId: m.commandId! }, m.grant);
    else throw new Error(`not an answer: ${m.type}`);
  };

  it('every message an entry can send is one the host accepts', () => {
    const s = state(
      chat('a', {
        items: [
          run('p', 'npm test', 1, '/w'),
          cmd('c', 'npm test', '/w', 2),
          site('b', 'browser_open', 'https://x.test/', 3, 'https://x.test'),
          { kind: 'review', reviewId: 'r', path: '/w/a.ts', added: 2, removed: 1, isNew: false, state: 'pending', at: 5 },
        ],
      }),
    );
    for (const e of inbox(s).entries) {
      const a = entryActions(e);
      const all = [...a.choices.map((c) => c.message), a.allow, a.deny, a.always?.message, a.primary, a.diff].filter((m): m is WebviewMessage => !!m && m !== 'open');
      for (const m of all) expect(parseWebviewMessage(JSON.parse(JSON.stringify(m)))).toEqual(m);
    }
  });

  it('answering two identical requests at once allows each in its own chat, and they leave the queue', async () => {
    const dir = await gitRepo();
    const core = makeCore(dir);
    const one = await core.createChat('demo');
    const two = await core.createChat('demo');
    const turns = [core.send(one.id, 'native-run'), core.send(two.id, 'native-run')];
    await waitFor(() => inbox(core.snapshot).entries.length === 2);
    const box = inbox(core.snapshot);
    expect(box.groups.map((g) => g.chat.id).sort()).toEqual([one.id, two.id].sort());
    const same = identical(box.entries, box.entries[0]);
    expect(same).toHaveLength(2);
    for (const m of batchMessages(same, 'allow')) await route(core, m);
    await Promise.all(turns);
    expect(inbox(core.snapshot).entries).toEqual([]);
    expect(answered(core.snapshot).map((a) => [a.chatId, a.outcome, a.allowed]).sort()).toEqual(
      [
        [one.id, 'Yes', true],
        [two.id, 'Yes', true],
      ].sort(),
    );
  });

  it('a no from the inbox is the agent’s own no', async () => {
    const dir = await gitRepo();
    const core = makeCore(dir);
    const c = await core.createChat('demo');
    const turn = core.send(c.id, 'native-run');
    await waitFor(() => inbox(core.snapshot).entries.length === 1);
    const cmdKey = inboxKey({ key: 'd' }, inbox(core.snapshot).entries[0], true);
    expect(cmdKey?.do).toBe('send');
    for (const m of cmdKey!.do === 'send' ? cmdKey!.messages : []) await route(core, m);
    await turn;
    expect(answered(core.snapshot)[0]).toMatchObject({ chatId: c.id, allowed: false });
  });
});

describe('what was answered lately', () => {
  it('lists what you answered, newest first, never what a rule or a level answered', () => {
    const s = state(
      chat('a', {
        items: [
          { ...run('p1', 'ls', 1), answer: 'Yes' } as Item,
          { ...run('p2', 'ls', 2), answer: 'Yes', auto: 'Always allowed' } as Item,
          { ...cmd('c1', 'make', '/w', 3), state: 'denied' } as Item,
          { ...site('b1', 'browser_open', 'https://x.test/', 4), state: 'allowed' } as Item,
          { kind: 'question', requestId: 'q1', message: 'Which?', fields: [], state: 'answered', summary: 'SQLite', at: 5 },
          run('waiting', 'ls', 6),
        ],
      }),
    );
    expect(answered(s).map((a) => [a.id, a.outcome, a.allowed])).toEqual([
      ['q1', 'Answered: SQLite', true],
      ['b1', 'Allowed', true],
      ['c1', 'Denied', false],
      ['p1', 'Yes', true],
    ]);
    expect(answered(s, 2)).toHaveLength(2);
  });
});

describe('the way in', () => {
  it('is a command, "FriedLiver: Open Decision Inbox", on Cmd+Shift+I', async () => {
    const { readFile } = await import('node:fs/promises');
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.contributes.commands).toContainEqual(expect.objectContaining({ command: 'friedliver.openInbox', title: 'Open Decision Inbox', category: 'FriedLiver' }));
    expect(pkg.contributes.keybindings).toContainEqual(expect.objectContaining({ command: 'friedliver.openInbox', mac: 'cmd+shift+i' }));
    expect(parseWebviewMessage({ type: 'openInbox' })).toEqual({ type: 'openInbox' });
  });
});
