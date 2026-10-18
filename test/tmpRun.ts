import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Vitest globalSetup: every temp folder a run makes (tests, helpers and the code under test,
 * fl-*, flx-*, flb-*) lands in one fresh folder that is removed when the run ends, so a run
 * leaves nothing in the system temp folder. TMPDIR is a realpath, so /var vs /private/var
 * never splits one folder into two paths on macOS.
 */
export default function setup(): () => void {
  const run = mkdtempSync(path.join(realpathSync(os.tmpdir()), 'flrun-'));
  // Forks inherit these; os.tmpdir() reads TMPDIR (TEMP/TMP on Windows) on every call.
  process.env.TMPDIR = process.env.TEMP = process.env.TMP = run;
  return () => rmSync(run, { recursive: true, force: true });
}
