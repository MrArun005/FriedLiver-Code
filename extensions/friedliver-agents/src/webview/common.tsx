import { linkTarget } from '../shared/links';
import { createContext, createElement, type ComponentChildren, type FunctionComponent } from 'preact';
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Avatar } from './ui/display';
import { Button, IconButton } from './ui/controls';
import { highlight } from '../shared/highlight';
import { lineCount, parseDoc, type Block, type Inline, type ListBlock, type ListItem, type MarkdownDoc, type PathRef } from '../shared/markdown';
import { SIGN_IN_TEXT, type AccountsMessage, type AgentRoster } from '../shared/accounts';
import type { HostMessage, WebviewMessage } from '../shared/messages';
import { discussLayouts, type DiscussLayout } from '../shared/discussView';
import { AGENT_FACES, AGENT_KEYS, EMPTY_STATE, reduce, type AgentKey, type AppState } from '../shared/model';
import { inFolder, runnableCode, stepSummary, type StepCommand } from '../shared/steps';
import { TAB_MIN, markWindow, settleOrder, tabFit, type Settled, type TabFit } from '../shared/view';
import type { AgentDefaults } from '../shared/session';

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();

export function send(message: WebviewMessage | AccountsMessage): void {
  vscode.postMessage(message);
}

// Links, in every view: a web link goes to the host, which opens it in FriedLiver's browser or the system's
// (friedliver.links.openIn, the other way with Cmd/Ctrl); a file: link opens in the editor if it is in the
// workspace; any other scheme (javascript:, data:, vscode:, …) opens nothing. In-page "#" links keep their own handlers.
function onLink(e: MouseEvent): void {
  if (e.button > 1) return;
  const a = (e.target as Element | null)?.closest?.('a[href]');
  const href = a?.getAttribute('href') ?? '';
  if (!a || href.startsWith('#')) return;
  e.preventDefault();
  const t = linkTarget(href);
  if (t?.kind === 'web') send({ type: 'openLink', url: t.url, modifier: e.metaKey || e.ctrlKey });
  else if (t?.kind === 'file') send({ type: 'openFile', path: t.path });
}
document.addEventListener('click', onLink, true);
document.addEventListener('auxclick', onLink, true);

/** Which agents pickers offer and each one's last known sign-in; every agent until the host says. */
let roster: AgentRoster = { agents: AGENT_KEYS.filter((a) => a !== 'demo'), signIn: {} };
const rosterWatchers = new Set<() => void>();

function setRoster(next: AgentRoster): void {
  roster = next;
  for (const wake of rosterWatchers) wake();
}

/** The roster, drawing the component again when it changes (a check, a sign-in). */
export function useRoster(): AgentRoster {
  const [, setN] = useState(0);
  useEffect(() => {
    const wake = () => setN((n) => n + 1);
    rosterWatchers.add(wake);
    return () => void rosterWatchers.delete(wake);
  }, []);
  return roster;
}

/** Each agent's last known options (its models among them), as the host last sent them. */
let agentDefaults: Partial<Record<AgentKey, AgentDefaults>> = {};
const defaultsWatchers = new Set<() => void>();

function setAgentDefaults(next: Partial<Record<AgentKey, AgentDefaults>>): void {
  agentDefaults = next;
  for (const wake of defaultsWatchers) wake();
}

/** The agents' cached options, drawing the component again when the host sends new ones. */
export function useAgentDefaults(): Partial<Record<AgentKey, AgentDefaults>> {
  const [, setN] = useState(0);
  useEffect(() => {
    const wake = () => setN((n) => n + 1);
    defaultsWatchers.add(wake);
    return () => void defaultsWatchers.delete(wake);
  }, []);
  return agentDefaults;
}

/** friedliver.discuss.layout, drawing the card again when it changes. */
export function useDiscussLayout(): DiscussLayout {
  const [, setN] = useState(0);
  useEffect(() => discussLayouts.watch(() => setN((n) => n + 1)), []);
  return discussLayouts.get();
}

