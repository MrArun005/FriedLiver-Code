// Lets clients outside FriedLiver (the Claude Code extension, or the claude CLI
// in FriedLiver's terminal) use the built-in browser tools. The editor mints one
// token per launch for EXTERNAL_CLIENT (bridge.ts), which reaches the browser_*
// tools only and asks the user (bridgeRequests.ts). Here: the token file, and the
// `friedliver-browser` stdio entry in Claude Code's user config, which runs
// ../bridge/externalStdio.ts.
//
// We edit ~/.claude.json directly instead of running `claude mcp add`: one code
// path, tested, and the file is Claude Code's documented user-scope MCP config.
import { randomBytes } from 'node:crypto';
import { chmod, copyFile, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const SERVER_NAME = 'friedliver-browser';
const DIR = 'external';

/**
 * Writes `{ url, token, pid }` (pid: the process serving url) to `<storage>/external/browser-token.json`, 0600 in a 0700 folder made fresh
 * (earlier launches' files go first, created with wx), so only this launch's token is ever on disk.
 */
export async function writeTokenFile(storage: string, url: string, token: string, pid = process.pid): Promise<string> {
  await removeTokenFile(storage);
  const dir = path.join(storage, DIR);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const file = path.join(dir, 'browser-token.json');
  await writeFile(file, JSON.stringify({ url, token, pid }), { mode: 0o600, flag: 'wx' });
  return file;
}

/** No token on disk: the stdio server then answers "FriedLiver isn't running". Also clears older layouts' `external-*` folders. */
export async function removeTokenFile(storage: string): Promise<void> {
  const names = await readdir(storage).catch(() => [] as string[]);
  for (const name of names) if (name === DIR || name.startsWith(`${DIR}-`)) await rm(path.join(storage, name), { recursive: true, force: true });
}

/**
 * The Claude Code entry: a stdio server run with FriedLiver's own runtime as plain Node. It holds no
 * secret and no port (externalStdio.ts reads the token file each request), so it can stay registered.
 */
export function claudeEntry(runtime: string, script: string, tokenFile: string) {
  return { type: 'stdio', command: runtime, args: [script, tokenFile], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

type Config = Record<string, unknown> & { mcpServers?: Record<string, unknown> };

/** Claude Code's config, or {} when there is none yet; throws rather than guess at a file it can't parse. */
async function readConfig(file: string): Promise<{ config: Config; exists: boolean }> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { config: {}, exists: false };
    throw err;
  }
  const config: unknown = JSON.parse(text);
  if (typeof config !== 'object' || config === null || Array.isArray(config)) throw new Error(`${file} is not a JSON object; left it alone.`);
  const servers = (config as Config).mcpServers;
  if (servers !== undefined && (typeof servers !== 'object' || servers === null || Array.isArray(servers))) throw new Error(`mcpServers in ${file} is not an object; left it alone.`);
  return { config: config as Config, exists: true };
}

/** The new file is always 0600 (it holds bearer tokens). Backup of the old file, then a write to a temp file beside it and a rename, so a crash never leaves half a config. */
async function writeConfig(link: string, config: Config, exists: boolean): Promise<void> {
  // A dotfile manager's symlink stays a symlink: the file it points at is the one replaced.
  const file = exists ? await realpath(link) : link;
  if (exists) {
    await copyFile(file, `${file}.friedliver-backup`);
    await chmod(`${file}.friedliver-backup`, 0o600);
  }
  const tmp = `${file}.friedliver-${randomBytes(6).toString('hex')}`;
  try {
    await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/** Adds or updates our entry (replacing an older http one), touching nothing else. 'unchanged' when it already says this. */
export async function registerClaude(file: string, want: ReturnType<typeof claudeEntry>): Promise<'added' | 'updated' | 'unchanged'> {
  const { config, exists } = await readConfig(file);
  const servers = config.mcpServers ?? {};
  const had = servers[SERVER_NAME];
  if (JSON.stringify(had) === JSON.stringify(want)) return 'unchanged';
  if (had !== undefined && !isOurEntry(had)) throw new Error(`${file} already has an MCP server named "${SERVER_NAME}" that FriedLiver didn't add; left it alone.`);
  await writeConfig(file, { ...config, mcpServers: { ...servers, [SERVER_NAME]: want } }, exists);
  return had === undefined ? 'added' : 'updated';
}

/**
 * An entry FriedLiver wrote: the stdio one running its externalStdio.js, or an older http one pointing at
 * FriedLiver's loopback server. A `friedliver-browser` server the user set up some other way is theirs.
 */
export function isOurEntry(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  const e = entry as { type?: unknown; args?: unknown; url?: unknown };
  if (e.type === 'stdio') return Array.isArray(e.args) && typeof e.args[0] === 'string' && /[\\/]externalStdio\.js$/.test(e.args[0]);
  return e.type === 'http' && typeof e.url === 'string' && /^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(e.url);
}

/**
 * Removes the entry FriedLiver added (with `onlyHttp`, only an older http one, which pointed at a port that
 * may now be anyone's), and nothing when there is none or it isn't ours; true when removed. A file without
 * our entry is not written at all.
 */
export async function unregisterClaude(file: string, onlyHttp = false): Promise<boolean> {
  const { config, exists } = await readConfig(file);
  const servers = config.mcpServers;
  if (!exists || !servers || !(SERVER_NAME in servers) || !isOurEntry(servers[SERVER_NAME])) return false;
  if (onlyHttp && (servers[SERVER_NAME] as { type?: unknown } | null)?.type !== 'http') return false;
  const rest = { ...servers };
  delete rest[SERVER_NAME];
  await writeConfig(file, { ...config, mcpServers: rest }, exists);
  return true;
}
