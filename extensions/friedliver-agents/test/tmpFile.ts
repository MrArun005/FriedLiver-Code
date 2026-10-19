import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

/**
 * Vitest setupFiles: each test file gets its own temp folder (inside the run's, ../../test/tmpRun.ts), and
 * every folder it, its helpers and the code under test made there (fl-conn-*, fl-bridge-*, flx-*, task
 * worktrees…) goes when the file ends, not only when the whole run does: a run stays small while it
 * runs, and one that is stopped part way leaves only the files still running. Short, so the tools'
 * socket path still fits under it.
 */
const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flf-')));
process.env.TMPDIR = process.env.TEMP = process.env.TMP = dir;
// A file whose tests are all skipped runs no hooks; its (empty) folder goes with the run's.
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
