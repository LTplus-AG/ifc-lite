---
'@ifc-lite/geometry': patch
'@ifc-lite/parser': patch
---

Two Web Worker resource leaks, same shape as the confirmed `collab`/`collab-server`
leaks: a `Worker` is spawned, a fallible step runs right after it (a
`postMessage` structured-clone), and the failure path had no handle to the
worker it had already created.

`packages/geometry/src/geometry-parallel.ts`: the process-worker pool's
init loop (spawn, then `postMessage({type:'init', ...})` and five more
`set-*` messages per worker) ran before the function's own try/finally, so
a `postMessage` throw partway through the loop (a `wasmModule`
structured-clone failure is the realistic trigger — the same class of
error `dispatchJobsChunkInternal` already guards against) left every
worker spawned so far un-terminated; the finally that owns teardown for
the rest of the pipeline never saw the throw. The loop now has its own
try/catch that terminates every worker pushed to `workers` so far before
rethrowing.

`packages/parser/src/scan-worker-inline.ts`: `scanEntitiesInWorker`
declared its `Worker` with `const` inside the try that also calls
`postMessage`, so the catch block — which only had `reject(err)` — could
not reach it if `postMessage` threw after construction (a detached-buffer
or memory-pressure clone failure). The `worker` binding now lives outside
the try so the catch can terminate it before rejecting.
