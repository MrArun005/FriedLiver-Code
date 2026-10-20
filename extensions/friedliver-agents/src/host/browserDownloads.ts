// Downloads an agent starts in FriedLiver's browser. The editor (patch 0300) saves them and pauses
// any that start while an agent's call acts, marked with that call's token; this asks the user in the
// agent's chat about the call's own downloads only, lets them go on or cancels them, and tells the
// agent where the file is, how big it is and its sha256.
// Without patch 0300 (stock VS Code) the commands don't exist and nothing here changes a call.

/** One download, as the editor's _friedliver.browser.downloads.* commands give it. */
export interface DownloadInfo {
  id: string;
  url: string;
  filename: string;
  path: string;
  state: 'awaiting' | 'progressing' | 'completed' | 'cancelled' | 'failed';
  waitingFor?: 'agent' | 'page' | 'large';
  byAgent: boolean;
  /** The agent call (DownloadsApi.begin's token) it started during. */
  agentCall?: string;
  receivedBytes: number;
  totalBytes: number;
  startTime: number;
  error?: string;
  sha256?: string;
}

export interface DownloadsApi {
  list(): Promise<DownloadInfo[]>;
  /** A call starts acting; its token marks the downloads that start before it ends. */
  begin(): Promise<string>;
  /** That call ended; other calls keep theirs. */
  end(token: string): Promise<void>;
  /** Takes the OK for one of the call's own downloads; false when it isn't the call's or was taken. */
  claim(id: string, token: string): Promise<boolean>;
  approve(id: string, allow: boolean): Promise<void>;
  waitFor(id: string, ms: number): Promise<DownloadInfo | undefined>;
}

/** Above this the user is asked even in Full auto (the editor's LARGE_DOWNLOAD_BYTES). */
export const LARGE_DOWNLOAD_BYTES = 500 * 1024 * 1024;
/** How long a tool call waits for a download it started to finish before it reports progress instead. */
export const DOWNLOAD_WAIT_MS = 5 * 60_000;
/** After the action, how long the call stays open for a download it caused to start. */
export const DOWNLOAD_SETTLE_MS = 1_500;

/** The editor's commands, through `exec` (vscode.commands.executeCommand). */
export function commandsApi(exec: (command: string, ...args: unknown[]) => Thenable<unknown>): DownloadsApi {
  const run = <T>(command: string, ...args: unknown[]) => Promise.resolve(exec(`_friedliver.browser.downloads.${command}`, ...args)) as Promise<T>;
  return {
    list: () => run<DownloadInfo[]>('list').then((l) => (Array.isArray(l) ? l : [])),
    begin: () => run<string>('beginAgentCall'),
    end: (token) => run('endAgentCall', token),
    claim: (id, token) => run<boolean>('claim', id, token).then((v) => v === true),
    approve: (id, allow) => run('approve', id, allow),
    waitFor: (id, ms) => run<DownloadInfo | undefined>('waitFor', id, ms),
  };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes || 0))} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(v >= 10 ? 1 : u >= 2 ? 2 : 1)} ${units[u]}`;
}

/** "report.pdf (2.4 MB) from example.com", for the approval card and the popup. */
export function describeForApproval(d: DownloadInfo): string {
  let host = d.url;
  try {
    host = new URL(d.url).host || d.url;
  } catch {
    // keep the URL
  }
  return `${d.filename}${d.totalBytes > 0 ? ` (${formatBytes(d.totalBytes)})` : ''} from ${host}`;
}

/** The line the agent reads about one download. */
export function downloadLine(d: DownloadInfo): string {
  switch (d.state) {
    case 'completed':
      return `Downloaded ${d.filename} to ${d.path} (${formatBytes(d.receivedBytes)}, ${d.receivedBytes} bytes, sha256 ${d.sha256 ?? 'unknown'}).`;
    case 'cancelled':
      return `The download of ${d.filename} was cancelled.`;
    case 'failed':
      return `The download of ${d.filename} failed${d.error ? `: ${d.error}` : ''}.`;
    case 'awaiting':
      return `The download of ${d.filename} is waiting for the user's OK.`;
    case 'progressing':
      return `${d.filename} is still downloading to ${d.path} (${formatBytes(d.receivedBytes)}${d.totalBytes > 0 ? ` of ${formatBytes(d.totalBytes)}` : ''}); it finishes in the background.`;
  }
}

export interface AgentDownloadOptions {
  /** The user's OK for one download; false or a throw cancels it. */
  ask?(d: DownloadInfo): Promise<boolean>;
  signal?: AbortSignal;
  settleMs?: number;
  waitMs?: number;
}

/**
 * Runs a browser action as one agent call: downloads that start meanwhile are this call's and wait
 * (paused) until `ask` allows them. Returns the action's text with a line per download it started.
 * Concurrent calls each get their own token, so one never answers or ends another's.
 */
export async function withAgentDownloads(api: DownloadsApi | undefined, act: () => Promise<string>, opts: AgentDownloadOptions = {}): Promise<string> {
  if (!api) return act();
  const token = await api.begin().catch(() => undefined);
  if (typeof token !== 'string' || !token) return act();
  let text: string;
  try {
    text = await act();
    await sleep(opts.settleMs ?? DOWNLOAD_SETTLE_MS, opts.signal);
  } finally {
    await api.end(token).catch(() => {});
  }
  const mine = (await api.list().catch(() => [] as DownloadInfo[])).filter((d) => d.agentCall === token);
  const lines: string[] = [];
  for (const d of mine) {
    if (d.state === 'failed') {
      lines.push(downloadLine(d));
      continue;
    }
    if (d.state !== 'awaiting' || !(await api.claim(d.id, token).catch(() => false))) continue;
    const allowed = opts.signal?.aborted ? false : await (opts.ask?.(d) ?? Promise.resolve(false)).catch(() => false);
    await api.approve(d.id, allowed).catch(() => {});
    if (!allowed) {
      lines.push(`The page started a download of ${d.filename}; the user did not allow it, so nothing was saved.`);
      continue;
    }
    const done = await api.waitFor(d.id, opts.waitMs ?? DOWNLOAD_WAIT_MS).catch(() => undefined);
    lines.push(downloadLine(done ?? d));
  }
  return lines.length ? `${text}\n${lines.join('\n')}` : text;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });
}
