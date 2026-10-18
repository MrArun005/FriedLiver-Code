// Level 1 system control (docs/SYSTEM-CONTROL.md): the fixed OS actions behind the system_* tools,
// on macOS and Windows. Every program runs from a fixed absolute path with an argv array (never a
// shell, never a PATH lookup), and scripts are fixed text: an agent's strings reach osascript only as
// JSON in one environment variable, and PowerShell only as base64 JSON on stdin, so no quote, `$()`,
// `;`, backtick or newline in them can become code. No vscode here, so all of it is tested with a
// mocked runner (bridgeRequests.ts asks the user before anything here acts).
import { spawn } from 'node:child_process';
import { chmod, mkdir, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { SystemCall } from '../bridge/protocol';
import { siteOrigin } from '../shared/permissions';
import { SYSTEM_LIMITS, SYSTEM_TOOLS, type SystemTool } from '../shared/system';
import { checkBrowserUrl, screenshotFile } from './browserRules';
import { isSensitive } from './permissions';
import { userSetting, type InspectedSetting } from './settings';

export type Platform = 'mac' | 'win';

export function systemPlatform(p: NodeJS.Platform = process.platform): Platform | null {
  return p === 'darwin' ? 'mac' : p === 'win32' ? 'win' : null;
}

export interface Exec {
  file: string;
  args: string[];
  /** Written to stdin, then closed. */
  input?: string;
  /** Added to the fixed environment the runner starts from. */
  env?: Record<string, string>;
  timeoutMs?: number;
}
export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}
export type Runner = (exec: Exec, signal: AbortSignal) => Promise<ExecResult>;

/** macOS programs, by absolute path only. */
export const MAC_BIN = {
  open: '/usr/bin/open',
  osascript: '/usr/bin/osascript',
  shortcuts: '/usr/bin/shortcuts',
  pbcopy: '/usr/bin/pbcopy',
  pbpaste: '/usr/bin/pbpaste',
  screencapture: '/usr/sbin/screencapture',
} as const;

/** Windows PowerShell 5.1, which every Windows 10/11 has, under the real Windows folder (one plain `X:\Name` segment, else C:\Windows). */
export function winPowerShell(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? '';
  return `${/^[A-Za-z]:\\[A-Za-z0-9_ -]+$/.test(root) ? root : 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

// ---- macOS: JavaScript for Automation, fixed text; data only through FL_DATA ----

const JXA_DATA = `ObjC.import('Foundation'); const d = JSON.parse(ObjC.unwrap($.NSProcessInfo.processInfo.environment.objectForKey('FL_DATA')) || '{}');`;

/** The scripts osascript runs; the last expression is what it prints. */
export const JXA = {
  /** Regular (Dock) apps and the on-screen windows: no Automation or Accessibility prompt (titles need Screen Recording). */
  running: `ObjC.import('AppKit'); ObjC.import('CoreGraphics');
const apps = ObjC.unwrap($.NSWorkspace.sharedWorkspace.runningApplications)
  .filter((a) => a.activationPolicy === $.NSApplicationActivationPolicyRegular)
  .map((a) => ({ name: ObjC.unwrap(a.localizedName) || '', pid: a.processIdentifier, path: a.bundleURL.isNil() ? '' : ObjC.unwrap(a.bundleURL.path) }));
const windows = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID)))
  .filter((w) => w.kCGWindowLayer === 0)
  .map((w) => ({ id: w.kCGWindowNumber, app: w.kCGWindowOwnerName || '', pid: w.kCGWindowOwnerPID, title: w.kCGWindowName || '' }));
JSON.stringify({ apps, windows });`,
  notify: `const app = Application.currentApplication(); app.includeStandardAdditions = true;
app.displayNotification(String(d.body), { withTitle: String(d.title) }); 'ok';`,
  volume: `const app = Application.currentApplication(); app.includeStandardAdditions = true;
if (d.action === 'set') app.setVolume(null, { outputVolume: Number(d.level) });
if (d.action === 'mute' || d.action === 'unmute') app.setVolume(null, { outputMuted: d.action === 'mute' });
const s = app.getVolumeSettings(); JSON.stringify({ level: s.outputVolume, muted: s.outputMuted });`,
};

export function jxa(script: string, data: unknown = {}): Exec {
  return { file: MAC_BIN.osascript, args: ['-l', 'JavaScript', '-e', `${JXA_DATA}\n${script}`], env: { FL_DATA: JSON.stringify(data) } };
}

// ---- Windows: PowerShell, fixed text run with -EncodedCommand; data only as base64 JSON on stdin ----

const PS_PRELUDE = String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$d = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())) | ConvertFrom-Json
`;

