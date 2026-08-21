---
"@ifc-lite/renderer": patch
---

Fix `RangeError: Map maximum size exceeded` when building LOD for a very large batch (#3028).

`simplifyIndicesByClustering` memoized cluster representatives in a `Map` keyed per vertex. V8 caps a `Map` at 2^24 - 1 entries, so a batch referencing more than ~16.7 million distinct vertices threw, which rejected the whole geometry finalize and left the viewer showing streaming fragments.

That is reachable from a legitimate file rather than needing a hostile one. Bucket size is bounded in bytes against the GPU's `maxBufferSize`, which is deliberately requested at the adapter maximum so multi-GB models render, and buckets group by spatial cell and colour rather than by model, so a dense federated load co-batches.

The memo is now an `Int32Array` keyed by vertex index: the same lookup, 4 bytes per vertex flat instead of the Map's per-entry overhead, and no ceiling below the index space. The cell map, which is bounded by occupied cells rather than vertices, now bails through the function's existing "simplification does not pay" contract if it ever approaches the same cap, so callers fall back to full-detail LOD0 instead of losing the batch.
