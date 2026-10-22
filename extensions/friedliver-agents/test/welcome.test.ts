// The Welcome page's sentence and lists (COMPONENTS.md v2 §2.38): one source with the board.
import { describe, expect, it } from 'vitest';
import { connectStatus, welcomeSummary } from '../src/shared/welcome';
import type { ChatView } from '../src/shared/model';

const NOW = new Date(2026, 9, 20, 15, 0).getTime();
const chat = (over: Partial<ChatView>): ChatView =>
  ({ id: Math.random().toString(36), agent: 'claude', label: 'Claude', title: 't', cwd: '/w', createdAt: NOW - 60_000, busy: false, changedFiles: 0, items: [], depth: 0, files: [], lastActivity: NOW - 1000, turns: 1, ...over }) as ChatView;

describe('welcomeSummary', () => {
  it('says what is working and what needs you, then today', () => {
    const chats = [
      chat({ busy: true }),
      chat({ busy: true }),
      chat({ usageLog: [{ at: NOW - 5000, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { amount: 4.2, currency: 'USD' } }] }),
    ];
    const s = welcomeSummary(chats, NOW);
    expect(s.working).toHaveLength(2);
    expect(s.sentence).toBe('Two agents are working. 1 task done today, $4.20 spent.');
  });

  it('greets a first run plainly', () => {
    expect(welcomeSummary([], NOW).sentence).toBe('Describe a task and an agent starts on it.');
  });

  it('leaves out work finished before midnight', () => {
    expect(welcomeSummary([chat({ lastActivity: new Date(2026, 9, 19, 23, 0).getTime() })], NOW).done).toHaveLength(0);
  });
});

describe('connectStatus (first run, V17)', () => {
  it('only a signed-in agent counts as connected; the rest say why in plain words', () => {
    expect(connectStatus('signed-in')).toEqual({ words: 'Connected', connected: true });
    expect(connectStatus('needs-sign-in')).toEqual({ words: 'Installed, needs sign-in', connected: false });
    expect(connectStatus('not-installed').connected).toBe(false);
    expect(connectStatus('error').words).toBe('Problem signing in');
    expect(connectStatus(undefined)).toEqual({ words: 'Not checked yet', connected: false });
  });
});
