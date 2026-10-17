// "Always allow", remembered: kept in the user's own storage (never the repository), read by every
// chat and every later session, whichever agent asks. Websites and agent tools are the user's,
// everywhere; folders and commands belong to this workspace. No vscode here, so all of it is tested.
import path from 'node:path';
import { cleanGrant, grantId, isGrant, type Access, type Grant, type Remembered, type ToolGrant } from '../shared/permissions';
import { isRule, type CommandRule } from '../shared/rules';
import { realPath } from './paths';

/** VS Code's Memento (globalState, workspaceState): get, and update that persists. */
export interface Store {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): unknown;
}

/** The old "Always allow" command rules keep their key, so rules made before still apply. */
const COMMANDS = 'friedliver.commandRules';
const FOLDERS = 'friedliver.folderRules';
const USER = 'friedliver.userRules';
const MAX_PER_KEY = 100;

type Saved = Grant & { at?: number; agent?: string };

/**
 * Places never always allowed, to read or write (Allow once still works there): system folders,
 * FriedLiver itself and its data (`extra`), and in home every dot file and folder (keys, credentials,
 * shell and tool config: .ssh, .aws, .claude, .codex, .gemini, .config, .npmrc, .netrc, .zshrc…)
 * and ~/Library (keychains, LaunchAgents, other apps' data). For writes also writeSensitive below.
 */
const SENSITIVE = ['/etc', '/private/etc', '/Library', '/System', '/usr', '/bin', '/sbin'];

/**
 * Writes no rule covers, anywhere (Allow once only). Fail-safe rather than a list to chase: any
 * dotfile or anything in a dot-folder (.git hooks, .vscode tasks, .husky, .github/workflows, .envrc,
 * .mcp.json, the agents' own settings…), plus config that runs code or steers agents without a dot.
 * Names are compared as the file system would read them: Unicode NFC, ignoring case; a segment the
 * OS could read as another (a trailing dot or space, an alternate data stream after ':') is refused.
 */
const WRITE_SENSITIVE_FILES = new Set(['claude.md', 'claude.local.md', 'agents.md', 'agents.override.md', 'gemini.md', 'copilot-instructions.md']);

function writeSensitive(real: string): boolean {
  const parts = real.split(/[\\/]/).filter((p, i) => p && !(i === 0 && /^[a-z]:$/i.test(p)));
  const name = (parts.at(-1) ?? '').normalize('NFC').toLowerCase();
  return (
    parts.some((p) => /[.\s]$/.test(p) || p.includes(':') || p.normalize('NFC').startsWith('.')) ||
    WRITE_SENSITIVE_FILES.has(name) ||
    name.endsWith('.code-workspace')
  );
}

function homeSensitive(real: string, home: string): boolean {
  if (real === home || !within(home, real)) return false;
  const first = path.relative(home, real).split(path.sep)[0];
  return first.startsWith('.') || first.toLowerCase() === 'library';
}

/** The .app around VS Code's appRoot (…/FriedLiver.app/Contents/Resources/app); appRoot itself elsewhere. */
export function appBundle(appRoot: string): string {
  return /^(.*?\.app)(?=[\\/])/.exec(appRoot)?.[1] ?? appRoot;
}

/** The editor's user-data folder, from an extension's globalStorage (<user data>/User/globalStorage/<extension>). */
export function userDataDir(globalStorage: string): string {
  return path.resolve(globalStorage, '..', '..', '..');
}

export function isSensitive(real: string, home: string, extra: readonly string[], access: Access = 'write'): boolean {
  if (access === 'write' && writeSensitive(real)) return true;
  if ([home, realPath(home) ?? home].some((h) => homeSensitive(real, h))) return true;
  return [...SENSITIVE, ...extra].some((b) => [b, realPath(b) ?? b].some((base) => within(base, real)));
}

