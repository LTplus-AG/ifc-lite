---
"@ifc-lite/renderer": patch
---

Deleted GPU-instanced occurrences no longer reappear. A delete now marks its instance records hidden in the CPU instance data as well as on the GPU, so device recovery and model moves, which re-upload whole instance buffers, keep them hidden, and the opaque instanced pass keeps its discarding shader while any such record exists (until its model is unloaded, since slots are not reclaimed).
