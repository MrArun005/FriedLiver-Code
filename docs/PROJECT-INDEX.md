# Project index: Merkle sync

The agents extension keeps a keyword index of each trusted workspace folder
for the `index_*` tools (`src/host/projectIndex.ts`, editor side in
`projectIndexHost.ts`). Since `feat/index-merkle` the index also keeps a
Merkle tree of its files (`src/host/merkle.ts`), so opening a project, a
checkout, a pull or a branch switch re-reads only what changed.

## The tree

- **Leaf**: an indexed file. Its hash is the SHA-256 of its bytes, read in
  64 KB chunks and hashed as they arrive, in the same read that indexes it.
  The file's size and mtime in nanoseconds are the quick check: a file whose
  stat matches the saved one is not read.
- **Node**: a directory. Its hash is the SHA-256 of its sorted
  `(kind, name, child hash)` entries. **Root**: the project hash.
- The leaves are exactly the indexed files, so every exclusion of the full
  build applies: `.gitignore` (fail closed when `git check-ignore` errors),
  `files.exclude`, the secrets denylist, dot and build directories, symlinks
  and paths whose real path leaves the folder, binaries, files over 1 MB.
- A change marks its ancestors dirty; the root is recomputed lazily, only
  along dirty paths, when the status bar or a tool asks for it (watcher
  events are already debounced by 1 s).
- Snapshots (at each save, every 30 s at most after a change, and on close)
  keep the nodes of the last 16 roots and of the root at open,
  content-addressed, so unchanged subtrees are stored once. Two roots diff
  by descending only into subtrees whose hashes differ.

## On open

