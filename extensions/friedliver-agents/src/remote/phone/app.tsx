// FriedLiver Remote's phone app, served by the Mac. Untrusted text (agent
// replies, commands, file names) is only ever rendered as text or as elements
// from the Markdown parser, never as HTML. The device token lives in this
// origin's localStorage and goes only in the Authorization header.
import { render } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { nextAfter, rowShowsWhole, sheetTarget } from './rules';
import { parseMarkdown, type Block, type Inline, type ListBlock } from '../../shared/markdown';
import type { AgentKey } from '../../shared/model';
import type { QuestionField, QuestionValue } from '../../shared/questions';
import type { ApprovalLevel } from '../../shared/session';
import type { PhoneChat, PhoneEvent, PhoneFile, PhoneItem, PhoneList, PhoneSummary, RemoteAction } from '../protocol';
// The design system's components (COMPONENTS.md), touch-sized by [data-density='touch'] on the body.
import { Avatar as UiAvatar, Button, Checkbox, FilterPill, Icon as UiIcon, IconButton, Input, Pill, RadioRow, Row, Segmented, Textarea } from '../../webview/ui';

// ---- Storage and the API ----

const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(`fl.${k}`) ?? undefined;
    } catch {
      return undefined;
    }
  },
  set: (k: string, v: string | undefined) => {
    try {
      if (v === undefined) localStorage.removeItem(`fl.${k}`);
      else localStorage.setItem(`fl.${k}`, v);
    } catch {
      // Private mode: the pairing lasts for this tab.
    }
  },
};

class Unpaired extends Error {}

async function api<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const token = store.get('token');
  if (!token && path !== '/api/pair') throw new Unpaired();
  const res = await fetch(path, {
    method,
    cache: 'no-store',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 401) throw new Unpaired();
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);
  return data;
}

// ---- Small pieces ----

const AGENT_NAMES: Record<AgentKey, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', demo: 'Demo' };
const LEVELS: { level: ApprovalLevel; name: string }[] = [
  { level: 'ask', name: 'Manual' },
  { level: 'edits', name: 'Edits' },
  { level: 'full', name: 'Auto' },
];

function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return 'now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
}

function Avatar({ agent, small }: { agent: AgentKey; small?: boolean }) {
  return <UiAvatar agent={agent} size={small ? 'md' : 'lg'} />;
}

function Dot({ status }: { status: string }) {
  return <span class="fl-dot" data-state={status} aria-hidden="true" />;
}

// ---- Markdown, as elements ----

function Inlines({ parts }: { parts: Inline[] }) {
  return (
    <>
      {parts.map((p, i) => {
        switch (p.t) {
          case 'text':
            return p.v;
          case 'br':
            return <br key={i} />;
          case 'strong':
            return <strong key={i}>{p.v}</strong>;
          case 'em':
            return <em key={i}>{p.v}</em>;
          case 'code':
          case 'path':
            return <code key={i}>{p.v}</code>;
          case 'link':
            return /^https:\/\//i.test(p.href) ? (
              <a key={i} href={p.href} target="_blank" rel="noopener noreferrer">
                {p.v}
              </a>
            ) : (
              p.v
            );
        }
      })}
    </>
  );
}

function List({ list }: { list: ListBlock }) {
  const items = list.items.map((it, i) => (
    <li key={i}>
      {it.mark ? <span class="md__mark">{it.mark} </span> : null}
      <Inlines parts={it.inline} />
      {it.lists?.map((l, j) => <List key={j} list={l} />)}
    </li>
  ));
  return list.t === 'ol' ? <ol start={list.start}>{items}</ol> : <ul>{items}</ul>;
}

