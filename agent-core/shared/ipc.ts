// The whole contract between the main process and the window. Keep it small:
// every call crosses a process boundary, and every method is attack surface.
import type * as acp from '@agentclientprotocol/sdk';

export type AgentKey = 'claude' | 'codex' | 'gemini' | 'demo';

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
  | { type: 'command'; commandId: string; agent: string; commandLine: string; cwd: string; state: CommandState; exitCode?: number | null }
  | { type: 'commandOutput'; commandId: string; data: string }
  | { type: 'agents'; running: { id: string; label: string; busy: boolean }[] }
  | { type: 'image'; image: ImageItem }
  | { type: 'fileChanged'; path: string };

export interface MemoryReport {
  kind: string;
  editorMb: number;
  agents: { label: string; mb: number }[];
}

export interface FriedLiverApi {
  versions: { electron: string; chrome: string; node: string };
  initialFolder(): Promise<string | null>;
  openFolder(): Promise<string | null>;
  listDir(dir: string): Promise<DirEntry[]>;
  readFile(file: string): Promise<string>;
  writeFile(file: string, content: string): Promise<void>;
  agents(): Promise<AgentOption[]>;
  createChat(agent: AgentKey): Promise<string>;
  prompt(chatId: string, blocks: acp.ContentBlock[]): Promise<PromptOutcome>;
  cancel(chatId: string): Promise<void>;
  signIn(agent: AgentKey, methodId: string): Promise<{ ok: boolean; message?: string }>;
  respondPermission(requestId: string, optionId: string | null): Promise<void>;
  respondWrite(reviewId: string, accept: boolean, content?: string): Promise<void>;
  respondCommand(commandId: string, approve: boolean): Promise<void>;
  stopAgents(): Promise<void>;
  memory(): Promise<MemoryReport>;
  onEvent(listener: (event: MainEvent) => void): () => void;
}

/** Channel names, shared so main and preload can't drift apart. */
export const CHANNELS = {
  initialFolder: 'fl:initialFolder',
  openFolder: 'fl:openFolder',
  listDir: 'fl:listDir',
  readFile: 'fl:readFile',
  writeFile: 'fl:writeFile',
  agents: 'fl:agents',
  createChat: 'fl:createChat',
  prompt: 'fl:prompt',
  cancel: 'fl:cancel',
  signIn: 'fl:signIn',
  respondPermission: 'fl:respondPermission',
  respondWrite: 'fl:respondWrite',
  respondCommand: 'fl:respondCommand',
  stopAgents: 'fl:stopAgents',
  memory: 'fl:memory',
  event: 'fl:event',
} as const;
