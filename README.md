# FriedLiver Code

FriedLiver built on VS Code 1.142 (Code - OSS). You get VS Code's editor and
extensions from Open VSX, plus Claude, Codex and Gemini coding agents in a
panel on the right. Under each message box you pick the agent's model, its
effort, and how much it may do on its own: **Ask** (edits and commands wait for
you), **Auto-accept edits**, or **Full auto**. What an agent asks to do shows
with its diff, its command or its plan, and every turn can be undone.

![An agent asks another agent, and waits for your Allow](docs/screenshots/app/03-agent-asks-agent.png)

![The Agent Manager's map: which chat asked which](docs/screenshots/app/06-manager-map.png)

What changes from stock VS Code:

- **Agents on the right.** The FriedLiver Agents panel holds chats, reviewed
  edits and approved commands. Each agent signs in through its own official CLI.
- **An Agent Manager for many agents.** A board (Needs you / Working / Done)
  where decisions are answered on the card, a sortable list, and a live map of
  how every chat is connected: who handed off to whom, who asked whom, which
  chats pipe into others, and which files two chats both changed. Run one task
  on several agents and compare them side by side
  ([screenshots](docs/screenshots/agents/)).
- **Any chat can reach any agent.** Hand a chat off to another agent, ask
  another agent from a chat (`@gemini …`, `@gpt …`, `@claude …`), pipe one
  chat's replies into another, or forward a reply. Agents can ask each other
  too, through FriedLiver's own tools, each time you allow it
  ([how it works](docs/CONNECTIONS.md)). Chats survive a reload.
- **No built-in Copilot, AI features off by default.** Copilot Chat and the
  agent host don't ship, so the fork settles about 165 MB below VS Code
  ([benchmarks](docs/benchmarks.md)). The JSON language server waits for a
  JSON file, and agents reach FriedLiver's tools without a process per chat:
  about 50 MB less at rest and 270 MB less with 15 agents at work
  ([measured](docs/benchmarks.md#cutting-memory-at-the-app-level)).
- **Open VSX gallery.** Prettier, ESLint, GitLens, Python, Go, rust-analyzer and
  most others install as usual. Microsoft-only extensions (Pylance, C/C++, C#,
  Remote - SSH, Copilot) aren't there. Open replacements are listed in the
  benchmarks.
- **Black Blue theme and Geist fonts** built in, plus Light Blue, Midnight Blue
  and Graphite. Quiet chrome, loud decisions: regions separate by tone instead
  of lines, overlays float on soft shadows, and only a decision gets the
  accent color ([screenshots](docs/screenshots/workbench/)). A first-run
  walkthrough (Help → Welcome) shows the Demo agent, sign-in, the Agent
  Manager and `@gemini`.
- **No telemetry, no experiments, no update service.** Every 4 hours the Agents
  extension asks GitHub whether a newer FriedLiver release is out and offers to
  install it (checksum-verified; `friedliver.update.mode: off` turns that off). It has its own
  `.friedliver` settings folder, so it doesn't touch an installed VS Code.
- **Agents ask first.** In Ask, each edit and command waits for you, shown as a
  diff or a command line; Full auto is a per-chat choice you confirm. Files
  outside the workspace (symlinks included) are off limits to FriedLiver's
  file access, and a repository's settings can't change which program runs as
  an agent or let it run without asking. What that does and doesn't protect,
  per agent: [SECURITY.md](SECURITY.md).

The Electron app, a separate and lighter editor (about 370 MB against about
840 MB here), lives in [FriedLiver](https://github.com/MrArun005/FriedLiver).

## Install

Releases (tags like `v1.142.0` or `v1.142.0-2`) are on the
[Releases](https://github.com/MrArun005/FriedLiver-Code/releases) page with
the same files and a `SHA256SUMS.txt` to check them against. The **Build
FriedLiver** workflow also builds every push to `main`: open its latest run
under **Actions** and download from **Artifacts**:

| System | Installer | Portable |
|---|---|---|
| Windows x64 | `friedliver-fork-windows-x64-installer`: `FriedLiverUserSetup-x64-<version>.exe`, installs for your user, no admin rights | `friedliver-fork-windows-x64`: unzip, run `FriedLiver.exe` |
| macOS (Apple silicon) | `friedliver-fork-macos-arm64-installer`: `.dmg`, drag to Applications | `friedliver-fork-macos-arm64`: zipped `.app` |
| Linux x64 | `friedliver-fork-linux-x64-installer`: `.deb` | `friedliver-fork-linux-x64`: `.tar.gz` |

Builds aren't code-signed yet. On Windows choose **More info → Run anyway**. On
macOS, the first time, go to **System Settings → Privacy & Security → Open
Anyway**.

## Use the agents

First time with real accounts? [docs/TRY-IT.md](docs/TRY-IT.md) is a 10-minute
check from install to two agents talking to each other.

1. Open a folder. The Agents panel opens on the right.
2. No account yet? Turn on `friedliver.showDemoAgent`, pick **Demo** (a fake
   local agent, no account, no network) and type `tour`: a plan, an edit you
   review as a diff, a command you approve, an image. Accept is Ctrl/Cmd+Alt+Y
   and Reject is Ctrl/Cmd+Alt+N. The "decisions waiting" item in the status bar
   jumps to whatever waits on you.
3. For the real agents, install a CLI once, then sign in from **FriedLiver:
   Agents & Accounts** (also in the New chat menu and the Accounts view). It has
   a card per agent: its status and version, its own sign-in methods, an API key
   kept in the editor's secret storage (Gemini also takes Vertex AI), which
   account is in use, sign-out, and the model and effort new chats start with
   ([details](docs/ACCOUNTS.md)):

| Agent | Install | Sign-in |
|---|---|---|
| Claude | `npm install -g @agentclientprotocol/claude-agent-acp` | Claude Code's own login in a terminal (subscription or Anthropic Console): approve on claude.ai; or an Anthropic API key |
| Codex | `npm install -g @agentclientprotocol/codex-acp` | Your browser opens OpenAI's sign-in page (ChatGPT), or an OpenAI API key |
| Gemini | `npm install -g @google/gemini-cli` | Your browser opens Google's sign-in page, or a Gemini API key, or Vertex AI |

   The older `@zed-industries/*` packages are deprecated and lack the effort
   and plan options; Agents & Accounts says when an installed adapter is too old.

4. Choose how the agent works, under the message box: the **approval** chip
   (Ask, Auto-accept edits, Full auto, Plan first, and the agent's own modes;
   Shift+Tab switches), the **model** (with switches such as Fast mode) and
   the **effort**, all as the agent offers them. Your last choices for each
   agent apply to its next chats. `/` lists the agent's commands, `#` names a
   file for it, and the bar shows how full its context is. Messages you send
   while it works wait in a queue (Send now adds one to the running turn
   where the agent allows it).
   On a Mac, the **mic** in the message box dictates: click it and talk, and
   the words appear at the caret as you speak. It stops after 2.5 s without
   new words, on a second click or on Esc. macOS asks once for microphone and
   speech-recognition permission for FriedLiver. Recognition runs on the Mac
   whenever macOS has the language on device (otherwise Apple's server does
   it). `friedliver.voice.language` (`auto` = the system language, or e.g.
   `en-IN`, `hi-IN`) and `friedliver.voice.silenceSeconds` tune it.
5. Connect them. In a chat, start a message with `@gemini` (or `@gpt`,
   `@claude`, `@demo`) to ask that agent; the answer comes back as a card you
   can send on. **Hand off**, **Ask** and **Pipe to** in the chat's header and
   on Agent Manager cards do the rest. With the Demo agent, `ask demo <question>`
   shows an agent asking another agent: you get Allow, Allow for this chat, or
   Deny.

The command palette has the rest under "FriedLiver": Agent Manager, Run a Task
on Several Agents, Hand Off to Another Agent, Ask Another Agent, Pipe a Chat's
Replies to Another Chat, Go to Next Decision (Ctrl+Alt+D), Accept All Agent
Edits, Manage Permissions, Get Another Agent Extension…, Move Agents to
the Center (Ctrl/Cmd+Shift+A), Agents & Accounts, Set API Key…, Stop All Agents, and the editor
commands below. `friedliver.connections.agentToAgent` (ask, allow or off) and
`friedliver.approvals.default` (ask or edits) are read from your user settings
only. `friedliver.notify.decisions` and `.finished` choose the notifications.

### What FriedLiver controls for each agent

Claude and Codex edit files and run commands themselves; Gemini and the Demo
agent write through FriedLiver. So the review looks different per agent, and
FriedLiver sets each agent's own mode to match the chat's level instead of
taking the agent's default:

| | Claude | Codex | Gemini | Demo |
|---|---|---|---|---|
| Edits | Claude writes the file. In Ask, its request shows the diff first (**Open diff** shows the whole file) | Codex writes the file. In Ask (Read-only), its request shows the diff first | Through FriedLiver: in Ask each write opens as a diff you accept or change | Through FriedLiver, like Gemini |
| Commands | Claude runs them. In Ask and Auto-accept edits its request shows the command and folder | Codex runs them in its sandbox; Read-only asks before anything that writes, Workspace access runs workspace commands without asking | Gemini runs them after its own request, shown with the command | FriedLiver runs them after Run |
| Ask / Auto-accept edits / Full auto | Manual / Accept edits / Bypass permissions (Auto when Bypass isn't offered) | Read-only / Workspace access / Full access | Auto Edit (FriedLiver reviews each write) / Auto Edit / YOLO | Ask / Accept edits / Full access |
| Undo and "Changed N files" | A git snapshot at the start of each turn, for every agent; outside git, from the content FriedLiver saw before each edit | same | same, plus FriedLiver's own record of its writes | same |

"Always allow" on a command adds a rule (that exact command, or a program and
its subcommand) for this workspace, kept in your profile, never in the
repository. Lines that chain, redirect, substitute or set variables never
match a rule.

Prefer another agent extension? **FriedLiver: Get Another Agent Extension…**
offers Claude Code, Cline, Roo Code, Kilo Code and Continue from Open VSX as
their publishers ship them. They work on their own, outside FriedLiver's
reviews.

The program each agent runs (`friedliver.agents.<agent>.command` and `.args`)
is read from your user settings only, never from a workspace's
`.vscode/settings.json`. API keys stay in the editor's secret storage and go
only to their own vendor's agent.

### Agents in the editor

Agents also work right where the code is, with the same reviewed diffs and
approved commands ([details](docs/EDITOR.md)):

- **Edit with Agent** (Ctrl/Cmd+I, or right-click): select code, describe the
  change, and the edit opens there as a diff to accept or reject. Start with
  `@claude`, `@gpt`, `@gemini` or `@demo` to pick the agent; otherwise it's
  the one you last used for edits. Errors and warnings get **Fix with Agent**
  in their quick fixes.
- **Ask About Selection** sends your question with the code to a chat, and
  **Add Selection to Chat** puts the code in its message box. The code shows
  as a chip (`format.ts:12–18`) that opens those lines.
- **Review My Changes** (Source Control title bar) gives an agent your
  uncommitted diff in a new "Review: \<branch\>" chat. Say "fix it" there to
  get the fixes as reviewed edits.

With the Demo agent, try `@demo uppercase` on a selection.

### In VS Code or Antigravity instead

The two built-in extensions also install into VS Code 1.104 or newer and into
editors built on it. Download **friedliver-vscode-extensions** from the latest
**CI** run, then in the Extensions view choose **⋯ → Install from VSIX…** for
`friedliver-agents.vsix` and `friedliver-theme.vsix`. There the Agents icon sits
in the activity bar; drag it to the right-hand side bar if you want it there.

## Build it

```bash
node scripts/fetch.mjs                          # clone upstream at the pinned tag into vscode/
node scripts/prepare.mjs                        # patches, product.json, branding, built-in extensions
node scripts/build.mjs                          # npm ci + compile (dev build)
node scripts/dev.mjs [folder]                   # run from source
node scripts/build.mjs --package --installer    # minified app in VSCode-<os>-<arch>/, installer in installers/
```

`VSCODE_DIR` puts the upstream checkout somewhere else. The full guide covers
prerequisites per OS, time, disk and memory: [docs/BUILD.md](docs/BUILD.md).

| Path | What it is |
| --- | --- |
| `upstream.json` | Pinned upstream tag and commit |
| `product.json` | Names, IDs, Open VSX gallery and service overrides, deep-merged into upstream's. `null` deletes a key |
| `patches/` | Source patches, applied in file-name order |
| `branding/` | The roasted liver icon and artwork, and `make-branding.py`, which generates `overlay/` (Windows and macOS icons, installer pictures, watermark) |
| `extensions/friedliver-agents/` | The Agents panel, Agent Manager and reviews |
| `extensions/friedliver-theme/` | Color themes generated from `palette.json`, and the workbench defaults |
| `agent-core/` | The ACP client the agents extension bundles, and the offline Demo agent ([README](agent-core/README.md)) |
| `scripts/` | `fetch`, `prepare`, `build`, `dev`, `screenshot`, `check-upstream` (plain Node, any OS); `checksums.json` pins downloads that publish no checksums |
| `docs/` | [BUILD.md](docs/BUILD.md), [DEFAULTS.md](docs/DEFAULTS.md), [EDITOR.md](docs/EDITOR.md), [memory-plan.md](docs/memory-plan.md), [benchmarks.md](docs/benchmarks.md) |
| `SECURITY.md` | Threat model, how to report a vulnerability, audit findings |

Patches:

| Patch | What it does |
| --- | --- |
| `0010-drop-builtin-copilot` | No built-in Copilot extension; runs without `defaultChatAgent` |
| `0020-disable-builtin-ai-by-default` | `chat.disableAIFeatures` defaults to true, and the Chat view hides with it |
| `0030-installers-without-microsoft-only-parts` | Installers build without the Windows appx package and the tunnel CLI |
| `0040-extensions-without-vsce-sign` | Open VSX installs work without Microsoft's signature-check binary (signature checks are off; see [SECURITY.md](SECURITY.md), FL-18) |
| `0100-bundle-geist-fonts` | Geist and Geist Mono ship with the app and are the default fonts |
| `0110-modern-workbench` | The FriedLiver workbench stylesheet: regions separate by tone, soft rounded overlays, an activity pill, thin scrollbars, a pill command center. Theme variables only; high contrast untouched |
| `0130-chat-list-below-explorer` | The FriedLiver chat list (`friedliver-chats`) gets activity-bar order 0.5: right below Explorer on new and existing profiles, then wherever the user drags it |
| `0200-fast-shell-env` | The extension host starts with the last launch's shell environment instead of waiting for the login shell, then gets the fresh one in the background; only non-secret variables are cached (`friedliver.fastShellEnv`, [DEFAULTS.md](docs/DEFAULTS.md)) |
| `0210-node-compile-cache-posix` | macOS/Linux: the extension host, shared process and pty host keep a writable Node.js compile cache in `CachedData/<commit>/node` (upstream: Windows only, packaged); argv.json `"node-compile-cache": false` turns it off |

### Writing a patch

```bash
node scripts/prepare.mjs                         # start from a prepared tree
# edit files in vscode/
git -C vscode diff -- src > patches/0200-my-change.patch
node scripts/prepare.mjs                         # check it applies on a clean tree
```

Leave `product.json`, `resources/linux/code.png`, the branding overlay and the
removed `extensions/copilot` out of patch diffs; `prepare.mjs` handles those.

### Checks

```bash
npm ci && npm run lint && npm test               # lint, theme tests
cd extensions/friedliver-agents && npm ci && npm run typecheck && npm test
node scripts/ui-harness.mjs                      # the webviews from a fixture, with screenshots
```

After a packaged build, `xvfb-run -a node scripts/e2e-demo.mjs
VSCode-linux-x64/friedliver /tmp/fle` drives the real app with the Demo agent
(an @mention, an agent asking another agent, the Agent Manager) and saves the
screenshots in `docs/screenshots/app/`.

`xvfb-run -a -s "-screen 0 1920x1080x24" node scripts/stress-demo.mjs
VSCode-linux-x64/friedliver /tmp/fls` runs 15 Demo chats at once (`--agents 1`
for a baseline) with the Agent Manager open beside an editor, and prints memory
by process, CPU, long tasks, typing latency and how far the views lag behind.
`--scenario idle` measures memory at rest instead. The numbers are in
[docs/benchmarks.md](docs/benchmarks.md#15-agents-at-once).

## License

Upstream Code - OSS is MIT licensed. Its `LICENSE.txt` and
`ThirdPartyNotices.txt` ship inside every build.
