// The composer's bottom-row menus: Select a model, Modes, the / menu, and the
// Agent map. Each opens above the composer (the map is a modal); Esc closes.
import { Fragment, type ComponentChildren } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Attachment } from '../shared/messages';
import { AGENT_FACES, type ChatView } from '../shared/model';
import { APPROVAL_HINTS, APPROVAL_NAMES, agentOverride, choiceName, formatCost, formatTokens, modeClass, modeOption, optionGroups, planToggle, planning, turnsLeft, usagePercent, type ApprovalLevel, type SessionOption } from '../shared/session';
import { FRIEDLIVER_COMMANDS, commandLabel, sameAgents, sameControls, shortDuration, slashMenu, subagents } from '../shared/view';
import { Dot, Icon, memo, scrollBehavior, send, useNow, type IconName } from './common';
import { agentName, chatTip } from '../shared/names';

export type ComposerMenu = 'slash' | 'model' | 'modes' | 'agents' | null;

/** Short names, as on the mode button. */
export const MODE_NAMES: Record<ApprovalLevel | 'plan', string> = { ...APPROVAL_NAMES, plan: 'Plan' };
const MODE_ICONS: Record<ApprovalLevel | 'plan', IconName> = { ask: 'hand', edits: 'code', plan: 'plan', full: 'bolt' };

export function currentMode(chat: Pick<ChatView, 'approval' | 'session'>): ApprovalLevel | 'plan' {
  return planning(chat.session) ? 'plan' : (chat.approval ?? 'ask');
}

function modeHint(mode: ApprovalLevel | 'plan', agent: string): string {
  if (mode === 'ask') return `${agent} will ask for approval before making each edit`;
  if (mode === 'edits') return `${agent} will make edits without asking; commands still wait for you`;
  if (mode === 'plan') return `${agent} will explore the code and present a plan before editing`;
  return `${agent} will run edits and commands without asking`;
}

/** The model as the pill names it: "Default (recommended)" names the model it resolves to ("Opus 5.5 · Best for…"). */
export function modelLabel(model: SessionOption | undefined): string | undefined {
  const name = choiceName(model);
  const picked = model?.type === 'select' ? model.choices.find((c) => c.value === model.current) : undefined;
  const resolved = name && /^default\b/i.test(name) ? picked?.description?.match(/^([^·]+?)\s+·/)?.[1] : undefined;
  return resolved ?? name;
}

/** The model pill's tooltip: model, effort, context, cost and the turns-left estimate. */
export function usageTitle(chat: ChatView, samples: number[]): string {
  const { model, effort } = optionGroups(chat.session);
  const usage = chat.session?.usage;
  const parts = [[choiceName(model), choiceName(effort)].filter(Boolean).join(' · ') || 'Model'];
  if (usage) {
    parts.push(`Context ${usagePercent(usage)}% · ${formatTokens(Math.max(0, usage.size - usage.used))} of ${formatTokens(usage.size)} tokens left`);
    if (usage.cost) parts.push(`${formatCost(usage.cost)} this chat`);
    const turns = turnsLeft(samples, usage.size);
    parts.push(turns === undefined ? 'Context lasts — (needs a couple of turns to estimate)' : `Context lasts ~${turns} more turns (estimate)`);
  }
  return parts.join('\n');
}

