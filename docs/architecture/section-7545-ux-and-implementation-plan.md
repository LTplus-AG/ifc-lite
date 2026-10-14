# Multiple cutting planes: UX redesign and implementation plan

Status: proposed. Companion to [section-7545-cutting-planes-spec.md](./section-7545-cutting-planes-spec.md), which fixes *what* is built (plane set, renderer ABI, saved sets). This document fixes *how it feels* and *the order of work*. Where the two disagree, the amendments in "Spec amendments" win.

Issue: [#7545](https://github.com/LTplus-AG/ifc-lite/issues/7545).

## 1. The existing tool, tried on a real GPU

Method: the dev viewer at `main` (`7a90ee4900`), `AC20-FZK-Haus.ifc` (public fixture, 82 elements), Windows Chrome 155 on an NVIDIA GPU, driven over CDP, 1500×900 and 1000×800 viewports. Everything below was done by clicking and typing, not by reading code. Screenshots are in [`evidence/section-7545/`](./evidence/section-7545/).

| Step | Observed |
| --- | --- |
| Open Section from the ribbon | The bar appears with **Face** armed and a faint plane quad, but nothing is cut. Hint: "Hover a surface to preview · click to cut" |
| Click **Down** | Cut appears at 2.66 m at once, roof removed, hatched cap ([baseline-down-cut](./evidence/section-7545/baseline-down-cut.png)). No plane quad, no handle, nothing in the scene says where the plane is or which side is kept. Hint: "Drag the distance to move the cut" |
| Type `1.5` in the number | Works; the field is 72 px wide, unlabeled, 2 decimals. `1.234` would display as `1.23` |
| Wheel over the number | **Nothing happens** (value stays 2.66; the camera does not move either) |
| Click **Side** after Down | The Down plane is **replaced**, not joined. Same for Face, Box, Alignment |
| Click **Cap ▾** | A popover of hatch pattern, colours, spacing, angle, width ([baseline-cap-popover](./evidence/section-7545/baseline-cap-popover.png)). There is no one-click "fill the cut solid" |
| Toggle **Cut** off | The plane draws as a faint, sparse blue translucent quad ([baseline-preview-quad](./evidence/section-7545/baseline-preview-quad.png)). That is the only time the plane is visible |
| Reopen the tool later | It silently restores the last mode from `localStorage` (cardinal cut, or auto-arms Face after 200 ms), so the bar can open in a state the user did not choose |
| Narrow window (1000 px) | The bar wraps; `2D` and `✕` drop to a second row ([baseline-narrow-wrap](./evidence/section-7545/baseline-narrow-wrap.png)) |

What this adds up to, and why the UI is the part to redesign rather than the part to extend:

1. **One row answers three different questions.** `Down Front Side Face Box Alignment` mixes *which direction* (three cardinal axes) with *how the plane is defined* (a picked face, a box, a station). A second plane has nowhere to live in that row.
2. **The primary control is the least legible one.** The offset is a bare number with a glyph-only flip button beside it. Nothing says "Offset", nothing says what it is measured from, and the flip toggle cannot be told from decoration.
3. **The plane is invisible while it is working.** Cardinal cuts have no on-canvas presence; only a face-picked plane gets a drag gizmo. The user moves an invisible thing by scrubbing a 72 px number.
4. **State is surprising.** Auto-armed Face on open, restore-last-mode on open, `Cut` meaning "clipping on" while `2D` means "open the drawing", and a replace-on-click model for the modes.
5. **Fill is a hatch editor, not a switch.**

The redesign answers each of these; "make the number field bigger" does not.

## 2. Spec amendments from the trial

| # | Amendment | Replaces / extends |
| --- | --- | --- |
| A1 | **Offset is shown relative to the plane's datum.** A face-picked plane shows the distance from the picked face (`0.000` at the face, negative into the solid, matching the issue's `-0.200`). A cardinal plane shows the world coordinate along its axis (the elevation for a Down plane), with the datum named next to the field ("level", "from face", "X") so the number is never anonymous. `custom.distance` stays the stored absolute; a `datum` is stored at commit and the field displays `distance − datum` | Spec D5 shows an absolute value for every plane. `custom.distance` is `dot(point, normal)`, meaningless to a user |
| A2 | **Three decimals** (millimetres) in the field and in saved sets' display, in the project unit | Field today is `precision={2}` |
| A3 | **No auto-arm and no restore-last-mode on open.** The tool opens showing the current plane set. With an empty set it shows an empty state with the four Add actions. `sectionLastMode.ts` and its `SectionPanel` restore effect are deleted, not kept as a fallback (supersede means delete) | Today's `loadLastSectionMode` effect in `SectionPanel.tsx` |
| A4 | **No per-plane hues.** #5488 decided the section plane, gizmo and pick preview use the single interaction accent. Planes are told apart by *state* (active: solid outline and filled name tag; inactive: dashed, dim; cut-off: hollow) and by their name tag, never by colour | Spec's "brighter/dimmed + name tag" stays; any idea of a colour per plane is excluded |
| A5 | **Fill slice is a switch.** One toggle sets the cap to a solid fill in the cap's own colour (`pattern: 'solid'`, surfaces on) and back to the previous hatch; the `Cap ▾` popover keeps every existing detail | Spec D4 says only "caps for every plane" |
| A6 | **"Section" (2D) is renamed in the UI**: the control that opens the drawing is labelled `2D section`, tooltip names the active plane ("Open the 2D section of plane D") | Today's glyph + `2D` |

