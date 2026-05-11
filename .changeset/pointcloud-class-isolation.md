---
"@ifc-lite/renderer": minor
"@ifc-lite/viewer": minor
---

Per-class visibility toggles for ASPRS-classified point clouds.

A new "Classes" section in the point cloud panel exposes a checkbox
list of every LAS 1.4 standard class (Ground, Vegetation, Building,
Water, Wires, Bridge deck, ...). Toggling a class hides every point
with that classification. Works in any colour mode; the swatch
colours mirror the splat shader's classification palette so the UI
matches what's on screen.

Implementation:
- New `pointCloudClassMask: number` (u32 bitmask, default
  `0xFFFFFFFF`) on the point cloud slice. `togglePointCloudClass(id)`
  flips a single bit; `setPointCloudClassMask(mask)` replaces all 32.
- `PointCloudRenderOptions.classMask` plumbed through the renderer.
  Stored in uniform slot `flags.w` (was unused).
- Splat shader checks `(flags.w >> classId) & 1` per vertex; hidden
  classes get a degenerate `clipPos = vec4(0, 0, -2, 1)` so they're
  culled before rasterisation rather than wasted on a fragment-stage
  discard.
- New `PointCloudClasses` component in the panel renders a
  `<details>` collapsible with "Show all" + per-class toggles. A
  badge surfaces "N of 32 visible" when not all are on.
- `usePointCloudSync` forwards the mask to
  `setPointCloudOptions({ classMask })`.

Class ids ≥32 always show — the mask only covers the standard
range. Custom-labelled scans need a richer UI (deferred).
