---
"@ifc-lite/server-client": minor
"@ifc-lite/lists": minor
---

Server-parse path now resolves Type-level properties/QTOs in Lists/Schedules identically to the in-browser (WASM) path (#1751), and adds a `Type` list column showing the element's IfcTypeProduct name (#1754).

Two things were broken on the server path and are fixed together:

- **Every text/boolean property was garbled.** The server's property extractor only matched bare strings/numbers, so STEP's typed wrappers (`IFCLABEL('X')`, `IFCBOOLEAN(.T.)`) fell through to a Rust `Debug` string typed `"unknown"`. It now mirrors the WASM `parsePropertyValue` — resolving canonical value + kind (`string`/`boolean`/`logical`/`integer`/`real`) and carrying the raw measure tag (`data_type`, e.g. `IFCLENGTHMEASURE`) — so numeric cells sum/sort and unit conversion (#1573) works. `@ifc-lite/server-client`'s `Property` gains an optional `data_type` (data-model payload bumped to v3).

- **Type sets never reached the client.** The server dropped `IfcRelDefinesByType` and never read a type's `HasPropertySets`. It now emits the type→element relationship plus a synthetic `TYPEHASPROPERTYSETS` edge per type-owned set, and the viewer merges those onto the type id (own sets first, name-deduped) — matching the WASM path exactly.

`@ifc-lite/lists` adds a `Type` attribute column and an optional `getEntityDefiningTypeName` accessor on `ListDataProvider`. A cross-path parity test asserts identical `executeList` rows, column metadata, and group sums for the same file through both parse paths.
