import { useEffect, useRef, useState } from 'preact/hooks';
import { TEXT_DEFAULT, defaultTextSize, textSizeKey } from '../shared/textSize';
import { usePersisted } from './common';

const MAC = document.body.dataset.platform === 'darwin';
const FALLBACK = defaultTextSize(document.body.dataset.fontSize);

/**
 * Cmd/Ctrl + = - 0 size this tab's text only. The size lives in this webview's
 * own state (vscode.setState), so each chat tab keeps its own; the setting is
 * the size a new tab starts at.
 */
export function TextSize() {
  const [size, setSize] = usePersisted<number | null>('textSize', null);
  const [shown, setShown] = useState(0);
  const px = size ?? FALLBACK;
  // The latest size, for presses that come faster than a render.
  const current = useRef(size);
  useEffect(() => {
    const root = document.documentElement.style;
    // At the stock default, the stylesheet's own default (the editor's chat font size, else 13px) stands.
    if (size === null && FALLBACK === TEXT_DEFAULT) root.removeProperty('--fl-font-size');
    else root.setProperty('--fl-font-size', `${px}px`);
  }, [size, px]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const next = textSizeKey(e, MAC, current.current, FALLBACK);
      if (next === null) return;
      // Capture phase, before the webview's own listener forwards the key to the window (which would zoom it).
      e.preventDefault();
      e.stopPropagation();
      current.current = next === FALLBACK ? null : next;
      setSize(current.current);
      setShown((n) => n + 1);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  useEffect(() => {
    if (!shown) return;
    const t = setTimeout(() => setShown(0), 1200);
    return () => clearTimeout(t);
  }, [shown]);
  return shown ? (
    <div class="text-size-toast" role="status">
      Text {px}px
    </div>
  ) : null;
}
