// The /discuss card (COMPONENTS.md §2.30), in the layout friedliver.discuss.layout picks: A's positions
// board, B's stance meter, both (board first), or C's threaded timeline while it runs; once it ends,
// every layout shows the same conclusion (C's), the meter layouts keep the meter under its headline
// and the board layouts keep the board folded. Drawn only with the design system's components.
import { Fragment, type ComponentChildren } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { discussMeta, speakerName, type DiscussionItem } from '../shared/discuss';
import { discussSections, discussView, meterOf, pointPlaceholder, type DiscussSection, type DiscussView, type Outcome, type RoundView, type TurnView } from '../shared/discussView';
import type { AgentKey, ChatView } from '../shared/model';
import { Dot, Markdown, send, useDiscussLayout } from './common';
import { Avatar, Button, Card, Icon, Input, MenuItem, MenuTitle, Pill, Popover, Segmented, SplitButton, cx } from './ui';

type Ctx = { d: DiscussionItem; v: DiscussView; chat: ChatView };

export function DiscussionCard({ item: d, chat }: { item: DiscussionItem; chat: ChatView }) {
  const layout = useDiscussLayout();
  const v = useMemo(() => discussView(d), [d]);
  const running = d.state !== 'done';
  const ctx: Ctx = { d, v, chat };
  // A's round picker, shared by the board while it runs and the folded board after.
  const [picked, pick] = useState<number | undefined>(undefined);
  const shown = Math.max(1, Math.min(picked ?? (running ? d.round : v.rounds.length), v.rounds.length));
  const part = (s: DiscussSection): ComponentChildren => {
    switch (s) {
      case 'bar':
        return <RoundBar ctx={ctx} round={shown} pick={pick} />;
      case 'points':
        return <Points d={d} round={shown} />;
      case 'board':
        return <Board ctx={ctx} round={shown} onQuote={pick} />;
      case 'meter':
        return <Meter v={v} round={running ? d.round : v.rounds.length} compact={!running} />;
      case 'steps':
        return <Steps d={d} />;
      case 'rows':
        return <Rows ctx={ctx} />;
      case 'thread':
        return <Thread ctx={ctx} />;
      case 'outcome':
        return <OutcomeHead o={v.outcome!} />;
      case 'sides':
        return <Sides o={v.outcome!} />;
      case 'conclusion':
        return <Conclusion d={d} o={v.outcome!} />;
      case 'actions':
        return <Actions d={d} />;
      case 'board-folded':
        return (
          <details class="fl-discuss__fold">
            <summary>
              <Icon name="forward" size={12} />
              Board · round {shown}
            </summary>
            <RoundBar ctx={ctx} round={shown} pick={pick} />
            <Board ctx={ctx} round={shown} onQuote={pick} />
          </details>
        );
      case 'history':
        return <History ctx={ctx} />;
    }
  };
  return (
    <Card class="msg-card fl-discuss" label={`Discussion: ${d.question}`} data-layout={layout} data-state={running ? 'running' : 'done'} data-enter={running ? '' : undefined} data-muted={d.continued ? '' : undefined}>
      <Head d={d} v={v} />
      {discussSections(layout, d).map((s) => (
        <Fragment key={s}>{part(s)}</Fragment>
      ))}
      {running && <AddPoint d={d} />}
    </Card>
  );
}

// ---- Shared parts ----

