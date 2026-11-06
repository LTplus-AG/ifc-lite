# #8947 access hillclimb: Round 4 visual and context taste review (fresh Opus)

**Verdict for the observed UX on 98d3: ACCEPT.** The R4 production change, a distinct
"Reset visibility filters" action that keeps selection and collection, reads clearly. It is
truthful in both its active and inactive states, it stays out of default browse while inactive, and it
does not disturb any accepted layout. Every R3 alignment, recovery-browse and reason fix is still present. The
evidence is pixel-equivalent to the R3 baseline, apart from clock, parse-time and map-tile pixels. I found
no blocking objection. This accepts the observed palette UX only. Complete feature access (rubric 1),
the full four-shard and focused suites, the new mounted child and full gates, and production readiness
remain **unaccepted and unclaimed**.

## Scope and identity

- Reviewer: fresh Opus (`claude-opus-5-5`) on `info@lt.plus`, read-only. I ran no builds, tests, browser
  sessions or fleet commands, and made no edits, commits, pushes, watches or subagents. The brief forbids
  fleet use, so I did not run `ifc-fleet status`.
- Preconditions: `gh api user` returns `louistrue`. #8947 is OPEN, assigned to `louistrue`, and labelled `ready`, `claimed`
  and `claimed:session-t3-fd0b1714`. PR #9024 is OPEN and **draft**, and its head is `98d3ec5fb866e6098e05b7806469447e7223d01f`. The
  local worktree HEAD is the same, with a clean status.
- Source identity: `qualification.json`, `run-summary.json` and all three manifest `label`s give `98d3ec5f…`.
  The tree is `d1cb0fbc…`, the status is empty, and the diff is the empty-string SHA. The dist index is `d7a39377…`.
- Hashes, all re-hashed by me: **36/36** manifest PNGs match `captures.verified`. **90/90** browser attachments
  match `attachments`. The gunzipped `run-manifest.json.gz` equals `originalManifestSha256` `74d0b32e…`. All three
  manifests have `failures: []`. Every `*pageerrors.json` and `00-command-errors.json` is `[]`. `cleanupError` is `null`.
- Runtime: NVIDIA Lovelace, `fallback:false`, `visible-canvas` 832×791, readback pixel `[0,255,0,255]`.
  `e2e.json.gz` reports stats `expected 27, unexpected 0, skipped 0, flaky 0`, with one result each, so there were no retries.
  Each of the three commands exited 0. The root typecheck/build entry in `qualification.rootBuildScope` covers
  the build phases only. The focused and full four-shard jobs are still **RUNNING and are not counted**.
- Astra inputs are background only: the corrected review has no actionable findings, and the closure disposition
  keeps its dormant IDs. Neither is runtime-completeness approval, and I do not treat either as one.

## What changed since R3 (15bd → 98d3)

The palette production delta is small and readable:

- `surface-commands-visibility.ts` adds `vis:reset-filters` (palette-only, Visibility, `RotateCcw`). It runs the
  canonical `resetVisibilityReasons(useViewerStore)`, which is the same function as the viewport chip
  "Reset everything" and the empty-view notice. It does **not** run `showAllFromStore`, which additionally clears
  selection and collection. The difference is real, and the browser test witnesses it: after Show all, the selection
  and collection are `[]`.
- `palette-availability.ts` blocks the row with `commandPalette.availability.noVisibilityFilters` when no
  `resetPolicy: 'cleared'` reason is active. The prerequisite snapshot gains `hasResettableVisibilityFilters`,
  so the state updates live.
- `commandPaletteSearch.ts` generalises the R3 `LOAD_RECOVERY_IDS` into `ACTIVE_ONLY_BROWSE_IDS`, adding
  `vis:reset-filters`. Search still returns the full catalogue. The R3 recovery rule is unchanged, only renamed.
- Localization: en, de and ru have the label, detail, aliases and reason. Screenshot toasts are localized
  (saved, not ready, failed), and a missing renderer now gives a "not ready" refusal instead of a thrown error.
- Everything else in the range is test or witness code, plus main-integration panel changes (panel headers, list,
  validation, BCF, IDS). The branch did not author those changes, and no palette capture exercises them.

