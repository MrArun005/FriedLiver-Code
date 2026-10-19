// Commands FriedLiver puts in a terminal for an agent: its install line and its own CLI login.
import { DEFAULT_AGENTS } from '@friedliver/main/agents/registry';
import type { AgentKey } from '../shared/model';

/**
 * The install command for an agent: FriedLiver's own constant, chosen by the
 * agent's key and never taken from a webview or an agent. Only plain
 * characters, so typing it into a terminal can't run anything else.
 */
export function installCommandFor(agent: AgentKey): string | null {
  if (agent === 'demo') return null;
  return cliLineFor(DEFAULT_AGENTS[agent].installCommand);
}

/** One of FriedLiver's own lines for a terminal (shared/accounts.ts CLI_ACCOUNTS), if it has only plain characters. */
export function cliLineFor(command: string): string | null {
  return /^[\w@/.: -]+$/.test(command) ? command : null;
}

const MAX_LOGIN_ARGS = 32;
const MAX_LOGIN_TEXT = 4096;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * Variables a sign-in method may not set: ones that make a program load or run
 * something else, choose other programs, redirect traffic, or carry credentials.
 */
const UNSAFE_ENV =
  /^(NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|LD_\w*|DYLD_\w*|PATH|PATHEXT|COMSPEC|SHELL|BASH_ENV|ENV|ZDOTDIR|PROMPT_COMMAND|PS4|SHELLOPTS|BASHOPTS|IFS|PYTHON\w*|PERL5\w*|PERLLIB|RUBY\w*|GIT_\w*|ELECTRON_\w*|NoDefaultCurrentDirectoryInExePath|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_\w*|\w*_API_KEY|\w*_TOKEN)$/i;

/**
 * The arguments and variables an agent's terminal sign-in method adds to its
 * own command (ACP `AuthMethodTerminal`). They come from the agent, so they're
 * checked: plain one-line arguments only, and none of the variables above.
 * Null when the arguments can't be used at all.
 */
export function loginExtras(method: { args?: unknown; env?: unknown }): { args: string[]; env: Record<string, string> } | null {
  const args = method.args ?? [];
  if (!Array.isArray(args) || args.length > MAX_LOGIN_ARGS) return null;
  if (!args.every((a): a is string => typeof a === 'string' && a.length <= MAX_LOGIN_TEXT && !/[\0\r\n]/.test(a))) return null;
  const env: Record<string, string> = {};
  if (method.env && typeof method.env === 'object' && !Array.isArray(method.env)) {
    for (const [name, value] of Object.entries(method.env)) {
      if (typeof value !== 'string' || value.length > MAX_LOGIN_TEXT || /[\0\r\n]/.test(value)) continue;
      if (ENV_NAME.test(name) && !UNSAFE_ENV.test(name)) env[name] = value;
    }
  }
  return { args, env };
}
