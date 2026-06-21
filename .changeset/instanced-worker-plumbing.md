---
"@ifc-lite/geometry": patch
---

Render genuinely-repeated opaque geometry via GPU instancing. The geometry worker
now produces each batch once via `processGeometryBatchPartitioned`, which routes
occurrences by per-batch repetition: a geometry whose `rep_identity` occurs at
least `INSTANCE_MIN_OCCURRENCES` (8) times in the batch collapses to one template
+ per-occurrence transforms in a GPU-instancing shard; everything else
(singletons, low-count, non-instanceable, plus all transparent / textured /
type-template geometry) goes to the flat `MeshCollection` and is consolidated +
frustum-culled exactly as before. This keeps the instancing upload/memory win for
truly-repeated geometry (mullions, fasteners, identical parts) while keeping
unique geometry on the cheap consolidated draw path — instancing every singleton
as a 1-instance template would issue one draw call per mesh and tank orbit
framerate. The shard is posted as `instancedShards`, decoded, and GPU-instanced;
picking, selection highlight, and colour overlays (lens / IDS / compare / 4D) all
operate per-instance, so the instanced path is at feature parity with the flat
path. The streamed mesh total counts both routes. Falls back to the flat-only path
when the loaded wasm predates the partitioned export.
