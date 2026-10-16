import { describe, expect, it } from 'vitest';
import {
  EMPTY_STATE,
  age,
  boardColumn,
  chatStatus,
  decisions,
  lineStats,
  reduce,
  shortCommand,
  stateLine,
  titleFrom,
  type Action,
  type AppState,
  type ChatView,
} from '../src/shared/model';

const chat = (over: Partial<ChatView> = {}): ChatView => ({
  id: 'chat-1',
  agent: 'demo',
  label: 'Demo',
  title: 'New chat',
  cwd: '/w',
  createdAt: 0,
  busy: false,
  changedFiles: 0,
  items: [],
  ...over,
});

const run = (actions: Action[], start: AppState = EMPTY_STATE) => actions.reduce(reduce, start);

describe('transcript reducer', () => {
  it('joins streamed text chunks and keeps one live plan per turn', () => {
    const s = run([
      { t: 'created', chat: chat() },
      { t: 'items', chatId: 'chat-1', items: [{ kind: 'user', text: 'hi', images: [] }] },
      { t: 'update', chatId: 'chat-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hel' } } },
      { t: 'update', chatId: 'chat-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'lo' } } },
      { t: 'update', chatId: 'chat-1', update: { sessionUpdate: 'plan', entries: [{ content: 'a', priority: 'medium', status: 'in_progress' }] } },
      { t: 'update', chatId: 'chat-1', update: { sessionUpdate: 'plan', entries: [{ content: 'a', priority: 'medium', status: 'completed' }] } },
    ]);
    const items = s.chats[0].items;
    expect(items.map((i) => i.kind)).toEqual(['user', 'agent', 'plan']);
    expect(items[1]).toEqual({ kind: 'agent', text: 'Hello' });
    expect(items[2]).toMatchObject({ entries: [{ status: 'completed' }] });
  });

  it('updates tool calls in place', () => {
    const s = run([
      { t: 'created', chat: chat() },
      { t: 'update', chatId: 'chat-1', update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read', status: 'pending' } },
      { t: 'update', chatId: 'chat-1', update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' } },
    ]);
    expect(s.chats[0].items).toEqual([{ kind: 'tool', id: 't1', title: 'Read', toolKind: undefined, status: 'completed', locations: [] }]);
  });

  it('tracks commands, output and exit', () => {
    const s = run([
      { t: 'created', chat: chat({ busy: true }) },
      {
        t: 'items',
        chatId: 'chat-1',
        items: [{ kind: 'command', commandId: 'cmd-1', commandLine: 'npm test', cwd: '/w', outside: false, state: 'awaiting', output: '' }],
      },
    ]);
    expect(decisions(s)).toEqual([{ chatId: 'chat-1', kind: 'command', id: 'cmd-1', title: 'Run npm test' }]);
    expect(chatStatus(s.chats[0])).toBe('needs-you');
    expect(stateLine(s.chats[0])).toMatchObject({ text: 'Wants to run a command', code: 'npm test' });

    const after = run(
      [
        { t: 'command', commandId: 'cmd-1', patch: { state: 'running', startedAt: 1 } },
        { t: 'commandOutput', commandId: 'cmd-1', data: 'ok\n' },
        { t: 'command', commandId: 'cmd-1', patch: { state: 'exited', exitCode: 0, durationMs: 5 } },
      ],
      s,
    );
    expect(after.chats[0].items[0]).toMatchObject({ state: 'exited', exitCode: 0, output: 'ok\n', durationMs: 5 });
    expect(decisions(after)).toEqual([]);
    expect(chatStatus(after.chats[0])).toBe('working');
  });

  it('counts changed files and undoes them once', () => {
    const s = run([
      { t: 'created', chat: chat() },
      { t: 'changes', chatId: 'chat-1', turnId: 'turn-1', files: ['/w/a', '/w/b'] },
      { t: 'undone', chatId: 'chat-1', turnId: 'turn-1' },
      { t: 'undone', chatId: 'chat-1', turnId: 'turn-1' },
    ]);
    expect(s.chats[0].changedFiles).toBe(0);
    expect(s.chats[0].items[0]).toMatchObject({ undone: true });
  });

  it('ignores duplicate images', () => {
    const image = { id: 'i1', src: 'data:image/png;base64,AA==', title: 'x', from: 'agent' as const };
    expect(run([{ t: 'image', image }, { t: 'image', image }]).images).toHaveLength(1);
  });
});

describe('status and task cards', () => {
  it('moves from idle to working to done', () => {
    expect(chatStatus(chat())).toBe('idle');
    expect(chatStatus(chat({ busy: true }))).toBe('working');
    expect(chatStatus(chat({ items: [{ kind: 'user', text: 'x', images: [] }] }))).toBe('done');
    expect(chatStatus(chat({ items: [{ kind: 'notice', text: 'boom', tone: 'error' }] }))).toBe('error');
  });

  it('puts failures in the needs-you column', () => {
    expect(boardColumn('error')).toBe('needs-you');
    expect(boardColumn('needs-you')).toBe('needs-you');
    expect(boardColumn('working')).toBe('working');
    expect(boardColumn('idle')).toBe('done');
  });

  it('describes a pending edit and plan progress', () => {
    const review = chat({
      busy: true,
      items: [{ kind: 'review', reviewId: 'r1', path: '/w/src/app.ts', added: 3, removed: 1, isNew: false, state: 'pending' }],
    });
    expect(stateLine(review).text).toBe('Edit to review: app.ts +3 −1');
    const plan = chat({
      busy: true,
      items: [
        {
          kind: 'plan',
          entries: [
            { content: 'one', status: 'completed' },
            { content: 'two', status: 'in_progress' },
            { content: 'three', status: 'pending' },
            { content: 'four', status: 'pending' },
          ],
        },
      ],
    });
    expect(stateLine(plan).text).toBe('Step 2 of 4: two');
  });

  it('shortens titles and ages', () => {
    expect(titleFrom('fix it\nmore')).toBe('fix it');
    expect(titleFrom('x'.repeat(80))).toHaveLength(58);
    expect(age(0, 59_000)).toBe('59s');
    expect(age(0, 3 * 60_000)).toBe('3m');
    expect(age(0, 2 * 3600_000)).toBe('2h');
  });

  it('shortens command lines for notifications', () => {
    expect(shortCommand("/tmp/x/VSCode-linux-x64/code -e 'console.log(1)'")).toBe("code -e 'console.log(1)'");
    // An unquoted path with a space can't be told apart from arguments; leave it alone.
    expect(shortCommand('C:\\Program Files\\nodejs\\node.exe --test')).toBe('C:\\Program Files\\nodejs\\node.exe --test');
    expect(shortCommand('"C:\\tools\\bin\\npm.cmd" test')).toBe('"npm.cmd" test');
    expect(shortCommand('npm test')).toBe('npm test');
    expect(shortCommand('x'.repeat(100))).toHaveLength(80);
  });

  it('counts added and removed lines', () => {
    expect(lineStats(null, 'a\nb\n')).toEqual({ added: 2, removed: 0 });
    expect(lineStats('a\nb\nc\n', 'a\nB\nc\nd\n')).toEqual({ added: 2, removed: 1 });
    expect(lineStats('same\n', 'same\n')).toEqual({ added: 0, removed: 0 });
  });
});
