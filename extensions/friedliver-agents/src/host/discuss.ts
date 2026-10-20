// /discuss: the chat's agent and the agents it names take turns on a question, in a fixed order,
// for a few rounds at most, then the starting agent sums it up (FriedLiver does when it can't).
// Everyone is read-only meanwhile: the core refuses their writes, commands and acting tools
// (discussionAllows below), and puts their agents in a read-only mode.
import type { BridgeCall } from '../bridge/protocol';
import type { Action, AgentKey, AppState, ChatView } from '../shared/model';
import {
  DISCUSS_BUDGET,
  DISCUSS_ROUNDS,
  MAX_TURN_TEXT,
  allAgree,
  carryOutText,
  fallbackConclusion,
  parseConclusion,
  speakerName,
  stanceOf,
  stripStance,
  type DiscussEnd,
  type DiscussTurn,
  type DiscussionItem,
} from '../shared/discuss';
import { NO_READ_ONLY, noReadOnlyText } from '../shared/session';
import { estimateTokens } from '../shared/tokens';
import type { TurnResult } from './connections';

/** What a discussion needs from the core. */
export interface DiscussHost {
  readonly state: AppState;
  dispatch(action: Action): void;
  id(prefix: string): string;
  settings(): { maxRounds?: number; tokenBudget?: number };
  /** The agent's chat for the discussion: the one `sourceId` already consults, else a new one. */
  participant(sourceId: string, agent: AgentKey): Promise<string>;
  /** A turn in the starting chat, given `text` as a message from FriedLiver. */
  prompt(chatId: string, text: string): Promise<TurnResult>;
  /** A turn in another participant's chat, asked from the starting one; resolves with the answer. */
  ask(sourceId: string, chatId: string, agent: AgentKey, text: string): Promise<string>;
  cancel(chatId: string): Promise<void>;
  /** Read-only on or off for a chat taking part. */
  guard(chatId: string, on: boolean): Promise<void>;
  /** An ordinary message to a chat, with its normal approvals (Carry out). */
  send(chatId: string, text: string): Promise<void>;
  /** `from`'s message to another chat, shown in both (Carry out with another participant). */
  message(from: string, to: string, text: string): Promise<unknown>;
}

/** ACP tool kinds a discussion may use, as the agent's adapter reports them: reading, searching, fetching a page. */
const READ_KINDS = new Set(['read', 'search', 'fetch']);
/** FriedLiver tools that only look, by exact name: the project index, the chat list, a page's text. */
const READ_TOOLS = new Set([
  'index_search',
  'index_symbols',
  'index_read',
  'index_outline',
  'index_related',
  'index_diff',
  'index_changes',
  'list_agents',
  'list_chats',
  'read_chat',
  'browser_snapshot',
  'browser_screenshot',
  'browser_console',
]);
/** The real MCP name of one of those (Claude's toolName in the call's _meta), exactly: never a display title. */
const READ_MCP = /^mcp__friedliver(?:-browser)?__([a-z_]+)$/;

export const DISCUSS_READ_ONLY = 'FriedLiver refused this: the chat is in a discussion, where agents may only read and search. Say what you would change instead.';

/**
 * Whether a permission request may go to the user (or the chat's rules) during a discussion. Decided
 * on the call's kind and its real tool name (`toolName`, from the adapter's _meta), never its title,
 * which the agent or a tool writes. Anything it doesn't recognise is refused.
 */
export function discussionAllows(tool: { kind?: string | null; toolName?: string; command?: boolean; diffs?: boolean }): boolean {
  if (tool.command || tool.diffs) return false;
  if (tool.toolName !== undefined) {
    const m = READ_MCP.exec(tool.toolName);
    if (m) return READ_TOOLS.has(m[1]);
    // Another MCP server's tool, or a look-alike of ours: its kind is only its own say-so.
    if (/mcp|__|friedliver/i.test(tool.toolName)) return false;
  }
  return !!tool.kind && READ_KINDS.has(tool.kind);
}

/** Whether a FriedLiver tool call may run during a discussion. */
export const discussionAllowsBridge = (call: Pick<BridgeCall, 'tool'>): boolean => READ_TOOLS.has(call.tool);

