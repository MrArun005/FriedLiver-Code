import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionBatcher } from '../src/host/batch';
import type { Action } from '../src/shared/model';

afterEach(() => {
  vi.useRealTimers();
});

const title = (n: number): Action => ({ t: 'title', chatId: 'chat-1', title: `t${n}` });

describe('ActionBatcher', () => {
  it('sends the first action at once and the rest together, in order', () => {
    vi.useFakeTimers();
    const sent: Action[][] = [];
    const b = new ActionBatcher((a) => sent.push(a), 30);
    b.push(title(1));
    b.push(title(2));
    b.push(title(3));
    expect(sent).toEqual([[title(1)]]);
    vi.advanceTimersByTime(30);
    expect(sent).toEqual([[title(1)], [title(2), title(3)]]);
    b.push(title(4));
    vi.advanceTimersByTime(30);
    expect(sent.at(-1)).toEqual([title(4)]);
    // Quiet for a while: the next one goes straight out again.
    vi.advanceTimersByTime(100);
    b.push(title(5));
    expect(sent.at(-1)).toEqual([title(5)]);
    expect(sent.flat()).toEqual([1, 2, 3, 4, 5].map(title));
  });

  it('flushes what is queued on demand, so a snapshot never repeats it', () => {
    vi.useFakeTimers();
    const sent: Action[][] = [];
    const b = new ActionBatcher((a) => sent.push(a), 30);
    b.push(title(1));
    b.push(title(2));
    b.flush();
    expect(sent).toEqual([[title(1)], [title(2)]]);
    vi.advanceTimersByTime(30);
    expect(sent).toHaveLength(2);
    b.dispose();
  });
});
