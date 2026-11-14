---
"@ifc-lite/create": minor
"@ifc-lite/sdk": patch
"@ifc-lite/viewer": patch
---

Retyping a wall or slab that was drawn with a layered type now gives it the new type's layers (#9296). Such an element places its type's `IfcMaterialLayerSet` through an `IfcMaterialLayerSetUsage` of its own, and `bim.store.assignType` left that usage on the OLD type's set, so the element kept the old build-up and thickness: a 230 mm wall retyped to a 150 + 50 mm type stayed 230 mm in the model and in the exported IFC. `assignType` now re-points the usage at the new type's layer set first (`followTypeLayersOnRetypeInStore`, exported from `@ifc-lite/create`), re-centring a wall on its axis and splitting a usage shared with an element that is not being retyped; the body then takes the new total. An element whose layers differ from its old type keeps them, and a new type without layers changes nothing. In the viewer, "New type…" on a selected element starts the new type with the layers the element inherits, so "Apply to Type" reaches it, and the layers of one cut element that share a colour now fill per material in 2D drawings.
