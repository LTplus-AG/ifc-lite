---
"@ifc-lite/clash": patch
---

**Note added in this same release — see `clash-depth-box-exact-metric.md`.** `TriMesh.maxPenetrationInto`, the probes' caller, has been removed (it was a sampling artifact, not a real depth measurement). `containsPoint` and `distanceToSurface` — the BVH-accelerated probes this changeset describes — are kept as exact, independently tested primitives for future callers, but are no longer on the hot path this changeset was optimising; the per-pair cost figures below no longer apply to the current narrow phase.

Drive the mesh-depth probes through the triangle BVH instead of scanning every triangle.

Measuring the mesh-level penetration depth for every hard clash (rather than only for AABB-contained pairs) made two per-vertex probes hot: `containsPoint`, a ray cast counting crossings against every triangle, and `distanceToSurface`, a closest-surface scan over every triangle. Both were deliberate O(n) linear scans whose doc comments justified the cost by "only invoked from the contained-pair depth measurement" — an invariant that stopped holding when the gate was removed. Both comments are now corrected, and both probes use the per-element triangle BVH that `TriMesh` already builds.

`containsPoint` tests only the triangles the BVH reports along the ray. `distanceToSurface` queries the cube of half-size `h` around the point, and — because every triangle within `h` has its closest point inside that cube — accepts the candidate minimum `d` as the global minimum once `d <= h`, otherwise re-queries once at half-size `d`, which provably captures the closest triangle. Both therefore return the exact same value the linear scans returned; `min` selects an element rather than accumulating, so a different visit order cannot move the last bit.

The Rust/WASM kernel is changed identically, including a port of the TS BVH's ray traversal, so the two kernels stay bit-identical. A shared probe fixture pinned to exact `f64` literals now guards that in both test suites — the differential suite's 1e-6 epsilon would not catch a one-ulp drift.

On the same synthetic bench of 300 deeply penetrating pairs, per-pair cost drops from 1.51 ms to 0.95 ms at 300 triangles per mesh, 7.21 ms to 2.86 ms at 1200, and 59.3 ms to 7.6 ms at 3072 — back to within noise of the cost before the depth measurement was generalised (0.98 / 3.08 / 8.04 ms). Meshes small enough that one query covers them see no change; the win scales with triangle count.
