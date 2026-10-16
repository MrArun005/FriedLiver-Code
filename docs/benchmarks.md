# Benchmarks

Measured on 2026-10-16 in a cloud container (Linux x64, no GPU, software
rendering). The FriedLiver app's numbers, and the RAM tool and test project used
here (`scripts/ram-benchmark.ts`, `bench/fixture`), are in the
[FriedLiver repo](https://github.com/MrArun005/FriedLiver/blob/main/docs/benchmarks.md).

## The fork against VS Code and the FriedLiver app

The same container. Each app opens `bench/fixture` with `src/format.ts` in the
editor, so the language features run. Then memory is sampled for 30 s.
"First start" uses a new profile, and "Start" is the next launches. Each app
ran at least twice, and the runs agreed within about 10 %. Script:
`scripts/compare-editors.mjs` in the FriedLiver repo's `vscode-fork` branch.

| | FriedLiver fork 1.142 | VS Code 1.105 | FriedLiver 0.2 app |
|---|---|---|---|
| First start, until the files are listed | 4.1 s | 3.7 s | 1.7 s |
| Start | 3.0–3.2 s | 2.8–2.9 s | 1.6 s |
| Memory after it settles | 840 MB | 1005 MB | 373 MB |
| Memory, average / peak | 994 / 1150 MB | 1050 / 1100 MB | 382 / 390 MB |
| Processes | 13 | 13 | 6 |
| Installed size, Linux | 611 MB | 444 MB | |
| Windows installer | 150 MB (per-user setup) | 232 MB (1.142 user setup) | 108 MB |
| macOS download | 218 MB `.dmg` | 302 MB (1.142 `.zip`) | |
| Linux `.deb` | 137 MB | 229 MB (1.142) | |

- The fork settles about 165 MB below stock VS Code. Copilot and the built-in
  AI features are removed, and the agent host never starts. It is still more
  than twice the size of the FriedLiver app, as a full VS Code workbench is.
- First starts on a cold machine are slower for all three. The very first
  launch of any app in a fresh container took 20–40 s while the operating
  system filled its file cache. Those runs are left out.
- Installed size: the first packaged fork was 1.1 GB, because 300 MB of source
  maps and the 150 MB Copilot SDK runtime were still in it. `build.mjs` now
  removes both, which brings it to 611 MB. That also shrank the installers:
  Windows from 182 to 150 MB, macOS from 270 to 218 MB, and Linux from 177 to
  137 MB.
- VS Code here is 1.105 from its own download. Its installer sizes are for
  1.142 from Microsoft's download server.
- Agents run as separate processes and cost the same in every app: Codex about
  33 MB, Gemini about 320 MB.

## Extensions in the fork

The fork installs from Open VSX. Prettier 12.4, ESLint 3.0 and GitLens
installed with the fork's CLI and activated in the packaged app. GitLens's
Commit Graph, Prettier's status item and the FriedLiver Agents panel ran
side by side. Before patch 0040, every gallery install failed in a packaged
build with "Signature verification was not executed". Dev builds skip that
check.

| On Open VSX | Microsoft-only (not on Open VSX) | Open replacement on Open VSX |
|---|---|---|
| Prettier, ESLint, GitLens, Python, Jupyter, Java (Red Hat), Go, rust-analyzer, Tailwind CSS, Vue | Pylance | basedpyright |
| | C/C++ | clangd |
| | C# | `muhammad-sammy.csharp` |
| | Remote - SSH | Open Remote - SSH |
| | GitHub Copilot | FriedLiver Agents (Claude, Codex, Gemini) |

## 15 agents at once

What 15 agents streaming together cost, and what FriedLiver costs at rest.
Measured with `scripts/stress-demo.mjs` on the packaged Linux build (VS Code
1.142, `main` at 6cc8051) in the same container: 4 cores, no GPU, Xvfb at
1920×1080. "Before" is `main`'s agents extension, "after" this change; both
ran in the same packaged app, one after the other, with only the extension's
bundles swapped. One run per column.

How it runs: a fresh profile and folder. The script opens N Demo chats from the
chat view and sends each `busy <seconds> stamp`: four markdown chunks a second
(paragraphs, lists, code blocks), a tool call with two updates every 2.5 s, a
six-step plan, and a file read through the editor every 5 s. As real agents do,
each session starts its FriedLiver tools server when it starts. The Agent
Manager opens beside `notes.txt`, shows the board for 25 s and then the map
for 25 s, while the script types into the editor every 300 ms. All 15 agents
were working through both phases.

| | 1 agent, before | 1 agent, after | 15 agents, before | 15 agents, after |
|---|---|---|---|---|
| Memory, average / peak / settled | 801 / 1030 / 744 MB | 805 / 1038 / 725 MB | 1256 / 1417 / 1118 MB | 1052 / 1308 / 1024 MB |
| FriedLiver tools servers (one per chat) | 31 MB | 22 MB | 412 MB | 282 MB |
| Agent Manager webview, memory | 49 MB | 46 MB | 118 MB | 64 MB |
| CPU, Agent Manager webview (board / map) | 4.1 / 12.7 % | 3.6 / 4.1 % | 72.5 / 18.1 % | 10.5 / 8.4 % |
| CPU, chat webview (board / map) | 7.0 / 7.0 % | 6.2 / 6.1 % | 11.1 / 13.2 % | 6.9 / 7.0 % |
| CPU, extension host (board / map) | 4.2 / 2.3 % | 4.4 / 2.1 % | 10.2 / 8.3 % | 7.5 / 7.2 % |
| CPU, workbench renderer (board / map) | 24.5 / 20.6 % | 20.2 / 17.8 % | 23.9 / 22.3 % | 22.1 / 18.7 % |
| CPU, GPU process, software compositing (board / map) | 89 / 90 % | 91 / 91 % | 92 / 91 % | 91 / 92 % |
| CPU once the agents are done, map open: Agent Manager / GPU process | 13.7 / 50.1 % | 0.0 / 0.4 % | 16.7 / 71.0 % | 0.1 / 0.2 % |
| Long tasks (over 50 ms) in the workbench and both webviews | 1 (74 ms) | 0 | 1 (50 ms) | 0 |
| Long animation frames in the workbench (board / map) | 10 / 2 (699 / 111 ms) | 4 / 2 (382 / 103 ms) | 10 / 2 (700 / 116 ms) | 5 / 2 (306 / 122 ms) |
| Typing, keypress to painted, median (board / map) | 34 / 28 ms | 30 / 25 ms | 33 / 29 ms | 33 / 29 ms |
| Typing, p95 (board / map) | 53 / 42 ms | 45 / 45 ms | 51 / 46 ms | 54 / 48 ms |
| Chat view behind the agent, median / p95 | 6 / 43 ms | 6 / 47 ms | 26 / 40 ms | 33 / 44 ms |
| Board behind the agent, median / p95 | 5 ms (2 samples) | 11 ms (2 samples) | 30 / 166 ms | 33 / 49 ms |

CPU is a percentage of one core, averaged over each 25 s phase; "once the
agents are done" is 15–25 s after the last one finished. Memory is PSS summed
over the whole process tree (13 processes plus the tools servers), sampled
every 2 s: the average over both phases, the peak of the run (during startup),
and the average once the agents are done. Typing latency runs from the key
event Playwright sends to the frame after the character shows in the editor.
View lag runs from the time the demo agent wrote a sentence (or plan step) to
the frame after it shows in the chat view (33 samples) or on a board card (15).

What was slow, and what changed:

- **The board drew every card for every update.** With 15 agents the Agent
  Manager's renderer was busy most of the time. A profile put 4 of its 19 busy
  seconds (per 25 s) in the pipe menu's sort, which built a collator for every
  comparison on every card, and most of the rest in style, layout and paint.
  Cards are now drawn from a small view model and draw again only when what
  they show changes (`cardModel` in `src/shared/view.ts`, `memo` in
  `src/webview/common.tsx`); the pipe menu reads the chats only while it is
  open, with one collator (`src/webview/connect.tsx`). List rows work the same
  way.
- **Cards and rows moved many times a second.** Sorted by activity, 15
  streaming agents reorder the Working column on almost every batch; each move
  lays out and paints the column again, and moves the card under the pointer.
  The order now changes at most once a second; a new or removed chat, another
  sort or a change of column still shows at once (`settleOrder`). On its own
  this took the board from 45 % to 12 % of a core.
- **Some animations never stopped.** The map legend's "Live" sample, and the
  pulsing "working" dots in the Agent Manager's header, the Working column's
  heading and the legend, repainted every frame with no agent at work: an open
  Agent Manager kept its renderer at 14–17 % and the GPU process at 50–71 %
  with nothing happening. They now move only while something is live or
  working, and a plan or tool step left "in progress" after its turn no longer
  pulses. The map is laid out again only when something it shows changes
  (`mapKey`).
- **The chat view drew every transcript item for every update**, including
  updates for the 14 chats it wasn't showing. The transcript and each item now
  draw only when they change, and a streaming reply is parsed incrementally:
  finished blocks are kept and only the last one is parsed again (`parseDoc` in
  `src/shared/markdown.ts`; for a 60 KB reply, 26 µs a chunk instead of
  450 µs).
- **Each tools server held the MCP SDK, zod and ajv**: 1.4 MB of script and
  about 10 MB of memory per chat on top of the runtime. `src/bridge/mcp.ts`
  speaks the part of MCP the tools need (initialize, ping, tools/list,
  tools/call, progress) with the same tool list, byte for byte; `bridge.js` is
  12 KB, and each server went from 27 to 19 MB.
- **Smaller things.** Decisions were looked for in every transcript on every
  batch, by the host and each webview: now once per transcript change
  (`waitingItems`; 228 µs to 2.5 µs for 15 chats of 2,000 items). The status
  item and the Agents badge are set only when they change. Command output
  copied every transcript (`editItems` now copies only the chat it changes).
  Saving reuses the JSON of chats that didn't change (24 ms to 3 ms for a
  4.5 MB state, once a second while agents work). Past 100 updates a second the
  host batches every 50 ms instead of 30 (`ActionBatcher`): fewer, bigger
  messages for the workbench to pass on, at a few milliseconds of lag (80 ms
  saved under a point of CPU more and tripled the chat view's p95 lag, so it
  isn't used). The Agent Manager gets no images and a chat only the ones you attached
  (`src/host/surfaceState.ts`), and the Images list is capped at 64 MB.

### At rest

The same builds, `--scenario idle`: the folder open with the Agents panel and
no chat; then one finished Demo chat (`busy 5`); then the Agent Manager open;
then closed again. Each step waits 15 s and averages 10 s. The columns after
the totals are the after run, in MB.

| | Total, before | Total, after | Workbench | Main | Extension host | Shared process | Agents webviews | File watcher | JSON server | GPU | Demo agent + tools server |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Agents extension off (two runs) | 631–651 MB | | 214–229 | 104–106 | 83 | 81 | – | 42 | 32–35 | 29 | – |
| Folder open, no chat | 679 MB | 676 MB | 216 | 112 | 86 | 75 | 44 | 40 | 31 | 29 | – |
| One finished chat | 656 MB | 646 MB | 178 | 96 | 78 | 44 | 53 | 34 | 30 | 37 | 33 + 23 |
| Agent Manager open | 661 MB | 656 MB | 172 | 96 | 77 | 43 | 44 + 40 | 33 | 29 | 32 | 28 + 22 |
| Agent Manager closed | 695 MB | 646 MB | 171 | 96 | 77 | 43 | 43 + 33 | 33 | 29 | 30 | 28 + 22 |

- What the agents extension adds at rest is mostly the chat view's renderer:
  about 45 MB, with 1.5 MB of JavaScript heap. In the extension host it was
  4.7 MB of heap (32.8 MB, against 28.1 MB with the extension off) and is
  3.4 MB now: the ACP library and the zod schemas it builds load with the first
  agent, not at startup (`agent-core/main/agents/agentConnection.ts`).
- After a chat, the demo agent (about 30 MB) and its session's tools server
  (31 MB before, 22–23 MB after) stay until the agent has been idle for
  `friedliver.idleStopMinutes` (10).
- A closed Agent Manager leaves its renderer running (33–40 MB): VS Code keeps
  the webview's service worker alive, and the service worker keeps the
  process. Opening the manager again reuses it, so it doesn't add up, but the
  extension can't free it. In every before run the workbench's heap also grew
  from 59 to 76 MB once the manager closed; in the after run it didn't (one
  run, so take that as a hint).
