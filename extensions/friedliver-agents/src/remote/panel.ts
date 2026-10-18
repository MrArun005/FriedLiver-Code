// The pairing panel's page: the QR, how long its code lasts, the addresses,
// the paired phones. Built in the extension host; every value is escaped and
// the page runs only its own nonce script.
import type { Device } from './auth';
import { qrSvg } from './qr';

export interface PanelState {
  code?: string;
  expires?: number;
  /** Which address the QR shows. */
  via: 'lan' | 'tailscale';
  paired?: string;
}

export interface PairingView {
  nonce: string;
  state: PanelState;
  active: boolean;
  url?: string;
  /** The QR carries the certificate fingerprint for the phone to show (self-signed certificates). */
  pinned: boolean;
  fingerprint: string;
  lanUrl?: string;
  tailscaleUrl?: string;
  tailscaleAllowed: boolean;
  tailscaleFound: boolean;
  devices: Device[];
  connected: Set<string>;
  now?: number;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function since(at: number, now: number): string {
  const s = Math.round((now - at) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return new Date(at).toLocaleDateString();
}

/** The pairing link: the address, then the one-time code and the certificate fingerprint in the fragment (never sent to a server). */
export function pairingLink(url: string, code: string, fp: string | undefined): string {
  const f = fp ? `&f=${Buffer.from(fp.replace(/:/g, ''), 'hex').toString('base64url')}` : '';
  return `${url}#c=${code}${f}`;
}

/** The pairing panel: QR, code lifetime, addresses, paired devices. Every value in it is escaped; the QR is drawn here. */
export function pairingHtml(v: PairingView): string {
  const now = v.now ?? Date.now();
  const { code, expires, paired } = v.state;
  const link = v.url && code && v.active ? pairingLink(v.url, code, v.pinned ? v.fingerprint : undefined) : undefined;
  const fpShort = v.fingerprint.split(':').reduce((acc: string[], b, i) => ((i % 4 ? (acc[acc.length - 1] += b) : acc.push(b)), acc), []).join(' ');
  const qr = link
    ? `<div class="qr">${qrSvg(link, 240)}</div>
       <p class="sub">Scan with your phone’s camera. The code works once, for <span id="left" data-expires="${expires}">${Math.max(0, Math.ceil(((expires ?? now) - now) / 1000))}s</span>.</p>`
    : `<div class="qr qr--empty"><p>${paired ? `${esc(paired)} is paired.` : 'The code has expired.'}</p></div>
       <p class="sub">Show a new code to pair ${paired ? 'another' : 'a'} phone.</p>`;
  const devices = v.devices.length
    ? v.devices
        .map(
          (d) => `<li class="device">
        <span class="dot${v.connected.has(d.id) ? ' dot--on' : ''}" aria-hidden="true"></span>
        <span class="device__main"><span class="device__name">${esc(d.name)}</span>
        <span class="device__meta">${v.connected.has(d.id) ? 'Connected now' : `Last seen ${since(d.lastSeen, now)}`} · paired ${new Date(d.createdAt).toLocaleDateString()}</span></span>
        <button class="btn btn--quiet" data-revoke="${esc(d.id)}">Revoke</button>
      </li>`,
        )
        .join('')
    : '<li class="device device--none">No phones paired yet.</li>';
  const viaTabs =
    v.lanUrl && v.tailscaleUrl
      ? `<div class="seg" role="tablist">
          <button role="tab" aria-selected="${v.state.via === 'lan'}" class="seg__item${v.state.via === 'lan' ? ' seg__item--on' : ''}" data-via="lan">Same Wi-Fi</button>
          <button role="tab" aria-selected="${v.state.via === 'tailscale'}" class="seg__item${v.state.via === 'tailscale' ? ' seg__item--on' : ''}" data-via="tailscale">Tailscale</button>
        </div>`
      : '';
  const tailscaleLine = v.tailscaleAllowed
    ? v.tailscaleFound
      ? `Tailscale: ${esc(v.tailscaleUrl ?? '')}${v.pinned || v.state.via !== 'tailscale' ? '' : ' · trusted certificate'}`
      : 'Tailscale is allowed but not running or not logged in on this Mac.'
    : 'Tailscale is off.';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${v.nonce}'; script-src 'nonce-${v.nonce}'; img-src data:">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FriedLiver Remote</title>
<style nonce="${v.nonce}">
:root {
  --bg: var(--vscode-editor-background, #121314);
  --input-bg: var(--vscode-input-background, #191a1b);
  --menu-bg: var(--vscode-menu-background, #202122);
  --border: var(--vscode-inlineChatInput-border, var(--vscode-input-border, var(--vscode-widget-border, #2a2b2c)));
  --fg: var(--vscode-foreground, #bfbfbf);
  --fg-2: var(--vscode-descriptionForeground, #8c8c8c);
  --sel-fg: var(--vscode-list-activeSelectionForeground, #ededed);
  --sel-bg: var(--vscode-list-activeSelectionBackground, #3d3e3f);
  --hover-bg: var(--vscode-list-hoverBackground, #313233);
  --code-bg: var(--vscode-textCodeBlock-background, #242526);
  --btn-bg: var(--vscode-button-background, #297aa0);
  --btn-fg: var(--vscode-button-foreground, #ffffff);
  --error: var(--vscode-errorForeground, #f48771);
  --dot-on: #89d185;
  --font: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
  --mono: var(--vscode-editor-font-family, Menlo, monospace);
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 13px/1.5 var(--font); }
main { padding: 24px 32px; display: grid; grid-template-columns: minmax(260px, 320px) minmax(0, 1fr); gap: 16px 48px; align-items: start; }
h1 { grid-column: 1 / -1; margin: 0; font-size: 16px; font-weight: 600; color: var(--sel-fg); }
h2 { margin: 0 0 8px; font-size: 1em; font-weight: 600; color: var(--sel-fg); }
.lead { grid-column: 1 / -1; margin: -8px 0 0; color: var(--fg-2); max-width: none; }
.pair, .side { display: flex; flex-direction: column; gap: 12px; }
.qr { width: 272px; height: 272px; display: grid; place-items: center; background: #fff; border-radius: 8px; border: 1px solid var(--border); }
.qr svg { display: block; }
.qr--empty { background: var(--input-bg); color: var(--fg-2); text-align: center; padding: 24px; }
.sub { margin: 0; color: var(--fg-2); }
.row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.btn { font: inherit; border-radius: 4px; padding: 6px 12px; line-height: 1; border: 1px solid var(--border); background: transparent; color: var(--fg); cursor: pointer; }
.btn:hover { background: var(--hover-bg); }
.btn--primary { background: var(--btn-bg); border-color: var(--btn-bg); color: var(--btn-fg); }
.btn--primary:hover { background: var(--btn-bg); filter: brightness(1.1); }
.btn--quiet { padding: 4px 8px; }
.btn--danger { color: var(--error); }
.box { background: var(--menu-bg); border: 1px solid var(--border); border-radius: 8px; padding: 12px; }
.facts { margin: 0; display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 16px; }
.facts dt { color: var(--fg-2); }
.facts dd { margin: 0; font-family: var(--mono); font-size: 12px; overflow-wrap: anywhere; color: var(--sel-fg); }
.devices { list-style: none; margin: 0; padding: 0; }
.device { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-top: 1px solid var(--border); }
.device:first-child { border-top: 0; }
.device--none { color: var(--fg-2); }
.device__main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.device__name { color: var(--sel-fg); }
.device__meta { color: var(--fg-2); font-size: .85em; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: color-mix(in srgb, var(--fg-2) 40%, transparent); flex: none; }
.dot--on { background: var(--dot-on); }
.seg { display: inline-flex; gap: 2px; padding: 2px; border: 1px solid var(--border); border-radius: 6px; align-self: flex-start; }
.seg__item { font: inherit; border: 0; background: transparent; color: var(--fg-2); padding: 4px 10px; border-radius: 4px; cursor: pointer; }
.seg__item--on { background: var(--sel-bg); color: var(--sel-fg); }
.note { margin: 0; color: var(--fg-2); font-size: .85em; }
.row--top { margin-top: 8px; }
@media (max-width: 640px) { main { grid-template-columns: 1fr; padding: 16px; } }
</style></head>
<body><main>
<h1>FriedLiver Remote</h1>
<p class="lead">Control your agents from your phone. Paired phones can read chats, send messages and answer approvals; Auto and Always allow from a phone still ask here first.</p>
<section class="pair">
  ${viaTabs}
  ${qr}
  <div class="row"><button class="btn${link ? '' : ' btn--primary'}" id="new">New code</button><button class="btn btn--danger" id="stop">Stop Remote</button></div>
</section>
<section class="side">
  <div class="box">
    <h2>Connection</h2>
    <dl class="facts">
      <dt>Address</dt><dd>${esc(v.url ?? 'none')}</dd>
      <dt>Certificate</dt><dd>${v.pinned ? `SHA-256 ${esc(fpShort)}` : 'Trusted (tailscale cert)'}</dd>
    </dl>
    <p class="note">${v.pinned ? 'Your phone’s browser will warn about this self-signed certificate the first time. Its fingerprint must match the one above.' : ''}</p>
  </div>
  <div class="box">
    <h2>Paired phones</h2>
    <ul class="devices">${devices}</ul>
    ${v.devices.length ? '<div class="row row--top"><button class="btn btn--danger" id="revokeAll">Revoke all</button></div>' : ''}
  </div>
  <div class="box">
    <h2>From anywhere</h2>
    <p class="note">${tailscaleLine}</p>
    <div class="row row--top"><button class="btn" id="tailscale">${v.tailscaleAllowed ? 'Stop using Tailscale' : 'Allow over Tailscale'}</button></div>
  </div>
</section>
</main>
<script nonce="${v.nonce}">
const vscode = acquireVsCodeApi();
const send = (m) => vscode.postMessage(m);
for (const [id, type] of [['new', 'newCode'], ['stop', 'stop'], ['revokeAll', 'revokeAll'], ['tailscale', 'tailscale']]) document.getElementById(id)?.addEventListener('click', () => send({ type }));
for (const b of document.querySelectorAll('[data-revoke]')) b.addEventListener('click', () => send({ type: 'revoke', id: b.dataset.revoke }));
for (const b of document.querySelectorAll('[data-via]')) b.addEventListener('click', () => send({ type: 'via', via: b.dataset.via }));
const left = document.getElementById('left');
if (left) {
  const tick = () => {
    const s = Math.max(0, Math.ceil((Number(left.dataset.expires) - Date.now()) / 1000));
    left.textContent = s >= 60 ? Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') : s + 's';
    if (s > 0) setTimeout(tick, 500);
  };
  tick();
}
</script>
</body></html>`;
}
