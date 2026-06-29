---
"@ifc-lite/wasm": minor
"@ifc-lite/geometry": minor
"@ifc-lite/server-client": minor
"@ifc-lite/cli": minor
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
- Native parity: the `rust/processing` geometry pass drains opening classification +
  per-host diagnostics from each per-element router and aggregates them through the
  same `aggregate_diagnostics`, attaching the full contract to
  `ProcessingStats.geometry_diagnostics` (the WASM bundle and the server emit it). The
  native streaming bridge forwards it onto the viewer `complete` event, so the
  native-only deployed viewer surfaces the same diagnostics as the WASM path, and
  `@ifc-lite/server-client` types it on the stats response.
- CLI / SDK surface: a new wasm `diagnoseGeometry(bytes)` binding runs the same
  `process_geometry` pass and returns only its `GeometryDiagnostics`, exposed as
  `GeometryProcessor.diagnoseGeometry` and an `ifc-lite diagnose-geometry <file.ifc>`
  command (human-readable report, or `--json` for the raw contract).

`totalCsgFailures` and the classification counts are exact; `productsWithFailures`,
`hostsWithOpenings` and `silentNoOps` are batch-summed upper bounds.
