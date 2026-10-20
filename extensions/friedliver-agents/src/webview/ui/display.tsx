// The design system's display components (COMPONENTS.md §2.3–2.4, §2.14, §2.16–2.26).
import type { ButtonHTMLAttributes, ComponentChildren } from 'preact';
import { Icon, type IconName } from './icon';
import { AGENT_FACES, type AgentKey } from '../../shared/model';
import { messageTime, messageTimeTitle, type MessageStamp } from '../../shared/view';
import { IconButton, cx } from './controls';
import { markFor } from './marks';
import { useTooltip } from './overlays';
import { Keycaps } from './keycap';

export type Tone = 'working' | 'done' | 'failed' | 'waiting' | 'warn' | 'accent' | 'muted' | 'info' | 'success' | 'error' | 'routine' | 'review' | 'careful';

/** A status, risk or metadata pill (18 tall). `dot` marks risk; pressable pills are buttons (see FilterPill). */
export function Pill({
  tone,
  icon,
  dot,
  size,
  title,
  children,
  sub,
  class: className,
}: {
  tone?: Tone;
  icon?: IconName;
  dot?: boolean;
  size?: 'sm' | 'md' | 'touch';
  title?: string;
  children: ComponentChildren;
  sub?: ComponentChildren;
  /** A hook for tests or layout; never for looks. */
  class?: string;
}) {
  return (
    <span class={cx('fl-pill', size && size !== 'sm' && `fl-pill--${size}`, className)} data-tone={tone} title={title}>
      {dot && <span class="fl-pill__dot" aria-hidden="true" />}
      {icon && <Icon name={icon} />}
      <span class="fl-pill__text">{children}</span>
      {sub && <span class="fl-pill__sub">{sub}</span>}
    </span>
  );
}

/** A pill you press: a filter that is on or off, or a picker's trigger (the composer's pills). */
export function FilterPill({
  pressed,
  onPress,
  icon,
  size,
  tone,
  children,
  title,
  class: className,
}: {
  pressed?: boolean;
  onPress(): void;
  icon?: IconName;
  size?: 'sm' | 'md' | 'touch';
  tone?: Tone;
  children: ComponentChildren;
  title?: string;
  /** A hook for tests or layout; never for looks. */
  class?: string;
}) {
  return (
    <button type="button" class={cx('fl-pill', size && size !== 'sm' && `fl-pill--${size}`, className)} data-tone={tone} aria-pressed={pressed} title={title} onClick={onPress}>
      {icon && <Icon name={icon} />}
      <span class="fl-pill__text">{children}</span>
    </button>
  );
}

/** A file, by name, that opens when pressed: a pressable Pill in the editor's font; the full path in the tooltip. */
export function FileRef({ path, label, onOpen, title }: { path: string; label?: ComponentChildren; onOpen(): void; title?: string }) {
  return (
    <button type="button" class="fl-pill fl-pill--mono" title={title ?? path} onClick={onOpen}>
      <span class="fl-pill__text">{label ?? path.split(/[\\/]/).filter(Boolean).at(-1) ?? path}</span>
    </button>
  );
}

/** A chip that opens something, with an optional × that removes it (a pipe, a reference). */
export function ChipButton({
  icon,
  lead,
  tone,
  children,
  title,
  onPress,
  onRemove,
  removeLabel = 'Remove',
  class: className,
}: {
  icon?: IconName;
  /** In place of the icon: an avatar. */
  lead?: ComponentChildren;
  tone?: Tone;
  children: ComponentChildren;
  title?: string;
  onPress(): void;
  onRemove?: () => void;
  removeLabel?: string;
  /** A hook for tests or layout; never for looks. */
  class?: string;
}) {
  return (
    <span class={cx('fl-pill', className)} data-tone={tone}>
      <button type="button" class="fl-pill__main" title={title} onClick={onPress}>
        {icon && <Icon name={icon} />}
        {lead}
        <span class="fl-pill__text">{children}</span>
      </button>
      {onRemove && (
        <button type="button" class="fl-pill__x" aria-label={removeLabel} title={removeLabel} onClick={onRemove}>
          <Icon name="close" size={12} />
        </button>
      )}
    </span>
  );
}

export function Count({ n, loud, label }: { n: number | string; loud?: boolean; label?: string }) {
  return (
    <span class={cx('fl-count', loud && 'fl-count--loud')} title={label} aria-label={label}>
      {n}
    </span>
  );
}

export const Kbd = ({ children, inline }: { children: ComponentChildren; inline?: boolean }) =>
  typeof children === 'string' ? <Keycaps keys={children} inline={inline} /> : <kbd class={cx('fl-kbd', inline && 'fl-kbd--inline')}>{children}</kbd>;

/**
 * The agent's tile (§2.22): its letter, or with `mark` its Mark (§2.22b) in its hue. `size` 'marker' is
 * the /discuss meter's marker (§2.30, 28).
 */
