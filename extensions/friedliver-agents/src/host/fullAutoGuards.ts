// What Full auto never covers (SECURITY.md "Full auto's hard limits"): a page from the internet
// steering the browser onto this computer or its network, a download, running a file this chat
// just downloaded or wrote, installing packages, and piping a download into a shell. Enforced
// here and where requests are answered (core.ts, bridgeRequests.ts), never by prompting.
// Pure apart from DNS, which callers may replace, so all of it is tested.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import path from 'node:path';

export const STILL_ASKS = 'Full auto still asks';
/** A file this chat downloaded or wrote counts as fresh for this many turns, the running one included. */
export const GUARD_TURNS = 3;

export type Lookup = (host: string) => Promise<string[]>;
const systemLookup: Lookup = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

const NAT64_LOCAL = ipaddr.parseCIDR('64:ff9b:1::/48');
/** IPv4-compatible IPv6 (::a.b.c.d), deprecated and never global. */
const V4_COMPATIBLE = ipaddr.parseCIDR('::/96');

/**
 * Anything but plain global unicast, by ipaddr.js's range table: loopback, unspecified, private,
 * link-local, CGNAT (100.64/10), benchmarking (198.18/15), multicast, broadcast, reserved, and IPv6
 * that carries IPv4 (NAT64, 6to4…). IPv4-mapped IPv6 is judged by the IPv4 inside. Not an IP: local.
 */
export function isPrivateIp(raw: string): boolean {
  const text = raw.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (!isIP(text)) return true;
  let addr = ipaddr.parse(text);
  if (addr instanceof ipaddr.IPv6 && addr.isIPv4MappedAddress()) addr = addr.toIPv4Address();
  if (addr instanceof ipaddr.IPv6 && (addr.match(NAT64_LOCAL) || addr.match(V4_COMPATIBLE))) return true;
  return addr.range() !== 'unicast';
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
  'cp mv ln rsync sh bash zsh dash ksh fish csh tcsh source . exec eval python python2 python3 node deno bun tsx ts-node ruby perl php pwsh powershell osascript open java chmod xattr install ii invoke-item'.split(' '),
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
  /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|ci)|(?:pip3?|pipx|poetry|uv(?:\s+pip)?|-m\s+pip)\s+(?:install|add)|(?:gem|cargo|go|brew|port|apt|apt-get|yum|dnf|apk|zypper|choco|winget|scoop)\s+(?:install|reinstall)|uv\s+tool\s+install|pacman\s+-S|npx|bunx|uvx|(?:npm|bun)\s+x|npm\s+exec|(?:pnpm|yarn)\s+dlx|pipx\s+run|go\s+run\s+\S+@\S+)\b/i;
const FETCHER = String.raw`(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)`;
const SHELLS = String.raw`(?:(?:\S*\/)?(?:ba|z|da|k|fi|c|tc)?sh|python[23]?|node|perl|ruby|php|iex|invoke-expression|pwsh|powershell|osascript|source)`;
const PIPE_FROM_FETCHER = new RegExp(String.raw`\b${FETCHER}\b[^;&|]*\|(?!\|)`, 'i');
const PIPE_TO_SHELL = new RegExp(
  String.raw`\b${FETCHER}\b[^|;&]*\|\s*(?:sudo\s+)?${SHELLS}\b|\b${SHELLS}\b[^;&|]*(?:\$\(|<\(|\x60)\s*${FETCHER}\b|\biex\b[^;&|]*\(\s*${FETCHER}\b`,
  'i',
);

/**
 * PowerShell programs that fetch or start other code. downloadTargets only reads curl/wget the POSIX
 * way, and PowerShell takes any unique parameter prefix (-OutF, -o), so under PowerShell a line
 * naming any of these simply asks. `start` counts only as a command, not `npm start`.
 */
