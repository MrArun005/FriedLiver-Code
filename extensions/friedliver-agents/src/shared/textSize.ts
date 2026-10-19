/** The chat's text size: one px value (--fl-font-size) everything in the chat scales from. */
export const TEXT_MIN = 10;
export const TEXT_MAX = 20;
export const TEXT_DEFAULT = 13;

export const clampTextSize = (n: number): number => Math.min(TEXT_MAX, Math.max(TEXT_MIN, Math.round(n)));

/** friedliver.chat.fontSize as the body carries it; anything unusable is the default. */
export function defaultTextSize(raw: string | undefined): number {
  const n = Number(raw);
  return raw && Number.isFinite(n) ? clampTextSize(n) : TEXT_DEFAULT;
}

type Keys = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey'>;

/**
 * Cmd (macOS) or Ctrl with = / + / - / 0: the tab's next text size, or null
 * when the key isn't one of these. `current` null = the tab follows the default.
 */
export function textSizeKey(e: Keys, mac: boolean, current: number | null, fallback: number): number | null {
  if (e.altKey || !(mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey)) return null;
  const base = current ?? fallback;
  if (e.key === '=' || e.key === '+') return clampTextSize(base + 1);
  if (e.key === '-' || e.key === '_') return clampTextSize(base - 1);
  if (e.key === '0') return fallback;
  return null;
}
