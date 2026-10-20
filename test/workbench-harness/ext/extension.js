// Test-only extension loaded with --extensionDevelopmentPath by scripts/workbench-shots.mjs.
const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');

const file = (rel) => vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, rel);

exports.activate = (context) => {
  context.subscriptions.push(
    // A typical stack: an error, a progress toast and an info toast with two actions.
    vscode.commands.registerCommand('harness.toasts', () => {
      vscode.window.showErrorMessage('Could not reach the language server for src/format.ts.', 'Retry');
      vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Indexing workspace', cancellable: true }, () => new Promise(() => {}));
      vscode.window.showInformationMessage('FriedLiver 1.142.0-6 is available.', 'Install', 'Release notes');
    }),
    // A custom modal dialog (window.dialogStyle is custom in the harness profile).
    vscode.commands.registerCommand('harness.dialog', () =>
      vscode.window.showWarningMessage('Do you want to save the changes you made to format.ts?', { modal: true, detail: "Your changes will be lost if you don't save them." }, 'Save', "Don't Save")),
    // The diff editor: an older format.ts (outside the workspace) against the working one.
    vscode.commands.registerCommand('harness.diff', () => {
      const old = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'flwb-old-')), 'format.ts');
      fs.writeFileSync(old, '/** Formats an amount in cents as dollars. */\nexport function formatCents(cents: number): string {\n  return `$${cents / 100}`;\n}\n\nexport const ZERO = formatCents(0);\n');
      return vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(old), file('src/format.ts'), 'format.ts (older ↔ working)');
    }),
    // Peek: the definition of formatCents from its call in cart.ts.
    vscode.commands.registerCommand('harness.peek', async () => {
      const doc = await vscode.workspace.openTextDocument(file('src/cart.ts'));
      const editor = await vscode.window.showTextDocument(doc);
      const at = doc.positionAt(doc.getText().lastIndexOf('formatCents(') + 2);
      editor.selection = new vscode.Selection(at, at);
      return vscode.commands.executeCommand('editor.action.peekDefinition');
    }),
  );
};
