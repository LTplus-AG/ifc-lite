---
"@ifc-lite/wasm": patch
"@ifc-lite/export": patch
---

On a downgrade to IFC2X3, IFC4/IFC4X3 `IfcMaterialProperties` is written as `IfcExtendedMaterialProperties`, because its IFC2X3 namesake is abstract (#10763). IFC2X3 takes only an `IfcMaterial` in `Material`, so the referent is resolved against the records the export writes, with edits, created records, retypes and deletions applied. An `IfcMaterial` is kept. A layer, set or member that names exactly one `IfcMaterial` points at that material. Any other record is left out and named in the export warnings and the loss report. This applies to single, subset, log and merged exports in both writers.
