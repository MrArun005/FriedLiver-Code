export const AGENT_IDS = ['claude', 'codex', 'gemini', 'antigravity', 'copilot', 'opencode', 'demo'] as const;
export type BuiltinAgentId = (typeof AGENT_IDS)[number];
/** An agent the user added in their own settings (`friedliver.agents.custom`), by its id there. */
export type CustomAgentId = `custom:${string}`;
export type AgentId = BuiltinAgentId | CustomAgentId;
/** Agents from an AI company, signed in through that company's own CLI. */
export type VendorAgentId = Exclude<BuiltinAgentId, 'demo'>;

export interface AgentSpec {
  id: AgentId;
  label: string;
  /** Executable that speaks ACP on stdin/stdout. */
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Shell command that installs `command`, shown when it is missing. */
  installCommand: string;
  /** How to sign in with the vendor's own tool, shown when the agent asks for auth. */
  loginHint: string;
  /**
   * The oldest adapter version that has what FriedLiver uses (effort levels, plan approval).
   * Older ones still run; Accounts says to update.
   */
  minVersion?: string;
}

/**
 * OpenCode's permission rules (https://opencode.ai/docs/permissions/; last match wins): ask for everything but
 * reading files and listing names; .env stays unread. grep asks too: its rules match the search, not the file, so
 * it can't be kept out of .env. The risky ones are named as well as "*", so a same-named rule elsewhere can't win.
 */
export const OPENCODE_PERMISSIONS = {
  '*': 'ask',
  read: { '*': 'allow', '*.env': 'deny', '*.env.*': 'deny', '*.env.example': 'allow' },
  glob: 'allow',
  lsp: 'allow',
  question: 'allow',
  grep: 'ask',
  edit: 'ask',
  shell: 'ask',
  webfetch: 'ask',
  websearch: 'ask',
  task: 'ask',
  skill: 'ask',
  external_directory: 'ask',
  doom_loop: 'ask',
};

/**
 * How FriedLiver starts OpenCode. OPENCODE_DISABLE_PROJECT_CONFIG=1 (OpenCode 1.19 source: it skips the project's
 * opencode.json, .opencode/ agents, commands and plugins, and AGENTS.md) keeps a repo from setting an agent's own
 * permissions to allow; the inline config pins those of every built-in agent against the user's global config too.
 */
const OPENCODE_ENV = {
  OPENCODE_DISABLE_PROJECT_CONFIG: '1',
  OPENCODE_CONFIG_CONTENT: JSON.stringify({
    permission: OPENCODE_PERMISSIONS,
    agent: Object.fromEntries(['build', 'plan', 'general', 'explore'].map((a) => [a, { permission: OPENCODE_PERMISSIONS }])),
  }),
};

// Agents are started directly, never through `npx`: npx keeps an extra Node
// process alive for the whole session, which costs ~50 MB per agent. The
// @zed-industries/* adapters are deprecated; the @agentclientprotocol/* ones
// install the same command names.
export const DEFAULT_AGENTS: Record<VendorAgentId, AgentSpec> = {
  claude: {
    id: 'claude',
    label: 'Claude',
    command: 'claude-agent-acp',
    args: [],
    installCommand: 'npm install -g @agentclientprotocol/claude-agent-acp',
    loginHint: 'Run `claude` in a terminal and type /login, or set ANTHROPIC_API_KEY.',
    minVersion: '0.90.0',
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    command: 'codex-acp',
    args: [],
    installCommand: 'npm install -g @agentclientprotocol/codex-acp',
    loginHint: 'Run `codex login` in a terminal (Sign in with ChatGPT), or set OPENAI_API_KEY.',
    minVersion: '2.0.0',
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    command: 'gemini',
    args: ['--acp'],
    installCommand: 'npm install -g @google/gemini-cli',
    loginHint: 'Run `gemini` in a terminal and choose "Login with Google", or set GEMINI_API_KEY.',
  },
  // Google's Antigravity CLI has no ACP mode: FriedLiver runs its own adapter (agyAcp.ts), which
  // drives `agy` through its documented headless stream-json mode. `command` here is agy itself.
  antigravity: {
    id: 'antigravity',
    label: 'Antigravity',
    command: 'agy',
    args: [],
    installCommand: process.platform === 'win32' ? 'irm https://antigravity.google/cli/install.ps1 | iex' : 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    loginHint: 'Run `agy` in a terminal: it opens Google sign-in in the browser.',
  },
  // GitHub Copilot CLI's own ACP server (`copilot --acp`, stdio; public preview):
  // https://docs.github.com/en/copilot/reference/acp-server. Sign-in is the CLI's own /login, not over ACP.
  copilot: {
    id: 'copilot',
    label: 'Copilot',
    command: 'copilot',
    args: ['--acp'],
    installCommand: process.platform === 'win32' ? 'winget install GitHub.Copilot' : 'npm install -g @github/copilot',
    loginHint: 'Run `copilot login` in a terminal, or set GH_TOKEN to a fine-grained token with the Copilot Requests permission.',
  },
  // OpenCode's own ACP mode (`opencode acp`): https://opencode.ai/docs/acp/. Its permissions default to
  // "allow", so FriedLiver starts it asking for every action but reads (OPENCODE_ENV): each edit, command and
  // fetch then comes to FriedLiver's approvals like any agent's.
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    command: 'opencode',
    args: ['acp'],
    env: OPENCODE_ENV,
    installCommand: process.platform === 'win32' ? 'npm install -g opencode-ai' : 'curl -fsSL https://opencode.ai/install | bash',
    loginHint: 'OpenCode Zen’s free models need no sign-in. For other providers run `opencode auth login` in a terminal, or set the provider’s API key.',
  },
};

export function isAgentId(value: unknown): value is BuiltinAgentId {
  return typeof value === 'string' && (AGENT_IDS as readonly string[]).includes(value);
}

/**
 * The offline demo agent (the same one the tests use), for trying the UI
 * without signing in anywhere. Electron's binary runs it as plain Node.
 */
export function demoAgentSpec(script: string): AgentSpec {
  return {
    id: 'demo',
    label: 'Demo (offline)',
    command: process.execPath,
    args: [script],
    env: { ELECTRON_RUN_AS_NODE: '1' },
    installCommand: '',
    loginHint: '',
  };
}
