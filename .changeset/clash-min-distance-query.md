---
"@ifc-lite/clash": minor
---

Expose an exact minimum-distance query between two meshes, with witness points.

`triTriDistance` already computed the exact triangle-to-triangle minimum
distance, but it lived under `math/`, which has no export subpath, so any
consumer outside the package hit `ERR_PACKAGE_PATH_NOT_EXPORTED`. What did not
exist anywhere was a traversal that can find the CLOSEST pair: every BVH query
in the package is an overlap predicate, so two disjoint meshes yield an empty
candidate set and there is nothing left to measure.

Adds `minDistanceBetweenMeshes` / `minDistanceBetweenBvhs` (branch-and-bound
over the two BVHs, pruning on the exact AABB lower bound) and re-exports
`buildMeshBvh` / `queryMeshCross` from `@ifc-lite/clash/contact` so a caller
measuring one element against several can build each tree once. Additive: no
existing export changes.
