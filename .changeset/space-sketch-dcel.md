---
"@ifc-lite/create": minor
"@ifc-lite/wasm": minor
"@ifc-lite/viewer": minor
---

feat(spaces): interactive Space Sketch (DCEL) editor

A topology-aware space editor built on a persistent half-edge (DCEL) plate in
the Rust geometry core, exposed via a stateful `SpacePlateHandle` wasm binding:

- **Derive** rooms from a storey's walls, **drag** a shared vertex (both rooms
  follow), **split** a room between corners *or* new nodes added anywhere on a
  wall, **merge** rooms across a shared wall, with undo/redo, and **bake** to
  real `IfcSpace` (via the existing `addSpace` path).
- **Wall-axis recognition fixes** in `@ifc-lite/create`: read the extractor's
  reliable entity type instead of the columnar table's `'Unknown'` sentinel
  (every `Curve2D` Axis polyline — e.g. all of AC20-FZK-Haus — was skipped), and
  a body-footprint fallback (face sets, `IfcFacetedBrep`, vertically-extruded
  rect / arbitrary / IndexedPolyCurve profiles) for walls without an Axis.
- Viewer "Space Sketch" tool: storey list with resolved names, auto-derive on
  selection, auto-escalating + manual snap tolerance to close centreline corner
  gaps.
