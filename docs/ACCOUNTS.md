# Agents & Accounts

**FriedLiver: Agents & Accounts** opens a page with one card per agent. Open it
from the command palette, the title of the **Accounts** view, the welcome
walkthrough, **Agents & Accounts…** in the chat's New chat menu, or **Sign in
to <Agent>** on a chat that failed because the agent needs a sign-in (that opens
the page on the agent's card).

![Agents & Accounts, dark](screenshots/agents/accounts-black-blue.png)

## What a card shows

- **Status**: Not checked, Not installed, Needs sign-in, Signed in or Problem,
  the adapter's version, and how long ago it was learned. The same status shows
  as a small dot next to the agent in the New chat menu, Hand off, Ask and the
  Agent Manager's new task.
- **Which way it signs in**: the account the agent reports (Claude's and
  Codex's adapters send `_auth/status_update` with the plan, email or key
  source), else the key saved in FriedLiver, a key variable already in the
  editor's environment, or the sign-in method you last used from FriedLiver.
- **Install** with Copy and Run in terminal, when the agent isn't installed.
- **Sign in**: the agent's own ACP sign-in methods (a browser login through ACP
  `authenticate`, or its terminal login), an API key, and its own CLI's login.
- **Sign out**: the agent's own sign-out (ACP `logout`) when it offers one, and
  its CLI's sign-out line. FriedLiver never deletes a CLI's credential files.
- **Models**: the model and effort the agent's last session offered, and which
  ones its new chats start with. These are the same remembered choices the
  chips under the message box use, so the two always agree.

Nothing on the page starts an agent by itself. **Check** and **Refresh** start
it and open a session that is closed again at once (no model call); a sign-in or
sign-out checks afterwards. Every chat session also updates the card: a session
that starts means signed in, and a chat that fails for want of a sign-in means
needs sign-in. What was learned is kept in the editor's global storage
(`friedliver.accounts`), never a key.

## Per agent

| | Claude | Codex | Gemini | Antigravity |
|---|---|---|---|---|
| Browser / terminal sign-in (from the agent) | Claude Subscription, Anthropic Console (terminal) | ChatGPT (browser) | Log in with Google (browser) | none: agy has no ACP mode, so its own CLI line signs in |
| Keys FriedLiver keeps | `ANTHROPIC_API_KEY` | `OPENAI_API_KEY`, then ACP `api-key` | Gemini API key (`GEMINI_API_KEY`, then ACP `gemini-api-key`); Vertex AI (`GOOGLE_CLOUD_PROJECT` + `GOOGLE_CLOUD_LOCATION`, or `GOOGLE_API_KEY`, with `GOOGLE_GENAI_USE_VERTEXAI=true`, then ACP `vertex-ai`) | none (agy's API-key mode lives in its own `~/.gemini/antigravity-cli/settings.json`, which FriedLiver never edits) |
| Own CLI sign-in / sign-out | `claude auth login` / `claude auth logout` | `codex login` / `codex logout` | API key or Vertex AI in Agents & Accounts (Google sign-in: use Antigravity) / `gemini`, then `/signout` | `agy`, then Google OAuth / `agy`, then `/logout` |
| Sign-out from the page | ACP `logout` | ACP `logout` | the CLI line | the CLI line |
| Account reported | plan, email, organization or key source | ChatGPT plan and email, or API key | not reported; the card says which method is in use | not reported; the version is agy's (`agy --version`), the models are what `agy models` lists |

One key setup is kept per agent: saving the Gemini API key replaces Vertex AI
settings and the other way round. After a key is saved, FriedLiver restarts the
agent with it and, when the agent has an ACP method for that key (Gemini,
Codex), calls it so the agent records the choice, then checks. The page asks
for keys in the editor's own password boxes; the page itself never receives a
key, only "set" or "not set" (and the project and location for Vertex AI).

## Not verified against the real CLIs

The flows were built from each adapter's published `initialize` and
`authenticate` code and tested against the tests' fake agent standing in (browser
sign-in, `logout`, `_auth/status_update`, model lists), never with real
accounts. See [TRY-IT.md](TRY-IT.md) for the first real run.
