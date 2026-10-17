// The composer's bottom-row menus: Select a model, Modes, the / menu, and the
// Agent map. Each opens above the composer (the map is a modal); Esc closes.
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Attachment } from '../shared/messages';
import { AGENT_FACES, type ChatView } from '../shared/model';
import { APPROVAL_HINTS, choiceName, formatCost, formatTokens, modeOption, optionGroups, planToggle, planning, turnsLeft, usagePercent, type ApprovalLevel, type SessionOption } from '../shared/session';
import { sameAgents, sameControls, shortDuration, subagents } from '../shared/view';
import { Dot, Icon, memo, scrollBehavior, send, useNow, type IconName } from './common';

export type ComposerMenu = 'slash' | 'model' | 'modes' | 'agents' | null;

/** Short names, as on the mode button. */
export const MODE_NAMES: Record<ApprovalLevel | 'plan', string> = { ask: 'Manual', edits: 'Edit automatically', plan: 'Plan', full: 'Auto' };
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

/** Effort as dots on a track: a slider, arrows step it. */
export function EffortRow({ chat, icon }: { chat: ChatView; icon?: boolean }) {
  const { effort } = optionGroups(chat.session);
  if (!effort || effort.type !== 'select' || !effort.choices.length) return null;
  const at = Math.max(0, effort.choices.findIndex((c) => c.value === effort.current));
  const set = (i: number) => {
    const c = effort.choices[Math.max(0, Math.min(effort.choices.length - 1, i))];
    if (c.value !== effort.current) send({ type: 'setOption', chatId: chat.id, optionId: effort.id, value: c.value });
  };
  return (
    <div class="cc-row cc-effort">
      {icon && <Icon name="gauge" />}
      <span class="cc-row-name">
        Effort <span class="cc-mute">({choiceName(effort)})</span>
      </span>
      <span
        class="cc-dots"
        role="slider"
        tabIndex={0}
        aria-label="Effort"
        aria-valuemin={0}
        aria-valuemax={effort.choices.length - 1}
        aria-valuenow={at}
        aria-valuetext={choiceName(effort)}
        onKeyDown={(e) => {
          const step = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[e.key];
          if (step !== undefined) set(at + step);
          else if (e.key === 'Home') set(0);
          else if (e.key === 'End') set(effort.choices.length - 1);
          else return;
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        {effort.choices.map((c, i) => (
          <span key={c.value} class="cc-dot" data-on={i === at ? '' : undefined} title={c.name} onClick={() => set(i)} />
        ))}
      </span>
    </div>
  );
}

function ToggleRow({ chat, option }: { chat: ChatView; option: SessionOption }) {
  const on = option.current === true;
  return (
    <div class="cc-row">
      <span class="cc-row-name" title={option.description}>
        {option.name}
      </span>
      <button type="button" role="switch" aria-checked={on} aria-label={option.name} class="cc-switch" onClick={() => send({ type: 'setOption', chatId: chat.id, optionId: option.id, value: !on })} />
    </div>
  );
}

/** Up/Down move through a menu's items; Esc closes. */
function useMenuKeys(close: () => void) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
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
      <div class="cc-menu-scroll">
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
            {pick.current === c.value && <Icon name="check" />}
          </button>
        ))}
        {!pick && <div class="cc-item-desc cc-pad">{chat.session?.live ? `${chat.label} offers no model choice` : `${chat.label} is starting…`}</div>}
      </div>
      <div class="cc-menu-foot">
        <EffortRow chat={chat} />
        {toggles.map((o) => (
          <ToggleRow key={o.id} chat={chat} option={o} />
        ))}
      </div>
    </div>
  );
}