const clamp = (n: number | undefined, lo: number, hi: number, d: number) => (n === undefined || !Number.isFinite(n) ? d : Math.min(hi, Math.max(lo, Math.round(n))));

interface Live {
  stop: boolean;
  /** The chat speaking now, for Stop. */
  speaking?: string;
}

export class Discussions {
  private readonly live = new Map<string, Live>();

  constructor(private readonly host: DiscussHost) {}

  /** Starts a discussion in `chatId` with `agents`; resolves when it has its conclusion. */
  async start(chatId: string, agents: AgentKey[], question: string): Promise<void> {
    const chat = this.require(chatId);
    if (chat.busy) throw new Error(`${chat.label} is still working. Start the discussion when the turn ends.`);
    if (this.runningIn(chatId)) throw new Error('A discussion is already running in this chat.');
    const others = [...new Set(agents)].filter((a) => a !== chat.agent);
    if (!others.length) throw new Error('Name at least one other agent: /discuss @gemini @codex <question>');
    // Everyone is read only in a discussion: an agent nothing holds to that can't take part.
    const loose = [chat.agent, ...others].find((a) => NO_READ_ONLY.includes(a));
    if (loose) throw new Error(noReadOnlyText(speakerName(loose)));
    const s = this.host.settings();
    const d: DiscussionItem = {
      kind: 'discussion',
      id: this.host.id('discuss'),
      question: question.trim(),
      participants: [{ agent: chat.agent, chatId }, ...others.map((agent) => ({ agent }))],
      maxRounds: clamp(s.maxRounds, DISCUSS_ROUNDS.min, DISCUSS_ROUNDS.max, DISCUSS_ROUNDS.default),
      round: 1,
      state: 'running',
      turns: [],
      tokens: 0,
      budget: clamp(s.tokenBudget, DISCUSS_BUDGET.min, DISCUSS_BUDGET.max, DISCUSS_BUDGET.default),
    };
    const typed = `/discuss ${others.map((a) => `@${a}`).join(' ')} ${d.question}`;
    this.host.dispatch({ t: 'items', chatId, items: [{ kind: 'user', text: typed, images: [] }, d], at: Date.now() });
    await this.run(chatId, d.id);
  }

  /** The discussion running in a chat, if any. */
  runningIn(chatId: string): DiscussionItem | undefined {
    const d = this.find(chatId);
    return d && d.state !== 'done' && this.live.has(d.id) ? d : undefined;
  }

  /**
   * A point the user adds while it runs: it waits for the round to end, then everyone hears it from the
   * next round on ("It goes in before round N"); after the last round, the summing up hears it.
   */
  interject(chatId: string, text: string): void {
    const d = this.runningIn(chatId);
    const point = text.trim().slice(0, MAX_TURN_TEXT);
    if (!d || !point) return;
    // Summing up already: too late for anyone to hear it, but it stays on the card.
    if (d.state === 'summarizing') this.patch(d, { turns: [...d.turns, { by: 'you', round: d.round + 1, text: point }] });
    else this.patch(d, { points: [...(d.points ?? []), point] });
  }

  /** A point typed on the card (its id), as interject. */
  addPoint(id: string, text: string): void {
    const found = this.locate(id);
    if (found) this.interject(found.chat.id, text);
  }

  /** The waiting points into the transcript, as said before `round`. */
  private flushPoints(d: DiscussionItem, round: number): void {
    if (!d.points?.length) return;
    this.patch(d, { turns: [...d.turns, ...d.points.map((text) => ({ by: 'you' as const, round, text }))], points: undefined });
  }

  /** Stops after the turn being spoken (which is cancelled); FriedLiver sums up what was said. */
  async stop(id: string): Promise<void> {
    const live = this.live.get(id);
    if (!live) return;
    live.stop = true;
    if (live.speaking) await this.host.cancel(live.speaking).catch(() => {});
  }

