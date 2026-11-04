---
"@ifc-lite/pointcloud": minor
"@ifc-lite/viewer": patch
---

Large PLY point clouds are read twice instead of three times: once to scan bounds, once to decode. When `streamPointCloud` downsamples or picks a local origin it now calls a source's new optional `reopen()`, which keeps the first bounds scan. Worker sources without `reopen()` of their own are rebuilt inside the worker as before.

Cancelling a point-cloud load while the source is still opening now stops the work promptly. Previously the cancel waited for the full bounds scan of a multi-GB PLY to finish.
