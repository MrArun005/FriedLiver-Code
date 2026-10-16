import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { parseMarkdown, type Inline } from '../shared/markdown';
import type { HostMessage, WebviewMessage } from '../shared/messages';
import { AGENT_FACES, EMPTY_STATE, reduce, type AgentKey, type AppState } from '../shared/model';

interface VsCodeApi {
  postMessage(message: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();

export function send(message: WebviewMessage): void {
  vscode.postMessage(message);
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

const DOT_LABEL: Record<string, string> = {
  idle: 'Idle',
  next: 'Next',
  working: 'Working',
  'needs-you': 'Needs you',
  done: 'Done',
  error: 'Problem',
};

export function Dot({ state }: { state: string }) {
  return <span class="dot" data-state={state} role="img" aria-label={DOT_LABEL[state] ?? state} title={DOT_LABEL[state] ?? state} />;
}

export function Markdown({ text }: { text: string }) {
  return (
    <div class="md">
      {parseMarkdown(text).map((b, i) => {
        switch (b.t) {
          case 'p':
            return <p key={i}>{inline(b.inline)}</p>;
          case 'h':
            return b.level === 1 ? <h3 key={i}>{inline(b.inline)}</h3> : <h4 key={i}>{inline(b.inline)}</h4>;
          case 'ul':
          case 'ol': {
            const List = b.t;
            return (
              <List key={i}>
                {b.items.map((item, n) => (
                  <li key={n}>{inline(item)}</li>
                ))}
              </List>
            );
          }
          case 'pre':
            return (
              <pre key={i}>
                <code>{b.code}</code>
              </pre>
            );
        }
      })}
    </div>
  );
}

function inline(parts: Inline[]): ComponentChildren[] {
  return parts.map((p, i) => {
    switch (p.t) {
      case 'code':
        return <code key={i}>{p.v}</code>;
      case 'strong':
        return <strong key={i}>{p.v}</strong>;
      case 'em':
        return <em key={i}>{p.v}</em>;
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
};
export type IconName = keyof typeof ICONS;

export function Icon({ name }: { name: IconName }) {
  return (
    <svg class="icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path d={ICONS[name]} fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

export function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).at(-1) ?? p;
}
