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

1. The saved index loads (`globalStorage/index/index-<folder hash>.json`,
   folder 0700, file 0600, written to a temp file and renamed). It must be
   version 2 and well formed; each entry is used only if its file passes
   today's checks. A corrupt, foreign or older file loads nothing, which is a
   full build. Saved tree nodes are re-hashed and the kept roots must be
   stored; anything off drops the history (the docs stay).
2. Every listed file is stat'ed, 256 at a time. That is the floor: a
   directory's mtime does not change when a file in it is edited, so without
   a file-system journal (FSEvents/watchman since-tokens) every leaf needs
   its stat. Only files whose stat changed are read; only those whose
   content hash changed are re-tokenized. A checkout that rewrites a file with
   the same bytes costs one read and no re-index.
3. The status bar shows `Index · N files · #<root 8 hex> · K changed since
   last open`. **FriedLiver: Rebuild Project Index (full)** (or a click on the
   status item) drops the saved index and reads everything again.

When `.git/HEAD`, `ORIG_HEAD` or `FETCH_HEAD` changes, the same stat pass runs
again, since the watcher may not report every file of a big checkout.

## `index_changes`

Read-only. Returns the current root and the files added (`A`), modified
(`M`) or deleted (`D`) since an earlier root: by default the root at open,
or `since`, a kept root or its unique 8+ hex prefix. At most 200 paths, then
a count of the rest. An unknown `since` lists the kept roots.

## Measured

Synthetic tree, 20,000 files in 1,020 directories (the test in
`test/projectIndex.test.ts`, MacBook, warm cache): full build about 2.8–4.5 s;
re-open after editing 10 files about 0.6–1.2 s with 20,010 stats and 10 reads;
the diff visits 21 of 1,021 directories.

`.github/workflows/index-bench.yml` runs `test/indexBench.test.ts` on a
throwaway clone of microsoft/TypeScript at v6.0.3: a full build, a re-open
after editing 10 files, and one after touching 10 more with the same
content. The numbers go to the run's summary. Run 39112512864 (ubuntu-latest,
81,369 files indexed, saved index 93.9 MB):

| Scenario | Time | Stats | Reads | Re-indexed |
|---|---|---|---|---|
| Full build | 30.1 s | 162,805 | 81,385 | 81,369 |
| Re-open, 10 files edited | 4.9 s | 162,799 | 10 | 10 |
| Re-open, 10 files touched (same content) | 4.9 s | 162,799 | 10 | 0 |

Re-open time is now the stat floor: each file is checked twice (lstat and
realpath when the saved entry loads, again in the sync pass).

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
