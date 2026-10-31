---
"@ifc-lite/renderer": major
---

Cut per-frame CPU during camera navigation. Colour-batch uniform blocks now live in a shared per-device arena (`BatchedMesh.uniformSlot` replaces `BatchedMesh.uniformBuffer`), so a moving camera uploads every drawn batch with one `queue.writeBuffer` per 256 KiB page instead of one per batch, and an unchanged block is not uploaded at all. Redundant `setPipeline` calls between consecutive batches are skipped, the drawing-buffer size reads the canvas layout only after a `ResizeObserver` report instead of forcing layout every frame, and the GPU residency budget check sums sizes before doing any eviction bookkeeping. `FrameStats.cpuMs` reports the frame's main-thread encode cost, excluding the `getCurrentTexture()` wait.
