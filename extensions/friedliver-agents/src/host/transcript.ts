// Chats as text for other agents: the context a hand-off starts from, the
// brief a consulted agent gets, and what the FriedLiver tools return.
import path from 'node:path';
import { agentFace, allAgentKeys, lastReply, type AppState, type ChatView, type Item } from '../shared/model';
import { turnsText } from '../shared/view';
import { testAgentsOn } from './settings';

/** Characters kept from one message in a hand-off or a read. */
const MAX_MESSAGE = 2000;
/** Characters of transcript a hand-off carries; older messages go first. */
const MAX_HANDOFF = 24_000;
const MAX_EXCERPT = 1500;
const MAX_READ = 100_000;

/** A file the agents touched, as the chat sees it: relative to its folder, with forward slashes. */
export function relativeFile(cwd: string, file: string): string {
  const rel = path.relative(cwd, file) || path.basename(file);
  return rel.split(path.sep).join('/');
}

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}… [trimmed]` : t;
}

/** The chat's conversation as "who: text" lines, oldest first. */
function messages(chat: ChatView, max: number): string[] {
  const out: string[] = [];
  let agentText = '';
  const flush = () => {
    if (agentText.trim()) out.push(`${chat.label}: ${clip(agentText, max)}`);
    agentText = '';
  };
  for (const i of chat.items) {
    if (i.kind === 'agent') {
      agentText += (agentText ? '\n\n' : '') + i.text;
      continue;
    }
    const line = messageLine(chat, i, max);
    if (line) {
      flush();
      out.push(line);
    }
  }
  flush();
  return out;
}

function messageLine(chat: ChatView, i: Item, max: number): string | null {
  switch (i.kind) {
    case 'user': {
      // Code the message pointed at, by place: the agent that takes over can read it.
      const refs = (i.refs ?? []).map((r) => `${relativeFile(chat.cwd, r.path)}:${r.startLine === r.endLine ? r.startLine : `${r.startLine}-${r.endLine}`}`);
      const about = refs.length ? ` (about ${refs.join(', ')})` : '';
      return i.text.trim() || about ? `User: ${clip(i.text, max)}${about}` : null;
    }
    case 'link':
      switch (i.role) {
        case 'asked':
          return `${chat.label} asked ${i.label}: ${clip(i.text, max)}`;
        case 'reply':
          return `${i.label} answered: ${clip(i.text, max)}`;
        case 'consulted':
          return `${i.label} asked: ${clip(i.text, max)}`;
        case 'piped-in':
          return `Message from ${i.label}: ${clip(i.text, max)}`;
        default:
          return null;
      }
    default:
      return null;
  }
}

/** What a hand-off carries of the user's messages after the first, and of the last reply. */
const HANDOFF_ASKS = 10;
const MAX_ASK = 400;
const MAX_LAST_REPLY = 1500;

/**
 * What a new agent needs to continue another's work, compactly: the task, what the user asked
 * (their instructions are the decisions), where the other agent stopped and what it still asked,
 * the latest plan, the commands that ran, and the files that changed with their content hash now
 * (`hashes`, relative path → hash). The whole conversation stays a read_chat away. Sent once, in
 * front of the user's first message in the new chat, so it costs no turn.
 */
export function handoffContext(chat: ChatView, hashes: Record<string, string> = {}, again = false): string {
  const parts = [
    [
      again
        ? `[FriedLiver] The task is back with you from ${chat.label}, which worked on it after you, in this same folder (${chat.cwd}). Here is where it is now.`
        : `[FriedLiver] You are taking over a task from another coding agent, ${chat.label}, in this same folder (${chat.cwd}).`,
      "The files on disk already include the changes the user accepted. Continue from where it stopped. The user's message follows this context.",
      '',
      `Task: ${chat.title}`,
    ].join('\n'),
  ];
  const asks = chat.items.flatMap((i) => (i.kind === 'user' ? [messageLine(chat, i, MAX_ASK)].filter((l): l is string => !!l) : []));
  if (asks.length) {
    const kept = asks.length > HANDOFF_ASKS + 1 ? [asks[0], `(${asks.length - HANDOFF_ASKS - 1} more in between)`, ...asks.slice(-HANDOFF_ASKS)] : asks;
    parts.push(`What the user asked, oldest first:\n${kept.join('\n')}`);
  }
  const reply = lastReply(chat).trim();
  if (reply) {
    const tail = reply.length > MAX_LAST_REPLY ? `[…] ${reply.slice(-MAX_LAST_REPLY)}` : reply;
    parts.push(`Where ${chat.label} stopped (its last reply):\n${chat.label}: ${tail}`);
    const questions = reply.split('\n').map((l) => l.trim()).filter((l) => l.endsWith('?') && l.length < 300).slice(-5);
    if (questions.length) parts.push(`Open questions:\n${questions.map((q) => `- ${q.replace(/^[-*\d.)\s]+/, '')}`).join('\n')}`);
  }
  const plan = [...chat.items].reverse().find((i) => i.kind === 'plan');
  if (plan?.kind === 'plan' && plan.entries.length) parts.push(`Plan:\n${plan.entries.map((e) => `- [${e.status}] ${e.content}`).join('\n')}`);
  const commands = chat.items.flatMap((i) => (i.kind === 'command' ? [`- \`${clip(i.commandLine, 200)}\` (${commandOutcome(i)})`] : []));
  if (commands.length) parts.push(`Commands${commands.length > 10 ? ` (last 10 of ${commands.length})` : ''}:\n${commands.slice(-10).join('\n')}`);
  if (chat.files.length) {
    const files = chat.files.slice(0, 50).map((f) => `- ${f}${hashes[f] ? ` #${hashes[f]}` : ''}`);
    parts.push(`Files changed (content hash now; index_outline / index_read show what you need):\n${files.join('\n')}${chat.files.length > 50 ? `\n… and ${chat.files.length - 50} more` : ''}`);
  }
  parts.push(`More: read_chat with chat_id "${chat.id}" returns the conversation itself (last: up to 50 messages).`);
  return parts.join('\n\n');
}

