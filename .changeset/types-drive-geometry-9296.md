---
"@ifc-lite/create": minor
"@ifc-lite/sdk": minor
"@ifc-lite/viewer": patch
---

Types now drive geometry (#9296):

- **Layered types size their walls and slabs.** `bim.store.assignType` brings each typed wall or slab to the total thickness of its effective layer set. So does `bim.store.assignMaterial` when it gives a type a new layer set. Both resize in the same undo step. An occurrence's own layer set usage still wins over its type's, and a body that is not a plain extrusion keeps its shape. The helpers are `applyLayerThicknessInStore`, `effectiveLayerSetThickness` and `typeOccurrencesInStore`.
- **Placed doors and windows are typed.** `addHostedDoor` and `addHostedWindow`, and every caller of `addHostedElementInStore`, type the new door or window with an `IfcDoorType` or `IfcWindowType` named for its size, such as `Door 900 × 2100`. A live type of that name is reused. A custom operation or partitioning becomes `USERDEFINED` plus its description, as on the door itself. Pass `TypeId` to use a type of your own; IFC2X3 fills stay untyped.
- **Materials carry their colour.** `addMaterial({ Color })` takes a hex string or 0..1 channels and writes an `IfcMaterialDefinitionRepresentation` with a styled surface colour.
- **Copies keep one type relationship.** Copying a typed element now extends the type's `IfcRelDefinesByType` instead of adding a second one, which IFC forbids.
- **IFC2X3 surface styles are schema-valid.** `IfcSurfaceStyleShading` is written with its colour alone, and a transparent colour uses `IfcSurfaceStyleRendering`. This applies to `bim.style` as well as material colours. In the viewer, adding a coloured material fences undo the way a layer set does, so undo can't strand its appearance records.
