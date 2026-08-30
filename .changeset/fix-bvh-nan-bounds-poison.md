---
'@ifc-lite/spatial': patch
---

Fix `BVH.queryAABB`/`raycast`/`queryFrustum` dropping a valid mesh when a sibling in the same subtree has NaN/degenerate bounds. `computeBounds` folded child bounds with `Math.min`/`Math.max`, which propagate a NaN operand through every later comparison in the same reduce, so one mesh with bad geometry (e.g. a corrupt vertex) NaN'd its entire subtree's aggregate bounds — and `AABBUtils.intersects` treats a NaN bound as no intersection, pruning that subtree, and every valid sibling under it, out of every query regardless of the query box. `computeBounds` now folds with NaN-safe comparisons (matching the Rust port in `rust/clash/src/bvh.rs`, which already used this shape), so a NaN-bounded mesh is excluded on its own without poisoning its siblings.
