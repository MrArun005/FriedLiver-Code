import fs from 'node:fs';
import path from 'node:path';

/**
 * Resolves a path an agent or webview supplied, which must lie inside one of
 * `roots` (the workspace folders and task worktrees). Relative paths resolve
 * against the first root. Returns null when it falls outside all of them.
 * Ported from the app's `AppController.inside()`.
 *
 * Being inside by name is not enough: a symlink in the workspace (a cloned
 * repository's `keys -> ~/.ssh`) leads somewhere else. So the real location
 * is checked too, with every symlink resolved: the file's own when it exists,
 * otherwise its nearest existing folder's, following dangling links to where
 * a write would land. The returned path is the one asked for (not the real
 * one), so it matches open editors and the review, except that a path named
 * under a root's real name comes back under the root as given; callers check
 * again right before they write, in case a link appeared since.
 *
 * `p` other than the native `path` checks names only (tests of Windows rules on Linux).
 */
export function insideRoots(file: unknown, roots: readonly string[], p: path.PlatformPath = path): string | null {
  if (typeof file !== 'string' || !file || file.includes('\0') || roots.length === 0) return null;
  let resolved = p.resolve(roots[0], file);
  if (!roots.some((root) => contains(p, p.resolve(root), resolved))) {
    // A root opened by another name (C:\Users\RUNNER~1\… on Windows, or a link) still holds the paths git and
    // agents report under its real one. Such a path is given back under the root as given, so every later
    // check by name (inGitFolder, per-root rules) sees one spelling. The real-path check below still decides.
    if (p !== path) return null;
    const alias = roots.map((r) => [path.resolve(r), realPath(path.resolve(r))] as const).find(([, real]) => real !== null && contains(p, real, resolved));
    if (!alias) return null;
    resolved = path.join(alias[0], path.relative(alias[1]!, resolved));
  }
  if (p !== path) return resolved;
  const real = realPath(resolved);
  if (real === null) return null;
  return roots.some((root) => {
    const realRoot = realPath(path.resolve(root));
    return realRoot !== null && contains(path, realRoot, real);
  })
    ? resolved
    : null;
}

/**
 * Whether `file` (already inside `roots`) is in a repository's `.git` folder, or is a
 * worktree's `.git` file. Agents may read there but not write: git config and hooks
 * run programs, and nothing there shows up in a diff or a commit.
 */
export function inGitFolder(file: string, roots: readonly string[], p: path.PlatformPath = path): boolean {
  const named = (f: string, rs: readonly string[]) =>
    rs.some((root) => {
      const base = p.resolve(root);
      return contains(p, base, f) && p.relative(base, f).split(/[\\/]/).some((part) => part.toLowerCase() === '.git');
    });
  if (named(file, roots)) return true;
  if (p !== path) return false;
  // Also where it really is, against the roots as they really are: a link into .git, or a root opened by
  // another name. Fails closed: a path that can't be resolved counts as in .git.
  const real = realPath(file);
  return real === null || named(real, roots.map((r) => realPath(path.resolve(r)) ?? path.resolve(r)));
}

function contains(p: path.PlatformPath, root: string, file: string): boolean {
  const rel = p.relative(root, file);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel));
}

const MAX_LINKS = 40;

/**
 * Where `file` really is, with every symlink resolved, also when the file (or
 * the folders above it) don't exist yet: then the nearest existing folder is
 * resolved and the missing names are added back. A dangling link is followed
 * to its target, since writing through it would create the target. Null when
 * that can't be told (a link loop, no permission): callers then refuse.
 */
export function realPath(file: string): string | null {
  let current = path.resolve(file);
  const missing: string[] = [];
  for (let links = 0; links <= MAX_LINKS; ) {
    const real = realpathOrMissing(current);
    if (real === null) return null;
    if (real !== MISSING) return missing.length ? path.join(real, ...missing) : real;
    let target: string | undefined;
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) target = fs.readlinkSync(current);
    } catch (err) {
      if (!isMissing(err)) return null;
    }
    if (target !== undefined) {
      current = path.resolve(path.dirname(current), target);
      links++;
      continue;
    }
    const parent = path.dirname(current);
    if (parent === current) return missing.length ? path.join(current, ...missing) : current;
    missing.unshift(path.basename(current));
    current = parent;
  }
  return null;
}

const MISSING = Symbol('missing');

function realpathOrMissing(file: string): string | null | typeof MISSING {
  try {
    return fs.realpathSync.native(file);
  } catch (err) {
    if (isMissing(err)) return MISSING;
  }
  // The native call fails on some Windows file systems (RAM disks, some network shares).
  try {
    return fs.realpathSync(file);
  } catch (err) {
    return isMissing(err) ? MISSING : null;
  }
}

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * A path a request names (a command's folder, a file it reads), relative ones resolved against the
 * chat's folder, with every symlink followed: the real path when it is inside `roots`, else null.
 * Fails closed: a relative path with no folder to resolve it against, or one that doesn't resolve, is null.
 */
export function workspacePath(file: string | undefined, base: string | undefined, roots: readonly string[]): string | null {
  if (!file || file.includes('\0')) return null;
  if (!path.isAbsolute(file) && !(base && path.isAbsolute(base))) return null;
  const real = realPath(path.isAbsolute(file) ? file : path.resolve(base!, file));
  return real !== null && insideRoots(real, roots) !== null ? real : null;
}
