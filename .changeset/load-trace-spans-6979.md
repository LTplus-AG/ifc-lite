---
"@ifc-lite/load-trace": minor
"@ifc-lite/parser": minor
"@ifc-lite/renderer": minor
"@ifc-lite/viewer": patch
---

Load tracing (`?perfTrace=1`) now covers the parser worker and the post-stream phases. `@ifc-lite/load-trace` adds `createWorkerPhaseTrace` for spans inside one long worker handler. `WorkerParser.parseColumnar` takes an optional `trace` and records `parser.worker` with the worker's `parser.parse`, `parser.entityIndexWait`, `parser.wasmInit`, per-phase `columnar.*`, `parser.spatialReady.serialize` and `parser.transport.serialize` spans under it, plus the main-thread `parser.hydrate`. `Scene.flushPending` and `Scene.finalizeStreamingAsync` take an optional trailing `trace` and record `scene.flushPending` and `scene.finalize` (with `scene.finalize.regroup`). The viewer records streaming batches, camera fit and refit, queue drain, instanced shard decode/upload, the first placed BVH build and the first tier-1 search index on the load that produced them. With tracing off every call site stays a no-op.
