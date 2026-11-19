---
"@ifc-lite/renderer": patch
---

Selection and hover highlight from the colour batches (#10264 S3). A batch holding a selected entity is drawn again from its own GPU buffers for the highlight and the selection outline, keeping only the highlighted entities per fragment against a shared GPU id table; the hover outline does the same for the hovered entity. Entities held by batches no longer get highlight copies built from CPU geometry, so the highlight survives a scene whose CPU geometry has been released. An item-level selection keeps its exact copy while the CPU geometry is in memory, and an entity whose batches cannot all draw it (evicted, ambiguous across federated models, or while a larger id table awaits WebGPU's confirmation) keeps the copies, so nothing is highlighted in part. No public API changes.