const PS_FETCH_OR_RUN = /(?:^|[^\w-])(?:iwr|irm|invoke-webrequest|invoke-restmethod|start-bitstransfer|curl|wget|certutil|bitsadmin|start-process|saps|msiexec|rundll32|mshta|regsvr32|cscript|wscript|iex|invoke-expression|ii|invoke-item|icm|invoke-command|sajb|start-job|start-threadjob|installutil|msbuild)(?:\.exe)?(?![\w-])|(?:^|[;&|\n({]\s*)start(?:\.exe)?(?![\w-])/i;

/** Variables that make a shell or runtime load code: set in a line, they can turn any later program into anything. */
const STARTUP_VAR = /(?:^|[^\w$])(?:\$env:)?(BASH_ENV|ENV|NODE_OPTIONS|PYTHONSTARTUP|PROMPT_COMMAND)\s*=/i;
/** On Full auto, any mention of these at all asks (read, export -n, Env:, -v ...). Bare ENV only in capitals, so `env` the program passes. */
const STARTUP_NAME = /(?<!\w)(?:BASH_ENV|NODE_OPTIONS|PYTHONSTARTUP|PROMPT_COMMAND|PERL5OPT|RUBYOPT|LD_PRELOAD|DYLD_INSERT_LIBRARIES|GIT_SSH_COMMAND)(?!\w)/i;
const STARTUP_ENV = /(?<!\w)ENV(?![\w:])/;
/** `NAME=value` and `$env:NAME = 'value'` assignments: the whole value, quoted or not. */
const ASSIGNED = /(?:\$env:)?\b[A-Za-z_]\w*\s*=\s*('[^']*'|"[^"]*"|[^\s;&|]+)/g;
/** Every file an assigned value could name: split at path and list separators, option prefixes (--x=, -M) dropped. */
const valueFiles = (value: string) =>
  value
    .replace(/^['"]|['"]$/g, '')
    .split(/[\s,;]+/)
    .map((e) => e.replace(/^--?[\w-]*=/, '').replace(/^-[A-Za-z](?=.)/, ''))
    .flatMap((e) => e.split(/[\\/:]+/))
    .filter(Boolean);

/** Without quoted strings, for checks that only count what the shell itself reads. */
const unquoted = (line: string) => line.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''");

/**
 * On Full auto, lines this doesn't parse reliably ask instead of being guessed at: command
 * substitution, a quoted program, any quote, backslash, $ or brace, an unquoted glob, a download
 * piped anywhere, or a download whose file can't be told (bundled or attached -o/-O, a redirect).
 */
function unclear(line: string, powershell: boolean): string | undefined {
  if (/\$\(|`|<\(|>\(/.test(line)) return 'it uses command substitution';
  // In PowerShell any parenthesis runs what is inside it first: `iex (iwr URL).Content`.
  if (powershell && /\(/.test(line)) return 'it uses command substitution';
  const bare = unquoted(line);
  if (/(?:^|[;&|\n]\s*)(?:\w+=\S*\s+)*(?:''|\\)/.test(bare)) return 'its program is quoted';
  if (/['"\\${}]/.test(line)) return 'it has quotes, backslashes, $ or braces';
  if (/[*?[]/.test(bare)) return 'it uses a glob';
  if (PIPE_FROM_FETCHER.test(line)) return 'it pipes a download into another program';
  for (const part of bare.split(/[;&|\n]/)) {
    const words = part.trim().split(/\s+/);
    if (!/^(?:curl|wget)$/.test(path.basename(words.find((w) => !PREFIX.has(w) && !w.includes('=')) ?? ''))) continue;
    if (/>/.test(part) || words.some((w) => /^-[a-zA-Z]*[oO][a-zA-Z]*$/.test(w) ? w.length > 2 : /^-[oO]./.test(w))) return "FriedLiver can't tell where the download goes";
  }
  return undefined;
}

/**
 * Why Full auto must still ask before running `line`, or undefined: it pipes a download into a
 * shell, installs or fetches packages, or runs, copies or moves a file named in `fresh` (this chat's
 * recent downloads and writes); on `fullAuto`, also a line too unclear to check (unclear()).
 * `powershell`: agent command lines run in PowerShell here (agentShell), which reads more as code.
 */
export function commandGuard(line: string, fresh: ReadonlySet<string>, fullAuto = false, powershell = false): string | undefined {
  if (PIPE_TO_SHELL.test(line)) return `${STILL_ASKS}: the command pipes a download into a shell`;
  if (INSTALL.test(line)) return `${STILL_ASKS}: the command installs or fetches packages`;
  const startup = STARTUP_VAR.exec(line);
  if (startup) return `${STILL_ASKS}: the command sets ${startup[1]}, a startup variable that makes programs load other code`;
  const named = fullAuto ? (STARTUP_NAME.exec(line) ?? STARTUP_ENV.exec(line)) : null;
  if (named) return `${STILL_ASKS}: the command names ${named[0]}, a startup variable that makes programs load other code`;
  if (powershell && PS_FETCH_OR_RUN.test(line)) return `${STILL_ASKS}: the command downloads or starts other code in PowerShell`;
  for (const [, value] of line.matchAll(ASSIGNED)) {
    const hit = valueFiles(value).find((f) => fresh.has(f));
    if (hit) return `${STILL_ASKS}: the command points a variable at ${hit}, a file this chat just downloaded or wrote`;
  }
  const why = fullAuto ? unclear(line, powershell) : undefined;
  if (why) return `${STILL_ASKS}: ${why}, so FriedLiver can't check what the command runs`;
  if (!fresh.size) return undefined;
  for (const words of simpleCommands(line)) {
    let i = 0;
    while (i < words.length - 1 && (PREFIX.has(words[i]) || /^\w+=/.test(words[i]) || (words[i].startsWith('-') && i > 0))) i++;
    const prog = words[i];
    const named = (w: string) => fresh.has(path.basename(w));
    const hit = named(prog) ? prog : RUNNERS.has(path.basename(prog).toLowerCase()) ? words.slice(i + 1).find(named) : undefined;
    if (hit) return `${STILL_ASKS}: the command runs ${path.basename(hit)}, a file this chat just downloaded or wrote`;
  }
  return undefined;
}
