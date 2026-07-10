---
"@ifc-lite/renderer": minor
---

Opt-in spatial chunk bucketing (issue #1682, phase 2 of the chunked-residency plan).

`Scene.setSpatialChunking({ cellSize })` partitions colour buckets by world grid cell, so batches become spatially compact and per-batch frustum/contribution culling fires at chunk granularity. Pure reorganization (pixel-identical rendering, same shared frame origin and draw path); a mesh never splits across cells; recolour, move/rotate re-bucketing, streaming fragments, finalize re-grouping and partial-batch piece filtering are all chunk-aware. Off by default.
