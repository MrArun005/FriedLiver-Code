import { describe, expect, it } from 'vitest';
import { DecisionTargets, KEY_GRACE_MS } from '../src/shared/decisionTarget';

describe('the card the decision keys act on', () => {
  it('stays on the card already marked when a new decision arrives, oldest first', () => {
    const t = new DecisionTargets();
    expect(t.target('chat-1', ['a'], 0)?.id).toBe('a');
    // A new request arrives just before the keypress: the keys still act on the card you saw.
    expect(t.target('chat-1', ['a', 'b'], 900)?.id).toBe('a');
    expect(t.armed('chat-1', ['a', 'b'], 900)).toBe(true);
  });

  it('starts on the oldest waiting card, not the newest', () => {
    const t = new DecisionTargets();
    expect(t.target('chat-1', ['a', 'b', 'c'], 0)?.id).toBe('a');
  });

  it('ignores the keys for a moment after the target changes', () => {
    const t = new DecisionTargets();
    t.target('chat-1', ['a', 'b'], 0);
    expect(t.armed('chat-1', ['a', 'b'], KEY_GRACE_MS - 1)).toBe(false);
    expect(t.armed('chat-1', ['a', 'b'], KEY_GRACE_MS)).toBe(true);
    // You choose another card: a fresh grace period.
    t.choose('chat-1', 'b', ['a', 'b'], 1000);
    expect(t.target('chat-1', ['a', 'b'], 1000)?.id).toBe('b');
    expect(t.armed('chat-1', ['a', 'b'], 1000 + KEY_GRACE_MS - 1)).toBe(false);
    expect(t.armed('chat-1', ['a', 'b'], 1000 + KEY_GRACE_MS)).toBe(true);
  });

  it('moves on only when the marked card is answered, with a fresh grace period', () => {
    const t = new DecisionTargets();
    t.target('chat-1', ['a', 'b'], 0);
    expect(t.target('chat-1', ['b'], 5000)?.id).toBe('b');
    expect(t.armed('chat-1', ['b'], 5000)).toBe(false);
    expect(t.armed('chat-1', ['b'], 5000 + KEY_GRACE_MS)).toBe(true);
    expect(t.target('chat-1', [], 9000)).toBeUndefined();
  });

  it('keeps each chat to itself', () => {
    const t = new DecisionTargets();
    t.target('chat-1', ['a', 'b'], 0);
    t.target('chat-2', ['x', 'y'], 0);
    t.choose('chat-1', 'b', ['a', 'b'], 10);
    expect(t.target('chat-2', ['x', 'y'], 2000)?.id).toBe('x');
    expect(t.target('chat-1', ['a', 'b'], 2000)?.id).toBe('b');
    // Choosing a card another chat owns does nothing.
    t.choose('chat-2', 'b', ['x', 'y'], 20);
    expect(t.target('chat-2', ['x', 'y'], 2000)?.id).toBe('x');
  });

  it('is not armed when nothing waits', () => {
    expect(new DecisionTargets().armed('chat-1', [], 10_000)).toBe(false);
  });
});
