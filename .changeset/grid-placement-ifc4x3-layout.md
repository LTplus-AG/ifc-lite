---
'@ifc-lite/export': patch
---

Exporting across IFC4X3 now writes `IfcGridPlacement` in the target schema's layout. An IFC2X3 or IFC4 model exported as IFC4X3 kept the two-attribute list, so grid-placed elements failed `ifcopenshell.validate` and had their location in the wrong slot. The upgrade names the owning grid's placement as `PlacementRelTo`, so elements stay where they are, and a downgrade drops it.
