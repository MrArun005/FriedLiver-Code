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

  it('sends bigger batches less often under load, and goes back when it eases', () => {
    vi.useFakeTimers();
    const sent: Action[][] = [];
    const b = new ActionBatcher((a) => sent.push(a), 30, 80);
    let n = 0;
    // Six actions every 10 ms is 600 a second.
    const stream = (ms: number, every = 10, per = 6) => {
      for (let t = 0; t < ms; t += every) {
        for (let k = 0; k < per; k++) b.push(title(n++));
        vi.advanceTimersByTime(every);
      }
    };
    stream(30);
    expect(sent).toHaveLength(2);
    stream(400);
    const busy = sent.length;
    stream(400);
    // 400 ms at one batch every 80 ms.
    expect(sent.length - busy).toBe(5);
    expect(sent.at(-1)!.length).toBe(48);
    // One action every 40 ms is 25 a second: batches every 30 ms again.
    stream(400, 40, 1);
    const calm = sent.length;
    stream(400, 40, 1);
    expect(sent.length - calm).toBe(10);
    b.dispose();
    expect(sent.flat()).toEqual(Array.from({ length: sent.flat().length }, (_, i) => title(i)));
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
