# Connections between chats and agents

Any chat can work with any agent: Claude, Codex (GPT), Gemini, Antigravity or the offline
Demo. A chat can hand its work to another agent, ask one a question, feed
its replies to another chat, or run the same task on several agents at once.
Agents can also reach each other themselves, through FriedLiver's own tools,
but only when you allow it.

The host side lives in `extensions/friedliver-agents/src/host/`
(`connections.ts`, `bridgeRequests.ts`, `bridge.ts`) and
`src/bridge/server.ts`. The shapes the webviews see are in
`src/shared/model.ts`: `ChatLink`, `LinkItem`, `BridgeItem`.

## What each connection does

| In the UI | What happens | Spends a turn? |
|---|---|---|
| **Hand off** | A new chat for the agent you pick, in the same folder (or the same task worktree). It starts from the old chat's transcript: your messages, the agent's replies (trimmed), the latest plan, the commands with their exit codes, and the files changed. | No. The transcript goes in front of the first message you send there. |
| **Ask** | Your question goes to another agent, with a short brief: the asking chat's task, an excerpt of its last reply, the files it changed. The answer shows in your chat. Asking the same agent again continues the same consultation. | One turn in the consulted chat. |
| **@gemini …** | The same as Ask. A message that starts with `@claude`, `@codex`, `@gpt`, `@gemini`, `@antigravity` (or `@agy`) or `@demo` goes to that agent instead of this chat's. A mention later in the text is just text. | One turn in the consulted chat. |
| **Pipe to** | From now on, each reply that finishes in this chat is sent to the other chat as a message. If the other chat is busy, the newest reply waits until it is idle. | One turn in the other chat per reply. |
| **Forward** | Sends this chat's last reply to another chat once, e.g. a consultant's answer back to the main chat. | One turn in the other chat. |
| **Run on several agents** | One chat per agent you pick, all given the same message at once, shown side by side on the board. With "Own worktree" each gets its own git worktree and branch, so their edits never mix. | One turn each. |

Every message that crosses shows in both chats, with the other chat's name.
The consulted chat is an ordinary chat: you review its edits and approve its
commands there, as anywhere else. A chat another one starts (a consultation,
a hand-off) begins at your default approval level, never Full auto, whatever
the chat that started it uses.

Commands in the palette (category FriedLiver): **Hand Off to Another Agent**,
**Ask Another Agent**, **Run a Task on Several Agents**, **Pipe a Chat's
Replies to Another Chat**.

## Limits that keep chats from running away

- A pipe that would close a loop (A to B while B already reaches A) is
  refused.
- A pipe pauses after 20 forwards and says so. Pipe it again to continue.
- Fan-out without "Own worktree", or in a folder that isn't a git repository,
  runs every agent in the same folder. The chats say so; the board warns when
  two chats change the same file.

## The agent tools

Each agent session gets an MCP server named `friedliver`. Agents that take
MCP servers over HTTP (Claude's, Codex's and Gemini's adapters say so when
they start) reach it in the editor itself, at `http://127.0.0.1:<port>/mcp`;
other agents start `dist/bridge.js` with the editor's own runtime for each
session, about 19 MB a chat. Its tools:

| Tool | What it does | Needs your OK under "ask" |
|---|---|---|
| `list_agents` | The agents FriedLiver can start. | No |
| `list_chats` | The open chats: id, agent, task, busy or idle. | No |
| `ask_agent {agent, prompt, chat_id?}` | Asks another agent and waits for the answer. Without `chat_id` it continues the consultation this chat already has with that agent, or starts one. | Yes |
| `send_to_chat {chat_id, message}` | Gives another chat a message and returns at once. | Yes |
| `read_chat {chat_id, last?}` | The latest messages of another chat (10 by default, 50 at most). | Yes |

When an agent asks, the chat shows the request with **Allow**, **Allow for
this chat** and **Deny**, and it counts as a decision in the status bar and on
the board. If no chat view is on screen, a notification asks too. Nobody
answering for 10 minutes counts as Deny. A denied call returns an error the
agent can read, and it carries on without it.

