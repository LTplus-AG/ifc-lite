---
"@ifc-lite/export": patch
"@ifc-lite/wasm": patch
---

An IFC2X3 -> IFC4 or IFC4X3 upgrade no longer writes the IFC2X3 subtypes IFC4 deleted under their IFC2X3 names, which IFC4 readers drop:

- `IfcMove` and `IfcOrderAction` are written as `IfcTask`, `TaskId` as `Identification`. `MoveFrom`, `MoveTo`, `PunchList` and `ActionID` have no slot there and are reported lost.
- `IfcRelOccupiesSpaces`, `IfcRelAssignsTasks`, `IfcRelAssignsToProjectOrder` and `IfcRelSchedulesCostItems` are written as their IFC4 supertype. `TimeForTask` is reported lost. `IfcRelOverridesProperties` is not: as `IfcRelDefinesByProperties` it would attach the values it overrides.

An IFC2X3 -> IFC4 upgrade also stops writing the other IFC2X3-only rooted types (`IfcServiceLife`, `IfcElectricalElement`, ...) under their IFC2X3 names. They become `IFCPROXY`, as on a downgrade. The non-rooted ones (dates, `IfcExtendedMaterialProperties` and its family, the profile properties, annotation occurrences) are still written as they are, now listed by name (#10970, #10879).

The loss report names each one. It now also lists as lossy, on any pair, a type written under a name the target does not declare (on IFC4X3 targets, #10971). The Rust writer's warnings name proxied and verbatim records by type, downgrades included. A registry check fails when a source-only type has no route.
