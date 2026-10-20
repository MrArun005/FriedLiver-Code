import { execFileSync, spawn } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { UPDATER_APP, UPDATER_INFO_PLIST, appBundleFor, checkForUpdate, downloadVerified, fetchSums, installScript, manualCheckMessage, pickInstaller, readInstallResult, releasePageFrom, resolveRealApp, sumFor, versionLabel, type Release } from './updateCheck';

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
export function startUpdateChecks(context: vscode.ExtensionContext): vscode.Disposable {
  const log = vscode.window.createOutputChannel('FriedLiver Updates', { log: true });
  const isApp = vscode.env.appName.startsWith('FriedLiver') && context.extensionMode === vscode.ExtensionMode.Production;
  const offered = new Set<string>();
  let running: Promise<unknown> | undefined;
  const check = (seen: Set<string>) =>
    (running ??= checkForUpdate({
      current: appVersion(),
      fetch: (input, init) => fetch(input, init),
      offered: seen,
      notify: (release) => void offer(release, log).catch((err: unknown) => log.error(`Update failed: ${String(err)}`)),
      log: (line) => log.info(line),
    }).finally(() => (running = undefined))) as ReturnType<typeof checkForUpdate>;
  const run = () => void (enabled() && check(offered));
  const subs: vscode.Disposable[] = [
    log,
    vscode.commands.registerCommand('friedliver.showVersion', async () => {
      const text = `FriedLiver ${versionLabel(product(), vscode.version)} (VS Code ${vscode.version}, ${channel()})`;
      if ((await vscode.window.showInformationMessage(text, 'Copy')) === 'Copy') await vscode.env.clipboard.writeText(text);
    }),
    vscode.commands.registerCommand('friedliver.checkForUpdates', async () => {
      if (!isApp) return void vscode.window.showInformationMessage('Updates for this editor come from the editor itself.');
      log.info('Manual update check');
      // A manual check offers again even a version already offered this launch.
      // Said with the build (a main build names its commit); compared by friedliverVersion alone (appVersion).
      const message = manualCheckMessage(await check(new Set()), versionLabel(product(), vscode.version));
      if (message) void vscode.window.showInformationMessage(message);
    }),
  ];
  if (isApp) {
    void reportLastInstall(log);
    const first = setTimeout(run, FIRST_CHECK_DELAY_MS);
    const again = setInterval(run, RECHECK_EVERY_MS);
    first.unref?.();
    again.unref?.();
    subs.push(new vscode.Disposable(() => (clearTimeout(first), clearInterval(again))));
  }
  return vscode.Disposable.from(...subs);
}

/** Outlives the install script's own folder, so the next launch can say how it went. */
const INSTALL_LOG = () => path.join(tmpdir(), 'friedliver-update.log');

async function reportLastInstall(log: vscode.LogOutputChannel): Promise<void> {
  let text: string;
  try {
    text = readFileSync(INSTALL_LOG(), 'utf8');
    renameSync(INSTALL_LOG(), `${INSTALL_LOG()}.last`); // Reported once.
  } catch {
    return;
  }
  log.info(`Last install log:\n${text}`);
  const result = readInstallResult(text);
  if (result?.ok) return void vscode.window.showInformationMessage(`Updated to FriedLiver ${result.detail}.`);
  const why = result?.detail || 'the install script did not finish';
  const choice = await vscode.window.showErrorMessage(`FriedLiver couldn't update itself (${why}). This version is unchanged; download the new one from its release page.`, 'Download manually', 'Show log');
  if (choice === 'Download manually') await vscode.env.openExternal(vscode.Uri.parse(releasePageFrom(text), true));
  if (choice === 'Show log') log.show();
}

function product(): { friedliverVersion?: unknown; friedliverBuild?: unknown; quality?: unknown } {
  try {
    return JSON.parse(readFileSync(path.join(vscode.env.appRoot, 'product.json'), 'utf8'));
  } catch {
    return {};
  }
}

function channel(): string {
  const q = product().quality;
  return typeof q === 'string' ? q : 'unknown channel';
}

/** The real .app behind the running one (see resolveRealApp), via plutil and Spotlight. */
function realApp(running: string): string | null {
  const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] });
  return resolveRealApp(running, {
    home: homedir(),
    bundleId: (app) => {
      try {
        return existsSync(app) ? run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(app, 'Contents/Info.plist')]).trim() || null : null;
      } catch {
        return null;
      }
    },
    mdfind: (id) => run('/usr/bin/mdfind', [`kMDItemCFBundleIdentifier == '${id.replace(/'/g, '')}'`]).split('\n').filter(Boolean),
  });
}

