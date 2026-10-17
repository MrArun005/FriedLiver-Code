import { createContext, createElement, type ComponentChildren, type FunctionComponent } from 'preact';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { highlight } from '../shared/highlight';
import { lineCount, parseDoc, type Block, type Inline, type ListBlock, type ListItem, type MarkdownDoc, type PathRef } from '../shared/markdown';
import type { HostMessage, WebviewMessage } from '../shared/messages';
import { AGENT_FACES, EMPTY_STATE, reduce, type AgentKey, type AppState } from '../shared/model';
import { inFolder, runnableCode, stepSummary, type StepCommand } from '../shared/steps';
import { settleOrder, type Settled } from '../shared/view';

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();

export function send(message: WebviewMessage): void {
  vscode.postMessage(message);
}

let viewState: Record<string, unknown> = {};
try {
  viewState = (vscode.getState() as Record<string, unknown> | undefined) ?? {};
} catch {
  // A stub without state: start fresh.
}

/** Like useState, kept by the webview across reloads (the view, the sort order). */
export function usePersisted<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => (key in viewState ? (viewState[key] as T) : initial));
  const set = (next: T) => {
    setValue(next);
    viewState = { ...viewState, [key]: next };
    vscode.setState(viewState);
  };
  return [value, set];
}

/** The webview's width, for laying out by the room there is (side bar or editor). */
export function useWidth(): number {
  const [width, setWidth] = useState(window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width;
}

/** Smooth scrolling, unless motion is turned down. */
export function scrollBehavior(): ScrollBehavior {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

/** Arrow keys move the choice in a radio group, as native radios do. */
export function radioKeys(e: KeyboardEvent): void {
  const forward = e.key === 'ArrowRight' || e.key === 'ArrowDown';
  if (!forward && e.key !== 'ArrowLeft' && e.key !== 'ArrowUp') return;
  const radios = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="radio"]')];
  const at = radios.indexOf(document.activeElement as HTMLElement);
  if (at < 0) return;
  e.preventDefault();
  const next = radios[(at + (forward ? 1 : radios.length - 1)) % radios.length];
  next.focus();
  next.click();
}

/** Typing in a field: single-key shortcuts stay out of the way. */
export function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && !!target.closest('input, textarea, select, [contenteditable="true"]');
}

/** The host's state, kept in step by folding the same actions with the same reducer. */
export function useHost(onMessage?: (m: HostMessage) => void) {
  const [state, setState] = useState<AppState>(EMPTY_STATE);
  const [selected, setSelected] = useState<string | undefined>();
  const handler = useRef(onMessage);
  handler.current = onMessage;
  useEffect(() => {
    const listener = (e: MessageEvent) => {
      const m = e.data as HostMessage;
      if (m.type === 'snapshot') {
        setState(m.state);
        setSelected(m.selected);
      } else if (m.type === 'action') {
        setState((s) => reduce(s, m.action));
      } else if (m.type === 'actions') {
        setState((s) => m.actions.reduce(reduce, s));
      } else if (m.type === 'select') {
        setSelected(m.chatId);
      }
      handler.current?.(m);
    };
    window.addEventListener('message', listener);
    send({ type: 'ready' });
    return () => window.removeEventListener('message', listener);
  }, []);
  return { state, selected, setSelected };
}

/**
 * A component that draws again only when `same` says its props changed. With
 * fifteen agents streaming, most updates are for chats a component doesn't
 * show, and drawing every card and transcript item again for each one kept
 * the webviews busy.
 */
export function memo<P extends object>(component: FunctionComponent<P>, same: (prev: P, next: P) => boolean = shallowSame): FunctionComponent<P> {
  function Memo(this: { props: P; shouldComponentUpdate?: (next: P) => boolean }, props: P) {
    this.shouldComponentUpdate = (next) => !same(this.props, next);
    return createElement(component, props);
  }
  return Memo as FunctionComponent<P>;
}

function shallowSame<P extends object>(a: P, b: P): boolean {
  const ka = Object.keys(a) as (keyof P)[];
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

/**
 * The whole state, for parts that need the latest of it only now and then
 * (a menu listing the other chats), so the parts around them can skip
 * drawing while other chats stream.
 */
export const LiveState = createContext<AppState>(EMPTY_STATE);

/** `sorted`, in an order that moves at most every `ms` while chats stream (see settleOrder). */
export function useSettledOrder<T extends { id: string }>(sorted: T[], sort: string, ms = 1000): T[] {
  const shown = useRef<Settled>(undefined);
  const [, wake] = useState(0);
  const { order, pending } = settleOrder(shown.current, sorted.map((c) => c.id), sort, Date.now(), ms);
  shown.current = order;
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => wake((n) => n + 1), Math.max(0, order.at + ms - Date.now()));
    return () => clearTimeout(timer);
  });
  const byId = new Map(sorted.map((c) => [c.id, c]));
  return order.ids.map((id) => byId.get(id)!);
}

