// The /discuss card (COMPONENTS.md §2.30): who takes part, how far it got, the folded transcript,
// and the conclusion with "Carry out with …". Drawn only with the design system's components.
import { discussMeta, discussProgress, speakerName, type DiscussTurn, type DiscussionItem } from '../shared/discuss';
import type { AgentKey, ChatView } from '../shared/model';
import { Dot, Markdown, send } from './common';
import { Avatar, Button, Card, CardFoot, CardHead, Icon, MenuItem, MenuTitle, Pill, Popover, Progress, SplitButton, cx } from './ui';

export function DiscussionCard({ item: d, chat }: { item: DiscussionItem; chat: ChatView }) {
  const running = d.state !== 'done';
  const act = (a: 'stop' | 'continue') => send({ type: 'discussion', id: d.id, act: a });
  const carry = (agent: AgentKey) => send({ type: 'discussion', id: d.id, act: 'carry', agent });
  const spoken = d.turns.filter((t) => t.by !== 'you').length;
  return (
    <Card size="sm" class="msg-card fl-discuss" label={`Discussion: ${d.question}`} data-enter={running ? '' : undefined} data-muted={d.continued ? '' : undefined}>
      <CardHead icon="discuss" title={<span title={d.question}>{d.question}</span>} meta={<span aria-live="polite">{discussMeta(d)}</span>} />
      <div class="fl-discuss__who">
        {d.participants.map((p) => (
          <span key={p.agent} class="fl-discuss__person">
            <Avatar agent={p.agent} size="sm" />
            {speakerName(p.agent)}
            {d.speaking === p.agent && <Dot state="working" />}
          </span>
        ))}
      </div>
      {d.state === 'running' && <Progress value={discussProgress(d)} label="Discussion progress" />}
      {d.turns.length > 0 && (
        <details class="fl-discuss__log" open={running}>
          <summary>
            <Icon name="chevron" size={12} />
            Transcript · {spoken} turn{spoken === 1 ? '' : 's'}
          </summary>
          <div class="fl-discuss__turns">
            {d.turns.map((t, n) => (
              <Turn key={n} turn={t} chat={chat} />
            ))}
          </div>
        </details>
      )}
      {!running && d.conclusion && <Conclusion d={d} />}
      {running ? (
        <CardFoot>
          <span class="fl-discuss__hint">Read-only until it ends. Type below to add a point.</span>
          <Button variant="quiet-danger" size="sm" icon="stop" onClick={() => act('stop')}>
            Stop
          </Button>
        </CardFoot>
      ) : (
        !d.continued && (
          <CardFoot>
            {d.conclusion?.by === 'friedliver' && <span class="fl-discuss__hint">Summed up by FriedLiver</span>}
            <Button size="sm" icon="ask" onClick={() => act('continue')}>
              Continue discussing
            </Button>
            {d.carried ? (
              <Pill tone="done" icon="check">
                Carried out with {speakerName(d.carried)}
              </Pill>
            ) : (
              <CarryOut d={d} carry={carry} />
            )}
          </CardFoot>
        )
      )}
    </Card>
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
                  lead={<Avatar agent={a} size="sm" />}
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

function Turn({ turn: t, chat }: { turn: DiscussTurn; chat: ChatView }) {
  const s = t.stance;
  return (
    <div class="fl-discuss__turn" data-by={t.by} data-failed={t.failed ? '' : undefined}>
      <div class="fl-discuss__turn-head">
        {t.by === 'you' ? <Icon name="user" /> : <Avatar agent={t.by} size="sm" />}
        <b>{speakerName(t.by)}</b>
        <span class="fl-discuss__round">{t.by === 'you' ? 'between turns' : `Round ${t.round}`}</span>
      </div>
      <div class="fl-discuss__body">{t.failed ? t.text : <Markdown text={t.text} chatId={chat.id} cwd={chat.cwd} />}</div>
      {s?.parsed && (s.confidence !== undefined || s.disagree.length > 0) && (
        <div class="fl-discuss__stance">
          {s.confidence !== undefined && <Pill>{Math.round(s.confidence * 100)}% sure</Pill>}
          {s.disagree.length > 0 && <span>Disputes: {s.disagree.join('; ')}</span>}
        </div>
      )}
    </div>
  );
}

function Conclusion({ d }: { d: DiscussionItem }) {
  const c = d.conclusion!;
  return (
    <>
      <section class="fl-discuss__section" aria-label="Agreed">
        <div class="fl-discuss__label">
          <Icon name="check" />
          Agreed
        </div>
        {c.agreed.length ? (
          <ul>
            {c.agreed.map((a, n) => (
              <li key={n}>{a}</li>
            ))}
          </ul>
        ) : (
          <span class="fl-discuss__empty">Nothing everyone agreed on.</span>
        )}
      </section>
      <section class="fl-discuss__section" aria-label="Still disagree">
        <div class="fl-discuss__label">
          <Icon name="compare" />
          Still disagree
        </div>
        {c.disagreed.length ? (
          c.disagreed.map((x, n) => (
            <div key={n} class="fl-discuss__point">
              <b>{x.point}</b>
              {x.sides.map((side) => (
                <div key={side.agent} class="fl-discuss__side">
                  <Avatar agent={side.agent} size="sm" />
                  <span>{side.view}</span>
                </div>
              ))}
            </div>
          ))
        ) : (
          <span class="fl-discuss__empty">No open disagreements.</span>
        )}
      </section>
      <section class="fl-discuss__section" aria-label="Recommended next step">
        <div class="fl-discuss__label">
          <Icon name="forward" />
          Recommended next step
        </div>
        <span class="fl-discuss__next">{c.next}</span>
      </section>
    </>
  );
}
