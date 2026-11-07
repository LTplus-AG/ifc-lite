---
"@ifc-lite/renderer": patch
---

Clearing X-Ray, hide or isolate over many batches that the GPU residency budget evicted no longer leaves gaps in the model. Past the per-frame rebuild cap, a batch now draws last frame's sub-batches until the time-sliced queue rebuilds it, instead of disappearing until then. A capture render no longer rebuilds an evicted batch whose sub-batches were on screen: it draws the same sub-batches, or rebuilds the batch in that frame when the capture shows it whole. An appearance preview of an element in an evicted batch builds its new batches from the CPU pieces without first rebuilding the old batch. Frame stats now count a batch whose CPU pieces are still loading from disk as not resident.