/** Effort as a slider: a thumb on a 76px track with a notch per level; arrows, Home/End, a click or a drag set it. */
export function EffortRow({ chat, icon }: { chat: ChatView; icon?: boolean }) {
  const [drag, setDrag] = useState<number | null>(null);
  const { effort } = optionGroups(chat.session);
  if (!effort || effort.type !== 'select' || !effort.choices.length) return null;
  const n = effort.choices.length;
  const clamp = (i: number) => Math.max(0, Math.min(n - 1, i));
  const current = Math.max(0, effort.choices.findIndex((c) => c.value === effort.current));
  // While dragging, the thumb shows where it is; the agent hears once, on release.
  const at = drag ?? current;
  const set = (i: number) => {
    const c = effort.choices[clamp(i)];
    if (c.value !== effort.current) send({ type: 'setOption', chatId: chat.id, optionId: effort.id, value: c.value });
  };
  const fromPointer = (e: PointerEvent) => {
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return clamp(Math.round(((e.clientX - box.left - 9) / Math.max(1, box.width - 18)) * (n - 1)));
  };
  const name = choiceName(effort, effort.choices[at].value);
  return (
    <div class="cc-item cc-effort">
      {icon && <Icon name="gauge" size={20} />}
      <span class="cc-item-name">
        Effort <span class="cc-item-value">({name})</span>
      </span>
      <span
        class="cc-slider"
        role="slider"
        tabIndex={0}
        aria-label="Effort"
        aria-valuemin={0}
        aria-valuemax={n - 1}
        aria-valuenow={at}
        aria-valuetext={name}
        style={{ '--at': n > 1 ? at / (n - 1) : 0 }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          setDrag(fromPointer(e));
        }}
        onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && setDrag(fromPointer(e))}
        onPointerUp={(e) => {
          set(fromPointer(e));
          setDrag(null);
        }}
        onPointerCancel={() => setDrag(null)}
        onKeyDown={(e) => {
          const step = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[e.key];
          if (step !== undefined) set(at + step);
          else if (e.key === 'Home') set(0);
          else if (e.key === 'End') set(n - 1);
          else return;
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        {effort.choices.map((c, i) => (
          <span key={c.value} class="cc-notch" style={{ '--i': n > 1 ? i / (n - 1) : 0 }} title={c.name} />
        ))}
        <span class="cc-thumb" />
      </span>
    </div>
  );
}

const TOGGLE_ICONS: Record<string, IconName> = { ultracode: 'rocket', fast: 'bolt', 'fast-mode': 'bolt' };

function ToggleRow({ chat, option, icon }: { chat: ChatView; option: SessionOption; icon?: boolean }) {
  const on = option.current === true;
  return (
    <div class="cc-item cc-toggle-row">
      {icon && <Icon name={TOGGLE_ICONS[option.id] ?? 'model'} size={20} />}
      <span class="cc-item-name" title={option.description}>
        {option.name}
      </span>
      <button type="button" role="switch" aria-checked={on} aria-label={option.name} class="cc-switch" onClick={() => send({ type: 'setOption', chatId: chat.id, optionId: option.id, value: !on })} />
    </div>
  );
}

const Divider = () => <div class="cc-divider" role="separator" />;

/** Up/Down move through a menu's items; Esc closes. */
function useMenuKeys(close: () => void) {
  const panel = useRef<HTMLDivElement>(null);
  // Before paint, so a key pressed right after opening already lands in the menu.
  useLayoutEffect(() => {
    panel.current?.querySelector<HTMLElement>('input, [aria-checked="true"], [role^="menuitem"]')?.focus();
  }, []);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...(panel.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
    if (!items.length) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  };
  return { panel, onKeyDown };
}

type MenuProps = { chat: ChatView; close: () => void };

export function ModelMenu({ chat, close }: MenuProps) {
  const { panel, onKeyDown } = useMenuKeys(close);
  const { model, modelConfig, other } = optionGroups(chat.session);
  const pick = model ?? [...modelConfig, ...other].find((o) => o.type === 'select');
  const toggles = [...modelConfig, ...other].filter((o) => o.type === 'boolean');
  return (
    <div ref={panel} class="cc-menu cc-model-menu" role="menu" aria-label="Select a model" onKeyDown={onKeyDown}>
      <div class="cc-menu-title">Select a model</div>
      <div class="cc-menu-list">
        {pick?.choices.map((c) => (
          <button
            key={c.value}
            role="menuitemradio"
            aria-checked={pick.current === c.value}
            class="cc-item"
            onClick={() => {
              send({ type: 'setOption', chatId: chat.id, optionId: pick.id, value: c.value });
              close();
            }}
          >
            <span class="cc-item-text">
              <span class="cc-item-name">{c.name}</span>
              {c.description && <span class="cc-item-desc">{c.description}</span>}
            </span>
            {pick.current === c.value && <Icon name="check" size={16} />}
          </button>
        ))}
        {!pick && <div class="cc-empty">{chat.session?.live ? `${agentName(chat.agent)} offers no model choice` : `${agentName(chat.agent)} is starting…`}</div>}
      </div>
      <Divider />
      <EffortRow chat={chat} />
      {toggles.map((o) => (
        <ToggleRow key={o.id} chat={chat} option={o} />
      ))}
    </div>
  );
}