/** Re-renders every `ms`, for ages like "3m". */
export function useNow(ms: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

/** Every agent has a face: its letter on a 16% tint of its hue. */
export function Glyph({ agent, size }: { agent: AgentKey; size?: 'sm' | 'lg' }) {
  const face = AGENT_FACES[agent];
  return (
    <span class={`glyph ${size ?? ''}`} data-agent={agent} title={face.name} aria-label={face.name} role="img">
      {face.letter}
    </span>
  );
}

export const DOT_LABEL: Record<string, string> = {
  idle: 'Idle',
  next: 'Next',
  working: 'Working',
  'needs-you': 'Needs you',
  done: 'Done',
  error: 'Problem',
};

/**
 * A status dot; "working" pulses. `still` keeps it from pulsing where nothing
 * is working right now (a count of none, a legend, a step of a finished turn):
 * an animation that never ends repaints the webview every frame.
 */
export function Dot({ state, still }: { state: string; still?: boolean }) {
  return <span class="dot" data-state={state} data-still={still ? '' : undefined} role="img" aria-label={DOT_LABEL[state] ?? state} title={DOT_LABEL[state] ?? state} />;
}

/** Where a reply is shown: the chat (for Run in terminal) and its folder (for file links). */
interface MdPlace {
  chatId?: string;
  cwd?: string;
}

/** Replies longer than this many lines start collapsed, with Show all. */
const COLLAPSE_LINES = 40;

/**
 * A reply as markdown. While it streams in, only its tail is parsed and drawn
 * again. A long reply drawn when it has finished starts collapsed; `full`
 * means it still streams in, or a card around it does the collapsing.
 * `chatId` and `cwd` (optional) give its code blocks Run in terminal and its
 * file paths links.
 */
export const Markdown = memo(function Markdown({ text, chatId, cwd, full }: { text: string; full?: boolean } & MdPlace) {
  const doc = useRef<MarkdownDoc>(undefined);
  // A reply that streamed in on screen stays open when it ends; one drawn finished starts collapsed.
  const [all, setAll] = useState(!!full);
  doc.current = parseDoc(text, doc.current);
  const lines = full ? 0 : lineCount(text);
  const clamped = lines > COLLAPSE_LINES && !all;
  return (
    <>
      <div class={`md${clamped ? ' clamped' : ''}`}>
        {doc.current.blocks.map((b, i) => (
          <MarkdownBlock key={i} block={b} chatId={chatId} cwd={cwd} />
        ))}
      </div>
      {lines > COLLAPSE_LINES && (
        <button class="link sm-link md-more" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? 'Show less' : `Show all ${lines} lines`}
        </button>
      )}
    </>
  );
});

type BlockProps = { block: Block } & MdPlace;

