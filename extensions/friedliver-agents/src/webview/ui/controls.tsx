// The design system's controls (COMPONENTS.md §2.1–2.10): the only place a webview draws a
// <button>, <input>, <textarea> or <select>. Views compose these; test/designSystem.test.ts
// fails on a raw one anywhere else (baseline in test/fixtures/ds-baseline.json, ratchet down).
import { createElement, type ButtonHTMLAttributes, type ComponentChildren, type InputHTMLAttributes, type Ref, type TextareaHTMLAttributes } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Icon, type IconName } from './icon';

export type Variant = 'primary' | 'secondary' | 'quiet' | 'danger' | 'quiet-danger' | 'brand' | 'link' | 'text';
export type Size = 'sm' | 'md' | 'lg' | 'touch';

/** Joins class names, dropping empty ones. */
export const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(' ');

type ButtonBase = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'size' | 'icon' | 'class' | 'className'> & {
  variant?: Variant;
  size?: Size;
  /** A leading icon. */
  icon?: IconName;
  /** A trailing icon (a chevron, an external-link arrow). */
  iconEnd?: IconName;
  /** A key shown inside the button at 55%, after the label ("Allow ⏎"). */
  kbd?: string;
  /** The spinner replaces the label; the button keeps its width and is not clickable. */
  loading?: boolean;
  block?: boolean;
  /** Text buttons: one line, cut with an ellipsis. */
  truncate?: boolean;
  /** Link: the quiet grey link (one that repeats on every row), leaving the accent to the one action that matters. */
  muted?: boolean;
  /** Extra classes for layout only (margin, flex); never for looks. */
  class?: string;
  ref?: Ref<HTMLButtonElement>;
};

function buttonClass(p: { variant?: Variant; size?: Size; block?: boolean; class?: string }, extra?: string) {
  const v = p.variant ?? 'secondary';
  return cx('fl-btn', v === 'quiet-danger' ? 'fl-btn--quiet fl-btn--danger' : `fl-btn--${v}`, p.size && p.size !== 'md' && `fl-btn--${p.size}`, p.block && 'fl-btn--block', extra, p.class);
}

export function Button({ variant, size, icon, iconEnd, kbd, loading, block, truncate, muted, class: className, children, type = 'button', disabled, onClick, ...rest }: ButtonBase) {
  return (
    <button
      {...rest}
      type={type}
      class={buttonClass({ variant, size, block, class: cx(truncate && 'fl-btn--truncate', muted && 'fl-btn--muted', className) })}
      disabled={disabled}
      aria-busy={loading ? 'true' : undefined}
      onClick={loading ? undefined : onClick}
    >
      {icon && <Icon name={icon} />}
      {children}
      {kbd && <kbd class="fl-kbd fl-kbd--inline">{kbd}</kbd>}
      {iconEnd && <Icon name={iconEnd} />}
      {loading && <span class="fl-spinner" aria-hidden="true" />}
    </button>
  );
}

/** A square button with one icon; its label is the tooltip and the accessible name. Quiet unless told. */
export function IconButton({
  icon,
  label,
  variant = 'quiet',
  size,
  muted,
  round,
  class: className,
  type = 'button',
  ...rest
}: Omit<ButtonBase, 'icon' | 'iconEnd' | 'kbd' | 'block' | 'children'> & { icon: IconName; label: string; muted?: boolean; round?: boolean; children?: never }) {
  return (
    <button {...rest} type={type} title={rest.title ?? label} aria-label={label} class={buttonClass({ variant, size, class: className }, cx('fl-btn--icon', muted && 'fl-btn--muted', round && 'fl-btn--round'))}>
      <Icon name={icon} />
    </button>
  );
}

/**
 * The default action plus a ▾ for the others (scope: once / this chat / always). The menu is the
 * caller's: pass a Popover-rendering `menu`, which receives the trigger class to use.
 */
export function SplitButton({ menu, size, variant = 'primary', ...rest }: ButtonBase & { menu: (triggerClass: string) => ComponentChildren }) {
  return (
    <span class="fl-split">
      <Button {...rest} size={size} variant={variant} />
      {menu(buttonClass({ variant, size }, 'fl-btn--icon'))}
    </span>
  );
}

