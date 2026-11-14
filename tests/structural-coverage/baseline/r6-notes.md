# R6 round-3 close (#9668)

Freezes the measurement after round 3 of the structural climb. R0 to R5 are retained.

Measured on main `efe8d65d3d` (after #9923). Rows: **56/119 -> 92.5/119** (met 1 -> 67, partial 110 -> 51, missing 8 -> 1). Cells: **469.5/774 -> 721/774**. No row or cell dropped. The scorer ran online with the complete corpus.

PRs merged since R5 (`b085c65b50`): #9845, #9860, #9922, #9923, #9930, #9937, #9940, #9954.

| Level | R5 | R6 |
|---|---|---|
| fixture | 110/110 | 110/110 |
| read | 84.5/110 | 106.5/110 |
| card | 0/100 | 97.5/100 |
| render | 9/43 | 41.5/43 |
| create | 73.5/110 | 110/110 |
| edit | 74/110 | 99/110 |
| remove | 74/110 | 96/110 |
| convert | 43.5/72 | 53/72 |
| capability | 1/9 | 7.5/9 |

Still open after this round:

- `cap/check-stale-after-physical-change` is missing: it needs stored provenance (draft #10173).
- `cap/derive-analytical-model` is partial: the reference model's two support-only connections are not derived (see #10173's notes).
- Convert is 53/72: classes IFC2X3 cannot hold are meant to show the loss; draft PRs #10151, #10159 and #10182 raise the rest.
- Edit 99/110 and remove 96/110: draft PRs #10152, #10157, #10158 and #10183.

## Every changed cell since R5

| Row | Level | R5 | R6 | Reason |
|---|---|---|---|---|
| IFC2X3/IfcBoundaryEdgeCondition | card | unwritten | pass |  |
| IFC2X3/IfcBoundaryEdgeCondition | convert | fail | pass |  |
| IFC2X3/IfcBoundaryFaceCondition | card | unwritten | pass |  |
| IFC2X3/IfcBoundaryFaceCondition | convert | fail | pass |  |
| IFC2X3/IfcBoundaryNodeCondition | card | unwritten | pass |  |
| IFC2X3/IfcBoundaryNodeCondition | convert | fail | pass |  |
| IFC2X3/IfcBoundaryNodeCondition | create | partial | pass |  |
| IFC2X3/IfcBoundaryNodeCondition | read | partial | pass |  |
| IFC2X3/IfcBoundaryNodeConditionWarping | card | unwritten | pass |  |
| IFC2X3/IfcBoundaryNodeConditionWarping | convert | fail | pass |  |
| IFC2X3/IfcBoundaryNodeConditionWarping | create | fail | pass |  |
| IFC2X3/IfcBoundaryNodeConditionWarping | edit | fail | pass |  |
| IFC2X3/IfcConnectionPointEccentricity | card | unwritten | pass |  |
| IFC2X3/IfcConnectionPointEccentricity | create | fail | pass |  |
| IFC2X3/IfcConnectionPointEccentricity | read | fail | pass |  |
| IFC2X3/IfcConnectionPointEccentricity | remove | fail | pass |  |
| IFC2X3/IfcFailureConnectionCondition | card | unwritten | pass |  |
| IFC2X3/IfcFailureConnectionCondition | create | fail | pass |  |
| IFC2X3/IfcFailureConnectionCondition | edit | fail | pass |  |
| IFC2X3/IfcFailureConnectionCondition | read | fail | pass |  |
| IFC2X3/IfcFailureConnectionCondition | remove | fail | pass |  |
| IFC2X3/IfcRelConnectsStructuralElement | convert | fail | partial | 1 problem(s) over 1 record(s): ifcopenshell/generated_structural_coverage_ifc2x3.ifc#89: came back as IFCRELASSIGNSTOPRODUCT |
| IFC2X3/IfcRelConnectsStructuralElement | create | fail | pass |  |
| IFC2X3/IfcRelConnectsStructuralElement | read | fail | pass |  |
| IFC2X3/IfcRelConnectsStructuralElement | remove | fail | pass |  |
| IFC2X3/IfcRelConnectsStructuralMember | read | partial | pass |  |
| IFC2X3/IfcRelConnectsWithEccentricity | create | fail | pass |  |
| IFC2X3/IfcRelConnectsWithEccentricity | read | partial | pass |  |
| IFC2X3/IfcRelConnectsWithEccentricity | remove | fail | pass |  |
| IFC2X3/IfcSlippageConnectionCondition | card | unwritten | pass |  |
| IFC2X3/IfcSlippageConnectionCondition | create | fail | pass |  |
| IFC2X3/IfcSlippageConnectionCondition | edit | fail | pass |  |
| IFC2X3/IfcSlippageConnectionCondition | read | fail | pass |  |
| IFC2X3/IfcSlippageConnectionCondition | remove | fail | pass |  |
| IFC2X3/IfcStructuralAnalysisModel | card | unwritten | pass |  |
| IFC2X3/IfcStructuralAnalysisModel | read | partial | pass |  |
| IFC2X3/IfcStructuralCurveConnection | card | unwritten | pass |  |
| IFC2X3/IfcStructuralCurveConnection | render | fail | pass |  |
| IFC2X3/IfcStructuralCurveMember | card | unwritten | pass |  |
| IFC2X3/IfcStructuralCurveMember | convert | fail | partial | 1 problem(s) over 14 record(s): ifcopenshell/generated_structural_coverage_ifc2x3.ifc: 1 of 1 IfcStructuralCurveMember record(s) in the IFC4 file do not conform |
| IFC2X3/IfcStructuralCurveMember | render | unwritten | pass |  |
| IFC2X3/IfcStructuralCurveMemberVarying | card | unwritten | pass |  |
| IFC2X3/IfcStructuralCurveMemberVarying | create | fail | pass |  |
| IFC2X3/IfcStructuralCurveMemberVarying | edit | fail | pass |  |
| IFC2X3/IfcStructuralCurveMemberVarying | remove | fail | pass |  |
| IFC2X3/IfcStructuralCurveMemberVarying | render | unwritten | pass |  |
| IFC2X3/IfcStructuralLinearAction | card | unwritten | pass |  |
| IFC2X3/IfcStructuralLinearAction | read | partial | pass |  |
| IFC2X3/IfcStructuralLinearAction | render | partial | pass |  |
| IFC2X3/IfcStructuralLinearActionVarying | card | unwritten | pass |  |
| IFC2X3/IfcStructuralLinearActionVarying | create | fail | pass |  |
| IFC2X3/IfcStructuralLinearActionVarying | edit | fail | pass |  |
| IFC2X3/IfcStructuralLinearActionVarying | read | partial | pass |  |
| IFC2X3/IfcStructuralLinearActionVarying | render | partial | pass |  |
| IFC2X3/IfcStructuralLoadGroup | card | unwritten | pass |  |
| IFC2X3/IfcStructuralLoadLinearForce | card | unwritten | pass |  |
| IFC2X3/IfcStructuralLoadPlanarForce | card | unwritten | pass |  |
| IFC2X3/IfcStructuralLoadSingleDisplacement | card | unwritten | pass |  |
| IFC2X3/IfcStructuralLoadSingleDisplacementDistortion | card | unwritten | pass |  |
| IFC2X3/IfcStructuralLoadSingleDisplacementDistortion | create | fail | pass |  |
| IFC2X3/IfcStructuralLoadSingleDisplacementDistortion | edit | fail | pass |  |
| IFC2X3/IfcStructuralLoadSingleForce | card | unwritten | pass |  |
| IFC2X3/IfcStructuralLoadSingleForceWarping | card | unwritten | pass |  |
| IFC2X3/IfcStructuralLoadSingleForceWarping | create | fail | pass |  |
| IFC2X3/IfcStructuralLoadSingleForceWarping | edit | fail | pass |  |
| IFC2X3/IfcStructuralLoadTemperature | card | unwritten | pass |  |
| IFC2X3/IfcStructuralLoadTemperature | read | partial | pass |  |
| IFC2X3/IfcStructuralPlanarAction | card | unwritten | pass |  |
| IFC2X3/IfcStructuralPlanarAction | read | partial | pass |  |
| IFC2X3/IfcStructuralPlanarAction | render | partial | pass |  |
| IFC2X3/IfcStructuralPlanarActionVarying | card | unwritten | pass |  |
| IFC2X3/IfcStructuralPlanarActionVarying | create | fail | pass |  |
| IFC2X3/IfcStructuralPlanarActionVarying | edit | fail | pass |  |
| IFC2X3/IfcStructuralPlanarActionVarying | read | partial | pass |  |
| IFC2X3/IfcStructuralPlanarActionVarying | render | fail | pass |  |
| IFC2X3/IfcStructuralPointAction | card | unwritten | partial | 1 problem(s) over 31 record(s): CausedBy: no fixture sets it, so showing it is unproven |
| IFC2X3/IfcStructuralPointConnection | card | unwritten | pass |  |
| IFC2X3/IfcStructuralPointReaction | card | unwritten | pass |  |
| IFC2X3/IfcStructuralPointReaction | render | unwritten | pass |  |
| IFC2X3/IfcStructuralResultGroup | card | unwritten | pass |  |
| IFC2X3/IfcStructuralSurfaceConnection | card | unwritten | pass |  |
| IFC2X3/IfcStructuralSurfaceConnection | render | partial | pass |  |
| IFC2X3/IfcStructuralSurfaceMember | card | unwritten | pass |  |
| IFC2X3/IfcStructuralSurfaceMember | render | unwritten | pass |  |
| IFC2X3/IfcStructuralSurfaceMemberVarying | card | unwritten | pass |  |
| IFC2X3/IfcStructuralSurfaceMemberVarying | create | fail | pass |  |
| IFC2X3/IfcStructuralSurfaceMemberVarying | edit | fail | pass |  |
| IFC2X3/IfcStructuralSurfaceMemberVarying | read | partial | pass |  |
| IFC2X3/IfcStructuralSurfaceMemberVarying | render | unwritten | pass |  |
| IFC4/IfcBoundaryEdgeCondition | card | unwritten | pass |  |
| IFC4/IfcBoundaryEdgeCondition | convert | fail | partial | 4 problem(s) over 6 record(s): structural/analysis-models/slab_01.ifc#74: no IfcBoundaryEdgeCondition with its values came back; structural/analysis-models/slab |
| IFC4/IfcBoundaryEdgeCondition | read | partial | pass |  |
| IFC4/IfcBoundaryFaceCondition | card | unwritten | pass |  |
| IFC4/IfcBoundaryFaceCondition | convert | fail | pass |  |
| IFC4/IfcBoundaryNodeCondition | card | unwritten | pass |  |
| IFC4/IfcBoundaryNodeCondition | convert | fail | pass |  |
| IFC4/IfcBoundaryNodeCondition | read | partial | pass |  |
| IFC4/IfcBoundaryNodeConditionWarping | card | unwritten | pass |  |
| IFC4/IfcBoundaryNodeConditionWarping | convert | fail | pass |  |
| IFC4/IfcBoundaryNodeConditionWarping | create | fail | pass |  |
| IFC4/IfcBoundaryNodeConditionWarping | edit | fail | pass |  |
| IFC4/IfcConnectionPointEccentricity | card | unwritten | pass |  |
| IFC4/IfcConnectionPointEccentricity | create | fail | pass |  |
| IFC4/IfcConnectionPointEccentricity | read | fail | pass |  |
| IFC4/IfcConnectionPointEccentricity | remove | fail | pass |  |
| IFC4/IfcFailureConnectionCondition | card | unwritten | pass |  |
| IFC4/IfcFailureConnectionCondition | create | fail | pass |  |
| IFC4/IfcFailureConnectionCondition | edit | fail | pass |  |
| IFC4/IfcFailureConnectionCondition | read | fail | pass |  |
| IFC4/IfcFailureConnectionCondition | remove | fail | pass |  |
| IFC4/IfcRelConnectsStructuralMember | read | partial | pass |  |
| IFC4/IfcRelConnectsWithEccentricity | create | fail | pass |  |
| IFC4/IfcRelConnectsWithEccentricity | read | partial | pass |  |
| IFC4/IfcRelConnectsWithEccentricity | remove | fail | pass |  |
| IFC4/IfcSlippageConnectionCondition | card | unwritten | pass |  |
| IFC4/IfcSlippageConnectionCondition | create | fail | pass |  |
| IFC4/IfcSlippageConnectionCondition | edit | fail | pass |  |
| IFC4/IfcSlippageConnectionCondition | read | fail | pass |  |
| IFC4/IfcSlippageConnectionCondition | remove | fail | pass |  |
| IFC4/IfcStructuralAnalysisModel | card | unwritten | pass |  |
| IFC4/IfcStructuralAnalysisModel | read | partial | pass |  |
| IFC4/IfcStructuralCurveAction | card | unwritten | pass |  |
| IFC4/IfcStructuralCurveAction | create | fail | pass |  |
| IFC4/IfcStructuralCurveAction | edit | fail | pass |  |
| IFC4/IfcStructuralCurveAction | render | partial | pass |  |
| IFC4/IfcStructuralCurveConnection | card | unwritten | pass |  |
| IFC4/IfcStructuralCurveConnection | render | partial | pass |  |
| IFC4/IfcStructuralCurveMember | card | unwritten | pass |  |
| IFC4/IfcStructuralCurveMember | render | unwritten | partial | 1 problem(s) over 708 record(s): 1 of 708 member(s) not drawn at the file's coordinates, e.g. structural/analysis-models/cantilever_01.ifc#133 (the file gives i |
| IFC4/IfcStructuralCurveMemberVarying | card | unwritten | pass |  |
| IFC4/IfcStructuralCurveMemberVarying | create | fail | pass |  |
| IFC4/IfcStructuralCurveMemberVarying | edit | fail | pass |  |
| IFC4/IfcStructuralCurveMemberVarying | remove | fail | pass |  |
| IFC4/IfcStructuralCurveMemberVarying | render | unwritten | pass |  |
| IFC4/IfcStructuralCurveReaction | card | unwritten | pass |  |
| IFC4/IfcStructuralCurveReaction | render | unwritten | pass |  |
| IFC4/IfcStructuralLinearAction | card | unwritten | pass |  |
| IFC4/IfcStructuralLinearAction | convert | fail | partial | 50 problem(s) over 26 record(s): structural/analysis-models/building_02.ifc#8336: DestabilizingLoad false, was null; structural/analysis-models/building_02.ifc# |
| IFC4/IfcStructuralLinearAction | render | partial | pass |  |
| IFC4/IfcStructuralLoadCase | card | unwritten | pass |  |
| IFC4/IfcStructuralLoadCase | read | partial | pass |  |
| IFC4/IfcStructuralLoadConfiguration | card | unwritten | pass |  |
| IFC4/IfcStructuralLoadConfiguration | create | fail | pass |  |
| IFC4/IfcStructuralLoadConfiguration | remove | fail | pass |  |
| IFC4/IfcStructuralLoadGroup | card | unwritten | pass |  |
| IFC4/IfcStructuralLoadGroup | read | partial | pass |  |
| IFC4/IfcStructuralLoadLinearForce | card | unwritten | pass |  |
| IFC4/IfcStructuralLoadPlanarForce | card | unwritten | pass |  |
| IFC4/IfcStructuralLoadSingleDisplacement | card | unwritten | pass |  |
| IFC4/IfcStructuralLoadSingleDisplacementDistortion | card | unwritten | pass |  |
| IFC4/IfcStructuralLoadSingleDisplacementDistortion | create | fail | pass |  |
| IFC4/IfcStructuralLoadSingleDisplacementDistortion | edit | fail | pass |  |
| IFC4/IfcStructuralLoadSingleForce | card | unwritten | pass |  |
| IFC4/IfcStructuralLoadSingleForceWarping | card | unwritten | pass |  |
| IFC4/IfcStructuralLoadSingleForceWarping | create | fail | pass |  |
| IFC4/IfcStructuralLoadSingleForceWarping | edit | fail | pass |  |
| IFC4/IfcStructuralLoadTemperature | card | unwritten | pass |  |
| IFC4/IfcStructuralPlanarAction | card | unwritten | pass |  |
| IFC4/IfcStructuralPlanarAction | convert | fail | partial | 28 problem(s) over 15 record(s): structural/analysis-models/building_01.ifc#869: DestabilizingLoad false, was null; structural/analysis-models/building_01.ifc#8 |
| IFC4/IfcStructuralPlanarAction | render | partial | pass |  |
| IFC4/IfcStructuralPointAction | card | unwritten | pass |  |
| IFC4/IfcStructuralPointConnection | card | unwritten | pass |  |
| IFC4/IfcStructuralPointReaction | card | unwritten | pass |  |
| IFC4/IfcStructuralPointReaction | render | unwritten | pass |  |
| IFC4/IfcStructuralResultGroup | card | unwritten | pass |  |
| IFC4/IfcStructuralSurfaceAction | card | unwritten | pass |  |
| IFC4/IfcStructuralSurfaceAction | render | fail | pass |  |
| IFC4/IfcStructuralSurfaceConnection | card | unwritten | pass |  |
| IFC4/IfcStructuralSurfaceConnection | render | fail | pass |  |
| IFC4/IfcStructuralSurfaceMember | card | unwritten | pass |  |
| IFC4/IfcStructuralSurfaceMember | render | unwritten | pass |  |
| IFC4/IfcStructuralSurfaceMemberVarying | card | unwritten | pass |  |
| IFC4/IfcStructuralSurfaceMemberVarying | create | fail | pass |  |
| IFC4/IfcStructuralSurfaceMemberVarying | edit | fail | pass |  |
| IFC4/IfcStructuralSurfaceMemberVarying | remove | fail | pass |  |
| IFC4/IfcStructuralSurfaceMemberVarying | render | unwritten | pass |  |
| IFC4/IfcStructuralSurfaceReaction | card | unwritten | pass |  |
| IFC4/IfcStructuralSurfaceReaction | render | unwritten | pass |  |
| IFC4/IfcSurfaceReinforcementArea | card | unwritten | fail | 1 problem(s) over 1 record(s): 1 of 1 record(s) on no card, e.g. ifcopenshell/generated_structural_coverage_ifc4_reinforcement.ifc#15 |
| IFC4/IfcSurfaceReinforcementArea | create | fail | pass |  |
| IFC4/IfcSurfaceReinforcementArea | remove | fail | pass |  |
| IFC4X3/IfcBoundaryEdgeCondition | card | unwritten | pass |  |
| IFC4X3/IfcBoundaryFaceCondition | card | unwritten | pass |  |
| IFC4X3/IfcBoundaryNodeCondition | card | unwritten | pass |  |
| IFC4X3/IfcBoundaryNodeCondition | read | partial | pass |  |
| IFC4X3/IfcBoundaryNodeConditionWarping | card | unwritten | pass |  |
| IFC4X3/IfcBoundaryNodeConditionWarping | create | fail | pass |  |
| IFC4X3/IfcBoundaryNodeConditionWarping | edit | fail | pass |  |
| IFC4X3/IfcConnectionPointEccentricity | card | unwritten | pass |  |
| IFC4X3/IfcConnectionPointEccentricity | create | fail | pass |  |
| IFC4X3/IfcConnectionPointEccentricity | read | fail | pass |  |
| IFC4X3/IfcConnectionPointEccentricity | remove | fail | pass |  |
| IFC4X3/IfcFailureConnectionCondition | card | unwritten | pass |  |
| IFC4X3/IfcFailureConnectionCondition | create | fail | pass |  |
| IFC4X3/IfcFailureConnectionCondition | edit | fail | pass |  |
| IFC4X3/IfcFailureConnectionCondition | read | fail | pass |  |
| IFC4X3/IfcFailureConnectionCondition | remove | fail | pass |  |
| IFC4X3/IfcRelConnectsStructuralMember | read | partial | pass |  |
| IFC4X3/IfcRelConnectsWithEccentricity | create | fail | pass |  |
| IFC4X3/IfcRelConnectsWithEccentricity | read | partial | pass |  |
| IFC4X3/IfcRelConnectsWithEccentricity | remove | fail | pass |  |
| IFC4X3/IfcSlippageConnectionCondition | card | unwritten | pass |  |
| IFC4X3/IfcSlippageConnectionCondition | create | fail | pass |  |
| IFC4X3/IfcSlippageConnectionCondition | edit | fail | pass |  |
| IFC4X3/IfcSlippageConnectionCondition | read | fail | pass |  |
| IFC4X3/IfcSlippageConnectionCondition | remove | fail | pass |  |
| IFC4X3/IfcStructuralAnalysisModel | card | unwritten | pass |  |
| IFC4X3/IfcStructuralAnalysisModel | read | partial | pass |  |
| IFC4X3/IfcStructuralCurveAction | card | unwritten | pass |  |
| IFC4X3/IfcStructuralCurveAction | create | fail | pass |  |
| IFC4X3/IfcStructuralCurveAction | edit | fail | pass |  |
| IFC4X3/IfcStructuralCurveAction | render | fail | pass |  |
| IFC4X3/IfcStructuralCurveConnection | card | unwritten | pass |  |
| IFC4X3/IfcStructuralCurveConnection | render | fail | pass |  |
| IFC4X3/IfcStructuralCurveMember | card | unwritten | pass |  |
| IFC4X3/IfcStructuralCurveMember | render | unwritten | pass |  |
| IFC4X3/IfcStructuralCurveMemberVarying | card | unwritten | pass |  |
| IFC4X3/IfcStructuralCurveMemberVarying | create | fail | pass |  |
| IFC4X3/IfcStructuralCurveMemberVarying | edit | fail | pass |  |
| IFC4X3/IfcStructuralCurveMemberVarying | remove | fail | pass |  |
| IFC4X3/IfcStructuralCurveMemberVarying | render | unwritten | pass |  |
| IFC4X3/IfcStructuralCurveReaction | card | unwritten | pass |  |
| IFC4X3/IfcStructuralCurveReaction | render | unwritten | pass |  |
| IFC4X3/IfcStructuralLinearAction | card | unwritten | pass |  |
| IFC4X3/IfcStructuralLinearAction | render | fail | pass |  |
| IFC4X3/IfcStructuralLoadCase | card | unwritten | pass |  |
| IFC4X3/IfcStructuralLoadCase | read | partial | pass |  |
| IFC4X3/IfcStructuralLoadConfiguration | card | unwritten | pass |  |
| IFC4X3/IfcStructuralLoadConfiguration | create | fail | pass |  |
| IFC4X3/IfcStructuralLoadConfiguration | remove | fail | pass |  |
| IFC4X3/IfcStructuralLoadGroup | card | unwritten | pass |  |
| IFC4X3/IfcStructuralLoadGroup | read | partial | pass |  |
| IFC4X3/IfcStructuralLoadLinearForce | card | unwritten | pass |  |
| IFC4X3/IfcStructuralLoadPlanarForce | card | unwritten | pass |  |
| IFC4X3/IfcStructuralLoadSingleDisplacement | card | unwritten | pass |  |
| IFC4X3/IfcStructuralLoadSingleDisplacementDistortion | card | unwritten | pass |  |
| IFC4X3/IfcStructuralLoadSingleDisplacementDistortion | create | fail | pass |  |
| IFC4X3/IfcStructuralLoadSingleDisplacementDistortion | edit | fail | pass |  |
| IFC4X3/IfcStructuralLoadSingleForce | card | unwritten | pass |  |
| IFC4X3/IfcStructuralLoadSingleForceWarping | card | unwritten | pass |  |
| IFC4X3/IfcStructuralLoadSingleForceWarping | create | fail | pass |  |
| IFC4X3/IfcStructuralLoadSingleForceWarping | edit | fail | pass |  |
| IFC4X3/IfcStructuralLoadTemperature | card | unwritten | pass |  |
| IFC4X3/IfcStructuralPlanarAction | card | unwritten | pass |  |
| IFC4X3/IfcStructuralPlanarAction | render | fail | pass |  |
| IFC4X3/IfcStructuralPointAction | card | unwritten | pass |  |
| IFC4X3/IfcStructuralPointAction | render | partial | pass |  |
| IFC4X3/IfcStructuralPointConnection | card | unwritten | pass |  |
| IFC4X3/IfcStructuralPointConnection | read | partial | pass |  |
| IFC4X3/IfcStructuralPointReaction | card | unwritten | pass |  |
| IFC4X3/IfcStructuralPointReaction | render | unwritten | partial | 1 problem(s) over 7 record(s): 2 of 7 record(s) with a non-zero reaction draw no glyph, e.g. structural/puntal-alfa/portal-demo.ifc#161 |
| IFC4X3/IfcStructuralResultGroup | card | unwritten | pass |  |
| IFC4X3/IfcStructuralSurfaceAction | card | unwritten | pass |  |
| IFC4X3/IfcStructuralSurfaceAction | render | fail | pass |  |
| IFC4X3/IfcStructuralSurfaceConnection | card | unwritten | pass |  |
| IFC4X3/IfcStructuralSurfaceConnection | render | fail | pass |  |
| IFC4X3/IfcStructuralSurfaceMember | card | unwritten | pass |  |
| IFC4X3/IfcStructuralSurfaceMember | render | unwritten | pass |  |
| IFC4X3/IfcStructuralSurfaceMemberVarying | card | unwritten | pass |  |
| IFC4X3/IfcStructuralSurfaceMemberVarying | create | fail | pass |  |
| IFC4X3/IfcStructuralSurfaceMemberVarying | edit | fail | pass |  |
| IFC4X3/IfcStructuralSurfaceMemberVarying | remove | fail | pass |  |
| IFC4X3/IfcStructuralSurfaceMemberVarying | render | unwritten | pass |  |
| IFC4X3/IfcStructuralSurfaceReaction | card | unwritten | pass |  |
| IFC4X3/IfcStructuralSurfaceReaction | render | unwritten | pass |  |
| IFC4X3/IfcSurfaceReinforcementArea | card | unwritten | fail | 1 problem(s) over 1 record(s): 1 of 1 record(s) on no card, e.g. ifcopenshell/generated_structural_coverage_ifc4x3.ifc#15 |
| IFC4X3/IfcSurfaceReinforcementArea | create | fail | pass |  |
| IFC4X3/IfcSurfaceReinforcementArea | remove | fail | pass |  |
| cap/analytical-physical-toggle | capability | unwritten | pass |  |
| cap/check-axis-drift | capability | unwritten | pass |  |
| cap/check-unconnected-member | capability | unwritten | pass |  |
| cap/check-unlinked-load-bearing | capability | unwritten | pass |  |
| cap/cli-structural-command | capability | unwritten | pass |  |
| cap/derive-analytical-model | capability | unwritten | partial | reference connection #481: no derived point with links [] within 0.001 m at [-14.51035417,-6.4521875,0]; reference connection #492: no derived point with links  |
| cap/docs-page | capability | fail | pass |  |
