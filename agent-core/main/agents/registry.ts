export const AGENT_IDS = ['claude', 'codex', 'gemini', 'demo'] as const;
export type AgentId = (typeof AGENT_IDS)[number];
/** Agents from an AI company, signed in through that company's own CLI. */
export type VendorAgentId = Exclude<AgentId, 'demo'>;

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
}

// Agents are started directly, never through `npx`: npx keeps an extra Node
// process alive for the whole session, which costs ~50 MB per agent.
export const DEFAULT_AGENTS: Record<VendorAgentId, AgentSpec> = {
  claude: {
    id: 'claude',
    label: 'Claude',
    command: 'claude-agent-acp',
    args: [],
    installCommand: 'npm install -g @zed-industries/claude-agent-acp',
    loginHint: 'Run `claude` in a terminal and type /login, or set ANTHROPIC_API_KEY.',
  },
  codex: {
    id: 'codex',
    label: 'GPT (Codex)',
    command: 'codex-acp',
    args: [],
    installCommand: 'npm install -g @zed-industries/codex-acp',
    loginHint: 'Run `codex login` in a terminal (Sign in with ChatGPT), or set OPENAI_API_KEY.',
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    command: 'gemini',
    args: ['--acp'],
    installCommand: 'npm install -g @google/gemini-cli',
    loginHint: 'Run `gemini` in a terminal and choose "Login with Google", or set GEMINI_API_KEY.',
  },
};

export function isAgentId(value: unknown): value is AgentId {
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
