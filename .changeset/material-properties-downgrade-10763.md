---
"@ifc-lite/wasm": patch
"@ifc-lite/export": major
---

**Breaking:** `convertStepLine` now returns `null` for an IFC4/IFC4X3 `IfcMaterialProperties` converted to IFC2X3 when it is called without the export's checks (the `enums` argument). It used to return the record unmapped. Without the export's records, its `Material` cannot be checked to be an `IfcMaterial`, so the record is left out. A caller that never handled `null` for this type must now.

On a downgrade to IFC2X3, IFC4/IFC4X3 `IfcMaterialProperties` is written as `IfcExtendedMaterialProperties`, because its IFC2X3 namesake is abstract (#10763). IFC2X3 takes only an `IfcMaterial` in `Material`, so the referent is resolved against the records the export writes, with edits, created records, retypes and deletions applied. An `IfcMaterial` is kept. A layer, set or member that names exactly one `IfcMaterial` points at that material. Any other record is left out and named in the export warnings and the loss report. This applies to single, subset, log and merged exports in both writers.
