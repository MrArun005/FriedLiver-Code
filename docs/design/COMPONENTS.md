# FriedLiver components: the spec (Design System v2, "Beacon")

Date: 2026-10-20. Status: **law** (owner's rule), v2. v1 (2026-10-18) is kept unchanged as `COMPONENTS.v1.md`; where an entry below says "as v1 §x", that v1 text still applies word for word. Every surface draws only these components: the stock workbench (§6), the chat, the Agent Manager, the inbox, images, the permissions and accounts pages, the welcome page, the phone app. No button, pill, field or menu with its own radius, height, border, fill, glass or motion.

**Where it lives.** Repo `~/code/FriedLiver-Code`, branch `design/v2-system` (draft PR "Design System v2"); a mirror of this file is `docs/design/COMPONENTS.md`.

| File | Role |
|---|---|
| `extensions/friedliver-agents/media/tokens.css` | The only file with raw colours, sizes, shadows, blur and motion curves. Theme colours come from `--vscode-*` keys with the FriedLiver Dark (v2) value as fallback. `scripts/workbench-tokens.mjs` copies it into the workbench as `--fl-*` (and maps `body[data-platform]` to `.monaco-workbench.windows/.linux`). |
| `extensions/friedliver-theme/palette.json` | The colour source of truth, in OKLCH (`"oklch(L C H [/ A])"`, converted by `scripts/oklch.mjs`); `generate-themes.mjs` writes **FriedLiver Dark** and **FriedLiver Light** (the new defaults) and the four Control Room themes. |
| `media/components.css`, `src/webview/ui/` | Every component below (B2 rebuilds them on v2). |
| `workbench/friedliver.css` + `patches/0110…` | The stock workbench (§6; phase B). |
| `~/code/FriedLiver-Code-design/review/v2/src/` (its stylesheet mirrored in the repo as `docs/design/v2-reference.css`) | The reference implementation of every v2 look: `v2.css` (all components and workbench chrome, tokens only), `mock.js` (the 7 screens, both platforms), `render.mjs` (renders + objective gates). |

Load order is unchanged: `tokens.css` → `webview.css` → `components.css`.

---

## 0. The direction: Beacon

**One line.** Warm graphite surfaces that recede, one ember light on the thing you should press next, and a small blue mark wherever an agent needs you.

**Why it wins for a pro coding and multi-agent tool.** Every reference makes one thing great; none is built for watching several agents at once. Linear owns restraint (one accent, tone over borders, LCH-generated themes); Raycast owns the keyboard palette; Zed owns density; macOS 26 owns material and concentric shape; Cursor owns agent-in-IDE but wears stock VS Code; Claude's apps own warmth. Beacon takes Linear's restraint and Raycast's palette, keeps VS Code's affordances at Zed's density, and adds what none of them has: **one attention system across the whole workbench** (the bullseye mark, the "N need you" front door, the Needs-you column, the approval card that says why and how to undo), so the user always knows which agent is waiting and what the next key action is. Glass and depth are reserved for floating layers (macOS 26's lesson); panels stay attached and full-width (Figma UI3's lesson: floating panels were reverted because they slowed people down).

**Principles (each has a test or a gate).**
1. **60/30/10.** 60% page and shell, 30% raised content (fields, cards, menus), 10% ember: the one primary on a surface, a switch's "on", the composer's send. Gate: accent groups ≤ 1 per render (switches excepted, §2.8).
2. **One attention hue, small.** Needs-you is blue (owner, 2026-10-18) and only ever a mark: the bullseye, a count, a link. Never a filled button, never a card ring.
3. **Status is a shape.** Needs-you ◉, working ◠ (an open arc), done ✓, failed ⊗, idle ○. Colour is a second channel (WCAG 1.4.1; checked under protan/deutan/tritan simulation).
4. **Tone over borders.** Regions separate by surface tone; hairlines only inside one tone.
5. **Floating things float.** Glass (blur 24, saturate 160%), a 1px rim light and a two-part shadow on menus, palette, toasts, dialogs; nothing inline has a shadow.
6. **Motion is physical and quiet.** Springs for things that open, a 120ms trail when hover leaves, a 0.97 press. Everything off under reduced motion.
7. **The whole width.** No centred columns; wide pages split into a main column and a context rail rather than 1,300px lines.
8. **One truth.** Every count, state and time comes from one source (six critics checked the mocks for contradictions).
9. **Platform-true.** macOS: traffic lights, ⌘ keycaps, 6/10/12/14 radii. Windows/Linux: caption buttons via `titleBarOverlay`, one "Ctrl+Shift+F" keycap, Fluent 4/8 radii, Fluent switches and double-ring focus (§1.14).

### 0.1 Research (2025–26): what each teaches

| Reference | What makes it feel current | Taken into Beacon |
|---|---|---|
| Apple macOS 26 / Liquid Glass ([Apple newsroom, 2025-06-09](https://www.nasdaq.com/press-release/apple-introduces-delightful-and-elegant-new-software-design-2025-06-09); [MacStories overview](https://www.macstories.net/news/macos-tahoe-the-macstories-overview/); Apple HIG "Materials") | A translucent material that adapts to content; concentric, rounder corners; controls float above content; menus and Dock frosted with an edge sheen | Glass + rim light on floating layers only; the concentric radius rule; reduced-transparency fallback |
| Linear ([How we redesigned the Linear UI](https://linear.app/now/how-we-redesigned-the-linear-ui)) | Themes generated in LCH from three inputs (base, accent, contrast); one accent; quiet chrome | OKLCH palette in `palette.json`; one accent; contrast as a token block |
| Vercel Geist ([vercel.com/geist](https://vercel.com/geist)) | Geist Sans/Mono; a 10-step gray scale; "materials" = presets of radius + fill + stroke + shadow | Geist + Geist Mono (OFL, already bundled); elevation + glass tokens as materials |
| Raycast ([raycast.com](https://www.raycast.com)) | A big input, roomy rows, sections, keycaps at the edge, an action footer | Palette: 52px filter, 40px rows, keys column, footer hints |
| Zed ([visual customization](https://zed.dev/docs/visual-customization)) | Bundled UI and buffer fonts (IBM Plex / Lilex); density; almost no chrome | Bundled fonts on every OS; 22–26px rows; tone-separated panes |
| Cursor 2.x ([forum: Agents view](https://forum.cursor.com/t/cursor-2-0-agents-view-whats-the-point/140094); [layout resets](https://forum.cursor.com/t/ui-constantly-resets-layout-in-cursor-2-0/139511)) | Agent-first layouts; users pushed back when the side bar moved and layouts reset | Agents are a side lane, a board and a front door; the VS Code layout stays put |
| Figma UI3 ([our approach to designing UI3](https://www.figma.com/blog/our-approach-to-designing-ui3/); [we shipped it, you shaped it](https://www.figma.com/blog/figma-2024-we-shipped-it-you-shaped-it/)) | Floating panels tested and reverted: they slowed people down | Attached, full-width panels; glass only for transient layers |
| Material 3 Expressive ([material_expressive docs](https://pub.dev/documentation/material_expressive/0.8.0/)) | Physics springs split into spatial and effects tokens | `--spring-snap` (spatial, critically damped), `--spring-pop` (1.5% overshoot); effects use `--ease-out` |
| Fluent 2 ([shapes](https://fluent2.microsoft.design/shapes)) | 4px default corner, 8 for surfaces; Mica/Acrylic; double-ring focus | §1.14 platform layer |
| Warp, Notion, Claude/ChatGPT desktop, Things 3, Arc | Steps as first-class units; warm neutrals; delight in empty states and small motion | Steps as rows with durations; warm graphite; voiced empty states; steam on the mark |

---

## 1. Tokens

All values are in `tokens.css` (webviews) and generated into the workbench as `--fl-<name>`. "Dark"/"Light" = FriedLiver Dark/Light (v2).

### 1.1 Colour roles

OKLCH is the source; hex is what the theme JSON holds. Neutrals are warm graphite (dark C .006 h 60; light C .005 h 70).

| Token | Theme key (fallback chain) | OKLCH dark / light | Dark | Light | Used for |
|---|---|---|---|---|---|
| shell (workbench) | `sideBar/activityBar/titleBar/statusBar.background` | .168 / .966 | #110e0c | #f6f3f0 | title bar, activity bar, side bar, status bar |
| `--bg` (page) | `editor.background` | .205 / .995 | #191714 | #fffdfb | editor, panel, chat, every webview page |
| `--input-bg` | `input.background` | .235 / .995 | #201d1b | #fffdfb | fields, composer, cards on the page |
| `--menu-bg`, `--dialog-bg` | `menu.background`, `editorWidget.background` | .265 / 1.0 | #252220 | #ffffff | floating layers (under glass) |
| `--code-bg` | `textCodeBlock.background` | .15 / .968 | #100e0c | #f7f4f1 | code blocks, diff and command wells |
| `--inline-code-bg` / `-fg` | `textPreformat.*` | | #23201e / #c7c3c0 | #edebe8 / #4b4743 | inline `code` |
| `--sel-bg` | `list.activeSelectionBackground` | sel-fg @ 11% / 7.5% | #faf6f31c | #110f0d13 | selected rows, tabs, palette item |
| `--hover-bg` | derived | sel-fg @ 6% | | | hovered rows |
| `--ghost-hover` | derived | sel-fg @ 8% | | | icon and quiet buttons on hover |
| `--pill-bg` / `-hover` / `-active` | derived | fg @ 9 / 14 / 19% | | | secondary buttons, pills, segmented track |
| `--border` | `inlineChatInput.border` → `input.border` → `widget.border` | | #24211f | #e1dfdd | container lines |
| `--hairline` | border @ 60% | | | | row rules |
| `--field-border` | derived | fg-2 @ 55% / 72% | | | a field's 3:1 edge (WCAG 1.4.11) |
| `--sel-fg` | `list.activeSelectionForeground` | .975 / .17 | #faf6f3 | #110f0d | selected and strong text, the selection mark |
| `--fg` | `foreground` | .925 / .255 | #e9e5e2 | #242220 | body text |
| `--fg-2` | `descriptionForeground` | .735 / .475 | #aca8a5 | #5e5c59 | secondary text and icons |
| `--fg-50` | fg @ 62% | | | | menu titles only (≥ 11px) |
| `--placeholder`, `--disabled` | `input.placeholderForeground`, `disabledForeground` | .62 / .56 | #898583 | #767471 | placeholders, hints |
| `--link` | `textLink.foreground` | .74 .13 250 / .53 .16 256 | #67b0f9 | #1e6ac5 | links |
| **`--accent-bg`** (= `--primary-bg`, `--send-bg`, `--toggle-on`, `--button-bg`) | `button.background` | **.56 .15 42** (both themes) | **#ba4f1f** | **#ba4f1f** | the one primary, the send, a switch or checkbox "on" |
| `--accent-fg` | `button.foreground` | white | #ffffff (5.0:1) | #ffffff | text on the accent |
| `--accent-hover` | `button.hoverBackground` | .58 .15 44 / .51 .15 42 | #c05621 | #a94008 | |
| `--accent-press` | accent 88% + bg | | | | pressed |
| **`--decision`** | `friedliver.decision` → `notificationsInfoIcon.foreground` | **.74 .13 250 / .53 .16 256** | **#67b0f9** | **#1e6ac5** | needs-you marks and counts only |
| `--focus` | `focusBorder` (made opaque) | .88 .005 60 / .3 .006 70 | #dad7d4 | #302d2b | keyboard focus ring (neutral) |
| `--status-working` | `descriptionForeground` (a warm neutral; owner, 2026-10-20) | = `--fg-2` | #aca8a5 | #5e5c59 | the working arc, progress. Green (`charts.green`) means done or success only |
| `--error` (= failed) | `errorForeground` | .7 .175 20 / .53 .2 25 | #f86970 | #c51d28 | failed, danger |
| `--warn` | `editorWarning.foreground` | .83 .13 82 / .5 .115 70 | #f1bf5b | #8a5600 | warnings |
| `--added` / `--removed` | `gitDecoration.added/deletedResourceForeground` | | #67d283 / #f86970 | #007835 / #c51d28 | diff |
| git modified | `gitDecoration.modifiedResourceForeground` | .8 .06 90 / .48 .07 85 | #cdbd92 | #705a2c | "M" in trees (out of the accent's family) |
| `--hue-claude` / `-codex` / `-gemini` | `friedliver.agent*` (B2 updates the contributed defaults) | .8 .09 55 · .83 .08 180 · .79 .09 275 / .5 .12 50 · .5 .09 180 · .5 .14 275 | #ebaf86 #8bd9c9 #a9b6f5 | #984b16 #037465 #4e59b1 | agent marks and pucks |
| `--mic-bg` | fixed | | #0078d4 | | composer mic only (unchanged; `palette.test` pins it) |
| caret | `editorCursor.foreground` | .68 .15 46 / .56 .15 42 | #e2763f | #ba4f1f | the editor caret: the one ember in the editor |
| `--brand` | (mock: literal; B2: a token) | .72 .14 52 / .62 .15 48 | #e2884f | #c4622a | the FriedLiver mark only |

**Text ramp.** `--sel-fg`, `--fg`, `--fg-2`, `--fg-50` (menu titles), `--placeholder`. `test/palette.test.ts` checks them in VS Code's Dark/Light 2026 **and** FriedLiver Dark/Light: body 7:1, secondary and links 4.5:1, every text-on-fill pair 4.5:1, status dots 3:1.

**Syntax (FriedLiver Dark / Light).** Keywords rose `.79 .09 15` / `.5 .14 15`; types sea-glass `.82 .06 195` / `.48 .07 200`; strings sage `.83 .09 135` / `.48 .11 140`; numbers lilac `.8 .09 300` / `.5 .14 300`; comments warm grey `.66 .02 60` italic; punctuation `.74 .01 60`. No syntax role is ember, so the caret and the primary stay the only ember. `test/themes.test.ts` checks every token colour at 4.5:1.

### 1.2 Type

| Token | Value | Use |
|---|---|---|
| `--font` | `chat.fontFamily` → `'Geist', system-ui` (workbench: patch 0100; webviews: bundled `@font-face`, B2) | everything |
| `--mono` | `editor.fontFamily` → `'Geist Mono'` | code, paths, commands |
| `--fs` | 13px (Cmd/Ctrl ± scales it) | base |
| `--t-xs` · `--t-sm` · `--t-md` · `--t-lg` · `--t-lead` · `--t-title` · `--t-hero` · `--t-display` | 11 · 12 · 13 · 14 · 15 · 16 · 20 · 28 px | meta and counts · secondary and sm controls · body · palette items, hero sentence · a section's own title (discussion headline, sides) · section titles · page titles (Agents, a chat, a discussion) · the welcome greeting |
| em steps (v1) | `--t-100/90/85/80/75` | kept for components that scale with `--fs` |
| `--track-title` / `--track-display` | −0.011em / −0.022em | ≥ 15px / ≥ 28px; 0 below 15px |
| weights | 400 · 500 (labels, primary, titles of rows) · 600 (page/section titles, counts) | 700 is retired |
| `--lh` / `--lh-tight` / `--lh-code` | 1.5 / 1.2 / 1.6 (editor: `editor.lineHeight` 1.55) | |
| numerals | `font-variant-numeric: tabular-nums` on every time, count, cost, duration, line number | |

### 1.3 Spacing (4px grid)

`--sp-half` 2 · `--sp-1` 4 · `--sp-2` 8 · `--sp-3` 12 · `--sp-4` 16 · `--sp-5` 20 · `--sp-6` 24 · `--sp-8` 32 · `--sp-10` 40 · `--sp-12` 48. Gate: every padding, margin and gap is on the 2px half-grid (35 renders, 0 off-grid). Layout constants: `--gutter` 20 (16 under 720px), `--tab-h` 32.

**Widths (new tokens):** `--w-tip` 280 · `--w-menu` 380 · `--w-toast` 400 · `--w-dialog` 560 / `--w-dialog-wide` 880 · `--w-palette` 640. Pages have no max-width; a chat or discussion page is `main | 300px context rail` (264 under 1300px). The agent side panel is 420 at 1440 wide, 360 at 1280.

### 1.4 Radius (concentric: inner = outer − inset)

| Family | Token | macOS / default | Windows/Linux (§1.14) | Members |
|---|---|---|---|---|
| Control | `--r-ctl` | **6** | 4 | buttons, icon buttons, inputs, selects, tabs, segments, status-bar items |
| Row | `--r-row` | **6** | 4 | menu items, list and tree rows |
| Box | `--r-box` | **10** | 8 | cards, banners, table frames, diff and code wells |
| Float | `--r-float` | **12** | 8 | menus, popovers, toasts |
| Dialog | `--r-dialog` | **14** | 8 | dialogs, the palette, sheets (top corners) |
| Composer | `--r-12` | 12 | 8 | the composer box, the Ask box |
| Track | `--r-8` | 8 | 8 | segmented track, tooltip, palette rows, rail items |
| Key | `--r-4` | 4 | 4 | keycaps, checkbox, inline code |
| Pill / Round | `--r-pill` / 50% | | | pills, counts, switches, pucks, status marks |

Raw `--r-1/3/4/5/6/8/10/12/14` stay as the ramp; components use the families.

### 1.5 Heights

`--h-2xs` 16 (count) · `--h-xs` 18 (pill sm, keycap, switch) · `--h-sm` 22 (sm controls, status items, crumb row) · **`--h-md` 26** (default control; the composer's controls) · `--h-lg` 32 (one large CTA, rail items, tab strip) · **`--h-xl` 40 (palette and welcome rows; new)** · `--h-touch` 44 (phone). Trees default to **24** (comfortable, WCAG 2.5.8) with a "compact" density of 22 (§6.3).

### 1.6 Icons

- One set on a 16 grid, **stroke 1.5px** at every size (`--i-stroke`, `vector-effect: non-scaling-stroke`), round caps and joins. Boxes `--i-xs` 12 · `--i-sm` 14 · `--i-md` 16 · `--i-lg` 20 · `--i-xl` 24.
- Webviews: `src/webview/ui/icon.tsx` (B2: stroke 1.2 → 1.5; add `files, extensions, debug, scm, agents, sliders, bell, sideL, sideR, panelB, folder, sync, braces, book, clone, error, filter, fork, menu, keyboard, arrowRight, minus, square` from `review/v2/src/mock.js`).
- Workbench: the **FriedLiver Icons** product icon theme (§6.21) renders the same glyphs.
- File icons are neutral (`--fg-2`); language is not colour-coded.
- **The mark** (`friedliverMark.ts`) is drawn as a line (2px at 48, 1.5px at 14–16) with a 16% fill in `--brand`. It appears in the title bar, the welcome hero, the palette footer, the Welcome tab and empty states; nowhere is it a control.

### 1.7 Lines

1px `--border` for containers; `--hairline` for rules between rows; 0.5px only in the composer footer and IO blocks (as v1 §1.7). Controls draw no border except fields (`--field-border`), High Contrast, and the off switch's track.

### 1.8 Elevation (contact + ambient)

| Token | Dark | Light (adds a 1px #1a14100f–14 ring) | On |
|---|---|---|---|
| `--elev-1` | 0 1px 2px #0000003d | ring + 0 1px 2px #1a14100f | composer, selected segment, primary button |
| `--elev-2` | 0 1px 2px #00000033, 0 4px 12px −2px #00000052 | | context menus |
| `--elev-3` | 0 2px 6px #00000040, 0 16px 40px −8px #00000080 | | menus, popovers, toasts |
| `--elev-4` | 0 4px 12px #0000004d, 0 32px 80px −16px #00000099 | | dialogs, palette |
| `--rim` | inset 0 1px 0 #ffffff12 (dark only) | none | every card, the composer, every floating surface |
| `--sheen` | inset 0 1px 0 #ffffff26 | same | filled buttons (primary, send) |

### 1.9 Glass

`--glass-bg` = the surface at `--glass-alpha` (78% dark, 84% light) + `--glass-blur` `blur(24px) saturate(160%)` + `--rim` + 1px `--dialog-border` (sel-fg 12%). Only menus, popovers, palette, toasts, dialogs, sheets. Off (100%, no blur) in High Contrast and under `prefers-reduced-transparency`. The palette sits on a scrim (shell @ 62%) on macOS; Windows uses no scrim (Fluent flyouts don't dim) with the same glass as Acrylic.

### 1.10 Layers

As v1 §1.10: content 1 · sticky 2/3 · composer footer 6 · menus 10 · composer 20 · toasts 900 · overlay/dialog/palette 1000 · tooltip 1100.

### 1.11 Motion

| Token | Value | Use |
|---|---|---|
| `--spring-snap` | `linear()` sample of a spring, stiffness 800, damping 57 (ζ 1.0, settles ≈ 300ms) | spatial: menus, palette, popovers open (scale .98 → 1, 6px rise); the tab top line slides |
| `--spring-pop` | stiffness 560, damping 38 (ζ 0.8, 1.5% overshoot) | toasts arriving, a switch's knob, a selected segment moving, a card arriving on the board, a count bump |
| `--dur-spring` / `--dur-pop` | 240 / 340ms | the durations the springs run for |
| `--dur-fast` / `--dur` / `--dur-slow` | 120 / 180 / 260ms | fades (effects) and closing (`--ease-out`) |
| `--dur-out` | 120ms | the hover trail: a fill appears instantly and fades out over 120ms when the pointer leaves |
| `--press-scale` | 0.97 | buttons and pills on :active; back on `--spring-pop` |
| `--rise` / `--open-scale` | 6px / 0.98 | open transforms |
| `--dur-hold` | 600ms | hold to confirm (§2.4) |
| working arc | rotate 360° per 1s, linear | §2.23 |
| steam | the mark's three strokes drift up 2px and fade, 3.2s ease-in-out, staggered 0.4s | the welcome mark and the empty Agent Manager only |

**Micro-interactions (each one).** Hover: fill on at once, off over `--dur-out`. Press: 0.97 + the active fill. Open (menu, palette, popover): fade 120ms + `--spring-snap` from 6px below and 98%. Close: fade 120ms `--ease-out`, no travel. Toast: `--spring-pop` from 8px below; leaves with a 120ms fade. Switch: knob `--spring-pop` 340ms, track 180ms. Segment: the selected chip slides on `--spring-pop`. Tab: the active top line slides on `--spring-snap`. A card changing column: FLIP on `--spring-snap`. An agent starts working: its puck's ring fades in over 260ms and the arc starts. A needs-you count changes: it bumps once (1.15 → 1, `--spring-pop`); nothing loops for attention. **Reduced motion:** the springs become `linear`, `--press-scale` 1, `--rise` 0, spring durations 1ms, the arc is a static ¾ ring, steam stops: every state still changes, nothing travels.

### 1.12 Focus and selection

| | Look |
|---|---|
| keyboard focus (`:focus-visible`) | 2px `--focus` (neutral) ring, 2px offset (`--focus-w`, `--focus-off`); fields: `--focus` border + 3px halo at 24% |
| selection (rows, nav, radio rows) | `--sel-bg` fill + the selection mark (§2.37) |
| active tab | the raised fill + a 2px `--sel-fg` line on the top edge, inset 8 |
| palette item | fill only (sel-fg 13%) |
| the card the keys act on (board) | a 7% `--sel-fg` tonal fill + a 1px `--fg-2` edge |
| High Contrast | selection = 1px solid `contrastBorder`; focus = 2px `contrastActiveBorder` (orange): never alike |
| Windows | focus is Fluent's double ring: 2px `--fg` outside a gap in `--bg` |

### 1.13 Theme blocks

`body.vscode-light`: field edge 72%, white knob with a ring, light elevation with rings, overlay #1a141047, glass 84%, no rim. `body.vscode-high-contrast(-light)`: contrast borders on every control and container, outlines replace fills, no glass/shadow/rim, `--press-scale` 1, primary = `--fg` on `--bg`. `prefers-reduced-transparency`: glass off. `prefers-reduced-motion`: §1.11. Derived tokens are restated inside each block (v1 rule).

### 1.14 Platform layer (new)

`body[data-platform='windows'|'linux']` (webviews; the host sets it) and `.monaco-workbench.windows/.linux` (workbench; `workbench-tokens.mjs` maps it).

| | macOS | Windows / Linux |
|---|---|---|
| radii | 6 / 6 / 10 / 12 / 14 | 4 / 4 / 8 / 8 / 8 |
| window chrome | traffic lights, then the mark | app icon, then the app menu (hamburger under 1600px wide, the full menu bar above), caption buttons from Electron `titleBarOverlay` (46×40, close hover #c42b1c), Snap Layouts by native hit-testing |
| keys | one cap per key, Apple order ⌃⌥⇧⌘ | one cap "Ctrl+Alt+Shift+X"; ⌘ → Ctrl, and ⌃ held with ⌘ → Alt (⌃⌘I = Ctrl+Alt+I); Esc, Enter, Backspace spelled out |
| switch | 32×18, 14 knob | Fluent 40×20, 12 knob, outlined off track, white knob on the accent |
| focus | 2px ring, 2px offset | double ring |
| font | Geist | Segoe UI Variable Text (Display ≥ 20px), then Geist (B changes patch 0100's Windows stack) |
| shell | warm graphite | Mica Alt on the title bar, activity bar and side bar (`backgroundMaterial: 'mica'`), solid layers for the editor and panels |
| palette | under the title bar, scrim | same anchor, no scrim, Acrylic |
| paths and prompts | `~/…`, zsh | `C:\Users\…`, `PS C:\…>` |
| dialogs and approvals | Cancel/Deny first, primary last | primary first (Fluent order) |
| option | — | "Use Windows accent colour" (off by default) |

---

## 2. Components

Headings keep v1's numbers so code references stay valid. Each entry: purpose · variants · size · shape · fill · border · glass · type · icon · states · motion · do/don't. The reference CSS for each is in `review/v2/src/v2.css`.

### 2.1 Button `.fl-btn`

| Variant | Fill rest / hover / active | Text | Weight | Use |
|---|---|---|---|---|
| `--primary` | `--accent-bg` / `--accent-hover` / `--accent-press`; `--sheen` + `--elev-1` | `--accent-fg` | 500 | the one key action on a surface ("Allow once", "Carry out with Codex", "New chat", "Start") |
| `--secondary` (default) | `--pill-bg` / `--pill-hover` / `--pill-active` | `--fg` | 500 | every other action ("Deny", "Keep discussing", "Retry") |
| `--quiet` | transparent / `--ghost-hover` / `--pill-active` | `--fg-2` → `--fg` | 400 | minor and toolbar actions ("Edit command", "Clear", "Open folder") |
| `--danger` | `--error` 14 / 22 / 30% | error mixed toward `--fg` by `--tone-ink` | 500 | destructive |
| `--link` | none; underline in `--hairline`, offset 3 | `--fg-2` (default) or `--link` | 400 | "Agents & Accounts", "All" |
| `--brand` | **removed**: the send is the primary's colour (§2.27) | | | |

| Size | Height | Min-width | Padding x | Gap | Icon | Font |
|---|---|---|---|---|---|---|
| `--sm` | 22 | 44 | 8 | 4 | 14 | 12px |
| md | 26 | 52 | 12 | 4 | 16 | 13px |
| `--lg` | 32 | 64 | 16 | 8 | 16 | 13px |
| `--touch` | 44 | 88 | 16 | 8 | 20 | 15px |

Radius `--r-ctl`; border 1px `--ctl-border` (visible only in HC); no glass. **Keycap in a button** (`.fl-btn__k`): a Keycap (§2.25) at 11px; on a primary it is outlined in currentColor 45%; elsewhere a 16% currentColor fill. **Only the primary shows its key**; other buttons put the key in the tooltip.

| State | Look |
|---|---|
| hover | the variant's hover fill (instant on, `--dur-out` off) |
| active | the active fill + `--press-scale` |
| focus-visible | §1.12 ring |
| on (`aria-pressed`, secondary/quiet) | `--sel-bg`, text `--sel-fg` |
| menu open | the active fill |
| disabled | .4, no hover |
| loading (`aria-busy`) | label transparent (width kept), a 14px working arc in currentColor |

Do: one primary per surface; verb labels. Don't: a primary for something destructive; two primaries; bordered buttons.

### 2.2 IconButton `.fl-btn--icon`

Square 22/26/32/44, padding 0, `--r-ctl`; quiet by default (`--fg-2` → `--fg` on `--ghost-hover`); `--muted` and secondary variants as v1. Every icon button has a hit box of at least 24×24 (WCAG 2.5.8): an sm (22) icon button in a dense row gets 1px of margin so neighbouring hit boxes never overlap. Label = tooltip + `aria-label`. `--round` only for media pagers and phone swipe actions.

### 2.3 SplitButton `.fl-split`

Two buttons of one variant; outer corners `--r-ctl`, inner 0; the chevron half is square (= height), 12px chevron, with a 1px currentColor 28% divider drawn as an inset shadow (the primary keeps its sheen). Its menu: a Menu (§2.13), end-aligned, 4px below. The approval scope split: "Allow once ⌘↵ ▾" → Once / This chat / Always.

### 2.4 HoldButton `.fl-btn--hold`

As v1 §2.4 (hold 600ms; early release drains over 200ms; double-press fallback; `aria-description`). v2: the sweep is currentColor 22% over the danger tint. Used for force-pushes, deletes, payments and secrets when "Hold to confirm risky actions" is on (the default); the card lists what cannot be undone (§2.29).

### 2.5 Pill / Chip / Tag `.fl-pill`

| Size | Height | Padding x | Font | Icon | Gap |
|---|---|---|---|---|---|
| sm (default) | 18 | 8 | 11px / 500 | 12 | 4 |
| `--md` | 22 | 8 | 12px / 500 | 12 | 4 |
| `--touch` | 32 | 12 | 13px / 500 | 12 | 4 |

Pill radius; `--pill-bg`; text `--fg` (never `--fg-2` on a fill). Tones (`data-tone`): working, waiting, failed, warn, done (neutral): the tone at 14% (hover 22%) with text mixed toward `--fg` by `--tone-ink`. `--mono` for branches and files (FileRef). Remove × 14 circle. Width `fit-content`, ellipsis when squeezed. Pressable pills: hover `--pill-hover`, on `--sel-bg`. Don't: a pill as the only status signal (pair with §2.23); rectangular chips.

### 2.6 Count `.fl-count`

16 tall, min 16, padding 0 4, pill, 11px/600 tabular. Neutral: `--fg` on `--pill-bg`. `--loud` (needs-you only): `--decision-fg` on `--decision`, with a 2px ring in its surface colour when it sits on an icon. Bumps once when it changes (§1.11). Shows 0 only in a column header.

### 2.7 Segmented `.fl-seg`

Track 26 (touch 44), padding 2, gap 2, `--r-8`, `--pill-bg`. Segment 22, padding 0 8, `--r-ctl`, 12px/500 `--fg`, 14 icon. **Selected:** `--seg-on` (float tone dark / white light) + `--elev-1` + an inset 1px `--fg-2` edge (3:1, WCAG 1.4.11) + 600 `--sel-fg`; it slides between options on `--spring-pop`. Hover `--hover-bg`. Focus §1.12. Disabled .4. Keyboard: roving tabindex, arrows select. 2–4 options; more → Select.

### 2.8 Switch `.fl-toggle`

| | default (macOS) | Windows (Fluent) |
|---|---|---|
| track | 32×18, pill | 40×20, pill |
| off | transparent, 1px `--fg-2` edge; 14 knob `--fg-2` at 2px | same; 12 knob at 4px |
| on | `--accent-bg` (= `--toggle-on`); 14 knob white + `--shadow-thumb`; 14px travel | `--accent-bg`; 12 white knob; 20px travel |

Motion: knob `--spring-pop` 340ms, track 180ms. Hover: the track mixes 15% toward `--fg`. Focus §1.12 (Windows: double ring). Disabled .4. A switch's "on" is the one place the accent may appear more than once on a surface (the accent gate ignores switches). `role=switch` + `aria-checked`; no "On/Off" text beside it. Apply the change at once (otherwise use a checkbox and Save).

### 2.9 Checkbox `.fl-check`

14×14, `--r-4`, 1px `--fg-2` 70% on transparent; checked: `--button-bg` (the accent) fill and border, a white 2px check; indeterminate: an 8px bar. Row min 26, gap 8, label `--fg`. Settings use switches, not checkboxes.

### 2.10 Radio row / ChoiceRow `.fl-radio`

As v1 §2.10 with v2 tokens: `--r-row` 6; checked row `--sel-bg` + the selection mark (§2.37) + `--sel-fg`; dot 14 with a 4px inner ring in `--button-bg`; number key as a Keycap at the end.

### 2.11 Input · Search · Field `.fl-input`

| Size | Height | Padding x | Font |
|---|---|---|---|
| `--sm` | 22 | 8 | 12 |
| md | 26 | 8 | 13 |
| `--lg` | 32 | 12 | 13 |
| `--touch` | 44 | 12 | 16 |
| hero (Ask box, §2.36) | 52 | 16 | 14 |

`--r-ctl`; `--input-bg`; 1px `--field-border` (3:1). Hover: border → `--fg-2`; focus: `--focus` border + `--focus-halo`; invalid: `--error` border; disabled .4. Search: 14 glyph at 8, text inset 30, a clear button once there is text. Number fields right-align tabular digits and size to content (a money field is 128 wide). Field: label above (12px `--fg`, gap 4), help below (12px `--fg-2`), error replaces help.

### 2.12 Select `.fl-select`

The Input's look as a button; md 26, min 120, padding 0 8, gap 8; value ellipsised; a 14 chevron `--fg-2` at the end; may lead with a 16 mark or puck (agent picker). Open = the focus look. List = Menu (§2.13) with the value checked.

### 2.13 Menu / Popover / Palette `.fl-menu`

**Menu container:** min 220, max `--w-menu`; padding 4 0; rows gap 2; radius `--r-float` 12; glass + `--rim` + `--elev-3`; 1px `--dialog-border`; opens on `--spring-snap`, closes with a fade; placement 4px below, flips above, capped to the room.
**Item:** min 26, margin 0 6 (concentric: 12 − 6 = `--r-row` 6), padding 4 8, gap 8; 16 icon `--fg-2` or a puck sm; label ellipsised; end slot: value `--fg-2`, Keycap, check. Hover `--hover-bg`; keyboard-active `--hover-bg`; checked `--sel-bg` + the selection mark; disabled .4; danger `--error`. Title 11px/500 `--fg-50`, padding 8 12 4. Separator 1px `--hairline`, margin 4 0. Filter 26, `--r-row`, `--input-bg`. Form variant: padding 12, gap 8, min 340.

**Palette variant** (command palette, quick open, every quick input):
- Width `--w-palette` 640; radius `--r-dialog` 14; glass + `--rim` + `--elev-4`; anchored 4px under the title bar, centred on the command center (which stays visible).
- Filter row 52: a 20 search glyph `--fg-2`, 16px text `--sel-fg` (`--t-title`, `--track-title`), caret `--focus`, an "esc" Keycap at the end.
- Scope chips below (pills sm 22, transparent; selected `--sel-bg`): Files · Commands · Symbols · Agents (Agents shows once a provider owns `~`). Prefixes are VS Code's (`>` commands, `@` symbol in file, `#` workspace symbol, `:` line); Agents use `~`. The prefix is in each chip's tooltip, not its label. **All** (one list mixing Files, Commands and Agents) needs a mixed quick-access provider; until one exists the workbench shows the four chips (patch 0110).
- Group labels 11px/500 `--fg-2`, padding 8 8 4.
- Rows **40** (`--h-xl`), `--r-8`, grid `16 icon | title | context | keys`; title 14px `--fg`, matched characters 600 `--sel-fg`; context 12px `--fg-2` right after the title (path, "new chat", a status mark + "needs you"); keycaps alone at the right edge. Agent rows lead with a puck.
- Selected row: fill only (sel-fg 13%), text `--sel-fg`.
- Order in "All": Files, Commands, Agents. ⌘⇧P opens straight into Commands.
- Footer 32: the mark + workspace name, then "Open ↵" and "More actions Tab", on a 3% sel-fg wash with a top hairline.
- Workbench: §6.9.

### 2.14 Tooltip `.fl-tip`

Padding 4 8, `--r-8`, solid `--menu-bg`, 1px `--dialog-border`, `--shadow-tip`; 12px `--fg`, an optional 500 `--sel-fg` lead word, keys at the end. Delay 500ms on hover (0 for mark-only targets), at once on keyboard focus; fade 120ms. Never interactive. Every rail icon, status-bar item and jargon chip has one in plain words ("2↓ 1↑ · 2 commits to pull, 1 to push").

### 2.15 Toast `.fl-toast`

Region bottom-right, 16 from the edges, gap 8. Toast: width `--w-toast`, padding 12, `--r-float`, glass + `--rim` + `--elev-3`; grid `16 icon | title (600 --sel-fg) + text (12px --fg-2) + actions (sm buttons) | close`. Countdown: a 2px bar along the bottom inset 12, `--fg-2` on `--pill-bg`, paused on hover; errors don't auto-dismiss. Arrives on `--spring-pop` from 8px below. At most 3; the rest go to the notification center. `role=status` (`alert` for errors).

### 2.16 Card `.fl-card`

| Variant | Fill | Border | Shadow |
|---|---|---|---|
| inline (default) | `--input-bg` | 1px `--hairline` | `--rim` |
| `--flat` | transparent | 1px `--hairline` | none |
| `--ghost` | transparent | none | none |

Radius `--r-box` 10; padding 12 (`--sm` 8 12); gap 8–12. Head: 11px `--fg-2` row (puck sm, agent name, status mark, time words). States: interactive hover = border 40% toward `--fg-2`; **the card the keys act on** = 7% `--sel-fg` tonal fill + 1px `--fg-2` edge; waiting = no ring (the head's bullseye); failed = the head's ⊗ + "Failed" in error ink, no red border; muted .6; arriving = `--spring-pop` rise. Don't: a box inside a card (rule-separated sections instead); shadows on inline cards.

### 2.17 Dialog · Sheet

Dialog: `--w-dialog` (wide 880), padding 16, gap 12, `--r-dialog` 14, glass (dialog tone) + `--rim` + `--elev-4`, 1px `--dialog-border`; overlay `--overlay`; opens on `--spring-snap` (98% + 6px). Head 16/600 `--track-title` + subtitle 12px `--fg-2` + close icon button sm. Foot: quiet Cancel first, primary or danger last (Windows: primary first). Focus trap, Esc closes, focus returns. Sheet: bottom, max 60vh, `--r-dialog` top corners, handle 36×4, slides on `--spring-snap`.

### 2.18 Tabs `.fl-tab`

Strip 32 (`--tab-h`), padding 0 8, gap 2. Tab 26, padding 0 4 0 8, `--r-ctl`, gap 8; 16 icon `--fg-2` (neutral file icons; a chat tab leads with its agent mark); label 13 `--fg-2`; close × 22 square (24 hit box) shown on hover and when active; Delete closes the focused tab. **Active:** the raised tab fill + `--sel-fg` text + a 2px `--sel-fg` line along the top edge inset 8 (slides on `--spring-snap`). Hover: `--fg` on `--hover-bg`. Preview tab: italic label (a dirty tab is never a preview). Chat tabs end with a status mark (§2.23). Overflow: a quiet "N more chats" button that opens the All-chats popover; the v1 Fit rules (§2.18 Fit, `tabFit()`) still decide how many whole tabs show. Panel tabs (Terminal, Problems…) are Tabs at sm 22.

### 2.19 Row / Tree row `.fl-row`

Row min 26 (lists), **24 (trees, comfortable)**, 22 (compact density); padding 0 8; `--r-row` 6; gap 8 (trees 4); 16 icon `--fg-2`; meta 11px `--fg-2` tabular at the end. Tree: indent 12 per level; 16 twisty; 1px `--indent` guides at each level; a 6px git-modified dot on a folder whose descendants changed; git letters M/U/D in straw/green/red mono 11. States: hover `--hover-bg` (trail); selected `--sel-bg` + the selection mark + `--sel-fg`; keyboard focus a 1px inset `--focus` outline. Chat rows: puck sm + title + status mark with an accessible name.

### 2.20 Table

As v1 §2.20 with v2 tokens: header 26, 11px/500 `--fg-2`, `--border` below, sticky; cells min 32, padding 4 8, `--hairline` rules, numbers right-aligned tabular; hover `--hover-bg`; selected `--sel-bg` + mark; frame `--r-box`.

### 2.21 Code · IO · Diff

**Code:** `--code-bg`, `--r-box` (`--r-ctl` inside a card), padding 8 12, mono 12/1.6, wrap; copy (icon button sm) fades in on hover.
**IO:** as v1 §2.21 with `--r-ctl` and v2 tokens.
**Diff card:** `--r-box`, 1px `--hairline`, `--code-bg`, `--rim`. Head 36 on `--input-bg`: file icon, mono file pill, `+N −N` (mono 11, green/red), the extent in words ("showing the first 3 lines"), a quiet "Review" button (opens the diff beside the code). Rows mono 12/1.6, grid `4ch | 2ch | text`; long lines don't wrap and fade over their last 24px; added rows `--added` 6% + a 2px left bar in `--added`; removed the same with `--removed`; changed tokens (`em`) at 18% with `--r-3`; signs 600, mixed toward `--fg` by `--tone-ink`.

### 2.22 Agent puck `.fl-avatar` (was "Avatar"; class kept)

Round (50%). Sizes xs 14 (status bar), sm 16, md 20, lg 32, marker 28. Fill: the agent's hue at 16%; its mark (§2.22b) in the hue at 70% of the box. **Working:** a 1.5px gap in the surface colour and a 3px `--status-working` ring that breathes (opacity .6 ↔ 1 over 2.4s; static under reduced motion). Stacks overlap by 4px with a 2px surface-colour ring. Always `role=img` + a name ("Claude, working").

### 2.22b Agent mark `.fl-mark`

As v1 §2.22b (16 box, no fill/border, rest in the text colour, hue on hover/selected), stroke 1.5. Claude's burst and Gemini's sparkle stay. **Codex (owner, 2026-10-20): a closed loop, not `{ }`** (braces read as a JSON file icon in every list) and not OpenAI's logo: one 1.5px stroke tracing a horizontal figure-eight, `M4.75 5.5a2.5 2.5 0 1 0 0 5c1.6 0 2.4-1.3 3.25-2.5S9.65 5.5 11.25 5.5a2.5 2.5 0 1 1 0 5c-1.6 0-2.4-1.3-3.25-2.5S6.35 5.5 4.75 5.5z` on the 16 grid (x 2.25–13.75, y 5.5–10.5: it sits on the same optical centre as the burst and the sparkle). It stays vendor-neutral: a glyph for "the agent that runs your code", in Codex's hue. B2 draws it in `icon.tsx` and reruns `scripts/agent-icons.mjs`.

### 2.23 Status mark `.fl-status` (was "Status dot"; `.fl-dot` stays as an alias)

A 12px box; each state is a shape and a colour:

| State | Shape | Colour | Accessible name |
|---|---|---|---|
| needs you | bullseye: a 2px ring of 12 + a 4px centre dot | `--decision` | "needs you" |
| working | an open ¾ arc, 2px, rotating 1s (a static ¾ ring under reduced motion) | `--status-working` | "working" |
| done | check, 2px | `--status-done` | "done" |
| failed | ⊗, a circle with a cross, 2px | `--error` | "failed" |
| idle / in review | a hollow ring, 1.5px | `--fg-2` | "idle" |
| modified (settings) | a 6px dot | `--fg-2` | "changed from the default" |

The four main states stay distinguishable by shape under protan, deutan and tritan simulation (`review/v2/cvd/`). Never colour alone: rows add a tooltip; cards add words ("waiting 6m", "Failed").

### 2.24 Progress · Spinner · Countdown

Progress: 3px (cards) / 4px (pages), pill, `--status-working` on `--pill-bg`, width animates 260ms; indeterminate as v1. Spinner = the working arc (12/14/20). Countdown: 2px, `--fg-2` on `--pill-bg` (v1's accent countdown would spend the accent). A working card shows the arc + "step 4 of about 5", not a bar as well.

### 2.25 Keycap `.fl-kbd`

18 tall, min 18, padding 0 4, `--r-4`, `--pill-bg` + a 1px bottom `--hairline` inset; 11px/500 `--fg-2` tabular; `--fg` inside a selected row. macOS: one cap per key in ⌃⌥⇧⌘ order; Windows/Linux: one cap "Ctrl+Alt+Shift+X" (§1.14). Chords render VS Code style in one cap: "⌘K A" / "Ctrl+K A". **Placement:** the palette, the one primary, the focused approval card, tooltips; nowhere else. B2 adds a lint that rejects repeated modifiers and the wrong order.

### 2.26 Divider · Empty state · Banner

Divider: 1px `--hairline`, margin 4 0; vertical 1×16. **Empty state:** unboxed, start-aligned in its column, padding 12 4: a 40 line mark or 20 icon in `--fg-2`, title 15/500 `--fg`, text 12px `--fg-2` that says what will arrive and what happens then ("Work an agent marks ready for review stops here before it merges. You'll get a nudge."), at most one action. Banner: as v1 §2.26 with `--r-box` and v2 tokens.

### 2.27 Composer (layout and behaviour frozen; visuals restyled)

The owner's "complete change" authorises new visuals; DOM, sizes and behaviour stay. Box: `--r-12`, `--input-bg`, 1px `--hairline`, `--rim` + `--shadow-composer`; focus: border `--focus` 60% + halo. Bar (gap 4): + and / quiet icon buttons (26); agent pill md (mark + name); model pill md ("Sonnet 4.5 · High", tooltip "Model and how long it thinks"); mode pill md ("Edits land, Rewind undoes" / "Ask before edits"; in a discussion: "All 3 agents" and "Read-only: no files change" instead of agent/model); mic (unchanged blue); **send: 26, `--r-ctl`; `--pill-bg` + `--fg-2` when empty; `--send-bg` (the accent) + white + `--sheen` when there is text.** Placeholder fits one line ("Ask Claude… @ mention, / commands"). ⌃⌘I focuses it from anywhere. B2 updates `test/composer-frozen.test.ts` and the harness's computed-style baselines on purpose (HANDOFF §B2.3).

### 2.28 Workbench components (v1) → §6

v1's Breadcrumb, Status bar item, Nav rail item, Section header, Scrollbar, Setting row, Checklist step, Rating row and Command center are superseded by §6.

### 2.29 Decisions (approval card)

A Card (inline), no ring. Head: bullseye + "Codex wants to install a package" (600 `--sel-fg`) + a risk pill ("Low risk" neutral / "Changes files outside the project" warn / "Can't be undone" failed). **"Why:"** line (12px `--fg`). Command well (`--code-bg`, `--r-ctl`, mono 12, `$` in `--fg-2`). **Effects row** (12 icons + plain sentences: what it changes, what it downloads, whether Rewind takes it back). Foot: quiet "Edit command" at the start; secondary "Deny esc" and the primary split "Allow once ⌘↵ ▾" at the end (Windows: primary first). The keys act only while the card has focus (a stray Enter in the composer never approves). Risky actions use HoldButton and list what cannot be undone (B5's list of commits a force-push drops, and its safer alternative, are kept). Board version (§2.35): the same verbs and keys on the focused card.

### 2.30 Discussion `.fl-discuss`

Page = chat page: head (discuss icon, the question at `--t-hero` 20/600, a pill "3 agents · 3 rounds · no files changed", a "Transcript · 9 turns" quiet button) and a context rail (§2.34: agents by name, started, cost in money with tokens beneath, time, **Rounds** in words, files read). The conclusion is unboxed sections with one hairline before "Where each agent stands": headline (fork icon + "Still split on one question", `--t-lead` 15/600); the question they split on (500 `--fg`); **one plain sentence per side**; two columns "They agree on" (list) and "Recommended next step" (arrow icon, 500 `--sel-fg`); actions: "Summed up by Gemini, the agent that didn't pick a side" (11px `--fg-2`), secondary "Keep discussing esc", primary split "Carry out with <the agent whose plan won> ⌘↵ ▾". Positions: one track per agent (1px `--fg-2`, a centre tick), one puck at its position, the words at the right ("80% sure, firmer than round 1"); round history lives in the rail. Sides: two columns separated by a single hairline with "vs". The composer addresses the discussion (§2.27). The layout setting (Board + meter / Board / Meter / Timeline) stays; Board + meter is the default.

### 2.31 Subagent detail · 2.32 Timestamp

As v1 §2.31 and §2.32, on v2 tokens (pucks, status marks, `--r-box`).

### 2.33 Needs-you pill `.fl-needs` (new)

The front door, in the title bar's right cluster: 26 tall, pill, `--pill-bg`, padding 0 4 0 8, bullseye + "3 need you" 12px/500 `--sel-fg`; `white-space: nowrap`; collapses to bullseye + count under 1100px; hidden when the count is 0. ⌘K A or a click opens the Agent Manager on Needs you. The rail's Agents badge (a loud Count) is the only other place this number appears.

### 2.34 Context rail `.fl-ctx` (new)

Right column of a chat or discussion page: 300 wide (264 under 1300px), 1px `--hairline` start border, padding 16, sections 20 apart; section head 12px/600 `--fg` + a Count; facts in 2 columns (label 11px `--fg-2`, value 13px tabular); rows md. Shows the agent(s), started, **cost in money with tokens beneath**, time, files changed, files read, Rewind points (chat) or Rounds (discussion).

### 2.35 Agent Manager board (new composition)

Page head: h1 "Agents" (`--t-hero`), Segmented Board / List / Map, a filter Input 240, quiet "All agents ▾", a "⋯" icon button (Images, keyboard help), primary "New chat ⌃⌘N". Four columns, gap 16, no column fill. Column head 26: status mark + name 600 + Count (loud for Needs you) + an 11px summary ("2 questions · 1 failed"), a hairline under it. Cards (§2.16): head (puck sm with ring if working, agent name, status mark, "waiting 6m" / "for 48s" / clock time), title 13/500 `--sel-fg`, sub 12px `--fg-2`, meta (mono branch pill, step pill, `+N −N`), actions (sm; the focused needs-you card shows "Allow once ⌘↵" primary + "Deny esc"; other cards secondary verbs; an open icon on every needs-you card). A failed card offers the fix first ("Let Codex fix it"), then Retry and Open log. Empty column: §2.26. Done column: 3 cards + "and 2 more"; done copy says what happened ("Merged into main. Nothing needed from you.").

### 2.36 Ask box `.fl-ask` (new)

The welcome hero input: 52 tall, `--r-12`, `--input-bg`, 1px `--field-border`, `--rim` + `--elev-1`, max 640; agents icon, 14px placeholder "What do you want to build or change? Claude will start on it.", a primary "Start ↵" inside at the end. Beside it: "or type /discuss to have your agents argue it out first" (12px `--fg-2`).

### 2.37 Selection mark (new)

A 3×12px pill in `--sel-fg`, vertically centred at a selected row's leading edge (Fluent's selection pill; straight, never an inset curve on a rounded row). On list and tree rows, chat rows, settings navigation and radio rows. Not on tabs (§2.18 top line), not in the palette (fill only), not on cards.

### 2.38 Welcome page (new composition; replaces the stock walkthrough)

Hero: the line mark 48 + the greeting at `--t-display` 28/600 `--track-display` ("Good afternoon, Arun", by local time) + one sentence of state (working, needs you, done today, spend); quiet "Open folder" and "Get a project from GitHub" at the end of the row; the Ask box (§2.36) on its own row. Left column: Recent (rows 40: folder icon, name 500, path `--fg-2`, a branch pill only when it isn't the default branch, time; hairline rules) and Agents (2×2: puck md + name + plain status). Right column: Needs you (puck, title, reason · time, status mark, one sm action), Working (puck with ring, title, step text, a 72px progress bar), Done today (3 + "and 2 more"). **First run** (no projects, no agents): the Ask box, "Connect an agent" and "Try the demo agent" instead of the lists.

---

## 3. Enforcement

v1's `designSystem.test.ts` ratchet and `palette.test.ts` stay. v2 adds:
- `palette.test.ts` runs every check against FriedLiver Dark/Light too (`test/fixtures/theme-friedliver-{dark,light}.css`, written by `scripts/theme-fixture-v2.mjs`).
- `test/themes.test.ts` checks six themes; FriedLiver Dark is the default, FriedLiver Light the light preference.
- **Render gates** (`review/v2/src/render.mjs`; B2 moves them into the UI harness): text contrast on composited backgrounds for every text node (4.5:1, 3:1 large); status marks and focus rings 3:1; accent groups ≤ 1; spacing on the half-grid; no control outside the window. Final state: **35 renders, 0 failures** (`review/v2/gates.json`).
- B2 adds a keycap lint and a 24×24 hit-box check.

## 4. The gallery

`scripts/ui-gallery.mjs` (B2 adds FriedLiver Dark/Light and the Windows layer to its themes) and the v2 mock (`review/v2/src/index.html?screen=<workbench|palette|manager|chat|discuss|settings|welcome>&theme=<dark|light|hc>&platform=win`).

## 5. v1 → v2 map

| v1 | v2 | Where |
|---|---|---|
| Dark 2026 fallbacks; `--vscode-*` only | FriedLiver Dark/Light; OKLCH source | §1.1 |
| new tokens | `--accent-bg/-fg/-hover/-press`, `--r-10/14`, `--r-float`, `--r-dialog`, `--h-xl`, `--t-xs…--t-display`, `--t-lead`, `--track-*`, `--lh-code`, `--sp-10/12`, `--w-*`, `--rim`, `--sheen`, `--sel-bar`, `--spring-snap/pop`, `--dur-out/-spring/-pop`, `--press-scale`, `--open-scale`, `--i-stroke` | tokens.css |
| primary = inverted neutral | primary = ember accent | §2.1 |
| `--brand` button (send) | removed; the send uses the primary's colour | §2.1, §2.27 |
| toggles/checkboxes on = `button.background` (blue) | the accent | §2.8, §2.9 |
| focus = the theme's blue | neutral ring; Windows double ring | §1.12 |
| Status dot (colour only) | Status mark (shape + colour) | §2.23 (`.fl-dot` alias) |
| Avatar (r = size/4) | Agent puck (round, working ring) | §2.22 |
| radii 5 / 4 / 8 | 6 / 6 / 10 / 12 / 14 (Windows 4 / 4 / 8) | §1.4 |
| palette rows 22 | 40 | §2.13, §6.9 |
| card focus = decision ring; waiting = blue tint | tonal + edge; the head's mark | §2.16 |
| discussion card (A/B/C) | v2 composition | §2.30 |
| §2.28 workbench components | §6 | |
| tree indent 12, rows 22 | indent 12, rows 24 (comfortable) / 22 (compact) | §2.19, §6.3 |
| new | Needs-you pill, Context rail, Board composition, Ask box, Selection mark, Welcome page | §2.33–2.38 |

---

## 6. Stock workbench spec (phase B)

Mechanisms: **T** theme keys (`palette.json` overrides) · **C** `workbench/friedliver.css` (only `--fl-*` and `--vscode-*`) · **D** configuration default (`friedliver-theme/package.json` or a patch for application-scope settings) · **P** a TS/DOM patch. Every C rule is scoped to `.monaco-workbench:not(.hc-black):not(.hc-light)` (v1 rule). The reference look is `review/v2/src/v2.css` ("The workbench" section) and the mock screens.

### 6.1 Title bar (custom)
Target: 40 tall, shell tone, no border. macOS: traffic lights, the 16px line mark, back/forward (IconButton sm), the project name 13/600 `--sel-fg` (no branch pill: the status bar owns the branch); centre: the command center pill (26, pill radius, `commandCenter.background`, "Go to file, run a command, ask an agent", a ⌘P Keycap; min(520, 36vw)); right: the Needs-you pill (§2.33) and one Layout IconButton (menu: side bar / panel / agents); no account icon (the activity bar has it). Windows: app icon, app menu (hamburger under 1600px), the same centre, caption buttons from `titleBarOverlay`.
- T: `titleBar.activeBackground/inactiveBackground` = shell; `titleBar.border` none; `commandCenter.*`.
- D: `window.titleBarStyle: custom`, `window.commandCenter: true`, `workbench.layoutControl.enabled: false`, `window.menuBarVisibility: compact` (Windows under 1600).
- C: `.part.titlebar` height via `--fl-title-h` 40; `.command-center .action-item.command-center-center` (exists in 0110).
- P (0160): `DEFAULT_CUSTOM_TITLEBAR_HEIGHT` 35 → 40 in `src/vs/platform/window/common/window.ts`; upstream centres the traffic lights in that height (x 14, y 13 with macOS 26's 14px buttons) and sizes the Windows `titleBarOverlay` caption buttons (46×40) from it, so one constant moves both. The nav rail is 48 wide (`FLOATING_ACTIVITYBAR_WIDTH`). `src/vs/workbench/browser/parts/titlebar/titlebarPart.ts`: the mark before the menubar, and a `MenuId.TitleBar` slot the Agents extension fills with the Needs-you pill (the extension API can't target the title bar, so the patch adds the slot).

### 6.2 Activity bar (nav rail)
Target: 48 wide, shell; items IconButton lg 32, `--r-8`, 20 stroke icons (product icon theme), `--fg-2` → `--fg`; selected: `--sel-bg` + a 3×16 `--sel-fg` pill flush at the start edge (the same on Windows); badges: neutral Count; Agents' badge loud with a 2px shell ring. Tooltips name the view and the count ("Agents · 3 need you").
- T: `activityBar.background` shell, `activityBar.activeBorder` sel-fg, `activityBar.inactiveForeground` fg-2, `activityBarBadge.*` decision.
- C: `.activitybar .action-item.checked .active-item-indicator::after` (0110 has the pill: 3×16, `--fl-sel-fg`), `.badge .badge-content` → Count.

### 6.3 Side bar, sections, tree rows
Target: shell tone; head 32 ("Explorer" 13/600 `--sel-fg`, + and ⋯); trees: rows **24** comfortable (22 compact), indent 12, guides always, neutral file icons, git "M" in straw, folder dots; selected = fill + selection mark; the Chats view (patch 0130) below Explorer, collapsed by default, rows = puck + title + status mark; Outline and Timeline collapsed.
- T: `sideBar.*`, `sideBarSectionHeader.background` shell / `.foreground` fg-2, `list.*` (selection sel-fg 11%, hover 7%), `tree.indentGuidesStroke`, `gitDecoration.modifiedResourceForeground` straw.
- D: `workbench.tree.indent: 12`, `workbench.tree.renderIndentGuides: always`, `workbench.iconTheme: "friedliver-files"` (a neutral file-icon theme: 16-grid stroke glyphs in `--fg-2`, shipped with the theme extension).
- C: `.monaco-list .monaco-list-row.selected::before` = the selection mark; `.pane-header` 26, label 12/600.
- P (new **0150-row-density.patch**): setting `workbench.list.density: comfortable | compact`; `explorerViewer.ts` `ExplorerDelegate.ITEM_HEIGHT`, the SCM, Outline and Search delegates read it (24 / 22).

### 6.4 Editor tabs
Target: strip 32 on the page tone; tabs 26, `--r-ctl`, gap 2; active = the raised fill + the 2px top line; inactive `--fg-2`; × on hover and active; preview italic; no connected shoulders.
- D: `workbench.experimental.modernUIEditorTabStyle: "pill"`, `workbench.editor.tabSizing: shrink`.
- T: `editorGroupHeader.tabsBackground` page, `tab.activeBackground` raised, `tab.inactiveBackground` page, `tab.border` none, `tab.activeBorderTop` sel-fg.
- C: `.tabs-container > .tab` height 26, radius `--fl-r-ctl`; `.tab.active::after` = the top line.

### 6.5 Breadcrumbs
A 22 row; 12px `--fg-2`, last segment `--fg`; 12 chevrons at 70%; segments are quiet sm buttons (`--r-ctl`). T `breadcrumb.*`; C `.monaco-breadcrumbs .monaco-breadcrumb-item`.

### 6.6 Editor chrome (gutter, minimap, scrollbars)
Target: line numbers `.6 .006 60` (4.5:1), active line number `--fg`; the current line a slight lift (`editor.lineHighlightBackground` .215), no border; gutter change bars 2px: added solid green, modified **hatched** straw, deleted a red wedge; the ember caret; minimap off; an overview ruler of 14 with shape-coded marks (changes in the start third; find matches in the centre; warnings in the end third; **errors a full-width band**, patch 0180) and a 6px pill slider; sticky scroll on; inline suggestions as dotted-underlined ghost text. Open: agent edits as an end-half blue mark (B2 decorates them) and the "suggestion · Tab accepts" hint after the ghost text (an injected-text decoration in `ghostTextView.ts`; deferred because ordering two injected texts at one column needs an editor change).
- T: `editorLineNumber.*`, `editor.lineHighlightBackground`, `editorCursor.foreground` ember, `editorGutter.added/modified/deletedBackground`, `editorOverviewRuler.*`, `scrollbarSlider.*`, `editorGhostText.foreground` fg-2.
- D: `editor.minimap.enabled: false`, `scm.diffDecorationsGutterPattern: {"added": false, "modified": true}`, `editor.overviewRulerBorder: false`, `editor.fontFamily` Geist Mono, `editor.lineHeight: 1.55`, `editor.cursorBlinking: smooth`, `editor.cursorSmoothCaretAnimation: on`, `editor.inlineSuggest.showToolbar: never`.
- C: `.monaco-editor .ghost-text-decoration` (dotted underline), scrollbar rules (0110).
- P: overview-ruler lane widths per kind (`src/vs/editor/browser/viewParts/overviewRuler/decorationsOverviewRuler.ts`); the hint text in the inline-completions hints widget.

### 6.7 Panel and terminal
Target: page tone, a top hairline; a 32 strip with Tabs sm (22); an agent's terminal is its own tab named "Claude · npm test" with its puck; terminal Geist Mono 12/1.4; the prompt's branch in `--fg-2` (blue is reserved).
- T: `panel.background` page, `panel.border` hairline, `panelTitle.activeForeground` sel-fg, `panelTitle.activeBorder` transparent, `terminal.*`.
- C: `.part.panel > .composite.title .action-item` → the Tab look.
- B2: the Agents extension names agent terminals "<Agent> · <command>" with the puck as `iconPath`.

### 6.8 Status bar
Target: 26 tall, shell, no border; items sm 22, `--r-ctl`, 11px `--fg-2` tabular, 14 icons. Start: branch, sync, problems. End: **"◠ 2 agents working"** (the arc + words; one item), Ln/Col, spaces, UTF-8, LF, language, bell. No needs-you count here (the title pill owns it). Remote, debug and offline are toned pills, never a coloured bar. Every item has a plain-words tooltip.
- T: `statusBar.*` shell + fg-2, `statusBarItem.hoverBackground` ghost-hover, `statusBarItem.remoteBackground` raised.
- C: `.part.statusbar .statusbar-item` (0110).
- B2: the agents item is contributed by the Agents extension (`createStatusBarItem`, priority high, end side).

### 6.9 Command palette / quick input
Target: §2.13 palette variant.
- T: `quickInput.background` float, `quickInputList.focusBackground` sel-fg 13%, `pickerGroup.foreground` fg-2, `pickerGroup.border` hairline.
- C: `.quick-input-widget` (radius `--fl-r-dialog`, glass + rim + `--fl-elev-4`, width 640), `.quick-input-filter .monaco-inputbox` (52, 16px), `.quick-input-list .quick-input-list-entry` (the grid), `.quick-input-list-separator` (group labels).
- P (new **0160-palette-v2.patch**): `src/vs/platform/quickinput/browser/quickInputList.ts` item height 22 → 40 (two-line 44); `quickInputController.ts` `layout()` top = the title-bar height + 4; a scope-chips row (`.quick-input-scopes`) whose chips set the value prefix; an agents quick-access provider on `~` (in core, or contributed by the Agents extension through a small proposed API). `>`, `@`, `#`, `:` stay upstream's.

### 6.10 Context menus
§2.13 menu (radius 12, glass + rim, rows 26 inset 6). 0110 already restyles `menu.ts`'s shadow-DOM CSS; v2 changes: `--fl-r-row` 6, row margin 0 6, container radius `--fl-r-float`, `--fl-elev-3` + rim. macOS custom menus stay on (0110).

### 6.11 Hovers
Simple hovers = Tooltip §2.14; rich (editor) hovers = Popover (`--fl-r-float`, glass). T `editorHoverWidget.*`; D `workbench.hover.delay: 500`; C `.monaco-hover`, `.workbench-hover` (0110).

### 6.12 Notifications / toasts
§2.15. 0110 already sets 400 wide and 38 rows; v2: radius 12, rim, `--spring-pop` arrival (keyframes under `.monaco-enable-motion`), the countdown bar; P: drop the "Source:" label (`notificationsViewer.ts`).

### 6.13 Dialogs
§2.17. 0110 turns on custom dialogs; v2: radius 14, rim, the Windows button order (upstream already reverses on `isWindows` in `dialog.ts`; verify).

### 6.14 Settings editor
Target (mock `settings-*`): an editor tab (not the modal editor); TOC 232 ("Commonly used" first, rows 26 with the selection mark, no counts); search lg 32 with a ⌘F Keycap; a "2 you changed" filter chip (the `@modified` filter); scope Segmented "For me / For this project"; group titles 16/600 + a 12px description; setting rows: grid `1fr | 220–320`, padding 8 12, hairlines between; title 13/500 `--sel-fg` with the 6px changed dot in the gutter; description 12px `--fg-2` that describes both states; the control at the end (switch, select, number sized to content, segmented); setting IDs (`friedliver.agents.default`) on hover or focus only; "Edit as JSON" quiet button in the tab strip.
- D: `workbench.settings.editor: ui`, open Settings as an editor rather than the 1.142 modal editor (the modal-editor setting off), `workbench.settings.useSplitJSON: false`.
- T: `settings.headerForeground` sel-fg, `settings.modifiedItemIndicator` fg-2, `settings.focusedRowBackground` hover, `settings.rowHoverBackground` hover, `settings.textInputBorder` / `numberInputBorder` / `dropdownBorder` field border.
- C: `.settings-editor .settings-toc-container`, `.setting-item-contents` (the grid), `.setting-item-modified-indicator` (a dot in the gutter), `.setting-item-title`, `.setting-item-description`, `.setting-value-checkbox` → the Switch look (a track pseudo-element on the existing toggle), `.settings-tabs-widget` → Segmented.
- P: the scope labels "User"/"Workspace" → "For me"/"For this project" (display strings in `settingsEditor2.ts`); TOC counts hidden (`tocTree.ts`).

### 6.15 Welcome / walkthrough
Target §2.38. The stock Getting Started can't show live agents, so B2 ships a **FriedLiver Welcome** webview editor in the Agents extension and it opens on an empty window and on first run.
- D: `workbench.startupEditor: none` (already), `workbench.welcomePage.walkthroughs.openOnInstall: false`.
- P: 0140 already rebrands the walkthrough; keep it for Help → Welcome.

### 6.16 Extensions view and editor
List rows two-line (40): icon 32 `--r-8`, name 500, publisher + rating 11px tabular; list actions are secondary (Install is secondary in lists; the extension editor's main Install is the one primary); verified = a check pill. T `extensionButton.prominentBackground` accent (editor header only), `extensionButton.*` secondary elsewhere; C `.extension-list-item .extension-action.prominent` → the secondary look.

### 6.17 Diff editor
Inserted/removed lines 6% + 2px gutter bars; character-level 18%; no diagonal fill; gutter indicators in the same colours; inline view under 900px.
- T: `diffEditor.insertedLineBackground` / `removedLineBackground` 6%, `diffEditor.insertedTextBackground` / `removedTextBackground` 18%, `diffEditorGutter.*`, `diffEditor.border` hairline, `diffEditor.diagonalFill` transparent.
- D: `diffEditor.renderSideBySideInlineBreakpoint: 900`, `diffEditor.experimental.showMoves: true`.

### 6.18 Peek
`peekView.border` hairline (not blue), `peekViewTitle.background` raised, `peekViewEditor.background` code-bg, `peekViewResult.background` float, selection sel 11%; C `.peekview-widget` radius `--fl-r-box`, rim.

### 6.19 Find widget
A Popover row: 32 tall, `--fl-r-8`, glass + `--fl-elev-3`; input md; option toggles = IconButton "on" (`--sel-bg`); the match count 11px tabular. T `editorWidget.*`, `inputOption.activeBackground` sel, `editor.findMatch*` straw `.8 .1 85` at 35%; C `.monaco-editor .find-widget` (0110).

### 6.20 SCM view
The commit input is an Input md that grows; the commit button is the primary only when changes are staged (secondary otherwise); changes are tree rows (24) with M/U/D letters (straw/green/red) and `+N −N`; the graph gives agent-authored commits the agents' hues. T `scmGraph.*`, `gitDecoration.*`; C `.scm-view .scm-editor`, `.scm-provider`.

### 6.21 Product icon theme
A `productIconThemes` contribution in `friedliver-theme`: "FriedLiver Icons", made the default with `workbench.productIconTheme`. A woff2 font is built in CI from the 16-grid SVGs (the `P` paths in `review/v2/src/mock.js` + `icon.tsx`) by a new `scripts/build-icon-font.mjs` (outlined at stroke 1.5), never by hand. First ~60 ids: `files, search, source-control, debug-alt, extensions, account, settings-gear, chevron-right, chevron-down, close, add, ellipsis, split-horizontal, layout-sidebar-left, layout-sidebar-right, layout-panel, bell, sync, git-branch, error, warning, info, check, circle-filled, circle-outline, terminal, file, folder, folder-opened, json, markdown, play, debug-stop, refresh, filter, list-flat, list-tree, collapse-all, new-file, new-folder, go-to-file, copy, trash, edit, pin, pinned, history, comment, sparkle, keyboard, globe, zap` and the ten most common `symbol-*`. Others fall back to Codicons. Own glyphs are MIT; any Lucide-derived glyph keeps Lucide's ISC text beside the font.

### 6.22 Fonts
Workbench: Geist + Geist Mono are bundled (0100). v2 changes the Windows UI stack to `"Segoe UI Variable Text", "Segoe UI", "Geist", sans-serif` (Linux keeps Geist first; code stays Geist Mono everywhere). Webviews (B2): copy the four woff2 and the OFL texts into `extensions/friedliver-agents/media/fonts/`, declare them in a `fonts.css` loaded before `tokens.css`, allow `font-src ${webview.cspSource}`, and default `chat.fontFamily` to `"Geist, system-ui, sans-serif"`.

---

## 7. Decisions (v2)

| Question | Decision | Why |
|---|---|---|
| Direction | Beacon | §0 |
| The accent | ember `oklch(.56 .15 42)`, white ink 5:1, both themes | The blind panel rejected blue + orange side by side (round 1) and stock blue as the accent (rounds 2–3); ember comes from the mark, so the brand owns it |
| Needs-you | blue, marks only | Owner rule (2026-10-18); restricted to marks so it never competes with the accent |
| Focus | neutral ring | An accent or blue ring on an off switch read as an error (rounds 5–6) |
| Selection | fill + pill (lists), fill + top line (tabs), fill only (palette) | An inset bar on rounded rows read as "(" (round 7) |
| Status | shapes | WCAG 1.4.1; CVD simulations |
| Panels | attached, tone-separated, full width | Figma UI3's reversal; the owner's full-width rule |
| Composer | visuals restyled, layout frozen | The owner's "complete change" order |
| Keys | no shadowed VS Code defaults or quick-open prefixes; agents on ⌘K chords and `~`; ⌃⌘I focuses chat; ⌃⌘N new chat; approval keys only while the card has focus | Power-user critic, rounds 4–9 |
| Needs-you colour (owner, 2026-10-20) | blue, marks and links only, never a fill | Owner rule, confirmed |
| Working (owner, 2026-10-20) | a warm neutral animated arc (`--status-working` = `--fg-2`); green only for done/success | Removes a fourth hue (taste critic) |
| First run (owner, 2026-10-20) | "Ask before edits" stays the first-run default | Newcomer critic |
| Codex mark (owner, 2026-10-20) | a closed figure-eight loop (§2.22b), vendor-neutral | `{ }` read as a JSON file |
| Active tab | Modern UI pill tabs (`modernUIEditorTabStyle: pill`) with the 2px top line on the active pill's fill; height 24 (Modern UI's pill height; the strip's 32 is unchanged) | Spec §6.4 with upstream's pill geometry |
