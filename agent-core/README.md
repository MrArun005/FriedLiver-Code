# agent-core

The ACP client that runs the agents: starting and stopping agent processes,
sessions, permission requests, file access, terminals and turn logs. The
FriedLiver Agents extension bundles it (`@friedliver/main/*` in
`extensions/friedliver-agents`).

| Path | What |
| --- | --- |
| `main/agents/` | Agent processes (`processes.ts`), the ACP connection, the hub that shares one process per agent between chats, sign-in methods, file access, terminals, turn logs |
| `main/workspace/git.ts` | Git helpers for task worktrees and Review My Changes |
| `shared/ipc.ts` | Shared types (the extension uses `SignInMethod`) |
| `demo/fakeAgent.mjs` | The offline Demo agent: `tour`, `project`, edits, commands, images, `ask <agent> …` through the FriedLiver tools, and `busy <seconds>` for stress tests |
| `demo/editorRequests.mjs` | The Demo agent's answers to editor requests: Edit with Agent on a selection, Review My Changes |

It started as a copy of `src/main/agents/` and friends from the
[FriedLiver app](https://github.com/MrArun005/FriedLiver) (branch `vscode-fork`,
commit `76e9182`), with that history kept. The two repos change independently
from here.
