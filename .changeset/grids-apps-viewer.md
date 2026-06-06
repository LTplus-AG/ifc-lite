---
"@ifc-lite/renderer": minor
"@ifc-lite/viewer": minor
---

feat(grids): render structural grids in apps/viewer (#967)

Wire the structural-grid SDK from #966 into the in-repo viewer, mirroring the
alignment-lines stack (lines-only for now).

- **`@ifc-lite/renderer`**: `uploadGridLines3D` / `clearGridLines3D` (+ internal
  `hasGridLines3D` / `drawGridLines3D`) — a dedicated grid line buffer drawn
  through the existing line pipeline, independent of the annotation/alignment
  overlays. Unlike alignment, grid lines don't expand model bounds (they sit
  behind a visibility toggle and routinely extend past the envelope). Also frees
  the alignment + grid line buffers on overlay `dispose()`.
- **`@ifc-lite/viewer`**: `useGridLines3D` hook (mirrors `useAlignmentLines3D`,
  calls `GeometryProcessor.parseGridLines`), wired in `Viewport` and gated by the
  existing `ifcGrid` type-visibility toggle.

3D tag/bubble labels and full polyline sampling for curved axes are deferred (see
#967).
