# Security

## Reporting a vulnerability

Report it privately through GitHub:
[Security → Report a vulnerability](https://github.com/MrArun005/FriedLiver-Code/security/advisories/new).
Please don't open a public issue. Include the FriedLiver version (Help → About,
or `friedliverVersion` in the app's `product.json`), your OS, and steps to
reproduce. You'll hear back within a week. Fixes ship in the next release; only
the latest release is supported. Upstream VS Code bugs go to
[Microsoft](https://github.com/microsoft/vscode/security/policy) and vendor
agent CLI bugs to their vendors.

## Threat model

FriedLiver is VS Code (Code - OSS) with an Agents extension that runs coding
agents (Claude, Codex, Gemini, and an offline Demo) over the Agent Client
Protocol. Who is trusted:

- **You.** You choose per chat how much an agent may do without asking (Ask,
  Auto-accept edits, Full auto). In Ask, every edit and command that reaches
  FriedLiver, or that the agent asks permission for, waits for you.
- **The editor and the extensions you install.** They run with your rights.
- **The agent programs you install** (`claude-agent-acp`, `codex-acp`, `gemini`)
  are trusted code with untrusted input: they act on what they read, and a file
  in a repository can tell them to do things (prompt injection).
- **Repositories** are untrusted. Until you trust a folder, VS Code's Restricted
  Mode applies and the Agents extension doesn't run at all
  (`untrustedWorkspaces.supported: false`). Even after you trust it, its files
  are data, not instructions to FriedLiver.

### What an agent can and can't do through FriedLiver

An agent can:

- Read files in the open workspace folders and its task worktree. It sees
  unsaved editor text the way you do.
- Propose a write through FriedLiver (Gemini, the Demo agent). In Ask it opens
  as a diff and is written only if you accept, with the content you leave in
  the diff. Edits you ask for from the editor (Edit with Agent, Fix with
  Agent; docs/EDITOR.md) are ordinary chat turns and go through the same review.
- Ask to run a command in a FriedLiver terminal (the Demo agent). In Ask it
  runs only after you approve it. You see the whole command line, including
  any environment variables the agent sets, with invisible and
  direction-changing characters spelled out.
- Ask permission for something it does itself (Claude and Codex edit files and
  run commands in their own process). The card shows what the request carries,
  merged with the tool call it names: the diff (and the whole proposed file,
  read-only, through **Open diff**), the command and its folder with invisible
  characters spelled out, or the plan. FriedLiver can only answer the request;
  the agent does the work.
- Ask you a question as a form, send images, and start a sign-in for its own vendor.

Every turn starts with a checkpoint: a git snapshot of the working tree, made
in a temporary index (your index, stash and branches stay as they are), so
"Changed N files" and Undo cover edits an agent made itself. Outside git,
Undo covers FriedLiver's own writes and the files an agent asked to edit, from
the content seen before the request. A file changed again after the turn is
left as it is.

Through FriedLiver an agent can't:

- Read or write outside the workspace, including through symlinks (a cloned
  repository's `keys -> ~/.ssh`, dangling links, or links to folders that
  don't exist yet). Paths are checked by real location, and checked again just
  before writing.
- Write into a `.git` folder, whose config and hooks run programs.
- Run a command in a FriedLiver terminal without your approval (or the chat's
  Full auto or a rule you added), or get a Run or Allow button for a command
  the notification doesn't show in full.
- Put a link that runs editor commands into a notification.
- Read another chat, post into it, or ask another agent without your OK
  (see "Agents reaching other agents" below), or pose as another agent's chat.
- Get another vendor's API key, swap its own key through a sign-in method, or
  load code into its sign-in command through variables like `NODE_OPTIONS`.
- Open a web page. The only exception is a sign-in link on its own vendor's
  site, offered only while you sign in, and only after you click.
- Show anything but an image as an image. Images, SVG included, are only
  rendered through `<img>`, where scripts don't run.
- Exhaust the editor's memory with output, replies or images. Output is capped
  at 16 MB per command, a reply at 512 KB, a chat at 2,000 items, a read at 64 MB.

**Agents aren't sandboxed.** An agent is a program running as you. FriedLiver
controls what an agent asks FriedLiver to do (ACP file reads, writes and
terminals) and answers the permission requests the agent sends. It can't stop
the agent's own process from reading files, writing files or using the
network directly, and an agent's own settings can let it act without asking
(Claude honours allow rules in a project's `.claude/settings.json`; Codex's
"Workspace access" runs sandboxed commands without asking). FriedLiver sets
each agent's mode at session start from the chat's level, so a vendor default
(Codex's "Auto review", a `defaultMode` in `~/.claude/settings.json`) doesn't
carry over, and the chat header always shows the mode the agent reports, in
color when it doesn't ask. Install only agents you trust, and treat their
vendors' own permission settings as part of your setup.

### Approval levels and "Always allow"

- **Ask** (the default): FriedLiver's reviews and Run/Deny cards, and every
  permission request, wait for you.
- **Auto-accept edits**: writes through FriedLiver are accepted without a diff
  and permission requests for edits get the agent's one-time "yes". Commands
  still wait. Every such edit is recorded for Undo and listed in the turn's
  changes.
- **Full auto**: edits and commands go through. It is chosen per chat, never
  as a default, and confirmed once per chat in a modal. The chat, its tab, its
  Agent Manager card, the map and the status bar show it in red while it is
  on. A reopened window brings the chat back in Ask (or your default), never
  Full auto. FriedLiver still asks for commands in folders outside the
  workspace and for plans (and other mode switches) that reach it, but the
  agent's own full-access mode means the agent itself may not ask at all.
- FriedLiver answers for you only with an agent's one-time allow option whose
  name doesn't change the agent's mode or keep allowing ("bypass", "don't ask
  again", "always"…). Those options are never the highlighted button and say
  what they do.
- **Rules**: "Always allow" on a command adds a rule for the exact command, or
  for a program and its subcommand (`npm test` covers `npm test -- --watch`).
  A line with `;`, `&`, `|`, `<`, `>`, backticks, `$`, parentheses, braces, a
  backslash, a line break, a spelled-out invisible character or a leading
  `NAME=value` never matches any rule, and none is offered for it. Rules live
  in this workspace's storage in your profile, never in the repository, and
  **FriedLiver: Manage Permissions** lists and revokes them. A prefix rule
  allows any arguments after it, which can change what the program does; prefer
  exact rules for anything that writes.
- **"Always allow" beyond commands** remembers a website (its exact origin,
  e.g. `https://www.irctc.co.in`; never `file:`, `chrome:` or the like), a
  folder (the chosen folder and below, reading and changing separately, matched
  on the real path so `..` and symlinks can't leave it), or an agent-to-agent
  tool. It holds in every chat and after restarts, for every agent (Claude,
  Codex, Gemini, Claude Code outside FriedLiver), and answers the agent's own
  permission prompts with its one-time allow. Websites and tools are kept in
  your profile's global storage, folders and commands in this workspace's.
  Never offered or applied in read-only chats or inline edits. Allow once
  only: every dot file and folder directly in home (`~/.ssh`, `~/.aws`,
  `~/.claude`, `~/.codex`, `~/.gemini`, `~/.config`, `~/.npmrc`, `~/.netrc`,
  `~/.zshrc`…), all of `~/Library` (keychains, LaunchAgents, Application
  Support), system folders (`/etc`, `/Library`, `/System`, `/usr`), the
  FriedLiver app and its user data; and for writes, anywhere: every dotfile
  and anything in a dot-folder (`.git`, `.vscode`, `.husky`,
  `.github/workflows`, `.envrc`, `.mcp.json`, the agents' own settings…),
  `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `AGENTS.override.md`,
  `GEMINI.md`, `copilot-instructions.md` and `*.code-workspace` (Unicode NFC,
  ignoring case), and any name the OS could read as another (a trailing dot
  or space, `:` for an alternate data stream). Home and anything above it
  can't be always allowed. A browser action
  allowed by a website rule still checks the page's origin just before it acts.
  **FriedLiver: Manage Permissions** (also "Manage" on approval notifications)
  shows what, where, when and which agent asked, with Revoke and Revoke all.
- `friedliver.approvals.default` (ask or edits) is machine-scoped and read from
  your user settings only; a workspace value is ignored and logged.

### What a malicious repository can and can't do

It can:

- Put instructions in files that an agent reads. That can lead the agent to
  propose edits or commands, which you review.
- Run git hooks when you merge or commit a task's worktree, as any git
  checkout can. Like VS Code's own git integration, this needs a trusted folder.
- Use VS Code's own trusted-workspace features (tasks, launch configurations,
  extension recommendations). Workspace trust is that boundary. FriedLiver
  doesn't weaken it.

It can't:

- Run anything before you trust the folder.
- Pick the program FriedLiver runs as an agent. `friedliver.agents.*.command`
  and `.args` are machine-scoped and read only from your user settings, so a
  repository can't redirect an agent or the API key that goes with it.
- Let agents reach each other without asking you.
  `friedliver.connections.agentToAgent` is machine-scoped and read only from
  your user settings too.
- Lead agents out of the workspace through symlinks.
- Get a planted `claude-agent-acp.exe`, `node.exe` or `git.exe` run in place of
  the real one on Windows.
- Run a program through FriedLiver's own git calls via `core.fsmonitor`, or,
  for Review My Changes, through an external diff program or a textconv
  filter (`--no-ext-diff --no-textconv`).
- Choose which agent gets your code from Edit with Agent.
  `friedliver.edit.defaultAgent` is machine-scoped and read from your user
  settings only.
- Make agents run without asking. `friedliver.approvals.default` is
  machine-scoped and read from your user settings only, it can't be Full
  auto, and "Always allow" rules aren't settings at all.

### What a malicious agent can and can't do

Assume the agent's process is hostile: it can do anything you can do in a
terminal, and FriedLiver can't prevent that. Through FriedLiver itself it gets
no more than a well-behaved agent: approvals still apply, it gets only its own
vendor's key, it can't forge links in notifications, it reaches other chats
only through the FriedLiver tools and within your setting, its sign-in
arguments are checked, and its images and output are bounded.

### Data at rest

- **API keys** are kept in VS Code's SecretStorage (the OS keychain). On Linux
  without a keyring, VS Code may fall back to weaker storage (see its
  `password-store` option). A key is given only to its own vendor's agent
  process, as an environment variable, which other processes running as you
  can read. Keys are never logged, persisted elsewhere, or sent to a webview.
- **Gemini's Vertex AI settings** (project, location and an optional express
  key) are kept the same way, as one SecretStorage entry, and given only to
  Gemini. One key setup is kept per agent.
- **Vendor logins** are stored by each vendor's CLI in its own config folder.
  Sign-out goes through the agent's own ACP `logout` or its CLI, run in a
  terminal you see; FriedLiver never deletes those files.
- **Agents & Accounts** keeps, per agent in globalState, the last known
  sign-in: status, adapter version, the sign-in methods it offered, the name
  of the method last used, and the identity the agent reported (a plan label,
  an email address, an organization or a key source; never a key).
- **Chats** are saved per folder in VS Code's workspace storage
  (`chats.json`) while `friedliver.restoreChats` is on (the default): the last
  400 items of each chat, messages cut to 32 KB, command output to 8 KB, no
  images, at most 8 MB. Agent session IDs and task worktree paths are saved
  with them. API keys and bridge tokens never are. Turning the setting off
  deletes the file. Anything that was waiting when the window closed comes
  back closed, never approved.
- **Pending reviews and undo checkpoints** live in memory and are gone after a
  reload. A turn's git snapshot writes blob and tree objects into the
  repository's object store (unreachable, so `git gc` prunes them in time); it
  never touches the index, the stash or a branch. Task worktrees are git
  checkouts next to the repository.
- **Chats** also keep each session's settings (model, effort, mode) and the
  choices you made, so the next session applies them. Full auto is never saved.
- **globalState** keeps, per agent, the options its last session offered and
  your last choices (never Full auto). **workspaceState** keeps this
  workspace's "Always allow" rules.
- **The output channel** (FriedLiver Agents) logs agent commands, agent stderr
  and errors. It never logs keys.

### Network

FriedLiver itself contacts Open VSX (extensions, over HTTPS) and, every 4 hours,
`api.github.com` for the latest FriedLiver release. That check is an anonymous
GET and can be turned off with `friedliver.update.mode: off` or `update.mode:
none`. Installing an update downloads only over https from this repo's release
downloads (and GitHub's asset hosts, every redirect checked), and refuses a DMG
whose size or SHA-256 doesn't match the release's `SHA256SUMS.txt`. It runs only in the FriedLiver app. There is no telemetry. Agents talk
to their own vendors. The Agents extension listens on one port, on 127.0.0.1
only, for agents that reach the FriedLiver tools over HTTP ("The HTTP
endpoint" below). FriedLiver Remote, when you turn it on, listens on the LAN
and optionally Tailscale addresses ("FriedLiver Remote" above).

### Builds

Release builds come from GitHub Actions on `v*` tags and carry a
`SHA256SUMS.txt`. The build checks the Node toolchain against nodejs.org's
`SHA256SUMS.txt`, the `@vscode/ripgrep` package against upstream's lockfile
integrity, the ripgrep binaries against pins in `scripts/checksums.json`, and
the Linux .deb sysroot against upstream's `build/checksums/vscode-sysroot.txt`.
Release builds refuse unpinned downloads. Workflows run with a read-only token
by default and use actions pinned to commits. Only the release job and the
weekly upstream job can write. Builds aren't code-signed yet (see
docs/BUILD.md), so verify downloads against `SHA256SUMS.txt`.

### Agents reaching other agents

Chats can be connected (docs/CONNECTIONS.md): you hand a chat off, ask another
agent, pipe one chat's replies into another, or run a task on several agents.
Agents can do some of that themselves through FriedLiver's MCP server
(`friedliver`), with the tools `list_agents`, `list_chats`, `ask_agent`,
`send_to_chat` and `read_chat`. An agent that takes MCP servers over HTTP
(it says so in ACP's `agentCapabilities.mcpCapabilities.http`; Claude's,
Codex's and Gemini's adapters do) reaches them in the extension host itself
(`src/bridge/http.ts`); any other starts a tools server for each session
(`dist/bridge.js`), which talks to the extension host over a socket. Both
paths answer with the same code (`src/bridge/mcp.ts`) and end in the same
checks (`parseCall`, `src/host/bridgeRequests.ts`).

- **Your OK.** Under `friedliver.connections.agentToAgent: ask` (the default)
  only the two list tools answer directly. Asking an agent, messaging a chat and
  reading one wait for Allow, Allow for this chat, or Deny in the chat (and a
  notification when no chat is on screen). No answer in 10 minutes is a Deny.
  `off` gives sessions no FriedLiver tools at all and refuses calls from
  sessions that already have them. "Allow for this chat" lasts until the window
  closes and is never saved.
- **Who is asking.** Each chat gets a random 32-byte token, held in memory and
  passed only to that chat's session: in the tool server's environment, or as
  the `Authorization: Bearer` header of the session's HTTP server. The editor
  acts only as the chat a token belongs to, looks tokens up by SHA-256, and
  revokes a chat's token when the chat is removed.
- **The socket.** On macOS and Linux it's in a fresh `mkdtemp` directory under
  the temp folder, mode 0700, socket 0600. On Windows it's a named pipe with a
  random name; the token is what keeps other users out there. Every request is
  checked (tool, agent key, chat ID, text size). A line over 1 MB, a malformed
  request, an unknown token, or more than 1000 requests on one connection
  closes the connection.
- **The HTTP endpoint.** It listens on 127.0.0.1 only, on a random port, from
  the first session that uses it until the window closes, at
  `http://127.0.0.1:<port>/mcp`. Unlike the socket, other users on the machine
  can connect to a loopback port, so, as with the Windows pipe, the token is
  what keeps them out: a request without a known chat token gets 401 and the
  connection is closed. A web page can't use it either: the `Host` header must
  be `127.0.0.1:<port>` (or `localhost:<port>`), and an `Origin`, if there is
  one, the same, so DNS rebinding gets 403; and only a `POST` of
  `application/json` (which a page can't send across origins without a
  preflight the server never allows) to `/mcp` is read. A body over 1 MB, a
  path, content type or protocol version it doesn't know, and `GET` or
  `DELETE` (no server stream, no sessions) are refused. Headers must arrive
  within 10 s and the body within 30 s; a connection takes at most 1000
  requests and the server at most 128 connections. A tool call's answer
  streams as server-sent events, so a call that waits minutes for you or for
  another agent keeps its connection; when the agent hangs up, what the call
  waited for is cancelled, as when a tool server's socket closes.
- **No loops.** An agent can't reach its own chat, a busy chat, or a chat that
  waits on it (or that it waits on). Chats agents start may be at most
  `MAX_LINK_DEPTH` (2) steps from one you started. Pipes refuse cycles and pause
  after 20 forwards. Stopping a chat denies its pending requests and stops the
  consultations it waits on. A chat may have at most 3 requests waiting for you;
  further ones are refused, so an agent can't bury its chat in questions.
- **The token in the agent's hands.** The token reaches the tool server, or
  the agent's own MCP client for HTTP, through the session's MCP settings, so
  the agent process sees it either way and could talk to the socket or the
  port directly. That gives it nothing more: the same chat, the same checks
  and the same need for your OK. A token is worth nothing once its chat is
  removed or the window closes: the socket and port close with the window,
  and the next window makes new tokens.
- **What crosses.** A consulted agent gets the asking chat's title, an excerpt
  of its last reply and its changed files; a hand-off carries the transcript.
  Text from another agent is untrusted input for the agent that gets it, like
  a file in the repository: it may carry injected instructions, so every edit
  and command that follows still waits for your review in that chat. A reply
  you consult for yourself is shown, not sent to your agent, unless you
  forward it or set up a pipe. The consulted chat is an ordinary chat with the
  same path checks, `.git` refusal, notification text handling and update
  compaction as any other.

### FriedLiver Remote

FriedLiver Remote (docs/REMOTE.md, `src/remote/`) lets a paired phone control
agents over the network. That is the most exposed thing FriedLiver does, so it
is off by default (`friedliver.remote.enabled`, `application` scope, which a
workspace can't set) and starts only from the command.

**What it exposes, and where.**

- An HTTPS server in the extension host.
- It listens on these addresses and no others:
  - the Mac's private IPv4 addresses on Wi-Fi or Ethernet (RFC 1918);
  - with `friedliver.remote.tailscale`, the Tailscale 100.64/10 address.
- It never listens on `0.0.0.0`, `::`, loopback or a public address
  (`checkBindHost`). It skips VPN tunnels, VM, container and Apple
  peer-to-peer interfaces.
- It stops when the Mac's addresses change.
- There is no port forwarding, no UPnP, and no relay.
- TLS 1.2+. Certificates:
  - On the LAN: a per-install self-signed ECDSA P-256 certificate whose key
    lives in the editor's secret storage (the OS keychain).
  - On Tailscale: a real `tailscale cert` certificate when the tailnet allows
    it.

**Who may use it.**

- **Pairing.**
  - The QR carries the address plus `#c=<code>&f=<fingerprint>`. The fragment
    is never sent to a server.
  - The code is 128 random bits, valid for 2 minutes, used once, and
    replaced when the panel shows a new one.
  - A correct code then needs the Mac's OK, in a modal naming the phone and
    its address.
  - Only then does the phone get its own 256-bit token.
- **Tokens.**
  - The Mac keeps only the token's SHA-256 (globalState) and compares it in
    constant time against every stored hash.
  - Revocation is an append-only tombstone list (by id and hash). Every check
    reads it fresh, so a revoke holds in every window. A window holding a
    stale device list can't bring a device back, and `lastSeen` writes re-read
    the list and touch only that device.
  - Devices unused for 30 days expire.
- **Requests.** Every route except the app shell and pairing needs
  `Authorization: Bearer`. There are no cookies, so there is no CSRF.
- **WebSocket.**
  - It opens with a single-use, 30-second ticket from an authenticated
    request, so the token is never in a URL.
  - It only pushes "these chats changed"; data frames from the phone close
    it.
  - Revoking closes the device's sockets. Sockets of devices revoked in
    another window close within 25 seconds.

**What it may do.** Phone actions are parsed against a short list
(`parseRemoteAction`): send, stop, answer a permission, command, question,
review or agent request, Always allow, approval level, and new chat. Each goes
through the same core call the desktop makes, with these extra rules:

- **Only visible chats.** Only chats the phone may see (not inline edits, not
  read-only, not archived) and only requests still waiting in them.
- **Loosening needs the Mac.** Anything that loosens review or keeps allowing
  waits for a notification on the Mac naming the phone (`CoreUi.confirmRemote`).
  No answer in 2 minutes means no. That covers:
  - the Edits and Auto levels, every time, whatever the desktop confirmed
    earlier;
  - every Always allow, including command rules (instead of the desktop rule
    dialog);
  - any agent option other than the plain one-time yes;
  - "For this chat" on agent requests.
- **Revocation cancels pending OKs.** An OK that arrives after the phone was
  revoked does nothing, and a revoke answers every pending question no.
- **No defaults.** Levels set from a phone never become defaults for new
  chats, and a new chat from the phone can't start in Auto.
- **Slash commands.** A message starting with `/` (after any `@mention`)
  runs the agent's own command. Information-only ones go through. Ones that
  change permissions, approvals, modes or settings (`/permissions`,
  `/allowed-tools`, `/config`, `/approvals`, `/mode`, `/yolo`, `/settings`,
  `/plan`, `dangerously…`, `bypass…`) are refused. Every other command, listed
  or not, needs the Mac's OK naming the command.
- **Commands the phone can't show whole and plainly** (over 4,000 characters,
  or with control, bidi or zero-width characters) can only be denied there.
  The phone spells those characters out.

**Browser hardening.**

- Host must name the server exactly (DNS rebinding) and is checked before it
  goes into any header.
- Origin must be the page's own when present, and is required for pairing and
  the WebSocket.
- `Sec-Fetch-Site: cross-site` is refused.
- No CORS headers, ever.
- Strict CSP (`default-src 'none'`, scripts and styles only from the server,
  no third-party assets), plus `nosniff`, `no-referrer`, `DENY` framing,
  COOP/CORP and `no-store`.
- The phone renders untrusted text as text or as elements from the Markdown
  parser, never HTML, and links only to https.

**Denial of service.**

- 64 connections in all, 16 per address, and a 10-second TLS handshake limit.
- An address with five bad codes or tokens in a minute is locked out for five
  minutes, dropped before TLS. Requests without any token don't count, so a
  web page can't lock the phone out.
- The code burns after 30 bad guesses from anywhere.
- Bodies are limited to 256 KB.
- WebSocket frames from the phone are limited to 125 bytes; a phone that
  doesn't read is dropped past 256 KB buffered.

Threats considered:

| Threat | What stops it | What doesn't |
|---|---|---|
| **Stolen phone or token** | Revoke (or Revoke all) on the Mac kills the token in every window and closes its sockets. Loosening review still needs the Mac. The Mac is told the first time each phone is used in a session. | Until revoked, the token can read chats and do everything the phone can, including allowing one-time requests. Tokens live in the browser's localStorage for that origin. |
| **LAN attacker without a token** | Every route needs a token. Codes are 128-bit, single-use and live 2 minutes, and lockout follows failures. Pairing needs the Mac's OK. | Seeing that a server listens on a port. |
| **LAN man-in-the-middle at pairing** | The phone's browser warns about the certificate. The fingerprint in the QR and on the panel lets the user check the browser's certificate details before continuing. After that, the browser's exception is for that certificate only, so an interceptor's certificate warns again. | A browser can't pin a certificate from page script: the in-page fingerprint display proves nothing if the user continued past an interceptor's warning (its script would see the code and later the token). This is why REMOTE.md says to check before continuing, to stop on any later warning, and to use LAN mode only on trusted networks. Tailscale with `tailscale cert` (real certificate over WireGuard) avoids the problem. |
| **CSRF from a site the phone visits** | No cookies: the token is sent only by the app's own script, in a header. Cross-site requests are refused, and no CORS headers are sent. | |
| **DNS rebinding** | Exact Host check on every request and the WebSocket upgrade. Origin check. | |
| **Replay** | TLS. WebSocket tickets are single-use and expire in 30 s. Pairing codes are single-use. Actions name a request id that must still be waiting, so a replayed answer finds nothing. | A captured bearer token is reusable until revoked or 30 days unused (it is only ever sent over TLS). |
| **QR shoulder-surfing or a screenshot of the QR** | The code works once, for 2 minutes, and closing the panel cancels it. The Mac must approve the phone that redeems it. | Someone who scans it first and whom you then allow. |
| **A workspace turning Remote on** | `application` scope, read through `userSetting`, which ignores workspace values. | |
| **A planted `tailscale` binary** | Only fixed install paths, never PATH or the workspace, run with a fixed small environment. | `/opt/homebrew/bin` and `/usr/local/bin` are writable by the user. That isn't a privilege boundary, but anything that can write there already runs as you. |

Not verified on a real phone yet: camera scanning, the certificate warning and
fingerprint view on iOS and Android, Add to Home Screen, the keyboard over the
composer, reconnecting after sleep, and `tailscale cert` on the Mac App Store
build of Tailscale.

### Review of the bridge

The agent-to-agent bridge was built after the audit below and reviewed when it
was merged (FL-23). It has been exercised with the offline Demo agent only, not
yet with the vendors' agents. The tools server speaks MCP itself
(`src/bridge/mcp.ts`, about 150 lines) rather than through the MCP SDK, which
cost each session's server about 10 MB. It answers initialize, ping,
tools/list and tools/call, answers other requests with "method not found",
ignores notifications and malformed lines, checks each call with the editor's
own rules (`parseCall`) before passing it on, and drops input past 1 MB without
a line break. The HTTP endpoint (`src/bridge/http.ts`, about 180 lines) puts
the same answers on streamable HTTP; `test/http.test.ts` checks that it
answers byte for byte what the stdio server answers, and its refusals. The
MCP SDK's own HTTP client (the one Claude's and Gemini's adapters use) was
checked against it by hand; Codex's Rust client wasn't.

## Findings

Audit of 2026-10-16 (VS Code 1.142.0 base, Agents extension 0.1.2). Severity is
for a typical single-user desktop.

| ID | Severity | Area | Issue | Resolution |
|---|---|---|---|---|
| FL-01 | High | Settings | `friedliver.agents.{claude,codex,gemini}.command/args` had window scope. A trusted repository's `.vscode/settings.json` could swap an agent for any program, which then also got that vendor's stored API key. | Fixed. `machine` scope; the host reads only user and default values and logs an ignored workspace value. |
| FL-02 | High | Agent file access | Workspace containment was lexical only. A symlink in a repository let an agent read and write outside through ACP file reads and writes, "open file" and image collection. This includes dangling links and new files under linked folders. | Fixed. The real path is checked on every platform (the target, or the nearest existing folder, following dangling links). Writes and undo check again right before writing. |
| FL-03 | Medium | Agent file access | Agents could write into `.git`. A `core.fsmonitor` or hook runs on the next git command, which VS Code's git integration runs constantly, and nothing shows in a diff or a commit. | Fixed. Writes into `.git` folders and worktree `.git` files are refused. |
| FL-04 | Medium | Notifications | Agent, git and repository text in VS Code notifications (errors, questions, command lines) could form `[label](command:…)` links. VS Code opens those with commands allowed, so one click could run any editor command, such as typing into a terminal. | Fixed. Brackets in untrusted text are replaced with look-alikes, and the Run link approves only a command whose notification offers Run. |
| FL-05 | Medium | Command approval | The notification offered Run for a shortened command: paths cut to the program name (`/tmp/x/npm test` showed as `npm test`) and long lines cut off. Variables the agent set (`NODE_OPTIONS`, `PATH`, `LD_PRELOAD`) were shown nowhere. A relative `cwd` was displayed differently from the folder it ran in. Invisible or bidi characters could disguise a command. | Fixed. Run is offered only when the full command is shown. Variables are part of the approved line, `cwd` resolves against the session folder, and invisible characters are spelled out. |
| FL-06 | Medium | Install action | The webview supplied the command that was typed into a terminal, and a line break in it would have run it. | Fixed. The action carries only the agent's key; the host uses its own constant command, plain characters only, sent without a newline. |
| FL-07 | Medium (Windows) | Process launch | Arguments for npm `.cmd` wrappers were quoted with `\"`, which cmd.exe ignores. An argument containing `" & … & "` or `%VAR%` could run other commands or expand variables. | Fixed. cmd.exe metacharacters are escaped with `^`, twice for batch files, and line breaks are refused. Tested against a model of cmd.exe parsing. |
| FL-08 | Medium (Windows) | Process launch | Binary planting. An agent missing from PATH was started by bare name with the workspace as its folder, and Windows looks in that folder first. npm wrappers start `node` by bare name, and git and taskkill were started by bare name too. | Fixed. Unresolved names are never started. Relative PATH entries are skipped. `NoDefaultCurrentDirectoryInExePath=1` is set for agents and terminal sign-in. Git is resolved on PATH, and taskkill and cmd are started from System32. |
| FL-09 | Medium | Updates | There was no update path, so people stayed on old builds. | Fixed. A release check in the app every 4 hours with a checksum-verified macOS install, a weekly pull request when VS Code has a new stable release (`upstream.yml`), and GitHub releases with checksums for `v*` tags. |
| FL-10 | Medium | CI | Workflows used the default token permissions, left credentials in `.git/config`, ran actions from floating tags and pasted values into scripts. Dependencies had no update automation. | Fixed. Read-only by default, with write only for the release and upstream jobs. `persist-credentials: false` where nothing is pushed. Actions are pinned to commits, scripts read values from variables, Dependabot is on, and release builds use no cache. Tests guard all of this. |
| FL-11 | Medium | Build supply chain | The Node toolchain, the `@vscode/ripgrep` package and the ripgrep binary were downloaded without integrity checks, and a file already in the shared temp folder was trusted. | Fixed. Node is checked against `SHASUMS256.txt`, the package against lockfile integrity, and the binaries against SHA-256 pins (required for release builds). A cached file must match its pin. |
| FL-12 | Low | Images | An agent-supplied MIME type went into `data:` URIs unchecked, with no size limit. Image files were read before their size was checked. | Fixed. Allowlisted image types, base64 only, a size cap, and `stat` before reading. SVG is only shown through `<img>`, which a test enforces. |
| FL-13 | Low | Memory | An agent could choose an unbounded terminal output limit. Transcripts grew without bound, image data went to every webview, and agents could read huge files or FIFOs. | Fixed. Caps (16 MB output, 512 KB per reply, 2,000 items per chat, 64 MB reads, regular files only), and media data stripped from webview updates. |
| FL-14 | Low | Sign-in | Agent-supplied arguments and variables for its terminal login were used verbatim: they could override the API key, load code (`NODE_OPTIONS`, `LD_PRELOAD`) or include line breaks. Sign-in links were offered for any allowlisted host, for any agent. | Fixed. Arguments are checked, unsafe variables dropped, and the user's own settings win. Links are offered only on the signing-in vendor's hosts, without credentials. |
| FL-15 | Low | Agent routing | Sessions were looked up by session ID alone. Two agents with the same ID mixed up their chats, and one agent could post into, or pose as, another agent's chat. | Fixed. Sessions are keyed by agent and session ID. |
| FL-16 | Low | Git | A repository-configured `core.fsmonitor` ran on FriedLiver's own git calls, and paths weren't preceded by `--`. | Fixed. `-c core.fsmonitor=false` and `--`. Hooks still run on task commit and merge (accepted: that's normal git behaviour, behind workspace trust). |
| FL-17 | Low | Webview input | Permission answers weren't checked against the offered options. The webview `<title>` wasn't escaped. | Fixed. |
| FL-18 | Accepted | Extensions | Patch 0040 turns off extension signature verification, because the verifier (`@vscode/vsce-sign`) is Microsoft-only. | Accepted. Downloads come only over HTTPS from Open VSX. Open VSX's list of malicious extensions applies through `controlUrl`, and publisher verification shows in the UI. Revisit when an open verifier for Open VSX signatures exists. |
| FL-19 | Accepted | Agents | Agent processes aren't sandboxed. | Accepted by design. Documented above; install only agents you trust. |
| FL-20 | Accepted | Demo agent | The offline Demo agent ships in the app. | Accepted. It has no network access and no keys, and goes through the same review and approval paths. Its terminal-login mode (a marker in the temp folder) is reachable only from tests. |
| FL-21 | Info | Platform defaults | Checked: workspace trust stays on by default, and no patch touches the renderer sandbox or context isolation. Telemetry is off, the update service is absent, and product.json uses HTTPS only with a minimal link-protection list. `--no-sandbox` appears only in `dev.mjs` (as root) and test tooling. `webviewContentExternalBaseUrlTemplate` (Microsoft's CDN) only matters for web and server builds, which FriedLiver doesn't ship. | No change needed. |
| FL-22 | Accepted | Residual | There is a short gap between the path check and the write, which a process you approved could use to swap a link. On Windows, terminal commands you approve still find programs in their folder, as cmd.exe always does. The extension host's environment reaches agents. | Accepted. These need a process you already allowed, or they are standard platform behaviour. |
| FL-23 | Low | Agent-to-agent bridge | Reviewed at merge: per-chat tokens, socket permissions, request checks, approval, loop and depth limits hold. Under "ask", an agent could leave any number of requests waiting in its chat. | Fixed. At most 3 waiting per chat; more are refused with a message to the agent. |
| FL-24 | High | Approvals (APR-2) | FriedLiver's diff review, command cards, "Changed N files" and Undo ran only for writes and commands routed through ACP `fs/write_text_file` and `terminal/create`. Claude and Codex use neither: their edits and commands happened in their own process, after a permission card that showed only a title (or no card, in Codex's default "Auto review" mode). The docs promised a diff for every write. | Fixed. A permission request is merged with the tool call it names and shows the diff (with the whole proposed file, read-only), the command and its folder, or the plan. Every turn gets a git checkpoint in a temporary index (outside git, the content seen before each request), so changes and Undo cover every agent. FriedLiver sets each agent's mode from the chat's level at session start and shows the mode the agent reports. The docs now say per agent what FriedLiver controls. |
| FL-25 | Medium | Auto-approve | New approval levels and "Always allow" rules let agents act without asking. A repository could try to turn them on, a rule could be stretched with chained commands, and an auto-answer could pick an option that changes the agent's mode for good. | Contained. The default level is machine-scoped, user settings only, and can't be Full auto. Full auto is per chat, confirmed once, shown in red everywhere, and never restored after a reload; FriedLiver still asks for outside-workspace commands and plans that reach it. Rules match only plain lines (no chaining, redirection, substitution, variables or invisible characters), live in your profile's workspace storage, and can be listed and removed. Auto-answers use only one-time allow options that don't escalate. Auto-accepted edits stay undoable. |
| FL-26 | Low | Notifications | Command approvals were progress notifications whose only button, Cancel, denied the command, and that showed even with the card on screen; questions from a chat in another view got none. | Fixed. Real buttons (Run only for a command shown in full, Deny, Show), only when that chat isn't on screen or the window isn't focused; dismissing decides nothing; a late button press after the decision was made elsewhere does nothing; several waiting decisions collapse into one "N decisions waiting". |
| FL-27 | Low | Setup | The install lines pointed at the deprecated `@zed-industries/*` adapters, frozen at old versions (Claude's lists "Yes, and bypass permissions" first after a plan). | Fixed. `@agentclientprotocol/claude-agent-acp` and `@agentclientprotocol/codex-acp`; Accounts shows the adapter version and says when to update. |
| FL-28 | Low | Agents & Accounts | The new accounts page takes messages from a webview that can sign in, sign out, save keys, type lines into terminals and change defaults. A page could have been made to name another agent's method, run its own command line, read a stored key, or set a mode as a default. | Contained. Every message is checked (`parseAccountsMessage`): an agent from the fixed list (Demo only when shown), a method id the agent itself offered at its last check, a key setup that agent has, a terminal line by name only (FriedLiver's own install, sign-in and sign-out constants, plain characters only, run when you press Run in terminal), and only a model or effort its last session offered. Keys are asked for in the editor's own password boxes and stored in SecretStorage; the page gets only "set"/"not set". An agent's `_auth/status_update` is reduced to a known kind and short one-line texts and only shown. `friedliver.showDemoAgent` and the agent commands stay `machine` scope, read from user settings only. |
| FL-29 | Medium | Remote | A phone could switch a chat to Edits (auto-accept) without the Mac's OK; only Auto was gated, and a phone's level could become the default. | Fixed before merge. Edits and Auto from a phone confirm on the Mac every time, naming the phone. Phone levels never save defaults. |
| FL-30 | Medium | Remote | Paired devices were held in memory per window, so a revoke in one window didn't reach another, and a stale `lastSeen` write could bring a revoked device back. | Fixed before merge. The list is read fresh on every check, with append-only tombstones by id and hash. `lastSeen` re-reads the list before writing. Sockets of devices revoked elsewhere close at the next check. |
| FL-31 | Medium | Remote | "For this chat" on agent requests, and agent options named like "Yes, for this session" (one-time allow by kind), kept allowing without the Mac's OK. | Fixed before merge. Only the plain one-time yes skips the Mac; every other allow confirms. |
| FL-32 | Medium | Remote | The server bound every private interface, including VPN tunnels and VM or container bridges, and kept listening after a network change. | Fixed before merge. Those interfaces are skipped, and the server stops when the addresses change. |
| FL-33 | Low | Remote | Unauthenticated sockets had no cap or handshake timeout. Tokenless requests (a web page's `<img>`) counted toward lockout. There was no WebSocket backpressure. | Fixed before merge. 64/16 connection caps, a 10 s handshake limit, lockout before TLS, tokenless and cross-site requests refused without counting, and a 256 KB write buffer. |
| FL-34 | Low | Remote | The phone could approve commands it showed clipped or with hidden characters. An OK given on the Mac after a revoke still applied. Pairing needed no OK on the Mac. Use over HTTP alone went unnoticed. | Fixed before merge. Approve such commands on the Mac. OKs check the device is still paired, and revoking refuses pending ones. Each pairing needs a modal OK, and the Mac is told on each phone's first use. |
