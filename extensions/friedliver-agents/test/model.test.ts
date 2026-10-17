import { describe, expect, it } from 'vitest';
import {
  EMPTY_STATE,
  MAX_IMAGE_CHARS,
  age,
  boardColumn,
  chatStatus,
  decisions,
  lineStats,
  reduce,
  shortCommand,
  stateLine,
  titleFrom,
  topicTitle,
  waitingItems,
  type Action,
  type AppState,
  type ChatView,
} from '../src/shared/model';

const chat = (over: Partial<ChatView> = {}): ChatView => ({
  id: 'chat-1',
  depth: 0,
  files: [],
  lastActivity: 0,
  turns: 0,
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

  it("keeps Claude's tool name and a subagent's parent tool call", () => {
    const meta = (claudeCode: object) => ({ _meta: { claudeCode } });
    const s = run([
      { t: 'created', chat: chat() },
      { t: 'update', chatId: 'chat-1', update: { sessionUpdate: 'tool_call', toolCallId: 'task', title: 'Find it', kind: 'think', status: 'pending', rawInput: { description: 'Find it', prompt: 'p', subagent_type: 'Explore' }, ...meta({ toolName: 'Task' }) } },
      { t: 'update', chatId: 'chat-1', update: { sessionUpdate: 'tool_call', toolCallId: 'inner', title: 'Read', status: 'pending', ...meta({ toolName: 'Read', parentToolUseId: 'task' }) } },
      { t: 'update', chatId: 'chat-1', update: { sessionUpdate: 'tool_call_update', toolCallId: 'task', status: 'completed', ...meta({ toolName: 'Task' }) } },
    ]);
    expect(s.chats[0].items).toMatchObject([
      { kind: 'tool', id: 'task', tool: 'Task', status: 'completed' },
      { kind: 'tool', id: 'inner', tool: 'Read', parent: 'task' },
    ]);
  });

  it("keeps a subagent's own words out of the chat's reply", () => {
    const sub = { _meta: { claudeCode: { parentToolUseId: 'task' } } };
    const s = run([
      { t: 'created', chat: chat() },
      { t: 'update', chatId: 'chat-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Spawning. ' } } },
      { t: 'update', chatId: 'chat-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'inner chatter' }, ...sub } },
      { t: 'update', chatId: 'chat-1', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'inner thought' }, ...sub } },
      { t: 'update', chatId: 'chat-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } } },
    ]);
    expect(s.chats[0].items).toMatchObject([{ kind: 'agent', text: 'Spawning. Done.' }]);
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

  it('keeps the newest images that fit in the size cap, and always the newest one', () => {
    const big = (id: string) => ({ id, src: 'x'.repeat(MAX_IMAGE_CHARS / 2 - 1), title: id, from: 'agent' as const });
    expect(run([{ t: 'image', image: big('a') }, { t: 'image', image: big('b') }]).images.map((i) => i.id)).toEqual(['a', 'b']);
    expect(run([{ t: 'image', image: big('a') }, { t: 'image', image: big('b') }, { t: 'image', image: big('c') }]).images.map((i) => i.id)).toEqual(['b', 'c']);
    const huge = { id: 'h', src: 'x'.repeat(MAX_IMAGE_CHARS + 1), title: 'h', from: 'agent' as const };
    expect(run([{ t: 'image', image: big('a') }, { t: 'image', image: huge }]).images.map((i) => i.id)).toEqual(['h']);
  });
});

