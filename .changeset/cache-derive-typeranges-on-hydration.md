---
"@ifc-lite/cache": patch
---

Derive `EntityTable.typeRanges` from the type column when hydrating a cache, instead of trusting the serialized triples.

`typeRanges` changed meaning from `start + count` to a `[firstRow, lastRow + 1]` span. `FORMAT_VERSION` was not bumped, and correctly so — `readHeader` throws only on `version > FORMAT_VERSION`, so caches at the current version are accepted by design and a bump would change nothing for them. The consequence is that the stored triples carry either meaning with nothing to tell them apart, and `readEntities` passed them straight to the public `EntityTable.typeRanges`. For a type whose rows are interleaved with another's — the ordinary case in IFC — the old form named a range that stopped short of the type's own later rows; the two forms coincide only when a type happens to be contiguous, which is what kept the divergence out of sight.

`readEntities` already built per-type index arrays for `getByType()`, which is why that path was never affected. The spans are now derived from those same arrays, so one structure feeds both. The serialized field is still written, and still read to keep the byte layout unchanged, but its value no longer reaches the table.

This closes the window for caches already on disk rather than fixing a regression: the mixed meaning existed before the semantics changed and is not damage that change caused.
