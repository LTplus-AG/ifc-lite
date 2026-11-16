# R7 round-4 close (#9668)

Freezes the measurement after round 4 of the structural climb. R0 to R6 are retained.

Measured on main `2d09a32fce`. Rows: **92.5/119 -> 104.5/119** (met 67 -> 90, partial 51 -> 29, missing 1 -> 0). Cells: **721/774 -> 750.5/774**. No row or cell dropped. The scorer ran online with the complete corpus.

This file lists cells, not the PR that moved each one.

| Level | R6 | R7 |
|---|---|---|
| fixture | 110/110 | 110/110 |
| read | 106.5/110 | 106.5/110 |
| card | 97.5/100 | 97.5/100 |
| render | 41.5/43 | 42/43 |
| create | 110/110 | 110/110 |
| edit | 99/110 | 110/110 |
| remove | 96/110 | 110/110 |
| convert | 53/72 | 56/72 |
| capability | 7.5/9 | 8.5/9 |

## Cells that changed since R6

| Level | Row | R6 | R7 |
|---|---|---|---|
| render | IFC2X3/IfcStructuralPointAction | partial | pass |
| edit | IFC2X3/IfcConnectionPointEccentricity | fail | pass |
| edit | IFC2X3/IfcRelConnectsStructuralElement | fail | pass |
| edit | IFC2X3/IfcRelConnectsWithEccentricity | fail | pass |
| edit | IFC4/IfcConnectionPointEccentricity | fail | pass |
| edit | IFC4/IfcRelConnectsWithEccentricity | fail | pass |
| edit | IFC4/IfcStructuralLoadConfiguration | fail | pass |
| edit | IFC4/IfcSurfaceReinforcementArea | fail | pass |
| edit | IFC4X3/IfcConnectionPointEccentricity | fail | pass |
| edit | IFC4X3/IfcRelConnectsWithEccentricity | fail | pass |
| edit | IFC4X3/IfcStructuralLoadConfiguration | fail | pass |
| edit | IFC4X3/IfcSurfaceReinforcementArea | fail | pass |
| remove | IFC2X3/IfcBoundaryNodeConditionWarping | fail | pass |
| remove | IFC2X3/IfcStructuralLinearActionVarying | fail | pass |
| remove | IFC2X3/IfcStructuralLoadSingleDisplacementDistortion | fail | pass |
| remove | IFC2X3/IfcStructuralLoadSingleForceWarping | fail | pass |
| remove | IFC2X3/IfcStructuralPlanarActionVarying | fail | pass |
| remove | IFC2X3/IfcStructuralSurfaceMemberVarying | fail | pass |
| remove | IFC4/IfcBoundaryNodeConditionWarping | fail | pass |
| remove | IFC4/IfcStructuralCurveAction | fail | pass |
| remove | IFC4/IfcStructuralLoadSingleDisplacementDistortion | fail | pass |
| remove | IFC4/IfcStructuralLoadSingleForceWarping | fail | pass |
| remove | IFC4X3/IfcBoundaryNodeConditionWarping | fail | pass |
| remove | IFC4X3/IfcStructuralCurveAction | fail | pass |
| remove | IFC4X3/IfcStructuralLoadSingleDisplacementDistortion | fail | pass |
| remove | IFC4X3/IfcStructuralLoadSingleForceWarping | fail | pass |
| convert | IFC2X3/IfcRelConnectsStructuralElement | partial | pass |
| convert | IFC2X3/IfcStructuralLinearActionVarying | fail | partial |
| convert | IFC4/IfcStructuralLinearAction | partial | pass |
| convert | IFC4/IfcStructuralPlanarAction | partial | pass |
| convert | IFC4/IfcStructuralPointAction | partial | pass |
| convert | IFC4/IfcStructuralSurfaceAction | partial | pass |
| capability | cap/check-stale-after-physical-change | unwritten | pass |

## Still open in R7

Every cell that is not a pass, with the scorer's reason.

