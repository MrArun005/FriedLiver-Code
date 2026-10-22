// The Welcome page (COMPONENTS.md v2 §2.38): the greeting and one sentence of state, the Ask box, recent
// folders, your agents, and what needs you, what's working and what got done today. First run (no
// folders, no chats): the Ask box, "Connect an agent" and "Try the demo agent" instead of the lists.
import { render } from 'preact';
import { useState } from 'preact/hooks';
import type { RecentFolder } from '../shared/messages';
import type { AgentKey, ChatView } from '../shared/model';
import { AGENT_FACES } from '../shared/model';
import { isVendor, preselectAgents } from '../shared/accounts';
import { ago, cardLine, needsYou, openChats, planProgress, statusOf } from '../shared/view';
import { connectStatus, welcomeSummary } from '../shared/welcome';
import { Dot, send, useHost, useNow, useRoster } from './common';
import { AskBox, Avatar, BrandMark, Button, Card, Count, Icon, Keycaps, Progress, Row, type IconName } from './ui';

/** First run: what happens after you connect an agent (V17). */
const NEXT_STEPS: { icon: IconName; title: string; text: string }[] = [
  { icon: 'user', title: 'Connect an agent', text: 'Sign in with its account or an API key. Nothing runs until you do.' },
  { icon: 'ask', title: 'Describe a task', text: 'Type it in the box above. The agent plans it and starts in this window.' },
  { icon: 'hand', title: 'Decide when it asks', text: 'Before it runs a command or changes files, it asks. Requests wait in Needs you.' },
  { icon: 'diff', title: 'Review and keep', text: 'Read the changes, then keep them or send them back.' },
];

const greeting = (d: Date) => (d.getHours() < 12 ? 'Good morning' : d.getHours() < 18 ? 'Good afternoon' : 'Good evening');

