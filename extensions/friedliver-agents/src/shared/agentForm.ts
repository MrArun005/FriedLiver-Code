// "Add an agent" on Agents & Accounts: the form's values, their checks, and how they become an entry of
// the user's friedliver.agents.custom setting. Pure, so the page, the host and the tests agree. The host
// checks everything again; values that look like keys go to SecretStorage, never into settings.
import { AGENT_KEYS, CUSTOM_AGENT_ID, MENTIONS } from './model';

/** The neutral marks a custom agent can wear (ui/marks.ts GLYPHS). */
export const AGENT_GLYPHS = ['agent', 'terminal', 'hexagon', 'spark'] as const;
export type AgentGlyph = (typeof AGENT_GLYPHS)[number];
export const isGlyph = (v: unknown): v is AgentGlyph => typeof v === 'string' && (AGENT_GLYPHS as readonly string[]).includes(v);

export interface EnvRow {
  name: string;
  /** Empty with `saved` keeps the value already in SecretStorage. */
  value: string;
  /** Kept in SecretStorage, not settings; a name or value that looks like a key always is. */
  secret: boolean;
  saved?: boolean;
}

export interface AgentDraft {
  id: string;
  name: string;
  command: string;
  /** As typed: separated by spaces, "double quotes" around one with spaces. */
  args: string;
  env: EnvRow[];
  install: string;
  signIn: string;
  glyph: AgentGlyph;
}

export type DraftField = 'id' | 'name' | 'command' | 'args' | 'env' | 'install' | 'signIn';
export type DraftErrors = Partial<Record<DraftField, string>>;

export const EMPTY_DRAFT: AgentDraft = { id: '', name: '', command: '', args: '', env: [], install: '', signIn: '', glyph: 'agent' };

/** The example the form and docs/ACCOUNTS.md show. */
export const AGENT_EXAMPLE = { id: 'qwen', name: 'Qwen Code', command: 'qwen', args: ['--acp'] };

export const MAX_ENV = 32;
const MAX_TEXT = 4096;
const MAX_HINT = 300;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** A program by name or path: no shell metacharacters (it is started directly, but keep it plain), not an option. */
const PROGRAM = /^(?!-)[\w@+.:/\\ -]+$/;

/**
 * One of FriedLiver's lines for a terminal, if it has only plain characters. One pipe into bash or iex
 * at the end is allowed: official installers are `curl … | bash` (`irm … | iex` on Windows).
 */
export function plainLine(command: string): boolean {
  return /^[\w@/.: -]+( \| (bash|iex))?$/.test(command);
}

