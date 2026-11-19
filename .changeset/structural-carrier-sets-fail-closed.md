---
"@ifc-lite/wasm": patch
"@ifc-lite/export": patch
---

Both STEP exporters now read a structural carrier property set ('IFC4 IfcStructuralLoadCase', Pset_StructuralSurfaceMemberVaryingThickness) in full or not at all (#10597). A set whose relationship lists a non-reference, or that lists a property it cannot read, gives no value. It still counts as present for the objects it names, so on an IFC2X3 to IFC4 export the Rust writer no longer adds a second thickness set beside it, and a load group named by two such sets stays a load group. Property names beside a STEP comment, and a relationship or set with extra trailing slots, now read the same in both.