export function Avatar({ agent, size, mark }: { agent: AgentKey; size?: 'sm' | 'md' | 'lg' | 'marker'; mark?: boolean }) {
  const face = AGENT_FACES[agent];
  return (
    <span class={cx('fl-avatar', size && size !== 'md' && `fl-avatar--${size}`, mark && 'fl-avatar--mark')} data-agent={agent} title={face.name} aria-label={face.name} role="img">
      {mark ? (
        <span class="fl-mark" aria-hidden="true">
          <MarkSvg agent={agent} />
        </span>
      ) : (
        face.letter
      )}
    </span>
  );
}

function MarkSvg({ agent }: { agent: string }) {
  const m = markFor(agent);
  return (
    <svg viewBox={m.viewBox ?? '0 0 16 16'} aria-hidden="true" focusable="false">
      {/* The FriedLiver mark is a line drawing with a 16% fill (§1.6). */}
      {m.fill && <path d={m.fill} fill="currentColor" fill-opacity=".16" stroke="currentColor" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linejoin="round" />}
      <path d={m.d} fill="none" stroke="currentColor" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

/** An agent's mark (§2.22b): a 16px monochrome drawing in the text colour; its hue where the tab is selected or hovered. */
export function AgentMark({ agent }: { agent: string }) {
  const name = AGENT_FACES[agent as AgentKey]?.name ?? 'Agent';
  return (
    <span class="fl-mark" data-agent={agent} role="img" aria-label={name} title={name}>
      <MarkSvg agent={agent} />
    </span>
  );
}

export const Spinner = ({ size, label = 'Working' }: { size?: 'sm' | 'md' | 'lg'; label?: string }) => (
  <span class={cx('fl-spinner', size && size !== 'md' && `fl-spinner--${size}`)} role="status" aria-label={label} />
);

/** Done of total; no `value` is indeterminate. */
export function Progress({ value, max = 1, label }: { value?: number; max?: number; label: string }) {
  const pct = value === undefined ? undefined : Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <span
      class="fl-progress"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      data-indeterminate={pct === undefined ? '' : undefined}
      style={pct === undefined ? undefined : { '--value': `${pct}%` }}
    >
      <i />
    </span>
  );
}

/** A bar that drains over `seconds`; restart it with a new `key`. */
export function Countdown({ seconds, paused, label }: { seconds: number; paused?: boolean; label: string }) {
  return (
    <span class="fl-countdown" role="timer" aria-label={label} data-paused={paused ? '' : undefined} style={{ '--countdown': `${seconds}s` }}>
      <i />
    </span>
  );
}

export const Divider = ({ vertical }: { vertical?: boolean }) => <div class={cx('fl-divider', vertical && 'fl-divider--v')} role="separator" aria-orientation={vertical ? 'vertical' : undefined} />;

export function Empty({ icon, title, children, actions }: { icon?: IconName; title: ComponentChildren; children?: ComponentChildren; actions?: ComponentChildren }) {
  return (
    <div class="fl-empty">
      {icon && <Icon name={icon} />}
      <div class="fl-empty__title">{title}</div>
      {children && <div class="fl-empty__text">{children}</div>}
      {actions && <div class="fl-empty__actions">{actions}</div>}
    </div>
  );
}

const BANNER_ICON: Partial<Record<Tone, IconName>> = { info: 'info', working: 'info', warn: 'warn', error: 'alert', failed: 'alert', success: 'check', done: 'check' };

/** An inline message across the view: what happened, one or two actions, a ×. */
export function Banner({ tone, children, actions, onDismiss }: { tone?: Tone; children: ComponentChildren; actions?: ComponentChildren; onDismiss?: () => void }) {
  const icon = tone && BANNER_ICON[tone];
  return (
    <div class="fl-banner" data-tone={tone} role={tone === 'error' || tone === 'failed' ? 'alert' : 'status'}>
      {icon && <Icon name={icon} />}
      <div class="fl-banner__text">{children}</div>
      {actions && <div class="fl-banner__actions">{actions}</div>}
      {onDismiss && <DismissButton onDismiss={onDismiss} />}
    </div>
  );
}

// The banner's ×.
const DismissButton = ({ onDismiss }: { onDismiss(): void }) => <IconButton icon="close" label="Dismiss" size="sm" muted onClick={onDismiss} />;

/**
 * A card: `inline` (default) on the menu tone, `flat` outlined only, `raised` with elevation 1.
 * `focus` rings it in the decision colour (the one the keys act on); `tone` marks waiting or failed.
 */
export function Card({
  variant = 'inline',
  size,
  bare,
  focus,
  tone,
  as: Tag = 'section',
  label,
  class: className,
  children,
  ...rest
}: {
  variant?: 'inline' | 'flat' | 'raised' | 'ghost';
  size?: 'sm' | 'md';
  /** Sections pad themselves (a card built of header, preview and footer rows). */
  bare?: boolean;
  focus?: boolean;
  tone?: 'waiting' | 'error' | 'careful';
  as?: 'section' | 'article' | 'div';
  label?: string;
  class?: string;
  children: ComponentChildren;
  [attr: `data-${string}`]: string | undefined;
}) {
  return (
    <Tag
      {...rest}
      class={cx('fl-card', variant !== 'inline' && `fl-card--${variant}`, size === 'sm' && 'fl-card--sm', bare && 'fl-card--bare', className)}
      data-focus={focus ? '' : undefined}
      data-tone={tone}
      aria-label={label}
    >
      {children}
    </Tag>
  );
}

export function CardHead({ icon, title, meta, children }: { icon?: IconName; title: ComponentChildren; meta?: ComponentChildren; children?: ComponentChildren }) {
  return (
    <div class="fl-card__head">
      {icon && <Icon name={icon} />}
      <span class="fl-card__title">{title}</span>
      {meta && <span class="fl-card__meta">{meta}</span>}
      {children}
    </div>
  );
}

export const CardFoot = ({ start, children }: { start?: boolean; children: ComponentChildren }) => (
  <div class="fl-card__foot" data-start={start ? '' : undefined}>
    {children}
  </div>
);

/**
 * One tab in a strip the caller lays out (role tablist): its own keyboard, an optional × to close it.
 * `tip`: an immediate tooltip below it (§2.18, a mark-only tab) in place of the native title.
 */
export function Tab({
  selected,
  onSelect,
  onClose,
  closeTitle = 'Close',
  tip,
  children,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'class' | 'role' | 'onClick'> & { selected: boolean; onSelect(): void; onClose?: () => void; closeTitle?: string; tip?: string; children: ComponentChildren }) {
  const tooltip = useTooltip<HTMLSpanElement>({ text: tip, delay: 0, side: 'below' });
  return (
    <span ref={tooltip.ref} class="fl-tab-wrap tab-wrap" data-active={selected ? '' : undefined} {...tooltip.handlers}>
      {tooltip.tip}
      <button {...rest} title={tip ? undefined : rest.title} type="button" role="tab" class="fl-tab tab" aria-selected={selected} onClick={onSelect}>
        {children}
      </button>
      {onClose && (
        // For the pointer; the keyboard closes the focused tab with Delete, so the × is no Tab stop of its own.
        <button type="button" class="fl-tab__x tab-close" tabIndex={-1} aria-hidden="true" title={closeTitle} onClick={onClose}>
          <Icon name="close" size={12} />
        </button>
      )}
    </span>
  );
}

/** A strip of tabs (role tablist); the panel is the caller's. */
export function Tabs<T extends string>({
  label,
  value,
  tabs,
  onChange,
}: {
  label: string;
  value: T;
  tabs: { value: T; label: ComponentChildren; icon?: IconName; count?: number }[];
  onChange(v: T): void;
}) {
  return (
    <div class="fl-tabs" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button key={t.value} type="button" role="tab" class="fl-tab" aria-selected={t.value === value} tabIndex={t.value === value ? 0 : -1} onClick={() => onChange(t.value)}>
          {t.icon && <Icon name={t.icon} />}
          <span class="fl-tab__label">{t.label}</span>
          {t.count !== undefined && <Count n={t.count} />}
        </button>
      ))}
    </div>
  );
}

