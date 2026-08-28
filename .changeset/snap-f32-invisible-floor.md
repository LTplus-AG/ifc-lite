---
'@ifc-lite/wasm': patch
---

The cross-bucket seam conform (`rust/geometry/src/csg/consolidate/conform`) gained a step that snaps a ring vertex a bucket already carries onto a seam candidate's exact position when the two are within `CONFORM_TOL` but not bit-identical — closing a sub-CONFORM_TOL disagreement between two buckets that land the same physical corner on floats a few µm apart (#3353). That step's own `region.changed` flag also controls whether `emit_plans` reuses pass 1's cached triangulation or re-runs `triangulate_polygon_with_holes_refined` from scratch, and that re-run is not guaranteed to reproduce the cached triangle set bit-for-bit even when the ring moved by nothing that matters.

Measured directly on `ara3d/ISSUE_171_IfcSurfaceCurveSweptAreaSolid.ifc` hosts #528 and #1290: every one of #528's 82 candidate snaps was a same-corner disagreement of 2.1e-9 units or less — double-precision noise from two independently-computed transform chains, not a real seam gap — and applying even the smallest of them still forced the re-triangulation and dropped a triangle through the needle backstop, tearing a previously watertight solid. #1290 showed the same noise band alongside genuine µm-scale corrections, with a ~140x gap between the two and nothing in between.

The snap now also requires that the candidate be distinguishable from the current position at the mesh's own output precision (`Mesh.positions` is f32): a move invisible at that precision cannot be the fix for a real T-junction, so refusing it costs nothing, while a µm-scale correction remains visible and still fires. `tri_is_needle` and `CONFORM_TOL` are unchanged.

Re-run of the triangulation-invariance census (`cargo test -p ifc-lite-geometry --features triangulation-alt --test triangulation_invariance`): 0 regressed against the golden (down from 2 before this floor).
