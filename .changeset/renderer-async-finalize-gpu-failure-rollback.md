---
"@ifc-lite/renderer": patch
---

Fix `Scene.finalizeStreamingAsync` (the time-sliced twin of the synchronous streaming finalize, used for large/streamed models) so a mid-rebuild GPU failure — e.g. `createBuffer` OOM — no longer corrupts scene state.

The chunked rebuild runs across `setTimeout` continuations. A throw inside a later chunk is a separate macrotask, so it was never caught by anything and silently became an unhandled exception: the returned promise stayed unsettled forever, `finalizeInProgress` stayed stuck `true`, `streamingFragments` had already been emptied by the synchronous preamble with no way back, a live `partialBatchCache` entry (backing an active hide/isolate view) had already been destroyed before the rebuild could fail, and `pendingBatchKeys`/`streamingFragments` being cleared unconditionally defeated `releaseGeometryData`'s in-flight guard, letting it run concurrently and further corrupt GPU state.

The synchronous preamble and every chunked continuation now run under their own `try/catch` that mirrors `finalizeStreamingInner`'s existing contract: on failure, restore the previous `streamingFragments`/`batchedMeshes`, free only the GPU resources this attempt created (not anything still being rendered), leave partial-batch caches alone (they are only dropped once the rebuild has actually succeeded), always clear `finalizeInProgress`, and reject the returned promise so callers can observe the failure.
