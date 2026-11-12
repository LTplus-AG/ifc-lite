---
"@ifc-lite/viewer": patch
---

The stream-end camera refit no longer scans every mesh that arrived after the first-batch fit in one long task. Each streamed commit now folds its meshes into the robust fit bounds as it lands (`RobustFitBoundsAccumulator.scan()`), and the stream-end `update()` only sorts and trims. The fitted camera is unchanged: the accumulator folds in index order, so per-commit folding gives the same bounds as the one-shot update, and corpus tests check the pose, orbit anchor, scene bounds and fitted bounds on five models as loaded, translated, and with instanced shards.
