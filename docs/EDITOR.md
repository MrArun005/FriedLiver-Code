# Agents in the editor

You can work with an agent from the file you're editing, not just from the
chat panel. These commands still use ordinary chats, with the chat's
approval level: in Manual (the default) every write through FriedLiver is a diff
you accept or reject, and every command or edit an agent asks permission for
waits for you, the same as in the panel (README: "What FriedLiver controls for
each agent"). They need only the stable VS Code API, so they also work when
the extension is installed in VS Code or Antigravity.

| Command | Where | What happens |
|---|---|---|
| **Edit with Agent** | Ctrl/Cmd+I in a file, right-click menu, a problem's quick fix | You describe the change. The agent's edit opens as a diff in the same editor group, focused. Accept with Ctrl/Cmd+Alt+Y, reject with Ctrl/Cmd+Alt+N. |
| **Ask About Selection** | Right-click menu, palette | Your question goes to the current chat with the code attached. The chat opens. |
| **Add Selection to Chat** | Right-click menu, palette | The code goes into the chat's message box as a chip. Nothing is sent yet. |
| **Review My Changes** | Source Control title bar, palette | Your uncommitted changes go to the agent you pick, in a new chat named "Review: \<branch\>". |
| **Fix with Agent** | Light bulb on an error or warning | Runs Edit with Agent with the problem's message as the instruction. |
| **Explain with Agent** | Light bulb on a selection | Runs Ask About Selection with "Explain this code." |

## Edit with Agent

1. Select code, or leave the cursor where it is. Without a selection the
   agent gets the function around the cursor (from the language's outline),
   or the cursor's line if no function is found.
2. Describe the change. The box's title shows which agent will do it. Start
   with `@claude`, `@codex`, `@gemini` or `@antigravity` to pick another one, or use
   the button in the box. Otherwise you get the agent you last used for edits
   in this folder. Before you pick one, it's `friedliver.edit.defaultAgent`
   (Claude unless you change it).
3. If the file has unsaved changes, it is saved first, so the diff compares
   against what you see.
4. While the agent works, the status bar shows "Claude is editing
   format.ts…" and the lines get a light background. Click the status bar
   item to stop the agent. If the agent asks you something on the way (a
   permission, or a FriedLiver tool request), its chat opens so you can
   answer.
5. The edit opens as a diff where you are looking. If the agent replies
   without editing (you asked a question, or it couldn't start because it
   isn't installed or signed in), its chat opens instead.

The agent gets the file's path relative to its folder, the language, the
lines (with the exact selection), the code, and five lines before and after.
It is told to change only what you ask for, and only in that file, unless
you say otherwise. Long selections are cut at 24,000 characters, and the
agent is told to read the file for the rest.

Each agent keeps one chat for its edits, so it remembers the earlier ones.
Each request shows there as a message, with the code as a chip, and the chat
is named after the latest instruction. If that chat is busy, the next edit
starts a new one. These chats appear in the Agent Manager like any other, so
you can open one, continue it or hand it off.

## Code references

A message that carries code from the editor shows a chip such as
`format.ts:12–18`. Click it to open the file with those lines selected. The
agent gets the lines as they are when you send (unsaved edits included), as a
fenced block headed `src/format.ts:12-18`.

## Review My Changes

FriedLiver collects the repository's staged and unstaged changes as one diff
against the last commit, plus the list of changed files, including untracked
ones. The agent is asked to review them, most important first, with file and
line, and not to change anything yet. Say "fix it" in that chat and it makes
the changes as ordinary reviewed edits. Diffs over 150 KB are cut, and the
agent reads the remaining files itself. In a folder that isn't a git
repository, or with nothing changed, it says so and stops.

The diff runs with external diff programs and textconv filters turned off
(`--no-ext-diff --no-textconv`), and with `core.fsmonitor` off, so a
repository's git config or `.gitattributes` can't make FriedLiver run a
program.

## Settings

| Setting | Scope | What it does |
|---|---|---|
| `friedliver.edit.defaultAgent` | machine (user settings only) | The agent for Edit with Agent until you pick one in a folder. A repository's `.vscode/settings.json` can't change it, so it can't choose which vendor gets your code. |

Ctrl/Cmd+I is bound only in a text editor for a file, and only while no other
inline chat claims the key (`!inlineChatHasProvider &&
!inlineChatHasEditsAgent`). In an editor whose own inline chat is on (VS Code
with Copilot, for one), Ctrl/Cmd+I stays with that, and Edit with Agent is in
the right-click menu and the palette. Rebind it under Keyboard Shortcuts if
you prefer.

## For developers

| File | What |
|---|---|
| `extensions/friedliver-agents/src/host/editor.ts` | The commands, the input boxes, progress, decorations and code actions |
| `src/host/editorPrompt.ts` | The text an agent gets: edit requests, references, @mention parsing, caps |
| `src/host/editFlow.ts` | Which chat an edit goes to, and what came of its turn |
| `src/host/gitChanges.ts` | The working tree's changes and the review request |
| `src/webview/refs.tsx` | Code reference chips |
| `agent-core/demo/editorRequests.mjs` | The tests' fake agent's side |

What changed in the shared contract (`src/shared/model.ts`, `messages.ts`)
is additive. Older views and saved chats work as before:

- `CodeRef { path, startLine, endLine }` and an optional `refs` on user items.
- An optional `refs` on the webview's `send` message, and optional
  `line`/`endLine` on `openFile`.
- A new host message, `addRef`, that puts a reference into a composer.
- `AgentCore.send()` takes optional `{ refs, context, title }`. `context` goes
  to the agent in front of the message but isn't shown in the chat.
