---
"@ifc-lite/renderer": patch
---

A colour batch drawn only as a partial sub-batch (some of its elements hidden or not isolated) now counts as drawn for GPU and host residency. It no longer ages out while on screen, so the GPU budget cannot evict it and the host budget cannot demote it to cold, which had dropped its pieces from CPU picking and snapping and restored them again on idle frames.
