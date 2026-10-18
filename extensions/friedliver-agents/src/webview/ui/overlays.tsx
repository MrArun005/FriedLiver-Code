// Floating surfaces (COMPONENTS.md §2.12, §2.13, §2.15): tooltip, toast, dialog, sheet. Glass and
// elevation come from components.css; these handle focus, Escape and timing.
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Icon, type IconName } from '../common';
import { Button, IconButton } from './controls';
import { Countdown, type Tone } from './display';

/** A tooltip for a control whose label isn't on screen: after 500ms of hover or on focus, above it. */
export function Tooltip({ text, kbd, children }: { text: string; kbd?: string; children: ComponentChildren }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const box = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = (delay: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const r = box.current?.getBoundingClientRect();
      if (r) setAt({ x: r.left + r.width / 2, y: r.top });
    }, delay);
  };
  const hide = () => (clearTimeout(timer.current), setAt(null));
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <span ref={box} style={{ display: 'inline-flex' }} onPointerEnter={() => show(500)} onPointerLeave={hide} onFocusIn={() => show(0)} onFocusOut={hide}>
      {children}
      {at && (
        <span class="fl-tip" role="tooltip" style={{ left: `${at.x}px`, top: `${at.y}px`, transform: 'translate(-50%, calc(-100% - 8px))' }}>
          {text}
          {kbd && <kbd class="fl-kbd">{kbd}</kbd>}
        </span>
      )}
    </span>
  );
}

const TOAST_ICON: Partial<Record<Tone, IconName>> = { info: 'info', success: 'check', done: 'check', warn: 'warn', error: 'alert', failed: 'alert' };

/** A toast: what happened, an optional action, a ×; with `seconds` it counts down (paused on hover). */
export function Toast({
  tone,
  title,
  text,
  action,
  seconds,
  onClose,
}: {
  tone?: Tone;
  title: ComponentChildren;
  text?: ComponentChildren;
  action?: { label: string; run(): void };
  seconds?: number;
  onClose(): void;
}) {
  const [paused, setPaused] = useState(false);
  const left = useRef(seconds ?? 0);
  useEffect(() => {
    if (!seconds || paused) return;
    const started = Date.now();
    const t = setTimeout(onClose, left.current * 1000);
    return () => (clearTimeout(t), (left.current -= (Date.now() - started) / 1000));
  }, [seconds, paused]);
  const icon = tone && TOAST_ICON[tone];
  return (
    <div class="fl-toast" data-tone={tone} role={tone === 'error' || tone === 'failed' ? 'alert' : 'status'} onPointerEnter={() => setPaused(true)} onPointerLeave={() => setPaused(false)}>
      {icon && <Icon name={icon} />}
      <div class="fl-toast__body">
        <div class="fl-toast__title">{title}</div>
        {text && <div class="fl-toast__text">{text}</div>}
        {action && (
          <div class="fl-toast__actions">
            <Button size="sm" onClick={() => (action.run(), onClose())}>
              {action.label}
            </Button>
          </div>
        )}
      </div>
      <IconButton icon="close" label="Dismiss" size="sm" muted onClick={onClose} />
      {seconds ? <Countdown seconds={seconds} paused={paused} label="Closes automatically" /> : null}
    </div>
  );
}

/** Where toasts stack: bottom right, newest last. */
export const ToastRegion = ({ children }: { children: ComponentChildren }) => (
  <div class="fl-toasts" aria-live="polite">
    {children}
  </div>
);

/** Traps Tab inside the panel, closes on Escape, and puts focus back where it was. */
function useModal(panel: { current: HTMLElement | null }, onClose: () => void, initial?: string) {
  useLayoutEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const el = panel.current;
    (el?.querySelector<HTMLElement>(initial ?? '[data-autofocus], button, input, textarea') ?? el)?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
      if (e.key !== 'Tab' || !el) return;
      const all = [...el.querySelectorAll<HTMLElement>('button:not(:disabled), input, textarea, [tabindex="0"]')];
      if (!all.length) return;
      const [first, last] = [all[0], all[all.length - 1]];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', key, true);
    return () => (document.removeEventListener('keydown', key, true), before?.focus());
  }, []);
}

/**
 * A dialog over the overlay. Initial focus goes to the element marked data-autofocus (put it on
 * Cancel for anything destructive); a click on the overlay closes only when `dismissable`.
 */
export function Dialog({
  title,
  sub,
  children,
  foot,
  wide,
  dismissable = true,
  onClose,
}: {
  title: ComponentChildren;
  sub?: ComponentChildren;
  children?: ComponentChildren;
  foot?: ComponentChildren;
  wide?: boolean;
  dismissable?: boolean;
  onClose(): void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useModal(panel, onClose);
  return (
    <div class="fl-overlay" onMouseDown={(e) => dismissable && e.target === e.currentTarget && onClose()}>
      <div ref={panel} class={wide ? 'fl-dialog fl-dialog--wide' : 'fl-dialog'} role="dialog" aria-modal="true" tabIndex={-1}>
        <div class="fl-dialog__head">
          <div>
            <h2 class="fl-dialog__title">{title}</h2>
            {sub && <div class="fl-dialog__sub">{sub}</div>}
          </div>
          <IconButton icon="close" label="Close" size="sm" muted onClick={onClose} />
        </div>
        {children}
        {foot && <div class="fl-dialog__foot">{foot}</div>}
      </div>
    </div>
  );
}

/** A bottom sheet: rises from the edge, 60% high at most; the handle or Escape closes it. */
export function Sheet({ label, children, onClose }: { label: string; children: ComponentChildren; onClose(): void }) {
  const panel = useRef<HTMLDivElement>(null);
  useModal(panel, onClose);
  return (
    <div class="fl-overlay fl-overlay--sheet" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={panel} class="fl-sheet" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>
        <button type="button" class="fl-sheet__handle" aria-label="Close" onClick={onClose} />
        {children}
      </div>
    </div>
  );
}
