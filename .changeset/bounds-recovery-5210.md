---
'@ifc-lite/geometry': patch
---

Fix bounds recovery when the fast path is poisoned by a corrupted vertex (issue #5210). `calculateBoundsFast` drops the per-vertex validity filter, so once a single finite-but-huge vertex was sampled, bounds accumulated permanently and never recovered. Add a post-hoc check after fast-path sampling: if any bound component exceeds `MAX_REASONABLE_COORD`, recompute via slow path with per-vertex filter for that batch to restore recoverability. This preserves the ~380M-call saving while preventing permanent corruption.

Also add `CoordinateInfo.boundsRecoveryFallbackCount`, surfaced by both `getCurrentCoordinateInfo()` and `getFinalCoordinateInfo()`: the number of batches that hit the fallback above. Recovery is silent to the caller by design, so this is the only signal that the mesher emitted a corrupted vertex at all.
