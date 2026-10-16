# Connections between chats and agents

Any chat can work with any agent: Claude, Codex (GPT), Gemini or the offline
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
| **@gemini …** | The same as Ask. A message that starts with `@claude`, `@codex`, `@gpt`, `@gemini` or `@demo` goes to that agent instead of this chat's. A mention later in the text is just text. | One turn in the consulted chat. |
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

Each agent session gets an MCP server named `friedliver` (`dist/bridge.js`,
started with the editor's own runtime). Its tools:

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
  every request, and the editor acts only as the chat that token belongs to.
  Tokens live in memory and are never saved.
- The editor listens on a local socket: on macOS and Linux in a fresh
  directory under the temp folder that only you can open (0700, the socket
  0600); on Windows a named pipe with a random name. Malformed requests,
  unknown tokens, lines over 1 MB and more than 1000 requests on one
  connection close the connection.
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
