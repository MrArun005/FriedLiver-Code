# Design System v2: the blind review panel

Date: 2026-10-20. Nine rounds, six independent critics per round (54 reviews, a fresh agent each time, so no critic remembered an earlier round).

## Method

- **Blind set** (`panel/set/`, rebuilt every round): Candidate **A** = the v2 mockups (A1–A8 macOS dark/light; from round 2 also A9–A15, the Windows variant). Candidate **B** = the shipping FriedLiver (release v1.142.0-9 workbench shots from CI run 39433871626, and the latest webview captures in `review/`). **R1–R3** = crops of shipping products (Linear's agent menu and diff, Raycast's launcher; `panel/refs/`). Critics also ranked Zed, Cursor 2.x and macOS 26 apps from their own knowledge. Nobody was told which candidate was ours.
- **Critics:** (1) senior product designer, Linear/Apple bar; (2) daily VS Code power user; (3) newcomer who has never used an IDE; (4) WCAG 2.2 accessibility auditor (also given `cvd/` simulations, high-contrast renders and `gates.json`); (5) Windows 11 / Fluent user; (6) taste critic (delight only).
- **Each critic returned:** a ranking of A, B, Linear, Raycast, Zed, Cursor, macOS 26; a 1–10 love score for A and B; every "still off" item in A as file · where · fix.
- **Objective gates** (`src/render.mjs`, run on all 35 renders every round): text contrast on composited backgrounds (4.5:1 / 3:1 large), status marks and focus rings 3:1, accent groups ≤ 1 per screen, spacing on the 2px half-grid, controls inside the window (added round 8), plus protanopia/deuteranopia/tritanopia renders of the board.
- Owner rules the critics could not override: needs-you is blue (2026-10-18); 60/30/10; full width; the composer's layout and behaviour stay.

## Rankings by round (position of A; ties shown as "=")

| Round | Designer | Power user | Newcomer | Accessibility | Windows | Taste | A love (avg) | B love (avg) |
|---|---|---|---|---|---|---|---|---|
| 1 | 4 (Linear, Raycast, Zed) | 2 (Cursor) | 4 (Linear, macOS, Raycast) | 3 (Cursor, Raycast) | 3 (Cursor, Linear) | =5 with Cursor | 7.1 | 3.8 |
| 2 | =3 with macOS (Linear, Raycast) | 2 (Zed) | 2 (Raycast) | **1** | **1** | 4 (Raycast, Linear, macOS) | 7.8 | 4.1 |
| 3 | =3 with macOS | **=1** with Zed | **1** | **1** | **1** | =4 with Zed | 7.8 | 3.8 |
| 4 | =4 with Zed | **1** | **1** | **1** | **1** | 3 (Linear = Raycast) | 7.8 | 3.7 |
| 5 | 3 (Linear, Raycast) | **=1** with Zed | 2 (Raycast) | **1** | **1** | 3 | 7.8 | 3.5 |
| 6 | 3 | **1** | =2 with Linear (Raycast) | **1** | **1** | =3 with Zed | 8.0 | 3.8 |
| 7 | =4 with Zed (Windows overflow regression) | 2 (Zed) | **1** | **1** | 3 (Cursor, Linear) | =4 with Zed | 7.4 | 4.0 |
| 8 | =3 with Zed | **1** | **1** | **1** | **1** | =3 with Zed | 7.7 | 3.5 |
| **9 (final)** | **3** (Linear, Raycast; A ahead of Zed, macOS, Cursor) | **=1** with Cursor | **1** | **1** | **1** | **3** (Raycast = Linear; A ahead of macOS, Zed, Cursor) | **7.8** | **3.8** |

B (the current app) was last or second-to-last with every critic in every round.

**Result against the target.** The target was first or tied-first with every critic. Four of six reached it and held it (power user, newcomer, accessibility, Windows). The designer and the taste critic end with A **third, behind only Linear and Raycast, and first among IDEs** (both rank A above Zed, Cursor and macOS 26 apps; the designer called it "the first IDE in this set that feels designed rather than skinned"). Both judge single-purpose apps from polished marketing renders against full IDE screens, and both say stills can't show A's motion and glass. Their remaining items are listed below as B/B2 work and open owner decisions; Phase A stopped after round 9 and applied a final round of fixes (round 10, below) that was not re-paneled.

## What changed each round

**Round 1 → 2** (first mocks: "Lantern", ember primary, blue needs-you)
- Critics: two accents fighting (orange buttons beside blue rings, badges and borders); boxes inside boxes; status only by colour (tritan: needs-you and working both teal); palette with no scrim and a second search field; ⌘K stolen from VS Code chords; dev-noise status bar on non-editor screens; frozen tooltip; Mac-only chrome; templated welcome tiles.
- Changes: one accent (signal blue); status marks with shapes; flatter board (no lane fills, no inner boxes); palette 52px filter, scopes, keys column, ⌘P; context-aware status bar; one header band; plain words (Rewind, Hand off tooltips); Windows variant (caption buttons, Ctrl keycaps, Fluent radii, PowerShell paths); a Live-now welcome; a context rail on chat pages.

**Round 2 → 3**
- Critics: counts that disagree across screens (2 vs 1 need you, 3 vs 2 working); a frozen tooltip over the Explorer; copied data in the discussion rail; a setup checklist for a returning user; the meter needs a decoder; blue still on primary, status, borders, badges and links.
- Changes: one count source (3 need you, 2 working, 1 failed) everywhere; a "3 need you" title-bar pill as the front door; failures into Needs you; discussion rail with its own data (Rounds, cost in money); plain sentence before the meter; Codex no longer looks like a JSON file in lists (pucks); welcome without the checklist; field edges 3:1; HC selection outlines.

