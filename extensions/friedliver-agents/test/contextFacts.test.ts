// The context rail's facts (COMPONENTS.md v2 §2.34): one source for cost, time, files and Rewind points.
import { describe, expect, it } from 'vitest';
import { chatFacts, compactCount } from '../src/shared/contextFacts';
import type { ChatView } from '../src/shared/model';

const base = (over: Partial<ChatView>): ChatView =>
  ({ id: 'c', agent: 'codex', label: 'Codex', title: 't', cwd: '/w', createdAt: 1_000, busy: false, changedFiles: 0, items: [], depth: 0, files: [], lastActivity: 373_000, turns: 1, ...over }) as ChatView;

describe('chatFacts', () => {
  it('sums the cost in money and the tokens under it', () => {
    const f = chatFacts(
      base({
        usageLog: [
          { at: 1, input: 30_000, output: 4_000, cacheRead: 0, cacheWrite: 0, cost: { amount: 0.4, currency: 'USD' } },
          { at: 2, input: 18_000, output: 2_000, cacheRead: 0, cacheWrite: 0, cost: { amount: 0.22, currency: 'USD' } },
        ],
      }),
      0,
    );
    expect(f.cost).toBe('$0.62');
    expect(f.tokens).toBe('54k tokens');
  });

  it('says nothing about money the agent never reported', () => {
    expect(chatFacts(base({}), 0).cost).toBeUndefined();
  });

  it('times from the start to the last activity, or to now while working', () => {
    expect(chatFacts(base({}), 0).time).toBe('6m 12s');
    expect(chatFacts(base({ busy: true }), 61_000).time).toBe('1m 0s');
  });

  it('lists files read (relative, once each) and Rewind points newest first', () => {
    const f = chatFacts(
      base({
        items: [
          { kind: 'user', text: 'Fix the rounding in tax totals please', images: [], checkpoint: 'k1', at: 5 },
          { kind: 'tool', id: 't1', title: 'Read', toolKind: 'read', locations: ['/w/src/a.ts'] },
          { kind: 'tool', id: 't2', title: 'Read', toolKind: 'read', locations: ['/w/src/a.ts', '/w/b.ts'] },
          { kind: 'user', text: 'Now the tests', images: [], checkpoint: 'k2', at: 9 },
        ],
      }),
      0,
    );
    expect(f.read).toEqual(['src/a.ts', 'b.ts']);
    expect(f.rewind.map((r) => r.checkpoint)).toEqual(['k2', 'k1']);
    expect(f.rewind[1].label).toBe('Before “Fix the rounding in tax tot…”');
  });

  it('compacts counts', () => {
    expect([compactCount(950), compactCount(54_210), compactCount(1_250_000), compactCount(2_000_000)]).toEqual(['950', '54k', '1.3M', '2M']);
  });
});
