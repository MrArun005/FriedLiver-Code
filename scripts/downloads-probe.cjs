// What patch 0300 (browser downloads) relies on, checked in the Electron FriedLiver ships:
//   - a download paused in will-download goes no further until resume() (Chromium may already have put
//     its first network chunk on disk, which is why patch 0300 writes a waiting download to a staging
//     folder and moves it into place only when finished), and cancel() leaves no file;
//   - resume() finishes it byte for byte;
//   - a real click (sendInputEvent, the path native input takes) fires 'input-event' and gives the
//     download a user gesture; a page script's download without one has none; a blob a click handler
//     makes has one;
//   - the finished file carries the OS's downloaded-from-the-internet mark (com.apple.quarantine on
//     macOS, Zone.Identifier on Windows) once markFromInternet (copied below) has run.
// Also reports, without failing, what Chromium itself marks and whether CDP's Input clicks count as
// input and gestures (they do, which is why agent calls hold a token: DownloadAttribution).
//
//   npx electron@<upstream .npmrc target> scripts/downloads-probe.cjs
//
// build.yml runs it on macOS and Windows. Never on someone's desktop: the window stays hidden (and no
// Dock icon), but run it in CI. Exit code 1 when a check fails.
'use strict';
const { app, BrowserWindow } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SIZE = 4 * 1024 * 1024;
const CHUNK = 64 * 1024;
const BODY = crypto.randomBytes(SIZE);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-dl-probe-'));
// As in patch 0300: a waiting download is written to a staging folder, moved to the downloads folder when done.
const staging = path.join(root, 'pending');
const dir = path.join(root, 'downloads');
fs.mkdirSync(staging);
fs.mkdirSync(dir);
const results = [];
let failed = false;
function check(name, ok, detail = '') {
  results.push(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed = true;
}
const note = (name, detail) => results.push(`info ${name}: ${detail}`);

const PAGE = `<!doctype html><body style="margin:0">
<a id="file" href="/file.bin" download style="position:absolute;left:10px;top:10px;width:120px;height:40px;display:block">file</a>
<button id="blob" style="position:absolute;left:10px;top:80px;width:120px;height:40px">blob</button>
<a id="cdp" href="/cdp.bin" download style="position:absolute;left:10px;top:150px;width:120px;height:40px;display:block">cdp</a>
<script>
document.getElementById('blob').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['made by the page']));
  a.download = 'page.txt';
  a.click();
};
window.later = () => setTimeout(() => { const a = document.createElement('a'); a.href = '/script.bin'; a.download = ''; document.body.append(a); a.click(); }, 50);
</script></body>`;

// A slow body, so a pause is visible: 64 KB every 25 ms.
const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(PAGE);
  }
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': SIZE, 'content-disposition': `attachment; filename="${req.url.slice(1)}"` });
  let at = 0;
  const timer = setInterval(() => {
    if (res.destroyed || at >= SIZE) return clearInterval(timer), res.end();
    res.write(BODY.subarray(at, (at += CHUNK)));
  }, 25);
  res.on('close', () => clearInterval(timer));
});

function nextDownload(win) {
  return new Promise((resolve) => win.webContents.session.once('will-download', (_e, item) => {
    item.setSavePath(path.join(staging, item.getFilename()));
    item.pause(); // synchronously, as BrowserDownloadsMainService does
    const done = new Promise((r) => item.once('done', (_e2, state) => r(state)));
    resolve({ item, done });
  }));
}

async function click(win, selector) {
  const r = await win.webContents.executeJavaScript(`(() => { const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(b.left + 20), y: Math.round(b.top + 20) }; })()`);
  win.webContents.sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: r.x, y: r.y, button: 'left', clickCount: 1 });
  return r;
}

const run = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8' }).trim(); } catch { return undefined; } };
const quarantine = (file) => run('/usr/bin/xattr', ['-p', 'com.apple.quarantine', file]);
const zone = (file) => { try { return fs.readFileSync(`${file}:Zone.Identifier`, 'utf8'); } catch { return undefined; } };

