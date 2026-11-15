---
"@ifc-lite/sdk": minor
"@ifc-lite/cli": minor
"@ifc-lite/mcp": minor
"@ifc-lite/export": minor
"@ifc-lite/parser": minor
---

Read and write georeferencing from the SDK, the CLI and the MCP server.

- SDK: `bim.georef.get/set/update/remove` on headless contexts, plus `readGeoreferencing(store)`. Each write is one undo step: `mutation_undo` takes a whole write back, never part of one, and `get()` always reports what the export contains. IFC4/IFC4X3 write `IfcProjectedCRS` + `IfcMapConversion` (IFC4X3 with FactorX/Y/Z: `IfcMapConversionScaled`) through the exporter's existing georeferencing writer; IFC2X3 writes the `ePSet_MapConversion` / `ePSet_ProjectedCRS` property sets. Writes fail closed with a `GeoreferencingError` naming the missing input: no CRS, map unit, scale or factor is guessed, a model without a representation context (IFC2X3: IfcSite) is refused, an existing georeferencing is replaced only with `replace: true`, contradicting values are refused, and unknown keys are refused by `set` and `update` alike. A map unit is carried from an existing same-named CRS only when the reader resolved it. FactorX/Y/Z are accepted only for FILE_SCHEMA `IFC4X3` / `IFC4X3_ADD2` (not the IFC4X3 release candidates). `bim.export.ifc` throws when the exporter could write the session's georeferencing only in part. On IFC2X3, `Description` is written as IfcText and a CRS rename carries `ePSet_MapConversion.TargetCRS` along.
- CLI: `ifc-lite georef show|set|update|remove`; `info` reports the model's georeferencing.
- MCP: `georeferencing_write`; `georeferencing` now also returns the SDK shape as `georef`, including unsaved session writes.
- Export: `StepExporter` writes `IfcMapConversionScaled` when all three factors are requested and the output FILE_SCHEMA declares it (`IFC4X3` / `IFC4X3_ADD2`; otherwise a plain `IfcMapConversion` and a warning), and edits FactorX/Y/Z on an existing scaled conversion (Rust mutation-log writer in parity). New: `isExpressibleMapUnit`, `declaresMapConversionScaled`, and `stats.georeferencingWarnings` (the warnings of the georeferencing phase).
- Parser: the on-demand georeferencing reader now resolves a conversion-based MapUnit through its IfcMeasureWithUnit, so `US SURVEY FOOT` (as ifc-lite itself writes it) no longer reads back as METRE. `ProjectedCRS.mapUnitResolved` (new, optional) says whether `mapUnit` was read or is the METRE default for a unit the reader could not resolve, and an `IfcConversionBasedUnitWithOffset` MapUnit with a zero offset now resolves like its supertype (the Rust reader too).
