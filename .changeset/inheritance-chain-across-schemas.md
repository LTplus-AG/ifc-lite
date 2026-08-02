---
'@ifc-lite/parser': minor
---

**schema**: export `getInheritanceChainAcrossSchemas(type)` — the inheritance chain resolved against every bundled IFC schema (IFC2X3 + IFC4 + IFC4X3), leaf → root.

The already-exported `getInheritanceChainForEntity` comes from the generated registry, which is pinned to IFC4_ADD2_TC1, so it answers an empty chain for any class that pin does not carry: 23 `IfcObjectDefinition` classes IFC4 dropped from IFC2X3 (`IfcMove`, `IfcOrderAction`, `IfcScheduleTimeControl`, `IfcSpaceProgram`, …) and 77 IFC4X3 additions (`IfcRoad`, `IfcBridge`, `IfcAlignment`, `IfcCourse`, …). Code that decides *what kind of thing* an entity is — as `ifc-lite diff` does — reads an empty chain as "unknown" and gets those classes wrong on schemas that are still very common in the wild.

This is the counterpart of the existing `getAttributeNamesAcrossSchemas`, and is the same function the columnar parser has always used internally to categorize entities. For classes the pin does know, both functions agree on every ancestor that matters; note that the two return their chains in opposite order, so pick the leaf by name rather than by position.
