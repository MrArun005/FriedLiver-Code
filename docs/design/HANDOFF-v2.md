# Design System v2 "Beacon": hand-off to phases B and B2

Date: 2026-10-20. From Phase A (direction + system). Read in this order: `COMPONENTS.md` (v2, §0–§7), this file, `PANEL.md` (what the critics still want), then open the mocks.

**Status (2026-10-21):** Beacon has shipped, so this is a record of the hand-off, not open work. Changes since: no line above the active tab in any theme (so ignore `tab.activeBorderTop` sel-fg and "Tabs (top line)" below), and quick-pick titles start at the left edge. `COMPONENTS.md` is the current spec.

## What Phase A shipped

| Item | Where |
|---|---|
| Spec v2 (tokens, every component, stock workbench §6, decisions) | `~/code/FriedLiver-Code-design/COMPONENTS.md` (v1 kept as `COMPONENTS.v1.md`); mirror `docs/design/COMPONENTS.md` in the repo |
| Tokens v2 | `extensions/friedliver-agents/media/tokens.css` (every v1 name kept, so nothing breaks before B2; new tokens listed in §5 of the spec) |
| Themes | `extensions/friedliver-theme/palette.json` (OKLCH + per-key `overrides`), `scripts/oklch.mjs`, `themes/friedliver-dark-color-theme.json`, `themes/friedliver-light-color-theme.json`; FriedLiver Dark/Light are the defaults in `package.json` |
| Tests | `test/themes.test.ts` (six themes, new defaults), `extensions/friedliver-agents/test/palette.test.ts` (also runs on v2 fixtures), fixtures `test/fixtures/theme-friedliver-{dark,light}.css` from `scripts/theme-fixture-v2.mjs` |
| Workbench token bridge | `scripts/workbench-tokens.mjs` maps `body[data-platform='windows'/'linux']` → `.monaco-workbench.windows/.linux` |
| Reference implementation | `review/v2/src/` (`v2.css`, `mock.js`, `index.html`, `render.mjs`, `compare.*`); its stylesheet is mirrored in the repo as `docs/design/v2-reference.css` |
| Mockups | `review/v2/<screen>-<dark|light>-<1440x900|1280x800>.png` (28) + `<screen>-windows-<theme>-1440x900.png` (7) + `cvd/` + `COMPARISON.png` |
| Gates | `review/v2/gates.json`: 35 renders, 0 failures |

To re-render: `cd ~/code/FriedLiver-Code-design/review/v2/src && PW_CHANNEL=chrome node render.mjs --repo <checkout>` (copies `tokens.css` and the fixtures, then renders with Chrome `--use-mock-keychain --password-store=basic`; Playwright from `~/code/reportwright/node_modules/playwright-core` or `PW_PATH`).

## Ground rules for both phases

