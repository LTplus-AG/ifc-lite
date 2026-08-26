---
'@ifc-lite/data': patch
'@ifc-lite/export': patch
---

The Parquet `Type` column now names the IFC class the file declares, instead of the class its `IfcTypeEnum` value coalesces to.

`IfcTypeEnum` maps several STEP class names onto one value on purpose, so the viewer's scope chips show one chip per family: `IfcDoorStandardCase` shares `IfcDoor`, `IfcSlabStandardCase` shares `IfcSlab`, and `IfcDistributionFlowElement` and `IfcDistributionControlElement` both share `IfcDistributionElement`. `EntityTable.getTypeName` resolves through that enum and only falls back to the parsed name when the enum says `Unknown`, so a known-but-coalesced class never reached the fallback and `ParquetExporter` wrote the coalesced name. A nine-entity model exported `IfcDoor` twice for one `IFCDOOR` and one `IFCDOORSTANDARDCASE` line, `IfcDistributionElement` three times for three different classes, and `IfcSlab` for an `IFCSLABSTANDARDCASE` — while `IfcWallStandardCase` came through intact only because it happens to hold its own enum value. The class is unrecoverable once written, and the archive disagreed with `StepExporter`, which re-emits every class verbatim.

`EntityTable` gains an optional `getExactTypeName`, read through the new `exactTypeName(entities, expressId)` helper, which answers the declared class and falls back to `getTypeName` for table shapes that track no parsed names (server hydration, legacy cache reads). `getTypeName` itself is unchanged, so the ~90 grouping, search and display callers that depend on the coalescing — the scope chips among them — keep the answer they had.

CSV, JSON and ifcx exports read the class through other paths and still report the coalesced name; those are not addressed here.
