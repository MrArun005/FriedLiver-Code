import { describe, expect, it } from 'vitest';
import { parseMention, reduce, type AppState, type ChatLink, type ChatView, type Item } from '../src/shared/model';
import {
  MAP,
  MENTION_OPTIONS,
  applyMention,
  cardLine,
  cardModel,
  clip,
  conflictText,
  conflictsOf,
  counts,
  excerpt,
  fanoutGroups,
  filterChats,
  keepPlan,
  linkBadges,
  mapKey,
  mapLayout,
  mentionOptions,
  mentionQuery,
  mentionedAgent,
  nextDecision,
  planProgress,
  recentChats,
  relativePath,
  rosterKey,
  settleOrder,
  slashAction,
  slashMenu,
  sortChats,
  statusOf,
  subagents,
  statusGroups,
  switcherGroups,
  tipPlace,
  stepsHeading,
  shortDuration,
  subagentAnswer,
  transcriptGroups,
  switcherMeta,
} from '../src/shared/view';

const chat = (id: string, over: Partial<ChatView> = {}): ChatView => ({
  id,
  agent: 'claude',
  label: 'Claude',
  title: 'New chat',
  cwd: '/w',
  createdAt: 0,
  busy: false,
  changedFiles: 0,
  items: [],
  depth: 0,
  files: [],
  lastActivity: 0,
  turns: 0,
  ...over,
});
const link = (over: Partial<ChatLink> = {}): ChatLink => ({ id: 'link-1', kind: 'consult', from: 'a', to: 'b', by: 'user', createdAt: 0, active: true, count: 0, ...over });
const said: Item = { kind: 'user', text: 'go', images: [] };
const waiting: Item = { kind: 'command', commandId: 'cmd-1', commandLine: 'npm test', cwd: '/w', outside: false, state: 'awaiting', output: '' };
const state = (chats: ChatView[], links: ChatLink[] = []): AppState => ({ chats, links, images: [] });

