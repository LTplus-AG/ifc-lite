---
"@ifc-lite/wasm": patch
"@ifc-lite/export": patch
---

Both STEP exporters now read a structural carrier property set ('IFC4 IfcStructuralLoadCase', Pset_StructuralSurfaceMemberVaryingThickness) in full or not at all. A set whose relationship lists a non-reference, or that lists a property it cannot read, gives no value but still counts as present. So on an IFC2X3 to IFC4 export the Rust writer no longer adds a second thickness set beside it, and reports the thicknesses lost as the TypeScript one does (#10597).
