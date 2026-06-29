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
worker sums them across batches; on the parallel WASM load path the loader
aggregates the per-worker totals, logs one console summary, and forwards them on the
public streaming `complete` event so `loadFile` callers can read a per-load total.

Scope: this is a data seam, no viewer UI consumes the event fields yet (the only
user-visible signal today is the loader's console summary). `productsWithFailures`
is a batch-summed upper bound, and the serial and native (non-parallel) load paths
do not carry the fields yet.
