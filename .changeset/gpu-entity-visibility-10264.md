---
"@ifc-lite/renderer": patch
---

Hide and isolate on the GPU (#10264 S2). A colour batch with some entities hidden or isolated away is drawn whole from its own buffers, and its hidden entities are discarded per fragment against a shared GPU id table, in the colour and shadow passes and in batch picking. The renderer no longer cuts a sub-batch from CPU geometry to hide entities, so visible batchmates keep drawing and casting shadows even when a scene's CPU geometry has been released. X-Ray and lens colour splits still use sub-batches of the visible entities where the geometry can be partitioned. A larger id table is bound only after WebGPU confirms its allocation; until then, or if it runs out of memory, partly hidden batches are left out rather than drawn with hidden entities, and a pick waits for the pending table. No public API changes.
