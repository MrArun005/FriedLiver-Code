// Test-only extension loaded with --extensionDevelopmentPath by scripts/workbench-shots.mjs.
const vscode = require('vscode');
const http = require('node:http');
const { setTimeout: sleep } = require('node:timers/promises');

const MB = 1024 * 1024;
// The page's downloads: name, size the server announces, and how it sends them.
const FILES = {
  'quarterly-report.pdf': { size: 2.4 * MB, mode: 'all' },
  'dataset-2026.zip': { size: 180 * MB, mode: 'slow' },
  'broken-archive.tar.gz': { size: 48 * MB, mode: 'break' },
  'setup.dmg': { size: 84 * MB, mode: 'slow' },
};
const PAGE = `<!doctype html><title>Releases</title><body style="font:14px system-ui;padding:24px"><h1>Releases</h1><script>
let i = 0;
for (const name of ${JSON.stringify(Object.keys(FILES))}) setTimeout(() => { const a = document.createElement('a'); a.href = '/' + name; a.download = name; document.body.append(a); a.click(); }, 400 * ++i);
</script>`;

function serve(req, res) {
  const name = decodeURIComponent(req.url.slice(1));
  const f = FILES[name];
  if (!f) {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(PAGE);
  }
  const size = Math.round(f.size);
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': size });
  if (f.mode === 'all') return res.end(Buffer.alloc(size, 7));
  let sent = 0;
  const timer = setInterval(() => {
    if (res.destroyed) return clearInterval(timer);
    if (f.mode === 'break' && sent >= MB) return clearInterval(timer), res.destroy();
    res.write(Buffer.alloc(256 * 1024, 7));
    sent += 256 * 1024;
  }, 250);
  res.on('close', () => clearInterval(timer));
}

exports.activate = (context) => {
  context.subscriptions.push(
    // A typical stack: an error, a progress toast and an info toast with two actions.
    vscode.commands.registerCommand('harness.toasts', () => {
      vscode.window.showErrorMessage('Could not reach the language server for src/format.ts.', 'Retry');
      vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Indexing workspace', cancellable: true }, () => new Promise(() => {}));
      vscode.window.showInformationMessage('FriedLiver 1.142.0-6 is available.', 'Install', 'Release notes');
    }),
    // Downloads in the integrated browser (patch 0300): a page starts four downloads without a click,
    // so each waits for an OK; the harness allows three (one finishes, one keeps going, one breaks)
    // and leaves the installer waiting, with its toast.
    vscode.commands.registerCommand('harness.downloads', async () => {
      const server = http.createServer(serve);
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      context.subscriptions.push({ dispose: () => server.close() });
      await vscode.window.openBrowserTab(`http://127.0.0.1:${server.address().port}/`);
      const run = (command, ...args) => vscode.commands.executeCommand(`_friedliver.browser.downloads.${command}`, ...args);
      const allow = new Set(['quarterly-report.pdf', 'dataset-2026.zip', 'broken-archive.tar.gz']);
      for (let i = 0; i < 60 && allow.size; i++) {
        for (const d of await run('list')) {
          if (d.state === 'awaiting' && allow.delete(d.filename)) await run('approve', d.id, true);
        }
        await sleep(250);
      }
    }),
    // A custom modal dialog (window.dialogStyle is custom in the harness profile).
    vscode.commands.registerCommand('harness.dialog', () =>
      vscode.window.showWarningMessage('Do you want to save the changes you made to format.ts?', { modal: true, detail: "Your changes will be lost if you don't save them." }, 'Save', "Don't Save")),
  );
};
