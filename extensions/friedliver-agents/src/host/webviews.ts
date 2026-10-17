import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { parseWebviewMessage, type HostMessage, type WebviewMessage } from '../shared/messages';

export type Script = 'chat' | 'tasks' | 'images';

/** One webview showing agent state: the side view, the center chat, the task board or images. */
export interface Surface {
  readonly kind: Script;
  readonly webview: vscode.Webview;
  /** The side bar's chat list (a chat surface that shows only the list). */
  list?: boolean;
  /** The chat this surface shows; chat surfaces only. */
  selected?: string;
  ready: boolean;
  visible(): boolean;
  reveal(): void;
}

export function webviewOptions(extensionUri: vscode.Uri, imageRoots: readonly string[] = []): vscode.WebviewOptions {
  // The extension's media folder (styles, the bundled webview scripts), and the folders steps' images may come
  // from; the host still checks each image (previewableImage) before it hands the webview a URI.
  return { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media'), ...imageRoots.map((r) => vscode.Uri.file(r))] };
}

/** Strict CSP: nonce scripts, no remote content, images only from data: URIs and the extension. */
export function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, script: Script, title: string, list = false): string {
  const nonce = randomBytes(16).toString('base64');
  const chat = vscode.workspace.getConfiguration('friedliver.chat');
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
<title>${escapeHtml(title)}</title>
</head>
<body data-surface="${script}"${list ? ' data-view="list"' : ''} data-platform="${process.platform}" data-font="${escapeHtml(chat.get<string>('fontFamily', 'Inter'))}" data-accent="${escapeHtml(chat.get<string>('accentColor', '#D97757'))}" data-font-size="${escapeHtml(String(chat.get<number>('fontSize', 13)))}">
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
  imageRoots: readonly string[] = [],
): vscode.Disposable {
  surface.webview.options = webviewOptions(extensionUri, imageRoots);
  surface.webview.html = webviewHtml(surface.webview, extensionUri, surface.kind, title, surface.list);
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

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