export function ModesMenu({ chat, close }: MenuProps) {
  const { panel, onKeyDown } = useMenuKeys(close);
  const agent = AGENT_FACES[chat.agent].name;
  const now = currentMode(chat);
  const inPlan = now === 'plan';
  const plan = planToggle(chat.session);
  const own = modeOption(chat.session);
  const modes: (ApprovalLevel | 'plan')[] = plan ? ['ask', 'edits', 'plan', 'full'] : ['ask', 'edits', 'full'];
  const pick = (m: ApprovalLevel | 'plan') => {
    if (m === 'plan') send({ type: 'plan', chatId: chat.id, on: !inPlan });
    else {
      if (inPlan) send({ type: 'plan', chatId: chat.id, on: false });
      send({ type: 'approval', chatId: chat.id, level: m });
    }
    close();
  };
  return (
    <div ref={panel} class="cc-menu cc-modes-menu" role="menu" aria-label="Modes" onKeyDown={onKeyDown}>
      <div class="cc-menu-title">
        Modes
        <span class="cc-keys" aria-label="Shift+Tab to switch">
          <kbd>⇧</kbd> + <kbd>tab</kbd> to switch
        </span>
      </div>
      {modes.map((m) => (
        <button key={m} role="menuitemradio" aria-checked={now === m} class="cc-item cc-item-icon" title={m === 'plan' ? undefined : APPROVAL_HINTS[m]} onClick={() => pick(m)}>
          <Icon name={MODE_ICONS[m]} />
          <span class="cc-item-text">
            <span class="cc-item-name">{MODE_NAMES[m]}</span>
            <span class="cc-item-desc">{modeHint(m, agent)}</span>
          </span>
          {now === m && <Icon name="check" />}
        </button>
      ))}
      {own && own.type === 'select' && (
        <div class="cc-menu-section">
          <div class="cc-menu-sub">{agent}'s own modes</div>
          {own.choices.map((c) => (
            <button
              key={c.value}
              role="menuitemradio"
              aria-checked={own.current === c.value}
              class="cc-item cc-item-small"
              title={c.description}
              onClick={() => {
                send({ type: 'setOption', chatId: chat.id, optionId: own.id, value: c.value });
                close();
              }}
            >
              <span class="cc-item-name">{c.name}</span>
              {own.current === c.value && <Icon name="check" />}
            </button>
          ))}
        </div>
      )}
      <div class="cc-menu-foot">
        <EffortRow chat={chat} icon />
      </div>
    </div>
  );
}

