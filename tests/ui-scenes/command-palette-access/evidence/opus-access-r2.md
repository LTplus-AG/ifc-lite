# #8947 access hillclimb: Round 2 visual and context taste review (fresh Opus)

**Verdict for the observed UX: REVISE.** There are two confirmed visual blockers. Both have small, local fixes.
Complete feature access is still **unaccepted**: coverage, full tests and production readiness are pending.
This review does not certify any of them.

## Scope and identity

- Reviewer: fresh Opus (claude-opus-5-5), as the design sub-agent. This review is separate from the accepted general-UX R3 (#8946).
- Preconditions: `gh api user` returns `louistrue`. #8947 is OPEN and assigned to `louistrue`. Shared worktree
  `t3-fd0b1714`, HEAD `c068c38ebc`, working tree clean.
- Visual source: **`f8ca13ee1d12f886a0c0179a877fe4470fba7f26`**, tree `df0a2761…`, dist index
  `7674cba7…49936`. All three run files and `qualification.json` agree. The 36 manifest PNGs (12 contexts,
  12 matrix, 12 flows, each light and dark) all match their manifest sha256 when I re-hash them. Every
  manifest has `failures: []`, every capture has zero page errors, and the adapter is NVIDIA lovelace with
  `fallback:false`.
- `git diff f8ca13ee1d c068c38ebc` touches only test files, an E2E spec and renderer helper, the README and
  inventory files. **The application source is identical**, so every source-attributed finding below
  also applies to `c068`. I make no claim that the images were captured on `c068`.
- Frozen charter and rubric: `tests/ui-scenes/command-palette-access/README.md`. The R1 objections are in
  `palette-access-opus-round1-provisional-fd0b1714.md`. The accepted UX baseline is
  `tests/ui-scenes/command-palette/evidence/candidate-*` (`9d476f01`) plus `access/evidence/baseline-*`.
- I inspected every image directly. I also opened the 12 extra `flows/*.actual.png` files, which are not in
  the manifest but are named by `flow-observations.json`. Four pairs are byte-identical to the manifest
  images and the other eight differ. Where it helped, I compared pixel crops against the accepted baseline
  with ffmpeg. I did no builds, tests, browser runs or edits.

## R1 objections: status on f8

| R1 objection | Status | Evidence |
| --- | --- | --- |
| P1: the reason clips the label ("Hid…", invisible "Undo") | **Fixed, Excellent** | "Hide Selection" is full in all 8 hide captures. "Undo" title + Ctrl+Z + "No workspace edits to undo". The reason sits on its own second line with a lock glyph. |
| P1: blocked rows look runnable, and `↵ run` is shown on them | **Fixed, Good** | Blocked labels are visibly muted in both themes (grey vs black/white). The selection stripe is muted. The footer drops `↵ run` when the highlight is on a blocked row and restores it on enabled rows (selected-hide, privacy). |
| P2: repeated "Load a model first" | Open, Weak | Unloaded-hide still shows the lock and reason on 7 of the 7 visible rows. Each blocked row now takes two lines, so the viewport holds only about 7 rows. |
| P2: Filter ranks 2nd for `hide` on keyword aliases | Open, **worse to read** | The hint is now shown in full over two lines: "Advanced search → Filter → rules groups properties operators select isolate hide results". This is keyword soup, not a path. Isolate is now present at row 3, which is an improvement. |
| P2: Show all carries no hidden state after Hide | Open, Weak | Selected-hide-run shows the "Hidden elements · 1" chip and "1 hidden" in the status bar, but the Show all row is unchanged. There is still no Unhide or Show-hidden row. |
| P3: Undo parenthetical | **Fixed, Excellent** | "No workspace edits to undo". |
| P3: Privacy separator and truncated hints | **Fixed, Excellent** | "Settings → Privacy → analytics consent, local action log export and clear, personal prompt overlay", wrapped and readable. |

## Confirmed visual blockers (REVISE)

### B1: the selected row shifts 12 px left, so rows no longer align (accepted-UX regression)
- **Scenario:** any palette list on f8. Examples: `matrix/command-palette.*` (`wall`), all six hide
  contexts, `palette-annot.*`, the 390 px `palette-narrow.*`, `access-history.*` and the privacy capture.
  The highlighted row's icon starts at about x=485 (label at 505). **Every other row starts at about
  x=497 (label at 517).** In the accepted `candidate-desktop-light.png` (`wall`), every row's icon starts at 485.
  The same 12 px offset appears at 390 px (Annotate at 37 vs Annotations/Filter at 49). Each arrow-key press
  therefore makes the newly selected row jump left 12 px. The column of icons and labels is ragged.
- **Cause (source-attributed, Tailwind 4.3):** `command-palette-option.tsx` now applies
  `before:bg-muted-foreground` or `before:bg-primary` to **every** row, through the `disabled ? … : …`
  class branch. In Tailwind v4, any `before:` utility emits `content: var(--tw-content)`, so non-selected
  rows get an in-flow, zero-width `::before` flex item. Only selected rows also get `before:absolute`.
  With `gap-3`, that adds exactly 12 px before the icon. The accepted source put the `before:bg-primary` class only
  inside the selected branch.
- **Minimal fix:** move the stripe colour into the selected branch, for example
  `selected ? cn('bg-accent before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:rounded-full', disabled ? 'before:bg-muted-foreground' : 'before:bg-primary') : 'hover:bg-accent/50'`,
  and keep `disabled ? 'text-muted-foreground cursor-not-allowed' : 'text-foreground'` separate. Add one
  browser oracle: the label-rectangle `left` is equal for the selected row and the next row, at 1440 and at 390.
- Rubric 5 (stable selection) and rubric 6 (UX preservation). This is a veto-class accepted-UX regression,
  even though the fix is one line.

### B2: default browse opens on dead recovery rows with untrue reasons
- **Scenario:** `matrix/palette-browse.light/dark`: loaded model, empty query, no load ever running and no
  load error. The File group now shows New blank model ("Start blank requires an empty session; close the
  current model first"), **Cancel model load** ("No matching load is still running"), **Retry failed load**
  and **Dismiss load error**. Both of the last two say "This load error has ended or been replaced". The first fold is five blocked rows
  under four enabled ones. The accepted browse showed File and then View (Home H, Fit All Z, Frame
  Selection F…) in the first fold. Now View is pushed out of sight. "This load error has ended or been replaced" implies that an
  error happened. Here none did, so the reason is not true to context (rubric 4) and the browse fold
  regresses (rubric 6).
- **Minimal fix:** in **browse mode only**, either leave out transient recovery rows (cancel, retry, dismiss)
  when no load or error exists, or sort disabled rows after the enabled rows inside each group. Keep them
  findable by query (rubric 5 discoverability), with never-occurred wording such as "No model is loading" and
  "No load error to retry". Keep the current "ended or been replaced" wording for the real stale-error case.

## Rubric judgment (observed UX only)

| Axis | Rating | Basis |
| --- | --- | --- |
| 1 Inventory completeness | **Unverifiable** | 48 executed-route bindings (I confirmed 48 lines) and 813 identities (813 lines) are accounting, not proof. Six flows cannot judge completeness. |
| 2 Functioning destination | **Good** (for the 6 flows observed) | Privacy: real Settings, Privacy tab focused, analytics opt-out, privacy guide and action log visible. Narrow Display: real tab focused. Measurements: Qty tab active with its empty-selection guidance. Hide: wall 262 visibly gone, with the chip, "1 hidden" and the struck-through hierarchy row. Blank wall: real Wall tool with Thickness/Height, Defaults · Wall, Level 1 and an in-viewport hint. Camera corner: `.actual` shows a re-oriented ViewCube and the scale bar going from 1.8 m to 2.8 m. |
| 3 Task-language search | **Weak** | `undo` and `privacy` are Excellent. `hide`: keyword-soup hint, and Filter ranks above the direct visibility actions. `annot`: a third row labelled just "Filter" (Visibility, funnel icon) gives no reason for the match and has the same label as the Advanced-search "Filter" (Tools). `wall`: a blocked, alias-only "New blank model" ranks 3rd, above enabled tools. |
| 4 Context truth | **Good, with defects** | The unloaded → loaded → selected → post-hide transitions are truthful, and the On/Off states are useful. Defects: B2's untrue reason, Show all without a hidden count, and two wordings for one prerequisite ("Select elements in the viewer first" vs "Select an IFC entity first"). |
| 5 Keyboard and grouping | **Weak until B1** | Labels are now readable and blocked rows are distinct (both Excellent fixes), but the 12 px selection jump breaks stable selection. |
| 6 UX preservation | **Fail until B1 and B2** | The frame, header, footer, empty state, 800×400 short state, narrow margins and light/dark parity are preserved. Row alignment and the browse fold regressed. The scrollbar is **unverifiable**: see the evidence notes. |

## Non-blocking objections (preserve-first, minimal)

- **P2: Filter hint word salad.** Separate the path from the aliases. Show "Advanced search → Filter" (or name
  the child controls: "rules, groups, results") and move the keyword list to the hidden search terms. Rank a
  direct label or prefix match (Hide Selection, Isolate, Show all, the toggles) above alias-only rows.
- **P2: two rows labelled "Filter".** Rename the class-visibility destination to "Class filter" or "Filter by class" and give it a
  short child hint, so its `annot` match makes sense. The exact `annot` membership and order oracle can stay as it is.
- **P2: tie-break blocked rows after enabled rows** within the same match tier. For example, `wall` would then
  put Make rooms and the other tools ahead of the blocked New blank model. Shorten that reason to "Close the current model first".
- **P2: unloaded repetition.** When three or more visible rows share one reason, show it once under the input
  ("No model loaded: blocked commands need a model"). Keep each row's lock and muted label, and keep the
  per-row reason in `aria-describedby`.
- **P2: Show all state.** Add a hidden-count state ("1 hidden") after Hide, as the class toggles already do with On/Off.
- **P3:** use one separator style for hints (`→` path, then `·` children; currently `→`, `,` and `·` are mixed).
  Unify the selection-prerequisite copy.
- **P3, source risk, not observed:** narrow rows no longer drop the category onto a second line. The new
  layout keeps the label `flex-1 truncate` next to meta up to `max-w-[55%]`. The captured `annot` labels are
  short and fit, but a long label at 390 px (for example "Toggle Collection Visibility" with Visibility/On)
  could truncate again. Add a 390 px `hide` capture before you call the narrow layout preserved.
- **Inherited, not palette regressions (record only):** in the dark theme the active Measurements "Qty" tab
  differs from inactive tabs only by text brightness (light has a blue fill). The narrow Settings tab grid is
  scrolled about 12 px, so the focused Display tab's top ring is clipped. "Privacy" is both a tab and a
  section heading. I found no change to these in this branch's diff of `MeasurementsPanel.tsx`.

## Evidence notes (not defects in the product)

- **Scrollbar parity cannot be judged from these captures.** The accepted baseline was captured with
  Windows Chrome through `/mnt/c` (classic scrollbar with arrow buttons). R2 used Linux
  `chrome-headless-shell` on Pop, where scrollbars are not drawn. The list container (`scrollbar-thin`) and
  `index.css` are unchanged since `9d476f01`. I record no regression, but rubric 6 needs a same-environment
  capture to confirm the accepted R3 themed scrollbar.
- The manifest image `flow-camera-corner.*.png` looks the same as the Home framing. The `.actual.png` (scale
  2.8 m, ViewCube corner-on) is the real witness. Reference the `.actual` file, or capture after the camera settles.
- `modelVisibleFraction` is 0 in captures where the model is plainly visible, so it is not a visibility oracle.
  The hide witness here is visual plus `rendererHidden:true`, not a numeric proof.

## Preserve list

Keep the label on its own line with the reason underneath, the lock glyph, the muted blocked label and stripe, and the
footer dropping `↵ run` on blocked rows. Keep the readable child-path hints (Privacy, About, Script Editor, Assistant),
the Undo/Ctrl+Z row, live On/Off state, Isolate appearing for `hide`, and the real destinations (Privacy tab focus, narrow
Display, Qty tab, wall tool HUD and defaults). Keep the hidden-wall chip, status and hierarchy feedback, the empty and
short states, and light/dark parity.

## Separation of claims

- **Confirmed visual blockers:** B1 and B2 only.
- **Still unverified functional completeness:** the 813-identity inventory, unvisited child controls (Privacy export,
  clear and prompt overlay below the fold; About/MCP; Filter children; Redo with real history), extension witness
  `a333` sequencing (PENDING), the `c068` root/full four-shard validation (submitted and PENDING), the nine
  authored modeling launch/refusal tests (UNRUN), federated, read-only and extension-state contexts, and locales.
  The browser result was 21 passed, 1 failed, 0 skipped on f8. That is not a pass.
- No production-readiness claim and no ALL-coverage claim. No numeric taste score.

**R2 judgment: REVISE.** Fix B1 (one class move) and B2 (browse demotion or omission plus honest reason copy),
then recapture the frozen matrix and context scenes on the matching build. Ideally also add a 390 px `hide` scene and a
same-environment scrollbar capture. Overall #8947 access stays unaccepted while coverage is pending.
