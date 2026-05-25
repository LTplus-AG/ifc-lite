# Element Splitting (design)

**Status:** plan only — not yet implemented.

Splitting a wall (or slab, beam, column, space, roof, plate) into
two coherent pieces is the single most-requested authoring gesture
after Move. This doc maps the UX, IFC semantics, and implementation
shape for landing it in ifc-lite.

## Goals

- **One gesture, multiple element types.** A user who learns the
  Split tool on a wall should split a slab the same way.
- **Lossless property carry-over.** Both halves inherit Pset / Qto /
  classification / material / type relationships from the original.
  No silent data loss.
- **Hosted-element correctness.** Doors, windows, and openings
  reassign to whichever half they geometrically belong to. A wall
  with a door in segment B mustn't keep the door on segment A.
- **Undoable as one step.** A single Ctrl+Z reverts the whole split
  (creates two, deletes one, reassigns hosts → one undo entry).
- **Works on both overlay and source-buffer entities.** For
  source-buffer elements with unsupported representations the tool
  refuses with a clear message rather than producing garbage.

## Non-goals

- **Boolean subtraction by arbitrary curves.** Splits are straight
  cuts. Curved cuts → out of scope.
- **Splitting curved walls.** Phase 1 supports straight rectangle-
  profile walls only (matches `addWallToStore` output). Curved walls
  return to "not supported" with a follow-up plan.
- **Splitting linked-model entities.** The owning model must be
  editable.
- **Cross-storey splits.** A wall can't be split into pieces on
  different storeys.

## UX flows

### Activation

- **Toolbar:** new "Split" pill in the edit-mode toolbar group with
  a knife icon (`Scissors` is taken by Section; use `Slice` or a
  custom knife). Pinned right after the draw-tool pills.
- **Keyboard:** `K` (knife) toggles the tool. Only fires while
  `editEnabled` is on. Esc cancels and returns to Select.
- **Command palette:** "Split element…" / "Split wall…" /
  "Split slab…" entries with the same shortcut hint.
- **Context menu:** right-click on a wall / slab in 3D → "Split…"
  enters the tool pre-armed for that element.

When the tool activates, the cursor flips to a knife glyph, hovered
splittable meshes get a subtle outline pulse (matches measure-tool
hover styling), and unsplittable elements gray slightly so the user
knows what's targetable.

### Wall split — single-click

```text
1. User enters Split tool (K).
2. User hovers a wall:
   - mesh outlines purple
   - a perpendicular guide line draws across the wall at the
     projected cursor position
   - a label shows "1.42 m from start" / "3.58 m to end"
   - snap dots appear at: start, midpoint, thirds (every 0.5 m if
     wall is longer than 2 m), and at every intersecting wall
3. User clicks:
   - if cursor is within the wall and at least MIN_SEGMENT_LENGTH
     (0.05 m) from each end → commit split
   - otherwise: red "X" cursor + toast "Split too close to wall end"
4. Two new walls appear; original is gone; selection moves to the
   new wall containing the cursor (so the user can immediately
   continue editing).
```

### Slab split — drag a line

Slabs need a cutting *line* (two points define which half is which),
not a single point. UX:

```text
1. User enters Split tool, hovers a slab → slab outlines purple.
2. First click: anchors the start of the cut line on the slab.
3. Cursor → ghost line follows from anchor to cursor, clipped to
   the slab polygon. Snap dots at slab edges / vertices.
4. Second click: commits.
   - If the line doesn't intersect the slab polygon in exactly two
     places: refuse with "Cut must cross the slab"
   - Otherwise: two slabs appear, selection moves to the half
     containing the second click.
5. Esc during the drag cancels.
```

Same pattern for plate, roof, space (room).

### Beam / column / member split — numeric or click

Beams and columns are linear like walls. Same single-click flow,
guide line perpendicular to the element's axis. For columns
(vertical), the guide is horizontal; for beams (any orientation),
perpendicular in the beam's local frame.

### Numeric split (always available)

While Split is active and an element is hovered or selected,
a small floating input panel near the cursor accepts:

- `Distance from start` (metres) → updates the guide live
- `Percent` (0–100%) → updates the guide live
- `Snap to grid step` checkbox → constrains the guide to the
  current grid (0.5 / 0.25 / 0.1 / 0.05 m, matching Pascal)

Enter commits, Esc cancels. Same panel position as the existing
measure-tool readout.

### Multi-element split (Phase 2)

