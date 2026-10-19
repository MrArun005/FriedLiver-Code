import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BridgeServer } from '../src/host/bridge';
import { gitRepo, memoryPermissions, tmpDir } from './helpers';

// Run on its own (FL_LEAK_FIXTURE=1): leaks every kind of temp folder a suite makes, on purpose.
describe.runIf(process.env.FL_LEAK_FIXTURE)('leaky fixture', () => {
  it('makes fl-*, flx-* and flb-* folders and never removes them', async () => {
    tmpDir('fl-x-');
    memoryPermissions();
    await gitRepo();
    await mkdtemp(path.join(os.tmpdir(), 'flx-'));
    await BridgeServer.start(() => Promise.resolve(undefined as never)); // never disposed
  });
});

describe.skipIf(process.env.FL_LEAK_FIXTURE)('temp folders', () => {
  it('a suite run leaves no fl-*, flx-* or flb-* folders behind', () => {
    // Short, so the bridge's socket fits under it and it never falls back to /tmp.
    const tmp = realpathSync(mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'flk-')));
    try {
      execFileSync(process.execPath, [path.resolve(__dirname, '../node_modules/vitest/vitest.mjs'), 'run', 'test/tmpLeak.test.ts'], {
        cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp, FL_LEAK_FIXTURE: '1' },
        stdio: 'pipe',
      });
      expect(readdirSync(tmp).filter((n) => /^(fl-|flx|flb)/.test(n))).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});
