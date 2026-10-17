import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseSaved, SAVE_LIMITS, saveText, settleRestored, StateFile, trimForSave, type SavedState } from '../src/host/persist';
import { EMPTY_STATE, lastReply, type ChatView, type Item } from '../src/shared/model';
import { buildBridge, disposeCores, gitRepo, makeCore, waitFor } from './helpers';

afterEach(disposeCores);

const chat = (id: string, over: Partial<ChatView> = {}): ChatView => ({
  id,
  agent: 'demo',
  label: 'Demo',
  title: 'Task',
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
const saved = (chats: ChatView[]): SavedState => ({
  version: 1,
  state: { ...EMPTY_STATE, chats, images: [{ id: 'img', src: 'data:image/png;base64,AAAA', title: 'x', from: 'you' }] },
  chats: Object.fromEntries(chats.map((c) => [c.id, { agent: c.agent, cwd: c.cwd }])),
  nextId: 9,
  chatCount: { demo: chats.length },
});

describe('saving chats', () => {
  it('writes what JSON.stringify(trimForSave) would, turning only changed chats into text again', () => {
    const odd = '"quotes", \\ back\u0000slash, ünïcode, \u2028 and ' + JSON.stringify(['\u0000friedliver:chats\u0000']);
    const set = saved([
      chat('chat-1', { title: odd, items: [{ kind: 'agent', text: odd }], lastActivity: 1 }),
      chat('chat-2', { archived: true, items: [{ kind: 'agent', text: 'y'.repeat(1000) }], lastActivity: 2 }),
      chat('chat-3', { items: [{ kind: 'user', text: 'z', images: ['img'] }], lastActivity: 3 }),
    ]);
    set.state.links = [{ id: 'link-1', kind: 'pipe', from: 'chat-1', to: 'chat-3', by: 'user', createdAt: 0, active: true, count: 0 }];
    expect(saveText(set)).toBe(JSON.stringify(trimForSave(set)));
    expect(saveText(set, 1600)).toBe(JSON.stringify(trimForSave(set, 1600)));
    expect(JSON.parse(saveText(set)).state.chats[0].title).toBe(odd);
    // One chat changes, as the reducer changes it: a new object; the others are the same.
    const next = { ...set, state: { ...set.state, chats: [set.state.chats[0], set.state.chats[1], { ...set.state.chats[2], title: 'Renamed' }] } };
    expect(saveText(next)).toBe(JSON.stringify(trimForSave(next)));
    expect(saveText(saved([]))).toBe(JSON.stringify(trimForSave(saved([]))));
  });

  it('keeps recent items, short output and no images, and drops the oldest archived chats when too big', () => {
    const many: Item[] = Array.from({ length: 450 }, (_, n) => ({ kind: 'agent', text: `m${n}` }));
    const big = chat('chat-1', {
      items: [...many, { kind: 'user', text: 'look', images: ['img'] }, { kind: 'command', commandId: 'cmd-1', commandLine: 'ls', cwd: '/w', outside: false, state: 'exited', output: 'x'.repeat(20_000) }],
    });
    const out = trimForSave(saved([big]));
    const items = out.state.chats[0].items;
    expect(items).toHaveLength(SAVE_LIMITS.items);
    expect(items.at(-2)).toEqual({ kind: 'user', text: 'look', images: [] });
    expect(items.at(-1)).toMatchObject({ output: 'x'.repeat(SAVE_LIMITS.output) });
    expect(out.state.images).toEqual([]);
    const long = trimForSave(saved([chat('chat-1', { items: [{ kind: 'agent', text: 'z'.repeat(SAVE_LIMITS.text + 10) }] })]));
    expect(long.state.chats[0].items[0]).toMatchObject({ text: expect.stringMatching(/^z+\n\n\[Shortened when saved\.\]$/) });

    const pad: Item[] = [{ kind: 'agent', text: 'y'.repeat(1000) }];
    const set = saved([
      chat('chat-1', { items: pad, lastActivity: 1, archived: true }),
      chat('chat-2', { items: pad, lastActivity: 2 }),
      chat('chat-3', { items: pad, lastActivity: 3, archived: true }),
    ]);
    expect(trimForSave(set, 2900).state.chats.map((c) => c.id)).toEqual(['chat-2', 'chat-3']);
    expect(trimForSave(set, 1600).state.chats.map((c) => c.id)).toEqual(['chat-2']);
  });

  it('closes everything that was waiting when the window closed', () => {
    const items: Item[] = [
      { kind: 'permission', requestId: 'perm-1', title: 'Edit', options: [] },
      { kind: 'review', reviewId: 'review-1', path: '/w/a', added: 1, removed: 0, isNew: true, state: 'pending' },
      { kind: 'command', commandId: 'cmd-1', commandLine: 'ls', cwd: '/w', outside: false, state: 'awaiting', output: '' },
      { kind: 'command', commandId: 'cmd-2', commandLine: 'sleep 9', cwd: '/w', outside: false, state: 'running', output: '' },
      { kind: 'bridge', requestId: 'bridge-1', tool: 'read_chat', target: { chatId: 'chat-2' }, text: '', state: 'awaiting' },
    ];
    const [c, idle] = settleRestored({ ...EMPTY_STATE, chats: [chat('chat-1', { busy: true, items }), chat('chat-2', { items: [{ kind: 'agent', text: 'hi' }] })] }).chats;
    expect(c.busy).toBe(false);
    expect(c.items.map((i) => ('answer' in i ? i.answer : 'state' in i ? i.state : i.kind))).toEqual([
      'Stopped when the window closed',
      'rejected',
      'denied',
      'exited',
      'denied',
      'notice',
    ]);
    expect(idle.items).toEqual([{ kind: 'agent', text: 'hi' }]);
  });

  it('reads back only files that make sense', () => {
    expect(parseSaved({ version: 2 })).toBeNull();
    expect(parseSaved('nope')).toBeNull();
    const ok = parseSaved(JSON.parse(JSON.stringify(saved([chat('chat-1'), chat('../bad')]))));
    expect(ok?.state.chats.map((c) => c.id)).toEqual(['chat-1']);
  });
});

describe('restoring chats', () => {
  it('brings chats back in a new window, with what was waiting closed, and carries on', async () => {
    const dir = await gitRepo();
    const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'fl-store-')), 'chats.json');
    const bridgeScript = await buildBridge();

    const first = makeCore(dir, { bridgeScript, apiKey: () => 'sk-never-saved', ui: { showReview: () => {}, closeReview: () => {} } });
    const a = await first.createChat('demo');
    await first.send(a.id, 'hello');
    const b = await first.handoff(a.id, 'claude');
    void first.send(a.id, `edit ${path.join(dir, 'x.txt')}`);
    await waitFor(() => first.decisions().length === 1);
    const store = new StateFile(file, () => first.exportState());
    await store.flush();
    const json = await readFile(file, 'utf8');
    expect(json).not.toContain('sk-never-saved');
    expect(json).not.toMatch(/[0-9a-f]{64}/);
    await first.dispose();

    const second = makeCore(dir);
    const loaded = await new StateFile(file, () => second.exportState()).load();
    second.restore(loaded!);
    expect(second.snapshot.chats.map((c) => c.id)).toEqual([a.id, b.id]);
    expect(second.snapshot.links).toEqual([expect.objectContaining({ kind: 'handoff', from: a.id, to: b.id })]);
    const restored = second.chat(a.id)!;
    expect(restored.busy).toBe(false);
    expect(restored.items.find((i) => i.kind === 'permission')).toMatchObject({ answer: 'Stopped when the window closed' });
    expect(restored.items.at(-1)).toMatchObject({ kind: 'notice', text: 'Stopped when the window closed.' });
    expect(second.decisions()).toEqual([]);

    // The demo agent can't reload sessions, so the chat says it starts a new one.
    await second.send(a.id, 'again');
    expect(lastReply(second.chat(a.id)!)).toBe('You said: again');
    expect(second.chat(a.id)!.items.some((i) => i.kind === 'notice' && i.text.includes('continues in a new session'))).toBe(true);
    // The hand-off context nobody sent yet survived the restart.
    await second.send(b.id, 'go on');
    expect(lastReply(second.chat(b.id)!)).toContain('taking over a task');
    const c = await second.createChat('demo');
    expect([a.id, b.id]).not.toContain(c.id);
    expect(c.label).toBe('Demo 2');
  });

  it('continues a session started outside FriedLiver', async () => {
    const before = process.env.FAKE_AGENT_LOAD_SESSION;
    process.env.FAKE_AGENT_LOAD_SESSION = '1';
    try {
      const dir = await gitRepo();
      const core = makeCore(dir);
      const a = await core.createChat('demo', { resume: { sessionId: 'outside-1', cwd: dir }, title: 'From the CLI' });
      expect(a.cwd).toBe(dir);
      await core.send(a.id, 'again');
      expect(lastReply(core.chat(a.id)!)).toBe('You said: again');
      expect(core.exportState().chats[a.id].sessionId).toBe('outside-1');
      // Only the "continues" notice: no "continues in a new session" one.
      expect(core.chat(a.id)!.items.filter((i) => i.kind === 'notice').map((i) => (i.kind === 'notice' ? i.text : ''))).toEqual([
        expect.stringContaining('Continues Claude Code session outside-1'),
      ]);
    } finally {
      if (before === undefined) delete process.env.FAKE_AGENT_LOAD_SESSION;
      else process.env.FAKE_AGENT_LOAD_SESSION = before;
    }
  });

  it('reloads the old session when the agent can', async () => {
    const before = process.env.FAKE_AGENT_LOAD_SESSION;
    process.env.FAKE_AGENT_LOAD_SESSION = '1';
    try {
      const dir = await gitRepo();
      const first = makeCore(dir);
      const a = await first.createChat('demo');
      await first.send(a.id, 'hello');
      const state = JSON.parse(JSON.stringify(first.exportState()));
      expect(state.chats[a.id].sessionId).toBe('fake-session-1');
      await first.dispose();

      const second = makeCore(dir);
      second.restore(parseSaved(state)!);
      await second.send(a.id, 'again');
      expect(lastReply(second.chat(a.id)!)).toBe('You said: again');
      expect(second.chat(a.id)!.items.some((i) => i.kind === 'notice')).toBe(false);
    } finally {
      if (before === undefined) delete process.env.FAKE_AGENT_LOAD_SESSION;
      else process.env.FAKE_AGENT_LOAD_SESSION = before;
    }
  });
});
