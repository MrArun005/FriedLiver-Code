// The /discuss card's model (shared/discussView.ts): the layout setting, the question's parts, the
// positions as they emerged, per-round holdings, moves and trends, the meter, and the outcome.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConclusion, parseStance, savedDiscussion, type DiscussTurn, type DiscussionItem, type Stance } from '../src/shared/discuss';
import { DISCUSS_LAYOUTS, discussLayoutOf, discussLayouts, discussSections, discussView, meterOf, pointPlaceholder, questionParts } from '../src/shared/discussView';
import { parseWebviewMessage } from '../src/shared/messages';
import type { AgentKey } from '../src/shared/model';

const st = (side: string, confidence: number, extra: Partial<Stance> = {}): Stance => ({ position: `${side}, because`, side, agree: [], disagree: ['x'], confidence, parsed: true, ...extra });
const turn = (by: AgentKey, round: number, side: string, conf: number, extra: Partial<Stance> = {}): DiscussTurn => ({ by, round, text: `${by} on ${side} in round ${round}.`, stance: st(side, conf, extra) });

const DB: DiscussionItem = {
  kind: 'discussion',
  id: 'discuss-1',
  question: 'Postgres or MySQL for the invoice audit log (13-month retention, JSON filters in reports, 50M rows)?',
  participants: [{ agent: 'claude' }, { agent: 'gemini' }, { agent: 'codex' }],
  maxRounds: 3,
  round: 3,
  state: 'done',
  ended: 'rounds',
  turns: [
    turn('claude', 1, 'Postgres', 0.75),
    turn('gemini', 1, 'MySQL', 0.7),
    turn('codex', 1, 'Postgres', 0.65),
    { by: 'you', round: 2, text: 'Reports must stay under 2 s at 50M rows.' },
    turn('claude', 2, 'Postgres', 0.8, { re: { agent: 'codex', quote: '3 of 5 report queries filter on nested keys' } }),
    turn('gemini', 2, 'MySQL', 0.6),
    turn('codex', 2, 'Postgres', 0.75),
    turn('claude', 3, 'Postgres', 0.8),
    turn('gemini', 3, 'MySQL', 0.55),
    turn('codex', 3, 'Postgres', 0.8),
  ],
  tokens: 1,
  budget: 60000,
  conclusion: {
    agreed: ['Monthly partitions'],
    disagreed: [{ point: 'Is a second engine worth its operating cost?', sides: [{ agent: 'claude', view: 'Yes: small runbook delta.' }, { agent: 'gemini', view: 'Only if budgeted.' }] }],
    next: 'Prototype on RDS Postgres.',
    by: 'claude',
    carryOut: 'codex',
    rounds: [{ round: 2, trend: 'converging', on: 'indexing' }, { round: 3, trend: 'stuck', on: 'ops cost' }],
  },
};

// Open question, two agents, Codex moves over in round 2.
const WH: DiscussionItem = {
  ...DB,
  id: 'discuss-2',
  question: 'How should the webhook worker retry failed deliveries?',
  participants: [{ agent: 'claude' }, { agent: 'codex' }],
  maxRounds: 2,
  round: 2,
  ended: 'agreed',
  turns: [turn('claude', 1, 'Backoff, then dead-letter', 0.7), turn('codex', 1, 'Fixed retries, then alert', 0.6), turn('claude', 2, 'Backoff, then dead-letter', 0.85), turn('codex', 2, 'Backoff, then dead-letter', 0.85)],
  conclusion: { agreed: ['Retry only 5xx'], disagreed: [], next: 'Add the retry policy.', by: 'claude', carryOut: 'claude' },
};

const running = (d: DiscussionItem, round: number, speaking: AgentKey): DiscussionItem => ({
  ...d,
  state: 'running',
  ended: undefined,
  conclusion: undefined,
  round,
  speaking,
  turns: d.turns.filter((t) => t.round < round || (t.round === round && t.by !== speaking && t.by !== 'codex')),
});