- The spec is law: if something isn't in `COMPONENTS.md`, add it there first (with every property and state), then build it.
- Colours: only theme keys (`palette.json` overrides) and `--fl-*`/tokens. Never a hex in `friedliver.css`, `webview.css` or a component (tests enforce it).
- One owner per stylesheet; no parallel agents on the same file.
- Verify in FriedLiver Dark **and** Light, at 1440×900 and 1280×800, macOS and Windows, against the mock of the same screen, side by side. Run the gates (`render.mjs`'s `gates()` is self-contained; port it into `scripts/workbench-shots.mjs` and `scripts/ui-harness.mjs`).
- No Docker. The workbench harness runs in CI (`workbench-shots.yml`, macos-latest).
- Never a Co-Authored-By trailer.

---

## Phase B: the stock workbench

Order (each step is one PR on top of `design/v2-system`; a Build FriedLiver dispatch + the Workbench shots harness per step):

### B.1 Theme and tokens land (no patch changes)
1. Merge the v2 themes as they are; `workbench.colorTheme` defaults to FriedLiver Dark.
2. Add the theme keys the spec names that the generator doesn't yet set: `tab.activeBorderTop` (sel-fg), `diffEditor.*` (6% / 18%), `diffEditor.diagonalFill` transparent, `peekView.*`, `editor.findMatch*` (straw), `editorGhostText.foreground`, `settings.*` (§6.14), `extensionButton.*` (§6.16). Put them in `palette.json` `overrides` so they stay per-theme; rerun `generate-themes.mjs` and `test/themes.test.ts`.
3. Configuration defaults (`friedliver-theme/package.json`): `scm.diffDecorationsGutterPattern`, `editor.inlineSuggest.showToolbar: never`, `workbench.layoutControl.enabled: false`, `workbench.tree.renderIndentGuides: always`, `workbench.experimental.modernUIEditorTabStyle: pill`, `workbench.hover.delay: 500`, `diffEditor.renderSideBySideInlineBreakpoint: 900`, `workbench.welcomePage.walkthroughs.openOnInstall: false`. Update `test/themes.test.ts`' defaults test.

### B.2 `workbench/friedliver.css` on v2 tokens (CSS only)
Section by section, matching `review/v2/src/v2.css` "The workbench": radii families (6/6/10/12/14; Windows 4/4/8 via `.monaco-workbench.windows`), menus (§6.10), palette container (§6.9 CSS part), hovers, toasts (+ `--fl-spring-pop` arrival under `.monaco-enable-motion`), dialogs, tabs (top line), breadcrumbs, the selection mark (`.monaco-list-row.selected::before`), the activity-bar pill (neutral on all platforms), status bar items, settings editor (§6.14 CSS part), extensions list actions, find widget, peek, ghost text. Keep `test/workbench-css.test.ts` green (no raw values; only defined tokens; HC untouched).

### B.3 Patches (TS/DOM), each small and named
| Patch | Change | Files |
|---|---|---|
| extend **0110** | palette row height 22 → 40 (two-line 44); palette top = title-bar height + 4; scope chips row; Windows dialog order check; drop "Source:" in toasts | `quickInputList.ts`, `quickInputController.ts`, `notificationsViewer.ts`, `dialog.ts` |
| new **0150-row-density** | `workbench.list.density` (comfortable 24 / compact 22) read by the Explorer, SCM, Outline and Search delegates | `explorerViewer.ts`, `scmViewPane.ts`, `outlinePane.ts`, `searchResultsView.ts` |
| new **0160-title-bar** | traffic-light position; Windows `titleBarOverlay` (40, shell, fg) on by default; the mark before the menubar; a `MenuId.TitleBar` slot for the Needs-you pill; compact menu under 1600px | `windowImpl.ts`, `titlebarPart.ts`, `desktop.contribution.ts` |
| new **0170-settings-words** | "For me" / "For this project"; hide TOC counts; open Settings as an editor tab | `settingsEditor2.ts`, `tocTree.ts`, settings contribution |
| new **0180-overview-ruler** | lane widths per kind (shape-coded marks) and the "suggestion · Tab accepts" hint | `decorationsOverviewRuler.ts`, inline-completions hints widget |
| extend **0100** | Windows UI font stack `"Segoe UI Variable Text", "Segoe UI", "Geist"` | `style.css` |

Each patch must still apply after `scripts/check-upstream.mjs`; re-check the risky selectors list in `WORKBENCH-MODERN-PLAN.md` §10.

### B.4 Icons
- `scripts/build-icon-font.mjs`: SVGs on the 16 grid (from `review/v2/src/mock.js` `P` + `src/webview/ui/icon.tsx`) → outlined at stroke 1.5 → woff2, built in CI; contributes `productIconThemes` "FriedLiver Icons" (default) for the ~60 ids in spec §6.21.
- A neutral file-icon theme "FriedLiver Files" (16-grid stroke glyphs in `--fg-2`) as `workbench.iconTheme`.

### B.5 Windows
Mica Alt on the shell (`backgroundMaterial: 'mica'` when available; solid otherwise), the double focus ring, the Fluent switch (CSS on `.monaco-custom-toggle.setting-value-checkbox` under `.windows`). Re-render with real Segoe UI Variable at 100/125/150% on a Windows runner (`workbench-shots.yml` matrix: add `windows-latest`).

### B acceptance
The Workbench shots harness at 1440×900 in FriedLiver Dark/Light (+ Windows) side by side with the mock screens `workbench`, `palette`, `settings` (and the welcome after B2); the gates at 0; the composer computed-style check updated on purpose (B2.3).

---

## Phase B2: the webviews (friedliver-agents)

### B2.1 Foundations (first, one PR)
1. Fonts: copy the four woff2 + OFL texts to `media/fonts/`; `media/fonts.css` with `@font-face`; load before `tokens.css`; CSP `font-src ${webview.cspSource}`; default `chat.fontFamily` "Geist, system-ui, sans-serif".
2. Host sets `body[data-platform]` (`process.platform` → windows/linux/mac).
3. Contributed colours in `package.json`: `friedliver.decision` defaults stay; `friedliver.agentClaude/Codex/Gemini` defaults → v2 hues (dark #ebaf86/#8bd9c9/#a9b6f5, light #984b16/#037465/#4e59b1); remove the OWN overrides in `scripts/theme-fixture-v2.mjs` once they're in.
4. `src/webview/ui/icon.tsx`: stroke 1.5; add the new glyphs; redraw Codex's mark (spec §2.22b) and run `scripts/agent-icons.mjs`.
5. Keys: one Keycap component that renders by platform (`sortKeys`/`winKeys` logic in `review/v2/src/mock.js`) + a lint test (order, no repeated modifiers).

### B2.2 Components, in this order (each: CSS in `components.css` per spec, the Preact wrapper in `src/webview/ui/`, the gallery updated, the ratchet lowered, never raised)
1. Button (§2.1: primary = accent, sheen, keycap slot; remove `--brand`), IconButton (24 hit box), SplitButton.
2. Pill, Count (loud = decision only), Keycap.
3. Status mark (§2.23; keep `.fl-dot` as an alias, add the shapes) and Agent puck (§2.22, round, working ring).
4. Switch (§2.8 incl. the Windows variant), Checkbox, Segmented (selected edge), Input/Select (field edge).
5. Row (selection mark §2.37, 24 trees), Tabs (top line), Menu/Popover (radius 12, inset 6, springs), Tooltip, Toast, Dialog/Sheet.
6. Card (no rings; tonal focus), Banner, Empty state (voiced).
7. Diff/Code (§2.21), the approval card (§2.29: Why, effects, keys scoped to the focused card, Windows order).
8. The composer (§2.27) — see B2.3.
9. Compositions: Agent Manager board (§2.35), chat page with the context rail (§2.34), discussion (§2.30), the Needs-you pill (§2.33, filled into the title-bar slot from B.3), the Welcome webview (§2.38, incl. first run), the status-bar agents item (§6.8), agent terminals named "<Agent> · <command>" (§6.7).
10. The phone app (`remote.css`) last, with touch density.

Motion: add the keyframes and transitions per §1.11 in `components.css` (springs via the tokens), each guarded so `prefers-reduced-motion` resolves to no travel.

### B2.3 Tests and baselines that change on purpose
| Test / baseline | Why it changes | How |
|---|---|---|
| `test/composer-frozen.test.ts` (repo root) | The owner's "complete change" authorises new composer **visuals** (layout and behaviour stay) | Restyle only the composer section's colours, radii, shadows and send state; keep DOM, sizes, spacing; then update `APPROVED` to the new sha256 in the same commit, with "owner-authorised v2 restyle" in the message and before/after shots |
| `test/workbench-harness/composer-{dark,light,dark-2026}.json` | Computed styles change (colours, radius 12, send fill) | Re-run `workbench-shots.yml` with `write_baseline: true`; commit the artifact's JSON; add `composer-friedliver-dark.json` / `-light.json` for the new default themes (and switch `THEMES` in `scripts/workbench-shots.mjs` to FriedLiver Dark/Light + Dark 2026) |
| `test/fixtures/ds-baseline.json` | The ratchet only goes down | `DS_BASELINE=write` after each component lands |
| `components/gallery-*.png` | New looks | `node scripts/ui-gallery.mjs` with FriedLiver Dark/Light + HC + Windows |
| `palette.test.ts` | Text-on-fill pairs include the new components | Already runs on v2 fixtures; keep it green |
| `tabStrip.test.ts`, `fullWidth.test.ts` | `--tab-h` 30 → 32 | Already green with v2 tokens; re-check if TS mirrors change |
| `test/themes.test.ts` | new theme keys from B.1 | Add pairs for any new foreground/background key |

### B2 acceptance
Each screen side by side with its mock (same theme, size and platform), the gates at 0 in the harness, the panel's open items either done or listed for the owner (`PANEL.md` "Still open").

## Open owner decisions (do not decide in B/B2)
1. Needs-you blue vs a warm amber (the taste critic asked every round; the owner rule says blue).
2. Green for "working" vs a warm neutral arc.
3. "Ask before edits" on by default for first-run users.
4. The Codex mark redraw (and whether to use vendor-neutral glyphs at all).
5. The logo pick (`~/code/FriedLiver-Code-design/logo/`): the mock draws the current mark as a line; a new logo drops in via `friedliverMark.ts`.
