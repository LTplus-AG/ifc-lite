---
"@ifc-lite/renderer": patch
---

A colour batch drawn only as a partial sub-batch (hide or isolate) no longer keeps its full GPU buffers resident. The GPU residency budget can now evict them, because the sub-batch draws from its own buffers; the batch's CPU pieces stay warm for the sub-batch, picks and snaps. A cold parent is restored only to warm for its sub-batch. Sub-batches cut from a replaced or cold-demoted parent now free their GPU buffers.