## The setting

`friedliver.connections.agentToAgent`, machine scope, so a repository's own
settings can't change it:

- `ask` (default): list tools answer directly; the others wait for you.
- `allow`: every tool call goes ahead. The chat still records each one.
- `off`: sessions get no FriedLiver tools at all.

The setting applies to agent sessions started after the change. Switching to
`off` also refuses calls from sessions that already have the tools.

## Safety rules

- Agents reach other agents and chats only through these tools, never
  directly, and only within the policy above. See SECURITY.md, "Agents
  reaching other agents", for the threat model.
- Each chat has its own random 32-byte token. The tool server passes it with
  every request (over HTTP, the agent sends it as `Authorization: Bearer`),
  and the editor acts only as the chat that token belongs to. Tokens live in
  memory and are never saved.
- The editor listens on a local socket: on macOS and Linux in a fresh
  directory under the temp folder that only you can open (0700, the socket
  0600); on Windows a named pipe with a random name. Malformed requests,
  unknown tokens, lines over 1 MB and more than 1000 requests on one
  connection close the connection. Over HTTP it listens on 127.0.0.1 only,
  refuses any other Host or Origin, any body over 1 MB, and any request
  without a chat's token (SECURITY.md has the details).
- An agent can't ask itself, a chat that is waiting on it (or that it waits
  on), or a busy chat. Agents can start chats only 2 steps away from a chat
  you started (`MAX_LINK_DEPTH`), so they can't keep spawning each other.
- Stopping a chat denies what it still has waiting and stops the
  consultations it is waiting on.

## Saved chats

`friedliver.restoreChats` (default on) saves the chats of each folder in the
editor's storage for that folder, about a second after each change, and
brings them back when the window opens again. Each chat keeps its last 400
items; messages are cut to 32 KB and command output to 8 KB; images are not
saved. API keys and tokens never are. Anything that was waiting when the window closed (a
question, a review, a command, a tool request) is closed and marked "Stopped
when the window closed". A restored chat continues in its old agent session
when the agent can reload it, and otherwise starts a new session and says so;
either way its model, effort and approval level are applied again (Full auto
comes back as Ask). Messages that were queued aren't saved.
Turning the setting off deletes the saved chats.

## The browser

**FriedLiver: Open Browser** (the globe in the Agents view's title bar, or the
command palette) opens the editor's integrated browser on the right. It never
opens by itself: only that command, or an agent's `browser_open` you allow.

- It is VS Code 1.142's own integrated browser: an Electron `WebContentsView`
  shown as an editor tab, reached through the `browser` API proposal (enabled
  for this extension in `product.json`). Pages load as top-level pages, so
  X-Frame-Options and CSP `frame-ancestors` don't block them, and web
  security stays on. No core patch is needed.
- Cookies and storage live in the integrated browser's own persistent
  session (`workbench.browser.dataStorage`, `global` by default), separate
  from your system browser.
- It opens in the second editor group at the width you last left it,
  between 40% and 70% of the window. Drag the sash to change it; FriedLiver
  remembers it and pulls it back inside those bounds when the groups change.
- **FriedLiver: Switch Between Code and Agent Chat** (Ctrl/Cmd+Alt+A) swaps
  the left group between your last code editor and the agent chat. Cmd/Ctrl+B
  still toggles the file side bar.
- `friedliver.browser.relaxLocalhostCors` (default off, user settings only)
  adds permissive CORS headers, and answers preflights with 204, for
  responses from `localhost`, `127.0.0.1` and `[::1]` in this browser only,
  through CDP's Fetch domain on pages FriedLiver is attached to.

### Browser tools

