---
'@ifc-lite/renderer': patch
'@ifc-lite/viewer': patch
---

Preserve triangle topology for widely separated survey components by validating inherited and automatic f32 frames and precision-partitioning unsafe same-colour batches even when spatial chunking is disabled.
