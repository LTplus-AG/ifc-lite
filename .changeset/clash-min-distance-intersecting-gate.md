---
"@ifc-lite/clash": patch
---

Fix `minDistanceBetweenMeshes`/`minDistanceBetweenBvhs` reporting a nonzero distance for a genuinely intersecting pair of triangles.

`minDistanceBetweenBvhs` called `triTriDistance` unconditionally on every candidate leaf triangle pair, with no `triTriIntersect` gate. `triTriDistance`'s own contract says it is "only invoked for non-intersecting pairs" — intersecting triangles must be detected separately. For an axis-aligned box-overlap pair the missing gate happened not to matter (overlapping-box vertices/edges land exactly on the boundary features `triTriDistance` samples, so it returned 0 anyway), which is why the existing test suite did not catch it. A tilted, non-axis-aligned triangle pierced through another triangle's face interior has no such coincidence and returned a nonzero gap for two surfaces that actually overlap, contradicting `MeshDistance.distance`'s own documentation ("0 when they touch or overlap").

The traversal now tests `triTriIntersect` before `triTriDistance` on each candidate leaf pair, the same order `engine-ts/narrow.ts` already uses for its per-pair test. Since 0 is the smallest distance this query can ever report, finding an intersecting pair now returns immediately rather than continuing to search the remaining frontier.
