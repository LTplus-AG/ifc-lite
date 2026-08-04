---
"@ifc-lite/spatial": patch
---

Wire `@ifc-lite/spatial` into the test runner. The package shipped four modules of load-bearing geometry — `AABBUtils`, the `BVH` (AABB query, raycast, frustum query), `FrustumUtils` and the spatial index builder — with no test files and no `test` script, so `turbo test` skipped it entirely and none of it ran in CI. Adds a `test` script plus 45 tests covering the touching/containment boundaries, ray-slab behaviour behind the origin and along a grazed axis, the frustum plane margin, the per-mesh world-space origin lift, and the time-sliced async builder. No behaviour change.