export function ModesMenu({ chat, close }: MenuProps) {
  const { panel, onKeyDown } = useMenuKeys(close);
  const agent = AGENT_FACES[chat.agent].name;
  // The agent's own, more permissive mode wins the check: the rows must not claim Manual while it bypasses.
  const override = agentOverride(chat.approval ?? 'ask', chat.session);
  const now = override ? (override.cls === 'auto' ? 'full' : null) : currentMode(chat);
  const inPlan = planning(chat.session);
  const plan = planToggle(chat.session);
  const own = modeOption(chat.session);
  // The agent's modes the four rows don't cover (e.g. Bypass permissions), behind More modes….
  const extra = own?.type === 'select' ? own.choices.filter((c) => !['ask', 'edits', 'plan', 'auto'].includes(modeClass(c) ?? '')) : [];
  const [more, setMore] = useState(() => extra.some((c) => c.value === own?.current));
  const modes: (ApprovalLevel | 'plan')[] = plan ? ['ask', 'edits', 'plan', 'full'] : ['ask', 'edits', 'full'];
  const pick = (m: ApprovalLevel | 'plan') => {
    if (m === 'plan') send({ type: 'plan', chatId: chat.id, on: !inPlan });
    else {
      if (inPlan) send({ type: 'plan', chatId: chat.id, on: false });
      send({ type: 'approval', chatId: chat.id, level: m });
    }
    close();
  };
  const { modelConfig, other } = optionGroups(chat.session);
  const toggles = [...modelConfig, ...other].filter((o) => o.type === 'boolean');
  return (
    <div ref={panel} class="cc-menu cc-modes-menu" role="menu" aria-label="Modes" onKeyDown={onKeyDown}>
      <div class="cc-menu-title">
        Modes
        <span class="cc-keys" aria-label="Shift+Tab to switch">
          <kbd>⇧</kbd> + <kbd>tab</kbd> to switch
        </span>
      </div>
      {modes.map((m) => (
        <button key={m} role="menuitemradio" aria-checked={now === m} class="cc-item" title={m === 'plan' ? undefined : APPROVAL_HINTS[m]} onClick={() => pick(m)}>
          <Icon name={MODE_ICONS[m]} size={20} />
          <span class="cc-item-text">
            <span class="cc-item-name">{MODE_NAMES[m]}</span>
            <span class="cc-item-desc">{modeHint(m, agent)}</span>
          </span>
          {now === m && <Icon name="check" size={16} />}
        </button>
      ))}
      <Divider />
      <EffortRow chat={chat} icon />
      {toggles.map((o) => (
        <ToggleRow key={o.id} chat={chat} option={o} icon />
      ))}
      {extra.length > 0 && (
        <>
          <Divider />
          <button role="menuitem" class="cc-item cc-more-btn" aria-expanded={more} onClick={() => setMore(!more)}>
            <Icon name="more" size={20} />
            <span class="cc-item-name">More modes…</span>
            <Icon name="chevron" size={16} />
          </button>
          {more &&
            extra.map((c) => (
              <button
                key={c.value}
                role="menuitemradio"
                aria-checked={own?.current === c.value}
                class="cc-item"
                title={c.description}
                onClick={() => {
                  send({ type: 'setOption', chatId: chat.id, optionId: own!.id, value: c.value });
                  close();
                }}
              >
                <Icon name={modeClass(c) === 'full' ? 'bolt' : 'shield'} size={20} />
                <span class="cc-item-text">
                  <span class="cc-item-name">{c.name}</span>
                  {c.description && <span class="cc-item-desc">{c.description}</span>}
                </span>
                {own?.current === c.value && <Icon name="check" size={16} />}
              </button>
            ))}
        </>
      )}
    </div>
  );
}

