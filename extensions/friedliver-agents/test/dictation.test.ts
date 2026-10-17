import { describe, expect, it, vi } from 'vitest';
import { DICTATION_SETTINGS, startDictation } from '../src/host/dictation';
import { parseWebviewMessage } from '../src/shared/messages';

const deps = (over: Partial<Parameters<typeof startDictation>[0]> = {}) => ({
  platform: 'darwin' as NodeJS.Platform,
  run: vi.fn(async () => undefined),
  toast: vi.fn(async () => undefined as string | undefined),
  openUrl: vi.fn(),
  ...over,
});

describe('dictation', () => {
  it('the webview may ask for it', () => {
    expect(parseWebviewMessage({ type: 'dictate' })).toEqual({ type: 'dictate' });
  });
  it('runs the app command on macOS', async () => {
    const d = deps();
    expect(await startDictation(d)).toBe('started');
    expect(d.run).toHaveBeenCalledWith('friedliver.startDictation');
    expect(d.toast).not.toHaveBeenCalled();
  });
  it('does nothing off macOS', async () => {
    const d = deps({ platform: 'linux' });
    expect(await startDictation(d)).toBe('unsupported');
    expect(d.run).not.toHaveBeenCalled();
  });
  it('without the command, says Fn Fn and can open the settings', async () => {
    const d = deps({ run: vi.fn(async () => Promise.reject(new Error("command 'friedliver.startDictation' not found"))), toast: vi.fn(async () => 'Open Dictation Settings') });
    expect(await startDictation(d)).toBe('fallback');
    expect(d.toast).toHaveBeenCalledWith('Press Fn twice to dictate.', 'Open Dictation Settings');
    expect(d.openUrl).toHaveBeenCalledWith(DICTATION_SETTINGS);
  });
});
