import type * as acp from '@agentclientprotocol/sdk';
import type { SignInMethod } from '../../shared/ipc';

/** The only places `openExternal` and sign-in links may go: vendor sign-in, key and docs pages. */
export const EXTERNAL_HOSTS = [
  'accounts.google.com',
  'aistudio.google.com',
  'auth.openai.com',
  'chatgpt.com',
  'platform.openai.com',
  'claude.ai',
  'anthropic.com',
  'console.anthropic.com',
  'github.com',
  'git-scm.com',
  'nodejs.org',
  'agentclientprotocol.com',
];

export function allowedExternal(raw: string, hosts: readonly string[] = EXTERNAL_HOSTS): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password && hosts.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/**
 * Where each agent's own sign-in page may be. A link an agent prints while
 * signing in is only offered when it goes to that vendor, so an agent can't
 * send you to another site (or another vendor's login) dressed up as its sign-in.
 */
export const SIGN_IN_HOSTS: Record<string, readonly string[]> = {
  claude: ['claude.ai', 'claude.com', 'anthropic.com'],
  codex: ['auth.openai.com', 'chatgpt.com', 'platform.openai.com'],
  gemini: ['accounts.google.com', 'aistudio.google.com'],
  // The demo agent prints a Google-style link in its browser sign-in.
  demo: ['accounts.google.com'],
};

export function allowedSignInUrl(agentId: string, raw: string): boolean {
  const hosts = SIGN_IN_HOSTS[agentId];
  return hosts !== undefined && allowedExternal(raw, hosts);
}

/** ACP auth methods, sorted the way a person would want to use them. */
export function signInMethods(methods: acp.AuthMethod[]): SignInMethod[] {
  return methods
    .map((m): SignInMethod => {
      // Codex sends `env_var` methods, which this SDK version doesn't type yet.
      const type = 'type' in m ? (m.type as string) : undefined;
      const looksLikeKey = type === 'env_var' || /api.?key|vertex|gateway/i.test(`${m.id} ${m.name}`);
      return {
        id: m.id,
        name: m.name,
        description: m.description ?? undefined,
        kind: type === 'terminal' ? 'terminal' : looksLikeKey ? 'key' : 'browser',
      };
    })
    .sort((a, b) => Number(a.kind === 'key') - Number(b.kind === 'key'));
}
