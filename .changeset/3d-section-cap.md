---
'@ifc-lite/renderer': minor
'@ifc-lite/drawing-2d': patch
'@ifc-lite/viewer': patch
---

3D section cap with screen-space hatches, driven by exact cut polygons.

### `@ifc-lite/renderer`

- **3D cut surface (cap) rendering.** `Section2DOverlayRenderer` gained
  a fill pipeline that paints the user's cap style on top of the exact
  polygons `SectionCutter` produces from triangle-plane intersection.
  Eight built-in screen-space hatch patterns are supplied via the new
  `section-cap-style.ts` module: `solid`, `diagonal`, `crossHatch`,
  `horizontal`, `vertical`, `concrete` (clean dot grid, ISO 128-50),
  `brick`, `insulation`. Pattern ids match the numeric branches in the
  fill fragment shader and are pinned by unit tests so changes can't
  drift silently. New `Section2DOverlayCapStyle` shape carries fill,
  stroke, pattern id, spacing/angle/width, and a secondary cross-hatch
  angle.
- **Outline + fill toggle independently.** `Section2DOverlayOptions`
  has new `showFills` and `showOutlines` booleans, both honoured by
  `Section2DOverlayRenderer.draw()`, so callers can hide the cut hatch
  without losing the line drawing or vice versa.
- **Cap respects model depth.** Both fill and outline pipelines test
  with `depthCompare: 'greater-equal'` (reverse-Z) and don't write
  depth, so when the camera looks through closer model geometry the
  cap is occluded naturally. Cap polygons live exactly on the plane,
  so equal-depth ties tie cleanly with greater-equal.
- **Cap fill landed exactly on the plane.** Removed the old 0.3 m
  vertical bias that made the hatch visibly drift off the slider
  position; the fill now sits on the cut surface itself.
- **Depth format unified at `depth24plus-stencil8`.** Main, instanced,
  section-plane preview, and 2D overlay pipelines all declare the same
  depth/stencil format and route through `PIPELINE_CONSTANTS.DEPTH_FORMAT`
  so the literal lives in exactly one place. All in-pass pipelines also
  declare both colour attachments (main colour + objectId, the latter
  with `writeMask: 0`) so WebGPU validation passes regardless of which
  shaders render inside the section render pass.
- **`flipped` flag plumbed end-to-end.** Main and instanced fragment
  shaders pack `enabled` (bit 0) + `flipped` (bit 1) into one flag slot
  and negate the keep side when flipped — slider position stays where
  it is, only the kept half swaps.
- **`SectionCapStyle`, `HatchPatternId`, `DEFAULT_CAP_STYLE`, and
  `HATCH_PATTERN_IDS` exported from the package** as the canonical
  styling primitives consumed by the viewer store and the fill shader.
- **Renderer log on first section enable** (`[Section] Y-up bounds
  used for clip: …`) so a user can verify the slider range matches
  their geometry without opening a debugger.

### `@ifc-lite/drawing-2d`

- **Plane equation no longer changes when `flipped`.** Both
  `SectionCutter` and `gpu-section-cutter` now build the plane normal
  from `getAxisNormal(axis, false)` regardless of the flipped flag.
  Previously the flipped normal was paired with an unchanged
  `planeDistance`, which described a different plane (`y = -position`
  instead of `y = position`) — the cutter then looked for intersections
  far outside the model and produced an empty 2D drawing. `flipped` is
  still honoured by `projectTo2D` so the resulting drawing mirrors
  correctly when viewed from the opposite side.

### `viewer`

- **`SectionCapControls` panel.** New compact controls inside the
  expanded Section panel: independent Display toggles for *Surfaces*
  (cap fill) and *Lines* (outline), hatch pattern dropdown, fill +
  stroke colour pickers, and Spacing / Angle / Width number inputs in
  a 3-col grid. The hatch fieldset disables itself when Surfaces are
  off so users can't tweak settings that don't apply. Every control
  has an explicit `id`/`htmlFor` association via `useId()` for
  assistive tech.
- **Flip button reflects state.** Now toggles `variant` to `default`,
  carries `aria-pressed`, and swaps `aria-label`/`title` between
  "Flip cut direction" and "Unflip cut direction".
- **Auto-enable on slider/axis change.** Moving the position slider or
  picking a direction now sets `enabled: true` so users no longer get
  stuck in a no-op "preview mode" wondering why nothing cuts. The
  bottom toggle relabelled "Clip on/off" instead of the old
  "Cutting/Preview" wording that read as if the cut was always live.
- **2D panel auto-fits on Flip.** `useViewControls` now triggers
  `fitToView` on `sectionPlane.flipped` change as well as axis change,
  so flipping doesn't park the polygons off-screen and leave the
  panel blank.
- **Cap style persists across reloads.** `showCap`, `showOutlines`,
  and the full `capStyle` (fill, stroke, pattern, spacing, angle,
  width, secondary angle) round-trip to `localStorage` under the keys
  `ifc-lite:section-cap-show`, `ifc-lite:section-outlines-show`, and
  `ifc-lite:section-cap-style`. `resetSectionPlane()` clears them so
  the default button actually resets. `resetViewerState()` (called on
  every IFC load) preserves persisted cap settings and only clears
  axis/position/enabled/flipped — so opening a new file no longer
  wipes the user's hatch and colour choices.
- **Cap style types deduplicated.** `SectionCapHatchId` and
  `SectionCapStyle` in the viewer store are now re-exports of the
  renderer's `section-cap-style.ts`, so adding a new pattern only
  requires editing the renderer.
- **localStorage failures are diagnosable.** Every persistence catch
  in `sectionSlice` now logs via `console.warn` instead of a bare
  `catch {}` — quota / private-mode / serialisation failures still
  fall back gracefully but show up in devtools.
