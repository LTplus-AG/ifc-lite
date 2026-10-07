---
"@ifc-lite/geometry": minor
"@ifc-lite/load-trace": patch
"@ifc-lite/viewer": patch
---

Opening an IFC file now starts the main-thread engine and the load's geometry and pre-pass workers as soon as the load is requested, while the file is still being read, instead of after the read and cache lookup. The load takes these prewarmed workers rather than spawning its own, and still terminates every worker it used when it ends. Prewarmed workers a load never takes, for example on a cache hit, are terminated after a minute, and a resource-limit retry releases them at once. `?perf.warmPool=0` switches this off. New exports: `prewarmGeometryWorkers`, `prewarmMainThreadEngine`, `releaseWarmGeometryWorkers` and `warmGeometryWorkerPoolStats`.
