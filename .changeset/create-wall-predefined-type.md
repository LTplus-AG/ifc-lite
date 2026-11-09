---
"@ifc-lite/create": minor
---

**Output change:** `IfcCreator.addIfcWall` now writes `PredefinedType` `.NOTDEFINED.` by default in IFC4 and IFC4X3 output. It used to write `.STANDARD.`, which buildingSMART deprecates from IFC4 on. IFC2X3 output is unchanged, because IFC2X3 `IfcWall` has no PredefinedType. In IFC4X3 output, `addIfcSpace` now defaults to `.NOTDEFINED.` instead of `.INTERNAL.`, which IFC4.3.2.0 deprecates (use `Pset_SpaceCommon.IsExternal`). Its IFC4 and IFC2X3 output is unchanged.

New optional `PredefinedType` on `WallParams`, `SlabParams`, `ColumnParams`, `BeamParams` and `SpaceParams`. Each value is checked against the target schema's own enumeration: for example, `RETAININGWALL` is accepted in IFC4X3 and refused in IFC4. A deprecated value (`STANDARD` or `POLYGONAL` for walls, `ELEMENTEDWALL` in IFC4) throws an error that lists the current values. `USERDEFINED` requires `ObjectType`. A value passed where the schema has no such attribute, such as an IFC2X3 wall or column, also throws. Defaults for slabs (`FLOOR`), columns (`COLUMN`) and beams (`BEAM`) are unchanged.