function within(folder: string, file: string): boolean {
  const rel = path.relative(folder, file);
  return rel === '' || (!!rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

export class Permissions {
  private readonly home: string;

  constructor(
    private readonly opts: {
      user: Store;
      workspace: Store;
      home: string;
      /** More places never always allowed: the FriedLiver app bundle and its user data. */
      sensitive?: string[];
      now?: () => number;
      onChange?: () => void;
    },
  ) {
    this.home = realPath(opts.home) ?? opts.home;
  }

  list(): Remembered[] {
    const user = this.read(USER).map((s) => this.remembered(s, 'user'));
    const workspace = [...this.read(FOLDERS), ...this.read(COMMANDS)].map((s) => this.remembered(s, 'workspace'));
    return [...user, ...workspace];
  }

  /** "Always allow" command rules for this workspace (rules.ts matchesRule). */
  commands(): CommandRule[] {
    return this.read(COMMANDS).filter((s): s is CommandRule & Saved => s.kind === 'exact' || s.kind === 'prefix');
  }

  site(origin: string): Remembered | undefined {
    return this.list().find((r) => r.grant.kind === 'site' && r.grant.origin === origin);
  }

  tool(tool: ToolGrant): Remembered | undefined {
    return this.list().find((r) => r.grant.kind === 'tool' && r.grant.tool === tool);
  }

  /**
   * The folder rule covering `file`, where it really is (every symlink resolved, `..` gone). Changing
   * implies reading. A write never matches in a sensitive place, whatever folder the rule names.
   */
  folder(file: string, access: Access): Remembered | undefined {
    const real = realPath(file);
    if (real === null || this.sensitive(real, access)) return undefined;
    return this.list().find((r) => r.grant.kind === 'folder' && (access === 'read' || r.grant.access === 'write') && within(r.grant.folder, real));
  }

  /**
   * Folders "Always allow" offers for these files: their folder, the workspace folder holding them,
   * and the top folder in home (~/Desktop), most specific first. None when a write touches a sensitive place.
   */
  folderCandidates(files: string[], access: Access, roots: readonly string[]): Grant[] {
    const reals = files.map((f) => realPath(f));
    if (!reals.length || reals.some((r) => r === null)) return [];
    const real = reals as string[];
    if (real.some((r) => this.sensitive(r, access))) return [];
    const common = real.map((r) => path.dirname(r)).reduce((a, b) => {
      while (!within(a, b)) a = path.dirname(a);
      return a;
    });
    const root = roots.map((r) => realPath(r)).find((r): r is string => !!r && real.every((f) => within(r, f)));
    const top = within(this.home, common) && common !== this.home ? path.join(this.home, path.relative(this.home, common).split(path.sep)[0]) : undefined;
    const out: Grant[] = [];
    for (const folder of [common, root, top]) {
      if (folder && this.allowedFolder(folder, access) && !out.some((g) => g.kind === 'folder' && g.folder === folder)) out.push({ kind: 'folder', folder, access });
    }
    return out;
  }

  /** Remembers the grant; false when it can't be (not a grant, too wide, or a write into a sensitive place). */
  add(grant: Grant, agent?: string): boolean {
    if (!isGrant(grant)) return false;
    let g = cleanGrant(grant);
    if (g.kind === 'folder') {
      const real = realPath(g.folder);
      if (!real || !this.allowedFolder(real, g.access)) return false;
      g = { ...g, folder: real };
    }
    const key = g.kind === 'site' || g.kind === 'tool' ? USER : g.kind === 'folder' ? FOLDERS : COMMANDS;
    const saved: Saved = { ...g, at: (this.opts.now ?? Date.now)(), ...(agent ? { agent } : {}) };
    const id = grantId(g);
    this.write(key, [...this.read(key).filter((s) => grantId(s) !== id), saved].slice(-MAX_PER_KEY));
    return true;
  }

  revoke(id: string): void {
    for (const key of [USER, FOLDERS, COMMANDS]) {
      const all = this.read(key);
      const kept = all.filter((s) => grantId(s) !== id);
      if (kept.length !== all.length) this.write(key, kept);
    }
  }

  revokeAll(): void {
    for (const key of [USER, FOLDERS, COMMANDS]) if (this.read(key).length) this.write(key, []);
  }

  private allowedFolder(real: string, access: Access): boolean {
    // Home, or anything above it, is too wide to always allow.
    if (within(real, this.home) || path.dirname(real) === real) return false;
    return !this.sensitive(real, access);
  }

  private sensitive(real: string, access: Access): boolean {
    return isSensitive(real, this.home, this.opts.sensitive ?? [], access);
  }

  private remembered(s: Saved, scope: Remembered['scope']): Remembered {
    return { id: grantId(s), grant: cleanGrant(s), scope, ...(s.at ? { at: s.at } : {}), ...(s.agent ? { agent: s.agent } : {}) };
  }

  private read(key: string): Saved[] {
    const store = key === USER ? this.opts.user : this.opts.workspace;
    const saved = store.get<unknown[]>(key);
    return (Array.isArray(saved) ? saved : []).filter((s): s is Saved => isGrant(s) && (key !== COMMANDS || isRule(s))).slice(-MAX_PER_KEY);
  }

  private write(key: string, value: Saved[]): void {
    void (key === USER ? this.opts.user : this.opts.workspace).update(key, value);
    this.opts.onChange?.();
  }
}
