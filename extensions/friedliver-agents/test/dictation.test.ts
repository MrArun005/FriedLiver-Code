import { describe, expect, it } from 'vitest';
import { parseWebviewMessage } from '../src/shared/messages';
import { turnsLeft } from '../src/shared/session';

describe('dictation', () => {
  it('the mic hint may open Dictation settings', () => {
    expect(parseWebviewMessage({ type: 'dictationSettings' })).toEqual({ type: 'dictationSettings' });
  });
  it('the old programmatic start is gone (it beeped)', () => {
    expect(parseWebviewMessage({ type: 'dictate' })).toBeNull();
  });
});

describe('turnsLeft (the usage popover estimate)', () => {
  it('uses growth per turn, not the total (the system prompt is not a turn)', () => {
    // The light fixture: 76% of 200k used, 12k a turn lately: 48k left is 4 turns, not ~0.
    expect(turnsLeft([116_000, 128_000, 140_000, 152_000], 200_000)).toBe(4);
  });
  it('looks at the last 5 turns only', () => {
    expect(turnsLeft([10_000, 90_000, 100_000, 110_000, 120_000, 130_000, 140_000], 200_000)).toBe(6);
  });
  it('needs 2 finished turns; caps at >50; never negative', () => {
    expect(turnsLeft([], 200_000)).toBeUndefined();
    expect(turnsLeft([30_000], 200_000)).toBeUndefined();
    expect(turnsLeft([30_000, 31_000], 200_000)).toBe('>50');
    expect(turnsLeft([30_000, 30_000], 200_000)).toBe('>50');
    expect(turnsLeft([190_000, 210_000], 200_000)).toBe(0);
  });
});
