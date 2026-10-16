// Runs src/test/suite.ts inside a real editor with this extension loaded.
// FRIEDLIVER_CODE points at an editor build (the FriedLiver fork, or stock
// VS Code); without it, @vscode/test-electron downloads stock VS Code.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runTests } from '@vscode/test-electron';

const FORK_BUILD = '/home/user/build/VSCode-linux-x64/bin/code-oss';

async function gitRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fl-workspace-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'FriedLiver test');
  await writeFile(path.join(dir, 'README.md'), '# Demo workspace\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return dir;
}

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '../..');
  const workspace = await gitRepo();
  const userData = await mkdtemp(path.join(os.tmpdir(), 'fl-userdata-'));
  await mkdir(path.join(userData, 'User'), { recursive: true });
  // A calm, predictable window for screenshots.
  await writeFile(
    path.join(userData, 'User', 'settings.json'),
    JSON.stringify({
      'workbench.startupEditor': 'none',
      'workbench.tips.enabled': false,
      'window.restoreWindows': 'none',
      'security.workspace.trust.enabled': false,
      'update.mode': 'none',
      'telemetry.telemetryLevel': 'off',
      'extensions.autoUpdate': false,
      'chat.disableAIFeatures': true,
      'workbench.secondarySideBar.defaultVisibility': 'visible',
    }),
  );
  const fromEnv = process.env.FRIEDLIVER_CODE;
  const vscodeExecutablePath = fromEnv || (existsSync(FORK_BUILD) ? FORK_BUILD : undefined);
  await runTests({
    version: process.env.FRIEDLIVER_CODE_VERSION,
    vscodeExecutablePath,
    extensionDevelopmentPath,
    extensionTestsPath: path.resolve(__dirname, 'suite.js'),
    // Stock builds gate the secondary side bar contribution behind a proposal; the fork allows it for built-ins.
    launchArgs: [workspace, '--enable-proposed-api=friedliver.friedliver-agents', '--no-sandbox', '--disable-gpu', '--disable-extensions', '--skip-welcome', '--skip-release-notes', `--user-data-dir=${userData}`],
    extensionTestsEnv: {
      FRIEDLIVER_SCREENSHOTS: process.env.FRIEDLIVER_SCREENSHOTS ?? path.join(extensionDevelopmentPath, 'screenshots'),
      FRIEDLIVER_WORKSPACE: workspace,
    },
  });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