function enabled(): boolean {
  const config = vscode.workspace.getConfiguration();
  return config.get<string>('friedliver.update.mode', 'notify') !== 'off' && config.get<string>('update.mode') !== 'none';
}

/** This build's FriedLiver version, stamped into product.json by scripts/prepare.mjs; the editor's version otherwise. */
function appVersion(): string {
  const v = product().friedliverVersion;
  return typeof v === 'string' ? v : vscode.version;
}

const openPage = (release: Release) => vscode.env.openExternal(vscode.Uri.parse(release.url, true));

async function offer(release: Release, log: vscode.LogOutputChannel): Promise<void> {
  const choice = await vscode.window.showInformationMessage(`FriedLiver ${release.version} is available`, 'Install', 'Release notes', 'Later');
  if (choice === 'Release notes') return void (await openPage(release));
  if (choice !== 'Install') return;
  const asset = pickInstaller(release, process.platform, process.arch);
  const running = appBundleFor(vscode.env.appRoot);
  const app = running && realApp(running);
  log.info(`Install ${release.version}: asset ${asset?.name ?? 'none'}, running from ${running ?? '?'}, installing into ${app ?? 'none found'}`);
  if (!asset || !app) {
    if (running && !app) void vscode.window.showWarningMessage('FriedLiver could not find its app in Applications, so it opened the release page instead.');
    return void (await openPage(release));
  }

  const dir = mkdtempSync(path.join(tmpdir(), 'friedliver-update-'));
  const dmg = path.join(dir, 'FriedLiver.dmg');
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Downloading FriedLiver ${release.version}` },
      async (progress) => {
        const sha256 = sumFor(await fetchSums(fetch, release), asset.name);
        if (!sha256) throw new Error(`SHA256SUMS has no entry for ${asset.name}`);
        log.info(`Downloading ${asset.url} (${asset.size} bytes, sha256 ${sha256})`);
        let shown = 0;
        await downloadVerified(fetch, asset.url, dmg, { size: asset.size, sha256 }, (bytes) => {
          const pct = Math.floor((bytes / asset.size) * 100);
          if (pct > shown) progress.report({ increment: pct - shown, message: `${pct}%` });
          if (pct >= shown + 25) log.info(`Downloaded ${pct}%`);
          shown = Math.max(shown, pct);
        });
        log.info('Download verified');
      },
    );
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    log.error(`Update download failed: ${String(err)}`);
    const again = await vscode.window.showErrorMessage(`FriedLiver ${release.version} could not be installed: ${err instanceof Error ? err.message : String(err)}`, 'Release notes');
    if (again) await openPage(release);
    return;
  }

  if (!writable(app)) {
    // Can't replace the app in place (e.g. /Applications owned by another user): hand over the verified DMG.
    log.warn(`${app} is not writable; opening the DMG instead`);
    await vscode.env.openExternal(vscode.Uri.file(dmg));
    void vscode.window.showWarningMessage(`FriedLiver can't replace ${app} (no write access). The verified ${release.version} installer is open: drag FriedLiver into Applications to update.`);
    return;
  }
  const restart = await vscode.window.showInformationMessage(`FriedLiver ${release.version} is ready.`, 'Restart to update');
  if (restart !== 'Restart to update') return void rmSync(dir, { recursive: true, force: true }); // The next check offers it again.
  // Runs as its own background app (see UPDATER_INFO_PLIST) so quitting or force-quitting FriedLiver can't stop it.
  const updater = path.join(dir, UPDATER_APP);
  const script = path.join(updater, 'Contents/MacOS/install');
  mkdirSync(path.dirname(script), { recursive: true });
  writeFileSync(path.join(updater, 'Contents/Info.plist'), UPDATER_INFO_PLIST);
  // The extension host's parent is the app's main process (seen with ps in a packaged 1.142.0-9).
  writeFileSync(script, installScript({ pid: process.ppid, app, dmg, dir, log: INSTALL_LOG(), version: release.version, page: release.url }), { mode: 0o700 });
  try {
    execFileSync('/usr/bin/open', ['-n', '-g', '-j', updater], { timeout: 15_000, stdio: ['ignore', 'ignore', 'pipe'] });
    log.info(`Started ${updater} (log: ${INSTALL_LOG()})`);
  } catch (err) {
    // Still installs; only a Force Quit of FriedLiver during the install could stop it.
    log.warn(`open ${updater} failed (${(err as { stderr?: Buffer }).stderr?.toString().trim() || String(err)}); running the script directly`);
    spawn('/bin/sh', [script], { detached: true, stdio: 'ignore' }).unref();
  }
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
