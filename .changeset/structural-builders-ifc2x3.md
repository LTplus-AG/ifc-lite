---
"@ifc-lite/create": minor
---

The structural builders now write IFC2X3 instead of refusing it. `addStructuralAnalysisModelToStore` leaves out `SharedPlacement`, `addStructuralCurveMemberToStore` leaves out `Axis`, and `addStructuralPointConnectionToStore` leaves out `ConditionCoordinateSystem` and writes each boundary stiffness as a plain measure (`-1.` rigid, `0.` free, the IFC2X3 convention). `addStructuralLoadGroupToStore` writes `LOAD_CASE` as an `IfcStructuralLoadGroup` and refuses `SelfWeightCoefficients`, which IFC2X3 cannot store. The point and linear action builders write `DestabilizingLoad` (default `.F.`), `CausedBy` and, for linear actions, `ProjectedOrTrue` (`.TRUE_LENGTH.`), in IFC2X3 order. IFC2X3 requires every analysis model and load group to group something, every point connection to connect a member, and every action to apply to an item, so the file validates once the relationship builders have run. IFC4 and IFC4X3 output is unchanged.
