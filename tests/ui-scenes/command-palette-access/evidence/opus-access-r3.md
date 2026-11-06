# #8947 access hillclimb: Round 3 visual and context taste review (fresh Opus)

**Verdict for the observed UX on 15bd: ACCEPT.** Both R2 blockers are fixed, and I found no new
accepted-UX regression in the 36 captures or the browser evidence I checked.
This accepts the observed palette UX only. Complete feature access (rubric 1), the full four-shard suite, the
integrated `6f40` candidate and production readiness remain **unaccepted and unclaimed**.
This review is separate from the general-UX hillclimb (#8946, R3 accepted, merged as #8950). Its rubric is not blended in here.

## Scope and identity

- Reviewer: fresh Opus (`claude-opus-5-5`), read-only. I ran no builds, tests or browser sessions, and made no commits, pushes or watches.
- Preconditions: `gh api user` returns `louistrue`. #8947 is OPEN, assigned to `louistrue`, labelled
  `claimed` and `claimed:session-t3-fd0b1714`, with a claim comment naming session t3-fd0b1714 (2026-11-05T21:23Z).
- Pinned visual source: `15bd4920d2410c102138c830bdd220799a4174b3`, tree `08cdd27c…cecce43a`. I confirmed both with `git log`.
  `qualification.json`, the three manifests (`label`) and `run-summary.json` agree. The dist index is `79f0f57e…890d36f`.
- Hashes, all re-hashed by me: **36/36** manifest PNGs match `qualification.captures.verified`. **72/72** attachments
  match. The gunzipped `run-manifest.json.gz` equals `originalManifestSha256` `a9ec63a0…`. Every manifest has `failures: []`.
  Every `browser/*pageerrors.json` and `00-command-errors.json` is `[]`.
- Runtime: Pop `chrome-headless-shell` 156 with Vulkan ANGLE. Adapter: NVIDIA Lovelace, `fallback:false`,
  surface `visible-canvas`, readback pixel `[0,255,0,255]`. Browser: **22/22 expected, 0 skip**. Of 4 commands, 4 completed and none were skipped.
  Focused run: **401/401** (`palette-access-15bd-focused-result`). The full 4 shards are still **running and are not counted**.
- Integration `15bd → 6f40`: 159 paths. The only overlap with the branch's own files (merge-base → 15bd) is `README.md`.
  No palette component, search, catalogue or recovery source changed. The three new `CommandPalette.workflow-*.test.tsx`
  files and the de/ru catalogue churn from main are **not tested by 15bd** and have no captures. These findings are attributed to 15bd only.
- I opened every one of the 36 manifest images directly. I also opened browser `00-disabled-owner`, `00-uninstalled-owner`,
  `00-reenabled-activation-{hidden,shown}-gpu` (with both verdict JSONs), `04-actual-state`, `05-actual-state`,
  `05-narrow-dark-colorful-palette`, `07-selected-entity-actions`, `18-scrolled-active-row`, `19-recent-settings-selected` and
  `21-unacknowledged-notice-palette`.

## R2 blockers: status on 15bd

| R2 blocker | Status | Scenario evidence |
| --- | --- | --- |
| **B1**: the selected row sat 12 px further left than the other rows | **Fixed** | `command-palette-option.tsx` now emits the `before:bg-*` colour only when `selected &&`, so unselected rows no longer get an in-flow `::before`. In the captures, the selected row's icon and label sit in the same column as every other row: `wall` (Draw walls vs Place curtain walls…), `palette-browse` (Open File), `annot` at 1440 and 390 (Annotate vs Annotations/Filter), the four hide contexts, `undo`, `privacy`, `18-scrolled-active-row` and `19` recents. This holds in both themes. A new e2e oracle (`assertStableLabels`) checks that the selected and next label `x` differ by less than 0.5 px, that ArrowDown and ArrowUp never shift a label, and that `hide` labels fit at 390 px or below. It is inside the passing 22. |
| **B2**: inactive recovery rows crowd default browse, with untrue reasons | **Fixed** | `palette-browse`: Cancel model load, Retry failed load and Dismiss load error are gone from File. `19-recent-settings-selected` (no-WebGPU) shows none of them either, and they are filtered out of Recent before the slice. Search stays complete: the unit test checks that each is searchable and `aria-disabled`, and that a live recovery row returns to browse and Recent. The reasons are now honest: an absent error gives "No load error to recover from", and a superseded error gives the separate "The load error changed; choose the current recovery action". The de and ru translations are updated. |
| R2 P2: Filter hint was keyword soup | **Fixed** | "Advanced search → Filter · rules and groups" fits on one line in all four hide contexts. The full alias list still drives search through `keywordsKey`. |
| R2 P3: narrow label truncation risk | **Addressed, not shown in a screenshot** | Labels use `break-words sm:truncate`, and the 390 px oracle asserts that `hide` results fit. No 390 px capture shows a long wrapped label. |

## Rubric judgment (observed UX only)

| Axis | Rating | Basis |
| --- | --- | --- |
| 1 Inventory completeness | **Unverifiable** | No screenshot or count can prove inventory completeness. |
| 2 Functioning destination | **Good** (6 flows plus the browser cases) | The Privacy tab is focused with analytics opt-out, guide and action log. Narrow Display is focused. Qty is active with empty-selection guidance. Hiding works: wall 262 is gone, with the chip, "1 hidden" and the struck-through hierarchy row (`rendererHidden:true`). Blank leads to Untitled Project / Level 1 with the Wall tool, Defaults · Wall and a viewport hint. **The camera manifest now preserves the actual corner**: `.png` is identical to `.actual.png`, the scale bar reads 2.8 m, the ViewCube is corner-on, and the forward axis is (-0.577, -0.577, -0.577). Extension: the disabled toggle and the uninstalled empty state are retired truthfully. Re-enabled QuickJS hide and show is a strict raster witness (`noise 0`, change 83606 for both, `restoredDifference 0`, `remainingWall 0`). |
| 3 Task-language search | **Adequate** | `undo`, `privacy` and `annot` are clear. `hide` is readable now. Residual ranking issues are listed below. |
| 4 Context truth | **Good** | Unloaded, loaded, selected and post-hide transitions are truthful, and On/Off states are live. B2's false reason is gone. The footer drops `↵ run` on blocked highlights (unloaded-hide, selected-hide-run, undo) and keeps it on enabled ones (selected-hide, wall, privacy). |
| 5 Keyboard and grouping | **Good** | Selection is stable and backed by an oracle. Blocked rows are distinct (muted label, lock and reason, muted stripe), and Tab, arrow scroll and Escape all passed. |
| 6 UX preservation | **Pass, with one residual noted** | The frame, header, footer, empty state, 800×400 short state, 390 margins and light/dark parity match the accepted UX. The browse fold still shows only the "View" header and a clipped "Home H" at y≈568. The accepted fold showed Home, Fit All, Frame Selection and three Level rows. The cause is the access-added File rows (New blank model, Refresh, Share, Add model), not the removed recovery rows. I judge this P2, not a veto, because the frozen rubric requires disabled rows to stay discoverable. |

## Residual defects (non-blocking, preserve-first)

- **P2: dead row in default browse.** "Share: Unavailable in this configuration" cannot become available in this
  deployment, yet it sits in the first fold. Apply the same rule used for recovery: leave configuration-unavailable rows out of browse and
  keep them searchable. Alternatively, sort blocked rows after enabled rows within a group, so Add model comes before New blank, Refresh and Share
  and more of View shows. Either option leaves accepted behaviour unchanged.
- **P2: Refresh reason reads as an instruction.** "Reopen every model with a live file handle to refresh" reads as an action. Use a
  prerequisite instead: "Needs a model opened from a local file".
- **P2 (carried from R2): ranking.** `hide` still ranks the alias-only Tools "Filter" above Isolate, Show all and the toggles. `wall`
  ranks the blocked, alias-only "New blank model" third, above enabled tools. Its reason is still long.
- **P2 (carried): Show all has no hidden state** after Hide. The chip and status bar say "1 hidden", but the row does not.
- **P2 (carried): unloaded repetition.** "Load a model first" appears on every visible row except Filter.
- **P2 (carried): two "Filter" rows.** For `annot`, the third row is a Visibility "Filter" with no hint explaining the match.
- **P3:** hint separators are mixed (`→ ,` in Privacy, `→ ·` in Filter, `→ /` in Learn Hub). Selection prerequisites use two wordings
  ("Select elements in the viewer first" and "Select an IFC entity first"). Cancel, which is now reachable only by search, still says
  "No matching load is still running"; "No model is loading" would be plainer.
- **Inherited, not palette (record only):** the dark Qty tab differs from inactive tabs only by text brightness. In the narrow Settings
  tab grid, the top ring of the focused Display tab is clipped.

## Evidence notes (not product defects)

- Linux headless draws no scrollbars. The accepted baseline was Windows Chrome. Scrollbar parity is an **environment difference**, so I
  do not claim parity with Windows and record no regression.
- `modelVisibleFraction` is 0 in palette captures where the model is visible, so it is not a visibility oracle. Hide and show rely on
  `rendererHidden` and the strict raster verdicts.
- `18`, `19` and `21` are the #8946 no-WebGPU cases ("No WebGPU" in the status bar). They witness the palette, not the GPU.

## Must stay

Keep the label line with the reason underneath, the lock glyph, the muted label and stripe on blocked rows, and the footer dropping `↵ run` on blocked rows.
Keep the selected-only stripe colour and the label-alignment oracle. Keep recovery hidden from browse only while inactive, and keep it searchable.
Keep the separate absent and replaced reasons, the short localized Filter hint, and the narrow wrap with `sm:truncate` above 640 px.
Keep the readable child paths (Privacy, About, Script Editor, Assistant), Undo with Ctrl+Z, and live On/Off.
Keep the real destinations: Privacy focus, narrow Display, Qty, wall tool with its HUD and defaults, the actual camera corner, the hidden-wall chip, status and hierarchy, and extension retirement.
Keep the empty and short states and light/dark parity.

## Separation of claims

- **Accepted:** the observed R3 palette UX on `15bd`, rubrics 2 through 6, within the scenarios captured.
- **Unproven or pending:** inventory completeness (rubric 1), the full 4-shard suite on 15bd, matching validation and captures for the
  integrated `6f40`, the three new workflow tests, and unvisited child controls (Privacy export, clear and overlay below the
  fold; About/MCP; Filter children; Redo with history). Locales, federated contexts and read-only contexts are not visually captured.
- No production-readiness claim, no claim of complete access coverage, and no numeric score.

PR https://github.com/LTplus-AG/ifc-lite/pull/9005, head pinned/reviewed `15bd4920d2410c102138c830bdd220799a4174b3` (remote head is still 15bd; local is `6f40f20450`), checks: draft and stacked on `feat/command-palette-access-runtime-repairs`. `PR review signal` FAILS: stacked, so the required lanes are absent, and CodeRabbit skipped the draft. Issue queue, risk label and parity pass. The merge queue and the AI reviewers are skipping. Reviews: none submitted, 0 open threads, 1 comment.