describe('search and sorting', () => {
  const chats = [
    chat('a', { title: 'Fix formatCents', label: 'Claude 1', lastActivity: 5, createdAt: 1 }),
    chat('b', { agent: 'codex', label: 'Codex 1', title: 'Add tests', branch: 'codex/add-tests', lastActivity: 9, createdAt: 2, files: ['a', 'b'] }),
    chat('c', { agent: 'gemini', label: 'Gemini 1', title: 'Document the API', busy: true, items: [said], lastActivity: 7, createdAt: 3, files: ['a'] }),
    chat('d', { label: 'Claude 10', title: 'Review', items: [said, waiting], lastActivity: 1, createdAt: 4 }),
    chat('e', { label: 'Claude 2', title: 'Zebra', items: [said], lastActivity: 3, createdAt: 5 }),
  ];

  it('matches every word against title, agent, label and branch', () => {
    expect(filterChats(chats, 'add-tests').map((c) => c.id)).toEqual(['b']);
    expect(filterChats(chats, 'GPT').map((c) => c.id)).toEqual(['b']);
    expect(filterChats(chats, 'claude fix').map((c) => c.id)).toEqual(['a']);
    expect(filterChats(chats, '  ').length).toBe(5);
    expect(filterChats(chats, 'nothing')).toEqual([]);
  });

  it('sorts by status, agent (numbered labels in order), task, activity, files and age', () => {
    const ids = (key: Parameters<typeof sortChats>[1]['key'], dir: 'asc' | 'desc' = 'asc') => sortChats(chats, { key, dir }).map((c) => c.id);
    expect(ids('status')[0]).toBe('d');
    expect(ids('status')[1]).toBe('c');
    expect(ids('agent')).toEqual(['a', 'e', 'd', 'b', 'c']);
    expect(ids('task')).toEqual(['b', 'c', 'a', 'd', 'e']);
    expect(ids('activity')).toEqual(['b', 'c', 'a', 'e', 'd']);
    expect(ids('files', 'desc').slice(0, 2)).toEqual(['b', 'c']);
    expect(ids('age')).toEqual(['e', 'd', 'c', 'b', 'a']);
    expect(ids('age', 'desc')).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('counts the columns, archived chats and decisions', () => {
    expect(counts(state([...chats, chat('x', { archived: true, items: [said, waiting] })]))).toEqual({ needsYou: 1, working: 1, done: 3, archived: 1, decisions: 1 });
  });

  it('steps through decisions and wraps around', () => {
    const list = [
      { chatId: 'a', kind: 'command' as const, id: '1', title: '' },
      { chatId: 'b', kind: 'review' as const, id: '2', title: '' },
    ];
    expect(nextDecision(list)?.id).toBe('1');
    expect(nextDecision(list, '1')?.id).toBe('2');
    expect(nextDecision(list, '2')?.id).toBe('1');
    expect(nextDecision([], '1')).toBeUndefined();
  });
});

describe('cards', () => {
  it('reads an agent asking to reach another agent as a decision with its request', () => {
    const c = chat('a', { label: 'Claude 2', items: [said, { kind: 'bridge', requestId: 'br-1', tool: 'ask_agent', target: { agent: 'gemini' }, text: 'Is this safe?', state: 'awaiting' }, waiting] });
    const line = cardLine(state([c]), c);
    expect(line).toMatchObject({ text: 'Claude 2 wants to ask Gemini', code: 'Is this safe?', waiting: 2 });
    expect(line.decision?.kind).toBe('bridge');
    expect(cardLine(state([chat('b', { busy: true, items: [said] })]), chat('b', { busy: true, items: [said] })).text).toBe('Working…');
  });

  it('reads a consultation that answered as done, not as not started', () => {
    const consulted = chat('g', {
      items: [{ kind: 'link', linkId: 'l', role: 'consulted', chatId: 'a', agent: 'claude', label: 'Claude 1', text: 'Is it safe?', by: 'user' }, { kind: 'agent', text: 'Yes.' }],
    });
    expect(statusOf(consulted)).toBe('done');
    expect(cardLine(state([consulted]), consulted).text).toBe('Done');
    expect(statusOf(chat('n'))).toBe('idle');
  });

  it('turns the latest plan into steps', () => {
    const c = chat('a', {
      items: [
        { kind: 'plan', entries: [{ content: 'old', status: 'pending' }] },
        {
          kind: 'plan',
          entries: [
            { content: 'Read', status: 'completed' },
            { content: 'Edit', status: 'in_progress' },
            { content: 'Test', status: 'pending' },
          ],
        },
      ],
    });
    expect(planProgress(c)).toEqual({ steps: ['done', 'working', 'next'], done: 1, current: 2, currentText: 'Edit' });
    expect(planProgress(chat('b'))).toBeNull();
  });

  it('names links from the point of view of each chat', () => {
    const s = state(
      [
        chat('a', { label: 'Claude 2' }),
        chat('b', { agent: 'gemini', label: 'Gemini 1', busy: true, origin: { kind: 'consult', chatId: 'a', by: 'agent' } }),
        chat('c', { agent: 'codex', label: 'Codex 3', origin: { kind: 'handoff', chatId: 'a', by: 'user' } }),
        chat('d', { agent: 'codex', label: 'Codex 4', group: 'g', createdAt: 1 }),
        chat('e', { agent: 'gemini', label: 'Gemini 2', group: 'g', createdAt: 2 }),
      ],
      [link({ id: 'l1', from: 'a', to: 'b' }), link({ id: 'l2', kind: 'handoff', from: 'a', to: 'c' }), link({ id: 'l3', kind: 'pipe', from: 'c', to: 'd', active: true })],
    );
    const texts = (id: string) => linkBadges(s, s.chats.find((c) => c.id === id)!).map((b) => b.text);
    expect(texts('a')).toEqual(['asking Gemini 1', 'handed to Codex 3']);
    expect(texts('b')).toEqual(['asked by Claude 2']);
    expect(texts('c')).toEqual(['from Claude 2', 'pipes to Codex 4']);
    expect(texts('d')).toEqual(['piped from Codex 3', '1 of 2 · compare']);
    expect(linkBadges(s, s.chats[3]).find((b) => b.kind === 'pipe')?.linkId).toBe('l3');
  });

  it('lists the other chats that changed the same file, and matches review paths to them', () => {
    const s = state([chat('a', { label: 'Claude 1', files: ['src/format.ts', 'a.ts'] }), chat('b', { label: 'Codex 2', title: 'Add tests for formatCents', files: ['src/format.ts'] }), chat('c', { files: ['a.ts'], merged: true })]);
    const mine = conflictsOf(s, 'a');
    expect(mine.map(conflictText)).toEqual(['also in Add tests for formatCents: src/format.ts']);
    expect(conflictsOf(s, 'c')).toEqual([]);
    expect(relativePath('/w/', '/w/src/format.ts')).toBe('src/format.ts');
    expect(relativePath('C:\\w', 'c:\\w\\src\\x.ts')).toBe('src/x.ts');
    expect(relativePath('/w', '/other/x.ts')).toBe('/other/x.ts');
  });
});

describe('fan-out groups', () => {
  it('compares open groups of two or more and keeps one', () => {
    const s = state([
      chat('a', { group: 'g', createdAt: 2, branch: 'claude/x' }),
      chat('b', { group: 'g', createdAt: 1 }),
      chat('c', { group: 'g', archived: true }),
      chat('d', { group: 'h' }),
    ]);
    const groups = fanoutGroups(s);
    expect(groups.map((g) => g.chats.map((c) => c.id))).toEqual([['b', 'a']]);
    expect(keepPlan(groups[0], 'a')).toEqual({ merge: 'a', archive: ['b'] });
    expect(keepPlan(groups[0], 'b')).toEqual({ merge: undefined, archive: ['a'] });
  });
});

describe('the chat switcher', () => {
  const chats = Array.from({ length: 8 }, (_, i) => chat(`c${i}`, { createdAt: i, lastActivity: i * 10, items: i % 3 === 0 ? [said, waiting] : [said], busy: i % 3 === 1 }));
  it('shows the most recent chats in start order, always with the open one', () => {
    expect(recentChats(chats, 'c7', 3).map((c) => c.id)).toEqual(['c5', 'c6', 'c7']);
    expect(recentChats(chats, 'c0', 3).map((c) => c.id)).toEqual(['c0', 'c6', 'c7']);
    expect(recentChats([...chats, chat('z', { archived: true, lastActivity: 999 })], undefined, 2).map((c) => c.id)).toEqual(['c6', 'c7']);
  });

  it('groups chats by where they stand, most recent first', () => {
    const groups = switcherGroups(chats, '');
    expect(groups.map((g) => g.title)).toEqual(['Needs you', 'Working', 'Done']);
    expect(groups.map((g) => g.chats.length)).toEqual([3, 3, 2]);
    expect(groups[0].chats.map((c) => c.id)).toEqual(['c6', 'c3', 'c0']);
    expect(switcherGroups(chats, 'nothing')).toEqual([]);
    const starred = switcherGroups(chats.map((c) => (c.id === 'c2' ? { ...c, starred: true } : c)), '');
    expect(starred.map((g) => [g.title, g.chats.length])).toEqual([['Starred', 1], ['Needs you', 3], ['Working', 3], ['Done', 1]]);
  });
});

describe('@-mentions', () => {
  it('opens only for an @ at the very start while the caret is in the word', () => {
    expect(mentionQuery('@', 1)).toBe('');
    expect(mentionQuery('@Gem', 4)).toBe('gem');
    expect(mentionQuery('  @ge', 5)).toBe('ge');
    expect(mentionQuery('@gemini review', 14)).toBeNull();
    expect(mentionQuery('hi @gemini', 10)).toBeNull();
    expect(mentionQuery('@ge', 0)).toBeNull();
  });

  it('filters agents by any of their names', () => {
    expect(mentionOptions('').map((o) => o.agent)).toEqual(['claude', 'codex', 'gemini', 'demo']);
    expect(mentionOptions('g').map((o) => o.agent)).toEqual(['codex', 'gemini']);
    expect(mentionOptions('open').map((o) => o.agent)).toEqual(['codex']);
    expect(mentionOptions('xyz')).toEqual([]);
  });

  it('inserts the mention, keeps the rest, and agrees with parseMention', () => {
    const gemini = MENTION_OPTIONS.find((o) => o.agent === 'gemini')!;
    expect(applyMention('@ge', gemini)).toEqual({ text: '@gemini ', caret: 8 });
    expect(applyMention('@g, check this', gemini)).toEqual({ text: '@gemini check this', caret: 8 });
    expect(mentionedAgent('@gpt')).toBe('codex');
    expect(mentionedAgent('@gp')).toBeNull();
    expect(mentionedAgent('hi @gpt')).toBeNull();
    for (const o of MENTION_OPTIONS) for (const w of o.words) expect(parseMention(`@${w} hi`)?.agent).toBe(o.agent);
  });
});

describe('subagents', () => {
  const task = (id: string, status: string, tool = 'Task'): Item => ({ kind: 'tool', id, title: `Job ${id}`, status, locations: [], tool });
  const inner = (id: string, parent: string): Item => ({ kind: 'tool', id, title: 'Read', status: 'completed', locations: [], tool: 'Read', parent });
  const items = [said, task('t1', 'in_progress'), inner('i1', 't1'), inner('i2', 't1'), task('t2', 'completed', 'Agent'), task('t3', 'failed'), inner('i3', 't3')];

  it("lists a chat's Task and Agent calls with their state and inner tool count", () => {
    expect(subagents(chat('p', { busy: true, items }))).toEqual([
      { id: 't1', title: 'Job t1', state: 'working', tools: 2, last: 'Read' },
      { id: 't2', title: 'Job t2', state: 'done', tools: 0 },
      { id: 't3', title: 'Job t3', state: 'failed', tools: 1, last: 'Read' },
    ]);
  });

  it('stops counting a subagent as working once its chat stopped', () => {
    expect(subagents(chat('p', { items }))[0].state).toBe('done');
    expect(subagents(chat('p', { items: [said, inner('i1', 'x')] }))).toEqual([]);
  });

  it('draws each subagent on the map under its chat, with an edge from the chat', () => {
    const map = mapLayout(state([chat('p', { busy: true, items }), chat('q', { createdAt: 1 })]));
    expect(map.subs.map((n) => [n.id, n.chatId, n.state])).toEqual([
      ['p:t1', 'p', 'working'],
      ['p:t2', 'p', 'done'],
      ['p:t3', 'p', 'failed'],
    ]);
    const p = map.nodes.find((n) => n.chat.id === 'p')!;
    const q = map.nodes.find((n) => n.chat.id === 'q')!;
    expect(map.subs.every((n) => n.y > p.y && n.y < q.y && n.x > p.x)).toBe(true);
    const e = map.edges.filter((x) => x.kind === 'subagent');
    expect(e.map((x) => [x.from, x.to])).toEqual([
      ['p', 'p:t1'],
      ['p', 'p:t2'],
      ['p', 'p:t3'],
    ]);
    expect(e[0].d.startsWith(`M ${p.x + MAP.nodeW} `)).toBe(true);
    expect(mapKey(state([chat('p', { busy: true, items })]))).not.toBe(mapKey(state([chat('p', { items })])));
  });
});

describe('subagents inline', () => {
  const agent = (id: string, status: string, over: Partial<Extract<Item, { kind: 'tool' }>> = {}): Item => ({ kind: 'tool', id, title: `Job ${id}`, status, locations: [], tool: 'Agent', ...over });
  const step = (id: string, parent: string, title = 'Read a.ts', status = 'completed'): Item => ({ kind: 'tool', id, title, status, locations: [], tool: 'Read', parent });
  const read: Item = { kind: 'tool', id: 'r', title: 'Read', status: 'completed', locations: [], tool: 'Read' };
  const items: Item[] = [said, read, agent('a1', 'in_progress', { startedAt: 1000 }), agent('a2', 'completed', { startedAt: 1000, ms: 4000 }), step('s1', 'a1'), read, step('s2', 'a1', 'Grep foo', 'in_progress'), step('s3', 'a2')];

  it('puts each subagent in the transcript where it was spawned, with its own steps, not in the step boxes', () => {
    const g = transcriptGroups(items);
    expect(g.map((x) => x.kind)).toEqual(['one', 'steps', 'subagent', 'subagent', 'steps']);
    const [, first, a1, a2, last] = g;
    expect(first.kind === 'steps' && first.items.map((t) => t.id)).toEqual(['r']);
    expect(a1.kind === 'subagent' && [a1.item.id, a1.steps.map((t) => t.id)]).toEqual(['a1', ['s1', 's2']]);
    expect(a2.kind === 'subagent' && a2.steps.map((t) => t.id)).toEqual(['s3']);
    // A step of a subagent between two plain steps doesn't split their box apart either.
    expect(last.kind === 'steps' && last.items.map((t) => t.id)).toEqual(['r']);
  });

  it('gives a subagent its last step and its timing', () => {
    const [a1, a2] = subagents(chat('p', { busy: true, items }));
    expect(a1).toMatchObject({ id: 'a1', state: 'working', last: 'Grep foo', startedAt: 1000, tools: 2 });
    expect(a2).toMatchObject({ id: 'a2', state: 'done', last: 'Read a.ts', ms: 4000 });
  });

  it("reads a subagent's final answer from its result", () => {
    expect(subagentAnswer({ kind: 'tool', id: 'a', title: 'x', locations: [], out: [{ t: 'text', text: 'Found 3 bugs.' }] })).toBe('Found 3 bugs.');
    expect(subagentAnswer({ kind: 'tool', id: 'a', title: 'x', locations: [] })).toBeUndefined();
  });

  it("draws an outside Claude Code session's subagents under it, and leaves sessions without subagents off the map", () => {
    const outside = [
      { id: 'cc1', cwd: '/w', title: 'Fan out three reviewers', lastActivity: 10_000, messages: 4, subagents: [{ id: 'x1', title: 'Review A', done: false }, { id: 'x2', title: 'Review B', done: true }] },
      { id: 'cc2', cwd: '/w', title: 'IDE identification question', lastActivity: 10_000, messages: 2, subagents: [] },
    ];
    const map = mapLayout(state([chat('p', { items: [said] })]), outside, 20_000);
    expect(map.outside.map((n) => [n.id, n.state])).toEqual([['cc1', 'working']]);
    expect(map.subs.filter((n) => n.outside).map((n) => [n.id, n.chatId, n.state])).toEqual([
      ['cc:cc1:x1', 'cc:cc1', 'working'],
      ['cc:cc1:x2', 'cc:cc1', 'done'],
    ]);
    expect(map.edges.filter((e) => e.kind === 'subagent').map((e) => [e.from, e.to])).toEqual([
      ['cc:cc1', 'cc:cc1:x1'],
      ['cc:cc1', 'cc:cc1:x2'],
    ]);
    expect(map.lanes.at(-1)).toMatchObject({ agent: 'claude', outside: true, chats: 1 });
    expect(mapKey(state([]), outside, 20_000)).not.toBe(mapKey(state([]), [], 20_000));
  });
});

describe('the agent map', () => {
  const s = state(
    [
      chat('c1', { label: 'Claude 1', createdAt: 1, busy: true, items: [said], files: ['src/format.ts'] }),
      chat('c2', { label: 'Claude 2', createdAt: 2, group: 'g' }),
      chat('x1', { agent: 'codex', label: 'Codex 1', createdAt: 3, group: 'g', files: ['src/format.ts'] }),
      chat('g1', { agent: 'gemini', label: 'Gemini 1', createdAt: 4, group: 'g' }),
      chat('g2', { agent: 'gemini', label: 'Gemini 2', createdAt: 5, busy: true, origin: { kind: 'consult', chatId: 'c1', by: 'agent' } }),
      chat('x2', { agent: 'codex', label: 'Codex 2', createdAt: 6, origin: { kind: 'handoff', chatId: 'g2', by: 'user' } }),
      chat('c3', { label: 'Claude 3', createdAt: 7 }),
      chat('old', { label: 'Claude 4', archived: true, origin: { kind: 'handoff', chatId: 'c1', by: 'user' } }),
    ],
    [link({ id: 'k', from: 'c1', to: 'g2' }), link({ id: 'p', kind: 'pipe', from: 'c3', to: 'c1', count: 4 }), link({ id: 'gone', from: 'c1', to: 'old' })],
  );
  const map = mapLayout(s);
  const at = (id: string) => map.nodes.find((n) => n.chat.id === id)!;

  it('puts open chats in agent lanes and link columns, one row each', () => {
    expect(map.nodes.map((n) => n.chat.id).sort()).toEqual(['c1', 'c2', 'c3', 'g1', 'g2', 'x1', 'x2']);
    expect(map.lanes.map((l) => [l.agent, l.chats, l.working])).toEqual([
      ['claude', 3, 1],
      ['codex', 2, 0],
      ['gemini', 2, 1],
    ]);
    expect([at('c1').col, at('g2').col, at('x2').col, at('c3').col]).toEqual([0, 1, 2, 0]);
    expect(new Set(map.nodes.map((n) => n.y)).size).toBe(map.nodes.length);
    for (const n of map.nodes) {
      const lane = map.lanes.find((l) => l.agent === n.lane)!;
      expect(n.y).toBeGreaterThanOrEqual(lane.y);
      expect(n.y + MAP.nodeH).toBeLessThanOrEqual(lane.y + lane.h);
    }
    expect(map.columns.map((c) => c.title)).toEqual(['Started by you', '1 link away', '2 links away', 'Shared files']);
  });

  it('draws links between open chats, plus a missing origin link', () => {
    expect(map.edges.map((e) => [e.id, e.kind, e.flowing]).sort()).toEqual([
      ['k', 'consult', true],
      ['origin:x2', 'handoff', false],
      ['p', 'pipe', true],
    ]);
    expect(map.edges.find((e) => e.id === 'p')!.label).toBe('pipe · 4');
    // Forward edges leave the source's right side and enter the target's left side.
    const k = map.edges.find((e) => e.id === 'k')!;
    expect(k.d.startsWith(`M ${at('c1').x + MAP.nodeW} `)).toBe(true);
    expect(k.d.endsWith(`${at('g2').x} ${at('g2').cy}`)).toBe(true);
  });

  it('brackets the fan-out group and branches You to every chat you started', () => {
    expect(map.groups).toHaveLength(1);
    const g = map.groups[0];
    expect(g.size).toBe(3);
    expect(g.members).toEqual([at('c2').cy, at('x1').cy, at('g1').cy].sort((a, b) => a - b));
    expect(map.nodes.some((n) => n.cy === g.joinY)).toBe(false);
    // c1 and c3 directly, the group through its bracket (one branch plus three ticks).
    expect(map.starts).toHaveLength(2 + 1 + 3);
    expect(map.trunk.y2).toBeGreaterThan(map.trunk.y1);
  });

  it('adds a shared-file node to the right of every chat that touched it', () => {
    expect(map.conflicts).toHaveLength(1);
    const f = map.conflicts[0];
    expect(f).toMatchObject({ file: 'src/format.ts', chats: ['c1', 'x1'] });
    expect(f.lines).toHaveLength(2);
    expect(Math.min(...map.nodes.map((n) => f.x - n.x))).toBeGreaterThan(MAP.nodeW);
    expect(map.width).toBeGreaterThanOrEqual(f.x + MAP.fileW);
    expect(map.height).toBeGreaterThan(Math.max(...map.nodes.map((n) => n.y + MAP.nodeH)));
  });

  it('is deterministic and handles an empty state', () => {
    expect(mapLayout(s)).toEqual(map);
    const empty = mapLayout(state([]));
    expect(empty.nodes).toEqual([]);
    expect(empty.width).toBeGreaterThan(0);
  });

  it('keeps twenty chats in their lanes without overlap', () => {
    const many = state(Array.from({ length: 20 }, (_, i) => chat(`n${i}`, { agent: (['claude', 'codex', 'gemini', 'demo'] as const)[i % 4], createdAt: i })));
    const m = mapLayout(many);
    const sorted = [...m.nodes].sort((a, b) => a.y - b.y);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i].y - sorted[i - 1].y).toBeGreaterThanOrEqual(MAP.nodeH);
    expect(m.lanes).toHaveLength(4);
  });
});

