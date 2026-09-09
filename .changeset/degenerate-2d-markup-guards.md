---
"@ifc-lite/viewer": patch
---

2D drawing markup's polygon-area and revision-cloud tools no longer accept a degenerate zero-size shape, matching the guard the measure tool already had. A polygon is rejected when its (shoelace) area is under `MIN_MEASUREMENT_DISTANCE ** 2` (1e-6 m²) — this also catches three collinear points, which widen to a zero-area polygon despite being distinct clicks. A cloud is rejected only when its bounding box is smaller than `MIN_MEASUREMENT_DISTANCE` on both axes — a cloud that is thin on only one axis (e.g. 5m x 0m) is still accepted, since it genuinely renders. `MIN_MEASUREMENT_DISTANCE` is 1mm.
