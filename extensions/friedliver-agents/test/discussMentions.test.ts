import { describe, expect, it } from 'vitest';
import { parseDiscuss, type DiscussPlan } from '../src/shared/discuss';
import {
  applyDiscussMention,
  discussMentionAt,
  insertFor,
  mentionSuggestions,
  modelCatalog,
  resolveMention,
  scanMentions,
  whoLabel,
} from '../src/shared/discussMentions';
import type { ChatSession, SessionOption } from '../src/shared/session';
import { CATALOG } from './fixtures/models';

const plan = (text: string, starter: Parameters<typeof parseDiscuss>[1] = 'claude') => parseDiscuss(text, starter, CATALOG) as DiscussPlan;

describe('/discuss mentions: where they are', () => {
  it('reads mentions before, after and between the words, in any order', () => {
    const q = 'Postgres or MySQL for the audit log?';
    for (const text of [
      `/discuss @gemini @codex ${q}`,
      `/discuss ${q} @gemini @codex`,
      `/discuss Postgres or @gemini MySQL for the @codex audit log?`,
      `/discuss @gemini, @codex: ${q}`,
      `/discuss @gemini and @codex ${q}`,
    ]) {
      const p = plan(text);
      expect(p.participants, text).toEqual([{ agent: 'gemini' }, { agent: 'codex' }]);
      expect(p.question, text).toBe(q);
      expect(p.problems).toEqual([]);
    }
    expect(plan(`/discuss @codex @gemini ${q}`).participants).toEqual([{ agent: 'codex' }, { agent: 'gemini' }]);
  });

  it('keeps the question\'s lines and its code, and tidies the gaps', () => {
    expect(plan('/discuss Should we use @gemini Postgres?\nWe run `pg_dump` nightly. @codex').question).toBe('Should we use Postgres?\nWe run `pg_dump` nightly.');
    expect(plan('/discuss Which is faster, @gemini? Say why.').question).toBe('Which is faster? Say why.');
  });

  it('ignores an @ in code, emails and URLs', () => {
    const p = plan('/discuss @gemini can `@codex` see a@b.com or https://x.dev/@codex or ```\n@codex\n``` here?');
    expect(p.participants).toEqual([{ agent: 'gemini' }]);
    expect(p.question).toBe('can `@codex` see a@b.com or https://x.dev/@codex or ```\n@codex\n``` here?');
    // An unclosed fence hides everything after it.
    expect(scanMentions('/discuss q @gemini ```\n@codex')).toEqual([{ at: 11, end: 18, word: 'gemini' }]);
  });

  it('a full stop or a dash after a mention is not part of it', () => {
    expect(scanMentions('ask @opus. and @gemini-').map((m) => m.word)).toEqual(['opus', 'gemini']);
  });

  it('is null for other commands and incomplete without someone else or a question', () => {
    expect(parseDiscuss('/discussion x', 'claude', CATALOG)).toBeNull();
    expect(parseDiscuss('/ask @gemini x', 'claude', CATALOG)).toBeNull();
    expect(parseDiscuss('/discuss @gemini', 'claude', CATALOG)).toBe('incomplete');
    expect(parseDiscuss('/discuss which?', 'claude', CATALOG)).toBe('incomplete');
    expect(parseDiscuss('/discuss @claude which?', 'claude', CATALOG)).toBe('incomplete');
  });
});