describe('what views draw again', () => {
  const plan = (current: number): Item => ({
    kind: 'plan',
    entries: ['Read', 'Edit', 'Test'].map((content, i) => ({ content, status: i < current ? 'completed' : i === current ? 'in_progress' : 'pending' })),
  });
  const working = chat('a', { label: 'Claude 1', busy: true, items: [said, plan(0), { kind: 'agent', text: 'Looking' }], files: ['src/a.ts'] });
  const s = state([working, chat('b', { label: 'Claude 2', files: ['src/a.ts'] })], [link({ id: 'k', from: 'a', to: 'b' })]);
  const chunk = (st: AppState, text = ' around') => reduce(st, { t: 'update', chatId: 'a', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }, at: 99 });

  it('keeps a card the same while its agent only streams text', () => {
    const before = cardModel(s, s.chats[0], 0);
    const after = chunk(s);
    expect(after.chats[0]).not.toBe(s.chats[0]);
    expect(cardModel(after, after.chats[0], 0).key).toBe(before.key);
    expect(before).toMatchObject({ status: 'working', line: { text: 'Step 1 of 3: Read' }, conflicts: [{ file: 'src/a.ts' }], age: '0s' });
    expect(before.badges.map((b) => b.text)).toEqual(['asked Claude 2']);
  });

  it('changes the card when its step, status, age, links or another chat it names change', () => {
    const key = (st: AppState, now = 0) => cardModel(st, st.chats[0], now).key;
    const base = key(s);
    const next = reduce(s, { t: 'update', chatId: 'a', update: { sessionUpdate: 'plan', entries: [{ content: 'Read', status: 'completed', priority: 'medium' }, { content: 'Edit', status: 'in_progress', priority: 'medium' }] } });
    expect(key(next)).not.toBe(base);
    expect(key(reduce(s, { t: 'busy', chatId: 'a', busy: false }))).not.toBe(base);
    expect(key(s, 61_000)).not.toBe(base);
    expect(key(reduce(s, { t: 'unlink', linkId: 'k' }))).not.toBe(base);
    expect(key({ ...s, chats: [s.chats[0], { ...s.chats[1], label: 'Claude 9' }] })).not.toBe(base);
  });

  it('lays the map out again only when something it shows changes', () => {
    const base = mapKey(s);
    expect(mapKey(chunk(s))).toBe(base);
    expect(mapKey(reduce(s, { t: 'busy', chatId: 'a', busy: false }))).not.toBe(base);
    expect(mapKey(reduce(s, { t: 'files', chatId: 'b', files: ['src/b.ts'] }))).not.toBe(base);
    expect(mapKey(reduce(s, { t: 'title', chatId: 'b', title: 'Other' }))).not.toBe(base);
    expect(mapKey(reduce(s, { t: 'linkPatch', linkId: 'k', patch: { count: 2 } }))).not.toBe(base);
    // The same drawing: nodes differ only in the chat object they carry.
    const drawn = (st: AppState) => ({ ...mapLayout(st), nodes: mapLayout(st).nodes.map(({ chat: c, ...n }) => ({ ...n, id: c.id })) });
    expect(drawn(chunk(s))).toEqual(drawn(s));
  });

  it('moves cards and rows at most once a second, but shows new chats and another sort at once', () => {
    const first = settleOrder(undefined, ['a', 'b', 'c'], 'activity', 1000, 1000);
    expect(first).toEqual({ order: { ids: ['a', 'b', 'c'], sort: 'activity', at: 1000 }, pending: false });
    // A reorder after a quiet spell shows at once; the next one within the second waits.
    const moved = settleOrder(first.order, ['b', 'a', 'c'], 'activity', 2500, 1000);
    expect(moved).toEqual({ order: { ids: ['b', 'a', 'c'], sort: 'activity', at: 2500 }, pending: false });
    const soon = settleOrder(moved.order, ['c', 'b', 'a'], 'activity', 2900, 1000);
    expect(soon).toEqual({ order: moved.order, pending: true });
    expect(settleOrder(moved.order, ['b', 'a', 'c'], 'activity', 2900, 1000)).toEqual({ order: moved.order, pending: false });
    expect(settleOrder(soon.order, ['c', 'b', 'a'], 'activity', 3500, 1000).order.ids).toEqual(['c', 'b', 'a']);
    expect(settleOrder(moved.order, ['c', 'b', 'a', 'd'], 'activity', 2600, 1000).order.ids).toEqual(['c', 'b', 'a', 'd']);
    expect(settleOrder(moved.order, ['a', 'c'], 'activity', 2600, 1000).order.ids).toEqual(['a', 'c']);
    expect(settleOrder(moved.order, ['c', 'b', 'a'], 'task:asc', 2600, 1000).order.ids).toEqual(['c', 'b', 'a']);
    expect(settleOrder(moved.order, ['b', 'a', 'd'], 'activity', 2600, 1000).order.ids).toEqual(['b', 'a', 'd']);
  });

  it('names the chats in a roster that ignores what they stream', () => {
    expect(rosterKey(chunk(s).chats)).toBe(rosterKey(s.chats));
    expect(rosterKey(reduce(s, { t: 'title', chatId: 'a', title: 'Renamed' }).chats)).not.toBe(rosterKey(s.chats));
  });
});

