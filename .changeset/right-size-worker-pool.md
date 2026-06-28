---
"@ifc-lite/geometry": patch
---

Right-size the geometry worker pool: narrow the small-file fast path from 8-64 MB
to <= 24 MB.

A 10-core browser worker-count sweep found the 8-64 MB `cores - 2` band (#1258)
over-provisioned workers for decode- and heavy-tail-bound models in the 24-64 MB
range. Because each worker is a separate WASM instance that re-decodes the file
into its own heap and rebuilds the entity index, 8 workers ran 20-30% SLOWER than
4 at up to ~5x the peak WASM memory (e.g. ~882 MB vs ~161 MB on a 54 MB model).
Measured improvements at the new auto-selected count: a 34 MB heavy-tail model
7.2s -> 5.7s (-21%), a 54 MB decode-bound model 14.4s -> 11.7s (-19%) at roughly
half the peak memory. Genuinely small compute-bound steel (a 20 MB model with
~26k boolean jobs) still benefits from `cores - 2` (17.0s vs 22.9s at 4 workers),
so the fast path is kept for <= 24 MB where the per-worker re-decode/memory cost
is low; > 24 MB now falls through to the existing per-core bandwidth cap (4 on a
10-core host). The > 512 MB bandwidth caps and the memory-budget cap are
unchanged. A fully workload-aware count (using the real prepass job/CSG density
instead of the file-size proxy) is a follow-up.
