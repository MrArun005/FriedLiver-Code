import path from 'node:path';

/**
 * Resolves a path an agent or webview supplied, which must lie inside one of
 * `roots` (the workspace folders and task worktrees). Relative paths resolve
 * against the first root. Returns null when it falls outside all of them.
 * Ported from the app's `AppController.inside()`.
 */
export function insideRoots(file: unknown, roots: readonly string[], p: path.PlatformPath = path): string | null {
  if (typeof file !== 'string' || !file || file.includes('\0') || roots.length === 0) return null;
  const resolved = p.resolve(roots[0], file);
  const ok = roots.some((root) => {
    const rel = p.relative(p.resolve(root), resolved);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel));
  });
  return ok ? resolved : null;
}
