---
'@ifc-lite/collab': patch
---

Fix `MemoryBlobStore.put()` keeping the FIRST upload's `uploadedAt` forever on a re-put of already-known content, instead of refreshing it like `IndexedDbBlobStore` and `HttpBlobStore` already do.

`put()` deduplicates by content hash and returned a fresh `meta` object either way, but only wrote it to the store on the first call for a given hash — a later `put()` of the same bytes handed the caller a meta claiming the current time while `stat()`/`get()` kept reporting the original upload time. Blob GC's grace-window check (`planBlobSweep` in `packages/collab/src/geometry/gc.ts`) reads that stored `uploadedAt` to decide whether an unreferenced-right-now blob is too young to sweep; a client re-references (and re-PUTs) a blob specifically to refresh that clock, per the race-protection this store's own sibling implementations already rely on. With the stale timestamp, a blob re-uploaded long after its original upload read back as old enough to sweep immediately.

`put()` now always writes the fresh `meta` (reusing the already-stored bytes rather than copying them again), matching `IndexedDbBlobStore` and `HttpBlobStore`.
