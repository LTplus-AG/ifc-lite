---
"@ifc-lite/geometry": patch
---

Fix the geometry stream watchdog killing healthy loads on CSG-dense models (issue #1097). The mid-stream stall deadline scaled with file size (MB), but the real silent window is the wall-time of one synchronous `processGeometryBatch` call, which tracks CSG density per job — uncorrelated with megabytes. A ~275 MB dense steel model (190k+ meshes) tripped its own `15s + MB*30 = 23s` deadline mid-stream.

- The worker now sizes each `processGeometryBatch` call adaptively to a wall-time budget (`batch-sizing.ts`) instead of a fixed 512-job count, so a single call stays ~2s regardless of CSG density and heartbeats flow continuously.
- The subsequent-batch watchdog deadline is now a fixed grace (30s browser / 20s desktop), decoupled from file size; the first-batch deadline still scales with size for the single-threaded pre-pass.
- The binary-split recovery path emits a liveness heartbeat before recursing/re-initialising, and a recovery WASM re-init now replays the pre-built entity index instead of falling back to an O(file) re-scan, closing the secondary silent window.