## Pixel comparison against the exact R3 Linux baseline

I compared every matrix, context and flow PNG with `palette-access-r3-visual-fd0b1714` (threshold Δ>24 grey).

- **Byte-identical (13):** `palette-narrow` ×2, `palette-short` ×2, `palette-empty.dark`, `access-selected-hide` ×2,
  `access-unloaded-hide.light`, and every `flow-blank-wall`, `flow-measure-quantities` and `flow-narrow-display` image (both themes, `.png`
  and `.actual.png`).
- **Pixel-equivalent:** every remaining matrix, context and flow image differs from R3 only in the box x 1200–1213, y 256–264.
  That box is the properties panel's "Parse Time" milliseconds value. The palette, frame, rows and footer are identical.
- **One environment difference:** `flow-hidden-wall.dark.actual` additionally differs in the map-tile area (x 1075–1391,
  y 740–871). I viewed both images: R4's OpenStreetMap tile loaded and R3's had not. This is not product UI.
- Browser: 38 of the 67 R4 image attachments are byte-identical to R3 images, after test renumbering by +5. For example `23-scrolled-active-row` is R3
  `18`, `10-narrow-dark-colorful-palette` is R3 `05`, `00-disabled/uninstalled-owner` match, and all GPU activation frames match.
  `16`/`17` browse and empty and `24-recent-settings-selected` are pixel-identical to R3 `11`/`12`/`19`. `12-*`, `14-*`
  and `25` differ only in the same "Loaded At" or parse-time strip (y 228–264). The new material is tests 01–05.

So the accepted R3 presentation is preserved exactly. In particular, default browse is unchanged:
`palette-browse` shows the same File rows and the same fold, and the inactive Reset row does not crowd it.

## Images inspected directly

I opened these images myself: `02-reset-preservation-command`, `02-reset-inactive-reason`, `02-actual-state`
(plus magnified crops of the hierarchy-footer and status strips in all three), `03-palette-screenshot`, `03-actual-state`,
`04-presentation-thumbnail.jpg`, `04-presentation-playback`, `04-actual-state`, `05-plan-constrained-refusal`,
`05-actual-state` (plus a magnified crop), `01-actual-state`, `10-actual-state`, `10-narrow-dark-colorful-palette`, `23-scrolled-active-row`,
`00-uninstalled-owner`, matrix `palette-browse` (light and dark), `command-palette.light` (wall), `palette-annot.dark`,
`palette-narrow.light`, `palette-empty.dark`, `palette-short.light`, contexts `access-unloaded-hide.light`, `access-loaded-hide.dark`,
`access-selected-hide.light`, `access-selected-hide-run.light`, `access-history.light` and `access-settings-privacy.dark`, and flows
`flow-hidden-wall.light`, `flow-hidden-wall.dark.actual` (plus the R3 `.actual`), `flow-blank-wall.dark`, `flow-narrow-display.dark`
and `flow-camera-corner.light`. The unopened images are byte-identical or pixel-equivalent to images I opened, or to images R3 opened.

## R4 scenarios

