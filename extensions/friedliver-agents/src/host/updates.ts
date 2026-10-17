import { spawn } from 'node:child_process';
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { appBundleFor, checkForUpdate, downloadVerified, fetchSums, installScript, pickInstaller, sumFor, type Release } from './updateCheck';

const FIRST_CHECK_DELAY_MS = 30_000;
const RECHECK_EVERY_MS = 4 * 60 * 60 * 1000;

/**
 * FriedLiver has no update service, so this is it. In the FriedLiver app only (not when
 * this extension runs in VS Code or another editor): 30 s after start and every 4 h, ask
 * GitHub for the latest release; when it's newer than this build, a toast offers
 * Install / Release notes / Later. Each version is offered once per launch. Install
 * downloads and verifies the DMG on Apple silicon, then restarts into it; elsewhere it
 * opens the release page. `friedliver.update.mode: off` (or `update.mode: none`) turns it off.
 */
export function startUpdateChecks(context: vscode.ExtensionContext, log: vscode.LogOutputChannel): vscode.Disposable {
  if (!vscode.env.appName.startsWith('FriedLiver') || context.extensionMode !== vscode.ExtensionMode.Production) return new vscode.Disposable(() => {});
  const offered = new Set<string>();
  let running = false;
  const run = () => {
    if (running || !enabled()) return;
    running = true;
    void checkForUpdate({
      current: appVersion(),
      fetch: (input, init) => fetch(input, init),
      offered,
      notify: (release) => void offer(release, log).catch((err: unknown) => log.warn(`Update failed: ${String(err)}`)),
      log: (line) => log.debug(line),
    }).finally(() => (running = false));
  };
  const first = setTimeout(run, FIRST_CHECK_DELAY_MS);
  const again = setInterval(run, RECHECK_EVERY_MS);
  first.unref?.();
  again.unref?.();
  return new vscode.Disposable(() => {
    clearTimeout(first);
    clearInterval(again);
  });
}

function enabled(): boolean {
  const config = vscode.workspace.getConfiguration();
  return config.get<string>('friedliver.update.mode', 'notify') !== 'off' && config.get<string>('update.mode') !== 'none';
}

/** This build's FriedLiver version, stamped into product.json by scripts/prepare.mjs; the editor's version otherwise. */
function appVersion(): string {
  try {
    const product = JSON.parse(readFileSync(path.join(vscode.env.appRoot, 'product.json'), 'utf8')) as { friedliverVersion?: unknown };
    if (typeof product.friedliverVersion === 'string') return product.friedliverVersion;
  } catch {
    // Not readable: fall back to the editor's version.
  }
  return vscode.version;
}

const openPage = (release: Release) => vscode.env.openExternal(vscode.Uri.parse(release.url, true));

async function offer(release: Release, log: vscode.LogOutputChannel): Promise<void> {
  const choice = await vscode.window.showInformationMessage(`FriedLiver ${release.version} is available`, 'Install', 'Release notes', 'Later');
  if (choice === 'Release notes') return void (await openPage(release));
  if (choice !== 'Install') return;
  const asset = pickInstaller(release, process.platform, process.arch);
  const app = appBundleFor(vscode.env.appRoot);
  if (!asset || !app) return void (await openPage(release));

  const dir = mkdtempSync(path.join(tmpdir(), 'friedliver-update-'));
  const dmg = path.join(dir, 'FriedLiver.dmg');
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Downloading FriedLiver ${release.version}` },
      async (progress) => {
        const sha256 = sumFor(await fetchSums(fetch, release), asset.name);
        if (!sha256) throw new Error(`SHA256SUMS has no entry for ${asset.name}`);
        let shown = 0;
        await downloadVerified(fetch, asset.url, dmg, { size: asset.size, sha256 }, (bytes) => {
          const pct = Math.floor((bytes / asset.size) * 100);
          if (pct > shown) progress.report({ increment: pct - shown, message: `${pct}%` });
          shown = Math.max(shown, pct);
        });
      },
    );
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    log.warn(`Update download failed: ${String(err)}`);
    const again = await vscode.window.showErrorMessage(`FriedLiver ${release.version} could not be installed: ${err instanceof Error ? err.message : String(err)}`, 'Release notes');
    if (again) await openPage(release);
    return;
  }

  if (!writable(app)) {
    // Can't replace the app in place (e.g. /Applications owned by another user): hand over the verified DMG.
    log.info(`${app} is not writable; opening the DMG instead`);
    await vscode.env.openExternal(vscode.Uri.file(dmg));
    return;
  }
  const restart = await vscode.window.showInformationMessage(`FriedLiver ${release.version} is ready.`, 'Restart to update');
  if (restart !== 'Restart to update') return; // The verified DMG stays in the temp folder; next launch offers it again.
  const script = path.join(dir, 'install.sh');
  // ponytail: the extension host's parent is the app's main process (Electron utilityProcess); unverified in a packaged build.
  writeFileSync(script, installScript({ pid: process.ppid, app, dmg, dir }), { mode: 0o700 });
  spawn('/bin/sh', [script], { detached: true, stdio: 'ignore' }).unref();
  await vscode.commands.executeCommand('workbench.action.quit');
}

function writable(app: string): boolean {
  try {
    accessSync(app, constants.W_OK);
    accessSync(path.dirname(app), constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
