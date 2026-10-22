// One approval, whatever asks: an agent's permission request, an edit to review, a FriedLiver
// command, a request through the FriedLiver tools. Who, the verb and its target, the risk, and the
// three scopes (Once / This chat / Always) with what each would remember and why one is locked.
// Pure: the chat card, the Agent Manager card and the Inbox all draw this, and every answer is
// a message the host already takes, with its own checks (an option the agent offered, a grant the
// request offered, the origin again), so the scopes offered here can never widen what policy allows.
import type { WebviewMessage } from './messages';
import { agentFace, type AppState, type ChatView, type Item } from './model';
import { describeGrant, siteOrigin, type Grant } from './permissions';
import { agentToolRisk, browserRisk, commandRisk, filesRisk, type DroppedCommits, type Risk } from './risk';
import { ruleCandidates, ruleSafe } from './rules';
import { isSystemTool, SYSTEM_VERBS } from './system';
import { chatRef } from './names';
import { denyOption, primaryOption } from './tools';
import { clip, relativePath } from './view';

export type Scope = 'once' | 'chat' | 'always';
export const SCOPES: readonly Scope[] = ['once', 'chat', 'always'];
export const SCOPE_NAMES: Record<Scope, string> = { once: 'Once', chat: 'This chat', always: 'Always' };

export type Approvable = Extract<Item, { kind: 'permission' | 'review' | 'command' | 'bridge' }>;

export interface Approval {
  /** requestId, reviewId or commandId. */
  id: string;
  /** Run, Edit, Click, Ask… (empty when the agent's own title says it all). */
  verb: string;
  target: string;
  /** The target is machine text: a command, path, selector or URL. */
  mono: boolean;
  /** "in ~/code/shop", "on staging.shop.dev", "+3 −1". */
  where?: string;
  risk: Risk;
  /** The scopes that can't be chosen, and why. Once never is. */
  locked: Partial<Record<Exclude<Scope, 'once'>, string>>;
  /** What Always can remember, most specific first. */
  grants: Grant[];
  /** The answer for each scope that has one; Always takes the grant to remember. */
  allow: { once?: WebviewMessage; chat?: WebviewMessage; always?: (grant?: Grant) => WebviewMessage };
  deny?: WebviewMessage;
  /** The agent's other answers (mode changes, "No, and tell Claude what to do"), behind More. */
  others: { label: string; message: WebviewMessage }[];
  /** Allow is press-and-hold (careful). */
  hold: boolean;
  /** The yes word: Allow, or Accept for an edit to review. */
  yes: string;
  /** The agent's own option that "This chat" picks. */
  chatOption?: string;
  /** What travels with a request to another agent or chat, besides its text. */
  shares?: string[];
}

const MODE_CHANGE = /bypass|auto mode|auto-accept|accept edits|full access|yolo|clear context|plan mode/i;

/** ~ for the home folder, so paths read short. */
export const tilde = (p: string) => p.replace(/^\/(Users|home)\/[^/]+(?=\/|$)/, '~');

function filesOf(i: Extract<Item, { kind: 'permission' }>): string[] {
  return i.detail?.files?.map((f) => f.path) ?? [];
}

function bridgeOrigin(i: Extract<Item, { kind: 'bridge' }>): string | undefined {
  if (!('browser' in i.target)) return undefined;
  return i.tool === 'browser_open' ? siteOrigin(i.text) : i.always ? siteOrigin(i.always) : undefined;
}