/** A list or tree row: a leading icon, the text, quiet meta at the end. Pressable when given `onPress`. */
export function Row({
  icon,
  children,
  meta,
  selected,
  level,
  expanded,
  onPress,
  title,
  label,
  class: className,
}: {
  icon?: IconName;
  children: ComponentChildren;
  meta?: ComponentChildren;
  selected?: boolean;
  level?: number;
  expanded?: boolean;
  onPress?: () => void;
  title?: string;
  /** Accessible name when the visible text isn't enough. */
  label?: string;
  /** A hook for tests or layout; never for looks. */
  class?: string;
}) {
  const body = (
    <>
      {expanded !== undefined && (
        <span class="fl-row__twisty">
          <Icon name="chevron" />
        </span>
      )}
      {icon && <Icon name={icon} />}
      <span class="fl-row__text">{children}</span>
      {meta && <span class="fl-row__meta">{meta}</span>}
    </>
  );
  const style = level && level > 1 ? { '--level': String(level) } : undefined;
  return onPress ? (
    <button type="button" class={cx('fl-row', className)} aria-selected={selected} aria-expanded={expanded} aria-label={label} title={title} style={style} onClick={onPress}>
      {body}
    </button>
  ) : (
    <div class={cx('fl-row', className)} aria-selected={selected} title={title} style={style}>
      {body}
    </div>
  );
}

/**
 * When a message was sent (§2.32): hidden until the `[data-stamp]` message it is in is hovered or
 * has focus. Nothing at all without a time (chats saved before times were kept).
 */
export function Timestamp({ stamp, class: className }: { stamp?: MessageStamp; class?: string }) {
  if (!stamp) return null;
  // ponytail: "today" is read when the message draws; one drawn before midnight keeps its short form until it draws again.
  return (
    <time class={cx('fl-time', className)} dateTime={new Date(stamp.at).toISOString()} title={messageTimeTitle(stamp)}>
      {messageTime(stamp.at, Date.now())}
    </time>
  );
}
