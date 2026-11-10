---
"@ifc-lite/parser": minor
---

Structural extraction now reads more of the analysis domain across IFC2X3, IFC4 and IFC4X3:

- Physical-to-analytical links (`IfcRelAssignsToProduct` in either direction, IFC2X3 `IfcRelConnectsStructuralElement`) as `physicalElementIds` (the linked `IfcElement`s) per member and connection.
- Each `IfcRelConnectsStructuralMember` / `IfcRelConnectsWithEccentricity` with its `AppliedCondition`, `AdditionalConditions`, `SupportedLength`, `ConditionCoordinateSystem` and point eccentricity.
- Member and curve-connection `Axis` (IFC4X3 `AxisDirection`), point-connection `ConditionCoordinateSystem`, and activity `ProjectedOrTrue`.

Attribute positions and names now come from the file's own schema. For IFC2X3 files this changes component keys to the IFC2X3 EXPRESS names (`LinearStiffnessX` instead of `TranslationalStiffnessX`, `DeltaT_Constant` instead of `DeltaTConstant`), and IFC2X3 `IfcStructuralLinearActionVarying` loads, previously dropped, are now read. Session-deleted records referenced by a structural relation no longer read back from the source file.