| Tool | What it does | Needs your OK |
|---|---|---|
| `browser_open {url}` | Opens an http/https URL (bare `localhost:3000` works) and waits for the load | Yes, unless the chat is on Full auto |
| `browser_snapshot` | Title, URL, the links/buttons/fields with a selector each, and the visible text (password values never) | No |
| `browser_click {selector \| text}` | Clicks with real mouse events | Yes, unless Full auto |
| `browser_type {selector, text}` | Replaces a field's text | Yes, unless Full auto |
| `browser_screenshot` | Saves a PNG in a private per-session folder under the extension's storage and returns its path | No |
| `browser_console` | The last 100 console messages and uncaught errors | No |
| `browser_back`, `browser_reload` | History back, reload | Yes, unless Full auto |

`file:`, `chrome:`, `devtools:`, `javascript:`, `data:` and every other
scheme are refused before anyone is asked. The `friedliver.connections.agentToAgent`
setting still applies: `off` removes these tools with the others. "Allow for
this chat" on a browser request allows later browser actions in that chat,
not agent-to-agent requests (and the other way round).

Claude, Codex and Gemini get these tools with the rest of the `friedliver`
server.

### Claude Code (extension or CLI) outside FriedLiver chats

The separate Claude Code VS Code extension, and `claude` run in FriedLiver's
terminal, reach the browser tools (and only those) through an MCP server named
`friedliver-browser`:

- It is opt-in: `friedliver.browser.externalClients` is off by default, and
  until you turn it on (or run **FriedLiver: Connect Claude Code to the
  browser**, which turns it on) FriedLiver writes nothing to `~/.claude.json`.
- On start, with `friedliver.browser.externalClients` on, FriedLiver
  mints a random 256-bit token for this launch and writes `{url, token}` to
  `<globalStorage>/external/browser-token.json` (0600, in a fresh 0700 folder;
  deleted again when the window closes). It then sets
  `mcpServers["friedliver-browser"]` in `~/.claude.json` to a **stdio** entry:
  `{type: "stdio", command: <FriedLiver's runtime>, args:
  [<extension>/dist/externalStdio.js, <token file>], env:
  {ELECTRON_RUN_AS_NODE: "1"}}`. The entry holds no token and no port, so it
  stays registered; an older http-style entry (token and port inline) is
  removed first. Nothing else in the file changes; the old file is kept as
  `~/.claude.json.friedliver-backup`, and the new one is written to a temp file
  and renamed (through a symlink, if it is one).
- `externalStdio.js` reads the token file (which also holds FriedLiver's pid)
  on every request; a dead pid means no network call at all. Before the first
  message to a url+pid it does a body-less handshake: the server must sign the
  client's nonce with the token, or nothing is sent. It never sends the token: it signs a fresh nonce and its session id with it (HMAC-SHA256), and
  forwards an answer only if the server signs the nonce back. A process that
  took over a stale port learns nothing and its answers are dropped. No file, no
  server, or a wrong proof gives "FriedLiver isn't running".
- The server is the same 127.0.0.1-only HTTP server the chats use, with the
  same Host/Origin checks. The external client gets the `browser_*` tools only
  (not `system_*`: the computer itself stays with FriedLiver's own chats);
  anything else is "not found". Its token is refused as a plain bearer, and
  used nonces are refused.
- Every action (open, click, type, back, reload) asks with a non-modal popup
  that says what and where, e.g. "Claude Code wants to click in the browser:
  http://localhost:3000: click "Sign in"" (agent text cleaned of control
  characters and cut at ~120 characters; text typed into a password field is
  never shown). Allow, Allow for this session, Deny. "Allow for this session"
  covers that Claude Code session on that origin only: a new session or another
  site asks again. Full auto in a chat does not cover Claude Code; only
  `friedliver.browser.externalAutoApprove` (default off) does. The URL rules,
  the own-tab-only rule and `agentToAgent: off` apply as for chats.
- **FriedLiver: Connect Claude Code to the browser** turns the setting on (if
  it isn't), does this again and says what happened. Start a new Claude Code
  session afterwards to pick up the server. Turning `externalClients` off
  revokes the token and removes the file and the entry FriedLiver added (only
  that one: a `friedliver-browser` server set up some other way is left alone,
  and FriedLiver won't overwrite it either).
- Both settings are read from your user settings only.
