export const AGENT_IDS = ['claude', 'codex', 'gemini', 'antigravity', 'copilot', 'demo'] as const;
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
    loginHint: 'Run `copilot` in a terminal and type /login, or set GH_TOKEN to a fine-grained token with the Copilot Requests permission.',
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
