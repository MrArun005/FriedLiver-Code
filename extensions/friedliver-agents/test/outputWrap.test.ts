import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LIMITS, parseWebviewMessage } from '../src/shared/messages';

const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

describe("a tool's output opened in the editor", () => {
  it('opens in its own language, which wraps long lines (the user’s files keep their setting)', () => {
    expect(pkg.contributes.languages).toContainEqual(expect.objectContaining({ id: 'friedliver-output' }));
    expect(pkg.contributes.configurationDefaults['[friedliver-output]']).toEqual({ 'editor.wordWrap': 'on', 'editor.wrappingIndent': 'same' });
    // Only that language: nothing global.
    expect(Object.keys(pkg.contributes.configurationDefaults).filter((k) => k.startsWith('editor.'))).toEqual([]);
  });

  it('takes the text, within the copy limit, and nothing else', () => {
    expect(parseWebviewMessage({ type: 'openText', text: 'line one\nline two', path: '/etc/passwd' })).toEqual({ type: 'openText', text: 'line one\nline two' });
    expect(parseWebviewMessage({ type: 'openText', text: '' })).toBeNull();
    expect(parseWebviewMessage({ type: 'openText', text: 'x'.repeat(LIMITS.copy + 1) })).toBeNull();
  });
});
