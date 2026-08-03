---
'@ifc-lite/parser': minor
'@ifc-lite/data': minor
---

**schema**: `isKnownType` and `normalizeIfcTypeName` now answer for every bundled IFC schema (IFC2X3 + IFC4 + IFC4X3), not just the IFC4_ADD2_TC1 codegen pin (issue [#2003](https://github.com/LTplus-AG/ifc-lite/issues/2003)).

Both read `isKnownEntity` / `getEntityMetadata`, which are generated from the pin and answer "unknown" for any class it does not carry. Measured on the bundled tables: 251 real classes, including 100 `IfcObjectDefinition` ones — the IFC2X3 classes IFC4 dropped (`IfcMove`, `IfcScheduleTimeControl`, `IfcSpaceProgram`, `IfcServiceLife`, `IfcOrderAction`, …) and the IFC4X3 infrastructure classes it never had (`IfcRoad`, `IfcSignal`, `IfcAlignment`, `IfcRailway`, `IfcMarineFacility`, …). `normalizeIfcTypeName` had the same blind spot from the other side: it fell through to "preserve as-is", so `'IFCROAD'` stayed `'IFCROAD'` instead of canonicalizing to `'IfcRoad'`.

Both now resolve against the schema union first and fall back to the pin, the same order `getInheritanceChainAcrossSchemas` uses.

`isKnownType` is still a guard, not a pass-through. Typos (`IfcWal`, `IfcRoadd`), vendor extensions, and the 138 EXPRESS *defined types* the upstream SchemaInfo tables carry as entity rows are all still rejected — 132 named by the cross-schema `IFC_DATA_TYPES` table (`IfcLengthMeasure`, `IfcBoolean`, `IfcCountMeasure`, …) and 6 more that only the pin's own `SCHEMA_REGISTRY.types` map names (`IfcBinary`, `IfcArcIndex`, `IfcLineIndex`, `IfcComplexNumber`, `IfcCompoundPlaneAngleMeasure`, `IfcPropertySetDefinitionSet`). None of the 776 pinned classes appears in either table, so no IFC4 answer changes.

It answers known-ness, not instantiability: abstract supertypes (`IfcProduct`, `IfcRoot`) are real IFC classes and still answer `true`, exactly as they did before. Rejecting those is a separate, pre-existing question — `main` already accepts 123 of them — tracked in [#2035](https://github.com/LTplus-AG/ifc-lite/issues/2035).

**data**: exports `IFC_DATA_TYPES`, the raw bundled defined-type table, for the same reason the `ENTITIES_*` tables are exported: a synchronous guard deciding "is this a class I may instantiate?" has to subtract the defined types, and the existing `findDataType` is async.