/** The / menu: a search box, then Context, Model and the agent's own commands. */
export function SlashMenu({ chat, close, mention, command, openModel }: MenuProps & { mention(): void; command(name: string, run?: boolean): void; openModel(): void }) {
  const { panel, onKeyDown } = useMenuKeys(close);
  const [query, setQuery] = useState('/');
  const q = query.replace(/^\//, '').trim().toLowerCase();
  const commands = chat.session?.commands ?? [];
  const { model } = optionGroups(chat.session);
  const context = [
    { label: 'Attach file…', run: () => send({ type: 'attach', chatId: chat.id }) },
    { label: 'Mention file from this project…', run: mention },
    ...(commands.some((c) => c.name === 'clear') ? [{ label: 'Clear conversation', run: () => command('clear', true) }] : []),
  ].filter((i) => !q || i.label.toLowerCase().includes(q));
  const switchModel = !q || 'switch model'.includes(q);
  const own = commands.filter((c) => !q || c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q));
  const item = (key: string, label: string, run: () => void, right?: string, title?: string) => (
    <button
      key={key}
      role="menuitem"
      class="cc-item cc-item-line"
      title={title}
      onClick={() => {
        close();
        run();
      }}
    >
      <span class="cc-item-name">{label}</span>
      {right && <span class="cc-mute">{right}</span>}
    </button>
  );
  return (
    <div ref={panel} class="cc-menu cc-slash-menu" role="menu" aria-label="Commands" onKeyDown={onKeyDown}>
      <input
        class="cc-search"
        value={query}
        aria-label="Search commands"
        onInput={(e) => setQuery(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            panel.current?.querySelector<HTMLElement>('[role="menuitem"]')?.click();
          }
        }}
      />
      <div class="cc-menu-scroll">
        {context.length > 0 && (
          <div class="cc-menu-section">
            <div class="cc-menu-sub">Context</div>
            {context.map((i) => item(i.label, i.label, i.run))}
          </div>
        )}
        {(switchModel || !q) && (
          <div class="cc-menu-section">
            <div class="cc-menu-sub">Model</div>
            {switchModel && item('switch-model', 'Switch model…', openModel, choiceName(model))}
            {!q && <EffortRow chat={chat} />}
          </div>
        )}
        {own.length > 0 && (
          <div class="cc-menu-section">
            <div class="cc-menu-sub">{AGENT_FACES[chat.agent].name}</div>
            {own.map((c) => item(`cmd-${c.name}`, `/${c.name}`, () => command(c.name), undefined, c.description))}
          </div>
        )}
        {!context.length && !switchModel && !own.length && <div class="cc-item-desc cc-pad">No matching commands</div>}
      </div>
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
  const model = choiceName(optionGroups(chat.session).model);
  const rows = [
    ...subs.map((s) => ({
      key: s.id,
      title: s.title,
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
      title: `${c.label}: ${c.title}`,
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
      <div
        ref={dialog}
        class="cc-map"
        role="dialog"
        aria-modal="true"
        aria-label="Agent map"
      >
        <div class="cc-map-head">
          <div>
            <div class="cc-map-title">Agent map</div>
            <div class="cc-map-sub">
              {rows.length} agent{rows.length === 1 ? '' : 's'} · click an agent for details
            </div>
          </div>
          <button type="button" class="cc-map-close icon-btn" aria-label="Close" title="Close (Esc)" onClick={close}>
            <Icon name="close" />
          </button>
        </div>
        <div class="cc-map-body">
          <div class="cc-map-parent">
            <div class="cc-map-node">
              <Dot state={chat.busy ? 'working' : 'done'} still={!chat.busy} />
              <span class="cc-map-text">
                <span class="cc-map-name">{chat.title}</span>
                <span class="cc-map-meta">{[model, usage ? `${formatTokens(usage.used)} tokens in context` : undefined].filter(Boolean).join(' · ') || chat.label}</span>
              </span>
            </div>
          </div>
          <div class="cc-map-children">
            {rows.map((r) => (
              <button key={r.key} type="button" class="cc-map-node" onClick={r.go}>
                <Dot state={r.state} still={r.state !== 'working'} />
                <span class="cc-map-text">
                  <span class="cc-map-name">{r.title}</span>
                  <span class="cc-map-meta">{r.meta}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
        <div class="cc-map-foot">
          <button
            type="button"
            class="cc-map-manager"
            onClick={() => {
              close();
              send({ type: 'openTasks' });
            }}
          >
            Open Agent Manager
          </button>
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
        <Icon name="slash" />
      </button>
      {agents > 0 && (
        <button type="button" class="cc-pill cc-agents" title={`${running} running · open the agent map`} aria-label={`${agents} agent${agents === 1 ? '' : 's'}, ${running} running: open the agent map`} onClick={() => open('agents')}>
          <Dot state={running ? 'working' : 'done'} still={!running} />
          {agents} agent{agents === 1 ? '' : 's'}
        </button>
      )}
      <button type="button" class="cc-pill cc-model" title={usageTitle(chat, samples)} aria-label={`Model: ${usageTitle(chat, samples)}`} onClick={() => open('model')}>
        {choiceName(model) ?? (chat.session?.live ? AGENT_FACES[chat.agent].name : 'Starting…')}
        {effort && <span class="cc-mute">{choiceName(effort)}</span>}
      </button>
    </>
  );
}, sameControlsAndAgents);

function sameControlsAndAgents<T extends { chat: ChatView; linked: ChatView[]; samples: number[] }>(a: T, b: T) {
  return sameControls(a, b) && sameAgents(a, b);
}

export const ModeButton = memo(function ModeButton({ chat, open }: { chat: ChatView; open: (m: ComposerMenu) => void; samples?: number[] }) {
  const m = currentMode(chat);
  return (
    <button type="button" class="cc-mode" data-mode={m} title={`${MODE_NAMES[m]}: ${modeHint(m, AGENT_FACES[chat.agent].name)}. Shift+Tab switches.`} aria-label={`Mode: ${MODE_NAMES[m]}`} onClick={() => open('modes')}>
      <Icon name={MODE_ICONS[m]} />
      {m === 'edits' ? 'Edits' : MODE_NAMES[m]}
    </button>
  );
}, sameControls);

/** An image waiting to go: thumbnail, name and size; click removes it. */
export function AttachmentChip({ a, onRemove }: { a: Attachment; onRemove: () => void }) {
  const [size, setSize] = useState('');
  return (
    <button type="button" class="thumb cc-chip" title={`Remove ${a.name}`} onClick={onRemove}>
      <img src={`data:${a.mimeType};base64,${a.data}`} alt={a.name} onLoad={(e) => setSize(`${e.currentTarget.naturalWidth}×${e.currentTarget.naturalHeight}`)} />
      <span class="cc-chip-name">{a.name}</span>
      {size && <span class="cc-mute">{size}</span>}
    </button>
  );
}
