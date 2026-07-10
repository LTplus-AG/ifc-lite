---
"@ifc-lite/wasm": patch
---

Binary-search the shared entity-index columns instead of building a per-worker
hashmap (#1682).

Every wasm worker (N geometry workers + prepass + parser) that receives the
pre-scanned entity index via `setEntityIndex` used to materialize a private
`FxHashMap<u32, (usize, usize)>`. hashbrown rounds the bucket count up to the
next power of two, so a 19.1 M-entity model allocates `2^25` buckets ≈ 436 MB
**per worker realm**, rebuilt in every realm. The delivered representation is
already three `u32` columns (ids / starts / lengths).

The worker now stores a compact `ColumnarEntityIndex` — three sorted `u32`
columns with a `binary_search` lookup — ≈ 229 MB for the same model, no
power-of-two rounding and no `(usize, usize)` widening. The producer emits the
columns already sorted by id, so consumers take an O(n) already-sorted check
and skip the argsort; a producer that ever emits out of order is handled by a
one-time stable argsort. Duplicate express ids resolve last-in-file-order-wins,
matching the previous `FxHashMap::insert` semantics.

Measured on the native per-element geometry profiler (`csg_model_profile`,
profiling build, best of 3), binary search is **faster**, not a regression,
with byte-identical triangle counts:

| model | FxHashMap | columnar | Δ geometry |
|-------|-----------|----------|------------|
| schependomlaan (49 MB) | 115 ms | 94 ms | -18% |
| Holter Tower (177 MB, 60,669 elems) | 827 ms | 711 ms | -14% |
| O-S1-BWK (342 MB) | 517 ms | 457 ms | -12% |

Native / server paths that can exceed the 4 GiB `u32` offset ceiling keep the
`usize`-carrying `EntityIndex` hashmap unchanged.
