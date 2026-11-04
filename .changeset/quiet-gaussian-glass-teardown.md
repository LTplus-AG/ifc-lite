---
"@ifc-lite/renderer": patch
---

Avoid reporting expected teardown failures as errors in the nearest-glass split: a layer-count readback aborted, or a depth-variant pipeline compile rejected, because the renderer was destroyed. The same failures while the renderer is live are still reported.
