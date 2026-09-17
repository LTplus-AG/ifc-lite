---
"@ifc-lite/geometry": minor
"@ifc-lite/viewer": patch
---

A single element whose geometry never finishes no longer has to fail the whole load with "Geometry stream stalled". `processAdaptive` and `processParallel` accept a new opt-in `hungJobTimeoutMs` (use `DEFAULT_HUNG_JOB_TIMEOUT_MS`, 45 s). With it, the parallel pool replaces a worker stuck inside one geometry call, re-runs that call one element at a time, and skips only an element that stays silent for twice the budget. It reports those elements on `complete.skippedHungElements` (express ids and counts by IFC type) and keeps the replaced worker's diagnostics. Recovery is off unless requested, so a consumer that does not read `skippedHungElements` never receives a partial model. A new `signal` option terminates the worker pool when a consumer abandons the stream, which `return()` alone could not do while the stream waited on a silent worker. The viewer opts in, tells the user which element types were left out, never caches a partial model, and aborts the pool when it closes a stream.
