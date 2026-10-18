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
