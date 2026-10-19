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

Installers (none notarized; macOS signed with FriedLiver's own certificate when CI has it, see [macOS signing](#macos-signing-and-privacy-prompts)):

| OS | File | Made by |
| --- | --- | --- |
| Windows | `FriedLiverUserSetup-<arch>-<version>.exe`, installs per user | `gulp vscode-win32-<arch>-inno-updater` and `-user-setup` (Inno Setup from upstream's `innosetup` package) |
| macOS | `FriedLiver-darwin-<arch>-<version>.dmg` | `codesign` (the self-signed certificate, or ad-hoc without it), then `hdiutil` |
| Linux | `friedliver_<version>_amd64.deb` | `gulp vscode-linux-<arch>-prepare-deb` and `-build-deb` |

CI (`.github/workflows/build.yml`) builds all three with the portable apps on
every push to `main`. For a pushed tag `vX.Y.Z` or `vX.Y.Z-N` (the upstream
version, then FriedLiver's own build number) it also publishes a GitHub
release with every installer, the portable apps and `SHA256SUMS.txt`. Only that
release job gets a token that can write (`contents: write`).

### Releasing an update

1. Run **Actions → Release → Run workflow** on `main` ([RELEASING.md](RELEASING.md)).
   It refuses unless CI passed on main's head, picks the next version (the
   pinned upstream version, then FriedLiver's own build number one higher than
   the last tag, e.g. `1.142.0-8`) and writes the notes. (By hand still works:
   `git tag v1.142.0-8 && git push origin v1.142.0-8`.)
2. It calls `build.yml`, which builds all three OSes with `FRIEDLIVER_VERSION` set from the tag
   (stamped into `product.json` as `friedliverVersion`), then the release job
   writes `SHA256SUMS.txt` over every asset (it fails if the macOS arm64 DMG is
   missing) and publishes the GitHub release, creating the tag. Then a Mac
   downloads the published DMG and zip and checks them against
   `SHA256SUMS.txt` and the signing certificate.
3. Running apps see it: the Agents extension asks
   `api.github.com/repos/MrArun005/FriedLiver-Code/releases/latest` 30 s after
   start and every 4 h. When the release is newer than `friedliverVersion`, a
   bottom-right toast says "FriedLiver X.Y.Z is available" with **Install**,
   **Release notes** and **Later** (each version once per launch).
   - **Install** on macOS arm64 downloads `FriedLiver-darwin-arm64-*.dmg`
     (https, only from this repo's release downloads and GitHub's asset hosts,
     every redirect checked), checks its size and its SHA-256 against
     `SHA256SUMS.txt` (missing or different: it refuses), then offers
     **Restart to update**. A script in a private temp folder, started as its
     own background app (`FriedLiver Update.app`, so quitting or force-quitting
     FriedLiver can't stop it), waits for the app to exit, mounts the DMG
     read-only at a mountpoint inside that folder (no second checksum pass,
     one retry), swaps the running `.app` (wherever it is), and reopens it. It
     always detaches the image and deletes its folder. On failure the current
     app is untouched and the next launch says why, with **Download manually**
     (the release page) and **Show log** (`$TMPDIR/friedliver-update.log`,
     with the mount's exit codes). If the `.app` or its folder isn't
     writable, the verified DMG is opened instead.
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
| `FRIEDLIVER_VERSION` | newest release tag in the checkout's history | Version stamped into `product.json` as `friedliverVersion` (`v1.142.0` or `v1.142.0-2`); release builds set it from the tag. Other builds take the newest `vX.Y.Z[-N]` tag that HEAD contains (the pinned upstream version when git has no tags), so the update check only offers a newer release, and stamp `friedliverBuild` as e.g. `1.142.0-7+3.gd0cca9f1ae` (3 commits past it) |
| `FRIEDLIVER_REQUIRE_PINS` | unset | When set, a download with no SHA-256 pin in `scripts/checksums.json` fails the build (release builds set it) |
| `FRIEDLIVER_KEEP_LOCALES` | `en,en-GB` | Chromium locale packs `--package` keeps (`<lang>.lproj` in macOS's Electron Framework, `locales/<lang>.pak` elsewhere); English is always kept as Chromium's fallback, `all` keeps every pack. The others are about 45 MB on macOS. Only Chromium's own strings (spellcheck and webview context menus, a few native dialogs) are affected; FriedLiver's UI language comes from VS Code language packs |

### The dictation helper (macOS)

The composer's mic runs `friedliver-dictate`, a small Swift program
(`extensions/friedliver-agents/native/friedliver-dictate.swift`) that listens
with AVAudioEngine and SFSpeechRecognizer (on-device when macOS has the
language) and writes JSON lines (`{"partial":…}`, `{"final":…}`,
`{"error":…,"code":…}`, and `{"level":0…1}` about 20 times a second for the
listening mic's visualizer) that the extension streams into the message box.
The host checks every line (levels must be finite; they are clamped to 0…1)
and forwards levels at most 30 times a second, to the dictating chat only.

- `extensions/friedliver-agents/native/build.sh` builds it into the
  extension's `bin/` (gitignored, shipped by `.vscodeignore`), with its
  `Info.plist` embedded, ad-hoc signed. `build.yml` runs it on macOS before
  `prepare.mjs`, which copies it into the app; `ci.yml` type-checks it on
  every push (`build.sh --check`). For a local macOS build, run it before
  `prepare.mjs`. Needs Xcode or the Command Line Tools.
- `build.mjs` (macOS installer step) adds `NSMicrophoneUsageDescription`
  and `NSSpeechRecognitionUsageDescription` to the app's `Info.plist` and
  signs the helper before it signs the app, so macOS asks for permission
  once, for FriedLiver (the helper runs as the app's child).
- The extension only runs the helper at its fixed path inside the
  extension folder (in the app, inside `FriedLiver.app`), never from `PATH`
  or the workspace. Without it (a dev build, stock VS Code) the mic shows
  the old "Press Fn twice" hint.

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
signed with FriedLiver's self-signed certificate (ad-hoc on forks and local
builds), not notarized, so macOS asks once under System Settings →
Privacy & Security → Open Anyway.

### macOS signing and privacy prompts

macOS keeps privacy grants (Desktop, Documents and Downloads folders,
Microphone, Speech Recognition, Automation) per app, keyed by the app's
*designated requirement*. An ad-hoc signature (`codesign --sign -`) has no
certificate, so its requirement is the build's `cdhash`, which changes with
every build: after each update macOS treats FriedLiver as a new app and asks
again. A signature from a certificate gives a requirement that names the
bundle id and the certificate, the same for every build:

```
designated => identifier "com.friedliver.app" and certificate root = H"b96aa277…"
```

What CI does (`build.yml`, macOS job):

1. **Signing keychain (macOS)**: when the secrets `MACOS_SIGN_P12` (base64
   PKCS#12), `MACOS_SIGN_P12_PASSWORD` and `MACOS_SIGN_IDENTITY` are set, it
   makes a throwaway keychain under `$RUNNER_TEMP` with a random password,
   imports the certificate for `codesign` only (`-T /usr/bin/codesign`,
   `set-key-partition-list`), puts it on the search list and exports
   `MACOS_SIGN_IDENTITY` and `MACOS_SIGN_KEYCHAIN`. Without the secrets (forks)
   it does nothing and the app stays ad-hoc signed. Secrets reach the script
   only through `env:`; the keychain password is masked.
2. `build.mjs` signs the dictation helper, then the app with `--deep`
   (helpers and frameworks inside it), using that identity
   (`codesignArgs` in `scripts/lib.mjs`: `--timestamp=none --keychain …`, no
   hardened runtime, which Electron would need entitlements for). The bundle
   id stays `com.friedliver.app` (`product.json`).
3. **Check the signature (macOS)**: `codesign --verify --deep --strict`, and
   prints `codesign -d -r-`; with a certificate the step fails unless the
   requirement contains `certificate root = H"…"` and no `cdhash`.
4. **Remove the signing keychain (macOS)** runs `if: always()`.

`test/scripts.test.ts` checks the argument logic and the workflow's order;
the signing itself only runs on CI's macOS runner.

**After the first signed release**, macOS asks one last time (the
requirement changed from a cdhash to the certificate); from then on updates
keep the grants. Gatekeeper still shows "Open Anyway" on first launch: the
certificate is not Apple-issued and the app is not notarized.

**Rotating the certificate.** The owner keeps it in `~/Private/friedliver-signing`.
To replace it, make a new self-signed code-signing certificate (Keychain
Access → Certificate Assistant → Create a Certificate, type *Code Signing*,
or `openssl` with `extendedKeyUsage = codeSigning`), export it with its key as
a `.p12` (with `-legacy` for OpenSSL 3, so `security import` reads it), then
set `MACOS_SIGN_P12` (`base64 -i cert.p12`), `MACOS_SIGN_P12_PASSWORD` and
`MACOS_SIGN_IDENTITY` (its common name) in the repository's Actions secrets.
A new certificate has a new root hash, so macOS asks once more after that
release; put the new hash in `CERT_ROOT` in `.github/workflows/release.yml`
(the release check fails until then). Keep it valid for years: an expired certificate still verifies (no
timestamp is needed for a self-signed one), but rotate before it leaks, not
on a schedule.

**Apple Developer ID instead** ($99/year): import the Developer ID
Application certificate the same way (same three secrets), add
`--options runtime` with an entitlements file allowing JIT and unsigned
executable memory for Electron, then notarize the DMG (`xcrun notarytool
submit … --wait` with an App Store Connect API key in further secrets) and
`xcrun stapler staple` it. That also removes the Gatekeeper warning.

FriedLiver itself avoids prompting where it can: with no folder open,
agents start in an empty folder of FriedLiver's (global storage
`no-folder/`) rather than the home folder, so an agent's start-up scan
doesn't reach Desktop, Documents or Downloads.

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
- **`0110-modern-workbench.patch`** and **`workbench/friedliver.css`**: the
  workbench built from the design system (`~/code/FriedLiver-Code-design/COMPONENTS.md`,
  plan in `WORKBENCH-MODERN-PLAN.md`). The patch imports two stylesheets from
  `src/vs/workbench/browser/style.ts`, right after upstream's `style.css`;
  `prepare.mjs` writes both into the checkout:
  - `friedliver-tokens.css`, generated by `scripts/workbench-tokens.mjs` from
    the Agents extension's `media/tokens.css`: every token prefixed `--fl-`,
    `:root` scoped to `.monaco-workbench`, the light and high-contrast blocks to
    the workbench's theme classes. One set of numbers for the webviews and the
    workbench.
  - `friedliver.css`, copied from `workbench/friedliver.css`. Each block names
    the spec component it renders (Button, Input, Select, Checkbox, Count, Kbd,
    Menu and its palette variant, Tooltip, Toast, Dialog, …). Upstream widgets
    paint their colours inline from `--vscode-*` variables, so a block re-points
    those variables on the widget itself. Every rule is scoped to
    `.monaco-workbench:not(.hc-black):not(.hc-light)`; no `:has()` and no
    class-substring selectors (upstream's `contrib/modernUI/CSS_PERFORMANCE.md`).
    `test/workbench-css.test.ts` fails on any raw size, colour, shadow or duration.

  The patch's code changes, each where CSS can't reach:
  - `base/browser/ui/menu/menu.ts` (menus render in a shadow root): row height,
    row radius, separator margin and the glass blur read the tokens, with
    upstream's values as fallbacks.
  - `notificationsViewer.ts`, `notificationsToasts.ts`, `notificationsCenter.ts`:
    toasts 400 wide with 38px rows (Toast §2.15: 8 + 22 + 8).
  - `electron-browser/desktop.contribution.ts`: `window.menuStyle` defaults to
    `inherit` and `window.dialogStyle` to `custom` on every platform, so macOS
    shows the styled menus and dialogs instead of native ones.
  - `services/layout/browser/layoutService.ts`: the frosted-glass opacity
    defaults to the spec's 84%.

  To iterate without a full compile, edit `workbench/friedliver.css`, copy it to
  `out/vs/workbench/browser/media/` in the prepared checkout and reload the
  window (Developer: Reload Window). For the TypeScript parts, edit the checkout
  and regenerate the patch from the diff of those files.

  The look is checked in CI: a manual Build FriedLiver run (`workflow_dispatch`)
  also runs `scripts/workbench-shots.mjs` on its macOS app (the `shots` job,
  artifact `workbench-shots`): every workbench surface in Black Blue, Light Blue
  and Dark 2026 at 1440×900, and the approved composer against its baseline.
  A clean dev rebuild of `out/` is `npm run transpile-client` in the
  checkout (about 20 s, no type check).
- **`0200-fast-shell-env.patch`**: the extension host no longer waits for the
  login shell (`friedliver.fastShellEnv`, see [DEFAULTS.md](DEFAULTS.md)). It
  adds `src/vs/workbench/services/extensions/common/shellEnvCache.ts` (no
  imports: the allow-list, the cache and a raw protocol message `0xFE
  'FLSHENV'` + JSON beside Initialized/Ready/Terminate), uses it in
  `localProcessExtensionHost.ts` and applies the message in
  `api/node/extensionHostProcess.ts`. `test/shellEnvCache.test.ts` runs that
  new file straight out of the patch (`test/patchedFile.ts`), so the filter is
  tested without an upstream checkout.
- **`0210-node-compile-cache-posix.patch`**: Node.js compile cache for the
  utility processes on macOS and Linux. Upstream turned POSIX off with a TODO
  that blames its *packaged* cache (portable + read-only/eager, generated at
  build time, `build/lib/nodeCompileCache.ts` makes it for win32-x64 only).
  This uses the plain Node API instead (`module.enableCompileCache({ directory })`:
  writable, not portable, not eager), the same call upstream makes on Windows
  in Electron's Node, documented for CommonJS and ESM since Node 22.1. Node
  validates entries against the module's source and its own version; the
  folder is `CachedData/<commit>/node/<kind>`, so the shared process's
  `CodeCacheCleaner` deletes old versions. `mainImpl.ts` sets
  `FRIEDLIVER_NODE_COMPILE_CACHE` once the user data folder is known (unless
  argv.json says `"node-compile-cache": false`, schema in
  `desktop.contribution.ts`); utility processes inherit it. Node only writes
  the cache when a process exits normally, so each one also flushes 20 s after
  it starts. Check: the extension host's log says
  `[node-compile-cache] extension-host: … (status: enabled, configured: …/CachedData/<commit>/node/extension-host …)`
  and that folder fills after the first launch.
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
- **No Apple- or Microsoft-issued signatures.** Windows SmartScreen and macOS
  Gatekeeper warn on first launch. macOS builds carry a self-signed
  certificate (stable privacy grants, see above); removing the warnings needs
  a Windows code-signing certificate and an Apple Developer ID (for
  notarization), both bought in the publisher's name.
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
