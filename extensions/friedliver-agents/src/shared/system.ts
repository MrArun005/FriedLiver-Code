// "Mac & Windows control": the fixed set of OS actions agents may ask for (docs/SYSTEM-CONTROL.md).
// Pure, so the host, the webviews and the tests agree on names, words and what may be always allowed.

export const SYSTEM_TOOLS = [
  'system_open',
  'system_apps',
  'system_focus',
  'system_shortcut',
  'system_clipboard_read',
  'system_clipboard_write',
  'system_notify',
  'system_volume',
  'system_screenshot_window',
] as const;
export type SystemTool = (typeof SYSTEM_TOOLS)[number];

export const isSystemTool = (v: unknown): v is SystemTool => (SYSTEM_TOOLS as readonly unknown[]).includes(v);

/** In words, for cards, Manage Permissions and the settings page. */
export const SYSTEM_WORDS: Record<SystemTool, string> = {
  system_open: 'Open apps, files and links',
  system_apps: 'List apps and windows',
  system_focus: 'Bring an app to the front',
  system_shortcut: 'Run an Apple Shortcut',
  system_clipboard_read: 'Read the clipboard',
  system_clipboard_write: 'Copy text to the clipboard',
  system_notify: 'Show a notification',
  system_volume: 'Read or change the volume',
  system_screenshot_window: 'Screenshot a window',
};

/** "Wants to …" on an approval card. */
export const SYSTEM_VERBS: Record<SystemTool, string> = {
  system_open: 'open',
  system_apps: 'list your apps and windows',
  system_focus: 'bring to the front',
  system_shortcut: 'run the Shortcut',
  system_clipboard_read: 'read your clipboard',
  system_clipboard_write: 'copy text to your clipboard',
  system_notify: 'show a notification',
  system_volume: 'use the volume',
  system_screenshot_window: 'screenshot a window',
};

export const SYSTEM_LIMITS = {
  /** Bytes of text written to or read from the clipboard. */
  clipboard: 100 * 1024,
  title: 100,
  body: 1000,
  /** App, Shortcut or path names. */
  name: 1024,
  /** Actions one chat (or external session) may take per minute. */
  perMinute: 30,
};

/** Tools never remembered, and never allowed for a whole chat: each use is asked for (Allow once). */
export const NEVER_ALWAYS: ReadonlySet<SystemTool> = new Set(['system_clipboard_read', 'system_screenshot_window']);

/**
 * Apps that run commands, change system settings or hold secrets: opening or focusing one is
 * asked for each time. Matched on the name without ".app"/".lnk", any case.
 */
const DANGEROUS_APPS = new Set([
  'terminal',
  'iterm',
  'iterm2',
  'warp',
  'ghostty',
  'alacritty',
  'kitty',
  'wezterm',
  'hyper',
  'tabby',
  'cmd',
  'command prompt',
  'windows terminal',
  'git bash',
  'system settings',
  'system preferences',
  'system information',
  'keychain access',
  'passwords',
  'registry editor',
  'regedit',
  'task manager',
  'script editor',
  'automator',
  'shortcuts',
  'activity monitor',
  'console',
  'disk utility',
  'directory utility',
  'migration assistant',
  'boot camp assistant',
  'control panel',
  'services',
  'computer management',
  'event viewer',
  'local security policy',
  'group policy editor',
  'windows tools',
  'administrative tools',
  'run',
  'mmc',
  'settings',
]);
const DANGEROUS_WORDS = /terminal|powershell|pwsh|command prompt|\bcmd\b|registry|regedit|keychain|\bshell\b|\bbash\b|\bzsh\b|\bwsl\b|ubuntu|task manager|system (settings|preferences)|policy/i;

export function isDangerousApp(name: string): boolean {
  const n = name
    .normalize('NFKC')
    .replace(/\.(app|lnk|exe)$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return DANGEROUS_APPS.has(n) || DANGEROUS_WORDS.test(n);
}

/**
 * What a system grant's target names: `app:<name>`, `url:<origin>`, `file:<real path>`, a Shortcut's
 * name, or '' for tools that act on nothing in particular.
 */
export function alwaysAllowable(tool: SystemTool, target: string): boolean {
  if (NEVER_ALWAYS.has(tool)) return false;
  if (target.startsWith('app:') && isDangerousApp(target.slice(4))) return false;
  return true;
}

/** A target for people: "Spotify", "https://example.com", "/Users/me/report.pdf", "any". */
export function describeTarget(target: string): string {
  const m = /^(app|url|file):(.*)$/s.exec(target);
  return m ? m[2] : target || 'anything';
}

/** The settings page's view of friedliver.system.* (host reads the user's own settings only). */
export interface SystemSettingsView {
  /** macOS or Windows; false on Linux, where every tool says it isn't supported. */
  supported: boolean;
  platform: 'mac' | 'win' | 'other';
  enabled: boolean;
  fullAutoAllowed: boolean;
  tools: Record<SystemTool, boolean>;
}

/** Tools that don't exist on a platform: the page shows them off, and they answer "not supported". */
export function unsupportedOn(platform: SystemSettingsView['platform']): SystemTool[] {
  return platform === 'mac' ? [] : platform === 'win' ? ['system_shortcut'] : [...SYSTEM_TOOLS];
}