describe('/discuss mentions: agents, models and pairs', () => {
  it('an agent by name or alias', () => {
    expect(resolveMention('Gemini', CATALOG)).toEqual({ ok: { agent: 'gemini' } });
    expect(resolveMention('gpt', CATALOG)).toEqual({ ok: { agent: 'codex' } });
    expect(resolveMention('openai', CATALOG)).toEqual({ ok: { agent: 'codex' } });
  });

  it('a model by id or display name, any case', () => {
    expect(resolveMention('gpt-5.6-terra', CATALOG)).toEqual({ ok: { agent: 'codex', model: 'gpt-5.6-terra' } });
    expect(resolveMention('Gemini-3.1-Pro', CATALOG)).toEqual({ ok: { agent: 'gemini', model: 'gemini-3.1-pro' } });
    expect(resolveMention('opus-4.1', CATALOG)).toEqual({ ok: { agent: 'claude', model: 'claude-opus-4-1' } });
    expect(resolveMention('argon', CATALOG)).toEqual({ ok: { agent: 'gemini', model: 'argon' } });
  });

  it('a family name or prefix is the newest model of it the agent offers', () => {
    expect(resolveMention('opus', CATALOG)).toEqual({ ok: { agent: 'claude', model: 'claude-opus-4-5' } });
    expect(resolveMention('sonnet', CATALOG)).toEqual({ ok: { agent: 'claude', model: 'claude-sonnet-4-5' } });
    expect(resolveMention('gemini-3', CATALOG)).toEqual({ ambiguous: [{ agent: 'gemini', model: 'gemini-3.1-pro' }, { agent: 'gemini', model: 'gemini-3.1-flash' }] });
  });

  it('agent/model and agent:model look at that agent only', () => {
    expect(resolveMention('claude/opus', CATALOG)).toEqual({ ok: { agent: 'claude', model: 'claude-opus-4-5' } });
    expect(resolveMention('codex:gpt-5.6-luna', CATALOG)).toEqual({ ok: { agent: 'codex', model: 'gpt-5.6-luna' } });
    expect(resolveMention('gemini/pro', CATALOG)).toEqual({ ok: { agent: 'gemini', model: 'gemini-3.1-pro' } });
    expect('unknown' in resolveMention('codex/opus', CATALOG)).toBe(true);
  });

  it('ambiguous: two models of one family, or models of two agents', () => {
    expect(resolveMention('gpt-5.6', CATALOG)).toEqual({ ambiguous: [{ agent: 'codex', model: 'gpt-5.6-terra' }, { agent: 'codex', model: 'gpt-5.6-luna' }] });
    expect(resolveMention('pro', CATALOG)).toEqual({ ambiguous: [{ agent: 'codex', model: 'gpt-5-pro' }, { agent: 'gemini', model: 'gemini-3.1-pro' }] });
    const p = plan('/discuss @gpt-5.6 @gemini Which ORM?');
    expect(p.participants).toEqual([{ agent: 'gemini' }]);
    expect(p.problems).toEqual([
      {
        kind: 'ambiguous',
        mention: { at: 9, end: 17, word: 'gpt-5.6' },
        options: [
          { agent: 'codex', model: 'gpt-5.6-terra', insert: 'gpt-5.6-terra', label: 'Codex · gpt-5.6-terra', name: 'gpt-5.6-terra' },
          { agent: 'codex', model: 'gpt-5.6-luna', insert: 'gpt-5.6-luna', label: 'Codex · gpt-5.6-luna', name: 'gpt-5.6-luna' },
        ],
      },
    ]);
  });

  it('unknown: an error with the nearest names', () => {
    const r = resolveMention('opsu', CATALOG);
    expect('unknown' in r && r.unknown[0]).toMatchObject({ agent: 'claude', model: expect.stringMatching(/opus/) });
    const p = plan('/discuss @gemni @opsu Which ORM?');
    expect(p.problems.map((x) => x.kind)).toEqual(['unknown', 'unknown']);
    expect(p.problems[0].kind === 'unknown' && p.problems[0].suggestions[0]).toMatchObject({ agent: 'gemini', insert: 'gemini', label: 'Gemini' });
    // Nothing near: no suggestions, still an error. Before any agent reported its models, every model is unknown.
    expect(resolveMention('zzzzzzzz', CATALOG)).toEqual({ unknown: [] });
    expect((parseDiscuss('/discuss @opus q', 'gemini', {}) as DiscussPlan).problems[0].kind).toBe('unknown');
  });

  it('the same agent twice on different models; duplicates once', () => {
    const p = plan('/discuss @opus @sonnet @gemini @claude/opus @Gemini Which ORM?', 'codex');
    expect(p.participants).toEqual([{ agent: 'claude', model: 'claude-opus-4-5' }, { agent: 'claude', model: 'claude-sonnet-4-5' }, { agent: 'gemini' }]);
  });

  it("the chat's own agent: on its own model (or none) adds nobody; on another model it joins", () => {
    const self = { agent: 'claude' as const, model: 'claude-opus-4-5' };
    expect(plan('/discuss @opus @gemini q', self).participants).toEqual([{ agent: 'gemini' }]);
    expect(plan('/discuss @claude @gemini q', self).participants).toEqual([{ agent: 'gemini' }]);
    expect(plan('/discuss @opus @sonnet q', self).participants).toEqual([{ agent: 'claude', model: 'claude-sonnet-4-5' }]);
    expect(plan('/discuss @opus @sonnet q', 'claude').participants).toEqual([
      { agent: 'claude', model: 'claude-opus-4-5' },
      { agent: 'claude', model: 'claude-sonnet-4-5' },
    ]);
  });
});

