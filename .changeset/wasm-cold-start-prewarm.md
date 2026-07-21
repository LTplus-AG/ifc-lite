---
'@ifc-lite/geometry': minor
---

Add `prewarmSharedWasmModule` so hosts can start the engine binary's fetch + compile before a file is opened.

The ~3.9 MB wasm (~1.3 MB brotli) was fetched lazily by `processParallel`, putting the entire download between "user picks a file" and "first geometry". On a ~4 Mbit link that measured 2535 ms of dead wait for a 225 KB model. The compile is memoised per resolved binary URL, so a prewarmed module is simply awaited by the subsequent load, and a failed prewarm degrades to today's behaviour.
