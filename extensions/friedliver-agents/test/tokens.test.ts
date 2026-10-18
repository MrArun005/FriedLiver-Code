import { describe, expect, it } from 'vitest';
import { unifiedDiff } from '../src/shared/diff';
import { estimateTokens } from '../src/shared/tokens';

describe('estimateTokens', () => {
  it('is close to cl100k on code and prose', () => {
    // cl100k_base counts (js-tiktoken 1.0.21) for these strings: 9, 11, 24.
    expect(estimateTokens('export function tokenize(text: string): string[] {')).toBeGreaterThanOrEqual(9);
    expect(estimateTokens('export function tokenize(text: string): string[] {')).toBeLessThanOrEqual(14);
    expect(estimateTokens('The quick brown fox jumps over the lazy dog again.')).toBeGreaterThanOrEqual(9);
    expect(estimateTokens('The quick brown fox jumps over the lazy dog again.')).toBeLessThanOrEqual(13);
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a'.repeat(400))).toBeGreaterThan(40);
  });
});

describe('unifiedDiff', () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`);

  it('gives hunks with 3 lines of context for far-apart edits in a big file', () => {
    const a = lines(5000);
    const b = [...a];
    b[100] = 'changed 101';
    b.splice(4000, 0, 'inserted');
    const d = unifiedDiff(a.join('\n'), b.join('\n'))!;
    expect(d.added).toBe(2);
    expect(d.removed).toBe(1);
    expect(d.text).toBe(
      ['@@ -98,7 +98,7 @@', ' line 98', ' line 99', ' line 100', '-line 101', '+changed 101', ' line 102', ' line 103', ' line 104',
        '@@ -3998,6 +3998,7 @@', ' line 3998', ' line 3999', ' line 4000', '+inserted', ' line 4001', ' line 4002', ' line 4003'].join('\n'),
    );
  });

  it('is empty for equal text and null past the edit cap', () => {
    expect(unifiedDiff('a\nb', 'a\nb')).toEqual({ text: '', added: 0, removed: 0 });
    const a = lines(400).join('\n');
    const b = lines(400).map((l) => `${l}!`).join('\n');
    expect(unifiedDiff(a, b, 3, 100)).toBeNull();
  });

  it('handles empty sides', () => {
    expect(unifiedDiff('', 'x\ny')).toEqual({ text: '@@ -0,0 +1,2 @@\n+x\n+y', added: 2, removed: 0 });
    expect(unifiedDiff('x', '')).toEqual({ text: '@@ -1,1 +0,0 @@\n-x', added: 0, removed: 1 });
  });
});
