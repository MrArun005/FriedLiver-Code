// A Claude Code subagent from outside FriedLiver, in the Agent Manager's detail sheet: its report when it has one,
// the brief it was given, a live timeline of its steps (the chat's own step rows), and beside them the facts (parent
// session, type, model, start, duration, tokens) and the files it touched. Read-only; the host follows the
// transcript while this is open (watchSubagent) and sends what changed (subagentDetail). COMPONENTS.md §2.31.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ClaudeSession } from '../shared/messages';
import { mergeEntries, parentLine, type SubagentDetail, type SubagentEntry, type SubagentNote, type SubagentTool } from '../shared/subagentDetail';
import { shortDuration } from '../shared/view';
import { CopyButton, Markdown, basename, send, useNow } from './common';
import { Steps } from './steps';
import { Button, Pill, Row } from './ui';

const NO_WAIT = new Set<string>();
/** A brief longer than this many lines or characters starts folded. */
const BRIEF_LINES = 6;
const BRIEF_CHARS = 600;

const count = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const exact = new Intl.NumberFormat('en');

function when(ms: number, now: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return new Date(now).toDateString() === d.toDateString() ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

/** The detail as the view keeps it: the host's latest totals, with its window of entries merged in. */
function useDetail(sessionId: string, id: string): SubagentDetail | undefined {
  const [d, setD] = useState<SubagentDetail>();
  useEffect(() => {
    const on = (e: MessageEvent) => {
      const m = e.data as { type?: string; detail?: SubagentDetail };
      if (m?.type !== 'subagentDetail' || m.detail?.sessionId !== sessionId || m.detail.id !== id) return;
      const next = m.detail;
      setD((prev) => ({ ...next, entries: mergeEntries(prev?.entries ?? [], next) }));
    };
    window.addEventListener('message', on);
    send({ type: 'watchSubagent', sessionId, id });
    return () => {
      window.removeEventListener('message', on);
      send({ type: 'watchSubagent' });
    };
  }, [sessionId, id]);
  return d;
}

/** Runs of steps (drawn by the chat's Steps) between what it said. */
type Part = { kind: 'steps'; key: string; tools: SubagentTool[] } | SubagentNote;
function parts(entries: SubagentEntry[]): Part[] {
  const out: Part[] = [];
  for (const e of entries) {
    if (e.kind === 'note') out.push(e);
    else {
      const last = out.at(-1);
      if (last?.kind === 'steps') last.tools.push(e);
      else out.push({ kind: 'steps', key: e.id, tools: [e] });
    }
  }
  return out;
}

const NOTE_VERB = (n: SubagentNote) => (n.caller ? 'Caller' : n.thinking ? 'Thought' : 'Said');

function Timeline({ entries, working, cwd }: { entries: SubagentEntry[]; working: boolean; cwd: string }) {
  const box = useRef<HTMLDivElement>(null);
  // Follows the newest step while you're at the end; scrolling up holds it where you are.
  const stick = useRef(true);
  const list = useMemo(() => parts(entries), [entries]);
  useLayoutEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [entries]);
  return (
    <div
      class="sd-timeline"
      ref={box}
      tabIndex={0}
      aria-label="Steps"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
    >
      {list.map((p) =>
        p.kind === 'steps' ? (
          <Steps key={p.key} tools={p.tools} waiting={NO_WAIT} waitingKey="" busy={working} chatId="" cwd={cwd} noFold />
        ) : (
          <div key={p.id} class="tl sd-note" data-state="done" data-kind={p.caller ? 'caller' : p.thinking ? 'thought' : 'said'} title={p.text}>
            <div class="step-row">
              <span class="step-verb">{NOTE_VERB(p)}</span>
              <span class="sd-note-text">{p.text}</span>
            </div>
          </div>
        ),
      )}
      {!list.length && <p class="sd-empty">{working ? 'Starting…' : 'No steps in its transcript.'}</p>}
    </div>
  );
}

function Head({ title, meta, copy, copyLabel }: { title: string; meta?: string; copy?: string; copyLabel?: string }) {
  return (
    <div class="sd-head">
      <h4 class="sd-h">{title}</h4>
      {meta && <span class="sd-meta">{meta}</span>}
      <span class="spacer" />
      {copy && <CopyButton text={copy} label={copyLabel ?? `Copy ${title.toLowerCase()}`} />}
    </div>
  );
}

