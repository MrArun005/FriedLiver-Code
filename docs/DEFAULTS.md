# FriedLiver fork: themes and defaults

Upstream reference: VS Code `1.142.0` (tag `d956e8a6`). Line numbers below are
from that tag.

## What ships

`extensions/friedliver-theme` is a built-in extension with no code. It
contributes four color themes and a set of `configurationDefaults`.

| Theme | uiTheme | File |
|---|---|---|
| FriedLiver Black Blue (default) | vs-dark | `themes/friedliver-black-blue-color-theme.json` |
| FriedLiver Light Blue | vs | `themes/friedliver-light-blue-color-theme.json` |
| FriedLiver Midnight Blue | vs-dark | `themes/friedliver-midnight-blue-color-theme.json` |
| FriedLiver Graphite | vs-dark | `themes/friedliver-graphite-color-theme.json` |

The theme JSONs are generated. Edit `palette.json`, then run
`node extensions/friedliver-theme/scripts/generate-themes.mjs`.
`test/themes.test.ts` fails if the JSONs drift from the palette, if any
text pair drops below WCAG AA (4.5:1), if an icon, squiggle or keyboard focus
ring drops below 3:1, if any token color drops below 4.5:1 on the editor
background, if a border between two differently toned regions stops being
transparent, or if neighbouring surfaces stop differing in tone (1.04:1).
`.vscodeignore` keeps `scripts/` and `palette.json` out of the packaged
extension.

Each theme sets about 800 workbench colors. Every key exists in the 1.142
color registry. The keys were checked against every `registerColor(...)` in
`src/vs` and every `contributes.colors` in `extensions/`.

### How the palette maps

| Token | Used for |
|---|---|
| `sunken` | inputs, dropdowns, checkboxes, command center, peek editor, notebook cell editors |
| `ground` | editor, terminal, active tab (classic and Modern UI connected tabs), breadcrumbs, output |
| `panel` | chrome: side bars, activity bar, panel, status bar, title bar, tab strip, and Modern UI's shell and cards (`modernUI.shellBackground`, `surface.background`); also menus, widgets, notifications, quick input |
| `raised` | selected and focused rows, the selected activity item and pane tab (`modernActivityBarItem.*`, `modernTab.*`), secondary buttons, quiet badges, status bar remote/debug/error/warning items. Hover is `raised` at 60% |
| `line` / `line-strong` | seams inside one tone only: split editors, stacked views, menu separators, overlay outlines. Borders between surfaces of different tones are transparent: side bar, activity bar, panel, tab strip, title bar, status bar, sticky scroll headers, and Modern UI's card frames (`surface.border`, `modernPanel.border`, `modernActivityBar.border`, `editor.border`) |
| `accent` | only: primary button, prominent extension button, activity badge, chat "needs input" indicator |
| `accent-line` | focus rings (`focusBorder`, list focus outline, input focus). Alpha `a6` in dark themes and `cc` in Light Blue, so a ring is at least 3:1 against every surface |
| `info` | an agent working: progress bar, chat in-progress border, queued tests, running notebook cells |
| `warn` | git modified (decorations, gutter, overview ruler, minimap) and terminal yellow. Exception: warning diagnostics also use it, because VS Code needs a hue for warnings that is distinct from errors, and the palette has no other |
| `ok` / `bad` | git added and deleted, diff inserted and removed, test pass and fail, errors |

Other decisions:
- The cursor is `text`, not `accent`. Selection, word highlight and bracket
  match use `text-2` at low alpha, so nothing blue appears unless something
  needs a decision. Find matches use the syntax `type` hue.
- Tone, not lines. Upstream's Modern UI (`workbench.experimental.modernUI`,
  on by default in 1.142) draws the side bars and panel as floating cards.
  Its shell and the cards are all `panel`, with transparent frames, so the
  chrome reads as one quiet surface and the editor is a `ground` well inside
  it. The resting sash grips are hidden (`modernSash.gripForeground` is
  transparent): a splitter shows only on hover, as a `muted` bar
  (`sash.hoverBorder`).
- Active tab: `ground`, connected to the editor by tone alone (no top
  border, `tab.activeBorderTop` is transparent). Inactive tabs: `muted` on
  `panel`, with a `raised` hover. The panel's active title keeps a subtle
  `text` underline in the classic layout.
