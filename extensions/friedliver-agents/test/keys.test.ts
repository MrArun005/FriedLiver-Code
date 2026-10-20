// Keycaps by platform (COMPONENTS.md v2 §1.14, §2.25) and the keycap lint: every key written in a
// webview is one combo the macOS way, modifiers in ⌃⌥⇧⌘ order, none repeated; ui/keys.ts draws it per OS.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { keyProblem, keycaps, keyText } from '../src/webview/ui/keys';

describe('keycaps', () => {
  it('macOS: one cap per key, Apple order', () => {
    expect(keycaps('⌘⏎', 'mac')).toEqual(['⌘', '⏎']);
    expect(keycaps('⌘⇧P', 'mac')).toEqual(['⇧', '⌘', 'P']);
    expect(keycaps('Ctrl+Shift+P', 'mac')).toEqual(['⇧', '⌘', 'P']);
    expect(keycaps('Esc', 'mac')).toEqual(['Esc']);
  });

  it('Windows and Linux: one cap, Ctrl+Alt+Shift order, words for Enter and Backspace', () => {
    expect(keycaps('⌘⏎', 'windows')).toEqual(['Ctrl+Enter']);
    expect(keycaps('⇧⌘⌫', 'windows')).toEqual(['Ctrl+Shift+Backspace']);
    expect(keycaps('⇧⏎', 'linux')).toEqual(['Shift+Enter']);
    expect(keycaps('Esc', 'windows')).toEqual(['Esc']);
    expect(keycaps('⌘d', 'windows')).toEqual(['Ctrl+D']);
  });

  it('a ⌃ held with ⌘ is Alt on Windows (⌃⌘I = Ctrl+Alt+I), never "Ctrl+Ctrl"', () => {
    expect(keycaps('⌃⌘I', 'windows')).toEqual(['Ctrl+Alt+I']);
    expect(keycaps('⌃⌘N', 'linux')).toEqual(['Ctrl+Alt+N']);
    expect(keycaps('⌃Tab', 'windows')).toEqual(['Ctrl+Tab']);
  });

  it('a chord is one cap, VS Code style', () => {
    expect(keycaps('⌘K A', 'mac')).toEqual(['⌘K A']);
    expect(keycaps('⌘K A', 'windows')).toEqual(['Ctrl+K A']);
  });

  it('as text, for tooltips', () => {
    expect(keyText('⇧⌘I', 'mac')).toBe('⇧⌘I');
    expect(keyText('⇧⌘I', 'windows')).toBe('Ctrl+Shift+I');
  });

  it('the lint catches repeats and order', () => {
    expect(keyProblem('⌘⌘K')).toMatch(/repeats/);
    expect(keyProblem('⌘⇧P')).toMatch(/order/);
    expect(keyProblem('⇧⌘P')).toBeUndefined();
  });
});

describe('the keycap lint over every webview', () => {
  const src = path.join(__dirname, '../src');
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = path.join(dir, f);
      return statSync(p).isDirectory() ? files(p) : f.endsWith('.tsx') ? [p] : [];
    });
  const written = files(path.join(src, 'webview')).flatMap((file) => {
    const text = readFileSync(file, 'utf8');
    const found = [
      ...[...text.matchAll(/\bkbd=["']([^"']+)["']/g)].map((m) => m[1]),
      ...[...text.matchAll(/\bkbd=\{[^}]*?["']([^"']+)["'][^}]*\}/g)].map((m) => m[1]),
      ...[...text.matchAll(/<Kbd(?: inline)?>([^<{]+)<\/Kbd>/g)].map((m) => m[1]),
      ...[...text.matchAll(/<Keycaps keys=["']([^"']+)["']/g)].map((m) => m[1]),
    ];
    return found.map((k) => [path.relative(src, file), k] as const);
  });

  it('finds the keys it lints', () => {
    expect(written.length).toBeGreaterThan(10);
  });

  it.each(written)('%s: "%s" is one combo in ⌃⌥⇧⌘ order, no repeats', (_file, keys) => {
    expect(keyProblem(keys)).toBeUndefined();
  });
});
