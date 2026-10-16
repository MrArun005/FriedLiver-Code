# Try it with the real agents

A 10-minute check on your own machine, with your own Claude, GPT or Gemini
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

1. Click **Demo**, type `tour` and press Enter.
2. When "New file to review" appears, press **Accept**. When it asks to run a
   command, press **Run**.

Report: if the diff didn't open, or Accept or Run did nothing.

## 3. Sign in to one real agent (3 minutes)

Install the agent's command line tool once, in a terminal:

| Agent | Install |
|---|---|
| Claude | `npm install -g @zed-industries/claude-agent-acp` |
| GPT (Codex) | `npm install -g @zed-industries/codex-acp` |
| Gemini | `npm install -g @google/gemini-cli` |

Then in FriedLiver: **Accounts** (bottom of the Agents panel) → **Check** next to
the agent → its sign-in button. Claude opens a terminal: type `/login`,
approve on claude.ai, then `/exit`. GPT and Gemini open your browser.

Report: the exact message if Check says "not installed" after installing, or
if sign-in doesn't finish.

## 4. Use it (2 minutes)

1. Start a chat with that agent and ask for something small in your project,
   for example "add a comment at the top of README explaining what this
   project does".
2. Its edit should open as a diff. Accept or reject it.
3. If it wants to run a command, you should see Run / Deny first.

Report: edits written without a diff, or commands run without asking (these
would be serious), slow or frozen panels, error notices.

## 5. Connect two agents (2 minutes, needs two agents signed in)

1. In the same chat, type `@gemini is this change a good idea?` (or `@gpt`,
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
