/** System Settings › Keyboard › Dictation. */
export const DICTATION_SETTINGS = 'x-apple.systempreferences:com.apple.Keyboard-Settings.extension';

export interface DictationDeps {
  platform: NodeJS.Platform;
  /** Runs a workbench command; rejects when it doesn't exist. */
  run: (command: string) => Thenable<unknown>;
  /** Shows the fallback and resolves to the button picked, if any. */
  toast: (text: string, button: string) => Thenable<string | undefined>;
  openUrl: (url: string) => unknown;
}

/**
 * Starts macOS dictation in the focused text box through the app's
 * friedliver.startDictation command (patch 0120). Without it (another editor,
 * an older build), says how to start it by hand.
 */
export async function startDictation(deps: DictationDeps): Promise<'started' | 'fallback' | 'unsupported'> {
  if (deps.platform !== 'darwin') return 'unsupported';
  try {
    await deps.run('friedliver.startDictation');
    return 'started';
  } catch {
    const open = 'Open Dictation Settings';
    if ((await deps.toast('Press Fn twice to dictate.', open)) === open) deps.openUrl(DICTATION_SETTINGS);
    return 'fallback';
  }
}