- Activity bar: the selected item is `raised` with `text`.
  `activityBar.activeBorder` is `text-2`; the workbench stylesheet (patch
  0110) draws it as a short pill at the bar's edge instead of the full-height
  stripe.
- Status bar: `panel` with `muted` text and no top border. Debugging, remote,
  offline, error and warning items are `raised` chips with readable text.
  There is no colored bar.
- Scrollbar sliders are `muted` at 25/45/60% (rest, hover, drag); the
  stylesheet paints them thin and rounded.
- Comments are upright, with no italic anywhere except `markup.italic`.
- Functions use `identifier`, because the syntax palette has no function hue.
  The upstream Electron app's Monaco theme did the same.
- Bracket pairs cycle keyword, type, number. Indent guides use `line`; the
  active guide uses `line-strong`.
- The terminal ANSI colors come from the palette. Bright variants are mixed
  25% toward white in dark themes and 15% toward black in the light theme,
  so all 16 colors stay above 4.5:1. The only exception is ANSI black in dark
  themes, which is the raised surface on purpose.

## configurationDefaults the extension sets

An extension's `configurationDefaults` can only override settings with
`window`, `resource`, `language-overridable` or `machine-overridable` scope.
Settings with `disallowConfigurationDefault` are rejected too. The rule is in
`src/vs/workbench/api/common/configurationExtensionPoint.ts:217-231`, which
warns "Only defaults for machine-overridable, window, resource and language
overridable scoped settings are supported." Object-valued defaults merge with
the registered default rather than replacing it
(`src/vs/platform/configuration/common/configurationRegistry.ts:714-736`).
Every key below was checked against its registration. User and workspace
settings override all of them.