function Welcome() {
  const [recent, setRecent] = useState<RecentFolder[]>([]);
  const { state } = useHost((m) => {
    if (m.type === 'recent') setRecent(m.items);
  });
  const now = useNow(30_000);
  const roster = useRoster();
  const [text, setText] = useState('');
  const agent: AgentKey = preselectAgents(roster, ['claude'])[0] ?? 'claude';
  const chats = openChats(state.chats);
  const sum = welcomeSummary(chats, now);
  const firstRun = !recent.length && !state.chats.length;
  const start = () => {
    const prompt = text.trim();
    if (!prompt) return;
    send({ type: 'createTask', agent, prompt, worktree: false });
    setText('');
  };
  const open = (c: ChatView) => send({ type: 'openChat', chatId: c.id });

  return (
    <main class="welcome">
      <header class="wl-hero">
        <BrandMark size={48} class="wl-mark" />
        <div class="wl-hello">
          <h1>{greeting(new Date(now))}</h1>
          <p>{sum.sentence}</p>
        </div>
        <span class="wl-grow" />
        <Button variant="quiet" icon="folder" onClick={() => send({ type: 'openFolder' })}>
          Open folder
        </Button>
        <Button variant="quiet" icon="branch" onClick={() => send({ type: 'cloneRepo' })}>
          Get a project from GitHub
        </Button>
      </header>

      <div class="wl-ask-row">
        <AskBox value={text} onInput={setText} onSubmit={start} label="Describe a task" placeholder={`What do you want to build or change? ${AGENT_FACES[agent].name} will start on it.`}>
          <Button variant="primary" kbd="⏎" disabled={!text.trim()} onClick={start}>
            Start
          </Button>
        </AskBox>
      </div>

      {firstRun ? (
        <div class="wl-cols wl-first">
          <div class="wl-col">
            <section aria-label="Connect an agent">
              <h2 class="wl-h">
                Connect an agent <span class="wl-grow" />
                <Button variant="link" muted onClick={() => send({ type: 'openAccounts' })}>
                  Agents &amp; Accounts
                </Button>
              </h2>
              <div class="wl-agents">
                {roster.agents.filter(isVendor).map((a) => {
                  const s = connectStatus(roster.signIn[a]);
                  return (
                    <Card key={a} as="div" variant="flat" class="wl-tile">
                      <Avatar agent={a} size="lg" />
                      <span class="wl-two">
                        <b>{AGENT_FACES[a].name}</b>
                        <span>{s.words}</span>
                      </span>
                      {s.connected ? (
                        <Dot state="done" still />
                      ) : (
                        <Button size="sm" aria-label={`Connect ${AGENT_FACES[a].name}`} onClick={() => send({ type: 'openAccounts', agent: a })}>
                          Connect
                        </Button>
                      )}
                    </Card>
                  );
                })}
              </div>
            </section>
            <section aria-label="Try the demo agent" class="wl-demo">
              <Button variant="quiet" icon="play" onClick={() => send({ type: 'createTask', agent: 'demo', prompt: 'Show me what you can do', worktree: false })}>
                Try the demo agent
              </Button>
              <p class="wl-empty">It runs on this machine with no account, so you can see a chat, a request and a review before you sign in.</p>
            </section>
          </div>
          <div class="wl-col">
            <section aria-label="What happens next">
              <h2 class="wl-h">What happens next</h2>
              <ol class="wl-steps">
                {NEXT_STEPS.map((step) => (
                  <li key={step.title} class="wl-row wl-live">
                    <Icon name={step.icon} />
                    <span class="wl-two">
                      <b>{step.title}</b>
                      <span>{step.text}</span>
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          </div>
        </div>
      ) : (
        <div class="wl-cols">
          <div class="wl-col">
            <section aria-label="Recent">
              <h2 class="wl-h">Recent</h2>
              {recent.length ? (
                recent.map((r, i) => (
                  <Row key={r.path} class="wl-row" icon="folder" title={r.path} meta={r.current ? 'this window' : undefined} onPress={() => send({ type: 'openRecent', index: i })}>
                    <span class="wl-name">{r.name}</span> <span class="wl-sub">{r.path}</span>
                  </Row>
                ))
              ) : (
                <p class="wl-empty">Folders you open show here.</p>
              )}
            </section>
            <section aria-label="Agents">
              <h2 class="wl-h">
                Agents <span class="wl-grow" />
                <Button variant="link" muted onClick={() => send({ type: 'openAccounts' })}>
                  Agents &amp; Accounts
                </Button>
              </h2>
              <div class="wl-agents">
                {roster.agents.map((a) => {
                  const mine = chats.filter((c) => c.agent === a);
                  const working = mine.filter((c) => c.busy).length;
                  const waiting = mine.filter(needsYou).length;
                  const words = [working && `${working} working`, waiting && `${waiting} need${waiting === 1 ? 's' : ''} you`].filter(Boolean).join(', ') || 'idle';
                  return (
                    <Row key={a} class="wl-agent" label={`${AGENT_FACES[a].name}: ${words}`} onPress={() => send({ type: 'openAccounts', agent: a })}>
                      <span class="wl-who">
                        <Avatar agent={a} working={working > 0} />
                        <span class="wl-two">
                          <b>{AGENT_FACES[a].name}</b>
                          <span>{words}</span>
                        </span>
                      </span>
                    </Row>
                  );
                })}
              </div>
            </section>
          </div>
          <div class="wl-col">
            <section aria-label="Needs you">
              <h2 class="wl-h">
                Needs you <Count n={sum.needs.length} loud={sum.needs.length > 0} />
                <span class="wl-grow" />
                <Button variant="link" muted onClick={() => send({ type: 'openTasks' })}>
                  Agent Manager
                </Button>
              </h2>
              {sum.needs.length ? (
                sum.needs.slice(0, 4).map((c) => (
                  <div key={c.id} class="wl-row wl-live">
                    <Avatar agent={c.agent} />
                    <span class="wl-two">
                      <b>{c.title}</b>
                      <span>
                        {cardLine(state, c).text} · {ago(c.lastActivity, now)}
                      </span>
                    </span>
                    <Dot state={statusOf(c)} still />
                    <Button size="sm" onClick={() => open(c)}>
                      Open
                    </Button>
                  </div>
                ))
              ) : (
                <p class="wl-empty">Nothing waits for you. When an agent asks, it shows here first.</p>
              )}
            </section>
            {sum.working.length > 0 && (
              <section aria-label="Working">
                <h2 class="wl-h">
                  Working <Count n={sum.working.length} />
                </h2>
                {sum.working.slice(0, 4).map((c) => {
                  const p = planProgress(c);
                  return (
                    <Row key={c.id} class="wl-row wl-live" label={c.title} onPress={() => open(c)} meta={p ? <span class="wl-bar"><Progress value={p.done} max={p.steps.length} label={`${p.done} of ${p.steps.length} steps`} /></span> : undefined}>
                      <span class="wl-who">
                        <Avatar agent={c.agent} working />
                        <span class="wl-two">
                          <b>{c.title}</b>
                          <span>{p?.currentText ? `${p.currentText} · step ${p.current} of about ${p.steps.length}` : cardLine(state, c).text}</span>
                        </span>
                      </span>
                    </Row>
                  );
                })}
              </section>
            )}
            {sum.done.length > 0 && (
              <section aria-label="Done today">
                <h2 class="wl-h">
                  Done today <Count n={sum.done.length} />
                </h2>
                {sum.done.slice(0, 3).map((c) => (
                  <Row key={c.id} class="wl-row" label={c.title} onPress={() => open(c)} meta={new Date(c.lastActivity).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}>
                    <span class="wl-who">
                      <Dot state="done" still />
                      <span class="wl-name">{c.title}</span> <span class="wl-sub">{AGENT_FACES[c.agent].name}</span>
                    </span>
                  </Row>
                ))}
                {sum.done.length > 3 && <p class="wl-empty">and {sum.done.length - 3} more</p>}
              </section>
            )}
          </div>
        </div>
      )}
      <p class="wl-keys">
        <Keycaps keys="⇧⌘A" /> opens a chat in the editor · <Keycaps keys="⇧⌘P" /> runs any command
      </p>
    </main>
  );
}

render(<Welcome />, document.getElementById('root')!);
