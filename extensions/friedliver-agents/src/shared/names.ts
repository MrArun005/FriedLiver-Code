// How a chat is named to people (owner rule): by its topic, and by the plain
// agent name ("Claude", "Codex", "Gemini") where an agent must be named. Never
// a numbered label like "Claude 9", not even in a tooltip; where chats must be
// told apart a tooltip reads "<topic> · Claude". Pure, so the status bar, the
// notifications and the tests agree.
import { agentFace, type AgentKey } from './model';

type Named = { agent: AgentKey; title: string };

/** The plain agent name. */
export const agentName = (agent: AgentKey): string => agentFace(agent).name;

/** The chat's topic, or the agent's name while it has none. */
export function chatName(chat: Named): string {
  const t = chat.title.replace(/\s+/g, ' ').trim();
  return t && t !== 'New chat' ? t : agentName(chat.agent);
}

/** A chat in a sentence: “its topic” in quotes, or the agent's name while it has none. */
export function chatRef(chat: Named): string {
  const name = chatName(chat);
  return name === agentName(chat.agent) ? name : `“${name}”`;
}

/** Where chats must be told apart (a tooltip, a quick pick's detail): "<topic> · Claude". */
export function chatTip(chat: Named): string {
  return `${chat.title.replace(/\s+/g, ' ').trim() || 'New chat'} · ${agentName(chat.agent)}`;
}

/** Matches a numbered agent label: the thing never to show. */
export const NUMBERED_LABEL = /\b(Claude|Codex|Gemini|Antigravity|Demo) \d+\b/;

const short = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
const list = (chats: Named[]) => chats.map((c) => `“${short(chatName(c), 60)}” (${agentName(c.agent)})`).join(', ');

/** The status bar's "N working" and "Auto: …" items. */
export function statusTexts(busy: Named[], full: Named[]): { working?: { text: string; tooltip: string }; auto?: { text: string; tooltip: string } } {
  return {
    ...(busy.length ? { working: { text: `$(loading~spin) ${busy.length} agent${busy.length === 1 ? '' : 's'} working`, tooltip: `${list(busy)} ${busy.length === 1 ? 'is' : 'are'} working. Open the Agent Manager.` } } : {}),
    ...(full.length
      ? {
          auto: {
            text: `$(zap) Auto: ${full.length === 1 ? short(chatName(full[0]), 40) : `${full.length} chats`}`,
            tooltip: `${list(full)} edit${full.length === 1 ? 's' : ''} and run${full.length === 1 ? 's' : ''} commands without asking. Click to see.`,
          },
        }
      : {}),
  };
}

/** A turn's end, for its notification. */
export function turnEndedText(t: Named & { failure?: string; files: number }): string {
  if (t.failure !== undefined) return `${agentName(t.agent)} · ${short(chatName(t), 80)}: ${t.failure}`;
  const changed = t.files ? ` · ${t.files} file${t.files === 1 ? '' : 's'} changed` : '';
  return `${agentName(t.agent)} finished: ${chatName(t)}${changed}`;
}

/** A quick pick row for a chat: the topic, then the agent (and anything else) as its description. */
export function chatPick(chat: Named, ...more: string[]): { label: string; description: string } {
  return { label: chatName(chat), description: [agentName(chat.agent), ...more].filter(Boolean).join(' · ') };
}