| Setting | Value | Scope (source) | Why |
|---|---|---|---|
| `workbench.colorTheme` | `FriedLiver Black Blue` | window (`services/themes/common/themeConfiguration.ts:35`) | design |
| `workbench.preferredDarkColorTheme` | `FriedLiver Black Blue` | window (`:45`) | design |
| `workbench.preferredLightColorTheme` | `FriedLiver Light Blue` | window (`:55`) | design |
| `editor.fontFamily` | `'Geist Mono', 'JetBrains Mono', 'Cascadia Code', Menlo, Consolas, monospace` | language-overridable (`editor/common/config/editorOptions.ts:6416`) | fonts |
| `editor.fontSize` | `13` | language-overridable | fonts |
| `editor.lineHeight` | `1.55` (values under 8 are multipliers, `editorOptions.ts:3390`) | language-overridable | fonts |
| `editor.fontLigatures` | `false` | language-overridable | fonts |
| `terminal.integrated.fontFamily` | same as the editor | window (`contrib/terminal/common/terminalConfiguration.ts:179`) | fonts |
| `terminal.integrated.fontSize` | `13` | window (`:222`) | fonts |
| `terminal.integrated.lineHeight` | `1.2` | window (`:234`) | 1.55 is too tall for TUIs |
| `terminal.integrated.fontLigatures.enabled` | `false` | window (`:195`) | fonts |
| `editor.minimap.enabled` | `false` | window (`editorOptions.ts:3505`) | quieter, and one canvas fewer per editor |
| `editor.overviewRulerBorder` | `false` | language-overridable (`editorOptions.ts:6584`) | quieter |
| `editor.guides.bracketPairs` | `active` | language-overridable (`editorOptions.ts:4915`) | a guide only for the bracket pair the cursor is in: shows structure where you work, nothing elsewhere |
| `editor.renderLineHighlight` | `line` | language-overridable | pinned |
| `editor.cursorSmoothCaretAnimation` | `on` | language-overridable (`editorOptions.ts:6258`) | the caret glides to its new position; a CSS transition, no extra rendering |
| `editor.smoothScrolling` | `true` | language-overridable (`editorOptions.ts:6780`) | animated scrolling; only runs while scrolling |
| `editor.stickyScroll.enabled` | `true` | language-overridable (`editorOptions.ts:3204`) | keeps the enclosing scopes in view; already the upstream default, pinned |
| `editor.padding.top` | `8` | language-overridable (`editorOptions.ts:3665`) | the first line doesn't touch the tab strip |
| `window.commandCenter` | `true` | window (`browser/workbench.contribution.ts:917`) | the pill search field in the title bar; already the upstream default, pinned |
| `workbench.tree.indent` | `12` | window (`platform/list/browser/listService.ts:1417`) | nesting is easier to follow than with 8px |
| `workbench.list.smoothScrolling` | `true` | window (`listService.ts:1430`) | lists and trees scroll like the editor |
| `terminal.integrated.smoothScrolling` | `true` | window (`contrib/terminal/common/terminalConfiguration.ts:660`) | the terminal scrolls like the editor; wheel scrolling only |
| `workbench.fontAliasing` | `antialiased` | window (`browser/workbench.contribution.ts:727`) | macOS only; thinner text on dark surfaces |
| `workbench.layoutControl.enabled` | `false` | window (`workbench.contribution.ts:803`) | quieter title bar |
| `workbench.tips.enabled` | `false` | window (`workbench.contribution.ts:823`) | quieter empty editor |
| `extensions.ignoreRecommendations` | `true` | window (`contrib/extensions/browser/extensions.contribution.ts:197`) | no recommendation toasts |
| `typescript.disableAutomaticTypeAcquisition` | `true` | window (`extensions/typescript-language-features/package.json`) | memory, see memory-plan.md item 5 |
| `files.watcherExclude` | adds `**/node_modules/*/**` and the tool caches `**/{.venv,venv,__pycache__,.mypy_cache,.pytest_cache,.next,.nuxt,.turbo,.parcel-cache,.gradle}/**` (each its own key) (merged with the upstream defaults) | resource (`contrib/files/browser/files.contribution.ts:294`) | memory, see memory-plan.md item 4; the caches: watcher and extension-host CPU during `pip install`, `next build` and the like (CORE-PERF C10). Build outputs (`dist`, `build`, `target`, `out`) and `node_modules` as a whole stay watched on purpose: extensions' recursive `createFileSystemWatcher` calls inherit `files.watcherExclude` (`api/common/extHostFileSystemEventService.ts:178-190`), and TypeScript watches through them (`tsServer/fileWatchingManager.ts:57`), so `tsc -b` project references, cargo and gradle outputs, and newly installed packages would go stale |
| `typescript.tsserver.useSyntaxServer` | `never` | window (`extensions/typescript-language-features/package.json:2523`) | one tsserver per window instead of two, est. −40–80 MB and one Node process with TS/JS open (CORE-PERF C5). **Trade-off:** on large projects, syntax features (outline, folding, breadcrumbs, document highlights) wait for the semantic server's project load instead of answering at once. The key must be the `typescript.*` one: the extension reads `js/ts.tsserver.useSyntaxServer` first but only when a user or workspace set it (`src/utils/configuration.ts:23-37` ignores defaults there), then falls back to `typescript.*`, which sees this default. Either key in user settings wins |
| `workbench.startupEditor` | `none` | resource (`contrib/welcomeGettingStarted/browser/gettingStarted.contribution.ts:317`) | no Welcome editor in a window with nothing to restore: est. −5–15 MB renderer and the time to restore it (CORE-PERF C8). Walkthroughs stay under Help |
| `extensions.experimental.deferredStartupFinishedActivation` | `true` | window (`contrib/extensions/browser/extensions.contribution.ts:312`) | `onStartupFinished` extensions activate in 50 ms slices (`api/common/extHostExtensionService.ts:622-645`) instead of all in one extension-host task: fewer long tasks and less input lag in the first seconds. Each such extension may activate a few hundred ms later (CORE-PERF C7) |

`editor.cursorBlinking` is **not** set, so it is upstream's `blink`: a 500 ms
JS interval toggles the caret (`editor/browser/viewParts/viewCursors/viewCursors.ts:262-270`).
FriedLiver used to default it to `smooth`, which runs a CSS opacity animation
for 10 s after every caret change (`viewCursors.css:42-52`), so the renderer and
GPU process drew frames at display rate for 10 s each time you stopped typing
(CORE-PERF C6). `phase` and `expand` are CSS animations too.

The editor and list defaults above cost no memory: smooth scrolling and the
caret glide only run while something moves, and sticky scroll and the
command center were already on upstream. The memory-related defaults
(minimap off, no automatic type acquisition, `node_modules` out of the file
watcher) are unchanged. A comfortable row height is not among them: list and
tree rows are virtualized at fixed heights in code (22px), so the stylesheet
rounds and insets rows instead of resizing them.

The custom title bar is already upstream's default:
`window.titleBarStyle` defaults to `custom` in 1.142
(`src/vs/workbench/electron-browser/desktop.contribution.ts:243-248`). It is
application-scoped, so the extension couldn't set it anyway.

