import { describe, expect, it } from 'vitest';
import { parseWebviewMessage } from '../src/shared/messages';

describe('dictation', () => {
  it('the mic hint may open Dictation settings', () => {
    expect(parseWebviewMessage({ type: 'dictationSettings' })).toEqual({ type: 'dictationSettings' });
  });
  it('the old programmatic start is gone (it beeped)', () => {
    expect(parseWebviewMessage({ type: 'dictate' })).toBeNull();
  });
});