const PS_VOLUME_TYPE = String.raw`Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int f(); int g(); int h(); int i();
  int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
  int j();
  int GetMasterVolumeLevelScalar(out float pfLevel);
  int k(); int l(); int m(); int n();
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, Guid pguidEventContext);
  int GetMute(out bool pbMute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid id, int clsCtx, int activationParams, out IAudioEndpointVolume aev); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }
public static class FlAudio {
  static IAudioEndpointVolume Vol() {
    var e = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
    IMMDevice dev = null; Marshal.ThrowExceptionForHR(e.GetDefaultAudioEndpoint(0, 1, out dev));
    IAudioEndpointVolume v = null; var id = typeof(IAudioEndpointVolume).GUID;
    Marshal.ThrowExceptionForHR(dev.Activate(ref id, 23, 0, out v)); return v;
  }
  public static float Level { get { float v = -1; Marshal.ThrowExceptionForHR(Vol().GetMasterVolumeLevelScalar(out v)); return v; } set { Marshal.ThrowExceptionForHR(Vol().SetMasterVolumeLevelScalar(value, Guid.Empty)); } }
  public static bool Muted { get { bool m; Marshal.ThrowExceptionForHR(Vol().GetMute(out m)); return m; } set { Marshal.ThrowExceptionForHR(Vol().SetMute(value, Guid.Empty)); } }
}
'@
`;

const PS_SHOT_TYPE = String.raw`Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System; using System.Drawing; using System.Drawing.Imaging; using System.Runtime.InteropServices;
public static class FlShot {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  public static void Save(IntPtr hWnd, string file) {
    RECT r;
    if (!GetWindowRect(hWnd, out r)) throw new Exception("The window is gone.");
    int w = r.Right - r.Left, h = r.Bottom - r.Top;
    if (w <= 0 || h <= 0 || w > 16384 || h > 16384) throw new Exception("The window has no size to capture.");
    using (var bmp = new Bitmap(w, h)) {
      using (var g = Graphics.FromImage(bmp)) { IntPtr hdc = g.GetHdc(); try { PrintWindow(hWnd, hdc, 2); } finally { g.ReleaseHdc(hdc); } }
      bmp.Save(file, ImageFormat.Png);
    }
  }
}
'@
`;

/** The scripts PowerShell runs after PS_PRELUDE: `$d` is the data. Each prints JSON or nothing. */
export const PS = {
  running: String.raw`$r = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { [pscustomobject]@{ id = $_.Id; name = $_.ProcessName; title = $_.MainWindowTitle } })
ConvertTo-Json -Compress -InputObject $r`,
  /** A file, folder or Start Menu shortcut, by literal path (no wildcards). */
  openPath: String.raw`Invoke-Item -LiteralPath ([string]$d.path)`,
  /** An http(s) URL, checked before: the default browser. */
  openUrl: String.raw`Start-Process -FilePath ([string]$d.url)`,
  focus: String.raw`Add-Type -AssemblyName Microsoft.VisualBasic
[Microsoft.VisualBasic.Interaction]::AppActivate([int]$d.pid)`,
  clipboardRead: String.raw`$t = Get-Clipboard -Raw
if ($null -eq $t) { $t = '' }
ConvertTo-Json -Compress -InputObject ([string]$t)`,
  clipboardWrite: String.raw`Set-Clipboard -Value ([string]$d.text)`,
  notify: String.raw`[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$t = $x.GetElementsByTagName('text')
[void]$t.Item(0).AppendChild($x.CreateTextNode([string]$d.title))
[void]$t.Item(1).AppendChild($x.CreateTextNode([string]$d.body))
$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($x))`,
  volume: `${PS_VOLUME_TYPE}${String.raw`if ($d.action -eq 'set') { [FlAudio]::Level = [float]([int]$d.level) / 100 }
if ($d.action -eq 'mute') { [FlAudio]::Muted = $true }
if ($d.action -eq 'unmute') { [FlAudio]::Muted = $false }
ConvertTo-Json -Compress -InputObject ([pscustomobject]@{ level = [int][Math]::Round([FlAudio]::Level * 100); muted = [FlAudio]::Muted })`}`,
  screenshot: `${PS_SHOT_TYPE}${String.raw`$p = Get-Process -Id ([int]$d.pid)
if ($p.MainWindowHandle -eq 0) { throw 'That process has no window.' }
[FlShot]::Save($p.MainWindowHandle, [string]$d.file)`}`,
};