/** A small mark for an agent's last known sign-in; nothing while it was never checked. */
export function SignInMark({ agent }: { agent: AgentKey }) {
  const state = useRoster().signIn[agent];
  if (!state || agent === 'demo') return null;
  const label = `${AGENT_FACES[agent].name}: ${SIGN_IN_TEXT[state]}`;
  return <span class="signin-mark" data-state={state} role="img" aria-label={label} title={label} />;
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

// friedliver.chat.fontFamily: empty keeps the editor's chat font (the stylesheet's --font).
{
  const font = document.body?.dataset.font?.trim().replace(/["\\]/g, '');
  if (font) document.documentElement.style.setProperty('--font', `"${font}", var(--vscode-chat-font-family, system-ui), sans-serif`);
}

// friedliver.chat.accentColor: any CSS colour; the stylesheet's default (Claude orange) otherwise.
{
  const accent = document.body?.dataset.accent?.trim();
  if (accent && accent.toLowerCase() !== '#d97757' && CSS.supports('color', accent)) document.documentElement.style.setProperty('--fl-accent', accent);
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
let nextKey = 0;

/**
 * Gives every transcript item a key that stays with it (`_k`): items the reducer updates are spread
 * from the old one, so they keep it; new items get the next one. Lists key by it, never by position,
 * so dropping the oldest items at the cap moves nothing on screen.
 */
function keyItems(prev: AppState | undefined, next: AppState): AppState {
  for (const chat of next.chats) {
    const before = prev?.chats.find((c) => c.id === chat.id);
    if (before?.items === chat.items) continue;
    for (const item of chat.items) {
      const keyed = item as { _k?: number };
      if (keyed._k === undefined) keyed._k = ++nextKey;
    }
  }
  return next;
}

/** An item's stable key (keyItems). */
export const itemKey = (item: object): number => (item as { _k?: number })._k ?? 0;

export function useHost(onMessage?: (m: HostMessage) => void) {
  const [state, setState] = useState<AppState>(EMPTY_STATE);
  const [selected, setSelected] = useState<string | undefined>();
  const handler = useRef(onMessage);
  handler.current = onMessage;
  useEffect(() => {
    const listener = (e: MessageEvent) => {
      const m = e.data as HostMessage;
      if (m.type === 'snapshot') {
        setState(keyItems(undefined, m.state));
        setSelected(m.selected);
        if (m.roster) setRoster(m.roster);
        if (m.defaults) setAgentDefaults(m.defaults);
        if (m.discussLayout) discussLayouts.set(m.discussLayout);
      } else if (m.type === 'discussLayout') {
        discussLayouts.set(m.layout);
      } else if (m.type === 'roster') {
        setRoster(m.roster);
      } else if (m.type === 'defaults') {
        setAgentDefaults(m.defaults);
      } else if (m.type === 'action') {
        setState((s) => keyItems(s, reduce(s, m.action)));
      } else if (m.type === 'actions') {
        setState((s) => keyItems(s, m.actions.reduce(reduce, s)));
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
/** An agent's face: its letter on a 16% tint of its hue (the Avatar component). */
export function Glyph({ agent, size }: { agent: AgentKey; size?: 'sm' | 'lg' }) {
  return <Avatar agent={agent} size={size} />;
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
  return <span class="fl-dot dot" data-state={state} data-still={still ? '' : undefined} role="img" aria-label={DOT_LABEL[state] ?? state} title={DOT_LABEL[state] ?? state} />;
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
        <Button variant="link" size="sm" class="sm-link md-more" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? 'Show less' : `Show all ${lines} lines`}
        </Button>
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
      case 'table': {
        // A column of numbers aligns right (tabular digits), unless the markdown set its own alignment.
        const cellText = (c: Inline[]) => c.map((x) => ('v' in x ? x.v : '')).join('').trim();
        const numeric = b.head.map((_, n) => b.rows.length > 0 && b.rows.every((r) => /^[-+−]?[$€£¥]?[\d.,]+\s*(%|[kKMGB]|ms|s|x|×)?$/.test(cellText(r[n] ?? []))));
        const align = b.head.map((_, n) => b.align[n] || (numeric[n] ? 'right' : undefined));
        return (
          <div class="md-table">
            <table>
              <thead>
                <tr>
                  {b.head.map((c, n) => (
                    <th key={n} style={align[n] ? { textAlign: align[n] } : undefined}>
                      {inline(c, cwd)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, k) => (
                  <tr key={k}>
                    {r.map((c, n) => (
                      <td key={n} data-num={numeric[n] ? '' : undefined} style={align[n] ? { textAlign: align[n] } : undefined}>
                        {inline(c, cwd)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }
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
    // Focusable, so a line wider than the box can be scrolled from the keyboard.
    <pre class={`code ${className ?? ''}`} tabIndex={0} aria-label={lang ? `${lang} code` : 'Code'}>
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
    <Button
      variant="secondary"
      size="sm"
      icon="terminal"
      class="run-btn"
      aria-label="Run in terminal"
      title={`Type this into a new terminal and run it:\n${command.length > 600 ? `${command.slice(0, 600)}…` : command}`}
      onClick={() => send({ type: 'runInTerminal', chatId, command, ...(cwd ? { cwd } : {}) })}
    >
      <span class="run-long">Run in terminal</span>
      <span class="run-short">Run</span>
    </Button>
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

/** A fenced code block: the code on its own tone; its language, Run in terminal (shell code), Insert and Copy show on hover. */
function CodeBlock({ lang, code, chatId }: { lang: string; code: string; chatId?: string }) {
  const run = chatId ? runnableCode(lang, code) : undefined;
  // Long lines wrap; Wrap off keeps them whole, to scroll sideways.
  const [wrap, setWrap] = useState(true);
  return (
    <div class="code-block" data-wrap={wrap ? '' : undefined}>
      <Code code={code} lang={lang} />
      <div class="code-tools">
        <span class="code-lang">{lang || 'code'}</span>
        <Button variant="secondary" size="sm" class="wrap-btn" aria-pressed={wrap} title={wrap ? 'Long lines wrap: click to keep them whole' : 'Wrap long lines'} onClick={() => setWrap(!wrap)}>
          Wrap
        </Button>
        {run && chatId && <RunButton chatId={chatId} command={run} />}
        <Button variant="secondary" size="sm" class="insert-btn" title="Insert at the cursor in the editor" onClick={() => send({ type: 'insert', text: code })}>
          Insert
        </Button>
        <CopyButton text={code} label="Copy code" />
      </div>
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
        // A click goes through onLink above: the host opens it (FriedLiver's browser or the system's).
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

export { Icon, type IconName } from './ui/icon';

/**
 * A message's text clamped to three lines, with Show more at the box's bottom right when (and only when) it
 * overflows them. `onMore` replaces expanding in place (the sticky copy sends you to the message instead).
 * Another part can open it with an `expand` event on the element (see openMessage).
 */
export function ClampedText({ text, onMore }: { text: string; onMore?: () => void }) {
  const [open, setOpen] = useState(false);
  const [over, setOver] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setOver(open || el.scrollHeight > el.clientHeight + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const expand = () => setOpen(true);
    el.addEventListener('expand', expand);
    return () => (ro.disconnect(), el.removeEventListener('expand', expand));
  }, [text, open]);
  return (
    <>
      <div ref={box} class="bubble-text" data-clamped={open ? undefined : ''}>
        {text}
      </div>
      {over && (
        <Button variant="link" class="msg-more" aria-expanded={open && !onMore} onClick={() => (onMore ? onMore() : setOpen(!open))}>
          {open && !onMore ? 'Show less' : 'Show more'}
        </Button>
      )}
    </>
  );
}

/** Puts text on the clipboard through the editor, which a webview may not reach itself. */
export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <IconButton
      icon={done ? 'check' : 'copy'}
      label={label}
      title={done ? 'Copied' : label}
      size="sm"
      variant="secondary"
      muted
      class="copy-btn"
      onClick={() => {
        send({ type: 'copy', text: text.slice(0, 1_000_000) });
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    />
  );
}

export function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).at(-1) ?? p;
}

export function Kbd({ children }: { children: ComponentChildren }) {
  return <kbd>{children}</kbd>;
}

export { Popover } from './ui/menu';

/** How much of each end of a strip to clip so that no tab shows in part (§2.18): a cut tab goes entirely. */
function clipPartialTabs(el: HTMLElement) {
  const s = el.getBoundingClientRect();
  let left = 0;
  let right = 0;
  for (const tab of el.children) {
    const r = tab.getBoundingClientRect();
    if (r.left < s.left - 0.5 && r.right > s.left + 0.5) left = Math.max(left, r.right - s.left);
    if (r.right > s.right + 0.5 && r.left < s.right - 0.5) right = Math.max(right, s.right - r.left);
  }
  el.style.setProperty('--clip-l', `${Math.ceil(left)}px`);
  el.style.setProperty('--clip-r', `${Math.ceil(right)}px`);
}

/**
 * Marks only, and still too many (§2.18): show a whole window of them beside the open tab, the open tab
 * taking the room left over (--open-w, from --tab-open-min up), and scroll to that window, so the strip
 * starts and ends on whole tabs with no gap. As close to where it was scrolled as the open tab allows.
 */
function windowMarks(el: HTMLElement) {
  const wraps = [...el.children] as HTMLElement[];
  const at = wraps.findIndex((w) => w.hasAttribute('data-active'));
  const mark = wraps.find((w) => !w.hasAttribute('data-active'));
  const reset = () => {
    el.removeAttribute('data-windowed');
    el.style.removeProperty('--open-w');
  };
  if (el.dataset.fit !== 'icon' || at < 0 || !mark) return reset();
  const step = mark.getBoundingClientRect().width + (parseFloat(window.getComputedStyle(el).columnGap) || 0);
  const { marks: k, openWidth } = markWindow(el.clientWidth, step, wraps.length);
  // Everything fits with the open tab at its full minimum: no window needed.
  if (k >= wraps.length - 1 && openWidth >= TAB_MIN.open) return reset();
  el.setAttribute('data-windowed', '');
  el.style.setProperty('--open-w', `${openWidth}px`);
  const first = Math.max(Math.max(0, at - k), Math.min(Math.round(el.scrollLeft / step), at, wraps.length - 1 - k));
  el.scrollLeft = first * step;
}

/**
 * A strip of tabs: crowded, its tabs shrink (`fit`, tabFit()); with more than fit even then it scrolls sideways
 * (`over`), snapping to whole tabs, with any tab an edge cuts clipped away; a mouse wheel steps it a tab at a
 * time, and the open tab stays in view.
 */
export function useTabStrip(box: { current: HTMLElement | null }, count: number, active: string | undefined): { over: boolean; fit: TabFit } {
  const [over, setOver] = useState(false);
  const [fit, setFit] = useState<TabFit>('full');
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      setFit(tabFit(el.clientWidth, count));
      setOver(el.scrollWidth > el.clientWidth + 1);
      clipPartialTabs(el);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => clipPartialTabs(el));
    };
    // A plain (vertical) wheel steps the strip a whole tab per notch; a trackpad's sideways swipe scrolls (and snaps) itself.
    let pending = 0;
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth + 1 || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      pending += e.deltaY;
      if (Math.abs(pending) < 40) return;
      const s = el.getBoundingClientRect();
      const lefts = [...el.children].map((t) => t.getBoundingClientRect().left - s.left);
      const to = pending > 0 ? lefts.find((x) => x > 1) : lefts.filter((x) => x < -1).at(-1);
      pending = 0;
      if (to !== undefined) el.scrollBy({ left: to, behavior: scrollBehavior() });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame);
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('wheel', onWheel);
    };
  }, [count]);
  // The tabs' widths changed with the fit or the open tab: is it still too wide, and what does an edge cut now?
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    windowMarks(el);
    setOver(el.scrollWidth > el.clientWidth + 1);
    clipPartialTabs(el);
  }, [fit, active, count]);
  // After the tab is in the strip: a chat opened from the list or a notification gets its new tab shown (QA F04).
  useEffect(() => {
    box.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active, count, fit]);
  return { over, fit };
}

// ---- Images from files: the host hands out a data: URI per path, once it has checked the file. ----

type HostImage = 'imageSrc' | 'imageThumb';
/** undefined: not asked yet or waiting; null: not showable (outside the allowed folders, too big, missing). */
const hostImages: Record<HostImage, Map<string, string | null>> = { imageSrc: new Map(), imageThumb: new Map() };
/** Who waits for which path: an answer re-renders only them. */
const imageWaiters: Record<HostImage, Map<string, Set<() => void>>> = { imageSrc: new Map(), imageThumb: new Map() };
window.addEventListener('message', (e: MessageEvent<{ type?: string; path?: string; src?: string }>) => {
  const kind = e.data?.type;
  if ((kind !== 'imageSrc' && kind !== 'imageThumb') || typeof e.data.path !== 'string') return;
  // Only raster data: URIs: never a URL or a file the webview could fetch.
  const src = e.data.src;
  hostImages[kind].set(e.data.path, typeof src === 'string' && /^data:image\/(png|jpeg|gif|webp);base64,/.test(src) ? src : null);
  for (const w of imageWaiters[kind].get(e.data.path) ?? []) w();
});

/** The image at `path` from the host, asked for once `enabled` (a thumbnail: once its card is near the screen). */
export function useHostImage(kind: HostImage, path: string, enabled = true): string | null | undefined {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const w = () => bump((n) => n + 1);
    const waiting = imageWaiters[kind];
    if (!waiting.has(path)) waiting.set(path, new Set());
    waiting.get(path)!.add(w);
    if (!asked[kind].has(path)) {
      asked[kind].add(path);
      send({ type: kind, path });
    }
    return () => {
      waiting.get(path)?.delete(w);
    };
  }, [kind, path, enabled]);
  return enabled ? hostImages[kind].get(path) : undefined;
}
/** Paths already asked for, so two cards of one file ask once. */
const asked: Record<HostImage, Set<string>> = { imageSrc: new Set(), imageThumb: new Set() };

export const useImageSrc = (path: string) => useHostImage('imageSrc', path);

/** Calls `onVisible` once, when the element comes within a screen's reach (one observer for all). */
const nearScreen = new Map<Element, () => void>();
let observer: IntersectionObserver | undefined;
export function useNearScreen(ref: { current: Element | null }): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || near) return;
    observer ??= new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          nearScreen.get(e.target)?.();
          nearScreen.delete(e.target);
          observer!.unobserve(e.target);
        }
      },
      { rootMargin: '300px 0px' },
    );
    nearScreen.set(el, () => setNear(true));
    observer.observe(el);
    return () => {
      nearScreen.delete(el);
      observer?.unobserve(el);
    };
  }, [near]);
  return near;
}

/** A step's image with its title; click opens the editor's image preview. Name only when it can't be shown. */
/** Opens the image viewer on a file, with its chat's images around it; a surface without a viewer opens the editor's preview. */
export const OpenImage = createContext<((path: string, from: HTMLElement) => void) | null>(null);

export function ImageThumb({ path, title }: { path: string; title: string }) {
  const src = useHostImage('imageThumb', path);
  const viewer = useContext(OpenImage);
  const open = (e: Event) => (viewer ? viewer(path, e.currentTarget as HTMLElement) : send({ type: 'openImage', path }));
  if (src === null) {
    return (
      <span class="image-thumb missing" title={path}>
        <span class="image-title">{title}</span>
        <Button variant="link" onClick={open}>
          Open
        </Button>
      </span>
    );
  }
  return (
    <button class="image-thumb" title={path} aria-label={`Open ${title}`} onClick={open}>
      {src ? <img src={src} alt="" loading="lazy" /> : <span class="image-wait" />}
      <span class="image-title">{title}</span>
    </button>
  );
}
