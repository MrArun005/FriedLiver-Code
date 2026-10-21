import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Item } from '../src/shared/model';
import { MAX_TOASTS, addToasts, dismissTimer, isToastNotice } from '../src/shared/toasts';

afterEach(() => void vi.useRealTimers());

describe('error notices as toasts', () => {
  it('toasts errors with their actions, keeps info notices and sign-in in the transcript', () => {
    const useModel: Item = { kind: 'notice', tone: 'error', text: "Claude can't use the model x", actions: [{ label: 'Use Sonnet', do: 'setOption', optionId: 'model', value: 'sonnet' }] };
    expect(isToastNotice(useModel)).toBe(true);
    expect(isToastNotice({ kind: 'notice', tone: 'error', text: "Claude didn't change Mode to plan: no" })).toBe(true);
    expect(isToastNotice({ kind: 'notice', tone: 'info', text: 'Stopped.' })).toBe(false);
    expect(isToastNotice({ kind: 'notice', tone: 'error', text: 'Sign in', actions: [{ label: 'Sign in to Claude', do: 'accounts', agent: 'claude' }, { label: 'Try again', do: 'retry' }] })).toBe(false);
    expect(isToastNotice({ kind: 'agent', text: 'hi' })).toBe(false);
  });

  it('shows at most three, newest last, each once', () => {
    expect(addToasts(['a', 'b'], ['c', 'd'])).toEqual(['b', 'c', 'd']);
    expect(addToasts(['a', 'b'], ['a'])).toEqual(['b', 'a']);
    expect(addToasts([], ['a', 'b', 'c', 'd', 'e'])).toHaveLength(MAX_TOASTS);
  });

  it('dismisses after its time, and a pause keeps the time left', () => {
    vi.useFakeTimers();
    const done = vi.fn();
    const t = dismissTimer(8, done);
    vi.advanceTimersByTime(5000);
    t.pause();
    vi.advanceTimersByTime(60_000);
    expect(done).not.toHaveBeenCalled();
    t.resume();
    vi.advanceTimersByTime(2999);
    expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(done).toHaveBeenCalledOnce();
    t.clear();
  });
});
