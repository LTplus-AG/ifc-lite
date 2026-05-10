---
"@ifc-lite/parser": minor
"@ifc-lite/data": minor
"@ifc-lite/geometry": minor
---

**Parse IFC off the main thread.** The browser viewer now runs `IfcParser.parseColumnar`
inside a dedicated `WorkerParser` worker that shares the source bytes via
`SharedArrayBuffer` with the existing geometry workers. Parse and geometry
streaming run in parallel without contending for main-thread time, cutting
upload-to-interactive wall-clock by roughly 2× on medium-to-large files.

New public APIs:

- `@ifc-lite/parser`
  - `WorkerParser` (browser-only, exported from `@ifc-lite/parser/browser`)
  - `data-store-transport`: `toTransport(store)` / `fromTransport(payload, source)`
    plus the `DataStoreTransport` payload type. Lets any consumer ship a
    fully-typed `IfcDataStore` across a `postMessage` boundary with the
    typed-array buffers in the transfer list and closures rebuilt on receipt.

- `@ifc-lite/data`
  - `entityTableFromColumns` / `entityTableToColumns`
  - `propertyTableFromColumns` / `propertyTableToColumns`
  - `quantityTableFromColumns` / `quantityTableToColumns`
  - `relationshipGraphFromColumns` / `relationshipGraphToColumns`
  - `relationshipEdgesFromColumns`, `relationshipGraphFromEdges`, `buildCSR`
  - `StringTable.fromArray(strings)`
  - `EntityTable.rawTypeName` is now exposed (optional column) so the
    unknown-type display fallback round-trips through column transports.

- `@ifc-lite/geometry`
  - `processParallel(buffer, coordinator, sharedRtcOffset?, existingSab?)`:
    new optional `existingSab` parameter so the geometry workers can reuse
    a SAB the caller already populated (e.g. for the parser worker).
  - `GeometryProcessor.processParallel` and `processAdaptive` accept the
    same `existingSab` to plumb the SAB through.
  - `StreamingGeometryEvent` gains a `workerMemory` variant carrying
    per-worker WASM heap + mesh-byte counts for memory accounting.

The viewer auto-falls back to the in-process `IfcParser` when
`crossOriginIsolated` is `false` or the worker spawn throws, so behavior is
unchanged in environments without SAB.
