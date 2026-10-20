// Keycaps by platform (COMPONENTS.md v2 §1.14, §2.25). A key is written once, the macOS way or with words
// ("⌘⏎", "⇧⏎", "Ctrl+⏎", "Esc", "⌃⌘I", "⌘K A"), and drawn the platform's way: on macOS one cap per key
// in Apple's ⌃⌥⇧⌘ order; on Windows and Linux one cap "Ctrl+Alt+Shift+X", where ⌘ is Ctrl and a ⌃ held
// with ⌘ is Alt (⌃⌘I = Ctrl+Alt+I), and Enter, Esc and Backspace are spelled out. No DOM here.

export type Platform = 'mac' | 'windows' | 'linux';

type Mod = '⌃' | '⌥' | '⇧' | '⌘';
const MAC_ORDER: Mod[] = ['⌃', '⌥', '⇧', '⌘'];
const WORD: Record<string, Mod> = { ctrl: '⌘', control: '⌘', cmd: '⌘', command: '⌘', meta: '⌘', shift: '⇧', alt: '⌥', option: '⌥', opt: '⌥' };
const WIN_KEY: Record<string, string> = { '⏎': 'Enter', '↵': 'Enter', '⌫': 'Backspace', '⌦': 'Delete', esc: 'Esc', '⎋': 'Esc' };

export interface Combo {
  mods: Mod[];
  key: string;
}

/** One combo ("⌘⏎", "Ctrl+Shift+P") into its modifiers, in the order written, and its key. */
export function parseCombo(text: string): Combo {
  const mods: Mod[] = [];
  let rest = text.trim();
  for (;;) {
    const sym = rest[0] as Mod;
    if (rest.length > 1 && MAC_ORDER.includes(sym)) {
      mods.push(sym);
      rest = rest.slice(1);
      continue;
    }
    const word = /^([A-Za-z]+)\+(?=.)/.exec(rest);
    if (word && WORD[word[1].toLowerCase()]) {
      mods.push(WORD[word[1].toLowerCase()]);
      rest = rest.slice(word[0].length);
      continue;
    }
    break;
  }
  return { mods, key: rest };
}

/** The platform from the webview body (the host sets data-platform; the phone app and tests default to macOS). */
export function currentPlatform(): Platform {
  const p = typeof document === 'undefined' ? undefined : document.body?.dataset.platform;
  return p === 'windows' || p === 'linux' ? p : 'mac';
}

/** The caps to draw for `keys` (a combo, or a chord of combos separated by a space). */
export function keycaps(keys: string, platform: Platform = currentPlatform()): string[] {
  const combos = keys.trim().split(/\s+(?=\S)/).map(parseCombo);
  if (platform === 'mac') {
    const caps = combos.map((c) => [...MAC_ORDER.filter((m) => c.mods.includes(m)), c.key].join(''));
    // A single combo is one cap per key; a chord renders VS Code style in one cap ("⌘K A").
    return combos.length > 1 ? [caps.join(' ')] : [...MAC_ORDER.filter((m) => combos[0].mods.includes(m)), combos[0].key];
  }
  const win = combos.map((c) => {
    const ctrl = c.mods.includes('⌘');
    const alt = c.mods.includes('⌥') || (ctrl && c.mods.includes('⌃'));
    const words = [ctrl || c.mods.includes('⌃') ? 'Ctrl' : '', alt ? 'Alt' : '', c.mods.includes('⇧') ? 'Shift' : ''].filter(Boolean);
    const key = WIN_KEY[c.key.toLowerCase()] ?? WIN_KEY[c.key] ?? (c.key.length === 1 ? c.key.toUpperCase() : c.key);
    return [...words, key].join('+');
  });
  return [win.join(' ')];
}

/** The keys as one string, for a tooltip or an aria-label ("⌘⏎" / "Ctrl+Enter"). */
export const keyText = (keys: string, platform: Platform = currentPlatform()) => keycaps(keys, platform).join(platform === 'mac' ? '' : ' ');

/** Why a written combo is wrong: a repeated modifier, or modifiers out of Apple's ⌃⌥⇧⌘ order. */
export function keyProblem(keys: string): string | undefined {
  for (const combo of keys.trim().split(/\s+(?=\S)/)) {
    const { mods, key } = parseCombo(combo);
    if (!key) return `"${combo}" has no key`;
    if (new Set(mods).size !== mods.length) return `"${combo}" repeats a modifier`;
    const order = mods.map((m) => MAC_ORDER.indexOf(m));
    if (order.some((o, i) => i > 0 && o < order[i - 1])) return `"${combo}" is out of ⌃⌥⇧⌘ order`;
  }
  return undefined;
}
