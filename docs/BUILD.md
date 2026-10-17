# Building FriedLiver on VS Code (Code - OSS)

FriedLiver on VS Code is built VSCodium-style. This repo holds the pinned
upstream tag, product.json overrides, patches, branding, built-in extensions,
the agent core and the scripts. Upstream
[microsoft/vscode](https://github.com/microsoft/vscode) (MIT) is cloned at build
time. See the [README](../README.md) for the layout.

Pinned upstream: **1.142.0** (`d956e8a6ac5d904486557eea07e1d6bd62a4d36f`). On
2026-10-16 this was the newest version on `update.code.visualstudio.com/api/releases/stable`.

## Quick start (any OS)

```bash
node scripts/fetch.mjs        # shallow clone of the pinned tag into vscode (or $VSCODE_DIR)
node scripts/prepare.mjs      # patches, product.json, icon, built-in extensions
node scripts/build.mjs        # deps + npm ci + compile + Electron (dev build)
node scripts/dev.mjs [folder] # run from source; as root on Linux it adds --no-sandbox
node scripts/build.mjs --package   # minified app in <VSCODE_DIR>/../VSCode-<os>-<arch>
node scripts/build.mjs --package --installer   # plus the installer in <VSCODE_DIR>/../installers
```

Installers, all unsigned:

| OS | File | Made by |
| --- | --- | --- |
| Windows | `FriedLiverUserSetup-<arch>-<version>.exe`, installs per user | `gulp vscode-win32-<arch>-inno-updater` and `-user-setup` (Inno Setup from upstream's `innosetup` package) |
| macOS | `FriedLiver-darwin-<arch>-<version>.dmg` | an ad-hoc `codesign`, then `hdiutil` |
| Linux | `friedliver_<version>_amd64.deb` | `gulp vscode-linux-<arch>-prepare-deb` and `-build-deb` |

CI (`.github/workflows/build.yml`) builds all three with the portable apps on
every push to `main`. For a pushed tag `vX.Y.Z` or `vX.Y.Z-N` (the upstream
version, then FriedLiver's own build number) it also publishes a GitHub
release with every installer, the portable apps and `SHA256SUMS.txt`. Only that
release job gets a token that can write (`contents: write`).

### Releasing an update

1. Pick the version: the pinned upstream version, then FriedLiver's own build
   number, e.g. `1.142.0-2`. It must be newer than the last release, or apps
   won't see it.
2. Tag and push: `git tag v1.142.0-2 && git push origin v1.142.0-2`.
3. `build.yml` builds all three OSes with `FRIEDLIVER_VERSION` set from the tag
   (stamped into `product.json` as `friedliverVersion`), then the release job
   writes `SHA256SUMS.txt` over every asset (it fails if the macOS arm64 DMG is
   missing) and publishes the GitHub release.
4. Running apps see it: the Agents extension asks
   `api.github.com/repos/MrArun005/FriedLiver-Code/releases/latest` 30 s after
   start and every 4 h. When the release is newer than `friedliverVersion`, a
   bottom-right toast says "FriedLiver X.Y.Z is available" with **Install**,
   **Release notes** and **Later** (each version once per launch).
   - **Install** on macOS arm64 downloads `FriedLiver-darwin-arm64-*.dmg`
     (https, only from this repo's release downloads and GitHub's asset hosts,
     every redirect checked), checks its size and its SHA-256 against
     `SHA256SUMS.txt` (missing or different: it refuses), then offers
     **Restart to update**. A detached script in a private temp folder waits
     for the app to exit, mounts the DMG, swaps the running `.app` (wherever it
     is), and reopens it. If the `.app` or its folder isn't writable, the
     verified DMG is opened instead.
   - On Windows and Linux, Install opens the release page.
   - `friedliver.update.mode: "off"` (or `update.mode: "none"`) turns this off.

Drafts and pre-releases are ignored.

`.github/workflows/upstream.yml` runs every Monday. When
`update.code.visualstudio.com/api/releases/stable` lists a newer stable VS Code
than `upstream.json`, it opens a pull request moving the pin (`upstream.json`,
the pinned line above, the README). Check that the patches still apply before
merging. It needs **Settings → Actions → General → Allow GitHub Actions to
create and approve pull requests**. Pull requests made with the workflow token
don't start other workflows, so push to the branch to run CI on it.
Dependabot (`.github/dependabot.yml`) proposes updates for the pinned actions
and the npm lockfiles every week.

Environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `VSCODE_DIR` | `vscode` | Upstream checkout |
| `FRIEDLIVER_EXTENSIONS_DIR` | `extensions` | Where `prepare.mjs` takes the FriedLiver built-ins from |
| `FRIEDLIVER_CACHE_DIR` | `.cache` | Downloaded Node toolchain |
| `FRIEDLIVER_VERSION` | upstream tag | Version stamped into `product.json` as `friedliverVersion` (`v1.142.0` or `v1.142.0-2`); release builds set it from the tag |
| `FRIEDLIVER_REQUIRE_PINS` | unset | When set, a download with no SHA-256 pin in `scripts/checksums.json` fails the build (release builds set it) |

### What the scripts handle for you

- **Node version.** Upstream's `.nvmrc` wants **Node 24.18.0** (same major,
  >= 24.18.0), and its preinstall refuses anything else. If your Node doesn't
  match (this container has 22.22.0), `build.mjs` and `dev.mjs` download the
  exact version from nodejs.org into `.cache` (203 MB), check it against that
  release's `SHASUMS256.txt` before unpacking (a mismatch deletes it and
  stops the build), and put it first on `PATH`. Your system Node stays as it
  is. npm must be older than 13.
- **Linux packages.** `build.mjs` installs any of these that are missing with
  apt-get (with sudo unless you're root): `build-essential g++ make pkg-config
  python-is-python3 libx11-dev libxkbfile-dev libsecret-1-dev libkrb5-dev
  fakeroot rpm dpkg`. Use `--skip-deps` to skip this step.
- **ripgrep.** `@vscode/ripgrep` looks its binary up through `api.github.com`.
  That fails behind restrictive proxies, and without a token on CI it hits rate
  limits. `build.mjs` first puts the binary in the package's cache from the
  plain release-download URL. It checks the `@vscode/ripgrep` package against
  the integrity in upstream's `package-lock.json`, and the binary against its
  SHA-256 in `scripts/checksums.json` (ripgrep-prebuilt publishes no checksums,
  and the package's own download checks nothing). A mismatch stops the build.
  When an upstream bump changes `@vscode/ripgrep`, add the new binaries'
  hashes there; the upstream pull request reminds you.
- **Linux .deb sysroot.** Upstream's `prepare-deb` step reads the app's library
  dependencies with a toolchain sysroot that it also looks up through
  `api.github.com`; a 403 there failed Linux CI builds. `build.mjs`
  downloads the asset upstream names from the plain release-download URL,
  checks it against upstream's `build/checksums/vscode-sysroot.txt` before
  unpacking it into `.cache/vscode-<arch>-sysroot` (or `VSCODE_SYSROOT_DIR`),
  and writes the stamp that makes upstream skip its own lookup.
- **Flaky sub-installs.** Upstream's postinstall runs about 100 `npm ci` in
  parallel. If one of them dies (we saw `ECONNRESET`), `build.mjs` retries the
  postinstall instead of the whole `npm ci`.

### Windows

Install Git, Python 3, and Visual Studio 2022 or newer with the *Desktop
development with C++* workload (upstream checks this in preinstall). Then run
the same `node scripts/...` commands from a normal terminal. `dev.mjs`
runs `scripts\code.bat`. `--package` runs `gulp vscode-win32-x64-min`,
which also needs `signtool.exe` from the Windows SDK on PATH (it strips old
signatures before stamping FriedLiver's name into bundled binaries), and
`git config --global core.autocrlf false` before cloning, because the patches
use LF line endings. CI does both (`.github/workflows/build.yml`).

### macOS

Install the Xcode command line tools (`xcode-select --install`) and Python 3,
then run the same commands. `dev.mjs` runs `scripts/code.sh`. `--package` runs
`gulp vscode-darwin-<arch>-min`. Built on CI for Apple silicon; the app is
ad-hoc signed, not notarized, so macOS asks once under System Settings →
Privacy & Security → Open Anyway.

### Icons and branding

`prepare.mjs` copies `branding/icon.png` (1024 px, roasted liver) over
`resources/linux/code.png`, then copies `branding/overlay/` over the
upstream tree. `branding/make-branding.py` (Pillow) generates that overlay
from `branding/icon.png` and `branding/liver-art.svg`:

- Windows `code.ico`, Start tiles and the Inno Setup wizard pictures for every
  display scale.
- macOS `code.icns`, plus the server icons.
- The empty-editor watermark: the liver's silhouette, in upstream's letterpress style.

The generated files are committed, so builds need no Pillow. Run the script
again after changing the artwork.

## What prepare changes

- **product.json** ([product.json](../product.json)): FriedLiver
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
- **`0110-modern-workbench.patch`**: adds
  `src/vs/workbench/browser/media/friedliver.css` and imports it from
  `src/vs/workbench/browser/style.ts`, right after upstream's `style.css`. Dev
  and transpile builds copy it to `out/` and load it through the CSS import
  map; `--package` bundles it into `workbench.desktop.main.css`, so no build
  script changes. It builds on upstream's Modern UI
  (`workbench.experimental.modernUI`, on by default) and works with it off.
  Every rule is scoped to `.monaco-workbench:not(.hc-black):not(.hc-light)`,
  uses only `--vscode-*` theme colors and size tokens, and avoids `:has()`
  and class-substring selectors (upstream's
  `contrib/modernUI/CSS_PERFORMANCE.md`). What it does: redefines
  `--vscode-shadow-lg` and `--vscode-shadow-xl` from `widget.shadow`, so every
  overlay (palette, hovers, suggest, menus, notifications, dialogs, find,
  peek) gets a soft deep shadow; rounds the palette and dialogs at 12px,
  menus, hovers and suggest at 8px, rows, inputs and buttons at 6px; makes the
  command center a pill; draws the selected activity item's
  `activityBar.activeBorder` as a short pill at the bar's edge; narrows
  scrollbar sliders with a transparent border (the hit area stays the same);
  gives buttons a 2px focus ring; fades hover colors only when motion is
  enabled and never under `prefers-reduced-motion`. The colors that make
  regions separate by tone (transparent borders, no resting sash grips) are
  in the themes, see [DEFAULTS.md](DEFAULTS.md).

  To iterate on the stylesheet without a full compile, edit the file in the
  prepared checkout, copy it to `out/vs/workbench/browser/media/` and reload
  the window (Developer: Reload Window). Then regenerate the patch, adding
  the new file to the diff:

  ```bash
  git -C vscode add -N src/vs/workbench/browser/media/friedliver.css
  git -C vscode diff -- src/vs/workbench/browser/style.ts src/vs/workbench/browser/media/friedliver.css > patches/0110-modern-workbench.patch
  git -C vscode reset -q -- src/vs/workbench/browser/media/friedliver.css
  ```

  A clean dev rebuild of `out/` is `npm run transpile-client` in the
  checkout (about 20 s, no type check).
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
| `--package` (`gulp vscode-linux-x64-min`), after a dev build | about 5 min | 1.1 GB app in `VSCode-linux-x64` |

## Memory

Measured with the FriedLiver app's `scripts/ram-benchmark.ts --pid <main pid>
--seconds 30 --interval 5`: PSS over the whole process tree, under xvfb with software
rendering, a fresh profile, `bench/fixture` open. Same container as
[benchmarks.md](benchmarks.md).

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
| FriedLiver 0.2, the Electron app ([benchmarks](https://github.com/MrArun005/FriedLiver/blob/main/docs/benchmarks.md)) | 314 MB | 321 MB | | 6 |

The fork weighs about what VS Code does. It settles about 40 MB lower than
stock VS Code even with its Agents panel's webview open, and averages a bit
more while it starts. It is more than twice the size of the FriedLiver
Electron app, as expected for a full VS Code workbench. Further cuts are in
[memory-plan.md](memory-plan.md), items 3 to 10.

## Extensions from Open VSX

Installed with the fork's CLI into a throwaway profile:
`vscode/scripts/code-cli.sh --user-data-dir <tmp> --extensions-dir <tmp>
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

### Workbench look (patch 0110 and the themes)

Packaged build, `bench/fixture`, 1440×900, under xvfb with software rendering
(so upstream's frosted glass, which needs GPU compositing, is off), in
[screenshots/workbench/](screenshots/workbench/):

| Black Blue (default) | Light Blue | What it shows |
| --- | --- | --- |
| `black-blue-editor.png` | `light-blue-editor.png` | explorer, editor and the Agents panel: one chrome tone, the editor a rounded well, no lines between regions, the activity pill |
| `black-blue-command-palette.png` | `light-blue-command-palette.png` | the palette with its soft shadow and the pill command center |
| `black-blue-suggest.png` | `light-blue-suggest.png` | the suggest widget and its details |
| `black-blue-hover.png` | `light-blue-hover.png` | an editor hover |
| `black-blue-context-menu.png` | `light-blue-context-menu.png` | a context menu |
| `black-blue-notification.png` | `light-blue-notification.png` | notification toasts, the primary button in the decision color |
| `black-blue-walkthrough.png` | `light-blue-walkthrough.png` | the first-run walkthrough with its theme-aware illustration |

## Known gaps

- **No extension signature checks.** Patch 0040 turns off
  `extensions.verifySignature`, because the verifier (`@vscode/vsce-sign`) ships
  only with Microsoft's builds. Extensions come over HTTPS from Open VSX, whose
  list of malicious extensions still applies. See [SECURITY.md](../SECURITY.md).
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
