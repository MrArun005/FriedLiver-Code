// Questions an agent asks as a small form (ACP form elicitation), e.g.
// Claude's AskUserQuestion: what the card shows, and the answer checked
// against what was asked before it goes back.
import type * as acp from '@agentclientprotocol/sdk';

export interface QuestionField {
  key: string;
  title: string;
  description?: string;
  /** choice: one of `options`; multi: any of them; text, number, boolean: a value. */
  type: 'choice' | 'multi' | 'text' | 'number' | 'boolean';
  /** `preview`: code or a mockup to show beside the option (claude-agent-acp's `_meta["_claude/askUserQuestionOption"].preview`). */
  options?: { value: string; title: string; description?: string; preview?: string }[];
  required?: boolean;
}

export type QuestionValue = string | number | boolean | string[];

const MAX_FIELDS = 12;
const MAX_OPTIONS = 50;
const MAX_TEXT = 500;
const MAX_PREVIEW = 4000;
/** Characters one typed answer may have. */
export const MAX_ANSWER = 10_000;

const text = (v: unknown, max = MAX_TEXT): string | undefined => (typeof v === 'string' && v.trim() ? v.slice(0, max) : undefined);

function enumOptions(prop: Record<string, unknown>): QuestionField['options'] | undefined {
  const list = Array.isArray(prop.oneOf) ? prop.oneOf : Array.isArray(prop.anyOf) ? prop.anyOf : undefined;
  if (list) {
    const out = list
      .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object' && typeof (o as Record<string, unknown>).const === 'string')
      .slice(0, MAX_OPTIONS)
      .map((o) => {
        const preview = text((o._meta as Record<string, { preview?: unknown }> | undefined)?.['_claude/askUserQuestionOption']?.preview, MAX_PREVIEW);
        return { value: o.const as string, title: text(o.title) ?? (o.const as string), description: text(o.description), ...(preview ? { preview } : {}) };
      });
    return out.length ? out : undefined;
  }
  if (Array.isArray(prop.enum)) {
    const names = Array.isArray(prop.enumNames) ? prop.enumNames : [];
    const out = prop.enum
      .filter((v): v is string => typeof v === 'string')
      .slice(0, MAX_OPTIONS)
      .map((v, n) => ({ value: v, title: text(names[n]) ?? v }));
    return out.length ? out : undefined;
  }
  return undefined;
}

/** The form's fields, or null when it asks for something the card can't show. */
export function questionFields(req: acp.CreateElicitationRequest): QuestionField[] | null {
  if (req.mode !== 'form') return null;
  const schema = (req as { requestedSchema?: acp.ElicitationSchema }).requestedSchema;
  const props = schema?.properties;
  if (!props || typeof props !== 'object') return [];
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const fields: QuestionField[] = [];
  for (const [key, raw] of Object.entries(props).slice(0, MAX_FIELDS)) {
    if (!raw || typeof raw !== 'object' || key.length > 128) return null;
    const prop = raw as Record<string, unknown>;
    const base = { key, title: text(prop.title) ?? key, description: text(prop.description), ...(required.has(key) ? { required: true } : {}) };
    if (prop.type === 'string') {
      const options = enumOptions(prop);
      fields.push(options ? { ...base, type: 'choice', options } : { ...base, type: 'text' });
    } else if (prop.type === 'array') {
      const items = prop.items && typeof prop.items === 'object' ? (prop.items as Record<string, unknown>) : {};
      const options = enumOptions(items);
      if (!options) return null;
      fields.push({ ...base, type: 'multi', options });
    } else if (prop.type === 'number' || prop.type === 'integer') {
      fields.push({ ...base, type: 'number' });
    } else if (prop.type === 'boolean') {
      fields.push({ ...base, type: 'boolean' });
    } else {
      return null;
    }
  }
  return fields;
}

/** A question as the card shows it: its field, and the free-text "Other" box that goes with a choice. */
export interface QuestionGroup {
  field: QuestionField;
  other?: QuestionField;
}

/**
 * The fields as questions. claude-agent-acp follows each AskUserQuestion choice (`question_<n>`) with an
 * optional free-text field (`question_<n>_custom`, "Other"): that box belongs to its choice, not beside it.
 */
export function questionGroups(fields: QuestionField[]): QuestionGroup[] {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const isOther = (f: QuestionField) => f.type === 'text' && f.key.endsWith('_custom') && /^(choice|multi)$/.test(byKey.get(f.key.slice(0, -'_custom'.length))?.type ?? '');
  return fields.filter((f) => !isOther(f)).map((f) => {
    const other = byKey.get(`${f.key}_custom`);
    return other && isOther(other) ? { field: f, other } : { field: f };
  });
}

/** "Redis (Recommended)": Claude marks its pick in the label. The label without it, and whether it was there. */
export function recommended(title: string): { label: string; recommended: boolean } {
  const label = title.replace(/\s*\(recommended\)\s*$/i, '');
  return { label: label || title, recommended: label !== title };
}

/** The one choice a click answers: a form that is a single choice question (with or without its "Other" box). */
export function oneClickQuestion(fields: QuestionField[]): QuestionField | undefined {
  const groups = questionGroups(fields);
  return groups.length === 1 && groups[0].field.type === 'choice' ? groups[0].field : undefined;
}

/** The answer, if it fits the fields: known keys, values of the right kind, offered options only, required ones there. */
export function checkAnswer(fields: QuestionField[], values: Record<string, unknown>): Record<string, QuestionValue> | null {
  const out: Record<string, QuestionValue> = {};
  for (const [key, v] of Object.entries(values)) {
    const f = fields.find((x) => x.key === key);
    if (!f) return null;
    if (v === '' || v === undefined || (Array.isArray(v) && !v.length)) continue;
    if (f.type === 'choice' && !(typeof v === 'string' && f.options?.some((o) => o.value === v))) return null;
    if (f.type === 'multi' && !(Array.isArray(v) && v.every((x) => typeof x === 'string' && f.options?.some((o) => o.value === x)))) return null;
    if (f.type === 'text' && !(typeof v === 'string' && v.length <= MAX_ANSWER)) return null;
    if (f.type === 'number' && !(typeof v === 'number' && Number.isFinite(v))) return null;
    if (f.type === 'boolean' && typeof v !== 'boolean') return null;
    out[key] = v as QuestionValue;
  }
  for (const f of fields) if (f.required && out[f.key] === undefined) return null;
  return out;
}

/** One line for the transcript after it was answered. */
export function answerSummary(fields: QuestionField[], values: Record<string, QuestionValue>): string {
  return fields
    .flatMap((f) => {
      const v = values[f.key];
      if (v === undefined) return [];
      const named = (x: string) => f.options?.find((o) => o.value === x)?.title ?? x;
      const shown = Array.isArray(v) ? v.map(named).join(', ') : typeof v === 'string' ? named(v) : String(v);
      return [fields.length > 1 ? `${f.title}: ${shown}` : shown];
    })
    .join(' · ')
    .slice(0, 300);
}
