---
"@ifc-lite/renderer": patch
---

Fix a GPU buffer leak on two paired-allocation paths where a throw on the second `createBuffer` orphaned the first, already-created buffer.

`appendPointSubBuffer` (point cloud chunk upload) creates a `vertexBuffer` then a `deviationBuffer`; if the second allocation throws (e.g. out of memory — the exact scenario `appendChunkToNode` splits large uploads to survive), the `vertexBuffer` was created and written but never referenced again and never destroyed. `DeviationPipeline.uploadBvh` has the same shape with `nodeBuf` then `triBuf`. Both sites now destroy the first buffer before the error propagates.

No change to the success path.
