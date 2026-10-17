// Lets clients outside FriedLiver (the Claude Code extension, or the claude CLI
// in FriedLiver's terminal) use the built-in browser tools. The editor mints one
// token per launch for EXTERNAL_CLIENT (bridge.ts), which reaches the browser_*
// tools only and asks the user like a chat does (bridgeRequests.ts). Here: the
// token file, and the `friedliver-browser` entry in Claude Code's user config.
//
// ponytail: we edit ~/.claude.json directly instead of running `claude mcp add`;
// that command would carry the bearer token in its argv, which any local user
// can read with ps. The file is Claude Code's documented user-scope MCP config.
import { randomBytes } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const SERVER_NAME = 'friedliver-browser';
const DIR_PREFIX = 'external-';

/**
 * Writes `{ url, token }` to a fresh 0600 file in a fresh 0700 directory under `storage`, after
 * removing earlier launches' files, so only this launch's token is ever on disk. Returns its path.
 */
export async function writeTokenFile(storage: string, url: string, token: string): Promise<string> {
  await mkdir(storage, { recursive: true });
  for (const name of await readdir(storage)) {
    if (name.startsWith(DIR_PREFIX)) await rm(path.join(storage, name), { recursive: true, force: true });
  }
  const dir = await mkdtemp(path.join(storage, DIR_PREFIX));
  await chmod(dir, 0o700);
  const file = path.join(dir, 'browser-token.json');
  await writeFile(file, JSON.stringify({ url, token }), { mode: 0o600, flag: 'wx' });
  return file;
}

type Config = Record<string, unknown> & { mcpServers?: Record<string, unknown> };

const entry = (url: string, token: string) => ({ type: 'http', url, headers: { Authorization: `Bearer ${token}` } });

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

/** Adds or updates our entry, touching nothing else. 'unchanged' when it already says this. */
export async function registerClaude(file: string, url: string, token: string): Promise<'added' | 'updated' | 'unchanged'> {
  const { config, exists } = await readConfig(file);
  const servers = config.mcpServers ?? {};
  const want = entry(url, token);
  const had = servers[SERVER_NAME];
  if (JSON.stringify(had) === JSON.stringify(want)) return 'unchanged';
  await writeConfig(file, { ...config, mcpServers: { ...servers, [SERVER_NAME]: want } }, exists);
  return had === undefined ? 'added' : 'updated';
}

/** Removes our entry if it is still the one this launch wrote (same URL); true when removed. */
export async function unregisterClaude(file: string, url: string): Promise<boolean> {
  const { config, exists } = await readConfig(file);
  const servers = config.mcpServers;
  const ours = servers?.[SERVER_NAME] as { url?: unknown } | undefined;
  if (!exists || !servers || ours?.url !== url) return false;
  const rest = { ...servers };
  delete rest[SERVER_NAME];
  await writeConfig(file, { ...config, mcpServers: rest }, exists);
  return true;
}