**Round 3 → 4**
- Critics: blue reads as stock GitHub/VS Code blue (taste, designer); no material or depth; the diff card contradicts the buffer; chat says "Done" while the board says working; ⌘N/⌘⇧A collide; mascot is clip-art.
- Changes: **ember becomes the one accent** (from the mark), blue restricted to needs-you marks; rim light and a top-lit page; the mark redrawn as a line; warm keywords; the chat panel still working (one state everywhere); the diff matches the buffer; ghost text instead of a chip; "Good afternoon"; In review as a voiced empty state; Windows menu; field and switch fixes.

**Round 4 → 5**
- Critics: ⌘2 and Ctrl+Shift+T shadow VS Code keys; a plain Enter would approve while the composer is focused; mixed Windows modifier order; the focus ring and the needs-you ring look alike; HC focus vs selection; failed vs close glyph.
- Changes: no shadowed keys; ⌘↵ to approve, scoped to the focused card; Ctrl/Alt/Shift order; needs-you cards without rings (focus only on the focused card); HC selection = contrast border; failed = ⊗ everywhere; Fluent switches; discussion composer addresses the discussion; settings text follows the switch.

**Round 5 → 6**
- Critics: an orange focus ring on an off switch reads as an error; one column with three card treatments; a red stripe is templated; blank weekend bars; agents row truncation.
- Changes: neutral focus ring; one card surface with the state in the head; no stripes; ⌘K chords for agent commands; the mark in the macOS title bar; caret in ember; no chart; branch pills only when not main.

**Round 6 → 7**
- Critics: palette rows too tight and metadata floating; discussion uses three containment systems; selection only a fill (a11y); `#` prefix taken from VS Code; Deny on bare Esc.
- Changes: 40px palette rows with context after the title; one container for the discussion; a 2px leading selection bar; `#` back to workspace symbols, agents on `~`; Deny on ⌘⌫; restored UTF-8/LF items; warm syntax palette; Windows menu bar.

**Round 7 → 8** (regression round)
- Critics (four of six): the Windows layout overflowed the window (the new menu bar pushed the title bar off-screen, wrapped the pill and hid caption buttons and settings controls); the inset selection bar read as a stray "(".
- Changes: compact app menu on Windows at this width, a no-wrap pill; **a new gate: no control outside the window**; the selection mark becomes a straight 3×12 pill; Esc back for Deny (scoped); keycaps only on the primary; chords in one cap.

**Round 8 → 9**
- Critics: the tab's bar reads as a divider; file glyphs, git "M" and types in the accent's orange family dilute it; four left edges in the chat column; New chat on a ⌘K chord breaks in the terminal; Retry is a dead end on a failed card; a newcomer has nowhere to just type.
- Changes: tabs get a top line instead; neutral file icons, straw git-modified, sea-glass types; one text edge in chats (icons hang in a gutter); ⌃⌘I/⌃⌘N; "Let Codex fix it"; the welcome Ask box ("What do you want to build or change?").

**Round 9 → 10** (applied, not re-paneled)
- Critics: Windows "Ctrl+Ctrl+I" (a translation bug); one chord for two actions; the meter still needs a legend; mixed button treatments on the board; palette selection marked twice; palette anchor differs by platform.
- Changes: ⌃ held with ⌘ maps to Alt on Windows (Ctrl+Alt+I / Ctrl+Alt+N); ⌃⌘I focus, ⌃⌘N new chat; one dot per agent on the meter with no ghosts or legend (history in the Rounds rail); one secondary style on cards, metadata above actions; palette fill-only selection and one anchor; overview-ruler marks shape-coded; prompt bubble visible in light.

## Objective gates (final)

`gates.json`: **35 renders** (7 screens × dark/light × 1440×900/1280×800, plus 7 Windows renders): **0** text pairs under AA, **0** status marks or focus rings under 3:1, **0** off-grid spacings, **0** controls outside the window, accent groups ≤ 1 on every screen (switches excepted by rule). CVD: needs-you ◉, working ◠, done ✓ and failed ⊗ stay distinct in all six simulations by shape (`cvd/`).

## Still open after round 9 (handed to B/B2 or the owner)

| From | Item | Where it goes |
|---|---|---|
| Designer, Taste | The editor screen is still VS Code's anatomy; asks for custom activity-bar glyphs and more brand in the editor | B: product icon theme (§6.21), file-icon theme (§6.3) |
| Taste (every round) | Blue for needs-you breaks the warm colour story; wants amber | **Owner decision** (owner rule says blue) |
| Taste | Green "working" adds a fourth hue | Owner decision |
| Taste, Designer | The discussion meter is undersold (thin tracks, small pucks) | B2: §2.30, thicker 2px tracks and 28 markers are allowed by the spec |
| Taste | A real type scale moment beyond the greeting | Spec has `--t-display`/`--t-hero`; B2 to apply on page titles |
| Newcomer | First-run welcome not shown in the mocks; jargon chips (model effort, ⊙ counts) need tooltips | B2 (§2.38 first run; §2.14 tooltips) |
| Newcomer | "Ask before edits" off by default feels risky | Owner decision |
| Accessibility | Spinners must stop under reduced motion; 24×24 hit boxes; gutter/ruler shapes in HC | Spec'd (§1.11, §2.2, §6.6); B/B2 verify |
| Windows | Re-render with real Segoe UI Variable at 125/150%; real Mica; native caption buttons and Snap | B (needs a Windows build; can't be faked on the render machine) |
| Power user | Esc as Deny remains debated (two critics prefer a chord) | Spec keeps Esc scoped to the focused card; revisit after use |
