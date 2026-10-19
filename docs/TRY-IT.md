# Try it with the real agents

A 10-minute check on your own machine, with your own Claude, Codex or Gemini
accounts. Everything here has been tested with the offline Demo agent only, so
this is the first run against the real ones. Note what happens at each step;
anything marked "Report" is worth sending back, with a screenshot if you can.

## 1. Install (2 minutes)

1. Open the latest **Build FriedLiver** run under the repository's **Actions**
   tab and download the installer for your system from **Artifacts**:
   `friedliver-fork-windows-x64-installer`, `friedliver-fork-macos-arm64-installer`
   or `friedliver-fork-linux-x64-installer`.
2. Install it. Windows: **More info → Run anyway** (the build isn't signed
   yet). macOS: open it once, then **System Settings → Privacy & Security →
   Open Anyway**.
3. Start FriedLiver and open a small project folder you don't mind agents
   editing (a git repository works best, so you can see and undo changes).

Report: anything other than the Agents panel on the right with "Start a chat".

## 2. Warm up with the Demo agent (1 minute)

The Demo agent is a fake local agent, hidden from the pickers until you turn
on **Settings → `friedliver.showDemoAgent`** (Help → Welcome's "Start a Demo
Chat" works without it).

1. Click **Demo**. The chips under the message box fill in at once: **Ask**,
   the model (**Smart**) and the effort (**Medium**).
2. Type `tour` and press Enter. When "New file to review" appears, press
   **Accept**. When it asks to run a command, press **Run**.
3. Type `native-edit README.md` (or any file): the agent asks with the diff on
   the card, and writes the file itself after **Yes**. "Changed 1 file" and
   **Undo this turn** should follow. `plan` shows a plan to approve, `question`
   a form, `/` the agent's commands.

Report: if the diff didn't open, Accept or Run did nothing, or Undo didn't
put the file back.

## 3. Sign in to one real agent (3 minutes)

Install the agent's command line tool once, in a terminal:

| Agent | Install |
|---|---|
| Claude | `npm install -g @agentclientprotocol/claude-agent-acp` |
| Codex | `npm install -g @agentclientprotocol/codex-acp` |
| Gemini | `npm install -g @google/gemini-cli` |

If you installed `@zed-industries/claude-agent-acp` or `@zed-industries/codex-acp`
before, install the new package instead: the old ones are deprecated and
Claude's has no effort option.

Then in FriedLiver: **FriedLiver: Agents & Accounts** (command palette, the
Accounts view's title, or **Agents & Accounts…** in the New chat menu) →
**Check** on the agent's card → one of its sign-in buttons, or **Set…** for an
API key (Gemini also has Vertex AI). Claude's subscription login opens a
terminal: approve on claude.ai and it closes. Codex (ChatGPT) and Gemini (Log in
with Google) open your browser. The card shows "Signed in", the adapter version,
the account when the agent reports it, and the models for new chats.

Report: the exact message if Check says "not installed" after installing, if
sign-in doesn't finish, if the card shows the wrong account, or if it says to
update right after installing.

## 4. Use it (3 minutes)

1. Start a chat with that agent. Before typing, look under the message box:
   the model and effort chips should list the agent's own choices (Claude's
   effort levels, Codex's reasoning effort, Gemini's models), and the approval
   chip should read **Ask**. The badge next to the chat's name is the mode the
   agent reports: Claude **Manual**, Codex **Read-only**, Gemini **Auto Edit**.
2. Pick another model or effort, then ask for something small, for example
   "add a comment at the top of README explaining what this project does".
3. What to expect in Ask:
   - **Claude**: a card "Claude asks: Edit README.md" with the diff and
     **Open diff**. Claude writes the file after **Yes**. A command shows as
     a card with the command line and folder.
   - **Codex**: a card with the edit's diff ("Edit files"), then one with the
     command it wants to run ("Run …"), each before it acts.
   - **Gemini**: the edit opens as a diff in the editor (FriedLiver writes it);
     shell commands come as a card with the command.
4. After the turn: "Changed N files" lists what changed, and **Undo this turn**
   puts it back, for every agent.
5. Switch the chip to **Auto-accept edits** (or press Shift+Tab) and ask for
   another small edit: it should go through without a card, still listed and
   undoable. **Full auto** should ask you to confirm, then show red badges.

Report: an edit or command that happened without a card in Ask (serious), a
card without its diff or command, chips that stay empty, a model or effort
that didn't take effect, a mode badge that disagrees with what the agent did,
Undo that missed a file, slow or frozen panels, error notices.

## 5. Connect two agents (2 minutes, needs two agents signed in)

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
