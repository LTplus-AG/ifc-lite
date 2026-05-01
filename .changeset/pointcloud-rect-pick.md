---
"@ifc-lite/renderer": minor
"@ifc-lite/viewer": minor
---

GPU rectangle pick (marquee select) — meshes + point clouds.

Hold `Ctrl` (or `⌘` on macOS) and drag with the left mouse button
in the select tool to draw a rectangle. On release, every entity
(mesh or point cloud) whose pixel falls inside the rect becomes
the new selection. A teal-dashed SVG outline tracks the drag.

Implementation:
- `Picker.pickRect(x0, y0, x1, y1, …) → Set<expressId>` renders the
  same pick pass as `pick()` and reads back the texel rect, deduping
  hits to a Set. Mesh + point splats both participate (point splats
  share the depth buffer in the pick pass).
- A new private `Picker.renderPickPass` extracts the shared render-
  pass setup so single-pixel `pick` and rect `pickRect` don't drift.
- `PickingManager.pickRect` applies the same visibility filtering
  (`hiddenIds`, `isolatedIds`) as `pick`. The CPU-raycast and
  dynamic-mesh-creation fallbacks `pick` uses for very large batched
  models are skipped — rect pick only sees already-hydrated meshes.
- `Renderer.pickRect` exposes the manager's API.
- New `RectSelectionOverlay` component renders the dashed SVG box
  while dragging; lives inside `Viewport.tsx` as a sibling of the
  canvas.
- `useMouseControls` tracks a new `mouseState.isRectSelecting` flag,
  suppresses orbit/pan during the drag, and on mouseup runs
  `renderer.pickRect(...)` and feeds the result into
  `setSelectedEntityIds`. A 4-pixel minimum rect size avoids
  clobbering selection on a stray Ctrl-click.
- `MouseState.isRectSelecting?: boolean` and a new
  `setRectSelection?` callback added to `UseMouseControlsParams`.

Lasso (polygonal) pick still pending — covered by issue #611's
mid-term list. Per-class isolation for points is a separate
follow-up.
