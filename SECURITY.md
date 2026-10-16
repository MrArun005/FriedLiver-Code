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

- **You.** Every edit an agent proposes and every command it asks to run waits for you.
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
- Propose a write. It opens as a diff and is written only if you accept, with
  the content you leave in the diff. You can undo the latest turn.
- Ask to run a command. It runs only after you approve it. You see the whole
  command line, including any environment variables the agent sets, with
  invisible and direction-changing characters spelled out.
- Ask you a question, send images, and start a sign-in for its own vendor.

Through FriedLiver an agent can't:

- Read or write outside the workspace, including through symlinks (a cloned
  repository's `keys -> ~/.ssh`, dangling links, or links to folders that
  don't exist yet). Paths are checked by real location, and checked again just
  before writing.
- Write into a `.git` folder, whose config and hooks run programs.
- Run a command without your approval, or get a Run button for a command the
  notification doesn't show in full.
- Put a link that runs editor commands into a notification.
- Read another agent's chat, post into it, or pose as that agent.
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
terminals). It can't stop the agent's own process from reading files,
writing files or using the network directly. Install only agents you trust,
and treat their vendors' own permission settings as part of your setup.

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
- Lead agents out of the workspace through symlinks.
- Get a planted `claude-agent-acp.exe`, `node.exe` or `git.exe` run in place of
  the real one on Windows.
- Run a program through FriedLiver's own git calls via `core.fsmonitor`.

### What a malicious agent can and can't do

Assume the agent's process is hostile: it can do anything you can do in a
terminal, and FriedLiver can't prevent that. Through FriedLiver itself it gets
no more than a well-behaved agent: approvals still apply, it gets only its own
vendor's key, it can't forge links in notifications or reach other agents'
chats, its sign-in arguments are checked, and its images and output are bounded.

### Data at rest

- **API keys** are kept in VS Code's SecretStorage (the OS keychain). On Linux
  without a keyring, VS Code may fall back to weaker storage (see its
  `password-store` option). A key is given only to its own vendor's agent
  process, as an environment variable, which other processes running as you
  can read. Keys are never logged, persisted elsewhere, or sent to a webview.
- **Vendor logins** are stored by each vendor's CLI in its own config folder.
- **Chats, pending reviews and undo checkpoints** live in memory and are gone
  after a reload. Task worktrees are git checkouts next to the repository.
- **The output channel** (FriedLiver Agents) logs agent commands, agent stderr
  and errors. It never logs keys.
- **globalState** holds the update check's last-check time and the last
  version it announced.

### Network

FriedLiver itself contacts Open VSX (extensions, over HTTPS) and, once a week,
`api.github.com` for the latest FriedLiver release. That check is an anonymous
GET and can be turned off with `friedliver.updates.check` or `update.mode:
none`. It runs only in the FriedLiver app. There is no telemetry. Agents talk
to their own vendors.

### Builds

Release builds come from GitHub Actions on `v*` tags and carry a
`SHA256SUMS.txt`. The build checks the Node toolchain against nodejs.org's
`SHA256SUMS.txt`, the `@vscode/ripgrep` package against upstream's lockfile
integrity, and the ripgrep binaries against pins in `scripts/checksums.json`.
Release builds refuse unpinned downloads. Workflows run with a read-only token
by default and use actions pinned to commits. Only the release job and the
weekly upstream job can write. Builds aren't code-signed yet (see
docs/BUILD.md), so verify downloads against `SHA256SUMS.txt`.

### Not reviewed yet

The **agent-to-agent bridge** (hand-offs, consultations, pipes, and agents
reaching other chats through the FriedLiver tools) is being built in parallel
and gets its own review once it's merged. That review covers instructions
passing from one agent to another, which chats an agent may read, approval for
every link an agent makes, the `MAX_LINK_DEPTH` limit, and that the new code
uses the same path checks, notification text handling and update compaction.

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
| FL-09 | Medium | Updates | There was no update path, so people stayed on old builds. | Fixed. A weekly release check in the app, a weekly pull request when VS Code has a new stable release (`upstream.yml`), and GitHub releases with checksums for `v*` tags. |
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
