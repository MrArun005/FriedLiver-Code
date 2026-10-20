import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DISCUSS_READ_ONLY, Discussions, discussionAllows, discussionAllowsBridge, summaryPrompt, turnPrompt, type DiscussHost } from '../src/host/discuss';
import { parseSaved, settleRestored } from '../src/host/persist';
import {
  allAgree,
  carryOutText,
  confidenceOf,
  discussMeta,
  discussingLabel,
  fallbackConclusion,
  parseConclusion,
  parseDiscuss,
  parseStance,
  stanceOf,
  savedDiscussion,
  stripStance,
  withoutDiscussionTurns,
  type DiscussionItem,
} from '../src/shared/discuss';
import { EMPTY_STATE, reduce, type Action, type AgentKey, type AppState, type ChatView, type Item } from '../src/shared/model';
import { slashAction } from '../src/shared/view';
import { parseWebviewMessage } from '../src/shared/messages';
import { discussView } from '../src/shared/discussView';
import type { ChatSession } from '../src/shared/session';
import type { ModelCatalog } from '../src/shared/discussMentions';
import { CATALOG } from './fixtures/models';
import { disposeCores, gitRepo, makeCore, waitFor } from './helpers';

afterEach(disposeCores);

const stance = (position: string, disagree: string[] = [], agree: string[] = [], confidence = 0.8) =>
  `\n\n\`\`\`stance\n${JSON.stringify({ position, agree, disagree, confidence })}\n\`\`\``;

const chat = (id: string, agent: AgentKey, over: Partial<ChatView> = {}): ChatView => ({
  id,
  agent,
  label: agent,
  title: 'Storage',
  cwd: '/w',
  createdAt: 0,
  busy: false,
  changedFiles: 0,
  items: [],
  depth: 0,
  files: [],
  lastActivity: 0,
  turns: 0,
  ...over,
});

type Reply = string | ((prompt: string, n: number) => string | Promise<string>);

/**
 * A host whose agents answer from a script: `replies[who][n]` is its n-th answer (the last one repeats);
 * `who` is the agent, or "agent/model" for a participant on a model. `models`: what each agent reports.
 */
function fakeHost(replies: Partial<Record<string, Reply[]>>, settings: { maxRounds?: number; tokenBudget?: number } = {}, models?: ModelCatalog, starter: Partial<ChatView> = {}) {
  let state: AppState = reduce(EMPTY_STATE, { t: 'created', chat: chat('chat-1', 'claude', starter) });
  let next = 1;
  const asked: { agent: string; prompt: string }[] = [];
  const guards: [string, boolean][] = [];
  const sent: [string, string, string?][] = [];
  const cancelled: string[] = [];
  const participants: string[] = [];
  const said = new Map<string, number>();
  const answer = async (agent: string, prompt: string) => {
    asked.push({ agent, prompt });
    const list = replies[agent] ?? ['ok'];
    const n = said.get(agent) ?? 0;
    said.set(agent, n + 1);
    const r = list[Math.min(n, list.length - 1)];
    return typeof r === 'function' ? r(prompt, n) : r;
  };
  const host: DiscussHost = {
    get state() {
      return state;
    },
    dispatch: (a: Action) => {
      state = reduce(state, a);
    },
    id: (p) => `${p}-${next++}`,
    settings: () => settings,
    participant: async (_source, agent, model, taken) => {
      const who = model ? `${agent}/${model}` : agent;
      participants.push(who);
      const id = `chat-${who}`;
      expect(taken).not.toContain(id);
      if (!state.chats.some((c) => c.id === id)) state = reduce(state, { t: 'created', chat: chat(id, agent) });
      return id;
    },
    ...(models ? { models: (agent: AgentKey) => models[agent] ?? [] } : {}),
    prompt: async (chatId, text) => {
      state = reduce(state, { t: 'items', chatId, items: [{ kind: 'link', linkId: 'discussion', role: 'piped-in', chatId, agent: 'claude', label: 'Discussion', text, by: 'user' }] });
      const reply = await answer('claude', text);
      state = reduce(state, { t: 'items', chatId, items: [{ kind: 'agent', text: reply }] });
      return { stopReason: reply ? 'end_turn' : 'cancelled', reply };
    },
    ask: async (_source, chatId, agent, text) => {
      expect(chatId.startsWith(`chat-${agent}`)).toBe(true);
      const reply = await answer(chatId.slice('chat-'.length), text);
      if (!reply) throw new Error('stopped without answering');
      return reply;
    },
    cancel: async (chatId) => {
      cancelled.push(chatId);
    },
    guard: async (chatId, on) => {
      guards.push([chatId, on]);
    },
    send: async (chatId, text) => {
      sent.push([chatId, text]);
    },
    message: async (from, to, text) => {
      sent.push([from, text, to]);
    },
  };
  const d = () => state.chats[0].items.find((i): i is DiscussionItem => i.kind === 'discussion')!;
  return { host, asked, guards, sent, cancelled, participants, d, discussions: new Discussions(host), get state() { return state; } };
}

const CONCLUSION = '```conclusion\n{"agreed":["Use Postgres"],"disagreed":[],"next":"Add the Postgres migration","carryOut":"codex"}\n```';

