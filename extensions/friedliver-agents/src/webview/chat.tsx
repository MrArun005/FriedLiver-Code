import { render } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Attachment } from '../shared/messages';
import {
  AGENT_FACES,
  AGENT_KEYS,
  chatStatus,
  formatDuration,
  shortCommand,
  type AppState,
  type ChatView,
  type CommandItem,
  type Item,
  type ReviewItem,
} from '../shared/model';
import { Dot, Glyph, Icon, Markdown, basename, send, useHost } from './common';

const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp|bmp|svg\+xml)$/;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function App() {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [reveal, setReveal] = useState<{ id: string; n: number } | null>(null);
  const { state, selected, setSelected } = useHost((m) => {
    if (m.type === 'attached') setAttachments((list) => [...list, ...m.images].slice(0, 10));
    if (m.type === 'reveal') setReveal((r) => ({ id: m.id, n: (r?.n ?? 0) + 1 }));
  });
  const chat = state.chats.find((c) => c.id === selected) ?? state.chats.at(-1);

  const select = (chatId: string) => {
    setSelected(chatId);
    send({ type: 'select', chatId });
  };

  return (
    <div class="chat-app">
      <Tabs chats={state.chats} active={chat?.id} onSelect={select} />
      {chat ? (
        <>
          {chat.branch && (
            <div class="chat-meta" title={chat.cwd}>
              Worktree <span class="chip">{chat.branch}</span>
              {chat.merged && <span class="hint"> · merged</span>}
            </div>
          )}
          <Transcript chat={chat} state={state} reveal={reveal} />
          <Composer chat={chat} attachments={attachments} setAttachments={setAttachments} />
        </>
      ) : (
        <Empty />
      )}
    </div>
  );
}

