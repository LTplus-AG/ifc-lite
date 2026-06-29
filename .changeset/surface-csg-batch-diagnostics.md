---
"@ifc-lite/wasm": minor
"@ifc-lite/geometry": minor
---

Add a typed `GeometryDiagnostics` contract for CSG / opening diagnostics.

The WASM batch path already computed a rich CSG / opening diagnostic summary
(opening classification, per-reason failure breakdown, per-host detail, silent
rectangular no-op detection, rect_fast fast-path engagement) and then discarded it,
logging only to the browser console. A package consumer could not subscribe to it
without scraping console output.

This surfaces it as a typed, serializable contract:

- `rust/geometry` exposes a `GeometryDiagnostics` struct and a wasm-free
  `aggregate_diagnostics` built from the drained router data, so the same shape is
  producible on the WASM and native paths from a single drain.
- The WASM `MeshCollection` exposes the per-batch `diagnostics` as a JS object
  (replacing the earlier two scalar getters).
- `@ifc-lite/geometry` exports the `GeometryDiagnostics` type and
  `mergeGeometryDiagnostics`, and surfaces a per-load `diagnostics` object on the
  streaming `complete` event: the geometry worker merges per-batch diagnostics
  across batches and the parallel loader merges across workers, logging one
  aggregate console summary.
- The viewer reads `event.diagnostics` and logs a concise summary when CSG failures
  or silent no-ops occur; the full typed object rides the streaming event for a UI
  or telemetry consumer to subscribe to.

`totalCsgFailures` and the classification counts are exact; `productsWithFailures`,
`hostsWithOpenings` and `silentNoOps` are batch-summed upper bounds. The fields are
forwarded on the parallel WASM load path only; native `ProcessingStats` parity (the
processor aggregates per `local_router`) and a CLI `diagnose-geometry` command are
follow-ups.
