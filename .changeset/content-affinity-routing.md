---
"@ifc-lite/wasm": patch
"@ifc-lite/geometry": patch
---

Content-affinity worker routing for boolean-heavy models. The streaming geometry
pre-pass now tags each job with an affinity key — the exact 128-bit hash of the
element's representation geometry — and the parallel dispatcher routes all jobs
sharing a key to the same worker. Combined with the per-worker geometry-dedup
cache, each unique geometry is meshed once **per model** instead of once per
worker, so the workers partition the unique meshing instead of replicating it.
Restores fast loads on models exported without `IfcMappedItem` (e.g.
structural-steel detailers that emit thousands of byte-identical parts): a 19.5 MB
steel model drops from ~32 s to ≈ the dedup floor split across the worker pool.
Falls back to the previous interleaved split when no affinity data is present.