describe('text', () => {
  it('clips and strips markdown for excerpts', () => {
    expect(clip('  a   b  ', 10)).toBe('a b');
    expect(clip('abcdefghij', 5)).toBe('abcd…');
    expect(excerpt('**Done.** See [the docs](http://x) and `x`.\n```\ncode\n```', 80)).toBe('Done. See the docs and x.');
  });
});

describe('"/" commands', () => {
  const agentCmds = [{ name: 'review', description: 'Agent review' }, { name: 'help', description: 'Help' }];

  it('adds FriedLiver’s own commands after the agent’s, and the agent’s win a shared name', () => {
    expect(slashMenu([]).map((c) => c.name)).toEqual(['handoff', 'ask', 'pipe', 'review', 'new']);
    const menu = slashMenu(agentCmds);
    expect(menu.map((c) => c.name)).toEqual(['review', 'help', 'handoff', 'ask', 'pipe', 'new']);
    expect(menu[0].description).toBe('Agent review');
  });

  it('turns a FriedLiver command into its action, and leaves the agent’s own alone', () => {
    const me = chat('a', { agent: 'claude' });
    const codex = chat('b', { agent: 'codex', lastActivity: 5 });
    const all = [me, chat('c', { agent: 'codex', lastActivity: 1 }), codex];
    expect(slashAction('/handoff codex', me, all, [])).toEqual({ type: 'handoff', chatId: 'a', agent: 'codex' });
    expect(slashAction('/ask gemini why?', me, all, [])).toEqual({ type: 'consult', chatId: 'a', agent: 'gemini', text: 'why?' });
    expect(slashAction('/pipe codex', me, all, [])).toEqual({ type: 'pipe', from: 'a', to: 'b' });
    expect(slashAction('/review', me, all, [])).toEqual({ type: 'viewChanges', chatId: 'a' });
    expect(slashAction('/new', me, all, [])).toEqual({ type: 'newChat', agent: 'claude' });
    expect(slashAction('/new gemini', me, all, [])).toEqual({ type: 'newChat', agent: 'gemini' });
    // Not finished: no agent, no question, no chat to pipe to.
    expect(slashAction('/handoff', me, all, [])).toBe('incomplete');
    expect(slashAction('/ask codex', me, all, [])).toBe('incomplete');
    expect(slashAction('/pipe gemini', me, all, [])).toBe('incomplete');
    // The agent's /review, and anything else, go to the agent as typed.
    expect(slashAction('/review', me, all, agentCmds)).toBeNull();
    expect(slashAction('/help', me, all, agentCmds)).toBeNull();
    expect(slashAction('hello', me, all, [])).toBeNull();
  });
});

