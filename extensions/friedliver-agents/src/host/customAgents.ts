// Agents the user adds in friedliver.agents.custom: any program that speaks ACP on stdio.
// Read from the user's own settings only (machine scope); a workspace can never add one or
// change its command. Webviews get the list without the command, args or env.
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentConnection, isAuthRequired } from '@friedliver/main/agents/agentConnection';
import type { AgentSpec } from '@friedliver/main/agents/registry';
import { isGlyph, type AgentTestResult } from '../shared/agentForm';
import { AGENT_KEYS, CUSTOM_AGENT_ID, MENTIONS, type CustomAgent, type CustomAgentKey } from '../shared/model';
import { sessionOptions } from '../shared/session';

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
    const glyph = isGlyph(e.glyph) && e.glyph !== 'agent' ? e.glyph : undefined;
    agents.push({ key, id, name: text(e.name, 40) ?? id, command, args: args as string[], env, ...(install ? { install } : {}), ...(signIn ? { signIn } : {}), ...(glyph ? { glyph } : {}) });
  }
  return { agents, problems };
}

/**
 * friedliver.agents.custom with `entry` in place of the one with id `editing` (or its own id), else added
 * at the end. Entries FriedLiver can't read are kept as they are: the setting is the user's.
 */
export function withEntry(list: unknown, entry: Record<string, unknown>, editing?: string): unknown[] {
  const items = Array.isArray(list) ? [...list] : [];
  const id = editing ?? entry.id;
  const at = items.findIndex((e) => typeof e === 'object' && e !== null && (e as { id?: unknown }).id === id);
  if (at >= 0) items[at] = entry;
  else items.push(entry);
  return items;
}

/** friedliver.agents.custom without the entry with that id. */
export function withoutEntry(list: unknown, id: string): unknown[] {
  return (Array.isArray(list) ? list : []).filter((e) => !(typeof e === 'object' && e !== null && (e as { id?: unknown }).id === id));
}

/** What webviews get: never the command, args or env (an env may hold a key). */
export function publicCustomAgents(list: readonly CustomAgentConfig[]): CustomAgent[] {
  return list.map(({ key, id, name, install, signIn, glyph }) => ({ key, id, name, ...(install ? { install } : {}), ...(signIn ? { signIn } : {}), ...(glyph ? { glyph } : {}) }));
}

/** SecretStorage, as much of it as this needs. */
export interface SecretStore {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

/**
 * The environment variables of custom agents that look like keys: in SecretStorage, one JSON object per
 * agent, and in memory so an agent can start without waiting. Never in settings, never sent to a webview.
 */
export class CustomSecrets {
  private readonly cache = new Map<string, Record<string, string>>();
  constructor(private readonly store: SecretStore) {}

  private static key(id: string): string {
    return `friedliver.customAgent.${id}.env`;
  }

  async load(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      const raw = await this.store.get(CustomSecrets.key(id));
      let env: Record<string, string> = {};
      try {
        const v: unknown = raw ? JSON.parse(raw) : {};
        if (v && typeof v === 'object' && !Array.isArray(v)) env = Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string'));
      } catch {
        // A value FriedLiver didn't write: treated as none.
      }
      this.cache.set(id, env);
    }
  }

  env(id: string): Record<string, string> {
    return { ...this.cache.get(id) };
  }

  names(id: string): string[] {
    return Object.keys(this.cache.get(id) ?? {});
  }

  /** Replaces the agent's secret variables; none deletes the entry. */
  async set(id: string, env: Record<string, string>): Promise<void> {
    if (Object.keys(env).length) await this.store.store(CustomSecrets.key(id), JSON.stringify(env));
    else await this.store.delete(CustomSecrets.key(id));
    this.cache.set(id, { ...env });
  }

  async remove(id: string): Promise<void> {
    await this.store.delete(CustomSecrets.key(id));
    this.cache.delete(id);
  }
}

const TEST_TIMEOUT_MS = 30_000;
const MAX_LISTED = 12;

/**
 * "Test connection": starts the program in an empty folder of its own, sends ACP initialize and asks for a
 * session (no prompt, so no model call), then stops it. Every file, terminal and permission request is refused.
 */
export async function testAgentConnection(spec: AgentSpec, clientVersion: string, timeoutMs = TEST_TIMEOUT_MS): Promise<AgentTestResult> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'fl-agent-test-'));
  let conn: AgentConnection | undefined;
  const refuse = () => Promise.reject(new Error('Test connection: FriedLiver allows nothing here.'));
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`No answer within ${timeoutMs / 1000} s.`)), timeoutMs)));
  try {
    conn = await Promise.race([
      AgentConnection.start(spec, {
        cwd,
        clientVersion,
        host: { sessionUpdate: () => {}, requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }), readTextFile: refuse, writeTextFile: refuse },
      }),
      timeout,
    ]);
    const info = conn.info.agentInfo;
    const base = { agent: info ? [info.title ?? info.name, info.version].filter(Boolean).join(' ') : undefined, signIn: conn.authMethods.map((m) => m.name) };
    try {
      const setup = await Promise.race([conn.newSession(cwd), timeout]);
      const options = sessionOptions(setup);
      const models = options.find((o) => o.category === 'model')?.choices ?? [];
      const modes = options.find((o) => o.category === 'mode')?.choices ?? [];
      return { ok: true, ...base, needsSignIn: false, models: models.slice(0, MAX_LISTED).map((c) => c.name), modelCount: models.length, modes: modes.map((c) => c.name) };
    } catch (err) {
      if (isAuthRequired(err)) return { ok: true, ...base, needsSignIn: true, models: [], modelCount: 0, modes: [] };
      throw err;
    }
  } catch (err) {
    return { ok: false, error: String((err as { message?: unknown }).message ?? err).split('\n').slice(0, 6).join('\n') };
  } finally {
    clearTimeout(timer);
    await conn?.stop().catch(() => {});
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}
