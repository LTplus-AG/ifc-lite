# #8946 command palette — independent visual review, round 3 (Opus)

- **Scope:** UX taste/acceptance for #8946 only. Not implementation review, not #8947 coverage.
- **Mode:** read-only. No builds, browser runs, tests, subagents, commits, pushes or source edits.
- **Source:** HEAD `9d476f01e7b2bfc1e69799d39a1b0289d6a6e2d3`, tree `63f8396b08b2271c02364336e14f8f8acd0b41a4`. Verified with `git rev-parse`. The only working-tree change is the coordinator's uncommitted `tests/ui-scenes/command-palette/README.md` docs edit, which I left alone.
- **Issue #8946:** OPEN, assigned to `louistrue` (the authenticated `gh` user), labeled `claimed` and `claimed:session-t3-fd0b1714`.
- **Fleet:** I read the policy. `ifc-fleet status` reported pop-os reachable. I submitted no jobs.
- **Rubric:** the frozen seven axes in the README: discoverability, relevance, keyboard/pointer predictability, focus/announcement, hierarchy, responsive light/dark, recovery.
- **Round-3 source delta:** I read it.
  - The listbox gets `scrollbar-thin`, the existing utility with `.dark` and `.colorful` rules in `index.css`.
  - The option label and category become an `sm:` flex row, with the category muted, right-aligned and capped at 28%.
  - Below `sm`, the two-line layout is unchanged.
  - Ranking, dispatch and strings are unchanged.
- **Receipts:**
  - `round3-build-provenance.json`: run 42127421737, viewer artifact 13462775595, tested-tree artifact 13461248722, matching head and tree.
  - `round3-browser-result.json`: exit 0, 11 expected, 0 skipped, 0 unexpected, 0 flaky, GPU runner, not a benchmark.
  - `round3-matrix/manifest.json`: 12 scenes, NVIDIA adapter, `failures: []`, `pageErrors: []` for every scene.
  - `round3-locale.json`: the T3 browser had no GPU and the run was unloaded, which the file states honestly. It records 36px rows, `scrollbarWidth: thin`, a dark scrollbar colour, and combobox focus.
- **Images I opened and looked at:**
  - All 12 images in `round3-matrix/` plus `palette-russian-desktop.dark.png`.
  - All 16 images in `round3-browser-captures/`.
  - `round2-matrix/command-palette.dark.png`, for comparison.
- **Labels:** [taste] is visual judgement. [behavior] is backed by an executed receipt. [source] is a read-only code observation.

## Verdict: ACCEPT (UX, #8946)

- The one blocking defect from round 2 is fixed. Round 2 showed a bright native scrollbar in dark mode.
- The recommended density change landed without losing category context or narrow two-line labels.
- I found no regressions or vetoes in the evidence.
- This verdict covers taste and UX only. It does **not** cover:
  - production readiness;
  - the final full CI run, which is still pending and not counted here;
  - merge readiness of draft PR 8950;
  - #8947 coverage, toggles or prerequisite truthfulness. Those stay separately chartered and unchanged by this round.

## Round-2 findings, rechecked

1. **Dark scrollbar (was blocking): FIXED.**
   - [taste] `round3-matrix/palette-browse.dark.png`, `command-palette.dark.png`, `round3-browser-captures/04-browse`, `08-browse` and `12-browse` show a thin, low-contrast dark thumb on a dark track.
   - In `04-browse`, the page's own scrollbar beside the palette now matches. Round 2's `command-palette.dark.png` showed a wide light-grey native bar.
   - In light mode the thin thumb is a soft grey (`palette-browse.light`, `02`, `10`, `14`).
   - The scroll affordance stays visible in both themes.
   - [behavior] `round3-locale.json` records `rgb(48,49,53)` on `rgb(24,25,27)`, thin.
2. **Search row density (was recommended): DONE.**
   - [taste] `command-palette.{light,dark}` ("wall") show 11 full rows plus a partial one, up from 8 in round 2. That matches the baseline's row count.
   - Each row is single-line: label on the left, then muted "Tools", "Panels" or "Automation", then the shortcut chip.
   - Search rows are now the same height as browse rows, so the list no longer changes rhythm between browse and search.
   - "Annotate · Tools" and "Annotations · Visibility" stay distinguishable (`palette-annot.*`).
   - In Russian, "Сечение · Инструменты · X" and the long labels fit on one line without truncation (`palette-russian-desktop.dark`).
   - [taste] At 390px, the `palette-narrow.{light,dark}` images keep the two-line label and category layout as intended.

## Rubric

