---
"@ifc-lite/cache": patch
---

Fix `parseGLBToMeshData`'s existing accessor bounds guard being silently bypassed by a missing/non-numeric `accessor.count` in a GLB's JSON chunk.

The guard (`bufferOffset + neededBytes > bin.byteLength`) is a bare comparison, and `accessor.count` — REQUIRED by the glTF spec but never runtime-checked — flows unvalidated from `JSON.parse` into it. A missing `count` makes it `undefined`, and `undefined * elementSize` is `NaN`; every arithmetic comparison against `NaN` (`< 0`, `> bin.byteLength`) evaluates `false`, so the guard added for the accessor-overrun case (see the "malformed accessor bounds" tests) did not catch this. Control fell through to a typed-array constructor built from the same `NaN`, which coerces to an element count of 0 — producing a mesh with an empty `positions` array, reported as a successfully imported model, instead of throwing. `readAccessorData` now validates `accessor.count` is a non-negative integer before doing any arithmetic on it; a valid `count`, including the boundary value `0`, is unaffected.
