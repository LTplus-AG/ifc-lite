---
"@ifc-lite/geometry": patch
---

`prewarmSharedWasmModule` now returns a promise that resolves `true` once the engine module has compiled (`false` when it could not), so a host can time the prewarm. It still never rejects, and callers that ignore the result behave as before.