## 3. The new Section UI

### 3.1 Structure: one tool, two rows, one card

```
Top-center, one two-row surface (HudSurface), width = lane cap
┌──────────────────────────────────────────────────────────────────────────┐
│ ✂ SECTION │ (A) (B) [D] (+)  ⋯                         Cut  Fill  Show  ✕ │  row 1: planes + display
│ Plane D · Face │ Offset [ −0.200 ] m  − + │ ⇕ 10 cm ▾ │ ⇅ Flip │ ⌖ Set view │ ⤢ Zoom ▾ │ 2D section │  row 2: active plane
└──────────────────────────────────────────────────────────────────────────┘
Bottom-center hint line (one sentence, changes with state)
Canvas: name tags + plane outlines + drag handle on the active plane
```

Row 1 is *which planes exist and what is shown*. Row 2 is *the active plane*. Everything the issue lists maps to one visible control:

| Issue | Control | Row |
| --- | --- | --- |
| Add plane | `(+)` menu | 1 |
| Plane selector | plane chips `(A) (B) [D]`; ≥ 6 planes or a narrow lane collapses them into a dropdown showing the active one | 1 |
| Remove / Clear all | chip menu `Remove`; `⋯` menu `Clear all` (with Undo toast) | 1 |
| Cut vs Section | `Cut` (3D clipping, applies to the active plane's chip dot) and `2D section` | 1, 2 |
| Fill slice | `Fill` switch (A5) with a chevron into the existing Cap popover | 1 |
| Show | `Show` switch for the active plane's quad/outline | 1 |
| Numeric offset | the offset field with `− +` | 2 |
| Step + wheel | `⇕ 10 cm ▾` (a wheel glyph, as the reference shows) | 2 |
| Flip | `Flip` (icon **and** label until the narrowest tier) | 2 |
| Set view | `Set view` | 2 |
| Exact zoom | `Zoom ▾` | 2 |
| Plane preview | any plane with `Cut` off draws its outline and quad with a "preview" treatment; no separate control | — |

Chips are tabs (`role="tablist"`, arrow keys move, Enter activates, F2 renames, Delete removes). Each chip carries a small state dot: filled = cutting, hollow = preview only. The chip menu (right-click or its chevron when active) offers Rename, Cut on/off, Show on/off, Duplicate, Remove. **Duplicate** is the cheap way to make a parallel plane and costs nothing extra to build; it is in.

The `(+)` menu, top to bottom: `Z · Down`, `Y · Front`, `X · Side`, then `Face…`, `From selection`, `Box`, `Alignment…`. The first three are one click that makes a plane at the current storey (Z) or the model midpoint (X, Y); `Face…` arms a pick. This replaces the six-segment control: the axis buttons are not lost, they become *add* actions, and changing an existing plane's definition is `Reset to axis` / `Pick another face` in the chip menu.

### 3.2 Tiers (the existing `useHudBarTier` mechanism)

The top-center lane is capped at `calc(100% − 28rem)`, so the bar must degrade, not wrap. Tiers are measured offscreen exactly as the current bar does:

| Tier | Form |
| --- | --- |
| 0 | Everything with labels |
| 1 | Row 2 buttons lose their words (icons with tooltips); `Fill`/`Show`/`Cut` keep words |
| 2 | Chips become a dropdown; `Zoom`, `2D section`, `Clear all` move into `⋯` |
| Last resort | `HudToolbar`'s own wrap, unchanged |

`Offset`, `Flip`, `Cut` and `✕` never leave the bar at any tier. At 1000 px wide the bar is tier 2 and the baseline wrap is gone.

### 3.3 In the scene

This is the part the current tool lacks entirely, and the part most likely to make "several planes" legible.

- **Every plane is drawn**, cutting or not: an outline of its clipped extent, a **name tag** at its nearest corner to the camera (DOM overlay on the scene projector, as `SectionVisualization` already does), and a short **kept-side arrow** from the plane toward the geometry that stays. The arrow is what makes `Flip` understandable.
- **Active plane**: solid outline, filled tag, and a **drag handle** (the existing `SectionPlaneDragGizmo` arrow, generalised from custom planes to all planes). Dragging it writes the offset; a live readout (`D −0.200 m`) follows the pointer. Stepping with the wheel over the handle uses the same step as the field.
- **Inactive planes**: dashed outline, dim tag. Clicking a tag activates the plane; double-click zooms to that plane's cut region.
- **Preview** (cut off): the same outline with a hollow tag and the existing translucent quad, only while the tool is open (#6374 preserved).
- Everything uses the interaction accent (A4). The z-fight and cap rules from #5480 do not change.

### 3.4 Interaction rules

- **Empty state**: opening the tool with no planes shows `Add a plane: Z  Y  X  Face` as four buttons in row 1 and the hint "Add a plane to start cutting". No auto-armed pick (A3).
- **Adding** never replaces; it creates the next name, activates it, and flashes its tag for ~600 ms. At 8 planes `(+)` is disabled with the reason as visible text, not only a tooltip.
- **Face add**: hint becomes "Click a face to cut through it · Esc cancels"; the existing hover preview stays; the committed plane's offset reads `0.000 from face`.
- **Offset field**: click to type, Enter commits, Esc reverts, arrow keys step (Shift ×10, Alt ÷10), drag scrubs, **wheel steps** by exactly one step per notch, `−`/`+` buttons step. A tooltip names the wheel behaviour once ("Scroll to step by 10 cm"). While scrubbing a point-cloud model the existing preview stride still applies.
- **Step menu**: 1 cm, 5 cm, 10 cm, 25 cm, 50 cm, 1 m, Custom…. The choice is remembered per user.
- **Flip** toggles the kept side; the kept-side arrow flips with it. **Set view** animates the camera to look at the kept side, perpendicular to the plane; pressing it again returns to the previous camera (it is a toggle with a remembered camera, which is what makes it safe to press).
- **Remove** shows an Undo toast for 6 s; **Clear all** shows the same. No confirmation dialog.
- **Esc** disarms a pending pick, then, if nothing is armed, closes the tool (today's order). Closing the tool does not discard the planes (#5893 lasting scene state); the HUD chip reads `Section · 3 cuts` and keeps its hide/resume/clear actions.
- **Keyboard**: `[` / `]` previous/next plane, `Delete` remove (when a chip or the handle has focus), `F2` rename, `Alt+Wheel` over the canvas steps the active plane (off until the shortcut is learned from the dialog; documented in `KeyboardShortcutsDialog`).
- **Hints** (bottom-center, one line): empty → "Add a plane to start cutting"; pick → "Click a face…"; cutting → "Drag the arrow or scroll to move plane D"; cut off → "Cut is off · turn on Cut to clip the model".

### 3.5 Copy, i18n, accessibility

- Every new string is a catalogue key in `apps/viewer/src/i18n/catalogues` (`en` first, then the lazy catalogues the i18n tests enumerate). No literals.
- Chips are `role="tab"`; the offset field is the existing `role="spinbutton"` with an `aria-valuetext` of "−0.200 metres from face"; `Cut`, `Fill`, `Show` and `Flip` are `aria-pressed` toggles; the plane name tag overlay is `aria-hidden` (the chip is the accessible handle). `check-jsx-a11y` must not rise for any touched file.
- Tour anchors: `sectionPanel` stays on the bar; new anchors (`sectionPlaneChips`, `sectionOffset`) go through `lib/tours/anchors.ts` and the tour that mentions the old axis row is updated in the same PR.

## 4. Implementation plan

Order is fixed by dependency. Each layer ends in a state that can be merged, driven in a browser, and reverted alone. File paths are the current ones; the module-size ratchet (~400 lines, `sectionSlice.ts` and `store/index.ts` at budget) governs where code goes.

### L0 — Test and evidence harness (before any product change)

- `apps/viewer/src/test/section-fixtures.ts`: a fixture that seeds the store with a model of known bounds and planes with known normals, and a **shared clip predicate table** (planes × 10,000 seeded points) reused by every parity test.
- `scripts/` or `tools/` browser walkthrough `section-walkthrough.mjs` (CDP, real GPU) that performs the tasks in §5, writes screenshots to `evidence/section-7545/<layer>/`, and exits non-zero if any check fails. The scratch driver used for the trial above is its starting point; it becomes a committed, parameterised script so each layer's PR reruns the same steps.
- Baseline recordings of the walkthrough on `main` (the screenshots already in `evidence/`).

### L1 — Plane set, clipping, and the new chips/Add menu

Store (`apps/viewer/src/store`):
- `section-types.ts`: `SectionPlane` gains `id`, `name`, `showGizmo`; `MAX_SECTION_PLANES`.
- New `slices/sectionPlaneSetSlice.ts` (composed like `createSectionBoxSlice`): `inactiveSectionPlanes`, `addSectionPlane(kind)`, `activateSectionPlane(id)`, `removeSectionPlane(id)`, `renameSectionPlane`, `duplicateSectionPlane`, `clearSectionPlanes` (+ one-step undo record), `allSectionPlanes()`, `clippingSectionPlanes()`.
- `section-active.ts`: `activeSectionPlane` unchanged; new `clippingSectionPlanes`. `teardown`/`resetViewerState`: the set resets with the model, as the active plane does today.
- `setSectionPlaneFromFace` takes `target: 'new' | 'replace'`; `sectionPickTarget` state.
- Delete `sectionLastMode.ts` and `SectionPanel`'s restore effect (A3), and every test of them.

Renderer (`packages/renderer/src`):
- Spike (≤ 1 day, throwaway branch): place the extras block (D3) in the main, picker, shadow and point-cloud pipelines; record the bind-group decision in the PR.
- `extra-clip-planes.ts`: `ClipPlaneState`, `packExtraClipPlanes(frame, planes)` (world + RTE copies, f64 conversion via `rtePlaneDistance`), and the WGSL snippet `extraPlanesClipped`.
- `RenderOptions.extraSectionPlanes`; apply at the eight sites in spec D3. CPU side: `PickClipState.extraPlanes` with `pointClipped`, `boxFullyClipped`, `clipIsActive`, `source-curve-clipping`.
- `apps/viewer/src/lib/section/section-render-clip.ts`: emits `extraSectionPlanes` from the set; N=1 emits exactly what it does today.
- Reader ledger (`evidence/section-7545/readers.md`); every clip-set reader moves to `clippingSectionPlanes`.

UI (`components/viewer/tools`): split `SectionToolbar.tsx` (340 lines) into `SectionBar.tsx` (frame + tiers), `SectionPlaneChips.tsx`, `SectionAddMenu.tsx`, `SectionPlaneRow2.tsx` (placeholder offset/flip/Cut using today's controls). `AXIS_INFO` is kept for labels and `presetViewForAxis`.

Exit: three planes cut `AC20-FZK-Haus`; picker, raycast, shadows and outline agree; `N=1` bytes equal `main`; walkthrough tasks T1, T2 (§5) pass.

### L2 — Offset, plane controls and in-scene presence

- `HudValueField`: `onWheelStep(sign)` prop (wheel steps; `preventDefault` on a non-passive listener; magnitude ignored), `−`/`+` render as optional `stepper` prop, `precision={3}` for the section field. Tests in `HudValueField.test.tsx`.
- `useSectionDistance` → `useSectionOffset(plane)`: datum-relative value (A1), project unit conversion (`lib/units/convert.ts`), step from the new `sectionStepPreference` (`localStorage` `ifc-lite:section-step`), custom step.
- `SectionStepMenu.tsx`, `SectionPlaneRow2.tsx` (offset, step, Flip with label, Set view, Zoom placeholder), `Show`, per-plane `Cut`.
- Camera: `CameraCallbacks.lookAlong(direction, up?, bounds?)` (verify first that none exists), remembered-camera toggle for Set view.
- Scene: generalise `SectionPlaneDragGizmo` to any plane; `SectionPlaneTags.tsx` (name tags, kept-side arrow, outlines for inactive/preview); wheel stepping over the active tag; live drag readout.
- `Fill` switch (A5) and its state in `SectionCapControls`.
- i18n catalogues, tour anchors, shortcuts dialog.

Exit: tasks T3–T6 pass in the real browser; mounted-component tests cover every control; narrow-lane tier screenshots.

### L3 — Caps and drawings for every plane

- `Section2DOverlayRenderer`: geometry per plane id; extras block in its shader; cap discarded where another plane clips it.
- `useRenderUpdates.ts`: per-plane cap uploads (debounced 120 ms; active plane still from the Drawing hook), worker-side `cutMeshesStreaming` for inactive planes.
- Drawing header names and follows the active plane; `2D section` tooltip (A6); `generate-view-pdf.ts` clips by the set.
- Perf table (1, 4, 8 planes; `AC20` plus one heavy model; base vs branch interleaved, byte-identity statement) recorded in the PR and the `scripts/perf/README.md` ledger.

Exit: task T7 passes; perf gate met, or the fallback (active-plane caps only) is applied and recorded on the issue.

### L4 — Zoom and saved sets

- `CameraCallbacks.frameBounds(bounds, margin, durationMs)`; `SectionZoomSpec`; cut-region bounds helper (convex clip of the model AABB against the planes, pure function with its own tests).
- `Zoom ▾` popover; double-click-tag zoom.
- `SectionSet` in `savedSectionCutsStore`, `BasketView.section`, scene-session capture/restore; BCF `clippingPlanes[]` multi-plane round trip (`packages/bcf/src/viewpoint.ts`, `useBCF`, `section-restore.ts`); SDK `getSections/setSections/addSection/removeSection` with `pnpm generate:bim-globals`, `pnpm api-surface:update` and a changeset.
- `Views ▾` popover (in `⋯`): list, save (name prefilled), apply, rename, delete.

Exit: tasks T8, T9 pass; BCF round trip with three planes.

## 5. Tests: what is asserted, and how it is run

### Mounted-component tests (viewer, `@/test/render.js`, real store)

| Test | Asserts |
| --- | --- |
| `SectionBar.planes.test.tsx` | Add Z/Y/X/Face makes A, B, C; add never replaces; 8th disables Add with the reason visible; remove selects the previous; Clear all + Undo restores; rename dedupes; chips are `role=tab` and arrow keys move |
| `SectionBar.offset.test.tsx` | Typed `-0.2` → store `−0.2 m` (metres and mm project units); wheel one notch = one step at 10 cm and at a custom 7 mm; magnitude ignored (`deltaY` 1 vs 400 vs line mode); wheel does not reach the canvas handler; garbage input reverts without touching the store; face plane shows `0.000` at pick and the stored absolute is unchanged (A1) |
| `SectionBar.tiers.test.tsx` | The offscreen-measure tiers pick 0/1/2 for 1500/1100/900 px lane widths; `Offset`, `Flip`, `Cut`, `✕` present at every tier |
| `SectionPlaneTags.test.tsx` | A tag per plane; the active one has the handle; click activates; double-click calls `frameBounds` with the cut region; tags are absent when the tool is closed and the preview is absent for an enabled plane |
| `SectionPanel.open.test.tsx` | Opening the tool with no planes shows the empty state and arms nothing (A3, replaces `SectionPanel.reopen.test.tsx`) |
| `sectionPlaneSetSlice.test.ts` | Invariants: ids unique, `activeIndex` valid, every writer edits only the active plane, `activate` is a swap; face pick during a BCF apply and a saved-set apply never leaves an enabled plane the renderer was not told about |
| `SectionZoom.test.tsx` | `selection` + 10 % frames the bounds with the margin within 1 % (checked on the resulting view-projection) |
| `savedSectionSets.test.ts` | Round trip of planes, active, zoom and camera, ids regenerated |

### Renderer and parity tests

- One shared predicate table (planes × 10,000 seeded points) evaluated through the TS port of each WGSL clip function, `pointClipped`, the picker's and the shadow pass's predicate; all must agree. A compile test builds the real WGSL and fails if any pipeline's source lacks `extraPlanesClipped`.
- `N=1` byte-equality of the packed mesh uniform and the extras block's `count = 0` against fixtures captured from `main`; `section-plane-rte.test.ts` and `mesh-rte-uniforms.test.ts` stay unchanged and green.
- RTE: three planes at ~5,000 km coordinates, boundary within 1 cm of the f64 truth.
- Cap: sample cap geometry of plane A against plane B's predicate; none lies in B's removed half-space.

### The real-browser walkthrough (committed script, every layer reruns it)

Run against `AC20-FZK-Haus.ifc` and one authored model on a real GPU. Each task records a screenshot and a pass/fail.

| Task | Steps | Pass |
| --- | --- | --- |
| T1 | Open Section; add Z, X, then Face on a wall | Three chips A, B, C; three tags in the scene; model cut by all three; no plane replaced another |
| T2 | Select B; remove it; Clear all; Undo | Chip and scene follow each step |
| T3 | Select A; click the offset; type `-0.200`; Enter | Field `−0.200`; the cut moved; the tag follows |
| T4 | Hover the field; scroll 3 notches at 10 cm; change step to 1 cm; scroll 3 | Offset changed by 0.30 then 0.03; camera unchanged |
| T5 | Flip C; Set view on C; Set view again | Kept-side arrow flips; camera looks along the kept side; second press restores the camera |
| T6 | Narrow the window to 1000 px | Tier 2; no wrap; `Offset`/`Flip`/`Cut`/`✕` visible |
| T7 | `Fill` on with three planes | Solid cap on each plane; no cap inside another plane's removed region |
| T8 | Zoom ▾ → Selection → 10 % → Zoom | Selection fills the view with a visible margin |
| T9 | Save a set; delete all planes; reorient; apply the set | Planes, active plane, zoom and camera restored |

A pass requires the screenshot to be looked at, not only the assertion to hold: the baseline showed that state and picture can disagree (an enabled plane with nothing on screen).

### CI and housekeeping gates

`pnpm typecheck`, `pnpm test`, `pnpm lint` (a11y ratchet), `check-module-size`, `pnpm docs:check-samples` if a guide snippet changes, the BCF and SDK suites, `pnpm test:wasm-contract` (untouched, run anyway), and the perf ledger entry. A changeset for every published package touched (`renderer`, `bcf`, `sdk`).

## 6. Risks specific to the UI work

| Risk | Control |
| --- | --- |
| The new bar is wider than the lane | Measured tiers (§3.2) and the 1000 px task T6 |
| Handle dragging fights camera orbit | The handle captures the pointer through `lib/pointer-capture` as the face-pick gizmo does; test that a drag on the handle never reaches the orbit controller |
| Wheel steps conflict with camera zoom | Wheel is claimed only while the pointer is over the field or the active handle, and `Alt+Wheel` elsewhere is opt-in |
| Deleting auto-arm and restore-last-mode surprises habitual users | It is a behaviour change, so it gets a line in the changeset and the `What's new` tab; the empty state makes the first action one click |
| Name tags clutter dense models | Tags are drawn only for planes whose outline is within the viewport, collision-nudged along the outline, and hidden on the hide toggle |
| A deliberately larger UI lands as one unreviewable PR | L1 and L2 are separate PRs; the split of `SectionToolbar.tsx` is a pure move in its own commit |

## 7. Open questions (unchanged from the spec, plus two)

The four in the spec stand (object-based plane, "Section" meaning, persistence, units). Two from the UI work:

5. **Chips versus the issue's literal dropdown.** The issue shows `Plane [D ▾]`. Chips are faster for the 2–4 planes this feature is for, and the dropdown is the tier-2 form, so both exist; say if the dropdown should be the primary form.
6. **Set view as a toggle.** Remembering the previous camera makes the button safe to press, but it is a second meaning for a button the issue defines as one action. Default: toggle.
