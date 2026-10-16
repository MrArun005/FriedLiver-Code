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
  options?: { value: string; title: string; description?: string }[];
  required?: boolean;
}

export type QuestionValue = string | number | boolean | string[];

const MAX_FIELDS = 12;
const MAX_OPTIONS = 50;
const MAX_TEXT = 500;
/** Characters one typed answer may have. */
export const MAX_ANSWER = 10_000;

const text = (v: unknown, max = MAX_TEXT): string | undefined => (typeof v === 'string' && v.trim() ? v.slice(0, max) : undefined);

function enumOptions(prop: Record<string, unknown>): QuestionField['options'] | undefined {
  const list = Array.isArray(prop.oneOf) ? prop.oneOf : Array.isArray(prop.anyOf) ? prop.anyOf : undefined;
  if (list) {
    const out = list
      .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object' && typeof (o as Record<string, unknown>).const === 'string')
      .slice(0, MAX_OPTIONS)
      .map((o) => ({ value: o.const as string, title: text(o.title) ?? (o.const as string), description: text(o.description) }));
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
