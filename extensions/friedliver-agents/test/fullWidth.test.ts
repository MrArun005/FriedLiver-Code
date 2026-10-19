import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The owner's rule: chat and Agent Manager use the whole width; no fixed-pixel column caps.
describe('full width', () => {
  const css = readFileSync('media/webview.css', 'utf8');
  it('does not cap the chat transcript to a fixed column', () => {
    expect(css).not.toMatch(/\.transcript > \* \{\s*max-width: \d+px/);
  });
  it('does not cap the Agent Manager to a fixed column', () => {
    expect(css).not.toMatch(/\.manager > \* \{[^}]*max-width: \d+px/);
  });
});
