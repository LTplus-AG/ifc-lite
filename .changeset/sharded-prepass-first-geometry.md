---
"@ifc-lite/geometry": minor
"@ifc-lite/wasm": minor
---

Sharded pre-pass: parallel entity-index scan + parallel styles resolution for large fresh loads (`__IFC_LITE_SHARD_SCAN`).

Idle geometry workers scan byte shards of the file (`scanEntityIndexShard`, wrapping the byte-identical `scan_shard` primitive plus a per-record prepass-class column), the host stitches the full entity index in under a second on a 19M-entity model, styled-item spans resolve as parallel slices on the workers (`resolveStyledItemsShard`, first-wins merge in file order), support spans come from the class column, and the canonical flatten (`finalizePrepassStyles`) seeds the merged styled maps BEFORE the material-chain resolution so output matches the serial resolver. The pre-pass itself starts after the stitch with the prebuilt index (`buildPrePassStreamingSharded`): no inline index build, full-index RTC resolution, no redundant index export. Stream-end defers while job chunks are queued behind the asynchronously finalized styles event.

Measured on an 883 MB / 19.1M-entity CATIA model (3 workers): first visible geometry 14.3s -> 10.4s (-28%), stream complete 22.4s -> 15.4s (-31%), with identical final render stats. Flag off = the serial path, byte-for-byte.
