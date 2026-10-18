// The design system's display components (COMPONENTS.md §2.3–2.4, §2.14, §2.16–2.26).
import type { ComponentChildren } from 'preact';
import { Icon, type IconName } from '../common';
import { AGENT_FACES, type AgentKey } from '../../shared/model';
import { IconButton, cx } from './controls';

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
}: {
  tone?: Tone;
  icon?: IconName;
  dot?: boolean;
  size?: 'sm' | 'md' | 'touch';
  title?: string;
  children: ComponentChildren;
  sub?: ComponentChildren;
}) {
  return (
    <span class={cx('fl-pill', size && size !== 'sm' && `fl-pill--${size}`)} data-tone={tone} title={title}>
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
  children,
  title,
}: {
  pressed?: boolean;
  onPress(): void;
  icon?: IconName;
  size?: 'sm' | 'md' | 'touch';
  children: ComponentChildren;
  title?: string;
}) {
  return (
    <button type="button" class={cx('fl-pill', size && size !== 'sm' && `fl-pill--${size}`)} aria-pressed={pressed} title={title} onClick={onPress}>
      {icon && <Icon name={icon} />}
      <span class="fl-pill__text">{children}</span>
    </button>
  );
}

export function Count({ n, loud, label }: { n: number | string; loud?: boolean; label?: string }) {
  return (
    <span class={cx('fl-count', loud && 'fl-count--loud')} title={label} aria-label={label}>
      {n}
    </span>
  );
}

export const Kbd = ({ children, inline }: { children: ComponentChildren; inline?: boolean }) => <kbd class={cx('fl-kbd', inline && 'fl-kbd--inline')}>{children}</kbd>;

export function Avatar({ agent, size }: { agent: AgentKey; size?: 'sm' | 'md' | 'lg' }) {
  const face = AGENT_FACES[agent];
  return (
    <span class={cx('fl-avatar', size && size !== 'md' && `fl-avatar--${size}`)} data-agent={agent} title={face.name} aria-label={face.name} role="img">
      {face.letter}
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
  focus,
  tone,
  as: Tag = 'section',
  label,
  class: className,
  children,
  ...rest
}: {
  variant?: 'inline' | 'flat' | 'raised';
  size?: 'sm' | 'md';
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
      class={cx('fl-card', variant !== 'inline' && `fl-card--${variant}`, size === 'sm' && 'fl-card--sm', className)}
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
}: {
  icon?: IconName;
  children: ComponentChildren;
  meta?: ComponentChildren;
  selected?: boolean;
  level?: number;
  expanded?: boolean;
  onPress?: () => void;
  title?: string;
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
    <button type="button" class="fl-row" aria-selected={selected} aria-expanded={expanded} title={title} style={style} onClick={onPress}>
      {body}
    </button>
  ) : (
    <div class="fl-row" aria-selected={selected} title={title} style={style}>
      {body}
    </div>
  );
}