- Totals move by 10–20 MB between runs (garbage collection, and shared pages
  split between more or fewer processes), as much as the extension's own
  share; only the heap numbers above are exact.

Caveats:

- Software rendering. With `--disable-gpu` under Xvfb the GPU process
  composites in software and sits near 90 % of a core whenever anything
  animates or streams. With the animations turned off in both webviews it was
  62 % on the board and 35 % on the map, so the pulsing "working" dots of the
  agents at work account for much of it. A real GPU makes compositing cheap,
  and `prefers-reduced-motion` turns the animations off.
- The Demo agent, not the real ones. It streams four chunks a second; real
  agents stream faster and send bigger tool updates, so what grows with the
  update rate (webview drawing, the workbench passing messages on) would be
  higher; that is what the bigger batches under load are for. Its own memory
  says nothing about Claude's, Codex's or Gemini's.
- All 15 sessions share one demo process, as 15 chats with one vendor's agent
  share one agent process. Real agents may start other MCP servers per session
  too; only FriedLiver's are counted.
- One run per column, measured in one sitting after the container restarted.
  An earlier pair of runs, before the restart and before the dots and batching
  changes, gave the same picture (Agent Manager 50 → 8 % on the board, 412 →
  280 MB of tools servers) with a lighter baseline; CPU moves by 2–3 points
  between runs, and more when the container is busy.
