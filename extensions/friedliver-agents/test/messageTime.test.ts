// When a message was sent: only your messages, the agent's replies and messages
// between chats carry a time on hover; steps, thinking, plans and notices don't.
import { describe, expect, it } from 'vitest';
import { parseSaved, saveText, type SavedState } from '../src/host/persist';
import { EMPTY_STATE, reduce, type Action, type AppState, type ChatView, type Item } from '../src/shared/model';
import { messageStamp, messageTime, messageTimeTitle } from '../src/shared/view';

const chat = (over: Partial<ChatView> = {}): ChatView => ({
  id: 'chat-1',
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
const run = (actions: Action[], start: AppState = EMPTY_STATE) => actions.reduce(reduce, start);
const chunk = (text: string, at: number, sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk' = 'agent_message_chunk'): Action => ({
  t: 'update',
  chatId: 'chat-1',
  update: { sessionUpdate, content: { type: 'text', text } },
  at,
});
const link: Item = { kind: 'link', linkId: 'l1', role: 'reply', chatId: 'chat-2', agent: 'demo', label: 'Demo', text: 'The answer', by: 'agent' };

describe('which items keep a time', () => {
  const s = run([
    { t: 'created', chat: chat() },
    { t: 'items', chatId: 'chat-1', items: [{ kind: 'user', text: 'Fix it', images: [] }], at: 1000 },
    chunk('Thinking it over', 1500, 'agent_thought_chunk'),
    chunk('Looking', 2000),
    chunk(' at it.', 5000),
    { t: 'update', chatId: 'chat-1', update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read a.ts', kind: 'read', status: 'completed' }, at: 6000 },
    { t: 'update', chatId: 'chat-1', update: { sessionUpdate: 'plan', entries: [{ content: 'Do it', status: 'pending', priority: 'medium' }] }, at: 6500 },
    chunk('Done.', 7000),
    chunk(' All of it.', 9500),
    { t: 'items', chatId: 'chat-1', items: [link, { kind: 'notice', tone: 'info', text: 'Stopped.' }], at: 10_000 },
  ]);
  const items = s.chats[0].items;
  const byKind = (k: Item['kind']) => items.filter((i) => i.kind === k);

  it('stamps your message when it was sent', () => {
    expect(messageStamp(byKind('user')[0])).toEqual({ at: 1000 });
  });
  it('stamps each reply text block when it began and when its last words came', () => {
    expect(byKind('agent').map(messageStamp)).toEqual([
      { at: 2000, end: 5000 },
      { at: 7000, end: 9500 },
    ]);
  });
  it('stamps a message between chats (an answer, a hand-off)', () => {
    expect(messageStamp(byKind('link')[0])).toEqual({ at: 10_000 });
  });
  it('gives steps, thinking, plans and notices none', () => {
    for (const k of ['thought', 'tool', 'plan', 'notice'] as const) {
      expect(byKind(k)).toHaveLength(1);
      expect(messageStamp(byKind(k)[0]), k).toBeUndefined();
    }
  });
  it('shows nothing for a message saved before times were kept', () => {
    expect(messageStamp({ kind: 'user', text: 'old', images: [] })).toBeUndefined();
    expect(messageStamp({ kind: 'agent', text: 'old' })).toBeUndefined();
    expect(messageStamp({ ...link })).toBeUndefined();
    // A file edited by hand: a time that isn't a number is no time.
    expect(messageStamp({ kind: 'agent', text: 'x', at: 'noon' } as unknown as Item)).toBeUndefined();
    expect(messageStamp({ kind: 'agent', text: 'x', at: 5, end: 'later' } as unknown as Item)).toEqual({ at: 5 });
    expect(messageStamp({ kind: 'user', text: 'x', images: [], at: 1e20 })).toBeUndefined();
  });
});

describe('a time survives saving and restoring', () => {
  it('round-trips, and old items stay without one', () => {
    const items: Item[] = [
      { kind: 'user', text: 'Fix it', images: [], at: 1000 },
      { kind: 'agent', text: 'Done.', at: 2000, end: 4000 },
      { ...link, at: 5000 },
      { kind: 'user', text: 'old', images: [] },
      { kind: 'agent', text: 'old reply' },
    ];
    const saved: SavedState = { version: 1, state: { ...EMPTY_STATE, chats: [chat({ items })] }, chats: { 'chat-1': { agent: 'demo', cwd: '/w' } }, nextId: 2, chatCount: { demo: 1 } };
    const back = parseSaved(JSON.parse(saveText(saved)))!;
    expect(back.state.chats[0].items.map(messageStamp)).toEqual([{ at: 1000 }, { at: 2000, end: 4000 }, { at: 5000 }, undefined, undefined]);
  });
});

describe('how a time reads', () => {
  const now = new Date(2026, 9, 19, 18, 5).getTime();
  it('today: just the time', () => {
    expect(messageTime(new Date(2026, 9, 19, 14, 41).getTime(), now, 'en-US')).toBe('2:41 PM');
    expect(messageTime(new Date(2026, 9, 19, 0, 3).getTime(), now, 'en-US')).toBe('12:03 AM');
  });
  it('an earlier day: the date and the time', () => {
    expect(messageTime(new Date(2026, 9, 18, 14, 41).getTime(), now, 'en-US')).toBe('Oct 18, 2:41 PM');
    expect(messageTime(new Date(2026, 0, 2, 9, 7).getTime(), now, 'en-US')).toBe('Jan 2, 9:07 AM');
  });
  it('another year: the year too', () => {
    expect(messageTime(new Date(2025, 9, 18, 14, 41).getTime(), now, 'en-US')).toBe('Oct 18, 2025, 2:41 PM');
  });
  it('the tooltip: the full ISO time, and for a reply how long it took', () => {
    const at = Date.UTC(2026, 9, 19, 9, 11, 0);
    expect(messageTimeTitle({ at })).toBe('2026-10-19T09:11:00.000Z');
    expect(messageTimeTitle({ at, end: at + 72_000 })).toBe('2026-10-19T09:11:00.000Z · took 1m 12s');
    expect(messageTimeTitle({ at, end: at + 2500 })).toBe('2026-10-19T09:11:00.000Z · took 2.5 s');
    // One chunk: it took no time worth saying.
    expect(messageTimeTitle({ at, end: at })).toBe('2026-10-19T09:11:00.000Z');
  });
});
