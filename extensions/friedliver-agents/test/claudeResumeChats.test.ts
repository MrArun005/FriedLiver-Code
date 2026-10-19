// A FriedLiver chat that only resumed an outside Claude Code session (it never ran a turn) while the Claude Code
// extension went on with it: one card, the outside session with its agents, and opening it reuses that chat.
import { describe, expect, it } from 'vitest';
import type { ChatView } from '../src/shared/model';
import type { ClaudeSession } from '../src/shared/messages';
import { chatOfSession, linkResumeChats, withoutLinkedChats } from '../src/shared/view';

const S = '607dfe49-a562-4c39-8755-d4057bf35d87';
const session = (id = S): ClaudeSession => ({ id, cwd: '/w', title: 'IDE identification question', lastActivity: 1, messages: 876, subagents: [{ id: 't1', title: 'Build Decision Inbox' }] });
const chat = (id: string, extra: Partial<ChatView> = {}) => ({ id, turns: 0, busy: false, ...extra }) as ChatView;
const saved = (chats: ChatView[], sessions: Record<string, string>) => ({
  state: { chats },
  chats: Object.fromEntries(chats.map((c) => [c.id, { sessionId: sessions[c.id] }])),
});

describe('resume chats', () => {
  it('ties an outside session to the FriedLiver chat that only resumed it', () => {
    const [s] = linkResumeChats([session()], saved([chat('chat-10'), chat('chat-11')], { 'chat-10': 'other', 'chat-11': S }));
    expect(s.chatId).toBe('chat-11');
    expect(s.subagents).toHaveLength(1);
  });

  it('leaves a chat that ran a turn, or is running one, as its own card', () => {
    expect(linkResumeChats([session()], saved([chat('chat-11', { turns: 2 })], { 'chat-11': S }))[0].chatId).toBeUndefined();
    expect(linkResumeChats([session()], saved([chat('chat-11', { busy: true })], { 'chat-11': S }))[0].chatId).toBeUndefined();
  });

  it('shows a linked chat only inside the outside session’s card, and keeps every other chat', () => {
    const chats = [chat('chat-10'), chat('chat-11')];
    expect(withoutLinkedChats(chats, [{ ...session(), chatId: 'chat-11' }]).map((c) => c.id)).toEqual(['chat-10']);
    expect(withoutLinkedChats(chats, [session()])).toBe(chats);
  });

  it('finds the chat to reuse when an outside session is opened, whatever its turns', () => {
    const st = saved([chat('chat-10'), chat('chat-11', { turns: 3 })], { 'chat-10': 'other', 'chat-11': S });
    expect(chatOfSession(st, S)).toBe('chat-11');
    expect(chatOfSession(st, 'nope')).toBeUndefined();
  });
});
