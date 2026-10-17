import { describe, expect, it } from 'vitest';
import { TEXT_DEFAULT, clampTextSize, defaultTextSize, textSizeKey } from '../src/shared/textSize';

const key = (k: string, mods: { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean } = {}) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, ...mods });
const cmd = (k: string) => key(k, { metaKey: true });
const ctrl = (k: string) => key(k, { ctrlKey: true });

describe('chat text size', () => {
  it('clamps to 10–20 and rounds', () => {
    expect(clampTextSize(4)).toBe(10);
    expect(clampTextSize(99)).toBe(20);
    expect(clampTextSize(12.6)).toBe(13);
  });
  it('reads the setting, falling back to 13', () => {
    expect(defaultTextSize('15')).toBe(15);
    expect(defaultTextSize('40')).toBe(20);
    expect(defaultTextSize(undefined)).toBe(TEXT_DEFAULT);
    expect(defaultTextSize('big')).toBe(TEXT_DEFAULT);
  });
  it('Cmd = - 0 step by 1px from the tab size, or its default', () => {
    expect(textSizeKey(cmd('='), true, null, 13)).toBe(14);
    expect(textSizeKey(cmd('+'), true, 14, 13)).toBe(15);
    expect(textSizeKey(cmd('-'), true, 12, 13)).toBe(11);
    expect(textSizeKey(cmd('-'), true, 10, 13)).toBe(10);
    expect(textSizeKey(cmd('='), true, 20, 13)).toBe(20);
    expect(textSizeKey(cmd('0'), true, 17, 13)).toBe(13);
  });
  it('Ctrl off macOS; other keys and modifiers are left alone', () => {
    expect(textSizeKey(ctrl('='), false, null, 13)).toBe(14);
    expect(textSizeKey(ctrl('='), true, null, 13)).toBeNull();
    expect(textSizeKey(cmd('='), false, null, 13)).toBeNull();
    expect(textSizeKey(key('='), true, null, 13)).toBeNull();
    expect(textSizeKey(key('=', { metaKey: true, altKey: true }), true, null, 13)).toBeNull();
    expect(textSizeKey(cmd('a'), true, null, 13)).toBeNull();
  });
});
