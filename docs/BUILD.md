# Building FriedLiver on VS Code (Code - OSS)

FriedLiver's fork is built VSCodium-style. This repo holds only `code/`: the
pinned upstream tag, product.json overrides, patches, built-in extensions and
the scripts. Upstream [microsoft/vscode](https://github.com/microsoft/vscode)
(MIT) is cloned at build time. See [code/README.md](../../code/README.md) for
the layout.

Pinned upstream: **1.142.0** (`d956e8a6ac5d904486557eea07e1d6bd62a4d36f`). On
2026-10-16 this was the newest version on `update.code.visualstudio.com/api/releases/stable`.

## Quick start (any OS)

```bash
node code/scripts/fetch.mjs        # shallow clone of the pinned tag into code/vscode (or $VSCODE_DIR)
node code/scripts/prepare.mjs      # patches, product.json, icon, built-in extensions
node code/scripts/build.mjs        # deps + npm ci + compile + Electron (dev build)
node code/scripts/dev.mjs [folder] # run from source; as root on Linux it adds --no-sandbox
node code/scripts/build.mjs --package   # minified app in <VSCODE_DIR>/../VSCode-<os>-<arch>
node code/scripts/build.mjs --package --installer   # plus the installer in <VSCODE_DIR>/../installers
```

Installers, all unsigned:

| OS | File | Made by |
| --- | --- | --- |
| Windows | `FriedLiverUserSetup-<arch>-<version>.exe`, installs per user | `gulp vscode-win32-<arch>-inno-updater` and `-user-setup` (Inno Setup from upstream's `innosetup` package) |
| macOS | `FriedLiver-darwin-<arch>-<version>.dmg` | an ad-hoc `codesign`, then `hdiutil` |
| Linux | `friedliver_<version>_amd64.deb` | `gulp vscode-linux-<arch>-prepare-deb` and `-build-deb` |

CI (`.github/workflows/code.yml`) builds all three with the portable apps on
every change to the fork.

Environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `VSCODE_DIR` | `code/vscode` | Upstream checkout |
| `FRIEDLIVER_EXTENSIONS_DIR` | `code/extensions` | Where `prepare.mjs` takes the FriedLiver built-ins from |
| `FRIEDLIVER_CACHE_DIR` | `code/.cache` | Downloaded Node toolchain |

### What the scripts handle for you

- **Node version.** Upstream's `.nvmrc` wants **Node 24.18.0** (same major,
  >= 24.18.0), and its preinstall refuses anything else. If your Node doesn't
  match (this container has 22.22.0), `build.mjs` and `dev.mjs` download the
  exact version from nodejs.org into `code/.cache` (203 MB) and put it first on
  `PATH`. Your system Node stays as it is. npm must be older than 13.
- **Linux packages.** `build.mjs` installs any of these that are missing with
  apt-get (with sudo unless you're root): `build-essential g++ make pkg-config
  python-is-python3 libx11-dev libxkbfile-dev libsecret-1-dev libkrb5-dev
  fakeroot rpm dpkg`. Use `--skip-deps` to skip this step.
- **ripgrep.** `@vscode/ripgrep` looks its binary up through `api.github.com`.
  That fails behind restrictive proxies, and without a token on CI it hits rate
  limits. `build.mjs` first puts the binary in the package's cache from the
  plain release-download URL.
- **Flaky sub-installs.** Upstream's postinstall runs about 100 `npm ci` in
  parallel. If one of them dies (we saw `ECONNRESET`), `build.mjs` retries the
  postinstall instead of the whole `npm ci`.

### Windows

Install Git, Python 3, and Visual Studio 2022 or newer with the *Desktop
development with C++* workload (upstream checks this in preinstall). Then run
the same `node code/scripts/...` commands from a normal terminal. `dev.mjs`
runs `scripts\code.bat`. `--package` runs `gulp vscode-win32-x64-min`,
which also needs `signtool.exe` from the Windows SDK on PATH (it strips old
signatures before stamping FriedLiver's name into bundled binaries), and
`git config --global core.autocrlf false` before cloning, because the patches
use LF line endings. CI does both (`.github/workflows/code.yml`).

### macOS

Install the Xcode command line tools (`xcode-select --install`) and Python 3,
then run the same commands. `dev.mjs` runs `scripts/code.sh`. `--package` runs
`gulp vscode-darwin-<arch>-min`. Built on CI for Apple silicon; the app is
ad-hoc signed, not notarized, so macOS asks once under System Settings →
Privacy & Security → Open Anyway.

### Icons and branding

`prepare.mjs` copies `build/icon.png` (1024 px, roasted liver) over
`resources/linux/code.png`, then copies `code/branding/overlay/` over the
upstream tree. `code/branding/make-branding.py` (Pillow) generates that overlay
from `build/icon.png` and `build/liver-art.svg`:

- Windows `code.ico`, Start tiles and the Inno Setup wizard pictures for every
  display scale.
- macOS `code.icns`, plus the server icons.
- The empty-editor watermark: the liver's silhouette, in upstream's letterpress style.

The generated files are committed, so builds need no Pillow. Run the script
again after changing the artwork.

## What prepare changes

- **product.json** ([code/product.json](../../code/product.json)): FriedLiver
  names, `friedliver` URL protocol, `.friedliver` data folder, server and
  tunnel names, fresh Windows AppIds, `com.friedliver.app`. Telemetry is off,
  and with no `updateUrl` there is no update service. The extension gallery is
  Open VSX, with the same `serviceUrl`, `itemUrl`, `latestUrlTemplate` and
  `controlUrl` that VSCodium's `prepare_vscode.sh` sets, plus
  `linkProtectionTrustedDomains`. Copilot keys are removed: `defaultChatAgent`,
  Copilot auth access, `voiceWsUrl` and `agentsTelemetryAppName`.
- **`0010-drop-builtin-copilot.patch`** together with removing
  `extensions/copilot`. It takes the folder out of the postinstall list, out of
  `npm run compile` and out of the packaging tasks. It also null-guards the
  seven places that crash without `defaultChatAgent`: account setup at
  startup, the onboarding module, gallery queries, the extensions control
  manifest, dependency install and uninstall.
- **`0020-disable-builtin-ai-by-default.patch`**: `chat.disableAIFeatures`
  defaults to true. This stops the agent host process and its
  `copilot-runtime` child. The patch also hides the built-in Chat view in that
  case, so the secondary side bar belongs to FriedLiver Agents.
- **Built-in extensions**: `friedliver-agents` (`npm ci` + `npm run build`
  first) and `friedliver-theme` are copied without `node_modules` and
  `.vscode-test`. On the copy, the Agents view container moves from
  `activitybar` to `secondarySidebar`. `contribSecondarySidebar` is final in
  1.142, so no proposal is declared. Declaring it logs *"wants API proposal
  'contribSecondarySidebar' but that proposal DOES NOT EXIST"*.

## Time and disk (cloud container: 4 CPUs, 15 GB RAM, Linux x64)

| Step | Time | Disk |
| --- | --- | --- |
| Shallow clone of 1.142.0 | 12 s | 416 MB |
| apt packages | about 1 min | |
| Node 24.18.0 download | about 10 s | 203 MB |
| `npm ci` + postinstall (root, build/, every extension) | about 6 min | +4.8 GB |
| `npm run compile` (dev, 0 errors) | 3 min with Copilot, 2 min without | +0.6 GB |
| Electron 43.7.7 + 3 marketplace built-ins | under 30 s | |
| **Dev build total** | **about 12 min** | **6.2 GB** |
| `--package` (`gulp vscode-linux-x64-min`), after a dev build | about 5 min | 1.1 GB app in `code/VSCode-linux-x64` |

## Memory

Measured with `scripts/ram-benchmark.ts --pid <main pid> --seconds 30
--interval 5`: PSS over the whole process tree, under xvfb with software
rendering, a fresh profile, `bench/fixture` open. Same container as
[docs/benchmarks.md](../benchmarks.md).

| Build | Average | Peak | Processes |
| --- | --- | --- | --- |
| Fork **dev build**, upstream as is (Copilot built in) | 1499 MB | 1755 MB | 12 |
| Copilot extension and `defaultChatAgent` removed | 1392 MB | 1470 MB | 12 (a 75 MB `copilot-runtime` still ran) |
| Plus `chat.disableAIFeatures` default (agent host stays off) | 1257 MB | 1355 MB | 11 (settles near 1160 MB) |
| Plus FriedLiver Agents view open (one more webview renderer) | 1238 MB | 1250 MB | 12 |
| *For comparison:* FriedLiver 0.2 Electron app | 314 MB | 321 MB | 6 |
| *For comparison:* VS Code 1.142, packaged, no extensions | 761 MB | 848 MB | 12 |

The dev-build rows show the direction of each change: removing Copilot and
the agent host cut about 240 MB (16 %). A dev build loads unminified modules,
so its absolute numbers don't compare with packaged apps.

### Packaged build

Same method: a fresh profile and `bench/fixture`. The app opened on its own
for 12 seconds, then memory was sampled every 5 seconds for 30 seconds. Both
apps settle after about 20 seconds.

| Build | Average | Peak | After it settles | Processes |
| --- | --- | --- | --- | --- |
| **FriedLiver fork 1.142.0, packaged** (Copilot removed, AI features off, Agents panel open) | 731 MB | 814 MB | about 580 MB | 11 |
| Stock VS Code 1.105, packaged, no extensions | 702 MB | 745 MB | about 620 MB | 10 |
| FriedLiver 0.2, the Electron app ([benchmarks](../benchmarks.md)) | 314 MB | 321 MB | | 6 |

The fork weighs about what VS Code does. It settles about 40 MB lower than
stock VS Code even with its Agents panel's webview open, and averages a bit
more while it starts. It is more than twice the size of the FriedLiver
Electron app, as expected for a full VS Code workbench. Further cuts are in
[memory-plan.md](memory-plan.md), items 3 to 10.

## Extensions from Open VSX

Installed with the fork's CLI into a throwaway profile:
`code/vscode/scripts/code-cli.sh --user-data-dir <tmp> --extensions-dir <tmp>
--install-extension <id>`.

| Extension | Result |
| --- | --- |
| esbenp.prettier-vscode | Installed 12.4.0 |
| dbaeumer.vscode-eslint | Installed 3.0.34 |
| eamodio.gitlens | Installed 19.4.0. Open VSX's newest, 2026.10.x, was not picked; the gallery chose the newest compatible release |
| golang.go | Installed 0.56.1 |
| rust-lang.rust-analyzer | Installed 0.3.3081, linux-x64 build. Newest is 0.4.3085, likely a pre-release |
| ms-python.python | Installed 2026.4.0, with its dependencies ms-python.debugpy 2026.6.0 (linux-x64) and ms-python.vscode-python-envs 1.40.0 |

All six install, 135 MB in total. Whether each one activates and works in the
editor hasn't been checked yet.

## Screenshots

- [packaged-first-start.png](screenshots/packaged-first-start.png): the
  packaged fork on a fresh profile. The Agents panel opens on the right by
  itself, in the Black Blue theme, with no Copilot.
- [dev-before-copilot-removal.png](screenshots/dev-before-copilot-removal.png):
  the first dev build, an empty window with upstream's Copilot "Sign In" and
  "Build with Agent" chat.
- [dev-folder-open.png](screenshots/dev-folder-open.png): `bench/fixture`
  open, the FriedLiver Black Blue theme, the FriedLiver Agents panel on the
  right, no Copilot.

## Known gaps

- **Unsigned builds.** Windows SmartScreen and macOS Gatekeeper warn on first
  launch. Signing needs a Windows code-signing certificate and an Apple
  Developer ID (for notarization), both bought in the publisher's name.
- **No Windows 11 context-menu entry.** That package is built by Microsoft's
  pipeline; the setup leaves it out (patch 0030), and the classic
  "Open with FriedLiver" entry still works.
- **No remote-tunnel CLI** (`friedliver-tunnel`). Microsoft builds it from
  upstream's Rust `cli/`; FriedLiver doesn't need it.
- The `@github/copilot-sdk` runtime is still packaged in the app's
  `node_modules`, because the agent-host code imports it. It no longer runs.
  The `github` built-in still activates on `*` (memory-plan item 3).
- Running as root shows "It is not recommended to run FriedLiver as root
  user". That message is expected in this container.
