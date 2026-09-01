---
'@ifc-lite/collab': patch
---

`createGeometry` no longer drops an explicit empty-string `blobHash` (`if (opts.blobHash)` was a truthiness check, so `blobHash: ''` never made it into the Y.Doc — the value was lost before there was anything to snapshot or seed back). `createGeometry` now checks `!== undefined`, matching the contract `upsertGeometry` already used.
