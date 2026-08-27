---
'@ifc-lite/cli': patch
---

`ifc-lite export --format csv` and `--format json` now name the IFC class the file declares in the `Type` column, instead of the class its `IfcTypeEnum` value coalesces to.

`IfcTypeEnum` maps several STEP class names onto one value on purpose, so the viewer's scope chips show one chip per family: `IfcDoorStandardCase` shares `IfcDoor`, `IfcSlabStandardCase` shares `IfcSlab`, and `IfcDistributionFlowElement` and `IfcDistributionControlElement` both share `IfcDistributionElement`. `EntityTable.getTypeName` resolves through that enum and only falls back to the parsed name when the enum says `Unknown`, so a known-but-coalesced class never reached the fallback. A CSV of the seven-element model in `export.exact-type.test.ts` named an `IFCDOORSTANDARDCASE` line `IfcDoor`, an `IFCSLABSTANDARDCASE` `IfcSlab`, and two different distribution classes `IfcDistributionElement` — while `IfcWallStandardCase` came through intact, because it happens to hold its own enum value. That last one is what made the loss hard to notice: a consumer had no rule for which classes were trustworthy. The class is unrecoverable once written, and the export disagreed with the Parquet exporter and with `StepExporter`, which re-emit every class verbatim.

The `Type` column now reads through `exactTypeName` from `@ifc-lite/data`, the accessor the Parquet exporter already uses, so all three exporters answer the same class for the same line. A class no IFC schema declares still degrades to `Unknown` and is never invented into a name.

Selection is unchanged: `--type IfcDoor` still returns the `IFCDOORSTANDARDCASE` line — `--type` expands through `IFC_SUBTYPES`, not through the type enum — and `getTypeName` itself is untouched, so saved filters and the scope chips keep matching on the coalesced family name.

CSV and JSON also stop keeping two row builders for one column list. They used to delegate to the SDK's `bim.export.csv`/`.json` when every requested column was a native attribute and resolve columns locally only when a quantity or property column was asked for — which is how the `Type` column came to be wrong in both, by two separate routes. Rows are now built one way, through the resolver that already answered a strict superset of the SDK's columns, over the same entities and the same CSV escaper.