describe('/discuss: the orchestrator', () => {
  it('stops at the round limit, in a fixed order, then the starting agent sums it up', async () => {
    const h = fakeHost(
      {
        claude: [`Postgres.${stance('Postgres', ['MySQL is simpler to run'])}`, `Still Postgres.${stance('Postgres', ['ops cost'])}`, CONCLUSION],
        gemini: [`MySQL.${stance('MySQL', ['JSONB matters less'])}`],
        codex: [`Postgres.${stance('Postgres', ['replication story'])}`],
      },
      { maxRounds: 2 },
    );
    await h.discussions.start('chat-1', ['gemini', 'codex'], 'Postgres or MySQL?');
    const d = h.d();
    expect(d.state).toBe('done');
    expect(d.ended).toBe('rounds');
    expect(h.asked.map((a) => a.agent)).toEqual(['claude', 'gemini', 'codex', 'claude', 'gemini', 'codex', 'claude']);
    expect(d.turns.map((t) => `${t.by}:${t.round}`)).toEqual(['claude:1', 'gemini:1', 'codex:1', 'claude:2', 'gemini:2', 'codex:2']);
    expect(d.conclusion).toMatchObject({ agreed: ['Use Postgres'], next: 'Add the Postgres migration', by: 'claude', carryOut: 'codex' });
    // Each agent's chat is found once, then reused.
    expect(h.participants).toEqual(['gemini', 'codex']);
    expect(d.participants).toEqual([
      { agent: 'claude', chatId: 'chat-1' },
      { agent: 'gemini', chatId: 'chat-gemini' },
      { agent: 'codex', chatId: 'chat-codex' },
    ]);
  });

  it('clamps the round setting to 1..5', async () => {
    const h = fakeHost({ claude: [`a${stance('A', ['x'])}`], gemini: [`b${stance('B', ['y'])}`] }, { maxRounds: 99 });
    await h.discussions.start('chat-1', ['gemini'], 'q');
    expect(h.d().maxRounds).toBe(5);
    expect(h.d().turns).toHaveLength(10);
  });

  it('stops early once everyone agrees (from round 2: the first speaker has heard nobody in round 1)', async () => {
    const h = fakeHost(
      {
        claude: [`Postgres${stance('Postgres')}`, `Agreed${stance('Postgres', [], ['JSONB'])}`, CONCLUSION],
        gemini: [`Fine${stance('Postgres')}`],
      },
      { maxRounds: 5 },
    );
    await h.discussions.start('chat-1', ['gemini'], 'Postgres or MySQL?');
    expect(h.d().ended).toBe('agreed');
    expect(h.d().turns).toHaveLength(4);
    expect(h.d().round).toBe(2);
  });

  it('a turn without a stance block never counts as agreement', async () => {
    const h = fakeHost({ claude: ['I think Postgres. It has JSONB.', CONCLUSION], gemini: ['Sure.'] }, { maxRounds: 2 });
    await h.discussions.start('chat-1', ['gemini'], 'q');
    expect(h.d().ended).toBe('rounds');
    expect(h.d().turns[0].stance).toMatchObject({ parsed: false, position: 'I think Postgres.' });
  });

  it('stops at the token budget and still ends with a summary', async () => {
    const big = 'word '.repeat(4000);
    const h = fakeHost({ claude: [`${big}${stance('A', ['x'])}`, CONCLUSION], gemini: [`${big}${stance('B', ['y'])}`] }, { maxRounds: 5, tokenBudget: 1 });
    await h.discussions.start('chat-1', ['gemini'], 'q');
    const d = h.d();
    expect(d.budget).toBe(5000);
    expect(d.ended).toBe('budget');
    expect(d.turns.length).toBeLessThan(10);
    expect(d.conclusion?.by).toBe('claude');
  });

  it("FriedLiver sums up from the stances when the starting agent's summary doesn't parse", async () => {
    const h = fakeHost(
      {
        claude: [`P${stance('Postgres', ['ops'], ['JSONB is useful'])}`, 'no json here'],
        gemini: [`M${stance('MySQL', ['JSONB'], ['Postgres has better types'])}`],
      },
      { maxRounds: 1 },
    );
    await h.discussions.start('chat-1', ['gemini'], 'q');
    const c = h.d().conclusion!;
    expect(c.by).toBe('friedliver');
    expect(c.agreed).toEqual(['JSONB is useful', 'Postgres has better types']);
    expect(c.disagreed.map((x) => x.point)).toEqual(['Claude: ops', 'Gemini: JSONB']);
    expect(c.disagreed[0].sides).toEqual([
      { agent: 'claude', view: 'Postgres' },
      { agent: 'gemini', view: 'MySQL' },
    ]);
  });

  it('Stop cancels the turn being spoken, asks nobody more and sums up without another turn', async () => {
    let release!: (s: string) => void;
    const h = fakeHost({ claude: [`P${stance('Postgres', ['x'])}`], gemini: [() => new Promise<string>((r) => (release = r))] }, { maxRounds: 3 });
    const done = h.discussions.start('chat-1', ['gemini'], 'q');
    await waitFor(() => h.d().speaking === 'gemini' && !!release);
    await h.discussions.stop(h.d().id);
    expect(h.cancelled).toEqual(['chat-gemini']);
    release('');
    await done;
    expect(h.d()).toMatchObject({ state: 'done', ended: 'stopped' });
    expect(h.d().conclusion?.by).toBe('friedliver');
    expect(h.asked).toHaveLength(2);
    // Read-only went on for each chat before its first turn, and off for all of them at the end.
    expect(h.guards).toEqual([
      ['chat-1', true],
      ['chat-gemini', true],
      ['chat-1', false],
      ['chat-gemini', false],
    ]);
  });

  it('Antigravity takes part like any agent: its chat goes read only (talk only) before its first turn', async () => {
    const h = fakeHost({ claude: [`P${stance('Postgres', ['x'])}`, CONCLUSION], antigravity: [`M${stance('MySQL', ['y'])}`] }, { maxRounds: 1 });
    await h.discussions.start('chat-1', [{ agent: 'antigravity' }], 'q');
    expect(h.d()).toMatchObject({ state: 'done', ended: 'rounds' });
    expect(h.asked.map((a) => a.agent)).toEqual(['claude', 'antigravity', 'claude']);
    expect(h.guards).toEqual([
      ['chat-1', true],
      ['chat-antigravity', true],
      ['chat-1', false],
      ['chat-antigravity', false],
    ]);
  });

  it('a point added while it runs waits for the round to end, then everyone hears it from the next round', async () => {
    let release!: () => void;
    const h = fakeHost(
      { claude: [async () => (await new Promise<void>((r) => (release = r)), `P${stance('Postgres', ['x'])}`), `P2${stance('Postgres', ['x'])}`, CONCLUSION], gemini: [`M${stance('MySQL', ['y'])}`] },
      { maxRounds: 2 },
    );
    const done = h.discussions.start('chat-1', ['gemini'], 'q');
    await waitFor(() => !!release);
    expect(h.discussions.runningIn('chat-1')).toBeDefined();
    h.discussions.addPoint(h.d().id, 'We already run MySQL in prod.');
    expect(h.d().points).toEqual(['We already run MySQL in prod.']);
    release();
    await done;
    // Gemini, still in round 1, didn't hear it; Claude, opening round 2, did.
    expect(h.asked[1].prompt).not.toContain('We already run MySQL in prod.');
    expect(h.asked[2].prompt).toContain('The user (between turns):\nWe already run MySQL in prod.');
    expect(h.d().turns.map((t) => [t.by, t.round])).toEqual([['claude', 1], ['gemini', 1], ['you', 2], ['claude', 2], ['gemini', 2]]);
    expect(h.d().points).toBeUndefined();
    expect(h.discussions.runningIn('chat-1')).toBeUndefined();
  });

  it('a point added in the last round goes to the summing up', async () => {
    let release!: () => void;
    const h = fakeHost({ claude: [async () => (await new Promise<void>((r) => (release = r)), `P${stance('Postgres', ['x'])}`), CONCLUSION], gemini: [`M${stance('MySQL', ['y'])}`] }, { maxRounds: 1 });
    const done = h.discussions.start('chat-1', ['gemini'], 'q');
    await waitFor(() => !!release);
    h.discussions.interject('chat-1', 'Budget matters.');
    release();
    await done;
    expect(h.asked.at(-1)!.prompt).toContain('Budget matters.');
    expect(h.d().turns.at(-1)).toMatchObject({ by: 'you', round: 2, text: 'Budget matters.' });
  });

  it('asks for the side, whose point it answers, and later names the sides so far; the summary asks for round trends', async () => {
    const h = fakeHost({ claude: [`P${stance('Postgres', ['x'])}`.replace('"position"', '"side":"Postgres","position"'), `P2${stance('Postgres', ['x'])}`, CONCLUSION], gemini: [`M${stance('MySQL', ['y'])}`] }, { maxRounds: 2 });
    await h.discussions.start('chat-1', ['gemini'], 'Postgres or MySQL?');
    expect(h.asked[0].prompt).toMatch(/"side": .*"replyTo": .*"quote"/);
    expect(h.asked[1].prompt).toContain('Positions named so far: "Postgres"');
    expect(h.asked.at(-1)!.prompt).toContain('"rounds": [{"round": 1, "trend": "converging|diverging|stuck"');
    expect(h.d().turns[0].stance?.side).toBe('Postgres');
  });

  it("each prompt carries only what the agent hasn't heard, and asks for a stance block", async () => {
    const h = fakeHost({ claude: [`P${stance('Postgres', ['x'])}`, `P2${stance('Postgres', ['x'])}`, CONCLUSION], gemini: [`M${stance('MySQL', ['y'])}`] }, { maxRounds: 2 });
    await h.discussions.start('chat-1', ['gemini'], 'Postgres or MySQL?');
    const [first, second, third] = h.asked.map((a) => a.prompt);
    expect(first).toContain('Question: Postgres or MySQL?');
    expect(first).toContain('You speak first.');
    expect(first).toContain('```stance');
    expect(second).toContain('Claude (round 1):\nP');
    expect(third).not.toContain('Question:');
    expect(third).toContain('New since your last turn:\n\nGemini (round 1):\nM');
    expect(third).not.toContain('Claude (round 1)');
  });

  it('a failing agent is noted, and too few answers end it', async () => {
    const h = fakeHost({ claude: [`P${stance('Postgres', ['x'])}`, CONCLUSION], gemini: [''] }, { maxRounds: 3 });
    await h.discussions.start('chat-1', ['gemini'], 'q');
    expect(h.d().ended).toBe('failed');
    expect(h.d().turns[1]).toMatchObject({ by: 'gemini', failed: true });
  });

  it('refuses a busy chat, a second discussion and no other agent', async () => {
    const h = fakeHost({});
    await expect(h.discussions.start('chat-1', ['claude'], 'q')).rejects.toThrow(/other agent/);
    h.host.dispatch({ t: 'busy', chatId: 'chat-1', busy: true });
    await expect(h.discussions.start('chat-1', ['gemini'], 'q')).rejects.toThrow(/still working/);
  });

  it('Continue discussing runs more rounds in a new card that keeps the transcript', async () => {
    const h = fakeHost({ claude: [`P${stance('Postgres', ['x'])}`, CONCLUSION, `P2${stance('Postgres', ['x'])}`, CONCLUSION], gemini: [`M${stance('MySQL', ['y'])}`] }, { maxRounds: 1 });
    await h.discussions.start('chat-1', ['gemini'], 'q');
    const first = h.d();
    await h.discussions.continue(first.id);
    const cards = h.state.chats[0].items.filter((i): i is DiscussionItem => i.kind === 'discussion');
    expect(cards).toHaveLength(2);
    expect(cards[0].continued).toBe(true);
    expect(cards[1]).toMatchObject({ state: 'done', round: 2, maxRounds: 2 });
    expect(cards[1].turns.map((t) => t.round)).toEqual([1, 1, 2, 2]);
  });

  it('Carry out hands the conclusion to the starting chat, or to the other agent’s chat', async () => {
    const h = fakeHost({ claude: [`P${stance('Postgres', ['x'])}`, CONCLUSION], gemini: [`M${stance('MySQL', ['y'])}`] }, { maxRounds: 1 });
    await h.discussions.start('chat-1', ['gemini'], 'Postgres or MySQL?');
    await h.discussions.carryOut(h.d().id, 'claude');
    await h.discussions.carryOut(h.d().id, 'gemini');
    expect(h.sent[0][0]).toBe('chat-1');
    expect(h.sent[0][1]).toContain('Recommended next step: Add the Postgres migration');
    expect(h.sent[1]).toEqual(['chat-1', h.sent[0][1], 'chat-gemini']);
    expect(h.d().carried).toBe('gemini');
    await expect(h.discussions.carryOut(h.d().id, 'codex')).rejects.toThrow(/didn't take part/);
  });
});

describe('/discuss: stances', () => {
  it('reads the fenced stance block, the last one winning', () => {
    const s = parseStance(`text\n${stance('old', ['a'])}\nmore${stance('Postgres', [], ['JSONB'], 0.9)}`);
    expect(s).toEqual({ position: 'Postgres', agree: ['JSONB'], disagree: [], confidence: 0.9, parsed: true });
  });
  it('reads a json fence or a bare JSON object', () => {
    expect(parseStance('x ```json\n{"position":"A","agree":[],"disagree":["b"]}\n```')).toMatchObject({ position: 'A', disagree: ['b'] });
    expect(parseStance('so {"position": "A", "disagree": "b; c", "confidence": "80%"} end')).toMatchObject({ disagree: ['b', 'c'], confidence: 0.8 });
  });
  it('reads Agree/Disagree lines, bold or not', () => {
    const s = parseStance('My view.\n**Position:** Postgres\n**Agree:** JSONB; types\nDisagree: none\nConfidence: high');
    expect(s).toEqual({ position: 'Postgres', agree: ['JSONB', 'types'], disagree: [], confidence: 0.85, parsed: true });
  });
  it('survives broken JSON and missing blocks with a guess', () => {
    expect(parseStance('```stance\n{"position": "A", agree: [}\n```')).toBeUndefined();
    expect(stanceOf('Postgres wins. Because.')).toEqual({ position: 'Postgres wins.', agree: [], disagree: [], parsed: false });
  });
  it('reads confidence in any usual form', () => {
    expect([0.7, '0.7', '70%', 70, '7/10', 'medium', -1, 'lots', 250].map(confidenceOf)).toEqual([0.7, 0.7, 0.7, 0.7, 0.7, 0.6, undefined, undefined, undefined]);
  });
  it('strips the stance block from the shown text', () => expect(stripStance(`Hello${stance('A')}`)).toBe('Hello'));
  it('agrees only when every speaker of the round gave a stance disputing nothing', () => {
    const t = (by: AgentKey, disagree: string[], parsed = true) => ({ by, round: 2, text: '', stance: { position: '', agree: [], disagree, parsed } });
    expect(allAgree([t('claude', []), t('gemini', [])], 2)).toBe(true);
    expect(allAgree([t('claude', []), t('gemini', ['x'])], 2)).toBe(false);
    expect(allAgree([t('claude', []), t('gemini', [], false)], 2)).toBe(false);
    expect(allAgree([t('claude', [])], 2)).toBe(false);
  });
});

describe('/discuss: conclusions', () => {
  it('reads the summary block and drops agents that did not take part', () => {
    const c = parseConclusion(
      '```conclusion\n{"agreed":["a"],"disagreed":[{"point":"p","sides":[{"agent":"gemini","view":"v"},{"agent":"codex","view":"w"}]}],"next":"n","carryOut":"codex"}\n```',
      'claude',
      ['claude', 'gemini'],
    );
    expect(c).toEqual({ agreed: ['a'], disagreed: [{ point: 'p', sides: [{ agent: 'gemini', view: 'v' }] }], next: 'n', by: 'claude' });
    expect(parseConclusion('{"agreed": []}', 'claude', ['claude'])).toBeUndefined();
  });
  it('FriedLiver recommends the starter’s position when nobody disputes it', () => {
    const c = fallbackConclusion({
      participants: [{ agent: 'claude' }, { agent: 'gemini' }],
      turns: [{ by: 'claude', round: 1, text: '', stance: { position: 'Postgres', agree: [], disagree: [], parsed: true } }],
    });
    expect(c.next).toBe("Go with Claude's position: Postgres");
  });
  it('the carry-out message names the agreement, the open points and the next step', () => {
    const t = carryOutText({ question: 'Q?', conclusion: { agreed: ['a'], disagreed: [{ point: 'p', sides: [] }], next: 'n', by: 'claude' } });
    expect(t).toContain('Question: Q?');
    expect(t).toContain('- a');
    expect(t).toContain('- p');
    expect(t).toContain('Recommended next step: n');
  });
});

describe('/discuss: the command', () => {
  it('reads the mentions and the question', () => {
    expect(parseDiscuss('/discuss @gemini @codex Postgres or MySQL?', 'claude')).toEqual({ participants: [{ agent: 'gemini' }, { agent: 'codex' }], question: 'Postgres or MySQL?', problems: [] });
    expect(parseDiscuss('/discuss @gpt, @claude: which ORM', 'claude')).toEqual({ participants: [{ agent: 'codex' }], question: 'which ORM', problems: [] });
    expect(parseDiscuss('/discuss @gemini', 'claude')).toBe('incomplete');
    expect(parseDiscuss('/discuss which?', 'claude')).toBe('incomplete');
    expect(parseDiscuss('/discussion x', 'claude')).toBeNull();
  });
  it('goes through the composer’s slash command path', () => {
    const c = chat('chat-1', 'claude');
    expect(slashAction('/discuss @gemini @codex Postgres or MySQL?', c, [c], [])).toEqual({ type: 'discuss', chatId: 'chat-1', participants: [{ agent: 'gemini' }, { agent: 'codex' }], text: 'Postgres or MySQL?' });
    expect(slashAction('/discuss @gemini', c, [c], [])).toBe('incomplete');
  });
  it('sends models and waits while a mention is ambiguous or unknown', () => {
    const c = chat('chat-1', 'claude');
    expect(slashAction('/discuss Postgres or MySQL? @opus @sonnet @gemini', c, [c], [], CATALOG)).toEqual({
      type: 'discuss',
      chatId: 'chat-1',
      participants: [{ agent: 'claude', model: 'claude-opus-4-5' }, { agent: 'claude', model: 'claude-sonnet-4-5' }, { agent: 'gemini' }],
      text: 'Postgres or MySQL?',
    });
    expect(slashAction('/discuss @gpt-5.6 q', c, [c], [], CATALOG)).toBe('incomplete');
    expect(slashAction('/discuss @nope @gemini q', c, [c], [], CATALOG)).toBe('incomplete');
  });
});

describe('/discuss: read-only', () => {
  it('lets reads, searches and the FriedLiver look-only tools through, nothing else', () => {
    for (const kind of ['read', 'search', 'fetch']) expect(discussionAllows({ kind })).toBe(true);
    for (const kind of ['edit', 'delete', 'move', 'execute', 'switch_mode', 'think', 'other', null, undefined, 'READ']) expect(discussionAllows({ kind })).toBe(false);
    expect(discussionAllows({ kind: 'read', diffs: true })).toBe(false);
    expect(discussionAllows({ kind: 'read', command: true })).toBe(false);
    expect(discussionAllows({ kind: 'other', toolName: 'mcp__friedliver__index_search' })).toBe(true);
    expect(discussionAllows({ kind: 'other', toolName: 'mcp__friedliver-browser__browser_snapshot' })).toBe(true);
    expect(discussionAllows({ kind: 'other', toolName: 'mcp__friedliver__remember' })).toBe(false);
    expect(discussionAllows({ kind: 'other', toolName: 'mcp__friedliver__system_open' })).toBe(false);
    expect(discussionAllows({ kind: 'other', toolName: 'mcp__friedliver__browser_click' })).toBe(false);
    expect(['index_search', 'list_chats', 'read_chat', 'browser_snapshot'].every((tool) => discussionAllowsBridge({ tool: tool as never }))).toBe(true);
    expect(['ask_agent', 'send_to_chat', 'remember', 'browser_click', 'browser_open', 'system_open', 'system_clipboard_write', 'index_', 'index_write'].some((tool) => discussionAllowsBridge({ tool: tool as never }))).toBe(false);
  });

  it('never trusts a title or a look-alike name: spoofs, other servers and case tricks are refused', () => {
    // The title is the agent's or the tool's own text: it decides nothing.
    for (const title of ['friedliver index_read', 'mcp__friedliver__index_read', 'mcp__friedliver__index_read; rm -rf /'])
      expect(discussionAllows({ kind: 'edit', title } as never)).toBe(false);
    for (const toolName of [
      'mcp__friedliver__index_read; rm',
      'mcp__friedliver__index_read ',
      'mcp__friedliver-evil__index_read',
      'mcp__evil_friedliver__index_read',
      'mcp__other__index_search',
      'mcp__FriedLiver__index_read',
      'mcp__friedliver__INDEX_READ',
      'mcp__friedliver__index_readx',
      'xmcp__friedliver__index_read',
      'mcp__friedliver__',
    ])
      expect(discussionAllows({ kind: 'read', toolName }), toolName).toBe(false);
    // Missing name: only the kind counts, and only a read kind.
    expect(discussionAllows({ kind: 'other', toolName: undefined })).toBe(false);
    expect(discussionAllows({})).toBe(false);
  });

  const guard = (core: ReturnType<typeof makeCore>, chatId: string, on: boolean) => (core as unknown as { guardDiscussion(id: string, on: boolean): Promise<void> }).guardDiscussion(chatId, on);
  const mode = (core: ReturnType<typeof makeCore>, chatId: string) => core.chat(chatId)?.session?.options.find((o) => o.category === 'mode')?.current;

  it('a discussing chat in Full auto can still read, but every write and command is refused', async () => {
    const dir = await gitRepo();
    const file = path.join(dir, 'db.ts');
    await writeFile(file, 'keep\n');
    const core = makeCore(dir);
    const c = await core.createChat('claude', { approval: 'full' });
    await core.send(c.id, 'hi');
    expect(mode(core, c.id)).toBe('bypassPermissions');
    await guard(core, c.id, true);
    expect(mode(core, c.id)).toBe('plan');
    // Asked to edit: the request is refused before any rule or level, and says why.
    await core.send(c.id, `edit ${file}`);
    const refused = core.chat(c.id)!.items.filter((i) => i.kind === 'permission').at(-1);
    expect(refused).toMatchObject({ auto: 'Read-only during the discussion', answer: 'Reject' });
    await core.send(c.id, 'run');
    expect(core.chat(c.id)!.items.some((i) => i.kind === 'agent' && /denied the command/.test(i.text))).toBe(true);
    await core.send(c.id, `native-read ${file}`);
    expect(core.chat(c.id)!.items.some((i) => i.kind === 'agent' && /Allowed to read/.test(i.text))).toBe(true);
    // Even if the agent left its read-only mode and wrote on its own, the write is refused.
    await core.setApproval(c.id, 'full');
    await core.send(c.id, `edit ${file}`);
    expect(await readFile(file, 'utf8')).toBe('keep\n');
    await expect(core.bridgeCall(c.id, { tool: 'remember', fact: 'x' }, new AbortController().signal)).rejects.toThrow(DISCUSS_READ_ONLY);
    await expect(core.bridgeCall(c.id, { tool: 'ask_agent', agent: 'gemini', prompt: 'x' }, new AbortController().signal)).rejects.toThrow(DISCUSS_READ_ONLY);
    // Afterwards the chat is itself again.
    await guard(core, c.id, false);
    await core.send(c.id, `edit ${file}`);
    expect(await readFile(file, 'utf8')).toBe('edited by fake agent\n');
  });

  it('stays read-only until every discussion the chat is in has ended, whatever order they end in', async () => {
    const dir = await gitRepo();
    const file = path.join(dir, 'db.ts');
    await writeFile(file, 'keep\n');
    const core = makeCore(dir);
    const c = await core.createChat('claude', { approval: 'full' });
    await core.send(c.id, 'hi');
    const refused = () => core.bridgeCall(c.id, { tool: 'remember', fact: 'x' }, new AbortController().signal).then(() => false, (e: Error) => e.message === DISCUSS_READ_ONLY);
    await guard(core, c.id, true);
    await guard(core, c.id, true);
    await guard(core, c.id, false);
    // One discussion is still running: read-only and Plan mode stay.
    expect(await refused()).toBe(true);
    expect(mode(core, c.id)).toBe('plan');
    await core.send(c.id, `edit ${file}`);
    expect(await readFile(file, 'utf8')).toBe('keep\n');
    await guard(core, c.id, false);
    expect(await refused()).toBe(false);
    expect(mode(core, c.id)).toBe('bypassPermissions');
    // A second end (Stop after a crash, say) doesn't go below zero or put a mode back again.
    await guard(core, c.id, false);
    await guard(core, c.id, true);
    expect(await refused()).toBe(true);
    await guard(core, c.id, false);
    expect(await refused()).toBe(false);
  });

  it('two discussions sharing a participant: the first to end leaves it read-only for the other', async () => {
    const dir = await gitRepo();
    const core = makeCore(dir);
    const a = await core.createChat('claude');
    const b = await core.createChat('gemini');
    const shared = await core.createChat('codex');
    const g = (id: string, on: boolean) => guard(core, id, on);
    const refused = () => core.bridgeCall(shared.id, { tool: 'remember', fact: 'x' }, new AbortController().signal).then(() => false, (e: Error) => e.message === DISCUSS_READ_ONLY);
    await g(a.id, true);
    await g(shared.id, true);
    await g(b.id, true);
    await g(shared.id, true);
    await g(a.id, false);
    await g(shared.id, false);
    expect(await refused()).toBe(true);
    await g(b.id, false);
    await g(shared.id, false);
    expect(await refused()).toBe(false);
  });

  it('puts the mode the chat had back when the discussion ends', async () => {
    const dir = await gitRepo();
    const core = makeCore(dir);
    const c = await core.createChat('claude', { approval: 'full' });
    await core.send(c.id, 'hi');
    await guard(core, c.id, true);
    await guard(core, c.id, false);
    expect(mode(core, c.id)).toBe('bypassPermissions');
  });
});

describe('/discuss: end to end (Demo agents)', () => {
  it('runs in the chat, folds its turns into the card, and leaves nobody read-only', async () => {
    const dir = await gitRepo();
    const core = makeCore(dir, { discussSettings: () => ({ maxRounds: 1 }) });
    const c = await core.createChat('claude');
    await core.discuss(c.id, ['codex'], 'Postgres or MySQL for the audit log?');
    const items = core.chat(c.id)!.items;
    const d = items.find((i): i is DiscussionItem => i.kind === 'discussion')!;
    expect(d).toMatchObject({ state: 'done', ended: 'rounds' });
    expect(d.turns.map((t) => t.by)).toEqual(['claude', 'codex']);
    const codexChat = d.participants[1].chatId!;
    expect(core.chat(codexChat)?.origin).toMatchObject({ kind: 'consult', chatId: c.id });
    // The Demo agent echoes the summary prompt, whose example block parses.
    expect(d.conclusion?.by).toBe('claude');
    // The chat shows your command and the card; the turns it took are in the card.
    const shown = withoutDiscussionTurns(items).map((i) => i.kind);
    expect(shown).toEqual(['user', 'discussion']);
    expect(d.span).toBe(items.length - 2);
    // Nobody is read-only now: a message goes to the agent, not the discussion.
    await core.send(c.id, 'hello');
    expect(core.chat(c.id)!.items.at(-1)).toMatchObject({ kind: 'agent' });
  });

  it('a message while it runs goes into the discussion, not to the agent', async () => {
    const dir = await gitRepo();
    const core = makeCore(dir, { discussSettings: () => ({ maxRounds: 1 }) });
    const c = await core.createChat('claude');
    const run = core.discuss(c.id, ['codex'], 'q');
    await waitFor(() => !!core.discussions.runningIn(c.id));
    await core.send(c.id, 'We run MySQL already.');
    await run;
    const d = core.chat(c.id)!.items.find((i): i is DiscussionItem => i.kind === 'discussion')!;
    expect(d.turns.some((t) => t.by === 'you' && t.text === 'We run MySQL already.')).toBe(true);
  });
});

describe('/discuss: saved and restored', () => {
  const base: DiscussionItem = {
    kind: 'discussion',
    id: 'discuss-1',
    question: 'Postgres or MySQL?',
    participants: [{ agent: 'claude', chatId: 'chat-1' }, { agent: 'gemini', chatId: 'chat-2' }],
    maxRounds: 3,
    round: 2,
    state: 'running',
    speaking: 'gemini',
    turns: [{ by: 'claude', round: 1, text: 'P', stance: { position: 'Postgres', agree: [], disagree: ['x'], parsed: true } }],
    tokens: 100,
    budget: 60000,
  };
  const saved = (items: Item[]) => ({
    version: 1,
    state: { chats: [chat('chat-1', 'claude', { items })], links: [] },
    chats: { 'chat-1': { agent: 'claude', cwd: '/w' } },
  });

  it('a finished card comes back as it was', () => {
    const done: DiscussionItem = { ...base, state: 'done', ended: 'agreed', speaking: undefined, span: 1, conclusion: { agreed: ['a'], disagreed: [], next: 'n', by: 'claude', carryOut: 'gemini' }, carried: 'claude' };
    const back = parseSaved(JSON.parse(JSON.stringify(saved([done, { kind: 'agent', text: 'x' }]))))!;
    const d = back.state.chats[0].items[0] as DiscussionItem;
    expect(d).toMatchObject({ state: 'done', ended: 'agreed', span: 1, carried: 'claude', conclusion: { agreed: ['a'], next: 'n', by: 'claude', carryOut: 'gemini' } });
    expect(d.turns[0].stance).toEqual(base.turns[0].stance);
  });

  it('one still running when the window closed ends there, summed up by FriedLiver, its turns still folded', () => {
    const back = settleRestored(parseSaved(JSON.parse(JSON.stringify(saved([base, { kind: 'agent', text: 'x' }, { kind: 'agent', text: 'y' }]))))!.state);
    const d = back.chats[0].items[0] as DiscussionItem;
    expect(d).toMatchObject({ state: 'done', ended: 'stopped', span: 2 });
    expect(d.speaking).toBeUndefined();
    expect(d.conclusion?.by).toBe('friedliver');
  });

  it('a malformed card is dropped, the chat kept', () => {
    const back = parseSaved(saved([{ kind: 'discussion', id: 'bad id!' } as unknown as Item, { kind: 'agent', text: 'x' }]))!;
    expect(back.state.chats[0].items).toEqual([{ kind: 'agent', text: 'x' }]);
  });

  it('the reducer patches the card by id', () => {
    let s = reduce(EMPTY_STATE, { t: 'created', chat: chat('chat-1', 'claude', { items: [base] }) });
    s = reduce(s, { t: 'discussion', id: 'discuss-1', patch: { round: 3 } });
    expect((s.chats[0].items[0] as DiscussionItem).round).toBe(3);
  });

  it('the chat view keeps what waits for you inside a running discussion', () => {
    const items: Item[] = [
      { kind: 'user', text: '/discuss', images: [] },
      base,
      { kind: 'agent', text: 'turn' },
      { kind: 'permission', requestId: 'p', title: 'Read', options: [] },
    ];
    expect(withoutDiscussionTurns(items).map((i) => i.kind)).toEqual(['user', 'discussion', 'permission']);
    const done = [items[0], { ...base, state: 'done' as const, span: 1 }, { kind: 'agent' as const, text: 'turn' }, { kind: 'agent' as const, text: 'after' }];
    expect(withoutDiscussionTurns(done).map((i) => (i.kind === 'agent' ? i.text : i.kind))).toEqual(['user', 'discussion', 'after']);
  });

  it('a turn prompt names the read-only rule', () => expect(turnPrompt(base, 'gemini')).toMatch(/refuses any edit, command or other change/));
});

describe('/discuss: the chat header says so while it runs', () => {
  const d: DiscussionItem = {
    kind: 'discussion',
    id: 'discuss-1',
    question: 'Postgres or MySQL?',
    participants: [{ agent: 'claude' }, { agent: 'gemini' }],
    maxRounds: 3,
    round: 2,
    state: 'running',
    speaking: 'gemini',
    turns: [],
    tokens: 0,
    budget: 60000,
  };
  const user: Item = { kind: 'user', text: 'q', images: [] };

  it('names who speaks, then who sums up, and nothing once it ends or moved on', () => {
    expect(discussingLabel([user, d])).toBe('Discussing · Gemini speaking');
    expect(discussingLabel([user, { ...d, speaking: undefined }])).toBe('Discussing');
    expect(discussingLabel([user, { ...d, state: 'summarizing', speaking: undefined }])).toBe('Discussing · Claude summing up');
    expect(discussingLabel([user, { ...d, state: 'done', ended: 'agreed' }])).toBeUndefined();
    expect(discussingLabel([user, { ...d, continued: true }])).toBeUndefined();
    expect(discussingLabel([user])).toBeUndefined();
  });
});

describe('/discuss: participants on models', () => {
  const OPUS = 'claude/claude-opus-4-5';
  const SONNET = 'claude/claude-sonnet-4-5';
  /** A Claude chat on Opus 4.5, as its session reports it. */
  const onOpus: ChatSession = {
    options: [{ id: 'model', name: 'Model', category: 'model', type: 'select', current: 'claude-opus-4-5', choices: CATALOG.claude!, via: 'option' }],
    commands: [],
    live: true,
  };
  const stanceTo = (position: string, replyTo: string, disagree: string[] = ['x']) =>
    `\n\n\`\`\`stance\n${JSON.stringify({ position, replyTo, quote: 'their words', agree: [], disagree, confidence: 0.7 })}\n\`\`\``;

  it('the same agent twice: Claude · Opus and Claude · Sonnet, each in its own chat, then Gemini', async () => {
    const h = fakeHost(
      {
        claude: [
          `Postgres.${stance('Postgres', ['ops'])}`,
          '```conclusion\n{"agreed":["a"],"disagreed":[{"point":"p","sides":[{"agent":"Claude · Opus 4.5","view":"v1"},{"agent":"' + SONNET + '","view":"v2"},{"agent":"claude","view":"dropped: two Claudes"}]}],"next":"n","carryOut":"Claude · Sonnet 4.5"}\n```',
        ],
        [SONNET]: [`MySQL.${stanceTo('MySQL', 'Claude · Opus 4.5')}`],
        gemini: [`MySQL.${stanceTo('MySQL', SONNET)}`],
      },
      { maxRounds: 1 },
      CATALOG,
      { session: onOpus },
    );
    await h.discussions.start('chat-1', [{ agent: 'claude', model: 'claude-sonnet-4-5' }, 'gemini', { agent: 'claude', model: 'claude-opus-4-5' }], 'Postgres or MySQL?');
    const d = h.d();
    expect(d.participants).toEqual([
      { agent: 'claude', model: 'claude-opus-4-5', modelName: 'Opus 4.5', chatId: 'chat-1' },
      { agent: 'claude', model: 'claude-sonnet-4-5', modelName: 'Sonnet 4.5', chatId: `chat-${SONNET}` },
      { agent: 'gemini', chatId: 'chat-gemini' },
    ]);
    expect(h.participants).toEqual([SONNET, 'gemini']);
    expect(d.turns.map((t) => t.by)).toEqual([OPUS, SONNET, 'gemini']);
    // Replies name a participant by its name or key.
    expect(d.turns[1].stance?.re).toEqual({ agent: OPUS, quote: 'their words' });
    expect(d.turns[2].stance?.re).toEqual({ agent: SONNET, quote: 'their words' });
    // Each is told who it is and who the others are, by model.
    const sonnetPrompt = h.asked.find((a) => a.agent === SONNET)!.prompt;
    expect(sonnetPrompt).toContain('You are Claude · Sonnet 4.5, discussing a question with Claude · Opus 4.5 and Gemini');
    expect(sonnetPrompt).toContain('Claude · Opus 4.5 (round 1):');
    // The summing up names them by key; a bare "claude" fits two participants, so that side is dropped.
    expect(h.asked.at(-1)!.prompt).toContain(`"${OPUS}" (Claude · Opus 4.5), "${SONNET}" (Claude · Sonnet 4.5), "gemini" (Gemini)`);
    expect(d.conclusion).toMatchObject({ by: OPUS, carryOut: SONNET, disagreed: [{ point: 'p', sides: [{ agent: OPUS, view: 'v1' }, { agent: SONNET, view: 'v2' }] }] });
    // The card's names.
    const v = discussView(d);
    expect(v.agents).toEqual([OPUS, SONNET, 'gemini']);
    expect(v.agents.map(v.name)).toEqual(['Claude · Opus 4.5', 'Claude · Sonnet 4.5', 'Gemini']);
    expect(v.outcome?.sides.flatMap((s) => s.agents)).toEqual([OPUS, SONNET, 'gemini']);
    expect(discussMeta({ ...d, state: 'running', speaking: SONNET })).toBe('Round 1 of 1 · Claude · Sonnet 4.5 is speaking');
    // Carry out with the second Claude: a message to its chat.
    await h.discussions.carryOut(d.id, SONNET);
    expect(h.d().carried).toBe(SONNET);
    expect(h.sent.at(-1)?.[2]).toBe(`chat-${SONNET}`);
  });

  it('without models, nothing changes: the starter keeps its plain name', async () => {
    const h = fakeHost({}, { maxRounds: 1 }, CATALOG, { session: onOpus });
    await h.discussions.start('chat-1', ['gemini'], 'q');
    expect(h.d().participants.map((p) => p.model)).toEqual([undefined, undefined]);
    expect(h.d().turns.map((t) => t.by)).toEqual(['claude', 'gemini']);
  });

  it("refuses its own model only, and a model the agent doesn't offer", async () => {
    const h = fakeHost({}, {}, CATALOG, { session: onOpus });
    await expect(h.discussions.start('chat-1', [{ agent: 'claude', model: 'claude-opus-4-5' }, 'claude'], 'q')).rejects.toThrow(/at least one other agent or model/);
    await expect(h.discussions.start('chat-1', [{ agent: 'gemini', model: 'gpt-5.6-terra' }], 'q')).rejects.toThrow("Gemini doesn't offer the model gpt-5.6-terra.");
    expect(h.state.chats[0].items).toEqual([]);
  });

  it('turn prompts work by key for old and new discussions alike', () => {
    const d: DiscussionItem = {
      kind: 'discussion',
      id: 'discuss-1',
      question: 'Q?',
      participants: [{ agent: 'claude', model: 'claude-opus-4-5', modelName: 'Opus 4.5' }, { agent: 'claude', model: 'claude-sonnet-4-5', modelName: 'Sonnet 4.5' }],
      maxRounds: 2,
      round: 1,
      state: 'running',
      turns: [{ by: OPUS, round: 1, text: 'A' }],
      tokens: 0,
      budget: 1000,
    };
    expect(turnPrompt(d, SONNET)).toContain('You are Claude · Sonnet 4.5, discussing a question with Claude · Opus 4.5');
    expect(turnPrompt(d, SONNET)).toContain('Claude · Opus 4.5 (round 1):\nA');
    expect(summaryPrompt(d, 'rounds')).toContain(`"carryOut": "${OPUS}|${SONNET}"`);
    expect(summaryPrompt({ ...d, participants: [{ agent: 'claude' }, { agent: 'gemini' }], turns: [] }, 'rounds')).not.toContain('Name participants by these keys');
  });

  it('saved with models, read back as it was; a turn by someone not taking part is dropped', () => {
    const d: DiscussionItem = {
      kind: 'discussion',
      id: 'discuss-1',
      question: 'Postgres or MySQL?',
      participants: [
        { agent: 'claude', model: 'claude-opus-4-5', modelName: 'Opus 4.5', chatId: 'chat-1' },
        { agent: 'claude', model: 'claude-sonnet-4-5', modelName: 'Sonnet 4.5', chatId: 'chat-2' },
        { agent: 'gemini', chatId: 'chat-3' },
      ],
      maxRounds: 2,
      round: 1,
      state: 'done',
      ended: 'rounds',
      turns: [
        { by: OPUS, round: 1, text: 'P', stance: { position: 'Postgres', agree: [], disagree: ['x'], parsed: true } },
        { by: SONNET, round: 1, text: 'M', stance: { position: 'MySQL', agree: [], disagree: ['y'], re: { agent: OPUS, quote: 'q' }, parsed: true } },
        { by: 'gemini', round: 1, text: 'M' },
      ],
      tokens: 10,
      budget: 1000,
      span: 0,
      conclusion: { agreed: [], disagreed: [{ point: 'p', sides: [{ agent: SONNET, view: 'v' }] }], next: 'n', by: OPUS, carryOut: SONNET },
      carried: SONNET,
    };
    const raw = JSON.parse(JSON.stringify(d)) as Record<string, unknown>;
    expect(savedDiscussion(raw, 0)).toEqual(d);
    const bad = { ...raw, turns: [...(raw.turns as unknown[]), { by: 'claude/haiku', round: 1, text: 'H' }, { by: 'claude', round: 1, text: 'C' }] };
    expect(savedDiscussion(bad, 0)!.turns).toHaveLength(3);
    // The same participant twice is kept once.
    expect(savedDiscussion({ ...raw, participants: [...(raw.participants as unknown[]), { agent: 'gemini' }] }, 0)!.participants).toHaveLength(3);
  });

  it('an old discussion (agents only) still reads and draws by agent name', () => {
    const old = savedDiscussion(
      {
        id: 'discuss-1',
        question: 'Q?',
        participants: [{ agent: 'claude', chatId: 'c1' }, { agent: 'codex' }],
        turns: [{ by: 'codex', round: 1, text: 'T', stance: { position: 'p', agree: [], disagree: [], re: { agent: 'claude', quote: 'q' }, parsed: true } }],
        state: 'done',
        ended: 'agreed',
        conclusion: { agreed: [], disagreed: [], next: 'n', by: 'claude', carryOut: 'codex' },
        carried: 'codex',
      },
      0,
    )!;
    expect(old.turns[0].stance?.re).toEqual({ agent: 'claude', quote: 'q' });
    expect(old.conclusion?.carryOut).toBe('codex');
    expect(old.carried).toBe('codex');
    expect(discussView(old).agents.map(discussView(old).name)).toEqual(['Claude', 'Codex']);
  });

  it('the webview message carries agents and models; a bad model or key is refused', () => {
    expect(parseWebviewMessage({ type: 'discuss', chatId: 'chat-1', participants: [{ agent: 'claude', model: 'claude-opus-4-5' }, { agent: 'gemini' }, { agent: 'gemini' }], text: 'q' })).toEqual({
      type: 'discuss',
      chatId: 'chat-1',
      participants: [{ agent: 'claude', model: 'claude-opus-4-5' }, { agent: 'gemini' }],
      text: 'q',
    });
    expect(parseWebviewMessage({ type: 'discuss', chatId: 'chat-1', participants: [{ agent: 'claude', model: 'a b' }], text: 'q' })).toBeNull();
    expect(parseWebviewMessage({ type: 'discuss', chatId: 'chat-1', participants: [{ agent: 'nobody' }], text: 'q' })).toBeNull();
    expect(parseWebviewMessage({ type: 'discuss', chatId: 'chat-1', agents: ['gemini'], text: 'q' })).toBeNull();
    expect(parseWebviewMessage({ type: 'discussion', id: 'discuss-1', act: 'carry', agent: SONNET })).toEqual({ type: 'discussion', id: 'discuss-1', act: 'carry', agent: SONNET });
    expect(parseWebviewMessage({ type: 'discussion', id: 'discuss-1', act: 'carry', agent: 'gemini' })).toEqual({ type: 'discussion', id: 'discuss-1', act: 'carry', agent: 'gemini' });
    expect(parseWebviewMessage({ type: 'discussion', id: 'discuss-1', act: 'carry', agent: 'nobody/x' })).toBeNull();
    expect(parseWebviewMessage({ type: 'discussion', id: 'discuss-1', act: 'carry', agent: 'claude/a b' })).toBeNull();
  });
});
