// The composer's controls are memoised: a streamed text chunk must not redraw them.
import { describe, expect, it } from 'vitest';
import type { ChatView } from '../src/shared/model';
import { sameAgents, sameControls } from '../src/shared/view';

const session = { options: [], commands: [], live: true, usage: { used: 10_000, size: 200_000 } } as unknown as ChatView['session'];
const chat = { id: 'c1', agent: 'claude', label: 'Claude 1', title: 't', busy: true, items: [{ kind: 'text', text: 'Hel' }], session, approval: 'ask', turns: 1 } as unknown as ChatView;
const samples = [10_000];

describe('composer controls memo', () => {
  it('a text-only stream update keeps the controls', () => {
    const next = { ...chat, items: [{ kind: 'text', text: 'Hello' }] } as unknown as ChatView;
    expect(sameControls({ chat, samples }, { chat: next, samples })).toBe(true);
    expect(sameAgents({ chat, linked: [] }, { chat: next, linked: [] })).toBe(true);
  });
  it('a level, session or new usage sample redraws them', () => {
    expect(sameControls({ chat, samples }, { chat: { ...chat, approval: 'full' }, samples })).toBe(false);
    expect(sameControls({ chat, samples }, { chat: { ...chat, session: { ...session! } }, samples })).toBe(false);
    expect(sameControls({ chat, samples }, { chat, samples: [...samples, 20_000] })).toBe(false);
  });
  it('a linked chat finishing redraws the agents button', () => {
    const child = { ...chat, id: 'c2', items: [] } as ChatView;
    expect(sameAgents({ chat, linked: [child] }, { chat, linked: [{ ...child, busy: false }] })).toBe(false);
  });
});
