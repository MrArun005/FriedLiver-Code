// The Keycap component (§2.25); its platform logic is ui/keys.ts. No other ui/ imports, so Button,
// ChoiceRow and the tooltip can all use it without a cycle.
import { keycaps } from './keys';

const cx = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(' ');

/**
 * Keycaps (§2.25), drawn by platform from one written form ("⌘⏎", "Esc", "⌃⌘I", "⌘K A"; ui/keys.ts):
 * macOS one cap per key in ⌃⌥⇧⌘ order, Windows and Linux one "Ctrl+Shift+X" cap.
 */
export function Keycaps({ keys, inline, class: className }: { keys: string; inline?: boolean; class?: string }) {
  const caps = keycaps(keys);
  const one = (cap: string, i?: number) => (
    <kbd key={i} class={cx('fl-kbd', inline && 'fl-kbd--inline', caps.length === 1 && className)}>
      {cap}
    </kbd>
  );
  return caps.length === 1 ? one(caps[0]) : <span class={cx('fl-kbds', className)}>{caps.map(one)}</span>;
}
