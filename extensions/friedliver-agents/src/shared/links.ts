// Links you click inside FriedLiver: which open, and where. Pure, so the webviews, the host and the tests agree.

/** Longest link FriedLiver opens. */
export const LINK_MAX = 2048;

export type LinkMode = 'builtin' | 'external';

/** What a clicked href may open: a web page (http/https, no user:password), a local file, or nothing. */
export function linkTarget(href: string): { kind: 'web'; url: string } | { kind: 'file'; path: string } | null {
  if (!href || href.length > LINK_MAX) return null;
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (u.protocol === 'http:' || u.protocol === 'https:') return u.username || u.password ? null : { kind: 'web', url: u.href };
  if (u.protocol === 'file:' && !u.host) {
    try {
      return { kind: 'file', path: decodeURIComponent(u.pathname) };
    } catch {
      return null;
    }
  }
  return null;
}

/** Where a web link opens: the setting's choice, or the other one with Cmd/Ctrl held. */
export function linkDestination(mode: unknown, modifier: boolean): LinkMode {
  const base: LinkMode = mode === 'external' ? 'external' : 'builtin';
  return modifier ? (base === 'builtin' ? 'external' : 'builtin') : base;
}
