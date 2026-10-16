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

export function allowedExternal(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && EXTERNAL_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`));
  } catch {
    return false;
  }
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
