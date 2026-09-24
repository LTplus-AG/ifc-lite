---
'@ifc-lite/renderer': patch
---

Keep the X-Ray resolution between frames while X-Ray, selection, visibility and colour overrides are unchanged. The renderer built a fresh `XRayAlpha` every frame, so an orbit with X-Ray or `ghostExceptIds` on walked every id of every batch and re-split the mixed batches on each frame. It now rebuilds only when the partial sub-batch epoch moves.
