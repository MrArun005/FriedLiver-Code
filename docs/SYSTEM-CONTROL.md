# Mac & Windows control

A fixed set of things agents can ask to do on your computer, as `system_*`
tools: every FriedLiver chat (except read-only chats and inline edits) gets
them; Claude Code outside FriedLiver doesn't (its `friedliver-browser` server
has the browser tools only). macOS and Windows: a session isn't offered them
on Linux, nor `system_shortcut` on Windows, nor any while
`friedliver.system.enabled` is off or one you turned off in
`friedliver.system.tools`, so its tool list stays short.

Code: `extensions/friedliver-agents/src/host/system.ts` (the actions),
`src/host/bridgeRequests.ts` (approvals), `src/shared/system.ts` (names and
rules), `src/bridge/mcp.ts` (schemas). Threat model: SECURITY.md, "Mac &
Windows control".

## The tools

| Tool | What it does | macOS | Windows |
|---|---|---|---|
| `system_open` | One of: an installed app by name (`app`), a document, image, media file or folder by absolute path (`path`), an http(s) link (`url`) | `/usr/bin/open -a <bundle>` / `open <real path>` / `open <url>` | `Invoke-Item -LiteralPath` (Start Menu shortcut or file) / `Start-Process <url>` |
| `system_apps` | Installed apps, running apps and their windows (ids for focus and screenshots) | `.app` bundles in /Applications, ~/Applications, /System/Applications (+ Utilities); running apps and windows from NSWorkspace and CGWindowList (JXA) | Start Menu `.lnk` shortcuts; `Get-Process` with a main window (the window id is the process id) |
| `system_focus` | Brings a running app, or a window's app, to the front | `open -a <bundle>` | `AppActivate(pid)` |
| `system_shortcut` | Runs an Apple Shortcut by exact name from `shortcuts list` | `/usr/bin/shortcuts run -- <name>` | Not supported (Power Automate may come later) |
| `system_clipboard_read` / `_write` | Clipboard text, up to 100 KB | `pbpaste` / `pbcopy` (stdin) | `Get-Clipboard -Raw` / `Set-Clipboard` |
| `system_notify` | A notification (title ≤ 100, body ≤ 1,000 characters) | `displayNotification` (JXA) | A toast through WinRT |
| `system_volume` | `get`, `set` 0–100, `mute`, `unmute` | `set volume` / `get volume settings` (JXA) | Core Audio `IAudioEndpointVolume` (Add-Type) |
| `system_screenshot_window` | A PNG of one window, saved to FriedLiver's private screenshots folder (0700 folder, 0600 file); it shows in the Images view | `/usr/sbin/screencapture -x -o -l<id>` | `PrintWindow` (Add-Type) |

No brightness: neither OS has a built-in way without extra programs.

What may be opened: apps only by a name from the installed list; files only
with a document, image or media extension (pdf, txt, md, rtf, docx, xlsx,
pptx, odt/ods/odp, key/numbers/pages, csv, tsv, json, log, epub, png, jpg,
gif, webp, heic, tiff, bmp, mp3, m4a, wav, aac, flac, ogg, mp4, mov, m4v,
webm, mkv, avi) and folders that aren't app bundles or packages, by real path,
outside private places (home dot folders, ~/Library, AppData, system folders,
FriedLiver itself); no network shares or alternate data streams. Links are
http(s) without a user name or password, opened in FriedLiver's browser or the
system browser as `friedliver.links.openIn` says (FriedLiver's when unset).

## How programs are run

Fixed absolute paths only, argument arrays, no shell, no `PATH` lookup. On
macOS the environment is fixed too (PATH `/usr/bin:/bin:/usr/sbin:/sbin`,
`LANG`, `HOME`, `USER`, `TMPDIR`). osascript runs fixed JavaScript-for-
Automation text; the agent's data is JSON in `FL_DATA`. PowerShell is Windows
PowerShell 5.1 at `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`
(a SystemRoot that isn't a plain `X:\Name` falls back to `C:\Windows`), run
`-NoProfile -NonInteractive -NoLogo -EncodedCommand <fixed script>`; the data
is base64 JSON on stdin. Each run is capped (15 s, 2 minutes for Shortcuts;
2 MB of output) and stops when the agent gives up on the call.

## Approvals

| | Allow once | Allow for this chat | Always allow | Full auto |
|---|---|---|---|---|
| Most actions | yes | that tool on that target, this chat | that tool on that target, every chat (Manage Permissions → Mac & Windows control) | only with `friedliver.system.fullAutoAllowed` |
| Reading the clipboard, window screenshots, opening or focusing terminals, shells, System Settings, Keychain Access, Registry Editor, Task Manager and the like | yes | no | no | no |

A target is the app (`app:Spotify`), a link's site (`url:https://example.com`),
a file's real path, a Shortcut's name, or nothing (notifications, volume,
copying, listing). The target is checked again just before acting; if it
changed after you approved, nothing happens. Agent-to-agent "allow" and
`friedliver.browser.externalAutoApprove` don't cover these tools.

Limits: 30 actions a minute per chat; three requests
waiting on you per chat.

## Settings

- `friedliver.system.enabled` (on): all of it.
- `friedliver.system.tools`: each tool on or off.
- `friedliver.system.fullAutoAllowed` (off): Full auto chats act without asking (not for the always-asked kinds).

All machine-scoped and read from your user settings only. The same switches
are on **Agents & Accounts → Mac & Windows control** (turning Full auto on
asks first).

## Seeing what happened

- **FriedLiver: System Actions** (output channel; also "Show System Actions
  Log"): one line per attempt: time, agent, chat, tool, arguments, result.
  Clipboard text and notification bodies are logged as their length; what the
  clipboard held never is.
- The status bar shows "Agent used: Open Spotify" for a few seconds after each
  action.

## macOS permissions

- Listing apps and windows and bringing apps forward use NSWorkspace,
  CGWindowList and `open`: no Automation or Accessibility prompt.
- **Screen Recording** (System Settings → Privacy & Security) for FriedLiver:
  needed for window titles in `system_apps` and for `system_screenshot_window`.
  Without it titles are empty and screenshots fail with a message saying so.
- Notifications come from osascript, so macOS may show them as Script Editor's
  and ask once to allow its notifications.
- A Shortcut may ask for its own permissions the first time it runs.

## Windows notes

- Toasts are shown under Windows PowerShell's app id; Focus Assist can hide them.
- `PrintWindow` can't capture some GPU-drawn windows (they come out black).
- `AppActivate` may only flash the taskbar button when Windows' foreground lock
  stops it.

## Checked on a real machine?

The tests mock every program and compile the macOS scripts with `osacompile`;
CI's Windows runner parses every PowerShell script and runs the process list
and a clipboard round trip. Still to try by hand on each OS: opening apps,
files and links, focus, notifications, volume, Shortcuts and window
screenshots, with the permissions above.
