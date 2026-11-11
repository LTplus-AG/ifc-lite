# R1 harness correction measurement

Product source: origin/main `51872549156c969f3f8b685fa763b30d5bd1f1f8`. No product changes in this revision. R1 is a baseline revision, not a product climb round. R0 is retained.

Rows: **55/119 -> 56/119** (met 0 -> 1, partial 110 -> 110, missing 9 -> 8). Cells: **251/774 -> 271.5/774**. Read: 75.5 -> 84.5; create: 22 -> 32.5; capability: 0 -> 1. All other level totals are unchanged. The ratchet reports no row or cell dropped.

## Every changed cell

This table includes reason-only changes with unchanged points. To distinguish fresh-build effects from lookup corrections, the original main read probe was also run against the same freshly built packages and corpus. A “current-main extraction” change below is already present with that original probe; its cause is outside the changed lookup. R0 therefore under-reported those values even before this correction. Creation improvements come from the IFC2X3 builders already on main (#9662).

| Row | Level | R0 -> R1 | Why |
|---|---|---|---|
| IFC2X3/IfcBoundaryEdgeCondition | read | partial -> pass | Fresh current-main extraction already improves this cell with the original read probe. Fixture values now match. |
| IFC2X3/IfcBoundaryFaceCondition | read | partial -> pass | Fresh current-main extraction already improves this cell with the original read probe. Fixture values now match. |
| IFC2X3/IfcBoundaryNodeCondition | read | partial -> partial | Fresh current-main extraction already improves this cell with the original read probe. Remaining gaps keep the score partial. |
| IFC2X3/IfcBoundaryNodeCondition | create | fail -> partial | Current-main IFC2X3 builder runs; six stiffness expectations remain unproven. |
| IFC2X3/IfcBoundaryNodeConditionWarping | read | partial -> pass | Fresh current-main extraction already improves this cell with the original read probe. Fixture values now match. |
| IFC2X3/IfcRelConnectsStructuralActivity | create | fail -> pass | Current-main IFC2X3 builders and their dependency scenes now run (#9662). |
| IFC2X3/IfcRelConnectsStructuralMember | create | fail -> pass | Current-main IFC2X3 builders and their dependency scenes now run (#9662). |
| IFC2X3/IfcRelConnectsWithEccentricity | read | partial -> partial | Fresh current-main extraction already improves this cell with the original read probe. Remaining gaps keep the score partial. |
| IFC2X3/IfcStructuralAnalysisModel | create | fail -> pass | Current-main IFC2X3 builders and their dependency scenes now run (#9662). |
| IFC2X3/IfcStructuralCurveMember | create | fail -> pass | Current-main IFC2X3 builders and their dependency scenes now run (#9662). |
| IFC2X3/IfcStructuralLinearAction | read | partial -> partial | Exact EXPRESS lookup: ProjectedOrTrue now matches; CausedBy remains unproven. |
| IFC2X3/IfcStructuralLinearAction | create | fail -> pass | Current-main IFC2X3 builders and their dependency scenes now run (#9662). |
| IFC2X3/IfcStructuralLinearActionVarying | read | partial -> partial | Fresh current-main extraction already improves this cell with the original read probe. Remaining gaps keep the score partial. |
| IFC2X3/IfcStructuralLoadGroup | create | fail -> pass | Current-main IFC2X3 builders and their dependency scenes now run (#9662). |
| IFC2X3/IfcStructuralLoadLinearForce | read | partial -> partial | Fresh current-main extraction already improves this cell with the original read probe. Remaining gaps keep the score partial. |
| IFC2X3/IfcStructuralLoadLinearForce | create | fail -> pass | Current-main IFC2X3 builders and their dependency scenes now run (#9662). |
| IFC2X3/IfcStructuralLoadSingleForce | create | fail -> pass | Current-main IFC2X3 builders and their dependency scenes now run (#9662). |
| IFC2X3/IfcStructuralLoadTemperature | read | partial -> partial | Fresh current-main extraction already improves this cell with the original read probe. Remaining gaps keep the score partial. |
| IFC2X3/IfcStructuralPlanarAction | read | partial -> partial | Exact EXPRESS lookup: ProjectedOrTrue now matches; CausedBy remains unproven. |
| IFC2X3/IfcStructuralPlanarActionVarying | read | partial -> partial | Fresh current-main extraction already improves this cell with the original read probe. Remaining gaps keep the score partial. |
| IFC2X3/IfcStructuralPointAction | create | fail -> pass | Current-main IFC2X3 builders and their dependency scenes now run (#9662). |
| IFC2X3/IfcStructuralPointConnection | create | fail -> pass | Current-main IFC2X3 builders and their dependency scenes now run (#9662). |
| IFC4/IfcRelConnectsWithEccentricity | read | partial -> partial | Fresh current-main extraction already improves this cell with the original read probe. Remaining gaps keep the score partial. |
| IFC4/IfcStructuralCurveAction | read | partial -> pass | Exact EXPRESS lookup: ProjectedOrTrue now matches. |
| IFC4/IfcStructuralCurveConnection | read | partial -> pass | Exact EXPRESS lookup and fixture-directed express-id reference comparison: Axis now matches. |
| IFC4/IfcStructuralCurveMember | read | partial -> pass | Exact EXPRESS lookup and fixture-directed express-id reference comparison: Axis now matches. |
| IFC4/IfcStructuralCurveMemberVarying | read | partial -> pass | Exact EXPRESS lookup and fixture-directed express-id reference comparison: Axis now matches. |
| IFC4/IfcStructuralLinearAction | read | partial -> pass | Exact EXPRESS lookup: ProjectedOrTrue now matches. |
| IFC4/IfcStructuralPlanarAction | read | partial -> pass | Exact EXPRESS lookup: ProjectedOrTrue now matches. |
| IFC4/IfcStructuralPointConnection | read | partial -> pass | Exact EXPRESS lookup and fixture-directed express-id reference comparison: ConditionCoordinateSystem now matches. |
| IFC4/IfcStructuralSurfaceAction | read | partial -> pass | Exact EXPRESS lookup: ProjectedOrTrue now matches. |
| IFC4X3/IfcStructuralCurveAction | read | partial -> pass | Exact EXPRESS lookup: ProjectedOrTrue now matches. |
| IFC4X3/IfcStructuralCurveConnection | read | partial -> pass | Exact EXPRESS lookup and fixture-directed express-id reference comparison: AxisDirection now matches. |
| IFC4X3/IfcStructuralCurveMember | read | partial -> pass | Exact EXPRESS lookup and fixture-directed express-id reference comparison: Axis now matches. |
| IFC4X3/IfcStructuralCurveMemberVarying | read | partial -> pass | Exact EXPRESS lookup and fixture-directed express-id reference comparison: Axis now matches. |
| IFC4X3/IfcStructuralLinearAction | read | partial -> pass | Exact EXPRESS lookup: ProjectedOrTrue now matches. |
| IFC4X3/IfcStructuralPlanarAction | read | partial -> pass | Exact EXPRESS lookup: ProjectedOrTrue now matches. |
| IFC4X3/IfcStructuralSurfaceAction | read | partial -> pass | Exact EXPRESS lookup: ProjectedOrTrue now matches. |
| cap/physical-analytical-link-read | capability | fail -> pass | Resolve physicalElementIds through parsed IfcElement subtypes and compare fixture GlobalIds; handle both assignment directions; check all 238 links. |

39 changed cells, including reason-only changes.

## Physical link counts by fixture

| Fixture | Held / checked |
|---|---|
| ara3d/ISSUE_171_IfcSurfaceCurveSweptAreaSolid.ifc | 26 / 26 |
| ifcopenshell/generated_structural_coverage_ifc2x3.ifc | 1 / 1 |
| structural/ifc_structuralanalysisview/E1--3-Axis-Struc-Export.ifc | 5 / 5 |
| structural/ifc_structuralanalysisview/house_basement_floor--Axis-Struc.ifc | 10 / 10 |
| structural/ifc_structuralanalysisview/little_steel_frame-3D--Axis-Struc.ifc | 176 / 176 |
| structural/ifc_structuralanalysisview/roof_truss--Axis-Struc.ifc | 13 / 13 |
| structural/ifc_structuralanalysisview/simple_bottom_slab--Axis-Struc.ifc | 1 / 1 |
| structural/ifc_structuralanalysisview/steel-joint-modelled-with-shellelements--Axis-Struc.ifc | 6 / 6 |

Counts are distinct item/element links (a link declared by two relationships counts once), not all structural items: ISSUE_171 has 26 linked items out of 66 items; E1--3 has 5 linked items out of 17. Every declared link is checked, including 176 in little_steel_frame.