/** The / menu: a search box, then Context, Model and the agent's own commands. */
export function SlashMenu({ chat, close, mention, command, openModel }: MenuProps & { mention(): void; command(name: string, run?: boolean): void; openModel(): void }) {
  const { panel, onKeyDown } = useMenuKeys(close);
  const [query, setQuery] = useState('/');
  const q = query.replace(/^\//, '').trim().toLowerCase();
  const commands = chat.session?.commands ?? [];
  const { model, modelConfig, other } = optionGroups(chat.session);
  const toggles = [...modelConfig, ...other].filter((o) => o.type === 'boolean');
  const context = [
    { label: 'Attach file…', run: () => send({ type: 'attach', chatId: chat.id }) },
    { label: 'Mention file from this project…', run: mention },
    ...(commands.some((c) => c.name === 'clear') ? [{ label: 'Clear conversation', run: () => command('clear', true) }] : []),
    ...(chat.items.some((i) => i.kind === 'user' && i.checkpoint) ? [{ label: 'Rewind…', run: () => send({ type: 'rewind', chatId: chat.id }) }] : []),
  ].filter((i) => !q || i.label.toLowerCase().includes(q));
  const switchModel = !q || 'switch model'.includes(q);
  // One list for the / button and a typed /: FriedLiver's commands, then the agent's (shared/view.ts slashMenu).
  const listed = slashMenu(commands).filter((c) => !q || c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q));
  const ours = listed.filter((c) => FRIEDLIVER_COMMANDS.includes(c));
  const own = listed.filter((c) => !FRIEDLIVER_COMMANDS.includes(c));
  const item = (key: string, label: string, run: () => void, right?: string, desc?: string) => (
    <button
      key={key}
      role="menuitem"
      class="cc-item"
      title={desc}
      onClick={() => {
        close();
        run();
      }}
    >
      <span class="cc-item-text">
        <span class="cc-item-name">{label}</span>
        {desc && <span class="cc-item-hint">{desc}</span>}
      </span>
      {right && <span class="cc-item-value">{right}</span>}
    </button>
  );
  const sections = [
    ours.length > 0 && (
      <div key="ours" class="cc-menu-section">
        <div class="cc-menu-sub">FriedLiver</div>
        {ours.map((c) => item(`cmd-${c.name}`, commandLabel(c), () => command(c.name), undefined, c.description))}
      </div>
    ),
    context.length > 0 && (
      <div key="context" class="cc-menu-section">
        <div class="cc-menu-sub">Context</div>
        {context.map((i) => item(i.label, i.label, i.run))}
      </div>
    ),
    (switchModel || !q) && (
      <div key="model" class="cc-menu-section">
        <div class="cc-menu-sub">Model</div>
        {switchModel && item('switch-model', 'Switch model…', openModel, modelLabel(model))}
        {!q && <EffortRow chat={chat} />}
        {!q && toggles.map((o) => <ToggleRow key={o.id} chat={chat} option={o} />)}
      </div>
    ),
    own.length > 0 && (
      <div key="own" class="cc-menu-section">
        <div class="cc-menu-sub">{AGENT_FACES[chat.agent].name}</div>
        {own.map((c) => item(`cmd-${c.name}`, commandLabel(c), () => command(c.name), undefined, c.description))}
      </div>
    ),
  ].filter(Boolean);
  return (
    <div ref={panel} class="cc-menu cc-slash-menu" role="menu" aria-label="Commands" onKeyDown={onKeyDown}>
      <input
        class="cc-search"
        value={query}
        aria-label="Search commands"
        placeholder="Search commands"
        onInput={(e) => setQuery(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            panel.current?.querySelector<HTMLElement>('[role="menuitem"]')?.click();
          }
        }}
      />
      <ScrollList>
        {sections.map((section, i) => (
          <Fragment key={i}>
            {i > 0 && <Divider />}
            {section}
          </Fragment>
        ))}
        {!sections.length && <div class="cc-empty">No matching commands</div>}
      </ScrollList>
    </div>
  );
}

