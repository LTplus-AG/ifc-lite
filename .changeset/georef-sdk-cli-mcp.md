---
"@ifc-lite/sdk": minor
"@ifc-lite/cli": minor
"@ifc-lite/mcp": minor
"@ifc-lite/export": minor
"@ifc-lite/parser": patch
---

Read and write georeferencing from the SDK, the CLI and the MCP server.

- SDK: `bim.georef.get/set/update/remove` on headless contexts, plus `readGeoreferencing(store)`. IFC4/IFC4X3 write `IfcProjectedCRS` + `IfcMapConversion` (IFC4X3 with FactorX/Y/Z: `IfcMapConversionScaled`) through the exporter's existing georeferencing writer; IFC2X3 writes the `ePSet_MapConversion` / `ePSet_ProjectedCRS` property sets. Writes fail closed with a `GeoreferencingError` naming the missing input: no CRS, map unit, scale or factor is guessed, a model without a representation context (IFC2X3: IfcSite) is refused, an existing georeferencing is replaced only with `replace: true`, and contradicting values are refused.
- CLI: `ifc-lite georef show|set|update|remove`; `info` reports the model's georeferencing.
- MCP: `georeferencing_write`; `georeferencing` now also returns the SDK shape as `georef`, including unsaved session writes.
- Export: `StepExporter` writes `IfcMapConversionScaled` when all three factors are requested and edits FactorX/Y/Z on an existing scaled conversion (Rust mutation-log writer in parity); `isExpressibleMapUnit` is exported.
- Parser: the on-demand georeferencing reader now resolves a conversion-based MapUnit through its IfcMeasureWithUnit, so `US SURVEY FOOT` (as ifc-lite itself writes it) no longer reads back as METRE.