| Scenario | Observation | Judgment |
| --- | --- | --- |
| Reset, active (`02-reset-preservation-command`) | Query `reset visibility filters` returns one row: "Reset visibility filters", with the detail "Keep selection and collection", category Visibility, the selected stripe in the label column and the footer `↵ run`. Behind it, the viewport is fully empty because the collection was isolated and then the same wall was hidden. The chips "Hidden elements · 1" and "Isolated elements · 1", the "IfcWall ×" footer chip, "15 hidden" and "Present 1" are all truthful. The wall is selected in properties. | Clear task language. The detail answers the one question that separates this action from Show all. |
| Reset, after (`02-reset-inactive-reason`) | The model is back and the wall is still blue-selected, with the same properties. The status bar has dropped "15 hidden" and keeps "Present 1", so the collection is kept. The isolation chip and "IfcWall ×" footer chip are cleared, which is correct because isolation is a cleared reason. Re-querying shows the same row muted, with the lock, "No visibility filters to reset", the detail kept beneath, and the footer without `↵ run`. | The reason is honest and visible. It uses the R3 blocked-row grammar exactly. |
| Reset in browse | The test asserts the row is absent from empty-query browse and Recent while inactive. The unit test asserts it appears in browse and Recent when active and leaves again live, with no need to reopen the palette. `palette-browse` is pixel-identical to R3. | Matches the R3 recovery rule. No fold regression. |
| Screenshot (`03-*`) | The downloaded PNG decodes to a real 832×791 scene: house, roof and cube, more than 16 colours. The app shows the localized "Screenshot saved" toast. | The direct action actually dispatches. The "not ready" refusal is unit-only, with no capture. |
| Presentation (`04-*`) | The Presentation panel shows "1 in collection · 1 view". The Basket 1 card is Active, "1 object", with a JPG thumbnail. After Play, the ViewCube is TOP/FRONT, the scale is 3.5 m, the chip reads "Isolated elements · 1", the status reads "Present 1/1", and "14 hidden". | Real flow and camera restore. The thumbnail is a thin, edge-on wall sliver: truthful, but a weak witness of legibility. This is an evidence note, not a defect. |
| Plan refusal (`05-*`) | At 800 px with the Wall defaults panel open, `plan layout` returns "Show the plan". It is blocked with the lock and the reason "No room for the plan beside 3D: widen the window or close a side panel", the footer has no `↵ run`, and the label and reason fit on one line. Afterwards the 390 px loaded 3D view survives, with the Model HUD hint. | It refuses with a remedy, which is better than a silent no-op. |
| Federation (`01-actual-state`) | "Federation setup saved." and the follow-on "Loaded a setup with 1 model slots — now pick the source files to match." | Real pickers, reaching cancellable review. "1 model slots" is an inherited plural string (`750b331`, before the accepted UX base). |

## Rubric judgment (observed UX only)

| Axis | Rating | Specific evidence |
| --- | --- | --- |
| 1 Inventory completeness | **Not judged** | No image or count can prove it. It stays with the inventory and Astra closure. |
| 2 Functioning destination | **Good** | Reset changes renderer input and keeps the selection and collection state equal before and after (`toEqual(before)`). Screenshot decodes a real non-blank PNG. Presentation captures and plays back to the saved matrix. Plan refuses at constrained widths and preserves 3D. The R3 destinations are pixel-identical: Privacy focus, narrow Display, Qty, the wall tool with HUD and defaults, the camera corner (`.png == .actual.png`), and the hidden-wall chip, "1 hidden" and struck-through row. Extension retirement and the QuickJS raster frames are byte-identical. |
| 3 Task-language search | **Adequate, slightly improved** | `reset visibility filters` finds one precise row. `plan layout` finds Show the plan. `undo`, `privacy`, `annot` and `wall` are unchanged from R3. The gaps are listed under P2 below. |
| 4 Context truth | **Good** | The Reset row moves from enabled to blocked live after running. Its reason names the actual state. Footer `↵ run` follows eligibility in all six new or changed frames. The unloaded, loaded, selected and post-hide contexts are identical to R3. |
| 5 Keyboard and grouping | **Good** | The selected-row label column is aligned in every R4 frame: the Reset row's icon x≈485 and label x≈505 match every other row. `23-scrolled-active-row`, Tab, arrow and Escape cases, and recents are byte- or pixel-identical to R3 and pass. Visibility is the right group for Reset. |
| 6 UX preservation | **Pass** | Frame, header, footer, empty and short states, 390 px margins and light/dark parity are identical. The R3 browse fold residual is unchanged and not worsened. |

## Prior R3 fixes: still present

- The B1 selected-row alignment, with the selected-only `before:` stripe, holds in every frame, including both R4 Reset frames.
- B2 recovery stays out of browse while inactive. This is now the shared `ACTIVE_ONLY_BROWSE_IDS`, and `palette-browse` is byte-equal in content
  to R3. The absent and replaced reasons are unchanged.
- The short Filter hint "Advanced search → Filter · rules and groups" fits on one line in all four hide contexts. The narrow wrap with
  `sm:truncate` is unchanged.

