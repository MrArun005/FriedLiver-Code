// Test-only extension loaded with --extensionDevelopmentPath by scripts/workbench-shots.mjs.
const vscode = require('vscode');

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
  );
};
