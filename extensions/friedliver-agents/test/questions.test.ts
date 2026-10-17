import type * as acp from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { checkAnswer, oneClickQuestion, questionFields, questionGroups, recommended } from '../src/shared/questions';

// Claude's AskUserQuestion as claude-agent-acp sends it (dist/elicitation.js askUserQuestionsToCreateRequest):
// each question a `oneOf` choice field `question_<n>`, followed by its free-text "Other" field `question_<n>_custom`.
const ask = (questions: { header: string; options: string[]; multi?: boolean }[]): acp.CreateElicitationRequest => {
  const properties: Record<string, unknown> = {};
  questions.forEach((q, n) => {
    const options = q.options.map((o) => ({ const: o, title: o, description: `${o} because` }));
    properties[`question_${n}`] = q.multi ? { type: 'array', title: q.header, items: { anyOf: options } } : { type: 'string', title: q.header, oneOf: options };
    properties[`question_${n}_custom`] = { type: 'string', title: 'Other', description: 'Type your own answer, or add a note to the option you chose above (optional).' };
  });
  return { mode: 'form', sessionId: 's', message: 'Which store?', requestedSchema: { type: 'object', properties } } as unknown as acp.CreateElicitationRequest;
};

describe("an agent's question card", () => {
  it('reads one AskUserQuestion as one question with its "Other" box, answered with one click (owner bug: clicks did nothing)', () => {
    const fields = questionFields(ask([{ header: 'Store', options: ['Redis', 'SQLite'] }]))!;
    expect(fields.map((f) => [f.key, f.type])).toEqual([
      ['question_0', 'choice'],
      ['question_0_custom', 'text'],
    ]);
    const groups = questionGroups(fields);
    expect(groups.map((g) => [g.field.key, g.other?.key])).toEqual([['question_0', 'question_0_custom']]);
    expect(oneClickQuestion(fields)?.key).toBe('question_0');
    // A click sends the option; "Something else…" sends the typed answer alone. Both fit what was asked.
    expect(checkAnswer(fields, { question_0: 'SQLite' })).toEqual({ question_0: 'SQLite' });
    expect(checkAnswer(fields, { question_0_custom: 'Postgres' })).toEqual({ question_0_custom: 'Postgres' });
  });

  it('keeps several questions, or a multi-select, as a form with Answer', () => {
    const two = questionFields(ask([{ header: 'Store', options: ['Redis', 'SQLite'] }, { header: 'Cache', options: ['None', 'LRU'] }]))!;
    expect(questionGroups(two).map((g) => [g.field.key, g.other?.key])).toEqual([
      ['question_0', 'question_0_custom'],
      ['question_1', 'question_1_custom'],
    ]);
    expect(oneClickQuestion(two)).toBeUndefined();
    expect(oneClickQuestion(questionFields(ask([{ header: 'Pick', options: ['a', 'b'], multi: true }]))!)).toBeUndefined();
  });

  it("carries an option's preview and reads Claude's (Recommended) mark", () => {
    const req = ask([{ header: 'Store', options: ['Redis (Recommended)', 'SQLite'] }]);
    const props = (req as unknown as { requestedSchema: { properties: Record<string, { oneOf: Record<string, unknown>[] }> } }).requestedSchema.properties;
    props.question_0.oneOf[1]._meta = { '_claude/askUserQuestionOption': { preview: 'new SqliteStore()' } };
    const [choice] = questionFields(req)!;
    expect(choice.options!.map((o) => o.preview)).toEqual([undefined, 'new SqliteStore()']);
    expect(recommended(choice.options![0].title)).toEqual({ label: 'Redis', recommended: true });
    expect(recommended('SQLite')).toEqual({ label: 'SQLite', recommended: false });
  });

  it('leaves a plain text field that merely ends in _custom alone', () => {
    const fields = [{ key: 'name_custom', title: 'Name', type: 'text' as const }];
    expect(questionGroups(fields)).toEqual([{ field: fields[0] }]);
  });
});