| Axis | Rating | Evidence |
| --- | --- | --- |
| Discoverability | Good | [taste] The Recent group is now visible (`15-recent-settings-selected`): a "Recent" header with "Settings…" first and selected, above File and View. This closes round 2's "Recent not judged visually" gap. Grouped browse with sentence-case headers and shortcut chips is unchanged. |
| Relevance | Good | [taste] "annot" returns exactly 2 rows. "wall" shows direct hits first, then keyword hits. Russian "section" puts Сечение first. [source] Ranking is untouched this round. Carried minor: keyword-only hits show no reason they matched. |
| Keyboard/pointer predictability | Excellent | [behavior] 11/11 passed, covering native Tab/Shift+Tab containment, arrow scroll without focus loss, Escape/reopen reset, and Enter reaching real Settings (loaded IFC). [taste] The input stays top-anchored at y≈96–123 across browse, search, empty and Russian. `14-scrolled-active-row` shows the last row (Open Learn Hub) scrolled into view, with the thumb at the bottom and the footer intact. |
| Focus/announcement | Good | [taste] The stripe plus fill marks the active row in both themes. It still reads in light mode against the new single-line rows (`command-palette.light`, `00`, `15`). [behavior] Combobox focus is retained (`round3-locale.json`). This is not a screen-reader audit. |
| Hierarchy | Good, improved | [taste] The label stays dominant, the category is muted secondary text, and the kbd chip comes last. The dialog stays the focal point over the scrim. See minor note 1 on the ragged right column. |
| Responsive light/dark | **Good** (was Weak) | [taste] Light and dark match in layout. The dark theme is now coherent end to end, with no bright native chrome left. Narrow keeps 16px gutters and two-line rows. The short 800×400 viewport fits browse and empty states (`10`–`13`, `palette-short.*`). |
| Recovery | Good | [taste] Empty state shows "No results / Try a different name or keyword" with a real Clear search button, and the footer drops to "Esc close" (`03`, `05`, `07`, `09`, `11`, `13`, `palette-empty.*`, `palette-short.*`). In `01`, the first-visit privacy toast sits under the scrim and the dialog stays intact. [behavior] The privacy notice test passed. |

**Vetoes:** none observed.

- [behavior] Canonical Settings activation passed on the loaded bundled IFC.
- [behavior] The manifest and browser report show zero page errors and zero failures.
- [source] This round adds no new UI strings, so no new untranslated UI.
- File-picker user activation was not re-exercised this round. It is not claimed, and the change cannot affect it, since it is CSS only.

## Must stay

- The `scrollbar-thin` theme utility on the listbox. Do not regress to a plain `overflow-y-auto`.
- Single-line desktop rows with a muted category on the right, at the same height as browse rows.
- The two-line layout below `sm`.
- Everything on round 2's must-stay list:
  - the top-anchored input;
  - 16px narrow gutters;
  - suppressing fuzzy matches when direct hits exist, with typo fallback;
  - the semantic selection stripe;
  - the palette z-layer above toasts;
  - the empty-state Clear search button and trimmed footer;
  - the kbd-chip footer;
  - the X close button;
  - opening on the most recent command;
  - the Recent group;
  - the dark scrim.

## Next fixes

**Blocking:** none.

**Optional and non-blocking.** Do these in a later round only if one is spare; do not reopen #8946 for them:

1. **Ragged category column.**
   - [taste] The category is right-aligned immediately before a chip of variable width, so its x-position shifts with the shortcut.
   - In `command-palette.*`, "Tools" sits at about x893 next to `W` and at about x854 next to `Shift+…`. "Panels" and "Automation" sit flush right with no chip.
   - In `palette-annot.*`, "Tools" and "Visibility" end at different x-positions.
   - It is readable, but an expert-density list would scan more cleanly with a fixed-width shortcut slot, or with the category in its own aligned column.
2. The thin scrollbar still shows tiny themed arrow glyphs at the track ends in Chromium. They are consistent with the app's other `scrollbar-thin` areas (the page scrollbar in `04` shows the same). Leave them as they are.
3. Items carried from round 2, all minor:
   - keyword-only hits have no match hint;
   - Annotate and Annotations use inconsistent icons;
   - keyboard footer hints appear at touch width;
   - Tour titles stay in English under ru (existing runtime content).

## Separate (#8947, not counted here)

These are unchanged from round 2:

- Frame Selection is offered with no selection.
- Save Federation Setup and Model Tags are offered unloaded.
- Open File is the default action while upload is disabled without WebGPU (`02`, `15`).
- Grid and Annotations toggles show no on/off state.

Coverage can proceed from this accepted UX candidate as its baseline.

## Cleanup

- I created no artifacts, jobs, builds, workspaces or tabs. Bytes reclaimed: 0.
- I sampled pixels with ffmpeg to stdout only. Nothing was written, and I did not rely on those samples.
- All source, fixtures, foreign jobs and existing evidence are untouched.
- The only file written is this review.
