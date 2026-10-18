import { beforeAll, describe, expect, it } from 'vitest';
import { writePatchedFile } from './patchedFile';

// The module patch 0200 adds to VS Code: which shell variables the extension host may start with
// before the login shell has answered (friedliver.fastShellEnv). The cache on disk must never hold
// a secret; the running host then gets the full fresh environment in memory, as upstream gives it.
type Env = Record<string, string | undefined>;
type Changes = Record<string, string | null>;
let m: {
  SHELL_ENV_CACHE_KEY: string;
  isSafeShellEnvName(name: string): boolean;
  pickSafeShellEnv(env: Env): Record<string, string>;
  readShellEnvCache(get: (key: string) => string | undefined): Record<string, string> | undefined;
  writeShellEnvCache(store: (key: string, value: string) => void, env: Env): void;
  diffShellEnv(started: Env, fresh: Env): Changes;
  createShellEnvMessage(changes: Changes): Uint8Array;
  parseShellEnvMessage(message: Uint8Array): Changes | undefined;
  applyShellEnvChanges(env: Env, changes: Changes): void;
};

beforeAll(async () => {
  m = await import(writePatchedFile('0200-fast-shell-env.patch', 'src/vs/workbench/services/extensions/common/shellEnvCache.ts'));
});

const shell: Env = {
  PATH: '/Users/me/.nvm/versions/node/v24/bin:/opt/homebrew/bin:/usr/bin',
  LANG: 'en_GB.UTF-8',
  LC_ALL: 'en_GB.UTF-8',
  NVM_DIR: '/Users/me/.nvm',
  NVM_BIN: '/Users/me/.nvm/versions/node/v24/bin',
  PYENV_ROOT: '/Users/me/.pyenv',
  JAVA_HOME: '/Library/Java/Home',
  GOPATH: '/Users/me/go',
  CARGO_HOME: '/Users/me/.cargo',
  HOMEBREW_PREFIX: '/opt/homebrew',
  // never cached
  GITHUB_TOKEN: 'ghp_x',
  OPENAI_API_KEY: 'sk-x',
  AWS_SECRET_ACCESS_KEY: 'x',
  PGPASSWORD: 'x',
  NVM_AUTH_HEADER: 'Bearer x',
  HOMEBREW_GITHUB_API_TOKEN: 'x',
  CONDA_PRIVATE_KEY: 'x',
  SSH_AUTH_SOCK: '/tmp/agent',
  AWS_SESSION_TOKEN: 'x',
  NPM_CONFIG_PASSWORD: 'x',
  DATABASE_URL: 'postgres://u:p@h/db',
  HOME: '/Users/me',
  ELECTRON_RUN_AS_NODE: '1',
  VSCODE_PID: '1',
  SOMETHING_ELSE: 'x',
};

describe('safe-variable filter', () => {
  it('keeps the tool-path variables and nothing else', () => {
    expect(Object.keys(m.pickSafeShellEnv(shell)).sort()).toEqual([
      'CARGO_HOME', 'GOPATH', 'HOMEBREW_PREFIX', 'JAVA_HOME', 'LANG', 'LC_ALL', 'NVM_BIN', 'NVM_DIR', 'PATH', 'PYENV_ROOT',
    ]);
  });

  it('refuses secret-looking names even under an allowed prefix', () => {
    for (const name of ['NVM_AUTH_HEADER', 'HOMEBREW_GITHUB_API_TOKEN', 'CONDA_PRIVATE_KEY', 'PYENV_PASSWORD', 'LC_SECRET', 'XDG_SESSION_ID', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'PATH_TOKEN']) {
      expect(m.isSafeShellEnvName(name), name).toBe(false);
    }
  });

  it('ignores non-string values', () => {
    expect(m.pickSafeShellEnv({ PATH: undefined, LANG: null as unknown as string })).toEqual({});
  });
});

