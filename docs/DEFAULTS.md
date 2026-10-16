# FriedLiver fork: themes and defaults

Upstream reference: VS Code `1.142.0` (tag `d956e8a6`). Line numbers below are
from that tag.

## What ships

`code/extensions/friedliver-theme` is a built-in extension with no code. It
contributes four color themes and a set of `configurationDefaults`.

| Theme | uiTheme | File |
|---|---|---|
| FriedLiver Black Blue (default) | vs-dark | `themes/friedliver-black-blue-color-theme.json` |
| FriedLiver Light Blue | vs | `themes/friedliver-light-blue-color-theme.json` |
| FriedLiver Midnight Blue | vs-dark | `themes/friedliver-midnight-blue-color-theme.json` |
| FriedLiver Graphite | vs-dark | `themes/friedliver-graphite-color-theme.json` |

The theme JSONs are generated. Edit `palette.json`, then run
`node code/extensions/friedliver-theme/scripts/generate-themes.mjs`.
`test/forkThemes.test.ts` fails if the JSONs drift from the palette, if any
text pair drops below WCAG AA (4.5:1), if an icon or squiggle drops below 3:1,
or if any token color drops below 4.5:1 on the editor background.
`.vscodeignore` keeps `scripts/` and `palette.json` out of the packaged
extension.

Each theme sets about 800 workbench colors. Every key exists in the 1.142
color registry. The keys were checked against every `registerColor(...)` in
`src/vs` and every `contributes.colors` in `extensions/`.

### How the palette maps

| Token | Used for |
|---|---|
| `sunken` | inputs, dropdowns, checkboxes, command center, peek editor, notebook cell editors |
| `ground` | editor, terminal, active tab, breadcrumbs, output |
| `panel` | side bars, activity bar, panel, status bar, title bar, tab strip, menus, widgets, notifications, quick input |
| `raised` | selected and focused rows, hovered tabs, the selected activity item, secondary buttons, quiet badges, status bar remote/debug/error/warning items |
| `line` / `line-strong` | borders. Structural borders between surfaces of different tones are transparent: side bar, activity bar, panel, tabs |
| `accent` | only: primary button, prominent extension button, activity badge, chat "needs input" indicator |
| `accent-line` | focus rings (`focusBorder`, list focus outline, input focus) |
| `info` | an agent working: progress bar, chat in-progress border, queued tests, running notebook cells |
| `warn` | git modified (decorations, gutter, overview ruler, minimap) and terminal yellow. Exception: warning diagnostics also use it, because VS Code needs a hue for warnings that is distinct from errors, and the palette has no other |
| `ok` / `bad` | git added and deleted, diff inserted and removed, test pass and fail, errors |

Other decisions:
- The cursor is `text`, not `accent`. Selection, word highlight and bracket
  match use `text-2` at low alpha, so nothing blue appears unless something
  needs a decision. Find matches use the syntax `type` hue.
- Active tab: `ground` with a top border in `text` at 35–40% alpha. Inactive
  tabs: `muted` on `panel`. The panel's active title uses the same subtle
  border.
- Activity bar: the selected item is `raised` with `text` and no indicator
  bar (`activityBar.activeBorder` is transparent).
- Status bar: `panel` with `text-2`. Debugging, remote, offline, error and
  warning items are `raised` chips with readable text. There is no colored
  bar.
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
Every key below was checked against its registration.

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
| `editor.guides.bracketPairs` | `false` | language-overridable | quieter (already the upstream default; pinned) |
| `editor.renderLineHighlight` | `line` | language-overridable | pinned |
| `workbench.fontAliasing` | `antialiased` | window (`browser/workbench.contribution.ts:727`) | macOS only; thinner text on dark surfaces |
| `workbench.layoutControl.enabled` | `false` | window (`workbench.contribution.ts:803`) | quieter title bar |
| `workbench.tips.enabled` | `false` | window (`workbench.contribution.ts:823`) | quieter empty editor |
| `extensions.ignoreRecommendations` | `true` | window (`contrib/extensions/browser/extensions.contribution.ts:197`) | no recommendation toasts |
| `typescript.disableAutomaticTypeAcquisition` | `true` | window (`extensions/typescript-language-features/package.json`) | memory, see memory-plan.md item 5 |
| `files.watcherExclude` | adds `**/node_modules/*/**` (merged with the upstream defaults) | resource (`contrib/files/browser/files.contribution.ts:294`) | memory, see memory-plan.md item 4 |

The custom title bar is already upstream's default:
`window.titleBarStyle` defaults to `custom` in 1.142
(`src/vs/workbench/electron-browser/desktop.contribution.ts:243-248`). It is
application-scoped, so the extension couldn't set it anyway.

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
| `update.mode` | `manual` (or `none` until FriedLiver has an update feed) | application (`src/vs/platform/update/common/update.config.contribution.ts:19`) | omit `updateUrl` and the update service stays idle |
| `update.showReleaseNotes` | `false` | application (`update.config.contribution.ts:74`) | omit `releaseNotesUrl` |
| `extensions.autoCheckUpdates` | `false` | application (`contrib/extensions/browser/extensions.contribution.ts:190`) | follows `extensionsGallery`; with no gallery, nothing is checked |
| `extensions.autoUpdate` | `false` | application (`extensions.contribution.ts:139`) | same |
| `workbench.welcomePage.walkthroughs.openOnInstall` | `false` | machine (`contrib/welcomeGettingStarted/browser/gettingStarted.contribution.ts:311`) | patch default |
| `window.titleBarStyle` | `custom` | application (`desktop.contribution.ts:243`) | already the upstream default |
| `window.menuStyle` | leave | application (`desktop.contribution.ts:270`) | none |
| `gulp.autoDetect`, `grunt.autoDetect`, `jake.autoDetect` | `off` | application (`extensions/{gulp,grunt,jake}/package.json`) | already `off` upstream |

## Geist fonts: patch pending

Status: **not written.** `/home/user/build/vscode` did not exist during this
run (`ls: cannot access '/home/user/build': No such file or directory`).
Until the patch lands, the `'Geist Mono'` entry in `editor.fontFamily` falls
through to JetBrains Mono, Cascadia Code, Menlo or Consolas, and the UI keeps
upstream's system font.

Plan for `code/patches/0100-bundle-geist-fonts.patch`, against 1.142.0. It
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
