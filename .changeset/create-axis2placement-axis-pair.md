---
"@ifc-lite/create": patch
---

`IfcCreator` and the in-store builders no longer write an `IfcAxis2Placement3D` with a `RefDirection` but no `Axis` (or the reverse), which failed the `AxisAndRefDirProvision` rule in IfcOpenShell validation. Walls, stairs, curtain walls, furnishing elements, rotated spatial zones and any `addLocalPlacement` given only one of the two now write both, with the missing one set to its schema default, so the placement's geometry is unchanged (#5469).