export function powershell(script: string, data: unknown = {}, env: NodeJS.ProcessEnv = process.env): Exec {
  return {
    file: winPowerShell(env),
    args: ['-NoProfile', '-NonInteractive', '-NoLogo', '-EncodedCommand', Buffer.from(PS_PRELUDE + script, 'utf16le').toString('base64')],
    input: Buffer.from(JSON.stringify(data), 'utf8').toString('base64'),
  };
}

// ---- Running programs ----

const MAX_OUTPUT = 1024 * 1024;

/** The environment programs start with: fixed on macOS (nothing from the editor's), the user's own on Windows (PowerShell needs it). */
function baseEnv(platform: Platform, env: NodeJS.ProcessEnv): Record<string, string> {
  if (platform === 'win') return Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === 'string'));
  const keep = (k: string) => (typeof env[k] === 'string' ? { [k]: env[k] as string } : {});
  return { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', ...keep('HOME'), ...keep('USER'), ...keep('TMPDIR') };
}

/** Runs one program: no shell, its window hidden, output capped, killed at the timeout or when the call is abandoned. */
export function spawnRunner(platform: Platform, env: NodeJS.ProcessEnv = process.env): Runner {
  return (e, signal) =>
    new Promise((resolve, reject) => {
      const child = spawn(e.file, e.args, { shell: false, windowsHide: true, env: { ...baseEnv(platform, env), ...e.env }, signal, timeout: e.timeoutMs ?? 15_000, stdio: 'pipe' });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let size = 0;
      const take = (into: Buffer[]) => (b: Buffer) => {
        size += b.length;
        if (size > MAX_OUTPUT * 2) child.kill();
        else into.push(b);
      };
      child.stdout.on('data', take(out));
      child.stderr.on('data', take(err));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout: Buffer.concat(out).toString('utf8').replace(/^\uFEFF/, ''), stderr: Buffer.concat(err).toString('utf8') }));
      child.stdin.on('error', () => {});
      child.stdin.end(e.input ?? '');
    });
}

// ---- What may be opened ----

/** Documents, images and media: what an agent may open as a file. Programs, scripts, shortcuts, web pages and macro formats never. */
export const OPEN_EXTENSIONS = new Set(
  (
    'pdf txt md markdown rtf docx xlsx pptx odt ods odp key numbers pages csv tsv json log epub ' +
    'png jpg jpeg gif webp heic heif tif tiff bmp mp3 m4a wav aac flac ogg mp4 mov m4v webm mkv avi'
  ).split(' '),
);

/** Folders that macOS runs or installs rather than shows (apps, preference panes, plug-ins): refused as folders. */
const BUNDLE_EXT = /\.(app|bundle|prefpane|kext|plugin|framework|workflow|action|appex|xpc|saver|qlgenerator|mdimporter|service|systemextension|wdgt|dext|driver|pkg|mpkg|scptd|osax|component|vst3?|shortcut)$/i;

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

/** Only the first two `:` on Windows are a drive; another is an alternate data stream. A `\\` start is a network share (it would send your login). */
function badPathShape(p: string, platform: Platform): string | undefined {
  if (/^[\\/]{2}/.test(p)) return 'Network paths (\\\\server\\share) are not opened.';
  if (platform === 'win' && p.slice(2).includes(':')) return 'That path names an alternate data stream.';
  return undefined;
}

// ---- The actions ----

export interface RunningApp {
  name: string;
  pid: number;
  /** The .app bundle on macOS, when known. */
  path?: string;
}
export interface RunningWindow {
  /** CGWindowID on macOS; the process id of the main window on Windows. */
  id: number;
  app: string;
  pid: number;
  title: string;
}

