# Try it with the real agents

A 10-minute check on your own machine, with your own Claude, Codex, Gemini or
Antigravity accounts. Everything here was tested with a fake stand-in agent only, so this is
the first run against the real ones. Note what happens at each step;
anything marked "Report" is worth sending back, with a screenshot if you can.

## 1. Install (2 minutes)

1. Download the installer for your system from the latest release on the
   repository's **Releases** page: `FriedLiver-darwin-arm64-<version>.dmg`,
   `FriedLiverUserSetup-x64-<version>.exe` or `friedliver_<version>_amd64.deb`.
2. Install it. Windows: **More info → Run anyway** (the build isn't signed
   by Microsoft). macOS: open it once, then **System Settings → Privacy & Security →
   Open Anyway**.
3. Start FriedLiver and open a small project folder you don't mind agents
   editing (a git repository works best, so you can see and undo changes).

Report: anything other than the Agents panel on the right with "Start a chat".

## 2. Sign in to one real agent (3 minutes)

Install the agent's command line tool once, in a terminal:

| Agent | Install |
|---|---|
| Claude | `npm install -g @agentclientprotocol/claude-agent-acp` |
| Codex | `npm install -g @agentclientprotocol/codex-acp` |
| Gemini | `npm install -g @google/gemini-cli` |
| Antigravity (macOS only) | `curl -fsSL https://antigravity.google/cli/install.sh \| bash` |

If you installed `@zed-industries/claude-agent-acp` or `@zed-industries/codex-acp`
before, install the new package instead: the old ones are deprecated and
Claude's has no effort option.

Then in FriedLiver: **FriedLiver: Agents & Accounts** (command palette, the
Accounts view's title, or **Agents & Accounts…** in the New chat menu) →
**Check** on the agent's card → one of its sign-in buttons, or **Set…** for an
API key (Gemini also has Vertex AI; FriedLiver offers no Google-account
sign-in for Gemini). Claude's subscription login opens a terminal: approve on
claude.ai and it closes. Codex (ChatGPT) opens your browser. Antigravity signs
in from its own CLI: run `agy` in a terminal, choose Google OAuth, then `/quit`. The card shows "Signed in", the adapter version,
the account when the agent reports it, and the models for new chats.

Report: the exact message if Check says "not installed" after installing, if
sign-in doesn't finish, if the card shows the wrong account, or if it says to
update right after installing.

## 3. Use it (3 minutes)

1. Start a chat with that agent. Before typing, look under the message box:
   the model and effort chips should list the agent's own choices (Claude's
   effort levels, Codex's reasoning effort, Gemini's models), and the approval
   chip should read **Manual**. The badge next to the chat's name is the mode the
   agent reports: Claude **Manual**, Codex **Read-only**, Gemini **Auto Edit**.
2. Pick another model or effort, then ask for something small, for example
   "add a comment at the top of README explaining what this project does".
3. What to expect in Manual:
   - **Claude**: a card "Claude asks: Edit README.md" with the diff and
     **Open diff**. Claude writes the file after **Yes**. A command shows as
     a card with the command line and folder.
   - **Codex**: a card with the edit's diff ("Edit files"), then one with the
     command it wants to run ("Run …"), each before it acts.
   - **Gemini**: the edit opens as a diff in the editor (FriedLiver writes it);
     shell commands come as a card with the command.
   - **Antigravity**: in Manual and Plan it only talks (FriedLiver reads the
     project for it) and changes nothing; switch to **Edit automatically** or
     **Auto** to let it edit.
4. After the turn: "Changed N files" lists what changed, and **Undo this turn**
   puts it back, for every agent.
5. Switch the chip to **Edit automatically** (or press Shift+Tab) and ask for
   another small edit: it should go through without a card, still listed and
   undoable. **Auto** should ask you to confirm, then show red badges.

Report: an edit or command that happened without a card in Manual (serious), a
card without its diff or command, chips that stay empty, a model or effort
that didn't take effect, a mode badge that disagrees with what the agent did,
Undo that missed a file, slow or frozen panels, error toasts (the "N errors" item lists them again).

## 4. Connect two agents (2 minutes, needs two agents signed in)

1. In the same chat, type `@gemini is this change a good idea?` (or `@codex`,
   `@claude`). A second chat starts with that agent, and its answer comes back
   as a card with **Send to …**.
2. Click the chat's **Hand off** button and pick the other agent: the new chat
   continues the work with the conversation so far.
3. Ask the first agent: "Use the FriedLiver tools to ask Gemini to review your
   last change." You should get **Allow / Allow for this chat / Deny** before
   anything happens.
4. Open the **Agent Manager** (the board icon at the top of the Agents panel)
   and switch to **Map**: the chats and the lines between them should match what
   you just did.

Report: whether the agent found and used the FriedLiver tools in step 3 (real
agents are the untested part), and anything on the map that looks wrong.

## What to send back

- Your system (Windows 11, macOS 15, …) and which agents you tried.
- For each "Report" above: what you saw, and a screenshot if you can.
- **Help → Toggle Developer Tools → Console** errors, and the
  **FriedLiver Agents** output (View → Output → pick "FriedLiver Agents"),
  if something failed. They show what the agent said; no keys or passwords are
  logged there.