/** Text with `code` spans, as the agents write them. */
function Inline({ text }: { text: string }) {
  const parts = text.split(/`([^`]+)`/);
  return <>{parts.map((p, i) => (i % 2 ? <code key={i}>{p}</code> : p))}</>;
}

const pct = (c: number | undefined) => (c === undefined ? '' : `${Math.round(c * 100)}%`);

function Head({ d, v }: { d: DiscussionItem; v: DiscussView }) {
  const context = [...v.context, ...(v.open ? ['open question'] : [])];
  return (
    <header class="fl-discuss__head">
      <Icon name="discuss" />
      <div class="fl-discuss__q">
        <div class="fl-discuss__title" title={d.question}>
          {v.title}
        </div>
        {context.length > 0 && (
          <div class="fl-discuss__context">
            {context.map((c, i) => (
              <Fragment key={i}>
                {i > 0 && ' · '}
                <Inline text={c} />
              </Fragment>
            ))}
          </div>
        )}
      </div>
      <span class="fl-discuss__meta" aria-live="polite">
        {d.state !== 'done' && d.speaking && <Dot state="working" />}
        {discussMeta(d)}
      </span>
    </header>
  );
}

/** The live foot: the user's point, heard from the next round on, and Stop. Read-only stays as it is. */
function AddPoint({ d }: { d: DiscussionItem }) {
  const [text, setText] = useState('');
  const add = () => {
    if (!text.trim()) return;
    send({ type: 'discussion', id: d.id, act: 'point', text: text.trim() });
    setText('');
  };
  return (
    <div class="fl-discuss__add">
      {d.state === 'running' ? (
        <Input
          size="sm"
          value={text}
          placeholder={pointPlaceholder(d)}
          aria-label={pointPlaceholder(d)}
          onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.isComposing) {
              e.preventDefault();
              add();
            }
          }}
        />
      ) : (
        <span class="fl-discuss__hint">Summing up. Nothing more goes in now.</span>
      )}
      <Button variant="quiet-danger" size="sm" icon="stop" onClick={() => send({ type: 'discussion', id: d.id, act: 'stop' })}>
        Stop
      </Button>
    </div>
  );
}

/** C's quote link: whose words a turn answers. Pressing it shows that turn. */
function Quote({ re, prefix, onPress }: { re: NonNullable<TurnView['re']>; prefix?: string; onPress?: () => void }) {
  return (
    <Button variant="text" class="fl-discuss__quote" onClick={onPress} title={`Show ${speakerName(re.agent)}'s turn`}>
      <Icon name="reply" size={12} />
      <span>
        {prefix}
        <b>{speakerName(re.agent)}</b> “{re.quote}”
      </span>
    </Button>
  );
}

/** The turn a reply answers: that agent's newest turn before it. */
const answered = (v: DiscussView, t: TurnView): TurnView | undefined => {
  if (!t.re) return undefined;
  let found: TurnView | undefined;
  for (const r of v.rounds) for (const x of r.turns) if (x.agent === t.re.agent && x.n < t.n) found = x;
  return found;
};

