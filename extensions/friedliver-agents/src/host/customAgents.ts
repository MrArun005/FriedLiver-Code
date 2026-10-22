// Agents the user adds in friedliver.agents.custom: any program that speaks ACP on stdio.
// Read from the user's own settings only (machine scope); a workspace can never add one or
// change its command. Webviews get the list without the command, args or env.
import { AGENT_KEYS, CUSTOM_AGENT_ID, MENTIONS, type CustomAgent, type CustomAgentKey } from '../shared/model';

/** A custom agent as the host keeps it: what webviews see, plus how to start it. */
export interface CustomAgentConfig extends CustomAgent {
  command: string;
  args: string[];
  env: Record<string, string>;
}

const MAX_AGENTS = 16;
const MAX_ARGS = 64;
const MAX_TEXT = 4096;
const MAX_HINT = 300;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

const text = (v: unknown, max: number): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t && t.length <= max && !CONTROL.test(t) ? t : undefined;
};

/**
 * The well-formed entries of friedliver.agents.custom, and why any others were left out. An id
 * that is a built-in agent or one of its @ names (claude, gpt, google…) is refused, so a custom
 * agent never stands in for a built-in one.
 */
export function parseCustomAgents(raw: unknown): { agents: CustomAgentConfig[]; problems: string[] } {
  const agents: CustomAgentConfig[] = [];
  const problems: string[] = [];
  if (raw === undefined || raw === null) return { agents, problems };
  if (!Array.isArray(raw)) return { agents, problems: ['friedliver.agents.custom must be a list.'] };
  for (const [i, entry] of raw.entries()) {
    const where = `friedliver.agents.custom[${i}]`;
    if (agents.length >= MAX_AGENTS) {
      problems.push(`${where}: at most ${MAX_AGENTS} custom agents.`);
      break;
    }
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      problems.push(`${where} must be an object.`);
      continue;
    }
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === 'string' ? e.id : '';
    if (!CUSTOM_AGENT_ID.test(id)) {
      problems.push(`${where}: id must be 2–24 lower-case letters and digits, starting with a letter.`);
      continue;
    }
    if ((AGENT_KEYS as readonly string[]).includes(id) || Object.hasOwn(MENTIONS, id) || agents.some((a) => a.id === id)) {
      problems.push(`${where}: the id "${id}" is taken.`);
      continue;
    }
    const command = text(e.command, MAX_TEXT);
    if (!command) {
      problems.push(`${where}: command must be the program that speaks ACP, on one line.`);
      continue;
    }
    const args = e.args ?? [];
    if (!Array.isArray(args) || args.length > MAX_ARGS || !args.every((a) => typeof a === 'string' && a.length <= MAX_TEXT && !/[\0\r\n]/.test(a))) {
      problems.push(`${where}: args must be a list of one-line strings.`);
      continue;
    }
    const env: Record<string, string> = {};
    if (e.env !== undefined) {
      if (typeof e.env !== 'object' || e.env === null || Array.isArray(e.env)) {
        problems.push(`${where}: env must be an object of strings.`);
        continue;
      }
      const bad = Object.entries(e.env).find(([k, v]) => !ENV_NAME.test(k) || typeof v !== 'string' || v.length > MAX_TEXT || /[\0\r\n]/.test(v));
      if (bad) {
        problems.push(`${where}: env.${bad[0]} must be a one-line string with a plain name.`);
        continue;
      }
      Object.assign(env, e.env);
    }
    const key: CustomAgentKey = `custom:${id}`;
    const install = text(e.install, MAX_HINT);
    const signIn = text(e.signIn, MAX_HINT);
    agents.push({ key, id, name: text(e.name, 40) ?? id, command, args: args as string[], env, ...(install ? { install } : {}), ...(signIn ? { signIn } : {}) });
  }
  return { agents, problems };
}

/** What webviews get: never the command, args or env (an env may hold a key). */
export function publicCustomAgents(list: readonly CustomAgentConfig[]): CustomAgent[] {
  return list.map(({ key, id, name, install, signIn }) => ({ key, id, name, ...(install ? { install } : {}), ...(signIn ? { signIn } : {}) }));
}
