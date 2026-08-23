---
"@ifc-lite/renderer": patch
---

Bound the point-cloud spatial index by occupied cells, not just by points, so a sparse cloud cannot outgrow V8's `Map` limit.

`PointCloudSpatialIndex` stores its voxel grid as a `Map<number, number[]>` with one entry per occupied cell, and `insertRange` can create a new cell for every point it indexes. V8 throws `RangeError: Map maximum size exceeded` at exactly 2^24 = 16,777,216 entries, but the only limb of the "memory safety valve" was `DEFAULT_MAX_INDEXED_POINTS = 30_000_000` — above that ceiling. On a sparse cloud (airborne LiDAR, a coarse site scan) roughly one point falls in each 0.5 m cell, so occupied cells track indexed points almost 1:1 and the grid would hit the engine limit around 16.8M points, well before the valve could bind. Dense terrestrial scans put many points in one cell and never approach it, which is why the gap went unnoticed.

The two limbs bound different resources and neither implies the other, so both are now enforced: `DEFAULT_MAX_INDEXED_POINTS` still bounds retained position memory, and the new `DEFAULT_MAX_INDEXED_CELLS` (2^24 − 2^20 = 15,728,640) bounds the `Map`. It is set high enough to bind only where V8 would otherwise have thrown, so no cloud that indexes fully today loses coverage, and a caller-supplied budget is clamped below the ceiling regardless. Points landing in an already-occupied cell cost no budget.

Whichever limb binds first closes the index; a chunk that crosses it is truncated to the prefix actually indexed, so the cap bounds retained memory rather than just stopping bookkeeping. Truncation is no longer silent: the index reports it once via `console.warn`, naming which limb bound and the point/cell counts, and exposes `capReason` (`'points' | 'cells' | null`), `cellCount` and `cellCapacity` so callers can explain why the measure tool stops snapping. Points past the cap still render normally.