## Process and engine defaults (patches and the Agents extension)

Not settings, but defaults that change what runs. Measured in
[benchmarks.md, "Cutting memory at the app level"](benchmarks.md#cutting-memory-at-the-app-level).

| Default | Value | Where | Why, and how to undo |
|---|---|---|---|
| Debug task labels for launch.json's schema | collected when the first JSON or JSONC model opens, not 5 s after the window opens | patch 0050, `debugAdapterManager.ts` | memory: collecting them made npm's task provider open `package.json`, which started the JSON language server, `configuration-editing` and `extension-editing` in every JavaScript folder. `preLaunchTask` completions in launch.json work as before |
| How agents reach the FriedLiver tools | over MCP's streamable HTTP, at `http://127.0.0.1:<port>/mcp` in the extension host, for agents that advertise `mcpCapabilities.http`; otherwise a `dist/bridge.js` process per session | Agents extension (`src/bridge/http.ts`) | memory: no 19 MB process per chat. No setting of its own; `friedliver.connections.agentToAgent: off` still gives sessions no tools at all. Security: SECURITY.md, "The HTTP endpoint" |

## Settings an extension can't override (for the build owner)

These have `application` or `machine` scope, so the extension point drops
them with a warning.

**Desktop `product.json` has no `configurationDefaults` key.** In 1.142 the
only product-level defaults hook is the web embedder's
`IWorkbenchConstructionOptions.configurationDefaults`
(`src/vs/workbench/browser/web.api.ts:315`, consumed in
`src/vs/workbench/services/configuration/browser/configuration.ts:48-49`).
The build owner has two options. One is to switch the feature off through
`product.json` keys, shown in the right-hand column (this is how VSCodium
does it). The other is a small patch that reads a new `configurationDefaults`
field from `IProductService` and passes it to
`configurationRegistry.registerDefaultConfigurations()` next to that line.

| Setting | Suggested | Scope (source) | product.json route |
|---|---|---|---|
| `telemetry.telemetryLevel` | `off` | application (`src/vs/platform/telemetry/common/telemetryService.ts:321-339`) | ship no `aiConfig`/`ariaKey` keys. Code-OSS has none, so telemetry is a no-op |
| `workbench.enableExperiments` | `false` | application (`src/vs/workbench/services/assignment/common/assignmentService.ts:618`) | omit `tasConfig` |
| `update.mode` | `manual` (or `none` until FriedLiver has an update feed) | application (`src/vs/platform/update/common/update.config.contribution.ts:19`) | omit `updateUrl` and the update service stays idle. `none` also stops the Agents extension's release check |
| `update.showReleaseNotes` | `false` | application (`update.config.contribution.ts:74`) | omit `releaseNotesUrl` |
| `extensions.autoCheckUpdates` | `false` | application (`contrib/extensions/browser/extensions.contribution.ts:190`) | follows `extensionsGallery`; with no gallery, nothing is checked |
| `extensions.autoUpdate` | `false` | application (`extensions.contribution.ts:139`) | same |
| `workbench.welcomePage.walkthroughs.openOnInstall` | `false` | machine (`contrib/welcomeGettingStarted/browser/gettingStarted.contribution.ts:311`) | patch default |
| `window.titleBarStyle` | `custom` | application (`desktop.contribution.ts:243`) | already the upstream default |
| `window.menuStyle` | leave | application (`desktop.contribution.ts:270`) | none |
| `gulp.autoDetect`, `grunt.autoDetect`, `jake.autoDetect` | `off` | application (`extensions/{gulp,grunt,jake}/package.json`) | already `off` upstream |

## Security-relevant defaults

What the fork keeps or changes from upstream, for the threat model in
[SECURITY.md](../SECURITY.md).

| Default | Value | Where |
|---|---|---|
| Workspace trust (`security.workspace.trust.enabled`) | on, as upstream | not changed. The Agents extension declares `untrustedWorkspaces.supported: false`, so it doesn't run in Restricted Mode |
| Renderer sandbox, context isolation | as upstream | no patch touches them. `scripts/dev.mjs` adds `--no-sandbox` only for dev runs as root on Linux |
| Telemetry | off | `enableTelemetry: false`, no telemetry keys in product.json |
| Update service | none | no `updateUrl` |
| FriedLiver release check (`friedliver.update.mode`) | `notify`: 30 s after start, then every 4 h; application scope | Agents extension, FriedLiver app only. One anonymous GET to `api.github.com/repos/MrArun005/FriedLiver-Code/releases/latest`; also off when `update.mode` is `none` |
| Extension signature checks (`extensions.verifySignature`) | off | patch 0040; the verifier is Microsoft-only |
| Agent program (`friedliver.agents.*.command`, `.args`) | machine scope | Agents extension; read from user settings only |
| Link protection (`linkProtectionTrustedDomains`) | `https://open-vsx.org` | product.json; other links ask before they open |
| FriedLiver tools endpoint for agents that take MCP over HTTP | 127.0.0.1 only, random port, open from the first such session until the window closes; each request needs its chat's token (`Authorization: Bearer`), and another Host or Origin is refused | Agents extension, `src/bridge/http.ts`; SECURITY.md, "The HTTP endpoint" |

## Geist fonts: patch pending

Status: **not written.** `/home/user/build/vscode` did not exist during this
run (`ls: cannot access '/home/user/build': No such file or directory`).
Until the patch lands, the `'Geist Mono'` entry in `editor.fontFamily` falls
through to JetBrains Mono, Cascadia Code, Menlo or Consolas, and the UI keeps
upstream's system font.

Plan for `patches/0100-bundle-geist-fonts.patch`, against 1.142.0. It
must be made with `git diff --binary` because it adds woff2 files, and it
applies with `git apply`.

1. **Add the font files** (OFL-1.1) from `@fontsource-variable/geist@5.3.0`
   and `@fontsource-variable/geist-mono@5.3.0` (`files/`) to a new directory
   `src/vs/workbench/browser/media/fonts/`:
   - `geist-latin-wght-normal.woff2` (29,400 B)
   - `geist-latin-ext-wght-normal.woff2` (16,512 B)
   - `geist-mono-latin-wght-normal.woff2` (23,128 B)
   - `geist-mono-latin-ext-wght-normal.woff2` (14,696 B)
   - `OFL.txt` (the packages' `LICENSE`)

   The total is about 84 KB. Cyrillic and Vietnamese subsets can be added the
   same way. Also add them to `cglicenses.json` and `ThirdPartyNotices.txt` if
   the build's license check requires it.
2. **`src/vs/workbench/browser/media/style.css`** (loaded by
   `workbench.desktop.main`):
   - Add four `@font-face` rules: `font-family: 'Geist'` or `'Geist Mono'`,
     `font-weight: 100 900`, `font-display: swap`,
     `src: url('./fonts/<file>.woff2') format('woff2-variations')`. Copy the
     `unicode-range` values from the packages' `index.css`. Latin is
     `U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD`.
     Latin-ext is
     `U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF`.
   - Prepend `"Geist", ` to each `font-family` on lines 12–29: the
     `.monaco-workbench.mac`, `.windows` and `.linux` rules and their
     `:lang(...)` variants. The system and CJK fonts stay as fallbacks.
   - The CSP in `src/vs/code/electron-browser/workbench/workbench.html:41-45`
     already allows `font-src 'self'`, so it needs no change.
3. **`build/next/index.ts:517-522`**: add `'.woff2': 'file'` to the esbuild
   `loader` map. Production bundles CSS for `vs/workbench/workbench.desktop.main`
   (`build/next/index.ts:184`), and esbuild rejects an unknown asset
   extension. Dev and transpile builds copy every non-TS file under `src/`
   (`build/next/index.ts:270-292`), so they need nothing.
4. **Editor re-measure.** The editor measures `editor.fontFamily` once and
   caches the result (`src/vs/editor/browser/config/fontMeasurements.ts`). A
   web font that finishes loading after that leaves fallback metrics until
   the next display change. The only upstream hook is
   `src/vs/workbench/contrib/codeEditor/electron-browser/displayChangeRemeasureFonts.ts:25`.
   Add to the same contribution:
   `mainWindow.document.fonts.addEventListener('loadingdone', () => FontMeasurements.clearAllFontInfos())`.
   An alternative is to preload the two mono files with `<link rel="preload">`
   in `workbench.html`.

That touches three upstream files (`style.css`, `build/next/index.ts`,
`displayChangeRemeasureFonts.ts`) and adds one directory. The terminal
(xterm) uses the same document, so it gets Geist Mono from the same
`@font-face` rules.