A save is two files in `globalStorage/index/` (folder 0700, files 0600, each
written to a temp file and renamed): `index-<folder hash>.json`, the tree
(every leaf's path, size, mtime-ns and hash; the kept roots; the journal
mark; git's HEAD; the name rules it was made under), and
`index-<folder hash>.docs.ndjson`, the search data, one JSON doc per line.

1. **Tree ready.** The tree file loads with no file-system access: the
   Merkle root, the status bar and `index_changes` answer at once. A save
   made under other name rules (denylists, `files.exclude`) is re-checked
   by name; a corrupt, foreign or older file loads nothing (a full build);
   saved tree nodes are re-hashed and a bad one drops the history.
2. **Search ready.** The docs stream in, 100 lines at a time, yielding to
   the editor. A saved doc is used only while its leaf still has the same
   content hash, so a file that changed meanwhile never shows stale
   results; leaves left without a doc are read. Until then answers carry a
   note that they may be incomplete. Every read (search snippets) still
   re-checks its file: symlink, real path, size, name rules, `O_NOFOLLOW`.
3. **Verified**, alongside step 2:
   - **macOS: FSEvents journal.** `bin/friedliver-fsevents` (Swift,
     `native/friedliver-fsevents.swift`) returns every event under the folder
     since the saved event id. Only those paths are re-checked, through every
     filter of the full build (`.gitignore` via `git check-ignore`, name
     rules, symlinked or nested-repo directories, size, binary). Directory
     events and changed `.gitignore` files rescan their directory. No END
     from the helper, another journal UUID, dropped or wrapped events, a
     mount, or the folder itself to rescan: the full check instead.
   - **Elsewhere, or without a usable mark:** every listed file is stat'ed,
     256 at a time, and read only if its stat changed. Windows' USN journal
     would need a volume handle (administrator), so Windows uses this too.
   - **git's hint**, in both cases: `git --no-optional-locks status
     --porcelain` plus the diff from the last session's HEAD. With a journal
     it runs alongside and its extra paths are checked after; without one it
     goes first so likely changes show within moments. It is never trusted
     alone.
4. The mark saved is the one taken at the previous save (saves are 30 s
   apart at least), so the watcher has delivered everything before it; the
   next open replays the journal from there. Changes the editor's watcher
   is told to skip (`files.watcherExclude`) between those points are only
   caught by the next full check (**Rebuild Project Index (full)**).

While open, watcher events update files live (one update at a time per
file); a moved `.git/HEAD`, `ORIG_HEAD`, `FETCH_HEAD` or an edited
`.gitignore` re-runs the stat pass. The status bar shows `Index · N files ·
#<root 8 hex> · K changed since last open`.

## `index_changes`

Read-only. Returns the current root and the files added (`A`), modified
(`M`) or deleted (`D`) since an earlier root: by default the root at open,
or `since`, a kept root or its unique 8+ hex prefix. At most 200 paths, then
a count of the rest. An unknown `since` lists the kept roots.

## Measured

`.github/workflows/index-bench.yml` runs `test/indexBench.test.ts` on a
throwaway clone of microsoft/TypeScript at v6.0.3 (81,369 files indexed) on
ubuntu-latest (no journal) and macos-latest (FSEvents journal): a full
build, a re-open after editing 10 files, and one after touching 10 more
with the same content. Run 39115942509:

| Runner | Scenario | Tree ready | Verified | Search ready | Stats | Reads | Re-indexed |
|---|---|---|---|---|---|---|---|
| macOS | Full build | – | 57.3 s | 57.3 s | 162,805 | 81,385 | 81,369 |
| macOS | Re-open, 10 edited | 0.28 s | 0.65 s | 3.4 s | 20 | 10 | 10 |
| macOS | Re-open, 10 touched | 0.28 s | 0.71 s | 3.5 s | 30 | 10 | 0 |
| Linux | Full build | – | 58.4 s | 58.4 s | 162,805 | 81,385 | 81,369 |
| Linux | Re-open, 10 edited | 0.34 s | 6.4 s | 7.5 s | 81,440 | 10 | 10 |
| Linux | Re-open, 10 touched | 0.35 s | 6.2 s | 7.3 s | 81,440 | 10 | 0 |

Before the tree file, the journal and the stream, a re-open loaded one
94 MB JSON (4.3 s blocking the extension host on Linux) and then stat'ed
every file twice: 4.9 s to verified. The CI runners vary by up to 2x
between runs (the same Linux full build took 33 s in run 39115448596, its
re-open verified in 4.0 s), so compare rows within a run. Search ready is
the docs stream (about 3 s for 81k docs); the tree, the status and
`index_changes` do not wait for it.

Synthetic tree, 20,000 files in 1,020 directories (`test/projectIndex.test.ts`,
MacBook): the diff after 10 edits visits 21 of 1,021 directories.

## Later uses (design only)

**Rewind checkpoints.** Outside git, checkpoints (`dirSnapshots.ts`) keep a
manifest of every file and each file's bytes once under its SHA-256, the
same hash as an index leaf. A checkpoint could take the index's hash for any
file whose `(size, mtime-ns)` still matches the index, instead of reading
and hashing it again, and a turn's changed files would be the
`index_changes` diff between the root at turn start and at turn end, found
without walking the folder. The blob store stays as it is; only the hashing
pass is shared. Files the index leaves out (big, binary, ignored) still go
through the checkpoint's own walk, so a restore misses nothing.

**Proof of what an agent read.** When an agent reads a file through
FriedLiver (the `index_*` tools, an attached selection, an edit flow), log
`(path, leaf hash, root)` for the turn. The root commits to the whole tree,
so a turn's record proves which version of each file the agent saw, and a
later reviewer can check it against any kept root, or against git, without
storing the content. Reads an agent makes with its own tools (shell `cat`,
its file reader) do not pass through FriedLiver and would not be covered; the
record would say so.

# Token efficiency

Everything FriedLiver reads for an agent or hands to one is made to cost
fewer tokens (branch `feat/token-efficiency`). Measured by
`test/tokenBench.test.ts` (below).

## Code: read the part, not the file

- `index_search` returns ±3-line numbered windows around the best-matching
  lines of each hit, merged, a window repeated in another file named instead
  of shown, within `budget` tokens (default 1,500, 100-8,000); what did not
  fit is listed as "More matches".
- `index_outline` lists signatures only: `12: export function f(a: string): number`.
- `index_read(path, symbol | lines)` returns one definition (`name` or
  `Outer.inner`, its doc comment included; its end found by brackets,
  indentation or `end`, never past the next sibling definition) or a line
  range, under a one-line header (`path · N lines · #hash · defines …`). A
  file over 150 lines without either comes back as its outline. At most 300
  lines per call, with where to go on.
- Change-aware: per chat FriedLiver remembers the version (content hash, the
  file's Merkle leaf) of each file it showed the agent: through `index_read`,
  and through reads and edits it sees (finished read/edit tool calls,
  `fs/read_text_file`). `index_diff(path)` is a unified diff against that
  version; `index_changes` with `since: "last_turn"` lists what changed since
  the chat's previous turn (a root pinned per chat at turn end) and marks the
  files the chat already has.
- A new session's first message starts with a project map: top-level folders
  with file counts and the files most relevant to that message, at most 1,500
  tokens and only what the shared rules leave of their 8 KB cap
  (`friedliver.index.primer` turns it off).
- The tools server's instructions and the tool descriptions say the cheap
  order: `index_search` → `index_outline` → `index_read(symbol)` → `index_diff`.

Every new tool goes through the index's own checks: only indexed files
(workspace-relative, not ignored, excluded or secret-looking), re-checked
before each read (regular file, no symlink out of the folder), and a diff only
of a file that still passes them.

## Browser, screenshots, commands, hand-offs

- `browser_snapshot` returns the page's main content as compact markdown
  (headings, lists, `[text](url)` links with same-site ones as paths and
  tracking parameters dropped, code blocks, tables as rows), without
  navigation, footers, banners, cookie and newsletter blocks or form
  controls; `elements: true` lists the interactive elements instead, as
  `e12 button "Save"`, and `e12` works as a selector. A re-snapshot of the
  same page in the same chat returns a diff. `budget` caps it (default 2,500).
- `browser_screenshot` captures at most 1,024 image pixels wide (whatever the
  screen's pixel ratio) as JPEG, or one element (`selector`), and says its cost
  (about w×h/750 tokens after Claude's own fit to 1,568 px and 1.15 MP).
- Command output an agent reads through FriedLiver's terminals loses color
  codes and spinner frames, folds repeated lines and library stack frames,
  and keeps the first 60 and last 100 lines; the whole output is saved
  privately and named.
- A hand-off carries a summary (task, the user's asks, where the agent
  stopped, open questions, plan, commands, files with their hash) instead of
  the transcript; `read_chat` brings the conversation. It asks first, as any
  read of another chat does, unless `friedliver.chat.autoAllowLinkedReads`
  (user settings, default off) lets it read a chat linked by that hand-off or
  consultation without asking.
- Near a full context (85%) a chat is offered the agent's own `/compact`.
- Prompt caching: rules (Claude: system prompt), then the map, then the
  message, byte-identical across sessions with the same rules; tools and
  instructions are static. Each turn's cache reads, when the agent reports
  usage, show in the model pill's tooltip with the tokens FriedLiver saved;
  the Agent Manager shows the total saved.

## Token bench

`test/tokenBench.test.ts` replays scripted tool-call traces two ways and
counts the tokens of every tool result (cl100k_base via js-tiktoken in CI).
Without FriedLiver: grep (content, 100 lines) and whole-file reads (2,000
lines, like Claude Code's Read); the old snapshot (elements + innerText,
emulated on the same parsed page); full-resolution screenshots; raw command
output; the transcript for a hand-off. With: the tools as they answer now.
Code tasks run on this extension's sources and, in CI, on
microsoft/TypeScript v6.0.3; browser rows on a fixture and three pinned
web.archive.org captures. Screenshot rows are Claude's formula, not a
measurement. No real-agent run: the repo has no model API key secret.

Run 39115951436 (ubuntu-latest, cl100k_base), tokens of tool results:

| Category | Task | Without | With | Saved | Calls (without/with) |
|---|---|---|---|---|---|
| Code (this extension) | Find where tokenize is defined and change it | 14,964 | 294 | 14,670 (98%) | 3/3 |
| Code (this extension) | After 3 files changed, update the tests | 9,440 | 2,300 | 7,140 (76%) | 6/7 |
| Code (this extension) | Explain the module that defines MerkleTree | 3,506 | 1,029 | 2,477 (71%) | 1/4 |
| Code (TypeScript v6.0.3) | Find where isIdentifierStart is defined and change it | 21,598 | 109 | 21,489 (99%) | 3/3 |
| Code (TypeScript v6.0.3) | After 3 files changed, update the tests | 68,565 | 1,850 | 66,715 (97%) | 6/7 |
| Code (TypeScript v6.0.3) | Explain the module that defines nodeModuleNameResolver | 27,755 | 5,526 | 22,229 (80%) | 2/4 |
| Browser | Read a docs page (fixture) | 5,159 | 456 | 4,703 (91%) | 1/1 |
| Browser | Re-read it after one paragraph changed | 5,159 | 183 | 4,976 (96%) | 1/1 |
| Browser | Find the button to click | 5,159 | 1,497 | 3,662 (71%) | 1/1 |
| Browser | Read github-typescript (archived page) | 7,198 | 2,635 | 4,563 (63%) | 1/1 |
| Browser | Read mdn-429 (archived page) | 12,055 | 553 | 11,502 (95%) | 1/1 |
| Browser | Read wikipedia-merkle-tree (archived page) | 12,424 | 5,871 | 6,553 (53%) | 1/1 |
| Screenshots (formula) | Screenshot of the page (1280×800 at 2×) | 1,533 | 874 | 659 (43%) | 1/1 |
| Screenshots (formula) | Screenshot to check one button | 1,533 | 9 | 1,524 (99%) | 1/1 |
| Screenshots (formula) | Screenshot to check one panel | 1,533 | 329 | 1,204 (79%) | 1/1 |
| Command output | A test run, 1,500 passing lines | 48,529 | 2,940 | 45,589 (94%) | 1/1 |
| Command output | A build with a spinner and repeated warnings | 4,629 | 45 | 4,584 (99%) | 1/1 |
| Command output | Six failures with deep stack traces | 4,722 | 357 | 4,365 (92%) | 1/1 |
| Hand-off | Hand a 40-turn chat to another agent | 5,001 | 698 | 4,303 (86%) | 1/1 |
| Category | Without | With | Saved |

|---|---|---|---|
| Code (this extension) | 27,910 | 3,623 | 24,287 (87%) |
| Code (TypeScript v6.0.3) | 117,918 | 7,485 | 110,433 (94%) |
| Browser | 47,154 | 11,195 | 35,959 (76%) |
| Screenshots (formula) | 4,599 | 1,212 | 3,387 (74%) |
| Command output | 57,880 | 3,342 | 54,538 (94%) |
| Hand-off | 5,001 | 698 | 4,303 (86%) |
| **Total** | 260,462 | 27,555 | 232,907 (89%) |
| New work | Time |

Load-time impact: the new work's wall time in the same run (the project map runs once, before a new session's first message; it was 412 ms on TypeScript before symbol boosts were limited to the best BM25 hits):

|---|---|
| Project map for a first message (this extension, 91 files) | 7.9 ms |
| index_read of one symbol (this extension) | 7.9 ms |
| index_search with windows (this extension) | 16.6 ms |
| Project map for a first message (TypeScript v6.0.3, 81,369 files) | 128.0 ms |
| index_read of one symbol (TypeScript v6.0.3) | 18.7 ms |
| index_search with windows (TypeScript v6.0.3) | 9.6 ms |
| Page text for github-typescript.html (parse + extract, in Node; the browser skips the parse) | 81.8 ms |
| Page text for mdn-429.html (parse + extract, in Node; the browser skips the parse) | 22.6 ms |
| Page text for wikipedia-merkle-tree.html (parse + extract, in Node; the browser skips the parse) | 18.6 ms |

Bundles (minified, esbuild): extension.js 879,081 → 898,962 bytes (+19.9 KB), the per-session tools server bridge.js 14,719 → 19,367 (+4.6 KB), the Agent Manager webview 136,411 → 137,209 (+0.8 KB).
