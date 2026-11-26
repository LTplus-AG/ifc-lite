---
"@ifc-lite/geometry": patch
"@ifc-lite/wasm": patch
---

Out-of-core geometry ingest (`?perf.ooc`, off by default) keeps the parallel sharded pre-pass instead of falling back to the single-worker scan, so its first frame is no longer later than the whole-file path's. Each shard scan copies only its own byte range into the worker (never the whole file), the sharded pre-pass emits the sparse facts, its sorted entity index and the styles itself, and out-of-core ingest now applies only past the small-file tier (10 MiB), where the workers' file copies it removes are worth it.
