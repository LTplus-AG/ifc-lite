---
"@ifc-lite/mutations": minor
"@ifc-lite/export": minor
"@ifc-lite/data": minor
"@ifc-lite/cache": patch
---

Add entity retype (reassign class) to the mutation overlay.

`EntityTable` gains an additive `setTypeOverride(expressId, typeName | null)` so
a host (the viewer) can reflect a pending retype live in `getTypeName` /
`getTypeEnum` without rebuilding the table; the original columnar type is left
intact.

`StoreEditor.setEntityType(expressId, newType, { predefinedType? })` and
`MutablePropertyView.setEntityType(...)` change an entity's IFC class in place,
and a new `BulkAction { type: 'SET_ENTITY_TYPE', entityType, predefinedType? }`
applies it to a selection. `StepExporter` materializes the retype on export.

The entity keeps its expressId, so geometry, placement, representation and every
`IfcRel*` reference (all keyed by `#id`) carry over unchanged. Attributes are
re-laid-out by name against the target class's declared layout — dropping
attributes the target lacks (e.g. IFC2X3 `CompositionType`) and validating
`PredefinedType` against the target enum (an unknown override falls back to
`USERDEFINED` + `ObjectType`). This mirrors IfcOpenShell's
`ifcopenshell.util.schema.reassign_class`. Intended for compatible
reassignments such as the building-element subtypes that share the IfcElement
layout (`IfcBuildingElementProxy` ↔ `IfcColumn`/`IfcBeam`/`IfcMember`/
`IfcPlate`/`IfcWall`).
