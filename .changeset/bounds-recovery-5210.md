---
'@ifc-lite/geometry': patch
---

Fix model bounds staying poisoned for the rest of a load after one corrupted vertex (#5210). The sampling bounds path (the default for WASM-streamed models) skipped the per-vertex validity filter, so a single garbage vertex widened the accumulated bounds permanently. Each sampled batch result is now checked once; a batch with a bound beyond the 10,000 km sanity limit is recomputed through the filtered path, which drops only the garbage vertex. The recovery is counted in the new optional `CoordinateInfo.boundsRecoveryFallbackCount`, reported by `getCurrentCoordinateInfo()` and `getFinalCoordinateInfo()`.