describe('/discuss mentions: names and the catalog', () => {
  it('labels a participant "Agent · Model" without the agent twice', () => {
    expect(whoLabel({ agent: 'claude', model: 'claude-opus-4-5' }, CATALOG)).toBe('Claude · Opus 4.5');
    expect(whoLabel({ agent: 'gemini', model: 'gemini-3.1-pro' }, CATALOG)).toBe('Gemini · 3.1 Pro');
    expect(whoLabel({ agent: 'gemini' }, CATALOG)).toBe('Gemini');
  });

  it('inserts the shortest name that picks the model alone', () => {
    expect(insertFor({ agent: 'claude', model: 'claude-opus-4-5' }, CATALOG)).toBe('opus');
    expect(insertFor({ agent: 'claude', model: 'claude-opus-4-1' }, CATALOG)).toBe('opus-4.1');
    expect(insertFor({ agent: 'codex', model: 'gpt-5.6-luna' }, CATALOG)).toBe('gpt-5.6-luna');
    expect(insertFor({ agent: 'gemini', model: 'gemini-3.1-pro' }, CATALOG)).toBe('gemini-3.1-pro');
    expect(insertFor({ agent: 'claude' }, CATALOG)).toBe('claude');
    // A name two agents share falls back to agent/id.
    expect(insertFor({ agent: 'claude', model: 'same' }, { claude: [{ value: 'same', name: 'Same' }], codex: [{ value: 'same', name: 'Same' }] })).toBe('claude/same');
    for (const [agent, list] of Object.entries(CATALOG))
      for (const c of list!) {
        const who = { agent: agent as 'claude', model: c.value };
        expect(resolveMention(insertFor(who, CATALOG), CATALOG)).toEqual({ ok: who });
      }
  });

  it('merges the agents\' cached models and their chats\' sessions', () => {
    const model = (choices: string[]): SessionOption => ({ id: 'model', name: 'Model', category: 'model', type: 'select', current: choices[0], choices: choices.map((value) => ({ value, name: value })), via: 'option' });
    const session = (o: SessionOption): ChatSession => ({ options: [o], commands: [], live: true });
    const c = modelCatalog({ claude: { options: [model(['opus', 'sonnet'])] } }, [
      { agent: 'claude', session: session(model(['sonnet', 'haiku'])) },
      { agent: 'gemini', session: session(model(['gemini-3.1-pro'])) },
      { agent: 'codex' },
    ]);
    expect(Object.fromEntries(Object.entries(c).map(([a, l]) => [a, l!.map((x) => x.value)]))).toEqual({ claude: ['opus', 'sonnet', 'haiku'], gemini: ['gemini-3.1-pro'] });
  });
});

describe('/discuss mentions: the composer suggestions', () => {
  const agents = ['claude', 'codex', 'gemini'] as const;

  it('opens on an @ after /discuss, anywhere in the text, never in code or an email', () => {
    const text = '/discuss Postgres or MySQL? @op';
    expect(discussMentionAt(text, text.length)).toEqual({ at: 28, end: 31, word: 'op', query: 'op' });
    expect(discussMentionAt('/discuss @', 10)).toEqual({ at: 9, end: 10, word: '', query: '' });
    expect(discussMentionAt('/discuss @clau now', 14)).toEqual({ at: 9, end: 14, word: 'clau', query: 'clau' });
    // The caret mid-word: the whole word is replaced.
    expect(discussMentionAt('/discuss @claude/op x', 12)).toMatchObject({ at: 9, end: 19, query: 'cl' });
    expect(discussMentionAt('/discuss mail a@b', 17)).toBeNull();
    expect(discussMentionAt('/discuss `@co', 13)).toBeNull();
    expect(discussMentionAt('/ask @co', 8)).toBeNull();
    expect(discussMentionAt('@co', 3)).toBeNull();
  });

  it('suggests agents and their models, grouped by agent', () => {
    const all = mentionSuggestions('', CATALOG, agents);
    expect(all.map((s) => s.agent)).toEqual(['claude', 'claude', 'claude', 'claude', 'claude', 'claude', 'codex', 'codex', 'codex', 'codex', 'gemini', 'gemini', 'gemini', 'gemini', 'gemini']);
    expect(all[0]).toMatchObject({ agent: 'claude', insert: 'claude', label: 'Claude', name: 'Claude' });
    const op = mentionSuggestions('opus', CATALOG, agents);
    expect(op.map((s) => s.insert)).toEqual(['opus-4.1', 'opus']);
    expect(op.map((s) => s.label)).toEqual(['Claude · Opus 4.1', 'Claude · Opus 4.5']);
    expect(op.map((s) => s.name)).toEqual(['Opus 4.1', 'Opus 4.5']);
    // The agent's name brings all of its models; agent/ narrows to them.
    expect(mentionSuggestions('gem', CATALOG, agents).map((s) => s.insert)).toEqual(['gemini', 'gemini-3.1-pro', 'gemini-2.5-pro', 'gemini-3.1-flash', 'argon']);
    expect(mentionSuggestions('codex/', CATALOG, agents).map((s) => s.insert)).toEqual(['codex', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5-pro']);
    expect(mentionSuggestions('claude/son', CATALOG, agents).map((s) => s.insert)).toEqual(['sonnet']);
    // Only the agents the pickers show.
    expect(mentionSuggestions('', CATALOG, ['gemini']).every((s) => s.agent === 'gemini')).toBe(true);
  });

  it('a choice replaces the word and leaves the caret after one space', () => {
    expect(applyDiscussMention('/discuss Which? @op', { at: 16, end: 19 }, 'opus')).toEqual({ text: '/discuss Which? @opus ', caret: 22 });
    expect(applyDiscussMention('/discuss @op Which?', { at: 9, end: 12 }, 'opus')).toEqual({ text: '/discuss @opus Which?', caret: 15 });
  });
});
