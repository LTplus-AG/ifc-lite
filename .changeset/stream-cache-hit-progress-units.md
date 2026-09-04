---
'@ifc-lite/server-bin': patch
---

`progress` events on `POST /api/v1/parse/parquet-stream` reported different units on a cache hit than on a miss (#3897). A live parse reports the pipeline's geometry JOB counts (`processed_jobs` / `total_jobs`); the cached replay counted the meshes it emitted, and a job can produce several meshes or none, so the same file streamed `0/3, 3/3` when parsed and `0/4, 4/4` when replayed. `start.total_estimate` had the same split. The live path now caches its per-batch job checkpoints beside the geometry and the replay emits those, so a hit and a miss report the same numbers. Entries cached before the sidecar existed have no job counts to replay and keep the old mesh-unit behaviour.
