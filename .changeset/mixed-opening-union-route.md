---
"@ifc-lite/wasm": patch
---

Preserve opening-union semantics in mixed planar and residual cuts by applying mandatory overlap corrections after residual cutting. Retry unsafe compositions with the full opening set on the original host.

Skip residual work when mandatory correction support is disabled, and publish route diagnostics only for accepted compositions.
