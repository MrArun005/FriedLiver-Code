import { describe, expect, it } from 'vitest';
import { parseSaved } from '../src/host/persist';
import { chatName, chatPick, chatRef, chatTip, NUMBERED_LABEL, statusTexts, turnEndedText } from '../src/shared/names';
import { EMPTY_STATE, type AgentKey, type ChatView } from '../src/shared/model';

// Owner rule: a chat is never shown as "Claude 9"; it is its topic, and the plain agent name where an agent must be named.

const chat = (agent: AgentKey, title: string, label: string) => ({ agent, title, label });
const fix = chat('claude', 'Fix the login redirect', 'Claude 9');
const tests = chat('codex', 'Add tests for the cart', 'Codex 2');
const fresh = chat('gemini', 'New chat', 'Gemini 3');

const strings = (v: unknown): string[] => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []);

describe('naming a chat', () => {
  it('by its topic, else the agent; quoted in a sentence; "<topic> · Agent" in a tooltip', () => {
    expect(chatName(fix)).toBe('Fix the login redirect');
    expect(chatName(fresh)).toBe('Gemini');
    expect(chatRef(fix)).toBe('“Fix the login redirect”');
    expect(chatRef(fresh)).toBe('Gemini');
    expect(chatTip(fix)).toBe('Fix the login redirect · Claude');
    expect(chatPick(tests, 'working')).toEqual({ label: 'Add tests for the cart', description: 'Codex · working' });
  });

  it('the status bar names chats by topic, never by a numbered label', () => {
    const one = statusTexts([fix], [fix]);
    expect(one.auto?.text).toBe('$(zap) Auto: Fix the login redirect');
    expect(one.working?.text).toBe('$(sync~spin) 1 working');
    const many = statusTexts([fix, tests, fresh], [fix, tests]);
    expect(many.auto?.text).toBe('$(zap) Auto: 2 chats');
    expect(many.auto?.tooltip).toContain('“Fix the login redirect” (Claude), “Add tests for the cart” (Codex)');
    for (const s of [...strings(one), ...strings(many)]) expect(s).not.toMatch(NUMBERED_LABEL);
    expect(statusTexts([], [])).toEqual({});
  });

  it('notifications say the agent and the topic', () => {
    expect(turnEndedText({ ...fix, files: 2 })).toBe('Claude finished: Fix the login redirect · 2 files changed');
    expect(turnEndedText({ ...tests, files: 0, failure: 'Rate limited' })).toBe('Codex · Add tests for the cart: Rate limited');
    for (const c of [fix, tests, fresh]) expect(turnEndedText({ ...c, files: 1 })).not.toMatch(NUMBERED_LABEL);
  });

  it('a chat saved by an older version with a numbered label comes back with the plain agent name', () => {
    const c: ChatView = { id: 'chat-1', agent: 'claude', label: 'Claude 9', title: 'Fix it', cwd: '/w', createdAt: 0, busy: false, changedFiles: 0, items: [], depth: 0, files: [], lastActivity: 0, turns: 0 };
    const saved = parseSaved({ version: 1, state: { ...EMPTY_STATE, chats: [c] }, chats: { 'chat-1': { agent: 'claude', cwd: '/w' } }, nextId: 2, chatCount: { claude: 9 } });
    expect(saved?.state.chats[0].label).toBe('Claude');
  });
});