function Tabs({ chats, active, onSelect }: { chats: ChatView[]; active?: string; onSelect(id: string): void }) {
  const [menu, setMenu] = useState(false);
  return (
    <div class="tabbar">
      <div class="tabs" role="tablist" aria-label="Chats">
        {chats.map((c) => (
          <button key={c.id} role="tab" class="tab" aria-selected={c.id === active} title={`${c.label}: ${c.title}`} onClick={() => onSelect(c.id)}>
            <Glyph agent={c.agent} size="sm" />
            <span class="tab-title">{c.title}</span>
            <Dot state={chatStatus(c)} />
          </button>
        ))}
      </div>
      <div class="tabbar-end">
        <button class="ghost icon-btn" aria-label="New chat" title="New chat" aria-expanded={menu} onClick={() => setMenu(!menu)}>
          <Icon name="plus" />
        </button>
        <button class="ghost icon-btn" aria-label="Agent Manager (tasks)" title="Agent Manager (tasks)" onClick={() => send({ type: 'openTasks' })}>
          <Icon name="tasks" />
        </button>
        {menu && (
          <div class="menu" role="menu" onKeyDown={(e) => e.key === 'Escape' && setMenu(false)}>
            {AGENT_KEYS.map((agent) => (
              <button
                key={agent}
                role="menuitem"
                onClick={() => {
                  setMenu(false);
                  send({ type: 'newChat', agent });
                }}
              >
                <Glyph agent={agent} size="sm" /> {AGENT_FACES[agent].name}
                {agent === 'demo' && <span class="hint"> offline</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Empty() {
  return (
    <div class="empty">
      <p>Start a chat with an agent.</p>
      <div class="pick">
        {AGENT_KEYS.map((agent) => (
          <button key={agent} class="pick-agent" onClick={() => send({ type: 'newChat', agent })}>
            <Glyph agent={agent} size="lg" />
            <span>{AGENT_FACES[agent].name}</span>
          </button>
        ))}
      </div>
      <p class="hint">
        No sign-in yet? Pick <strong>Demo</strong> and type <code>tour</code> or <code>project</code>.
      </p>
    </div>
  );
}

type Group = { kind: 'steps'; items: Extract<Item, { kind: 'tool' }>[]; at: number } | { kind: 'one'; item: Item; at: number };

/** Consecutive tool calls read as one timeline of steps. */
function group(items: Item[]): Group[] {
  const out: Group[] = [];
  items.forEach((item, at) => {
    const last = out.at(-1);
    if (item.kind === 'tool' && last?.kind === 'steps') last.items.push(item);
    else if (item.kind === 'tool') out.push({ kind: 'steps', items: [item], at });
    else out.push({ kind: 'one', item, at });
  });
  return out;
}

function Transcript({ chat, state, reveal }: { chat: ChatView; state: AppState; reveal: { id: string; n: number } | null }) {
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    if (stick.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  });
  useEffect(() => {
    stick.current = true;
  }, [chat.id]);
  useEffect(() => {
    if (!reveal) return;
    const el = document.getElementById(`item-${reveal.id}`);
    el?.scrollIntoView({ block: 'center' });
    el?.querySelector<HTMLButtonElement>('button')?.focus();
  }, [reveal]);
  const lastChanges = chat.items.map((i) => i.kind).lastIndexOf('changes');
  const waiting = new Set(chat.items.flatMap((i) => (i.kind === 'permission' && !i.answer && i.toolCallId ? [i.toolCallId] : [])));

  return (
    <div
      class="transcript"
      ref={box}
      aria-live="polite"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {group(chat.items).map((g) =>
        g.kind === 'steps' ? (
          <Steps key={g.at} tools={g.items} waiting={waiting} />
        ) : (
          <ItemView key={g.at} item={g.item} chat={chat} state={state} canUndo={g.at === lastChanges && !chat.busy} />
        ),
      )}
      {chat.busy && !chat.items.some(isWaiting) && (
        <div class="working">
          <Dot state="working" /> {chat.label} is working…
        </div>
      )}
    </div>
  );
}

const isWaiting = (i: Item) =>
  (i.kind === 'permission' && !i.answer) || (i.kind === 'review' && i.state === 'pending') || (i.kind === 'command' && i.state === 'awaiting');

const TOOL_STATE: Record<string, string> = { completed: 'done', in_progress: 'working', failed: 'error', pending: 'next' };
const PLAN_STATE: Record<string, string> = { completed: 'done', in_progress: 'working', pending: 'next' };

function Steps({ tools, waiting }: { tools: Extract<Item, { kind: 'tool' }>[]; waiting: Set<string> }) {
  return (
    <ol class="steps" aria-label="Steps">
      {tools.map((t) => {
        const state = waiting.has(t.id) ? 'needs-you' : (TOOL_STATE[t.status ?? 'pending'] ?? 'next');
        return (
          <li key={t.id} data-state={state}>
            <Dot state={state} />
            <span class="step-title">{t.title}</span>
            {t.toolKind && <span class="tag">{t.toolKind}</span>}
            {t.locations.slice(0, 3).map((l) => (
              <button key={l} class="chip link" title={l} onClick={() => send({ type: 'openFile', path: l })}>
                {basename(l)}
              </button>
            ))}
          </li>
        );
      })}
    </ol>
  );
}

function ItemView({ item, chat, state, canUndo }: { item: Item; chat: ChatView; state: AppState; canUndo: boolean }) {
  switch (item.kind) {
    case 'user':
      return (
        <div class="bubble">
          {item.text && <div class="bubble-text">{item.text}</div>}
          {item.images.length > 0 && (
            <div class="thumbs">
              {item.images.map((id) => {
                const img = state.images.find((i) => i.id === id);
                return img ? <img key={id} src={img.src} alt={img.title} /> : null;
              })}
            </div>
          )}
        </div>
      );
    case 'agent':
      return (
        <div class="prose">
          <Markdown text={item.text} />
        </div>
      );
    case 'thought':
      return (
        <details class="thought">
          <summary>Thinking</summary>
          <div class="thought-text">{item.text}</div>
        </details>
      );
    case 'tool':
      return null; // Rendered in Steps.
    case 'plan': {
      const doneCount = item.entries.filter((e) => e.status === 'completed').length;
      const current = item.entries.findIndex((e) => e.status !== 'completed');
      return (
        <section class="card plan" aria-label="Plan">
          <div class="card-head">
            <span>Plan</span>
            <span class="hint">{current < 0 ? `All ${item.entries.length} steps done` : `Step ${current + 1} of ${item.entries.length}`}</span>
          </div>
          <ol class="steps">
            {item.entries.map((e, i) => {
              const s = PLAN_STATE[e.status] ?? 'next';
              return (
                <li key={i} data-state={s}>
                  <Dot state={s} />
                  <span class="step-title">{e.content}</span>
                </li>
              );
            })}
          </ol>
          <div class="progress" role="progressbar" aria-valuemin={0} aria-valuemax={item.entries.length} aria-valuenow={doneCount}>
            <span style={{ width: `${(doneCount / Math.max(1, item.entries.length)) * 100}%` }} />
          </div>
        </section>
      );
    }
    case 'permission':
      if (item.answer) {
        return (
          <div class="answered">
            <Icon name="check" /> {item.title} <span class="hint">· {item.answer}</span>
          </div>
        );
      }
      return (
        <section class="ask" id={`item-${item.requestId}`} aria-label="The agent asks">
          <div class="ask-head">
            <Glyph agent={chat.agent} size="sm" /> {chat.label} asks
          </div>
          <div class="ask-body">{item.title}</div>
          <div class="actions">
            {item.options.map((o, i) => (
              <button
                key={o.optionId}
                class={o.kind.startsWith('allow') && i === item.options.findIndex((x) => x.kind.startsWith('allow')) ? 'decide' : ''}
                onClick={() => send({ type: 'permission', requestId: item.requestId, optionId: o.optionId })}
              >
                {o.name}
              </button>
            ))}
          </div>
        </section>
      );
    case 'review':
      return <Review item={item} chat={chat} />;
    case 'command':
      return <Command item={item} chat={chat} />;
    case 'notice':
      return (
        <div class="notice" data-tone={item.tone} role={item.tone === 'error' ? 'alert' : undefined}>
          <div>{item.text}</div>
          {item.detail && <code class="detail">{item.detail}</code>}
          {item.actions && (
            <div class="actions">
              {item.actions.map((a) => (
                <button key={a.label} onClick={() => send({ type: 'notice', chatId: chat.id, action: a })}>
                  {a.label}
                </button>
              ))}
            </div>
          )}
        </div>
      );
    case 'changes':
      return (
        <section class="card changes" data-undone={item.undone ? 'true' : undefined}>
          <div class="card-head">
            <span>{item.undone ? 'Turn undone' : `Changed ${item.files.length} file${item.files.length === 1 ? '' : 's'}`}</span>
          </div>
          <div class="files">
            {item.files.map((f) => (
              <button key={f} class="chip link" title={f} onClick={() => send({ type: 'openFile', path: f })}>
                <Glyph agent={chat.agent} size="sm" /> {basename(f)}
              </button>
            ))}
          </div>
          {!item.undone && canUndo && (
            <div class="actions">
              <button onClick={() => send({ type: 'undo', chatId: chat.id, turnId: item.turnId })}>
                <Icon name="undo" /> Undo this turn
              </button>
            </div>
          )}
        </section>
      );
  }
}

function Stats({ item }: { item: ReviewItem }) {
  return (
    <span class="stats">
      <span class="plus">+{item.added}</span> <span class="minus">−{item.removed}</span>
    </span>
  );
}

function Review({ item, chat }: { item: ReviewItem; chat: ChatView }) {
  const name = basename(item.path);
  if (item.state !== 'pending') {
    return (
      <div class="answered">
        <Icon name={item.state === 'accepted' ? 'check' : 'close'} /> {item.state === 'accepted' ? 'Accepted' : 'Rejected'} edit to{' '}
        <button class="link" title={item.path} onClick={() => send({ type: 'openFile', path: item.path })}>
          {name}
        </button>{' '}
        <Stats item={item} />
      </div>
    );
  }
  return (
    <section class="ask" id={`item-${item.reviewId}`} aria-label="Edit to review">
      <div class="ask-head">
        <Glyph agent={chat.agent} size="sm" /> {item.isNew ? 'New file to review' : 'Edit to review'}
      </div>
      <button class="file-row" title={`${item.path}: open the diff`} onClick={() => send({ type: 'review', reviewId: item.reviewId, action: 'open' })}>
        <Icon name="file" /> <span class="file-name">{name}</span> <Stats item={item} />
      </button>
      <div class="actions">
        <button class="decide" onClick={() => send({ type: 'review', reviewId: item.reviewId, action: 'accept' })}>
          <Icon name="check" /> Accept
        </button>
        <button onClick={() => send({ type: 'review', reviewId: item.reviewId, action: 'reject' })}>Reject</button>
        <button class="ghost" onClick={() => send({ type: 'review', reviewId: item.reviewId, action: 'open' })}>
          Open diff
        </button>
      </div>
    </section>
  );
}

const COMMAND_STATE: Record<CommandItem['state'], string> = { awaiting: 'needs-you', running: 'working', denied: 'idle', exited: 'done' };

function Command({ item, chat }: { item: CommandItem; chat: ChatView }) {
  if (item.state === 'awaiting') {
    return (
      <section class="ask" id={`item-${item.commandId}`} aria-label="Command to approve">
        <div class="ask-head">
          <Glyph agent={chat.agent} size="sm" /> {chat.label} wants to run a command
        </div>
        <pre class="cmdline">
          <span class="prompt">$ </span>
          {item.commandLine}
        </pre>
        <div class="hint" title={item.cwd}>
          in {item.cwd}
        </div>
        {item.outside && <div class="warn">This folder is outside the workspace.</div>}
        <div class="actions">
          <button class="decide" onClick={() => send({ type: 'command', commandId: item.commandId, approve: true })}>
            <Icon name="play" /> Run
          </button>
          <button onClick={() => send({ type: 'command', commandId: item.commandId, approve: false })}>Deny</button>
        </div>
      </section>
    );
  }
  const failed = item.state === 'exited' && item.exitCode !== 0;
  const meta =
    item.state === 'denied'
      ? 'denied'
      : item.state === 'running'
        ? 'running…'
        : `exit ${item.exitCode ?? '?'}${item.durationMs !== undefined ? ` · ${formatDuration(item.durationMs)}` : ''}`;
  return (
    <section class="command" id={`item-${item.commandId}`}>
      <div class="command-head">
        <Dot state={failed ? 'error' : COMMAND_STATE[item.state]} />
        <Glyph agent={chat.agent} size="sm" />
        <code class="command-line" title={item.commandLine}>
          {shortCommand(item.commandLine, 200)}
        </code>
        <span class="hint">{meta}</span>
      </div>
      {item.output && <pre class="output">{item.output}</pre>}
    </section>
  );
}

function Composer({ chat, attachments, setAttachments }: { chat: ChatView; attachments: Attachment[]; setAttachments(fn: (a: Attachment[]) => Attachment[]): void }) {
  const [text, setText] = useState('');
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => area.current?.focus(), [chat.id]);

  const submit = () => {
    if (chat.busy || (!text.trim() && attachments.length === 0)) return;
    send({ type: 'send', chatId: chat.id, text: text.trim(), images: attachments });
    setText('');
    setAttachments(() => []);
  };

  const addFiles = (files: File[]) => {
    for (const file of files) {
      if (!IMAGE_TYPES.test(file.type) || file.size > MAX_IMAGE_BYTES) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const url = String(reader.result);
        setAttachments((list) => [...list, { name: file.name || 'pasted image', mimeType: file.type, data: url.slice(url.indexOf(',') + 1) }].slice(0, 10));
      };
      reader.readAsDataURL(file);
    }
  };

  return (
    <div
      class="composer"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        const files = Array.from(e.dataTransfer?.files ?? []);
        if (files.length) {
          e.preventDefault();
          addFiles(files);
        }
      }}
    >
      {attachments.length > 0 && (
        <div class="thumbs">
          {attachments.map((a, i) => (
            <button key={i} class="thumb" title={`Remove ${a.name}`} onClick={() => setAttachments((list) => list.filter((_, n) => n !== i))}>
              <img src={`data:${a.mimeType};base64,${a.data}`} alt={a.name} />
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={area}
        value={text}
        rows={3}
        aria-label={`Message ${chat.label}`}
        placeholder={`Message ${chat.label}. Enter sends, Shift+Enter adds a line.`}
        onInput={(e) => setText(e.currentTarget.value)}
        onPaste={(e) => {
          const files = Array.from(e.clipboardData?.items ?? [])
            .filter((i) => i.kind === 'file')
            .map((i) => i.getAsFile())
            .filter((f): f is File => f !== null && f.type.startsWith('image/'));
          if (files.length) {
            e.preventDefault();
            addFiles(files);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div class="composer-bar">
        <button class="ghost icon-btn" aria-label="Attach images" title="Attach images" onClick={() => send({ type: 'attach' })}>
          <Icon name="attach" />
        </button>
        <span class="hint composer-agent">
          <Glyph agent={chat.agent} size="sm" /> {chat.label}
        </span>
        <span class="spacer" />
        {chat.busy ? (
          <button class="danger" onClick={() => send({ type: 'stop', chatId: chat.id })}>
            <Icon name="stop" /> Stop
          </button>
        ) : (
          <button onClick={submit} disabled={!text.trim() && attachments.length === 0}>
            <Icon name="send" /> Send
          </button>
        )}
      </div>
    </div>
  );
}

render(<App />, document.getElementById('root')!);