describe('reducer fast paths', () => {
  const command = (id: string) => ({ kind: 'command' as const, commandId: id, commandLine: 'npm test', cwd: '/w', outside: false, state: 'running' as const, output: '' });
  const three = run([
    { t: 'created', chat: chat({ id: 'a', items: [{ kind: 'agent', text: 'hi' }, command('cmd-a')] }) },
    { t: 'created', chat: chat({ id: 'b', items: [command('cmd-b'), { kind: 'agent', text: 'hey' }] }) },
    { t: 'created', chat: chat({ id: 'c' }) },
  ]);

  it('copies only the chat and the item that command output changes', () => {
    const next = reduce(three, { t: 'commandOutput', commandId: 'cmd-b', data: 'ok\n' });
    expect(next.chats[0]).toBe(three.chats[0]);
    expect(next.chats[2]).toBe(three.chats[2]);
    expect(next.chats[1].items[0]).toMatchObject({ output: 'ok\n' });
    expect(next.chats[1].items[1]).toBe(three.chats[1].items[1]);
    expect(three.chats[1].items[0]).toMatchObject({ output: '' });
    expect(next.links).toBe(three.links);
  });

  it('gives the same state back when no item matches', () => {
    expect(reduce(three, { t: 'commandOutput', commandId: 'cmd-x', data: 'ok' })).toBe(three);
    expect(reduce(three, { t: 'permissionAnswered', requestId: 'perm-x', answer: 'Allow' })).toBe(three);
  });

  it('scans a transcript for decisions once until it changes', () => {
    const asking = chat({ items: [{ kind: 'agent', text: 'hi' }, { ...command('cmd-1'), state: 'awaiting' }] });
    const first = waitingItems(asking.items);
    expect(first).toHaveLength(1);
    expect(waitingItems(asking.items)).toBe(first);
    const s = run([{ t: 'created', chat: asking }, { t: 'update', chatId: 'chat-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '!' } } }]);
    expect(waitingItems(s.chats[0].items)).not.toBe(first);
    expect(decisions(s)).toEqual([{ chatId: 'chat-1', kind: 'command', id: 'cmd-1', title: 'Run npm test' }]);
    const answered = reduce(s, { t: 'command', commandId: 'cmd-1', patch: { state: 'running' } });
    expect(decisions(answered)).toEqual([]);
    expect(chatStatus(answered.chats[0])).toBe('idle');
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

describe('chat titles from the topic', () => {
  it('names a chat after a substantive request, short and in sentence case', () => {
    expect(topicTitle('add auto-update for releases')).toBe('Add auto-update for releases');
    expect(topicTitle('Hi! Can you please fix the browser approval prompts? They keep popping up.')).toBe('Fix browser approval prompts');
    expect(topicTitle('@claude refactor the payroll export so it streams rows to disk instead')).toBe('Refactor payroll export so it streams');
    expect(topicTitle('make the PR list load faster.')).toBe('Make PR list load faster');
  });

  it('skips greetings, acknowledgements, slash and shell commands', () => {
    for (const t of ['hi', 'ok', 'go', 'merge', 'yes', 'yes go ahead', 'ok merge it', 'thanks!', 'sounds good, go ahead please', '/review', 'git push origin main', '$ ls -la', 'npm test', '']) {
      expect(topicTitle(t), t).toBeNull();
    }
  });

  it('keeps a pinned (renamed) title and ignores later automatic ones', () => {
    let s = reduce(EMPTY_STATE, { t: 'created', chat: chat() });
    s = reduce(s, { t: 'title', chatId: 'chat-1', title: 'First topic' });
    expect(s.chats[0].title).toBe('First topic');
    s = reduce(s, { t: 'title', chatId: 'chat-1', title: 'My name', pinned: true });
    s = reduce(s, { t: 'title', chatId: 'chat-1', title: 'Second topic' });
    s = reduce(s, { t: 'update', chatId: 'chat-1', update: { sessionUpdate: 'session_info_update', title: 'Agent title' } });
    expect(s.chats[0]).toMatchObject({ title: 'My name', titlePinned: true });
  });

  it("takes the agent's own session title while not pinned", () => {
    let s = reduce(EMPTY_STATE, { t: 'created', chat: chat() });
    s = reduce(s, { t: 'update', chatId: 'chat-1', update: { sessionUpdate: 'session_info_update', title: 'Agent title' } });
    expect(s.chats[0].title).toBe('Agent title');
  });
});
