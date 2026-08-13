---
"@ifc-lite/export": minor
---

Export `columnsToParquet`, the Arrow-to-Parquet conversion `ParquetExporter`
already used internally.

A caller with a table that is not an `IfcDataStore` view - the viewer's
per-element x per-zone quantity breakdown is the first - now writes Parquet
through the same type inference and the same Arrow IPC fallback, rather than a
second conversion beside it. `ParquetExporter` delegates to it, so there is one
implementation of the schema inference rather than two that agree today.

Also exports `isParquet`, and fixes the browser path: the package resolves to
its wasm-bindgen ESM build there, which does nothing until its default export is
awaited. Without that every browser call threw inside `Table.fromIPCStream` and
fell through to the Arrow IPC fallback silently, so a caller naming a file
`.parquet` wrote Arrow IPC into it. `isParquet` lets a caller name the file
after what it actually got.
