// Joining chats and agents: hand off, ask, pipe. The chat view and the Agent
// Manager share these, so a connection reads and works the same in both.
import { useContext, useState } from 'preact/hooks';
import { AGENT_FACES, AGENT_KEYS, type AgentKey, type ChatView } from '../shared/model';
import { clip, openChats } from '../shared/view';
import { Glyph, Icon, LiveState, Popover, radioKeys, send } from './common';

/** Text beside the icon, or the icon alone where room is short. */
function Trigger({ icon, text, compact }: { icon: Parameters<typeof Icon>[0]['name']; text: string; compact?: boolean }) {
  return (
    <>
      <Icon name={icon} />
      {!compact && <span>{text}</span>}
      {!compact && <Icon name="chevron" />}
    </>
  );
}

export function HandoffMenu({ chat, compact, buttonClass = 'ghost sm' }: { chat: ChatView; compact?: boolean; buttonClass?: string }) {
  return (
    <Popover label={`Hand off ${chat.label} to`} title={compact ? 'Hand off' : undefined} buttonClass={compact ? `${buttonClass} icon-btn` : buttonClass} trigger={<Trigger icon="handoff" text="Hand off" compact={compact} />}>
      {(close) => (
        <>
          <div class="pop-title" aria-hidden="true">Continue with</div>
          {AGENT_KEYS.map((agent) => (
            <button
              key={agent}
              role="menuitem"
              onClick={() => {
                close();
                send({ type: 'handoff', chatId: chat.id, agent });
              }}
            >
              <Glyph agent={agent} size="sm" />
              <span class="grow">{AGENT_FACES[agent].name}</span>
              {agent === chat.agent && <span class="hint">new chat</span>}
            </button>
          ))}
        </>
      )}
    </Popover>
  );
}

const defaultConsultant = (agent: AgentKey): AgentKey => (agent === 'claude' ? 'codex' : 'claude');

/** Ask another agent a short question; its answer comes back into this chat. */
export function AskMenu({ chat, compact, buttonClass = 'ghost sm' }: { chat: ChatView; compact?: boolean; buttonClass?: string }) {
  const [agent, setAgent] = useState<AgentKey>(defaultConsultant(chat.agent));
  const [text, setText] = useState('');
  return (
    <Popover kind="dialog" label={`Ask another agent from ${chat.label}`} title={compact ? 'Ask another agent' : undefined} buttonClass={compact ? `${buttonClass} icon-btn` : buttonClass} trigger={<Trigger icon="ask" text="Ask" compact={compact} />}>
      {(close) => {
        const ask = () => {
          if (!text.trim()) return;
          send({ type: 'consult', chatId: chat.id, agent, text: text.trim() });
          setText('');
          close();
        };
        return (
          <div class="ask-form">
            <div class="pop-title" aria-hidden="true">Ask, reply comes back here</div>
            <div class="seg" role="radiogroup" aria-label="Agent" onKeyDown={radioKeys}>
              {AGENT_KEYS.map((a) => (
                <button key={a} type="button" role="radio" aria-checked={a === agent} tabIndex={a === agent ? 0 : -1} class="seg-item" onClick={() => setAgent(a)}>
                  <Glyph agent={a} size="sm" /> {AGENT_FACES[a].name}
                </button>
              ))}
            </div>
            <textarea
              rows={2}
              value={text}
              aria-label={`Question for ${AGENT_FACES[agent].name}`}
              placeholder={`Question for ${AGENT_FACES[agent].name}`}
              onInput={(e) => setText(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                  e.preventDefault();
                  ask();
                }
              }}
            />
            <div class="row end">
              <button type="button" class="ghost sm" onClick={() => close()}>
                Cancel
              </button>
              <button type="button" class="primary sm" disabled={!text.trim()} onClick={ask}>
                Ask {AGENT_FACES[agent].name}
              </button>
            </div>
          </div>
        );
      }}
    </Popover>
  );
}

/** Forward every finished turn of this chat to another one; picking a piped chat again stops the pipe. */
export function PipeMenu({ chat, compact, buttonClass = 'ghost sm' }: { chat: ChatView; compact?: boolean; buttonClass?: string }) {
  return (
    <Popover label={`Pipe ${chat.label} to`} title={compact ? 'Pipe to' : undefined} buttonClass={compact ? `${buttonClass} icon-btn` : buttonClass} trigger={<Trigger icon="pipe" text="Pipe to" compact={compact} />}>
      {(close) => <PipeTargets chat={chat} close={close} />}
    </Popover>
  );
}

const byLabel = new Intl.Collator('en', { numeric: true });

/** The other open chats, read from the live state only while the menu is open. */
export function PipeTargets({ chat, close }: { chat: ChatView; close(refocus?: boolean): void }) {
  const state = useContext(LiveState);
  const others = openChats(state.chats)
    .filter((c) => c.id !== chat.id)
    .sort((a, b) => AGENT_KEYS.indexOf(a.agent) - AGENT_KEYS.indexOf(b.agent) || byLabel.compare(a.label, b.label));
  const pipeTo = (id: string) => state.links.find((l) => l.kind === 'pipe' && l.from === chat.id && l.to === id);
  return (
    <>
      <div class="pop-title" aria-hidden="true">Send each finished turn to</div>
      <div class="pop-scroll">
        {others.length === 0 && (
          <button role="menuitem" disabled>
            <span class="hint">No other chats</span>
          </button>
        )}
        {others.map((c) => {
          const pipe = pipeTo(c.id);
          return (
            <button
              key={c.id}
              role="menuitemcheckbox"
              aria-checked={!!pipe}
              title={c.title}
              onClick={() => {
                close();
                send(pipe ? { type: 'unlink', linkId: pipe.id } : { type: 'pipe', from: chat.id, to: c.id });
              }}
            >
              <Glyph agent={c.agent} size="sm" />
              <span class="menu-label">{clip(c.title, 40)}</span>
              <span class="menu-sub">{AGENT_FACES[c.agent].name}</span>
              {pipe ? <span class="tag on">{pipe.active ? 'piping' : 'paused'} · stop</span> : null}
            </button>
          );
        })}
      </div>
    </>
  );
}