const reveal = (d: DiscussionItem, n: number) => {
  const el = document.getElementById(`${d.id}-turn-${n}`);
  if (!el) return;
  if (el instanceof HTMLDetailsElement) el.open = true;
  el.closest('details')?.setAttribute('open', '');
  el.scrollIntoView({ block: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  el.focus({ preventScroll: true });
};

function stanceLabel(v: DiscussView, side: number | undefined, conf: number | undefined): string {
  return [side === undefined ? '' : v.positions[side], pct(conf)].filter(Boolean).join(' · ');
}

/** What the user said before a round, in the transcript. */
const pointsBefore = (d: DiscussionItem, round: number): string[] => d.turns.filter((t) => t.by === 'you' && t.round === round).map((t) => t.text);

/** Where a waiting point goes in. */
const queuedFor = (d: DiscussionItem) => (d.round < d.maxRounds ? `round ${d.round + 1}` : 'the summing up');

// ---- A · Positions board ----

function RoundBar({ ctx: { d, v }, round, pick }: { ctx: Ctx; round: number; pick(r: number): void }) {
  const running = d.state !== 'done';
  const count = running ? d.maxRounds : v.rounds.length;
  if (count < 1) return null;
  return (
    <div class="fl-discuss__bar">
      <Segmented
        label="Round"
        value={String(round)}
        onChange={(r) => pick(Number(r))}
        options={Array.from({ length: count }, (_, i) => ({
          value: String(i + 1),
          disabled: running && i + 1 > d.round,
          label: (
            <>
              Round {i + 1}
              {running && i + 1 === d.round && <Dot state="working" />}
            </>
          ),
        }))}
      />
      <span class="fl-discuss__hint">{v.open ? 'Open question: the columns are the positions as they emerged.' : 'Each column is an option; an agent sits under the one it holds.'}</span>
    </div>
  );
}

function Points({ d, round }: { d: DiscussionItem; round: number }) {
  const said = pointsBefore(d, round).map((text) => ({ when: `round ${round}`, text }));
  const waiting = round === d.round ? (d.points ?? []).map((text) => ({ when: queuedFor(d), text })) : [];
  return (
    <>
      {[...said, ...waiting].map((p, i) => (
        <div key={i} class="fl-discuss__you">
          <Icon name="user" />
          <span>
            <b>You</b>, before {p.when}: {p.text}
          </span>
        </div>
      ))}
    </>
  );
}

function Board({ ctx, round, onQuote }: { ctx: Ctx; round: number; onQuote(r: number): void }) {
  const { d, v } = ctx;
  const r = v.rounds[round - 1];
  if (!v.positions.length || !r) return <span class="fl-discuss__hint">No positions yet: the first turns are still being written.</span>;
  const live = d.state !== 'done' && round === d.round;
  const waiting = v.agents.filter((a) => r.holds[a] === undefined && !(live && v.speaking === a));
  return (
    <>
      <div class="fl-discuss__board" style={{ '--cols': String(v.positions.length) }}>
        {v.positions.map((name, i) => {
          const mine = v.agents.filter((a) => r.holds[a] === i);
          return (
            <section key={name} class="fl-discuss__col" data-empty={mine.length ? undefined : ''} aria-label={`${name}: ${mine.length} of ${v.agents.length}`}>
              <header class="fl-discuss__col-head">
                <span class="fl-discuss__col-name">{name}</span>
                <span class="fl-discuss__stack">
                  {mine.map((a) => (
                    <Avatar key={a} agent={a} size="sm" mark />
                  ))}
                </span>
                <span class="fl-discuss__count">
                  {mine.length} of {v.agents.length}
                </span>
              </header>
              {mine.length ? mine.map((a) => <Tile key={a} ctx={ctx} agent={a} round={round} live={live} onQuote={onQuote} />) : <div class="fl-discuss__empty">{nobody(v, i, round)}</div>}
            </section>
          );
        })}
      </div>
      {waiting.length > 0 && <span class="fl-discuss__hint">No position yet: {waiting.map(speakerName).join(', ')}</span>}
    </>
  );
}

function nobody(v: DiscussView, i: number, round: number): string {
  const left = new Set<string>();
  let when = 0;
  for (const a of v.agents)
    for (let r = 2; r <= round; r++)
      if (v.rounds[r - 2]?.holds[a] === i && v.rounds[r - 1]?.holds[a] !== i) {
        left.add(speakerName(a));
        when = r;
      }
  return left.size ? `Nobody holds this now. ${[...left].join(' and ')} moved off it in round ${when}.` : 'Nobody holds this yet.';
}

function Tile({ ctx: { d, v, chat }, agent, round, live, onQuote }: { ctx: Ctx; agent: AgentKey; round: number; live: boolean; onQuote(r: number): void }) {
  const [open, setOpen] = useState(false);
  const t = v.latest(agent, round)!;
  const r = v.rounds[round - 1];
  const prev = v.rounds[round - 2];
  const speaking = live && v.speaking === agent;
  const moved = !speaking && r.moved.includes(agent);
  const before = prev?.conf[agent];
  const now = r.conf[agent];
  const conf = !speaking && !moved && t.round === round && before !== undefined && now !== undefined && before !== now ? `${pct(before)}→${pct(now)}` : pct(now);
  const target = answered(v, t);
  return (
    <article class="fl-discuss__tile" id={`${d.id}-turn-${t.n}`} tabIndex={-1} data-speaking={speaking ? '' : undefined}>
      <div class="fl-discuss__tile-head">
        <Avatar agent={agent} mark />
        <b>{speakerName(agent)}</b>
        {speaking && (
          <span class="fl-discuss__speaking">
            <Dot state="working" />
            speaking
          </span>
        )}
        {moved && <Pill icon="send">moved here in round {round}</Pill>}
        <span class="fl-discuss__conf">{conf}</span>
      </div>
      <div class="fl-discuss__claim">{speaking ? <span class="fl-discuss__hint">Writing its round {d.round} turn…</span> : <Inline text={t.claim} />}</div>
      {open && !speaking && (
        <div class="fl-discuss__body">
          <Markdown text={t.body} chatId={chat.id} cwd={chat.cwd} />
        </div>
      )}
      {!speaking && (
        <div class="fl-discuss__sub">
          {t.re && (
            <Quote
              re={t.re}
              prefix="re: "
              onPress={
                target &&
                (() => {
                  onQuote(target.round);
                  requestAnimationFrame(() => reveal(d, target.n));
                })
              }
            />
          )}
          <Button variant="link" muted onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? 'Less' : 'Full turn'}
          </Button>
        </div>
      )}
    </article>
  );
}

// ---- B · Stance meter ----

function Meter({ v, round, compact }: { v: DiscussView; round: number; compact?: boolean }) {
  if (!v.positions.length) return null;
  const m = meterOf(v, round);
  const said = m.lanes.map((l) => `${speakerName(l.agent)}: ${l.side !== undefined ? v.positions[l.side] : 'no position'}${l.label && !l.speaking ? `, ${l.label}` : ''}`).join('; ');
  return (
    <div class="fl-discuss__meter" data-compact={compact ? '' : undefined} role="img" aria-label={`Where each agent stands. ${said}`}>
      <div class="fl-discuss__axis">
        <span />
        <div class="fl-discuss__ends">
          <b>
            <Icon name="arrowLeft" />
            {m.ends[0]}
          </b>
          <span>unsure</span>
          <b>
            {m.ends[1] || 'Anything else'}
            <Icon name="send" />
          </b>
        </div>
      </div>
      {m.lanes.map((l) => {
        const lo = Math.min(l.x, ...l.trail);
        const hi = Math.max(l.x, ...l.trail);
        return (
          <div key={l.agent} class="fl-discuss__lane">
            <div class="fl-discuss__who">
              <Avatar agent={l.agent} mark />
              <span>{speakerName(l.agent)}</span>
            </div>
            <div class="fl-discuss__track">
              <i class="fl-discuss__mid" />
              {l.trail.length > 0 && <i class="fl-discuss__trail" style={{ '--x': `${lo}%`, '--w': `${hi - lo}%` }} />}
              {l.trail.map((x) => (
                <i key={x} class="fl-discuss__ghost" style={{ '--x': `${x}%` }} />
              ))}
              <span class="fl-discuss__marker" style={{ '--x': `${l.x}%` }} data-speaking={l.speaking ? '' : undefined}>
                <Avatar agent={l.agent} size="marker" mark />
              </span>
              <span class="fl-discuss__val" style={{ '--x': `${l.x}%` }} data-end={l.x < 50 ? 'start' : l.x > 50 ? 'end' : undefined} data-speaking={l.speaking ? '' : undefined}>
                {l.label}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Steps({ d }: { d: DiscussionItem }) {
  return (
    <div class="fl-discuss__steps">
      {Array.from({ length: d.maxRounds }, (_, i) => {
        const r = i + 1;
        const st = r < d.round || d.state === 'summarizing' ? 'done' : r === d.round ? 'working' : 'idle';
        return (
          <Fragment key={r}>
            {r > 1 && <i class="fl-discuss__link" />}
            <span class="fl-discuss__step" data-st={st}>
              <Dot state={st} still={st !== 'working'} />
              Round {r}
            </span>
          </Fragment>
        );
      })}
      <span class="fl-discuss__legend">
        <i class="fl-discuss__ghost" />
        earlier rounds
      </span>
    </div>
  );
}

function Rows({ ctx }: { ctx: Ctx }) {
  const { d, v } = ctx;
  return (
    <div class="fl-discuss__rows">
      {v.rounds.map((r) =>
        r.round < d.round ? (
          <details key={r.round} class="fl-discuss__group">
            <summary>
              <Icon name="forward" size={12} />
              Round {r.round} · {r.turns.length} turn{r.turns.length === 1 ? '' : 's'} ·
              <span class="fl-discuss__stack">
                {r.turns.map((t) => (
                  <Avatar key={t.n} agent={t.agent} size="sm" mark />
                ))}
              </span>
            </summary>
            {pointsBefore(d, r.round).map((p, i) => (
              <YouRow key={`p${i}`} text={p} />
            ))}
            {r.turns.map((t) => (
              <Row key={t.n} ctx={ctx} t={t} />
            ))}
          </details>
        ) : (
          <Fragment key={r.round}>
            <div class="fl-discuss__group" data-open="">
              <Icon name="chevronDown" size={12} />
              Round {r.round}
            </div>
            {pointsBefore(d, r.round).map((p, i) => (
              <YouRow key={`p${i}`} text={p} />
            ))}
            {r.turns.map((t) => (
              <Row key={t.n} ctx={ctx} t={t} />
            ))}
            {v.speaking && <SpeakingRow agent={v.speaking} />}
            {(d.points ?? []).map((p, i) => (
              <YouRow key={`q${i}`} text={p} queued={`before ${queuedFor(d)}`} />
            ))}
          </Fragment>
        ),
      )}
    </div>
  );
}

const YouRow = ({ text, queued }: { text: string; queued?: string }) => (
  <div class="fl-discuss__row" data-you="">
    <Icon name="user" />
    <b>You</b>
    {queued && <Pill>{queued}</Pill>}
    <span class="fl-discuss__row-text">{text}</span>
  </div>
);

const SpeakingRow = ({ agent }: { agent: AgentKey }) => (
  <div class="fl-discuss__row" data-speaking="">
    <Avatar agent={agent} size="sm" mark />
    <b>{speakerName(agent)}</b>
    <Pill tone="working" dot>
      speaking
    </Pill>
    <span class="fl-discuss__row-text fl-discuss__hint">Writing its turn…</span>
  </div>
);

function Row({ ctx: { d, v, chat }, t }: { ctx: Ctx; t: TurnView }) {
  const stance = stanceLabel(v, t.side, t.confidence);
  return (
    <details class="fl-discuss__row-wrap" id={`${d.id}-turn-${t.n}`} tabIndex={-1}>
      <summary class="fl-discuss__row">
        <Avatar agent={t.agent} size="sm" mark />
        <b>{speakerName(t.agent)}</b>
        {t.failed ? <Pill tone="failed">couldn’t answer</Pill> : stance && <Pill>{stance}</Pill>}
        <span class="fl-discuss__row-text">
          {t.re && <span class="fl-discuss__re">re {speakerName(t.re.agent)}: </span>}
          <Inline text={t.claim} />
        </span>
        <Icon name="forward" size={12} />
      </summary>
      <div class="fl-discuss__body">{t.failed ? t.body : <Markdown text={t.body} chatId={chat.id} cwd={chat.cwd} />}</div>
    </details>
  );
}

// ---- C · Threaded timeline ----

const YouLine = ({ text, when }: { text: string; when: string }) => (
  <div class="fl-discuss__you" data-plain="">
    <Icon name="user" />
    <span>
      <b>You</b> added a point before {when}: {text}
    </span>
  </div>
);

function Thread({ ctx }: { ctx: Ctx }) {
  const { d, v } = ctx;
  return (
    <div class="fl-discuss__thread">
      {v.rounds.map((r) =>
        r.round < d.round ? (
          <RoundFold key={r.round} ctx={ctx} r={r} />
        ) : (
          <Fragment key={r.round}>
            {pointsBefore(d, r.round).map((p, i) => (
              <YouLine key={i} text={p} when={`round ${r.round}`} />
            ))}
            <div class="fl-discuss__round" data-open="">
              <Icon name="chevronDown" size={12} />
              <b>Round {r.round}</b>
              <span class="fl-discuss__round-label">{r.round === 1 ? 'Opening positions' : 'Replies'}</span>
              {tagOf(r) && <span class="fl-discuss__tag">{tagOf(r)}</span>}
            </div>
            {r.turns.map((t) => (
              <TurnCard key={t.n} ctx={ctx} t={t} />
            ))}
            {v.speaking && <SpeakingCard agent={v.speaking} />}
          </Fragment>
        ),
      )}
      {(d.points ?? []).map((p, i) => (
        <YouLine key={`q${i}`} text={p} when={queuedFor(d)} />
      ))}
      {d.state === 'running' && d.round < d.maxRounds && (
        <div class="fl-discuss__round" data-next="">
          <Icon name="forward" size={12} />
          <b>Round {d.round + 1}</b>
          <span class="fl-discuss__round-label">
            {d.round + 1 === d.maxRounds ? 'Last round' : 'Next'} · {v.agents.map(speakerName).join(', ')}
          </span>
        </div>
      )}
    </div>
  );
}

/** A round's tag: how it moved (the summary's word, else worked out) and on what; else its tally. */
const tagOf = (r: RoundView): string =>
  r.trend ? (r.on ? `${r.trend} on ${r.on}` : r.trend) : [r.tally, r.lessSure.length ? `${r.lessSure.map(speakerName).join(' and ')} less sure` : ''].filter(Boolean).join(', ');

function TurnCard({ ctx: { d, v, chat }, t }: { ctx: Ctx; t: TurnView }) {
  const [open, setOpen] = useState(false);
  const target = answered(v, t);
  const stance = stanceLabel(v, t.side, t.confidence);
  const more = t.body.trim() !== t.claim.trim();
  return (
    <article class="fl-discuss__turn" id={`${d.id}-turn-${t.n}`} tabIndex={-1}>
      <span class="fl-discuss__node">
        <Avatar agent={t.agent} mark />
      </span>
      <div class="fl-discuss__turn-card">
        <div class="fl-discuss__turn-head">
          <b>{speakerName(t.agent)}</b>
          {t.failed ? <Pill tone="failed">couldn’t answer</Pill> : stance && <Pill>{stance}</Pill>}
        </div>
        {t.re && <Quote re={t.re} onPress={target && (() => reveal(d, target.n))} />}
        <p class="fl-discuss__claim" data-strong="">
          <Inline text={t.claim} />
        </p>
        {more &&
          (open ? (
            <div class="fl-discuss__body">
              {t.failed ? t.body : <Markdown text={t.body} chatId={chat.id} cwd={chat.cwd} />}
              <Button variant="link" muted onClick={() => setOpen(false)} aria-expanded>
                Less
              </Button>
            </div>
          ) : (
            <p class="fl-discuss__more">
              <span class="fl-discuss__more-text">{t.body.replace(/[#*_>`]/g, '')}</span>
              <Button variant="link" muted onClick={() => setOpen(true)} aria-expanded={false}>
                More
              </Button>
            </p>
          ))}
      </div>
    </article>
  );
}

const SpeakingCard = ({ agent }: { agent: AgentKey }) => (
  <article class="fl-discuss__turn" data-speaking="">
    <span class="fl-discuss__node">
      <Avatar agent={agent} mark />
    </span>
    <div class="fl-discuss__turn-card">
      <div class="fl-discuss__turn-head">
        <b>{speakerName(agent)}</b>
        <Pill tone="working" dot>
          speaking
        </Pill>
      </div>
      <p class="fl-discuss__claim fl-discuss__hint">Writing its turn…</p>
    </div>
  </article>
);

/** A round, folded to one line: its label, each agent's stance and the round's tag; open, its turns. */
function RoundFold({ ctx, r }: { ctx: Ctx; r: RoundView }) {
  const { d, v } = ctx;
  const tag = tagOf(r);
  return (
    <details class="fl-discuss__round-fold">
      <summary class="fl-discuss__round">
        <Icon name="forward" size={12} />
        <b>Round {r.round}</b>
        <span class="fl-discuss__round-label">{r.label}</span>
        <span class="fl-discuss__chips">
          {r.turns
            .filter((t) => !t.failed)
            .map((t) => (
              <span key={t.n} class="fl-discuss__chip">
                <Avatar agent={t.agent} size="sm" mark />
                {[t.side !== undefined ? v.positions[t.side] : '', pct(t.confidence)].filter(Boolean).join(' ') || 'no stance'}
              </span>
            ))}
        </span>
        <span class="fl-discuss__tag">{tag}</span>
      </summary>
      <div class="fl-discuss__thread">
        {pointsBefore(d, r.round).map((p, i) => (
          <YouLine key={i} text={p} when={`round ${r.round}`} />
        ))}
        {r.turns.map((t) => (
          <TurnCard key={t.n} ctx={ctx} t={t} />
        ))}
      </div>
    </details>
  );
}

// ---- The conclusion (C's, in every layout) ----

function OutcomeHead({ o }: { o: Outcome }) {
  return (
    <div class="fl-discuss__hero">
      <div class="fl-discuss__hero-title">
        <Icon name={o.kind === 'agreed' ? 'check' : o.kind === 'split' ? 'split' : 'info'} />
        {o.headline}
      </div>
      {o.dispute && <p class="fl-discuss__hero-sub">{o.dispute}</p>}
      {o.who && (
        <p class="fl-discuss__hero-sub">
          <span class="fl-discuss__stack">
            {o.whoAgents?.map((a) => (
              <Avatar key={a} agent={a} size="sm" mark />
            ))}
          </span>
          {o.who}
        </p>
      )}
    </div>
  );
}

function Sides({ o }: { o: Outcome }) {
  return (
    <div class="fl-discuss__sides" data-n={String(o.sides.length)}>
      {o.sides.map((s, i) => (
        <Fragment key={s.position}>
          {i > 0 && o.sides.length === 2 && <span class="fl-discuss__vs">vs</span>}
          <section class="fl-discuss__side" aria-label={s.position}>
            <div class="fl-discuss__side-head">
              <span class="fl-discuss__stack">
                {s.agents.map((a) => (
                  <Avatar key={a} agent={a} size="sm" mark />
                ))}
              </span>
              <b>{s.position}</b>
              <span class="fl-discuss__side-who">{s.agents.map(speakerName).join(' and ')}</span>
            </div>
            <p>
              <Inline text={s.why} />
            </p>
          </section>
        </Fragment>
      ))}
    </div>
  );
}

function Conclusion({ d, o }: { d: DiscussionItem; o: Outcome }) {
  const c = d.conclusion;
  if (!c) return null;
  return (
    <>
      <section class="fl-discuss__section" aria-label={o.agreedLabel}>
        <div class="fl-discuss__label">
          <Icon name="check" />
          {o.agreedLabel}
        </div>
        {c.agreed.length ? (
          <ul>
            {c.agreed.map((a, n) => (
              <li key={n}>
                <Inline text={a} />
              </li>
            ))}
          </ul>
        ) : (
          <span class="fl-discuss__hint">Nothing everyone agreed on.</span>
        )}
      </section>
      {c.disagreed.length > 1 && (
        <section class="fl-discuss__section" aria-label="Also still open">
          <div class="fl-discuss__label">
            <Icon name="split" />
            Also still open
          </div>
          <ul>
            {c.disagreed.slice(1).map((x, n) => (
              <li key={n}>{x.point}</li>
            ))}
          </ul>
        </section>
      )}
      <section class="fl-discuss__section" aria-label="Recommended next step">
        <div class="fl-discuss__label">
          <Icon name="send" />
          Recommended next step
        </div>
        <p class="fl-discuss__next">
          <Inline text={c.next} />
        </p>
      </section>
    </>
  );
}

function Actions({ d }: { d: DiscussionItem }) {
  if (d.continued) return null;
  const carry = (agent: AgentKey) => send({ type: 'discussion', id: d.id, act: 'carry', agent });
  return (
    <div class="fl-discuss__actions">
      {d.conclusion?.by === 'friedliver' && <span class="fl-discuss__hint">Summed up by FriedLiver</span>}
      <Button size="sm" icon="ask" onClick={() => send({ type: 'discussion', id: d.id, act: 'continue' })}>
        Continue discussing
      </Button>
      {d.carried ? (
        <Pill tone="done" icon="check">
          Carried out with {speakerName(d.carried)}
        </Pill>
      ) : (
        <CarryOut d={d} carry={carry} />
      )}
    </div>
  );
}

function History({ ctx }: { ctx: Ctx }) {
  return (
    <div class="fl-discuss__history" role="group" aria-label="Rounds">
      {ctx.v.rounds.map((r) => (
        <RoundFold key={r.round} ctx={ctx} r={r} />
      ))}
    </div>
  );
}

function CarryOut({ d, carry }: { d: DiscussionItem; carry(agent: AgentKey): void }) {
  const agents = d.participants.map((p) => p.agent);
  const pick = d.conclusion?.carryOut && agents.includes(d.conclusion.carryOut) ? d.conclusion.carryOut : agents[0];
  return (
    <SplitButton
      size="sm"
      onClick={() => carry(pick)}
      menu={(triggerClass) => (
        <Popover label="Carry out with" title="Carry out with another agent" buttonClass={cx(triggerClass, 'fl-split-caret')} align="end" trigger={<Icon name="chevronDown" />}>
          {(close) => (
            <>
              <MenuTitle>Carry out with</MenuTitle>
              {agents.map((a) => (
                <MenuItem
                  key={a}
                  lead={<Avatar agent={a} size="sm" mark />}
                  label={speakerName(a)}
                  checked={a === pick}
                  onSelect={() => {
                    close();
                    carry(a);
                  }}
                />
              ))}
            </>
          )}
        </Popover>
      )}
    >
      Carry out with {speakerName(pick)}
    </SplitButton>
  );
}
