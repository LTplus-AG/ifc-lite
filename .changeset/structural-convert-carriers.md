---
"@ifc-lite/export": minor
---

Structural IFC2X3 <-> IFC4 conversion keeps four more values (#9668). An IFC2X3 action's `CausedBy` becomes the IFC4 `IfcRelAssignsToProduct` named `Causes`, and the downgrade fills `CausedBy` from it. An `IfcStructuralLoadCase` downgrades to an `IfcStructuralLoadGroup` with an `IFC4 IfcStructuralLoadCase` property set holding `SelfWeightCoefficients`, which the upgrade turns back into the load case. The upgrade writes `IfcStructuralAnalysisModel.SharedPlacement` when the grouped items share one placement or equal copies of one, and places those items by it. IFC2X3 varying surface member thicknesses become `Pset_StructuralSurfaceMemberVaryingThickness`, and back.
