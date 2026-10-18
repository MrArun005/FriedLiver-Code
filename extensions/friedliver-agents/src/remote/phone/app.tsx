// FriedLiver Remote's phone app, served by the Mac. Untrusted text (agent
// replies, commands, file names) is only ever rendered as text or as elements
// from the Markdown parser, never as HTML. The device token lives in this
// origin's localStorage and goes only in the Authorization header.
import { render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { parseMarkdown, type Block, type Inline, type ListBlock } from '../../shared/markdown';
import type { AgentKey } from '../../shared/model';
import type { Grant } from '../../shared/permissions';
import type { QuestionField } from '../../shared/questions';
import type { ApprovalLevel } from '../../shared/session';
import type { PhoneChat, PhoneEvent, PhoneFile, PhoneItem, PhoneList, PhoneSummary, RemoteAction } from '../protocol';

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

const AGENT_LETTER: Record<AgentKey, string> = { claude: 'C', codex: 'X', gemini: 'G', demo: 'D' };
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

function Avatar({ agent }: { agent: AgentKey }) {
  return (
    <span class={`avatar avatar--${agent}`} aria-hidden="true">
      {AGENT_LETTER[agent]}
    </span>
  );
}

function Dot({ status }: { status: string }) {
  return <span class={`dot dot--${status}`} aria-hidden="true" />;
}

function Icon({ name }: { name: 'back' | 'plus' | 'stop' | 'send' | 'more' | 'chev' }) {
  const d = {
    back: 'M10 3 5 8l5 5',
    plus: 'M8 3v10M3 8h10',
    stop: 'M4.5 4.5h7v7h-7z',
    send: 'M8 13V3M4 7l4-4 4 4',
    more: 'M3.5 8h.01M8 8h.01M12.5 8h.01',
    chev: 'm6 4 4 4-4 4',
  }[name];
  return (
    <svg class="icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path d={d} fill={name === 'stop' ? 'currentColor' : 'none'} stroke="currentColor" stroke-width={name === 'more' ? 2.4 : 1.4} stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
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

function Diff({ file }: { file: PhoneFile }) {
  return (
    <div class="diff">
      <div class="diff__head">
        <span class="diff__path">{file.path}</span>
        <span class="diff__stat">
          {file.isNew ? <span class="diff__new">new </span> : null}
          <span class="add">+{file.added}</span> <span class="del">−{file.removed}</span>
        </span>
      </div>
      {file.lines.length ? (
        <pre class="diff__body">
          {file.lines.map((l, i) => (
            <span key={i} class={l.op === '+' ? 'add' : l.op === '-' ? 'del' : ''}>
              {l.op}
              {l.text}
              {'\n'}
            </span>
          ))}
          {file.more ? <span class="diff__more">{`… ${file.more} more line${file.more === 1 ? '' : 's'}\n`}</span> : null}
        </pre>
      ) : null}
    </div>
  );
}

function Card({ title, children, done }: { title: string; children?: preact.ComponentChildren; done?: string }) {
  return (
    <section class={`card${done ? ' card--done' : ''}`}>
      <p class="card__title">{title}</p>
      {children}
      {done ? <p class="card__done">{done}</p> : null}
    </section>
  );
}

function Buttons({ children }: { children: preact.ComponentChildren }) {
  return <div class="card__buttons">{children}</div>;
}

function Always({ choices, act, target }: { choices: { grant: Grant; label: string }[]; act: Act; target: { requestId: string } | { commandId: string } }) {
  if (!choices.length) return null;
  return (
    <div class="card__always">
      {choices.map((c, i) => (
        <button key={i} class="link" onClick={() => void act({ type: 'allowAlways', ...target, grant: c.grant })}>
          {c.label}
        </button>
      ))}
      <p class="hint">Always allow asks on your Mac first.</p>
    </div>
  );
}

function QuestionCard({ item, act }: { item: Extract<PhoneItem, { k: 'question' }>; act: Act }) {
  const [values, setValues] = useState<Record<string, string | number | boolean | string[]>>({});
  if (item.state !== 'awaiting') return <Card title={item.message} done={item.summary ?? (item.state === 'declined' ? 'Skipped' : 'Answered')} />;
  const one = item.fields.length === 1 && item.fields[0].type === 'choice' ? item.fields[0] : undefined;
  const set = (k: string, v: string | number | boolean | string[]) => setValues({ ...values, [k]: v });
  const field = (f: QuestionField) => {
    switch (f.type) {
      case 'choice':
      case 'multi': {
        const picked = values[f.key];
        return (
          <div class="choices" role={f.type === 'choice' ? 'radiogroup' : 'group'}>
            {(f.options ?? []).map((o) => {
              const on = f.type === 'choice' ? picked === o.value : Array.isArray(picked) && picked.includes(o.value);
              return (
                <button
                  key={o.value}
                  class={`choice${on ? ' choice--on' : ''}`}
                  aria-pressed={on}
                  onClick={() => {
                    if (one) return void act({ type: 'answerQuestion', requestId: item.id, action: 'accept', values: { [f.key]: o.value } });
                    if (f.type === 'choice') return set(f.key, o.value);
                    const list = Array.isArray(picked) ? picked : [];
                    set(f.key, on ? list.filter((x) => x !== o.value) : [...list, o.value]);
                  }}
                >
                  <span class="choice__title">{o.title}</span>
                  {o.description ? <span class="choice__desc">{o.description}</span> : null}
                </button>
              );
            })}
          </div>
        );
      }
      case 'boolean':
        return (
          <label class="check">
            <input type="checkbox" checked={values[f.key] === true} onChange={(e) => set(f.key, (e.target as HTMLInputElement).checked)} /> {f.title}
          </label>
        );
      default:
        return (
          <input
            class="input"
            inputMode={f.type === 'number' ? 'decimal' : 'text'}
            value={String(values[f.key] ?? '')}
            onInput={(e) => {
              const v = (e.target as HTMLInputElement).value;
              set(f.key, f.type === 'number' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : v);
            }}
          />
        );
    }
  };
  return (
    <Card title={item.message}>
      {item.fields.map((f) => (
        <div class="field" key={f.key}>
          {item.fields.length > 1 || f.type !== 'choice' ? <p class="field__title">{f.title}</p> : null}
          {f.description ? <p class="hint">{f.description}</p> : null}
          {field(f)}
        </div>
      ))}
      <Buttons>
        {one ? null : (
          <button class="btn btn--primary" onClick={() => void act({ type: 'answerQuestion', requestId: item.id, action: 'accept', values })}>
            Submit
          </button>
        )}
        <button class="btn" onClick={() => void act({ type: 'answerQuestion', requestId: item.id, action: 'decline' })}>
          Skip
        </button>
      </Buttons>
    </Card>
  );
}

function ItemView({ item, act }: { item: PhoneItem; act: Act }) {
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
    case 'permission': {
      if (item.answer) return <Card title={item.title} done={item.auto ? `${item.answer} · ${item.auto}` : item.answer} />;
      const primary = item.options.find((o) => o.kind === 'allow_once' && !o.escalates);
      return (
        <Card title={item.title}>
          {item.command ? (
            <>
              <pre class="code">{item.command.line}</pre>
              {item.command.cwd ? <p class="hint">in {item.command.cwd}</p> : null}
            </>
          ) : null}
          {item.url ? <p class="hint">{item.url}</p> : null}
          {item.files?.map((f) => <Diff key={f.path} file={f} />)}
          {item.plan ? (
            <div class="card__plan">
              <Markdown text={item.plan} />
            </div>
          ) : null}
          {item.text && !item.plan ? <p class="card__text">{item.text}</p> : null}
          <div class="options">
            {item.options.map((o, i) => (
              <button
                key={o.id}
                class={`option${o === primary ? ' option--primary' : ''}${o.escalates ? ' option--escalates' : ''}`}
                onClick={() => void act({ type: 'permission', requestId: item.id, optionId: o.id })}
              >
                <span class="option__n">{i + 1}</span>
                <span>{o.name}</span>
                {o.escalates && o.kind.startsWith('allow') ? <span class="option__note">Confirm on Mac</span> : null}
              </button>
            ))}
          </div>
          <Always choices={item.always} act={act} target={{ requestId: item.id }} />
        </Card>
      );
    }
    case 'command': {
      if (item.state !== 'awaiting') {
        return (
          <div class={`step step--${item.state === 'denied' || (item.exitCode ?? 0) !== 0 ? 'failed' : item.state === 'running' ? 'working' : 'done'}`}>
            <span class="step__title">
              <span class="tag">Run</span>
              <code>{item.line.split('\n')[0]}</code>
            </span>
            {item.output ? <pre class="step__out">{item.output}</pre> : null}
          </div>
        );
      }
      return (
        <Card title={item.outside ? 'Run a command outside the workspace' : 'Run a command'}>
          <pre class="code">{item.line}</pre>
          <p class="hint">in {item.cwd}</p>
          <Buttons>
            <button class="btn btn--primary" onClick={() => void act({ type: 'command', commandId: item.id, approve: true })}>
              Run
            </button>
            <button class="btn" onClick={() => void act({ type: 'command', commandId: item.id, approve: false })}>
              Deny
            </button>
          </Buttons>
          {item.outside ? null : <Always choices={[{ grant: { kind: 'exact', command: item.line }, label: 'Always allow this exact command' }]} act={act} target={{ commandId: item.id }} />}
        </Card>
      );
    }
    case 'question':
      return <QuestionCard item={item} act={act} />;
    case 'review':
      if (item.state !== 'pending') return <Card title={`Edit ${item.file.path}`} done={`${item.state === 'accepted' ? 'Accepted' : 'Rejected'}${item.auto ? ` · ${item.auto}` : ''}`} />;
      return (
        <Card title={`Review an edit to ${item.file.path}`}>
          <Diff file={item.file} />
          <Buttons>
            <button class="btn btn--primary" onClick={() => void act({ type: 'review', reviewId: item.id, action: 'accept' })}>
              Accept
            </button>
            <button class="btn" onClick={() => void act({ type: 'review', reviewId: item.id, action: 'reject' })}>
              Reject
            </button>
          </Buttons>
        </Card>
      );
    case 'bridge':
      if (item.state !== 'awaiting') return <Card title={item.title} done={item.state === 'allowed' ? 'Allowed' : 'Denied'} />;
      return (
        <Card title={item.title}>
          {item.text ? <p class="card__text">{item.text}</p> : null}
          <Buttons>
            <button class="btn btn--primary" onClick={() => void act({ type: 'bridge', requestId: item.id, answer: 'allow' })}>
              Allow
            </button>
            <button class="btn" onClick={() => void act({ type: 'bridge', requestId: item.id, answer: 'allowChat' })}>
              For this chat
            </button>
            <button class="btn" onClick={() => void act({ type: 'bridge', requestId: item.id, answer: 'deny' })}>
              Deny
            </button>
          </Buttons>
          {item.always ? (
            <div class="card__always">
              <button class="link" onClick={() => void act({ type: 'bridge', requestId: item.id, answer: 'allowAlways' })}>
                Always allow {item.always}
              </button>
              <p class="hint">Always allow asks on your Mac first.</p>
            </div>
          ) : null}
        </Card>
      );
    case 'notice':
      return <p class={`notice${item.tone === 'error' ? ' notice--error' : ''}`}>{item.text}</p>;
    case 'changes':
      return <p class="notice">{`${item.files} file${item.files === 1 ? '' : 's'} changed${item.undone ? ' · undone' : ''}`}</p>;
    case 'link':
      return (
        <div class="msg msg--link">
          <p class="hint">{item.label}</p>
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
        <button class="icon-btn" aria-label="Settings" onClick={settings}>
          <Icon name="more" />
        </button>
        <button class="icon-btn icon-btn--accent" aria-label="New chat" onClick={newChat}>
          <Icon name="plus" />
        </button>
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
  const end = useRef<HTMLDivElement>(null);
  const count = chat?.items.length ?? 0;
  useEffect(() => end.current?.scrollIntoView({ block: 'end' }), [count, chat?.id]);
  if (!chat) {
    return (
      <div class="screen">
        <header class="bar">
          <button class="icon-btn" aria-label="Back" onClick={back}>
            <Icon name="back" />
          </button>
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
  return (
    <div class="screen screen--chat">
      <header class="bar bar--chat">
        <button class="icon-btn" aria-label="Back" onClick={back}>
          <Icon name="back" />
        </button>
        <div class="bar__chat">
          <p class="bar__chat-title">{chat.title}</p>
          <p class="bar__chat-meta">
            <Dot status={chat.status} />
            {chat.label} · {chat.folder}
          </p>
        </div>
      </header>
      <div class="levels" role="radiogroup" aria-label="Approvals">
        {LEVELS.map((l) => (
          <button key={l.level} role="radio" aria-checked={chat.approval === l.level} class={`level${chat.approval === l.level ? ' level--on' : ''}${l.level === 'full' ? ' level--auto' : ''}`} onClick={() => chat.approval !== l.level && void act({ type: 'approval', chatId: chat.id, level: l.level })}>
            {l.name}
          </button>
        ))}
      </div>
      {chat.subagentList.length ? (
        <div class="subs">
          <button class="subs__head" aria-expanded={subsOpen} onClick={() => setSubsOpen(!subsOpen)}>
            <span>
              {chat.subagentList.length} subagent{chat.subagentList.length === 1 ? '' : 's'}
              {live.length ? ` · ${live.length} running` : ''}
            </span>
            <span class={`chev${subsOpen ? ' chev--open' : ''}`}>
              <Icon name="chev" />
            </span>
          </button>
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
        {chat.items.map((item, i) => (
          <ItemView key={`${chat.id}-${i}-${item.k}`} item={item} act={act} />
        ))}
        {chat.busy ? <p class="working">Working…</p> : null}
        <div ref={end} />
      </main>
      <footer class="composer">
        <textarea
          class="composer__input"
          rows={1}
          placeholder={chat.busy ? 'Queue a message' : `Message ${chat.label}`}
          value={text}
          onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
          aria-label="Message"
        />
        {chat.busy ? (
          <button class="send send--stop" aria-label="Stop" onClick={() => void act({ type: 'stop', chatId: chat.id })}>
            <Icon name="stop" />
          </button>
        ) : null}
        <button class="send" aria-label="Send" disabled={!text.trim()} onClick={() => void send()}>
          <Icon name="send" />
        </button>
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
          <button class="link" onClick={() => close()}>
            Cancel
          </button>
        </header>
        <p class="field__title">Agent</p>
        <div class="pills">
          {list.agents.map((a) => (
            <button key={a.key} class={`pill${agent === a.key ? ' pill--on' : ''}`} aria-pressed={agent === a.key} onClick={() => setAgent(a.key)}>
              <Avatar agent={a.key} />
              {a.name}
            </button>
          ))}
        </div>
        <p class="field__title">Folder</p>
        {list.folders.length ? (
          <select class="input" value={folder} onChange={(e) => setFolder((e.target as HTMLSelectElement).value)}>
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
        <textarea class="input input--area" rows={4} value={text} placeholder="What should it do?" onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} />
        <button
          class="btn btn--primary btn--wide"
          disabled={!agent || !folder}
          onClick={async () => {
            const r = await act({ type: 'newChat', agent: agent!, folder, text });
            if (r) close(r.chatId);
          }}
        >
          Start chat
        </button>
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
          <button class="link" onClick={close}>
            Done
          </button>
        </header>
        <p class="field__title">Paired as</p>
        <p>{store.get('name') ?? 'Phone'}</p>
        {fp ? (
          <>
            <p class="field__title">Mac’s certificate (SHA-256)</p>
            <p class="fp">{fp}</p>
          </>
        ) : null}
        <button class="btn btn--danger btn--wide" onClick={forget}>
          Forget this phone
        </button>
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
const groupedFp = (fp: string) => (fp.match(/([0-9A-F]{2}:?){1,4}/g) ?? []).map((g) => g.replace(/:$/, '')).join('  ');

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
            <p class="hint">The same as on your Mac’s pairing panel. If your browser warned about the certificate, it should show this fingerprint too.</p>
          </>
        ) : null}
        <p class="field__title">Name this phone</p>
        <input class="input" value={name} maxLength={40} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        {error ? <p class="notice notice--error">{error}</p> : null}
        <button
          class="btn btn--primary btn--wide"
          disabled={busy}
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
        </button>
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

render(<App />, document.getElementById('root')!);
