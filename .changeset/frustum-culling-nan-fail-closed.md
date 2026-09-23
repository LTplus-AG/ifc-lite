---
"@ifc-lite/spatial": patch
---

Fix `FrustumUtils.isAABBVisible` reporting a NaN-bounded box as visible. Every plane comparison was `distance < PLANE_EPSILON`, and a comparison against NaN is always false, so a corrupt mesh's bounds never tripped any of the six plane rejects and fell through to `true` — disagreeing with `AABBUtils.intersects` and raycast queries, which both already exclude it. `isAABBVisible` now rejects a non-finite AABB up front.
