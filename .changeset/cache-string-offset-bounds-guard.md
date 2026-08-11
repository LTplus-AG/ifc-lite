---
"@ifc-lite/cache": patch
---

`readStrings` now rejects a StringTable section whose offset table isn't non-decreasing instead of silently mis-decoding it.

The read loop sliced each string out of the shared data blob with `data.subarray(offsets[i], offsets[i + 1])`. `subarray` doesn't throw when a range is out of order or runs past the blob — it saturates — so a corrupt or hand-crafted offset table (disk corruption, a truncated transfer) could make one string silently absorb bytes belonging to the next string (or decode as empty) instead of failing loudly. This is the same "declared length trusted without a bounds check" shape already fixed for the entity-index and geometry-chunk sections' directories. A validly-written table's offsets are always non-decreasing and end at the data blob's length, so this guard rejects only corruption.
