// Rewind outside the agent: the transcript's checkpoints, the webview message,
// and the menus and dialogs of "Rewind to here".
import { describe, expect, it } from 'vitest';
import { runRewind, type RewindHost, type RewindUi } from '../src/host/rewindFlow';
import { parseWebviewMessage } from '../src/shared/messages';
import { EMPTY_STATE, reduce, type AppState, type ChatView, type Item } from '../src/shared/model';

const chat = (items: Item[]): ChatView =>
  ({ id: 'chat-1', agent: 'demo', label: 'Demo', title: 't', cwd: '/w', createdAt: 0, busy: false, changedFiles: 2, items, depth: 0, files: [], lastActivity: 0, turns: 2 }) as ChatView;

describe('transcript checkpoints', () => {
  const user = (text: string): Item => ({ kind: 'user', text, images: [] });
  let state: AppState = { ...EMPTY_STATE, chats: [chat([user('first')])] };

  it('marks the message a turn started, cuts the conversation back to it, and drops gone ones', () => {
    state = reduce(state, { t: 'checkpoint', chatId: 'chat-1', turnId: 'turn-1' });
    state = reduce(state, { t: 'items', chatId: 'chat-1', items: [{ kind: 'agent', text: 'ok' }] });
    state = reduce(state, { t: 'changes', chatId: 'chat-1', turnId: 'turn-1', files: ['/w/a'] });
    // A turn with no new message (a consultation) marks nothing.
    state = reduce(state, { t: 'checkpoint', chatId: 'chat-1', turnId: 'turn-x' });
    state = reduce(state, { t: 'items', chatId: 'chat-1', items: [user('second')] });
    state = reduce(state, { t: 'checkpoint', chatId: 'chat-1', turnId: 'turn-2' });
    const marks = () => state.chats[0].items.flatMap((i) => (i.kind === 'user' ? [i.checkpoint] : []));
    expect(marks()).toEqual(['turn-1', 'turn-2']);

    const gone = reduce(state, { t: 'checkpointsGone', chatId: 'chat-1', turnIds: ['turn-1'] });
    expect(gone.chats[0].items.flatMap((i) => (i.kind === 'user' ? [i.checkpoint] : []))).toEqual([undefined, 'turn-2']);

    const cut = reduce(state, { t: 'rewound', chatId: 'chat-1', turnId: 'turn-2' });
    expect(cut.chats[0].items.map((i) => i.kind)).toEqual(['user', 'agent', 'changes']);
    const all = reduce(state, { t: 'rewound', chatId: 'chat-1', turnId: 'turn-1' });
    expect(all.chats[0].items).toEqual([]);
    expect(all.chats[0].changedFiles).toBe(state.chats[0].changedFiles - 1);
  });

  it('accepts a rewind message only with well-formed ids', () => {
    expect(parseWebviewMessage({ type: 'rewind', chatId: 'chat-1', turnId: 'turn-2' })).toEqual({ type: 'rewind', chatId: 'chat-1', turnId: 'turn-2' });
    expect(parseWebviewMessage({ type: 'rewind', chatId: 'chat-1' })).toEqual({ type: 'rewind', chatId: 'chat-1' });
    expect(parseWebviewMessage({ type: 'rewind', chatId: 'chat-1', turnId: 5 })).toBeNull();
    expect(parseWebviewMessage({ type: 'rewind' })).toBeNull();
  });
});

describe('Rewind to here', () => {
  function fakes(answers: unknown[], confirm = true) {
    const calls: unknown[] = [];
    const host: RewindHost = {
      checkpointList: () => [{ turnId: 'turn-1', text: 'make it blue', files: 2 }],
      rewindPlan: async () => ({
        turnId: 'turn-1',
        added: 4,
        removed: 6,
        files: [
          { file: 'a.ts', added: 1, removed: 3, conflict: false },
          { file: 'b.ts', added: 3, removed: 3, conflict: true },
        ],
      }),
      rewind: async (...args) => calls.push(args),
    };
    const seen: string[] = [];
    const ui: RewindUi = {
      pick: async (title, items) => {
        seen.push(`${title}: ${items.map((i) => i.label).join(' | ')}`);
        return answers.shift() as never;
      },
      confirm: async (message, detail) => {
        seen.push(`${message}\n${detail}`);
        return confirm;
      },
      info: (m) => seen.push(m),
    };
    return { host, ui, calls, seen };
  }

  it('offers the three restores, asks per changed file, and shows the diff summary before it rewinds', async () => {
    const f = fakes(['code', 'mine']);
    expect(await runRewind(f.host, f.ui, 'chat-1', 'turn-1')).toBe(true);
    expect(f.seen[0]).toBe('Rewind to here: Restore code and conversation | Restore code only | Restore conversation only');
    expect(f.seen[1]).toBe("b.ts changed after the agent's last turn: Keep mine | Use checkpoint");
    expect(f.seen[2]).toBe('Rewind to before “make it blue”?\n1 file, +1 −3:\na.ts  +1 −3');
    expect(f.calls).toEqual([['chat-1', 'turn-1', 'code', []]]);
  });

  it('restores your changed file only when you pick the checkpoint, and nothing without confirmation', async () => {
    const f = fakes(['both', 'checkpoint'], false);
    expect(await runRewind(f.host, f.ui, 'chat-1', 'turn-1')).toBe(false);
    expect(f.seen.at(-1)).toContain('2 files, +4 −6');
    expect(f.seen.at(-1)).toContain('new session');
    expect(f.calls).toEqual([]);

    const g = fakes(['turn-1', 'conversation']);
    expect(await runRewind(g.host, g.ui, 'chat-1')).toBe(true);
    expect(g.seen[0]).toContain('make it blue');
    expect(g.calls).toEqual([['chat-1', 'turn-1', 'conversation', []]]);
  });
});
