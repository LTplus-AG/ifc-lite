---
"@ifc-lite/clash": patch
---

Fix `unionAabb` (`contact/aabb.ts`) to fold bounds with NaN-safe comparisons instead of `Math.min`/`Math.max`. `Bvh.build` (`contact/bvh.ts`) folds `unionAabb` bottom-up over every ancestor of a leaf, so a single degenerate (NaN-vertexed) triangle — e.g. from corrupt mesh geometry — poisoned the aggregate bounds of every node above it, up to and including the tree root. `queryMeshCross` then treated the poisoned bounds as "no overlap" and pruned the whole subtree, silently dropping every other, valid triangle from contact-interface clustering (`contactClusters`) and minimum-distance queries (`minDistanceBetweenMeshes`). A NaN triangle is now simply excluded from the aggregate rather than poisoning it, matching `aabbFromPositions` in the same file and `compute_bounds` in `rust/clash/src/bvh.rs`.
