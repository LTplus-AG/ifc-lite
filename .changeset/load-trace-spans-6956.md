---
"@ifc-lite/load-trace": minor
"@ifc-lite/geometry": minor
"@ifc-lite/viewer": patch
---

Load-trace spans (#6956). New `@ifc-lite/load-trace` package: a per-load span tree spanning the main thread and its workers (worker spans are aligned by `performance.timeOrigin`), mirrored into User Timing as `ifc:<name>` measures and exportable as Chrome-trace JSON; disabled tracing is a no-op. `@ifc-lite/geometry` accepts a `trace` option on `processAdaptive` / `processParallel` and records the worker pool, first batch, shard scan/stitch and pre-pass phases on it, with worker-side spans for init, shard scans, the pre-pass, style slices and the first geometry chunk. The viewer records the cold-open and cache-hit milestones under `?perfTrace=1` and exposes them on `window.__IFC_LITE_LOAD_TRACE__`; console logs are unchanged.
