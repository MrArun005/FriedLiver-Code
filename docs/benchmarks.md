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
