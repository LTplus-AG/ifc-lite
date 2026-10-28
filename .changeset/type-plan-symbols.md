---
"@ifc-lite/wasm": patch
"@ifc-lite/cli": patch
---

The 2D plan symbol extraction now falls back to the type's `RepresentationMaps` for a product with no Plan, Annotation, FootPrint or Axis representation of its own. A furniture or sanitary occurrence typed through `IfcRelDefinesByType` whose symbol is held only on its type is drawn, placed by the occurrence's placement composed with the map's `MappingOrigin`. Products that carry their own symbolic representation are unchanged.
