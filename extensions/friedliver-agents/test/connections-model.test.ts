import { describe, expect, it } from 'vitest';
import { parseWebviewMessage } from '../src/shared/messages';
import {
  EMPTY_STATE,
  decisions,
  fileConflicts,
  lastReply,
  linksOf,
  parseMention,
  reduce,
  type Action,
  type AppState,
  type ChatLink,
  type ChatView,
} from '../src/shared/model';

const chat = (id: string, over: Partial<ChatView> = {}): ChatView => ({
  id,
  agent: 'demo',
  label: 'Demo',
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
const link = (over: Partial<ChatLink> = {}): ChatLink => ({ id: 'link-1', kind: 'consult', from: 'chat-1', to: 'chat-2', by: 'user', createdAt: 0, active: true, count: 0, ...over });
const run = (actions: Action[], start: AppState = EMPTY_STATE) => actions.reduce(reduce, start);

describe('links between chats', () => {
  it('adds, patches and removes links, and drops them with their chat', () => {
    let s = run([{ t: 'created', chat: chat('chat-1') }, { t: 'created', chat: chat('chat-2') }, { t: 'link', link: link() }, { t: 'link', link: link() }]);
    expect(s.links).toHaveLength(1);
    s = reduce(s, { t: 'linkPatch', linkId: 'link-1', patch: { count: 2, active: false } });
    expect(s.links[0]).toMatchObject({ count: 2, active: false });
    expect(linksOf(s, 'chat-2').map((l) => l.id)).toEqual(['link-1']);
    expect(reduce(s, { t: 'unlink', linkId: 'link-1' }).links).toEqual([]);
    expect(reduce(s, { t: 'closed', chatId: 'chat-2' }).links).toEqual([]);
  });

  it('counts finished turns and records when the agent last did something', () => {
    const s = run([
      { t: 'created', chat: chat('chat-1') },
      { t: 'busy', chatId: 'chat-1', busy: true, at: 5 },
      { t: 'update', chatId: 'chat-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } }, at: 9 },
      { t: 'busy', chatId: 'chat-1', busy: false, at: 12 },
      { t: 'busy', chatId: 'chat-1', busy: false },
    ]);
    expect(s.chats[0]).toMatchObject({ turns: 1, lastActivity: 12 });
  });

  it('lists an agent asking to reach another chat as a decision until answered', () => {
    let s = run([
      { t: 'created', chat: chat('chat-1', { label: 'Claude 2', agent: 'claude' }) },
      { t: 'items', chatId: 'chat-1', items: [{ kind: 'bridge', requestId: 'bridge-1', tool: 'ask_agent', target: { agent: 'gemini' }, text: 'Review it', state: 'awaiting' }] },
    ]);
    expect(decisions(s)).toEqual([{ chatId: 'chat-1', kind: 'bridge', id: 'bridge-1', title: 'Claude 2 wants to ask Gemini' }]);
    s = reduce(s, { t: 'bridge', requestId: 'bridge-1', state: 'allowed' });
    expect(decisions(s)).toEqual([]);
  });
});

describe('files and conflicts', () => {
  it('merges touched files and flags a file two open chats both changed', () => {
    const s = run([
      { t: 'created', chat: chat('chat-1') },
      { t: 'created', chat: chat('chat-2', { cwd: '/w/.worktrees/task' }) },
      { t: 'created', chat: chat('chat-3', { archived: true }) },
      { t: 'files', chatId: 'chat-1', files: ['src/a.ts', 'README.md'] },
      { t: 'files', chatId: 'chat-1', files: ['src/a.ts'] },
      { t: 'files', chatId: 'chat-2', files: ['src/a.ts'] },
      { t: 'files', chatId: 'chat-3', files: ['README.md'] },
    ]);
    expect(s.chats[0].files).toEqual(['src/a.ts', 'README.md']);
    expect(fileConflicts(s)).toEqual([{ file: 'src/a.ts', chats: ['chat-1', 'chat-2'] }]);
  });
});

describe('@mentions', () => {
  it('reads an agent name at the start of a message', () => {
    expect(parseMention('@gemini review this')).toEqual({ agent: 'gemini', text: 'review this' });
    expect(parseMention('  @GPT, write tests')).toEqual({ agent: 'codex', text: 'write tests' });
    expect(parseMention('@claude: hi')).toEqual({ agent: 'claude', text: 'hi' });
  });

  it('ignores unknown names, a bare mention and mentions later in the text', () => {
    expect(parseMention('@bob hi')).toBeNull();
    expect(parseMention('@gemini')).toBeNull();
    expect(parseMention('ask @gemini about it')).toBeNull();
    expect(parseMention('email@gemini.com')).toBeNull();
  });
});

describe('lastReply', () => {
  it('joins the agent text after the last message the chat was given', () => {
    const c = chat('chat-2', {
      items: [
        { kind: 'link', linkId: 'link-1', role: 'consulted', chatId: 'chat-1', agent: 'claude', label: 'Claude', text: 'Q1', by: 'user' },
        { kind: 'agent', text: 'old' },
        { kind: 'user', text: 'Q2', images: [] },
        { kind: 'agent', text: 'first' },
        { kind: 'tool', id: 't', title: 'Read', locations: [] },
        { kind: 'agent', text: 'second' },
      ],
    });
    expect(lastReply(c)).toBe('first\n\nsecond');
  });
});

describe('connection messages from webviews', () => {
  it('accepts well-formed ones', () => {
    expect(parseWebviewMessage({ type: 'handoff', chatId: 'chat-1', agent: 'codex' })).toEqual({ type: 'handoff', chatId: 'chat-1', agent: 'codex' });
    expect(parseWebviewMessage({ type: 'consult', chatId: 'chat-1', agent: 'gemini', text: 'why?' })).toMatchObject({ type: 'consult' });
    expect(parseWebviewMessage({ type: 'pipe', from: 'chat-1', to: 'chat-2' })).toMatchObject({ type: 'pipe' });
    expect(parseWebviewMessage({ type: 'fanout', agents: ['claude', 'codex', 'claude'], prompt: 'do it', worktree: true })).toEqual({
      type: 'fanout',
      agents: ['claude', 'codex'],
      prompt: 'do it',
      worktree: true,
    });
    expect(parseWebviewMessage({ type: 'bridge', requestId: 'bridge-1', answer: 'allowChat' })).toMatchObject({ type: 'bridge' });
    expect(parseWebviewMessage({ type: 'archive', chatId: 'chat-1', archived: true })).toMatchObject({ type: 'archive' });
  });

  it('rejects malformed ones', () => {
    for (const m of [
      { type: 'handoff', chatId: 'chat-1', agent: 'bob' },
      { type: 'consult', chatId: 'chat-1', agent: 'gemini', text: '  ' },
      { type: 'pipe', from: 'chat-1', to: 'chat-1' },
      { type: 'forward', fromChatId: 'chat-1', toChatId: 'chat-1' },
      { type: 'fanout', agents: [], prompt: 'x', worktree: false },
      { type: 'fanout', agents: ['claude', 'codex', 'gemini', 'demo', 'claude'], prompt: 'x', worktree: false },
      { type: 'fanout', agents: ['claude'], prompt: 'x', worktree: 'yes' },
      { type: 'bridge', requestId: 'bridge-1', answer: 'always' },
      { type: 'archive', chatId: '../x', archived: true },
    ]) {
      expect(parseWebviewMessage(m)).toBeNull();
    }
  });
});