/** Blocks a reply has finished keep their object, so they aren't drawn again. */
const MarkdownBlock = memo(
  function MarkdownBlock({ block: b, chatId, cwd }: BlockProps) {
    switch (b.t) {
      case 'p':
        return <p>{inline(b.inline, cwd)}</p>;
      case 'h':
        return b.level === 1 ? <h3>{inline(b.inline, cwd)}</h3> : <h4>{inline(b.inline, cwd)}</h4>;
      case 'label':
        return <h5 class="md-label">{inline(b.inline, cwd)}</h5>;
      case 'ul':
      case 'ol':
        return <List list={b} cwd={cwd} />;
      case 'table':
        return (
          <div class="md-table">
            <table>
              <thead>
                <tr>
                  {b.head.map((c, n) => (
                    <th key={n} style={b.align[n] ? { textAlign: b.align[n] } : undefined}>
                      {inline(c, cwd)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, k) => (
                  <tr key={k}>
                    {r.map((c, n) => (
                      <td key={n} style={b.align[n] ? { textAlign: b.align[n] } : undefined}>
                        {inline(c, cwd)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case 'mono':
        return <pre class="md-mono">{b.text}</pre>;
      case 'pre':
        return <CodeBlock lang={b.lang} code={b.code} chatId={chatId} />;
    }
  },
  (a: BlockProps, b: BlockProps) => a.block === b.block && a.chatId === b.chatId && a.cwd === b.cwd,
);

function List({ list, cwd }: { list: ListBlock; cwd?: string }) {
  const items = list.items.map((it: ListItem, n) => (
    <li key={n} data-mark={it.mark ? '' : undefined} data-tone={it.tone}>
      {it.mark && <span class="li-mark">{it.mark}</span>}
      {inline(it.inline, cwd)}
      {it.lists?.map((l, k) => <List key={k} list={l} cwd={cwd} />)}
    </li>
  ));
  return list.t === 'ol' ? <ol start={list.start}>{items}</ol> : <ul>{items}</ul>;
}

/** Code, coloured by its language when it is short enough. */
export function Code({ code, lang, class: className }: { code: string; lang: string; class?: string }) {
  const tokens = useMemo(() => highlight(code, lang), [code, lang]);
  return (
    <pre class={`code ${className ?? ''}`}>
      <code>{tokens ? tokens.map((t, i) => (t.k ? <span key={i} class={`tk-${t.k}`}>{t.v}</span> : t.v)) : code}</code>
    </pre>
  );
}

/**
 * Types `command` into a new terminal named after the chat and runs it: the
 * user clicked, and the command is on screen in full. The host runs it only if
 * the chat showed it.
 */
export function RunButton({ chatId, command, cwd }: { chatId: string; command: string; cwd?: string }) {
  return (
    <button
      type="button"
      class="ghost sm run-btn"
      aria-label="Run in terminal"
      title={`Type this into a new terminal and run it:\n${command.length > 600 ? `${command.slice(0, 600)}…` : command}`}
      onClick={() => send({ type: 'runInTerminal', chatId, command, ...(cwd ? { cwd } : {}) })}
    >
      <Icon name="terminal" />
      <span class="run-long">Run in terminal</span>
      <span class="run-short">Run</span>
    </button>
  );
}

/**
 * A tool's title on one line: the verb and a short summary, the whole of it in
 * the tooltip. Claude titles a shell step with the whole command, heredoc and all.
 */
export function StepLabel({ title, toolKind, cmd }: { title: string; toolKind?: string; cmd?: StepCommand }) {
  const s = stepSummary({ title, toolKind, ...(cmd ? { cmd } : {}) });
  return (
    <span class="step-label" title={s.full}>
      <span class="step-verb">{s.verb}</span>
      <span class={`step-text${s.mono ? ' mono' : ''}`}>{s.text}</span>
      {s.lines && <span class="step-lines">{s.lines} lines</span>}
    </span>
  );
}

/** Whether a title reads badly as it is: several lines, or longer than a line. */
export const longTitle = (title: string) => title.includes('\n') || title.length > 120;

/** A fenced code block: its language, Copy, Insert, and Run in terminal for shell code. */
function CodeBlock({ lang, code, chatId }: { lang: string; code: string; chatId?: string }) {
  const run = chatId ? runnableCode(lang, code) : undefined;
  return (
    <div class="code-block">
      <div class="code-head">
        <span class="code-lang">{lang || 'code'}</span>
        <span class="spacer" />
        {run && chatId && <RunButton chatId={chatId} command={run} />}
        <button type="button" class="ghost sm insert-btn" title="Insert at the cursor in the editor" onClick={() => send({ type: 'insert', text: code })}>
          Insert
        </button>
        <CopyButton text={code} label="Copy code" />
      </div>
      <Code code={code} lang={lang} />
    </div>
  );
}

/** Inline text that acts as a button: a real <button> is a box that can't wrap with the line, and long paths would overflow. */
function InlineButton({ class: className, title, onPress, children }: { class: string; title: string; onPress(): void; children: ComponentChildren }) {
  return (
    <span
      role="button"
      tabIndex={0}
      class={className}
      title={title}
      onClick={onPress}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onPress();
        }
      }}
    >
      {children}
    </span>
  );
}

/** A file path in a reply: opens at its line when it is in the chat's folder, otherwise copies. */
function PathLink({ at: r, cwd, children }: { at: PathRef; cwd?: string; children: ComponentChildren }) {
  const [copied, setCopied] = useState(false);
  const file = cwd ? inFolder(cwd, r.path) : undefined;
  const where = r.line ? `:${r.line}${r.col ? `:${r.col}` : ''}` : '';
  if (file) {
    return (
      <InlineButton class="path-link" title={`Open ${file}${where}`} onPress={() => send({ type: 'openFile', path: file, ...(r.line ? { line: r.line } : {}) })}>
        {children}
      </InlineButton>
    );
  }
  return (
    <InlineButton
      class="path-link outside"
      title={copied ? 'Copied' : `${r.path}: not in this chat’s folder. Click to copy the path.`}
      onPress={() => {
        send({ type: 'copy', text: r.path });
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      {children}
    </InlineButton>
  );
}

function inline(parts: Inline[], cwd?: string): ComponentChildren[] {
  return parts.map((p, i) => {
    switch (p.t) {
      case 'code':
        return p.ref ? (
          <PathLink key={i} at={p.ref} cwd={cwd}>
            <code>{p.v}</code>
          </PathLink>
        ) : (
          <code key={i}>{p.v}</code>
        );
      case 'strong':
        return <strong key={i}>{p.v}</strong>;
      case 'em':
        return <em key={i}>{p.v}</em>;
      case 'br':
        return <br key={i} />;
      case 'path':
        return (
          <PathLink key={i} at={p.ref} cwd={cwd}>
            {p.v}
          </PathLink>
        );
      case 'link':
        // VS Code opens webview links through its own link protection.
        return (
          <a key={i} href={p.href} title={p.href}>
            {p.v}
          </a>
        );
      default:
        return p.v;
    }
  });
}

const ICONS = {
  plus: 'M8 3v10M3 8h10',
  send: 'M3 8h9M8.5 4.5 12 8l-3.5 3.5',
  stop: 'M4.5 4.5h7v7h-7z',
  attach: 'M10.5 5.5 6 10a1.5 1.5 0 0 1-2.1-2.1l5-5a2.5 2.5 0 0 1 3.5 3.5l-5 5a3.5 3.5 0 0 1-5-5l4.5-4.5',
  undo: 'M5 6H10a3 3 0 0 1 0 6H6M5 6l2.5-2.5M5 6l2.5 2.5',
  check: 'M3.5 8.5l3 3 6-7',
  close: 'M4 4l8 8M12 4l-8 8',
  play: 'M5 3.5v9l7-4.5z',
  merge: 'M5 3v10M5 6c0 3 6 2 6 6M11 12v1',
  trash: 'M3.5 4.5h9M6.5 4.5v-1h3v1M5 4.5l.5 8h5l.5-8',
  center: 'M2.5 3.5h11v9h-11zM5.5 3.5v9M10.5 3.5v9',
  tasks: 'M2.5 3.5h3v9h-3zM6.5 3.5h3v6h-3zM10.5 3.5h3v4h-3z',
  file: 'M4.5 2.5h4l3 3v8h-7zM8.5 2.5v3h3',
  terminal: 'M3 4.5l3 3-3 3M7.5 11h5',
  search: 'M7 2.75a4.25 4.25 0 1 1 0 8.5a4.25 4.25 0 0 1 0-8.5zM10.2 10.2l3.3 3.3',
  list: 'M2.75 4.5h.5M5.5 4.5h7.75M2.75 8h.5M5.5 8h7.75M2.75 11.5h.5M5.5 11.5h7.75',
  map: 'M2.5 3.5h3.5v3h-3.5zM10 3.5h3.5v3H10zM10 10.5h3.5v3H10zM6 5h4M4.25 6.5v3.75a1.75 1.75 0 0 0 1.75 1.75h4',
  archive: 'M2.5 3.5h11v2.75h-11zM3.5 6.25v6.25h9V6.25M6.5 9h3',
  unarchive: 'M2.5 3.5h11v2.75h-11zM3.5 6.25v6.25h9V6.25M8 11.5V8.25M6.5 9.75 8 8.25l1.5 1.5',
  handoff: 'M2.5 8h7.5M7.5 5l3 3-3 3M13.25 3.5v9',
  ask: 'M2.75 3.5h10.5v6.75H8L5 12.75v-2.5H2.75z',
  pipe: 'M2.5 6.5h7.5M2.5 9.5h7.5M9.5 4.5 13 8l-3.5 3.5',
  chevron: 'M5 6.5l3 3 3-3',
  more: 'M3 8a1 1 0 1 0 2 0a1 1 0 1 0-2 0M7 8a1 1 0 1 0 2 0a1 1 0 1 0-2 0M11 8a1 1 0 1 0 2 0a1 1 0 1 0-2 0',
  branch: 'M5 2.75v10.5M11 6a1.5 1.5 0 1 0 0-3a1.5 1.5 0 0 0 0 3zM11 6c0 3-6 2.25-6 5',
  diff: 'M4.5 2.5h4l3 3v8h-7zM6.5 8.25h3M8 6.75v3M6.5 11.25h3',
  open: 'M9.5 2.75h3.75V6.5M13.25 2.75 8 8M11.5 9.5v3.75h-8.75V4.5H6.5',
  user: 'M8 7.75a2.5 2.5 0 1 0 0-5a2.5 2.5 0 0 0 0 5zM3.25 13.25c.6-2.4 2.4-3.5 4.75-3.5s4.15 1.1 4.75 3.5',
  link: 'M7 9a2.5 2.5 0 0 0 3.5 0l2-2A2.5 2.5 0 0 0 9 3.5l-.5.5M9 7a2.5 2.5 0 0 0-3.5 0l-2 2A2.5 2.5 0 0 0 7 12.5l.5-.5',
  compare: 'M2.75 3.5h4v9h-4zM9.25 3.5h4v9h-4z',
  history: 'M2.75 8a5.25 5.25 0 1 0 1.55-3.7M2.75 2.75v2.5h2.5M8 5.25V8l2 1.5',
  grid: 'M3 3h4v4H3zM9 3h4v4H9zM3 9h4v4H3zM9 9h4v4H9z',
  keep: 'M3.5 8.5l3 3 6-7',
  code: 'M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5',
  bolt: 'M9 2.5 4 9h3.5L7 13.5 12 7H8.5z',
  copy: 'M5.5 5.5h7v7h-7zM10.5 5.5v-2h-7v7h2',
  gauge: 'M2.75 11a5.25 5.25 0 1 1 10.5 0M8 11l2.5-3.5',
  model: 'M8 2.5l1.4 3.1 3.1 1.4-3.1 1.4L8 11.5 6.6 8.4 3.5 7l3.1-1.4zM12.5 10.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z',
  shield: 'M8 2.5l4.75 1.75v3.5c0 3-2 5-4.75 5.75C5.25 12.75 3.25 10.75 3.25 7.75v-3.5z',
  queue: 'M2.75 4.5h10.5M2.75 8h10.5M2.75 11.5h6M11 10v3l2-1.5z',
};
export type IconName = keyof typeof ICONS;

export function Icon({ name }: { name: IconName }) {
  return (
    <svg class="icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path d={ICONS[name]} fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

/** Puts text on the clipboard through the editor, which a webview may not reach itself. */
export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      class="ghost icon-btn sm copy-btn"
      title={done ? 'Copied' : label}
      aria-label={label}
      onClick={() => {
        send({ type: 'copy', text: text.slice(0, 1_000_000) });
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      <Icon name={done ? 'check' : 'copy'} />
    </button>
  );
}

export function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).at(-1) ?? p;
}

export function Kbd({ children }: { children: ComponentChildren }) {
  return <kbd>{children}</kbd>;
}

const MENU_ITEMS = '[role^="menuitem"]:not(:disabled)';

/**
 * A button that opens a menu or a small form. Escape, Tab or a click outside
 * closes it; Escape returns focus to the button. Menus move with the arrows.
 */
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
  buttonClass?: string;
  class?: string;
  disabled?: boolean;
  children: (close: (refocus?: boolean) => void) => ComponentChildren;
}) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<{ up: boolean; dx: number }>({ up: false, dx: 0 });
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
    // Open upward when there's no room below, and slide sideways to stay inside the webview.
    const b = button.current.getBoundingClientRect();
    const p = panel.current.getBoundingClientRect();
    const dx = p.right > window.innerWidth - 8 ? window.innerWidth - 8 - p.right : 0;
    setPlace({ up: b.bottom + p.height + 8 > window.innerHeight && b.top - p.height - 8 > 0, dx: p.left + dx < 8 ? 8 - p.left : dx });
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
    <span class={`pop ${className ?? ''}`}>
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
          class={`popover ${kind}`}
          role={kind}
          aria-label={label}
          data-up={place.up ? '' : undefined}
          data-end={align === 'end' ? '' : undefined}
          style={place.dx ? { transform: `translateX(${Math.round(place.dx)}px)` } : undefined}
          onKeyDown={onKeyDown}
        >
          {children(close)}
        </div>
      )}
    </span>
  );
}
