---
"@ifc-lite/parser": minor
---

Add block-compressed storage for `IfcDataStore.source`, and let a source switch to it in place (#2183).

Inert in this release: nothing constructs a compressed source yet. It is the machinery plus its proofs, landing separately from the switch that turns it on so the switch can be reverted on its own.

The source is the whole IFC file, held resident for the model's lifetime because property and attribute reads slice it synchronously during React render. On a 342 MB model that is 327 MB of the viewer's main-thread heap. Deflating it into fixed-size blocks and inflating on demand trades that for ~67 MB plus a small cache.

Sized from measurement rather than taste, using fflate on the real 342.7 MB model:

| block | stored | saved | inflate p50 / p99 / max |
|---|---|---|---|
| 16 KiB | 77 MB | 265 MB | 0.08 / 0.25 / 1.70 ms |
| **64 KiB** | **67 MB** | **275 MB** | **0.18 / 0.35 / 0.40 ms** |
| 256 KiB | 64 MB | 278 MB | 0.69 / 0.93 / 1.32 ms |

64 KiB: 256 KiB buys 3 MB more for 3.8x the per-miss latency and a much worse tail, which is the wrong trade for a synchronous read on the render path.

The cache is 32 MB. A full per-entity sweep touches 5161 of 5229 blocks — essentially each block once, because expressId order tracks byte offset in STEP — so it is a sequential scan, not a thrash, and capacity is nearly irrelevant to it (32 MB and 256 MB are within 7%). Capacity is therefore sized for the interactive working set, where the worst measured case (a 1000-product selection) touches 500 blocks.

**The swap is in place, and that is load-bearing rather than stylistic.** `attachDataStoreAccessors` captures the accessor in a `BufferEntitySource` held for the store's lifetime, so `getEntity` reads through that object, while `getProperties` builds a fresh extractor from `store.source` on every call. Replacing the property instead of mutating the object would leave entities served from the old resident buffer and properties from the compressed one — both alive, nothing saved, and the two read paths silently disagreeing.

Fixed here for the same reason: `parseColumnar` built **two** accessors over the same bytes, one for `source` and one inside `BufferEntitySource`. Harmless while both are resident views; fatal once the source can compress, because the entity path would keep its own resident accessor and the original buffer would never be released. Measured both ways — with two accessors the buffer survives GC after a swap, with one it is collected.

New exports: `compressSource`, `compressSourceInPlace`, `shouldCompressSource`, `sourceBlockStats`, `COMPRESSION_MIN_BYTES`, `DEFAULT_BLOCK_SIZE`, `DEFAULT_CACHE_BYTES`, and the `CompressedSource`, `BlockedPayload`, `BlockStoreCounters` types. `sourceBytesFromTransferable` now rehydrates the `blocked` arm, so a source crosses a worker boundary as ~67 MB of blocks instead of 343 MB of bytes, with no inflation on either side.

Adds `fflate` as a dependency of `@ifc-lite/parser`; it was already a viewer dependency.
