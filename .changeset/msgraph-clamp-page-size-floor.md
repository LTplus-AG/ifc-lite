---
"@ifc-lite/source-msgraph": patch
---

Fix `clampPageSize` sending Graph a literal `$top=0` for a fractional sub-1 `limit`.

A `ListOptions.limit` between 0 and 1 (e.g. `0.5`) passed the function's `limit > 0` guard but then floored to `0` with no lower bound, producing a `$top=0` query parameter instead of "use at least one item". `source-dropbox`'s own `clampPageSize` already floors at 1 for the same case (and has a test pinning it); `source-msgraph`'s did not. Added the same `Math.max(1, ...)` floor, plus a `clampPageSize` test block and a real cross-page-boundary `listFiles` pagination test (mirroring `source-dropbox/test/provider.test.ts`'s own pagination test), which passed on the first correct run - no pagination bug found, just a coverage gap.
