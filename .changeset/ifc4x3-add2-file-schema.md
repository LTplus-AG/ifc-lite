---
"@ifc-lite/data": minor
"@ifc-lite/create": patch
"@ifc-lite/export": patch
"@ifc-lite/wasm": patch
---

IFC4X3 output now declares `FILE_SCHEMA(('IFC4X3_ADD2'))`, the ISO 16739-1:2024 identifier, instead of the bare `IFC4X3` (#5351). ifc-lite already wrote IFC4X3_ADD2's attribute layouts. IfcOpenShell, and the buildingSMART Validation Service built on it, resolves the bare `IFC4X3` token to a later development schema whose layouts differ (`IfcTriangulatedFaceSet`/`IfcTriangulatedIrregularNetwork` put `Closed` before `Normals`, and `IfcMapConversion` has 10 attributes instead of 8), so it rejected conformant files because of the identifier alone.

This applies wherever ifc-lite chooses the identifier: `IfcCreator` with `Schema: 'IFC4X3'`, a `StepExporter` conversion to `IFC4X3`, a `MergedExporter` export to `IFC4X3`, and the Rust STEP and merged exporters (CLI, wasm) when given an explicit IFC4X3 target. A re-export that does not change schema still keeps the source file's own `FILE_SCHEMA` token verbatim. The Rust STEP exporter now follows the TypeScript rule for that too: an explicit target that does not change the schema family keeps the source token rather than writing the target label. The `schema` options still take `'IFC4X3'`, and ifc-lite reads both identifiers as IFC4X3.

`ProjectParams.FileSchemaIdentifier` (added in `@ifc-lite/create` 2.9.0 as the opt-in for this) is deprecated: IFC4X3 output is declared `IFC4X3_ADD2` without it, so it no longer changes the output. It still refuses a `Schema` other than `'IFC4X3'`, and is removed at the next major (#5562).

`@ifc-lite/data` exports `fileSchemaIdentifier(schema)`, which maps a schema family to the identifier a writer declares. It is the single source for the TypeScript writers.
