---
"@ifc-lite/renderer": patch
---

A transparent colour batch whose entities only partly carry a colour override no longer vanishes after CPU geometry is released, and a colour-merged piece in such a batch is no longer drawn twice. The promoted/remaining split now checks the same `canPartitionBatch` gate as the X-Ray alpha split. A batch that fails the check draws whole at its native transparent routing, as it did before the split existed. The visible subset of a hidden or isolated batch follows the same rule.
