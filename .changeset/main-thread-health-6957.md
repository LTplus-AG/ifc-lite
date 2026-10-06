---
"@ifc-lite/load-trace": minor
"@ifc-lite/geometry": patch
"@ifc-lite/renderer": patch
"@ifc-lite/parser": patch
"@ifc-lite/cache": patch
"@ifc-lite/viewer": patch
---

Main-thread health and structural counters (#6957), all off unless load tracing is on (`?perfTrace=1`, benchmark runs). `@ifc-lite/load-trace` adds a realm-wide counter registry (`perfCounters`, `perfCount`, `perfTally`, `countCopy`) whose per-load deltas, plus every counter a worker posts back, land on `LoadTraceSnapshot.counters` / `.workerCounters`; a `long-animation-frame` / `longtask` monitor (`startFrameMonitor`) summarised per load and per innermost span as `.mainThread`; `accountWorkerMessages`, one wrapper counting a worker's messages, estimated structured-clone bytes, transferred and shared bytes per direction; and `meterTypedArrayArgs`, which counts the typed-array bytes handed to a wasm API object. The geometry pool, parser, scan and cache-compression workers go through that wrapper, geometry workers meter their wasm ingress and flush counters before the pre-pass worker is terminated, the renderer counts GPU buffer creations, uploaded bytes, `mergeGeometry` calls and finalize rebuilds, and the viewer counts store writes and notifications, full source copies and the per-append model-index re-spread. With tracing off each call site is one boolean test and every wrapper returns its target unchanged.
