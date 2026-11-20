---
"@ifc-lite/export": patch
"@ifc-lite/wasm": patch
---

An IFC2X3 -> IFC4 upgrade no longer writes the IFC2X3-only types IFC4 deleted under their IFC2X3 names, which IFC4 readers drop:

- `IfcMove` and `IfcOrderAction` are written as `IfcTask`, `TaskId` as `Identification`. `MoveFrom`, `MoveTo`, `PunchList` and `ActionID` have no slot there and are reported lost.
- The other rooted ones (`IfcRelOccupiesSpaces`, `IfcServiceLife`, `IfcElectricalElement`, ...) become `IFCPROXY`, as on a downgrade.
- The non-rooted ones (dates, `IfcExtendedMaterialProperties` and its family, the profile properties, annotation occurrences) are still written as they are, now listed by name (#10970, #10879). The varying structural actions stay as the structural pass leaves them (#9668).

The loss report names each one, and the Rust writer's warnings name them by type. A registry check fails when a source-only type has no route.
