// What Full auto never covers (SECURITY.md "Full auto's hard limits"): a page from the internet
// steering the browser onto this computer or its network, a download, running a file this chat
// just downloaded or wrote, installing packages, and piping a download into a shell. Enforced
// here and where requests are answered (core.ts, bridgeRequests.ts), never by prompting.
// Pure apart from DNS, which callers may replace, so all of it is tested.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import path from 'node:path';

export const STILL_ASKS = 'Full auto still asks';
/** A file this chat downloaded or wrote counts as fresh for this many turns, the running one included. */
export const GUARD_TURNS = 3;

export type Lookup = (host: string) => Promise<string[]>;
const systemLookup: Lookup = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

function v4Private(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Eight 16-bit groups, or null. Takes a dotted IPv4 tail (::ffff:127.0.0.1). */
function v6Groups(ip: string): number[] | null {
  let text = ip;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail) {
    const [a, b, c, d] = tail[1].split('.').map(Number);
    text = `${text.slice(0, -tail[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, rest] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = rest ? rest.split(':') : [];
  const fill = text.includes('::') ? 8 - left.length - right.length : 0;
  const groups = [...left, ...Array(Math.max(0, fill)).fill('0'), ...right].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

/** Loopback, unspecified, private (10/8, 172.16/12, 192.168/16, fc00::/7), link-local (169.254/16, fe80::/10), IPv4 inside IPv6. */
export function isPrivateIp(raw: string): boolean {
  const ip = raw.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (isIP(ip) === 4) return v4Private(ip);
  if (isIP(ip) !== 6) return false;
  const g = v6Groups(ip.toLowerCase());
  if (!g) return true;
  if (g.slice(0, 7).every((x) => x === 0)) return g[7] <= 1; // :: and ::1
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible): the IPv4 address inside decides.
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return v4Private(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
  return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80;
}

/** Whether `url`'s host is local by its name or address alone; undefined for a name only DNS can tell. Unparsable: local. */
export function isLocalName(url: string): boolean | undefined {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return true;
  }
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  const bare = host.replace(/^\[|\]$/g, '');
  return isIP(bare) ? isPrivateIp(bare) : undefined;
}

/**
 * Whether `url` reaches this computer or its network: its host is such an address, a local name
 * (localhost, *.localhost, *.local), or a name that resolves to one, checked on every address
 * DNS gives (a rebinding name is caught by what it resolves to, not what it is called). A URL that
 * doesn't parse or resolve counts as local: fail closed.
 */
export async function isLocalTarget(url: string, resolve: Lookup = systemLookup): Promise<boolean> {
  const local = isLocalName(url);
  if (local !== undefined) return local;
  const host = new URL(url).hostname.replace(/\.$/, '');
  try {
    const ips = await resolve(host);
    return !ips.length || ips.some(isPrivateIp);
  } catch {
    return true;
  }
}

/**
 * The files each chat downloaded or wrote, by turn, for the last GUARD_TURNS turns. Matched by
 * name, not location: a same-named file elsewhere also asks, which errs the safe way.
 */
export class FileTrail {
  private readonly chats = new Map<string, Set<string>[]>();

  add(chatId: string, file: string): void {
    if (!file) return;
    const turns = this.chats.get(chatId) ?? [new Set<string>()];
    turns.at(-1)!.add(path.basename(file));
    this.chats.set(chatId, turns);
  }

  endTurn(chatId: string): void {
    const turns = this.chats.get(chatId);
    if (!turns) return;
    turns.push(new Set());
    if (turns.length > GUARD_TURNS) turns.shift();
  }

  forget(chatId: string): void {
    this.chats.delete(chatId);
  }

  names(chatId: string): Set<string> {
    return new Set(this.chats.get(chatId)?.flatMap((t) => [...t]));
  }
}

/** Programs that run (or make runnable) the file they are given. */
const RUNNERS = new Set(
  'sh bash zsh dash ksh fish csh tcsh source . exec eval python python2 python3 node deno bun tsx ts-node ruby perl php pwsh powershell osascript open java chmod xattr install'.split(' '),
);
/** Words before the program: `sudo env FOO=1 nohup ./x`. */
const PREFIX = new Set('sudo doas env nohup time nice command builtin xargs'.split(' '));

/** Simple commands in a line, each as words: split at ; & | newlines, $( and backticks, quotes dropped. */
function simpleCommands(line: string): string[][] {
  return line
    .split(/[;&|\n`]|\$\(|<\(/)
    .map((part) => part.split(/[\s'"()<>]+/).filter(Boolean))
    .filter((w) => w.length);
}

const isUrl = (w: string) => /^https?:\/\//i.test(w);

/** Files a curl or wget in `line` saves to: -o/-O/--output/--output-document, a > redirect, else the URL's own name. */
export function downloadTargets(line: string): string[] {
  const out: string[] = [];
  for (const part of line.split(/[;&|\n]/)) {
    const words = part.trim().split(/\s+/);
    const prog = path.basename(words.find((w) => !PREFIX.has(w) && !w.includes('=')) ?? '');
    if (prog !== 'curl' && prog !== 'wget') continue;
    for (let i = 0; i < words.length; i++) {
      const w = words[i].replace(/^['"]|['"]$/g, '');
      const m = /^--?(?:o|O|output|output-document)(?:=(.+))?$/.exec(w);
      if (m?.[1]) out.push(m[1]);
      else if (m && words[i + 1] && !words[i + 1].startsWith('-') && !isUrl(words[i + 1])) out.push(words[i + 1]);
      else if (w.startsWith('>')) out.push(w.slice(1).replace(/^>/, '') || (words[i + 1] ?? ''));
      else if (isUrl(w)) out.push(new URL(w).pathname.split('/').pop() ?? '');
    }
  }
  return out.map((f) => f.replace(/^['"]|['"]$/g, '')).filter((f) => f && f !== '-');
}

const INSTALL =
  /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|ci)|(?:pip3?|pipx|poetry|uv(?:\s+pip)?|-m\s+pip)\s+(?:install|add)|(?:gem|cargo|go|brew|port|apt|apt-get|yum|dnf|apk|zypper|choco|winget|scoop)\s+(?:install|reinstall)|uv\s+tool\s+install|pacman\s+-S)\b/i;
const FETCHER = String.raw`(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)`;
const SHELLS = String.raw`(?:(?:\S*\/)?(?:ba|z|da|k|fi|c|tc)?sh|python[23]?|node|perl|ruby|php|iex|invoke-expression|pwsh|powershell|osascript|source)`;
const PIPE_TO_SHELL = new RegExp(
  String.raw`\b${FETCHER}\b[^|;&]*\|\s*(?:sudo\s+)?${SHELLS}\b|\b${SHELLS}\b[^;&|]*(?:\$\(|<\(|\x60)\s*${FETCHER}\b|\biex\b[^;&|]*\(\s*${FETCHER}\b`,
  'i',
);

/**
 * Why Full auto must still ask before running `line`, or undefined: it pipes a download into a
 * shell, installs packages, or runs a file named in `fresh` (this chat's recent downloads and writes).
 */
export function commandGuard(line: string, fresh: ReadonlySet<string>): string | undefined {
  if (PIPE_TO_SHELL.test(line)) return `${STILL_ASKS}: the command pipes a download into a shell`;
  if (INSTALL.test(line)) return `${STILL_ASKS}: the command installs packages`;
  if (!fresh.size) return undefined;
  for (const words of simpleCommands(line)) {
    let i = 0;
    while (i < words.length - 1 && (PREFIX.has(words[i]) || /^\w+=/.test(words[i]) || (words[i].startsWith('-') && i > 0))) i++;
    const prog = words[i];
    const named = (w: string) => fresh.has(path.basename(w));
    const hit = named(prog) ? prog : RUNNERS.has(path.basename(prog)) ? words.slice(i + 1).find(named) : undefined;
    if (hit) return `${STILL_ASKS}: the command runs ${path.basename(hit)}, a file this chat just downloaded or wrote`;
  }
  return undefined;
}
