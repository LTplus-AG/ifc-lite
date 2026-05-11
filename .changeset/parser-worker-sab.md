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
  - `processParallel(buffer, coordinator, sharedRtcOffset?, existingSab?, options?)`:
    `existingSab` lets the geometry workers reuse a SAB the caller already
    populated. The new fifth argument is `ProcessParallelOptions` with:
    - `onEntityIndex(ids, starts, lengths)`: invoked once the streaming
      pre-pass has built the entity index. Hosts forward the SAB-shared
      columns to `WorkerParser.setEntityIndex(...)` so the parser skips
      its own ~10 s WASM scan.
    - `useSingleController`: opt-in (off by default) to the experimental
      single-controller + wasm-bindgen-rayon path. See
      `docs/architecture/single-controller-rayon-design.md` §12 for the
      post-mortem on when this helps and when it regresses.
  - `GeometryProcessor.processParallel` and `processAdaptive` accept the
    same options to plumb them through.
  - `StreamingGeometryEvent` gains a `workerMemory` variant carrying
    per-worker WASM heap + mesh-byte counts for memory accounting.

- `@ifc-lite/parser` (additions on top of the worker entry above)
  - `WorkerParser.setEntityIndex(ids, starts, lengths)`: hand a pre-built
    entity index to the worker's `IfcAPI`. Pairs with the geometry
    pre-pass's `onEntityIndex` callback above.
  - `WorkerParserOptions.waitForEntityIndex`: when true, the worker blocks
    its WASM scan until `setEntityIndex` arrives (60 s watchdog falls
    back to the regular scan if it never does).
  - `IfcParser.parseColumnar`: signature widened to accept
    `ArrayBuffer | SharedArrayBuffer` (was `ArrayBuffer`); the SAB-backed
    parser worker no longer needs an `as unknown as ArrayBuffer` cast.

The viewer auto-falls back to the in-process `IfcParser` when
`crossOriginIsolated` is `false` or the worker spawn throws, so behavior is
unchanged in environments without SAB.
