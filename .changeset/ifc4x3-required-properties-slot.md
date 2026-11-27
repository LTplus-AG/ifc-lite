---
"@ifc-lite/export": patch
---

An IFC2X3 → IFC4X3 export now reports a required slot left `$` in a record an attribute map wrote, as an IFC2X3 → IFC4 export already did. An IFC2X3 `IfcMechanicalMaterialProperties` or `IfcGeneralProfileProperties` with no measure to carry becomes `IfcMaterialProperties`/`IfcProfileProperties` with `Properties` unset, which IFC4X3 requires. The count uses IFC4X3's own required slots, so a slot IFC4X3 made optional is not reported. Rust's `StepStats::ifc4_required_slots_unfilled` still counts IFC4 slots only; the IFC4X3 count is in the warnings, as in TypeScript.
