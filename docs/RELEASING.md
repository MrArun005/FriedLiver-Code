# Releasing

"Merge" means two clicks, no re-integration:

1. **Merge the green pull requests** into `main` (merge commit). They are already
   up to date with `main`: after every push to `main`,
   [`update-prs.yml`](../.github/workflows/update-prs.yml) merges `main` into each
   open pull request that is behind (a merge, never a rebase), runs CI on it, and
   comments on any that conflict, with the commands to fix it. A conflicting branch
   is fixed on the branch, before merging, not during a release.
2. **Actions → Release → Run workflow** on `main`
   ([`release.yml`](../.github/workflows/release.yml)). It refuses unless CI passed
   on main's head, picks the next version (`v1.142.0-7` → `v1.142.0-8`; a new
   upstream version starts at `-1`), writes the notes from the titles of the pull
   requests merged since the last tag (grouped by `feat`/`fix`/`perf`/… prefix),
   builds every OS with [`build.yml`](../.github/workflows/build.yml), publishes the
   release (which creates the tag on that commit; a failed build leaves no tag) and
   then, on a Mac, downloads the DMG and zip and checks them against
   `SHA256SUMS.txt`, `codesign --verify --deep --strict` and the signing
   certificate's root hash. Any mismatch fails the run.
3. **LINKS.md** (outside the repo, `~/code/FriedLiver-Code-design/LINKS.md`):
   `node scripts/update-links.mjs` reads the latest release with `gh` and adds its
   row to the Releases table (moving "live, latest" to it). `--file <path>` for
   another copy; a tag argument for a given release.

Preview the version and notes locally: `node scripts/release.mjs` (prints them;
needs `gh`).

Limits: pull requests from forks are not updated. The workflow token may not
write `.github/workflows/`, so when `main` changes a workflow, branches get the
comment instead and are merged by hand (`git merge origin/main && git push`).

## Branch protection (proposed, not applied)

Keeps `main` green: pull requests only (no direct pushes, also for admins), the
CI checks must pass on a branch that is up to date with `main`, no force pushes
or deletion. The owner decides; to apply:

```sh
gh api -X PUT repos/MrArun005/FriedLiver-Code/branches/main/protection --input - <<'EOF'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["test (ubuntu-latest)", "test (macos-latest)", "test (windows-latest)", "extensions"]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": { "required_approving_review_count": 0 },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
EOF
```

Undo: `gh api -X DELETE repos/MrArun005/FriedLiver-Code/branches/main/protection`.
With it on, a hand merge (`git merge … && git push origin main`) is refused; merge
through the pull request instead.
