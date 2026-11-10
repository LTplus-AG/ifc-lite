---
"@ifc-lite/parser": major
---

Structural extraction now reads more of the analysis domain across IFC2X3, IFC4 and IFC4X3:

- Physical-to-analytical links (`IfcRelAssignsToProduct` in either direction, IFC2X3 `IfcRelConnectsStructuralElement`) as `physicalElementIds` per member and connection. Only `IfcElement` ends count, so a storey, grid, annotation or `IfcProxy` is not reported as the analysed element.
- Each `IfcRelConnectsStructuralMember` / `IfcRelConnectsWithEccentricity` with its `AppliedCondition`, `AdditionalConditions`, `SupportedLength`, `ConditionCoordinateSystem` and point eccentricity.
- Member and curve-connection `Axis` (IFC4X3 `AxisDirection`), point-connection `ConditionCoordinateSystem`, and activity `ProjectedOrTrue`.

Breaking for IFC2X3 files: attribute positions and names now come from the file's own schema, so component keys use the IFC2X3 EXPRESS names (`LinearStiffnessX` instead of `TranslationalStiffnessX`, `DeltaT_Constant` instead of `DeltaTConstant`), and previously dropped `IfcStructuralLinearActionVarying` loads are now read. Session-deleted records referenced by a structural relation no longer read back from the source file.
