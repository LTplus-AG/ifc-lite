---
"@ifc-lite/geometry": minor
"@ifc-lite/load-trace": patch
"@ifc-lite/viewer": patch
---

The opt-in `?perf.warmPool=1` experiment starts the main-thread engine and the load's geometry and pre-pass workers while an IFC file is being read. It defaults off pending performance acceptance. The load takes these prewarmed workers rather than spawning its own, and still terminates every worker it used when it ends. Unused prewarmed workers expire after a minute without repeated cache hits extending their lifetime. A resource-limit retry releases them at once and does not refill the pool. New exports: `prewarmGeometryWorkers`, `prewarmMainThreadEngine`, `releaseWarmGeometryWorkers` and `warmGeometryWorkerPoolStats`.