function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div class="md">
      {blocks.map((b: Block, i) => {
        switch (b.t) {
          case 'p':
            return (
              <p key={i}>
                <Inlines parts={b.inline} />
              </p>
            );
          case 'h':
          case 'label':
            return (
              <p key={i} class="md__h">
                <Inlines parts={b.inline} />
              </p>
            );
          case 'ul':
          case 'ol':
            return <List key={i} list={b} />;
          case 'pre':
            return <pre key={i}>{b.code}</pre>;
          case 'mono':
            return <pre key={i}>{b.text}</pre>;
          case 'table':
            return (
              <div key={i} class="md__table">
                <table>
                  <thead>
                    <tr>
                      {b.head.map((c, j) => (
                        <th key={j}>
                          <Inlines parts={c} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr key={j}>
                        {r.map((c, k) => (
                          <td key={k}>
                            <Inlines parts={c} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
        }
      })}
    </div>
  );
}

// ---- Cards ----

type Act = (a: RemoteAction) => Promise<boolean>;

// ---- Approvals, mobile-native: a pending request is one compact row (✕ / ✓, or a swipe); the row
// opens a sheet with the details, the scope (Once / For this chat / Always) and one primary at the
// bottom. Careful requests have no quick allow: their sheet lists what happens and needs a hold. ----

type Scope = 'once' | 'chat' | 'always';
type Tone = 'routine' | 'review' | 'careful';

function Diff({ file }: { file: PhoneFile }) {
  return (
    <div class="preview">
      <div class="preview__head">
        <span class="mono preview__path">{file.path}</span>
        <span class="mono">
          {file.isNew ? <span class="muted">new </span> : null}
          <span class="add">+{file.added}</span> <span class="del">−{file.removed}</span>
        </span>
      </div>
      {file.lines.length ? (
        <pre class="preview__body">
          {file.lines.map((l, i) => (
            <span key={i} class={`dl${l.op === '+' ? ' dl--add' : l.op === '-' ? ' dl--del' : ''}`}>
              <span class="dl__op">{l.op === ' ' ? '' : l.op === '-' ? '−' : '+'}</span>
              {l.text}
              {'\n'}
            </span>
          ))}
          {file.more ? <span class="muted">{`… ${file.more} more line${file.more === 1 ? '' : 's'}`}</span> : null}
        </pre>
      ) : null}
    </div>
  );
}

function LockIcon() {
  return <UiIcon name="lock" size={12} />;
}

function Chip({ tone, label }: { tone: Tone; label: string }) {
  return (
    <Pill tone={tone} dot={tone !== 'careful'} icon={tone === 'careful' ? 'lock' : undefined}>
      {label}
    </Pill>
  );
}

function Glyph({ name }: { name: 'check' | 'x' }) {
  return <UiIcon name={name === 'check' ? 'check' : 'close'} />;
}

function CommandPreview({ line, cwd }: { line: string; cwd?: string }) {
  return (
    <div class="preview">
      <pre class="preview__body preview__cmd">{line}</pre>
      {cwd && cwd !== '.' ? <p class="preview__foot">in {cwd}</p> : null}
    </div>
  );
}

/** The row would allow if it showed more: say so, so the missing ✓ isn't a mystery. */
const quickAllowBlocked = (r: Req) => r.tone !== 'careful' && !r.onMac && !r.question && !!r.scopes.once && !(r.full !== undefined && r.full.includes('\n'));

/** One pending request, as the row and the sheet both read it. */
interface Req {
  id: string;
  agent: AgentKey;
  verb: string;
  target?: string;
  /** The target is prose (a question), not machine text. */
  prose?: boolean;
  /** The whole command this request approves, when it approves one: sent back as `shown`, and the row must show all of it to allow. */
  full?: string;
  tone: Tone;
  chip: string;
  consequences: string[];
  onMac?: string;
  allowWord: string;
  denyWord: string;
  scopes: Partial<Record<Scope, { rule: string; run(): void }[]>>;
  deny?(): void;
  extra: { label: string; run(): void }[];
  body?: preact.ComponentChildren;
  question?: Extract<PhoneItem, { k: 'question' }>;
  /** How the request read: an open sheet notices when it changes. */
  sig: string;
  /** A question's answer. */
  answer?(values: Record<string, QuestionValue>): void;
}

/**
 * The quick ✓ and swipe-right: the plain one-time yes, only when the row shows everything it approves
 * (one line, not cut off), and never for careful requests, questions or what the phone can't show.
 */
const quickAllow = (r: Req, truncated: boolean) =>
  r.tone !== 'careful' && !r.onMac && !r.question && rowShowsWhole(r.full, r.target, truncated) ? r.scopes.once?.[0]?.run : undefined;

/** A pending item as a request; undefined for anything already decided or not a request. */
function requestOf(item: PhoneItem, agent: AgentKey, act: Act): Req | undefined {
  const r = requestShape(item, agent, act);
  return r && { ...r, sig: JSON.stringify(item) };
}

function requestShape(item: PhoneItem, agent: AgentKey, act: Act): Omit<Req, 'sig'> | undefined {
  switch (item.k) {
    case 'permission': {
      if (item.answer) return undefined;
      const shown = item.command?.line;
      const answer = (optionId: string) => () => void act({ type: 'permission', requestId: item.id, optionId, ...(shown !== undefined ? { shown } : {}) });
      return {
        id: item.id,
        agent,
        verb: item.verb,
        target: item.command ? item.command.line.split('\n')[0] : item.target,
        ...(shown !== undefined ? { full: shown } : {}),
        tone: item.risk.level,
        chip: item.risk.label,
        consequences: item.risk.consequences,
        onMac: item.onMac ? 'Too long or hidden characters: allow it on your Mac. You can still deny it here.' : undefined,
        allowWord: 'Allow',
        denyWord: 'Deny',
        scopes: {
          ...(item.once ? { once: [{ rule: 'Just this request', run: answer(item.once) }] } : {}),
          ...(item.chat ? { chat: [{ rule: `${item.verb}${item.target ? ` ${item.target}` : ''} again, until this chat ends`, run: answer(item.chat) }] } : {}),
          ...(item.always.length ? { always: item.always.map((c) => ({ rule: c.label.replace(/^Always allow (\w)/, (_, ch: string) => ch.toUpperCase()), run: () => void act({ type: 'allowAlways', requestId: item.id, grant: c.grant, ...(shown !== undefined ? { shown } : {}) }) })) } : {}),
        },
        ...(item.deny ? { deny: answer(item.deny) } : {}),
        extra: item.options.map((o) => ({ label: o.name, run: answer(o.id) })),
        body: (
          <>
            {item.command ? <CommandPreview line={item.command.line} cwd={item.command.cwd} /> : null}
            {item.url ? <p class="preview preview__text mono">{item.url}</p> : null}
            {item.files?.map((f) => <Diff key={f.path} file={f} />)}
            {item.plan ? (
              <div class="preview preview--plan">
                <Markdown text={item.plan} />
              </div>
            ) : null}
            {item.text && !item.plan ? <p class="sheet__text">{item.text}</p> : null}
          </>
        ),
      };
    }
    case 'command': {
      if (item.state !== 'awaiting') return undefined;
      const first = item.line.split('\n')[0];
      return {
        id: item.id,
        agent,
        verb: 'Run',
        target: first,
        full: item.line,
        tone: item.risk.level,
        chip: item.risk.label,
        consequences: item.risk.consequences,
        onMac: item.onMac ? 'Too long or hidden characters: run it from your Mac. You can still deny it here.' : undefined,
        allowWord: 'Run',
        denyWord: 'Deny',
        scopes: {
          once: [{ rule: 'Just this command', run: () => void act({ type: 'command', commandId: item.id, approve: true, shown: item.line }) }],
          ...(item.outside || item.onMac ? {} : { always: [{ rule: `${first}, exactly, in every chat`, run: () => void act({ type: 'allowAlways', commandId: item.id, grant: { kind: 'exact', command: item.line }, shown: item.line }) }] }),
        },
        deny: () => void act({ type: 'command', commandId: item.id, approve: false }),
        extra: [],
        body: <CommandPreview line={item.line} cwd={item.cwd} />,
      };
    }
    case 'review':
      if (item.state !== 'pending') return undefined;
      return {
        id: item.id,
        agent,
        verb: item.file.isNew ? 'Create' : 'Edit',
        target: item.file.path,
        tone: 'review',
        chip: `+${item.file.added} −${item.file.removed}`,
        consequences: [],
        allowWord: 'Accept',
        denyWord: 'Reject',
        scopes: { once: [{ rule: 'Write this edit', run: () => void act({ type: 'review', reviewId: item.id, action: 'accept' }) }] },
        deny: () => void act({ type: 'review', reviewId: item.id, action: 'reject' }),
        extra: [],
        body: <Diff file={item.file} />,
      };
    case 'bridge': {
      if (item.state !== 'awaiting') return undefined;
      const answer = (a: 'allow' | 'allowChat' | 'allowAlways') => () => void act({ type: 'bridge', requestId: item.id, answer: a });
      return {
        id: item.id,
        agent: item.agent,
        verb: item.title,
        tone: item.careful ? 'careful' : 'review',
        chip: 'Agent',
        consequences: [],
        allowWord: 'Allow',
        denyWord: 'Deny',
        scopes: {
          once: [{ rule: 'Just this request', run: answer('allow') }],
          ...(item.once ? {} : { chat: [{ rule: 'Requests like this one in this chat, until it ends', run: answer('allowChat') }] }),
          ...(item.always ? { always: [{ rule: item.always, run: answer('allowAlways') }] } : {}),
        },
        deny: () => void act({ type: 'bridge', requestId: item.id, answer: 'deny' }),
        extra: [],
        body: item.text ? <p class="preview preview__text">{item.text}</p> : undefined,
      };
    }
    case 'question':
      if (item.state !== 'awaiting') return undefined;
      return {
        id: item.id,
        agent,
        verb: 'Asks',
        target: item.message,
        prose: true,
        tone: 'review',
        chip: 'Question',
        consequences: [],
        allowWord: 'Answer',
        denyWord: 'Skip',
        scopes: {},
        deny: () => void act({ type: 'answerQuestion', requestId: item.id, action: 'decline' }),
        extra: [],
        question: item,
        answer: (values) => void act({ type: 'answerQuestion', requestId: item.id, action: 'accept', values }),
      };
    default:
      return undefined;
  }
}

/** A pending request in the transcript: one row; ✕ / ✓ on the right; swipe right allows once, left denies. */
function PendingRow({ req, open, swiped }: { req: Req; open(): void; swiped(dir: 'allow' | 'deny', run: () => void): void }) {
  const targetRef = useRef<HTMLSpanElement>(null);
  const [truncated, setTruncated] = useState(true);
  useLayoutEffect(() => {
    const el = targetRef.current;
    setTruncated(!!el && el.scrollWidth > el.clientWidth + 1);
  });
  const allow = quickAllow(req, truncated);
  const moreLines = req.full ? req.full.split('\n').length - 1 : 0;
  const [dx, setDx] = useState(0);
  const drag = useRef<{ x: number; y: number; id: number; moving: boolean; armed: boolean } | undefined>(undefined);
  const LIMIT = 96;
  const onDown = (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    drag.current = { x: e.clientX, y: e.clientY, id: e.pointerId, moving: false, armed: false };
  };
  const onMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const mx = e.clientX - d.x;
    if (!d.moving) {
      if (Math.abs(mx) < 10 || Math.abs(mx) < Math.abs(e.clientY - d.y)) return;
      d.moving = true;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
    const next = Math.max(req.deny ? -140 : 0, Math.min(allow ? 140 : 0, mx));
    const armed = Math.abs(next) >= LIMIT;
    if (armed !== d.armed) {
      d.armed = armed;
      if (armed) navigator.vibrate?.(8);
    }
    setDx(next);
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = undefined;
    if (!d) return;
    if (!d.moving) return open();
    if (dx >= LIMIT && allow) swiped('allow', allow);
    else if (dx <= -LIMIT && req.deny) swiped('deny', req.deny);
    setDx(0);
  };
  return (
    <div class={`req req--${req.tone}`}>
      <div class="req__under" aria-hidden="true">
        <span class={`req__hint req__hint--allow${dx >= LIMIT ? ' req__hint--armed' : ''}`}>
          <Glyph name="check" /> {req.allowWord} once
        </span>
        <span class={`req__hint req__hint--deny${dx <= -LIMIT ? ' req__hint--armed' : ''}`}>
          {req.denyWord} <Glyph name="x" />
        </span>
      </div>
      <div
        class={`req__row${dx ? ' req__row--dragging' : ''}`}
        style={dx ? { transform: `translateX(${dx}px)` } : undefined}
        role="button"
        tabIndex={0}
        aria-label={`${req.verb} ${req.target ?? ''}: open the request`}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={() => ((drag.current = undefined), setDx(0))}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), open())}
      >
        <Avatar agent={req.agent} small />
        <span class="req__text">
          <span class="req__line">
            <span class="req__verb">{req.verb}</span>
            {req.target ? (
              <span ref={targetRef} class={req.prose ? 'req__prose' : 'mono req__target'}>
                {req.target}
              </span>
            ) : null}
          </span>
          <span class="req__meta">
            <Chip tone={req.tone} label={req.chip} />
            {moreLines ? <span class="meta">+{moreLines} more line{moreLines === 1 ? '' : 's'}</span> : null}
            {!allow && quickAllowBlocked(req) ? <span class="meta">Tap to review</span> : null}
          </span>
        </span>
        {req.deny ? <IconButton round variant="secondary" icon="close" label={req.denyWord} onClick={req.deny} /> : null}
        {allow ? <IconButton round variant="primary" icon="check" label={`${req.allowWord} once`} onClick={allow} /> : null}
      </div>
    </div>
  );
}

/** Press and hold for 600 ms (or hold Enter / Space): a careful allow is never a reflex tap. */
function HoldBar({ label, onDone }: { label: string; onDone(): void }) {
  const [holding, setHolding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const start = () => {
    if (timer.current) return;
    setHolding(true);
    navigator.vibrate?.(8);
    timer.current = setTimeout(() => {
      timer.current = undefined;
      setHolding(false);
      navigator.vibrate?.(20);
      onDone();
    }, 600);
  };
  const stop = () => {
    clearTimeout(timer.current);
    timer.current = undefined;
    setHolding(false);
  };
  return (
    <Button
      variant="danger"
      block
      class="fl-btn--hold"
      data-holding={holding ? '' : undefined}
      aria-label={`${label}: press and hold`}
      onPointerDown={(e) => (e.preventDefault(), start())}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && !e.repeat && (e.preventDefault(), start())}
      onKeyUp={(e) => (e.key === 'Enter' || e.key === ' ') && stop()}
    >
      <LockIcon /> {holding ? 'Keep holding…' : `Hold to ${label.toLowerCase()}`}
    </Button>
  );
}

function QuestionFields({ q, values, set }: { q: Extract<PhoneItem, { k: 'question' }>; values: Record<string, QuestionValue>; set(k: string, v: QuestionValue): void }) {
  return (
    <>
      {q.fields.map((f: QuestionField) => (
        <div class="field" key={f.key}>
          {q.fields.length > 1 || f.type !== 'choice' ? <p class="field__title">{f.title}</p> : null}
          {f.description ? <p class="meta">{f.description}</p> : null}
          {f.type === 'choice' || f.type === 'multi' ? (
            <div class="rows" role={f.type === 'choice' ? 'radiogroup' : 'group'}>
              {(f.options ?? []).map((o) => {
                const picked = values[f.key];
                const on = f.type === 'choice' ? picked === o.value : Array.isArray(picked) && picked.includes(o.value);
                if (f.type === 'choice') return <RadioRow key={o.value} name={f.key} checked={on} onChange={() => set(f.key, o.value)} label={o.title} desc={o.description} />;
                const list = Array.isArray(picked) ? picked : [];
                return (
                  <Checkbox key={o.value} checked={on} onChange={() => set(f.key, on ? list.filter((x) => x !== o.value) : [...list, o.value])}>
                    {o.title}
                    {o.description ? <span class="meta"> · {o.description}</span> : null}
                  </Checkbox>
                );
              })}
            </div>
          ) : f.type === 'boolean' ? (
            <Checkbox checked={values[f.key] === true} onChange={(v) => set(f.key, v)}>
              {f.title}
            </Checkbox>
          ) : (
            <Input
              inputMode={f.type === 'number' ? 'decimal' : 'text'}
              value={String(values[f.key] ?? '')}
              onInput={(e) => {
                const v = (e.target as HTMLInputElement).value;
                set(f.key, f.type === 'number' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : v);
              }}
            />
          )}
        </div>
      ))}
    </>
  );
}

const SCOPE_TITLES: Record<Scope, string> = { once: 'Once', chat: 'For this chat', always: 'Always' };

/** One request in full: details, scope, and the primary in the thumb zone. */
function RequestPanel({ req, done }: { req: Req; done(): void }) {
  const [choice, setChoice] = useState<{ scope: Scope; i: number }>({ scope: 'once', i: 0 });
  const [values, setValues] = useState<Record<string, QuestionValue>>({});
  const careful = req.tone === 'careful';
  const rows = careful ? [] : (['once', 'chat', 'always'] as Scope[]).flatMap((s) => (req.scopes[s] ?? []).map((x, i) => ({ scope: s, i, rule: x.rule })));
  const chosen = req.scopes[choice.scope]?.[choice.i];
  const primary = req.question ? 'Answer' : choice.scope === 'once' ? `${req.allowWord} once` : choice.scope === 'chat' ? `${req.allowWord} for this chat` : `Always ${req.allowWord.toLowerCase()}`;
  const q = req.question;
  const ready = !q || (q.fields.every((f) => !f.required || values[f.key] !== undefined) && (q.fields.length !== 1 || values[q.fields[0].key] !== undefined));
  const go = () => {
    chosen?.run();
    done();
  };
  return (
    <>
      <div class="sheet__scroll">
        <header class="sheet__req">
          <Avatar agent={req.agent} small />
          <div class="sheet__req-text">
            <p class="sheet__req-title">
              {req.verb} {req.target && !req.prose ? <span class="mono">{req.target}</span> : null}
            </p>
            {req.prose && req.target ? <p class="sheet__text">{req.target}</p> : null}
            <Chip tone={req.tone} label={req.chip} />
          </div>
        </header>
        {req.body}
        {q ? <QuestionFields q={q} values={values} set={(k, v) => setValues({ ...values, [k]: v })} /> : null}
        {careful && req.consequences.length ? (
          <ul class="sheet__why">
            {req.consequences.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        ) : null}
        {req.onMac ? <p class="meta meta--warn">{req.onMac}</p> : null}
        {rows.length > 1 && !req.onMac ? (
          <div class="rows" role="radiogroup" aria-label="How long">
            {rows.map((r) => {
              const on = r.scope === choice.scope && r.i === choice.i;
              return (
                <RadioRow
                  key={`${r.scope}${r.i}`}
                  name="how-long"
                  checked={on}
                  onChange={() => setChoice({ scope: r.scope, i: r.i })}
                  label={
                    <>
                      {SCOPE_TITLES[r.scope]} {r.scope === 'once' ? null : <Pill tone="info">Confirm on Mac</Pill>}
                    </>
                  }
                  desc={r.rule}
                />
              );
            })}
          </div>
        ) : null}
        {careful ? (
          <p class="meta">
            <LockIcon /> Allowed once only
          </p>
        ) : null}
        {req.extra.length ? (
          <div class="sheet__extra">
            <p class="meta">Other answers from {AGENT_NAMES[req.agent]}</p>
            {req.extra.map((x) => (
              <Button key={x.label} variant="quiet" size="sm" onClick={() => (x.run(), done())}>
                {x.label}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
      <footer class="sheet__actions">
        {q ? (
          <Button variant="primary" block disabled={!ready} onClick={() => (req.answer?.(values), done())}>
            Answer
          </Button>
        ) : chosen && !req.onMac ? (
          careful ? (
            <HoldBar label={primary} onDone={go} />
          ) : (
            <Button variant="primary" block onClick={go}>
              {primary}
            </Button>
          )
        ) : null}
        {req.deny ? (
          <Button variant="quiet" block onClick={() => (req.deny!(), done())}>
            {req.denyWord}
          </Button>
        ) : null}
      </footer>
    </>
  );
}

/** The request sheet: one request, or the queue of them, swiped or paged with ‹ ›. */
/** What the sheet has open: a request by id, and how it read when opened (its signature). */
type Open = { id: string; sig: string };

/**
 * The request sheet: one request, tracked by id, never by position, so a list that changes can't put
 * another request under your finger. A request that leaves or changes says so instead of being replaced.
 * After an answer the next one is offered, and opens after a 400 ms settle (or a tap), as a new panel
 * that needs a fresh press.
 */
function RequestSheet({ reqs, open, setOpen, close }: { reqs: Req[]; open: Open; setOpen(o: Open): void; close(): void }) {
  const start = useRef<number | undefined>(undefined);
  const [settled, setSettled] = useState<{ next?: Req } | undefined>(undefined);
  const list = reqs.map((r) => ({ id: r.id, sig: r.sig }));
  const target = sheetTarget(list, open);
  const at = target.kind === 'ok' ? target.index : -1;
  const req = at >= 0 ? reqs[at] : undefined;
  const go = (r: Req | undefined) => (r ? setOpen({ id: r.id, sig: r.sig }) : close());
  const step = (by: number) => {
    const from = list.findIndex((r) => r.id === open.id);
    go(reqs[(Math.max(from, 0) + by + reqs.length) % reqs.length]);
  };
  useEffect(() => {
    if (!settled) return;
    const t = setTimeout(() => {
      setSettled(undefined);
      const still = settled.next && reqs.find((r) => r.id === settled.next!.id && r.sig === settled.next!.sig);
      go(still);
    }, 400);
    return () => clearTimeout(t);
  }, [settled]);
  const answered = () => {
    const nextId = nextAfter(list.map((r) => r.id), open.id);
    setSettled({ next: reqs.find((r) => r.id === nextId) });
  };
  let content: preact.ComponentChildren;
  if (settled) {
    content = (
      <div class="sheet__state">
        <p class="sheet__state-title">
          <Glyph name="check" /> Answered
        </p>
        {settled.next ? (
          <Button variant="quiet" size="sm" onClick={() => (setSettled(undefined), go(settled.next))}>
            Next: {settled.next.verb} {settled.next.target && !settled.next.prose ? settled.next.target : ''}
          </Button>
        ) : null}
      </div>
    );
  } else if (target.kind === 'gone') {
    content = (
      <div class="sheet__state">
        <p class="sheet__state-title">This request is no longer waiting.</p>
        <p class="meta">It was answered elsewhere, or the agent moved on.</p>
        <Button variant="quiet" onClick={close}>
          Close
        </Button>
      </div>
    );
  } else if (target.kind === 'changed') {
    content = (
      <div class="sheet__state">
        <p class="sheet__state-title">This request changed. Review it again.</p>
        <Button variant="quiet" onClick={() => setOpen({ id: open.id, sig: reqs.find((r) => r.id === open.id)!.sig })}>
          Review again
        </Button>
      </div>
    );
  } else {
    content = <RequestPanel key={`${req!.id}:${req!.sig}`} req={req!} done={answered} />;
  }
  return (
    <div class="sheet" role="dialog" aria-modal="true" aria-label="Request" onClick={(e) => e.target === e.currentTarget && close()}>
      <div
        class="sheet__panel sheet__panel--req"
        onTouchStart={(e) => (start.current = e.touches[0]?.clientX)}
        onTouchEnd={(e) => {
          const dx = (e.changedTouches[0]?.clientX ?? 0) - (start.current ?? 0);
          if (!settled && req && reqs.length > 1 && Math.abs(dx) > 80 && !(e.target as HTMLElement).closest('pre, .preview, .btn-lg')) step(dx < 0 ? 1 : -1);
        }}
      >
        <div class="sheet__grab" aria-hidden="true" />
        <header class="sheet__nav">
          {reqs.length > 1 && req && !settled ? (
            <>
              <IconButton round icon="back" label="Previous request" onClick={() => step(-1)} />
              <span class="meta">
                {at + 1} of {reqs.length} waiting
              </span>
              <IconButton round icon="forward" label="Next request" onClick={() => step(1)} />
            </>
          ) : (
            <span class="meta">Waiting for you</span>
          )}
          <Button variant="quiet" size="sm" onClick={close}>
            Close
          </Button>
        </header>
        {content}
      </div>
    </div>
  );
}

/** A decided request: one line in the timeline. */
function Resolved({ verb, target, outcome, tone = 'done' }: { verb: string; target?: string; outcome: string; tone?: 'done' | 'denied' }) {
  return (
    <p class={`resolved resolved--${tone}`}>
      <span class="resolved__what">
        {verb} {target ? <span class="mono">{target}</span> : null}
      </span>
      <span class="resolved__outcome"> · {outcome}</span>
    </p>
  );
}

/** Everything in the transcript but pending requests, which ChatScreen draws as rows. */
function ItemView({ item }: { item: PhoneItem }) {
  switch (item.k) {
    case 'user':
      return <div class="msg msg--you">{item.text}</div>;
    case 'agent':
      return (
        <div class="msg msg--agent">
          <Markdown text={item.text} />
        </div>
      );
    case 'tool':
      return (
        <div class={`step step--${item.status === 'failed' ? 'failed' : item.status === 'completed' ? 'done' : 'working'}`}>
          <span class="step__title">
            {item.subagent ? <span class="tag">Subagent</span> : null}
            {item.title}
          </span>
        </div>
      );
    case 'plan':
      return (
        <section class="plan">
          {item.entries.map((e, i) => (
            <p key={i} class={`plan__row plan__row--${e.status}`}>
              <span class="plan__mark">{e.status === 'completed' ? '✓' : e.status === 'in_progress' ? '•' : '○'}</span>
              {e.content}
            </p>
          ))}
        </section>
      );
    case 'permission':
      return <Resolved verb={item.verb} target={item.target} outcome={`${item.answer ?? ''}${item.auto ? ` · ${item.auto}` : ''}`} tone={/^no|deny|reject|cancel/i.test(item.answer ?? '') ? 'denied' : 'done'} />;
    case 'command':
      return (
        <div class={`step step--${item.state === 'denied' || (item.exitCode ?? 0) !== 0 ? 'failed' : item.state === 'running' ? 'working' : 'done'}`}>
          <span class="step__title">
            <span class="tag">Run</span>
            <span class="mono">{item.line.split('\n')[0]}</span>
          </span>
          {item.output ? <pre class="step__out">{item.output}</pre> : null}
        </div>
      );
    case 'question':
      return <Resolved verb="Asked" outcome={item.summary ?? (item.state === 'declined' ? 'skipped' : 'answered')} />;
    case 'review':
      return <Resolved verb="Edit" target={item.file.path} outcome={`${item.state}${item.auto ? ` · ${item.auto}` : ''}`} tone={item.state === 'rejected' ? 'denied' : 'done'} />;
    case 'bridge':
      return <Resolved verb={item.title} outcome={item.state} tone={item.state === 'denied' ? 'denied' : 'done'} />;
    case 'notice':
      return <p class={`notice${item.tone === 'error' ? ' notice--error' : ''}`}>{item.text}</p>;
    case 'changes':
      return <p class="notice">{`${item.files} file${item.files === 1 ? '' : 's'} changed${item.undone ? ' · undone' : ''}`}</p>;
    case 'link':
      return (
        <div class="msg msg--link">
          <p class="meta">{item.label}</p>
          <Markdown text={item.text} />
        </div>
      );
  }
}

// ---- Screens ----

function ChatRow({ chat, now, open }: { chat: PhoneSummary; now: number; open(): void }) {
  return (
    <button class="row" onClick={open}>
      <Avatar agent={chat.agent} />
      <span class="row__main">
        <span class="row__title">{chat.title}</span>
        <span class="row__meta">
          <Dot status={chat.status} />
          {chat.label} · {chat.folder}
          {chat.subagents ? ` · ${chat.subagents} subagent${chat.subagents === 1 ? '' : 's'}` : ''}
        </span>
      </span>
      <span class="row__end">
        {chat.waiting ? <span class="badge">{chat.waiting}</span> : <span class="row__ago">{ago(chat.lastActivity, now)}</span>}
      </span>
    </button>
  );
}

function ListScreen({ list, live, open, newChat, settings }: { list: PhoneList | undefined; live: boolean; open(id: string): void; newChat(): void; settings(): void }) {
  return (
    <div class="screen">
      <header class="bar">
        <h1 class="bar__title">Chats</h1>
        <span class={`live${live ? ' live--on' : ''}`}>{live ? 'Live' : 'Reconnecting…'}</span>
        <IconButton icon="more" label="Settings" onClick={settings} />
        <IconButton icon="plus" variant="brand" label="New chat" onClick={newChat} />
      </header>
      <main class="list">
        {!list ? <p class="empty">Loading…</p> : null}
        {list && !list.groups.length ? <p class="empty">No chats yet. Start one with +.</p> : null}
        {list?.groups.map((g) => (
          <section key={g.status} class="group">
            <h2 class="group__title">
              {g.title} <span class="group__count">{g.chats.length}</span>
            </h2>
            {g.chats.map((c) => (
              <ChatRow key={c.id} chat={c} now={list.now} open={() => open(c.id)} />
            ))}
          </section>
        ))}
      </main>
    </div>
  );
}

function ChatScreen({ chat, act, back }: { chat: PhoneChat | undefined; act: Act; back(): void }) {
  const [text, setText] = useState('');
  const [subsOpen, setSubsOpen] = useState(false);
  const [sheet, setSheet] = useState<Open | undefined>(undefined);
  const flushUndo = useRef<(() => void) | undefined>(undefined);
  /** A swiped answer waits 3 s before it is sent, so Undo really undoes: the agent hasn't seen it. */
  const [undo, setUndo] = useState<{ id: string; text: string; timer: ReturnType<typeof setTimeout> } | undefined>(undefined);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => () => clearTimeout(undo?.timer), [undo]);
  const count = chat?.items.length ?? 0;
  useEffect(() => end.current?.scrollIntoView({ block: 'end' }), [count, chat?.id]);
  if (!chat) {
    return (
      <div class="screen">
        <header class="bar">
          <IconButton icon="back" label="Back" onClick={back} />
        </header>
        <p class="empty">Loading…</p>
      </div>
    );
  }
  const send = async () => {
    if (!text.trim()) return;
    if (await act({ type: 'send', chatId: chat.id, text })) setText('');
  };
  const live = chat.subagentList.filter((s) => s.state === 'working');
  const reqs = chat.items.flatMap((item) => {
    const r = requestOf(item, chat.agent, act);
    return r && r.id !== undo?.id ? [r] : [];
  });
  const swiped = (r: Req, dir: 'allow' | 'deny', run: () => void) => {
    if (undo) {
      // The earlier one goes now.
      clearTimeout(undo.timer);
      flushUndo.current?.();
    }
    const timer = setTimeout(() => {
      flushUndo.current = undefined;
      setUndo(undefined);
      run();
    }, 3000);
    flushUndo.current = run;
    setUndo({ id: r.id, text: `${dir === 'allow' ? `${r.allowWord === 'Run' ? 'Run' : 'Allowed'} once` : ({ Deny: 'Denied', Reject: 'Rejected', Skip: 'Skipped' } as Record<string, string>)[r.denyWord] ?? r.denyWord}: ${r.verb}${r.target && !r.prose ? ` ${r.target}` : ''}`, timer });
  };
  return (
    <div class="screen screen--chat">
      <header class="bar bar--chat">
        <IconButton icon="back" label="Back" onClick={back} />
        <div class="bar__chat">
          <p class="bar__chat-title">{chat.title}</p>
          <p class="bar__chat-meta">
            <Dot status={chat.status} />
            {chat.label} · {chat.folder}
          </p>
        </div>
      </header>
      <div class="levels">
        <Segmented
          label="Approvals"
          block
          value={chat.approval}
          onChange={(level) => chat.approval !== level && void act({ type: 'approval', chatId: chat.id, level })}
          options={LEVELS.map((l) => ({ value: l.level, label: l.name }))}
        />
      </div>
      {chat.subagentList.length ? (
        <div class="subs">
          <Row expanded={subsOpen} onPress={() => setSubsOpen(!subsOpen)}>
            {chat.subagentList.length} subagent{chat.subagentList.length === 1 ? '' : 's'}
            {live.length ? ` · ${live.length} running` : ''}
          </Row>
          {subsOpen ? (
            <ul class="subs__list">
              {chat.subagentList.map((s) => (
                <li key={s.id} class="subs__row">
                  <Dot status={s.state === 'working' ? 'working' : s.state === 'failed' ? 'error' : 'done'} />
                  <span class="subs__title">{s.title}</span>
                  <span class="subs__meta">{s.last ?? `${s.tools} steps`}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <main class="transcript">
        {chat.earlier ? <p class="notice">{chat.earlier} earlier items are on your Mac.</p> : null}
        {chat.items.map((item, i) => {
          const r = requestOf(item, chat.agent, act);
          if (r) return r.id === undo?.id ? null : <PendingRow key={r.id} req={r} open={() => setSheet({ id: r.id, sig: r.sig })} swiped={(dir, run) => swiped(r, dir, run)} />;
          return <ItemView key={`${chat.id}-${i}-${item.k}`} item={item} />;
        })}
        {chat.busy ? <p class="working">Working…</p> : null}
        <div ref={end} />
      </main>
      {undo ? (
        <div class="undo" role="status">
          <span class="undo__text">{undo.text}</span>
          <Button
            variant="quiet"
            size="sm"
            onClick={() => {
              clearTimeout(undo.timer);
              flushUndo.current = undefined;
              setUndo(undefined);
            }}
          >
            Undo
          </Button>
        </div>
      ) : reqs.length > 1 ? (
        <div class="waiting">
          <Button block onClick={() => setSheet({ id: reqs[0].id, sig: reqs[0].sig })}>
            <Dot status="needs-you" />
            {reqs.length} waiting · Review
          </Button>
        </div>
      ) : null}
      {sheet ? <RequestSheet reqs={reqs} open={sheet} setOpen={setSheet} close={() => setSheet(undefined)} /> : null}
      <footer class="composer">
        <Textarea
          class="composer__input"
          rows={1}
          placeholder="Message…"
          value={text}
          onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
          aria-label="Message"
        />
        {chat.busy ? (
          <IconButton icon="stop" variant="secondary" label="Stop" onClick={() => void act({ type: 'stop', chatId: chat.id })} />
        ) : null}
        <IconButton icon="up" variant="brand" label="Send" disabled={!text.trim()} onClick={() => void send()} />
      </footer>
    </div>
  );
}

function NewChatSheet({ list, act, close }: { list: PhoneList; act(a: RemoteAction): Promise<{ chatId?: string } | undefined>; close(id?: string): void }) {
  const [agent, setAgent] = useState<AgentKey | undefined>(list.agents[0]?.key);
  const [folder, setFolder] = useState(list.folders[0]?.path ?? '');
  const [text, setText] = useState('');
  return (
    <div class="sheet" role="dialog" aria-modal="true" aria-label="New chat">
      <div class="sheet__panel">
        <header class="sheet__head">
          <h2>New chat</h2>
          <Button variant="link" onClick={() => close()}>
            Cancel
          </Button>
        </header>
        <p class="field__title">Agent</p>
        <div class="pills">
          {list.agents.map((a) => (
            <FilterPill key={a.key} size="touch" pressed={agent === a.key} onPress={() => setAgent(a.key)}>
              {a.name}
            </FilterPill>
          ))}
        </div>
        <p class="field__title">Folder</p>
        {list.folders.length ? (
          <select class="fl-input" value={folder} onChange={(e) => setFolder((e.target as HTMLSelectElement).value)}>
            {list.folders.map((f) => (
              <option key={f.path} value={f.path}>
                {f.name}
              </option>
            ))}
          </select>
        ) : (
          <p class="hint">Open a folder in FriedLiver on your Mac first.</p>
        )}
        <p class="field__title">First message</p>
        <Textarea rows={4} value={text} placeholder="What should it do?" onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} />
        <Button
          variant="primary"
          block
          disabled={!agent || !folder}
          onClick={async () => {
            const r = await act({ type: 'newChat', agent: agent!, folder, text });
            if (r) close(r.chatId);
          }}
        >
          Start chat
        </Button>
      </div>
    </div>
  );
}

function Settings({ close, forget }: { close(): void; forget(): void }) {
  const fp = store.get('fingerprint');
  return (
    <div class="sheet" role="dialog" aria-modal="true" aria-label="This phone">
      <div class="sheet__panel">
        <header class="sheet__head">
          <h2>This phone</h2>
          <Button variant="link" onClick={close}>
            Done
          </Button>
        </header>
        <p class="field__title">Paired as</p>
        <p>{store.get('name') ?? 'Phone'}</p>
        {fp ? (
          <>
            <p class="field__title">Mac’s certificate (SHA-256)</p>
            <p class="fp">{fp}</p>
          </>
        ) : null}
        <Button variant="danger" block onClick={forget}>
          Forget this phone
        </Button>
        <p class="hint">Unpairs this phone. Your Mac can also revoke it under FriedLiver: Remote Control.</p>
      </div>
    </div>
  );
}

function defaultName(): string {
  const ua = navigator.userAgent;
  return /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android phone' : 'Phone';
}

/** "AB:CD:…" in groups of four bytes, so it is easy to compare with the browser's certificate view. */
const groupedFp = (fp: string) => (fp.replace(/:/g, '').match(/.{1,8}/g) ?? []).join(' ');

function Pairing({ code, fp, done }: { code: string | undefined; fp: string | undefined; done(): void }) {
  const [name, setName] = useState(defaultName());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (!code) {
    return (
      <div class="screen screen--center">
        <div class="pair">
          <h1>FriedLiver Remote</h1>
          <p>
            On your Mac, run <strong>FriedLiver: Remote Control…</strong> and scan the QR code with this phone’s camera.
          </p>
          {error ? <p class="notice notice--error">{error}</p> : null}
        </div>
      </div>
    );
  }
  return (
    <div class="screen screen--center">
      <div class="pair">
        <h1>Pair with your Mac</h1>
        <p>This phone will be able to read your chats, answer approvals and send messages to your agents.</p>
        {fp ? (
          <>
            <p class="field__title">Certificate fingerprint (SHA-256)</p>
            <p class="fp">{groupedFp(fp)}</p>
            <p class="hint">It must match your Mac’s pairing panel and the certificate details your browser showed. If your browser warns again after pairing, don’t continue: someone may be in between.</p>
          </>
        ) : null}
        <p class="field__title">Name this phone</p>
        <Input value={name} maxLength={40} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        {error ? <p class="notice notice--error">{error}</p> : null}
        <Button
          variant="primary"
          block
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await api<{ token: string; device: { name: string } }>('POST', '/api/pair', { code, name });
              store.set('token', r.token);
              store.set('name', r.device.name);
              store.set('fingerprint', fp ? groupedFp(fp) : undefined);
              done();
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          Pair
        </Button>
      </div>
    </div>
  );
}

// ---- The app ----

/** The QR's link carries the pairing code and the certificate fingerprint in the fragment, which never reaches a server. */
function readFragment(): { code?: string; fp?: string } {
  const p = new URLSearchParams(location.hash.slice(1));
  if (location.hash) history.replaceState(null, '', location.pathname);
  const code = p.get('c') ?? undefined;
  const fpRaw = p.get('f');
  let fp: string | undefined;
  if (fpRaw && /^[A-Za-z0-9_-]{43}$/.test(fpRaw)) {
    const bin = atob(fpRaw.replace(/-/g, '+').replace(/_/g, '/') + '=');
    fp = [...bin].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase()).join(':');
  }
  return { code: code && /^[A-Za-z0-9_-]{22}$/.test(code) ? code : undefined, fp };
}

const fragment = readFragment();

function App() {
  const [paired, setPaired] = useState(!!store.get('token') && !fragment.code);
  const [list, setList] = useState<PhoneList>();
  const [openId, setOpenId] = useState<string | undefined>(() => (location.hash ? undefined : (sessionStorage.getItem('fl.open') ?? undefined)));
  const [chat, setChat] = useState<PhoneChat>();
  const [live, setLive] = useState(false);
  const [toast, setToast] = useState<{ text: string; tone?: 'error' } | undefined>();
  const [sheet, setSheet] = useState<'new' | 'settings' | undefined>();
  const openRef = useRef(openId);
  openRef.current = openId;

  const unpair = () => {
    store.set('token', undefined);
    setPaired(false);
    setList(undefined);
    setChat(undefined);
  };
  const fail = (err: unknown) => {
    if (err instanceof Unpaired) unpair();
    else setToast({ text: err instanceof Error ? err.message : String(err), tone: 'error' });
  };
  const refresh = async (which: 'all' | string[] = 'all') => {
    try {
      const id = openRef.current;
      const [l, c] = await Promise.all([api<PhoneList>('GET', '/api/chats'), id && (which === 'all' || which.includes(id)) ? api<PhoneChat>('GET', `/api/chats/${encodeURIComponent(id)}`).catch(() => undefined) : Promise.resolve(null)]);
      setList(l);
      if (c !== null) setChat(c);
    } catch (err) {
      fail(err);
    }
  };

  useEffect(() => {
    try {
      if (openId) sessionStorage.setItem('fl.open', openId);
      else sessionStorage.removeItem('fl.open');
    } catch {
      // ignore
    }
    setChat(undefined);
    if (paired && openId) void refresh([openId]);
  }, [openId, paired]);

  // Live updates: a ticket from an authenticated request opens the socket; it only says what changed.
  useEffect(() => {
    if (!paired) return;
    let socket: WebSocket | undefined;
    let stopped = false;
    let delay = 1000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: Set<string> | 'all' | undefined;
    let flush: ReturnType<typeof setTimeout> | undefined;
    const connect = async () => {
      if (stopped || socket) return;
      try {
        const { ticket } = await api<{ ticket: string }>('POST', '/api/ticket', {});
        socket = new WebSocket(`wss://${location.host}/ws?ticket=${encodeURIComponent(ticket)}`);
        socket.onopen = () => {
          delay = 1000;
          setLive(true);
          void refresh();
        };
        socket.onmessage = (e) => {
          const ev = JSON.parse(String(e.data)) as PhoneEvent;
          if (ev.type === 'revoked') return unpair();
          pending = pending === 'all' ? 'all' : new Set([...(pending ?? []), ...ev.chats]);
          flush ??= setTimeout(() => {
            flush = undefined;
            const which = pending;
            pending = undefined;
            void refresh(which === 'all' || !which ? 'all' : [...which]);
          }, 120);
        };
        socket.onclose = () => {
          socket = undefined;
          setLive(false);
          if (!stopped) timer = setTimeout(() => void connect(), (delay = Math.min(delay * 2, 15_000)));
        };
      } catch (err) {
        fail(err);
        if (!(err instanceof Unpaired) && !stopped) timer = setTimeout(() => void connect(), (delay = Math.min(delay * 2, 15_000)));
      }
    };
    void connect();
    void refresh();
    const wake = () => {
      if (document.visibilityState !== 'visible') return;
      void refresh();
      if (!socket) {
        clearTimeout(timer);
        delay = 1000;
        void connect();
      }
    };
    document.addEventListener('visibilitychange', wake);
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearTimeout(flush);
      socket?.close();
      document.removeEventListener('visibilitychange', wake);
    };
  }, [paired]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(undefined), toast.tone === 'error' ? 5000 : 2500);
    return () => clearTimeout(t);
  }, [toast]);

  const send = async (a: RemoteAction): Promise<{ chatId?: string } | undefined> => {
    const slow = setTimeout(() => setToast({ text: 'Waiting for your Mac…' }), 700);
    try {
      const r = await api<{ ok: boolean; error?: string; chatId?: string }>('POST', '/api/action', a);
      if (!r.ok) {
        setToast({ text: r.error ?? 'That didn’t work.', tone: 'error' });
        return undefined;
      }
      setToast(undefined);
      void refresh(openRef.current ? [openRef.current] : 'all');
      return { chatId: r.chatId };
    } catch (err) {
      fail(err);
      return undefined;
    } finally {
      clearTimeout(slow);
    }
  };
  const act: Act = async (a) => !!(await send(a));

  if (!paired) return <Pairing code={fragment.code} fp={fragment.fp} done={() => ((fragment.code = undefined), setPaired(true))} />;
  return (
    <>
      {openId ? (
        <ChatScreen chat={chat?.id === openId ? chat : undefined} act={act} back={() => setOpenId(undefined)} />
      ) : (
        <ListScreen list={list} live={live} open={setOpenId} newChat={() => setSheet('new')} settings={() => setSheet('settings')} />
      )}
      {sheet === 'new' && list ? (
        <NewChatSheet
          list={list}
          act={send}
          close={(id) => {
            setSheet(undefined);
            if (id) setOpenId(id);
          }}
        />
      ) : null}
      {sheet === 'settings' ? (
        <Settings
          close={() => setSheet(undefined)}
          forget={async () => {
            await api('POST', '/api/forget', {}).catch(() => {});
            setSheet(undefined);
            unpair();
          }}
        />
      ) : null}
      {toast ? (
        <div class={`toast${toast.tone === 'error' ? ' toast--error' : ''}`} role="status">
          {toast.text}
        </div>
      ) : null}
    </>
  );
}

// The design system's theme hooks: the light or dark token blocks by the phone's own setting, and touch sizes.
const light = window.matchMedia('(prefers-color-scheme: light)');
const theme = () => {
  document.body.classList.toggle('vscode-light', light.matches);
  document.body.classList.toggle('vscode-dark', !light.matches);
};
document.body.dataset.density = 'touch';
theme();
light.addEventListener('change', theme);

render(<App />, document.getElementById('root')!);
