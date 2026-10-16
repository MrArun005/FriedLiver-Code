import { render } from 'preact';
import { useState } from 'preact/hooks';
import {
  AGENT_FACES,
  AGENT_KEYS,
  age,
  boardColumn,
  chatStatus,
  stateLine,
  type AgentKey,
  type BoardColumn,
  type ChatView,
} from '../shared/model';
import { Dot, Glyph, Icon, send, useHost, useNow } from './common';

const COLUMNS: { id: BoardColumn; title: string; empty: string }[] = [
  { id: 'needs-you', title: 'Needs you', empty: 'Nothing waits for you.' },
  { id: 'working', title: 'Working', empty: 'No agent is working.' },
  { id: 'done', title: 'Done', empty: 'Finished tasks land here.' },
];

/** The Agent Manager: every chat as a task card, by where it stands. */
function Board() {
  const { state } = useHost();
  const now = useNow(30_000);
  const byColumn = (col: BoardColumn) => [...state.chats].reverse().filter((c) => boardColumn(chatStatus(c)) === col);
  return (
    <div class="board-app">
      <header class="board-head">
        <h1>Agent Manager</h1>
        <span class="hint">{state.chats.length ? `${state.chats.length} task${state.chats.length === 1 ? '' : 's'}` : ''}</span>
      </header>
      <NewTask />
      <div class="columns">
        {COLUMNS.map((col) => {
          const cards = byColumn(col.id);
          return (
            <section key={col.id} class="column" data-column={col.id} aria-label={col.title}>
              <h2>
                {col.title} <span class={`count ${col.id === 'needs-you' && cards.length ? 'loud' : ''}`}>{cards.length}</span>
              </h2>
              {cards.length === 0 && <div class="hint column-empty">{col.empty}</div>}
              {cards.map((c) => (
                <Card key={c.id} chat={c} now={now} />
              ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function NewTask() {
  const [agent, setAgent] = useState<AgentKey>('demo');
  const [prompt, setPrompt] = useState('');
  const [worktree, setWorktree] = useState(false);
  const start = () => {
    if (!prompt.trim()) return;
    send({ type: 'createTask', agent, prompt: prompt.trim(), worktree });
    setPrompt('');
  };
  return (
    <section class="new-task" aria-label="New task">
      <textarea
        value={prompt}
        rows={2}
        placeholder="Describe the task. Try “project” with the Demo agent. Ctrl+Enter starts."
        aria-label="Task description"
        onInput={(e) => setPrompt(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) start();
        }}
      />
      <div class="row">
        <div class="agent-pick" role="radiogroup" aria-label="Agent">
          {AGENT_KEYS.map((a) => (
            <button key={a} role="radio" aria-checked={agent === a} class="agent-option" title={AGENT_FACES[a].name} onClick={() => setAgent(a)}>
              <Glyph agent={a} size="sm" /> {AGENT_FACES[a].name}
            </button>
          ))}
        </div>
        <label class="check" title="Runs in a separate git checkout on its own branch, so it can't clash with other agents">
          <input type="checkbox" checked={worktree} onChange={(e) => setWorktree(e.currentTarget.checked)} /> Own worktree
        </label>
        <span class="spacer" />
        <button disabled={!prompt.trim()} onClick={start}>
          <Icon name="play" /> Start
        </button>
      </div>
    </section>
  );
}

function Card({ chat, now }: { chat: ChatView; now: number }) {
  const status = chatStatus(chat);
  const line = stateLine(chat);
  const d = line.decision;
  const permission = d?.kind === 'permission' ? chat.items.find((i) => i.kind === 'permission' && i.requestId === d.id) : undefined;
  return (
    <article class="task-card" data-status={status}>
      <div class="card-top">
        <Glyph agent={chat.agent} />
        <span class="hint">{chat.label}</span>
        <span class="hint">· {age(chat.createdAt, now)}</span>
        {chat.branch && (
          <span class="chip" title={chat.cwd}>
            {chat.branch}
          </span>
        )}
        {chat.merged && <span class="tag">merged</span>}
        <span class="spacer" />
        <Dot state={status} />
      </div>
      <button class="task-title link" title={chat.title} onClick={() => send({ type: 'openChat', chatId: chat.id })}>
        {chat.title}
      </button>
      <div class="state-line" data-decision={d ? 'true' : undefined}>
        {line.text}
        {line.code && <code class="state-code">{line.code}</code>}
      </div>
      <div class="actions">
        {d?.kind === 'review' && (
          <button class="decide" onClick={() => send({ type: 'review', reviewId: d.id, action: 'open' })}>
            Review edit
          </button>
        )}
        {d?.kind === 'command' && (
          <>
            <button class="decide" onClick={() => send({ type: 'command', commandId: d.id, approve: true })}>
              <Icon name="play" /> Run
            </button>
            <button onClick={() => send({ type: 'command', commandId: d.id, approve: false })}>Deny</button>
          </>
        )}
        {permission?.kind === 'permission' &&
          permission.options.map((o) => (
            <button
              key={o.optionId}
              class={o === permission.options.find((x) => x.kind.startsWith('allow')) ? 'decide' : ''}
              onClick={() => send({ type: 'permission', requestId: permission.requestId, optionId: o.optionId })}
            >
              {o.name}
            </button>
          ))}
        <button class="ghost" onClick={() => send({ type: 'openChat', chatId: chat.id })}>
          Open chat
        </button>
        {chat.busy && (
          <button class="ghost danger" onClick={() => send({ type: 'stop', chatId: chat.id })}>
            <Icon name="stop" /> Stop
          </button>
        )}
        {chat.branch && !chat.busy && !chat.merged && (
          <button class="ghost" onClick={() => send({ type: 'merge', chatId: chat.id })}>
            <Icon name="merge" /> Merge into main
          </button>
        )}
        {chat.branch && !chat.busy && (
          <button class="ghost danger" onClick={() => send({ type: 'removeWorktree', chatId: chat.id })}>
            <Icon name="trash" /> Delete worktree
          </button>
        )}
      </div>
    </article>
  );
}

render(<Board />, document.getElementById('root')!);