/** What an approved call will do: what "Always allow" would remember, words for the card and the status bar, and the act itself. */
export interface Prepared {
  tool: SystemTool;
  /** `app:<name>`, `url:<origin>`, `file:<real path>`, a Shortcut's name, or ''. */
  target: string;
  /** What the approval card shows under its title. */
  text: string;
  /** "Open Spotify", for the status bar and the audit log. */
  summary: string;
  run(signal: AbortSignal): Promise<string>;
}

export interface SystemDeps {
  home: string;
  /** The private folder screenshots go in (the extension's global storage). */
  shotsBase: string;
  /** More places never opened: the app bundle and FriedLiver's user data (permissions.ts). */
  sensitive?: string[];
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  run?: Runner;
  /** Where web links open (friedliver.links.openIn); the built-in browser when not given. */
  links?(): 'builtin' | 'external';
  /** Opens a URL in FriedLiver's browser; without it, links open in the system browser. */
  openInBrowser?(url: string, signal: AbortSignal): Promise<string>;
  /** Where installed apps are looked for; the platform's own folders when not given. */
  appDirs?: string[];
}

export const NOT_SUPPORTED = "Mac & Windows control isn't supported on this system: FriedLiver can act on macOS and Windows only.";

/** Text a program printed, safe in a message: no control characters, short. */
function said(r: ExecResult): string {
  // eslint-disable-next-line no-control-regex
  const text = (r.stderr || r.stdout).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim();
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

const fileName = (p: string) => p.split(/[\\/]/).pop() || p;
const quote = (s: string, max = 80) => `“${s.length > max ? `${s.slice(0, max - 1)}…` : s}”`;

export class SystemControl {
  readonly platform: Platform | null;
  private readonly run: Runner;
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly deps: SystemDeps) {
    this.platform = systemPlatform(deps.platform);
    this.env = deps.env ?? process.env;
    this.run = deps.run ?? spawnRunner(this.platform ?? 'mac', this.env);
  }

  /**
   * Checks the call and works out what it would act on, without acting: an app must be installed
   * (or running), a path must exist and be a document or folder outside the private places, a URL
   * http(s). Throws a message for the agent. Called again just before acting, after the user's OK.
   */
  async prepare(call: SystemCall): Promise<Prepared> {
    const p = this.platform;
    if (!p) throw new Error(NOT_SUPPORTED);
    const tool = call.tool;
    const done = (target: string, text: string, summary: string, run: Prepared['run']): Prepared => ({ tool, target, text, summary, run });
    switch (call.tool) {
      case 'system_open': {
        if ('app' in call) {
          const app = await this.installedApp(call.app);
          const exec = p === 'mac' ? { file: MAC_BIN.open, args: ['-a', app.path] } : powershell(PS.openPath, { path: app.path }, this.env);
          return done(`app:${app.name}`, app.name, `Open ${app.name}`, async (signal) => (await this.checked(exec, signal), `Opened ${app.name}.`));
        }
        if ('path' in call) {
          const real = await this.openablePath(call.path);
          const exec = p === 'mac' ? { file: MAC_BIN.open, args: [real] } : powershell(PS.openPath, { path: real }, this.env);
          return done(`file:${real}`, real, `Open ${fileName(real)}`, async (signal) => (await this.checked(exec, signal), `Opened ${real}.`));
        }
        const url = new URL(checkBrowserUrl(call.url));
        if (url.username || url.password) throw new Error('Links with a user name or password in them are not opened.');
        const href = url.href;
        const inside = (this.deps.links?.() ?? 'builtin') === 'builtin' && this.deps.openInBrowser;
        return done(`url:${siteOrigin(href)}`, href, `Open ${url.host}`, async (signal) => {
          if (inside) return this.deps.openInBrowser!(href, signal);
          await this.checked(p === 'mac' ? { file: MAC_BIN.open, args: [href] } : powershell(PS.openUrl, { url: href }, this.env), signal);
          return `Opened ${href} in the system browser.`;
        });
      }
      case 'system_apps':
        return done('', '', 'List apps and windows', async (signal) => {
          const [installed, running] = await Promise.all([this.installedApps(), this.running(signal)]);
          return JSON.stringify({ installed: installed.map((a) => a.name), running: running.apps.map((a) => a.name), windows: running.windows });
        });
      case 'system_focus': {
        const running = await this.running(new AbortController().signal);
        let app: RunningApp | undefined;
        let pid: number;
        if ('window' in call) {
          const w = running.windows.find((x) => x.id === call.window);
          if (!w) throw new Error(`There is no window ${call.window} on screen. Use system_apps to see the windows.`);
          pid = w.pid;
          app = running.apps.find((a) => a.pid === w.pid) ?? { name: w.app, pid: w.pid };
        } else {
          const want = call.app.toLowerCase();
          app = running.apps.find((a) => a.name.toLowerCase() === want);
          if (!app) throw new Error(`${quote(call.app)} isn't running. Use system_apps to see the running apps, or system_open to start it.`);
          pid = app.pid;
        }
        const name = app.name;
        let exec: Exec;
        if (p === 'mac') {
          if (!app.path) throw new Error(`FriedLiver can't bring ${quote(name)} to the front.`);
          exec = { file: MAC_BIN.open, args: ['-a', app.path] };
        } else {
          exec = powershell(PS.focus, { pid }, this.env);
        }
        return done(`app:${name}`, name, `Focus ${name}`, async (signal) => (await this.checked(exec, signal), `${name} is in front.`));
      }
      case 'system_shortcut': {
        if (p !== 'mac') throw new Error('Apple Shortcuts run on macOS only. (On Windows, Power Automate may come later.)');
        const list = await this.checked({ file: MAC_BIN.shortcuts, args: ['list'] }, new AbortController().signal);
        const names = list.stdout.split('\n').map((l) => l.replace(/\r$/, ''));
        if (!names.includes(call.name)) throw new Error(`There is no Shortcut named exactly ${quote(call.name)}.`);
        const exec: Exec = { file: MAC_BIN.shortcuts, args: ['run', '--', call.name], timeoutMs: 120_000 };
        return done(call.name, call.name, `Run Shortcut ${quote(call.name, 40)}`, async (signal) => {
          const r = await this.checked(exec, signal);
          return r.stdout.trim() ? `Ran ${quote(call.name)}. It said:\n${r.stdout.slice(0, SYSTEM_LIMITS.clipboard)}` : `Ran ${quote(call.name)}.`;
        });
      }
      case 'system_clipboard_read':
        return done('', '', 'Read the clipboard', async (signal) => {
          const r = await this.checked(p === 'mac' ? { file: MAC_BIN.pbpaste, args: [] } : powershell(PS.clipboardRead, {}, this.env), signal);
          const text = p === 'mac' ? r.stdout : (JSON.parse(r.stdout || '""') as string);
          return capBytes(text, SYSTEM_LIMITS.clipboard) || '(The clipboard holds no text.)';
        });
      case 'system_clipboard_write': {
        const exec: Exec = p === 'mac' ? { file: MAC_BIN.pbcopy, args: [], input: call.text } : powershell(PS.clipboardWrite, { text: call.text }, this.env);
        return done('', call.text.length > 2000 ? `${call.text.slice(0, 2000)}…` : call.text, `Copy ${call.text.length} characters to the clipboard`, async (signal) => {
          await this.checked(exec, signal);
          return `Copied ${call.text.length} characters to the clipboard.`;
        });
      }
      case 'system_notify': {
        const data = { title: call.title, body: call.body };
        return done('', call.body ? `${call.title} — ${call.body}` : call.title, `Notify ${quote(call.title, 40)}`, async (signal) => {
          await this.checked(p === 'mac' ? jxa(JXA.notify, data) : powershell(PS.notify, data, this.env), signal);
          return 'Shown.';
        });
      }
      case 'system_volume': {
        const data = call.action === 'set' ? { action: 'set', level: call.level } : { action: call.action };
        const summary = call.action === 'set' ? `Set the volume to ${call.level}` : call.action === 'get' ? 'Read the volume' : call.action === 'mute' ? 'Mute' : 'Unmute';
        return done('', summary, summary, async (signal) => {
          const r = await this.checked(p === 'mac' ? jxa(JXA.volume, data) : powershell(PS.volume, data, this.env), signal);
          const v = JSON.parse(r.stdout) as { level: number; muted: boolean };
          return `Volume ${v.level} of 100${v.muted ? ', muted' : ''}.`;
        });
      }
      case 'system_screenshot_window': {
        const w = (await this.running(new AbortController().signal)).windows.find((x) => x.id === call.window);
        if (!w) throw new Error(`There is no window ${call.window} on screen. Use system_apps to see the windows.`);
        const what = `${w.app}${w.title ? ` — ${w.title}` : ''}`;
        return done(`app:${w.app}`, what, `Screenshot ${w.app}`, async (signal) => {
          await mkdir(this.deps.shotsBase, { recursive: true, mode: 0o700 });
          const file = await screenshotFile(this.deps.shotsBase, 'window');
          await this.checked(
            p === 'mac' ? { file: MAC_BIN.screencapture, args: ['-x', '-o', `-l${w.id}`, file], timeoutMs: 20_000 } : { ...powershell(PS.screenshot, { pid: w.pid, file }, this.env), timeoutMs: 30_000 },
            signal,
          );
          if (!(await exists(file))) throw new Error('No screenshot was taken. On macOS, FriedLiver needs Screen Recording permission (System Settings → Privacy & Security).');
          if (p === 'mac') await chmod(file, 0o600);
          return `Screenshot of ${what}\nSaved to ${file}. Read that file to see it.`;
        });
      }
    }
  }

  /** Installed apps: .app bundles in the Applications folders, or Start Menu shortcuts. Names only come from here. */
  async installedApps(): Promise<{ name: string; path: string }[]> {
    const dirs = this.deps.appDirs ?? this.appDirs();
    const out = new Map<string, { name: string; path: string }>();
    for (const dir of dirs) {
      const entries = await readdir(dir, { recursive: this.platform === 'win', withFileTypes: false }).catch(() => [] as string[]);
      for (const rel of entries) {
        const m = this.platform === 'win' ? /^(.+)\.lnk$/i.exec(path.basename(rel)) : /^(.+)\.app$/i.exec(rel);
        if (!m || rel.split(/[\\/]/).length > 4) continue;
        const name = m[1];
        if (!out.has(name.toLowerCase())) out.set(name.toLowerCase(), { name, path: path.join(dir, rel) });
        if (out.size >= 2000) break;
      }
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private appDirs(): string[] {
    if (this.platform === 'mac') {
      return ['/Applications', '/Applications/Utilities', path.join(this.deps.home, 'Applications'), '/System/Applications', '/System/Applications/Utilities'];
    }
    const programData = this.env.ProgramData ?? this.env.PROGRAMDATA;
    const appData = this.env.APPDATA;
    return [programData, appData].filter((d): d is string => !!d && path.win32.isAbsolute(d)).map((d) => path.join(d, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
  }

  /** Windows' own folders and the user's AppData (browser profiles, credentials, other apps' data). */
  private winSensitive(): string[] {
    if (this.platform !== 'win') return [];
    const e = this.env;
    return [e.SystemRoot, e.ProgramFiles, e['ProgramFiles(x86)'], e.ProgramData, path.join(this.deps.home, 'AppData')].filter((d): d is string => !!d);
  }

  private async installedApp(name: string): Promise<{ name: string; path: string }> {
    const app = (await this.installedApps()).find((a) => a.name.toLowerCase() === name.toLowerCase());
    if (!app) throw new Error(`No installed app is named ${quote(name)}. Use system_apps to see the installed apps.`);
    return app;
  }

  async running(signal: AbortSignal): Promise<{ apps: RunningApp[]; windows: RunningWindow[] }> {
    if (this.platform === 'mac') {
      const r = await this.checked(jxa(JXA.running), signal);
      const v = JSON.parse(r.stdout) as { apps: RunningApp[]; windows: RunningWindow[] };
      return { apps: v.apps.slice(0, 500), windows: v.windows.slice(0, 500) };
    }
    const r = await this.checked(powershell(PS.running, {}, this.env), signal);
    const list = (JSON.parse(r.stdout || '[]') as { id: number; name: string; title: string }[]).slice(0, 500);
    return { apps: list.map((x) => ({ name: x.name, pid: x.id })), windows: list.map((x) => ({ id: x.id, app: x.name, pid: x.id, title: x.title ?? '' })) };
  }

  /** The real path of a document or folder an agent may open, or a message why not. */
  private async openablePath(raw: string): Promise<string> {
    const p = this.platform!;
    const abs = p === 'win' ? path.win32.isAbsolute(raw) && /^[A-Za-z]:[\\/]/.test(raw) : raw.startsWith('/');
    if (!abs) throw new Error('Give an absolute path, like /Users/you/Documents/report.pdf or C:\\Users\\you\\report.pdf.');
    const shape = badPathShape(raw, p);
    if (shape) throw new Error(shape);
    let real: string;
    try {
      real = await realpath(raw);
    } catch {
      throw new Error(`There is no file or folder at ${raw}.`);
    }
    const shape2 = badPathShape(real, p);
    if (shape2) throw new Error(shape2);
    if (isSensitive(real, this.deps.home, [...(this.deps.sensitive ?? []), ...this.winSensitive()], 'read')) {
      throw new Error('That is in a private or system place (keys, settings, system folders, FriedLiver itself); FriedLiver does not open it for agents.');
    }
    const st = await stat(real);
    if (st.isDirectory()) {
      if (BUNDLE_EXT.test(real) || /\.\{[0-9a-f-]+\}$/i.test(real) || (p === 'mac' && (await exists(path.join(real, 'Contents', 'Info.plist'))))) {
        throw new Error('That folder is an app or package, which opening would run or install. Use system_open with `app` for installed apps.');
      }
      return real;
    }
    if (!st.isFile()) throw new Error('Only files and folders are opened.');
    const ext = path.extname(real).slice(1).toLowerCase();
    if (!OPEN_EXTENSIONS.has(ext)) {
      throw new Error(`FriedLiver opens documents, images, media and folders only, not ${ext ? `.${ext}` : 'extensionless'} files (they could run code).`);
    }
    return real;
  }

  private async checked(e: Exec, signal: AbortSignal): Promise<ExecResult> {
    const r = await this.run(e, signal);
    if (r.code !== 0) throw new Error(`It didn't work${said(r) ? `: ${said(r)}` : '.'}`);
    return r;
  }
}

/** At most `max` bytes of UTF-8, cut on a character. */
export function capBytes(text: string, max: number): string {
  if (Buffer.byteLength(text, 'utf8') <= max) return text;
  const cut = Buffer.from(text, 'utf8').subarray(0, max).toString('utf8').replace(/\uFFFD$/, '');
  return `${cut}\n… (cut at ${max / 1024} KB)`;
}

/** At most `max` actions per key in any minute. */
export class RateLimit {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly max = SYSTEM_LIMITS.perMinute,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts one action; false (and not counted) when the key is over its limit. */
  take(key: string): boolean {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((h) => t - h < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    return true;
  }

  forget(key: string): void {
    this.hits.delete(key);
  }
}

/** The call's arguments for the audit log: clipboard text and notification bodies as their length only. */
export function auditArgs(call: SystemCall): string {
  const args: Record<string, unknown> = { ...call };
  delete args.tool;
  if ('text' in args) args.text = `<${String(args.text).length} chars>`;
  if (call.tool === 'system_notify') args.body = `<${call.body.length} chars>`;
  return JSON.stringify(args);
}

/** One line of the "FriedLiver: System Actions" log; results of reading the clipboard never appear. */
export function auditLine(e: { at: number; agent: string; chat: string; call: SystemCall; result: string }): string {
  // eslint-disable-next-line no-control-regex
  const plain = (s: string) => s.replace(/[\u0000-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ');
  const result = e.call.tool === 'system_clipboard_read' && e.result.startsWith('ok') ? 'ok (text not logged)' : e.result;
  return `${new Date(e.at).toISOString()} ${plain(e.agent)} ${plain(e.chat)} ${e.call.tool} ${plain(auditArgs(e.call))} → ${plain(result).slice(0, 300)}`;
}

/**
 * friedliver.system.* from the user's own settings only (a repository's settings never turn these on):
 * on by default, Full auto never covering them unless the user says so, every tool on unless turned off.
 */
export function systemSettings(inspect: (key: 'enabled' | 'fullAutoAllowed' | 'tools') => InspectedSetting<unknown> | undefined): {
  enabled: boolean;
  fullAutoAllowed: boolean;
  tools: Record<SystemTool, boolean>;
} {
  const enabled = userSetting(inspect('enabled')).value;
  const fullAuto = userSetting(inspect('fullAutoAllowed')).value;
  const tools = userSetting(inspect('tools')).value;
  const t = typeof tools === 'object' && tools !== null ? (tools as Record<string, unknown>) : {};
  return {
    enabled: enabled !== false,
    fullAutoAllowed: fullAuto === true,
    tools: Object.fromEntries(SYSTEM_TOOLS.map((k) => [k, t[k] !== false])) as Record<SystemTool, boolean>,
  };
}