describe('cache read/write', () => {
  function storage() {
    const map = new Map<string, string>();
    return { map, get: (k: string) => map.get(k), store: (k: string, v: string) => void map.set(k, v) };
  }

  it('writes only safe variables and reads them back', () => {
    const s = storage();
    m.writeShellEnvCache(s.store, shell);
    const raw = s.map.get(m.SHELL_ENV_CACHE_KEY)!;
    for (const secret of ['ghp_x', 'sk-x', 'Bearer', 'postgres://']) expect(raw).not.toContain(secret);
    expect(m.readShellEnvCache(s.get)).toEqual(m.pickSafeShellEnv(shell));
  });

  it('writes nothing without a PATH', () => {
    const s = storage();
    m.writeShellEnvCache(s.store, { LANG: 'C' });
    expect(s.map.size).toBe(0);
  });

  it('reads no cache when there is none, it is garbage, or it has no PATH', () => {
    expect(m.readShellEnvCache(() => undefined)).toBeUndefined();
    expect(m.readShellEnvCache(() => '{not json')).toBeUndefined();
    expect(m.readShellEnvCache(() => '[1,2]')).toBeUndefined();
    expect(m.readShellEnvCache(() => '{"LANG":"C"}')).toBeUndefined();
  });

  it('filters a cache written by anything else (defense in depth)', () => {
    expect(m.readShellEnvCache(() => JSON.stringify({ PATH: '/bin', GITHUB_TOKEN: 'x', NVM_DIR: 1 }))).toEqual({ PATH: '/bin' });
  });
});

describe('updating the running extension host', () => {
  it('reports every changed, added and removed variable, secrets included (they stay in memory)', () => {
    const started = { HOME: '/Users/me', PATH: '/old', NVM_BIN: '/nvm/22', VIRTUAL_ENV: '/proj/.venv' };
    expect(m.diffShellEnv(started, { HOME: '/Users/me', PATH: '/new', NVM_BIN: '/nvm/22', JAVA_HOME: '/jdk', ANTHROPIC_API_KEY: 'sk' }))
      .toEqual({ PATH: '/new', JAVA_HOME: '/jdk', ANTHROPIC_API_KEY: 'sk', VIRTUAL_ENV: null });
    expect(m.diffShellEnv(started, { ...started })).toEqual({});
  });

  it('round-trips through the protocol message and applies to process.env', () => {
    const message = m.createShellEnvMessage({ PATH: '/new', VIRTUAL_ENV: null });
    const env: Env = { PATH: '/old', VIRTUAL_ENV: '/proj/.venv', OTHER: 'kept' };
    m.applyShellEnvChanges(env, m.parseShellEnvMessage(message)!);
    expect(env).toEqual({ PATH: '/new', OTHER: 'kept' });
  });

  it('leaves every other extension-host message alone', () => {
    expect(m.parseShellEnvMessage(new Uint8Array([3]))).toBeUndefined(); // Terminate
    expect(m.parseShellEnvMessage(new Uint8Array([1, 0, 0, 0, 7, 0xfe, 0x46]))).toBeUndefined(); // an RPC frame
    expect(m.parseShellEnvMessage(new TextEncoder().encode('{"commit":"x"}'))).toBeUndefined(); // init data
  });

  it('carries tokens the shell exports to the running host (agents need them), never to the cache', () => {
    const message = m.createShellEnvMessage({ PATH: '/p', GITHUB_TOKEN: 'x', BAD: 1 as unknown as string });
    expect(m.parseShellEnvMessage(message)).toEqual({ PATH: '/p', GITHUB_TOKEN: 'x' });
    const stored = new Map<string, string>();
    m.writeShellEnvCache((k, v) => void stored.set(k, v), { PATH: '/p', GITHUB_TOKEN: 'x' });
    expect(JSON.parse(stored.get(m.SHELL_ENV_CACHE_KEY)!)).toEqual({ PATH: '/p' });
  });
});