/** Arguments as typed: split at spaces, "…" keeps one with spaces together. Null when a quote isn't closed. */
export function splitArgs(s: string): string[] | null {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  if ((s.match(/"/g)?.length ?? 0) % 2) return null;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2]);
  return out;
}

export function joinArgs(args: readonly string[]): string {
  return args.map((a) => (/\s/.test(a) || a === '' ? `"${a}"` : a)).join(' ');
}

/** A variable whose name or value looks like a credential: it goes to SecretStorage. */
export function looksSecret(name: string, value: string): boolean {
  if (/KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|BEARER/i.test(name)) return true;
  if (/^(sk|pk|rk|ghp|gho|ghs|github_pat|xox[abpr]|AKIA)[-_]?[A-Za-z0-9]/.test(value)) return true;
  return value.length >= 32 && /^[A-Za-z0-9_\-+/=.]+$/.test(value) && /\d/.test(value) && /[A-Za-z]/.test(value);
}

/** A suggested id from the name: "Qwen Code" → "qwencode". */
export function idFromName(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/^[0-9]+/, '');
  return s.slice(0, 24);
}

/** Why each field can't be saved; empty when it can. `taken`: the other custom agents' ids. */
export function validateDraft(d: AgentDraft, taken: readonly string[]): DraftErrors {
  const e: DraftErrors = {};
  if (!CUSTOM_AGENT_ID.test(d.id)) e.id = '2–24 lower-case letters and digits, starting with a letter.';
  else if ((AGENT_KEYS as readonly string[]).includes(d.id) || Object.hasOwn(MENTIONS, d.id)) e.id = `"${d.id}" is a built-in agent’s name.`;
  else if (taken.includes(d.id)) e.id = `Another agent already has the id "${d.id}".`;
  const name = d.name.trim();
  if (name.length > 40 || CONTROL.test(name)) e.name = 'One line, at most 40 characters.';
  const command = d.command.trim();
  if (!command) e.command = 'The program that speaks ACP, e.g. opencode.';
  else if (command.length > MAX_TEXT || !PROGRAM.test(command)) e.command = 'A program name or path only: no ; | & $ quotes or other shell characters, and not starting with -.';
  const args = splitArgs(d.args);
  if (!args) e.args = 'A quote isn’t closed.';
  else if (args.length > 64 || args.some((a) => a.length > MAX_TEXT || CONTROL.test(a))) e.args = 'At most 64 arguments, each on one line.';
  if (d.env.length > MAX_ENV) e.env = `At most ${MAX_ENV} variables.`;
  else {
    const names = new Set<string>();
    for (const row of d.env) {
      if (!ENV_NAME.test(row.name)) e.env = `"${row.name}" isn’t a variable name (letters, digits and _, not starting with a digit).`;
      else if (names.has(row.name)) e.env = `${row.name} is there twice.`;
      else if (row.value.length > MAX_TEXT || CONTROL.test(row.value)) e.env = `${row.name}: one line.`;
      else if (!row.value && !row.saved) e.env = `${row.name} has no value.`;
      names.add(row.name);
      if (e.env) break;
    }
  }
  const install = d.install.trim();
  if (install && (install.length > MAX_HINT || !plainLine(install))) e.install = 'One plain command line (letters, digits, @ / . : - and spaces), optionally ending in | bash or | iex.';
  if (d.signIn.trim().length > MAX_HINT || CONTROL.test(d.signIn.trim())) e.signIn = 'One line, at most 300 characters.';
  return e;
}

/** A draft from a webview message, or null when it isn't one. Values are checked by validateDraft. */
export function parseDraft(raw: unknown): AgentDraft | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown, max = MAX_TEXT) => (typeof v === 'string' && v.length <= max ? v : null);
  const fields = [str(r.id, 64), str(r.name, 200), str(r.command), str(r.args, 64 * MAX_TEXT), str(r.install, 2000), str(r.signIn, 2000)];
  if (fields.some((f) => f === null) || !isGlyph(r.glyph) || !Array.isArray(r.env) || r.env.length > MAX_ENV) return null;
  const env: EnvRow[] = [];
  for (const row of r.env) {
    if (typeof row !== 'object' || row === null) return null;
    const x = row as Record<string, unknown>;
    if (str(x.name, 256) === null || str(x.value) === null || typeof x.secret !== 'boolean') return null;
    env.push({ name: x.name as string, value: x.value as string, secret: x.secret, ...(x.saved === true ? { saved: true } : {}) });
  }
  const [id, name, command, args, install, signIn] = fields as string[];
  return { id, name, command, args, env, install, signIn, glyph: r.glyph };
}

/**
 * What a valid draft writes: the settings entry (no secrets in it), the secret variables to store, and
 * the names of saved secrets to keep as they are.
 */
export function draftToEntry(d: AgentDraft): { entry: Record<string, unknown>; secrets: Record<string, string>; keep: string[] } {
  const env: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  const keep: string[] = [];
  for (const row of d.env) {
    const secret = row.secret || row.saved || looksSecret(row.name, row.value);
    if (secret && !row.value && row.saved) keep.push(row.name);
    else if (secret) secrets[row.name] = row.value;
    else env[row.name] = row.value;
  }
  const entry: Record<string, unknown> = { id: d.id, name: d.name.trim() || d.id, command: d.command.trim(), args: splitArgs(d.args) ?? [] };
  if (Object.keys(env).length) entry.env = env;
  if (d.install.trim()) entry.install = d.install.trim();
  if (d.signIn.trim()) entry.signIn = d.signIn.trim();
  if (d.glyph !== 'agent') entry.glyph = d.glyph;
  return { entry, secrets, keep };
}

/** The form's values for an agent already saved; secret values stay in SecretStorage (shown as saved). */
export function entryToDraft(c: { id: string; name: string; command: string; args: string[]; env: Record<string, string>; install?: string; signIn?: string; glyph?: AgentGlyph }, secretNames: readonly string[]): AgentDraft {
  return {
    id: c.id,
    name: c.name,
    command: c.command,
    args: joinArgs(c.args),
    env: [...Object.entries(c.env).map(([name, value]) => ({ name, value, secret: false })), ...secretNames.map((name) => ({ name, value: '', secret: true, saved: true }))],
    install: c.install ?? '',
    signIn: c.signIn ?? '',
    glyph: c.glyph ?? 'agent',
  };
}

/** What Test connection learned: the agent's own name, how it signs in, and what its first session offered. */
export type AgentTestResult =
  | { ok: true; agent?: string; signIn: string[]; needsSignIn: boolean; models: string[]; modelCount: number; modes: string[] }
  | { ok: false; error: string };