describe('/discuss layout setting', () => {
  it('offers board+meter (default), board, meter and timeline, in package.json with plain descriptions', () => {
    const pkg = JSON.parse(readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
    const s = pkg.contributes.configuration.properties['friedliver.discuss.layout'];
    expect(s.enum).toEqual([...DISCUSS_LAYOUTS]);
    expect(s.default).toBe('board+meter');
    expect(s.enumDescriptions).toHaveLength(4);
  });

  it('reads any value, falling back to the default', () => {
    expect(discussLayoutOf('meter')).toBe('meter');
    expect(discussLayoutOf('timeline')).toBe('timeline');
    expect(discussLayoutOf('nonsense')).toBe('board+meter');
    expect(discussLayoutOf(undefined)).toBe('board+meter');
  });

  it('switching it wakes every open card, which then reads the new layout', () => {
    const woke: string[] = [];
    const stop = discussLayouts.watch(() => woke.push(discussLayouts.get()));
    discussLayouts.set('timeline');
    discussLayouts.set('nonsense');
    stop();
    discussLayouts.set('meter');
    expect(woke).toEqual(['timeline', 'board+meter']);
    expect(discussLayouts.get()).toBe('meter');
    discussLayouts.set('board+meter');
  });

  it('a point typed on the card is a checked message', () => {
    expect(parseWebviewMessage({ type: 'discussion', id: 'discuss-1', act: 'point', text: ' Under 2 s ' })).toEqual({ type: 'discussion', id: 'discuss-1', act: 'point', text: 'Under 2 s' });
    expect(parseWebviewMessage({ type: 'discussion', id: 'discuss-1', act: 'point', text: '  ' })).toBeNull();
  });

  it('each layout shows its parts: running per layout, finished with the shared conclusion', () => {
    const r = running(DB, 2, 'codex');
    expect(discussSections('board+meter', r)).toEqual(['bar', 'points', 'board', 'meter']);
    expect(discussSections('board', r)).toEqual(['bar', 'points', 'board']);
    expect(discussSections('meter', r)).toEqual(['steps', 'meter', 'rows']);
    expect(discussSections('timeline', r)).toEqual(['thread']);
    expect(discussSections('board+meter', DB)).toEqual(['outcome', 'meter', 'sides', 'conclusion', 'actions', 'board-folded', 'history']);
    expect(discussSections('board', DB)).toEqual(['outcome', 'sides', 'conclusion', 'actions', 'board-folded', 'history']);
    expect(discussSections('meter', DB)).toEqual(['outcome', 'meter', 'sides', 'conclusion', 'actions', 'history']);
    expect(discussSections('timeline', DB)).toEqual(['outcome', 'sides', 'conclusion', 'actions', 'history']);
    // Agreed: no sides.
    expect(discussSections('timeline', WH)).toEqual(['outcome', 'conclusion', 'actions', 'history']);
  });
});

describe('/discuss: the question', () => {
  it('splits a trailing parenthesis into the context line, and finds the options', () => {
    expect(questionParts(DB.question)).toEqual({ title: 'Postgres or MySQL for the invoice audit log?', context: ['13-month retention', 'JSON filters in reports', '50M rows'], options: ['Postgres', 'MySQL'] });
  });
  it('an open question has no options; later lines are context', () => {
    expect(questionParts('How should the webhook worker retry failed deliveries?\nabout 40k a day')).toEqual({ title: 'How should the webhook worker retry failed deliveries?', context: ['about 40k a day'] });
  });
  it('reads "A, B or C" and "A vs B"', () => {
    expect(questionParts('Redis, Memcached or nothing?').options).toEqual(['Redis', 'Memcached', 'nothing']);
    expect(questionParts('tabs vs spaces').options).toEqual(['tabs', 'spaces']);
  });
});

describe('/discuss: the view model', () => {
  it('fixed options come first as positions; each round knows who holds what', () => {
    const v = discussView(DB);
    expect(v.positions).toEqual(['Postgres', 'MySQL']);
    expect(v.open).toBe(false);
    expect(v.rounds.map((r) => r.tally)).toEqual(['2 to 1', '2 to 1', '2 to 1']);
    expect(v.rounds[1].holds).toEqual({ claude: 0, gemini: 1, codex: 0 });
    expect(v.rounds[1].points.map((p) => p.text)).toEqual(['Reports must stay under 2 s at 50M rows.']);
    expect(v.rounds[1].turns[0].re).toEqual({ agent: 'codex', quote: '3 of 5 report queries filter on nested keys' });
  });

  it("the summary's per-round trend tags the rounds; labels say what happened", () => {
    const v = discussView(DB);
    expect(v.rounds.map((r) => [r.trend, r.on])).toEqual([[undefined, undefined], ['converging', 'indexing'], ['stuck', 'ops cost']]);
    expect(v.rounds.map((r) => r.label)).toEqual(['Opening positions', 'You added: Reports must stay under 2 s at 50M rows.', 'Last round']);
  });

  it('open questions: positions as they emerged, a move is tagged with its round, trend computed when the summary gives none', () => {
    const v = discussView(WH);
    expect(v.open).toBe(true);
    expect(v.positions).toEqual(['Backoff, then dead-letter', 'Fixed retries, then alert']);
    expect(v.rounds[1].moved).toEqual(['codex']);
    expect(v.rounds[1].label).toBe('Codex moved over');
    expect(v.rounds.map((r) => r.tally)).toEqual(['split', 'agreed']);
    expect(v.rounds[1].trend).toBe('converging');
  });

  it('an abandoned position stays, held by nobody now', () => {
    const v = discussView(WH);
    expect(Object.values(v.rounds[1].holds)).not.toContain(1);
    expect(v.everHeld(1)).toEqual(['codex']);
  });

  it('the outcome: split with sides grouped by position, each with its case', () => {
    const o = discussView(DB).outcome!;
    expect(o.kind).toBe('split');
    expect(o.headline).toBe('Still split on one question');
    expect(o.dispute).toBe('Is a second engine worth its operating cost?');
    expect(o.sides).toEqual([
      { position: 'Postgres', agents: ['claude', 'codex'], why: 'Yes: small runbook delta.' },
      { position: 'MySQL', agents: ['gemini'], why: 'Only if budgeted.' },
    ]);
  });

  it('the outcome: agreed names the position and how sure', () => {
    const o = discussView(WH).outcome!;
    expect(o).toMatchObject({ kind: 'agreed', headline: 'Agreed: Backoff, then dead-letter', who: 'Claude and Codex, 85% sure each' });
  });

  it('the meter: the two emerged positions are its ends; earlier rounds leave a trail', () => {
    const m = meterOf(discussView(DB), 3);
    expect(m.ends).toEqual(['Postgres', 'MySQL']);
    const claude = m.lanes.find((l) => l.agent === 'claude')!;
    expect(claude.x).toBe(10); // Postgres at 80%: 50 − 40
    expect(claude.trail).toEqual([12.5]);
    expect(m.lanes.find((l) => l.agent === 'gemini')!.x).toBeCloseTo(77.5);
  });

  it('running: the speaker is marked, the rounds after it are still to come', () => {
    const v = discussView(running(DB, 2, 'codex'));
    expect(v.speaking).toBe('codex');
    expect(v.rounds.map((r) => r.round)).toEqual([1, 2]);
    expect(v.outcome).toBeUndefined();
    expect(meterOf(v, 2).lanes.find((l) => l.agent === 'codex')!.speaking).toBe(true);
  });

  it('the add-a-point placeholder names the round it goes in before', () => {
    expect(pointPlaceholder(running(DB, 2, 'codex'))).toBe('Add a point. It goes in before round 3.');
    expect(pointPlaceholder(running(DB, 3, 'codex'))).toBe('Add a point. It goes in before the summing up.');
  });
});

describe('/discuss: old discussions still render', () => {
  // Saved before stances had a side, a reply or a trend: positions come from the options in the prose.
  const old = savedDiscussion(
    {
      ...DB,
      turns: [
        { by: 'claude', round: 1, text: 'P', stance: { position: 'Postgres, for jsonb indexing', agree: [], disagree: ['x'], confidence: 0.75, parsed: true } },
        { by: 'gemini', round: 1, text: 'M', stance: { position: 'MySQL, to keep one engine', agree: [], disagree: ['y'], parsed: true } },
        { by: 'codex', round: 1, text: 'no stance at all' },
      ],
      conclusion: { agreed: ['a'], disagreed: [{ point: 'p', sides: [{ agent: 'claude', view: 'v' }] }], next: 'n', by: 'claude' },
    } as unknown as Record<string, unknown>,
    0,
  )!;

  it('reads back, and the model degrades: no trend from the summary, options matched in the prose', () => {
    expect(old.conclusion?.rounds).toBeUndefined();
    const v = discussView(old);
    expect(v.positions).toEqual(['Postgres', 'MySQL']);
    expect(v.rounds[0].holds).toEqual({ claude: 0, gemini: 1 });
    expect(v.rounds[0].trend).toBeUndefined();
    expect(meterOf(v, 1).lanes.find((l) => l.agent === 'codex')!.x).toBe(50);
    for (const layout of DISCUSS_LAYOUTS) expect(discussSections(layout, old).length).toBeGreaterThan(0);
  });

  it('a discussion with no turns at all still has an outcome', () => {
    const empty = { ...DB, turns: [], conclusion: { agreed: [], disagreed: [], next: 'Nobody answered.', by: 'friedliver' as const } };
    expect(discussView(empty).outcome).toMatchObject({ kind: 'none' });
  });
});

describe('/discuss: stance and trend parsing', () => {
  it('reads the side and who it answers, with the words it answers', () => {
    const s = parseStance('x\n```stance\n{"position":"Postgres on RDS","side":"Postgres","replyTo":"Codex","quote":"3 of 5 queries","agree":[],"disagree":[],"confidence":0.8}\n```')!;
    expect(s).toMatchObject({ side: 'Postgres', re: { agent: 'codex', quote: '3 of 5 queries' }, confidence: 0.8 });
  });
  it('an unknown agent or a missing quote drops the reply, not the stance', () => {
    expect(parseStance('```stance\n{"position":"p","replyTo":"bob","quote":"q","agree":[]}\n```')!.re).toBeUndefined();
    expect(parseStance('```stance\n{"position":"p","replyTo":"codex","agree":[]}\n```')!.re).toBeUndefined();
  });
  it('reads per-round trends from the summary, dropping bad ones', () => {
    const c = parseConclusion('```conclusion\n{"agreed":[],"disagreed":[],"next":"n","rounds":[{"round":1},{"round":2,"trend":"converging","on":"indexing"},{"round":3,"trend":"sideways"},{"round":"x","trend":"stuck"}]}\n```', 'claude', ['claude', 'codex'])!;
    expect(c.rounds).toEqual([{ round: 1 }, { round: 2, trend: 'converging', on: 'indexing' }, { round: 3 }]);
  });
  it('no rounds in the summary: none on the conclusion', () => {
    expect(parseConclusion('```conclusion\n{"agreed":[],"disagreed":[],"next":"n"}\n```', 'claude', ['claude'])!.rounds).toBeUndefined();
  });
});

describe('/discuss: a round that is still running', () => {
  it('has no worked-out trend yet, but knows who is less sure', () => {
    const r = running(DB, 2, 'codex');
    const v = discussView({ ...r, turns: r.turns.filter((t) => t.by !== 'you') });
    expect(v.rounds[1].trend).toBeUndefined();
    expect(v.rounds[1].tally).toBe('2 to 1');
    expect(v.rounds[1].lessSure).toEqual(['gemini']);
  });
});
