---
"@ifc-lite/create": minor
"@ifc-lite/sdk": minor
"@ifc-lite/sandbox": minor
"@ifc-lite/mcp": patch
"@ifc-lite/extensions": patch
"@ifc-lite/viewer": patch
---

Author type objects and materials into a loaded model.

`@ifc-lite/create` adds:
- `addElementTypeToStore`: any `IfcElementType` subtype, with its attribute layout and enumeration values read from the model's schema, so IFC2X3, IFC4 and IFC4X3 each get a valid record.
- `assignTypeInStore`: `IfcRelDefinesByType`. It extends the type's relationship and moves an occurrence off a previous type.
- `addMaterialToStore`, `addMaterialLayerSetToStore` and `addMaterialLayerSetUsageToStore`: layer thicknesses and offsets are given in metres and converted to the model's length unit.
- `assignMaterialInStore`: `IfcRelAssociatesMaterial`. It replaces an object's previous association.
- `resolveAuthoringAnchor`, `readRelatedLists` and `liveEntityType`.

Scripts reach them as `bim.store.addElementType`, `assignType`, `addMaterial`, `addMaterialLayerSet`, `addMaterialLayerSetUsage` and `assignMaterial`. A wall given a layer set usage this way exports, parses back with its layers, and meshes as one slice per layer.