  /** More rounds on a finished discussion, in a new card that carries its transcript on. */
  async continue(id: string): Promise<void> {
    const found = this.locate(id);
    if (!found || found.d.state !== 'done' || found.d.continued) return;
    const { chat, d } = found;
    if (chat.busy) throw new Error(`${chat.label} is still working. Continue when the turn ends.`);
    if (this.runningIn(chat.id)) throw new Error('A discussion is already running in this chat.');
    this.patch(d, { continued: true });
    const s = this.host.settings();
    const next: DiscussionItem = {
      ...d,
      id: this.host.id('discuss'),
      round: d.round + 1,
      maxRounds: d.round + clamp(s.maxRounds, DISCUSS_ROUNDS.min, DISCUSS_ROUNDS.max, DISCUSS_ROUNDS.default),
      state: 'running',
      ended: undefined,
      conclusion: undefined,
      span: undefined,
      carried: undefined,
      continued: undefined,
      budget: d.tokens + clamp(s.tokenBudget, DISCUSS_BUDGET.min, DISCUSS_BUDGET.max, DISCUSS_BUDGET.default),
    };
    delete next.at;
    this.host.dispatch({ t: 'items', chatId: chat.id, items: [next], at: Date.now() });
    await this.run(chat.id, next.id);
  }

  /** Hands the conclusion to one of the agents, as an ordinary message (its approvals apply). */
  async carryOut(id: string, agent: AgentKey): Promise<void> {
    const found = this.locate(id);
    if (!found || found.d.state !== 'done' || !found.d.conclusion) return;
    const { chat, d } = found;
    const p = d.participants.find((x) => x.agent === agent);
    if (!p) throw new Error(`${speakerName(agent)} didn't take part in this discussion.`);
    this.patch(d, { carried: agent });
    const text = carryOutText(d);
    if (p.chatId === chat.id || !p.chatId) await this.host.send(chat.id, text);
    else await this.host.message(chat.id, p.chatId, text);
  }

  // ---- The loop ----

  private async run(chatId: string, id: string): Promise<void> {
    const live: Live = { stop: false };
    this.live.set(id, live);
    const guarded = new Set<string>();
    const guard = async (cid: string) => {
      if (guarded.has(cid)) return;
      guarded.add(cid);
      await this.host.guard(cid, true);
    };
    try {
      // Every way into the rounds (Start, Continue) comes here: an agent nothing holds to read only never takes part.
      const loose = this.get(chatId, id)?.participants.find((p) => NO_READ_ONLY.includes(p.agent));
      if (loose) throw new Error(noReadOnlyText(speakerName(loose.agent)));
      await guard(chatId);
      await this.conclude(chatId, id, live, await this.rounds(chatId, id, live, guard));
    } catch (err) {
      const d = this.get(chatId, id);
      if (d) this.finish(chatId, d, 'failed', fallbackConclusion({ ...d, ended: 'failed' }));
      throw err;
    } finally {
      this.live.delete(id);
      await Promise.all([...guarded].map((cid) => this.host.guard(cid, false).catch(() => {})));
    }
  }

  /** Rounds until the limit, agreement, the budget or Stop. */
  private async rounds(chatId: string, id: string, live: Live, guard: (cid: string) => Promise<void>): Promise<DiscussEnd> {
    for (let d = this.get(chatId, id)!; d.round <= d.maxRounds; d = this.get(chatId, id)!) {
      for (const p of d.participants) {
        d = this.get(chatId, id)!;
        if (live.stop) return 'stopped';
        if (d.tokens >= d.budget) return 'budget';
        const prompt = turnPrompt(d, p.agent);
        this.patch(d, { speaking: p.agent });
        let turn: DiscussTurn;
        try {
          const target = p.chatId ?? (await this.host.participant(chatId, p.agent));
          if (!p.chatId) this.patch(this.get(chatId, id)!, { participants: this.get(chatId, id)!.participants.map((x) => (x.agent === p.agent ? { ...x, chatId: target } : x)) });
          await guard(target);
          live.speaking = target;
          const reply = target === chatId ? await this.starterTurn(chatId, prompt) : await this.host.ask(chatId, target, p.agent, prompt);
          turn = { by: p.agent, round: d.round, text: stripStance(reply).slice(0, MAX_TURN_TEXT) || '(no answer)', stance: stanceOf(reply) };
          d = this.get(chatId, id)!;
          this.patch(d, { tokens: d.tokens + estimateTokens(prompt) + estimateTokens(reply) });
        } catch (err) {
          if (live.stop) return 'stopped';
          turn = { by: p.agent, round: d.round, text: `Couldn't answer: ${err instanceof Error ? err.message : String(err)}`.slice(0, 600), failed: true };
        } finally {
          live.speaking = undefined;
        }
        d = this.get(chatId, id)!;
        this.patch(d, { turns: [...d.turns, turn], speaking: undefined });
      }
      d = this.get(chatId, id)!;
      if (live.stop) return 'stopped';
      // Round 1's first speaker heard nobody yet: agreement counts from round 2.
      if (d.round >= 2 && allAgree(d.turns, d.round)) return 'agreed';
      if (d.turns.filter((t) => t.round === d.round && t.by !== 'you' && !t.failed).length < 2) return 'failed';
      if (d.round === d.maxRounds) return 'rounds';
      this.patch(d, { round: d.round + 1 });
      this.flushPoints(this.get(chatId, id)!, d.round + 1);
    }
    return 'rounds';
  }

