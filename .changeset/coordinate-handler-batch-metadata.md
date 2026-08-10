---
"@ifc-lite/geometry": patch
---

Surface `wasmRtcOffset` / `lengthUnitScale` on the batch `processMeshes` path, not just the incremental one.

`CoordinateHandler.processMeshes` — the path behind the synchronous `GeometryProcessor.process()` — returned its `CoordinateInfo` without the wasm metadata that `setWasmMetadata` had recorded, while the incremental/streaming path attached it. For a model whose placement the wasm pre-pass re-based (coordinates >10 km from the origin, e.g. a Vectorworks export with the IfcSite at absolute EPSG:25833 map coordinates, issue #2526), every sync-path consumer then read the re-based bounds as if they were absolute: the site offset — including its elevation — silently vanished from georeferencing math. All `processMeshes` returns (empty, no-shift, and shifted) now attach the same metadata the incremental path reports, via one shared helper.
