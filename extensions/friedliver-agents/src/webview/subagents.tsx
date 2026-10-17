// Claude's subagents (its Task/Agent tool) inside the chat that launched them:
// a compact card where each was spawned, which opens in place to its steps and
// answer, and a "Running · N agents" strip above the composer while any work.
import { useState } from 'preact/hooks';
import type { ChatView } from '../shared/model';
import { shortDuration, subagentAnswer, subagents, type Subagent, type ToolItem } from '../shared/view';
import { Dot, Markdown, scrollBehavior, send, useNow } from './common';
import { Steps } from './steps';

const DOT = { working: 'working', done: 'done', failed: 'error' } as const;
const NO_WAIT = new Set<string>();

const elapsed = (s: Subagent, now: number) => (s.ms !== undefined ? s.ms : s.startedAt !== undefined ? Math.max(0, now - s.startedAt) : undefined);

/** Ticks once a second while the subagent works, so its time counts up. */
function Elapsed({ sub }: { sub: Subagent }) {
  const now = useNow(sub.state === 'working' ? 1000 : 3_600_000);
  const ms = elapsed(sub, now);
  return ms === undefined ? null : <span class="sa-time">{shortDuration(ms)}</span>;
}

export function SubagentCard({ chat, item, steps }: { chat: ChatView; item: ToolItem; steps: ToolItem[] }) {
  const [open, setOpen] = useState(false);
  const sub = subagents(chat).find((s) => s.id === item.id);
  if (!sub) return null;
  const answer = subagentAnswer(item);
  const body = `sa-body-${item.id}`;
  return (
    <section class="sa-card" id={`item-${item.id}`} data-state={DOT[sub.state]} data-open={open ? '' : undefined} aria-label={`Subagent: ${sub.title}`}>
      <button type="button" class="sa-head" aria-expanded={open} aria-controls={open ? body : undefined} onClick={() => setOpen(!open)}>
        <Dot state={DOT[sub.state]} still={!chat.busy} />
        <b class="sa-verb">Task</b>
        <span class="sa-title" title={sub.title}>
          {sub.title}
        </span>
        <Elapsed sub={sub} />
      </button>
      {!open && <div class="sa-last">{sub.state === 'failed' ? 'Stopped with a problem' : sub.last ?? (sub.state === 'working' ? 'Starting…' : answer ? 'Answered' : 'Done')}</div>}
      {open && (
        <div class="sa-body" id={body}>
          {steps.length > 0 ? (
            <Steps tools={steps} waiting={NO_WAIT} waitingKey="" busy={chat.busy} chatId={chat.id} cwd={chat.cwd} />
          ) : (
            <p class="sa-empty">No steps reported yet.</p>
          )}
          {answer && (
            <div class="sa-answer">
              <div class="sa-label">Answer</div>
              <Markdown text={answer} chatId={chat.id} cwd={chat.cwd} />
            </div>
          )}
          <button type="button" class="link sa-manager" onClick={() => send({ type: 'openTasks' })}>
            Open in Agent Manager
          </button>
        </div>
      )}
    </section>
  );
}

/** Above the composer while any subagent of this chat runs; an entry scrolls to its card. */
export function RunningAgents({ chat }: { chat: ChatView }) {
  const running = subagents(chat).filter((s) => s.state === 'working');
  if (!running.length) return null;
  const go = (id: string) => {
    const el = document.getElementById(`item-${id}`);
    el?.scrollIntoView({ block: 'center', behavior: scrollBehavior() });
    el?.querySelector<HTMLButtonElement>('.sa-head')?.focus({ preventScroll: true });
  };
  return (
    <nav class="sa-strip" aria-label="Running subagents">
      {running.length} agent{running.length === 1 ? '' : 's'} running
      {running.map((s) => (
        <span key={s.id}>
          {' · '}
          <button type="button" class="sa-name" title={s.title} onClick={() => go(s.id)}>
            {s.title}
          </button>
        </span>
      ))}
    </nav>
  );
}
