// Menus and popovers (COMPONENTS.md §2.11): a trigger and a floating glass panel. Escape, Tab or a
// click outside closes it; Escape returns focus to the trigger; menus move with the arrow keys.
import type { ComponentChildren } from 'preact';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Icon, type IconName } from './icon';
import { cx } from './controls';

const MENU_ITEMS = '[role^="menuitem"]:not(:disabled)';

/** A button that opens a menu or a small form. */
export function Popover({
  label,
  title,
  trigger,
  kind = 'menu',
  align = 'start',
  buttonClass,
  class: className,
  disabled,
  children,
}: {
  /** The panel's accessible name. */
  label: string;
  /** Tooltip and accessible name for a button that shows only an icon. */
  title?: string;
  trigger: ComponentChildren;
  kind?: 'menu' | 'dialog';
  align?: 'start' | 'end';
  /** The trigger's component classes (fl-btn …, fl-pill, fl-select). */
  buttonClass?: string;
  class?: string;
  disabled?: boolean;
  children: (close: (refocus?: boolean) => void) => ComponentChildren;
}) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<{ up: boolean; dx: number; max?: number }>({ up: false, dx: 0 });
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  useLayoutEffect(() => {
    if (!open) setPlace({ up: false, dx: 0 });
    if (!open || !panel.current || !button.current) return;
    // Open on the side with room (below first), cap the height to that room so a long menu scrolls
    // inside the window, and slide sideways to stay inside the webview.
    const b = button.current.getBoundingClientRect();
    const p = panel.current.getBoundingClientRect();
    const below = window.innerHeight - b.bottom - 12;
    const above = b.top - 12;
    const up = p.height > below && above > below;
    const room = Math.floor(up ? above : below);
    const dx = p.right > window.innerWidth - 8 ? window.innerWidth - 8 - p.right : 0;
    setPlace({ up, dx: p.left + dx < 8 ? 8 - p.left : dx, max: p.height > room ? room : undefined });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // Menus focus their first item; forms their text field first.
    const first =
      kind === 'menu'
        ? panel.current?.querySelector<HTMLElement>(MENU_ITEMS)
        : (panel.current?.querySelector<HTMLElement>('input, textarea') ?? panel.current?.querySelector<HTMLElement>('button:not(:disabled)'));
    first?.focus();
    const outside = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !button.current?.contains(t)) setOpen(false);
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [open]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === 'Tab' && kind === 'menu') {
      setOpen(false);
      return;
    }
    if (kind !== 'menu' || !panel.current) return;
    const items = [...panel.current.querySelectorAll<HTMLElement>(MENU_ITEMS)];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => {
      e.preventDefault();
      items[(n + items.length) % items.length]?.focus();
    };
    if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(items.length - 1);
  };

  return (
    <span class={cx('pop', className)}>
      <button
        ref={button}
        type="button"
        class={buttonClass}
        title={title}
        disabled={disabled}
        aria-label={title}
        aria-haspopup={kind === 'menu' ? 'menu' : 'dialog'}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (kind === 'menu' && !open && e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        {trigger}
      </button>
      {open && (
        <div
          ref={panel}
          id={id}
          class={cx('fl-menu', kind === 'dialog' && 'fl-menu--form')}
          role={kind}
          aria-label={label}
          data-up={place.up ? '' : undefined}
          data-end={align === 'end' ? '' : undefined}
          style={{ transform: place.dx ? `translateX(${Math.round(place.dx)}px)` : undefined, maxHeight: place.max ? `${place.max}px` : undefined }}
          onKeyDown={onKeyDown}
        >
          {children(close)}
        </div>
      )}
    </span>
  );
}

/** A menu row: icon, label (and a description under it), then a value, key or check at the end. */
export function MenuItem({
  icon,
  lead,
  class: className,
  value,
  label,
  desc,
  end,
  kbd,
  checked,
  tone,
  disabled,
  title,
  onSelect,
}: {
  icon?: IconName;
  /** In place of the icon: an avatar or another 16px mark. */
  lead?: ComponentChildren;
  /** A hook for tests or layout; never for looks. */
  class?: string;
  /** The choice's value, as data-value (pickers). */
  value?: string;
  label: ComponentChildren;
  desc?: ComponentChildren;
  end?: ComponentChildren;
  kbd?: string;
  /** A radio or check row: undefined for a plain action. */
  checked?: boolean;
  tone?: 'error';
  disabled?: boolean;
  title?: string;
  onSelect(): void;
}) {
  return (
    <button
      type="button"
      role={checked === undefined ? 'menuitem' : 'menuitemradio'}
      class={cx('fl-menu__item', className)}
      aria-checked={checked}
      data-value={value}
      data-tone={tone}
      disabled={disabled}
      title={title}
      onClick={onSelect}
    >
      {icon && <Icon name={icon} />}
      {lead}
      {desc ? (
        <span class="fl-menu__text">
          <span class="fl-menu__label">{label}</span>
          <span class="fl-menu__desc">{desc}</span>
        </span>
      ) : (
        <span class="fl-menu__label">{label}</span>
      )}
      {(end || kbd || checked !== undefined) && (
        <span class="fl-menu__end">
          {end}
          {kbd && <kbd class="fl-kbd">{kbd}</kbd>}
          {checked !== undefined && (
            <span class="fl-menu__check">
              <Icon name="check" />
            </span>
          )}
        </span>
      )}
    </button>
  );
}

export const MenuSep = () => <div class="fl-menu__sep" role="separator" />;

export function MenuTitle({ children, end }: { children: ComponentChildren; end?: ComponentChildren }) {
  return (
    <div class="fl-menu__title" aria-hidden="true">
      {end ? <span>{children}</span> : children}
      {end}
    </div>
  );
}