describe('a starting agent', () => {
  it('says so on the card until the session is live', () => {
    const starting = chat('a', { agent: 'codex', session: { options: [], commands: [], live: false, starting: true } });
    expect(cardLine(state([starting]), starting).text).toBe('Starting Codex…');
    const started = { ...starting, session: { ...starting.session!, live: true, starting: false } };
    expect(cardLine(state([started]), started).text).not.toContain('Starting');
  });
});

describe('status groups', () => {
  const failed: Item = { kind: 'notice', tone: 'error', text: 'boom' };
  const chats = [
    chat('done-old', { items: [said], lastActivity: 1 }),
    chat('idle', { lastActivity: 9 }),
    chat('err', { items: [said, failed], lastActivity: 3 }),
    chat('done-new', { items: [said], lastActivity: 7 }),
    chat('work', { items: [said], busy: true, lastActivity: 2 }),
    chat('wait', { items: [said, waiting], lastActivity: 4 }),
  ];
  it('orders Needs you, Working, Problem, Idle, Done, most recent first within each', () => {
    const groups = statusGroups(chats);
    expect(groups.map((g) => [g.title, g.chats.length])).toEqual([
      ['Needs you', 1],
      ['Working', 1],
      ['Problem', 1],
      ['Idle', 1],
      ['Done', 2],
    ]);
    expect(groups[4].chats.map((c) => c.id)).toEqual(['done-new', 'done-old']);
  });
  it('leaves out empty groups unless asked to keep them', () => {
    expect(statusGroups([chats[0]]).map((g) => g.status)).toEqual(['done']);
    expect(statusGroups([chats[0]], true).map((g) => g.status)).toEqual(['needs-you', 'working', 'error', 'idle', 'done']);
  });
});