| Level | Row | Status | Reason |
|---|---|---|---|
| read | IFC2X3/IfcStructuralLoadLinearForce | partial | 1 problem(s) over 263 record(s): 131 of 263 record(s) not in the read model, e.g. structural/ifc_structuralanalysisview/steel-joint-modelled-with-shellelements--Axis-S... |
| read | IFC2X3/IfcStructuralPointAction | partial | 1 problem(s) over 31 record(s): CausedBy: no fixture sets it, so reading it is unproven |
| read | IFC4/IfcSurfaceReinforcementArea | fail | 1 problem(s) over 1 record(s): 1 of 1 record(s) not in the read model, e.g. ifcopenshell/generated_structural_coverage_ifc4_reinforcement.ifc#15 |
| read | IFC4X3/IfcRelConnectsStructuralActivity | partial | 1 problem(s) over 20 record(s): link RelatingElement -> RelatedStructuralActivity not in the read model for 2 of 20 record(s), e.g. structural/puntal-alfa/portal-demo.... |
| read | IFC4X3/IfcSurfaceReinforcementArea | fail | 1 problem(s) over 1 record(s): 1 of 1 record(s) not in the read model, e.g. ifcopenshell/generated_structural_coverage_ifc4x3.ifc#15 |
| card | IFC2X3/IfcStructuralPointAction | partial | 1 problem(s) over 31 record(s): CausedBy: no fixture sets it, so showing it is unproven |
| card | IFC4/IfcSurfaceReinforcementArea | fail | 1 problem(s) over 1 record(s): 1 of 1 record(s) on no card, e.g. ifcopenshell/generated_structural_coverage_ifc4_reinforcement.ifc#15 |
| card | IFC4X3/IfcSurfaceReinforcementArea | fail | 1 problem(s) over 1 record(s): 1 of 1 record(s) on no card, e.g. ifcopenshell/generated_structural_coverage_ifc4x3.ifc#15 |
| render | IFC4/IfcStructuralCurveMember | partial | 1 problem(s) over 708 record(s): 1 of 708 member(s) not drawn at the file's coordinates, e.g. structural/analysis-models/cantilever_01.ifc#133 (the file gives it no to... |
| render | IFC4X3/IfcStructuralPointReaction | partial | 1 problem(s) over 7 record(s): 2 of 7 record(s) with a non-zero reaction draw no glyph, e.g. structural/puntal-alfa/portal-demo.ifc#161 |
| convert | IFC2X3/IfcRelConnectsStructuralActivity | partial | 1 problem(s) over 14 record(s): ifcopenshell/generated_structural_coverage_ifc2x3.ifc: 2 of 9 IfcRelConnectsStructuralActivity record(s) in the IFC4 file do not confor... |
| convert | IFC2X3/IfcStructuralCurveConnection | fail | 1 problem(s) over 1 record(s): ifcopenshell/generated_structural_coverage_ifc2x3.ifc: 1 of 1 IfcStructuralCurveConnection record(s) in the IFC4 file do not conform to ... |
| convert | IFC2X3/IfcStructuralCurveMember | partial | 1 problem(s) over 14 record(s): ifcopenshell/generated_structural_coverage_ifc2x3.ifc: 1 of 1 IfcStructuralCurveMember record(s) in the IFC4 file do not conform to IFC... |
| convert | IFC2X3/IfcStructuralCurveMemberVarying | fail | 1 problem(s) over 1 record(s): ifcopenshell/generated_structural_coverage_ifc2x3.ifc: 1 of 1 IfcStructuralCurveMemberVarying record(s) in the IFC4 file do not conform ... |
| convert | IFC2X3/IfcStructuralLinearAction | partial | 2 problem(s) over 27 record(s): ifcopenshell/generated_structural_coverage_ifc2x3.ifc#50: CausedBy null, was "0KQ0efL39PrP5DeqBwaUNp"; ifcopenshell/generated_structura... |
| convert | IFC2X3/IfcStructuralLinearActionVarying | partial | 1 problem(s) over 2 record(s): ifcopenshell/generated_structural_coverage_ifc2x3.ifc: 1 of 1 IfcStructuralLinearActionVarying record(s) in the IFC4 file do not conform... |
| convert | IFC2X3/IfcStructuralPlanarAction | partial | 1 problem(s) over 2 record(s): ifcopenshell/generated_structural_coverage_ifc2x3.ifc#52: CausedBy null, was "0KQ0efL39PrP5DeqBwaUNp" |
| convert | IFC2X3/IfcStructuralPlanarActionVarying | fail | 1 problem(s) over 1 record(s): ifcopenshell/generated_structural_coverage_ifc2x3.ifc: 1 of 1 IfcStructuralPlanarActionVarying record(s) in the IFC4 file do not conform... |
| convert | IFC2X3/IfcStructuralSurfaceMemberVarying | partial | 2 problem(s) over 1 record(s): ifcopenshell/generated_structural_coverage_ifc2x3.ifc#40: SubsequentThickness null, was [0.25,0.3]; ifcopenshell/generated_structural_co... |
| convert | IFC4/IfcBoundaryEdgeCondition | partial | 4 problem(s) over 6 record(s): structural/analysis-models/slab_01.ifc#74: no IfcBoundaryEdgeCondition with its values came back; structural/analysis-models/slab_01.ifc... |
| convert | IFC4/IfcRelConnectsStructuralActivity | partial | 1 problem(s) over 11 record(s): ifcopenshell/generated_structural_coverage_ifc4.ifc: 3 of 10 IfcRelConnectsStructuralActivity record(s) in the IFC2X3 file do not confo... |
| convert | IFC4/IfcStructuralAnalysisModel | partial | 1 problem(s) over 2 record(s): structural/analysis-models/slab_01.ifc#19: SharedPlacement null, was "#IFCLOCALPLACEMENT" |
| convert | IFC4/IfcStructuralCurveAction | fail | 2 problem(s) over 2 record(s): ifcopenshell/generated_structural_coverage_ifc4.ifc#51: lost; ifcopenshell/structural_analysis_curve.ifc#317: lost |
| convert | IFC4/IfcStructuralCurveConnection | partial | 4 problem(s) over 4 record(s): structural/analysis-models/slab_01.ifc#62: Axis null, was "#IFCDIRECTION"; structural/analysis-models/slab_01.ifc#72: Axis null, was "#I... |
| convert | IFC4/IfcStructuralCurveMember | partial | 2 problem(s) over 3 record(s): ifcopenshell/generated_structural_edge_curve.ifc: 2 of 2 IfcStructuralCurveMember record(s) in the IFC2X3 file do not conform to IFC2X3 ... |
| convert | IFC4/IfcStructuralCurveMemberVarying | partial | 1 problem(s) over 1 record(s): ifcopenshell/generated_structural_coverage_ifc4.ifc#33: Axis null, was "#IFCDIRECTION" |
| convert | IFC4/IfcStructuralCurveReaction | fail | 4 problem(s) over 4 record(s): ifcopenshell/generated_structural_coverage_ifc4.ifc#57: lost; ifcopenshell/structural_analysis_curve.ifc#2773: lost; ifcopenshell/struct... |
| convert | IFC4/IfcStructuralLoadCase | partial | 4 problem(s) over 4 record(s): structural/analysis-models/beam_01.ifc#65: came back as IFCSTRUCTURALLOADGROUP; structural/analysis-models/beam_01.ifc#67: came back as ... |
| convert | IFC4/IfcStructuralLoadConfiguration | fail | 5 problem(s) over 5 record(s): ifcopenshell/generated_structural_coverage_ifc4.ifc#23: no IfcStructuralLoadConfiguration with its values came back; ifcopenshell/struct... |
| convert | IFC4/IfcStructuralSurfaceMember | partial | 1 problem(s) over 2 record(s): ifcopenshell/generated_structural_surface_member.ifc: 1 of 1 IfcStructuralSurfaceMember record(s) in the IFC2X3 file do not conform to I... |
| convert | IFC4/IfcStructuralSurfaceMemberVarying | fail | 1 problem(s) over 1 record(s): ifcopenshell/generated_structural_coverage_ifc4.ifc: 1 of 1 IfcStructuralSurfaceMemberVarying record(s) in the IFC2X3 file do not confor... |
| convert | IFC4/IfcStructuralSurfaceReaction | fail | 1 problem(s) over 1 record(s): ifcopenshell/generated_structural_coverage_ifc4.ifc#59: lost |
| convert | IFC4/IfcSurfaceReinforcementArea | fail | 1 problem(s) over 1 record(s): ifcopenshell/generated_structural_coverage_ifc4_reinforcement.ifc: IFC4 -> IFC2X3 -> IFC4 threw: Cannot convert #15=IFCSURFACEREINFORCEM... |
| capability | cap/derive-analytical-model | partial | connection #198 at [-14.85635417,-6.4521875,0]: reference has no support, derived #633 has support; connection #227 at [-7.85635417,-6.452,0]: reference has no support... |