  private async starterTurn(chatId: string, text: string): Promise<string> {
    const r = await this.host.prompt(chatId, text);
    if (!r.reply) throw new Error(r.stopReason && r.stopReason !== 'end_turn' ? `stopped (${r.stopReason})` : 'no reply');
    return r.reply;
  }

  /** The starting agent writes the conclusion; FriedLiver does when it was stopped or that fails. */
  private async conclude(chatId: string, id: string, live: Live, ended: DiscussEnd): Promise<void> {
    this.flushPoints(this.get(chatId, id)!, this.get(chatId, id)!.round + 1);
    let d = this.get(chatId, id)!;
    const agents = d.participants.map((p) => p.agent);
    let conclusion = undefined as DiscussionItem['conclusion'];
    if (ended !== 'stopped' && d.turns.some((t) => t.by !== 'you' && !t.failed)) {
      this.patch(d, { state: 'summarizing', speaking: agents[0] });
      const prompt = summaryPrompt(d, ended);
      try {
        live.speaking = chatId;
        const reply = await this.starterTurn(chatId, prompt);
        d = this.get(chatId, id)!;
        this.patch(d, { tokens: d.tokens + estimateTokens(prompt) + estimateTokens(reply) });
        conclusion = parseConclusion(reply, agents[0], agents);
      } catch {
        // Summed up below.
      } finally {
        live.speaking = undefined;
      }
      if (live.stop) ended = 'stopped';
    }
    d = this.get(chatId, id)!;
    this.finish(chatId, d, ended, conclusion ?? fallbackConclusion({ ...d, ended }));
  }

  private finish(chatId: string, d: DiscussionItem, ended: DiscussEnd, conclusion: NonNullable<DiscussionItem['conclusion']>): void {
    const items = this.chat(chatId)?.items ?? [];
    const at = items.findIndex((i) => i.kind === 'discussion' && i.id === d.id);
    this.patch(d, { state: 'done', ended, conclusion, speaking: undefined, span: at < 0 ? 0 : items.length - at - 1 });
  }

  // ---- State ----

  private patch(d: DiscussionItem, patch: Partial<DiscussionItem>): void {
    this.host.dispatch({ t: 'discussion', id: d.id, patch });
  }

  private find(chatId: string): DiscussionItem | undefined {
    const items = this.chat(chatId)?.items ?? [];
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.kind === 'discussion') return it;
    }
    return undefined;
  }

  private get(chatId: string, id: string): DiscussionItem | undefined {
    for (const i of this.chat(chatId)?.items ?? []) if (i.kind === 'discussion' && i.id === id) return i;
    return undefined;
  }

  private locate(id: string): { chat: ChatView; d: DiscussionItem } | undefined {
    for (const chat of this.host.state.chats) for (const i of chat.items) if (i.kind === 'discussion' && i.id === id) return { chat, d: i };
    return undefined;
  }

  private chat(chatId: string): ChatView | undefined {
    return this.host.state.chats.find((c) => c.id === chatId);
  }

  private require(chatId: string): ChatView {
    const chat = this.chat(chatId);
    if (!chat) throw new Error(`Unknown chat ${chatId}`);
    return chat;
  }
}

// ---- Prompts ----