describe('map hover card placement', () => {
  const view = { w: 1000, h: 600 };
  const tip = { w: 288, h: 160 };
  const at = (left: number, top: number) => ({ left, top, right: left + 200, bottom: top + 44 });
  it('sits to the right of the node when it fits', () => {
    expect(tipPlace(at(100, 100), tip, view)).toEqual({ left: 312, top: 94, width: 288, side: 'right' });
  });
  it('flips to the left near the right edge', () => {
    expect(tipPlace(at(700, 100), tip, view)).toMatchObject({ left: 400, side: 'left' });
  });
  it('goes above when neither side fits, and stays inside the viewport', () => {
    const narrow = { w: 400, h: 600 };
    expect(tipPlace(at(100, 300), tip, narrow)).toEqual({ left: 100, top: 128, width: 288, side: 'above' });
    expect(tipPlace(at(100, 50), tip, narrow)).toEqual({ left: 100, top: 106, width: 288, side: 'below' });
  });
  it('never runs off the bottom or past a tiny viewport', () => {
    expect(tipPlace(at(100, 560), tip, view).top).toBe(600 - 160 - 4);
    expect(tipPlace(at(0, 0), tip, { w: 200, h: 100 })).toMatchObject({ left: 4, width: 192 });
  });
});

describe('the chat transcript', () => {
  const tool = (id: string): Item => ({ kind: 'tool', id, title: id, locations: [] });
  it('folds each run of consecutive tools into one card, numbered from 1', () => {
    const items: Item[] = [said, tool('a'), tool('b'), { kind: 'agent', text: 'hi' }, tool('c')];
    const groups = transcriptGroups(items);
    expect(groups.map((g) => (g.kind === 'steps' ? g.items.map((t) => t.id) : g.item.kind))).toEqual(['user', ['a', 'b'], 'agent', ['c']]);
    expect(groups.map((g) => g.at)).toEqual([0, 1, 3, 4]);
  });
  it('reads times and durations short', () => {
    expect(shortDuration(340)).toBe('340ms');
    expect(shortDuration(1400)).toBe('1s');
    expect(shortDuration(125_000)).toBe('2m 5s');
  });
  it('heads a step box with what the steps did, how many and how long', () => {
    const b = (id: string, ms: number) => ({ ...(tool(id) as Extract<Item, { kind: 'tool' }>), title: `mcp__friedliver__browser_${id}`, ms });
    expect(stepsHeading([b('open', 1200), b('click', 3100), b('click', 2000), b('screenshot', 900)])).toBe('Used the browser · 4 steps · 7s');
    expect(stepsHeading([{ ...(tool('x') as Extract<Item, { kind: 'tool' }>), cmd: { line: 'ls' } }])).toBe('Ran commands · 1 step');
    expect(stepsHeading([tool('a') as Extract<Item, { kind: 'tool' }>, tool('b') as Extract<Item, { kind: 'tool' }>])).toBe('Used tools · 2 steps');
  });
  it('says where a chat stands and when it last moved', () => {
    expect(switcherMeta(chat('x', { items: [said, waiting], lastActivity: 1000 }), 43_000)).toBe('Needs you · 42s ago');
  });
});
