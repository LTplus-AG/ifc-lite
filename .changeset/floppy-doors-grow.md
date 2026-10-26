---
"@ifc-lite/geometry": major
---

Remove the unaccepted opt-in worker warm-up experiment after its recorded-build comparison failed the full-readiness acceptance rule. Remove prewarmMainThreadEngine, prewarmGeometryWorkers, releaseWarmGeometryWorkers, warmGeometryWorkerPoolStats, GeometryWorkerPoolStats and the ProcessParallelOptions.workerPool option. Normal per-load workers and shared-module idle compilation remain.
