---
"@ifc-lite/geometry": patch
---

Render opaque ordinary occurrences via GPU instancing. The geometry worker now
produces each batch once via `processGeometryBatchPartitioned`, splitting it into
a GPU-instancing shard (opaque, untextured ordinary occurrences — repeated
geometry collapses to one template + per-occurrence transforms) and a flat
`MeshCollection` (transparent glass, type-template geometry, and textured meshes,
which the instanced pipeline can't carry). The shard is posted to the main thread
as `instancedShards`, decoded, and GPU-instanced — uploading each unique geometry
once instead of per occurrence, which cuts upload/memory/draw cost on
repeated-geometry models. Picking, selection highlight, and colour overlays
(lens / IDS / compare / 4D) all operate per-instance, so the instanced path is at
feature parity with the flat path. Falls back to the flat-only path when the
loaded wasm predates the partitioned export.
