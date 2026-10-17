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
  it('divides what is left by the average per finished turn', () => {
    expect(turnsLeft({ used: 20_000, size: 200_000 }, 4)).toBe(36);
  });
  it('is unknown before the first turn, and never negative', () => {
    expect(turnsLeft({ used: 5_000, size: 200_000 }, 0)).toBeUndefined();
    expect(turnsLeft({ used: 210_000, size: 200_000 }, 3)).toBe(0);
  });
});
