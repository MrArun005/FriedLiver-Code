// Agents & Accounts (host/accountsPage.ts): a card per agent with its sign-in,
// keys, its CLI's own login and the model and effort new chats start with.
// The page shows what the host sends and asks it to act; it never sees a key.
import { Fragment, render, type ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { SIGN_IN_TEXT, type AccountCard, type AccountsView, type CliLine, type CliWhat, type DefaultKey, type KeyView, type MethodView, type VendorKey } from '../shared/accounts';
import { age } from '../shared/model';
import type { SessionOption } from '../shared/session';
import { NEVER_ALWAYS, SYSTEM_TOOLS, SYSTEM_WORDS, unsupportedOn, type SystemSettingsView } from '../shared/system';
import { Glyph, Icon, Popover, send } from './common';
import { BrandMark, Button, IconButton, MenuItem, selectTrigger, Toggle } from './ui';

const KIND_TEXT: Record<MethodView['kind'], string> = { browser: 'in your browser', terminal: 'in a terminal', key: 'API key' };

function Page() {
  const [view, setView] = useState<AccountsView | null>(null);
  const scrolled = useRef(0);
  useEffect(() => {
    const listener = (e: MessageEvent) => {
      const m = e.data as { type?: string; view?: AccountsView };
      if (m?.type === 'accounts' && m.view) setView(m.view);
    };
    window.addEventListener('message', listener);
    send({ type: 'ready' });
    return () => window.removeEventListener('message', listener);
  }, []);
  // Opened from a chat that needs a sign-in: that agent's card, once per opening.
  useEffect(() => {
    const focus = view?.focus;
    if (!focus || focus.n === scrolled.current) return;
    scrolled.current = focus.n;
    const card = document.getElementById(`card-${focus.agent}`);
    card?.scrollIntoView({ block: 'start' });
    card?.focus({ preventScroll: true });
  }, [view?.focus?.n]);

  if (!view) return <div class="acct-page" />;
  return (
    <main class="acct-page">
      <header class="acct-head">
        <h1>
          <BrandMark size={20} /> Agents &amp; Accounts
        </h1>
        <p class="hint">
          Each agent signs in with its own company, through its own login or an API key you keep here. FriedLiver never sees a password; keys stay in the
          editor’s secret storage and go only to their own agent. Nothing here starts an agent until you press Check, Refresh or a sign-in.
        </p>
      </header>
      <section class="acct-card acct-links" aria-label="Links">
        <div class="acct-links-row">
          <div>
            <h2>Open links in</h2>
            <p class="hint">Links you click in FriedLiver, its editor and terminal. In chats and the Agent Manager, hold {MAC ? '⌘' : 'Ctrl'} to open one the other way.</p>
          </div>
          <div class="fl-seg seg" role="radiogroup" aria-label="Open links in">
            {(['builtin', 'external'] as const).map((mode) => (
              <button key={mode} type="button" role="radio" class="fl-seg__item seg-item" aria-checked={view.links === mode} onClick={() => send({ type: 'setLinks', mode })}>
                {mode === 'builtin' ? 'FriedLiver browser' : 'System browser'}
              </button>
            ))}
          </div>
        </div>
      </section>
      {view.cards.map((card) => (
        <Card key={card.agent} card={card} focused={view.focus?.agent === card.agent} />
      ))}
      {view.system && <SystemCard s={view.system} />}
    </main>
  );
}

/**
 * "Mac & Windows control": the system_* tools on or off, one by one, and whether Full auto covers them.
 * Built from the page's existing classes only (acct-card, acct-top, acct-key, acct-block, acct-tag) and the design system's Toggle.
 */
function SystemCard({ s }: { s: SystemSettingsView }) {
  const on = s.supported && s.enabled;
  const missing = new Set(unsupportedOn(s.platform));
  return (
    <section class="acct-card" aria-labelledby="sys-title">
      <div class="acct-top">
        <h2 id="sys-title">Mac &amp; Windows control</h2>
        <Switch label="Mac & Windows control" on={on} disabled={!s.supported} onChange={(value) => send({ type: 'setSystem', key: 'enabled', value })} />
      </div>
      <p class="acct-note hint">
        {s.supported
          ? 'Agents can ask to open apps, files and links, use the clipboard, show a notification, change the volume or screenshot a window. Each action asks you first and goes in the action log.'
          : 'Not available here: FriedLiver can act on macOS and Windows only.'}
      </p>
      <div class="acct-block">
        <h3>Actions agents may ask for</h3>
        {SYSTEM_TOOLS.map((tool) => (
          <div key={tool} class="acct-key">
            <span>
              {SYSTEM_WORDS[tool]}
              {missing.has(tool) ? <span class="acct-tag">{s.platform === 'win' ? 'macOS only' : 'Not here'}</span> : NEVER_ALWAYS.has(tool) && <span class="acct-tag">Asks every time</span>}
            </span>
            <Switch label={SYSTEM_WORDS[tool]} on={on && s.tools[tool]} disabled={!on || missing.has(tool)} onChange={(value) => send({ type: 'setSystem', key: tool, value })} />
          </div>
        ))}
      </div>
      <div class="acct-block">
        <div class="acct-top">
          <h3>Full auto may act without asking</h3>
          <Switch label="Full auto may act without asking" on={s.fullAutoAllowed} disabled={!on} onChange={(value) => send({ type: 'setSystem', key: 'fullAutoAllowed', value })} />
        </div>
        <p class="hint">Off: chats on Full auto still ask before they touch your computer. Reading the clipboard, window screenshots and terminal-like apps always ask.</p>
        <p class="acct-note">
          <Button variant="link" onClick={() => send({ type: 'systemLog' })}>
            Show the action log
          </Button>
        </p>
      </div>
    </section>
  );
}

function Switch({ label, on, disabled, onChange }: { label: string; on: boolean; disabled?: boolean; onChange: (on: boolean) => void }) {
  return <Toggle checked={on} label={label} disabled={disabled} onChange={onChange} />;
}

function Card({ card, focused }: { card: AccountCard; focused: boolean }) {
  const r = card.record;
  const status = card.checking ? 'checking' : (r?.status ?? 'unknown');
  const vendor = card.agent !== 'demo';
  return (
    <section id={`card-${card.agent}`} class="acct-card" data-focused={focused ? '' : undefined} tabIndex={-1} aria-labelledby={`title-${card.agent}`}>
      <div class="acct-top">
        <Glyph agent={card.agent} size="lg" />
        <div class="grow">
          <h2 id={`title-${card.agent}`}>
            {card.name}
            {r?.version && <span class="hint acct-version"> {r.version}</span>}
          </h2>
          <div class="acct-active hint">{card.active ?? (!vendor ? 'A fake local agent: no account, no network.' : r?.status === 'needs-sign-in' ? 'Not signed in.' : 'Not known yet which way it signs in.')}</div>
        </div>
        <span class="acct-status" data-state={status}>
          <span class="signin-mark" data-state={status} aria-hidden="true" />
          {card.checking ? 'Checking…' : !r ? 'Not checked' : !vendor && r.status === 'signed-in' ? 'Ready' : SIGN_IN_TEXT[r.status]}
        </span>
        <Button icon="history" size="sm" disabled={card.checking} onClick={() => send({ type: 'check', agent: card.agent })} title="Starts the agent and a short session, then stops using it">
          Check
        </Button>
      </div>
      {r && <div class="hint acct-when">Checked {age(r.at, Date.now())} ago</div>}
      {card.busy && <div class="acct-note" role="status">{card.busy}</div>}
      {r?.message && r.status !== 'signed-in' && <div class="acct-note warn">{r.message.split('\n')[0]}</div>}
      {r?.update && <div class="acct-note warn">{r.update}</div>}
      {vendor && card.installCommand && (r?.status === 'not-installed' || !r) && (
        <Block title={r?.status === 'not-installed' ? 'Install' : 'Not installed yet?'}>
          <Line agent={card.agent as VendorKey} what="install" line={{ command: card.installCommand }} />
        </Block>
      )}
      {vendor && r?.status !== 'not-installed' && <SignIn card={card} />}
      {vendor && r?.status !== 'not-installed' && <SignOut card={card} />}
      {r?.status !== 'not-installed' && <Models card={card} />}
    </section>
  );
}

function Block({ title, children }: { title: string; children: ComponentChildren }) {
  return (
    <div class="acct-block">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

function SignIn({ card }: { card: AccountCard }) {
  const r = card.record;
  return (
    <Block title="Sign in">
      {card.signIn.length > 0 ? (
        <div class="actions">
          {card.signIn.map((m) => (
            <Button key={m.id} size="sm" variant={r?.status === 'needs-sign-in' ? 'primary' : 'secondary'} title={m.description} onClick={() => send({ type: 'signIn', agent: card.agent, methodId: m.id })}>
              {m.name} <span class="fl-btn__sub acct-kind">{KIND_TEXT[m.kind]}</span>
            </Button>
          ))}
        </div>
      ) : (
        <p class="hint">{r ? `${card.name} offered no browser or terminal sign-in.` : `Check to see the ways ${card.name} offers to sign in.`}</p>
      )}
      {card.keys.map((k) => (
        <KeyRow key={k.id} card={card} k={k} />
      ))}
      {card.envKey && !card.keys.some((k) => k.active) && <p class="hint">{card.envKey} is set in the editor’s environment, so {card.name} gets it.</p>}
      {card.cli && (
        <div class="acct-cli">
          <span class="hint">Or its own CLI: </span>
          <Line agent={card.agent as VendorKey} what="signIn" line={card.cli.signIn} />
          <p class="hint">{card.cli.note}</p>
        </div>
      )}
    </Block>
  );
}

function KeyRow({ card, k }: { card: AccountCard; k: KeyView }) {
  const set = k.fields.filter((f) => f.set);
  return (
    <div class="acct-key" data-active={k.active ? '' : undefined}>
      <div class="grow">
        <div>
          <Icon name="key" size={14} /> {k.name}
          {k.active && <span class="acct-tag">in use</span>}
        </div>
        <div class="hint">{k.description}</div>
        <div class="hint mono acct-fields">
          {k.fields.map((f) => (
            <span key={f.env}>
              {f.env}: {f.set ? (f.secret ? 'set' : f.value) : 'not set'}
            </span>
          ))}
        </div>
      </div>
      <Button size="sm" onClick={() => send({ type: 'setKey', agent: card.agent as VendorKey, setup: k.id })}>
        {set.length ? 'Change…' : 'Set…'}
      </Button>
      {k.active && (
        <Button size="sm" onClick={() => send({ type: 'clearKey', agent: card.agent as VendorKey })}>
          Remove
        </Button>
      )}
    </div>
  );
}

function SignOut({ card }: { card: AccountCard }) {
  const r = card.record;
  if (!card.cli || r?.status !== 'signed-in') return null;
  return (
    <Block title="Sign out">
      {r.logout && (
        <div class="actions">
          <Button size="sm" disabled={!!card.busy} onClick={() => send({ type: 'signOut', agent: card.agent })}>
            Sign out of {card.name}
          </Button>
          <span class="hint">{card.name} signs itself out.</span>
        </div>
      )}
      <div class="acct-cli">
        <span class="hint">{r.logout ? 'Or with its CLI: ' : 'With its own CLI: '}</span>
        <Line agent={card.agent as VendorKey} what="signOut" line={card.cli.signOut} />
      </div>
      {card.keys.some((k) => k.active) && <p class="hint">A key saved here keeps working until you remove it above.</p>}
    </Block>
  );
}

/** One of FriedLiver's own lines for a terminal, with Copy and Run. */
function Line({ agent, what, line }: { agent: VendorKey; what: CliWhat; line: CliLine }) {
  return (
    <span class="acct-line">
      <code>{line.command}</code>
      <IconButton icon="copy" label={`Copy ${line.command}`} muted size="sm" title="Copy" onClick={() => send({ type: 'copy', agent, what })} />
      <Button variant="quiet" icon="terminal" size="sm" title="Runs it in a new terminal" onClick={() => send({ type: 'terminal', agent, what })}>
        Run in terminal
      </Button>
      {line.then && <span class="hint">{line.then}</span>}
    </span>
  );
}

function Models({ card }: { card: AccountCard }) {
  const known = card.model || card.effort;
  return (
    <Block title="Models">
      {known ? (
        <div class="acct-models">
          {card.model && <Choice card={card} option={card.model} k="model" label="Model" />}
          {card.effort && <Choice card={card} option={card.effort} k="thought_level" label="Effort" />}
          <Button icon="history" size="sm" disabled={card.checking} onClick={() => send({ type: 'check', agent: card.agent })} title="Starts the agent and a short session to read its models">
            Refresh
          </Button>
        </div>
      ) : (
        <div class="actions">
          <span class="hint">No models known yet. They come from the agent: start a chat, or</span>
          <Button size="sm" disabled={card.checking} onClick={() => send({ type: 'check', agent: card.agent })}>
            Refresh
          </Button>
        </div>
      )}
      {known && (
        <p class="hint">
          What {card.name}’s new chats start with, as under the message box; its last session offered these.
          {card.model && card.effort ? ' Effort levels can change with the model.' : ''}
        </p>
      )}
    </Block>
  );
}

/** A default for new chats, as our menu (like the composer's and the Agent Manager's pickers, not a native select). */
function Choice({ card, option, k, label }: { card: AccountCard; option: SessionOption; k: DefaultKey; label: string }) {
  const value = String(card.chosen[k] ?? option.current);
  const name = option.choices.find((c) => c.value === value)?.name ?? value;
  const groups = [...new Set(option.choices.map((c) => c.group))];
  return (
    <div class="acct-choice">
      <span class="hint">{label}</span>
      <Popover
        label={`${label} for ${card.name}`}
        title={`${card.name} ${label}: ${name}`}
        buttonClass="fl-select fl-select--sm"
        trigger={selectTrigger(name)}
      >
        {(close) =>
          groups.map((g) => (
            <Fragment key={g ?? ''}>
              {g && (
                <div class="fl-menu__title" aria-hidden="true">
                  {g}
                </div>
              )}
              {option.choices
                .filter((c) => c.group === g)
                .map((c) => (
                  <MenuItem
                    key={c.value}
                    label={c.name}
                    checked={c.value === value}
                    value={c.value}
                    title={c.description}
                    onSelect={() => {
                      close();
                      send({ type: 'setDefault', agent: card.agent, key: k, value: c.value });
                    }}
                  />
                ))}
            </Fragment>
          ))
        }
      </Popover>
    </div>
  );
}

const MAC = /Mac/.test(navigator.platform);

render(<Page />, document.getElementById('root')!);