/** A menu's list that says when more is below: its end fades while it can scroll further. */
export function ScrollList({ children, class: extra }: { children: ComponentChildren; class?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  const measure = () => {
    const el = box.current;
    if (el) setMore(el.scrollHeight - el.scrollTop - el.clientHeight > 1);
  };
  useLayoutEffect(measure);
  return (
    <div ref={box} class={`cc-menu-list ${extra ?? ''}`} data-more={more ? '' : undefined} onScroll={measure}>
      {children}
    </div>
  );
}

/** Agent map: this chat on the left, its subagents, hand-offs and consultations on the right. */
export function AgentMap({ chat, linked, close }: { chat: ChatView; linked: ChatView[]; close: () => void }) {
  const now = useNow(1000);
  const dialog = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    dialog.current?.querySelector<HTMLElement>('.cc-map-close')?.focus();
    // Esc closes it wherever focus is.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [close]);
  const subs = subagents(chat);
  const usage = chat.session?.usage;
  const model = modelLabel(optionGroups(chat.session).model);
  const rows = [
    ...subs.map((s) => ({
      key: s.id,
      title: s.title,
      tip: s.title,
      state: s.state === 'working' ? 'working' : s.state === 'failed' ? 'error' : 'done',
      meta: [s.ms !== undefined ? shortDuration(s.ms) : s.startedAt !== undefined ? shortDuration(Math.max(0, now - s.startedAt)) : undefined, `${s.tools} tool call${s.tools === 1 ? '' : 's'}`].filter(Boolean).join(' · '),
      go: () => {
        close();
        const el = document.getElementById(`item-${s.id}`);
        el?.scrollIntoView({ block: 'center', behavior: scrollBehavior() });
        el?.querySelector<HTMLButtonElement>('.sa-head')?.focus({ preventScroll: true });
      },
    })),
    ...linked.map((c) => ({
      key: c.id,
      title: c.title,
      tip: chatTip(c),
      state: c.busy ? 'working' : 'done',
      meta: [shortDuration(Math.max(0, (c.busy ? now : c.lastActivity) - c.createdAt)), c.session?.usage ? `${formatTokens(c.session.usage.used)} tokens` : c.origin?.kind === 'consult' ? 'consultation' : 'hand-off'].join(' · '),
      go: () => {
        close();
        send({ type: 'openChat', chatId: c.id });
      },
    })),
  ];
  return (
    <div class="cc-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={dialog} class="cc-map" role="dialog" aria-modal="true" aria-label="Agent map">
        <div class="cc-map-head">
          <div class="cc-map-title">Agent map</div>
          <span class="cc-map-actions">
            <button
              type="button"
              class="ghost icon-btn sm cc-map-manager"
              aria-label="Open Agent Manager"
              title="Open Agent Manager"
              onClick={() => {
                close();
                send({ type: 'openTasks' });
              }}
            >
              <Icon name="tasks" />
            </button>
            <button type="button" class="ghost icon-btn sm cc-map-close" aria-label="Close" title="Close (Esc)" onClick={close}>
              <Icon name="close" />
            </button>
          </span>
        </div>
        <div class="cc-map-sub">
          {rows.length} agent{rows.length === 1 ? '' : 's'} · click an agent for details
        </div>
        <div class="cc-map-body">
          <div class="cc-map-tree">
            <div class="cc-map-node cc-map-main">
              <span class="cc-map-name">
                <Dot state={chat.busy ? 'working' : 'idle'} still={!chat.busy} />
                {chat.title}
              </span>
              <span class="cc-map-meta">{[model, usage ? `${formatTokens(usage.used)} tokens in context` : undefined].filter(Boolean).join(' · ') || agentName(chat.agent)}</span>
            </div>
            {rows.length > 0 && (
              <div class="cc-map-children">
                {rows.map((r) => (
                  <button key={r.key} type="button" class="cc-map-node" title={r.tip} onClick={r.go}>
                    <span class="cc-map-name">
                      <Dot state={r.state} still={r.state !== 'working'} />
                      {r.title}
                    </span>
                    <span class="cc-map-meta">{r.meta}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The bottom row's pills and mode button; redrawn only when what they show changes. */
export const ComposerPills = memo(function ComposerPills({
  chat,
  linked,
  samples,
  open,
}: {
  chat: ChatView;
  linked: ChatView[];
  samples: number[];
  open: (m: ComposerMenu) => void;
}) {
  const { model, effort } = optionGroups(chat.session);
  const subs = subagents(chat);
  const agents = subs.length + linked.length;
  const running = subs.filter((s) => s.state === 'working').length + linked.filter((c) => c.busy).length;
  return (
    <>
      <button type="button" class="cc-icon-btn cc-slash-btn" aria-label="Commands" title="Commands (/)" onClick={() => open('slash')}>
        <Icon name="slash" size={20} />
      </button>
      {agents > 0 && (
        <button type="button" class="cc-pill cc-agents" title={`${running} running · open the agent map`} aria-label={`${agents} agent${agents === 1 ? '' : 's'}, ${running} running: open the agent map`} onClick={() => open('agents')}>
          <Dot state={running ? 'working' : 'idle'} still />
          {agents} agent{agents === 1 ? '' : 's'}
        </button>
      )}
      <button type="button" class="cc-pill cc-model" title={usageTitle(chat, samples)} aria-label={`Model: ${usageTitle(chat, samples)}`} onClick={() => open('model')}>
        <span class="cc-pill-text">{modelLabel(model) ?? (chat.session?.starting ? 'Starting…' : AGENT_FACES[chat.agent].name)}</span>
        {effort && <span class="cc-pill-sub">{choiceName(effort)}</span>}
      </button>
    </>
  );
}, sameControlsAndAgents);

function sameControlsAndAgents<T extends { chat: ChatView; linked: ChatView[]; samples: number[] }>(a: T, b: T) {
  return sameControls(a, b) && sameAgents(a, b);
}

export const ModeButton = memo(function ModeButton({ chat, open }: { chat: ChatView; open: (m: ComposerMenu) => void; samples?: number[] }) {
  const m = currentMode(chat);
  const agent = AGENT_FACES[chat.agent].name;
  const override = agentOverride(chat.approval ?? 'ask', chat.session);
  if (override) {
    return (
      <button type="button" class="cc-mode" data-warn={override.tone} title={`${agent} is in ${override.name} — it won't ask. Click to change.`} aria-label={`Mode: ${override.name} (${agent}'s own mode, it won't ask)`} onClick={() => open('modes')}>
        <span class="cc-icon-box">
          <Icon name="bolt" size={18} />
        </span>
        {override.name}
      </button>
    );
  }
  return (
    <button type="button" class="cc-mode" data-mode={m} title={`${MODE_NAMES[m]}: ${modeHint(m, AGENT_FACES[chat.agent].name)}. Shift+Tab switches.`} aria-label={`Mode: ${MODE_NAMES[m]}`} onClick={() => open('modes')}>
      <span class="cc-icon-box">
        <Icon name={MODE_ICONS[m]} size={18} />
      </span>
      {m === 'edits' ? 'Edits' : MODE_NAMES[m]}
    </button>
  );
}, sameControls);

/** A long file name cut in the middle, so its end (what tells screenshots apart) stays. */
export function middleCut(name: string, max = 24): string {
  return name.length <= max ? name : `${name.slice(0, Math.ceil((max - 1) / 2))}…${name.slice(-Math.floor((max - 1) / 2))}`;
}

/** An image waiting to go: click previews it; its own × removes it. */
export function AttachmentChip({ a, onPreview, onRemove }: { a: Attachment; onPreview: () => void; onRemove: () => void }) {
  const [size, setSize] = useState('');
  return (
    <span class="cc-chip">
      <button type="button" class="cc-chip-open" title={a.name} aria-label={`Preview ${a.name}${size ? `, ${size}` : ''}`} onClick={onPreview}>
        <img src={`data:${a.mimeType};base64,${a.data}`} alt="" onLoad={(e) => setSize(`${e.currentTarget.naturalWidth}×${e.currentTarget.naturalHeight}`)} />
        <span class="cc-chip-name">{middleCut(a.name)}</span>
        {size && <span class="cc-chip-meta">{size}</span>}
      </button>
      <button type="button" class="cc-chip-remove" aria-label={`Remove ${a.name}`} title={`Remove ${a.name}`} onClick={onRemove}>
        <Icon name="close" size={12} />
      </button>
    </span>
  );
}