const STANCE_ASK = [
  'End with your stance as a fenced block, exactly:',
  '```stance',
  '{"position": "<your answer in one line>", "side": "<the position you hold, named in 1 to 4 words>", "replyTo": "<the agent whose point you mainly answer, or empty>", "quote": "<their few words you answer>", "agree": ["<points of the others you accept>"], "disagree": ["<points you still dispute>"], "confidence": 0.8}',
  '```',
  'Leave "disagree" empty only when you have nothing left to dispute.',
].join('\n');

/** The positions named so far, so an agent holding one reuses its name ("side") and the card groups them. */
function sidesSoFar(d: DiscussionItem): string {
  const seen = new Map<string, string>();
  for (const t of d.turns) {
    const side = t.stance?.side;
    if (side && !seen.has(side.toLowerCase())) seen.set(side.toLowerCase(), side);
  }
  return seen.size ? `Positions named so far: ${[...seen.values()].map((x) => `"${x}"`).join(', ')}. If you hold one, use its exact name as "side".` : '';
}

function rendered(turns: DiscussTurn[]): string {
  return turns
    .map((t) => {
      const head = t.by === 'you' ? 'The user (between turns)' : `${speakerName(t.by)} (round ${t.round})`;
      const body = t.text.length > 4000 ? `${t.text.slice(0, 4000)}…` : t.text;
      const s = t.stance?.parsed ? `\n[stance: ${t.stance.position || '—'}${t.stance.disagree.length ? `; disputes: ${t.stance.disagree.join('; ')}` : '; disputes nothing'}]` : '';
      return `${head}:\n${body}${s}`;
    })
    .join('\n\n');
}

/** What `agent` hasn't heard yet: every turn after its own last one (all of them before its first). */
function unheard(d: DiscussionItem, agent: AgentKey): DiscussTurn[] {
  let last = -1;
  d.turns.forEach((t, n) => {
    if (t.by === agent) last = n;
  });
  return d.turns.slice(last + 1).filter((t) => t.by !== agent);
}

export function turnPrompt(d: DiscussionItem, agent: AgentKey): string {
  const others = d.participants.filter((p) => p.agent !== agent).map((p) => speakerName(p.agent));
  const first = !d.turns.some((t) => t.by === agent);
  const news = unheard(d, agent);
  const lines = ['[FriedLiver discussion]'];
  if (first) {
    lines.push(
      `You are ${speakerName(agent)}, discussing a question with ${others.join(' and ')}, taking turns, for ${d.maxRounds} round${d.maxRounds === 1 ? '' : 's'} at most.`,
      'It is read-only: read and search the code as you need, but FriedLiver refuses any edit, command or other change until it ends.',
      '',
      `Question: ${d.question}`,
    );
  }
  lines.push('', news.length ? `${first ? 'So far' : 'New since your last turn'}:\n\n${rendered(news)}` : 'You speak first.');
  lines.push(
    '',
    `Round ${d.round} of ${d.maxRounds}. In under 250 words: weigh the trade-offs for this project, answer the others' points, and change your mind when they convince you.`,
    STANCE_ASK,
  );
  const sides = sidesSoFar(d);
  if (sides) lines.push(sides);
  return lines.join('\n');
}

const WHY: Record<DiscussEnd, string> = {
  agreed: 'everyone agrees',
  rounds: 'the last round is over',
  budget: 'it used its token budget',
  stopped: 'the user stopped it',
  failed: 'too few agents could answer',
};

export function summaryPrompt(d: DiscussionItem, ended: DiscussEnd): string {
  const news = unheard(d, d.participants[0].agent);
  const agents = d.participants.map((p) => p.agent);
  return [
    `[FriedLiver discussion] The discussion has ended: ${WHY[ended]}.`,
    news.length ? `\nNew since your last turn:\n\n${rendered(news)}\n` : '',
    'Write its conclusion for the user, fairly, from the whole discussion: what everyone agreed on, where anyone still disagrees (each side with its reason), the one recommended next step, and how each round moved: converging (closer together), diverging (further apart) or stuck, and on what, in 2 to 5 words. Reply with only this fenced block:',
    '```conclusion',
    `{"agreed": ["..."], "disagreed": [{"point": "...", "sides": [{"agent": "${agents[0]}", "view": "... because ..."}]}], "next": "...", "carryOut": "${agents.join('|')}", "rounds": [{"round": 1, "trend": "converging|diverging|stuck", "on": "..."}]}`,
    '```',
  ].join('\n');
}