// markFromInternet from browserDownloadsMainService.ts (patch 0300), kept in step by hand.
function markFromInternet(file, url) {
  if (process.platform === 'darwin') {
    if (quarantine(file) !== undefined) return;
    const value = `0081;${Math.floor(Date.now() / 1000).toString(16)};FriedLiver;${crypto.randomUUID().toUpperCase()}`;
    execFileSync('/usr/bin/xattr', ['-w', 'com.apple.quarantine', value, file]);
  } else if (process.platform === 'win32') {
    if (!fs.existsSync(`${file}:Zone.Identifier`)) fs.writeFileSync(`${file}:Zone.Identifier`, `[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=${url.startsWith('blob:') ? 'about:internet' : url}\r\n`);
  }
}

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  app.dock?.hide();
  const win = new BrowserWindow({ width: 400, height: 300, show: false, paintWhenInitiallyHidden: true, webPreferences: { partition: 'fl-dl-probe', sandbox: true, contextIsolation: true } });
  const inputs = [];
  win.webContents.on('input-event', (_e, input) => inputs.push(input.type));
  await win.loadURL(`${origin}/`);
  note('electron', process.versions.electron);

  // 1. A real click: input-event, a user gesture, paused writes nothing, resume finishes it.
  let next = nextDownload(win);
  await click(win, '#file');
  let { item, done } = await next;
  check('a click fires input-event (mouseDown)', inputs.includes('mouseDown'), inputs.join(','));
  check('a clicked link download has a user gesture', item.hasUserGesture() === true);
  check('paused in will-download', item.isPaused() === true);
  await sleep(800);
  const onDisk = () => (fs.existsSync(item.getSavePath()) ? fs.statSync(item.getSavePath()).size : 0);
  const r1 = item.getReceivedBytes();
  const d1 = onDisk();
  await sleep(1200);
  const r2 = item.getReceivedBytes();
  const d2 = onDisk();
  check('nothing more arrives while paused', r2 === r1 && r2 < SIZE, `${r1} → ${r2} of ${SIZE}`);
  // Chromium may already have buffered some bytes to the staged file (64 KB on macOS, ~450 KB on Windows).
  check('the staged file stops growing while paused', d2 === d1 && d2 < SIZE, `${d1} → ${d2} bytes staged`);
  check('nothing reaches the downloads folder while waiting', fs.readdirSync(dir).length === 0, fs.readdirSync(dir).join(', '));
  item.resume();
  const state1 = await done;
  const file1 = path.join(dir, path.basename(item.getSavePath()));
  if (state1 === 'completed') fs.renameSync(item.getSavePath(), file1);
  check('resume() finishes the download', state1 === 'completed', state1);
  check('the file is byte for byte the body', state1 === 'completed' && sha256(fs.readFileSync(file1)) === sha256(BODY));
  if (process.platform === 'darwin') note('Chromium set com.apple.quarantine', quarantine(file1) ?? 'no');
  if (process.platform === 'win32') note('Chromium wrote Zone.Identifier', zone(file1)?.replace(/\r?\n/g, ' ') ?? 'no');
  markFromInternet(file1, `${origin}/file.bin`);
  if (process.platform === 'darwin') check('macOS quarantine mark present', !!quarantine(file1), quarantine(file1));
  if (process.platform === 'win32') check('Windows Mark of the Web present (ZoneId=3)', /ZoneId=3/.test(zone(file1) ?? ''), zone(file1)?.replace(/\r?\n/g, ' '));

  // 2. A page script's download, no gesture; cancelled while paused leaves nothing. A fresh document
  // first: a click's user activation lasts seconds (the web's transient activation).
  await win.loadURL(`${origin}/`);
  inputs.length = 0;
  next = nextDownload(win);
  await win.webContents.executeJavaScript('window.later()');
  ({ item, done } = await next);
  check('a script download has no user gesture', item.hasUserGesture() === false);
  check('a script download comes with no click or key input', !inputs.some((t) => /Down$|Up$/.test(t)), inputs.join(',') || 'none');
  await sleep(500);
  item.cancel();
  check('cancel() while paused ends it cancelled', (await done) === 'cancelled');
  await sleep(500);
  const left = [...fs.readdirSync(staging), ...fs.readdirSync(dir)].filter((f) => f.startsWith('script.bin') || f.endsWith('.crdownload'));
  check('a cancelled download leaves no file', left.length === 0, left.join(', '));

  // 3. A blob a click handler makes: blob: URL with a user gesture.
  next = nextDownload(win);
  await click(win, '#blob');
  ({ item, done } = await next);
  check('a click-made blob download has a user gesture', item.hasUserGesture() === true, item.getURL().slice(0, 40));
  check('its URL is blob:http', item.getURL().startsWith(`blob:${origin}/`));
  item.resume();
  check('the blob download completes', (await done) === 'completed');

  // 4. CDP's click (what browser_click sends): reported only.
  inputs.length = 0;
  const dbg = win.webContents.debugger;
  dbg.attach('1.3');
  const at = await win.webContents.executeJavaScript(`(() => { const b = document.querySelector('#cdp').getBoundingClientRect(); return { x: b.left + 20, y: b.top + 20 }; })()`);
  next = nextDownload(win);
  for (const type of ['mousePressed', 'mouseReleased']) await dbg.sendCommand('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
  ({ item, done } = await next);
  note('CDP click fires input-event', inputs.length ? inputs.join(',') : 'no');
  note('CDP click download has a user gesture', String(item.hasUserGesture()));
  item.cancel();
  await done;
  dbg.detach();
}

app.whenReady().then(main).catch((err) => {
  failed = true;
  results.push(`FAIL ${err && err.stack || err}`);
}).finally(() => {
  console.log(`downloads probe on ${process.platform}-${process.arch}\n${results.join('\n')}`);
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
  app.exit(failed ? 1 : 0);
});
