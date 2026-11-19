---
"@ifc-lite/renderer": patch
---

Deleted GPU-instanced occurrences no longer reappear. The scene now records the instance slots a delete hides, so the opaque instanced pass keeps its discarding shader while any such slot exists, and device recovery hides them again after rebuilding the instance buffers.
