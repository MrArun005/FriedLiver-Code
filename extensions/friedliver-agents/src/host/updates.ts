import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { checkForUpdate, type Release } from './updateCheck';

const FIRST_CHECK_DELAY_MS = 60_000;
const RECHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * FriedLiver has no update service, so without this people stay on old builds.
 * In the FriedLiver app only (not when this extension runs in VS Code or another
 * editor), once a week: ask GitHub for the latest release and, when it's newer
 * than this build, say so with a link to the download page. Nothing is sent
 * besides the request, and failures stay silent. `friedliver.updates.check`
 * (or `update.mode: none`) turns it off.
 */
export function startUpdateChecks(context: vscode.ExtensionContext, log: vscode.LogOutputChannel): vscode.Disposable {
  if (!vscode.env.appName.startsWith('FriedLiver') || context.extensionMode !== vscode.ExtensionMode.Production) return new vscode.Disposable(() => {});
  let running = false;
  const run = () => {
    if (running || !enabled()) return;
    running = true;
    void checkForUpdate({
      current: appVersion(),
      fetch: (input, init) => fetch(input, init),
      state: context.globalState,
      now: () => Date.now(),
      notify: (release) => void offer(release),
      log: (line) => log.debug(line),
    })
      .catch((err: unknown) => log.debug(`Update check failed: ${String(err)}`))
      .finally(() => (running = false));
  };
  const first = setTimeout(run, FIRST_CHECK_DELAY_MS);
  // Windows that stay open for weeks check too; checkForUpdate itself keeps it weekly.
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
  return config.get<boolean>('friedliver.updates.check', true) !== false && config.get<string>('update.mode') !== 'none';
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

async function offer(release: Release): Promise<void> {
  const open = await vscode.window.showInformationMessage(`FriedLiver ${release.version} is out. This is ${appVersion()}.`, 'Open download page');
  if (open) await vscode.env.openExternal(vscode.Uri.parse(release.url, true));
}