```text
1. Draw a line tool (Shift-K?) places a free-floating "cutting
   plane" represented in 2D as a yellow line + extruded plane
   visualisation in 3D.
2. The plane snaps to vertical / horizontal axes by default, to
   any wall axis with Shift held.
3. Every wall / slab / beam / column that intersects the plane is
   highlighted blue.
4. User clicks "Apply" in the floating prompt → all highlighted
   elements split at the plane intersection in one mutation
   (single undo).
5. Esc cancels.
```

This is the killer feature for building-wide cuts (e.g. "split
everything along this gridline").

## Visual design

| State | Wall | Slab | Beam/Column |
|---|---|---|---|
| Idle (tool armed, no hover) | Knife cursor; splittable meshes get a faint purple tint at 8% opacity | same | same |
| Hover | Mesh outline pulses (existing hover style); guide line in red-orange at full opacity | Same outline; first-click crosshair on slab surface | Mesh outline pulses; perpendicular guide |
| First click placed (slab only) | n/a | Anchor dot stays; ghost line follows cursor; clipped to polygon | n/a |
| Snap engaged | Snap dot + green ring; readout shows snap target ("midpoint", "wall intersection") | Same | Same |
| Committed | Brief flash on the two new pieces; toast "Wall split — undo to restore" | Same | Same |
| Error | Red "X" cursor; toast with reason; tool stays armed | Same | Same |

Colour palette pulls from existing edit-mode purple (`#a855f7`) for
the tool accent and existing snap green for snap states. Keeps the
visual language consistent with the gizmo / wall-endpoint handles.

## Snap targets

Reused from the existing `SnapDetector` in `@ifc-lite/renderer`
(it already does VERTEX / EDGE / FACE / FACE_CENTER) plus
element-specific snaps:

- **Wall split:**
  - Start endpoint
  - Midpoint
  - Thirds, quarters (configurable in tool-settings dropdown)
  - Intersection point with any other wall on the same storey
    (computed by `findWallIntersection` already in `wall-drafting.ts`'s
    equivalent — we have planar-graph helpers in `@ifc-lite/create`'s
    auto-space code that can be reused)
  - Hosted-element edges (door / window frames) — snap to the frame
    boundary so users can split "right next to" an opening
  - Snap to current grid step
- **Slab split:**
  - Slab vertices + edge midpoints
  - Perpendicular / parallel to any slab edge
  - Pass-through point of any wall axis above/below the slab
- **Beam/column split:** ends, midpoint, thirds, intersection with
  perpendicular slab/beam.

`SnapDetector` already provides VERTEX/EDGE/FACE; we add
**SNAP-AXIS** for element-axis projections (closest point on the
wall's centreline given a cursor in 3D space).

## IFC semantics

### Wall split (rectangle profile)

Input: wall #W with placement origin `S`, RefDirection `d`, profile
XDim `L`, YDim `T`, height `H`. Split distance `t ∈ (0, L)` from
start.

Output:
- Wall #W deleted (tombstone).
- Wall #W₁: same `S`, same `d`, XDim `t`. Profile origin
  `[t/2, 0]`.
- Wall #W₂: placement origin `S + d·t`, same `d`, XDim `L - t`.
  Profile origin `[(L - t)/2, 0]`.

Sub-graph reuse:
- Owner history, body context, storey placement — both halves
  reference the same originals.
- RefDirection `d` is shared (constant — splitting doesn't rotate).
  We emit one IfcDirection and share it.
- Material layer set, classification, property sets — referenced
  by both new walls (we copy the relationship refs; the underlying
  Pset entities are shared).

Hosted-element reassignment:
- For each `IfcRelVoidsElement` voiding #W: project the opening's
  local position onto wall axis. If position ≤ `t`, reassign to
  #W₁; else reassign to #W₂ (rewriting the RelVoids to point at
  the correct host) and offset the opening's local X by `-t`.
- For each `IfcRelFillsElement` chained from a voided opening:
  follow the chain — door/window stays on whichever wall the
  void went to.

GlobalId policy:
- #W's GlobalId is **retired** (the entity is tombstoned).
- #W₁ and #W₂ get fresh GlobalIds via `generateIfcGuid()`.
- Audit trail: both new walls get an `ObjectType` suffix `(split
  from #W's-globalid)` so downstream IDS / BCF round-trips know
  the origin. Configurable.

Property carry-over:
- `IfcRelDefinesByProperties` and `IfcRelDefinesByType` referring
  to #W get cloned with one entry per new wall in the RelatedObjects
  list (or duplicated rels — cheaper, simpler).
- Quantity sets: `LongLength`-style quantities recompute per half
  (we already know the new lengths). `Width`, `Height` carry over
  unchanged.

### Slab split (rectangle or polygon profile)

Input: slab #S with footprint polygon `P` (vertices in slab-local
2D) and thickness `T`. Cutting line `L` with endpoints in slab-local
2D.

Output:
- Slab #S deleted.
- Two new slabs whose footprints are the two halves of `P` cut by
  `L`. Each becomes an `IfcArbitraryClosedProfileDef` (even if
  the original was rectangle — splits a rectangle into two arbitrary
  polygons more often than not).
- Same storey placement; thickness `T` preserved; extrusion direction
  preserved.

Polygon-clipping math: standard half-plane clipping. We already
have polygon helpers in `apps/viewer/src/components/viewer/tools/computePolygonArea.ts`;
we'd add a `clipPolygonByLine(polygon, lineA, lineB) → [left, right]`
helper.

Hosted elements (rare for slabs but possible — floor cutouts /
openings): same reassignment as walls, projecting opening centre
onto the cutting line.

### Beam / column split

Same shape as wall but the "axis" runs through 3D rather than
storey-planar. Beams use `IfcExtrudedAreaSolid` with a non-vertical
axis; columns use `IfcExtrudedAreaSolid` with vertical axis. Both
have `IfcRectangleProfileDef` or `IfcCircleProfileDef` SweptAreas.

We split by adjusting `Depth` (extrusion length) for the
ExtrudedAreaSolid and offsetting the placement origin for the
second half. Implementation differs from wall only in which
attribute carries the length and how the placement offset is
computed.

### Refusal cases

The tool refuses (with specific toasts) when:

- Element has a non-rectangular profile we don't handle yet
  (`IfcCircleProfileDef`, `IfcIShapeProfileDef`, …) → "Split
  supports rectangular profiles only (this is a circular beam)"
- Element is curved (wall along a Bezier, etc.) → "Curved walls
  can't be split"
- Split distance leaves a segment shorter than
  `MIN_SEGMENT_LENGTH` (0.05 m) → "Split too close to end"
- Element is in a linked / read-only model → "Model is read-only"
- Element has hosted openings that would straddle the cut line →
  warning toast "Cut bisects an opening; the opening will move to
  the [left/right] half. Continue?" with Confirm / Cancel

## Property + relationship preservation

Single shared helper `cloneElementMetadata(modelId, sourceExpressId,
targetExpressId)` that:

1. Walks every `IfcRelDefinesByProperties` referencing the source,
   appends the target to its `RelatedObjects` list.
2. Same for `IfcRelDefinesByType` (occurrence → type).
3. Same for `IfcRelAssociatesClassification` and
   `IfcRelAssociatesMaterial`.
4. Same for `IfcRelContainedInSpatialStructure` (storey
   containment) — actually the in-store wall builder already
   creates this; we just append.
5. Same for `IfcRelAggregates` if the source was a child of an
   element assembly.

This helper is the centrepiece of "lossless property carry-over"
and is unit-testable in isolation.

## State surface (slice)

```ts
type SplitMode = 'idle' | 'aiming' | 'first-anchor' | 'committing';
type SplitTarget = { modelId: string; expressId: number; type: 'wall' | 'slab' | 'beam' | 'column' | 'roof' | 'plate' | 'member' };

interface SplitToolSlice {
  splitMode: SplitMode;
  splitTarget: SplitTarget | null;
  /** Storey-local cut anchor (slab) or wall-axis offset (wall). */
  splitAnchor: [number, number, number] | null;
  /** Cursor in storey-local space for live preview. */
  splitHoverPoint: [number, number, number] | null;
  /** Per-tool settings (snap to grid, audit-trail suffix). */
  splitSnapToGrid: boolean;
  splitAuditTrail: boolean;
  setSplitTarget(t: SplitTarget | null): void;
  setSplitAnchor(p: [number, number, number] | null): void;
  setSplitHoverPoint(p: [number, number, number] | null): void;
  setSplitSnapToGrid(v: boolean): void;
  setSplitAuditTrail(v: boolean): void;
}
```

Goes in a new `splitToolSlice.ts`, same shape as the existing
`addElementSlice` (mode + anchor + hover + parameters).

## Store actions

```ts
// MutationSlice additions:

splitWallAtDistance: (
  modelId: string,
  expressId: number,
  distanceFromStart: number,
  options?: { auditTrail?: boolean },
) => { ok: true; newExpressIds: [number, number] } | { ok: false; reason: string };

splitSlabByLine: (
  modelId: string,
  expressId: number,
  lineStart: [number, number],
  lineEnd: [number, number],
  options?: { auditTrail?: boolean },
) => { ok: true; newExpressIds: [number, number] } | { ok: false; reason: string };

splitLinearElement: (
  modelId: string,
  expressId: number,
  distanceFromStart: number,
  options?: { auditTrail?: boolean },
) => { ok: true; newExpressIds: [number, number] } | { ok: false; reason: string };

splitElementsByPlane: (
  modelId: string,
  expressIds: number[],
  plane: { origin: [number, number, number]; normal: [number, number, number] },
  options?: { auditTrail?: boolean },
) => { ok: true; results: Array<{ source: number; halves: [number, number] }> } | { ok: false; reason: string };
```

Each action is a **single composite mutation** on the undo stack
(needs the `setPositionalAttributesBatch` primitive that's already
on the follow-up list from PR #723) so one Ctrl+Z reverts the
whole split.

## Helpers (placement-edit / wall-edit)

New helpers, scoped per the existing module split:

`wall-edit.ts`:
- `splitRectangleWall(dataStore, view, editor, expressId, distance, options): SplitResult`

`slab-edit.ts` (new):
- `resolveSlabEditChain(dataStore, view, editor, expressId): SlabEditChain | null`
- `splitArbitraryClosedSlab(dataStore, view, editor, expressId, line, options): SplitResult`

`linear-element-edit.ts` (new):
- Generic helper for beam/column/member — same shape as wall but
  parametrised by axis vector and length attribute index.

`metadata-clone.ts` (new):
- `cloneElementMetadata(dataStore, view, editor, sourceId, targetId)` —
  walks rels and appends to lists.

Module limits respected: each stays under 400 LOC.

## Visual feedback layer

New overlay `SplitOverlay.tsx` in `tools/`, sibling to
`AddElementOverlay` / `GizmoOverlay` / `WallEndpointOverlay`.
Mounted by `ToolOverlays` when `activeTool === 'split'`. Renders:

- Cursor knife glyph (CSS cursor on the canvas)
- Hover outline for the targeted element (uses the existing colour-
  override pipeline — set a transient `pendingColorUpdates` entry,
  clear on hover-out)
- Guide line — SVG anchored to projected world positions
- Snap markers — reused from `AddElementOverlay`'s snap glyphs
- Distance / percent readout — HTML over canvas, positioned at
  the cut point
- Numeric input panel — same shape as the existing measure-tool
  panel, anchored to the cursor

## Mesh re-render

This is the same blocker called out in PR #723's deferred items.
Split produces new walls/slabs whose geometry the renderer needs
to see immediately — same problem as the move gizmo. We solve it
once, both features benefit:

- **Path A (chosen for v1):** `appendGeometryBatch(newMeshes)` for
  the two new halves + a new `removeMeshFromGeometry(globalId)`
  action that filters the old wall's meshes out of
  `geometryResult.meshes` and bumps `geometryUpdateTick`. The
  renderer's `useGeometryStreaming` already watches for additions;
  we extend it to handle removals.
- **Path B (follow-up):** renderer-side per-entity transform +
  visibility flag, so we can do live preview during drag without
  reuploading meshes. Same path that level-display Exploded mode
  wants.

## Keyboard

| Key | Action |
|---|---|
| `K` | Toggle Split tool (only when `editEnabled`) |
| `Esc` | Cancel current split (clear anchor + hover) |
| `Enter` | Commit at the current numeric distance (if input panel is active) |
| `Shift` (held) | Bypass grid snap |
| `Tab` | Cycle snap targets (start → midpoint → thirds) |
| `1` / `2` / `3` | Snap to midpoint / thirds / quarters |

## Accessibility

- Tool selection is keyboard-accessible (Tab to the toolbar pill,
  Space to activate). Same shape as existing tools.
- Snap-target dropdown in the tool-settings popover is a proper
  `<select>` so screen readers announce the current snap mode.
- The numeric input panel uses an `<input type="number">` with a
  labelled `<form>` so screen readers announce the field as
  "Distance from start, metres".
- After commit, the toast carries `role="status"` so SRs hear
  "Wall split — undo to restore".
- Focus management: on commit, focus moves to the canvas (so
  Cmd+Z works without a mouse click) and the screen reader hears
  the new selection name.

## Mobile

The same gestures translate to touch with one key difference: the
numeric input panel doubles as the primary input on touch because
hover-driven snap previews aren't available. Tap on a wall opens
a sheet: "Split this wall at: [slider 0…length] [enter distance]
[snap to ¼ ½ ¾]". Tap-and-drag for slab cuts.

## Edge cases

| | Handling |
|---|---|
| Wall has a hosted door/window straddling the cut | Warning toast "Cut bisects an opening; opening will move to [left/right]." Confirm / Cancel. |
| Wall has multiple hosted openings | Each reassigned independently by its centre position. |
| Slab cut line passes through 0 or 1 polygon edges | Refuse with "Cut must cross the slab" |
| Slab cut line is tangent to a vertex | Slight nudge along the cut normal; warn if nudge > 1 cm |
| Splitting in Exploded view mode | Allowed — the cut is computed in storey-local coords, independent of display offset |
| Federated model selected | Split executes in the owning model's overlay; result selection picks the half in that model |
| Element has overlapping decomposition (IfcRelAggregates) | Both halves inherit the same parent; warn if assembly semantics may be broken |
| Pset linkage uses `IfcRelDefinesByProperties` with shared RelatedObjects | Both halves appear in the same rel's RelatedObjects list |
| Wall is part of a layered wall (IfcMaterialLayerSet) | Layers preserved; layer-specific quantities recomputed per length |
| Undo a split | Restore source wall, tombstone the two halves, rewind opening reassignments |
| Redo a split | Replay the entire composite mutation |
| User splits a wall they're about to drag with the gizmo | Gizmo target becomes one of the new halves (selection moves automatically); drag accumulator resets |

## Test surface

Pure helpers (high-priority):
- `clipPolygonByLine.test.ts` — half-plane clipping with degenerate
  cases (line misses polygon, line on edge, line through vertex)
- `splitWall.test.ts` — overlay-only fixture, verify new walls'
  XDim, profile origin, RefDirection sharing, Pset duplication
- `splitSlab.test.ts` — same plus polygon clipping correctness
- `cloneElementMetadata.test.ts` — Pset / Qto / classification /
  material / type rel duplication
- `reassignHostedOpenings.test.ts` — opening on left of cut goes
  to left half, opening on right goes to right; straddling
  opening triggers warning callback

Integration (lower priority, after pure helpers):
- Round-trip: split + export + reparse → two valid walls with
  correct geometry
- Undo / redo through a split

Manual / UX:
- Hover preview behaviour on long walls (zoomed out vs in)
- Snap engagement at exactly midpoint
- Numeric panel + cursor preview stay in sync
- Multi-element plane split highlights the right set
- Federated multi-model session

## Implementation phases

1. **Phase 1 — Wall split, single-click only.** Pure helper +
   action + `SplitOverlay` for wall. Numeric panel optional. Ships
   in ~700 LOC. Validates the end-to-end pipeline including the
   mesh-update primitive.
2. **Phase 2 — Slab split (drag-line) + polygon clipping helper.**
   ~500 LOC.
3. **Phase 3 — Beam / column / member split** (linear-element-edit
   module). ~400 LOC, mostly mirroring Phase 1.
4. **Phase 4 — Roof / plate / space split** (polygon-clipping
   reuse). ~250 LOC.
5. **Phase 5 — Numeric input panel** for all element types. ~250
   LOC.
6. **Phase 6 — Multi-element plane split.** ~600 LOC.
7. **Phase 7 — Hosted-opening reassignment** (started in Phase 1
   for the simple case, extended here for assemblies and edge
   cases). ~400 LOC.

Total ~3,100 LOC across 7 commits / PRs. Phase 1 alone is enough
to ship a useful product; Phases 2–4 fill out element coverage;
Phase 6 is the killer feature.

## Open questions

1. **Audit-trail suffix:** is `ObjectType += "(split from <gid>)"`
   acceptable, or should we use a custom Pset (`Pset_SplitProvenance`)?
   Pset is cleaner for IDS but invisible in property panels by
   default. Default to Pset, expose a setting.
2. **GlobalId reuse:** strict IFC says split → tombstone + two new
   GIDs (we do this). Some downstream BCF tooling may have already
   referenced the original; consider an optional "keep one GID"
   mode that retains the original GID on the half containing the
   cursor at split time.
3. **Curved-wall future:** when curved walls are supported (Bezier),
   splitting at parameter `t` is mathematically easy. The harder
   problem is deciding which Pascal-style "curve handle" each half
   gets — defer until curved walls land.
4. **Live preview during slab drag:** do we want the slab polygon
   clipped LIVE as the user drags the cut line's second point?
   Cheap math-wise; visually expensive (re-uploads a mesh per
   frame). Recommendation: ghost the cut line, defer the actual
   geometry update to commit.
