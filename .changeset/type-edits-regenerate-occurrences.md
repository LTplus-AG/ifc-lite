---
"@ifc-lite/create": minor
"@ifc-lite/sdk": patch
"@ifc-lite/viewer": patch
---

Editing a shared wall type's layers now regenerates the whole building it describes, as one undo step (Part of #9296). When a layered type sizes its occurrences (`applyLayerThicknessInStore`, behind `assignType` and `assignMaterial`), the generated rooms those walls bound take their new outline and net area in the same edit.

Two new functions:

- `takeLayerThicknessOutcome(editor)` names every element whose body changed: the resized occurrences, the walls joined to them, their openings and the rooms. It also lists each occurrence that could not follow, such as a third-party body that is not a plain extrusion, with the reason.
- `previewTypeLayerImpact(target, typeId, thickness)` reports the same thing without applying it, so a host can show the impact before Apply. It covers which occurrences resize, which keep their own material, which joined walls, openings and rooms change, and each room's net area before and after.

In the viewer, a type-scope layer edit (the Layers section's Type target, and reviewed `material.layers` with scope type) redraws every occurrence, the walls joined to them and the generated rooms. Undo and Redo redraw them again. Before Apply, the Layers section says how many elements of the type will change. Any occurrence that keeps its previous body is named on screen with the reason.
