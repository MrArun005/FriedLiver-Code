// Agents & Accounts (host/accountsPage.ts): a card per agent with its sign-in,
// keys, its CLI's own login and the model and effort new chats start with.
// The page shows what the host sends and asks it to act; it never sees a key.
import { Fragment, render, type ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { SIGN_IN_TEXT, type AccountCard, type AccountsView, type CliLine, type CliWhat, type DefaultKey, type KeyView, type LineKey, type MethodView, type VendorKey } from '../shared/accounts';
import { AGENT_EXAMPLE, AGENT_GLYPHS, EMPTY_DRAFT, idFromName, looksSecret, validateDraft, type AgentDraft, type AgentTestResult, type DraftErrors, type EnvRow } from '../shared/agentForm';
import { age, setCustomAgents, type AgentKey } from '../shared/model';
import type { SessionOption } from '../shared/session';
import { NEVER_ALWAYS, SYSTEM_TOOLS, SYSTEM_WORDS, unsupportedOn, type SystemSettingsView } from '../shared/system';
import { Glyph, Icon, Popover, send } from './common';
import { AgentMark, BrandMark, Button, Field, IconButton, Input, MarkSvg, MenuItem, Segmented, selectTrigger, Toggle } from './ui';

const KIND_TEXT: Record<MethodView['kind'], string> = { browser: 'in your browser', terminal: 'in a terminal', key: 'API key' };

function Page() {
  const [view, setView] = useState<AccountsView | null>(null);
  /** The form, open on a new agent or on one being edited. */
  const [form, setForm] = useState<{ draft: AgentDraft; editing?: string; n: number } | null>(null);
  const scrolled = useRef(0);
  const formShown = useRef(0);
  useEffect(() => {
    const listener = (e: MessageEvent) => {
      const m = e.data as { type?: string; view?: AccountsView };
      if (m?.type === 'accounts' && m.view) {
        // Custom agents' names and marks, for the cards' glyphs.
        setCustomAgents(m.view.custom ?? []);
        setView(m.view);
      }
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

  // "Add Agent…" from a picker or the command palette: the form, once per opening.
  useEffect(() => {
    if (!view?.form || view.form === formShown.current) return;
    formShown.current = view.form;
    setForm({ draft: EMPTY_DRAFT, n: view.form });
  }, [view?.form]);
  useEffect(() => {
    if (form) document.getElementById('agent-form')?.scrollIntoView({ block: 'start' });
  }, [form?.n, form?.editing]);
  const jump = (agent: AgentKey) => {
    setForm(null);
    requestAnimationFrame(() => document.getElementById(`card-${agent}`)?.scrollIntoView({ block: 'start' }));
  };

  if (!view) return <div class="acct-page" />;
  const taken = (view.custom ?? []).map((c) => c.id);
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
      {form ? (
        <AgentForm key={`${form.n}-${form.editing ?? ''}`} initial={form.draft} editing={form.editing} taken={taken.filter((id) => id !== form.editing)} onJump={jump} onClose={() => setForm(null)} />
      ) : (
        <div class="acct-add">
          <Button icon="plus" onClick={() => setForm({ draft: EMPTY_DRAFT, n: Date.now() })}>
            Add an agent
          </Button>
          <span class="hint">Any program that speaks ACP: OpenCode and GitHub Copilot are built in below.</span>
        </div>
      )}
      {view.cards.map((card) => (
        <Card key={card.agent} card={card} focused={view.focus?.agent === card.agent} onEdit={card.custom ? () => setForm({ draft: card.custom!, editing: card.custom!.id, n: Date.now() }) : undefined} />
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

function Card({ card, focused, onEdit }: { card: AccountCard; focused: boolean; onEdit?: () => void }) {
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
        {onEdit && (
          <>
            <Button size="sm" onClick={onEdit}>
              Edit
            </Button>
            <Button size="sm" variant="quiet" onClick={() => send({ type: 'removeAgent', agent: card.agent as `custom:${string}` })} title="Asks first. Its chats stay.">
              Remove
            </Button>
          </>
        )}
      </div>
      {r && <div class="hint acct-when">Checked {age(r.at, Date.now())} ago</div>}
      {card.busy && <div class="acct-note" role="status">{card.busy}</div>}
      {r?.message && r.status !== 'signed-in' && <div class="acct-note warn">{r.message.split('\n')[0]}</div>}
      {r?.update && <div class="acct-note warn">{r.update}</div>}
      {vendor && card.installCommand && (r?.status === 'not-installed' || !r) && (
        <Block title={r?.status === 'not-installed' ? 'Install' : 'Not installed yet?'}>
          <Line agent={card.agent as LineKey} what="install" line={{ command: card.installCommand }} />
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
      {card.hint && <p class="hint">{card.hint}</p>}
      {card.cli?.signIn && (
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
function Line({ agent, what, line }: { agent: LineKey; what: CliWhat; line: CliLine }) {
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

const GLYPH_NAMES: Record<(typeof AGENT_GLYPHS)[number], string> = { agent: 'Robot', terminal: 'Terminal', hexagon: 'Hexagon', spark: 'Spark' };
const EXAMPLE_JSON = `"friedliver.agents.custom": [\n  ${JSON.stringify(AGENT_EXAMPLE).replace(/,"/g, ', "').replace(/":/g, '": ')}\n]`;

/**
 * "Add an agent": a custom ACP agent into the user's friedliver.agents.custom. The host checks it all again
 * and keeps variables that look like keys in SecretStorage. Test connection starts it once, in an empty folder.
 */
function AgentForm({ initial, editing, taken, onJump, onClose }: { initial: AgentDraft; editing?: string; taken: string[]; onJump(agent: AgentKey): void; onClose(): void }) {
  const [d, setD] = useState<AgentDraft>(initial);
  const [idEdited, setIdEdited] = useState(!!editing);
  const [tried, setTried] = useState(false);
  const [hostErrors, setHostErrors] = useState<DraftErrors>({});
  const [test, setTest] = useState<AgentTestResult | 'running' | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const listener = (e: MessageEvent) => {
      const m = e.data as { type?: string; ok?: boolean; errors?: DraftErrors; result?: AgentTestResult };
      if (m?.type === 'agentTest' && m.result) setTest(m.result);
      if (m?.type === 'agentSaved') {
        setSaving(false);
        if (m.ok) onClose();
        else setHostErrors(m.errors ?? {});
      }
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, []);
  const set = (patch: Partial<AgentDraft>) => {
    setHostErrors({});
    setD((x) => ({ ...x, ...patch, ...(!idEdited && patch.name !== undefined && !editing ? { id: idFromName(patch.name) } : {}) }));
  };
  const setRow = (i: number, patch: Partial<EnvRow>) => set({ env: d.env.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const errors = { ...(tried ? validateDraft(d, taken) : {}), ...hostErrors };
  const save = () => {
    setTried(true);
    if (Object.keys(validateDraft(d, taken)).length) return;
    setSaving(true);
    send({ type: 'saveAgent', draft: d, ...(editing ? { editing } : {}) });
  };
  return (
    <section id="agent-form" class="acct-card acct-form" aria-labelledby="agent-form-title" tabIndex={-1}>
      <div class="acct-top">
        <span class="fl-avatar fl-avatar--lg fl-avatar--mark" aria-hidden="true">
          <span class="fl-mark">
            <MarkSvg agent="" glyph={d.glyph} />
          </span>
        </span>
        <h2 id="agent-form-title" class="grow">
          {editing ? `Edit ${initial.name || editing}` : 'Add an agent'}
        </h2>
        <IconButton icon="close" label="Close the form" muted size="sm" onClick={onClose} />
      </div>
      {!editing && (
        <div class="acct-block">
          <h3>Start from</h3>
          <div class="actions">
            <Button size="sm" onClick={() => onJump('opencode')} title="Built in: install and sign in on its card">
              <AgentMark agent="opencode" /> OpenCode
            </Button>
            <Button size="sm" onClick={() => onJump('copilot')} title="Built in: install and sign in on its card">
              <AgentMark agent="copilot" /> GitHub Copilot
            </Button>
            <Button size="sm" variant="primary" aria-pressed="true">
              Other ACP agent
            </Button>
          </div>
          <p class="hint">OpenCode and GitHub Copilot are built in: their cards below install and sign them in. Any other program that speaks ACP on stdin and stdout goes here.</p>
        </div>
      )}
      <div class="acct-block acct-form-grid">
        <Field label="Name" error={errors.name}>
          <Input value={d.name} placeholder="Qwen Code" onInput={(e) => set({ name: e.currentTarget.value })} />
        </Field>
        <Field label="ID" help={editing ? 'An agent keeps its id: chats find it by that.' : `What @ mentions it: @${d.id || 'id'}`} error={errors.id}>
          <Input
            value={d.id}
            placeholder="qwen"
            disabled={!!editing}
            onInput={(e) => {
              setIdEdited(true);
              set({ id: e.currentTarget.value.toLowerCase() });
            }}
          />
        </Field>
        <Field label="Command" help="The program, by name on your PATH or its full path. No shell: it is started directly." error={errors.command}>
          <Input class="mono" value={d.command} placeholder="qwen" onInput={(e) => set({ command: e.currentTarget.value })} />
        </Field>
        <Field label="Arguments" help={'Separated by spaces; "quote" one with spaces in it.'} error={errors.args}>
          <Input class="mono" value={d.args} placeholder="--acp" onInput={(e) => set({ args: e.currentTarget.value })} />
        </Field>
        <Field label="Install line (optional)" help="Shown on its card with Copy and Run in terminal." error={errors.install}>
          <Input class="mono" value={d.install} placeholder="npm install -g @qwen-code/qwen-code" onInput={(e) => set({ install: e.currentTarget.value })} />
        </Field>
        <Field label="Sign-in hint (optional)" error={errors.signIn}>
          <Input value={d.signIn} placeholder="Run qwen in a terminal and type /auth." onInput={(e) => set({ signIn: e.currentTarget.value })} />
        </Field>
      </div>
      <div class="acct-block">
        <h3>Environment variables (optional)</h3>
        {d.env.map((row, i) => {
          const secret = row.secret || row.saved || looksSecret(row.name, row.value);
          return (
            <div key={i} class="acct-key acct-env">
              <Input class="mono" aria-label="Variable name" value={row.name} placeholder="NAME" onInput={(e) => setRow(i, { name: e.currentTarget.value })} />
              <Input
                class="mono grow"
                aria-label={`Value of ${row.name || 'the variable'}`}
                type={secret ? 'password' : 'text'}
                value={row.value}
                placeholder={row.saved ? 'Saved; leave empty to keep it' : 'value'}
                onInput={(e) => setRow(i, { value: e.currentTarget.value })}
              />
              {secret && (
                <span class="acct-tag" title="Kept in the editor’s secret storage, not in settings">
                  <Icon name="key" size={12} /> secret
                </span>
              )}
              <IconButton icon="close" label={`Remove ${row.name || 'this variable'}`} muted size="sm" onClick={() => set({ env: d.env.filter((_, j) => j !== i) })} />
            </div>
          );
        })}
        {errors.env && <p class="fl-field__help" data-tone="error">{errors.env}</p>}
        <Button size="sm" variant="quiet" icon="plus" onClick={() => set({ env: [...d.env, { name: '', value: '', secret: false }] })}>
          Add a variable
        </Button>
        <p class="hint">Names or values that look like keys (…_KEY, …_TOKEN, sk-…) go to the editor’s secret storage; the rest to your user settings.</p>
      </div>
      <div class="acct-block">
        <h3>Mark</h3>
        <Segmented
          label="Mark"
          value={d.glyph}
          onChange={(glyph) => set({ glyph })}
          options={AGENT_GLYPHS.map((g) => ({ value: g, title: GLYPH_NAMES[g], label: <><span class="fl-mark" aria-hidden="true"><MarkSvg agent="" glyph={g} /></span> {GLYPH_NAMES[g]}</> }))}
        />
      </div>
      <div class="acct-block">
        <h3>Example</h3>
        <pre class="acct-example mono">{EXAMPLE_JSON}</pre>
        <p class="hint">Saving writes this to your user settings.json (never a workspace’s). You can write it there by hand too: id, command and args, plus name, env, install, signIn and glyph if you like.</p>
      </div>
      {test && (
        <div class="acct-block" role="status">
          <h3>Test connection</h3>
          {test === 'running' ? (
            <p class="hint">Starting it in an empty folder…</p>
          ) : test.ok ? (
            <>
              <p>
                <Icon name="check" size={14} /> {test.agent ?? 'The agent'} answered over ACP.{' '}
                {test.needsSignIn ? 'It needs a sign-in first.' : test.modelCount ? `It offers ${test.modelCount} model${test.modelCount === 1 ? '' : 's'}.` : 'It reported no models.'}
              </p>
              {test.models.length > 0 && <p class="hint">Models: {test.models.join(', ')}{test.modelCount > test.models.length ? ', …' : ''}</p>}
              {test.modes.length > 0 && <p class="hint">Modes: {test.modes.join(', ')}</p>}
              {test.signIn.length > 0 && <p class="hint">Sign-in: {test.signIn.join(', ')}</p>}
            </>
          ) : (
            <p class="acct-note warn">{test.error}</p>
          )}
        </div>
      )}
      <div class="acct-block actions">
        <Button
          icon="history"
          disabled={test === 'running' || !d.command.trim()}
          onClick={() => {
            setTest('running');
            send({ type: 'testAgent', draft: d, ...(editing ? { editing } : {}) });
          }}
          title="Starts it once in an empty folder: ACP initialize and a session, no prompt"
        >
          Test connection
        </Button>
        <span class="grow" />
        <Button variant="quiet" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" loading={saving} onClick={save}>
          {editing ? 'Save' : 'Add agent'}
        </Button>
      </div>
    </section>
  );
}

render(<Page />, document.getElementById('root')!);
