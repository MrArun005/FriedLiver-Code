/** The parts of `WorkspaceConfiguration.inspect()` this reads. */
export interface InspectedSetting<T> {
  defaultValue?: T;
  globalValue?: T;
  workspaceValue?: T;
  workspaceFolderValue?: T;
}

/**
 * A setting's value from the user's own settings, or its default, never from a
 * workspace. Which program FriedLiver runs as an agent (and hands that vendor's
 * API key) is the user's choice, not a repository's `.vscode/settings.json`.
 * The manifest gives these settings `machine` scope, so VS Code already drops
 * workspace values; reading only the user's layer keeps that true in editors
 * that don't. `ignored` says a workspace tried.
 */
export function userSetting<T>(inspected: InspectedSetting<T> | undefined): { value: T | undefined; ignored: boolean } {
  return {
    value: inspected?.globalValue ?? inspected?.defaultValue,
    ignored: inspected?.workspaceValue !== undefined || inspected?.workspaceFolderValue !== undefined,
  };
}