/**
 * Hold to confirm: press and hold (pointer, Enter or Space) for 600ms; letting go early does nothing.
 * The non-hold path, for anyone who can't hold: a second press within 3s confirms ("Press again").
 */
export function HoldButton({ onConfirm, children, variant = 'danger', ...rest }: Omit<ButtonBase, 'onClick'> & { onConfirm(): void }) {
  const [holding, setHolding] = useState(false);
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const disarm = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const start = () => {
    if (rest.disabled) return;
    setHolding(true);
    timer.current = setTimeout(() => (setHolding(false), setArmed(false), onConfirm()), 600);
  };
  const stop = () => {
    clearTimeout(timer.current);
    setHolding(false);
  };
  useEffect(() => () => (clearTimeout(timer.current), clearTimeout(disarm.current)), []);
  return (
    <Button
      {...rest}
      variant={variant}
      class={cx('fl-btn--hold', rest.class)}
      data-holding={holding ? '' : undefined}
      aria-description="Hold to confirm, or press twice"
      onPointerDown={start}
      onPointerUp={stop}
      onPointerLeave={stop}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
          e.preventDefault();
          start();
        }
      }}
      onKeyUp={(e) => {
        if (e.key === 'Enter' || e.key === ' ') stop();
      }}
      onClick={(e) => {
        // A click that ends a full hold already confirmed; a quick click arms, a second one confirms.
        if (e.detail === 0 || holding) return;
        if (armed) {
          clearTimeout(disarm.current);
          setArmed(false);
          onConfirm();
        } else {
          setArmed(true);
          disarm.current = setTimeout(() => setArmed(false), 3000);
        }
      }}
    >
      {armed ? 'Press again' : children}
    </Button>
  );
}

/** One choice of several, shown side by side. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  size,
  block,
}: {
  label: string;
  value: T;
  options: { value: T; label: ComponentChildren; icon?: IconName; title?: string; disabled?: boolean }[];
  onChange(v: T): void;
  size?: 'md' | 'touch';
  block?: boolean;
}) {
  const move = (e: KeyboardEvent) => {
    const i = options.findIndex((o) => o.value === value);
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = options[(i + step + options.length) % options.length];
    onChange(next.value);
    ((e.currentTarget as HTMLElement).querySelector(`[data-value="${CSS.escape(next.value)}"]`) as HTMLElement | null)?.focus();
  };
  return (
    <div class={cx('fl-seg', size === 'touch' && 'fl-seg--touch', block && 'fl-seg--block')} role="radiogroup" aria-label={label} onKeyDown={move}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          class="fl-seg__item"
          data-value={o.value}
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          title={o.title}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
        >
          {o.icon && <Icon name={o.icon} />}
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  size,
  disabled,
  title,
  class: className,
}: {
  checked: boolean;
  onChange(v: boolean): void;
  label: string;
  size?: 'md' | 'touch';
  disabled?: boolean;
  title?: string;
  /** Layout only. */
  class?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      class={cx('fl-toggle', size === 'touch' && 'fl-toggle--touch', className)}
      aria-checked={checked}
      aria-label={label}
      title={title ?? label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}

export function Checkbox({
  checked,
  indeterminate,
  onChange,
  children,
  disabled,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange(v: boolean): void;
  children: ComponentChildren;
  disabled?: boolean;
}) {
  return (
    <label class="fl-check">
      <input
        type="checkbox"
        class="fl-check__box"
        checked={checked}
        disabled={disabled}
        ref={(el) => {
          if (el) el.indeterminate = !!indeterminate;
        }}
        onChange={(e) => onChange((e.currentTarget as HTMLInputElement).checked)}
      />
      {children}
    </label>
  );
}

/** A row in a list of choices: the dot, the label, an optional description under it. */
export function RadioRow({
  name,
  checked,
  onChange,
  label,
  desc,
  disabled,
}: {
  name: string;
  checked: boolean;
  onChange(): void;
  label: ComponentChildren;
  desc?: ComponentChildren;
  disabled?: boolean;
}) {
  return (
    <label class="fl-radio">
      <input type="radio" class="fl-radio__dot" name={name} checked={checked} disabled={disabled} onChange={onChange} />
      <span class="fl-radio__text">
        <span>{label}</span>
        {desc && <span class="fl-radio__desc">{desc}</span>}
      </span>
    </label>
  );
}

