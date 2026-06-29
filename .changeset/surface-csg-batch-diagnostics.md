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

`processGeometryBatchPartitioned` (the default viewer path) now exposes
`totalCsgFailures` and `productsWithFailures` getters on `PartitionedBatch`. The
geometry worker sums them across batches and reports a single per-load total on the
completion message plus a one-line console summary, matching the native
`ProcessingResponse`.