function Brief({ text, cwd, folded: startFolded }: { text: string; cwd: string; folded: boolean }) {
  const long = text.split('\n').length > BRIEF_LINES || text.length > BRIEF_CHARS;
  const [open, setOpen] = useState(!startFolded || !long);
  return (
    <section class="sd-sec" aria-label="Brief">
      <Head title="Brief" copy={text} />
      <div class="sd-brief" data-open={open ? '' : undefined}>
        {text ? <Markdown text={text} cwd={cwd} full /> : <p class="sd-empty">Its transcript doesn't hold the brief.</p>}
      </div>
      {long && (
        <Button variant="link" size="sm" class="sd-more" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Show less' : 'Show the whole brief'}
        </Button>
      )}
    </section>
  );
}

export function OutsideSubagent({ session, id, state, now }: { session: ClaudeSession; id: string; state: 'working' | 'done' | 'failed' | 'quiet'; now: number }) {
  const d = useDetail(session.id, id);
  const working = state === 'working';
  const tick = useNow(working ? 1000 : 3_600_000);
  const sub = session.subagents.find((s) => s.id === id);
  const startedAt = d?.startedAt ?? sub?.startedAt;
  const lastAt = d?.lastAt ?? sub?.lastActivity;
  const ran = startedAt === undefined ? undefined : Math.max(0, (working ? Math.max(tick, now) : (lastAt ?? now)) - startedAt);
  const parent = parentLine({ session })!;
  const u = d?.usage;
  const report = working ? undefined : d?.report;
  const changed = d?.files.filter((f) => f.edits > 0).length ?? 0;
  return (
    <div class="sd" data-state={state}>
      <div class="sd-main">
        {report && (
          <section class="sd-sec sd-report" aria-label="Report">
            <Head title="Report" copy={report} />
            <Markdown text={report} cwd={session.cwd} full />
          </section>
        )}
        {!d ? <p class="sd-empty">Reading its transcript…</p> : <Brief key={id} text={d.prompt} cwd={session.cwd} folded={!!report || d.prompt.length > BRIEF_CHARS} />}
        {d && (
          <section class="sd-sec sd-steps" aria-label="Timeline">
            <Head title="Steps" meta={d.total > d.entries.length ? `the last ${d.entries.length} of ${d.total}` : `${d.total}`} />
            <Timeline entries={d.entries} working={working} cwd={session.cwd} />
          </section>
        )}
      </div>
      <aside class="sd-side" aria-label="Details">
        <dl class="sd-facts">
          <div class="sd-fact">
          <dt>{parent.label}</dt>
          <dd class="sd-parent">
            <Button
              variant="link"
              truncate
              title={`${parent.title}\nContinue it in a FriedLiver chat${working ? '. It is still running elsewhere: stop it there first, or the two will interleave.' : ''}`}
              onClick={() => send({ type: 'openClaudeSession', sessionId: session.id })}
            >
              {parent.title}
            </Button>
            <div class="sd-meta">Claude Code · outside FriedLiver</div>
          </dd>
          </div>
          {(d?.agentType || d?.model || sub?.agentType || sub?.model) && (
            <div class="sd-fact">
              <dt>Agent</dt>
              <dd class="sd-pills">
                {(d?.agentType ?? sub?.agentType) && <Pill tone="muted">{d?.agentType ?? sub?.agentType}</Pill>}
                {(d?.model ?? sub?.model) && <Pill tone="muted">{d?.model ?? sub?.model}</Pill>}
              </dd>
            </div>
          )}
          {startedAt !== undefined && (
            <div class="sd-fact">
              <dt>Started</dt>
              <dd>
                {when(startedAt, now)}
                {ran !== undefined && (
                  <div class="sd-meta">
                    {working ? 'running for' : 'ran for'} {shortDuration(ran)}
                  </div>
                )}
              </dd>
            </div>
          )}
          {u && (
            <div class="sd-fact">
              <dt>Tokens</dt>
              <dd
                class="sd-tokens"
                title={`Input ${exact.format(u.input)}\nOutput ${exact.format(u.output)}\nCache read ${exact.format(u.cacheRead)}\nCache write ${exact.format(u.cacheWrite)}${d?.partial ? '\nCounted from the end of a very large transcript' : ''}`}
              >
                {count.format(u.input)} in · {count.format(u.output)} out
                <div class="sd-meta">
                  cache {count.format(u.cacheRead)} read · {count.format(u.cacheWrite)} written{d?.partial ? ' (recent part)' : ''}
                </div>
              </dd>
            </div>
          )}
        </dl>
        {d && d.files.length > 0 && (
          <section class="sd-sec sd-files" aria-label="Files">
            <Head title="Files" meta={`${changed} changed · ${d.files.length + d.filesMore - changed} read`} />
            <div class="sd-file-list">
              {d.files.map((f) => (
                <Row
                  key={f.path}
                  icon="file"
                  title={f.path}
                  meta={f.edits ? `edited${f.edits > 1 ? ` ×${f.edits}` : ''}` : 'read'}
                  onPress={() => send({ type: 'openFile', path: f.path })}
                >
                  {basename(f.path)}
                </Row>
              ))}
              {d.filesMore > 0 && <p class="sd-meta">and {d.filesMore} more</p>}
            </div>
          </section>
        )}
      </aside>
    </div>
  );
}