const host = (origin?: string) => origin?.replace(/^https?:\/\//, '');

/** What the card says and offers for this request. */
export function approvalOf(item: Approvable, chat: Pick<ChatView, 'agent' | 'label' | 'cwd'> & { files?: string[] }, state?: Pick<AppState, 'chats'>): Approval {
  const agent = agentFace(chat.agent).name;
  const rel = (p: string) => relativePath(chat.cwd, p);
  if (item.kind === 'permission') {
    const d = item.detail;
    const yes = primaryOption(item.options);
    const no = denyOption(item.options);
    const answer = (optionId: string): WebviewMessage => ({ type: 'permission', requestId: item.requestId, optionId });
    const files = filesOf(item);
    const plan = !!d?.plan || item.toolKind === 'switch_mode';
    const cmd = d?.command;
    let verb = '';
    let target: string;
    let mono = false;
    let where: string | undefined;
    let risk: Risk;
    if (cmd) {
      verb = 'Run';
      target = cmd.line.split('\n')[0] + (cmd.line.includes('\n') ? ' …' : '');
      mono = true;
      where = `in ${tilde(cmd.cwd ?? chat.cwd)}`;
      risk = commandRisk(cmd.line);
    } else if (plan) {
      verb = 'Approve';
      target = 'the plan';
      risk = { tone: 'review', label: 'Starts making changes', consequences: [] };
    } else if (files.length) {
      const f = d!.files![0];
      verb = item.toolKind === 'delete' ? 'Delete' : item.toolKind === 'move' ? 'Move' : f.isNew ? 'Create' : 'Edit';
      target = rel(f.path);
      mono = true;
      where = files.length > 1 ? `and ${files.length - 1} more` : undefined;
      risk = filesRisk(files, 'write', chat.cwd);
    } else if (d?.url) {
      verb = 'Fetch';
      target = d.url.replace(/^https?:\/\//, '');
      mono = true;
      risk = { tone: 'review', label: 'Fetches a web page', consequences: [] };
    } else if ((item.toolKind === 'read' || item.toolKind === 'search') && d?.locations?.length) {
      verb = 'Read';
      target = rel(d.locations[0]);
      mono = true;
      where = d.locations.length > 1 ? `and ${d.locations.length - 1} more` : undefined;
      risk = filesRisk(d.locations, 'read', chat.cwd);
    } else {
      target = clip(item.title, 200);
      risk = { tone: 'review', label: 'Uses a tool', consequences: [] };
    }
    risk = withDropped(risk, d?.dropped);
    const careful = risk.tone === 'careful';
    const chatOption = careful || plan ? undefined : item.options.find((o) => o.kind === 'allow_always' && !MODE_CHANGE.test(o.name));
    const grants = !yes || plan || careful ? [] : [...(cmd && item.toolKind === 'execute' ? ruleCandidates(cmd.line) : []), ...(d?.always ?? [])];
    const locked: Approval['locked'] = {};
    if (risk.lock) locked.chat = locked.always = risk.lock;
    if (!locked.chat && !chatOption) locked.chat = plan ? 'Plans are approved one at a time.' : `${agent} offers no rule for this chat here.`;
    if (!locked.always && !grants.length)
      locked.always = plan ? 'Plans are approved one at a time.' : cmd && !ruleSafe(cmd.line) ? 'Chained or redirected commands always ask.' : 'Nothing here can be remembered safely.';
    const mapped = new Set([yes, no, chatOption].filter(Boolean));
    // Careful: no other way to say yes either, not even one the agent offered.
    const others = item.options.filter((o) => !mapped.has(o) && !(careful && o.kind.startsWith('allow'))).map((o) => ({ label: o.name, message: answer(o.optionId) }));
    return {
      id: item.requestId,
      verb,
      target,
      mono,
      ...(where ? { where } : {}),
      risk,
      locked,
      grants,
      allow: {
        ...(yes ? { once: answer(yes.optionId) } : {}),
        ...(chatOption && !locked.chat ? { chat: answer(chatOption.optionId) } : {}),
        ...(grants.length && !locked.always ? { always: (grant = grants[0]) => ({ type: 'allowAlways', requestId: item.requestId, grant }) } : {}),
      },
      ...(no ? { deny: answer(no.optionId) } : {}),
      others,
      hold: careful,
      yes: plan ? 'Approve' : 'Allow',
      ...(chatOption ? { chatOption: chatOption.name } : {}),
    };
  }
  if (item.kind === 'review') {
    const risk = filesRisk([item.path], 'write', chat.cwd);
    const each = risk.lock ?? 'Each edit is reviewed on its own.';
    const review = (action: 'accept' | 'reject'): WebviewMessage => ({ type: 'review', reviewId: item.reviewId, action });
    return {
      id: item.reviewId,
      verb: item.isNew ? 'Create' : 'Edit',
      target: rel(item.path),
      mono: true,
      where: `+${item.added} −${item.removed}`,
      risk,
      locked: { chat: each, always: each },
      grants: [],
      allow: { once: review('accept') },
      deny: review('reject'),
      others: [],
      hold: risk.tone === 'careful',
      yes: 'Accept',
    };
  }
  if (item.kind === 'command') {
    const risk = withDropped(item.outside ? { ...commandRisk(item.commandLine), tone: commandRisk(item.commandLine).tone === 'careful' ? 'careful' : 'review' } : commandRisk(item.commandLine), item.dropped);
    const careful = risk.tone === 'careful';
    const grants = item.outside || careful ? [] : ruleCandidates(item.commandLine);
    const run = (approve: boolean): WebviewMessage => ({ type: 'command', commandId: item.commandId, approve });
    return {
      id: item.commandId,
      verb: 'Run',
      target: item.commandLine.split('\n')[0] + (item.commandLine.includes('\n') ? ' …' : ''),
      mono: true,
      where: `in ${tilde(item.cwd)}`,
      risk,
      locked: {
        chat: risk.lock ?? 'Commands are remembered in every chat (Always), or not at all.',
        ...(grants.length ? {} : { always: risk.lock ?? (item.outside ? 'Commands outside the workspace always ask.' : 'Chained or redirected commands always ask.') }),
      },
      grants,
      allow: { once: run(true), ...(grants.length ? { always: (grant = grants[0]) => ({ type: 'allowAlways', commandId: item.commandId, grant }) } : {}) },
      deny: run(false),
      others: [],
      hold: careful,
      yes: 'Allow',
    };
  }
  // A request through the FriedLiver tools.
  const answer = (a: 'allow' | 'allowChat' | 'allowAlways' | 'deny'): WebviewMessage => ({ type: 'bridge', requestId: item.requestId, answer: a });
  const origin = bridgeOrigin(item);
  const browser = 'browser' in item.target;
  // Mac & Windows control (system_*): the app, link, file or Shortcut it acts on.
  const system = 'system' in item.target ? item.target.system : undefined;
  const risk: Risk = browser
    ? browserRisk(item.tool, item.text, origin)
    : system !== undefined
      ? { tone: 'review', label: item.once ? 'Asked every time' : 'Acts on your computer', consequences: [] }
      : agentToolRisk(item.tool);
  const careful = risk.tone === 'careful';
  const other = 'chatId' in item.target ? state?.chats.find((c) => c.id === (item.target as { chatId: string }).chatId) : undefined;
  const words = isSystemTool(item.tool) ? SYSTEM_VERBS[item.tool].replace(/^./, (c) => c.toUpperCase()) : BRIDGE_WORDS[item.tool];
  const target = system !== undefined
    ? system || clip(item.text, 120)
    : browser
    ? item.tool === 'browser_open'
      ? item.text.replace(/^https?:\/\//, '')
      : item.text || host(origin) || 'the open page'
    : 'memory' in item.target
      ? clip(item.text, 120)
      : 'agent' in item.target
        ? agentFace(item.target.agent).name
        : other
          ? clip(other.title, 60)
          : 'another chat';
  // What the host sends along (transcript.ts consultBrief, forwardText, renderChat).
  const files = chat.files?.length ?? 0;
  const shares =
    item.tool === 'ask_agent'
      ? ['its task', 'its latest reply', ...(files ? [`${files} changed file${files === 1 ? '' : 's'}`] : [])]
      : item.tool === 'send_to_chat'
        ? ['its task']
        : item.tool === 'read_chat'
          ? [`${other ? `${chatRef(other)}` : 'that chat'}’s latest messages`]
          : item.tool === 'remember'
            ? ['.friedliver/memory.md, for every agent']
            : undefined;
  const locked: Approval['locked'] = {};
  if (careful) locked.chat = locked.always = risk.lock;
  else if (item.tool === 'browser_download') {
    // Each download a page starts asks again in another chat; a large one asks every time.
    locked.always = 'Downloads can’t be always allowed: each chat asks.';
    if (item.once) locked.chat = 'Downloads over 500 MB ask every time.';
  } else if (item.once) locked.chat = locked.always = 'The clipboard, screenshots and terminal-like apps ask every time.';
  else if (!item.always) locked.always = browser ? 'The page’s site is unknown, so it can’t be remembered.' : 'Nothing here can be remembered safely.';
  return {
    id: item.requestId,
    verb: words,
    target,
    mono: browser,
    ...(browser && item.tool !== 'browser_open' && origin ? { where: `on ${host(origin)}` } : {}),
    risk,
    locked,
    grants: [],
    allow: { once: answer('allow'), ...(locked.chat ? {} : { chat: answer('allowChat') }), ...(locked.always ? {} : { always: () => answer('allowAlways') }) },
    deny: answer('deny'),
    others: [],
    hold: careful,
    yes: 'Allow',
    ...(shares ? { shares } : {}),
  };
}

const BRIDGE_WORDS: Record<string, string> = {
  ask_agent: 'Ask',
  send_to_chat: 'Message',
  read_chat: 'Read',
  remember: 'Remember',
  browser_open: 'Open',
  browser_click: 'Click',
  browser_type: 'Type',
  browser_back: 'Go back',
  browser_reload: 'Reload',
  browser_download: 'Download',
};

/** A force push with the commits the host found: the first consequence counts them. */
function withDropped(risk: Risk, dropped?: DroppedCommits): Risk {
  if (!risk.push || !dropped) return risk;
  const n = dropped.commits.length + dropped.more;
  if (!n) return { ...risk, consequences: [`${dropped.ref} has nothing your branch lacks: no commits would be dropped`] };
  return { ...risk, consequences: [`Replaces ${n} commit${n === 1 ? '' : 's'} on ${dropped.ref} that ${n === 1 ? 'is' : 'are'} not in your branch`, ...risk.consequences.slice(1)] };
}

/** The primary button's words for the chosen scope: it repeats the choice. */
export function primaryLabel(a: Approval, scope: Scope): string {
  if (a.hold) return `Hold to ${a.yes.toLowerCase()}`;
  if (scope === 'chat') return `${a.yes} for this chat`;
  if (scope === 'always') return `Always ${a.yes.toLowerCase()}`;
  return a.yes === 'Allow' ? 'Allow once' : a.yes;
}

/** Tab: the next scope that can be chosen, round to Once. */
export function nextScope(a: Approval, scope: Scope): Scope {
  const at = SCOPES.indexOf(scope);
  for (let n = 1; n <= SCOPES.length; n++) {
    const s = SCOPES[(at + n) % SCOPES.length];
    if (s === 'once' || (!a.locked[s] && a.allow[s])) return s;
  }
  return 'once';
}

/** The message Allow sends for this scope, or undefined when that scope isn't offered. */
export function allowMessage(a: Approval, scope: Scope, grant = 0): WebviewMessage | undefined {
  if (scope === 'once') return a.allow.once;
  if (a.locked[scope]) return undefined;
  if (scope === 'chat') return a.allow.chat;
  return a.allow.always?.(a.grants[grant] ?? a.grants[0]);
}

/** A grant as the note shows it: the exact rule. */
export function grantText(g: Grant): string {
  if (g.kind === 'exact') return g.command;
  if (g.kind === 'prefix') return `${g.command} *`;
  return tilde(describeGrant(g).scope);
}

/**
 * What a scope remembers, named exactly, for its row in the Allow menu and the scope token. Parts in
 * backticks are machine text (the webview sets them in mono). Undefined for a locked scope.
 */
export function scopeRule(a: Approval, item: Approvable, chat: Pick<ChatView, 'cwd'>, scope: Scope, grant = 0): string | undefined {
  if (scope === 'once') return 'Just this time; ask again next time';
  if (a.locked[scope]) return undefined;
  if (scope === 'chat') {
    if (item.kind === 'permission') return `Until this chat ends: “${(a.chatOption ?? '').replace(/^yes,?\s*(and\s*)?/i, '')}”`;
    if (item.kind === 'bridge') {
      if ('browser' in item.target) return 'Any site in the browser, until this chat ends';
      if ('memory' in item.target) return 'Project memory, until this chat ends';
      if ('system' in item.target) return `${a.verb}${a.target ? ` \`${a.target}\`` : ''}, until this chat ends`;
      return 'Other agents and chats, until this chat ends';
    }
    return undefined;
  }
  if (item.kind === 'bridge') {
    const origin = bridgeOrigin(item);
    if (origin) return `\`${origin}\` in the browser, every agent, every chat`;
    if ('system' in item.target) return `${a.verb}${a.target ? ` \`${a.target}\`` : ''}, every agent, every chat`;
    return `${(TOOL_NOTE[item.tool] ?? 'This tool').replace(/^./, (c) => c.toUpperCase())}, every agent, every chat`;
  }
  const g = a.grants[grant] ?? a.grants[0];
  if (!g) return undefined;
  if (g.kind === 'exact' || g.kind === 'prefix') return `\`${grantText(g)}\` in \`${tilde(chat.cwd)}\`, every chat`;
  if (g.kind === 'folder') return `${g.access === 'read' ? 'Reading files' : 'Changes'} in \`${grantText(g)}\` and below, every chat`;
  if (g.kind === 'site') return `Pages on \`${g.origin}\`, every chat`;
  return undefined;
}

const TOOL_NOTE: Record<string, string> = { ask_agent: 'ask another agent', send_to_chat: 'message another chat', read_chat: 'read another chat', remember: 'add to project memory' };

/** The command line a card previews, for its copy button; undefined when there is none. */
export function commandLine(item: Approvable): string | undefined {
  return item.kind === 'command' ? item.commandLine : item.kind === 'permission' ? item.detail?.command?.line : undefined;
}

