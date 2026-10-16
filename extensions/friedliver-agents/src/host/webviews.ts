import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { parseWebviewMessage, type HostMessage, type WebviewMessage } from '../shared/messages';

export type Script = 'chat' | 'tasks' | 'images';

/** One webview showing agent state: the side view, the center chat, the task board or images. */
export interface Surface {
  readonly kind: Script;
  readonly webview: vscode.Webview;
  /** The chat this surface shows; chat surfaces only. */
  selected?: string;
  ready: boolean;
  visible(): boolean;
  reveal(): void;
}

export function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
  // Only the extension's media folder: styles and the bundled webview scripts.
  return { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')] };
}

/** Strict CSP: nonce scripts, no remote content, images only from data: URIs and the extension. */
export function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, script: Script, title: string): string {
  const nonce = randomBytes(16).toString('base64');
  const media = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', file)).toString();
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${media('webview.css')}">
<title>${title}</title>
</head>
<body data-surface="${script}">
<div id="root"></div>
<script nonce="${nonce}" src="${media(`dist/${script}.js`)}"></script>
</body>
</html>`;
}

/** Wires a webview to the controller: validated messages in, state out. */
export function attachSurface(
  surface: Surface,
  extensionUri: vscode.Uri,
  title: string,
  onMessage: (surface: Surface, message: WebviewMessage) => void,
  log: (line: string) => void,
): vscode.Disposable {
  surface.webview.options = webviewOptions(extensionUri);
  surface.webview.html = webviewHtml(surface.webview, extensionUri, surface.kind, title);
  return surface.webview.onDidReceiveMessage((raw: unknown) => {
    const message = parseWebviewMessage(raw);
    if (!message) {
      log(`Ignored a malformed message from the ${surface.kind} view.`);
      return;
    }
    onMessage(surface, message);
  });
}

export function post(surface: Surface, message: HostMessage): void {
  if (surface.ready) void surface.webview.postMessage(message).then(undefined, () => {});
}
