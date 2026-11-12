---
"@ifc-lite/create": minor
"@ifc-lite/sdk": patch
"@ifc-lite/viewer": patch
---

Editing a shared wall type's layers now regenerates the whole building it describes, as one undo step (Part of #9296). When a layered type sizes its occurrences (`applyLayerThicknessInStore`, behind `assignType` and `assignMaterial`), the generated rooms those walls bound take their new outline and net area in the same edit. A loaded wall or slab whose body changes also has its file's base quantity set updated in the same edit: Width, the volumes and whatever else the new body changes, while a value the edit did not change keeps the file's own measure. That holds for an imported model and for one exported and reopened.

New functions:

- **`typeLayerScopeInStore(target, typeId)`** splits a type's occurrences into those that inherit its layers and those that differ. An occurrence inherits when it has no material of its own, or when its own IfcMaterialLayerSetUsage places the type's layer set. `typeLayerSetInStore` reads the type's set.
- **`retargetInheritingLayerUsagesInStore(target, typeId, newLayerSetId)`** points the inheriting usages at a type's new layer set, keeping a centred wall centred. A type layer edit then reaches walls drawn with their own usage too. A usage shared with an element that does not inherit is split, so the inheriting walls move to the new set and the other element keeps the old one; what the impact preview plans is what the edit applies.
- **`takeLayerThicknessOutcome(editor)`** names every element whose body changed: the resized occurrences, the walls joined to them, their openings and the rooms. It also lists each occurrence that could not follow, such as a third-party body that is not a plain extrusion, with the reason.
- **`previewTypeLayerImpact(target, typeId, thickness)`** reports the same thing without applying it, so a host can show the impact before Apply. It covers which occurrences resize, which differ from the type, which joined walls, openings and rooms change, and each room's net area before and after.

`addElementTypeToStore` now also writes IfcSpatialElementType subtypes, so an IFC4 or IFC4X3 space can be given an IfcSpaceType.

Rewriting a joined wall loaded from a file (a resize, a reshape, a join) no longer leaves the file's replaced Axis representation behind unreferenced. That broke IfcShapeModel.WR11, so the export of an edited loaded model failed express validation. The replaced representation is removed once nothing references it, together with its curve and points.

In the viewer:

- A type-scope layer edit (the Layers section's Type target, and reviewed `material.layers` with scope type) redraws every occurrence of the type, the walls joined to them and the generated rooms. Undo and Redo redraw them again.
- Walls drawn while a type and a layer default are both active now place the type's layer set. A type without layers adopts the default when nothing it types disagrees. A later type edit therefore reaches those walls.
- Before Apply, the Layers section says how many elements of the type will change and how many differ from it.
- Any occurrence that keeps its previous body is named on screen with the reason.
- "New type…" works on a space.
