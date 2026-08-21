---
"@ifc-lite/renderer": patch
---

Fix a GPU buffer leak when `Scene.createBatchedMesh` fails partway through allocating a color batch.

The batch path allocates a run of GPU buffers per color batch — vertex, then index, then uniform, plus an optional LOD1 index buffer — with no cleanup if a later `device.createBuffer` call in the run throws. `device.createBuffer` genuinely throws in production (already documented elsewhere in this file as a real "createBuffer failed, size (...) is too large" `RangeError`), so a throw on, say, the index buffer left the vertex buffer created just before it allocated, written, and never referenced again: an orphaned GPU buffer per failed batch key, repeating on every retry through `rebuildPendingBatches`.

`appendChunkToNode` and `DeviationPipeline.uploadBvh` already guard this exact shape for their own paired allocations. `createBatchedMesh` now tracks every buffer it creates in the run and destroys all of them before propagating a later throw.