/**
 * The conversation up to a rewind, for the new session that continues it:
 * the agent's own session can't be cut back to a message. Empty when nothing
 * is left to carry.
 */
export function rewoundHistory(chat: ChatView, items: Item[]): string {
  let lines = messages({ ...chat, items }, MAX_MESSAGE);
  if (!lines.length) return '';
  while (lines.length > 1 && lines.join('\n\n').length > MAX_HANDOFF) lines = [lines[0], ...lines.slice(2)];
  return [
    '[FriedLiver] The user rewound this conversation, so you are in a new session. This is the conversation so far, oldest first; anything after it was undone. The files on disk are as the user left them.',
    lines.join('\n\n'),
    "The user's message follows.",
  ].join('\n\n');
}

function commandOutcome(i: Extract<Item, { kind: 'command' }>): string {
  if (i.state === 'denied') return 'the user denied it';
  if (i.state === 'exited') return i.exitCode == null ? 'stopped' : `exit ${i.exitCode}`;
  return 'did not finish';
}

/** "3 messages · 2 files changed · 1 command", for the hand-off cards. */
export function handoffSummary(chat: ChatView): string {
  const n = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
  const parts = [n(messages(chat, 0).length, 'message')];
  if (chat.files.length) parts.push(`${n(chat.files.length, 'file')} changed`);
  const commands = chat.items.filter((i) => i.kind === 'command').length;
  if (commands) parts.push(n(commands, 'command'));
  return parts.join(' · ');
}

/** What a consulted agent learns about the chat that asks it, ahead of the question. */
export function consultBrief(chat: ChatView): string {
  const lines = [
    `[FriedLiver] ${chat.label}, another coding agent working in this folder (${chat.cwd}), asks you the question below.`,
    `Its task: ${chat.title}`,
  ];
  const reply = lastReply(chat);
  if (reply) lines.push(`Its latest reply (excerpt):\n${clip(reply.slice(-MAX_EXCERPT), MAX_EXCERPT)}`);
  if (chat.files.length) lines.push(`Files it changed: ${chat.files.slice(0, 30).join(', ')}`);
  lines.push(`More: read_chat with chat_id "${chat.id}" returns that chat's conversation.`);
  lines.push('Answer the question. Read files here as you need; change them only if the question asks you to.');
  return lines.join('\n\n');
}

/**
 * A follow-up question to a consultation that already has consultBrief: only what is new in the asking
 * chat since then (its latest reply, if it changed, and files it changed since), not the brief again.
 */
export function consultFollowUp(chat: ChatView, since: { reply: string; files: number }): string {
  const lines = [`[FriedLiver] ${chat.label} asks a follow-up question, below (same task: ${chat.title}).`];
  const reply = lastReply(chat);
  if (reply && reply !== since.reply) lines.push(`Its latest reply since your last answer (excerpt):\n${clip(reply.slice(-MAX_EXCERPT), MAX_EXCERPT)}`);
  const added = chat.files.slice(since.files, since.files + 30);
  if (added.length) lines.push(`Files it changed since: ${added.join(', ')}`);
  return lines.join('\n\n');
}

/** A finished turn from one chat, given to another as a message. */
export function forwardText(from: ChatView, text: string): string {
  return `[FriedLiver] From ${from.label}, another agent's chat (task: ${from.title}):\n\n${text}`;
}

/** read_chat: the latest messages of a chat. */
export function renderChat(chat: ChatView, last: number): string {
  const lines = messages(chat, MAX_MESSAGE * 2).slice(-last);
  const head = `${chat.id} · ${chat.label} · task: ${chat.title} · ${chat.busy ? 'busy' : 'idle'} · ${turnsText(chat)}`;
  const body = lines.length ? lines.join('\n\n') : '(no messages yet)';
  const text = `${head}\n\n${body}`;
  return text.length > MAX_READ ? `…${text.slice(-MAX_READ)}` : text;
}

/** list_chats: the open chats, with the caller marked. */
export function chatList(state: Pick<AppState, 'chats' | 'links'>, callerId: string): string {
  const open = state.chats.filter((c) => !c.archived);
  if (!open.length) return 'No chats are open.';
  return open
    .map((c) => {
      const notes = [c.busy ? 'busy' : 'idle'];
      if (c.id === callerId) notes.push('this chat');
      else if (state.links.some((l) => l.from === callerId && l.to === c.id && l.kind === 'consult')) notes.push('you consulted it');
      if (c.branch) notes.push(`own worktree on ${c.branch}`);
      return `${c.id} · ${agentFace(c.agent).name} (${c.label}) · ${JSON.stringify(c.title)} · ${notes.join(', ')}`;
    })
    .join('\n');
}

/** list_agents: the agents FriedLiver can start. */
export function agentList(): string {
  const about: Record<string, string> = { codex: 'OpenAI GPT through Codex', antigravity: 'Google models through the Antigravity CLI', copilot: 'GitHub Copilot CLI', opencode: 'OpenCode, with OpenCode Zen and other providers', demo: 'offline test agent; it echoes what it is told' };
  const keys = allAgentKeys().filter((k) => k !== 'demo' || testAgentsOn());
  return [
    ...keys.map((k) => `${k} · ${agentFace(k).name}${about[k] ? ` (${about[k]})` : ''}`),
    '',
    'Pass the key as `agent` to ask_agent. An agent the user has not installed or signed in to answers with an error.',
  ].join('\n');
}