## Non-blocking nits (preserve-first; none is a veto)

- **P2: alias bridge to the visible chip.** The viewport chip and the empty-view notice both run the identical
  `resetVisibilityReasons`, labelled "Reset everything" (`00-uninstalled-owner`, `02-reset-preservation-command`).
  A user who learned that label searches `reset everything`. `score()` matches the whole query, so that phrase is not in the Reset row's
  aliases and only reaches it through the weak subsequence tier. Similarly, `unhide` hits Show all's keyword
  (`unhide reset visible`) but not Reset, so the destructive option is the one that surfaces. Add `reset everything`, `unhide` and
  `show hidden` to `commandPalette.vis.resetFilters.aliases` in en, de and ru. The palette's name is the more truthful one, so keep it.
- **P2: scope disclosure.** `resetPolicy: 'cleared'` also covers the section cut and measurement visibility. So with
  only a visible measurement, the row is enabled and running it hides the measurements. This is the canonical semantics, but
  "visibility filters" understates it. An optional live detail such as "Clears: Hidden, Isolation · keeps selection and collection"
  would show the scope without new UI.
- **P3: kept preferences.** With only class toggles active (for example Spaces Off, `typeVisibility`, kept), the
  row says "No visibility filters to reset" while some geometry stays hidden. This is defensible under the #5869 table. If users
  report confusion, a remedy hint pointing to the class toggles would help.
- **Carried from R3, unchanged:** the browse fold shows only the File block and "View/Home". Share is a configuration-dead row in the first fold.
  The Refresh reason reads as an instruction. `hide` and `wall` ranking. Show all has no hidden-count state. Unloaded repetition.
  Mixed hint separators. Two "Filter" rows.
- **Inherited, not palette (record only):** in `05-actual-state` (390 px, Model workspace), the mobile Hierarchy launcher covers the
  left half of the active-storey HUD chip ("o… ±0.00 m"). No palette file in this range touches either component.
  "1 model slots" is pluralized wrongly in `federationSetupControls.pickSources`. The narrow Settings focused-tab top ring
  is still clipped.

## Evidence notes (not product defects)

- The isolate-then-hide setup in `02` leaves the viewport completely empty, and the palette sits over the
  top-centre empty-view notice. A capture with the palette closed before Reset would show the notice and its matching "Reset
  everything". This is optional, for a future witness only.
- `04-presentation-thumbnail.jpg` is valid but nearly blank to the eye, because the wall is seen edge-on at front-top. A three-quarter preset
  would make a better witness. The test's matrix assertion is the real oracle.
- Linux headless shows no scrollbars. Parity with the Windows baseline is an environment difference, as in R3.

## Must stay

Keep everything in R3's "Must stay" list. In addition, keep these R4 items:

- the separate palette-only Reset row with the "Keep selection and collection" detail;
- its canonical `resetVisibilityReasons` dispatch, distinct from `showAllFromStore`;
- the live `noVisibilityFilters` reason, with the row searchable while inactive and out of browse and Recent;
- the localized Screenshot toasts and the "not ready" refusal;
- the Plan refusal reason, which names its remedy.

## Separation of claims

- **Accepted:** the observed R4 palette UX on `98d3`, rubric axes 2 to 6, within the 36 captures and 27 browser cases inspected.
- **Pending or unproven:** inventory completeness (rubric 1); the full four-shard and focused suites, which are RUNNING and not passes;
  the new mounted child-access tests and all-feature gates, which have no executed receipt here; the seven historically-passed workflow
  tests, which are not re-witnessed by me; locale, federated (N > 1) and read-only visual captures; and unvisited children below folds.
  There is no production-readiness claim, no complete-access claim and no numeric score.
- Cleanup: I removed only my own session-scratchpad crops, the pixel-diff helper and the hash list (87,870 bytes).
  No evidence images, source, active jobs or locks were touched.

PR https://github.com/LTplus-AG/ifc-lite/pull/9024, head 98d3ec5fb866e6098e05b7806469447e7223d01f, checks and reviews pending; R4 observed UX ACCEPT.