/**
 * A choice as a button in a listbox or group (an agent's question): the Radio row's look, its dot (or a
 * checkbox when several may be picked), the label, a description under it, and its number key at the end.
 */
export function ChoiceRow({
  multi,
  selected,
  label,
  desc,
  kbd,
  onPick,
  action,
  class: className,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'class' | 'label' | 'role'> & {
  multi?: boolean;
  selected: boolean;
  label: ComponentChildren;
  desc?: ComponentChildren;
  kbd?: string;
  onPick(): void;
  /** Not a choice but an action in the list ("Other…" in a multi-select): a plain button, no dot. */
  action?: boolean;
  class?: string;
}) {
  return (
    <button
      {...rest}
      type="button"
      role={action && multi ? 'button' : multi ? 'checkbox' : 'option'}
      aria-checked={multi && !action ? selected : undefined}
      aria-selected={multi ? undefined : selected}
      class={cx('fl-radio fl-radio--btn', className)}
      data-on={selected ? '' : undefined}
      onClick={onPick}
    >
      {!action && <span class={multi ? 'fl-check__box' : 'fl-radio__dot'} data-on={selected ? '' : undefined} aria-hidden="true" />}
      <span class="fl-radio__text">
        <span>{label}</span>
        {desc && <span class="fl-radio__desc">{desc}</span>}
      </span>
      {kbd && <kbd class="fl-kbd fl-radio__key">{kbd}</kbd>}
    </button>
  );
}

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'class' | 'type' | 'role'> & {
  size?: 'sm' | 'md' | 'touch';
  type?: 'text' | 'search' | 'number' | 'url' | 'email' | 'password';
  class?: string;
  ref?: Ref<HTMLInputElement>;
};

export function Input({ size, class: className, type = 'text', ...rest }: InputProps) {
  // createElement: the JSX types can't narrow a union `type` against the per-type ARIA rules.
  return createElement('input', { ...rest, type, class: cx('fl-input', size && size !== 'md' && `fl-input--${size}`, className) });
}

export function Textarea({ class: className, rows, ...rest }: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'class' | 'rows'> & { class?: string; rows?: number; ref?: Ref<HTMLTextAreaElement> }) {
  return <textarea {...rest} rows={rows} style={rows ? { '--rows': String(rows) } : undefined} class={cx('fl-input', className)} />;
}

/** A filter field: the search glyph, the text, a clear button once there is text. */
export function Search({ value, onInput, placeholder, label, size, ...rest }: Omit<InputProps, 'onInput' | 'value'> & { value: string; onInput(v: string): void; label: string }) {
  return (
    <div class="fl-search" role="search">
      <Icon name="search" />
      <Input {...rest} size={size} type="search" value={value} placeholder={placeholder} aria-label={label} onInput={(e) => onInput((e.currentTarget as HTMLInputElement).value)} />
      {value && <IconButton icon="close" label="Clear" size="sm" muted onClick={() => onInput('')} />}
    </div>
  );
}

/** A labelled field: label, the control, help or an error under it. */
export function Field({ label, help, error, children }: { label: ComponentChildren; help?: ComponentChildren; error?: ComponentChildren; children: ComponentChildren }) {
  return (
    <label class="fl-field">
      <span class="fl-field__label">{label}</span>
      {children}
      {(error || help) && (
        <span class="fl-field__help" data-tone={error ? 'error' : undefined}>
          {error ?? help}
        </span>
      )}
    </label>
  );
}

/** A dropdown's trigger: the field's look and a chevron. Pair it with Popover for the list. */
export function selectTrigger(value: ComponentChildren, placeholder = 'Choose…') {
  return (
    <>
      <span class="fl-select__value" data-empty={value ? undefined : ''}>
        {value || placeholder}
      </span>
      <Icon name="chevronDown" />
    </>
  );
}
