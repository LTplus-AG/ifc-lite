---
"@ifc-lite/diff": minor
---

Switch all 23 existing public diff operations to the independent Rust/WASM engine while preserving their synchronous signatures after explicit initialization. Add `initDiff` and `initDiffSync`; applications must initialize before comparison, fingerprint, lineage, or sidecar operations. Remove the superseded TypeScript engine from published output and retain it solely as an independent test oracle.

While asynchronous initialization is in progress, `initDiffSync` throws; await `initDiff()` instead. Failed initialization remains retryable, and both initializers are no-ops after success.
