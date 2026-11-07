---
"@ifc-lite/renderer": patch
---

A fully visible colour batch drawn only as sub-batches, per X-Ray alpha or as promoted and remaining halves of a transparent batch with mixed colour overrides, no longer keeps its own GPU buffers resident. The GPU residency budget can now evict them, and the batch is not rebuilt while it stays split. A cold batch that will split gets back only its CPU pieces.
