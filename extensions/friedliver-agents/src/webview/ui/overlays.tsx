// Floating surfaces (COMPONENTS.md §2.12, §2.13, §2.15): tooltip, toast, dialog, sheet. Glass and
// elevation come from components.css; these handle focus, Escape and timing.
import type { ComponentChildren } from 'preact';
import { createPortal } from 'preact/compat';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Icon, type IconName } from './icon';
import { keyText } from './keys';
import { Button, IconButton } from './controls';
import { Countdown, type Tone } from './display';
import { dismissTimer } from '../../shared/toasts';

/** Space between a tooltip and its target, and the viewport's edge (§2.14). */
const TIP_GAP = 8;

/**
 * A tooltip on an element the caller keeps (§2.14): spread `handlers` on it, put `ref` on it, render `tip`.
 * After `delay` ms of hover (500; 0 where the target shows no text), at once on focus; above it, or `below`; kept in the viewport.
 */
export function useTooltip<T extends HTMLElement>({ text, kbd, delay = 500, side = 'above' }: { text?: string; kbd?: string; delay?: number; side?: 'above' | 'below' }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const ref = useRef<T>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = (ms: number) => {
    clearTimeout(timer.current);
    const place = () => {
      const r = ref.current?.getBoundingClientRect();
      if (r) setAt({ x: r.left + r.width / 2, y: side === 'below' ? r.bottom + TIP_GAP : r.top - TIP_GAP });
    };
    if (ms) timer.current = setTimeout(place, ms);
    else place();
  };
  const hide = () => (clearTimeout(timer.current), setAt(null));
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!text) hide();
  }, [text]);
  // Centred on the target, then nudged back inside the viewport.
  useLayoutEffect(() => {
    const el = tipRef.current;
    if (!el || !at) return;
    const w = el.offsetWidth;
    el.style.left = `${Math.max(TIP_GAP, Math.min(at.x - w / 2, window.innerWidth - w - TIP_GAP))}px`;
  }, [at]);
  const handlers = text
    ? { onPointerEnter: () => show(delay), onPointerLeave: hide, onFocusIn: () => show(0), onFocusOut: hide }
    : {};
  // In <body>: a strip's clip-path or a container (containment makes it the fixed box) would cut or shift it.
  const tip =
    at && text ? createPortal(
      <span ref={tipRef} class="fl-tip" role="tooltip" style={{ left: `${at.x}px`, top: `${at.y}px`, transform: side === 'below' ? undefined : 'translateY(-100%)' }}>
        {text}
        {kbd && <kbd class="fl-kbd">{keyText(kbd)}</kbd>}
      </span>,
      document.body,
    ) : null;
  return { ref, handlers, tip };
}

/** A tooltip for a control whose label isn't on screen: after 500ms of hover or on focus, above it. */
export function Tooltip({ text, kbd, delay, side, children }: { text: string; kbd?: string; delay?: number; side?: 'above' | 'below'; children: ComponentChildren }) {
  const { ref, handlers, tip } = useTooltip<HTMLSpanElement>({ text, kbd, delay, side });
  return (
    <span ref={ref} style={{ display: 'inline-flex' }} {...handlers}>
      {children}
      {tip}
    </span>
  );
}

const TOAST_ICON: Partial<Record<Tone, IconName>> = { info: 'info', success: 'check', done: 'check', warn: 'warn', error: 'alert', failed: 'alert' };

/** A toast: what happened, optional actions, a ×; with `seconds` it counts down (paused while hovered or focused). */
export function Toast({
  tone,
  title,
  text,
  action,
  actions,
  seconds,
  onClose,
}: {
  tone?: Tone;
  title: ComponentChildren;
  text?: ComponentChildren;
  action?: { label: string; run(): void };
  actions?: { label: string; run(): void }[];
  seconds?: number;
  onClose(): void;
}) {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const paused = hover || focus;
  const close = useRef(onClose);
  close.current = onClose;
  const timer = useRef<ReturnType<typeof dismissTimer>>(undefined);
  useEffect(() => {
    if (!seconds) return;
    timer.current = dismissTimer(seconds, () => close.current());
    return () => timer.current?.clear();
  }, [seconds]);
  useEffect(() => (paused ? timer.current?.pause() : timer.current?.resume()), [paused]);
  const icon = tone && TOAST_ICON[tone];
  const buttons = [...(action ? [action] : []), ...(actions ?? [])];
  return (
    <div
      class="fl-toast"
      data-tone={tone}
      role={tone === 'error' || tone === 'failed' ? 'alert' : 'status'}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onFocusIn={() => setFocus(true)}
      onFocusOut={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setFocus(false)}
    >
      {icon && <Icon name={icon} />}
      <div class="fl-toast__body">
        <div class="fl-toast__title">{title}</div>
        {text && <div class="fl-toast__text">{text}</div>}
        {buttons.length > 0 && (
          <div class="fl-toast__actions">
            {buttons.map((a) => (
              <Button key={a.label} size="sm" onClick={() => (a.run(), onClose())}>
                {a.label}
              </Button>
            ))}
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
