// The whole contract between the main process and the window. Keep it small:
// every call crosses a process boundary, and every method is attack surface.
import type * as acp from '@agentclientprotocol/sdk';

export type AgentKey = 'claude' | 'codex' | 'gemini' | 'demo';
export type VendorAgentKey = Exclude<AgentKey, 'demo'>;

export interface AgentOption {
  id: AgentKey;
  label: string;
}

export interface DirEntry {
  name: string;
  path: string;
  dir: boolean;
}

export interface SignInMethod {
  id: string;
  name: string;
  description?: string;
  /** Terminal methods run the agent's own CLI login; the user does that in a terminal. */
  terminal: boolean;
}

export type PromptOutcome =
  | { ok: true; stopReason: string }
  | { ok: false; kind: 'auth'; message: string; loginHint: string; methods: SignInMethod[] }
  | { ok: false; kind: 'not_installed'; message: string; installCommand: string }
  | { ok: false; kind: 'error'; message: string };

export interface ImageItem {
  id: string;
  src: string;
  title: string;
  from: 'agent' | 'you';
}

export type CommandState = 'awaiting' | 'running' | 'denied' | 'exited';

export interface SearchMatch {
  path: string;
  line: number;
  column: number;
  text: string;
}

export interface GitFile {
  path: string;
  status: 'M' | 'A' | 'D' | 'R' | 'U' | 'C';
  staged: boolean;
}

export interface GitStatus {
  root: string;
  branch: string | null;
  files: GitFile[];
}

export interface ChatInfo {
  chatId: string;
  cwd: string;
  /** Set when the task runs in its own git worktree. */
  branch?: string;
}

export type ApiKeyName = 'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY' | 'GEMINI_API_KEY';

export interface SettingsView {
  settings: {
    idleStopMinutes: number;
    maxRunningAgents: number;
    agents: Partial<Record<VendorAgentKey, { command?: string; args?: string[] }>>;
  };
  defaults: Record<VendorAgentKey, { command: string; args: string[] }>;
  keys: { protection: 'os' | 'basic' | 'none'; saved: Record<ApiKeyName, boolean> };
}

export type MainEvent =
  | { type: 'update'; chatId: string; update: acp.SessionUpdate }
  | { type: 'notice'; chatId: string; text: string }
  | {
      type: 'permission';
      requestId: string;
      chatId: string;
      title: string;
      toolKind?: string;
      options: acp.PermissionOption[];
    }
  | { type: 'permissionClosed'; requestId: string }
  | { type: 'writeReview'; reviewId: string; chatId?: string; path: string; before: string | null; after: string }
  | { type: 'writeReviewClosed'; reviewId: string }
  | {
      type: 'command';
      commandId: string;
      chatId?: string;
      agent: string;
      commandLine: string;
      cwd: string;
      state: CommandState;
      exitCode?: number | null;
    }
  | { type: 'commandOutput'; commandId: string; data: string }
  | { type: 'agents'; running: { id: string; label: string; busy: boolean }[] }
  | { type: 'image'; image: ImageItem }
  | { type: 'fileChanged'; path: string }
  | { type: 'turnChanges'; chatId: string; turnId: string; files: string[] }
  | { type: 'ptyData'; id: string; data: string }
  | { type: 'ptyExit'; id: string; exitCode: number };

export interface MemoryReport {
  kind: string;
  editorMb: number;
  agents: { label: string; mb: number }[];
}

export type Result<T = void> = { ok: true; value: T } | { ok: false; message: string };

export interface FriedLiverApi {
  versions: { electron: string; chrome: string; node: string };
  platform: string;
  initialFolder(): Promise<string | null>;
  openFolder(): Promise<string | null>;
  listDir(dir: string): Promise<DirEntry[]>;
  listFiles(): Promise<{ files: string[]; truncated: boolean }>;
  search(query: string, options: { caseSensitive?: boolean; regex?: boolean }): Promise<Result<{ matches: SearchMatch[]; truncated: boolean }>>;
  readFile(file: string): Promise<string>;
  writeFile(file: string, content: string): Promise<void>;

  agents(): Promise<AgentOption[]>;
  createChat(agent: AgentKey, options?: { worktree?: boolean; title?: string }): Promise<Result<ChatInfo>>;
  prompt(chatId: string, blocks: acp.ContentBlock[]): Promise<PromptOutcome>;
  cancel(chatId: string): Promise<void>;
  signIn(agent: AgentKey, methodId: string): Promise<{ ok: boolean; message?: string }>;
  respondPermission(requestId: string, optionId: string | null): Promise<void>;
  respondWrite(reviewId: string, accept: boolean, content?: string): Promise<void>;
  respondCommand(commandId: string, approve: boolean): Promise<void>;
  undoTurn(chatId: string, turnId: string): Promise<Result<string[]>>;
  mergeTask(chatId: string): Promise<Result>;
  removeTask(chatId: string): Promise<Result>;
  stopAgents(): Promise<void>;

  ptyCreate(cols: number, rows: number): Promise<{ id: string; title: string }>;
  ptyWrite(id: string, data: string): Promise<void>;
  ptyResize(id: string, cols: number, rows: number): Promise<void>;
  ptyKill(id: string): Promise<void>;

  gitStatus(): Promise<GitStatus | null>;
  gitHead(file: string): Promise<string | null>;
  gitCommit(message: string): Promise<Result<string>>;

  getSettings(): Promise<SettingsView>;
  updateSettings(change: Partial<SettingsView['settings']>): Promise<SettingsView>;
  setApiKey(name: ApiKeyName, value: string | null): Promise<Result<SettingsView>>;

  memory(): Promise<MemoryReport>;
  onEvent(listener: (event: MainEvent) => void): () => void;
}

/** Every invokable method, mapped to its IPC channel so main and preload can't drift apart. */
export const METHODS = [
  'initialFolder',
  'openFolder',
  'listDir',
  'listFiles',
  'search',
  'readFile',
  'writeFile',
  'agents',
  'createChat',
  'prompt',
  'cancel',
  'signIn',
  'respondPermission',
  'respondWrite',
  'respondCommand',
  'undoTurn',
  'mergeTask',
  'removeTask',
  'stopAgents',
  'ptyCreate',
  'ptyWrite',
  'ptyResize',
  'ptyKill',
  'gitStatus',
  'gitHead',
  'gitCommit',
  'getSettings',
  'updateSettings',
  'setApiKey',
  'memory',
] as const satisfies readonly (keyof FriedLiverApi)[];

export type Method = (typeof METHODS)[number];
export const channel = (method: Method) => `fl:${method}`;
export const EVENT_CHANNEL = 'fl:event';
