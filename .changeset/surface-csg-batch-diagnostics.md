---
"@ifc-lite/wasm": patch
"@ifc-lite/geometry": patch
---

Surface per-load CSG-failure counts from the WASM batch geometry path.

Per-element CSG boolean failures (un-cut openings, emptied hosts, kernel fallbacks)
were computed by the producer and drained at the batch boundary into a console
warning, then discarded: the three batch exports returned mesh-only types, so no
programmatic signal reached the host. A silently-uncut model produced a wrong but
non-empty result with nothing the load pipeline could observe (only the native
server path returned `total_csg_failures` / `products_with_failures`).

The WASM `MeshCollection` (produced by both the flat and partitioned batch paths)
now exposes `totalCsgFailures` and `productsWithFailures` getters. The geometry
worker sums them across batches; the parallel loader aggregates the per-worker
totals and forwards them on the public streaming `complete` event (plus a one-line
console summary), so `loadFile` callers can observe a per-load total, matching the
native `ProcessingResponse`. `productsWithFailures` is a batch-summed upper bound.
